import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { obstaclesOf, sweptClearance } from './clearance.js';
import { parseCad } from './parse-cad.js';
import { buildTimeline, cargoStateAt, normalizeAngle, poseAt, polylineSegments } from './route.js';

const plant = parseCad(readFileSync(new URL('../../../data/cad/sample-plant.dxf', import.meta.url), 'utf8'));
const timeline = buildTimeline(plant);

// Distance from a point to the drawn AGV-PATH geometry, independent of the graph's split edges.
function distanceToDrawing(x, y) {
  let best = Infinity;
  for (const segment of plant.paths.flatMap(polylineSegments)) {
    if (segment.type === 'line') {
      const dx = segment.b.x - segment.a.x;
      const dy = segment.b.y - segment.a.y;
      const f = Math.max(0, Math.min(1, ((x - segment.a.x) * dx + (y - segment.a.y) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(segment.a.x + dx * f - x, segment.a.y + dy * f - y));
    } else {
      best = Math.min(best, Math.abs(Math.hypot(x - segment.center.x, y - segment.center.y) - segment.radius));
    }
  }
  return best;
}

test('reads every layer of the sample plant', () => {
  assert.equal(plant.stations.length, 5);
  assert.deepEqual(plant.stations.find((s) => s.id === 'CHG-01').order, [0, 5]);
  assert.equal(plant.stations.find((s) => s.id === 'RM-01').cargo, 'COIL');
  assert.equal(plant.columns.length, 13 * 4);
  assert.ok(plant.racks.length > 20);
  assert.equal(plant.machines.length, 5);
  assert.equal(plant.machines[0].attrs.NAME, '数控加工中心 A');
  assert.ok(plant.paths.some((p) => p.points.some((v) => v.bulge !== 0)));
  assert.equal(plant.walls[0].width, 240);
});

test('rejects a plan that is missing a required layer', () => {
  const text = readFileSync(new URL('../../../data/cad/sample-plant.dxf', import.meta.url), 'utf8');
  assert.throws(() => parseCad(text.replaceAll('AGV-PATH', 'OTHER')), /AGV-PATH/);
});

test('the process visits stations in SEQ order and starts and ends charging', () => {
  assert.deepEqual(timeline.stops.map((s) => s.id), ['CHG-01', 'RM-01', 'CELL-01', 'CELL-02', 'FG-01', 'CHG-01']);
});

test('every station stop matches the plan to under 1 mm and 0.01 degree', () => {
  const dwells = timeline.steps.filter((s) => s.type === 'dwell');
  assert.ok(dwells.length >= 5);
  for (const step of dwells) {
    const pose = poseAt(timeline, (step.t0 + step.t1) / 2);
    assert.ok(Math.hypot(pose.x - step.station.x, pose.y - step.station.y) < 1, step.station.id);
    assert.ok(Math.abs(normalizeAngle(pose.heading - step.station.heading)) < (0.01 * Math.PI) / 180, step.station.id);
  }
});

test('the vehicle centre stays within 1 mm of the drawn path for the whole cycle', () => {
  let worst = 0;
  for (let t = 0; t <= timeline.duration; t += 0.05) {
    const pose = poseAt(timeline, t);
    worst = Math.max(worst, distanceToDrawing(pose.x, pose.y));
  }
  assert.ok(worst < 1, `deviation ${worst} mm`);
});

test('poses are continuous in position and repeat exactly', () => {
  const dt = 0.01;
  for (let t = 0; t < timeline.duration - dt; t += 0.37) {
    const a = poseAt(timeline, t);
    const b = poseAt(timeline, t + dt);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= 1000 * dt * 1.01, `jump at ${t}`);
    assert.deepEqual(poseAt(timeline, t), a);
  }
});

test('leaves a station in reverse without changing heading', () => {
  const index = timeline.steps.findIndex((s) => s.type === 'run');
  const run = timeline.steps[index];
  assert.equal(run.gear, -1);
  const start = poseAt(timeline, run.t0 + 1);
  assert.ok(Math.abs(normalizeAngle(start.heading - timeline.stops[0].heading)) < 1e-6);
});

test('cargo is lowered, carried, then lifted off', () => {
  const coil = timeline.cargo.find((c) => c.kind === 'COIL');
  assert.deepEqual(cargoStateAt(coil, coil.loadStart - 1), { on: 'from', lift: 1 });
  assert.equal(cargoStateAt(coil, (coil.loadEnd + coil.unloadStart) / 2).on, 'vehicle');
  assert.equal(coil.to.id, 'CELL-01');
  assert.deepEqual(cargoStateAt(coil, coil.unloadEnd + 1), { on: 'to', lift: 1 });
});

test('clearance reacts to vehicle size', () => {
  const obstacles = obstaclesOf(plant);
  const load = { length: 2200, width: 3300 };
  const small = sweptClearance(timeline, obstacles, { length: 2800, width: 1500 }, load);
  const wide = sweptClearance(timeline, obstacles, { length: 5000, width: 3000 }, load);
  assert.ok(small.distance > 0, JSON.stringify(small));
  assert.ok(wide.distance < small.distance);
});

test('sample plan leaves both catalog vehicles the demo clearance at standard size', () => {
  const pallet = { length: 2200, width: 3300 };
  for (const vehicle of [{ length: 2950, width: 1650 }, { length: 5000, width: 2000 }]) {
    assert.ok(sweptClearance(timeline, obstaclesOf(plant), vehicle, pallet).distance >= 500);
  }
});
