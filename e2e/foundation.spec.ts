import { test, expect } from './fixtures.js';
import type { Page, TestInfo } from '@playwright/test';

function nav(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true });
}
async function initial(page: Page) {
  await nav(page, 'Overview').click();
  await page.getByRole('button', { name: 'Collect initial fixtures', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collection activity' })).toBeVisible();
  await expect(page.locator('.job-list .badge.completed')).toHaveCount(1);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + '.png');
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('empty inventory becomes evidence-backed inventory with separate address identities', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Start with what we know.' })).toBeVisible();
  await expect(page.getByText('Synthetic demo only', { exact: true })).toBeVisible();
  await nav(page, 'Inventory').click();
  await expect(page.getByRole('heading', { name: 'No observations yet' })).toBeVisible();
  await initial(page);
  await nav(page, 'Inventory').click();
  await expect(page.locator('.asset-grid article')).toHaveCount(6);
  await noOverflow(page);
  await screenshot(page, info, 'inventory');

  const historical = page.locator('.asset-grid article').filter({ has: page.getByRole('heading', { name: 'Demo previous address holder' }) });
  await expect(historical.locator('.badge.stale')).toBeVisible();
  await expect(historical.locator('.badge.unknown')).toBeVisible();
  await expect(page.locator('.asset-grid .caution')).toHaveCount(2);

  const storage = page.locator('.asset-grid article').filter({ has: page.getByRole('heading', { name: 'Demo storage', exact: true }) });
  await storage.getByRole('button', { name: 'Inspect system' }).click();
  await expect(page.getByRole('heading', { name: 'Identity and current confidence' })).toBeVisible();
  const identity = page.locator('.columns > section').first();
  await expect(identity.getByText('fixture-v1', { exact: true })).toBeVisible();
  await expect(identity.getByText('synthetic-local-demo', { exact: true })).toBeVisible();
  await expect(identity.locator('.services li').filter({ hasText: 'NFS' }).locator('.badge')).toHaveText('unhealthy');
  await expect(identity.locator('.services li').filter({ hasText: 'SMB' }).locator('.badge')).toHaveText('healthy');
  await expect(identity.locator('.services li').filter({ hasText: 'ping' }).locator('.badge')).toHaveText('healthy');
  await expect(page.getByText('Root cause is unknown.', { exact: false }).first()).toBeVisible();
  await noOverflow(page);
  await screenshot(page, info, 'storage-evidence');
  await page.getByRole('button', { name: 'Back to inventory' }).click();
  await expect(page.locator('.asset-grid article')).toHaveCount(6);
});

test('scope selection persists and exclusions prevent collection', async ({ page }) => {
  await page.goto('/');
  const gateway = page.getByRole('checkbox', { name: 'Demo gateway', exact: true });
  await expect(gateway).toBeChecked();
  await gateway.uncheck();
  await page.reload();
  await expect(gateway).not.toBeChecked();
  await page.getByText('Limits and exclusions', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Exclude Demo storage', exact: true }).check();
  await initial(page);
  await nav(page, 'Inventory').click();
  await expect(page.locator('.asset-grid article')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: 'Demo gateway', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Demo storage', exact: true })).toHaveCount(0);
});

test('live collection prevents duplicate clicks and survives tab navigation before cancellation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start live fixtures', exact: true })).toBeEnabled();
  await page.getByText('Limits and exclusions', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Live cycles (1–15, two seconds apart)' }).fill('15');
  let posts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/jobs', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    posts++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const start = page.getByRole('button', { name: 'Start live fixtures', exact: true });
    await start.click();
    await expect(start).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Collect initial fixtures', exact: true })).toBeDisabled();
    await expect.poll(() => posts).toBe(1);
    const bounds = await start.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    expect(posts).toBe(1);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Collection activity' })).toBeVisible();
  await nav(page, 'Inventory').click();
  await expect(page.locator('.asset-grid article')).toHaveCount(6);
  await nav(page, 'Activity').click();
  await page.getByRole('button', { name: 'Cancel collection', exact: true }).click();
  await expect(page.locator('.job-list .badge.cancelled')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Cancel collection', exact: true })).toHaveCount(0);
  await expect(page.locator('.job-list article')).toHaveCount(1);
  await nav(page, 'Overview').click();
  await expect(page.getByRole('button', { name: 'Start live fixtures', exact: true })).toBeEnabled();
});

test('API interruption marks displayed data stale and retry recovers without duplicate work', async ({ page }, info) => {
  await page.goto('/');
  await initial(page);
  await nav(page, 'Inventory').click();
  await expect(page.locator('.asset-grid article')).toHaveCount(6);
  let offline = true;
  await page.route('**/api/**', async (route) => {
    if (offline) await route.abort('failed'); else await route.fallback();
  });
  await expect(page.getByText('The local API is unavailable.', { exact: false })).toBeVisible();
  await expect(page.locator('.asset-grid article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Displayed information may be out of date.', { exact: false })).toBeVisible();
  await screenshot(page, info, 'api-unavailable');
  offline = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('The local API is unavailable.', { exact: false })).toHaveCount(0);
  await nav(page, 'Activity').click();
  await expect(page.locator('.job-list article')).toHaveCount(1);
  await expect(page.locator('.job-list .badge.completed')).toHaveCount(1);
});

