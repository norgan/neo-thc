import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer,request as httpsRequest,type RequestOptions} from 'node:https';
import type {IncomingMessage} from 'node:http';
import {createApp} from '../server/app.js';
import {accessProblem,serviceOrigin,validToken} from '../server/access.js';
import {remoteRequest,allowedRemotePath,createFrontend} from '../server/frontend.js';
const token='a'.repeat(64);
test('remote access requires exact origin, strong token and TLS; local defaults remain loopback',()=>{
  for(const url of ['http://neo.example','https://user:pass@neo.example','https://neo.example/path','https://neo.example/?token=secret'])assert.throws(()=>serviceOrigin(url));
  assert.ok(validToken(token));assert.ok(!validToken('password'));
  const policy={mode:'service' as const,origin:'https://neo.example:7443',token};
  assert.equal(accessProblem(policy,'neo.example:7443',undefined,'Bearer '+token),null);
  assert.equal(accessProblem(policy,'neo.example:7443',undefined,undefined),'Authentication required');
  assert.equal(accessProblem(policy,'neo.example:7443','https://evil.example','Bearer '+token),'Cross-origin access is unavailable');
  assert.ok(accessProblem({mode:'local'},'192.0.2.1:4318',undefined,undefined));
  assert.throws(()=>createApp({access:policy}),/TLS/);
});
test('desktop proxy accepts only existing fixed API operations, never URLs, paths, code or transport configuration',()=>{
  assert.ok(allowedRemotePath('POST','/api/v1/diagnostics/preview'));
  for(const [method,path] of [['GET','https://evil.example'],['GET','/api/v1/snapshot?token=x'],['POST','/api/v1/execute'],['POST','/api/v1/jobs'],['GET','/api/v1/../secret'],['POST','/api/v1/local-device']])assert.ok(!allowedRemotePath(method,path));
});
test('real TLS service and desktop frontend authenticate, verify certificates, preserve data and keep device checks local',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'neo-remote-'));let service:ReturnType<typeof createApp>|undefined;let frontend:Awaited<ReturnType<typeof createFrontend>>|undefined;
  try{
    const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
    await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost','-keyout',key,'-out',cert],{timeout:10000,maxBuffer:8192});
    const tls={key:await readFile(key),cert:await readFile(cert)};
    const policy={mode:'service' as const,origin:'https://127.0.0.1:7443',token};service=createApp({tls,access:policy});
    let requests=0;service.app.addHook('onRequest',async()=>{requests++;});
    await service.app.listen({host:'127.0.0.1',port:0});const address=service.app.server.address();assert.ok(address&&typeof address!=='string');policy.origin='https://127.0.0.1:'+address.port;
    const connection={origin:policy.origin,token,ca:tls.cert};
    const ipv6=createServer(tls,(request,response)=>{assert.equal(request.headers.authorization,'Bearer '+token);response.setHeader('Content-Type','application/json');response.end('{"ipv6":true}');});await new Promise<void>(resolve=>ipv6.listen(0,'::1',resolve));const v6=ipv6.address();assert.ok(v6&&typeof v6!=='string');
    try{assert.deepEqual((await remoteRequest({origin:'https://[::1]:'+v6.port,token,ca:tls.cert},'GET','/api/v1/health',undefined,new AbortController().signal)).body,{ipv6:true});}finally{ipv6.closeAllConnections();await new Promise<void>(resolve=>ipv6.close(()=>resolve()));}
    await assert.rejects(remoteRequest({...connection,origin:'https://127.0.0.2:'+address.port},'GET','/api/v1/health',undefined,new AbortController().signal,((options:RequestOptions,callback:(response:IncomingMessage)=>void)=>httpsRequest({...options,hostname:'127.0.0.1'},callback)) as typeof httpsRequest));assert.equal(requests,0,'No access token sent when the certificate IP SAN does not match');
    await assert.rejects(remoteRequest({...connection,ca:undefined},'GET','/api/v1/health',undefined,new AbortController().signal));assert.equal(requests,0,'No access token sent before certificate verification');
    const ok=await remoteRequest(connection,'GET','/api/v1/health',undefined,new AbortController().signal);assert.equal(ok.status,200);assert.ok(!JSON.stringify(ok).includes(token));
    assert.equal((await remoteRequest({...connection,token:'b'.repeat(64)},'GET','/api/v1/health',undefined,new AbortController().signal)).status,401);
    let deviceCalls=0;frontend=await createFrontend(connection,'dist/web',4318,async(_signal,vantage)=>{deviceCalls++;return {observedAt:Date.now(),vantage:vantage??'collector',platform:'fixture',cpuBusyPercent:0,memoryUsedPercent:10,logicalCpus:4,wifi:{status:'unavailable',signalPercent:null,receiveMbps:null,transmitMbps:null,radio:null,channel:null}};});
    const snapshot=await frontend.inject({url:'/api/v1/snapshot',headers:{host:'127.0.0.1:4318'}});assert.equal(snapshot.statusCode,200);assert.equal(snapshot.json().runtime,'playback-desktop-v7');
    const before=requests;const device=await frontend.inject({method:'POST',url:'/api/v1/local-device',headers:{host:'127.0.0.1:4318','x-neo-client':'local-ui'},payload:{}});assert.equal(device.json().vantage,'this-computer');assert.equal(deviceCalls,1);assert.equal(requests,before);
    assert.equal((await frontend.inject({url:'/api/v1/snapshot',headers:{host:'evil.example'}})).statusCode,403);
    const placement=await frontend.inject({url:'/api/v1/placement',headers:{host:'127.0.0.1:4318'}});assert.equal(placement.json().mode,'remote');assert.ok(!JSON.stringify(placement.json()).includes(token));
    let behavior='redirect',calls=0;
    const hanging=createServer(tls,(_request,response)=>{calls++;if(behavior==='redirect'){response.writeHead(302,{Location:'https://example.invalid/private'});response.end('{}');}else if(behavior==='cap'){response.writeHead(200,{'Content-Type':'application/json'});response.end(Buffer.alloc(4*1024*1024+1024,32));}});await new Promise<void>(resolve=>hanging.listen(0,'127.0.0.1',resolve));const h=hanging.address();assert.ok(h&&typeof h!=='string');
    const limited={origin:'https://127.0.0.1:'+h.port,token,ca:tls.cert};
    try{await assert.rejects(remoteRequest(limited,'GET','/api/v1/health',undefined,new AbortController().signal),/redirect/);assert.equal(calls,1);behavior='cap';await assert.rejects(remoteRequest(limited,'GET','/api/v1/health',undefined,new AbortController().signal));behavior='hang';await assert.rejects(remoteRequest(limited,'GET','/api/v1/health',undefined,AbortSignal.timeout(100)));}finally{hanging.closeAllConnections();await new Promise<void>(resolve=>hanging.close(()=>resolve()));}
  }finally{await frontend?.close();await service?.app.close();await rm(dir,{recursive:true,force:true});}
});
