import {readFile,writeFile,readdir} from 'node:fs/promises';
import {zipSync} from 'fflate';
const files={};for(const name of await readdir('browser-companion'))if(/\.(js|json|html|css)$/.test(name))files['neo-playback-companion/'+name]=new Uint8Array(await readFile('browser-companion/'+name));
await writeFile('dist/web/companion.zip',zipSync(files,{level:6}));
const guide=await readFile('docs/playback-setup.html');await writeFile('dist/web/playback-guide.html',guide);
console.log('Packaged browser companion and one-time setup guide.');
