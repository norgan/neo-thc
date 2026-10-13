import {Buffer} from 'node:buffer';
import {randomInt} from 'node:crypto';
import {createSocket} from 'node:dgram';

/** @typedef {Buffer[]} Name */
/** @typedef {{owner:Name,type:number,ttlMs:number,value:unknown}} RecordData */
export const GLANCES_NAME=[Buffer.from('_glances'),Buffer.from('_tcp'),Buffer.from('local')];
/** ASCII case folding preserves DNS label boundaries and all non-ASCII bytes. @param {Name} labels */
export function nameKey(labels){return labels.map((label)=>[...label].map((b)=>b>=65&&b<=90?b+32:b).map((b)=>b.toString(16).padStart(2,'0')).join('')).join('/');}
/** @param {Name} labels */
function displayName(labels){return labels.map((label)=>new TextDecoder('utf-8',{fatal:true}).decode(label).replace(/[\u0000-\u001f\u007f]/gu,'�')).join('.').slice(0,253);}
/** @param {Name} labels */
export function encodeName(labels){
  if(!labels.length||labels.length>32||labels.some((label)=>!Buffer.isBuffer(label)||!label.length||label.length>63)||
    labels.reduce((sum,label)=>sum+1+label.length,1)>255)throw new Error('dns_name');
  return Buffer.concat([...labels.flatMap((label)=>[Buffer.from([label.length]),label]),Buffer.from([0])]);
}
/** @param {Buffer} packet @param {number} start @returns {{labels:Name,end:number}} */
export function readDnsName(packet,start){
  let cursor=start,end=-1,length=1,hops=0;
  const visited=new Set();
  /** @type {Name} */const labels=[];
  while(true){
    if(cursor>=packet.length||++hops>128||visited.has(cursor))throw new Error('dns_name');visited.add(cursor);
    const size=packet[cursor++];
    if(size===0){if(end<0)end=cursor;break;}
    if((size&0xc0)===0xc0){
      if(cursor>=packet.length)throw new Error('dns_name');
      const pointer=((size&63)<<8)|packet[cursor++];if(end<0)end=cursor;
      if(pointer>=packet.length)throw new Error('dns_name');cursor=pointer;continue;
    }
    if(size>63||cursor+size>packet.length||(length+=size+1)>255||labels.length>=32)throw new Error('dns_name');
    labels.push(Buffer.from(packet.subarray(cursor,cursor+size)));cursor+=size;
  }
  return {labels,end};
}
/** @param {Name} owner @param {number} type @param {number} id */
export function glancesQuestion(owner,type,id){
  if(![1,12,16,33].includes(type))throw new Error('dns_type');
  const header=Buffer.alloc(12);header.writeUInt16BE(id,0);header.writeUInt16BE(1,4);
  const tail=Buffer.alloc(4);tail.writeUInt16BE(type,0);tail.writeUInt16BE(1,2);
  return Buffer.concat([header,encodeName(owner),tail]);
}
/** Bounded legacy-unicast mDNS reply parser; no A/SRV value becomes a new target.
 * @param {Buffer} packet @param {Name} question @param {number} type @param {number} id @returns {RecordData[]}
 */
