// Process maths with no three.js: crane three-axis motion, the five process steps, gantt blocks,
// efficiency, shift simulation and travel. Plan units are mm and seconds, like the demo's route.js.
// Every pose is computed from t directly, so a replay or a jump lands on exactly the same point.
import { travelled } from '../../demo/src/scene/route.js';

// Demo values, to be replaced by the product library's real ratings.
export const CRANE_MOTION = {
  bridge: { speed: 800, acceleration: 300 }, // mm/s, mm/s²  (48 m/min)
  trolley: { speed: 500, acceleration: 250 }, // 30 m/min
  hoist: { speed: 200, acceleration: 200 }, // 12 m/min
  clampSeconds: 3,
  releaseSeconds: 2,
  insert: 1600, // mm the C-hook arm slides along the coil axis to enter the eye
  travelHeight: 4500, // mm, hook-arm height while travelling loaded
};

export const COIL = { diameter: 1600, eye: 600, width: 1350, tonnes: 20 };

function profile(distance, peak, acceleration) {
  const vmax = Math.min(peak, Math.sqrt(distance * acceleration));
  const ramp = vmax / acceleration;
  const cruise = (distance - vmax * ramp) / vmax;
  return { vmax, ramp, cruise, duration: 2 * ramp + cruise, acceleration, distance };
}

const AXES = [['x', 'bridge'], ['y', 'trolley'], ['z', 'hoist']];

// The crane's moves for one coil: preposition beside the coil, lower, slide the arm into the eye,
// clamp, hoist, travel, lower onto the saddle, slide out, hoist, return home.
export function planCrane({ home, pick, drop, ready, motion = CRANE_MOTION }) {
  const segments = [];
  let at = { ...home };
  let t = 0;
  const move = (to, label, kind, extra = {}) => {
    const axes = {};
    let duration = 0;
    for (const [axis, key] of AXES) {
      const delta = to[axis] - at[axis];
      if (Math.abs(delta) < 1e-6) continue;
      const p = profile(Math.abs(delta), motion[key].speed, motion[key].acceleration);
      axes[axis] = { p, sign: Math.sign(delta) };
      duration = Math.max(duration, p.duration);
    }
    segments.push({ type: 'move', label, kind, from: at, to: { ...to }, axes, t0: t, duration, t1: t + duration, ...extra });
    t += duration;
    at = { ...to };
  };
  const dwell = (label, kind, duration, extra = {}) => {
    segments.push({ type: 'dwell', label, kind, from: at, to: at, axes: {}, t0: t, duration, t1: t + duration, ...extra });
    t += duration;
  };

  const travel = Math.max(motion.travelHeight, pick.z + 800, drop.z + 800);
  const beside = (p) => ({ x: p.x - motion.insert, y: p.y, z: p.z });
  move({ x: beside(pick).x, y: pick.y, z: travel }, '预定位', 'mv', { phase: 3 });
  // Hold above the hand-off point until the AGV has set the coil down.
  const prep = t;
  const startOffset = Math.max(0, ready - prep);
  move(beside(pick), '下降', 'lf', { phase: 3 });
  move({ ...pick }, '插入卷芯', 'pk', { phase: 3 });
  dwell('夹紧', 'pk', motion.clampSeconds, { phase: 3 });
  const carryStart = t;
  move({ ...pick, z: travel }, '起升', 'lf', { phase: 3, loaded: true });
  move({ x: drop.x, y: drop.y, z: travel }, '吊运', 'mv', { phase: 4, loaded: true });
  move({ ...drop }, '下降放卷', 'lf', { phase: 4, loaded: true });
  dwell('松开', 'pk', motion.releaseSeconds, { phase: 4 });
  const carryEnd = t;
  move(beside(drop), '退出卷芯', 'pk', { phase: 4 });
  move({ ...beside(drop), z: travel }, '起升复位', 'lf', { phase: 4 });
  move({ ...home }, '回待机位', 'mv', { phase: 4 });

  // Shift the whole plan so the hook starts lowering exactly when the coil is ready.
  const shift = startOffset;
  for (const s of segments) {
    s.t0 += shift;
    s.t1 += shift;
  }
  return {
    segments,
    start: shift,
    end: t + shift,
    busy: t,
    prepEnd: prep + shift,
    carryStart: carryStart + shift,
    carryEnd: carryEnd + shift,
    home: { ...home },
    pick,
    drop,
    travel,
  };
}

