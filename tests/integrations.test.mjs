import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrations, normalizeISP } from '../lib/integrations.mjs';
import { cleanNotice, htmlText, officialURL, refreshNotices } from '../scripts/refresh-notices.mjs';

const MINUTE = 60_000;
const future = (offset = 24 * 60 * MINUTE) => new Date(Date.now() + offset).toISOString().replace('.000Z', 'Z').replace(/\.\d{3}Z$/, 'Z');
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function fixture(t, env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'currentgiya-integrations-'));
  const service = createIntegrations({ dataDir, env });
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, dataDir };
}

function vapid() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return { VAPID_PUBLIC_KEY: key.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: key.getPrivateKey().toString('base64url'), VAPID_SUBJECT: 'mailto:alerts@example.com' };
}

function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint') {
  return { endpoint, keys: { p256dh: vapid().VAPID_PUBLIC_KEY, auth: Buffer.alloc(16, 4).toString('base64url') } };
}

test('provider lookup uses the actual network owner, caches requests, and never guesses access type', async (t) => {
  const { service } = await fixture(t);
  const cases = [['Sri Lanka Telecom PLC', 'SLT'], ['Dialog Axiata PLC', 'Dialog'], ['Mobitel Pvt Ltd', 'Mobitel'], ['Hutchison Telecommunications', 'Hutch'], ['Unknown provider', 'Unknown provider']];
  for (const [name, expected] of cases) assert.equal(normalizeISP(name), expected);
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /^https:\/\/ipwho\.is\//);
    return json({ success: true, connection: { isp: 'Dialog Axiata PLC', asn: 18001, org: 'Dialog' } });
  };
  const result = await service.network('8.8.8.8');
  assert.equal(result.available, true);
  assert.equal(result.isp, 'Dialog');
  assert.equal(result.asn, 18001);
  assert.equal(result.connection, null);
  assert.deepEqual(await service.network('8.8.8.8'), result);
  assert.equal(calls, 1);
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.1', '10.1.2.3', '100.64.0.1', 'not-an-ip']) assert.equal((await service.network(ip)).available, false);
  assert.equal(calls, 1, 'private or invalid client IPs never leave the server');
});

test('provider failures stay unavailable rather than using a fallback ISP', async (t) => {
  const { service } = await fixture(t);
  globalThis.fetch = async () => json({ success: false, message: 'Reserved range' });
  const result = await service.network('8.8.4.4');
  assert.equal(result.available, false);
  assert.equal(result.isp, null);
});

test('weather flags current/next-hour thunderstorms and clearly identifies model guidance', async (t) => {
  const { service } = await fixture(t);
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get('timeformat'), 'unixtime');
    return json({ current: { time: Math.floor(Date.now() / 1_000), weather_code: 3, temperature_2m: 27, precipitation: 0 },
      hourly: { time: [Math.floor((Date.now() + 30 * MINUTE) / 1_000)], weather_code: [95], precipitation_probability: [85] } });
  };
  const result = await service.weather({ lat: 6.927, lng: 79.861 });
  assert.equal(result.available, true);
  assert.equal(result.stormRisk, true);
  assert.equal(result.nextHour.rainChance, 85);
  assert.match(result.summary, /forecast in the next hour/);
  assert.match(result.note, /not live lightning tracking/);
  await service.weather({ lat: 6.927, lng: 79.861 });
  assert.equal(calls, 1, 'nearby requests reuse a forecast for ten minutes');
  assert.equal((await service.weather({ lat: 0, lng: 0 })).available, false);
  assert.equal(calls, 1);
});

test('weather does not call a distant future storm a next-hour forecast or use stale observations', async (t) => {
  const { service } = await fixture(t);
  globalThis.fetch = async () => json({ current: { time: Math.floor(Date.now() / 1_000), weather_code: 3 },
    hourly: { time: [Math.floor((Date.now() + 4 * 60 * MINUTE) / 1_000)], weather_code: [95] } });
  const result = await service.weather({ lat: 6.9, lng: 79.8 });
  assert.equal(result.stormRisk, false);
  assert.equal(result.nextHour, null);
  globalThis.fetch = async () => json({ current: { time: Math.floor((Date.now() - 24 * 60 * MINUTE) / 1_000), weather_code: 95 }, hourly: { time: [] } });
  assert.equal((await service.weather({ lat: 7.9, lng: 80.8 })).available, false);
});

