const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs/promises');
let server,stage='initializing';
process.parentPort.once('message',async({data})=>{
  try{
    const root=data.root;
    if(data.mode==='remote'){
      const {createFrontend}=await import(pathToFileURL(path.join(root,'dist/server/server/frontend.js')).href);
      server=await createFrontend({origin:data.origin,token:data.token,...(data.caPath?{ca:await fs.readFile(data.caPath)}:{})},path.join(root,'dist/web'));
    }else{
      stage='loading packaged server';const {createApp}=await import(pathToFileURL(path.join(root,'dist/server/server/app.js')).href);
      await fs.mkdir(path.dirname(data.database),{recursive:true,mode:0o700});
      stage='opening database';server=createApp({dbPath:data.database,webRoot:path.join(root,'dist/web'),deviceVantage:'this-computer'}).app;
    }
    stage='opening listener';await server.listen({host:'127.0.0.1',port:4318});process.parentPort.postMessage({ready:true});
  }catch(error){await server?.close();process.parentPort.postMessage({error:'NEO could not start. Close another NEO instance using port 4318, then try again. Check database or server settings.',...(data.smoke&&data.mode==='local'?{stage,detail:String(error.message).slice(0,1000)}:{})});process.exitCode=1;}
});
process.parentPort.on('message',async({data})=>{if(data?.shutdown){try{await server?.close();process.parentPort.postMessage({closed:true});}catch{process.parentPort.postMessage({closed:false});}process.exit();}});
