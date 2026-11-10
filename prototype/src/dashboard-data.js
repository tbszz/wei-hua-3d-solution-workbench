// Steel-coil plant simulator behind the command-center board (可视化大屏).
// Pure and deterministic: no DOM, no Date.now(), no Math.random(). Everything follows from the seed,
// so the same seed and the same step() calls always give the same snapshot.
//
// Time is simulated seconds since 00:00 of the base date (negative = earlier days). The board runs it
// accelerated (1 real second = 1 sim minute by default), so a whole shift passes in a few minutes.

export const TICK = 10; // s, internal resolution
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

// ---------------------------------------------------------------- plant layout

// cap: how many coils fit (null = unlimited, the truck bay). line: which furnace line it belongs to.
export const ZONES = [
  { id: 'ARRIVAL', name: '来料卸车位', kind: '来料', cap: null },
  { id: 'INSPECT', name: '原材料检验区', kind: '检验区', cap: 4 },
  { id: 'RAW', name: '原材料存储区', kind: '库区', cap: 60 },
  { id: 'OUTBUF', name: '原材料出库暂存点', kind: '暂存点', cap: 3 },
  { id: 'F1', name: '1# 气垫炉', kind: '加工', cap: 2, line: 'L1' },
  { id: 'F2', name: '2# 气垫炉', kind: '加工', cap: 2, line: 'L2' },
  { id: 'COOLBUF', name: '高温冷却暂存点', kind: '暂存点', cap: 3 },
  { id: 'COOL', name: '高温冷却区', kind: '冷却区', cap: 16 },
  { id: 'SEMI', name: '半成品暂存点', kind: '暂存点', cap: 3 },
  { id: 'CHEM', name: '化学线', kind: '加工', cap: 2 },
  { id: 'FGBUF', name: '成品暂存点', kind: '暂存点', cap: 3 },
  { id: 'FG', name: '成品库区', kind: '库区', cap: 80 },
];
const ZONE = Object.fromEntries(ZONES.map((z) => [z.id, z]));

export const DEVICES = [
  { id: 'CR1', name: '智能起重机 1', type: 'crane', role: '来料吊装 · 入库 · 出库' },
  { id: 'CR2', name: '智能起重机 2', type: 'crane', role: '冷却吊运 · 半成品 · 成品入库' },
  { id: 'AGV1', name: '上线 AGV-1', type: 'agv', role: '出库暂存点 → 气垫炉上线点' },
  { id: 'AGV2', name: '下线 AGV-2', type: 'agv', role: '气垫炉下线 → 高温冷却暂存点' },
  { id: 'AGV3', name: '下线 AGV-3', type: 'agv', role: '半成品暂存点 → 化学线上线点' },
  { id: 'AGV4', name: '下线 AGV-4', type: 'agv', role: '化学线下线 → 成品暂存点' },
];
const DEVICE = Object.fromEntries(DEVICES.map((d) => [d.id, d]));

export const LINES = [
  { id: 'L1', name: '1# 气垫炉产线', zone: 'F1', factor: 1 },
  { id: 'L2', name: '2# 气垫炉产线', zone: 'F2', factor: 1.07 }, // the older furnace runs a little slower
];
const LINE = Object.fromEntries(LINES.map((l) => [l.id, l]));

