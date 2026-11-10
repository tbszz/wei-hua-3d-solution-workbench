// 可视化大屏: the command-center board for the steel-coil plant (smart cranes + heavy AGVs).
// A pop-up layer over the whole app (it never resizes the app's panels): a KPI band on top, module
// cards in a left and a right column, a live process-flow band at the bottom, and a clear window in
// the centre onto the 3D twin — everything around that window is dimmed. Every card pops out into a
// larger detail card on top; coil ids, zones and devices are links that locate the matching thing
// in the 3D scene. Minimised, the board is one strip of key figures; a click on it restores the board.
//
//   initDashboard(app, { locate })  builds the layer, binds every [data-open-dashboard] element
//                                   and exposes app.dashboard = { open, close, minimise, toggle, ... }
//   createSceneLocator(app)         the default locate(target) adapter for the current 3D scene;
//                                   SCENE_MAP below is the one place that maps plant zones/devices
//                                   onto the scene's points and objects.
import './dashboard.css';
import { createSim, fmtDuration, KIND_LABEL } from './dashboard-data.js';

// ---------------------------------------------------------------- 3D linkage

// 大屏区域 / 设备 → 当前 3D 场景。区域先找场景里同名的区域标注（图纸识别或手动标注的，names 依次尝试），
// 找不到再按 points 依次尝试场景点位 id（示例厂房：RM-01 上料位、CELL-01/02 工位、H-01 吊装交接点、
// FG-01 放货工位、FG-A 成品区、CHG-01 充电位）。设备：object 为场景里的 crane / agv。
export const SCENE_MAP = {
  zones: {
    ARRIVAL: { names: ['来料卸车位', '来料区'], points: ['RM-01'] },
    INSPECT: { names: ['原材料检验区', '检验区'], points: ['RM-01'] },
    RAW: { names: ['原材料存储区', '原料存储区', '原料库'], points: ['RM-01'] },
    OUTBUF: { names: ['原材料出库暂存点', '出库暂存点'], points: ['RM-01'] },
    F1: { names: ['1# 气垫炉', '1#气垫炉'], points: ['CELL-01'] },
    F2: { names: ['2# 气垫炉', '2#气垫炉'], points: ['CELL-02'] },
    COOLBUF: { names: ['高温冷却暂存点', '冷却暂存点'], points: ['H-01'] },
    COOL: { names: ['高温冷却区', '冷却区'], points: ['FG-A', 'H-01'] },
    SEMI: { names: ['半成品暂存点'], points: ['H-01'] },
    CHEM: { names: ['化学线'], points: ['FG-01', 'CELL-02'] },
    FGBUF: { names: ['成品暂存点'], points: ['FG-01'] },
    FG: { names: ['成品库区', '成品库'], points: ['FG-A', 'FG-01'] },
  },
  devices: {
    CR1: { object: 'crane', index: 1 },
    CR2: { object: 'crane', index: 2 },
    AGV1: { object: 'agv', index: 1 },
    AGV2: { object: 'agv', index: 2 },
    AGV3: { object: 'agv', index: 3 },
    AGV4: { object: 'agv', index: 4 },
  },
};

// Briefly highlight the scene labels whose text contains any of the given words.
function flashLabels(words) {
  const list = words.filter(Boolean).map(String);
  let n = 0;
  for (const el of document.querySelectorAll('#labels .pin')) {
    const text = el.textContent ?? '';
    if (!list.some((w) => text.includes(w))) continue;
    // A data attribute, not a class: the app rewrites each pin's className every frame.
    delete el.dataset.dbHit;
    void el.offsetWidth; // restart the animation
    el.dataset.dbHit = '1';
    clearTimeout(el.dbTimer);
    el.dbTimer = setTimeout(() => delete el.dataset.dbHit, 3600);
    n += 1;
  }
  return n;
}

// Where each plant zone sits in a drawing-built hall that has no zone marker of that name yet:
// [fraction along the runway, fraction across the bays]. A U-shaped flow — raw side up the first
// bay, the furnaces in the middle bays, cooling → chemical line → finished goods back down the last
// one. Only a schematic stand-in: a zone marker with the zone's name (区域标注) always wins.
const SCHEMATIC = {
  ARRIVAL: [0.05, 0], INSPECT: [0.15, 0], RAW: [0.35, 0], OUTBUF: [0.6, 0],
  F1: [0.8, 1 / 3], F2: [0.8, 2 / 3],
  COOLBUF: [0.92, 1], COOL: [0.75, 1], SEMI: [0.55, 1], CHEM: [0.4, 1], FGBUF: [0.26, 1], FG: [0.1, 1],
};
// Where an idle device waits: the start of its route.
const DEV_HOME = { CR1: 'RAW', CR2: 'COOL', AGV1: 'OUTBUF', AGV2: 'F1', AGV3: 'SEMI', AGV4: 'CHEM' };

// A plant zone → drawing coordinates (mm) in the current scene, or null.
export function zonePosition(app, id) {
  const m = SCENE_MAP.zones[id];
  const zone = m?.names.map((n) => app.zones?.find?.(n)).find(Boolean);
  if (zone) return { x: zone.x, y: zone.y, zone };
  const site = app.site;
  if (site?.isScene && site.hallBounds) {
    const [fa, fb] = SCHEMATIC[id] ?? [0.5, 0.5];
    const hb = site.hallBounds;
    const [u0, u1, v0, v1] = site.alongX ? [hb.x0, hb.x1, hb.y0, hb.y1] : [hb.y0, hb.y1, hb.x0, hb.x1];
    const bays = [...(site.bays ?? [])].sort((a, b) => a.centre - b.centre);
    const v = bays.length ? bays[Math.round(fb * (bays.length - 1))].centre : v0 + (v1 - v0) * (0.25 + fb * 0.5);
    const u = u0 + (u1 - u0) * fa;
    return { ...(site.alongX ? { x: u, y: v } : { x: v, y: u }), schematic: true };
  }
  const pid = m?.points.find((p) => site?.findPoint?.(p));
  const point = pid ? site.findPoint(pid) : null;
  return point ? { x: point.x, y: point.y, point: pid } : null;
}

// A device → where it is now: part way along its current move, else at its home zone.
function devicePosition(app, where) {
  const r = where.route;
  const a = zonePosition(app, r?.from ?? DEV_HOME[where.id]);
  const b = r ? zonePosition(app, r.to) : null;
  if (!a || !b) return a ?? b;
  const k = Math.max(0, Math.min(1, r.frac ?? 0.5));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, schematic: a.schematic || b.schematic };
}

// The located spot gets its own pin in the scene for a few seconds (drawn by the app's label pass).
const marks = new WeakMap();
function markSpot(app, pos, h, text) {
  if (!marks.has(app)) {
    marks.set(app, { until: 0 });
    app.labelHooks = [...(app.labelHooks ?? []), ({ pin, place, seen }) => {
      const m = marks.get(app);
      if (!m.pos || performance.now() > m.until) return;
      seen.add('db:loc');
      place(pin('db:loc', 'dbloc', `<span class="lab">${esc(m.text)}</span><span class="dot"></span>`), { x: m.pos.x / 1000, y: m.h, z: -m.pos.y / 1000 });
    }];
  }
  Object.assign(marks.get(app), { pos, h, text, until: performance.now() + 9000 });
}