export function cranePoseAt(plan, time) {
  const { segments } = plan;
  if (time <= segments[0].t0) return { ...plan.home, segment: null };
  for (const s of segments) {
    if (time > s.t1) continue;
    const local = time - s.t0;
    const pose = { ...s.from, segment: s };
    for (const [axis, { p, sign }] of Object.entries(s.axes)) pose[axis] = s.from[axis] + sign * travelled(p, local).s;
    return pose;
  }
  return { ...plan.home, segment: null };
}

// Five process steps over the AGV route and the crane plan.
export function composeProcess(agv, crane, names) {
  const load = agv.steps.find((s) => s.type === 'dwell' && s.kind === 'load');
  const unload = agv.steps.find((s) => s.type === 'dwell' && s.kind === 'unload');
  const duration = Math.max(agv.duration, crane.end);
  const hoisted = crane.segments.findLast((s) => s.phase === 3).t1;
  const steps = [
    { n: 1, device: 'AGV', title: `${names.pick} 接卷`, detail: `AGV 空车前往 ${names.pick}，支架下降，钢卷落到车上`, t0: 0, t1: load.t1 },
    { n: 2, device: 'AGV', title: `${names.pick} → ${names.handoff} 运送`, detail: `AGV 载卷沿 CAD 路线驶到 ${names.handoff}，支架上升托起钢卷`, t0: load.t1, t1: unload.t1 },
    { n: 3, device: '行车', title: `${names.handoff} 夹卷起升`, detail: '行车 C 形钩下降、插入卷芯、夹紧、起升', t0: Math.min(crane.prepEnd, unload.t1), t1: hoisted },
    { n: 4, device: '行车', title: `${names.handoff} → ${names.drop} 吊运放卷`, detail: `大车、小车联动吊运到 ${names.drop}，下降放卷，退出复位`, t0: hoisted, t1: crane.end },
    { n: 5, device: 'AGV', title: `${names.handoff} → ${names.home} 空车返回`, detail: `AGV 倒出支线，回 ${names.home} 充电待命`, t0: unload.t1, t1: agv.duration },
  ];
  for (const step of steps) step.duration = step.t1 - step.t0;
  return { steps, duration, load, unload };
}

export function ganttBlocks(agv, crane, duration) {
  const agvBlocks = [];
  let loadedSeen = false;
  const push = (lane, kind, label, t0, t1) => {
    const last = lane.at(-1);
    if (last && last.kind === kind && last.label === label && Math.abs(last.t1 - t0) < 1e-6) last.t1 = t1;
    else lane.push({ kind, label, t0, t1 });
  };
  for (const s of agv.steps) {
    let kind;
    let label;
    if (s.type === 'dwell' && s.kind === 'charge') [kind, label] = ['ch', '充电'];
    else if (s.type === 'dwell' && s.kind === 'load') [kind, label, loadedSeen] = ['pk', '接卷', true];
    else if (s.type === 'dwell' && s.kind === 'unload') [kind, label] = ['pk', '放卷'];
    else if (s.type === 'run') [kind, label] = ['mv', s.loaded ? '载卷运送' : loadedSeen ? '空车返回' : '空车前往'];
    else {
      // Turns and settles belong to the move they finish.
      const last = agvBlocks.at(-1);
      if (last) {
        last.t1 = s.t1;
        continue;
      }
      [kind, label] = ['mv', '空车前往'];
    }
    push(agvBlocks, kind, label, s.t0, s.t1);
  }
  if (agv.duration < duration) agvBlocks.push({ kind: 'id', label: '空闲', t0: agv.duration, t1: duration });

  const craneBlocks = [];
  if (crane.start > 0) craneBlocks.push({ kind: 'id', label: '空闲', t0: 0, t1: crane.start });
  for (const s of crane.segments) push(craneBlocks, s.kind, s.label, s.t0, s.t1);
  if (crane.end < duration) craneBlocks.push({ kind: 'id', label: '空闲', t0: crane.end, t1: duration });
  return { agv: agvBlocks, crane: craneBlocks };
}

