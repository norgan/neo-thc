import {test,expect} from './fixtures.js';
import type {Page} from '@playwright/test';
import {ASSISTANT_DEFAULT_MODEL,ASSISTANT_LIMITS,type AssistantOptions,type AssistantPreview,type AssistantReply} from '../shared/assistant.js';

const question='Explain these DNS results and what to improve.';
const sourceId='dns-benchmark-fixture';
function preview(identifiers=false,id='review-1'):AssistantPreview{
  const createdAt=Date.now();
  const context={generatedAt:createdAt,includeIdentifiers:identifiers,evidence:[{
    id:'E1',kind:'dns-benchmark' as const,title:'System DNS and IPv6 comparison',observedAt:createdAt-30000,
    vantage:'Selected collector',complete:false,summary:'IPv4 completed 40 of 40 requests. IPv6 completed 35 of 40.',
    facts:{resolver:identifiers?'fd12:3456::53':'Resolver 1',transportFamily:6,recordTypes:['A','AAAA'],protocols:['udp','tcp'],successfulRequests:35,totalRequests:40},
    limitations:['A completed DNS query does not establish the health of the returned application path.'],sourceId,
  }],findings:[{id:'F1',severity:'attention' as const,title:'Some IPv6 resolver queries did not succeed',detail:'Five of forty requests did not return a successful result.',evidenceIds:['E1'],nextStep:'Repeat the same comparison from the affected computer.'}],
    missingEvidence:['No saved playback capture is available.'],omitted:{jobs:0,stats:0,playback:0,assets:0}};
  return {previewId:id,createdAt,expiresAt:createdAt+ASSISTANT_LIMITS.previewTtlMs,context,outboundEvidence:JSON.stringify(context),disclosure:[
    'Only the reviewed evidence and this conversation are sent to OpenAI when you ask.',
    identifiers?'Network addresses and names are included.':'Local identifiers use aliases. Public resolver candidates can retain their public addresses.',
  ]};
}
function reply(requestId:string,previewId:string,remaining=7):AssistantReply{
  return {requestId,conversationId:'conversation-1',previewId,model:ASSISTANT_DEFAULT_MODEL,createdAt:Date.now(),turnsRemaining:remaining,usage:{inputTokens:1000,outputTokens:400},answer:{
    summary:'The sample points to lower reliability on the IPv6 resolver path. It does not yet establish an overall IPv6 fault.',
    findings:[{title:'IPv6 DNS success was lower',explanation:'35 of 40 requests succeeded on this collector; repeat before attributing this to a persistent route problem.',confidence:'measured',evidenceIds:['E1']}],
    actions:[{priority:'high',title:'Repeat the same DNS matrix',why:'A matching repeat can separate a transient sample from a recurring path issue.',steps:['Keep the same domains, resolvers, protocols and request count.','Run from the affected PC with the VPN state recorded.'],verification:'Compare successful requests and coverage before comparing mean timings.',tradeoff:'The repeat sends the selected DNS questions again; it does not change resolver settings.',evidenceIds:['E1']}],
    limitations:['A and AAAA describe the requested record type, independently of the address family used to reach the resolver.'],
    followUpQuestions:['How can I check whether the IPv6 issue repeats?'],
  }};
}
async function setup(page:Page,available=true,empty=false){
  const calls={options:0,previews:[] as {includeIdentifiers:boolean;focusJobId?:string}[],resets:[] as unknown[]};
  await page.route('**/api/v1/assistant/options',route=>{calls.options++;const options:AssistantOptions={available,provider:'OpenAI',model:ASSISTANT_DEFAULT_MODEL,reason:available?null:'Configure an OpenAI API key on this collector to enable the assistant.',limits:ASSISTANT_LIMITS};return route.fulfill({json:options});});
  await page.route('**/api/v1/assistant/preview',route=>{
    const body=route.request().postDataJSON();calls.previews.push(body);const result=preview(body.includeIdentifiers,'review-'+calls.previews.length);
    if(empty){result.context.evidence=[];result.context.findings=[];result.outboundEvidence=JSON.stringify(result.context);}
    return route.fulfill({json:result});
  });
  await page.route('**/api/v1/assistant/reset',route=>{calls.resets.push(route.request().postDataJSON());return route.fulfill({json:{reset:true}});});
  await page.goto('/');
  expect(calls.options).toBe(0);expect(calls.previews).toHaveLength(0);
  await page.getByRole('navigation').getByRole('button',{name:'Assistant',exact:true}).click();
  await expect(page.getByRole('heading',{name:'NEO assistant',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Refresh evidence',exact:true})).toBeEnabled();
  await expect(page.getByText(/1 saved record|0 saved records/)).toBeVisible();
  return calls;
}
const consent=(page:Page)=>page.getByRole('checkbox',{name:'Send the reviewed evidence, my question and this conversation to OpenAI.'});

test('assistant sends only an explicitly approved frozen review and keeps server-owned follow-up context',async({page},info)=>{
  const submitted:Record<string,unknown>[]=[];
  await page.route('**/api/v1/assistant/chat',route=>{const body=route.request().postDataJSON();submitted.push(body);expect(body).not.toHaveProperty('history');expect(body).not.toHaveProperty('apiKey');expect(body.confirmed).toBe(true);return route.fulfill({json:reply(body.requestId,body.previewId,8-submitted.length)});});
  const calls=await setup(page);
  expect(submitted).toHaveLength(0);expect(calls.previews).toEqual([{includeIdentifiers:false}]);
  await page.getByRole('button',{name:'Compare DNS and IPv6',exact:true}).click();expect(submitted).toHaveLength(0);
  await page.getByRole('textbox',{name:'Your question',exact:true}).fill(question);
  await expect(page.getByRole('button',{name:'Ask assistant',exact:true})).toBeDisabled();
  await page.getByText('Review the exact evidence sent to OpenAI',{exact:true}).click();
  await expect(page.locator('.assistant-review pre')).toContainText('Resolver 1');
  await expect(page.locator('.assistant-review pre')).not.toContainText('fd12:3456::53');
  await consent(page).check();await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Ways to improve things',exact:true})).toBeVisible();
  await expect(page.getByText('Check whether it helped:',{exact:true})).toBeVisible();
  expect(submitted).toHaveLength(1);expect(submitted[0].previewId).toBe('review-1');expect(submitted[0]).not.toHaveProperty('conversationId');
  await page.getByText('Review the exact evidence sent to OpenAI',{exact:true}).click();
  const path=info.outputPath('assistant-explanation.png');await page.screenshot({path,fullPage:true});await info.attach('assistant-explanation',{path,contentType:'image/png'});
  await page.getByRole('button',{name:'View evidence E1: System DNS and IPv6 comparison'}).first().click();
  await expect(page.locator('#assistant-evidence-E1')).toHaveAttribute('open','');
  await expect(page.locator('#assistant-evidence-E1')).toContainText('Selected collector');
  await page.getByRole('button',{name:'How can I check whether the IPv6 issue repeats?',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toHaveValue('How can I check whether the IPv6 issue repeats?');
  expect(submitted).toHaveLength(1);
  // The reviewed snapshot stays frozen for an existing conversation beyond the first-send review window.
  await page.evaluate(()=>{const original=Date.now;Date.now=()=>original()+16*60*1000;});
  await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
  await expect(page.locator('.assistant-turn')).toHaveCount(2);
  expect(submitted[1].conversationId).toBe('conversation-1');expect(submitted[1].previewId).toBe('review-1');
  await page.getByRole('navigation').getByRole('button',{name:'NOC',exact:true}).click();
  await page.getByRole('navigation').getByRole('button',{name:'Assistant',exact:true}).click();
  await expect(page.locator('.assistant-turn')).toHaveCount(2);expect(submitted).toHaveLength(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('identifier changes invalidate consent and start a new reviewed conversation',async({page})=>{
  const submitted:Record<string,unknown>[]=[];
  await page.route('**/api/v1/assistant/chat',route=>{const body=route.request().postDataJSON();submitted.push(body);return route.fulfill({json:reply(body.requestId,body.previewId)});});
  const calls=await setup(page);
  await page.getByRole('textbox',{name:'Your question',exact:true}).fill(question);await consent(page).check();
  await page.getByRole('button',{name:'Ask assistant',exact:true}).click();await expect(page.locator('.assistant-turn')).toHaveCount(1);
  await page.getByRole('checkbox',{name:'Include network addresses and names in the reviewed evidence'}).check();
  await expect(page.getByText(/addresses and names included/)).toBeVisible();
  await expect(page.locator('.assistant-turn')).toHaveCount(0);await expect(consent(page)).not.toBeChecked();
  expect(calls.resets).toEqual([{previewId:'review-1',conversationId:'conversation-1'}]);
  expect(calls.previews).toEqual([{includeIdentifiers:false},{includeIdentifiers:true}]);
  await page.getByRole('textbox',{name:'Your question',exact:true}).fill(question);
  await expect(page.getByRole('button',{name:'Ask assistant',exact:true})).toBeDisabled();expect(submitted).toHaveLength(1);
  await page.getByText('Review the exact evidence sent to OpenAI',{exact:true}).click();await expect(page.locator('.assistant-review pre')).toContainText('fd12:3456::53');
  await consent(page).check();await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
  await expect(page.locator('.assistant-turn')).toHaveCount(1);expect(submitted[1].previewId).toBe('review-2');expect(submitted[1]).not.toHaveProperty('conversationId');
});

test('unconfigured assistant still explains its evidence boundary without a fake AI response',async({page})=>{
  let sent=0;await page.route('**/api/v1/assistant/chat',route=>{sent++;return route.abort();});
  await setup(page,false);
  await expect(page.getByRole('heading',{name:'Connect OpenAI to ask the assistant'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Local findings',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Explain latest results',exact:true}).click();await consent(page).check();
  await expect(page.getByRole('button',{name:'Ask assistant',exact:true})).toBeDisabled();await expect(page.locator('.assistant-turn')).toHaveCount(0);
  expect(sent).toBe(0);await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test('empty evidence is labelled and assistant entry points prepare a draft without sending',async({page})=>{
  let sent=0;await page.route('**/api/v1/assistant/chat',route=>{sent++;return route.abort();});
  await setup(page,true,true);
  await expect(page.getByText(/There are no saved measurements to explain yet/)).toBeVisible();
  await page.getByRole('navigation').getByRole('button',{name:'NOC',exact:true}).click();
  await page.getByRole('button',{name:'Ask NEO assistant',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toHaveValue('Explain my latest results and what I should improve first.');
  expect(sent).toBe(0);
});

test('provider failures preserve the draft and cancel stops a pending reply',async({page})=>{
  let sent=0,cancelled=0;
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v1/assistant/chat',async route=>{sent++;if(sent===1)return route.fulfill({status:503,json:{error:'OpenAI could not complete the request. Check the API configuration and try again.'}});await held;try{await route.abort();}catch{}});
  await page.route('**/api/v1/assistant/cancel',route=>{cancelled++;release();return route.fulfill({json:{cancelRequested:true}});});
  await setup(page);await page.getByRole('textbox',{name:'Your question',exact:true}).fill(question);await consent(page).check();
  await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('OpenAI could not complete the request');
  await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toHaveValue(question);
  await expect(page.locator('.assistant-turn')).toHaveCount(0);
  await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
  await expect(page.getByRole('button',{name:'Cancel reply',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel reply',exact:true}).click();
  await expect(page.getByText('Reply cancelled. Your question has been kept.',{exact:true})).toBeVisible();
  await expect.poll(()=>cancelled).toBe(1);await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toHaveValue(question);
  await expect(page.locator('.assistant-turn')).toHaveCount(0);release();
});

test('manual retry after a definitive API rejection uses a new request id',async({page})=>{
  const ids:string[]=[];
  await page.route('**/api/v1/assistant/chat',route=>{
    const body=route.request().postDataJSON();ids.push(body.requestId);
    return ids.length===1?route.fulfill({status:429,json:{error:'OpenAI rate limit reached. Wait briefly before trying again.'}}):route.fulfill({json:reply(body.requestId,body.previewId)});
  });
  await setup(page);await page.getByRole('textbox',{name:'Your question',exact:true}).fill(question);await consent(page).check();await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('OpenAI rate limit reached');
  await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toHaveValue(question);expect(ids).toHaveLength(1);
  await page.getByRole('button',{name:'Ask assistant',exact:true}).click();await expect(page.locator('.assistant-turn')).toHaveCount(1);
  expect(ids).toHaveLength(2);expect(ids[1]).not.toBe(ids[0]);
});

test('answers are rendered as inert text and turn limits require a fresh review',async({page})=>{
  await page.route('**/api/v1/assistant/chat',route=>{const body=route.request().postDataJSON(),result=reply(body.requestId,body.previewId,0);result.answer.summary='<img src="https://external.invalid/probe" onerror="alert(1)">';return route.fulfill({json:result});});
  const calls=await setup(page);await page.getByRole('textbox',{name:'Your question',exact:true}).fill(question);await consent(page).check();await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
  await expect(page.locator('.assistant-summary')).toHaveText('<img src="https://external.invalid/probe" onerror="alert(1)">');
  await expect(page.locator('.assistant-summary img')).toHaveCount(0);
  await expect(page.getByText(/This conversation has reached its turn limit/)).toBeVisible();
  await page.getByRole('textbox',{name:'Your question',exact:true}).fill('One more question');await expect(page.getByRole('button',{name:'Ask assistant',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'New conversation with latest evidence',exact:true}).click();
  await expect(page.locator('.assistant-turn')).toHaveCount(0);await expect(consent(page)).not.toBeChecked();
  expect(calls.resets).toEqual([{previewId:'review-1',conversationId:'conversation-1'}]);expect(calls.previews).toHaveLength(2);
});