test('notices match explicit areas, preserve Sinhala marks, and exclude expired or unsafe entries', async (t) => {
  const { service, dataDir } = await fixture(t);
  const base = { title: 'Scheduled interruption', url: 'https://www.ceb.lk/notices/1', endsAt: future(), updatedAt: new Date().toISOString() };
  await writeFile(join(dataDir, 'notices.json'), JSON.stringify({ updatedAt: new Date().toISOString(), notices: [
    { ...base, id: 'exact', areas: ['Nugegoda'] }, { ...base, id: 'nearby', areas: ['Nugegoda West'] },
    { ...base, id: 'sinhala', areas: ['කොළඹ'] }, { ...base, id: 'different-marks', areas: ['කළඹ'] },
    { ...base, id: 'expired', areas: ['Nugegoda'], endsAt: '2020-01-01T00:00:00Z' },
    { ...base, id: 'invalid', areas: ['Nugegoda'], endsAt: 'not-a-time' },
    { ...base, id: 'unsafe', areas: ['Nugegoda'], url: 'javascript:alert(1)' },
    { ...base, id: 'old-no-end', areas: ['Nugegoda'], startsAt: '2020-01-01T00:00:00Z', endsAt: null },
    { ...base, id: 'stale-undated', areas: ['Nugegoda'], endsAt: null, updatedAt: '2020-01-01T00:00:00Z' }, null
  ] }));
  assert.deepEqual((await service.notices({ area: 'NUGEGODA' })).notices.map((item) => item.id), ['exact']);
  assert.deepEqual((await service.notices({ area: 'කොළඹ' })).notices.map((item) => item.id), ['sinhala']);
  assert.deepEqual((await service.notices({ area: 'Nuge' })).notices, []);
  assert.equal((await service.notices({ area: '' })).areaRequired, true);
});

test('push config exposes only public fields and rejects invalid configuration', async (t) => {
  const settings = vapid();
  const { service } = await fixture(t, settings);
  assert.deepEqual(service.publicKey(), { enabled: true, publicKey: settings.VAPID_PUBLIC_KEY, reason: null });
  assert.equal(JSON.stringify(service.publicKey()).includes(settings.VAPID_PRIVATE_KEY), false);
  const disabled = await fixture(t, { VAPID_PUBLIC_KEY: 'invalid', VAPID_PRIVATE_KEY: 'invalid', VAPID_SUBJECT: 'mailto:a@example.com' });
  assert.equal(disabled.service.publicKey().enabled, false);
  await assert.rejects(disabled.service.subscribe(subscription(), { lat: 6.9, lng: 79.8, deviceId: 'device-one' }), { status: 503 });
});

test('push rejects SSRF endpoints and requires subscription ownership to replace or remove a device', async (t) => {
  const { service, dataDir } = await fixture(t, vapid());
  const location = { lat: 6.927, lng: 79.861, area: 'Colombo', deviceId: 'device-one' };
  for (const endpoint of ['https://127.0.0.1/push', 'http://fcm.googleapis.com/push', 'https://fcm.googleapis.com.attacker.test/push', 'https://user:pass@fcm.googleapis.com/push', 'https://fcm.googleapis.com:9443/push']) {
    await assert.rejects(service.subscribe(subscription(endpoint), location), { status: 400 });
  }
  const browser = subscription();
  assert.deepEqual(await service.subscribe(browser, location), { subscribed: true, intervalMinutes: 15 });
  await assert.rejects(service.subscribe(browser, { ...location, deviceId: 'device-two' }), { status: 403 });
  await service.unsubscribe({ endpoint: browser.endpoint, deviceId: 'device-two' });
  assert.equal(JSON.parse(await readFile(join(dataDir, 'push.json'))).length, 1);
  await service.unsubscribe({ endpoint: browser.endpoint, deviceId: 'device-one' });
  assert.equal(JSON.parse(await readFile(join(dataDir, 'push.json'))).length, 0);
});

test('official-source URL validation excludes lookalikes, credentials, insecure ports, and local URLs', () => {
  assert.equal(officialURL('/notice.pdf', 'https://www.ceb.lk/power-interruption/en').href, 'https://www.ceb.lk/notice.pdf');
  for (const url of ['https://ceb.lk.attacker.test/notice.pdf', 'https://127.0.0.1/notice.pdf', 'http://ceb.lk/notice.pdf', 'https://user:pass@ceb.lk/notice.pdf', 'https://ceb.lk:8080/notice.pdf']) assert.throws(() => officialURL(url));
  assert.equal(htmlText('<script>secret</script><p>Nugegoda &amp; Kotte</p>'), 'Nugegoda & Kotte');
});

