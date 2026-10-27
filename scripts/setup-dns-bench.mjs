import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile,rename,rm,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

// Build-time provisioning only. The application never downloads or executes an installer.
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await readFile(join(root,'third-party/dns-bench/manifest.json'),'utf8'));
if(process.argv.slice(2).some(arg=>arg!=='--windows-x64'))throw new Error('Only --windows-x64 is supported.');
if(process.platform!=='win32'&&!process.argv.includes('--windows-x64')){
  console.log('On Linux/macOS install the pinned native tool: cargo install --locked --version '+manifest.version+' dns-bench');
}else{
  const {url,size,sha256}=manifest.windows;
  if(manifest.version!=='0.14.0'||size!==8114016||!/^[0-9a-f]{64}$/.test(sha256)||
    url!=='https://github.com/qwerty541/dns-bench/releases/download/v0.14.0/dns-bench.exe')throw new Error('Invalid pinned dns-bench manifest.');
  const directory=join(root,'tools/dns-bench'),destination=join(directory,'dns-bench.exe');
  const valid=buffer=>buffer.length===size&&createHash('sha256').update(buffer).digest('hex')===sha256;
  let current;try{current=await readFile(destination);}catch{}
  await mkdir(directory,{recursive:true});
  if(!current||!valid(current)){
    const response=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'follow'});
    if(!response.ok||!response.body)throw new Error('Could not download the pinned dns-bench executable.');
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>size)throw new Error('dns-bench download exceeds its pinned size.');chunks.push(chunk);}
    const content=Buffer.concat(chunks);
    if(!valid(content))throw new Error('dns-bench size or SHA-256 did not match the pinned release.');
    const temporary=join(directory,'dns-bench-'+randomUUID()+'.tmp');
    try{await writeFile(temporary,content,{flag:'wx',mode:0o700});await rename(temporary,destination);}
    finally{await rm(temporary,{force:true});}
  }
  await copyFile(join(root,'third-party/dns-bench/LICENSE-MIT'),join(directory,'LICENSE-MIT'));
  await copyFile(join(root,'third-party/dns-bench/manifest.json'),join(directory,'manifest.json'));
  console.log('Verified dns-bench '+manifest.version+' Windows x64 executable and licence for packaging.');
}
