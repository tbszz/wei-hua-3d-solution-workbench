import assert from 'node:assert/strict';
import test from 'node:test';
import { surfaceDetailBrightness } from './surface-detail.js';

test('surface detail never brightens lit materials', () => {
  assert.equal(surfaceDetailBrightness(0.9, 0.9), 1);
  assert.ok(surfaceDetailBrightness(-0.9, -0.9) < 1);
});

test('floor surface detail stays within six percent', () => {
  assert.equal(surfaceDetailBrightness(0.5, 0, true), 1);
  assert.equal(surfaceDetailBrightness(-0.5, 0, true), 0.94);
});
