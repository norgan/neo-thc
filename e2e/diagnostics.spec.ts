import {test,expect} from './fixtures.js';
import type {Page} from '@playwright/test';
import type {DiagnosticReport,Job,DiagnosticPlan} from '../shared/types.js';
import {diagnosticFindings} from '../shared/diagnostics.js';

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
async function setup(page:Page,history:()=>Job[]=()=>[]){
  await page.route('**/api/v1/snapshot',(route)=>route.fulfill({json:{runtime:'network-diagnostics-v5',synthetic:false,collectionError:null,assets:[],systems:[],stats:[],jobs:history(),targets:[]}}));
  await page.route('**/api/v1/diagnostics/options',(route)=>route.fulfill({json:{source:'Controlled interface DNS configuration',resolvers:[
    {interface:'Test interface',address:'192.0.2.53',family:4,supported:true},{interface:'Test interface',address:'2001:db8::53',family:6,supported:true},
    {interface:'Test interface',address:'fe80::1',family:6,supported:false}],interfaces:[{name:'Test interface',address:'2001:db8::10',family:'IPv6'}]}}));
  await page.goto('/');await page.getByRole('navigation').getByRole('button',{name:'Diagnostics',exact:true}).click();
  await expect(page.getByRole('heading',{name:'DNS and connection diagnosis'})).toBeVisible();
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
