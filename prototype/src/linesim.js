// Discrete-event simulation of a serial production line with finite buffers.
// Pure and seeded: the same input always gives the same result, so a number in a proposal
// can be reproduced. Times in seconds.
//
// station: { id, name, cycle_s, cv (0–0.6 spread of cycle time), servers (parallel machines),
//            buffer (parts that can wait in front of it; first station: from the source),
//            mtbf_min / mttr_min (random breakdowns, optional), setup_s (optional, every batch) }
// Blocking after service: a machine that finished but finds no room downstream holds the part.

const STATES = ['idle', 'busy', 'blocked', 'down'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Log-normal around the mean with coefficient of variation cv (cv 0 -> exactly the mean).
function sampler(random) {
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    let v = 0;
    while (u === 0) u = random();
    while (v === 0) v = random();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return {
    cycle(mean, cv) {
      if (!cv) return mean;
      const s2 = Math.log(1 + cv * cv);
      return mean * Math.exp(normal() * Math.sqrt(s2) - s2 / 2);
    },
    exp(mean) {
      return -Math.log(1 - random()) * mean;
    },
  };
}

class Heap {
  constructor() { this.a = []; this.n = 0; }
  push(e) {
    e.seq = this.n++;
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[p], a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
  static less(x, y) { return x.t < y.t || (x.t === y.t && x.seq < y.seq); }
}

export function validateLine(input) {
  const errors = [];
  const stations = Array.isArray(input?.stations) ? input.stations : [];
  if (stations.length < 1 || stations.length > 30) errors.push('工位数量需在 1–30 个');
  stations.forEach((s, i) => {
    const label = s?.name || s?.id || `第 ${i + 1} 个工位`;
    if (!(s?.cycle_s > 0 && s.cycle_s <= 36000)) errors.push(`${label} 的节拍 cycle_s 需在 0–36000 s`);
    if (s?.servers !== undefined && !(Number.isInteger(s.servers) && s.servers >= 1 && s.servers <= 20)) errors.push(`${label} 的并行设备数 servers 需为 1–20 的整数`);
    if (s?.cv !== undefined && !(s.cv >= 0 && s.cv <= 0.6)) errors.push(`${label} 的波动系数 cv 需在 0–0.6`);
    if (s?.buffer !== undefined && !(Number.isInteger(s.buffer) && s.buffer >= 0 && s.buffer <= 500)) errors.push(`${label} 的缓存 buffer 需为 0–500 的整数`);
    if ((s?.mtbf_min !== undefined || s?.mttr_min !== undefined) && !(s.mtbf_min > 0 && s.mttr_min > 0)) errors.push(`${label} 的故障参数需同时给 mtbf_min 和 mttr_min（正数，分钟）`);
  });
  const hours = input?.hours ?? 8;
  if (!(hours > 0 && hours <= 168)) errors.push('仿真时长 hours 需在 0–168 小时');
  if (input?.arrival_s !== undefined && input.arrival_s !== null && !(input.arrival_s > 0)) errors.push('来料间隔 arrival_s 需为正数（不给则视为来料充足）');
  return errors;
}

// Returns KPIs plus a compact event log for replay. trace: keep machine state changes and moves.
export function simulateLine(input, { trace = true, maxTrace = 120_000 } = {}) {
  const errors = validateLine(input);
  if (errors.length) throw new Error(errors.join('；'));
  const random = rng(input.seed ?? 20261110);
  const draw = sampler(random);
  const horizon = (input.hours ?? 8) * 3600;
  const warmup = Math.min((input.warmup_h ?? 0) * 3600, horizon * 0.5);
  const arrival = input.arrival_s ?? null;
  const stations = input.stations.map((s, i) => ({
    i,
    id: s.id ?? `S${i + 1}`,
    name: s.name ?? s.id ?? `工位 ${i + 1}`,
    cycle: s.cycle_s,
    cv: s.cv ?? 0.1,
    servers: s.servers ?? 1,
    cap: s.buffer ?? (i === 0 ? Infinity : 2),
    mtbf: s.mtbf_min ? s.mtbf_min * 60 : 0,
    mttr: s.mttr_min ? s.mttr_min * 60 : 0,
    queue: [],
    machines: [],
    done: 0,
    queueArea: 0,
    queueSince: 0,
    queueMax: 0,
  }));
  if (arrival === null) stations[0].cap = Infinity;
  const machines = [];
  for (const st of stations) {
    for (let k = 0; k < st.servers; k++) {
      const m = { st, k, index: machines.length, state: 'idle', since: 0, part: null, ver: 0, downUntil: 0, acc: { idle: 0, busy: 0, blocked: 0, down: 0 }, finishAt: 0 };
      st.machines.push(m);
      machines.push(m);
    }
  }
  const heap = new Heap();
  const log = [];
  const moves = [];
  let now = 0;
  let nextPart = 1;
  let released = 0;
  let wip = 0;
  let wipArea = 0;
  let wipSince = 0;
  let exited = 0;
  let exitedAfterWarmup = 0;
  const lead = [];
  const statsStart = () => warmup;

  const account = (m) => {
    const from = Math.max(m.since, statsStart());
    if (now > from) m.acc[m.state] += now - from;
    m.since = now;
  };
  const setState = (m, state) => {
    if (m.state === state) return;
    account(m);
    m.state = state;
    if (trace && log.length < maxTrace) log.push([+now.toFixed(2), m.index, STATES.indexOf(state)]);
  };
  const touchQueue = (st) => {
    const from = Math.max(st.queueSince, statsStart());
    if (now > from) st.queueArea += (now - from) * st.queue.length;
    st.queueSince = now;
  };
  const touchWip = (delta) => {
    const from = Math.max(wipSince, statsStart());
    if (now > from) wipArea += (now - from) * wip;
    wipSince = now;
    wip += delta;
  };

  const start = (m, part) => {
    m.part = part;
    setState(m, 'busy');
    const duration = draw.cycle(m.st.cycle, m.st.cv);
    m.finishAt = now + duration;
    m.ver += 1;
    heap.push({ t: m.finishAt, type: 'finish', m, ver: m.ver });
  };

  // A part enters station st (queue or straight onto an idle machine). Returns false if no room.
  const offer = (st, part) => {
    const idle = st.machines.find((m) => m.state === 'idle');
    if (idle && !st.queue.length) {
      start(idle, part);
      return true;
    }
    if (st.queue.length < st.cap) {
      touchQueue(st);
      st.queue.push(part);
      st.queueMax = Math.max(st.queueMax, st.queue.length);
      return true;
    }
    return false;
  };

  const feedFromSource = () => {
    // Saturated source: keep station 0 busy.
    if (arrival !== null) return;
    const st = stations[0];
    for (const m of st.machines) {
      if (m.state !== 'idle' || st.queue.length) continue;
      touchWip(1);
      released += 1;
      start(m, { id: nextPart++, born: now });
    }
  };

  // Pull: an idle machine takes the next part in its queue, then upstream blocked machines push.
  const pull = (st) => {
    for (const m of st.machines) {
      if (m.state !== 'idle' || !st.queue.length) continue;
      touchQueue(st);
      start(m, st.queue.shift());
    }
    if (st.i > 0) {
      const up = stations[st.i - 1];
      const blocked = up.machines.filter((m) => m.state === 'blocked').sort((a, b) => a.since - b.since);
      for (const m of blocked) {
        if (!offer(st, m.part)) break;
        if (trace && moves.length < maxTrace) moves.push([+now.toFixed(2), up.i, m.part.id]);
        m.part = null;
        setState(m, 'idle');
        pull(up);
      }
    } else feedFromSource();
  };

  const finish = (m) => {
    const st = m.st;
    st.done += now >= warmup ? 1 : 0;
    const next = stations[st.i + 1];
    if (!next) {
      touchWip(-1);
      exited += 1;
      if (now >= warmup) {
        exitedAfterWarmup += 1;
        lead.push(now - m.part.born);
      }
      if (trace && moves.length < maxTrace) moves.push([+now.toFixed(2), st.i, m.part.id]);
      m.part = null;
      setState(m, 'idle');
      pull(st);
      return;
    }
    if (offer(next, m.part)) {
      if (trace && moves.length < maxTrace) moves.push([+now.toFixed(2), st.i, m.part.id]);
      m.part = null;
      setState(m, 'idle');
      pull(st);
    } else setState(m, 'blocked');
  };

  for (const m of machines) {
    if (m.st.mtbf) heap.push({ t: draw.exp(m.st.mtbf), type: 'fail', m });
  }
  if (arrival !== null) heap.push({ t: 0, type: 'arrive' });
  else feedFromSource();

  while (heap.size) {
    const e = heap.pop();
    if (e.t > horizon) break;
    now = e.t;
    if (e.type === 'arrive') {
      const part = { id: nextPart++, born: now };
      if (offer(stations[0], part)) {
        touchWip(1);
        released += 1;
      }
      heap.push({ t: now + arrival, type: 'arrive' });
    } else if (e.type === 'finish') {
      if (e.ver !== e.m.ver || e.m.state !== 'busy') continue;
      finish(e.m);
    } else if (e.type === 'fail') {
      const m = e.m;
      const repair = draw.exp(m.st.mttr);
      const resume = m.state;
      setState(m, 'down');
      m.downUntil = now + repair;
      heap.push({ t: m.downUntil, type: 'repair', m, resume, left: resume === 'busy' ? Math.max(0, m.finishAt - now) : 0 });
      m.ver += 1; // cancel the pending finish; repair re-schedules it
    } else if (e.type === 'repair') {
      const m = e.m;
      if (e.resume === 'busy') {
        setState(m, 'busy');
        m.finishAt = now + e.left;
        m.ver += 1;
        heap.push({ t: m.finishAt, type: 'finish', m, ver: m.ver });
      } else if (e.resume === 'blocked') {
        setState(m, 'blocked');
        pull(stations[m.st.i + 1]);
      } else {
        setState(m, 'idle');
        pull(m.st);
      }
      heap.push({ t: now + draw.exp(m.st.mtbf), type: 'fail', m });
    }
  }
  now = horizon;
  for (const m of machines) account(m);
  for (const st of stations) touchQueue(st);
  touchWip(0);

  const span = horizon - warmup;
  const theory = Math.min(...stations.map((s) => s.servers / s.cycle)) * 3600;
  const perStation = stations.map((st) => {
    const sum = { idle: 0, busy: 0, blocked: 0, down: 0 };
    for (const m of st.machines) for (const k of STATES) sum[k] += m.acc[k];
    const total = span * st.servers;
    const share = Object.fromEntries(STATES.map((k) => [k, total ? sum[k] / total : 0]));
    return {
      id: st.id,
      name: st.name,
      servers: st.servers,
      cycle_s: st.cycle,
      capacityPerHour: (st.servers / st.cycle) * 3600 * (st.mtbf ? st.mtbf / (st.mtbf + st.mttr) : 1),
      done: st.done,
      utilization: share.busy,
      blocked: share.blocked,
      starved: share.idle,
      down: share.down,
      avgQueue: span ? st.queueArea / span : 0,
      maxQueue: st.queueMax,
      buffer: Number.isFinite(st.cap) ? st.cap : null,
    };
  });
  // Bottleneck: the station that is busiest while not being held up by its neighbours
  // (highest busy + down share, i.e. lowest blocked + starved).
  const bottleneck = perStation.reduce((best, s) => (s.utilization + s.down > best.utilization + best.down ? s : best), perStation[0]);
  const throughput = span ? (exitedAfterWarmup / span) * 3600 : 0;
  lead.sort((a, b) => a - b);
  return {
    hours: horizon / 3600,
    warmup_h: warmup / 3600,
    output: exitedAfterWarmup,
    totalOutput: exited,
    released,
    throughputPerHour: throughput,
    theoreticalPerHour: theory,
    lineEfficiency: theory ? throughput / theory : 0,
    actualTakt_s: throughput ? 3600 / throughput : null,
    theoreticalTakt_s: theory ? 3600 / theory : null,
    avgWip: span ? wipArea / span : 0,
    wipEnd: wip,
    leadTime_s: lead.length ? { avg: lead.reduce((a, b) => a + b, 0) / lead.length, p50: lead[Math.floor(lead.length * 0.5)], p90: lead[Math.floor(lead.length * 0.9)] } : null,
    bottleneck: { id: bottleneck.id, name: bottleneck.name },
    stations: perStation,
    machines: machines.map((m) => ({ station: m.st.i, k: m.k })),
    log,
    moves,
  };
}

// Several seeds -> mean and spread, so the proposal quotes a range instead of one lucky run.
export function replicate(input, runs = 5) {
  const results = [];
  for (let r = 0; r < runs; r++) results.push(simulateLine({ ...input, seed: (input.seed ?? 20261110) + r * 7919 }, { trace: r === 0 }));
  const values = results.map((x) => x.throughputPerHour);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { first: results[0], runs, throughput: { mean, min: Math.min(...values), max: Math.max(...values) }, shiftOutput: { mean: results.reduce((a, b) => a + b.output, 0) / runs, min: Math.min(...results.map((x) => x.output)), max: Math.max(...results.map((x) => x.output)) } };
}

// Machine states at time t from the trace (for replay in the 3D view).
export function statesAt(result, t) {
  const states = result.machines.map(() => 0);
  for (const [time, index, state] of result.log) {
    if (time > t) break;
    states[index] = state;
  }
  return states;
}

export const STATE_NAMES = { idle: '待料', busy: '加工', blocked: '堵塞', down: '故障' };
export { STATES };