export function parseGlancesDns(packet,question,type,id){
  if(packet.length<12||packet.length>8192||packet.readUInt16BE(0)!==id)throw new Error('dns_packet');
  const flags=packet.readUInt16BE(2),counts=[4,6,8,10].map((offset)=>packet.readUInt16BE(offset));
  if(!(flags&0x8000)||(flags&0x7a0f)||counts[0]!==1||counts.slice(1).reduce((a,b)=>a+b,0)>64)throw new Error('dns_packet');
  const q=readDnsName(packet,12);let offset=q.end;
  if(offset+4>packet.length||nameKey(q.labels)!==nameKey(question)||packet.readUInt16BE(offset)!==type||(packet.readUInt16BE(offset+2)&0x7fff)!==1)throw new Error('dns_question');
  offset+=4;
  /** @type {RecordData[]} */const records=[];
  for(let section=1;section<4;section++)for(let index=0;index<counts[section];index++){
    const owner=readDnsName(packet,offset);offset=owner.end;
    if(offset+10>packet.length)throw new Error('dns_record');
    const rrType=packet.readUInt16BE(offset),rrClass=packet.readUInt16BE(offset+2)&0x7fff,ttl=packet.readUInt32BE(offset+4),size=packet.readUInt16BE(offset+8);
    offset+=10;const end=offset+size;if(end>packet.length)throw new Error('dns_record');
    /** @type {unknown} */let value;
    if(rrClass===1&&[1,12,16,33].includes(rrType)){
      if(rrType===12){const target=readDnsName(packet,offset);if(target.end!==end)throw new Error('dns_ptr');value={target:target.labels};}
      if(rrType===33){
        if(size<7)throw new Error('dns_srv');
        const target=readDnsName(packet,offset+6),port=packet.readUInt16BE(offset+4);
        if(target.end!==end||!target.labels.length||port<1)throw new Error('dns_srv');
        value={target:target.labels,port};
      }
      if(rrType===16){
        if(size>1024)throw new Error('dns_txt');
        let position=offset,strings=0;
        /** @type {string[]} */const protocols=[];
        while(position<end){
          const size=packet[position++];if(position+size>end||++strings>32)throw new Error('dns_txt');
          const text=packet.subarray(position,position+size);position+=size;
          const split=text.indexOf(61),key=split<0?text:text.subarray(0,split);
          if(!protocols.length&&key.equals(Buffer.from(key.toString('ascii')))&&key.toString('ascii').toLowerCase()==='protocol'){
            const raw=split<0?Buffer.alloc(0):text.subarray(split+1);
            protocols.push(raw.equals(Buffer.from('rest'))?'rest':raw.equals(Buffer.from('rpc'))?'rpc':'unknown');
          }
        }
        const unique=[...new Set(protocols)];
        value={protocol:unique.length===1&&['rest','rpc'].includes(unique[0])?unique[0]:'unknown',conflict:unique.length>1};
      }
      if(rrType===1){if(size!==4)throw new Error('dns_a');value={address:[...packet.subarray(offset,end)].join('.')};}
      records.push({owner:owner.labels,type:rrType,ttlMs:Math.min(ttl*1000,10000),value});
    }
    offset=end;
  }
  if(offset!==packet.length)throw new Error('dns_packet');
  return records;
}
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('dns_value');return /** @type {Record<string,unknown>} */(value);}
/** @param {unknown} value @returns {Name} */
function name(value){if(!Array.isArray(value)||value.some((item)=>!Buffer.isBuffer(item)))throw new Error('dns_name');return /** @type {Name} */(value);}
/** @param {RecordData[]} records */
function unique(records){
  const values=new Map(records.map((record)=>[JSON.stringify(record.value),record]));
  if(values.size!==1)return null;
  const value=[...values.values()][0];return {...value,ttlMs:Math.min(...records.map((record)=>record.ttlMs))};
}
/** Fixed link-local operation. Socket factory exists only as a test dependency.
 * @param {import('../shared/types.js').DiscoveryPlan} plan @param {AbortSignal} signal @param {typeof createSocket} socketFactory
 * @param {number} windowMs Internal test clock bound; runtime uses 1000.
 * @returns {Promise<import('../shared/types.js').GlancesResolution>}
 */
