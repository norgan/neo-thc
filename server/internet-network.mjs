import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {request} from 'node:https';
import {DOWNLOAD_HOST,DOWNLOAD_BYTES,DOWNLOAD_DEADLINE_MS} from '../shared/internet-policy.mjs';

export class InternetCleanupError extends Error {}
/** Fixed executable, bounded output, no shell or inherited credentials. Wait for child closure on cancellation.
 * @param {string} file @param {string[]} args @param {AbortSignal} signal @param {number} timeout
 * @param {Record<string,string>} env @param {boolean} includeStderr @returns {Promise<string|null>}
 */
async function command(file,args,signal,timeout,env={},includeStderr=false){
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    let closed=false,aborted=false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */let cleanup;
    const child=execFile(file,args,{shell:false,windowsHide:true,timeout,maxBuffer:32768,killSignal:'SIGKILL',
      env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',LC_ALL:'C',...env}},(error,stdout,stderr)=>{
        if(!aborted){signal.removeEventListener('abort',abort);resolve(!error||typeof error.code==='number'?stdout+(includeStderr?'\n'+stderr:''):null);}
      });
    const abort=()=>{aborted=true;child.kill('SIGKILL');cleanup=setTimeout(()=>{
      child.unref();child.stdout?.destroy();child.stderr?.destroy();reject(new InternetCleanupError('Probe process cleanup was not confirmed'));
    },1000);if(closed){clearTimeout(cleanup);reject(new Error('Internet diagnosis cancelled'));}};
    child.once('close',()=>{closed=true;clearTimeout(cleanup);signal.removeEventListener('abort',abort);if(aborted)reject(new Error('Internet diagnosis cancelled'));});
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}
const powershell=()=>join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
/** @param {AbortSignal} signal */
export async function windowsDnsConfiguration(signal){
  return command(powershell(),['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-DnsClientServerAddress | Select-Object InterfaceAlias,ServerAddresses) | ConvertTo-Json -Compress -Depth 3'],signal,2000);
}
const settingsScript=`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$routes=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -ErrorAction Stop)
$gateway=$routes | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' -and $_.NextHop -ne '0.0.0.0' } | Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop
$rows=@(Get-NetIPInterface -ConnectionState Connected -ErrorAction Stop | Where-Object { $_.NlMtu -ge 68 -and $_.NlMtu -le 65535 } | Select-Object -First 64 | ForEach-Object {
  $adapter=$_
  [pscustomobject]@{name=$adapter.InterfaceAlias;family=($(if($adapter.AddressFamily -eq 'IPv4'){4}else{6}));mtu=[int]$adapter.NlMtu;defaultRoute=([bool]($routes | Where-Object InterfaceIndex -eq $adapter.InterfaceIndex));dhcp=($adapter.Dhcp -eq 'Enabled')}
})
[pscustomobject]@{kind='settings';status='read';gateway=$gateway;interfaces=$rows} | ConvertTo-Json -Compress -Depth 4`;
/** Local settings only; unavailable stays explicit. @param {AbortSignal} signal @returns {Promise<Extract<import('../shared/types.js').InternetCheck,{kind:'settings'}>>} */
export async function internetSettings(signal){
  if(process.platform==='win32'){
    const raw=await command(powershell(),['-NoProfile','-NonInteractive','-Command',settingsScript],signal,4000);
    if(raw){try{return JSON.parse(raw.replace(/^\uFEFF/,''));}catch{}}
  }else if(process.platform==='linux'){
    try{
      const routes=(await readFile('/proc/net/route','utf8')).split('\n').slice(1).map((line)=>line.trim().split(/\s+/)).filter((row)=>row[1]==='00000000'&&row[2]&&row[2]!=='00000000');
      const gateway=routes[0]?routes[0][2].match(/../g)?.reverse().map((byte)=>parseInt(byte,16)).join('.')??null:null;
      /** @type {Extract<import('../shared/types.js').InternetCheck,{kind:'settings'}>['interfaces']} */const interfaces=[];
      for(const [name,rows] of Object.entries(networkInterfaces()).slice(0,32)){
        if(!/^[a-zA-Z0-9_:-][a-zA-Z0-9_.:-]{0,63}$/.test(name))continue;
        const mtu=Number((await readFile('/sys/class/net/'+name+'/mtu','utf8')).trim());
        for(const family of [4,6])if(rows?.some((row)=>!row.internal&&isIP(row.address)===family))interfaces.push({name,family:/** @type {4|6} */(family),mtu,defaultRoute:routes.some((row)=>row[0]===name),dhcp:null});
      }
      signal.throwIfAborted();return {kind:'settings',status:'read',gateway,interfaces};
    }catch{signal.throwIfAborted();}
  }
  return {kind:'settings',status:'unavailable',gateway:null,interfaces:[]};
}
const pingScript=`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$p=New-Object System.Net.NetworkInformation.Ping
$a=[System.Net.IPAddress]::Parse($env:NEO_PING_TARGET)
$b=New-Object byte[] ([int]$env:NEO_PING_BYTES)
$o=New-Object System.Net.NetworkInformation.PingOptions(64,($env:NEO_PING_DF -eq '1'))
$rows=@(for($i=0;$i -lt [int]$env:NEO_PING_COUNT;$i++) {
  try {$r=$p.Send($a,800,$b,$o);$s=switch([string]$r.Status){'Success'{'reply'} 'TimedOut'{'timeout'} 'PacketTooBig'{'too_big'} default{'unreachable'}};[pscustomobject]@{status=$s;rttMs=($(if($s -eq 'reply'){[double]$r.RoundtripTime}else{$null}))}}
  catch {[pscustomobject]@{status='unavailable';rttMs=$null}}
  if($i -lt ([int]$env:NEO_PING_COUNT-1)){Start-Sleep -Milliseconds 200}
})
$p.Dispose();ConvertTo-Json -InputObject $rows -Compress`;
/** @param {string} target @param {number} count @param {number} payload @param {boolean} df @param {AbortSignal} signal
 * @returns {Promise<import('../shared/types.js').PingSample[]>} */
