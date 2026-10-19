import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createECDH } from 'node:crypto';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { officialURL } from '../scripts/refresh-notices.mjs';

const MINUTE = 60_000;
const THUNDER_CODES = new Set([95, 96, 97, 99]);
const PUSH_LIMIT = 1_000;
const PUSH_LIFETIME = 30 * 24 * 60 * MINUTE;

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn(`Cannot read ${file.split('/').at(-1)}; check the data file.`); return fallback; }
}

async function fetchJSON(url, timeout = 4_000, signal) {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: 'error', headers: { accept: 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Upstream HTTP ${response.status}`); }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 256_000) { await reader.cancel(); throw new Error('Upstream response too large'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicIP(input) {
  const ip = String(input || '').replace(/^::ffff:/i, '');
  if (!isIP(ip)) return null;
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && [0, 2].includes(c)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return null;
  } else if (/^(::|fc|fd|fe[89ab]|ff|2001:db8)/i.test(ip)) return null;
  return ip;
}

export function normalizeISP(name) {
  const text = String(name || '');
  if (/dialog/i.test(text)) return 'Dialog';
  if (/mobitel/i.test(text)) return 'Mobitel';
  if (/hutch(?:ison)?/i.test(text)) return 'Hutch';
  if (/sri\s*lanka\s*telecom|\bslt\b/i.test(text)) return 'SLT';
  return text.slice(0, 120) || null;
}

function coordinates(location) {
  const lat = Number(location?.lat), lng = Number(location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 5.8 || lat > 10 || lng < 79.4 || lng > 82.1) return null;
  return { lat, lng };
}

function validPushEndpoint(value) {
  try {
    if (typeof value !== 'string') return false;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || value.length > 2_048) return false;
    const host = url.hostname.toLowerCase();
    return ['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com'].includes(host) ||
      host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
  } catch { return false; }
}

function validPushKey(value, bytes) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value) && Buffer.from(value, 'base64url').length === bytes;
}

function validVapid(env) {
  try {
    if (!validPushKey(env.VAPID_PUBLIC_KEY, 65) || !validPushKey(env.VAPID_PRIVATE_KEY, 32)) return false;
    const subject = new URL(env.VAPID_SUBJECT);
    if (!['mailto:', 'https:'].includes(subject.protocol)) return false;
    const key = createECDH('prime256v1');
    key.setPrivateKey(Buffer.from(env.VAPID_PRIVATE_KEY, 'base64url'));
    return key.getPublicKey().equals(Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url'));
  } catch { return false; }
}

function error(message, status = 400) { return Object.assign(new Error(message), { status, statusCode: status }); }
function normalizedArea(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim(); }

/** External integrations are optional; unavailable sources never become sample data. */
export function createIntegrations({ dataDir = resolve('.data'), env = process.env } = {}) {
  const networkCache = new Map(), weatherCache = new Map();
  const shutdown = new AbortController();
  const pushFile = join(dataDir, 'push.json');
  let subscriptions = [], persistQueue = Promise.resolve(), runningCheck = false, refreshingNotices = false;
  const ready = readJSON(pushFile, []).then((items) => {
    subscriptions = Array.isArray(items) ? items.filter((item) =>
      validPushEndpoint(item?.subscription?.endpoint) && validPushKey(item.subscription.keys?.p256dh, 65) &&
      validPushKey(item.subscription.keys?.auth, 16) && coordinates(item) &&
      typeof item.deviceId === 'string' && Number.isFinite(item.updatedAt) &&
      item.updatedAt <= Date.now() && Date.now() - item.updatedAt < PUSH_LIFETIME).slice(-PUSH_LIMIT) : [];
  });
  const pushEnabled = validVapid(env);
  let pushClient;

  function persist() {
    const snapshot = JSON.stringify(subscriptions);
    const task = persistQueue.catch(() => {}).then(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(`${pushFile}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${pushFile}.tmp`, pushFile);
    });
    persistQueue = task;
    return task;
  }

  async function cached(cache, key, lifetime, work) {
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    const promise = work();
    cache.set(key, { expires: Date.now() + lifetime, value: promise });
    if (cache.size > 2_000) cache.delete(cache.keys().next().value);
    try { return await promise; }
    catch (failure) { cache.delete(key); throw failure; }
  }

  async function network(ip) {
    const address = publicIP(ip);
    if (!address) return { available: false, isp: null, asn: null, reason: 'Provider detection needs a public client IP.', source: 'ipwho.is' };
    try {
      return await cached(networkCache, address, 60 * MINUTE, async () => {
        const result = await fetchJSON(`https://ipwho.is/${encodeURIComponent(address)}`, 2_000, shutdown.signal);
        if (result.success !== true || !result.connection?.isp) throw new Error('Provider lookup unavailable');
        return {
          available: true, isp: normalizeISP(result.connection.isp),
          organization: String(result.connection.org || '').slice(0, 160),
          asn: result.connection.asn ?? null, connection: null,
          source: 'ipwho.is', checkedAt: new Date().toISOString(),
          note: 'Public IP network owner; VPNs and gateways can change this result. Access type is not inferred.'
        };
      });
    } catch {
      return { available: false, isp: null, asn: null, source: 'ipwho.is', reason: 'Provider lookup is temporarily unavailable.' };
    }
  }

  async function weather(location) {
    const point = coordinates(location);
    if (!point) return { available: false, stormRisk: false, reason: 'Choose a location in Sri Lanka for the weather forecast.' };
    const key = `${point.lat.toFixed(2)},${point.lng.toFixed(2)}`;
    try {
      return await cached(weatherCache, key, 10 * MINUTE, async () => {
        const url = new URL('https://api.open-meteo.com/v1/forecast');
        url.search = new URLSearchParams({ latitude: point.lat.toFixed(3), longitude: point.lng.toFixed(3),
          current: 'temperature_2m,weather_code,precipitation', hourly: 'weather_code,precipitation_probability',
          forecast_hours: '3', timezone: 'UTC', timeformat: 'unixtime' }).toString();
        const result = await fetchJSON(url, 4_000, shutdown.signal);
        const currentAt = Number(result.current?.time) * 1_000;
        if (!result.current || !Number.isFinite(result.current.weather_code) || !Number.isFinite(currentAt) ||
          Math.abs(Date.now() - currentAt) > 90 * MINUTE || !Array.isArray(result.hourly?.time)) throw new Error('Missing or stale weather fields');
        const currentCode = result.current.weather_code;
        const nextIndex = result.hourly.time.findIndex((time) => Number.isFinite(time) && time * 1_000 > Date.now() && time * 1_000 <= Date.now() + 60 * MINUTE);
        const nextCode = nextIndex >= 0 ? result.hourly.weather_code?.[nextIndex] : null;
        const stormNow = THUNDER_CODES.has(currentCode), stormSoon = THUNDER_CODES.has(nextCode);
        return {
          available: true, source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/',
          checkedAt: new Date().toISOString(), stormRisk: stormNow || stormSoon,
          current: { weatherCode: currentCode, temperature: result.current.temperature_2m ?? null,
            precipitation: result.current.precipitation ?? null, at: new Date(result.current.time * 1_000).toISOString() },
          nextHour: nextIndex < 0 ? null : { weatherCode: nextCode ?? null,
            rainChance: result.hourly.precipitation_probability?.[nextIndex] ?? null,
            at: new Date(result.hourly.time[nextIndex] * 1_000).toISOString() },
          summary: stormNow ? 'Thunderstorms indicated near your selected area. Charge essential devices while power is available.' :
            stormSoon ? 'Thunderstorms forecast in the next hour near your selected area. Charge essential devices while power is available.' :
              'No thunderstorm indicated in the current or next-hour forecast.',
          note: 'Weather-model guidance; this is not live lightning tracking or a 30-minute arrival prediction.'
        };
      });
    } catch {
      return { available: false, stormRisk: false, source: 'Open-Meteo', reason: 'Weather forecast is temporarily unavailable.' };
    }
  }

  async function notices({ area } = {}) {
    const stored = await readJSON(join(dataDir, 'notices.json'), null);
    const items = Array.isArray(stored) ? stored : Array.isArray(stored?.notices) ? stored.notices : [];
    const requested = normalizedArea(area);
    const matching = requested.length < 2 ? [] : items.filter((item) => {
      if (!item || !Array.isArray(item.areas)) return false;
      if (item.endsAt && (!Number.isFinite(Date.parse(item.endsAt)) || Date.parse(item.endsAt) <= Date.now())) return false;
      if (item.startsAt && (!Number.isFinite(Date.parse(item.startsAt)) || (!item.endsAt && Date.parse(item.startsAt) < Date.now()))) return false;
      if (item.startsAt && item.endsAt && Date.parse(item.startsAt) > Date.parse(item.endsAt)) return false;
      if (!item.startsAt && !item.endsAt && (!Number.isFinite(Date.parse(item.updatedAt)) || Date.now() - Date.parse(item.updatedAt) > 36 * 60 * MINUTE)) return false;
      try { officialURL(item.url); } catch { return false; }
      return item.areas.some((name) => normalizedArea(name) === requested);
    });
    return { notices: matching, updatedAt: stored?.updatedAt || null,
      configured: Boolean(env.NOTICE_SOURCE_URLS && env.OPENAI_API_KEY),
      areaRequired: requested.length < 2, stale: Boolean(stored?.updatedAt && Date.now() - Date.parse(stored.updatedAt) > 36 * 60 * MINUTE),
      note: 'Only exact area names explicitly listed in the source are matched. Check the original notice.' };
  }

  function publicKey() {
    return { enabled: pushEnabled, publicKey: pushEnabled ? env.VAPID_PUBLIC_KEY : null,
      reason: pushEnabled ? null : 'Background alerts need server VAPID configuration.' };
  }

  async function subscribe(subscription, location = {}) {
    await ready;
    if (!pushEnabled) throw error('Background weather alerts are not configured on this server.', 503);
    if (!subscription || !validPushEndpoint(subscription.endpoint) ||
      !validPushKey(subscription.keys?.p256dh, 65) || !validPushKey(subscription.keys?.auth, 16)) throw error('Invalid browser push subscription.');
    const point = coordinates(location);
    if (!point) throw error('A Sri Lankan location is required for local weather alerts.');
    if (typeof location.deviceId !== 'string' || location.deviceId.length < 8 || location.deviceId.length > 128) throw error('A valid device identifier is required.');
    const existing = subscriptions.find((item) => item.subscription.endpoint === subscription.endpoint);
    if (existing && existing.deviceId !== location.deviceId) throw error('This subscription belongs to a different device.', 403);
    if (!existing && subscriptions.length >= PUSH_LIMIT) throw error('Weather alert capacity reached. Try again later.', 503);
    const record = { subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      ...point, area: String(location.area || '').slice(0, 100), deviceId: location.deviceId,
      updatedAt: Date.now(), lastAlertAt: existing?.lastAlertAt || 0 };
    subscriptions = subscriptions.filter((item) => item.deviceId !== location.deviceId && item !== existing);
    subscriptions.push(record);
    await persist();
    return { subscribed: true, intervalMinutes: 15 };
  }

  async function unsubscribe({ endpoint, deviceId } = {}) {
    await ready;
    subscriptions = subscriptions.filter((item) => !(item.subscription.endpoint === endpoint && item.deviceId === deviceId));
    await persist();
    return { subscribed: false };
  }

  async function checkStorms() {
    await ready;
    if (!pushEnabled || runningCheck || shutdown.signal.aborted || !subscriptions.length) return;
    runningCheck = true;
    try {
      pushClient ||= import('web-push').then((module) => module.default || module);
      const client = await pushClient;
      const records = [...subscriptions];
      for (let start = 0; start < records.length; start += 8) {
        await Promise.allSettled(records.slice(start, start + 8).map(async (record) => {
          if (shutdown.signal.aborted || !subscriptions.includes(record)) return;
          if (Date.now() - record.updatedAt > PUSH_LIFETIME) { subscriptions = subscriptions.filter((item) => item !== record); return; }
          if (Date.now() - record.lastAlertAt < 60 * MINUTE) return;
          const forecast = await weather(record);
          if (!forecast.available || !forecast.stormRisk || shutdown.signal.aborted || !subscriptions.includes(record)) return;
          try {
            await client.sendNotification(record.subscription, JSON.stringify({
              title: 'Storm forecast — charge now', body: forecast.summary,
              tag: 'currentgiya-storm', url: '/', area: record.area
            }), { TTL: 1_800, timeout: 8_000, vapidDetails: {
              subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY
            } });
            record.lastAlertAt = Date.now();
          } catch (failure) {
            if ([404, 410].includes(failure.statusCode)) subscriptions = subscriptions.filter((item) => item !== record);
            else console.warn('A weather notification could not be delivered; it will retry on the next check.');
          }
        }));
      }
      await persist();
    } catch { console.warn('Background weather checks are unavailable; check the web-push installation and VAPID settings.'); }
    finally { runningCheck = false; }
  }

  const timer = setInterval(() => { void checkStorms(); }, 15 * MINUTE);
  timer.unref();
  async function refreshDailyNotices() {
    if (refreshingNotices || shutdown.signal.aborted || !env.OPENAI_API_KEY || !env.NOTICE_SOURCE_URLS) return;
    const saved = await readJSON(join(dataDir, 'notices.json'), null);
    if (saved?.updatedAt && Date.now() - Date.parse(saved.updatedAt) < 23 * 60 * MINUTE) return;
    refreshingNotices = true;
    try {
      const { refreshNotices } = await import('../scripts/refresh-notices.mjs');
      await refreshNotices({ env, dataDir, signal: shutdown.signal });
    } catch { if (!shutdown.signal.aborted) console.warn('Daily official-notice refresh could not finish; check source URLs and extraction configuration. Existing notices are retained.'); }
    finally { refreshingNotices = false; }
  }
  const noticeTimer = setInterval(() => { void refreshDailyNotices(); }, 60 * MINUTE);
  noticeTimer.unref();
  if (env.OPENAI_API_KEY && env.NOTICE_SOURCE_URLS) void refreshDailyNotices();
  // The timer continues while the server runs, including when a user's browser tab is closed.
  return { network, weather, notices, publicKey, subscribe, unsubscribe, checkStorms,
    close: () => { clearInterval(timer); clearInterval(noticeTimer); shutdown.abort(); return persistQueue; } };
}
