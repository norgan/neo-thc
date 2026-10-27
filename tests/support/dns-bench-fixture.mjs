import {appendFileSync,readFileSync,statSync} from 'node:fs';

const [mode,...args]=process.argv.slice(2);
const stage=args.includes('--version')?'version':'comparison';
const trace=process.env.NEO_DNS_BENCH_TEST_TRACE;
/** @param {Record<string,unknown>} value */
function record(value){if(trace)appendFileSync(trace,JSON.stringify({pid:process.pid,stage,...value})+'\n');}
/** @param {string} key */
const option=key=>args[args.indexOf(key)+1];
const hang=()=>{setInterval(()=>{},1000);};
const credentialNames=Object.keys(process.env).filter(name=>['NEO_OPENAI_API_KEY','OPENAI_API_KEY','NEO_SERVICE_TOKEN'].includes(name.toUpperCase()));
record({event:'started',args,protectedCredentialsPresent:credentialNames.length>0});
if(mode==='credential-boundary'&&credentialNames.length){process.stderr.write('Unexpected protected credentials in diagnostic process.');process.exit(7);}
if(stage==='version'){
  if(mode==='version-hang')hang();
  else if(mode==='version-invalid')process.stdout.write('SECRET arbitrary version output\n');
  else process.stdout.write('dns-bench '+(mode==='version-unsupported'?'0.15.0':'0.14.0')+'\n');
}else{
  const path=option('--custom-servers-file'),input=readFileSync(path,'utf8');
  const required=['--custom-servers-file','--skip-system-servers','--skip-gateway-detection','--disable-adaptive-timeout',
    '--domain','--requests','--threads','--timeout','--protocol','--name-servers-ip','--lookup-ip','--format','--style'];
  if(required.some(key=>!args.includes(key))||option('--threads')!=='1'||option('--format')!=='json'||input.split('\n').length!==2){
    process.stderr.write('SECRET invalid arguments');process.exit(7);
  }
  record({event:'input',input,fileMode:statSync(path).mode&0o777,directoryMode:statSync(process.cwd()).mode&0o777});
  if(mode==='hang'||mode==='partial'&&option('--protocol')==='tcp')hang();
  else if(mode==='stdout-cap'){process.stdout.write('x'.repeat(70_000));hang();}
  else if(mode==='stderr-cap'){process.stderr.write('SECRET'.repeat(12_000));hang();}
  else if(mode==='exit'){process.stderr.write('SECRET /private/tool/path');process.exitCode=7;}
  else{
    const match=/^([^;]+);(?:\[([^\]]+)\]|([^:]+)):(\d+)\n$/.exec(input);
    if(!match)throw new Error('Unexpected fixture input');
    const address=(match[2]??match[3]).split('%')[0];
    const ip=address.includes(':')?new URL('http://['+address+']/').hostname.slice(1,-1):address;
    const requests=Number(option('--requests')),count=mode==='no-responses'?0:mode==='some-responses'?requests-1:requests;
    const time={succeeded:{secs:0,nanos:2_000_000}},failed={failed:'No responses'};
    const result={name:match[1],ip,last_resolved_ip:count?(option('--lookup-ip')==='v4'?'192.0.2.1':'2001:db8::1'):'0.0.0.0',
      total_requests:requests,successful_requests:count,successful_requests_percentage:Math.fround(Math.fround(count/requests)*100),
      min_duration:count?time:failed,avg_duration:count?time:failed,max_duration:count?time:failed};
    setTimeout(()=>{
      process.stderr.write('Fixture progress; never retained.\n');
      process.stdout.write((mode==='bad-prefix'?'Unexpected startup message\n':'Using custom servers list.\n')+JSON.stringify([result])+'\n');
      record({event:'finished'});
    },mode==='matrix'?60:0);
  }
}
