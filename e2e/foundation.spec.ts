import { test,expect } from './fixtures.js';
import type { Page,TestInfo } from '@playwright/test';
const iface={id:'qa-interface',name:'Isolated test link',address:'192.0.2.10',netmask:'255.255.255.0',cidr:'192.0.2.0/24'};
const other={...iface,id:'other-interface',name:'Other test link',address:'198.51.100.10',cidr:'198.51.100.0/24'};
const defaults={
  [iface.id]:{source:'Windows interface DNS configuration',resolver:'192.0.2.53',servers:[
    {address:'192.0.2.53',supported:true,reason:'On the selected interface subnet'},{address:'192.0.2.54',supported:true,reason:'On the selected interface subnet'}]},
  [other.id]:{source:'System-wide DNS configuration',resolver:'',servers:[{address:'8.8.8.8',supported:false,reason:'Unsupported here: resolver must be on this interface subnet'}]},
};
const plan={interface:iface,cidr:iface.cidr,targets:['192.0.2.1'],methods:['tcp'],ports:[443],resolver:null,linkScopeConfirmed:false,tcpBudget:1,dnsBudget:0,datagramBudget:0};
const evidence={synthetic:false,id:'qa-observation',assetId:'qa-asset',subjectKey:'qa-job/192.0.2.1',label:'Address candidate 192.0.2.1',kind:'address-candidate',
  source:'discovery-v1',vantage:'interface 192.0.2.10',observedAt:Date.now(),receivedAt:Date.now(),ttlMs:60000,status:'unknown',
  note:'Network response observed; identity and health are unverified.',identifiers:[{kind:'ip',value:'192.0.2.1'}],
  services:[{name:'TCP 443',status:'unknown',note:'Connect result: open. No payload or service-health test.'}]};
const asset={id:'qa-asset',subjectKey:'qa-job/192.0.2.1',label:evidence.label,kind:'address-candidate',identityConfidence:'source-scoped',identityWarnings:[],freshness:'fresh',health:'unknown',latest:evidence};
const job=(status='running')=>({id:'qa-job',synthetic:false,requestId:'qa-request',spec:{mode:'initial',scope:['discovery:ipv4'],exclusions:[],intervalMs:1000,maxCycles:1,maxDurationMs:60000,discovery:plan},
  status,createdAt:Date.now(),startedAt:Date.now(),finishedAt:null,completedTargets:0,totalTargets:1,cyclesCompleted:0,observationsAdded:1,errors:[],
  discoveryProgress:{addressesCompleted:1,totalAddresses:1,tcpCompleted:1,dnsCompleted:0,datagramsSent:0}});
const snapshot=(assets:unknown[]=[],jobs:unknown[]=[])=>({runtime:'real-discovery-v2',synthetic:false,collectionError:null,assets,jobs,targets:[]});
const nav=(page:Page,name:string)=>page.getByRole('navigation').getByRole('button',{name,exact:true});
async function options(page:Page){await page.route('**/api/v1/discovery/options',(route)=>route.fulfill({json:{interfaces:[iface,other],defaults,limits:{}}}));}
async function setup(page:Page){await options(page);await page.goto('/');await page.getByRole('combobox',{name:'Source interface'}).selectOption(iface.id);}
async function tcp(page:Page,ports='443'){await page.getByRole('checkbox',{name:'TCP connect port probes',exact:true}).check();await page.getByRole('textbox',{name:'TCP ports, comma separated (maximum eight)'}).fill(ports);}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);}
async function screenshot(page:Page,info:TestInfo,name:string){const path=info.outputPath(name+'.png');await page.screenshot({path,fullPage:true});await info.attach(name,{path,contentType:'image/png'});}

test('normal production opens real discovery with no demo controls or automatic job',async({page},info)=>{
  await options(page);await page.goto('/');
  await expect(nav(page,'Discovery')).toHaveAttribute('aria-current','page');
  await expect(page.getByRole('heading',{name:'Scoped IPv4 discovery'})).toBeVisible();
  await expect(page.getByText('real-discovery-v2',{exact:true})).toBeVisible();
  await expect(page.getByText(/Synthetic demo only|Demo storage|Collect initial fixtures|Live fixture updates/)).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'Source interface'})).toHaveValue('');
  for(const box of await page.getByRole('checkbox').all())await expect(box).not.toBeChecked();
  await expect(page.getByText('Choose a source interface.',{exact:true})).toBeVisible();
  await nav(page,'Inventory').click();await expect(page.getByRole('heading',{name:'No network observations yet'})).toBeVisible();
  await nav(page,'Activity').click();await expect(page.locator('.job-list article')).toHaveCount(0);
  await nav(page,'Discovery').click();await screenshot(page,info,'real-discovery-empty');await noOverflow(page);
});

