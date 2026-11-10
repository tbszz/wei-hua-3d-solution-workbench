// AGV route: path graph, shortest legs between stations, and a closed-form pose timeline.
// Plant units are millimetres and seconds. Poses are computed from t directly, never integrated,
// so a replay at any speed or scrub position lands on exactly the same millimetre.

const JOIN_TOLERANCE = 1; // mm
const TANGENT_TOLERANCE = (0.5 * Math.PI) / 180;

export const MOTION = {
  laneSpeed: 1000, // mm/s
  spurSpeed: 400,
  acceleration: 250, // mm/s²
  turnRate: 0.35, // rad/s
  turnAcceleration: 0.25, // rad/s²
  loadSeconds: 6,
  chargeSeconds: 5,
  settleSeconds: 1.5,
};

const TAU = Math.PI * 2;
export const normalizeAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function lineSegment(a, b) {
  return { type: 'line', a, b, length: Math.hypot(b.x - a.x, b.y - a.y) };
}

function arcSegment(a, b, bulge) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  const sweep = 4 * Math.atan(bulge);
  const offset = (chord * (1 - bulge * bulge)) / (4 * bulge);
  const center = { x: (a.x + b.x) / 2 - (dy / chord) * offset, y: (a.y + b.y) / 2 + (dx / chord) * offset };
  const radius = Math.hypot(a.x - center.x, a.y - center.y);
  return { type: 'arc', a, b, center, radius, start: Math.atan2(a.y - center.y, a.x - center.x), sweep, length: radius * Math.abs(sweep) };
}

export function pointOn(segment, s) {
  if (segment.type === 'line') {
    const f = s / segment.length;
    return {
      x: segment.a.x + (segment.b.x - segment.a.x) * f,
      y: segment.a.y + (segment.b.y - segment.a.y) * f,
      tangent: Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x),
    };
  }
  const angle = segment.start + (segment.sweep * s) / segment.length;
  return {
    x: segment.center.x + segment.radius * Math.cos(angle),
    y: segment.center.y + segment.radius * Math.sin(angle),
    tangent: angle + (Math.sign(segment.sweep) * Math.PI) / 2,
  };
}

export function polylineSegments(line) {
  const count = line.points.length;
  const segments = [];
  for (let i = 0; i < (line.closed ? count : count - 1); i++) {
    const a = line.points[i];
    const b = line.points[(i + 1) % count];
    const p = { x: a.x, y: a.y };
    const q = { x: b.x, y: b.y };
    if (Math.hypot(q.x - p.x, q.y - p.y) < JOIN_TOLERANCE) continue;
    segments.push(a.bulge ? arcSegment(p, q, a.bulge) : lineSegment(p, q));
  }
  return segments;
}

function distanceAlong(segment, point) {
  if (segment.type === 'line') {
    const dx = segment.b.x - segment.a.x;
    const dy = segment.b.y - segment.a.y;
    const s = ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / segment.length;
    const clamped = Math.max(0, Math.min(segment.length, s));
    const on = pointOn(segment, clamped);
    return { s: clamped, off: Math.hypot(on.x - point.x, on.y - point.y) };
  }
  const angle = Math.atan2(point.y - segment.center.y, point.x - segment.center.x);
  const raw = normalizeAngle((angle - segment.start) * Math.sign(segment.sweep));
  const fraction = Math.max(0, Math.min(1, (raw < -1e-9 ? raw + TAU : raw) / Math.abs(segment.sweep)));
  const s = fraction * segment.length;
  const on = pointOn(segment, s);
  return { s, off: Math.hypot(on.x - point.x, on.y - point.y) };
}

function splitSegment(segment, s, at) {
  if (segment.type === 'line') return [lineSegment(segment.a, at), lineSegment(at, segment.b)];
  const firstSweep = (segment.sweep * s) / segment.length;
  const first = { ...segment, b: at, sweep: firstSweep, length: s };
  const second = { ...segment, a: at, start: segment.start + firstSweep, sweep: segment.sweep - firstSweep, length: segment.length - s };
  return [first, second];
}

