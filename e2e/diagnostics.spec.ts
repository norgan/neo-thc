import {test,expect} from './fixtures.js';
import type {Page} from '@playwright/test';
import type {DiagnosticReport,Job,DiagnosticPlan} from '../shared/types.js';
import {diagnosticFindings} from '../shared/diagnostics.js';
import {internetFindings,DOWNLOAD_BYTES} from '../shared/internet.js';

const dnsPlan:DiagnosticPlan={kind:'dns',hostname:'cloud.example',resolvers:['192.0.2.53','2001:db8::53'],systemLookup:false};
const report=(extra:Partial<DiagnosticReport>={}):DiagnosticReport=>{
  const value:DiagnosticReport={complete:true,hostname:'cloud.example',kind:'dns',vantage:'Controlled test collector',startedAt:Date.now(),updatedAt:Date.now(),
    dns:[{kind:'dns',source:'192.0.2.53',recordType:'A',status:'answer',durationMs:12,answers:[{address:'192.0.2.1',family:4,ttl:60}]},
      {kind:'dns',source:'192.0.2.53',recordType:'AAAA',status:'answer',durationMs:18,answers:[{address:'2001:db8::1',family:6,ttl:30}]}],connections:[],findings:[],...extra};
  value.findings=diagnosticFindings(value);return value;
};
const job=(id='dns-browser-job',value=report(),plan:DiagnosticPlan=dnsPlan,status:Job['status']='completed'):Job=>({
  id,requestId:'browser-diagnostic-request',synthetic:false,spec:{mode:'initial',scope:['diagnostics:connectivity'],exclusions:[],intervalMs:1000,maxCycles:1,maxDurationMs:12000,diagnostic:plan},
  status,createdAt:Date.now(),startedAt:Date.now(),finishedAt:status==='running'?null:Date.now(),completedTargets:status==='running'?0:1,totalTargets:1,cyclesCompleted:1,observationsAdded:0,errors:[],diagnosticReport:value,
});
async function setup(page:Page,history:()=>Job[]=()=>[],targeted=true){
  await page.route('**/api/v1/snapshot',(route)=>route.fulfill({json:{runtime:'playback-desktop-v7',synthetic:false,collectionError:null,assets:[],systems:[],stats:[],jobs:history(),targets:[]}}));
  await page.route('**/api/v1/diagnostics/options',(route)=>route.fulfill({json:{source:'Controlled interface DNS configuration',gateway:'192.0.2.1',resolvers:[
    {interface:'Test interface',address:'192.0.2.53',family:4,supported:true},{interface:'Test interface',address:'2001:db8::53',family:6,supported:true},
    {interface:'Test interface',address:'fe80::1',family:6,supported:false}],interfaces:[{name:'Test interface',address:'2001:db8::10',family:'IPv6'}]}}));
  await page.goto('/');await page.getByRole('navigation').getByRole('button',{name:'Diagnostics',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Home tech support diagnosis'})).toBeVisible();
  if(targeted)await page.getByText('DNS settings and targeted hostname checks',{exact:true}).click();
}
test('DNS diagnosis is inactive until exact preview and consent; IPv6 configuration stays visible',async({page})=>{
  let submissions=0;const history:Job[]=[];
  await page.route('**/api/v1/diagnostics/preview',(route)=>{
    const body=route.request().postDataJSON();expect(body.hostname).toBe('cloud.example');expect(body.resolvers).toEqual(['192.0.2.53']);expect(body.systemLookup).toBe(false);
    return route.fulfill({json:{plan:{...dnsPlan,resolvers:body.resolvers},operations:2,maxDurationMs:12000}});
  });
  await page.route('**/api/v1/diagnostics/jobs',async(route)=>{
    submissions++;expect(route.request().postDataJSON().confirmed).toBe(true);await new Promise((resolve)=>setTimeout(resolve,100));
    const saved=job();history.unshift(saved);await route.fulfill({json:{job:saved}});
  });
  await setup(page,()=>history);expect(submissions).toBe(0);
  await expect(page.getByRole('textbox',{name:'DNS servers (up to three literal addresses)'})).toHaveValue('192.0.2.53');
  await page.getByText('Detected IPv4/IPv6 DNS and local addresses',{exact:true}).click();
  await expect(page.getByText(/fe80::1/)).toBeVisible();
  await page.getByRole('textbox',{name:'Hostname',exact:true}).fill('cloud.example');
  await page.getByRole('button',{name:'Review DNS checks',exact:true}).click();
  const start=page.getByRole('button',{name:'Start approved checks',exact:true});await expect(start).toBeDisabled();expect(submissions).toBe(0);
  await page.getByRole('checkbox',{name:'I approve sending this hostname and these exact checks.'}).check();
  await start.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  await expect(page.getByRole('heading',{name:'2. Compare the returned connection paths'})).toBeVisible();expect(submissions).toBe(1);
  await expect(page.getByRole('checkbox',{name:'192.0.2.1 · IPv4',exact:true})).not.toBeChecked();
  await expect(page.getByRole('checkbox',{name:'2001:db8::1 · IPv6',exact:true})).not.toBeChecked();
});

test('custom DNS ports require new consent and missing AAAA explains ping -6 without declaring a path fault',async({page})=>{
  const history:Job[]=[];let submissions=0;
  await page.route('**/api/v1/diagnostics/preview',(route)=>{
    const body=route.request().postDataJSON();expect(body.port).toBe(5353);return route.fulfill({json:{plan:{...dnsPlan,resolvers:body.resolvers,port:body.port},operations:2,maxDurationMs:12000}});
  });
  await page.route('**/api/v1/diagnostics/jobs',(route)=>{
    submissions++;expect(route.request().postDataJSON().port).toBe(5353);
    const value=report({dns:[{...report().dns[0],port:5353},{...report().dns[1],port:5353,status:'no_data',answers:[]}]});
    const saved=job('missing-aaaa',value,{...dnsPlan,port:5353});history.unshift(saved);return route.fulfill({json:{job:saved}});
  });
  await setup(page,()=>history);await page.getByRole('textbox',{name:'Hostname',exact:true}).fill('cloud.example');
  await page.getByRole('spinbutton',{name:'DNS port',exact:true}).fill('5353');await page.getByRole('button',{name:'Review DNS checks',exact:true}).click();
  await page.getByRole('checkbox',{name:'I approve sending this hostname and these exact checks.'}).check();
  await page.getByRole('spinbutton',{name:'DNS port',exact:true}).fill('53');await expect(page.getByRole('button',{name:'Start approved checks'})).toHaveCount(0);expect(submissions).toBe(0);
  await page.getByRole('spinbutton',{name:'DNS port',exact:true}).fill('5353');await page.getByRole('button',{name:'Review DNS checks',exact:true}).click();
  await page.getByRole('checkbox',{name:'I approve sending this hostname and these exact checks.'}).check();await page.getByRole('button',{name:'Start approved checks'}).click();
  await expect(page.getByRole('heading',{name:'IPv4 records are available; IPv6 records are absent'})).toBeVisible();
  await expect(page.getByText(/ping -6 needs an IPv6 address/)).toBeVisible();await expect(page.getByText(/No address record of this type \(NODATA\)/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'IPv4 connected; the tested IPv6 paths did not'})).toHaveCount(0);
});

const internetPlan:DiagnosticPlan={kind:'internet',hostname:'YouTube and Netflix',resolvers:['192.0.2.53'],port:53,gateway:'192.0.2.1',download:true};
function streamingReport(complete=true):DiagnosticReport{
  const value=report({kind:'internet',hostname:'YouTube and Netflix',complete,dns:['www.youtube.com','www.netflix.com'].flatMap((hostname)=>report().dns.map((row)=>({...row,hostname,port:53}))),internet:[
    {kind:'settings',status:'read',gateway:'192.0.2.1',interfaces:[{name:'Test link',family:4,mtu:1500,defaultRoute:true,dhcp:true}]},
    {kind:'latency',target:'192.0.2.1',samples:[{status:'reply',rttMs:1},{status:'reply',rttMs:2},{status:'reply',rttMs:1}],durationMs:500},
    {kind:'latency',target:'1.1.1.1',samples:[{status:'reply',rttMs:12},{status:'reply',rttMs:20},{status:'timeout',rttMs:null}],durationMs:1500},
    {kind:'mtu',target:'1.1.1.1',status:'inconclusive',mtu:null,probes:[{payload:1472,status:'timeout'}],durationMs:1000},
    {kind:'transfer',status:'byte_cap',bytes:DOWNLOAD_BYTES,durationMs:4000,mbps:DOWNLOAD_BYTES*8/4000000},
  ]});value.findings=internetFindings(value);return value;
}
test('home streaming checks show exact targets and download budget, save useful measurements and preserve uncertainty',async({page},info)=>{
  const history:Job[]=[];let starts=0,previews=0;
  await page.route('**/api/v1/diagnostics/preview',(route)=>{
    previews++;const body=route.request().postDataJSON();expect(body.kind).toBe('internet');expect(body.hostname).toBeUndefined();expect(body.gateway).toBe('192.0.2.1');
    return route.fulfill({json:{plan:{...internetPlan,download:body.download},operations:9,maxDurationMs:45000}});
  });
  await page.route('**/api/v1/diagnostics/jobs',(route)=>{
    starts++;const body=route.request().postDataJSON();expect(body.download).toBe(true);expect(body.confirmed).toBe(true);
    const saved=job('streaming-diagnosis',streamingReport(),internetPlan,'completed_with_issues');history.unshift(saved);return route.fulfill({json:{job:saved}});
  });
  await setup(page,()=>history,false);await expect(page.getByRole('checkbox',{name:'Include an 8 MiB streaming capacity download'})).not.toBeChecked();
  await page.getByRole('button',{name:'Review Internet and streaming checks'}).click();await expect(page.getByText('No capacity download selected.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start approved checks'})).toBeDisabled();expect(starts).toBe(0);
  await page.getByRole('checkbox',{name:'Include an 8 MiB streaming capacity download'}).check();await expect(page.getByRole('button',{name:'Start approved checks'})).toHaveCount(0);
  await page.getByRole('button',{name:'Review Internet and streaming checks'}).click();await expect(page.getByText(/Download at most 8 MiB of response body from https:\/\/speed.cloudflare.com/)).toBeVisible();
  await page.getByRole('checkbox',{name:'I approve sending this hostname and these exact checks.'}).check();await page.getByRole('button',{name:'Start approved checks'}).click();expect(previews).toBe(2);
  await expect(page.getByRole('heading',{name:'Local interface settings'})).toBeVisible();await expect(page.getByText(/Test link · IPv4 · MTU 1500/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Internet latency needs attention'})).toBeVisible();await expect(page.getByRole('heading',{name:'Path MTU was not established'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Measured download capacity: 16.8 Mbps'})).toBeVisible();await expect(page.getByText(/not observed playback quality/)).toBeVisible();expect(starts).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const path=info.outputPath('home-streaming-diagnosis.png');await page.screenshot({path,fullPage:true});await info.attach('home-streaming-diagnosis',{path,contentType:'image/png'});
});
test('interrupted streaming evidence stays partial and carries no final MTU or capacity verdict',async({page})=>{
  const current=job('partial-streaming',streamingReport(false),internetPlan,'interrupted');await setup(page,()=>[current],false);
  await expect(page.getByText(/interrupted · Partial results/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Path MTU was not established'})).toHaveCount(0);await expect(page.getByRole('heading',{name:/Measured download capacity:/})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Streaming capacity sample'})).toBeVisible();
});
test('selected IPv4 and IPv6 paths show an evidence-based distinction and a clear next step',async({page},info)=>{
  const history:Job[]=[job()];let connections=0;
  await page.route('**/api/v1/diagnostics/preview',(route)=>{
    const body=route.request().postDataJSON();expect(body.addresses).toEqual(['192.0.2.1','2001:db8::1']);expect(body.port).toBe(443);expect(body.tls).toBe(true);
    return route.fulfill({json:{plan:{kind:'connect',hostname:'cloud.example',dnsJobId:history[0].id,addresses:body.addresses,port:443,tls:true},operations:2}});
  });
  await page.route('**/api/v1/diagnostics/jobs',(route)=>{
    connections++;const plan:DiagnosticPlan={kind:'connect',hostname:'cloud.example',dnsJobId:history[0].id,addresses:['192.0.2.1','2001:db8::1'],port:443,tls:true};
    const saved=job('connection-browser-job',report({kind:'connect',dns:[],connections:[
      {kind:'connect',address:'192.0.2.1',family:4,port:443,sourceAddress:'192.0.2.10',tcp:'connected',tls:'verified',durationMs:15},
      {kind:'connect',address:'2001:db8::1',family:6,port:443,sourceAddress:null,tcp:'unreachable',tls:'not_reached',durationMs:10}]}),plan,'completed_with_issues');
    history.unshift(saved);return route.fulfill({json:{job:saved}});
  });
  await setup(page,()=>history);
  await expect(page.getByRole('button',{name:'Review connection checks'})).toBeDisabled();
  await page.getByRole('checkbox',{name:'192.0.2.1 · IPv4',exact:true}).check();
  await page.getByRole('checkbox',{name:'2001:db8::1 · IPv6',exact:true}).check();
  await page.getByRole('button',{name:'Review connection checks'}).click();
  await page.getByRole('checkbox',{name:'I approve sending this hostname and these exact checks.'}).check();
  await page.getByRole('button',{name:'Start approved checks'}).click();
  await expect(page.getByRole('heading',{name:'IPv4 connected; the tested IPv6 paths did not'})).toBeVisible();
  await expect(page.getByText(/Check that the AAAA records match the server/)).toBeVisible();expect(connections).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const path=info.outputPath('dns-ipv6-diagnosis.png');await page.screenshot({path,fullPage:true});await info.attach('dns-ipv6-diagnosis',{path,contentType:'image/png'});
  await page.getByRole('navigation').getByRole('button',{name:'Activity',exact:true}).click();
  await page.getByRole('button',{name:'View diagnosis',exact:true}).nth(1).click();
  await expect(page.getByRole('heading',{name:'2. Compare the returned connection paths'})).toBeVisible();
});
test('slow IPv6 DNS queries retain timing and TTLs without claiming the service IPv6 path failed',async({page})=>{
  const value=report({dns:[{...report().dns[0],durationMs:900},
    {kind:'dns',source:'2001:db8::53',recordType:'A',status:'timeout',durationMs:1500,answers:[]}]});
  await setup(page,()=>[job('slow-dns',value,dnsPlan,'completed_with_issues'),job('previous-dns')]);
  await expect(page.getByRole('heading',{name:'Some DNS checks took at least 500 ms'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'A query to an IPv6 DNS server failed while another resolver answered'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'IPv4 connected; the tested IPv6 paths did not'})).toHaveCount(0);
  await expect(page.getByText('192.0.2.1 · IPv4 · TTL 60 seconds',{exact:true})).toBeVisible();
  await page.getByText('Recent DNS timing for this hostname',{exact:true}).click();await expect(page.getByText(/1500 ms slowest DNS check/)).toBeVisible();
});
test('cancelled diagnosis keeps partial results without a final conclusion and stale API blocks new work',async({page})=>{
  let current=job('active-dns',report({complete:false,dns:[report().dns[0]]}),dnsPlan,'running');let cancellations=0;
  await page.route('**/api/v1/jobs/active-dns/cancel',(route)=>{cancellations++;current={...current,status:'cancelled'};return route.fulfill({json:{job:current}});});
  await setup(page,()=>[current]);
  await expect(page.getByText(/Partial results; no final diagnosis yet/)).toBeVisible();
  await page.getByRole('button',{name:'Cancel checks',exact:true}).click();
  await expect(page.getByText(/cancelled · Partial results/)).toBeVisible();expect(cancellations).toBe(1);
  await page.route('**/api/v1/snapshot',(route)=>route.abort('failed'));
  await expect(page.getByText(/The local API is unavailable/).first()).toBeVisible({timeout:6000});
  await expect(page.getByRole('button',{name:'Review DNS checks',exact:true})).toBeDisabled();
});
