import {test,expect} from './fixtures.js';
import type {Page} from '@playwright/test';
import type {Job} from '../shared/types.js';
import {DNS_BENCHMARK_LIMITS,benchmarkComparisons,type DnsBenchmarkPlan,type DnsBenchmarkReport,type DnsBenchmarkResult} from '../shared/dns-benchmark.js';

const configured=[
  {interface:'Controlled Ethernet',address:'192.0.2.53',family:4,supported:true},
  {interface:'Controlled Ethernet',address:'2001:db8::53',family:6,supported:true},
  {interface:'Controlled Ethernet',address:'fe80::1%12',family:6,supported:true},
  {interface:'Controlled unscoped entry',address:'fe80::2',family:6,supported:false,reason:'An interface scope is required.'},
];
const candidates=[{label:'Public IPv4 fixture',address:'198.51.100.53'},{label:'Public IPv6 fixture',address:'2001:db8:1::53'}];
const defaultAddresses=[...configured.filter(row=>row.supported).map(row=>row.address),...candidates.map(row=>row.address)];
const plan:DnsBenchmarkPlan={hostnames:['example.com'],resolvers:['192.0.2.53','2001:db8::53'],port:53,protocols:['udp','tcp'],recordTypes:['A','AAAA'],requests:10,timeoutSeconds:1};

function report(complete=true):DnsBenchmarkReport{
  const results:DnsBenchmarkResult[]=benchmarkComparisons(plan).map(cell=>({
    ...cell,port:53,family:cell.resolver.includes(':')?6:4,status:'complete',totalRequests:10,
    successfulRequests:cell.resolver.includes(':')?10:9,successPercent:cell.resolver.includes(':')?100:90,
    minMs:cell.resolver.includes(':')?20:0.5,avgMs:cell.resolver.includes(':')?30:1,maxMs:cell.resolver.includes(':')?40:2,
    lastResolvedAddress:cell.recordType==='A'?'203.0.113.1':'2001:db8::100',issue:null,
  }));
  return {complete,tool:'dns-bench',toolVersion:'0.14.0',vantage:'Controlled remote collector',startedAt:Date.now(),updatedAt:Date.now(),totalComparisons:results.length,results};
}
function job(value=report(),status:Job['status']='completed_with_issues'):Job{
  return {id:'dns-benchmark-browser-job',requestId:'dns-benchmark-browser-request',synthetic:false,
    spec:{mode:'initial',scope:['diagnostics:dns-benchmark'],exclusions:[],intervalMs:1000,maxCycles:1,maxDurationMs:180000,dnsBenchmark:plan},
    status,createdAt:Date.now(),startedAt:Date.now(),finishedAt:status==='running'?null:Date.now(),completedTargets:0,totalTargets:1,cyclesCompleted:1,observationsAdded:0,errors:[],dnsBenchmarkReport:value};
}
async function setup(page:Page,history:()=>Job[]=()=>[],available=true,resolvers=configured){
  await page.route('**/api/v1/snapshot',route=>route.fulfill({json:{runtime:'playback-desktop-v7',synthetic:false,collectionError:null,assets:[],systems:[],stats:[],jobs:history(),targets:[]}}));
  await page.route('**/api/v1/diagnostics/options',route=>route.fulfill({json:{source:'Controlled system DNS',resolvers:configured,interfaces:[]}}));
  let reads=0;
  await page.route('**/api/v1/dns-benchmark/options',route=>{reads++;return route.fulfill({json:{capability:{available,version:available?'0.14.0':null,reason:available?null:'Install the supported dns-bench executable on this collector.'},source:'Controlled system DNS configuration',resolvers,publicResolvers:candidates,limits:DNS_BENCHMARK_LIMITS}});});
  await page.goto('/');expect(reads).toBe(0);
  await page.getByRole('navigation').getByRole('button',{name:'Diagnostics',exact:true}).click();
  await expect(page.getByRole('heading',{name:'DNS benchmark: system resolvers and IPv6'})).toBeVisible();
  await expect.poll(()=>reads).toBe(1);
}

test('benchmark defaults preserve system IPv4, global and scoped IPv6 with both protocols and record types',async({page})=>{
  let previews=0,starts=0;
  await page.route('**/api/v1/dns-benchmark/preview',route=>{
    previews++;
    const body=route.request().postDataJSON();
    expect(body.resolvers).toEqual(defaultAddresses);
    expect(body.protocols).toEqual(['udp','tcp']);expect(body.recordTypes).toEqual(['A','AAAA']);
    expect(body.hostnames).toEqual(['example.com','cloudflare.com','quad9.net']);
    expect(body.requests).toBe(10);expect(body.timeoutSeconds).toBe(1);
    return route.fulfill({json:{plan:body,maxDurationMs:180000,comparisons:60,lookupIterations:600,warning:'Every listed resolver receives the selected public names.'}});
  });
  await page.route('**/api/v1/dns-benchmark/jobs',route=>{starts++;return route.fulfill({json:{job:job()}});});
  await setup(page);
  await expect(page.getByRole('textbox',{name:'Benchmark DNS servers (up to 16 literal addresses)'})).toHaveValue(defaultAddresses.join('\n'));
  await page.getByText('Detected system DNS and public candidates',{exact:true}).click();
  await expect(page.getByText(/fe80::2.*Unavailable for this benchmark/)).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'UDP',exact:true})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'TCP',exact:true})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'A (IPv4 answers)',exact:true})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'AAAA (IPv6 answers)',exact:true})).toBeChecked();
  expect(starts).toBe(0);
  await page.getByRole('button',{name:'Review DNS benchmark',exact:true}).click();
  await expect(page.getByText(/60 comparisons · up to 600 lookup iterations/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Start approved DNS benchmark'})).toBeDisabled();
  await page.getByRole('checkbox',{name:'I approve this DNS benchmark and its listed recipients.'}).check();
  await page.getByRole('checkbox',{name:'TCP',exact:true}).uncheck();
  await expect(page.getByRole('button',{name:'Start approved DNS benchmark'})).toHaveCount(0);
  expect(starts).toBe(0);expect(previews).toBe(1);
});

