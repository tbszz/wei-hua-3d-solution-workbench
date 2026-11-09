import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bandFor, clampParam, mapAxis, minimumValue } from './stretch.js';

const config = JSON.parse(readFileSync(new URL('../../src/parametric/z1.config.json', import.meta.url)));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('nominal size leaves every coordinate unchanged', () => {
  const b = bandFor(config.bands.length, 5000, 5000);
  for (const v of [-2.5, -1.0, 0, 0.8, 1.21, 2.5]) close(mapAxis(b, v), v);
});

test('length change appears in full across the two ends', () => {
  const b = bandFor(config.bands.length, 5000, 6000);
  close(mapAxis(b, 2.5) - mapAxis(b, -2.5), 6);
});

test('geometry inside the inner band does not move', () => {
  const b = bandFor(config.bands.length, 5000, 7000);
  close(mapAxis(b, 0.375), 0.375);
  close(mapAxis(b, -0.79), -0.79);
});

test('the map is continuous at both band edges', () => {
  const b = bandFor(config.bands.width, 2000, 2600);
  close(mapAxis(b, 0.09), 0.09);
  close(mapAxis(b, 0.31 - 1e-12) + 1e-12 * b.scale, mapAxis(b, 0.31));
});

test('height is one-sided, so the ground stays at zero', () => {
  const b = bandFor(config.bands.height, 512.5, 700);
  close(mapAxis(b, 0), 0);
  close(mapAxis(b, 0.5125), 0.7);
});

test('configured minimums never collapse a band', () => {
  for (const key of Object.keys(config.params)) {
    const p = config.params[key];
    assert.ok(p.min > minimumValue(config.bands[key], p.nominal), `${key} min collapses its band`);
  }
});

test('clampParam snaps to step and range', () => {
  const p = config.params.length;
  assert.equal(clampParam(p, 5004), 5000);
  assert.equal(clampParam(p, 100), p.min);
  assert.equal(clampParam(p, 99999), p.max);
  assert.equal(clampParam(p, Number.NaN), p.nominal);
});
