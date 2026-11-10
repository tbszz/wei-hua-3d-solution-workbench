// The AGV + crane process laid out inside a plant built from a drawing. No three.js here.
// The drawing gives the bays, runway beams, columns and machines; this picks one bay and draws an
// AGV loop in it, with four points the process needs:
//   CHG-01 charger (west spur) → RM-01 raw-coil stand (east spur) → H-01 hand-off stand (north spur,
//   under the crane) → back to CHG-01; the bay's crane takes the coil from H-01 to FG-01 on the floor.
// Plant units are mm. U runs along the runway, V across it (the same frame as inferPlant).

const SPUR = 4500; // mm from the lane to a stand
const RAIL_GAP = 1650; // stand rails either side of the AGV centre line
const CHARGER_AHEAD = 3300;
const CLEAR = 2200; // mm between the route and a machine outline

// Quarter-arc bulge, signed by the turn direction in drawing coordinates (CCW positive).
const QUARTER = Math.tan(Math.PI / 8);

function roundedLoop(corners, radius) {
  const n = corners.length;
  const points = [];
  for (let i = 0; i < n; i++) {
    const p = corners[i];
    const a = corners[(i + n - 1) % n];
    const b = corners[(i + 1) % n];
    const d1 = norm({ x: p.x - a.x, y: p.y - a.y });
    const d2 = norm({ x: b.x - p.x, y: b.y - p.y });
    const turn = Math.sign(d1.x * d2.y - d1.y * d2.x);
    points.push({ x: p.x - d1.x * radius, y: p.y - d1.y * radius, bulge: turn * QUARTER });
    points.push({ x: p.x + d2.x * radius, y: p.y + d2.y * radius, bulge: 0 });
  }
  return { points, closed: true, width: 0 };
}

function norm(v) {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

function pointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - dx * k, p.y - a.y - dy * k);
}

// Stand: two rails along the heading, either side of the AGV (same block as the CAD's AGV_STAND).
function stand(id, type, at, heading) {
  const nx = -Math.sin(heading);
  const ny = Math.cos(heading);
  const rects = [-1, 1].map((s) => ({ x: at.x + nx * RAIL_GAP * s, y: at.y + ny * RAIL_GAP * s, w: 3000, d: 300, heading }));
  return { block: 'AGV_STAND', id, type, cargo: type === 'PICK' ? 'COIL' : '', x: at.x, y: at.y, heading, rects, order: [], attrs: { ID: id, TYPE: type } };
}

function charger(id, at, heading) {
  const rect = { x: at.x + Math.cos(heading) * CHARGER_AHEAD, y: at.y + Math.sin(heading) * CHARGER_AHEAD, w: 500, d: 1200, heading };
  return { block: 'AGV_CHARGE', id, type: 'CHARGE', cargo: '', x: at.x, y: at.y, heading, rects: [rect], order: [], attrs: { ID: id, TYPE: 'CHARGE' } };
}

