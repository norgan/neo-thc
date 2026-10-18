import {Resolver,lookup} from 'node:dns/promises';
import {createConnection,isIP} from 'node:net';
import {connect as connectTls} from 'node:tls';

/** @param {unknown} error @returns {import('../shared/types.js').DnsOutcome} */
function dnsCode(error){
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  /** @type {Record<string,import('../shared/types.js').DnsOutcome>} */
  const codes={ENODATA:'no_data',ENOTFOUND:'nxdomain',ESERVFAIL:'servfail',EREFUSED:'refused',ETIMEOUT:'timeout',ECANCELLED:'cancelled'};
  return codes[code]??'unavailable';
}
/** Fixed DNS operation; resolverFactory permits isolated test endpoints only through code injection.
 * @param {string} hostname @param {string} source @param {'A'|'AAAA'} recordType
 * @param {number} port @param {()=>Resolver} resolverFactory @param {AbortSignal|undefined} signal
 * @returns {Promise<import('../shared/types.js').DnsCheck>}
 */
export async function dnsCheck(hostname,source,recordType,port=53,resolverFactory=()=>new Resolver({timeout:1200,tries:1}),signal=undefined){
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('port');
  const started=Date.now(),resolver=resolverFactory();
  /** @type {import('../shared/types.js').DnsCheck} */const row={kind:'dns',source,recordType,port,status:'unavailable',answers:[],durationMs:0};
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;resolver.cancel();},1500);
  const abort=()=>resolver.cancel();signal?.addEventListener('abort',abort,{once:true});
  try {
    if(signal?.aborted){row.status='cancelled';return row;}
    resolver.setServers([(source.includes(':')?'['+source+']':source)+':'+port]);
    const records=await (recordType==='A'?resolver.resolve4(hostname+'.',{ttl:true}):resolver.resolve6(hostname+'.',{ttl:true}));
    if(records.length>16){row.status='response_cap';return row;}
    for(const record of records){
      if(isIP(record.address)!==(recordType==='A'?4:6)||!Number.isInteger(record.ttl)||record.ttl<0)throw new Error('record');
      row.answers.push({address:record.address,family:recordType==='A'?4:6,ttl:Math.min(record.ttl,2147483647)});
    }
    row.status=records.length?'answer':'no_data';
  }catch(error){row.status=timedOut?'timeout':dnsCode(error);row.answers=[];}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolver.cancel();row.durationMs=Date.now()-started;}
  return row;
}
/** OS resolver behavior is separate from direct DNS and has no observed TTL.
 * @param {string} hostname @returns {Promise<import('../shared/types.js').DnsCheck>}
 */
export async function systemCheck(hostname){
  const started=Date.now();
  /** @type {import('../shared/types.js').DnsCheck} */const row={kind:'dns',source:'operating-system',recordType:'system',status:'unavailable',answers:[],durationMs:0};
  /** @type {ReturnType<typeof setTimeout>|undefined} */let timer;
  try{
    /** @type {Promise<never>} */const deadline=new Promise((_resolve,reject)=>{
      timer=setTimeout(()=>reject(Object.assign(new Error('timeout'),{code:'ETIMEOUT'})),1500);
    });
    const records=await Promise.race([lookup(hostname+'.',{all:true,order:'verbatim'}),deadline]);
    if(records.length>16)row.status='response_cap';
    else {row.answers=records.map((record)=>({address:record.address,family:/** @type {4|6} */(record.family),ttl:null}));row.status=records.length?'answer':'no_data';}
  }catch(error){row.status=dnsCode(error)==='nxdomain'?'not_found':dnsCode(error);}
  finally{clearTimeout(timer);}
  row.durationMs=Date.now()-started;return row;
}
/** Literal address only. TLS sends a handshake/SNI, no HTTP, credentials, retries or family fallback.
 * @param {string} hostname @param {string} address @param {number} port @param {boolean} tls
 * @returns {Promise<import('../shared/types.js').ConnectionCheck>}
 */
export function connectionCheck(hostname,address,port,tls){
  const started=Date.now(),family=isIP(address);if(family!==4&&family!==6)throw new Error('address');
  /** @type {import('../shared/types.js').ConnectionCheck} */const row={kind:'connect',address,family,port,sourceAddress:null,tcp:'unavailable',tls:tls?'not_reached':'not_requested',durationMs:0};
  return new Promise((resolve)=>{
    let finished=false;
    const options={host:address,port,family,autoSelectFamily:false};
    const socket=tls?connectTls({...options,servername:hostname,rejectUnauthorized:true}):createConnection(options);
    const finish=()=>{
      if(finished)return;finished=true;clearTimeout(timer);socket.destroy();
      const cleanup=setTimeout(()=>{row.durationMs=Date.now()-started;resolve(row);},250);
      socket.once('close',()=>{clearTimeout(cleanup);row.durationMs=Date.now()-started;resolve(row);});
    };
    const timer=setTimeout(()=>{if(row.tcp==='connected')row.tls='timeout';else row.tcp='timeout';finish();},1500);
    socket.once('connect',()=>{row.tcp='connected';row.sourceAddress=socket.localAddress??null;if(!tls)finish();});
    if(tls)socket.once('secureConnect',()=>{row.tls='verified';finish();});
    socket.once('error',(error)=>{
      if(finished)return;
      const code='code' in error?String(error.code):'';
      if(row.tcp==='connected'&&tls)row.tls=/CERT|SELF_SIGNED|ISSUER|SIGNATURE|ALTNAME/.test(code)?'certificate_error':'handshake_error';
      else row.tcp=code==='ECONNREFUSED'?'refused':['ENETUNREACH','EHOSTUNREACH'].includes(code)?'unreachable':'unavailable';
      finish();
    });
  });
}