export function buildGraph(paths, stations) {
  let segments = paths.flatMap(polylineSegments);
  const joints = [...segments.flatMap((segment) => [segment.a, segment.b]), ...stations.map((station) => ({ x: station.x, y: station.y }))];
  for (const joint of joints) {
    const next = [];
    for (const segment of segments) {
      const { s, off } = distanceAlong(segment, joint);
      if (off <= JOIN_TOLERANCE && s > JOIN_TOLERANCE && segment.length - s > JOIN_TOLERANCE) next.push(...splitSegment(segment, s, joint));
      else next.push(segment);
    }
    segments = next;
  }

  const nodes = [];
  const nodeAt = (point) => {
    let index = nodes.findIndex((n) => Math.hypot(n.x - point.x, n.y - point.y) <= JOIN_TOLERANCE);
    if (index < 0) {
      index = nodes.length;
      nodes.push({ x: point.x, y: point.y, edges: [] });
    }
    return index;
  };
  segments.forEach((segment, id) => {
    const from = nodeAt(segment.a);
    const to = nodeAt(segment.b);
    nodes[from].edges.push({ id, to, segment, reversed: false });
    nodes[to].edges.push({ id, to: from, segment, reversed: true });
  });

  const stationNodes = new Map();
  for (const station of stations) {
    const index = nodes.findIndex((n) => Math.hypot(n.x - station.x, n.y - station.y) <= JOIN_TOLERANCE);
    if (index < 0) throw new Error(`工位 ${station.id} 不在 AGV 路径上（误差要求 ≤ ${JOIN_TOLERANCE} mm）`);
    stationNodes.set(station.id, index);
  }
  return { nodes, segments, stationNodes };
}

function shortestPath(graph, from, to) {
  const count = graph.nodes.length;
  const best = new Array(count).fill(Infinity);
  const previous = new Array(count).fill(null);
  const done = new Array(count).fill(false);
  best[from] = 0;
  for (let round = 0; round < count; round++) {
    let u = -1;
    for (let i = 0; i < count; i++) if (!done[i] && (u < 0 || best[i] < best[u])) u = i;
    if (u < 0 || best[u] === Infinity) break;
    done[u] = true;
    for (const edge of graph.nodes[u].edges) {
      if (best[u] + edge.segment.length < best[edge.to]) {
        best[edge.to] = best[u] + edge.segment.length;
        previous[edge.to] = { node: u, edge };
      }
    }
  }
  if (best[to] === Infinity) return null;
  const edges = [];
  for (let at = to; at !== from; at = previous[at].node) edges.unshift(previous[at].edge);
  return edges;
}

const directed = (edge) => ({
  segment: edge.segment,
  reversed: edge.reversed,
  length: edge.segment.length,
  at(s) {
    const p = pointOn(edge.segment, edge.reversed ? edge.segment.length - s : s);
    return edge.reversed ? { x: p.x, y: p.y, tangent: p.tangent + Math.PI } : p;
  },
});

function splitIntoRuns(edges) {
  const runs = [];
  for (const edge of edges.map(directed)) {
    const last = runs.at(-1)?.at(-1);
    const joined = last && Math.abs(normalizeAngle(last.at(last.length).tangent - edge.at(0).tangent)) <= TANGENT_TOLERANCE;
    if (joined) runs.at(-1).push(edge);
    else runs.push([edge]);
  }
  return runs;
}

// Displacement along a trapezoid (or triangle) profile for a move of `distance`.
function profile(distance, peak, acceleration) {
  const vmax = Math.min(peak, Math.sqrt(distance * acceleration));
  const ramp = vmax / acceleration;
  const cruise = (distance - vmax * ramp) / vmax;
  return { vmax, ramp, cruise, duration: 2 * ramp + cruise, acceleration, distance };
}

export function travelled(p, t) {
  if (t <= 0) return { s: 0, v: 0 };
  if (t >= p.duration) return { s: p.distance, v: 0 };
  if (t < p.ramp) return { s: 0.5 * p.acceleration * t * t, v: p.acceleration * t };
  if (t < p.ramp + p.cruise) return { s: 0.5 * p.vmax * p.ramp + p.vmax * (t - p.ramp), v: p.vmax };
  const left = p.duration - t;
  return { s: p.distance - 0.5 * p.acceleration * left * left, v: p.acceleration * left };
}

