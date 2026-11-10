import test from 'node:test';
import assert from 'node:assert/strict';
import { profileFromSite, resolveParams } from './cad/index.js';

test('resolveParams fills defaults and rejects out-of-range values', () => {
  const params = resolveParams('saddle_v', { length: '1600' });
  assert.equal(params.length, 1600);
  assert.equal(params.groove_angle, 90);
  assert.throws(() => resolveParams('saddle_v', { height: 5000 }), /超出范围/);
  assert.throws(() => resolveParams('saddle_v', { colour: 1 }), /没有参数/);
  assert.throws(() => resolveParams('nope', {}), /不认识的零件模板/);
  assert.equal(resolveParams('rack', { bays: 2.6 }).bays, 3);
});

test('profileFromSite chains loose lines into the outline and keeps inner loops as holes', () => {
  const pts = [[0, 0], [1300, 0], [1300, 480], [0, 480]];
  const lines = pts.map((p, i) => ({ layer: 'x', closed: false, points: [{ x: p[0], y: p[1] }, { x: pts[(i + 1) % 4][0], y: pts[(i + 1) % 4][1] }] }));
  const hole = { layer: 'x', closed: true, points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }] };
  const out = profileFromSite({ units: 'mm', bbox: { minX: 0, minY: 0, maxX: 1300, maxY: 480 }, lines: [...lines, hole] });
  assert.deepEqual(out.sizeMm, [1300, 480]);
  assert.equal(out.holes.length, 1);
  assert.deepEqual(out.points[0], [-650, 0]);
});
