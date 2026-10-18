import {readFile} from 'node:fs/promises';
import {test,expect} from './fixtures.js';
import {parsePlayback} from '../shared/playback.js';
const fixture={schema:1,provider:'youtube',capturedAt:1792300240077,durationMs:20000,stopReason:'finished',browser:'Chromium',waitingEvents:1,stalledEvents:1,rebufferMs:1500,longTaskMs:null,connection:{effectiveType:null,downlinkMbps:null,rttMs:null,saveData:null},samples:[{atMs:0,mediaTime:10,width:1920,height:1080,bufferSeconds:15,totalFrames:100,droppedFrames:0,paused:false,seeking:false,readyState:4,visibility:'visible'},{atMs:20000,mediaTime:28.5,width:1280,height:720,bufferSeconds:0,totalFrames:700,droppedFrames:12,paused:false,seeking:false,readyState:2,visibility:'visible'}]};
test('playback import previews measurements, persists only after save, and survives reload',async({page},info)=>{
  await page.goto('/');await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Playback',exact:true}).click();
  await page.getByLabel('Import playback report').setInputFiles({name:'neo-playback.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await expect(page.getByText('1920 × 1080 → 1280 × 720')).toBeVisible();await expect(page.getByText('12 / 600 frames (2.00%)')).toBeVisible();
  expect((await page.request.get('/api/v1/playback')).status()).toBe(200);expect((await (await page.request.get('/api/v1/playback')).json()).reports).toHaveLength(0);
  await page.getByRole('button',{name:'Save playback report to selected collector'}).click();await expect(page.getByLabel('Saved playback reports')).toBeVisible();
  await page.reload();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Playback',exact:true}).click();await expect(page.getByText('12 / 600 frames (2.00%)')).toBeVisible();
  await page.screenshot({path:info.outputPath('playback-report-fixture.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('playback rejects unexpected private fields before transmission and serves companion setup',async({page})=>{
  await page.goto('/');await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Playback',exact:true}).click();
  await page.getByLabel('Import playback report').setInputFiles({name:'private.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...fixture,url:'https://example.test/private'}))});
  await expect(page.getByRole('alert')).toContainText('Unexpected report fields');expect((await (await page.request.get('/api/v1/playback')).json()).reports).toHaveLength(0);
  expect((await page.request.get('/companion.zip')).status()).toBe(200);expect((await page.request.get('/playback-guide')).status()).toBe(200);
});
test('actual sampler reads real Chromium video dimensions and frame counters from an isolated canvas fixture',async({page})=>{
  await page.route('https://www.youtube.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><video muted autoplay playsinline></video><canvas width="320" height="180"></canvas></body></html>'}));
  await page.goto('https://www.youtube.com/neo-isolated-fixture');
  await page.evaluate(async()=>{const canvas=document.querySelector('canvas')!;const video=document.querySelector('video')!;const context=canvas.getContext('2d')!;let frame=0;function draw(){context.fillStyle=frame++%2?'#008877':'#334466';context.fillRect(0,0,320,180);requestAnimationFrame(draw);}draw();video.srcObject=canvas.captureStream(30);await video.play();});
  const source=(await readFile('browser-companion/sampler.js','utf8')).replace('export async function samplePlayback','window.neoFixtureSampler = async function samplePlayback');await page.addScriptTag({content:source});
  const report=await page.evaluate(async()=>await (window as unknown as {neoFixtureSampler:(x:{durationSeconds:number})=>Promise<unknown>}).neoFixtureSampler({durationSeconds:10}));
  const capture=parsePlayback(report);expect(capture.provider).toBe('youtube');expect(capture.samples.length).toBeGreaterThan(10);expect(capture.samples.at(-1)?.width).toBe(320);expect(capture.samples.at(-1)?.height).toBe(180);expect(capture.samples.at(-1)?.totalFrames??0).toBeGreaterThan(0);expect(JSON.stringify(report)).not.toContain('youtube.com');
});