export async function resolveGlancesMdns(plan,signal,socketFactory=createSocket,windowMs=1000){
  if(!Number.isInteger(windowMs)||windowMs<1||windowMs>1000)throw new Error('window');
  signal.throwIfAborted();
  /** @type {import('../shared/types.js').GlancesResolution} */const result={candidates:[],datagramsSent:0,packetsReceived:0,omitted:0,issues:[]};
  const socket=socketFactory('udp4'),started=Date.now(),allowed=new Set(plan.targets);
  /** @type {Map<string,{source:string,record:RecordData}[]>} */const records=new Map();
  let receivedBytes=0,recordCount=0,queriesAttempted=0,closed=false;
  /** @type {(()=>void)|undefined} */let finishQuery;
  /** @type {{owner:Name,type:number,id:number}|null} */let active=null;
  /** @param {string} issue */const issue=(issue)=>{if(!result.issues.includes(issue))result.issues.push(issue);};
  const abort=()=>{issue('cancelled');finishQuery?.();};
  signal.addEventListener('abort',abort,{once:true});
  socket.on('error',()=>{issue('socket_error');finishQuery?.();});
  socket.on('message',(packet,sender)=>{
    if(closed)return;
    result.packetsReceived++;receivedBytes+=packet.length;
    if(result.packetsReceived>256||receivedBytes>524288){issue('response_cap');finishQuery?.();return;}
    if(!active||sender.port!==5353||!allowed.has(sender.address)||packet.length>8192)return;
    try {
      for(const record of parseGlancesDns(packet,active.owner,active.type,active.id)){
        if(++recordCount>256){issue('record_cap');finishQuery?.();return;}
        const key=sender.address+'|'+nameKey(record.owner)+'|'+record.type;
        const group=records.get(key)??[];group.push({source:sender.address,record});records.set(key,group);
      }
    } catch {/* Invalid packets consume budget but never become targets or diagnostics. */}
  });
  /** @param {Name} owner @param {number} type */
  const query=async(owner,type)=>{
    if(signal.aborted||result.issues.length||queriesAttempted>=7||Date.now()-started>=8000)return;
    queriesAttempted++;active={owner,type,id:randomInt(1,65536)};
    const packet=glancesQuestion(owner,type,active.id);
    await new Promise((resolve)=>{
      const timer=setTimeout(()=>done(),Math.min(windowMs,8000-(Date.now()-started)));
      const done=()=>{clearTimeout(timer);finishQuery=undefined;active=null;resolve(undefined);};
      finishQuery=done;
      try{socket.send(packet,5353,'224.0.0.251',(error)=>{if(error){issue('socket_error');done();}else result.datagramsSent++;});}
      catch{issue('socket_error');done();}
      if(signal.aborted)done();
    });
  };
  /** @param {string} source @param {Name} owner @param {number} type */
  const get=(source,owner,type)=>(records.get(source+'|'+nameKey(owner)+'|'+type)??[]).map((item)=>item.record);
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('bind_timeout')),1000);
      const onError=()=>{clearTimeout(timer);reject(new Error('bind_failed'));};
      socket.once('error',onError);
      socket.bind(0,plan.interface.address,()=>{clearTimeout(timer);socket.removeListener('error',onError);resolve(undefined);});
    });
    socket.setMulticastInterface(plan.interface.address);socket.setMulticastTTL(255);socket.setTTL(255);
    await query(GLANCES_NAME,12);
    /** @type {Map<string,{source:string,instance:Name,ttlMs:number}>} */const instances=new Map();
    for(const source of plan.targets)for(const record of get(source,GLANCES_NAME,12)){
      const instance=name(object(record.value).target);
      if(instance.length!==4||nameKey(instance.slice(1))!==nameKey(GLANCES_NAME))continue;
      const key=source+'|'+nameKey(instance),prior=instances.get(key);
      instances.set(key,{source,instance,ttlMs:Math.min(prior?.ttlMs??10000,record.ttlMs)});
    }
    const all=[...instances.values()].sort((a,b)=>a.source.localeCompare(b.source,undefined,{numeric:true})||nameKey(a.instance).localeCompare(nameKey(b.instance)));
    result.omitted=Math.max(0,all.length-2);
    for(const item of all.slice(0,2)){
      const candidate={address:item.source,instance:displayName(item.instance),port:/** @type {number|null} */(null),
        protocol:/** @type {'rest'|'rpc'|'unknown'} */('unknown'),ttlMs:item.ttlMs,issue:/** @type {string|null} */(null)};
      result.candidates.push(candidate);
      if(signal.aborted){candidate.issue='cancelled';continue;}
      if(!get(item.source,item.instance,33).length)await query(item.instance,33);
      if(!get(item.source,item.instance,16).length)await query(item.instance,16);
      const srvs=get(item.source,item.instance,33),txts=get(item.source,item.instance,16);
      const srv=unique(srvs),txt=unique(txts);
      if(!srv||!txt){candidate.issue=srvs.length&&txts.length?'conflict':'unresolved';continue;}
      const service=object(srv.value),text=object(txt.value);
      candidate.ttlMs=Math.min(candidate.ttlMs,srv.ttlMs,txt.ttlMs);
      if(text.conflict){candidate.issue='conflict';continue;}
      candidate.protocol=text.protocol==='rest'?'rest':text.protocol==='rpc'?'rpc':'unknown';
      if(candidate.protocol!=='rest'){candidate.issue=candidate.protocol==='rpc'?'rpc_only':'protocol_unknown';continue;}
      const target=name(service.target);
      if(!get(item.source,target,1).length)await query(target,1);
      const addresses=get(item.source,target,1),record=unique(addresses.filter((entry)=>object(entry.value).address===item.source));
      if(!record){candidate.issue=addresses.length?'address_mismatch':'unresolved';continue;}
      candidate.ttlMs=Math.min(candidate.ttlMs,record.ttlMs);
      candidate.port=typeof service.port==='number'?service.port:null;
      if(candidate.ttlMs<=Date.now()-started)candidate.issue='expired';
    }
    if(!all.length&&!result.issues.length)issue('no_advertisements');
    if(result.omitted)issue('endpoint_cap');
    return result;
  } catch {issue(signal.aborted?'cancelled':'socket_error');return result;}
  finally {
    closed=true;signal.removeEventListener('abort',abort);
    await new Promise((resolve)=>{try{socket.close(()=>resolve(undefined));}catch{resolve(undefined);}});
  }
}