export function buildTimeline(plant, motion = MOTION) {
  const graph = buildGraph(plant.paths, plant.stations);
  const stops = plant.stations
    .flatMap((station) => station.order.map((order) => ({ order, station })))
    .sort((a, b) => a.order - b.order)
    .map((stop) => stop.station);
  const start = stops[0];
  const steps = [];
  let t = 0;
  let heading = start.heading;
  const push = (step) => {
    step.t0 = t;
    t += step.duration;
    step.t1 = t;
    steps.push(step);
  };
  const turnTo = (x, y, target) => {
    const delta = normalizeAngle(target - heading);
    if (Math.abs(delta) > 1e-6) {
      const p = profile(Math.abs(delta), motion.turnRate, motion.turnAcceleration);
      push({ type: 'turn', x, y, from: heading, delta, profile: p, duration: p.duration });
      heading = target;
    }
  };
  const dwell = (station, kind, duration) => push({ type: 'dwell', kind, station, x: station.x, y: station.y, heading: station.heading, duration });

  let loaded = null;
  const cargo = [];
  const stationService = (station) => {
    if (station.type === 'CHARGE') dwell(station, 'charge', motion.chargeSeconds);
    else if (station.type === 'PICK') {
      const item = { id: station.cargo || `cargo-${cargo.length}`, kind: station.cargo, from: station };
      cargo.push(item);
      item.loadStart = t;
      dwell(station, 'load', motion.loadSeconds);
      item.loadEnd = t;
      loaded = item;
    } else {
      if (!loaded) throw new Error(`流程顺序有误：到工位 ${station.id} 卸货时车上没有货`);
      loaded.to = station;
      loaded.unloadStart = t;
      dwell(station, 'unload', motion.loadSeconds);
      loaded.unloadEnd = t;
      loaded = null;
    }
  };

  stationService(start);
  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1];
    const to = stops[i];
    const edges = shortestPath(graph, graph.stationNodes.get(from.id), graph.stationNodes.get(to.id));
    if (!edges) throw new Error(`工位 ${from.id} 到 ${to.id} 没有连通路径`);
    const runs = splitIntoRuns(edges);
    runs.forEach((pieces, index) => {
      const first = pieces[0].at(0);
      const atSpurEnd = index === 0 || index === runs.length - 1;
      // Leave a dead-end spur in reverse, keeping the heading it was parked with.
      const gear = index === 0 && Math.abs(normalizeAngle(heading - (first.tangent + Math.PI))) < 0.01 ? -1 : 1;
      if (gear > 0) turnTo(first.x, first.y, first.tangent);
      const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
      const p = profile(length, atSpurEnd ? motion.spurSpeed : motion.laneSpeed, motion.acceleration);
      push({ type: 'run', pieces, length, gear, profile: p, duration: p.duration, loaded: loaded?.id ?? null });
      const end = pieces.at(-1).at(pieces.at(-1).length);
      heading = gear > 0 ? end.tangent : end.tangent + Math.PI;
    });
    // Arrive with the exact heading drawn on the plan, then let the chassis settle.
    turnTo(to.x, to.y, to.heading);
    dwell(to, 'settle', motion.settleSeconds);
    stationService(to);
  }
  return { steps, duration: t, cargo, stops, graph };
}

function findStep(timeline, t) {
  const { steps } = timeline;
  let low = 0;
  let high = steps.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (t < steps[mid].t1) high = mid;
    else low = mid + 1;
  }
  return steps[low];
}

export function poseAt(timeline, time) {
  const t = Math.max(0, Math.min(time, timeline.duration));
  const step = findStep(timeline, t);
  const local = t - step.t0;
  if (step.type === 'dwell') return { x: step.x, y: step.y, heading: step.heading, speed: 0, step, progress: local / step.duration };
  if (step.type === 'turn') {
    const { s, v } = travelled(step.profile, local);
    return { x: step.x, y: step.y, heading: step.from + Math.sign(step.delta) * s, speed: 0, turnRate: v, step, progress: local / step.duration };
  }
  const { s, v } = travelled(step.profile, local);
  let left = s;
  let piece = step.pieces[0];
  for (const candidate of step.pieces) {
    piece = candidate;
    if (left <= candidate.length) break;
    left -= candidate.length;
  }
  const p = piece.at(Math.min(left, piece.length));
  return { x: p.x, y: p.y, heading: step.gear > 0 ? p.tangent : p.tangent + Math.PI, speed: v * step.gear, step, progress: local / step.duration };
}

// Where a cargo item is at time t. lift runs 0 (resting on the deck side) to 1 (held up on the stand).
export function cargoStateAt(item, time) {
  if (time < item.loadStart) return { on: 'from', lift: 1 };
  if (time < item.loadEnd) return { on: 'from', lift: 1 - (time - item.loadStart) / (item.loadEnd - item.loadStart) };
  if (item.unloadStart === undefined || time < item.unloadStart) return { on: 'vehicle', lift: 0 };
  if (time < item.unloadEnd) return { on: 'to', lift: (time - item.unloadStart) / (item.unloadEnd - item.unloadStart) };
  return { on: 'to', lift: 1 };
}
