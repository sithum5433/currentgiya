import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createServer } from '../server.mjs';

const GPS = { lat: 6.9271, lng: 79.8612, accuracy: 20, area: 'Colombo' };
const locationQuery = 'lat=6.9271&lng=79.8612&accuracy=20';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'currentgiya-'));
  const dataFile = join(directory, 'state.json');
  const calls = [];
  const integrations = {
    network: async ip => { calls.push(['network', ip]); return { available: true, isp: 'Dialog', asn: 18001 }; },
    weather: async location => ({ available: true, stormRisk: false, location }),
    notices: async ({ area }) => ({ notices: [], configured: false, area }),
    publicKey: () => ({ enabled: false, publicKey: null }),
    subscribe: async (subscription, location) => { calls.push(['subscribe', subscription, location]); return { subscribed: true }; },
    unsubscribe: async payload => { calls.push(['unsubscribe', payload]); return { unsubscribed: true }; },
    close: () => {},
  };
  let clock = Date.UTC(2026, 9, 19, 12);
  const server = await createServer({ dataFile, testMode: true, integrations, now: () => clock, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, { body, ip = '10.0.0.1', cookie, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(origin + path, { method, headers: { 'x-test-ip': ip, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { status: response.status, payload, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { server, origin, request, calls, dataFile, tick: (ms = 1) => { clock += ms; } };
}

test('HTTP report quorum unlocks anonymous chat; restoration deletes it and state persists without raw IPs', async t => {
  const { request, tick, dataFile } = await fixture(t);
  const empty = await request('/api/status');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.payload.counts, { power: 0, water: 0, net: 0 });
  assert.match(empty.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const lite = await request(`/api/status?lite=1&${locationQuery}`);
  assert.deepEqual(Object.keys(lite.payload).sort(), ['counts', 'nearbyZone', 'restoration', 'serverTime']);
  const clients = [];
  for (let i = 1; i <= 5; i++) {
    const response = await request(`/api/reports${i === 5 ? '?lite=1' : ''}`, { body: { ...GPS, type: 'power', district: 'Jaffna' }, ip: `10.10.0.${i}` });
    assert.equal(response.status, 201);
    clients.push(response.cookie);
    assert.equal(response.payload.status.nearbyZone.verified, i === 5);
    assert.equal(response.payload.report.district, 'Colombo', 'district is derived from coordinates, overriding arbitrary submitted labels');
    if (i === 5) assert.deepEqual(Object.keys(response.payload.status).sort(), ['counts', 'nearbyZone', 'restoration', 'serverTime']);
    tick();
  }
  const duplicate = await request('/api/reports', { body: { ...GPS, type: 'power' }, ip: '10.10.0.99', cookie: clients[0] });
  assert.equal(duplicate.status, 429, 'new IP with the same device cannot add votes');
  const chat = await request('/api/chat', { body: { ...GPS, text: 'Router still off', battery: 8, nickname: 'Admin' }, cookie: clients[0], ip: '10.10.0.1' });
  assert.equal(chat.status, 201);
  assert.match(chat.payload.message.nickname, /^Neighbour /);
  assert.equal(chat.payload.message.battery, 8);
  const battery = await request('/api/chat/battery', { body: { ...GPS, battery: 7 }, cookie: clients[0], ip: '10.10.0.1' });
  assert.equal(battery.status, 200);
  assert.equal(battery.payload.messages[0].battery, 7);
  assert.ok(!JSON.stringify(battery.payload).includes('ownerHash'));
  assert.equal((await request('/api/chat/battery', { body: { ...GPS, accuracy: undefined, battery: 5 }, cookie: clients[0] })).status, 400);
  const read = await request(`/api/chat?${locationQuery}`);
  assert.equal(read.payload.messages.length, 1);
  assert.equal((await request('/api/chat?lat=6.9271&lng=79.8612')).status, 400);
  for (let i = 10; i <= 12; i++) {
    tick();
    const restored = await request('/api/reports', { body: { ...GPS, type: 'restored' }, ip: `10.10.0.${i}` });
    assert.equal(restored.status, 201);
    assert.equal(restored.payload.status.restoration.restored, i === 12);
  }
  const locked = await request(`/api/chat?${locationQuery}`);
  assert.equal(locked.payload.unlocked, false);
  assert.deepEqual(locked.payload.messages, []);
  const storedText = await readFile(dataFile, 'utf8');
  assert.ok(!storedText.includes('10.10.0.'));
  assert.ok(!storedText.includes('Router still off'));
  assert.ok(!storedText.includes(clients[0].split('=')[1]));
  assert.ok(JSON.parse(storedText).salt);
});

test('static compression negotiates gzip/Brotli and preserves bytes and encoded Content-Length', async t => {
  const { origin } = await fixture(t);
  async function raw(encoding) {
    return new Promise((accept, reject) => {
      get(`${origin}/lite.html`, { headers: { 'accept-encoding': encoding } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      }).on('error', reject);
    });
  }
  const identity = await raw('identity');
  assert.equal(identity.status, 200);
  for (const [encoding, decode] of [['gzip', gunzipSync], ['br', brotliDecompressSync]]) {
    const compressed = await raw(encoding);
    assert.equal(compressed.headers['content-encoding'], encoding);
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    assert.equal(Number(compressed.headers['content-length']), compressed.body.length);
    assert.deepEqual(decode(compressed.body), identity.body);
    assert.ok(compressed.body.length < identity.body.length);
  }
  const disabled = await raw('br;q=0,gzip;q=0');
  assert.equal(disabled.headers['content-encoding'], undefined);
  assert.deepEqual(disabled.body, identity.body);
});

test('server validates location/body, same-site origin, size limits and private path access', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/reports', { body: { ...GPS, accuracy: 250, type: 'power' } })).status, 400);
  assert.equal((await request('/api/reports', { body: { ...GPS, type: 'power' }, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('/api/reports', { body: { ...GPS, type: 'power' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/reports', { body: '{', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await request('/api/reports', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/reports', { body: { text: 'x'.repeat(9000) } })).status, 413);
  assert.equal((await request('/api/status?lat=&lng=79')).status, 400);
  assert.equal((await request('/api/status?lat=51&lng=0')).status, 400);
  for (const path of ['/.data/state.json', '/server.mjs', '/lib/outages.mjs', '/tests/server.test.mjs', '/%2e%2e/.data/state.json']) assert.equal((await request(path)).status, 404);
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  const ping = await request('/api/ping', { method: 'HEAD' });
  assert.equal(ping.status, 204);
  assert.equal(ping.headers.get('cache-control'), 'no-store');
  assert.equal(ping.headers.get('set-cookie'), null, 'parallel ping samples must not replace the reporting device cookie');
});

test('production mode ignores forged IP headers and requires independent network addresses', async t => {
  const original = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  t.after(() => { if (original === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = original; });
  const { request } = await fixture(t, { testMode: false });
  const first = await request('/api/reports', { body: { ...GPS, type: 'power' }, ip: '11.0.0.1', headers: { 'x-forwarded-for': '11.0.0.1', 'x-real-ip': '11.0.0.1' } });
  assert.equal(first.status, 201);
  const second = await request('/api/reports', { body: { ...GPS, type: 'power' }, ip: '11.0.0.2', headers: { 'x-forwarded-for': '11.0.0.2', 'x-real-ip': '11.0.0.2' } });
  assert.equal(second.status, 429);
});

test('trusted proxies use the configured client header and retain secure cookies and same-origin reports', async t => {
  const originalTrust = process.env.TRUST_PROXY, originalHeader = process.env.CLIENT_IP_HEADER;
  process.env.TRUST_PROXY = '1';
  process.env.CLIENT_IP_HEADER = 'x-real-ip';
  t.after(() => {
    if (originalTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = originalTrust;
    if (originalHeader === undefined) delete process.env.CLIENT_IP_HEADER; else process.env.CLIENT_IP_HEADER = originalHeader;
  });
  const { request, origin, calls } = await fixture(t, { testMode: false });
  const headers = { 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '11.0.0.1', 'x-forwarded-proto': 'https', origin: origin.replace('http:', 'https:') };
  const first = await request('/api/reports', { body: { ...GPS, type: 'power' }, headers });
  assert.equal(first.status, 201);
  assert.match(first.headers.get('set-cookie'), /; Secure/);
  const forged = await request('/api/reports', { body: { ...GPS, type: 'power' }, headers: { ...headers, 'x-forwarded-for': '11.0.0.2' } });
  assert.equal(forged.status, 429, 'changing an unselected header never creates a new voter');
  const second = await request('/api/reports', { body: { ...GPS, type: 'power' }, headers: { ...headers, 'x-real-ip': '8.8.4.4' } });
  assert.equal(second.status, 201);
  await request('/api/network', { headers });
  assert.deepEqual(calls.find(call => call[0] === 'network'), ['network', '8.8.8.8']);
});

test('integrations route server-derived ISP and bind push subscriptions to hashed device identity', async t => {
  const { request, calls } = await fixture(t);
  const session = await request('/api/status');
  const network = await request('/api/network', { cookie: session.cookie });
  assert.equal(network.payload.isp, 'Dialog');
  assert.equal(network.headers.get('set-cookie'), null);
  const report = await request('/api/reports', { body: { ...GPS, type: 'net', isp: 'Invented ISP' } });
  assert.equal(report.payload.report.isp, 'Dialog');
  assert.deepEqual(report.payload.status.leaderboard.isps, [{ name: 'Dialog', count: 1 }]);
  const weather = await request(`/api/weather?${locationQuery}`);
  assert.equal(weather.payload.available, true);
  const notices = await request('/api/notices?area=Colombo');
  assert.equal(notices.payload.area, 'Colombo');
  const push = await request('/api/push/subscribe', { cookie: session.cookie, body: { ...GPS, subscription: { endpoint: 'https://fcm.googleapis.com/fake' } } });
  assert.equal(push.status, 200);
  const call = calls.find(value => value[0] === 'subscribe');
  assert.match(call[2].deviceId, /^[a-f0-9]{64}$/);
  assert.notEqual(call[2].deviceId, session.cookie.split('=')[1]);
  const unsubscribe = await request('/api/push/unsubscribe', { cookie: session.cookie, body: { endpoint: 'https://fcm.googleapis.com/fake' } });
  assert.equal(unsubscribe.status, 200);
  assert.equal(calls.find(value => value[0] === 'unsubscribe')[1].deviceId, call[2].deviceId);
});

test('health checks storage without creating a device, calling integrations, or consuming the API limit', async t => {
  const { request, calls, dataFile } = await fixture(t);
  for (const method of ['GET', 'HEAD']) {
    const response = await request('/api/health', { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.payload, method === 'HEAD' ? '' : { status: 'ok' });
  }
  for (let i = 0; i < 301; i++) assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/status')).status, 200);
  assert.deepEqual(calls, []);
  await rm(dataFile);
  assert.equal((await request('/api/health')).status, 503);
});

test('failed persistence leaves reports and cooldowns unchanged and allows a successful retry', async t => {
  const { request, dataFile } = await fixture(t);
  const session = await request('/api/status');
  const directory = dirname(dataFile);
  await rm(directory, { recursive: true });
  await writeFile(directory, 'storage temporarily unavailable');
  const failed = await request('/api/reports', { body: { ...GPS, type: 'power' }, cookie: session.cookie });
  assert.equal(failed.status, 500);
  assert.equal((await request('/api/status')).payload.counts.power, 0, 'a failed report is not visible in memory');
  assert.equal((await request('/api/health')).status, 503);
  await rm(directory);
  await mkdir(directory);
  const retried = await request('/api/reports', { body: { ...GPS, type: 'power' }, cookie: session.cookie });
  assert.equal(retried.status, 201, 'a failed write does not consume the reporting cooldown');
  assert.equal(retried.payload.status.counts.power, 1);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal(JSON.parse(await readFile(dataFile, 'utf8')).reports.length, 1);
});

test('simultaneous reports commit once each and preserve quorum and persisted state', async t => {
  const { request, dataFile } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => request('/api/reports', {
    body: { ...GPS, type: 'power' }, ip: `10.20.0.${index + 1}`,
  })));
  assert.ok(responses.every(response => response.status === 201));
  const status = await request(`/api/status?${locationQuery}`);
  assert.equal(status.payload.counts.power, 5);
  assert.equal(status.payload.nearbyZone.verified, true);
  const stored = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(stored.reports.length, 5);
  assert.equal(stored.scores.length, 5);
  assert.equal(new Set(stored.reports.map(report => report.id)).size, 5);
});