test('navigation, labels, keyboard focus and mobile layout expose the fixture boundary', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Explicit fixture scope' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(7);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(nav(page, 'Overview')).toBeFocused();
  expect(await nav(page, 'Overview').evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('3px');
  await page.keyboard.press('Tab');
  await expect(nav(page, 'Inventory')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'No observations yet' })).toBeVisible();
  for (const item of ['System', 'Connections', 'DNS', 'Activity', 'Overview']) {
    await nav(page, item).click();
    await expect(nav(page, item)).toHaveAttribute('aria-current', 'page');
    await noOverflow(page);
  }
  await nav(page, 'Connections').click();
  await expect(page.getByText('No device integrations are installed or connected.', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await nav(page, 'DNS').click();
  await expect(page.getByText('No DNS queries run automatically.', { exact: false })).toBeVisible();
  await screenshot(page, info, 'planned-dns');
});

test('simulated Proxmox inventory is opt-in and platform availability stays uncertain', async ({ page }, info) => {
  await page.goto('/');
  const simulated = page.getByRole('checkbox', { name: 'Simulated Proxmox inventory', exact: true });
  await expect(simulated).not.toBeChecked();
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck();
  await simulated.check();
  await initial(page);
  await nav(page, 'Inventory').click();
  await expect(page.locator('.asset-grid article')).toHaveCount(5);
  await expect(page.locator('.asset-grid .badge.unknown')).toHaveCount(4);
  await expect(page.locator('.asset-grid .badge.stopped')).toHaveCount(1);
  const guest = page.locator('.asset-grid article').filter({ has: page.getByRole('heading', { name: 'Demo application VM', exact: true }) });
  await guest.getByRole('button', { name: 'Inspect system' }).click();
  await expect(page.getByText('Permission-filtered coverage: completeness unknown.', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('proxmox-fixture-v1', { exact: true }).first()).toBeVisible();
  await screenshot(page, info, 'simulated-proxmox-evidence');
});

test('real discovery stays inactive until separate scope preview and confirmation',async({page})=>{
  const fixtureInterface={id:'browser-test-interface',name:'Synthetic test link',address:'192.0.2.10',netmask:'255.255.255.0',cidr:'192.0.2.0/24'};
  let submitted=0;
  await page.route('**/api/v1/discovery/options',async(route)=>route.fulfill({json:{interfaces:[fixtureInterface],limits:{}}}));
  await page.route('**/api/v1/discovery/preview',async(route)=>{
    const body=route.request().postDataJSON();
    expect(body.interfaceId).toBe(fixtureInterface.id);expect(body.methods).toEqual(['tcp']);
    await route.fulfill({json:{plan:{interface:fixtureInterface,cidr:body.cidr,targets:['192.0.2.1','192.0.2.2'],methods:body.methods,
      ports:[443],resolver:null,linkScopeConfirmed:false,tcpBudget:2,dnsBudget:0,datagramBudget:0}}});
  });
  await page.route('**/api/v1/discovery/jobs',async(route)=>{
    submitted++;const body=route.request().postDataJSON();
    expect(body.confirmScope).toBe(true);expect(body.ports).toEqual([443]);expect(body.methods).toEqual(['tcp']);
    await route.fulfill({json:{job:{id:'browser-mocked-discovery-job'}}});
  });
  await page.goto('/');await nav(page,'Discovery').click();
  await expect(page.getByRole('heading',{name:'Scoped IPv4 discovery'})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Source interface'})).toHaveValue('');
  for(const box of await page.getByRole('checkbox').all())await expect(box).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Preview discovery'})).toBeDisabled();
  expect(submitted).toBe(0);
  await page.getByRole('combobox',{name:'Source interface'}).selectOption(fixtureInterface.id);
  await page.getByRole('textbox',{name:'Approved IPv4 CIDR'}).fill('192.0.2.0/30');
  await page.getByRole('checkbox',{name:'TCP connect port probes',exact:true}).check();
  await page.getByRole('textbox',{name:'TCP ports, comma separated (maximum eight)'}).fill('443');
  await page.getByRole('button',{name:'Preview discovery'}).click();
  await expect(page.getByRole('heading',{name:'Review this exact scope'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start approved discovery'})).toBeDisabled();
  expect(submitted).toBe(0);
  await page.getByRole('checkbox',{name:'I confirm this exact scope and these network methods.'}).check();
  await page.getByRole('textbox',{name:'Approved IPv4 CIDR'}).fill('192.0.2.0/29');
  await expect(page.getByRole('heading',{name:'Review this exact scope'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview discovery'}).click();
  await page.getByRole('checkbox',{name:'I confirm this exact scope and these network methods.'}).check();
  await page.getByRole('button',{name:'Start approved discovery'}).click();
  await expect(page.getByRole('heading',{name:'Collection activity'})).toBeVisible();
  expect(submitted).toBe(1);
});

test('broadcast and multicast are distinct, explicitly link-wide and never auto-selected',async({page})=>{
  await page.route('**/api/v1/discovery/options',async(route)=>route.fulfill({json:{interfaces:[
    {id:'test-link',name:'Synthetic test link',address:'192.0.2.10',netmask:'255.255.255.0',cidr:'192.0.2.0/24'}],limits:{}}}));
  await page.goto('/');await nav(page,'Discovery').click();
  await page.getByRole('combobox',{name:'Source interface'}).selectOption('test-link');
  await page.getByRole('checkbox',{name:'Legacy NetBIOS browse-master broadcast (limited coverage)',exact:true}).check();
  await expect(page.getByText('Link-wide methods require the entire current /24–/30 interface subnet, without overlapping interfaces. Multicast and broadcast reach listeners beyond individual accepted responses.',{exact:true})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'I approve link-wide transmission on 192.0.2.0/24, including all hosts on that link.'})).not.toBeChecked();
  await expect(page.getByRole('checkbox',{name:'mDNS service-type multicast (not full service discovery)',exact:true})).not.toBeChecked();
  await expect(page.getByRole('checkbox',{name:'SSDP root-device multicast (no URL fetching)',exact:true})).not.toBeChecked();
  await noOverflow(page);
});
