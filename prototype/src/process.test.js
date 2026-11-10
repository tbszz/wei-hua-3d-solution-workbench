import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseCad } from '../../demo/src/scene/parse-cad.js';
import { buildTimeline } from '../../demo/src/scene/route.js';
import { composeProcess, cranePoseAt, efficiency, ganttBlocks, planCrane, simulateShift, travelStats } from './process.js';

const plan = () => planCrane({ home: { x: 30000, y: 35925, z: 7000 }, pick: { x: 44000, y: 33000, z: 1510 }, drop: { x: 66000, y: 35500, z: 950 }, ready: 120 });

test('crane axes land on every target within 1 mm', () => {
  const p = plan();
  for (const s of p.segments) {
    const at = cranePoseAt(p, s.t1);
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(at[k] - s.to[k]) < 1, `${s.label} ${k}`);
  }
  assert.ok(Math.abs(p.segments[1].t0 - 120) < 1e-9, 'lowering starts when the coil is ready');
});

test('crane pose is continuous', () => {
  const p = plan();
  let prev = cranePoseAt(p, 0);
  for (let t = 0.05; t < p.end + 1; t += 0.05) {
    const now = cranePoseAt(p, t);
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(now[k] - prev[k]) < 60, `jump at ${t} on ${k}`);
    prev = now;
  }
});

function sampleTimeline() {
  const plant = parseCad(fs.readFileSync(new URL('../../data/cad/sample-plant.dxf', import.meta.url), 'utf8'));
  const tpl = plant.stations.find((s) => s.id === 'CELL-01');
  plant.paths.push({ points: [{ x: 44000, y: 26000 }, { x: 44000, y: 33000 }], closed: false });
  plant.stations = plant.stations.map((s) => ({ ...s, order: [] }));
  plant.stations.push({ ...tpl, id: 'H-01', type: 'DROP', x: 44000, y: 33000, order: [2] });
  plant.stations.find((s) => s.id === 'CHG-01').order = [0, 3];
  plant.stations.find((s) => s.id === 'RM-01').order = [1];
  return buildTimeline(plant);
}

test('process, efficiency, shift and travel agree with the timelines', () => {
  const agv = sampleTimeline();
  const unload = agv.steps.find((s) => s.kind === 'unload');
  const crane = planCrane({ home: { x: 30000, y: 35925, z: 7000 }, pick: { x: 44000, y: 33000, z: 1510 }, drop: { x: 66000, y: 35500, z: 950 }, ready: unload.t1 });
  const proc = composeProcess(agv, crane, { pick: 'RM-01', handoff: 'H-01', drop: 'FG-A', home: 'CHG-01' });
  assert.equal(proc.steps.length, 5);
  assert.ok(Math.abs(proc.duration - Math.max(agv.duration, crane.end)) < 0.1);
  for (const s of proc.steps) assert.ok(s.duration > 0, `step ${s.n}`);
  const g = ganttBlocks(agv, crane, proc.duration);
  assert.ok(Math.abs(g.agv.at(-1).t1 - proc.duration) < 1e-6);
  assert.ok(Math.abs(g.crane.at(-1).t1 - proc.duration) < 1e-6);
  const eff = efficiency(agv, crane, { agvCount: 1, target: 90 });
  assert.ok(Math.abs(eff.takt - Math.max(agv.duration, crane.busy)) < 0.1);
  assert.equal(eff.meets, false);
  assert.ok(eff.advice);
  const two = efficiency(agv, crane, { agvCount: 2 });
  assert.ok(two.takt <= eff.takt);
  const a = simulateShift(eff, proc.duration, 8);
  assert.deepEqual(a, simulateShift(eff, proc.duration, 8));
  assert.ok(a.pieces > 0);
  const tr = travelStats(agv, crane);
  const runs = agv.steps.filter((s) => s.type === 'run').reduce((sum, s) => sum + s.length, 0);
  assert.ok(Math.abs(tr.agv.total - runs) < 1);
  console.log({ agv: agv.duration.toFixed(1), crane: crane.busy.toFixed(1), takt: eff.takt.toFixed(1), steps: proc.steps.map((s) => s.duration.toFixed(1)), shift: a.pieces, travel: (tr.agv.total / 1000).toFixed(1) });
});
