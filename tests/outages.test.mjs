import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutageEngine, distanceMeters, independentCount, REPORT_TTL, RESTORE_TTL } from '../lib/outages.mjs';

const GPS = { lat: 6.9271, lng: 79.8612, accuracy: 20, area: 'Colombo', district: 'Colombo' };
function fixture() {
  let clock = Date.UTC(2026, 9, 19, 12);
  const engine = createOutageEngine({}, () => clock);
  return { engine, tick: (ms = 1) => { clock += ms; }, report: (i, fields = {}) => engine.addReport({ ...GPS, type: 'power', ...fields }, { ip: `10.0.0.${i}`, device: `device-${i}` }) };
}

test('starts empty and validates Sri Lankan GPS, accuracy, category and content', () => {
  const { engine, report } = fixture();
  assert.deepEqual(engine.status().counts, { power: 0, water: 0, net: 0 });
  assert.equal(engine.status().nearbyZone, null);
  for (const fields of [{ lat: 0 }, { lng: Infinity }, { accuracy: 201 }, { accuracy: undefined }, { type: 'invalid' }, { area: '' }, { area: 'x'.repeat(81) }]) {
    assert.throws(() => report(1, fields), error => error.status === 400);
  }
});

test('five different IPs and devices within three minutes verify; shared identities cannot', () => {
  const { engine, report, tick } = fixture();
  for (let i = 1; i <= 4; i++) { report(i); tick(10_000); }
  assert.equal(engine.status(GPS).nearbyZone.verified, false);
  assert.throws(() => engine.addReport({ ...GPS, type: 'power' }, { ip: '10.0.0.1', device: 'fresh-device' }), error => error.status === 429);
  assert.throws(() => engine.addReport({ ...GPS, type: 'power' }, { ip: '10.0.0.99', device: 'device-1' }), error => error.status === 429);
  report(5);
  assert.equal(engine.status(GPS).nearbyZone.verified, true);
  tick(4 * 60_000);
  assert.equal(engine.status(GPS).nearbyZone.verified, true, 'a confirmed outage stays confirmed until restored or expired');
  assert.equal(independentCount([
    { deviceHash: 'A', ipHash: 'X' }, { deviceHash: 'A', ipHash: 'Y' },
    { deviceHash: 'B', ipHash: 'X' }, { deviceHash: 'C', ipHash: 'Z' },
  ]), 3, 'maximum matching handles overlapping identities');
});

test('scattered reports outside a three-minute window do not verify', () => {
  const { engine, report, tick } = fixture();
  for (let i = 1; i <= 5; i++) { report(i); tick(60_000); }
  assert.equal(engine.status(GPS).nearbyZone.verified, false);
});

test('100m clusters distinguish concentrated reports from wider area signals without joining remote towns', () => {
  const { engine, report, tick } = fixture();
  for (let i = 1; i <= 5; i++) { report(i, { lat: GPS.lat + i * 0.00001 }); tick(); }
  assert.equal(engine.status(GPS).nearbyZone.scope, 'street');
  report(6, { lat: GPS.lat + 0.002 });
  assert.equal(engine.status(GPS).nearbyZone.scope, 'area');
  report(7, { lat: 7.29, lng: 80.63, area: 'Kandy' });
  assert.equal(engine.status().zones.length, 2);
  assert.equal(engine.status({ lat: 8, lng: 81 }).nearbyZone, null);
  assert.ok(distanceMeters(GPS, { ...GPS, lat: GPS.lat + 0.001 }) > 100);
});

test('nearby zones and chat use the same precise 3km boundary while public coordinates remain rounded', () => {
  const { engine, report } = fixture();
  for (let i = 1; i <= 5; i++) report(i);
  const inside = { ...GPS, lat: GPS.lat + 0.02695 };
  const outside = { ...GPS, lat: GPS.lat - 0.027 };
  assert.ok(distanceMeters(inside, GPS) < 3000);
  assert.ok(distanceMeters(outside, GPS) > 3000);
  const publicZone = engine.status().zones[0];
  assert.ok(distanceMeters(inside, publicZone) > 3000, 'rounded coordinates cross the northern boundary');
  assert.ok(distanceMeters(outside, publicZone) < 3000, 'rounded coordinates cross the southern boundary');
  assert.equal(engine.status(inside).nearbyZone.id, engine.chat(inside).zoneId);
  assert.equal(engine.status(inside).nearbyZone.lat, 6.927, 'precise matching does not expose exact coordinates');
  assert.equal(engine.status(outside).nearbyZone, null);
  assert.equal(engine.chat(outside).unlocked, false);
});

