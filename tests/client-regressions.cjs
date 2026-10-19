'use strict';
// Run only against a local Node preview. Every report/push write is mocked.
const assert = require('node:assert/strict');
const { createECDH } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000');
const json = data => ({contentType:'application/json',body:JSON.stringify(data)});
const gps = {latitude:6.9271,longitude:79.8612,accuracy:20};
async function context(browser,options={}){
  const ctx=await browser.newContext({serviceWorkers:'block',permissions:['geolocation'],geolocation:gps,...options});
  ctx.setDefaultTimeout(10000);
  await ctx.route('**/*',route=>new URL(route.request().url()).origin===base.origin?route.continue():route.abort());
  return ctx;
}
async function run(){
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/bin/google-chrome',headless:true,args:['--no-sandbox']});
  try{
    const slow=await context(browser),p=await slow.newPage();
    const errors=[];p.on('pageerror',e=>errors.push(e.message));
    await slow.route('**/api/ping*',async route=>{await new Promise(r=>setTimeout(r,700));return route.fulfill({status:204});});
    await p.goto(new URL('/?full=1',base).href);
    await p.waitForFunction(()=>document.getElementById('networkState').textContent!=='CHECKING');
    assert.equal((await p.locator('#probeValue').textContent()).replace(/\s/g,''),'4/4');
    assert.equal(await p.locator('#networkState').textContent(),'SLOW / UNSTABLE');
    await p.evaluate(coords=>{navigator.geolocation.getCurrentPosition=success=>success({coords});},{latitude:7.2906,longitude:80.6337,accuracy:1500});
    await p.locator('#locateBtn').click();
    await p.waitForFunction(()=>document.getElementById('locationHint').textContent.includes('1500 m'));
    assert.equal(await p.locator('#areaSelect').inputValue(),'Kandy');
    assert((await p.locator('#locationHint').textContent()).includes('browse only'));
    let writes=0;
    await slow.route('**/api/reports*',route=>{writes++;return route.fulfill(json({}));});
    await p.locator('[data-report="power"]').click();
    await p.waitForFunction(()=>document.getElementById('toast').textContent.includes('within 200 m'));
    assert.equal(writes,0);
    await p.evaluate(coords=>{
      window.__activationOrder=[];
      const proto=(window.AudioContext||window.webkitAudioContext).prototype;
      const resume=proto.resume;
      proto.resume=function(...args){window.__activationOrder.push('audio');return resume.apply(this,args);};
      navigator.geolocation.getCurrentPosition=success=>{window.__activationOrder.push('gps');setTimeout(()=>success({coords}),20);};
    },gps);
    await p.locator('#alarmToggle').click();
    await p.waitForFunction(()=>document.getElementById('alarmToggle').getAttribute('aria-checked')==='true');
    assert.deepEqual((await p.evaluate(()=>window.__activationOrder)).slice(0,2),['audio','gps']);
    await p.locator('#alarmToggle').click();
    await p.evaluate(()=>{
      Object.defineProperty(navigator,'canShare',{value:()=>true,configurable:true});
      Object.defineProperty(navigator,'share',{value:()=>Promise.reject(new DOMException('Native share unavailable','NotAllowedError')),configurable:true});
    });
    const download=p.waitForEvent('download');await p.locator('#shareStory').click();
    assert.equal((await download).suggestedFilename(),'currentgiya-today.png');
    assert.deepEqual(errors,[]);await slow.close();
    console.log('PASS slow usable connections, coarse browse/precise report gate, audio gesture ordering, share download fallback');

    for(const payload of [{contentType:'text/html',body:'<!doctype html><html>Static fallback</html>'},json({})]){
      const broken=await context(browser),page=await broken.newPage();
      await broken.route('**/api/status*',route=>route.fulfill(payload));
      await page.goto(new URL('/?full=1',base).href);
      await page.waitForFunction(()=>!document.getElementById('serviceMessage').hidden);
      assert.equal(await page.locator('#countPower').textContent(),'—');
      assert(!(await page.locator('#serviceMessage').textContent()).includes('last successful'));
      assert((await page.locator('#serviceMessage').textContent()).includes('npm start'));
      assert.equal(await page.locator('#shareStory').isDisabled(),false);
      let reports=0;await broken.route('**/api/reports*',route=>{reports++;return route.fulfill(json({}));});
      await page.locator('[data-report="power"]').click();
      await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('npm start'));
      assert.equal(reports,0);await broken.close();
    }
    console.log('PASS static HTML and malformed status responses show setup guidance without phantom snapshots/reports');

    const push=await context(browser,{serviceWorkers:'allow'}),page=await push.newPage();
    const key=createECDH('prime256v1');key.generateKeys();
    await push.route('**/api/push/public-key',route=>route.fulfill(json({enabled:true,publicKey:key.getPublicKey().toString('base64url')})));
    let subscription;
    await push.route('**/api/push/subscribe',route=>{subscription=route.request().postDataJSON();return route.fulfill(json({subscribed:true}));});
    await page.addInitScript(()=>{
      window.__promptCount=0;window.__permissionGesture=false;
      Object.defineProperty(Notification,'permission',{get:()=> 'default',configurable:true});
      Notification.requestPermission=()=>{window.__promptCount++;window.__permissionGesture=navigator.userActivation.isActive;return Promise.resolve('granted');};
      PushManager.prototype.getSubscription=async()=>null;
      PushManager.prototype.subscribe=async()=>({toJSON:()=>({endpoint:'https://fcm.googleapis.com/fcm/send/test-only',keys:{p256dh:'test-only',auth:'test-only'}})});
    });
    await page.goto(new URL('/?full=1',base).href);
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>document.getElementById('pushHint').textContent==='Optional alerts when thunder is forecast.');
    assert.equal(await page.evaluate(()=>window.__promptCount),0);
    await page.locator('#enablePush').click();
    await page.waitForFunction(()=>document.getElementById('enablePush').textContent.includes('Disable'));
    assert.equal(await page.evaluate(()=>window.__promptCount),1);
    assert.equal(await page.evaluate(()=>window.__permissionGesture),true);
    assert.equal(subscription.area,'Colombo');
    await push.close();
    console.log('PASS push configuration preloads and permission is requested only by an active user click');
  }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
