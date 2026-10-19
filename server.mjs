import http from 'node:http';
if (process.loadEnvFile) {
  try { process.loadEnvFile('.env'); } catch {}
}
import { access, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { createOutageEngine, fail, validateCoordinates } from './lib/outages.mjs';
import { createIntegrations } from './lib/integrations.mjs';
import { districtFor } from './lib/districts.mjs';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/lite', ['lite.html', 'text/html; charset=utf-8']],
  ['/lite.html', ['lite.html', 'text/html; charset=utf-8']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
]);

function headers(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function statusPayload(status, url) {
  if (url.searchParams.get('lite') !== '1') return status;
  const { counts, nearbyZone, restoration, serverTime } = status;
  return { counts, nearbyZone, restoration, serverTime };
}

function acceptedEncoding(header) {
  const qualities = new Map();
  for (const item of String(header || '').toLowerCase().split(',')) {
    const [encoding, ...parameters] = item.trim().split(';');
    if (!encoding) continue;
    const qualityParameter = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
    qualities.set(encoding, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  return ['br', 'gzip'].map(encoding => ({ encoding, q: qualities.get(encoding) ?? qualities.get('*') ?? 0 })).filter(value => value.q > 0).sort((a, b) => b.q - a.q)[0]?.encoding;
}

async function readJSON(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail('Use application/json.', 415);
  if (Number(req.headers['content-length']) > 8192) fail('Request body is too large.', 413);
  const bytes = await new Promise((accept, reject) => {
    let length = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      length += chunk.length;
      if (settled) return;
      if (length > 8192) {
        settled = true;
        const error = new Error('Request body is too large.');
        error.status = 413;
        reject(error);
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; accept(Buffer.concat(chunks)); } });
    req.on('error', reject);
    req.on('aborted', () => { const error = new Error('Request was interrupted.'); error.status = 400; reject(error); });
  });
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('A JSON object is required.');
  return value;
}

function locationFrom(url, required = false, accuracy = false) {
  const hasLocation = url.searchParams.has('lat') || url.searchParams.has('lng');
  if (!hasLocation && !required) return undefined;
  if (!url.searchParams.has('lat') || !url.searchParams.has('lng') || !url.searchParams.get('lat') || !url.searchParams.get('lng')) fail('Latitude and longitude are required.');
  const location = { lat: Number(url.searchParams.get('lat')), lng: Number(url.searchParams.get('lng')) };
  if (accuracy) {
    if (!url.searchParams.get('accuracy')) fail('An accurate GPS location is required.');
    location.accuracy = Number(url.searchParams.get('accuracy'));
  }
  validateCoordinates(location.lat, location.lng, location.accuracy);
  return location;
}

function isSecure(req, trustProxy) {
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return Boolean(req.socket.encrypted || (trustProxy && forwardedProtocol === 'https'));
}

function sameSite(req, trustProxy) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Cross-site requests are not allowed.', 403);
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail('Invalid request origin.', 403); }
    const secure = isSecure(req, trustProxy);
    let expected;
    try { expected = new URL(`${secure ? 'https' : 'http'}://${req.headers.host}`).origin; } catch { fail('Invalid request host.', 400); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== expected) fail('Cross-site requests are not allowed.', 403);
  }
}