test('chat opens only in a verified power zone within 3km and expires on restoration', () => {
  const { engine, report, tick } = fixture();
  assert.equal(engine.chat(GPS).unlocked, false);
  for (let i = 1; i <= 5; i++) { report(i); tick(); }
  assert.equal(engine.chat(GPS).unlocked, true);
  assert.equal(engine.chat({ ...GPS, lat: GPS.lat + 0.04 }).unlocked, false);
  assert.throws(() => engine.chat({ ...GPS, accuracy: undefined }), error => error.status === 400);
  const actor = { ip: '10.0.0.50', device: 'chatter' };
  const result = engine.addChat({ ...GPS, nickname: 'Admin', text: '<b>Hello</b>', battery: 8 }, actor);
  assert.match(result.message.nickname, /^Neighbour [A-F0-9]{4}$/);
  assert.equal(result.message.battery, 8);
  assert.equal(result.message.text, '<b>Hello</b>', 'JSON transport preserves text for frontend textContent rendering');
  assert.throws(() => engine.addChat({ ...GPS, text: 'spam' }, actor), error => error.status === 429);
  engine.addChat({ ...GPS, text: 'Neighbour here', battery: 80 }, { ip: '10.0.0.51', device: 'another-chatter' });
  const refreshed = engine.updateBattery({ ...GPS, battery: 7 }, actor);
  assert.deepEqual(refreshed.messages.map(m => m.battery), [7, 80], 'battery changes apply only to this device’s own messages');
  assert.ok(!JSON.stringify(refreshed).includes('ownerHash'));
  assert.throws(() => engine.updateBattery({ ...GPS, lat: GPS.lat + 0.04, battery: 6 }, actor), error => error.status === 403);
  for (let i = 10; i <= 12; i++) { tick(); report(i, { type: 'restored' }); }
  assert.deepEqual(engine.status(GPS).counts, { power: 0, water: 0, net: 0 });
  assert.equal(engine.status(GPS).restoration.restored, true);
  assert.equal(engine.chat(GPS).unlocked, false);
  assert.deepEqual(engine.state.chats, {});
  tick(RESTORE_TTL + 1);
  assert.equal(engine.status(GPS).restoration.restored, false);
  assert.equal(engine.status(GPS).counts.power, 0, 'resolved reports never reappear when restoration votes expire');
});

test('restoration requires three independent newer neighbours within 1km; new outages reset old restoration', () => {
  const { engine, report, tick } = fixture();
  report(1, { type: 'restored' }); tick();
  for (let i = 2; i <= 6; i++) { report(i); tick(); }
  assert.equal(engine.status(GPS).restoration.count, 0);
  report(10, { type: 'restored', lat: GPS.lat + 0.02 }); tick();
  assert.equal(engine.status(GPS).restoration.count, 0);
  report(11, { type: 'restored' }); tick();
  report(12, { type: 'restored' }); tick();
  assert.equal(engine.status(GPS).restoration.count, 2);
  report(7); tick();
  assert.equal(engine.status(GPS).restoration.count, 0, 'a fresh outage invalidates earlier restore votes');
  report(13, { type: 'restored' }); tick();
  report(14, { type: 'restored' }); tick();
  report(15, { type: 'restored' }); tick();
  assert.equal(engine.status(GPS).restoration.restored, true);
  report(8);
  assert.deepEqual(engine.status(GPS).restoration, { count: 0, restored: false });
});

test('reports and chat expire after two hours, while daily rankings retain submitted real reports', () => {
  const { engine, report, tick } = fixture();
  for (let i = 1; i <= 5; i++) { report(i); tick(); }
  engine.addChat({ ...GPS, text: 'Hello' }, { ip: '10.0.0.100', device: 'reader' });
  report(10, { type: 'net', isp: 'Dialog' });
  assert.deepEqual(engine.status().leaderboard.isps, [{ name: 'Dialog', count: 1 }]);
  tick(REPORT_TTL + 1);
  assert.equal(engine.status().reports.length, 0);
  assert.deepEqual(engine.state.chats, {});
  assert.deepEqual(engine.status().leaderboard.districts, [{ name: 'Colombo', count: 5 }]);
});

