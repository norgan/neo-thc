import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {isIP} from 'node:net';
import {createApp} from './app.js';
import {serviceOrigin,validToken} from './access.js';
// Separate opt-in entry point: local npm start never gains a LAN listener from environment flags.
let app:ReturnType<typeof createApp>['app']|undefined;
try{
  if(!process.env.NEO_SERVICE_CONFIG)throw new Error('Configuration required');
  const config=JSON.parse(await readFile(resolve(process.env.NEO_SERVICE_CONFIG),'utf8')) as Record<string,unknown>;
  if(Object.keys(config).some(k=>!['listenAddress','origin','tokenFile','certificateFile','keyFile','databaseFile'].includes(k)))throw new Error('Invalid configuration');
  const origin=serviceOrigin(config.origin);if(typeof config.listenAddress!=='string'||!isIP(config.listenAddress)||typeof config.tokenFile!=='string'||typeof config.certificateFile!=='string'||typeof config.keyFile!=='string'||typeof config.databaseFile!=='string')throw new Error('Incomplete configuration');
  const token=(await readFile(resolve(config.tokenFile),'utf8')).trim();if(!validToken(token))throw new Error('Invalid token');
  const db=resolve(config.databaseFile);await mkdir(dirname(db),{recursive:true,mode:0o700});
  app=createApp({dbPath:db,access:{mode:'service',origin:origin.origin,token},tls:{cert:await readFile(resolve(config.certificateFile)),key:await readFile(resolve(config.keyFile))}}).app;
  let closing=false;const close=async()=>{if(closing)return;closing=true;await app?.close();};process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
  await app.listen({host:config.listenAddress,port:Number(origin.port||443)});console.log('NEO authenticated collector service started. Scope approval is required for every collection job.');
}catch{console.error('NEO service did not start. Check the explicit config, TLS files, token and database permissions. No credentials are logged.');await app?.close();process.exitCode=1;}
