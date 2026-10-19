import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { districtFor } from '../lib/districts.mjs';

test('bundled district geometry contains all 25 unique Sri Lankan districts', () => {
  const data = JSON.parse(readFileSync(new URL('../data/sri-lanka-districts.geojson', import.meta.url), 'utf8'));
  assert.equal(data.features.length, 25);
  assert.equal(new Set(data.features.map((feature) => feature.properties.name)).size, 25);
  assert.equal(new Set(data.features.map((feature) => feature.properties.iso)).size, 25);
  assert.ok(data.features.some((feature) => feature.geometry.type === 'MultiPolygon'), 'island components must be preserved');
});

test('district lookup identifies representative towns across all 25 districts', () => {
  const towns = [
    ['Colombo', 6.9271, 79.8612], ['Gampaha', 7.0873, 79.9990], ['Kalutara', 6.5854, 79.9607],
    ['Kandy', 7.2906, 80.6337], ['Matale', 7.4675, 80.6234], ['Nuwara Eliya', 6.9497, 80.7891],
    ['Galle', 6.0535, 80.2210], ['Matara', 5.9549, 80.5550], ['Hambantota', 6.1246, 81.1185],
    ['Jaffna', 9.6615, 80.0255], ['Kilinochchi', 9.3803, 80.3770], ['Mannar', 8.9810, 79.9044],
    ['Vavuniya', 8.7514, 80.4971], ['Mullaitivu', 9.2671, 80.8142],
    ['Batticaloa', 7.7170, 81.7000], ['Ampara', 7.2975, 81.6820], ['Trincomalee', 8.5874, 81.2152],
    ['Kurunegala', 7.4863, 80.3647], ['Puttalam', 8.0362, 79.8283],
    ['Anuradhapura', 8.3114, 80.4037], ['Polonnaruwa', 7.9403, 81.0188],
    ['Badulla', 6.9934, 81.0550], ['Monaragala', 6.8728, 81.3507],
    ['Ratnapura', 6.7056, 80.3847], ['Kegalle', 7.2513, 80.3464]
  ];
  for (const [district, lat, lng] of towns) assert.equal(districtFor(lat, lng), district, `${district} representative town must fall in its district`);
});

test('district lookup handles northern islands without assigning nearby ocean to the closest district', () => {
  assert.equal(districtFor(9.6081, 79.8194), 'Jaffna', 'Nainativu island');
  assert.equal(districtFor(9.5217, 79.6869), 'Jaffna', 'Delft island');
  assert.equal(districtFor(7.0, 79.4), null, 'Indian Ocean west of Colombo');
  assert.equal(districtFor(8.3, 82.0), null, 'Indian Ocean east of Sri Lanka');
});

test('district lookup rejects invalid numbers, reversed coordinates and locations outside Sri Lanka', () => {
  for (const point of [[0, 0], [6.9, 78], [20, 80], [79.8612, 6.9271], [NaN, 80], [7, Infinity], ['6.9', 79.8], [null, null]]) assert.equal(districtFor(...point), null);
});

test('a shared Jaffna/Kilinochchi boundary vertex is not arbitrarily assigned to one district', () => {
  assert.equal(districtFor(9.61460146583082, 80.25497692534631), null);
});