export function travelStats(agv, crane) {
  let loaded = 0;
  let empty = 0;
  let longest = 0;
  for (const s of agv.steps) {
    if (s.type !== 'run') continue;
    if (s.loaded) loaded += s.length;
    else empty += s.length;
    longest = Math.max(longest, s.length);
  }
  const axis = { x: 0, y: 0, z: 0 };
  const longestAxis = { x: 0, y: 0, z: 0 };
  let zMax = -Infinity;
  let zMin = Infinity;
  for (const s of crane.segments) {
    for (const k of ['x', 'y', 'z']) {
      const d = Math.abs(s.to[k] - s.from[k]);
      axis[k] += d;
      longestAxis[k] = Math.max(longestAxis[k], d);
    }
    zMax = Math.max(zMax, s.from.z, s.to.z);
    zMin = Math.min(zMin, s.from.z, s.to.z);
  }
  return { agv: { total: loaded + empty, loaded, empty, longest }, crane: { bridge: axis.x, trolley: axis.y, hoist: axis.z, longest: longestAxis, zMax, zMin } };
}

// Steady state: the hand-off stand buffers one coil, so AGVs and the crane only meet through it.
export function efficiency(agv, crane, { agvCount = 1, target = null } = {}) {
  const charge = agv.steps.filter((s) => s.type === 'dwell' && s.kind === 'charge').reduce((sum, s) => sum + s.duration, 0);
  const agvCycle = agv.duration;
  const agvTakt = agvCycle / agvCount;
  const craneCycle = crane.busy;
  const takt = Math.max(agvTakt, craneCycle);
  const bottleneck = agvTakt >= craneCycle ? 'AGV' : '行车';
  const result = {
    agvCount,
    agvCycle,
    craneCycle,
    takt,
    perHour: 3600 / takt,
    bottleneck,
    utilization: { agv: (agvCycle - charge) / (agvCount * takt), crane: craneCycle / takt },
    target,
  };
  if (target) {
    result.meets = takt <= target + 1e-9;
    result.gap = takt - target;
    if (!result.meets) {
      if (bottleneck === 'AGV') {
        const needed = Math.ceil(agvCycle / target);
        const withOne = Math.max(agvCycle / (agvCount + 1), craneCycle);
        result.advice = craneCycle <= target
          ? `AGV 是瓶颈：需要 ${needed} 台 AGV（再加 ${needed - agvCount} 台），节拍可到 ${Math.max(agvCycle / needed, craneCycle).toFixed(0)} s`
          : `AGV 是瓶颈：再加 1 台节拍到 ${withOne.toFixed(0)} s，但行车单循环 ${craneCycle.toFixed(0)} s 已超目标，需同时提速行车或加第二台`;
      } else {
        result.advice = `行车是瓶颈：单循环 ${craneCycle.toFixed(0)} s，要压到 ${target} s 需提高起升 / 运行速度约 ${Math.ceil((craneCycle / target - 1) * 100)}%，或加第二台行车`;
      }
    }
  }
  return result;
}

// Deterministic shift: the first coil takes one full cycle, then one per takt.
export function simulateShift(eff, firstCycle, hours) {
  const seconds = hours * 3600;
  const pieces = seconds < firstCycle ? 0 : Math.floor((seconds - firstCycle) / eff.takt + 1e-9) + 1;
  return {
    hours,
    pieces,
    perHour: pieces / hours,
    busyHours: { agv: Math.min(1, eff.utilization.agv) * hours, crane: Math.min(1, eff.utilization.crane) * hours },
  };
}

export const fmtTime = (s) => {
  const v = Math.max(0, Math.round(s));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