test('notice cleanup rejects elapsed intervals and never fabricates malformed or impossible dates', () => {
  const item = { title: 'Water interruption', summary: 'Water interruption in Nugegoda.', areas: ['Nugegoda'], evidence: 'Water interruption in Nugegoda', startsAt: future(), endsAt: future(25 * 60 * MINUTE) };
  assert.equal(cleanNotice({ ...item, startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-02T00:00:00Z' }, 'https://waterboard.lk/notices'), null);
  assert.equal(cleanNotice({ ...item, startsAt: '2020-01-01T00:00:00Z', endsAt: null }, 'https://waterboard.lk/notices'), null);
  const invalid = cleanNotice({ ...item, startsAt: '2030-02-30T09:00:00+05:30', endsAt: null }, 'https://waterboard.lk/notices');
  assert.equal(invalid.startsAt, null);
  assert.equal(cleanNotice({ ...item, startsAt: 'tomorrow', endsAt: null }, 'https://waterboard.lk/notices').startsAt, null);
  assert.equal(cleanNotice({ ...item, endsAt: item.startsAt, startsAt: item.endsAt }, 'https://waterboard.lk/notices'), null);
});

test('notice refresh uses strict extraction with scoped credentials and supports linked PDF and image documents', async (t) => {
  const { dataDir } = await fixture(t);
  let modelCalls = 0;
  const visited = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    visited.push(url);
    if (url === 'https://api.openai.com/v1/responses') {
      modelCalls++;
      assert.equal(options.headers.authorization, 'Bearer test-only-key');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      const document = body.input[0].content[1];
      if (modelCalls === 2) { assert.equal(document.type, 'input_image'); assert.match(document.image_url, /^data:image\/png;base64,/); }
      if (modelCalls === 3) { assert.equal(document.type, 'input_file'); assert.match(document.file_data, /^data:application\/pdf;base64,/); }
      const candidates = modelCalls === 1 ? [] : [{ title: `Interruption ${modelCalls}`, areas: ['Nugegoda'], startsAt: future(), endsAt: future(25 * 60 * MINUTE), summary: 'Scheduled interruption in Nugegoda.', evidence: 'Scheduled interruption in Nugegoda' }];
      return json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ notices: candidates }) }] }] });
    }
    assert.equal(options.headers.authorization, undefined, 'API credentials never go to utility-source hosts');
    assert.equal(options.redirect, 'manual');
    if (url.endsWith('.png')) return new Response('image bytes', { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('.pdf')) return new Response('%PDF-test notice', { headers: { 'content-type': 'application/pdf' } });
    return new Response('<h1>Planned power interruption</h1><img src="https://www.ceb.lk/notices/outage.png" alt="Scheduled interruption"><a href="https://www.ceb.lk/notices/outage.pdf">Power interruption PDF</a><img src="https://127.0.0.1/private.png" alt="Power interruption">', { headers: { 'content-type': 'text/html' } });
  };
  const result = await refreshNotices({ dataDir, env: { OPENAI_API_KEY: 'test-only-key', NOTICE_SOURCE_URLS: 'https://www.ceb.lk/power-interruption/en' } });
  assert.equal(result.notices, 2);
  assert.equal(modelCalls, 3);
  assert.equal(visited.some((url) => url.includes('127.0.0.1')), false);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'notices.json'))).notices.length, 2);
});

test('notice refresh rejects off-domain redirects and oversized PDF/image sources before extraction', async (t) => {
  const { dataDir } = await fixture(t);
  const env = { OPENAI_API_KEY: 'test-only-key', NOTICE_SOURCE_URLS: 'https://www.ceb.lk/notice.pdf' };
  let requests = [];
  globalThis.fetch = async (input) => { requests.push(String(input)); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); };
  await assert.rejects(refreshNotices({ dataDir, env }), /No official documents/);
  assert.equal(requests.length, 1, 'a disallowed redirect is never followed');
  requests = [];
  globalThis.fetch = async (input) => { requests.push(String(input)); return new Response('tiny', { headers: { 'content-type': 'application/pdf', 'content-length': String(8 * 1024 * 1024 + 1) } }); };
  await assert.rejects(refreshNotices({ dataDir, env }), /No official documents/);
  assert.equal(requests.length, 1);
  requests = [];
  globalThis.fetch = async (input) => { requests.push(String(input)); return new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }); };
  await assert.rejects(refreshNotices({ dataDir, env: { ...env, NOTICE_SOURCE_URLS: 'https://www.ceb.lk/notice.png' } }), /No official documents/);
  assert.equal(requests.length, 1, 'streamed byte limits also prevent an extraction API call');
});

test('HTML notice extraction rejects invented evidence and area names', async (t) => {
  const { dataDir } = await fixture(t);
  const candidate = { title: 'Scheduled interruption', areas: ['Nugegoda'], startsAt: future(), endsAt: future(25 * 60 * MINUTE), summary: 'Interruption in Nugegoda.', evidence: 'Scheduled interruption in Nugegoda' };
  globalThis.fetch = async (url) => String(url).includes('api.openai.com') ?
    json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ notices: [candidate, { ...candidate, areas: ['Imaginary Town'] }, { ...candidate, evidence: 'An invented quotation describing an outage' }] }) }] }] }) :
    new Response('<p>Scheduled interruption in Nugegoda</p>', { headers: { 'content-type': 'text/html' } });
  const result = await refreshNotices({ dataDir, env: { OPENAI_API_KEY: 'test-only-key', NOTICE_SOURCE_URLS: 'https://www.ceb.lk/notices' } });
  assert.equal(result.notices, 1);
  const stored = JSON.parse(await readFile(join(dataDir, 'notices.json')));
  assert.deepEqual(stored.notices[0].areas, ['Nugegoda']);
});