export async function pingSamples(target,count,payload,df,signal){
  if(!isIP(target)||target.includes('%')||!Number.isInteger(count)||count<1||count>3||!Number.isInteger(payload)||payload<0||payload>1472)throw new Error('Ping scope');
  if(process.platform==='win32'){
    const raw=await command(powershell(),['-NoProfile','-NonInteractive','-Command',pingScript],signal,count*1000+2000,
      {NEO_PING_TARGET:target,NEO_PING_COUNT:String(count),NEO_PING_BYTES:String(payload),NEO_PING_DF:df?'1':'0'});
    if(raw){try{const data=JSON.parse(raw.replace(/^\uFEFF/,''));if(Array.isArray(data)&&data.length===count)return data;}catch{}}
  }else if(process.platform==='linux'){
    const raw=await command('/bin/ping',[isIP(target)===6?'-6':'-4','-n','-c',String(count),'-W','1','-w',String(count+1),'-s',String(payload),...(df?['-M','do']:[]),target],signal,(count+2)*1000,{},true);
    if(raw){
      const replies=[...raw.matchAll(/time[=<]([\d.]+)\s*ms/g)].map((match)=>({status:/** @type {const} */('reply'),rttMs:Number(match[1])}));
      if(/bytes from|packets transmitted|[Mm]essage too long|[Ff]rag needed/.test(raw))return [...replies,...Array.from({length:Math.max(0,count-replies.length)},()=>({status:/** @type {'too_big'|'unreachable'|'timeout'} */(/[Mm]essage too long|[Ff]rag needed|[Pp]acket too big/.test(raw)?'too_big':/[Uu]nreachable|[Ee]xceeded/.test(raw)?'unreachable':'timeout'),rttMs:null}))].slice(0,count);
    }
  }
  signal.throwIfAborted();return Array.from({length:count},()=>({status:'unavailable',rttMs:null}));
}
/** @param {string} target @param {AbortSignal} signal @returns {Promise<Extract<import('../shared/types.js').InternetCheck,{kind:'latency'}>>} */
export async function latencyCheck(target,signal){const started=Date.now();return {kind:'latency',target,samples:await pingSamples(target,3,32,false,signal),durationMs:Date.now()-started};}
/** IPv4-only, bounded DF search. A timeout is not evidence of a smaller MTU.
 * @param {string} target @param {AbortSignal} signal @param {typeof pingSamples} ping @returns {Promise<Extract<import('../shared/types.js').InternetCheck,{kind:'mtu'}>>} */
