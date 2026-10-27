import Fastify,{type FastifyInstance} from 'fastify';
import {request as httpsRequest,type RequestOptions} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {isIP} from 'node:net';
import {X509Certificate} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {accessProblem,serviceOrigin,validToken} from './access.js';
import {deviceEvidence} from './device.js';
import {RequestError} from './jobs.js';
import {ASSISTANT_LIMITS} from '../shared/assistant.js';
export interface RemoteConnection {origin:string;token:string;ca?:Buffer}
export function allowedRemotePath(method:string,path:string){
  if(method==='GET')return /^\/api\/v1\/(?:health|snapshot|assets(?:\/[a-zA-Z0-9-]+)?|jobs(?:\/[a-zA-Z0-9-]+)?|discovery\/options|diagnostics\/options|dns-benchmark\/options|assistant\/options|playback)$/.test(path);
  return method==='POST'&&/^\/api\/v1\/(?:jobs\/[a-zA-Z0-9-]+\/cancel|discovery\/(?:preview|jobs)|diagnostics\/(?:preview|jobs)|dns-benchmark\/(?:preview|jobs)|assistant\/(?:preview|chat|cancel|reset)|assets\/[a-zA-Z0-9-]+\/glances\/(?:preview|read)|stats\/[a-zA-Z0-9-]+\/cancel|playback)$/.test(path);
}
export async function remoteRequest(connection:RemoteConnection,method:string,path:string,body:unknown,signal:AbortSignal,transport:typeof httpsRequest=httpsRequest):Promise<{status:number;body:unknown}>{
  const origin=serviceOrigin(connection.origin);if(!validToken(connection.token)||!allowedRemotePath(method,path))throw new Error('Invalid remote request');
  const payload=body===undefined?undefined:JSON.stringify(body);if(payload&&Buffer.byteLength(payload)>65536)throw new Error('Request too large');
  const timeout=path==='/api/v1/assistant/chat'?ASSISTANT_LIMITS.requestTimeoutMs+5000:15000;
  return new Promise((resolve,reject)=>{
    let result:{status:number;body:unknown}|undefined;let failure:Error|undefined;
    const hostname=origin.hostname.replace(/^\[|\]$/g,'');
    const options:RequestOptions={protocol:'https:',hostname,servername:isIP(hostname)?'':hostname,checkServerIdentity:(_name,certificate)=>{
      // Use Node's X509 IP SAN matcher for literals. Some Node 24 versions apply
      // domainToASCII to IPv6 in the DNS matcher, turning a valid literal into an empty name.
      if(!isIP(hostname))return checkServerIdentity(hostname,certificate);
      try{if(new X509Certificate(certificate.raw).checkIP(hostname))return;}catch{}
      return new Error('Server certificate does not match the configured IP address');
    },port:origin.port||443,path,method,agent:false,rejectUnauthorized:true,...(connection.ca?{ca:connection.ca}:{}),signal,headers:{Host:origin.host,Authorization:'Bearer '+connection.token,'X-Neo-Client':'local-ui',Accept:'application/json','Accept-Encoding':'identity',...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}};
    const req=transport(options,res=>{
      const chunks:Buffer[]=[];let bytes=0;
      const timer=setTimeout(()=>req.destroy(new Error('Remote response timed out')),timeout);
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4*1024*1024){req.destroy(new Error('Remote response too large'));return;}chunks.push(chunk);});
      res.once('end',()=>{clearTimeout(timer);if((res.statusCode??500)>=300&&(res.statusCode??500)<400){failure=new Error('Remote redirects are unavailable');return;}try{result={status:res.statusCode??502,body:JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown};}catch{failure=new Error('Invalid remote response');}});
      res.once('error',()=>{clearTimeout(timer);failure=new Error('Remote response unavailable');});res.once('close',()=>clearTimeout(timer));
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('Remote connection timed out')));req.once('error',()=>{failure=new Error('Cannot reach or verify the selected server. Check its URL, certificate and access token.');});
    req.once('close',()=>{if(result&&!failure)resolve(result);else reject(failure??new Error('Remote response ended before completion'));});req.end(payload);
  });
}
export async function staticFiles(app:FastifyInstance,root:string){
  app.get('/',async(_r,reply)=>reply.type('text/html').send(await readFile(join(root,'index.html'))));
  app.get<{Params:{file:string}}>('/assets/:file',async(r,reply)=>{if(!/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(r.params.file))throw new RequestError(404,'Not found');const b=await readFile(join(root,'assets',r.params.file)).catch(()=>null);if(!b)throw new RequestError(404,'Not found');return reply.type(r.params.file.endsWith('.css')?'text/css':'text/javascript').send(b);});
  app.get('/companion.zip',async(_r,reply)=>reply.type('application/zip').header('Content-Disposition','attachment; filename="neo-playback-companion.zip"').send(await readFile(join(root,'companion.zip'))));
  app.get('/playback-guide',async(_r,reply)=>reply.type('text/html').send(await readFile(join(root,'playback-guide.html'))));
}
export async function createFrontend(connection:RemoteConnection,webRoot:string,port=4318,readDevice:typeof deviceEvidence=deviceEvidence){
  serviceOrigin(connection.origin);if(!validToken(connection.token))throw new Error('Use a server access token.');
  const app=Fastify({logger:false,bodyLimit:65536,requestTimeout:10000,forceCloseConnections:true,trustProxy:false});
  const active=new Set<{controller:AbortController;done:Promise<unknown>}>();
  app.addHook('onRequest',async(r,reply)=>{
    reply.header('Content-Security-Policy',"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'").header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    const error=accessProblem({mode:'local',port},r.headers.host,r.headers.origin,undefined);if(error)throw new RequestError(403,error);
    if(r.method!=='GET'&&r.headers['x-neo-client']!=='local-ui')throw new RequestError(403,'A local client header is required');
  });
  app.setErrorHandler((e,_r,reply)=>reply.code(e instanceof RequestError?e.statusCode:502).send({error:e instanceof RequestError?e.message:'Selected server is unavailable or could not be verified. Check Desktop connection.'}));
  app.get('/api/v1/placement',async()=>({mode:'remote',collector:serviceOrigin(connection.origin).host,deviceChecks:'this-computer'}));
  async function owned<T>(fn:(signal:AbortSignal)=>Promise<T>,reply?:import('fastify').FastifyReply){if(active.size>=8)throw new RequestError(409,'Too many active requests');const controller=new AbortController();const disconnected=()=>{if(!reply?.raw.writableEnded)controller.abort();};reply?.raw.once('close',disconnected);const item={controller,done:fn(controller.signal)};active.add(item);try{return await item.done;}finally{reply?.raw.removeListener('close',disconnected);active.delete(item);}}
  app.post('/api/v1/local-device',async()=>owned(signal=>readDevice(signal,'this-computer')));
  app.all('/api/v1/*',async(r,reply)=>{
    if(!allowedRemotePath(r.method,r.url))throw new RequestError(404,'Unsupported remote operation');
    const result=await owned(signal=>remoteRequest(connection,r.method,r.url,r.body,signal),reply);return reply.code(result.status).send(result.body);
  });
  await staticFiles(app,webRoot);
  app.addHook('preClose',async()=>{for(const x of active)x.controller.abort();await Promise.allSettled([...active].map(x=>x.done));});
  return app;
}