test('private identities are salted and never returned in public report payloads', () => {
  const { engine, report } = fixture();
  const response = report(1);
  const publicJSON = JSON.stringify(response);
  assert.equal(response.report.lat, 6.927);
  assert.equal(response.report.lng, 79.861);
  assert.equal(response.status.zones[0].lat, 6.927);
  assert.equal(engine.state.reports[0].lat, GPS.lat, 'precise locations stay private for geospatial thresholds');
  assert.ok(!publicJSON.includes('ipHash'));
  assert.ok(!publicJSON.includes('deviceHash'));
  assert.ok(!JSON.stringify(engine.state).includes('10.0.0.1'));
  assert.ok(!JSON.stringify(engine.state).includes('device-1'));
  const restoredEngine = createOutageEngine(JSON.parse(JSON.stringify(engine.state)));
  assert.deepEqual(restoredEngine.identity('10.0.0.1', 'device-1'), engine.identity('10.0.0.1', 'device-1'));
});

test('a verified incident keeps its room and verification while older individual reports expire', () => {
  const { engine, report, tick } = fixture();
  for (let i = 1; i <= 5; i++) { report(i); if (i < 5) tick(30_000); }
  const original = engine.chat(GPS);
  engine.addChat({ ...GPS, text: 'Still waiting' }, { ip: '10.0.0.100', device: 'reader' });
  tick(REPORT_TTL - 90_000);
  const status = engine.status(GPS);
  assert.equal(status.counts.power, 3);
  assert.equal(status.nearbyZone.verified, true);
  assert.equal(engine.chat(GPS).zoneId, original.zoneId);
  assert.equal(engine.chat(GPS).messages[0].text, 'Still waiting');
  tick(91_000);
  assert.equal(engine.chat(GPS).unlocked, false);
  assert.deepEqual(engine.state.incidents, {});
  assert.deepEqual(engine.state.chats, {});
});

test('same-millisecond restoration order is valid and old votes cannot clear a new incident', () => {
  const { engine, report } = fixture();
  report(1);
  for (let i = 10; i <= 12; i++) report(i, { type: 'restored' });
  assert.equal(engine.status(GPS).restoration.restored, true);
  report(2);
  assert.equal(engine.status(GPS).counts.power, 1);
  assert.deepEqual(engine.status(GPS).restoration, { count: 0, restored: false });
  report(13, { type: 'restored' });
  assert.deepEqual(engine.status(GPS).restoration, { count: 1, restored: false });
});

test('restoration alarms count neighbours within 1km of the viewer rather than a distant edge of the zone', () => {
  const { engine, report, tick } = fixture();
  report(1);
  const viewer = { ...GPS, lat: GPS.lat + 0.007 };
  for (let i = 10; i <= 12; i++) { tick(); report(i, { type: 'restored', lat: GPS.lat - 0.007 }); }
  assert.equal(engine.status(GPS).restoration.restored, true, 'zone-centre users have three neighbours within range');
  assert.deepEqual(engine.status(viewer).restoration, { count: 0, restored: false }, 'edge viewer is more than 1km from all three voters');
  for (let i = 13; i <= 15; i++) { tick(); report(i, { type: 'restored', lat: viewer.lat }); }
  assert.equal(engine.status(viewer).restoration.restored, true, 'local neighbours can subsequently confirm restoration');
});

test('daily history survives restoration with no coordinates or identities and resets at Sri Lankan midnight', () => {
  const { engine, report, tick } = fixture();
  report(1);
  for (let i = 10; i <= 12; i++) { tick(); report(i, { type: 'restored' }); }
  assert.deepEqual(engine.status().leaderboard.districts, [{ name: 'Colombo', count: 1 }]);
  assert.deepEqual(Object.keys(engine.state.scores[0]).sort(), ['area', 'createdAt', 'district', 'type']);
  tick(7 * 60 * 60_000);
  assert.deepEqual(engine.status().leaderboard.districts, []);
  assert.equal(engine.state.scores.length, 1, 'retention and local calendar-day filtering are separate');
  assert.ok(!JSON.stringify(engine.state).includes(String(GPS.lat)), 'precise coordinates expire with the incident');
});
