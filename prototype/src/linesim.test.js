import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLine, replicate, statesAt, validateLine } from './linesim.js';

test('a deterministic line runs at the pace of its slowest station', () => {
  const r = simulateLine({ hours: 8, stations: [{ name: '上料', cycle_s: 60, cv: 0 }, { name: '焊接', cycle_s: 90, cv: 0 }, { name: '下料', cycle_s: 45, cv: 0 }] });
  assert.ok(Math.abs(r.throughputPerHour - 40) < 0.5, `got ${r.throughputPerHour}`);
  assert.equal(r.bottleneck.name, '焊接');
  assert.ok(r.stations[1].utilization > 0.98);
  assert.ok(r.stations[0].blocked > 0.2, 'the fast first station waits on the bottleneck');
});

test('parallel machines add capacity', () => {
  const r = simulateLine({ hours: 4, stations: [{ cycle_s: 30, cv: 0 }, { cycle_s: 120, cv: 0, servers: 2 }] });
  assert.ok(Math.abs(r.throughputPerHour - 60) < 1, `got ${r.throughputPerHour}`);
});

test('variability, small buffers and breakdowns lose output; seeds make it reproducible', () => {
  const base = { hours: 24, stations: [{ cycle_s: 60, cv: 0.4, buffer: 1 }, { cycle_s: 60, cv: 0.4, buffer: 1, mtbf_min: 120, mttr_min: 15 }, { cycle_s: 60, cv: 0.4, buffer: 1 }] };
  const a = simulateLine(base);
  const b = simulateLine(base);
  assert.equal(a.output, b.output);
  assert.ok(a.throughputPerHour < 55, `got ${a.throughputPerHour}`);
  assert.ok(a.stations[1].down > 0.03);
  const roomy = simulateLine({ ...base, stations: base.stations.map((s) => ({ ...s, buffer: 20 })) });
  assert.ok(roomy.throughputPerHour > a.throughputPerHour);
  const rep = replicate(base, 3);
  assert.ok(rep.throughput.min <= rep.throughput.mean && rep.throughput.mean <= rep.throughput.max);
});

test('timed arrivals cap the output and the trace replays states', () => {
  const r = simulateLine({ hours: 2, arrival_s: 120, stations: [{ cycle_s: 60, cv: 0 }] });
  assert.ok(Math.abs(r.throughputPerHour - 30) < 1);
  const s = statesAt(r, 30);
  assert.equal(s[0], 1); // busy on the first part
  assert.deepEqual(validateLine({ stations: [] }).length, 1);
});