test('missing tool remains distinct from DNS failure and prevents starting an approved run',async({page})=>{
  let starts=0;
  await page.route('**/api/v1/dns-benchmark/preview',route=>{const body=route.request().postDataJSON();return route.fulfill({json:{plan:body,maxDurationMs:180000,comparisons:60,lookupIterations:600,warning:'Public queries are disclosed.'}});});
  await page.route('**/api/v1/dns-benchmark/jobs',route=>{starts++;return route.fulfill({json:{job:job()}});});
  await setup(page,()=>[],false);
  await expect(page.getByText('DNS benchmark is unavailable on this collector.')).toBeVisible();
  await expect(page.getByRole('link',{name:'DNS benchmark setup'})).toHaveAttribute('href',/docs\/dns-benchmark\.md$/);
  await page.getByRole('button',{name:'Review DNS benchmark',exact:true}).click();
  await page.getByRole('checkbox',{name:'I approve this DNS benchmark and its listed recipients.'}).check();
  await expect(page.getByRole('button',{name:'Start approved DNS benchmark'})).toBeDisabled();expect(starts).toBe(0);
});

test('complete coverage and reliability rank ahead of lower successful latency',async({page},info)=>{
  await setup(page,()=>[job()]);
  await expect(page.getByRole('heading',{name:'Lowest mean among fully successful tests'})).toBeVisible();
  const summary=page.getByRole('region',{name:'DNS resolver comparison',exact:true});
  await expect(summary.locator('tbody tr').first()).toContainText('2001:db8::53');
  await expect(summary.locator('tbody tr').first()).toContainText('40/40 (100.0%)');
  await expect(summary.locator('tbody tr').first()).toContainText('30.00 ms');
  await expect(summary.locator('tbody tr').nth(1)).toContainText('36/40 (90.0%)');
  await expect(page.getByText(/Controlled remote collector · dns-bench 0.14.0/)).toBeVisible();
  await page.getByText('Individual DNS benchmark measurements',{exact:true}).click();
  await expect(page.getByRole('region',{name:'Individual DNS benchmark measurements',exact:true}).locator('tbody tr')).toHaveCount(8);
  await expect(page.getByRole('region',{name:'Individual DNS benchmark measurements',exact:true}).getByRole('cell',{name:'2001:db8::100',exact:true})).toHaveCount(4);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const path=info.outputPath('dns-benchmark-results.png');await page.screenshot({path,fullPage:true});await info.attach('dns-benchmark-results',{path,contentType:'image/png'});
});

test('cancellation keeps partial comparisons and never selects a preferred resolver',async({page})=>{
  const partial=report(false);partial.results=partial.results.filter(row=>row.resolver==='2001:db8::53');
  let current=job(partial,'running'),cancellations=0;
  await page.route('**/api/v1/jobs/dns-benchmark-browser-job/cancel',route=>{cancellations++;current={...current,status:'cancelled'};return route.fulfill({json:{job:current}});});
  await setup(page,()=>[current]);
  await expect(page.getByText('DNS benchmark running · Partial results; comparison is incomplete.')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Lowest mean among fully successful tests'})).toHaveCount(0);
  const summary=page.getByRole('region',{name:'DNS resolver comparison',exact:true});
  await expect(summary.getByRole('row',{name:/192.0.2.53/})).toContainText('Not measured');
  await expect(page.getByRole('progressbar',{name:'DNS benchmark comparisons'})).toHaveAttribute('value','4');
  await page.getByRole('button',{name:'Cancel DNS benchmark',exact:true}).click();
  await expect(page.getByText('DNS benchmark cancelled · Partial results; comparison is incomplete.')).toBeVisible();
  expect(cancellations).toBe(1);
  await expect(summary.getByRole('row',{name:/2001:db8::53/})).toContainText('30.00 ms');
});

test('resolver limits retain every discovered address and require explicit batching',async({page})=>{
  const many=Array.from({length:17},(_,index)=>({interface:'Controlled interface '+index,address:'2001:db8::'+(index+1),family:6,supported:true}));
  await setup(page,()=>[],true,many);
  const selected=page.getByRole('textbox',{name:'Benchmark DNS servers (up to 16 literal addresses)'});
  await expect(selected).toHaveValue([...many.map(row=>row.address),...candidates.map(row=>row.address)].join('\n'));
  await expect(page.getByText(/All detected and public addresses are retained/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Review DNS benchmark',exact:true})).toBeDisabled();
});

test('unsupported system DNS is prominent and cannot be mistaken for a full system comparison',async({page})=>{
  await setup(page,()=>[],true,[configured[3]]);
  await expect(page.getByText(/System DNS was detected, but none of its addresses can be benchmarked here/)).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Benchmark DNS servers (up to 16 literal addresses)'})).toHaveValue(candidates.map(row=>row.address).join('\n'));
});
