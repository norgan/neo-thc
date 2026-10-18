import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {zipSync} from 'fflate';
const files={};async function add(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const name=join(dir,entry.name);if(entry.isDirectory())await add(name);else files[name.replaceAll('\\','/')]=new Uint8Array(await readFile(name));}}
await add('dist/server');await add('deploy');for(const name of ['package.json','package-lock.json'])files[name]=new Uint8Array(await readFile(name));
await mkdir('release',{recursive:true});await writeFile('release/NEO-THC-0.2.1-server.zip',zipSync(files,{level:6}));console.log('Packaged authenticated collector service. Node 24 and explicit TLS configuration required.');
