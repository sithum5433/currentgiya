import { randomBytes, createHash } from 'node:crypto';

const MINUTE = 60_000;
const TYPES = new Set(['power', 'water', 'net', 'restored']);
export const REPORT_TTL = 120 * MINUTE;
export const RESTORE_TTL = 15 * MINUTE;
const iso = value => new Date(value).toISOString();

export function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function validateCoordinates(lat, lng, accuracy) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 5.8 || lat > 10 || lng < 79.3 || lng > 82.2) {
    fail('A location in Sri Lanka is required.');
  }
  if (accuracy !== undefined && (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 200)) {
    fail('Use a fresh GPS location accurate to 200 metres or better.');
  }
  return { lat, lng };
}

export function distanceMeters(a, b) {
  const radians = x => x * Math.PI / 180;
  const lat = radians(b.lat - a.lat);
  const lng = radians(b.lng - a.lng);
  const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

// Maximum matching prevents either a shared IP or a reused device from adding votes.
export function independentCount(reports) {
  const devices = new Map();
  for (const report of reports) {
    if (!devices.has(report.deviceHash)) devices.set(report.deviceHash, new Set());
    devices.get(report.deviceHash).add(report.ipHash);
  }
  const matched = new Map();
  function visit(device, seen) {
    for (const ip of devices.get(device)) {
      if (seen.has(ip)) continue;
      seen.add(ip);
      if (!matched.has(ip) || visit(matched.get(ip), seen)) {
        matched.set(ip, device);
        return true;
      }
    }
    return false;
  }
  let count = 0;
  for (const device of devices.keys()) if (visit(device, new Set())) count++;
  return count;
}

function verifiedWindow(reports) {
  const sorted = [...reports].sort((a, b) => a.createdAt - b.createdAt);
  for (let end = 4; end < sorted.length; end++) {
    const window = sorted.slice(0, end + 1).filter(r => r.createdAt >= sorted[end].createdAt - 3 * MINUTE);
    if (independentCount(window) >= 5) return true;
  }
  return false;
}

function publicReport(report) {
  const { id, type, lat, lng, area, district, isp, createdAt } = report;
  return { id, type, lat: Number(lat.toFixed(3)), lng: Number(lng.toFixed(3)), area, ...(district ? { district } : {}), ...(isp ? { isp } : {}), createdAt: iso(createdAt) };
}

function publicMessage(message) {
  const { id, nickname, text, battery, createdAt } = message;
  return { id, nickname, text, ...(battery !== undefined ? { battery } : {}), createdAt };
}

function groupsFor(reports, incidents = {}) {
  const groups = [];
  // Fixed anchors prevent a chain of reports from joining distant towns.
  for (const report of [...reports].sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence || a.id.localeCompare(b.id))) {
    const incident = incidents[report.zoneId];
    let group = incident ? groups.find(g => g.id === incident.id) : groups.find(g => g.type === report.type && distanceMeters(g.anchor, report) <= 1000);
    if (!group) {
      group = { id: incident?.id || report.id, type: report.type, anchor: incident?.anchor || report, reports: [] };
      groups.push(group);
    }
    group.reports.push(report);
  }
  return groups.map(group => {
    const lat = group.reports.reduce((sum, r) => sum + r.lat, 0) / group.reports.length;
    const lng = group.reports.reduce((sum, r) => sum + r.lng, 0) / group.reports.length;
    const cells = [];
    for (const report of group.reports) {
      if (!cells.some(cell => distanceMeters(cell, report) <= 100)) cells.push(report);
    }
    return {
      ...group, lat, lng, area: group.anchor.area,
      reportCount: independentCount(group.reports),
      verified: Boolean(incidents[group.id]?.verified) || verifiedWindow(group.reports),
      scope: cells.length >= 2 ? 'area' : 'street',
      firstReportedAt: incidents[group.id]?.firstReportedAt || group.reports[0].createdAt,
      lastReportedAt: Math.max(...group.reports.map(r => r.createdAt)),
      lastSequence: Math.max(...group.reports.map(r => r.sequence || 0)),
    };
  });
}

