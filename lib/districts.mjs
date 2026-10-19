import { readFileSync } from 'node:fs';

// Pinned, locally bundled geoBoundaries ADM2 polygons. No runtime geocoding request.
// Source, simplification limitations and attribution: ../data/README.md.
const collection = JSON.parse(readFileSync(new URL('../data/sri-lanka-districts.geojson', import.meta.url), 'utf8'));
const EPSILON = 1e-10;

function boundsFor(ring) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng); minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng); maxLat = Math.max(maxLat, lat);
  }
  return [minLng, minLat, maxLng, maxLat];
}

const districts = collection.features.map((feature) => {
  const geometry = feature.geometry;
  if (!['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error('District boundary data contains an unsupported geometry.');
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return { name: feature.properties.name, polygons: polygons.map((rings) => ({ rings, bounds: boundsFor(rings[0]) })) };
});
if (districts.length !== 25 || new Set(districts.map((district) => district.name)).size !== 25) throw new Error('Expected 25 unique Sri Lankan districts.');

// Returns -1 outside, 0 on the ring, and 1 inside. Ray casting also handles concave rings.
function ringPosition(lng, lat, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [ax, ay] = ring[previous], [bx, by] = ring[index];
    const dx = bx - ax, dy = by - ay;
    const within = lng >= Math.min(ax, bx) - EPSILON && lng <= Math.max(ax, bx) + EPSILON &&
      lat >= Math.min(ay, by) - EPSILON && lat <= Math.max(ay, by) + EPSILON;
    if (within && Math.abs((lng - ax) * dy - (lat - ay) * dx) <= EPSILON * Math.max(Math.abs(dx), Math.abs(dy), EPSILON)) return 0;
    if ((ay > lat) !== (by > lat) && lng < (bx - ax) * (lat - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 1 : -1;
}

function contains(lng, lat, polygon) {
  const [minLng, minLat, maxLng, maxLat] = polygon.bounds;
  if (lng < minLng - EPSILON || lng > maxLng + EPSILON || lat < minLat - EPSILON || lat > maxLat + EPSILON) return false;
  if (ringPosition(lng, lat, polygon.rings[0]) < 0) return false;
  return !polygon.rings.slice(1).some((hole) => ringPosition(lng, lat, hole) > 0);
}

/** Return the containing district name, or null offshore, outside coverage, or on an ambiguous shared border. */
export function districtFor(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let match = null;
  for (const district of districts) {
    if (!district.polygons.some((polygon) => contains(lng, lat, polygon))) continue;
    if (match !== null && match !== district.name) return null;
    match = district.name;
  }
  return match;
}