// target: { kind: 'zone' | 'dev' | 'coil', id, name, at? } — a coil carries `at`, where it is now;
// a device (or a coil riding on one) carries `route` { from, to, frac } while it is moving a coil.
export function createSceneLocator(app) {
  return (target) => {
    const where = target.kind === 'coil' ? target.at : target;
    const label = target.kind === 'coil' ? `${target.id}（${where?.name ?? '—'}）` : target.name;
    let found = null;
    try {
      const site = app.site;
      const crane = where?.kind === 'dev' && SCENE_MAP.devices[where.id]?.object === 'crane';
      const pos = where?.kind === 'zone' ? zonePosition(app, where.id) : where?.kind === 'dev' ? devicePosition(app, where) : null;
      if (pos?.zone && where.kind === 'zone') {
        app.zones.lookAt(pos.zone.id);
        found = `区域标注 ${pos.zone.name}`;
      } else if (pos && site?.isScene) {
        app.setView('point', { x: pos.x, y: pos.y, h: crane ? 8 : 1, size: 26 });
        found = pos.schematic ? '示意位置（可用「区域标注」标出实际位置）' : '对应位置';
      } else if (pos?.point && where.kind === 'zone') {
        app.setView('point', { id: pos.point });
        found = `点位 ${pos.point}`;
      } else if (where?.kind === 'dev' && app.select?.(SCENE_MAP.devices[where.id]?.object)) {
        app.focusObject(SCENE_MAP.devices[where.id].object);
        found = crane ? '行车（示意）' : 'AGV（示意）';
      }
      if (pos) markSpot(app, pos, crane ? 9.5 : where.kind === 'dev' ? 2.6 : 1.2, `◎ ${label}`);
    } catch (error) {
      console.warn('大屏定位失败', error);
    }
    flashLabels([where?.name, target.name, target.id]);
    app.toast?.(`已定位：${label}${found ? ` → ${found}` : ''}`);
    return found;
  };
}

// ---------------------------------------------------------------- formatting + charts

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// The app's own palette (style.css :root): blue is the main data colour, red the brand / alarm
// colour, and status follows the app — 运行 green, 充电 yellow, 空闲 grey, 故障 red.
const C = { cyan: '#2B7DE9', amber: '#E6A700', green: '#2EA121', red: '#D7000F', blue: '#A0A6AE', muted: '#A0A6AE', violet: '#7B61FF' };
const LINE_COLOR = { L1: C.cyan, L2: C.amber };
const STATUS = { 运行: { color: C.green, cls: 'run' }, 空闲: { color: C.blue, cls: 'idle' }, 充电: { color: C.amber, cls: 'chg' }, 故障: { color: C.red, cls: 'err' } };
const LEVEL_CLS = { 严重: 'crit', 警告: 'warn', 提示: 'info' };
// 行车 red and AGV blue, as their badges in the rest of the app.
const KIND_COLOR = { crane: C.red, agv: C.cyan, process: C.violet, wait: C.amber, store: C.muted };