// One candidate layout in a bay, starting `start` mm along the runway.
function layout({ bay, ra, rb, u0, u1, start, alongX }) {
  const XY = (u, v) => (alongX ? { x: u, y: v } : { x: v, y: u });
  const headU = alongX ? 0 : Math.PI / 2; // heading of +U in drawing coordinates
  const headV = alongX ? Math.PI / 2 : 0;
  const W = rb - ra;
  const L = u1 - u0;
  const cover = rb - 3000; // the hook reaches up to here across the bay
  let vLow = ra + Math.max(3000, W * 0.2);
  let vHigh = vLow + Math.max(6000, Math.min(9000, W * 0.3));
  if (vHigh + SPUR > cover) {
    vHigh = cover - SPUR;
    vLow = Math.min(vLow, vHigh - 4000);
  }
  if (vLow < ra + 2500) throw new Error(`${bay.name} 跨净宽 ${(W / 1000).toFixed(1)} m，放不下 AGV 环线和吊装交接点`);
  const vMid = (vLow + vHigh) / 2;
  const length = Math.max(26000, Math.min(40000, L * 0.3));
  const uS = u0 + start;
  const uE = uS + length;
  if (uE + SPUR + 6000 > u1 - 2000) throw new Error('放不下');
  const uH = uS + length * 0.45;
  const vH = vHigh + SPUR;
  const uD = Math.min(uH + Math.max(14000, length * 0.4), u1 - 6000);
  const vD = Math.min(vH + 2500, cover);

  const radius = Math.min(3000, (vHigh - vLow) / 2 - 200);
  const loop = roundedLoop([XY(uS, vLow), XY(uE, vLow), XY(uE, vHigh), XY(uS, vHigh)], radius);
  const line = (a, b) => ({ points: [{ ...a, bulge: 0 }, { ...b, bulge: 0 }], closed: false, width: 0 });
  const chg = XY(uS - SPUR, vMid);
  const rm = XY(uE + SPUR, vMid);
  const ho = XY(uH, vH);
  const paths = [loop, line(XY(uS, vMid), chg), line(XY(uE, vMid), rm), line(XY(uH, vHigh), ho)];
  const stations = [charger('CHG-01', chg, headU + Math.PI), stand('RM-01', 'PICK', rm, headU), stand('H-01', 'DROP', ho, headV)];
  stations[0].order = [0, 3];
  stations[1].order = [1];
  stations[2].order = [2];
  const drop = XY(uD, vD);
  // Everything the AGV sweeps, plus the floor saddle, for the machine check.
  const sweep = [
    [XY(uS, vLow), XY(uE, vLow)], [XY(uE, vLow), XY(uE, vHigh)], [XY(uE, vHigh), XY(uS, vHigh)], [XY(uS, vHigh), XY(uS, vLow)],
    [XY(uS, vMid), XY(uS - SPUR - CHARGER_AHEAD, vMid)], [XY(uE, vMid), XY(uE + SPUR + 1500, vMid)], [XY(uH, vHigh), XY(uH, vH + 1500)], [drop, drop],
  ];
  const points = {
    home: { id: 'CHG-01', name: '充电位', role: 'charge', ...chg },
    pick: { id: 'RM-01', name: '原料上料位', role: 'pick', ...rm },
    handoff: { id: 'H-01', name: '吊装交接点', role: 'handoff', ...ho },
    drop: { id: 'FG-01', name: '成品区', role: 'drop', ...drop },
  };
  // Crane plan frame: x along the runway, y across it. When the runway runs along drawing Y the
  // crane model is turned 90° and y is the negated drawing x, so the frame stays right-handed.
  const s = alongX ? 1 : -1;
  const toPlan = (p) => ({ x: alongX ? p.x : p.y, y: alongX ? p.y : -p.x });
  const crane = {
    rotation: alongX ? 0 : Math.PI / 2,
    railLow: ra * s,
    railHigh: rb * s,
    home: { x: Math.max(uH - 12000, u0 + 5000), y: ((ra + rb) / 2) * s, z: 7000 },
    pick: toPlan(ho),
    drop: toPlan(drop),
  };
  return { bay, ra, rb, u0, u1, alongX, paths, stations, points, crane, sweep, loopLength: length };
}

function conflicts(plan, machines) {
  let n = 0;
  for (const m of machines) {
    const r = Math.max(...m.rects.map((x) => Math.hypot(x.w, x.d) / 2), 1000) + CLEAR;
    if (plan.sweep.some(([a, b]) => pointToSegment(m, a, b) < r)) n++;
  }
  return n;
}

// Pick the bay and position along it with no machine in the way (middle bays first).
export function planSceneFlow({ plant, bays, alongX, prefer = null }) {
  if (!bays?.length) throw new Error('图纸里没有识别出行车跨（两排柱子之间 9–40 m），没法排 AGV + 行车工序');
  const V = (p) => (alongX ? p.y : p.x);
  const U = (p) => (alongX ? p.x : p.y);
  const mid = (bays.length - 1) / 2;
  const order = [...bays].sort((a, b) => Math.abs(bays.indexOf(a) - mid) - Math.abs(bays.indexOf(b) - mid));
  if (prefer) {
    const want = bays.find((b) => b.name === String(prefer).toUpperCase().replace(/跨$/, ''));
    if (!want) throw new Error(`没有 ${prefer} 跨，可选：${bays.map((b) => `${b.name} 跨`).join('、')}`);
    order.splice(order.indexOf(want), 1);
    order.unshift(want);
  }
  let best = null;
  let lastError = null;
  for (const bay of prefer ? order.slice(0, 1) : order) {
    const rails = plant.beams.filter((b) => V(b.points[0]) > bay.from && V(b.points[0]) < bay.to).map((b) => V(b.points[0])).sort((a, b) => a - b);
    const beams = plant.beams.filter((b) => V(b.points[0]) > bay.from && V(b.points[0]) < bay.to);
    if (rails.length < 2) continue;
    const ra = rails[0];
    const rb = rails.at(-1);
    const us = beams.flatMap((b) => b.points.map(U));
    const u0 = Math.min(...us);
    const u1 = Math.max(...us);
    const L = u1 - u0;
    for (const f of [0.08, 0.3, 0.5, 0.2, 0.4]) {
      let plan;
      try {
        plan = layout({ bay, ra, rb, u0, u1, start: Math.max(12000, L * f), alongX });
      } catch (error) {
        lastError = error;
        continue;
      }
      const hits = conflicts(plan, plant.machines ?? []);
      if (!best || hits < best.hits) best = { plan, hits };
      if (hits === 0) return plan;
    }
  }
  if (best) return { ...best.plan, machineConflicts: best.hits };
  throw new Error(lastError?.message ?? '没有找到能放下 AGV 环线的跨');
}