// The route every coil follows, one stage after another. kind:
//   crane / agv  a move from `from` to `to` by `device`
//   process      inspection or processing at `zone`
//   wait         waiting at `zone` for the next move (暂存等待)
//   store        sitting in a warehouse (no standard time)
// std: standard time in minutes. 'FURNACE' resolves to the coil's furnace (F1 / F2).
export const STAGES = [
  { key: 'arrive_wait', name: '来料待吊', kind: 'wait', zone: 'ARRIVAL', std: 20 },
  { key: 'lift_in', name: '来料吊装至检验区', kind: 'crane', device: 'CR1', from: 'ARRIVAL', to: 'INSPECT', std: 5 },
  { key: 'inspect', name: '原料检验', kind: 'process', zone: 'INSPECT', std: 15 },
  { key: 'inspect_wait', name: '检验合格待吊', kind: 'wait', zone: 'INSPECT', std: 20 },
  { key: 'lift_store', name: '吊装入原料库', kind: 'crane', device: 'CR1', from: 'INSPECT', to: 'RAW', std: 5 },
  { key: 'raw_store', name: '原料库存储', kind: 'store', zone: 'RAW', std: null },
  { key: 'lift_out', name: '调度出库吊至暂存点', kind: 'crane', device: 'CR1', from: 'RAW', to: 'OUTBUF', std: 5 },
  { key: 'outbuf_wait', name: '出库暂存等待', kind: 'wait', zone: 'OUTBUF', std: 45 },
  { key: 'agv_feed', name: 'AGV-1 转运至气垫炉上线点', kind: 'agv', device: 'AGV1', from: 'OUTBUF', to: 'FURNACE', std: 8 },
  { key: 'furnace', name: '气垫炉加工', kind: 'process', zone: 'FURNACE', std: 90 },
  { key: 'furnace_wait', name: '气垫炉下线等待', kind: 'wait', zone: 'FURNACE', std: 12 },
  { key: 'agv_cool', name: 'AGV-2 转运至高温冷却暂存点', kind: 'agv', device: 'AGV2', from: 'FURNACE', to: 'COOLBUF', std: 8 },
  { key: 'coolbuf_wait', name: '冷却暂存等待', kind: 'wait', zone: 'COOLBUF', std: 20 },
  { key: 'lift_cool', name: '吊入高温冷却区', kind: 'crane', device: 'CR2', from: 'COOLBUF', to: 'COOL', std: 5 },
  { key: 'cooling', name: '高温冷却', kind: 'process', zone: 'COOL', std: 120 },
  { key: 'cool_wait', name: '冷却完成待吊', kind: 'wait', zone: 'COOL', std: 20 },
  { key: 'lift_semi', name: '吊至半成品暂存点', kind: 'crane', device: 'CR2', from: 'COOL', to: 'SEMI', std: 5 },
  { key: 'semi_wait', name: '半成品暂存等待', kind: 'wait', zone: 'SEMI', std: 45 },
  { key: 'agv_chem', name: 'AGV-3 转运至化学线上线点', kind: 'agv', device: 'AGV3', from: 'SEMI', to: 'CHEM', std: 8 },
  { key: 'chem', name: '化学线加工', kind: 'process', zone: 'CHEM', std: 40 },
  { key: 'chem_wait', name: '化学线下线等待', kind: 'wait', zone: 'CHEM', std: 12 },
  { key: 'agv_fg', name: 'AGV-4 转运至成品暂存点', kind: 'agv', device: 'AGV4', from: 'CHEM', to: 'FGBUF', std: 8 },
  { key: 'fgbuf_wait', name: '成品暂存等待', kind: 'wait', zone: 'FGBUF', std: 20 },
  { key: 'lift_fg', name: '起重机 2 吊装成品入库', kind: 'crane', device: 'CR2', from: 'FGBUF', to: 'FG', std: 5 },
  { key: 'fg_store', name: '成品库存储', kind: 'store', zone: 'FG', std: null },
];
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const isMove = (s) => s.kind === 'crane' || s.kind === 'agv';

export const KIND_LABEL = { crane: '吊装', agv: 'AGV 转运', process: '工艺加工', wait: '暂存等待', store: '库存' };

const GRADES = ['SPCC', 'DC01', 'DC03', 'DC04', 'Q195', 'SPCD'];

