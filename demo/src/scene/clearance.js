// Minimum clearance of the AGV (and its load) along the whole timeline. Millimetres.
import { poseAt } from './route.js';

const STEP_SECONDS = 0.1;

function corners(x, y, heading, halfL, halfW) {
  const [c, s] = [Math.cos(heading), Math.sin(heading)];
  return [[halfL, halfW], [halfL, -halfW], [-halfL, -halfW], [-halfL, halfW]].map(([u, v]) => ({ x: x + u * c - v * s, y: y + u * s + v * c }));
}

function segmentDistanceToPoint(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
}

function overlaps(p, q) {
  for (const poly of [p, q]) {
    for (let i = 0; i < 4; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % 4];
      const [nx, ny] = [b.y - a.y, a.x - b.x];
      const project = (pts) => pts.map((v) => v.x * nx + v.y * ny);
      if (Math.max(...project(p)) < Math.min(...project(q)) || Math.max(...project(q)) < Math.min(...project(p))) return false;
    }
  }
  return true;
}

export function rectangleDistance(p, q) {
  if (overlaps(p, q)) return 0;
  let best = Infinity;
  for (const [from, to] of [[p, q], [q, p]]) {
    for (let i = 0; i < 4; i++) {
      for (const point of to) best = Math.min(best, segmentDistanceToPoint(from[i], from[(i + 1) % 4], point));
    }
  }
  return best;
}

export function obstaclesOf(plant) {
  const named = (items, label) => items.flatMap((item) => item.rects.map((r) => ({
    ...r, half: Math.hypot(r.w, r.d) / 2, label: label(item), isStand: item.block === 'AGV_STAND',
    poly: corners(r.x, r.y, r.heading, r.w / 2, r.d / 2),
  })));
  return [
    ...named(plant.columns, () => '立柱'),
    ...named(plant.racks, () => '货架'),
    ...named(plant.machines, (m) => m.attrs.NAME ?? '设备'),
    ...named(plant.conveyors, (m) => m.attrs.NAME ?? '输送线'),
    ...named(plant.stations, (s) => `工位 ${s.id}`),
  ];
}

// vehicle: { length, width } in mm; load: { length, width } of the loaded pallet.
export function sweptClearance(timeline, obstacles, vehicle, load) {
  const vehicleRadius = Math.hypot(vehicle.length, vehicle.width) / 2;
  const loadRadius = Math.hypot(load.length, load.width) / 2;
  let worst = { distance: Infinity, label: '', x: 0, y: 0 };
  const check = (poly, radius, x, y, skipStands) => {
    for (const obstacle of obstacles) {
      if (skipStands && obstacle.isStand) continue;
      const centreGap = Math.hypot(obstacle.x - x, obstacle.y - y) - radius - obstacle.half;
      if (centreGap >= worst.distance) continue;
      const distance = rectangleDistance(poly, obstacle.poly);
      if (distance < worst.distance) worst = { distance, label: obstacle.label, x, y };
    }
  };
  for (let t = 0; t <= timeline.duration; t += STEP_SECONDS) {
    const pose = poseAt(timeline, t);
    check(corners(pose.x, pose.y, pose.heading, vehicle.length / 2, vehicle.width / 2), vehicleRadius, pose.x, pose.y, false);
    // The pallet rides above the stand rails, so only other obstacles can hit it.
    if (pose.step.loaded) check(corners(pose.x, pose.y, pose.heading, load.length / 2, load.width / 2), loadRadius, pose.x, pose.y, true);
  }
  return worst;
}