export async function createServer({ dataFile = join(resolve(process.env.DATA_DIR || join(ROOT, '.data')), 'state.json'), testMode = false, integrations: suppliedIntegrations, now = Date.now } = {}) {
  const trustProxy = process.env.TRUST_PROXY === '1';
  const clientIPHeader = process.env.CLIENT_IP_HEADER || 'x-forwarded-for';
  if (!['x-forwarded-for', 'x-real-ip'].includes(clientIPHeader)) throw new Error('CLIENT_IP_HEADER must be x-forwarded-for or x-real-ip.');
  await mkdir(dirname(dataFile), { recursive: true });
  let stored = {};
  try { stored = JSON.parse(await readFile(dataFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let engine = createOutageEngine(stored, now);
  const integrations = suppliedIntegrations || createIntegrations({ dataDir: dirname(dataFile) });
  let saveQueue = Promise.resolve();
  let mutationQueue = Promise.resolve(), storageReady = true;
  function save(candidate = engine) {
    const snapshot = JSON.stringify(candidate.state);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try {
        const temporary = `${dataFile}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, dataFile);
        storageReady = true;
      } catch (error) {
        storageReady = false;
        throw error;
      }
    });
    return saveQueue;
  }
  function mutate(work) {
    const task = mutationQueue.catch(() => {}).then(async () => {
      // Stage updates so failed disk writes cannot create invisible reports,
      // consume a user's cooldown, or publish a chat message after returning 500.
      const candidate = createOutageEngine(structuredClone(engine.state), now);
      const result = work(candidate);
      await save(candidate);
      engine = candidate;
      return result;
    });
    mutationQueue = task;
    return task;
  }
  engine.prune();
  await save(); // Persist the random hashing salt and remove expired data before serving.
  const limits = new Map();
  const staticCache = new Map();
  function limit(key, maximum, duration) {
    const timestamp = now();
    if (limits.size > 10000) for (const [entry, value] of limits) if (value.until <= timestamp) limits.delete(entry);
    let value = limits.get(key);
    if (!value || value.until <= timestamp) {
      value = { count: 0, until: timestamp + duration };
      limits.set(key, value);
    }
    if (++value.count > maximum) fail('Too many requests. Please wait and try again.', 429);
  }

  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'POST') sameSite(req, trustProxy);
      if (path === '/api/health' && ['GET', 'HEAD'].includes(req.method)) {
        try {
          await access(dirname(dataFile), fsConstants.W_OK);
          await access(dataFile, fsConstants.R_OK);
          if (!storageReady) throw new Error('Storage is unavailable.');
          return json(res, 200, { status: 'ok' });
        } catch {
          return json(res, 503, { status: 'unavailable' });
        }
      }
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        let ip = req.socket.remoteAddress || 'unknown';
        if (trustProxy) {
          const header = String(req.headers[clientIPHeader] || '');
          const forwarded = (clientIPHeader === 'x-forwarded-for' ? header.split(',')[0] : header).trim();
          if (isIP(forwarded)) ip = forwarded;
        }
        if (testMode && isIP(String(req.headers['x-test-ip'] || ''))) ip = req.headers['x-test-ip'];
        const match = String(req.headers.cookie || '').match(/(?:^|;\s*)cg_device=([a-f0-9]{48})(?:;|$)/);
        const device = match ? match[1] : randomBytes(24).toString('hex');
        // Ping/provider calls can run concurrently during startup. Only the session
        // bootstrap and writes mint cookies, avoiding late provider responses
        // replacing a device identity already used to submit a report.
        if (!match && (path === '/api/status' || req.method === 'POST')) {
          const secure = isSecure(req, trustProxy);
          res.setHeader('Set-Cookie', `cg_device=${device}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
        }
        const actor = { ip, device };
        const identity = engine.identity(ip, device);
        limit(`all:${identity.ipHash}`, 300, 60_000);
        if (path === '/api/ping' && ['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(204);
          return res.end();
        }
        if (path === '/api/status' && req.method === 'GET') return json(res, 200, statusPayload(engine.status(locationFrom(url)), url));
        if (path === '/api/reports' && req.method === 'POST') {
          limit(`reports:ip:${identity.ipHash}`, 20, 600_000);
          limit(`reports:device:${identity.deviceHash}`, 20, 600_000);
          const body = await readJSON(req);
          // Area labels and district values submitted by clients are never used
          // to classify administrative boundaries for the daily leaderboard.
          body.district = districtFor(body.lat, body.lng);
          if (body.type === 'net') {
            const provider = await integrations.network(ip);
            body.isp = provider.available && typeof provider.isp === 'string' ? provider.isp.slice(0, 80) : undefined;
          } else delete body.isp;
          const result = await mutate(candidate => candidate.addReport(body, actor));
          return json(res, 201, { report: result.report, status: statusPayload(result.status, url) });
        }
        if (path === '/api/chat' && req.method === 'GET') return json(res, 200, engine.chat(locationFrom(url, true, true)));
        if (path === '/api/chat' && req.method === 'POST') {
          limit(`chat:ip:${identity.ipHash}`, 12, 60_000);
          limit(`chat:device:${identity.deviceHash}`, 12, 60_000);
          const body = await readJSON(req);
          const result = await mutate(candidate => candidate.addChat(body, actor));
          return json(res, 201, result);
        }
        if (path === '/api/chat/battery' && req.method === 'POST') {
          limit(`battery:ip:${identity.ipHash}`, 12, 60_000);
          limit(`battery:device:${identity.deviceHash}`, 12, 60_000);
          const body = await readJSON(req);
          const result = await mutate(candidate => candidate.updateBattery(body, actor));
          return json(res, 200, result);
        }
        if (path === '/api/network' && req.method === 'GET') {
          limit(`network:${identity.ipHash}`, 10, 60_000);
          return json(res, 200, await integrations.network(ip));
        }
        if (path === '/api/weather' && req.method === 'GET') {
          limit(`weather:${identity.ipHash}`, 15, 60_000);
          return json(res, 200, await integrations.weather(locationFrom(url, true)));
        }
        if (path === '/api/notices' && req.method === 'GET') {
          const area = url.searchParams.get('area') || '';
          if (area.length > 80 || /[\u0000-\u001f]/u.test(area)) fail('Invalid area.');
          return json(res, 200, await integrations.notices({ area }));
        }
        if (path === '/api/push/public-key' && req.method === 'GET') return json(res, 200, await integrations.publicKey());
        if (path === '/api/push/subscribe' && req.method === 'POST') {
          limit(`subscribe:${identity.deviceHash}`, 5, 60_000);
          const body = await readJSON(req);
          validateCoordinates(body.lat, body.lng);
          if (typeof body.area !== 'string' || !body.area.trim() || body.area.length > 80) fail('An area is required.');
          return json(res, 200, await integrations.subscribe(body.subscription, { lat: body.lat, lng: body.lng, area: body.area.trim(), deviceId: identity.deviceHash }));
        }
        if (path === '/api/push/unsubscribe' && req.method === 'POST') {
          const body = await readJSON(req);
          return json(res, 200, await integrations.unsubscribe({ endpoint: body.endpoint, deviceId: identity.deviceHash }));
        }
        return json(res, 404, { error: 'API endpoint not found.' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      const asset = STATIC.get(path);
      if (!asset) return json(res, 404, { error: 'Not found.' });
      let content;
      try { content = await readFile(join(ROOT, asset[0])); } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Not found.' }); throw error; }
      const encoding = acceptedEncoding(req.headers['accept-encoding']);
      if (encoding) {
        let cached = staticCache.get(asset[0]);
        if (!cached || !cached.content.equals(content)) {
          cached = { content, encoded: {} };
          staticCache.set(asset[0], cached);
        }
        if (!cached.encoded[encoding]) cached.encoded[encoding] = encoding === 'br' ? brotliAsync(content, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }) : gzipAsync(content, { level: 6 });
        content = await cached.encoded[encoding];
      }
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length, 'Vary': 'Accept-Encoding', ...(encoding ? { 'Content-Encoding': encoding } : {}), 'Cache-Control': asset[0].endsWith('.html') || asset[0] === 'service-worker.js' ? 'no-cache' : 'public, max-age=300' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = Number(error.status || error.statusCode) || 500;
      if (status >= 500) console.error('Request failed:', error.message);
      if (!res.headersSent) json(res, status, { error: status >= 500 ? 'The service is temporarily unavailable.' : error.message });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const cleanup = setInterval(() => {
    mutate(candidate => candidate.prune()).catch(error => console.error('State cleanup failed:', error.message));
  }, 60_000);
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); integrations.close?.(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await createServer();
  const port = Number(process.env.PORT || 3000);
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Choose another port, for example: PORT=${port + 1} npm start`);
    else console.error(`Could not start CurrentGiya: ${error.message}`);
    process.exitCode = 1;
    server.close();
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`CurrentGiya is listening on http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
