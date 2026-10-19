/* Run against a local server with PLAYWRIGHT_PATH=/path/to/playwright
 * BASE_URL=http://127.0.0.1:3000 node tests/lite-regressions.cjs.
 * Real service workers; report writes are intercepted before reaching the API.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000');
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });
const gps = { latitude: 6.9271, longitude: 79.8612, accuracy: 20 };

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const offline = await browser.newContext();
    const p = await offline.newPage();
    const requests = [];
    const errors = [];
    p.on('request', request => requests.push(new URL(request.url()).pathname));
    p.on('pageerror', error => errors.push(error.message));
    await p.goto(new URL('/lite.html', base).href);
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.waitForFunction(async () => Boolean(await caches.match('/lite.html')));
    const cached = await p.evaluate(async () => (await caches.match('/lite.html')).text());
    assert(cached.includes('<strong id="power-count">—</strong>'), 'Offline shell must not retain live counts');
    assert(cached.includes('Browsing the town centre.'), 'Offline shell must not retain a user GPS reading');
    assert.equal(requests.filter(url => url === '/lite.html').length, 1, 'Initial Lite HTML was downloaded twice');
    assert(!requests.some(url => ['/app.js', '/style.css', '/index.html', '/'].includes(url)), 'Lite downloaded full dashboard assets');
    const bytes = ['lite.html', 'service-worker.js', 'manifest.webmanifest'].reduce((sum, file) => sum + fs.statSync(path.join(__dirname, '..', file)).size, 0);
    assert(bytes < 20000, `Initial static Lite assets exceed 20 KB: ${bytes}`);
    await offline.setOffline(true);
    await p.reload();
    assert.equal(await p.title(), 'CurrentGiya.lk · Lite');
    await p.waitForFunction(() => document.getElementById('connection').textContent.includes('Offline'));
    assert.equal(await p.locator('#power-count').textContent(), '—');
    assert.equal(await p.locator('#town').inputValue(), 'Colombo');
    await offline.setOffline(false);
    await p.locator('#refresh').click();
    await p.waitForFunction(() => document.getElementById('connection').textContent.includes('Updated'));
    assert.deepEqual(errors, []);
    await offline.close();
    console.log(`PASS: First Lite visit caches a pristine offline shell with one HTML download (${bytes} static bytes); reconnect works`);

    const context = await browser.newContext({
      serviceWorkers: 'block', permissions: ['geolocation'], geolocation: gps
    });
    const page = await context.newPage();
    const submissions = [];
    let invalidReport = false;
    let invalidStatus = false;
    await context.route('**/api/reports*', route => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill(json(invalidReport ? {} : { report: { id: 'regression-only' } }));
    });
    await context.route('**/api/status*', route => invalidStatus ? route.fulfill(json({})) : route.continue());
    await page.goto(new URL('/lite.html', base).href);
    await page.waitForFunction(() => document.getElementById('connection').textContent.includes('Updated'));
    await page.evaluate(coords => {
      navigator.geolocation.getCurrentPosition = success => success({ coords });
    }, { latitude: 7.2906, longitude: 80.6337, accuracy: 1500 });
    await page.locator('#locate').click();
    await page.waitForFunction(() => document.getElementById('town').value === 'Kandy');
    assert((await page.locator('#message').textContent()).includes('browsing'));
    await page.locator('[data-report="power"]').click();
    assert((await page.locator('#message').textContent()).includes('within 200 m'));
    assert.equal(submissions.length, 0);
    await page.evaluate(coords => {
      navigator.geolocation.getCurrentPosition = success => success({ coords });
    }, gps);
    await page.locator('#locate').click();
    await page.waitForFunction(() => document.getElementById('location-note').textContent.includes('accuracy 20 m'));
    for (const type of ['power', 'water', 'restored']) {
      await page.locator(`[data-report="${type}"]`).click();
      await page.waitForFunction(() => !document.querySelector('[data-report="power"]').disabled);
    }
    assert.deepEqual(submissions.map(body => body.type), ['power', 'water', 'restored']);
    await page.locator('[data-report="power"]').click();
    assert((await page.locator('#message').textContent()).includes('wait'));
    assert.equal(submissions.length, 3);
    invalidReport = true;
    await page.locator('[data-report="net"]').click();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('could not be accepted'));
    assert.equal(await page.evaluate(() => localStorage.getItem('cg-lite-last-net')), null);
    invalidReport = false;
    await page.locator('[data-report="net"]').click();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('Report received'));
    assert.equal(submissions.length, 5);
    invalidStatus = true;
    await page.locator('#town').selectOption('Galle');
    await page.waitForFunction(() => document.getElementById('connection').textContent.includes('unavailable'));
    assert.equal(await page.locator('#power-count').textContent(), '—');
    await context.close();
    console.log('PASS: Coarse locations browse but cannot report; cooldowns are per category; malformed status/report successes are rejected');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