// ---------------------------------------------------------------- helpers

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// 'HH:MM' (or 'HH:MM:SS') of a sim time, with a day prefix when it is not the base day.
export function fmtClock(t, seconds = false) {
  const day = Math.floor(t / DAY);
  const s = Math.floor(t - day * DAY);
  const hm = `${pad(Math.floor(s / HOUR))}:${pad(Math.floor((s % HOUR) / MIN))}${seconds ? `:${pad(s % MIN)}` : ''}`;
  return hm;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const m = sec / MIN;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)} min`;
  return `${Math.floor(m / 60)} h ${pad(Math.round(m % 60))} min`;
}

function dateOf(base, dayOffset) {
  const d = new Date(Date.UTC(base.y, base.m - 1, base.d + dayOffset));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
function sd(a) {
  if (a.length < 2) return a.length ? 0 : null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ---------------------------------------------------------------- simulator

class CoilSim {
  constructor(seed, opts) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.base = opts.date ?? { y: 2026, m: 11, d: 10 };
    // Per-stage standard times (min), overridable for tests and what-if.
    this.std = Object.fromEntries(STAGES.map((s) => [s.key, s.std]));
    Object.assign(this.std, opts.std ?? {});
    this.t = opts.from ?? -6 * HOUR;
    this.acc = 0;
    this.coils = [];
    this.byId = new Map();
    this.seq = new Map(); // day -> last serial
    this.created = 0;
    this.shipped = 0;
    this.count = Object.fromEntries(ZONES.map((z) => [z.id, 0]));
    this.reserved = Object.fromEntries(ZONES.map((z) => [z.id, 0]));
    this.records = []; // completed stages: { key, kind, line, dur, end, coil }
    this.moves = []; // warehouse movements: { t, type, weight, coil }
    this.alarms = [];
    this.alarmSeq = 0;
    this.history = []; // every 10 min: { t, wip, raw, fg }
    this.feedToggle = 0;
    this.devices = DEVICES.map((d) => ({
      ...d,
      busy: null, // { coil, stage, from, to, start }
      battery: d.type === 'agv' ? 70 + this.rng() * 28 : null,
      charging: false,
      faultUntil: -Infinity,
      fault: null,
      busyToday: 0,
      tasksToday: 0,
      faultsToday: 0,
      day: Math.floor(this.t / DAY),
    }));
    this.nextArrival = this.t + 10 * MIN;
    this.nextShip = this.t + 40 * MIN;
    this.zoneFull = {}; // zone -> since
    this.seedStock(opts.rawStock ?? 26, opts.fgStock ?? 34);
    this.run((opts.start ?? 8.5 * HOUR) - this.t);
  }

  // ------------------------------------------------ coils

  newCoil(arrivalT) {
    const day = Math.floor(arrivalT / DAY);
    const n = (this.seq.get(day) ?? 0) + 1;
    this.seq.set(day, n);
    const d = dateOf(this.base, day);
    const r = this.rng;
    const coil = {
      id: `GJ${pad(d.y % 100)}${pad(d.m)}${pad(d.d)}${pad(n, 4)}`,
      weight: Math.round((17 + r() * 15) * 10) / 10,
      grade: GRADES[Math.floor(r() * GRADES.length)],
      spec: `${(0.3 + Math.floor(r() * 26) / 10).toFixed(1)}×${1000 + Math.floor(r() * 11) * 50} mm`,
      line: null,
      stage: 0,
      stageStart: arrivalT,
      stageEnd: null,
      location: 'ARRIVAL',
      status: 'active',
      log: [],
      alarm: null,
    };
    this.coils.push(coil);
    this.byId.set(coil.id, coil);
    this.created += 1;
    return coil;
  }

  zoneOf(coil, token) {
    if (token !== 'FURNACE') return token;
    return LINE[coil.line]?.zone ?? 'F1';
  }

  // Coils already in the warehouses before the simulation starts get a plausible, consistent history.
  seedStock(rawN, fgN) {
    const r = this.rng;
    const make = (n, untilIdx, latest, spread) => {
      const list = [];
      for (let i = 0; i < n; i++) list.push(latest - r() * spread);
      list.sort((a, b) => a - b);
      for (const enterAt of list) {
        const durs = [];
        for (let s = 0; s < untilIdx; s++) {
          const st = STAGES[s];
          const std = (st.std ?? 30) * MIN;
          durs.push(st.kind === 'wait' ? std * (0.2 + r() * 0.5) : std * (0.75 + r() * 0.25));
        }
        const start = enterAt - durs.reduce((a, b) => a + b, 0);
        const coil = this.newCoil(start);
        if (untilIdx > STAGE_INDEX.agv_feed) coil.line = r() < 0.5 ? 'L1' : 'L2';
        let t = start;
        for (let s = 0; s < untilIdx; s++) {
          const st = STAGES[s];
          coil.log.push({ key: st.key, start: t, end: t + durs[s], device: st.device ?? null, zone: isMove(st) ? null : this.zoneOf(coil, st.zone), ...(isMove(st) ? { from: this.zoneOf(coil, st.from), to: this.zoneOf(coil, st.to) } : {}) });
          t += durs[s];
        }
        coil.stage = untilIdx;
        coil.stageStart = t;
        coil.location = STAGES[untilIdx].zone;
        coil.log.push({ key: STAGES[untilIdx].key, start: t, end: null, device: null, zone: coil.location });
        this.count[coil.location] += 1;
      }
    };
    make(rawN, STAGE_INDEX.raw_store, this.t - 10 * MIN, 30 * HOUR);
    make(fgN, STAGE_INDEX.fg_store, this.t - 10 * MIN, 26 * HOUR);
  }

  // Actual durations follow the nominal process times; opts.std only moves the standard the board judges by.
  sampleDuration(stage, coil) {
    const std = stage.std * MIN;
    const r = this.rng();
    const outlier = stage.kind === 'process' ? 0.06 : 0.025;
    const k = r < outlier ? 1.2 + this.rng() * 0.7 : 0.7 + this.rng() * 0.3;
    const factor = stage.key === 'furnace' ? LINE[coil.line]?.factor ?? 1 : 1;
    return Math.max(TICK, Math.round((std * k * factor) / TICK) * TICK);
  }

  // Close the coil's current stage and open the next one at time t.
  advance(coil, t) {
    const cur = STAGES[coil.stage];
    const entry = coil.log.at(-1);
    entry.end = t;
    this.records.push({ key: cur.key, kind: cur.kind, line: coil.line, dur: t - entry.start, end: t, coil: coil.id });
    if (coil.alarm) this.clearAlarm(coil.alarm, t);
    coil.alarm = null;
    coil.stage += 1;
    coil.stageStart = t;
    coil.stageEnd = null;
    const next = STAGES[coil.stage];
    coil.log.push({ key: next.key, start: t, end: null, device: next.device ?? null, zone: isMove(next) ? null : this.zoneOf(coil, next.zone) });
    if (next.kind === 'process') coil.stageEnd = t + this.sampleDuration(next, coil);
  }

  // ------------------------------------------------ main loop

  run(seconds) {
    this.acc += seconds;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick();
    }
  }

  tick() {
    const t0 = this.t;
    this.t += TICK;
    const t = this.t;
    if (Math.floor(t / DAY) !== Math.floor(t0 / DAY)) this.newDay(Math.floor(t / DAY));
    this.updateDevices(t);
    this.finishTimed(t);
    this.arrivals(t);
    this.shipping(t);
    this.dispatch(t);
    this.checkAlarms(t);
    if (Math.floor(t / (10 * MIN)) !== Math.floor(t0 / (10 * MIN))) this.sample(t);
    if (this.records.length > 6000) this.prune(t);
  }

  newDay(day) {
    for (const d of this.devices) {
      d.day = day;
      d.busyToday = 0;
      d.tasksToday = 0;
      d.faultsToday = 0;
    }
  }

  prune(t) {
    const keep = t - 2 * DAY;
    this.records = this.records.filter((r) => r.end >= keep);
    this.moves = this.moves.filter((m) => m.t >= keep);
    this.history = this.history.filter((h) => h.t >= keep);
    const gone = this.coils.filter((c) => c.status === 'shipped' && c.log.at(-1).end < keep);
    if (gone.length) {
      for (const c of gone) this.byId.delete(c.id);
      this.coils = this.coils.filter((c) => !(c.status === 'shipped' && c.log.at(-1).end < keep));
    }
    this.alarms = this.alarms.filter((a) => a.active || a.t >= keep).slice(-400);
  }

  updateDevices(t) {
    for (const d of this.devices) {
      const faulted = t < d.faultUntil;
      if (!faulted && d.fault) {
        this.clearAlarm(d.fault, t);
        d.fault = null;
      }
      if (faulted) {
        // A stalled device holds its load: the move takes longer by the stalled time.
        if (d.busy) this.byId.get(d.busy.coil).stageEnd += TICK;
        continue;
      }
      // Random faults, a few per day across the fleet.
      const rate = d.type === 'crane' ? 0.022 : 0.028;
      if (!d.charging && this.rng() < (rate * TICK) / HOUR) {
        const len = (8 + this.rng() * 17) * MIN;
        d.faultUntil = t + len;
        d.faultsToday += 1;
        const codes = d.type === 'crane' ? ['起升变频器过热', '大车定位偏差', '吊具夹钳信号丢失'] : ['激光导航丢失定位', '驱动轮过流', '安全触边触发'];
        const code = codes[Math.floor(this.rng() * codes.length)];
        d.fault = this.raise(t, { level: '严重', type: '设备故障', title: `${d.name} 故障`, detail: `${code}，预计 ${Math.round(len / MIN)} min 恢复`, target: { kind: 'dev', id: d.id } });
        continue;
      }
      if (d.busy) d.busyToday += TICK;
      if (d.type === 'agv') {
        if (d.charging) {
          d.battery = Math.min(100, d.battery + (3 * TICK) / MIN);
          if (d.battery >= 95) d.charging = false;
        } else {
          d.battery = Math.max(0, d.battery - ((d.busy ? 0.4 : 0.06) * TICK) / MIN);
          if (!d.busy && d.battery < 30) {
            d.charging = true;
            if (d.battery < 25) this.raise(t, { level: '提示', type: '电量低', title: `${d.name} 电量低`, detail: `剩余 ${Math.round(d.battery)}%，已回充电位`, target: { kind: 'dev', id: d.id }, auto: true });
          }
        }
      }
    }
  }

  finishTimed(t) {
    for (const coil of this.coils) {
      if (coil.status !== 'active' || coil.stageEnd == null || coil.stageEnd > t) continue;
      const stage = STAGES[coil.stage];
      if (isMove(stage)) {
        const to = this.zoneOf(coil, stage.to);
        this.reserved[to] -= 1;
        this.count[to] += 1;
        coil.location = to;
        const dev = this.devices.find((d) => d.id === stage.device);
        dev.busy = null;
        if (to === 'RAW') this.moves.push({ t: coil.stageEnd, type: 'rawIn', weight: coil.weight, coil: coil.id });
        if (to === 'FG') this.moves.push({ t: coil.stageEnd, type: 'fgIn', weight: coil.weight, coil: coil.id });
      }
      this.advance(coil, coil.stageEnd);
    }
  }

  room(zone) {
    const cap = ZONE[zone].cap;
    return cap == null || this.count[zone] + this.reserved[zone] < cap;
  }

  // Free devices pick their next move: downstream first (keeps the line flowing), then oldest wait.
  dispatch(t) {
    const inFlight = (keys) => this.coils.filter((c) => c.status === 'active' && keys.includes(STAGES[c.stage].key)).length;
    for (const dev of this.devices) {
      if (dev.busy || dev.charging || t < dev.faultUntil) continue;
      let best = null;
      for (const coil of this.coils) {
        if (coil.status !== 'active') continue;
        const next = STAGES[coil.stage + 1];
        if (!next || next.device !== dev.id) continue;
        const cur = STAGES[coil.stage];
        if (cur.kind !== 'wait' && cur.kind !== 'store') continue;
        let to = next.to;
        if (to === 'FURNACE') {
          const free = LINES.filter((l) => this.room(l.zone));
          if (!free.length) continue;
          free.sort((a, b) => this.count[a.zone] + this.reserved[a.zone] - (this.count[b.zone] + this.reserved[b.zone]));
          const tie = free.length > 1 && this.count[free[0].zone] + this.reserved[free[0].zone] === this.count[free[1].zone] + this.reserved[free[1].zone];
          to = (tie ? free[this.feedToggle % 2] : free[0]).zone;
        } else if (!this.room(this.zoneOf(coil, to))) continue;
        // 调度下发：release stock only while fewer than two coils are queued for the furnaces.
        if (next.key === 'lift_out' && inFlight(['lift_out', 'outbuf_wait']) >= 2) continue;
        const rank = [coil.stage, -coil.stageStart];
        if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { coil, to, rank };
      }
      if (!best) continue;
      const { coil, to } = best;
      const next = STAGES[coil.stage + 1];
      if (next.to === 'FURNACE') {
        coil.line = ZONE[to].line;
        this.feedToggle += 1;
      }
      const from = coil.location;
      this.count[from] -= 1;
      this.reserved[to] += 1;
      if (from === 'RAW') this.moves.push({ t, type: 'rawOut', weight: coil.weight, coil: coil.id });
      this.advance(coil, t);
      Object.assign(coil.log.at(-1), { from, to });
      coil.location = `dev:${dev.id}`;
      coil.stageEnd = t + this.sampleDuration(next, coil);
      dev.busy = { coil: coil.id, stage: next.key, from, to, start: t };
      dev.tasksToday += 1;
    }
  }

  arrivals(t) {
    if (t < this.nextArrival) return;
    const n = 2 + Math.floor(this.rng() * 4); // a truck brings 2–5 coils
    for (let i = 0; i < n; i++) {
      this.newCoil(t);
      const coil = this.coils.at(-1);
      coil.log.push({ key: STAGES[0].key, start: t, end: null, device: null, zone: 'ARRIVAL' });
      this.count.ARRIVAL += 1;
      this.moves.push({ t, type: 'arrive', weight: coil.weight, coil: coil.id });
    }
    this.nextArrival = t + (60 + this.rng() * 40) * MIN;
  }

  // Finished coils leave the warehouse by truck (成品出库).
  shipping(t) {
    if (t < this.nextShip) return;
    const stock = this.coils.filter((c) => c.status === 'active' && c.location === 'FG').sort((a, b) => a.stageStart - b.stageStart);
    const n = Math.min(stock.length, 3 + Math.floor(this.rng() * 4));
    for (const coil of stock.slice(0, n)) {
      coil.log.at(-1).end = t;
      coil.status = 'shipped';
      coil.location = 'shipped';
      coil.stageEnd = null;
      this.count.FG -= 1;
      this.shipped += 1;
      this.moves.push({ t, type: 'ship', weight: coil.weight, coil: coil.id });
    }
    this.nextShip = t + (90 + this.rng() * 60) * MIN;
  }

  // ------------------------------------------------ alarms

  raise(t, a) {
    this.alarmSeq += 1;
    const alarm = { id: `A${pad(this.alarmSeq, 5)}`, t, level: a.level, type: a.type, title: a.title, detail: a.detail, target: a.target, stage: a.stage ?? null, active: !a.auto, end: a.auto ? t : null };
    this.alarms.push(alarm);
    return alarm.id;
  }

  clearAlarm(id, t) {
    const a = this.alarms.find((x) => x.id === id);
    if (a && a.active) {
      a.active = false;
      a.end = t;
    }
  }

  checkAlarms(t) {
    // 超时: a coil has been in its stage longer than the standard time.
    for (const coil of this.coils) {
      if (coil.status !== 'active') continue;
      const stage = STAGES[coil.stage];
      const std = this.std[stage.key];
      if (std == null) continue;
      const over = (t - coil.stageStart) / (std * MIN);
      if (over <= 1) continue;
      const where = isMove(stage) ? DEVICE[stage.device].name : ZONE[this.zoneOf(coil, stage.zone)].name;
      const detail = () => `${where} · 已 ${Math.round((t - coil.stageStart) / MIN)} min / 标准 ${std} min`;
      if (!coil.alarm) {
        coil.alarm = this.raise(t, { level: '警告', type: stage.kind === 'wait' ? '等待超时' : `${KIND_LABEL[stage.kind]}超时`, title: `${coil.id} ${stage.name}超时`, detail: detail(), target: { kind: 'coil', id: coil.id }, stage: stage.key });
      } else {
        const a = this.alarms.find((x) => x.id === coil.alarm);
        if (a) {
          a.detail = detail();
          if (over > 1.5) a.level = '严重';
        }
      }
    }
    // 积压: a buffer point full for 10 min, or a warehouse above 90 %.
    for (const z of ZONES) {
      if (z.cap == null) continue;
      const full = z.kind === '暂存点' ? this.count[z.id] >= z.cap : z.kind === '库区' ? this.count[z.id] >= z.cap * 0.9 : false;
      const state = this.zoneFull[z.id];
      if (full && !state) this.zoneFull[z.id] = { since: t, alarm: null };
      else if (full && state && !state.alarm && t - state.since >= 10 * MIN) {
        state.alarm = this.raise(t, { level: '警告', type: z.kind === '库区' ? '库容告警' : '积压告警', title: `${z.name} ${z.kind === '库区' ? '库容紧张' : '积压'}`, detail: `${this.count[z.id]}/${z.cap} 卷，已持续 ${Math.round((t - state.since) / MIN)} min`, target: { kind: 'zone', id: z.id } });
      } else if (!full && state) {
        if (state.alarm) this.clearAlarm(state.alarm, t);
        delete this.zoneFull[z.id];
      }
    }
  }

  sample(t) {
    this.history.push({ t, wip: this.wip().length, raw: this.count.RAW, fg: this.count.FG });
  }

  wip() {
    const a = STAGE_INDEX.lift_out;
    const b = STAGE_INDEX.lift_fg;
    return this.coils.filter((c) => c.status === 'active' && c.stage >= a && c.stage <= b);
  }

  // ------------------------------------------------ read side

  snapshot() {
    const t = this.t;
    const day = Math.floor(t / DAY);
    const dayStart = day * DAY;
    const today = this.records.filter((r) => r.end >= dayStart);
    const elapsedToday = Math.max(TICK, t - dayStart);
    const date = dateOf(this.base, day);
    const sum = (type) => {
      const list = this.moves.filter((m) => m.type === type && m.t >= dayStart);
      return { count: list.length, weight: round1(list.reduce((s, m) => s + m.weight, 0)) };
    };
    const wip = this.wip();
    const active = this.coils.filter((c) => c.status === 'active');
    const nowElapsed = (c) => t - c.stageStart;

    // Node stats per stage: today's completed stages, plus what is in the stage right now.
    const nodes = STAGES.map((s) => {
      const recs = today.filter((r) => r.key === s.key);
      const durs = recs.map((r) => r.dur / MIN);
      const inStage = active.filter((c) => STAGES[c.stage].key === s.key);
      const std = this.std[s.key];
      return {
        key: s.key,
        name: s.name,
        kind: s.kind,
        kindLabel: KIND_LABEL[s.kind],
        device: s.device ?? null,
        zone: s.zone ?? s.to ?? null,
        std,
        count: recs.length,
        avg: round1(mean(durs)),
        max: round1(durs.length ? Math.max(...durs) : null),
        sd: round1(sd(durs)),
        overCount: std == null ? 0 : durs.filter((d) => d > std).length,
        active: inStage.length,
        overdue: std == null ? 0 : inStage.filter((c) => nowElapsed(c) > std * MIN).length,
      };
    });

    const categories = Object.fromEntries(['crane', 'agv', 'process', 'wait'].map((k) => {
      const durs = today.filter((r) => r.kind === k).map((r) => r.dur / MIN);
      return [k, { label: KIND_LABEL[k], count: durs.length, avg: round1(mean(durs)), max: round1(durs.length ? Math.max(...durs) : null) }];
    }));

    // Lead time: dispatch out of the raw store → into the finished-goods store, for coils finished today.
    const leadOf = (coil) => {
      const out = coil.log.find((e) => e.key === 'lift_out');
      const fin = coil.log.find((e) => e.key === 'fg_store');
      return out && fin ? fin.start - out.start : null;
    };
    const finishedToday = this.coils.filter((c) => {
      const fin = c.log.find((e) => e.key === 'fg_store');
      return fin && fin.start >= dayStart;
    });
    const leads = finishedToday.map(leadOf).filter((v) => v != null).map((v) => v / MIN);

    const taktOf = (ends) => (ends.length < 2 ? null : round1((Math.max(...ends) - Math.min(...ends)) / (ends.length - 1) / MIN));
    const hourNow = Math.floor(t / HOUR);
    const hours = Array.from({ length: 12 }, (_, i) => hourNow - 11 + i);
    const lines = LINES.map((l) => {
      const fr = today.filter((r) => r.key === 'furnace' && r.line === l.id);
      const durs = fr.map((r) => r.dur / MIN);
      const lineLeads = finishedToday.filter((c) => c.line === l.id).map(leadOf).filter((v) => v != null).map((v) => v / MIN);
      const busySec = this.records.filter((r) => r.key === 'furnace' && r.line === l.id && r.end >= dayStart).reduce((s, r) => s + Math.min(r.dur, r.end - dayStart), 0);
      const running = active.filter((c) => c.line === l.id && STAGES[c.stage].key === 'furnace');
      const util = Math.min(1, (busySec + running.reduce((s, c) => s + Math.min(t - c.stageStart, t - dayStart), 0)) / (elapsedToday * ZONE[l.zone].cap));
      return {
        id: l.id,
        name: l.name,
        zone: l.zone,
        cap: ZONE[l.zone].cap,
        inFurnace: this.count[l.zone],
        running: running.map((c) => ({ id: c.id, elapsed: round1((t - c.stageStart) / MIN), left: round1(Math.max(0, c.stageEnd - t) / MIN) })),
        done: fr.length,
        weight: round1(fr.reduce((s, r) => s + (this.byId.get(r.coil)?.weight ?? 0), 0)),
        avg: round1(mean(durs)),
        max: round1(durs.length ? Math.max(...durs) : null),
        over: durs.filter((d) => d > this.std.furnace).length,
        lead: round1(mean(lineLeads)),
        finished: finishedToday.filter((c) => c.line === l.id).length,
        util: round1(util * 100),
        // 节拍: mean gap between consecutive furnace discharges over the last 4 h.
        takt: taktOf(this.records.filter((r) => r.key === 'furnace' && r.line === l.id && r.end >= t - 4 * HOUR).map((r) => r.end)),
        hourly: hours.map((h) => this.records.filter((r) => r.key === 'furnace' && r.line === l.id && Math.floor(r.end / HOUR) === h).length),
      };
    });

    const queueOf = (devId) => active.filter((c) => {
      const next = STAGES[c.stage + 1];
      const cur = STAGES[c.stage];
      return next && next.device === devId && cur.kind === 'wait';
    }).length;
    const equipment = this.devices.map((d) => {
      const faulted = t < d.faultUntil;
      const status = faulted ? '故障' : d.charging ? '充电' : d.busy ? '运行' : '空闲';
      const task = d.busy
        ? { coil: d.busy.coil, stage: d.busy.stage, name: STAGES[STAGE_INDEX[d.busy.stage]].name, from: ZONE[d.busy.from]?.name ?? d.busy.from, to: ZONE[d.busy.to]?.name ?? d.busy.to, fromId: d.busy.from, toId: d.busy.to, elapsed: round1((t - d.busy.start) / MIN) }
        : null;
      const moves = today.filter((r) => STAGES[STAGE_INDEX[r.key]].device === d.id).map((r) => r.dur / MIN);
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        role: d.role,
        status,
        online: !faulted,
        task,
        tasksToday: d.tasksToday,
        avgTask: round1(mean(moves)),
        util: round1(Math.min(100, (d.busyToday / elapsedToday) * 100)),
        battery: d.battery == null ? null : Math.round(d.battery),
        faultsToday: d.faultsToday,
        faultLeft: faulted ? round1((d.faultUntil - t) / MIN) : null,
        queue: queueOf(d.id),
        // 调度队列: coils waiting for this device's next move, longest wait first.
        pending: active.filter((c) => {
          const next = STAGES[c.stage + 1];
          return next && next.device === d.id && STAGES[c.stage].kind === 'wait';
        }).map((c) => {
          const next = STAGES[c.stage + 1];
          return { coil: c.id, name: next.name, from: ZONE[c.location]?.name ?? c.location, to: next.to === 'FURNACE' ? '气垫炉' : ZONE[next.to].name, waited: round1((t - c.stageStart) / MIN) };
        }).sort((a, b) => b.waited - a.waited),
        // Today's finished moves, newest first.
        recent: today.filter((r) => STAGES[STAGE_INDEX[r.key]].device === d.id).slice(-8).reverse().map((r) => {
          const e = this.byId.get(r.coil)?.log.find((x) => x.key === r.key);
          return { coil: r.coil, name: STAGES[STAGE_INDEX[r.key]].name, from: ZONE[e?.from]?.name ?? '—', to: ZONE[e?.to]?.name ?? '—', start: fmtClock(r.end - r.dur), end: fmtClock(r.end), dur: round1(r.dur / MIN), over: this.std[r.key] != null && r.dur > this.std[r.key] * MIN };
        }),
      };
    });

    // 每个区域今日进出: a crane / AGV move ending in the zone is an arrival, one starting from it a departure.
    const flow = Object.fromEntries(ZONES.map((z) => [z.id, { in: { count: 0, weight: 0 }, out: { count: 0, weight: 0 }, dwell: [] }]));
    for (const c of this.coils) {
      let enteredAt = null;
      for (const e of c.log) {
        // Leaving the previous zone first, then arriving in the next one.
        if (e.from && flow[e.from] && e.start >= dayStart) {
          flow[e.from].out.count += 1;
          flow[e.from].out.weight += c.weight;
          if (enteredAt != null) flow[e.from].dwell.push((e.start - enteredAt) / MIN);
        }
        if (e.from) enteredAt = null;
        if (e.to && flow[e.to] && e.end != null) {
          if (e.end >= dayStart) {
            flow[e.to].in.count += 1;
            flow[e.to].in.weight += c.weight;
          }
          enteredAt = e.end;
        }
      }
    }
    for (const m of this.moves) {
      if (m.t < dayStart) continue;
      if (m.type === 'arrive') {
        flow.ARRIVAL.in.count += 1;
        flow.ARRIVAL.in.weight += m.weight;
      } else if (m.type === 'ship') {
        flow.FG.out.count += 1;
        flow.FG.out.weight += m.weight;
      }
    }
    const inventory = ZONES.filter((z) => z.id !== 'ARRIVAL').map((z) => {
      const here = active.filter((c) => c.location === z.id);
      const f = flow[z.id];
      return {
        id: z.id,
        name: z.name,
        kind: z.kind,
        cap: z.cap,
        count: this.count[z.id],
        weight: round1(here.reduce((s, c) => s + c.weight, 0)),
        ratio: z.cap ? round1((this.count[z.id] / z.cap) * 100) : null,
        incoming: this.reserved[z.id],
        coils: here.map((c) => c.id),
        waiting: here.filter((c) => STAGES[c.stage].kind === 'wait').length,
        inToday: { count: f.in.count, weight: round1(f.in.weight) },
        outToday: { count: f.out.count, weight: round1(f.out.weight) },
        dwellAvg: round1(mean(f.dwell)),
        dwellMax: round1(f.dwell.length ? Math.max(...f.dwell) : null),
      };
    });

    const alarmsActive = this.alarms.filter((a) => a.active);
    const alarms = [...this.alarms].sort((a, b) => b.t - a.t || (b.id > a.id ? 1 : -1)).slice(0, 120).map((a) => ({ ...a, time: fmtClock(a.t) }));

    const coils = active.map((c) => {
      const s = STAGES[c.stage];
      const std = this.std[s.key];
      return {
        id: c.id,
        weight: c.weight,
        line: c.line,
        stage: s.key,
        stageName: s.name,
        kind: s.kind,
        location: c.location,
        locationName: c.location.startsWith('dev:') ? DEVICE[c.location.slice(4)].name : ZONE[c.location]?.name ?? c.location,
        elapsed: round1((t - c.stageStart) / MIN),
        std,
        over: std != null && t - c.stageStart > std * MIN,
        progress: round1(c.stage / (STAGES.length - 1)),
      };
    });

    const totalDevices = equipment.length;
    const online = equipment.filter((e) => e.online).length;
    const kpis = {
      arrive: sum('arrive'),
      rawIn: sum('rawIn'),
      rawOut: sum('rawOut'),
      fgIn: sum('fgIn'),
      ship: sum('ship'),
      wip: wip.length,
      wipWeight: round1(wip.reduce((s, c) => s + c.weight, 0)),
      rawStock: this.count.RAW,
      fgStock: this.count.FG,
      online,
      totalDevices,
      running: equipment.filter((e) => e.status === '运行').length,
      alarms: alarmsActive.length,
      critical: alarmsActive.filter((a) => a.level === '严重').length,
      lead: round1(mean(leads)),
      util: round1(mean(equipment.map((e) => e.util))),
      perHour: round1((lines.reduce((s, l) => s + l.done, 0) / elapsedToday) * HOUR),
    };
    kpis.inCount = kpis.rawIn.count + kpis.fgIn.count;
    kpis.outCount = kpis.rawOut.count + kpis.ship.count;

    return {
      t,
      clock: fmtClock(t, true),
      date: `${date.y}-${pad(date.m)}-${pad(date.d)}`,
      kpis,
      nodes,
      categories,
      lines,
      hours: hours.map((h) => `${pad(((h % 24) + 24) % 24)}:00`),
      equipment,
      inventory,
      alarms,
      coils,
      history: this.history.slice(-36),
      fgHourly: hours.map((h) => this.moves.filter((m) => m.type === 'fgIn' && Math.floor(m.t / HOUR) === h).length),
    };
  }

  // 单卷全流程台账: every stage of the route with when, where, by which device, how long vs standard.
  ledger(id) {
    const coil = this.byId.get(String(id ?? '').trim().toUpperCase());
    if (!coil) return null;
    const t = this.t;
    const today = Math.floor(t / DAY);
    // Times on an earlier day carry their date.
    const stamp = (x) => {
      const d = Math.floor(x / DAY);
      if (d === today) return fmtClock(x);
      const date = dateOf(this.base, d);
      return `${pad(date.m)}-${pad(date.d)} ${fmtClock(x)}`;
    };
    const zname = (z) => ZONE[z]?.name ?? (z === 'FURNACE' ? '气垫炉' : z);
    const resolve = (tok) => (tok === 'FURNACE' && !coil.line ? 'FURNACE' : this.zoneOf(coil, tok));
    const rows = STAGES.map((s) => {
      const e = coil.log.find((x) => x.key === s.key);
      const std = this.std[s.key];
      const end = e?.end ?? null;
      const dur = e ? (end ?? t) - e.start : null;
      const place = isMove(s) ? `${zname(e?.from ?? resolve(s.from))} → ${zname(e?.to ?? resolve(s.to))}` : zname(e?.zone ?? resolve(s.zone));
      return {
        key: s.key,
        name: s.name,
        kind: s.kind,
        kindLabel: KIND_LABEL[s.kind],
        place,
        device: s.device ? DEVICE[s.device].name : null,
        deviceId: s.device ?? null,
        zoneId: isMove(s) ? e?.to ?? null : e?.zone ?? null,
        start: e ? stamp(e.start) : null,
        end: end != null ? stamp(end) : null,
        startT: e?.start ?? null,
        dur: dur == null ? null : round1(dur / MIN),
        std,
        state: !e ? 'todo' : end == null ? 'now' : 'done',
        over: std != null && dur != null && dur > std * MIN,
      };
    });
    const first = coil.log[0]?.start ?? t;
    const last = coil.log.at(-1);
    return {
      id: coil.id,
      weight: coil.weight,
      grade: coil.grade,
      spec: coil.spec,
      line: coil.line ? LINE[coil.line].name : '未分配',
      lineId: coil.line,
      status: coil.status === 'shipped' ? '已发货出库' : STAGES[coil.stage].name,
      location: coil.location,
      total: round1(((last.end ?? t) - first) / MIN),
      rows,
    };
  }

  findCoils(query, limit = 12) {
    const q = String(query ?? '').trim().toUpperCase();
    const list = this.coils.filter((c) => !q || c.id.includes(q));
    return list.slice(-limit).reverse().map((c) => c.id);
  }
}

export function createSim(seed = 20261110, opts = {}) {
  const sim = new CoilSim(seed, opts);
  return {
    get t() {
      return sim.t;
    },
    step: (dtSeconds) => sim.run(dtSeconds),
    snapshot: () => sim.snapshot(),
    ledger: (id) => sim.ledger(id),
    findCoils: (q, n) => sim.findCoils(q, n),
    // Read-only views for tests and the assistant.
    coils: () => sim.coils,
    stats: () => ({ created: sim.created, shipped: sim.shipped, count: { ...sim.count }, reserved: { ...sim.reserved } }),
    std: () => ({ ...sim.std }),
  };
}
