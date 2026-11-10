import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, STAGES, ZONES } from './dashboard-data.js';

const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

test('the same seed and steps give the same board; another seed differs', () => {
  const a = createSim(7);
  const b = createSim(7);
  for (let i = 0; i < 120; i++) {
    a.step(60);
    b.step(60);
  }
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
  const c = createSim(8);
  c.step(120 * 60);
  assert.notEqual(JSON.stringify(a.snapshot().coils), JSON.stringify(c.snapshot().coils));
});

test('splitting a step into smaller ones does not change the result', () => {
  const a = createSim(3);
  const b = createSim(3);
  a.step(3600);
  for (let i = 0; i < 360; i++) b.step(10);
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
});

test('every coil walks the route in order with non-decreasing timestamps', () => {
  const sim = createSim(11);
  sim.step(14 * 3600);
  const coils = sim.coils();
  assert.ok(coils.length > 80, `expected a busy plant, got ${coils.length} coils`);
  for (const coil of coils) {
    assert.ok(/^GJ\d{10}$/.test(coil.id), coil.id);
    let prev = null;
    for (const [i, e] of coil.log.entries()) {
      assert.equal(e.key, STAGES[i].key, `${coil.id} stage ${i} out of order`);
      if (e.end != null) assert.ok(e.end >= e.start, `${coil.id} ${e.key} ends before it starts`);
      if (prev) assert.equal(e.start, prev.end, `${coil.id} ${e.key} does not start where ${prev.key} ended`);
      prev = e;
    }
    // Only the last entry may still be open, and only for a coil still in the plant.
    assert.ok(coil.log.slice(0, -1).every((e) => e.end != null));
    if (coil.status === 'active') assert.equal(coil.log.at(-1).end, null);
    assert.equal(coil.log.length - 1, coil.stage);
  }
  // A furnace line is chosen for every coil that has gone into a furnace.
  for (const coil of coils.filter((c) => c.stage > STAGE_INDEX.agv_feed)) assert.ok(['L1', 'L2'].includes(coil.line));
});

test('coils and weight are conserved; no zone ever exceeds its capacity', () => {
  const sim = createSim(5);
  for (let i = 0; i < 24 * 6; i++) {
    sim.step(600);
    const snap = sim.snapshot();
    const { created, shipped, count } = sim.stats();
    const coils = sim.coils().filter((c) => c.status === 'active');
    assert.equal(coils.length + shipped, created);
    const inTransit = coils.filter((c) => c.location.startsWith('dev:')).length;
    const inZones = Object.values(count).reduce((a, b) => a + b, 0);
    assert.equal(inZones + inTransit, coils.length);
    for (const z of snap.inventory) {
      const here = coils.filter((c) => c.location === z.id);
      assert.equal(z.count, here.length, `${z.name} count`);
      assert.ok(Math.abs(z.weight - here.reduce((s, c) => s + c.weight, 0)) < 0.2, `${z.name} weight`);
      if (z.cap != null) assert.ok(z.count + z.incoming <= z.cap, `${z.name} over capacity ${z.count}+${z.incoming}/${z.cap}`);
    }
    // Each device carries at most one coil, and every coil in transit sits on a busy device.
    for (const c of coils.filter((x) => x.location.startsWith('dev:'))) {
      const dev = snap.equipment.find((e) => `dev:${e.id}` === c.location);
      assert.equal(dev.task?.coil, c.id);
    }
  }
  const zoneIds = new Set(ZONES.map((z) => z.id));
  for (const c of sim.coils()) assert.ok(c.location === 'shipped' || c.location.startsWith('dev:') || zoneIds.has(c.location));
});

test('a stage that runs past its standard time raises a timeout alarm, cleared when it ends', () => {
  // A 1-minute standard for the furnace: every furnace run overruns it.
  const sim = createSim(9, { std: { furnace: 1 } });
  const snap = sim.snapshot();
  const furnace = snap.alarms.filter((a) => a.stage === 'furnace');
  assert.ok(furnace.length > 5, 'furnace timeouts expected');
  assert.ok(furnace.every((a) => a.type === '工艺加工超时' && a.target.kind === 'coil'));
  assert.ok(furnace.some((a) => !a.active && a.end != null), 'finished runs clear their alarm');
  for (const a of furnace.filter((x) => x.active)) {
    const coil = snap.coils.find((c) => c.id === a.target.id);
    assert.equal(coil.stage, 'furnace');
  }
  const node = snap.nodes.find((n) => n.key === 'furnace');
  assert.equal(node.std, 1);
  assert.equal(node.overCount, node.count);
});

test('within the standard time no timeout alarm is raised for that stage', () => {
  const sim = createSim(9, { std: { furnace: 600 } });
  assert.equal(sim.snapshot().alarms.filter((a) => a.stage === 'furnace').length, 0);
});

test('snapshot carries what the board needs', () => {
  const sim = createSim(1);
  const s = sim.snapshot();
  assert.match(s.clock, /^\d\d:\d\d:\d\d$/);
  assert.equal(s.lines.length, 2);
  assert.ok(s.lines.every((l) => l.hourly.length === 12 && l.done > 0));
  assert.equal(s.equipment.length, 6);
  assert.ok(s.equipment.every((e) => ['运行', '空闲', '充电', '故障'].includes(e.status)));
  assert.ok(s.kpis.rawIn.count > 0 && s.kpis.fgIn.count > 0);
  assert.equal(s.nodes.length, STAGES.length);
  const id = s.coils.find((c) => c.stage === 'furnace')?.id ?? s.coils[0].id;
  const ledger = sim.ledger(id.toLowerCase());
  assert.equal(ledger.id, id);
  assert.equal(ledger.rows.length, STAGES.length);
  assert.ok(ledger.rows.some((r) => r.state === 'now'));
  assert.equal(sim.ledger('GJ0000000000'), null);
  assert.ok(sim.findCoils(id.slice(-5)).includes(id));
});