function spark(values, { w = 92, h = 22, color = C.cyan, fill = true } = {}) {
  if (!values?.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`);
  const area = fill ? `<path d="M0,${h} L${pts.join(' L')} L${w},${h} Z" fill="${color}" opacity=".16"/>` : '';
  return `<svg class="db-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">${area}<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

// Semicircle gauge, pct 0–100.
function gauge(pct, { size = 74, color = C.cyan, label = '' } = {}) {
  const r = size / 2 - 6;
  const cx = size / 2;
  const cy = size / 2 + 2;
  const p = clamp01((pct ?? 0) / 100);
  const arc = (a) => `${(cx - r * Math.cos(a)).toFixed(2)},${(cy - r * Math.sin(a)).toFixed(2)}`;
  const end = arc(Math.PI * p);
  return `<svg class="db-gauge" viewBox="0 0 ${size} ${size / 2 + 10}" width="${size}" height="${size / 2 + 10}">
    <path d="M${arc(0)} A${r},${r} 0 0 1 ${arc(Math.PI)}" fill="none" stroke="rgba(31,35,41,.08)" stroke-width="7" stroke-linecap="round"/>
    ${p > 0 ? `<path d="M${arc(0)} A${r},${r} 0 0 1 ${end}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>` : ''}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="db-gv">${num(pct)}<tspan class="db-gu">%</tspan></text>
    ${label ? `<text x="${cx}" y="${cy + 9}" text-anchor="middle" class="db-gl">${esc(label)}</text>` : ''}
  </svg>`;
}

const bar = (pct, color = C.cyan, warn = false) => `<span class="db-bar${warn ? ' warn' : ''}"><i style="width:${(clamp01((pct ?? 0) / 100) * 100).toFixed(1)}%;background:${color}"></i></span>`;

// Duration vs standard: the bar fills to avg/std, red beyond the standard (capped at 2×).
function vsStd(avg, std, max) {
  if (std == null || avg == null) return '<span class="db-vs"></span>';
  const k = avg / std;
  const km = max != null ? Math.min(2, max / std) : null;
  return `<span class="db-vs" title="平均 ${num(avg, 1)} / 标准 ${std} min"><i style="width:${(Math.min(2, k) / 2) * 100}%" class="${k > 1 ? 'over' : ''}"></i>${km ? `<b style="left:${(km / 2) * 100}%"></b>` : ''}<s></s></span>`;
}

// Multi-series line chart with a light grid and hour labels.
function lineChart(series, labels, { w = 320, h = 110, pad = [8, 6, 18, 22] } = {}) {
  const [pt, pr, pb, pl] = pad;
  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const iw = w - pl - pr;
  const ih = h - pt - pb;
  const x = (i, n) => pl + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
  const y = (v) => pt + ih - (v / max) * ih;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${pl}" x2="${w - pr}" y1="${y(max * f)}" y2="${y(max * f)}" class="db-grid"/><text x="${pl - 4}" y="${y(max * f) + 3}" text-anchor="end" class="db-ax">${num(max * f, max < 4 ? 1 : 0)}</text>`).join('');
  const xl = labels.map((l, i) => (i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1 ? `<text x="${x(i, labels.length)}" y="${h - 4}" text-anchor="middle" class="db-ax">${esc(l)}</text>` : '')).join('');
  const lines = series.map((s) => {
    const pts = s.values.map((v, i) => `${x(i, s.values.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const dots = s.values.map((v, i) => `<circle cx="${x(i, s.values.length).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" fill="${s.color}"><title>${esc(s.name)} ${esc(labels[i])}：${v}</title></circle>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round"/>${dots}`;
  }).join('');
  return `<svg class="db-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}${xl}${lines}</svg>`;
}

function barChart(values, labels, { w = 320, h = 100, color = C.green } = {}) {
  const max = Math.max(1, ...values);
  const pl = 22;
  const pb = 16;
  const iw = w - pl - 4;
  const ih = h - pb - 6;
  const bw = iw / values.length;
  const bars = values.map((v, i) => `<rect x="${(pl + i * bw + bw * 0.18).toFixed(1)}" y="${(6 + ih - (v / max) * ih).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${((v / max) * ih).toFixed(1)}" fill="${color}" rx="1.5"><title>${esc(labels[i])}：${v}</title></rect>`).join('');
  const xl = labels.map((l, i) => (i % 2 === 0 ? `<text x="${(pl + i * bw + bw / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle" class="db-ax">${esc(l.slice(0, 2))}</text>` : '')).join('');
  const grid = [0, 0.5, 1].map((f) => `<line x1="${pl}" x2="${w - 4}" y1="${6 + ih - f * ih}" y2="${6 + ih - f * ih}" class="db-grid"/><text x="${pl - 4}" y="${9 + ih - f * ih}" text-anchor="end" class="db-ax">${num(max * f)}</text>`).join('');
  return `<svg class="db-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}${bars}${xl}</svg>`;
}

const legend = (items) => `<div class="db-legend">${items.map(([name, color]) => `<span><s style="background:${color}"></s>${esc(name)}</span>`).join('')}</div>`;

// Links into the 3D scene.
const zoneLink = (id, name) => `<a class="db-loc" data-loc="zone:${esc(id)}" title="在孪生场景中定位">${esc(name)}</a>`;
const devLink = (id, name) => `<a class="db-loc" data-loc="dev:${esc(id)}" title="在孪生场景中定位">${esc(name)}</a>`;
const coilLink = (id) => `<a class="db-loc db-coil" data-loc="coil:${esc(id)}" title="在孪生场景中定位">${esc(id)}</a>`;
const ledgerBtn = (id) => `<button class="db-mini" data-ledger="${esc(id)}" title="单卷全流程台账">台账</button>`;

// Replace only when the markup changed, keeping inner scroll positions.
function setHTML(el, html) {
  if (!el || el.dbHtml === html) return;
  const keep = [...el.querySelectorAll('[data-scroll]')].map((x) => x.scrollTop);
  el.innerHTML = html;
  el.dbHtml = html;
  [...el.querySelectorAll('[data-scroll]')].forEach((x, i) => {
    if (keep[i]) x.scrollTop = keep[i];
  });
}

// ---------------------------------------------------------------- module bodies

// The stages shown on the compact node monitor (moves and processing, not the waits in between).
const MONITOR = ['lift_in', 'inspect', 'lift_store', 'lift_out', 'agv_feed', 'furnace', 'agv_cool', 'lift_cool', 'cooling', 'lift_semi', 'agv_chem', 'chem', 'agv_fg', 'lift_fg'];

function kpiTiles(s) {
  const k = s.kpis;
  const h = s.history;
  return [
    { label: '今日入库', value: k.inCount, unit: '卷', sub: `原料 ${k.rawIn.count} · 成品 ${k.fgIn.count}`, sub2: `${num((k.rawIn.weight ?? 0) + (k.fgIn.weight ?? 0), 1)} t` },
    { label: '今日出库', value: k.outCount, unit: '卷', sub: `原料 ${k.rawOut.count} · 发货 ${k.ship.count}`, sub2: `${num((k.rawOut.weight ?? 0) + (k.ship.weight ?? 0), 1)} t` },
    { label: '在制钢卷', value: k.wip, unit: '卷', sub: `${num(k.wipWeight, 1)} t`, spark: h.map((x) => x.wip), color: C.violet },
    { label: '原料库存', value: k.rawStock, unit: '卷', sub: '原材料存储区', spark: h.map((x) => x.raw), color: C.cyan },
    { label: '成品库存', value: k.fgStock, unit: '卷', sub: '成品库区', spark: h.map((x) => x.fg), color: C.green },
    { label: '设备在线', value: `${k.online}/${k.totalDevices}`, sub: `运行 ${k.running} 台`, bad: k.online < k.totalDevices },
    { label: '设备利用率', value: num(k.util, 1), unit: '%', sub: '2 台起重机 · 4 台 AGV' },
    { label: '平均流转周期', value: k.lead == null ? '—' : num(k.lead / 60, 1), unit: 'h', sub: '出库 → 成品入库' },
    { label: '产出节拍', value: num(k.perHour, 1), unit: '卷/h', sub: '两条气垫炉合计' },
    { label: '当前告警', value: k.alarms, unit: '条', sub: `严重 ${k.critical}`, alarm: k.alarms > 0 },
  ];
}

function kpiHTML(s) {
  return kpiTiles(s).map((t) => `<div class="db-kpi${t.alarm ? ' alarm' : ''}${t.bad ? ' bad' : ''}" data-open="${t.alarm ? 'alarms' : 'kpi'}">
    <small>${esc(t.label)}</small>
    <b class="db-num">${esc(t.value)}${t.unit ? `<em>${esc(t.unit)}</em>` : ''}</b>
    <span class="db-ks">${esc(t.sub ?? '')}${t.sub2 ? ` · ${esc(t.sub2)}` : ''}</span>
    ${t.spark ? spark(t.spark, { color: t.color, w: 78, h: 16 }) : ''}
  </div>`).join('');
}

function nodesHTML(s) {
  const cats = Object.entries(s.categories).map(([k, c]) => `<div class="db-cat"><small>${esc(c.label)}</small><b class="db-num" style="color:${KIND_COLOR[k]}">${num(c.avg, 1)}<em>min</em></b><span>今日 ${c.count} 次</span></div>`).join('');
  const rows = MONITOR.map((key) => s.nodes.find((n) => n.key === key)).map((n) => `<div class="db-node${n.overdue ? ' hot' : ''}">
      <i class="db-kd" style="background:${KIND_COLOR[n.kind]}" title="${esc(n.kindLabel)}"></i>
      <span class="db-nn" title="${esc(n.name)}">${esc(n.name)}</span>
      <span class="db-num db-nc" title="今日完成">${n.count}</span>
      <span class="db-num db-na" title="在途">${n.active ? `<b>${n.active}</b>` : '<s>0</s>'}</span>
      ${vsStd(n.avg, n.std, n.max)}
      <span class="db-num db-nt">${num(n.avg, 1)}<s>/${n.std ?? '—'}</s></span>
    </div>`).join('');
  return `<div class="db-cats">${cats}</div>
    <div class="db-node db-nh"><i></i><span>节点</span><span>完成</span><span>在途</span><span>平均/标准</span><span>min</span></div>
    <div class="db-scroll" data-scroll>${rows}</div>`;
}

function linesHTML(s) {
  const [a, b] = s.lines;
  const col = (l) => `<div class="db-line">
      <div class="db-lh"><s style="background:${LINE_COLOR[l.id]}"></s>${zoneLink(l.zone, l.name)}</div>
      ${gauge(l.util, { color: LINE_COLOR[l.id], label: '炉膛利用率' })}
      <div class="db-lk"><small>今日出炉</small><b class="db-num">${l.done}<em>卷</em></b></div>
      <div class="db-lk"><small>平均加工</small><b class="db-num">${num(l.avg, 1)}<em>min</em></b></div>
      <div class="db-lk"><small>出炉节拍</small><b class="db-num">${num(l.takt, 0)}<em>min/卷</em></b></div>
      <div class="db-lk"><small>在炉</small><b class="db-num">${l.inFurnace}<em>/${l.cap}</em></b></div>
    </div>`;
  return `<div class="db-lines">${col(a)}<div class="db-vsx">VS</div>${col(b)}</div>
    <div class="db-subt">近 12 小时逐时出炉（卷）${legend([['1#', LINE_COLOR.L1], ['2#', LINE_COLOR.L2]])}</div>
    ${lineChart([{ name: '1# 气垫炉', values: a.hourly, color: LINE_COLOR.L1 }, { name: '2# 气垫炉', values: b.hourly, color: LINE_COLOR.L2 }], s.hours, { w: 340, h: 84 })}`;
}

function inventoryHTML(s) {
  const big = s.inventory.filter((z) => z.kind === '库区');
  const rest = s.inventory.filter((z) => z.kind !== '库区');
  const k = s.kpis;
  const tiles = big.map((z) => `<div class="db-wh">
      ${gauge(z.ratio, { size: 66, color: z.ratio >= 90 ? C.red : z.id === 'RAW' ? C.cyan : C.green, label: '库容' })}
      <div>${zoneLink(z.id, z.name)}<b class="db-num">${z.count}<em>/${z.cap} 卷</em></b><span class="db-num">${num(z.weight, 1)} t</span>
      <span class="db-io">${z.id === 'RAW' ? `入 ${k.rawIn.count} · 出 ${k.rawOut.count}` : `入 ${k.fgIn.count} · 发 ${k.ship.count}`}</span></div>
    </div>`).join('');
  const rows = rest.map((z) => {
    const pct = z.cap ? (z.count / z.cap) * 100 : 0;
    const full = z.kind === '暂存点' && z.count >= z.cap;
    return `<div class="db-inv${full ? ' full' : ''}">${zoneLink(z.id, z.name)}${bar(pct, full ? C.red : pct >= 67 ? C.amber : C.cyan)}<span class="db-num">${z.count}<s>/${z.cap}</s></span><span class="db-num db-w">${num(z.weight, 1)} t</span></div>`;
  }).join('');
  return `<div class="db-whs">${tiles}</div><div class="db-scroll" data-scroll>${rows}</div>`;
}

function equipmentHTML(s) {
  return `<div class="db-scroll" data-scroll>${s.equipment.map((e) => {
    const st = STATUS[e.status];
    const task = e.task
      ? `${coilLink(e.task.coil)} <span class="db-route">${esc(e.task.from)} → ${esc(e.task.to)}</span>`
      : e.status === '故障' ? `<span class="db-route err">故障停机 · 约 ${num(e.faultLeft)} min 恢复</span>`
        : e.status === '充电' ? '<span class="db-route">充电位补电中</span>' : `<span class="db-route">待命${e.queue ? ` · 排队 ${e.queue}` : ''}</span>`;
    return `<div class="db-dev ${st.cls}">
      <i class="db-dot" style="background:${st.color}"></i>
      <div class="db-dn">${devLink(e.id, e.name)}<span class="db-tag ${st.cls}">${e.status}</span>${e.battery != null ? `<span class="db-bat${e.battery < 30 ? ' low' : ''}" title="电量"><i style="width:${e.battery}%"></i></span><span class="db-num db-bt">${e.battery}%</span>` : ''}</div>
      <div class="db-dt">${task}</div>
      <div class="db-du"><span class="db-num">${e.tasksToday}<s> 任务</s></span>${bar(e.util, st.color)}<span class="db-num">${num(e.util, 0)}<s>%</s></span></div>
    </div>`;
  }).join('')}</div>`;
}

function alarmRow(a, s) {
  const { kind, id } = a.target;
  const name = kind === 'coil' ? id : kind === 'dev' ? s.equipment.find((e) => e.id === id)?.name ?? id : s.inventory.find((z) => z.id === id)?.name ?? id;
  const link = kind === 'coil' ? coilLink(id) : kind === 'dev' ? devLink(id, name) : zoneLink(id, name);
  const rest = a.title.startsWith(name) ? a.title.slice(name.length).trim() : a.title;
  return `<div class="db-al ${LEVEL_CLS[a.level]}${a.active ? ' on' : ''}">
    <span class="db-num db-at">${esc(a.time)}</span><span class="db-lv">${esc(a.level)}</span>
    <div class="db-am"><div>${link} ${esc(rest)}</div><small>${esc(a.detail)}${a.active ? '' : ' · 已恢复'}</small></div>
  </div>`;
}

function alarmsHTML(s) {
  const active = s.alarms.filter((a) => a.active);
  const recent = s.alarms.filter((a) => !a.active).slice(0, 30);
  return `<div class="db-scroll" data-scroll>${active.length ? '' : '<div class="db-ok">当前无活动告警</div>'}${[...active, ...recent].map((a) => alarmRow(a, s)).join('')}</div>`;
}

function coilsHTML(s) {
  const list = [...s.coils].filter((c) => c.kind !== 'store').sort((a, b) => Number(b.over) - Number(a.over) || b.progress - a.progress).slice(0, 40);
  return `<div class="db-scroll" data-scroll>${list.map((c) => `<div class="db-cr${c.over ? ' over' : ''}">
      ${coilLink(c.id)}<span class="db-cs">${esc(c.stageName)}</span><span class="db-num db-ce">${num(c.elapsed, 0)}<s>${c.std ? `/${c.std}` : ''} min</s></span>${ledgerBtn(c.id)}
      <span class="db-cp"><i style="width:${c.progress * 100}%;background:${c.line ? LINE_COLOR[c.line] : C.muted}"></i></span>
    </div>`).join('')}</div>`;
}

// The route as one live chain under the 3D window: buffers / stores / process zones with their load,
// and between them the crane or AGV doing that move (lit while it is carrying a coil).
const FLOW = [
  ['INSPECT', '检验区'], 'CR1', ['RAW', '原料库'], 'CR1', ['OUTBUF', '出库暂存'], 'AGV1', [['F1', '1#炉'], ['F2', '2#炉']],
  'AGV2', ['COOLBUF', '冷却暂存'], 'CR2', ['COOL', '冷却区'], 'CR2', ['SEMI', '半成品暂存'], 'AGV3', ['CHEM', '化学线'], 'AGV4', ['FGBUF', '成品暂存'], 'CR2', ['FG', '成品库'],
];
const DEV_SHORT = { CR1: '吊1', CR2: '吊2', AGV1: 'A1', AGV2: 'A2', AGV3: 'A3', AGV4: 'A4' };

function flowHTML(s) {
  const hot = new Set(s.alarms.filter((a) => a.active && a.target.kind === 'zone').map((a) => a.target.id));
  const node = ([id, short]) => {
    const z = s.inventory.find((x) => x.id === id);
    const pct = z.cap ? (z.count / z.cap) * 100 : 0;
    const full = hot.has(id) || (z.kind === '暂存点' && z.count >= z.cap) || pct >= 90;
    return `<a class="db-fn${full ? ' full' : ''}" data-loc="zone:${id}" title="${esc(z.name)} · ${z.count}/${z.cap} 卷 · ${num(z.weight, 1)} t · 今日入 ${z.inToday.count} / 出 ${z.outToday.count}（点击定位）">
      <small>${esc(short)}</small><b class="db-num">${z.count}<s>/${z.cap}</s></b>${bar(pct, full ? C.red : pct >= 67 ? C.amber : C.cyan)}</a>`;
  };
  const items = FLOW.map((f) => {
    if (typeof f === 'string') {
      const e = s.equipment.find((x) => x.id === f);
      const st = STATUS[e.status];
      return `<a class="db-fa ${st.cls}" data-loc="dev:${f}" title="${esc(e.name)} · ${e.status}${e.task ? ` · ${e.task.coil}` : ''}（点击定位）"><i></i><small>${DEV_SHORT[f]}</small></a>`;
    }
    return Array.isArray(f[0]) ? `<div class="db-fpair">${f.map(node).join('')}</div>` : node(f);
  }).join('');
  return `<div class="db-fh" data-open="nodes" title="查看全工序耗时统计"><b>工艺流程 · 实时在制</b><span class="db-sub">来料 ${s.kpis.arrive.count} 卷 → … → 成品发货 ${s.kpis.ship.count} 卷</span>${legend([['运行', C.green], ['空闲', C.blue], ['充电', C.amber], ['故障', C.red]])}</div>
    <div class="db-fl">${items}</div>`;
}

// ---------------------------------------------------------------- detail cards

const DETAIL_TITLE = {
  kpi: '全局 KPI 汇总',
  nodes: '工序耗时统计（平均 / 最大 / 标准）',
  lines: '1# / 2# 气垫炉产线对比',
  inventory: '库区与暂存区库存',
  equipment: '起重机 & AGV 设备调度',
  alarms: '异常告警日志',
  coils: '在制钢卷',
  ledger: '单卷全流程台账',
};

function detailKpi(s) {
  const lines = s.lines;
  return `<div class="db-kpis db-kpis-big">${kpiHTML(s)}</div>
    <div class="db-grid2">
      <div class="db-box"><div class="db-subt">逐时出炉（卷）${legend([['1# 气垫炉', LINE_COLOR.L1], ['2# 气垫炉', LINE_COLOR.L2]])}</div>${lineChart(lines.map((l) => ({ name: l.name, values: l.hourly, color: LINE_COLOR[l.id] })), s.hours, { w: 480, h: 150 })}</div>
      <div class="db-box"><div class="db-subt">逐时成品入库（卷）</div>${barChart(s.fgHourly, s.hours, { w: 480, h: 150 })}</div>
      <div class="db-box"><div class="db-subt">近 6 小时在制 / 库存走势（卷）${legend([['在制', C.violet], ['原料库存', C.cyan], ['成品库存', C.green]])}</div>${lineChart([{ name: '在制', values: s.history.map((h) => h.wip), color: C.violet }, { name: '原料库存', values: s.history.map((h) => h.raw), color: C.cyan }, { name: '成品库存', values: s.history.map((h) => h.fg), color: C.green }], s.history.map((h) => h.label), { w: 480, h: 150 })}</div>
      <div class="db-box"><div class="db-subt">今日出入库</div><table class="db-tab"><thead><tr><th>类别</th><th>卷数</th><th>重量 t</th></tr></thead><tbody>
        ${[['来料到货', s.kpis.arrive], ['原料入库', s.kpis.rawIn], ['原料出库', s.kpis.rawOut], ['成品入库', s.kpis.fgIn], ['成品发货出库', s.kpis.ship]].map(([n, v]) => `<tr><td>${n}</td><td class="db-num">${v.count}</td><td class="db-num">${num(v.weight, 1)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
}

function detailNodes(s) {
  const cats = Object.entries(s.categories).map(([k, c]) => `<div class="db-cat"><small>${esc(c.label)}时长</small><b class="db-num" style="color:${KIND_COLOR[k]}">${num(c.avg, 1)}<em>min</em></b><span>最大 ${num(c.max, 1)} min · 今日 ${c.count} 次</span></div>`).join('');
  const rows = s.nodes.map((n, i) => `<tr class="${n.overdue ? 'hot' : ''}">
      <td class="db-num">${i + 1}</td><td>${esc(n.name)}</td><td><i class="db-kd" style="background:${KIND_COLOR[n.kind]}"></i>${esc(n.kindLabel)}</td>
      <td>${n.device ? devLink(n.device, n.device.replace('CR', '起重机 ').replace('AGV', 'AGV-')) : n.zone && n.zone !== 'FURNACE' ? zoneLink(n.zone, s.inventory.find((z) => z.id === n.zone)?.name ?? n.zone) : n.zone === 'FURNACE' ? '1#/2# 气垫炉' : '—'}</td>
      <td class="db-num">${n.std ?? '—'}</td><td class="db-num">${num(n.avg, 1)}</td><td class="db-num">${num(n.max, 1)}</td><td class="db-num">${num(n.sd, 1)}</td>
      <td>${vsStd(n.avg, n.std, n.max)}</td>
      <td class="db-num">${n.count}</td><td class="db-num">${n.active}</td><td class="db-num ${n.overCount ? 'db-red' : ''}">${n.overCount}</td><td class="db-num ${n.overdue ? 'db-red' : ''}">${n.overdue}</td>
    </tr>`).join('');
  return `<div class="db-cats db-cats-big">${cats}</div>
    <div class="db-tabwrap"><table class="db-tab"><thead><tr><th>#</th><th>节点</th><th>类型</th><th>设备 / 位置</th><th>标准 min</th><th>平均</th><th>最大</th><th>σ</th><th>平均 / 标准</th><th>今日完成</th><th>在途</th><th>今日超标</th><th>当前超时</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="db-note">统计口径：今日已完成的节点；“标准”为工艺标准耗时，超出即记超时告警。暂存等待为两次搬运之间的停留时间。</p>`;
}

function detailLines(s) {
  const stat = (label, f, unit = '') => `<tr><td>${label}</td>${s.lines.map((l) => `<td class="db-num">${f(l)}${unit}</td>`).join('')}</tr>`;
  const running = s.lines.map((l) => `<div class="db-box"><div class="db-subt"><s class="db-sw" style="background:${LINE_COLOR[l.id]}"></s>${esc(l.name)} · 在炉钢卷</div>
      ${l.running.length ? l.running.map((r) => `<div class="db-cr">${coilLink(r.id)}<span class="db-cs">已加工 ${num(r.elapsed)} min · 剩余约 ${num(r.left)} min</span>${ledgerBtn(r.id)}<span class="db-cp"><i style="width:${clamp01(r.elapsed / (r.elapsed + r.left || 1)) * 100}%;background:${LINE_COLOR[l.id]}"></i></span></div>`).join('') : '<div class="db-ok">炉内空闲，等待上线</div>'}
    </div>`).join('');
  return `<div class="db-grid2">
      <div class="db-box"><div class="db-lines">${s.lines.map((l) => `<div class="db-line">${gauge(l.util, { size: 110, color: LINE_COLOR[l.id], label: l.name.replace('产线', '') })}</div>`).join('<div class="db-vsx">VS</div>')}</div>
        <table class="db-tab"><thead><tr><th>指标</th>${s.lines.map((l) => `<th>${zoneLink(l.zone, l.name)}</th>`).join('')}</tr></thead><tbody>
        ${stat('今日出炉（卷）', (l) => l.done)}${stat('出炉重量（t）', (l) => num(l.weight, 1))}${stat('平均加工（min）', (l) => num(l.avg, 1))}${stat('最长加工（min）', (l) => num(l.max, 1))}
        ${stat('加工超标（次）', (l) => l.over)}${stat('今日成品入库（卷）', (l) => l.finished)}${stat('平均流转周期（h）', (l) => (l.lead == null ? '—' : num(l.lead / 60, 1)))}${stat('炉膛利用率（%）', (l) => num(l.util, 1))}${stat('出炉节拍（min/卷，近 4 h）', (l) => num(l.takt, 1))}
        </tbody></table></div>
      <div class="db-box"><div class="db-subt">逐时出炉对比（卷）${legend([['1# 气垫炉', LINE_COLOR.L1], ['2# 气垫炉', LINE_COLOR.L2]])}</div>${lineChart(s.lines.map((l) => ({ name: l.name, values: l.hourly, color: LINE_COLOR[l.id] })), s.hours, { w: 480, h: 190 })}</div>
      ${running}
    </div>`;
}

function detailInventory(s) {
  return `<div class="db-zones">${s.inventory.map((z) => {
    const pct = z.cap ? (z.count / z.cap) * 100 : 0;
    const full = (z.kind === '暂存点' && z.count >= z.cap) || pct >= 90;
    return `<div class="db-box db-zone${full ? ' full' : ''}">
      <div class="db-subt">${zoneLink(z.id, z.name)}<span class="db-tag">${esc(z.kind)}</span></div>
      <div class="db-zk"><b class="db-num">${z.count}<em>/${z.cap} 卷</em></b><span class="db-num">${num(z.weight, 1)} t</span><span>${z.incoming ? `在途 ${z.incoming}` : ''}</span></div>
      ${bar(pct, full ? C.red : pct >= 67 ? C.amber : C.cyan)}
      <div class="db-zio"><span>今日入 <b class="db-num">${z.inToday.count}</b> 卷 · ${num(z.inToday.weight, 1)} t</span><span>今日出 <b class="db-num">${z.outToday.count}</b> 卷 · ${num(z.outToday.weight, 1)} t</span>
        <span>平均停留 <b class="db-num">${z.dwellAvg == null ? '—' : fmtDuration(z.dwellAvg * 60)}</b>${z.dwellMax != null ? ` · 最长 ${fmtDuration(z.dwellMax * 60)}` : ''}</span></div>
      <div class="db-chips" data-scroll>${z.coils.map((id) => coilLink(id)).join('') || '<span class="db-muted">空</span>'}</div>
    </div>`;
  }).join('')}</div>`;
}

function detailEquipment(s) {
  const rows = s.equipment.map((e) => {
    const st = STATUS[e.status];
    return `<tr><td>${devLink(e.id, e.name)}<small class="db-muted">${esc(e.role)}</small></td>
      <td><span class="db-tag ${st.cls}">${e.status}</span>${e.faultLeft ? `<small class="db-red">约 ${num(e.faultLeft)} min 恢复</small>` : ''}</td>
      <td>${e.task ? `${coilLink(e.task.coil)}<small>${esc(e.task.from)} → ${esc(e.task.to)} · 已 ${num(e.task.elapsed, 1)} min</small>` : '—'}</td>
      <td class="db-num">${e.queue}</td><td class="db-num">${e.tasksToday}</td><td class="db-num">${num(e.avgTask, 1)}</td>
      <td>${bar(e.util, st.color)}<span class="db-num">${num(e.util, 1)}%</span></td>
      <td>${e.battery != null ? `<span class="db-bat${e.battery < 30 ? ' low' : ''}"><i style="width:${e.battery}%"></i></span><span class="db-num">${e.battery}%</span>` : '—'}</td>
      <td class="db-num ${e.faultsToday ? 'db-red' : ''}">${e.faultsToday}</td></tr>`;
  }).join('');
  return `<div class="db-devgrid">${s.equipment.map((e) => `<div class="db-box">${gauge(e.util, { size: 92, color: STATUS[e.status].color, label: e.name })}</div>`).join('')}</div>
    <div class="db-tabwrap"><table class="db-tab"><thead><tr><th>设备</th><th>状态</th><th>当前任务</th><th>排队</th><th>今日任务</th><th>平均任务 min</th><th>利用率</th><th>电量</th><th>今日故障</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="db-subt db-gap">调度队列与今日任务记录</div>
    <div class="db-queues">${s.equipment.map((e) => `<div class="db-box">
      <div class="db-subt">${devLink(e.id, e.name)}<span class="db-tag ${STATUS[e.status].cls}">${e.status}</span><small class="db-muted">${esc(e.role)}</small></div>
      <div class="db-qh">待执行 ${e.pending.length} 项</div>
      ${e.pending.length ? e.pending.map((q) => `<div class="db-q">${coilLink(q.coil)}<span>${esc(q.from)} → ${esc(q.to)}</span><span class="db-num">已等 ${num(q.waited)} min</span></div>`).join('') : '<div class="db-q db-muted">队列为空</div>'}
      <div class="db-qh">今日最近完成</div>
      ${e.recent.length ? e.recent.map((r) => `<div class="db-q${r.over ? ' over' : ''}">${coilLink(r.coil)}<span>${esc(r.start)}–${esc(r.end)} ${esc(r.from)} → ${esc(r.to)}</span><span class="db-num">${num(r.dur, 1)} min</span></div>`).join('') : '<div class="db-q db-muted">今日暂无</div>'}
    </div>`).join('')}</div>`;
}

function detailAlarms(s, filter) {
  const list = s.alarms.filter((a) => (filter === 'active' ? a.active : filter === 'crit' ? a.level === '严重' : true));
  const types = {};
  for (const a of s.alarms) types[a.type] = (types[a.type] ?? 0) + 1;
  return `<div class="db-cats">${Object.entries(types).map(([t, n]) => `<div class="db-cat"><small>${esc(t)}</small><b class="db-num">${n}</b><span>近期</span></div>`).join('')}</div>
    <div class="db-alist">${list.map((a) => alarmRow(a, s)).join('') || '<div class="db-ok">没有符合条件的告警</div>'}</div>`;
}

function detailCoils(s) {
  const rows = s.coils.map((c) => `<tr class="${c.over ? 'hot' : ''}"><td>${coilLink(c.id)}</td><td class="db-num">${num(c.weight, 1)}</td><td>${c.line ? (c.line === 'L1' ? '1#' : '2#') : '—'}</td><td>${esc(c.stageName)}</td><td>${esc(c.locationName)}</td><td class="db-num ${c.over ? 'db-red' : ''}">${num(c.elapsed, 0)}${c.std ? ` / ${c.std}` : ''}</td><td>${ledgerBtn(c.id)}</td></tr>`).join('');
  return `<div class="db-tabwrap"><table class="db-tab"><thead><tr><th>钢卷编号</th><th>重量 t</th><th>产线</th><th>当前节点</th><th>位置</th><th>停留 / 标准 min</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function detailLedger(sim, id) {
  if (!id) return '<div class="db-ok">输入钢卷编号（如 GJ2611100012）或从列表中点「台账」查看全流程。</div>';
  const L = sim.ledger(id);
  if (!L) return `<div class="db-ok">没有找到钢卷 ${esc(id)}（可能已发货超过 2 天）。</div>`;
  const maxDur = Math.max(...L.rows.filter((r) => r.kind !== 'store').map((r) => Math.max(r.dur ?? 0, r.std ?? 0)), 1);
  const rows = L.rows.map((r) => `<div class="db-lr ${r.state}${r.over ? ' over' : ''}">
      <i class="db-ld" style="border-color:${KIND_COLOR[r.kind]}"></i>
      <div class="db-ln"><b>${esc(r.name)}</b><small>${esc(r.kindLabel)} · ${r.deviceId ? devLink(r.deviceId, r.device) : r.zoneId ? zoneLink(r.zoneId, r.place) : esc(r.place)}${r.deviceId ? ` · ${esc(r.place)}` : ''}</small></div>
      <div class="db-num db-lt">${r.start ? `${esc(r.start)}${r.end ? ` → ${esc(r.end)}` : ' → 进行中'}` : '未开始'}</div>
      <div class="db-lb">${r.kind === 'store' ? '' : `<span class="db-lbar"><i style="width:${((r.dur ?? 0) / maxDur) * 100}%" class="${r.over ? 'over' : ''}"></i>${r.std ? `<b style="left:${(r.std / maxDur) * 100}%" title="标准 ${r.std} min"></b>` : ''}</span>`}</div>
      <div class="db-num db-lv2">${r.dur == null ? '—' : `${num(r.dur, 1)}`}<s>${r.std ? ` / ${r.std}` : ''} min</s></div>
    </div>`).join('');
  return `<div class="db-lhead">
      <div><small>钢卷编号</small><b>${coilLink(L.id)}</b></div>
      <div><small>重量</small><b class="db-num">${num(L.weight, 1)} t</b></div>
      <div><small>牌号 / 规格</small><b>${esc(L.grade)} · ${esc(L.spec)}</b></div>
      <div><small>产线</small><b>${esc(L.line)}</b></div>
      <div><small>当前状态</small><b>${esc(L.status)}</b></div>
      <div><small>累计用时</small><b class="db-num">${fmtDuration(L.total * 60)}</b></div>
    </div>
    <div class="db-ltl">${rows}</div>
    <p class="db-note">${legend(Object.entries(KIND_LABEL).map(([k, v]) => [v, KIND_COLOR[k]]))} 条形为实际耗时，竖线为标准耗时；红色为超标。</p>`;
}

// ---------------------------------------------------------------- the board

const CARDS = {
  left: [['nodes', '全工序节点监控', '今日 · 吊装 / 转运 / 加工'], ['lines', '产线对比', '1# vs 2# 气垫炉'], ['inventory', '库区与暂存区库存', '实时卷数 · 重量']],
  right: [['equipment', '起重机 & AGV 设备调度', '2 台起重机 · 4 台 AGV'], ['alarms', '异常告警日志', '超时 · 积压 · 故障'], ['coils', '在制钢卷 · 单卷台账', '点编号定位，点台账看全流程']],
};
const SPEEDS = [[60, '1 分/秒'], [300, '5 分/秒'], [1200, '20 分/秒']];
const PHONE = '(max-width: 760px)';
const ICON = {
  min: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 8h10"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  pop: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5"/></svg>',
  max: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>',
};

export function initDashboard(app, { locate = createSceneLocator(app), seed = 20261110 } = {}) {
  if (app.dashboard) return app.dashboard;
  const sim = createSim(seed);
  let state = 'closed'; // open | min | closed
  let speed = 60;
  let detail = null; // { kind, ledgerId, filter }
  let snap = null;

  const root = document.createElement('div');
  root.className = 'db-root';
  root.dataset.state = state;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '可视化大屏');
  const card = ([key, title, sub]) => `<section class="db-card" data-card="${key}">
      <header class="db-ch"><b>${title}</b><span class="db-sub">${sub}</span><button class="db-pop" data-open="${key}" title="放大查看">${ICON.pop}</button></header>
      <div class="db-cb" data-body="${key}"></div>
    </section>`;
  root.innerHTML = `
    <div class="db-board" role="region" aria-label="可视化大屏">
      <div class="db-win" aria-hidden="true"><span>孪生场景 · 点击钢卷编号 / 区域 / 设备即在此定位</span></div>
      <header class="db-head">
        <div class="db-time"><b class="db-num" data-clock>--:--:--</b><small data-date></small><span class="db-live">实时</span></div>
        <div class="db-title"><b>钢卷加工智能物流 · 指挥大屏</b><small>智能起重机 + 重载 AGV 数字孪生</small></div>
        <div class="db-ctl">
          <div class="db-seg" title="仿真倍速">${SPEEDS.map(([v, l]) => `<button data-speed="${v}" class="${v === speed ? 'on' : ''}">${l}</button>`).join('')}</div>
          <button class="db-ib" data-act="min" title="缩为一条关键指标（Esc）">${ICON.min}</button>
          <button class="db-ib" data-act="close" title="关闭大屏">${ICON.close}</button>
        </div>
      </header>
      <div class="db-kpis" data-body="kpi"></div>
      <div class="db-col db-left">${CARDS.left.map(card).join('')}</div>
      <div class="db-col db-right">${CARDS.right.map(card).join('')}</div>
      <section class="db-flow" data-body="flow"></section>
    </div>
    <div class="db-strip" role="button" tabindex="0" title="点击展开大屏"></div>
    <div class="db-mask" hidden>
      <div class="db-detail" role="dialog" aria-modal="true">
        <header class="db-dh"><b data-dtitle></b><div class="db-dctl" data-dctl></div><button class="db-ib" data-act="dclose" title="关闭 (Esc)">${ICON.close}</button></header>
        <div class="db-db" data-dbody></div>
      </div>
    </div>`;
  document.body.append(root);

  const $ = (sel) => root.querySelector(sel);
  const bodies = Object.fromEntries([...root.querySelectorAll('[data-body]')].map((el) => [el.dataset.body, el]));
  const strip = $('.db-strip');
  const mask = $('.db-mask');

  // ------------------------------------------------ rendering

  function renderBoard() {
    $('[data-clock]').textContent = snap.clock;
    $('[data-date]').textContent = snap.date;
    setHTML(bodies.kpi, kpiHTML(snap));
    setHTML(bodies.nodes, nodesHTML(snap));
    setHTML(bodies.lines, linesHTML(snap));
    setHTML(bodies.inventory, inventoryHTML(snap));
    setHTML(bodies.equipment, equipmentHTML(snap));
    setHTML(bodies.alarms, alarmsHTML(snap));
    setHTML(bodies.coils, coilsHTML(snap));
    setHTML(bodies.flow, flowHTML(snap));
    root.querySelector('[data-card="alarms"] .db-sub').textContent = snap.kpis.alarms ? `活动 ${snap.kpis.alarms} 条 · 严重 ${snap.kpis.critical}` : '超时 · 积压 · 故障';
  }

  function renderStrip() {
    const k = snap.kpis;
    const [l1, l2] = snap.lines;
    setHTML(strip, `<b class="db-st">大屏</b>
      <span class="db-s-wip">在制 <b class="db-num">${k.wip}</b></span>
      <span class="db-s-in">入库 <b class="db-num">${k.inCount}</b></span>
      <span class="db-s-out">出库 <b class="db-num">${k.outCount}</b></span>
      <span class="db-sa${k.alarms ? ' on' : ''}" data-open="alarms" title="查看告警">告警 <b class="db-num">${k.alarms}</b></span>
      <span class="db-s-takt" title="近 4 小时出炉节拍">节拍 1# <b class="db-num">${num(l1.takt, 0)}</b>′ · 2# <b class="db-num">${num(l2.takt, 0)}</b>′</span>
      <span class="db-num db-sc">${snap.clock.slice(0, 5)}</span>
      <button class="db-ib" data-act="restore" title="展开大屏">${ICON.max}</button>
      <button class="db-ib" data-act="close" title="关闭大屏">${ICON.close}</button>`);
  }

  function renderDetail() {
    if (!detail) return;
    const k = detail.kind;
    const body = $('[data-dbody]');
    const html = k === 'kpi' ? detailKpi(snap)
      : k === 'nodes' ? detailNodes(snap)
        : k === 'lines' ? detailLines(snap)
          : k === 'inventory' ? detailInventory(snap)
            : k === 'equipment' ? detailEquipment(snap)
              : k === 'alarms' ? detailAlarms(snap, detail.filter)
                : k === 'coils' ? detailCoils(snap)
                  : detailLedger(sim, detail.ledgerId);
    setHTML(body, html);
  }

  function refresh() {
    snap = sim.snapshot();
    snap.history = snap.history.map((h) => ({ ...h, label: h.t != null ? clockOf(h.t) : '' }));
    if (state === 'open') renderBoard();
    if (state !== 'closed') renderStrip();
    if (detail) renderDetail();
  }
  const clockOf = (t) => {
    const s = ((t % 86400) + 86400) % 86400;
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  };

  // ------------------------------------------------ state

  function setState(next) {
    state = next;
    root.dataset.state = next;
    // While open the board covers the app, floating cards included (dashboard.css hides them).
    document.body.classList.toggle('db-open', next === 'open');
    if (next !== 'open') closeDetail();
    for (const el of document.querySelectorAll('[data-open-dashboard]')) {
      el.classList.toggle('on', next !== 'closed');
      el.setAttribute('aria-pressed', String(next !== 'closed'));
    }
    if (next !== 'closed') refresh();
    app.dashboard?.onChange?.(next);
  }
  const open = () => setState('open');
  const close = () => setState('closed');
  const minimise = () => setState('min');
  const toggle = () => setState(state === 'open' ? 'closed' : 'open');

  function openDetail(kind, extra = {}) {
    if (state !== 'open') setState('open');
    detail = { kind, filter: 'all', ...extra };
    $('[data-dtitle]').textContent = DETAIL_TITLE[kind] ?? '详情';
    const ctl = $('[data-dctl]');
    if (kind === 'ledger') {
      ctl.innerHTML = `<form class="db-search" data-search><input list="db-coil-ids" placeholder="输入钢卷编号，如 GJ2611100012" value="${esc(detail.ledgerId ?? '')}" spellcheck="false" autocomplete="off"/><datalist id="db-coil-ids"></datalist><button type="submit">查询</button></form>`;
      ctl.querySelector('datalist').innerHTML = sim.findCoils('', 60).map((id) => `<option value="${id}">`).join('');
    } else if (kind === 'alarms') {
      ctl.innerHTML = `<div class="db-seg">${[['all', '全部'], ['active', '活动'], ['crit', '严重']].map(([v, l]) => `<button data-filter="${v}" class="${v === detail.filter ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    } else ctl.innerHTML = '';
    $('[data-dbody]').dbHtml = null;
    mask.hidden = false;
    renderDetail();
    if (kind === 'ledger' && !detail.ledgerId) ctl.querySelector('input')?.focus();
  }
  function closeDetail() {
    detail = null;
    mask.hidden = true;
  }

  // ------------------------------------------------ interaction

  function locateRef(ref) {
    const [kind, id] = ref.split(/:(.*)/s);
    // A device carrying a coil is located part way along its move (by elapsed vs standard time).
    const dev = (devId, name) => {
      const e = snap?.equipment.find((x) => x.id === devId);
      const std = e?.task ? snap.nodes.find((n) => n.key === e.task.stage)?.std : null;
      const route = e?.task ? { from: e.task.fromId, to: e.task.toId, frac: std ? e.task.elapsed / std : 0.5 } : null;
      return { kind: 'dev', id: devId, name: name ?? e?.name ?? devId, route };
    };
    let target;
    if (kind === 'coil') {
      const c = snap?.coils.find((x) => x.id === id);
      const at = !c ? null : c.location.startsWith('dev:') ? dev(c.location.slice(4), c.locationName) : { kind: 'zone', id: c.location, name: c.locationName };
      target = { kind: 'coil', id, name: id, at };
    } else if (kind === 'dev') target = dev(id);
    else target = { kind: 'zone', id, name: snap?.inventory.find((z) => z.id === id)?.name ?? id };
    locate?.(target);
    // A detail card covers the 3D window: close it so the jump can be seen.
    if (detail) closeDetail();
    // On a phone the board covers the scene: get out of the way so the jump can be seen.
    if (window.matchMedia(PHONE).matches && state === 'open') minimise();
  }

  root.addEventListener('click', (e) => {
    const loc = e.target.closest('[data-loc]');
    if (loc) return void locateRef(loc.dataset.loc);
    const led = e.target.closest('[data-ledger]');
    if (led) return void openDetail('ledger', { ledgerId: led.dataset.ledger });
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'min') return void minimise();
    if (act === 'close') return void close();
    if (act === 'restore') return void open();
    if (act === 'dclose') return void closeDetail();
    const sp = e.target.closest('[data-speed]');
    if (sp) {
      speed = Number(sp.dataset.speed);
      for (const b of root.querySelectorAll('[data-speed]')) b.classList.toggle('on', b === sp);
      return undefined;
    }
    const filter = e.target.closest('[data-filter]');
    if (filter && detail) {
      detail.filter = filter.dataset.filter;
      for (const b of root.querySelectorAll('[data-filter]')) b.classList.toggle('on', b === filter);
      return void renderDetail();
    }
    if (e.target === mask) return void closeDetail();
    if (e.target.closest('.db-strip')) {
      const al = e.target.closest('[data-open]');
      return void (al ? openDetail(al.dataset.open) : open());
    }
    if (e.target.closest('.db-detail')) return undefined;
    // Anything else on a card (or a KPI tile) pops the module out, unless the user is selecting text.
    if (window.getSelection?.().toString()) return undefined;
    const target = e.target.closest('[data-open]') ?? e.target.closest('[data-card]');
    if (target) openDetail(target.dataset.open ?? target.dataset.card);
    return undefined;
  });
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-search]');
    if (!form) return;
    e.preventDefault();
    const q = form.querySelector('input').value.trim().toUpperCase();
    const hit = sim.ledger(q) ? q : sim.findCoils(q, 1)[0];
    detail.ledgerId = hit ?? q;
    if (hit) form.querySelector('input').value = hit;
    renderDetail();
  });
  strip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state !== 'open') return;
    if (detail) closeDetail();
    else if (!document.querySelector('.pop-mask:not([hidden]), .ctx')) minimise();
  });
  // Any [data-open-dashboard] element (header chip, view bar button, …) toggles the board.
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-open-dashboard]');
    if (!t || root.contains(t)) return;
    e.preventDefault();
    toggle();
  });
  // Asking for a floating card (header module nav, …) while the board is open: step aside to the strip.
  document.addEventListener('click', (e) => {
    if (state === 'open' && e.target.closest?.('[data-open-card]') && !root.contains(e.target)) minimise();
  }, true);

  // ------------------------------------------------ live data

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    // 1 real second = `speed` sim seconds; a long background pause is not replayed.
    const dt = Math.min(5, (now - last) / 1000);
    last = now;
    sim.step(Math.round((dt * speed) / 10) * 10);
    if (state !== 'closed' && !document.hidden) refresh();
  }, 1000);

  app.dashboard = {
    open,
    close,
    minimise,
    toggle,
    get state() {
      return state;
    },
    sim,
    snapshot: () => sim.snapshot(),
    showCoil: (id) => openDetail('ledger', { ledgerId: String(id).toUpperCase() }),
    showModule: (kind) => openDetail(kind),
    locate: (ref) => locateRef(ref),
    setSpeed: (simSecondsPerSecond) => {
      speed = simSecondsPerSecond;
      for (const b of root.querySelectorAll('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === speed);
    },
  };
  if (/dashboard|大屏/.test(decodeURIComponent(location.hash))) open();
  return app.dashboard;
}