test('interface selection prefills actual CIDR and supported DNS while preserving edits',async({page})=>{
  await setup(page);
  await expect(page.getByRole('textbox',{name:'Approved IPv4 CIDR'})).toHaveValue(iface.cidr);
  await page.getByRole('checkbox',{name:'Reverse DNS (PTR) through my chosen resolver',exact:true}).check();
  const resolver=page.getByRole('textbox',{name:'Explicit on-link IPv4 DNS resolver'});
  await expect(resolver).toHaveValue('192.0.2.53');
  await page.getByRole('button',{name:'Use 192.0.2.54',exact:true}).click();await expect(resolver).toHaveValue('192.0.2.54');
  await resolver.fill('192.0.2.55');await page.getByRole('textbox',{name:'Approved IPv4 CIDR'}).fill('192.0.2.0/28');
  await expect(resolver).toHaveValue('192.0.2.55');
  await page.getByRole('combobox',{name:'Source interface'}).selectOption(other.id);
  await expect(resolver).toHaveValue('');await expect(page.getByRole('textbox',{name:'Approved IPv4 CIDR'})).toHaveValue(other.cidr);
  await expect(page.getByText(/Unsupported here: resolver/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview discovery'})).toBeDisabled();
});

test('full port list and target multiplication explain budget and invalid-token recovery',async({page},info)=>{
  await setup(page);await tcp(page,'80,443,8080,8443,22');
  await expect(page.getByText(/253 targets × 5 unique ports = 1265 TCP attempts/)).toBeVisible();
  await expect(page.getByText(/Choose at most 4 ports for this scope/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview discovery'})).toBeDisabled();
  const ports=page.getByRole('textbox',{name:'TCP ports, comma separated (maximum eight)'});
  await ports.fill('80,443,8080,8443');await expect(ports).toHaveValue('80,443,8080,8443');
  await expect(page.getByText(/253 targets × 4 unique ports = 1012 TCP attempts/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview discovery'})).toBeEnabled();
  await ports.fill('80,invalid');await expect(page.getByText(/TCP ports: enter 1–8 unique whole numbers/)).toBeVisible();
  await ports.fill('443');await expect(page.getByRole('button',{name:'Preview discovery'})).toBeEnabled();
  await screenshot(page,info,'real-discovery-budget');await noOverflow(page);
});

test('preview changes invalidate consent and repeated start sends exactly one request',async({page})=>{
  let submitted=0;
  await page.route('**/api/v1/discovery/preview',(route)=>route.fulfill({json:{plan}}));
  await page.route('**/api/v1/discovery/jobs',async(route)=>{submitted++;expect(route.request().postDataJSON().confirmScope).toBe(true);await new Promise((resolve)=>setTimeout(resolve,100));await route.fulfill({json:{job:job()}});});
  await setup(page);await tcp(page);
  await page.getByRole('button',{name:'Preview discovery'}).click();
  await expect(page.getByRole('button',{name:'Start approved discovery'})).toBeDisabled();
  await page.getByRole('checkbox',{name:'I confirm this exact scope and these network methods.'}).check();
  await page.getByRole('textbox',{name:'Approved IPv4 CIDR'}).fill('192.0.2.0/28');
  await expect(page.getByRole('heading',{name:'Review this exact scope'})).toHaveCount(0);expect(submitted).toBe(0);
  await page.getByRole('button',{name:'Preview discovery'}).click();
  await page.getByRole('checkbox',{name:'I confirm this exact scope and these network methods.'}).check();
  await page.getByRole('button',{name:'Start approved discovery'}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  await expect(page.getByRole('heading',{name:'Collection activity'})).toBeVisible();expect(submitted).toBe(1);
});

test('network inventory and evidence exclude synthetic records even in a mixed API response',async({page},info)=>{
  let stale=false;
  await page.route('**/api/v1/snapshot',(route)=>route.fulfill({json:snapshot([{...asset,freshness:stale?'stale':'fresh'},{...asset,id:'hidden',label:'Hidden sample',latest:{...evidence,synthetic:true,source:'fixture-v1'}}])}));
  await page.route('**/api/v1/assets/qa-asset',(route)=>route.fulfill({json:{asset,observations:[evidence,{...evidence,id:'hidden-history',synthetic:true}]}}));
  await page.goto('/');await nav(page,'Inventory').click();
  await expect(page.locator('.asset-grid article')).toHaveCount(1);await expect(page.getByText('Hidden sample')).toHaveCount(0);
  await page.getByRole('button',{name:'Inspect system'}).click();
  await expect(page.getByText('Network evidence',{exact:true}).first()).toBeVisible();
  await expect(page.getByText('discovery-v1',{exact:true}).first()).toBeVisible();
  await expect(page.getByText('TCP 443',{exact:true}).first()).toBeVisible();
  await expect(page.locator('details')).toHaveCount(1);
  stale=true;await expect(page.locator('.columns > section').first().locator('.badge.stale')).toHaveCount(1,{timeout:6000});
  await screenshot(page,info,'real-evidence');await noOverflow(page);
});

test('active discovery explains the form lock and cancellation preserves saved evidence',async({page})=>{
  let state=job();
  await page.route('**/api/v1/snapshot',(route)=>route.fulfill({json:snapshot([asset],[state])}));
  await page.route('**/api/v1/jobs/qa-job/cancel',(route)=>{state=job('cancelled');return route.fulfill({json:{job:state}});});
  await options(page);await page.goto('/');
  await expect(page.getByText('A discovery job is active. Open Activity to review progress or cancel it.',{exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Source interface'})).toBeDisabled();
  await page.getByRole('button',{name:'View activity'}).click();
  await page.getByRole('button',{name:'Cancel collection'}).click();
  await expect(page.locator('.badge.cancelled')).toHaveCount(1);
  await nav(page,'Inventory').click();await expect(page.locator('.asset-grid article')).toHaveCount(1);
  await nav(page,'Discovery').click();await expect(page.getByRole('combobox',{name:'Source interface'})).toBeEnabled();
});

test('method issues remain visible and API interruption retries without starting another scan',async({page},info)=>{
  let unavailable=false,submissions=0;
  const partial={...job('completed_with_issues'),discoveryOutcomes:[{method:'tcp',attempted:1,completed:1,responses:0,durationMs:20,issues:['access_denied']}]};
  await page.route('**/api/v1/snapshot',(route)=>unavailable?route.abort('failed'):route.fulfill({json:snapshot([asset],[partial])}));
  await page.route('**/api/v1/discovery/jobs',(route)=>{submissions++;return route.abort();});
  await page.goto('/');await nav(page,'Activity').click();
  await expect(page.getByText(/Collection completed with method issues/)).toBeVisible();
  await expect(page.getByText(/operating system denied this method/)).toBeVisible();
  unavailable=true;await expect(page.getByText(/The local API is unavailable/)).toBeVisible({timeout:6000});
  unavailable=false;await page.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page.getByText(/The local API is unavailable/)).toHaveCount(0);
  expect(submissions).toBe(0);await screenshot(page,info,'method-issues');
});

test('navigation, keyboard and link-wide controls remain accessible without placeholder screens',async({page})=>{
  await options(page);await page.goto('/');
  await page.keyboard.press('Tab');await expect(nav(page,'Discovery')).toBeFocused();
  await page.keyboard.press('Tab');await page.keyboard.press('Enter');await expect(nav(page,'Inventory')).toHaveAttribute('aria-current','page');
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(4);
  await nav(page,'Discovery').click();await page.getByRole('combobox',{name:'Source interface'}).selectOption(iface.id);
  await page.getByRole('checkbox',{name:'Legacy NetBIOS browse-master broadcast (limited coverage)',exact:true}).check();
  await expect(page.getByText('Approve link-wide transmission before previewing these methods.',{exact:true})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'I approve link-wide transmission on 192.0.2.0/24, including all hosts on that link.'})).not.toBeChecked();
  await expect(page.getByRole('checkbox',{name:'mDNS service-type multicast (not full service discovery)',exact:true})).not.toBeChecked();
  await expect(page.getByRole('checkbox',{name:'SSDP root-device multicast (no URL fetching)',exact:true})).not.toBeChecked();
  await noOverflow(page);
});
