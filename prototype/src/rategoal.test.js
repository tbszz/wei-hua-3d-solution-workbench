import test from 'node:test';
import assert from 'node:assert/strict';
import { goalLabel, rateCheck } from './rategoal.js';

const plan = { lead: 346, stations: [{ key: 'agv', name: 'AGV', cycle: 289.1, units: 1, max: 4 }, { key: 'crane', name: '行车', cycle: 177.6, units: 1, max: 1 }] };

test('3 runs a minute needs 20 s/run: AGV and crane both fall short', () => {
  const r = rateCheck(plan, { count: 3, seconds: 60 });
  assert.equal(r.need, 20);
  assert.equal(r.meets, false);
  assert.equal(r.neck, 'AGV');
  assert.deepEqual(r.rows.map((s) => s.needUnits), [15, 9]);
  assert.equal(r.fromEmpty, 0);
});

test('10 runs an hour: one AGV and the crane keep up', () => {
  const r = rateCheck(plan, { count: 10, seconds: 3600 });
  assert.equal(r.meets, true);
  assert.deepEqual(r.rows.map((s) => s.needUnits), [1, 1]);
  assert.equal(r.fromEmpty, Math.floor((3600 - 346) / 289.1) + 1);
});

test('more AGVs move the bottleneck to the crane', () => {
  const r = rateCheck({ ...plan, stations: [{ ...plan.stations[0], units: 2 }, plan.stations[1]] }, { count: 1, seconds: 150 });
  assert.equal(r.neck, '行车');
  assert.equal(r.meets, false);
});

test('labels', () => {
  assert.equal(goalLabel({ count: 3, seconds: 60 }), '每分钟 3 次');
  assert.equal(goalLabel({ count: 5, seconds: 90 }), '每 90 秒 5 次');
  assert.equal(goalLabel({ count: 3, seconds: 600 }), '每 10 分钟 3 次');
  assert.equal(goalLabel({ count: 3, seconds: 7200 }), '每 2 小时 3 次');
});