export function createOutageEngine(input = {}, now = Date.now) {
  const state = {
    version: 2, salt: input.salt || randomBytes(32).toString('hex'),
    reports: Array.isArray(input.reports) ? input.reports : [],
    resolutions: Array.isArray(input.resolutions) ? input.resolutions : [],
    chats: input.chats && typeof input.chats === 'object' ? input.chats : {},
    scores: Array.isArray(input.scores) ? input.scores.map(({ type, area, district, isp, createdAt }) => ({ type, area, ...(district ? { district } : {}), ...(isp ? { isp } : {}), createdAt })) : [],
    recentReports: Array.isArray(input.recentReports) ? input.recentReports : (input.scores || []).map(({ type, createdAt, ipHash, deviceHash }) => ({ type, createdAt, ipHash, deviceHash })),
    incidents: input.incidents && typeof input.incidents === 'object' ? input.incidents : {},
    sequence: Math.max(Number(input.sequence) || 0, ...((input.reports || []).map(r => r.sequence || 0))),
  };
  for (const report of state.reports) if (!report.sequence) report.sequence = ++state.sequence;
  const hash = value => createHash('sha256').update(`${state.salt}:${value}`).digest('hex');
  const identity = (ip, device) => ({ ipHash: hash(`ip:${ip}`), deviceHash: hash(`device:${device}`) });

  function groups(reports) {
    const result = groupsFor(reports, state.incidents);
    for (const group of result) {
      let incident = state.incidents[group.id];
      if (!incident) {
        incident = { id: group.id, type: group.type, anchor: { lat: group.anchor.lat, lng: group.anchor.lng, area: group.anchor.area }, firstReportedAt: group.firstReportedAt, verified: false };
        state.incidents[group.id] = incident;
      }
      if (group.verified) incident.verified = true;
      for (const report of group.reports) report.zoneId = group.id;
    }
    return result;
  }

  function prune() {
    const timestamp = now();
    state.reports = state.reports.filter(r => r.createdAt > timestamp - (r.type === 'restored' ? RESTORE_TTL : REPORT_TTL));
    state.resolutions = state.resolutions.filter(r => r.confirmedAt > timestamp - RESTORE_TTL);
    state.scores = state.scores.filter(r => r.createdAt > timestamp - 48 * 60 * MINUTE);
    state.recentReports = state.recentReports.filter(r => r.createdAt > timestamp - MINUTE);
    const current = groups(state.reports.filter(r => r.type !== 'restored'));
    const incidentIds = new Set(current.map(g => g.id));
    for (const id of Object.keys(state.incidents)) if (!incidentIds.has(id)) delete state.incidents[id];
    const active = new Set(current.filter(g => g.type === 'power' && g.verified).map(g => g.id));
    for (const id of Object.keys(state.chats)) if (!active.has(id)) delete state.chats[id];
  }

  function restoreVotes(group, center = group) {
    return independentCount(state.reports.filter(r => r.type === 'restored' && r.sequence > group.lastSequence && distanceMeters(center, r) <= 1000));
  }

  function applyRestorations() {
    for (const group of groups(state.reports.filter(r => r.type === 'power'))) {
      const count = restoreVotes(group);
      if (count < 3) continue;
      const ids = new Set(group.reports.map(r => r.id));
      state.reports = state.reports.filter(r => !ids.has(r.id));
      state.resolutions.push({ id: group.id, lat: group.lat, lng: group.lng, area: group.area, confirmedAt: now(), sequence: state.sequence, outageSequence: group.lastSequence, count });
      delete state.chats[group.id];
    }
  }

  function status(location) {
    prune();
    const currentGroups = groups(state.reports.filter(r => r.type !== 'restored'));
    const zones = currentGroups.map(g => ({
      id: g.id, lat: Number(g.lat.toFixed(3)), lng: Number(g.lng.toFixed(3)), area: g.area, type: g.type,
      reportCount: g.reportCount, verified: g.verified, scope: g.scope,
      firstReportedAt: iso(g.firstReportedAt), restorationCount: g.type === 'power' ? restoreVotes(g) : 0,
    }));
    // Apply distance gates before rounding public coordinates, matching chat's
    // precise 3 km boundary while keeping exact report locations private.
    const nearbyGroup = location ? currentGroups.filter(g => distanceMeters(location, g) <= 3000).sort((a, b) => distanceMeters(location, a) - distanceMeters(location, b))[0] : undefined;
    let restoration = { count: 0, restored: false };
    if (location) {
      const power = currentGroups.filter(g => g.type === 'power' && distanceMeters(location, g) <= 1000).sort((a, b) => b.lastSequence - a.lastSequence)[0];
      const resolution = state.resolutions.filter(r => distanceMeters(location, r) <= 1000).sort((a, b) => b.confirmedAt - a.confirmedAt || (b.sequence || 0) - (a.sequence || 0))[0];
      if (power && (!resolution || (resolution.sequence ? power.lastSequence > resolution.sequence : power.lastReportedAt >= resolution.confirmedAt))) restoration.count = restoreVotes(power, location);
      else if (resolution) {
        const votes = state.reports.filter(r => r.type === 'restored' && r.sequence > (resolution.outageSequence || 0) && distanceMeters(location, r) <= 1000).sort((a, b) => a.sequence - b.sequence);
        const count = independentCount(votes);
        restoration = { count, restored: count >= 3 };
        if (count >= 3) {
          const quorumVote = votes.find((vote, index) => independentCount(votes.slice(0, index + 1)) >= 3);
          restoration.confirmedAt = iso(quorumVote.createdAt);
        }
      }
    }
    const sriLankaDay = value => new Date(value + 330 * MINUTE).toISOString().slice(0, 10);
    const today = sriLankaDay(now());
    const daily = state.scores.filter(r => sriLankaDay(r.createdAt) === today);
    const rank = (list, field) => {
      const counts = new Map();
      for (const report of list) if (report[field]) counts.set(report[field], (counts.get(report[field]) || 0) + 1);
      return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5);
    };
    return {
      reports: state.reports.map(publicReport), zones,
      counts: Object.fromEntries(['power', 'water', 'net'].map(type => [type, state.reports.filter(r => r.type === type).length])),
      leaderboard: { districts: rank(daily.filter(r => r.type === 'power'), 'district'), isps: rank(daily.filter(r => r.type === 'net'), 'isp') },
      nearbyZone: nearbyGroup ? zones.find(zone => zone.id === nearbyGroup.id) : null, restoration, serverTime: iso(now()),
    };
  }

  function addReport(body, actor) {
    prune();
    if (!TYPES.has(body.type)) fail('Choose power, water, net, or restored.');
    if (body.accuracy === undefined) fail('An accurate GPS location is required.');
    validateCoordinates(body.lat, body.lng, body.accuracy);
    if (typeof body.area !== 'string' || !body.area.trim() || body.area.trim().length > 80 || /[\u0000-\u001f]/u.test(body.area)) fail('Enter an area name of 1–80 characters.');
    if (body.district !== undefined && body.district !== null && (typeof body.district !== 'string' || body.district.length > 80 || /[\u0000-\u001f]/u.test(body.district))) fail('Invalid district.');
    if (body.isp !== undefined && (typeof body.isp !== 'string' || body.isp.length > 80 || /[\u0000-\u001f]/u.test(body.isp))) fail('Invalid ISP name.');
    const person = identity(actor.ip, actor.device);
    if (state.recentReports.some(r => r.type === body.type && (r.ipHash === person.ipHash || r.deviceHash === person.deviceHash))) fail('A report from this device or network was received recently. Try again in a minute.', 429);
    const report = { id: randomBytes(10).toString('hex'), type: body.type, lat: body.lat, lng: body.lng, area: body.area.trim(), ...(body.district ? { district: body.district } : {}), ...(body.isp ? { isp: body.isp.trim() } : {}), createdAt: now(), sequence: ++state.sequence, ...person };
    state.reports.push(report);
    state.recentReports.push({ type: report.type, createdAt: report.createdAt, ...person });
    if (body.type !== 'restored') state.scores.push({ type: report.type, area: report.area, ...(report.district ? { district: report.district } : {}), ...(report.isp ? { isp: report.isp } : {}), createdAt: report.createdAt });
    applyRestorations();
    prune();
    return { report: publicReport(report), status: status(body) };
  }

  function chat(location) {
    prune();
    validateCoordinates(location.lat, location.lng, location.accuracy);
    if (location.accuracy === undefined) fail('An accurate GPS location is required.');
    const zone = groups(state.reports.filter(r => r.type === 'power')).filter(g => g.verified && distanceMeters(location, g) <= 3000).sort((a, b) => distanceMeters(location, a) - distanceMeters(location, b))[0];
    if (!zone) return { unlocked: false, zoneId: null, messages: [] };
    return { unlocked: true, zoneId: zone.id, messages: (state.chats[zone.id] || []).map(publicMessage), expiresAt: iso(Math.max(...zone.reports.map(r => r.createdAt)) + REPORT_TTL) };
  }

  function addChat(body, actor) {
    const room = chat(body);
    if (!room.unlocked) fail('Chat opens inside a verified power outage zone.', 403);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body.text)) fail('Messages must contain 1–200 characters.');
    if (body.battery !== undefined && (typeof body.battery !== 'number' || !Number.isFinite(body.battery) || body.battery < 0 || body.battery > 100)) fail('Invalid battery percentage.');
    const deviceHash = identity(actor.ip, actor.device).deviceHash;
    const messages = state.chats[room.zoneId] || [];
    const nickname = `Neighbour ${deviceHash.slice(0, 4).toUpperCase()}`;
    if (messages.some(m => m.nickname === nickname && new Date(m.createdAt).getTime() > now() - 5000)) fail('Wait a few seconds before sending another message.', 429);
    const message = { id: randomBytes(10).toString('hex'), nickname, text: body.text.trim(), ownerHash: deviceHash, ...(body.battery !== undefined ? { battery: Math.round(body.battery) } : {}), createdAt: iso(now()) };
    state.chats[room.zoneId] = [...messages, message].slice(-100);
    return { ...room, messages: state.chats[room.zoneId].map(publicMessage), message: publicMessage(message) };
  }

  function updateBattery(body, actor) {
    const room = chat(body);
    if (!room.unlocked) fail('Chat opens inside a verified power outage zone.', 403);
    if (typeof body.battery !== 'number' || !Number.isFinite(body.battery) || body.battery < 0 || body.battery > 100) fail('Invalid battery percentage.');
    const deviceHash = identity(actor.ip, actor.device).deviceHash;
    for (const message of state.chats[room.zoneId] || []) if (message.ownerHash === deviceHash) message.battery = Math.round(body.battery);
    return chat(body);
  }

  return { state, identity, status, addReport, chat, addChat, updateBattery, prune };
}