export async function mtuCheck(target,signal,ping=pingSamples){
  const started=Date.now();
  /** @type {Extract<import('../shared/types.js').InternetCheck,{kind:'mtu'}>} */const result={kind:'mtu',target,status:'inconclusive',mtu:null,probes:[],durationMs:0};
  /** @param {number} payload */const probe=async(payload)=>{signal.throwIfAborted();const status=(await ping(target,1,payload,true,signal))[0].status;result.probes.push({payload,status});return status;};
  if(await probe(1472)==='reply'){result.status='at_least_1500';result.mtu=1500;}
  else if(result.probes[0].status==='too_big'&&await probe(1200)==='reply'){
    let low=1200,high=1472;
    while(high-low>1&&result.probes.length<11){const middle=Math.floor((low+high)/2),status=await probe(middle);
      if(status==='reply')low=middle;else if(status==='too_big')high=middle;else {result.durationMs=Date.now()-started;return result;}}
    if(high-low===1){result.status='reduced';result.mtu=low+28;}
  }
  result.durationMs=Date.now()-started;return result;
}
/** Fixed public HTTPS download. No credentials, cookies, redirects, upload, proxy or stored body.
 * @param {AbortSignal} signal @param {typeof request} requestFactory @returns {Promise<Extract<import('../shared/types.js').InternetCheck,{kind:'transfer'}>>} */
export async function transferCheck(signal,requestFactory=request){
  signal.throwIfAborted();const started=Date.now();
  return new Promise((resolve,reject)=>{
    /** @type {Extract<import('../shared/types.js').InternetCheck,{kind:'transfer'}>} */const result={kind:'transfer',status:'unavailable',bytes:0,durationMs:0,mbps:null};
    let finished=false;
    /** @type {import('node:http').IncomingMessage|undefined} */let response;
    /** @param {typeof result.status} status */const finish=(status)=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
      result.status=status;result.durationMs=Date.now()-started;
      if(['complete','deadline','byte_cap'].includes(status)&&result.bytes>=262144&&result.durationMs>=100)result.mbps=result.bytes*8/(result.durationMs*1000);
      const cleanup=setTimeout(()=>reject(new InternetCleanupError('HTTPS probe cleanup was not confirmed')),1000);
      const closed=()=>{clearTimeout(cleanup);resolve(result);};req.once('close',closed);
      if(req.closed)closed();response?.destroy();req.destroy();};
    const req=requestFactory({hostname:DOWNLOAD_HOST,port:443,path:'/__down?bytes='+DOWNLOAD_BYTES,method:'GET',agent:false,rejectUnauthorized:true,
      headers:{'User-Agent':'Neo-THC/0.1','Accept':'application/octet-stream','Cache-Control':'no-cache'}},(incoming)=>{
      response=incoming;
      if(incoming.statusCode!==200||incoming.headers['content-encoding']&&incoming.headers['content-encoding']!=='identity'){finish('http_error');return;}
      incoming.on('data',(chunk)=>{if(finished)return;result.bytes+=Math.min(chunk.length,DOWNLOAD_BYTES-result.bytes);if(result.bytes>=DOWNLOAD_BYTES)finish('byte_cap');});
      incoming.once('end',()=>finish(result.bytes?'complete':'unavailable'));incoming.once('error',()=>finish('unavailable'));
    });
    const timer=setTimeout(()=>finish('deadline'),DOWNLOAD_DEADLINE_MS),abort=()=>finish('unavailable');
    signal.addEventListener('abort',abort,{once:true});req.once('error',(error)=>finish(/CERT|SELF_SIGNED|ISSUER|ALTNAME/.test('code' in error?String(error.code):'')?'tls_error':'unavailable'));
    if(signal.aborted)abort();else req.end();
  });
}
