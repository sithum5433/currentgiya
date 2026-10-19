/* Run against an existing preview server:
 * PLAYWRIGHT_PATH=/path/to/playwright BASE_URL=http://127.0.0.1:3000 node tests/browser-smoke.cjs
 * Uses local Chrome, mocks all report writes and blocks external browser requests.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000');
const shots = process.env.SCREENSHOT_DIR || '/tmp';
const gps = { latitude: 6.9271, longitude: 79.8612, accuracy: 20 };
const account = '12345678901234567890';
const address = 'Private browser smoke test address';
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });
const passed = [];

async function noOverflow(page, label) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  assert(sizes.html <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1,
    `${label}: horizontal overflow ${JSON.stringify(sizes)}`);
}

async function makeContext(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    geolocation: gps,
    permissions: ['geolocation'],
    ...options
  });
  context.setDefaultTimeout(10000);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base.origin) return route.abort();
    return route.continue();
  });
  return context;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const context = await makeContext(browser);
    const page = await context.newPage();
    const errors = [];
    const outgoing = [];
    page.on('pageerror', error => errors.push(error.message));
    context.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/')) outgoing.push(request.url() + (request.postData() || ''));
    });
    const statusResponse = await context.request.get(new URL('/api/status?lat=6.9271&lng=79.8612', base).href);
    assert.equal(statusResponse.status(), 200);
    const initial = await statusResponse.json();
    assert.deepEqual(Object.keys(initial.counts).sort(), ['net', 'power', 'water']);
    assert(Array.isArray(initial.reports) && Array.isArray(initial.zones));
    assert(initial.reports.every(report => typeof report.id === 'string'));
    let submitted = [];
    await context.route('**/api/reports*', route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      submitted.push(body);
      return route.fulfill(json({ report: { ...body, id: 'browser-test-only' }, status: initial }));
    });
    await context.route('**/api/push/public-key', route => route.fulfill(json({ enabled: false })));
    await page.addInitScript(() => {
      window.__permissionPrompts = 0;
      if ('Notification' in window) Notification.requestPermission = async () => { window.__permissionPrompts++; return 'denied'; };
    });
    await page.goto(new URL('/?full=1', base).href);
    await page.waitForFunction(() => document.getElementById('connectionBadge').textContent.includes('Community live'));
    await page.waitForFunction(() => document.getElementById('networkState').textContent !== 'CHECKING');
    assert.equal(await page.locator('#countPower').textContent(), Number(initial.counts.power).toLocaleString());
    assert.equal(await page.locator('#chatInput').isDisabled(), true);
    await noOverflow(page, 'desktop');
    await page.screenshot({ path: path.join(shots, 'currentgiya-desktop.png'), fullPage: true });
    passed.push('Live backend status renders without sample data; chat locked; desktop fits');

    await page.locator('[data-open="aboutDialog"]').first().click();
    assert(await page.locator('#aboutDialog').isVisible());
    assert((await page.locator('#aboutDialog').textContent()).includes('Five independent'));
    await page.locator('#aboutDialog .dialog-close').click();
    await page.locator('[data-open="complaintDialog"]').click();
    await page.locator('#accountNumber').fill(account);
    await page.locator('#complaintAddress').fill(address);
    assert.equal(await page.evaluate(() => localStorage.getItem('cg_account_power')), null);
    await page.locator('#rememberAccount').check();
    assert.equal(await page.evaluate(() => localStorage.getItem('cg_account_power')), account);
    const sms = await page.locator('#smsLink').getAttribute('href');
    assert(sms.startsWith('sms:1987'));
    assert(decodeURIComponent(sms).includes(account));
    assert(decodeURIComponent(sms).includes(address));
    await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copiedComplaint = text; }; });
    await page.locator('#copyComplaint').click();
    assert((await page.evaluate(() => window.__copiedComplaint)).includes(account));
    assert((await page.evaluate(() => window.__copiedComplaint)).includes(address));
    await page.locator('#complaintDialog .dialog-close').click();
    await page.locator('[data-open="complaintDialog"]').click();
    assert.equal(await page.locator('#accountNumber').inputValue(), account);
    await page.locator('#utilitySelect').selectOption('water');
    assert((await page.locator('#smsLink').getAttribute('href')).startsWith('sms:1939'));
    await page.locator('#accountNumber').fill('9876543210');
    await page.locator('#rememberAccount').check();
    await page.locator('#forgetAccounts').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('cg_account_power')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('cg_account_water')), null);
    await page.locator('#complaintDialog .dialog-close').click();
    passed.push('Account opt-in storage, independent utilities, SMS drafts and forget controls');

    await page.locator('#areaSelect').selectOption('Kandy');
    await page.waitForFunction(() => document.getElementById('mapArea').textContent === 'Kandy');
    assert((await page.locator('#locationHint').textContent()).includes('town centre'));
    for (const type of ['power', 'water', 'net', 'all']) {
      await page.locator(`[data-filter="${type}"]`).click();
      assert((await page.locator(`[data-filter="${type}"]`).getAttribute('class')).includes('selected'));
    }
    const scale = await page.locator('#mapScale').textContent();
    await page.locator('#zoomIn').click();
    await page.waitForFunction(previous => document.getElementById('mapScale').textContent !== previous, scale);
    await page.locator('#zoomOut').click();
    await page.locator('#outageMap').focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('[data-board="isps"]').click();
    assert((await page.locator('[data-board="isps"]').getAttribute('class')).includes('selected'));
    await page.locator('#locateBtn').click();
    await page.waitForFunction(() => document.getElementById('locationHint').textContent.includes('20 m'));
    assert.equal(await page.locator('#areaSelect').inputValue(), 'Colombo');
    await page.locator('[data-report="power"]').click();
    await page.waitForFunction(() => document.getElementById('reportFeedback').hidden === false);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].accuracy, 20);
    assert.equal(submitted[0].lat, gps.latitude);
    assert.equal(submitted[0].lng, gps.longitude);
    assert.equal(submitted[0].type, 'power');
    assert(!outgoing.some(value => value.includes(account) || value.includes(address)), 'Private complaint values leaked into an API request');
    assert.equal(await page.evaluate(() => window.__permissionPrompts), 0);
    passed.push('Town browsing, category filters, map controls and precise GPS report payload (POST mocked)');

    await page.locator('#alarmToggle').click();
    await page.waitForFunction(() => document.getElementById('alarmToggle').getAttribute('aria-checked') === 'true');
    assert((await page.locator('#alarmHint').textContent()).includes('Keep this tab open'));
    await page.locator('#alarmToggle').click();
    assert.equal(await page.locator('#alarmToggle').getAttribute('aria-checked'), 'false');
    const downloaded = page.waitForEvent('download');
    await page.locator('#shareStory').click();
    const story = await downloaded;
    assert.equal(story.suggestedFilename(), 'currentgiya-today.png');
    const png = fs.readFileSync(await story.path());
    assert.equal(png.readUInt32BE(16), 1080);
    assert.equal(png.readUInt32BE(20), 1920);
    passed.push('Restoration alarm arms/disarms and story exports a 1080×1920 PNG');

    await page.evaluate(coords => { navigator.geolocation.getCurrentPosition = success => success({ coords }); }, { ...gps, accuracy: 500 });
    await page.locator('#areaSelect').selectOption('Galle');
    await page.locator('[data-report="water"]').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('within 200 m'));
    assert.equal(submitted.length, 1, 'Inaccurate GPS should not submit');
    await page.evaluate(coords => { navigator.geolocation.getCurrentPosition = success => success({ coords }); }, { latitude: 51.5, longitude: -0.12, accuracy: 20 });
    await page.locator('[data-report="water"]').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Sri Lanka'));
    assert.equal(submitted.length, 1, 'Out-of-country GPS should not submit');
    assert.deepEqual(errors, []);
    passed.push('Inaccurate and out-of-country GPS rejected; no account API leakage or JS errors');
    await context.close();

    const chatContext = await makeContext(browser);
    const chatPage = await chatContext.newPage();
    await chatPage.addInitScript(() => {
      const battery = Object.assign(new EventTarget(), { level: 0.07, charging: false });
      Object.defineProperty(navigator, 'getBattery', { value: async () => battery, configurable: true });
    });
    let room = { unlocked: true, zoneId: 'browser-chat-room', expiresAt: new Date(Date.now() + 3600000).toISOString(),
      messages: [{ id: 'neighbour-message', nickname: 'Neighbour A12B', text: 'Anyone else near the junction?', battery: 8, createdAt: new Date().toISOString() }] };
    const sentMessages = [];
    await chatContext.route('**/api/chat*', route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        sentMessages.push(body);
        room.messages.push({ id: 'self-message', nickname: 'Neighbour C34D', text: body.text, battery: body.battery, createdAt: new Date().toISOString() });
      }
      return route.fulfill(json(room));
    });
    await chatPage.goto(new URL('/?full=1', base).href);
    assert.equal(await chatPage.locator('#chatInput').isDisabled(), true);
    await chatPage.locator('#chatLocate').click();
    await chatPage.waitForFunction(() => !document.getElementById('chatInput').disabled);
    assert((await chatPage.locator('#chatMessages').textContent()).includes('8%'));
    const message = 'Hello neighbours <script>window.chatInjected = true</script>';
    await chatPage.locator('#chatInput').fill(message);
    await chatPage.locator('#chatForm button').click();
    await chatPage.waitForFunction(text => document.getElementById('chatMessages').textContent.includes(text), message);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].battery, 7);
    assert.equal(sentMessages[0].accuracy, 20);
    assert.equal(await chatPage.evaluate(() => window.chatInjected), undefined);
    await chatPage.locator('#areaSelect').selectOption('Galle');
    assert.equal(await chatPage.locator('#chatInput').isDisabled(), true);
    assert.equal(await chatPage.locator('#chatMessages').textContent(), '');
    await chatContext.close();
    passed.push('Fresh GPS unlocks chat; messages stay escaped, carry supported battery readings, and clear on area change');

    // Model a live incident and incoming restoration updates without writing to the server.
    const alarmContext = await makeContext(browser);
    const alarmPage = await alarmContext.newPage();
    const powerZone = { id: 'alarm-test-zone', type: 'power', lat: gps.latitude, lng: gps.longitude,
      area: 'Colombo', reportCount: 5, verified: true, scope: 'area', firstReportedAt: new Date().toISOString() };
    let alarmStatus = { ...initial, counts: { power: 5, water: 0, net: 0 }, reports: [], zones: [powerZone],
      nearbyZone: powerZone, restoration: { count: 3, restored: true, confirmedAt: new Date(Date.now() - 60000).toISOString() } };
    await alarmContext.route('**/api/status*', route => route.fulfill(json(alarmStatus)));
    await alarmContext.route('**/api/reports*', route => route.fulfill(json({ report: { id: 'alarm-test-only' }, status: alarmStatus })));
    await alarmPage.goto(new URL('/?full=1', base).href);
    await alarmPage.waitForFunction(() => document.getElementById('countPower').textContent === '5');
    await alarmPage.locator('#locateBtn').click();
    await alarmPage.waitForFunction(() => document.getElementById('locationHint').textContent.includes('20 m'));
    await alarmPage.evaluate(() => {
      window.__alarmOscillators = 0;
      const prototype = (window.AudioContext || window.webkitAudioContext).prototype;
      const original = prototype.createOscillator;
      prototype.createOscillator = function (...args) { window.__alarmOscillators++; return original.apply(this, args); };
    });
    await alarmPage.locator('#alarmToggle').click();
    await alarmPage.waitForFunction(() => document.getElementById('alarmToggle').getAttribute('aria-checked') === 'true');
    assert.equal(await alarmPage.evaluate(() => window.__alarmOscillators), 1, 'An old restoration event must not play the alarm');
    alarmStatus = { ...alarmStatus, restoration: { count: 2, restored: false } };
    await alarmPage.locator('[data-report="restored"]').click();
    await alarmPage.waitForFunction(() => document.getElementById('reportFeedback').textContent.includes('2 of 3'));
    assert.equal(await alarmPage.locator('#alarmToggle').getAttribute('aria-checked'), 'true');
    assert.equal(await alarmPage.evaluate(() => window.__alarmOscillators), 1, 'Two neighbours must not trigger the alarm');
    alarmStatus = { ...alarmStatus, counts: { power: 0, water: 0, net: 0 }, zones: [], nearbyZone: null,
      restoration: { count: 3, restored: true, confirmedAt: new Date(Date.now() + 100).toISOString() } };
    await alarmPage.locator('[data-report="restored"]').click();
    await alarmPage.waitForFunction(() => document.getElementById('alarmToggle').getAttribute('aria-checked') === 'false');
    assert.equal(await alarmPage.evaluate(() => window.__alarmOscillators), 7, 'Three new restorations should create the six-note alert');
    assert.equal(await alarmPage.locator('#chatInput').isDisabled(), true);
    await alarmContext.close();
    passed.push('Restoration alarm ignores old/two-neighbour updates and sounds after three new confirmations');

    for (const [width, height] of [[390, 844], [320, 800]]) {
      const mobile = await makeContext(browser, { viewport: { width, height }, isMobile: true });
      const p = await mobile.newPage();
      const mobileErrors = [];
      p.on('pageerror', error => mobileErrors.push(error.message));
      await p.goto(new URL('/?full=1', base).href);
      await p.waitForFunction(() => document.getElementById('countPower').textContent !== '—');
      await noOverflow(p, `${width}px dashboard`);
      if (width === 390) await p.screenshot({ path: path.join(shots, 'currentgiya-mobile.png'), fullPage: true });
      await p.locator('[data-open="complaintDialog"]').click();
      await noOverflow(p, `${width}px complaint dialog`);
      const dialog = await p.locator('#complaintDialog').boundingBox();
      assert(dialog.x >= -1 && dialog.x + dialog.width <= width + 1, `${width}px dialog does not fit`);
      await p.locator('#complaintDialog .dialog-close').click();
      assert.deepEqual(mobileErrors, []);
      await mobile.close();
    }
    passed.push('390px and 320px dashboard and dialogs fit without horizontal scrolling');

    const lite = await makeContext(browser, { viewport: { width: 320, height: 800 } });
    const lp = await lite.newPage();
    const liteErrors = [], liteRequests = [];
    lp.on('pageerror', error => liteErrors.push(error.message));
    lite.on('request', request => liteRequests.push(request.url()));
    let liteReports = [];
    await lite.route('**/api/reports*', route => {
      liteReports.push(route.request().postDataJSON());
      return route.fulfill(json({ report: { id: 'lite-test-only' }, status: initial }));
    });
    await lp.goto(new URL('/lite.html', base).href);
    await lp.waitForFunction(() => document.getElementById('power-count').textContent !== '—');
    await noOverflow(lp, '320px lite');
    await lp.locator('[data-report="power"]').click();
    assert((await lp.locator('#message').textContent()).includes('location'));
    assert.equal(liteReports.length, 0);
    await lp.locator('#town').selectOption('Kandy');
    await lp.evaluate(coords => { navigator.geolocation.getCurrentPosition = success => success({ coords }); }, { ...gps, accuracy: 500 });
    await lp.locator('#locate').click();
    assert((await lp.locator('#message').textContent()).includes('within 200 m'));
    await lp.evaluate(coords => { navigator.geolocation.getCurrentPosition = success => success({ coords }); }, { latitude: 51.5, longitude: -0.12, accuracy: 20 });
    await lp.locator('#locate').click();
    assert((await lp.locator('#location-note').textContent()).includes('Sri Lanka'));
    await lp.evaluate(coords => { navigator.geolocation.getCurrentPosition = success => success({ coords }); }, gps);
    await lp.locator('#locate').click();
    await lp.waitForFunction(() => document.getElementById('location-note').textContent.includes('accuracy 20 m'));
    await lp.locator('[data-report="power"]').click();
    await lp.waitForFunction(() => document.getElementById('message').textContent.includes('Report received'));
    assert.equal(liteReports.length, 1);
    assert.equal(liteReports[0].accuracy, 20);
    assert.equal(liteReports[0].area, 'Colombo');
    await lp.locator('[data-report="power"]').click();
    assert((await lp.locator('#message').textContent()).includes('wait'));
    assert.equal(liteReports.length, 1);
    assert(liteRequests.every(value => new URL(value).origin === base.origin), 'Lite requested an external resource');
    assert(liteRequests.filter(value => new URL(value).pathname === '/api/status').every(value => new URL(value).searchParams.get('lite') === '1'));
    assert.deepEqual(liteErrors, []);
    const litePath = path.join(__dirname, '..', 'lite.html');
    assert(fs.statSync(litePath).size < 20000, 'Lite HTML exceeds 20 KB');
    await lite.close();
    passed.push('Lite fits 320px, uses compact API, requires GPS and enforces cooldown, no external assets');

    const worker = await makeContext(browser, { serviceWorkers: 'allow' });
    const wp = await worker.newPage();
    await wp.addInitScript(() => {
      window.__permissionPrompts = 0;
      if ('Notification' in window) Notification.requestPermission = async () => { window.__permissionPrompts++; return 'denied'; };
    });
    await wp.goto(new URL('/?full=1', base).href);
    await wp.evaluate(() => navigator.serviceWorker.ready);
    await worker.route('**/api/push/public-key', route => route.fulfill(json({ enabled: false })));
    await wp.locator('#enablePush').click();
    await wp.waitForFunction(() => document.getElementById('toast').textContent.includes('server configuration'));
    assert.equal(await wp.evaluate(() => window.__permissionPrompts), 0);
    const cached = await wp.evaluate(async () => {
      const entries = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) entries.push(new URL(request.url).pathname);
      return entries;
    });
    assert(cached.includes('/lite.html'));
    assert(!cached.some(value => value.startsWith('/api/')));
    await worker.setOffline(true);
    await wp.goto(new URL('/lite.html', base).href);
    assert.equal(await wp.title(), 'CurrentGiya.lk · Lite');
    await wp.waitForFunction(() => document.getElementById('connection').textContent.includes('Offline'));
    await worker.close();
    passed.push('Unconfigured push never requests permission; worker caches only shell and lite works offline');
    console.log(passed.map(value => `PASS ${value}`).join('\n'));
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
