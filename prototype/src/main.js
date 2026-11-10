// 卫华 3D 方案工作台 prototype: three.js site on the left, Doubao agent on the right.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CATALOG } from '../../demo/src/catalog.js';
import { SAMPLE_PLAN, fitDepthRange } from '../../demo/src/scene/site.js';
import { applyBands, loadVehicle } from '../../demo/src/vehicle.js';
import { Agent } from './agent.js';
import { ProcessSite } from './engine.js';
import { COIL, fmtTime, simulateShift } from './process.js';
import { createTools } from './tools.js';
import { Library } from './library.js';
import { initPopout } from './popout.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const view = $('view');
// Tuned for integrated GPUs: a 2048 PCF shadow map that is redrawn only as often as things move,
// and a pixel ratio that steps down when the frame rate drops (see adaptPixelRatio).
const QUALITY = { pixelRatio: Math.min(devicePixelRatio, 1.5), shadowSize: 2048, shadowRadius: 2 };

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(QUALITY.pixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 900);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 2;
controls.maxDistance = 320;
controls.autoRotateSpeed = 0.35;

const site = new ProcessSite(renderer, QUALITY);
site.speed = 4;

// ---------------------------------------------------------------- app state

export const app = {
  site,
  step: 4,
  done: new Set([1, 2, 3]),
  tab: 'gantt',
  view: 'overview',
  version: 1,
  product: null,
  vehicle: null,
  states: new Map(),
  pendingProcess: null,
  shift: null,
  newPoints: new Set(),
};

const stateOf = () => app.states.get(app.product.id);

app.bump = () => {
  app.version += 1;
  $('version').textContent = `v${app.version}`;
};

app.selectProduct = async (id) => {
  const product = CATALOG.find((p) => p.id === id || p.model.toLowerCase() === String(id).toLowerCase());
  if (!product) throw new Error(`产品库里没有 ${id}，可选：${CATALOG.map((p) => p.model).join('、')}`);
  const vehicle = await loadVehicle(product);
  app.vehicle?.root.removeFromParent();
  app.product = product;
  app.vehicle = vehicle;
  if (!app.states.has(product.id)) app.states.set(product.id, Object.fromEntries(Object.entries(product.params).map(([k, p]) => [k, p.nominal])));
  site.setVehicle(vehicle.root, product, stateOf());
  applyBands(product, stateOf());
  app.refresh();
  return product;
};

// Validates every value against the product library before touching anything.
app.setVehicleParams = (values) => {
  const product = app.product;
  const next = { ...stateOf() };
  for (const [key, value] of Object.entries(values)) {
    const param = product.params[key];
    if (!param) throw new Error(`${product.model} 没有参数 ${key}`);
    if (!(value >= param.min && value <= param.max)) throw new Error(`${product.model} ${param.label} ${value} mm 超出产品库范围 ${param.min}–${param.max} mm`);
    next[key] = value;
  }
  app.states.set(product.id, next);
  site.setVehicle(app.vehicle.root, product, next);
  applyBands(product, next);
  app.refresh();
  return next;
};

app.vehicleState = () => ({ model: app.product?.model, ...stateOf() });

// ---------------------------------------------------------------- camera

const fly = { active: false };
function flyTo(target, position, duration = 0.8) {
  Object.assign(fly, { active: true, t: 0, duration, track: null, fromTarget: controls.target.clone(), fromPos: camera.position.clone(), toTarget: target.clone(), toPos: position.clone() });
}

// The canvas spans the whole window but panels float over its edges, so the camera
// is centred on the free area between them (setViewOffset) and fits into that area.
const free = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
function measureFree() {
  const W = innerWidth;
  const H = innerHeight;
  if (document.body.classList.contains('clean')) {
    Object.assign(free, { x: 0, y: 0, w: W, h: H, W, H });
    camera.setViewOffset(W, H, 0, 0, W, H);
    return;
  }
  const open =(sel) => [...document.querySelectorAll(`${sel} .panel`)].some((p) => !p.classList.contains('min-on') && !p.classList.contains('viewbar'));
  const l = open('.left') ? document.querySelector('.left').getBoundingClientRect().right : 0;
  const r = open('.right') ? document.querySelector('.right').getBoundingClientRect().left : W;
  const t = document.querySelector('.top').getBoundingClientRect().bottom;
  const b = document.querySelector('.bottom').getBoundingClientRect().top;
  Object.assign(free, { x: l, y: t, w: Math.max(200, r - l), h: Math.max(160, b - t), W, H });
  const dx = free.x + free.w / 2 - W / 2;
  const dy = free.y + free.h / 2 - H / 2;
  camera.setViewOffset(W, H, -dx, -dy, W, H);
}

app.flyTo = (target, position, duration) => flyTo(target, position, duration);

function fitDistance(w, h) {
  const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanV = tv * (free.h / free.H);
  const tanH = tv * camera.aspect * (free.w / free.W);
  return Math.max(w / 2 / tanH, h / 2 / tanV);
}

const hookWorld = () => new THREE.Vector3(site.cranePose.x / 1000, site.cranePose.z / 1000, -site.cranePose.y / 1000);
// What the tracking views lock onto: the AGV body, or a point between the hook and the floor
// so the coil and the hook fit in the frame. While an AGV waits near the hook (hand-over at
// H-01) the aim slides towards it so both stay in shot.
const subjectOf = (mode) => {
  if (mode === 'follow') return site.carrier.position.clone().setY(0.8);
  const h = hookWorld().setY(3);
  const agv = site.carrier.position.clone().setY(1);
  const w = THREE.MathUtils.clamp(1 - h.distanceTo(agv) / 16, 0, 1) * 0.5;
  return h.lerp(agv, w);
};
// Columns and racks line the walls, so the AGV camera sits on the building-centre side of the
// subject and looks outwards. The crane camera looks along the runway (world x) instead: the
// bridge girder spans across the bay, so looking along it would put the girder in the way.
function trackOffset(mode) {
  const { centre } = site.built;
  const s = subjectOf(mode);
  const toCentre = new THREE.Vector3(centre.x / 1000 - s.x, 0, -centre.y / 1000 - s.z);
  let dir, d, h;
  if (mode === 'follow') {
    dir = toCentre.length() < 3 ? new THREE.Vector3(-0.5, 0, 0.85) : toCentre.normalize();
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.45); // a little off-axis so it reads as 3D
    [d, h] = [9, 8];
  } else {
    // Stay almost in the hook's own aisle: a row of columns runs parallel to the runway.
    dir = new THREE.Vector3(Math.sign(toCentre.x) || -1, 0, 0.12 * (Math.sign(toCentre.z) || 1)).normalize();
    [d, h] = [14, 10];
  }
  return dir.multiplyScalar(d).setY(h);
}

app.setView = (mode, opts = {}) => {
  app.view = mode;
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === mode);
  const { centre, size } = site.built;
  const c = new THREE.Vector3(centre.x / 1000, 0, -centre.y / 1000);
  if (mode === 'overview') {
    const dir = new THREE.Vector3(-0.26, 0.66, 0.7).normalize();
    // Fit the footprint's diagonal so the site stays framed while it slowly orbits.
    const diag = Math.hypot(size.x, size.y);
    flyTo(c, c.clone().addScaledVector(dir, fitDistance(diag * 1.05, diag * 0.85)));
  } else if (mode === 'top') {
    flyTo(c, new THREE.Vector3(c.x, fitDistance(size.x * 1.04, size.y * 1.04), c.z + 0.01));
  } else if (mode === 'follow' || mode === 'crane') {
    // The flight keeps re-aiming at the moving subject, so it lands on it, not where it was.
    const t = subjectOf(mode);
    const offset = trackOffset(mode);
    flyTo(t, t.clone().add(offset));
    fly.track = offset;
  } else if (mode === 'point') {
    const p = site.findPoint(opts.id);
    const t = new THREE.Vector3(p.x / 1000, 1, -p.y / 1000);
    flyTo(t, t.clone().add(new THREE.Vector3(-10, 12, 14)));
  }
};

// ---------------------------------------------------------------- labels

const labelsEl = $('labels');
const pins = new Map();
function pin(key, cls, html) {
  let el = pins.get(key);
  if (!el) {
    el = document.createElement('div');
    labelsEl.append(el);
    pins.set(key, el);
  }
  el.className = `pin ${cls}`;
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  return el;
}

const ROLE_COLORS = { pick: '#2B7DE9', handoff: '#D7000F', drop: '#1F2329', charge: '#2EA121', marker: '#F5B800' };
const projected = new THREE.Vector3();
function place(el, v) {
  projected.copy(v).project(camera);
  const visible = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
  el.style.display = visible ? '' : 'none';
  el.style.left = `${(projected.x * 0.5 + 0.5) * viewSize.w}px`;
  el.style.top = `${(-projected.y * 0.5 + 0.5) * viewSize.h}px`;
}

function roleOf(point) {
  const r = site.roles;
  if (point.id === r.pick) return ['pick', '上料位'];
  if (point.id === r.handoff) return ['handoff', '吊装交接点'];
  if (point.id === r.drop) return ['drop', '成品区'];
  if (point.id === r.home) return ['charge', '充电位'];
  return [point.role === 'marker' ? 'marker' : point.role, point.name];
}

function updateLabels() {
  const seen = new Set();
  const r = site.roles;
  for (const point of site.points()) {
    const keep = [r.pick, r.handoff, r.drop, r.home].includes(point.id) || site.extras.some((e) => e.id === point.id);
    if (!keep) continue;
    const [role, name] = roleOf(point);
    const key = `p:${point.id}`;
    seen.add(key);
    const el = pin(key, `${role === 'handoff' ? 'handoff' : ''} ${app.newPoints.has(point.id) ? 'new' : ''}`, `<span class="lab">${point.id} ${name}</span><span class="dot" style="background:${ROLE_COLORS[role] ?? '#1F2329'}"></span>`);
    place(el, new THREE.Vector3(point.x / 1000, role === 'handoff' ? 2.6 : 0.3, -point.y / 1000));
  }
  const step = site.stepAt();
  const craneBusy = site.cranePose.segment;
  const crane = pin('crane', 'dev', `<span class="lab">行车 #1 · ${craneBusy ? craneBusy.label : '待机'}</span>`);
  place(crane, new THREE.Vector3(site.cranePose.x / 1000, 13.2, -site.cranePose.y / 1000));
  seen.add('crane');
  const agvText = site.pose?.step?.type === 'run' ? (site.pose.step.loaded ? '载卷运送' : '空车行驶') : site.pose?.step?.kind === 'charge' ? '充电' : site.pose?.step?.kind === 'load' ? '接卷' : site.pose?.step?.kind === 'unload' ? '放卷' : '定位';
  const agv = pin('agv', 'dev agv', `<span class="lab">${app.product?.model ?? 'AGV'} · ${agvText}</span>`);
  place(agv, site.carrier.position.clone().setY(2.4));
  seen.add('agv');
  for (const p of app.library?.placed.values() ?? []) {
    const key = `a:${p.asset.id}`;
    seen.add(key);
    place(pin(key, 'asset', `<span class="lab">${p.asset.name}</span>`), new THREE.Vector3(p.x / 1000, p.height + 0.6, -p.y / 1000));
  }
  for (const hook of app.labelHooks ?? []) hook({ pin, place, seen });
  for (const [key, el] of pins) if (!seen.has(key)) {
    el.remove();
    pins.delete(key);
  }
  void step;
}

// ---------------------------------------------------------------- HUD

const setHtml = (id, html) => {
  const el = $(id);
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
};
const metric = (label, value, unit = '', txt = false) => `<div><small>${label}</small><b class="${txt ? 'txt' : ''}">${value}${unit ? `<em>${unit}</em>` : ''}</b></div>`;

// Right column device card: the step in progress and the live readings of its device.
function updateHud() {
  const t = site.time;
  const step = site.stepAt(t);
  const w = site.window;
  const crane = step.device === '行车';
  $('hudNo').textContent = String(step.n).padStart(2, '0');
  $('hudTitle').textContent = step.title;
  $('hudDev').textContent = crane ? '行车 #1' : app.product?.model ?? 'AGV';
  $('hudDev').className = `badge ${crane ? 'crane' : ''}`;
  $('hudWindow').textContent = `${fmtTime(step.t0)} – ${fmtTime(step.t1)}`;
  $('hudBar').style.width = `${Math.min(100, Math.max(0, ((t - step.t0) / step.duration) * 100))}%`;
  const cp = site.cranePose;
  setHtml('hudRow', crane
    ? metric('钩高', (cp.z / 1000).toFixed(2), 'm') + metric('大车 X', (cp.x / 1000).toFixed(1), 'm') + metric('小车 Y', (cp.y / 1000).toFixed(1), 'm') + metric('动作', cp.segment?.label ?? '待机', '', true)
    : metric('车速', (Math.abs(site.pose.speed) / 1000).toFixed(2), 'm/s') + metric('台数', site.agvCount, '台') + metric('状态', site.status().text, '', true) + metric('本步用时', step.duration.toFixed(0), 's'));
  setHtml('hudChips', `<span class="chip">钢卷 Φ${COIL.diameter / 1000} m · ${COIL.tonnes} t</span><span class="chip">${w ? '分步播放' : '全流程'}</span>`);
  const coil = site.coilPosition();
  setHtml('coord', coil
    ? `钢卷 X <b class="num">${Math.round(coil.x).toLocaleString('fr-FR')}</b> Y <b class="num">${Math.round(coil.y).toLocaleString('fr-FR')}</b> Z <b class="num">${Math.round(coil.z).toLocaleString('fr-FR')}</b> mm`
    : '');
  $('clock').textContent = fmtTime(t);
  $('clockTotal').textContent = `/ ${fmtTime(site.duration)}`;
  const playing = site.playing;
  $('playBtn').textContent = playing ? '❚❚ 暂停' : '▶ 播放';
  $('playBtn').classList.toggle('paused', !playing);
  $('runSt').textContent = playing ? '运行中' : '已暂停';
  $('runSt').classList.toggle('pause', !playing);
  $('allBtn').classList.toggle('on', !w);
}

// ---------------------------------------------------------------- step bar

const STEP_TAB = { 1: 'points', 2: 'params', 3: 'process', 4: 'gantt', 5: 'eff', 6: 'travel', 7: 'later' };
app.setStep = (n) => {
  if (app.step !== n && app.step !== 7) app.done.add(app.step);
  app.step = n;
  for (const b of document.querySelectorAll('.step')) {
    const k = Number(b.dataset.step);
    b.classList.toggle('cur', k === n);
    b.classList.toggle('done', k !== n && app.done.has(k));
  }
  app.setTab(STEP_TAB[n], n !== 4 || app.drawer);
  if (n === 6) {
    site.setTravelVisible(true);
    $('travelBtn').classList.add('on');
  }
};

// The tables live in a drawer over the 3D view; picking a tab opens it, picking it again closes it.
app.setTab = (tab, open = true) => {
  app.tab = tab;
  app.drawer = open;
  $('drawer').hidden = !open;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', open && b.dataset.tab === tab);
  renderDock();
};

// ---------------------------------------------------------------- dock

const pct = (t) => `${(t / site.duration) * 100}%`;

function ganttHtml() {
  const D = site.duration;
  const stepSize = [10, 20, 30, 60, 120].find((s) => D / s <= 9) ?? 300;
  const ticks = [];
  for (let s = 0; s <= D + 1e-6; s += stepSize) ticks.push(`<span style="left:${pct(s)}">${s}${s === 0 ? 's' : ''}</span>`);
  const blocks = (lane) => lane.map((b) => `<span class="blk ${b.kind}" data-t="${b.t0}" title="${b.label} ${(b.t1 - b.t0).toFixed(1)} s" style="left:${pct(b.t0)};width:${pct(b.t1 - b.t0)}">${b.label} ${(b.t1 - b.t0).toFixed(0)}s</span>`).join('');
  const cur = site.window?.step;
  const band = site.process.steps.map((s) => {
    const row = s.device === '行车' ? 22 : 0;
    return `<button data-play="${s.n}" class="${cur === s.n ? 'cur' : ''}" style="left:${pct(s.t0)};width:${pct(s.duration)};top:${row}px">${'①②③④⑤'[s.n - 1]} ${s.title.replace(/^.*? /, '')} ${s.duration.toFixed(0)}s</button>`;
  }).join('');
  const span = (site.cranePlan && Math.abs(site.runway.high - site.runway.low) / 1000).toFixed(2);
  return `<div class="ganttwrap" id="gantt">
    <div class="ruler"><span></span><div class="ticks num">${ticks.join('')}</div></div>
    <div class="stepsband"><span style="font-size:12px;color:var(--ink3)">工序</span><div class="sb">${band}</div></div>
    <div class="seq"><div class="who">${app.product?.model ?? 'AGV'}<small>${app.agvNote ?? '载重 30 t'}</small></div><div class="lane" data-lane>${blocks(site.gantt.agv)}</div></div>
    <div class="seq"><div class="who">行车 #1<small>跨度 ${span} m</small></div><div class="lane" data-lane>${blocks(site.gantt.crane)}</div></div>
    <div class="playhead" id="playhead"><span id="phLabel">00:00</span></div>
  </div>
  <div class="glegend"><span><i class="mv"></i>行走 / 运行</span><span><i class="pk"></i>取放 / 夹紧</span><span><i class="lf"></i>起升 / 下降</span><span><i class="ch"></i>充电</span><span><i class="id" style="border:1px dashed #C9CDD4"></i>空闲</span></div>`;
}

function updatePlayhead() {
  const ph = $('playhead');
  if (!ph) return;
  const f = site.time / site.duration;
  ph.style.left = `calc(92px + (100% - 92px) * ${f})`;
  $('phLabel').textContent = fmtTime(site.time);
}

function pointsHtml() {
  const rows = site.points().map((p) => {
    const [, name] = roleOf(p);
    const roleText = p.source === 'CAD'
      ? { pick: 'AGV 取货', drop: 'AGV 放货', charge: '充电' }[p.role]
      : { handoff: 'AGV 放货 / 行车取货', drop: '行车放卷', marker: '标记' }[p.role];
    return `<tr class="clickable ${app.newPoints.has(p.id) ? 'cur' : ''}" data-point="${p.id}"><td><b>${p.id}</b></td><td>${name}</td><td>${roleText}</td><td class="num">${Math.round(p.x)}</td><td class="num">${Math.round(p.y)}</td><td>${p.source === 'CAD' ? '<span class="src">CAD · AGV-STAT</span>' : '<span class="src" style="color:#B26A00">对话添加</span>'}</td></tr>`;
  });
  const c = site.coverage();
  return `<table class="t"><thead><tr><th>点位</th><th>名称</th><th>作业</th><th>X mm</th><th>Y mm</th><th>来源</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

const SLIDERS = [
  { key: 'agvCount', label: 'AGV 台数', min: 1, max: 4, step: 1, unit: '台', get: () => site.agvCount, set: (v) => site.setAgvCount(v) },
  { key: 'agvSpeed', label: 'AGV 主线速度', min: 0.5, max: 1.5, step: 0.05, unit: 'm/s', get: () => site.motion.laneSpeed / 1000, set: (v) => site.setMotion({ agvSpeed: v * 1000 }) },
  { key: 'bridge', label: '行车 大车速度', min: 20, max: 80, step: 1, unit: 'm/min', get: () => site.craneMotion.bridge.speed * 0.06, set: (v) => site.setMotion({ bridgeSpeed: v / 0.06 }) },
  { key: 'trolley', label: '行车 小车速度', min: 10, max: 45, step: 1, unit: 'm/min', get: () => site.craneMotion.trolley.speed * 0.06, set: (v) => site.setMotion({ trolleySpeed: v / 0.06 }) },
  { key: 'hoist', label: '行车 起升速度', min: 4, max: 20, step: 0.5, unit: 'm/min', get: () => site.craneMotion.hoist.speed * 0.06, set: (v) => site.setMotion({ hoistSpeed: v / 0.06 }) },
  { key: 'travel', label: '吊运高度（钩心）', min: 3, max: 7.5, step: 0.1, unit: 'm', get: () => site.craneMotion.travelHeight / 1000, set: (v) => site.setMotion({ travelHeight: v * 1000 }) },
];

function paramsHtml() {
  const product = app.product;
  const state = stateOf();
  const prod = CATALOG.map((p) => `<button data-product="${p.id}" class="${p.id === product.id ? 'on' : ''}">${p.model}</button>`).join('');
  const vehicle = Object.entries(product.params).map(([k, p]) => `<div class="param"><label>${p.label}<b class="num">${Math.round(state[k])} mm</b></label><input type="range" data-vparam="${k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${state[k]}" title="产品库范围 ${p.min}–${p.max} mm"></div>`).join('');
  const motion = SLIDERS.map((s) => `<div class="param"><label>${s.label}<b class="num">${Number(s.get().toFixed(2))} ${s.unit}</b></label><input type="range" data-mparam="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.get()}" title="${s.min}–${s.max} ${s.unit}"></div>`).join('');
  return `<div class="prod">${prod}</div><div class="params">${vehicle}${motion}
  <div class="param"><label>起重机跨度<b class="num">${(Math.abs(site.runway.high - site.runway.low) / 1000).toFixed(2)} m</b></label><label>吊具 / 卷材<b>C 形钩 · Φ${COIL.diameter / 1000} m · ${COIL.tonnes} t</b></label></div></div>`;
}

function processHtml() {
  const cur = site.stepAt().n;
  const rows = site.process.steps.map((s) => `<tr class="clickable ${s.n === cur ? 'cur' : ''}" data-play="${s.n}"><td>${s.n}</td><td>${s.device === 'AGV' ? app.product?.model ?? 'AGV' : '行车 #1'}</td><td><b>${s.title}</b><div class="muted" style="font-size:11.5px">${s.detail}</div></td><td class="num">${fmtTime(s.t0)}–${fmtTime(s.t1)}</td><td class="num">${s.duration.toFixed(1)} s</td></tr>`).join('');
  return `<table class="t"><thead><tr><th>#</th><th>设备</th><th>动作</th><th>时段</th><th>用时</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function meter(label, value, color) {
  return `<div><div class="line"><span>${label}</span><span class="num">${(value * 100).toFixed(0)}%</span></div><div class="meter"><span style="width:${Math.min(100, value * 100)}%;background:${color}"></span></div></div>`;
}

export function effHtml(eff = site.efficiency, shift = app.shift) {
  const t = eff.target;
  const verdict = t ? (eff.meets ? `<span class="good num">${eff.takt.toFixed(1)} s（目标 ${t} s，达到）</span>` : `<span class="bad num">${eff.takt.toFixed(1)} s（目标 ${t} s，差 ${eff.gap.toFixed(1)} s）</span>`) : `<span class="num">${eff.takt.toFixed(1)} s</span>`;
  return `<div class="eff">
    <div class="line"><span>单件节拍</span>${verdict}</div>
    <div class="line"><span>AGV 单车循环 / 台数</span><span class="num">${eff.agvCycle.toFixed(1)} s / ${eff.agvCount} 台</span></div>
    <div class="line"><span>行车单循环</span><span class="num">${eff.craneCycle.toFixed(1)} s</span></div>
    <div class="line"><span>每小时</span><span class="num">${eff.perHour.toFixed(1)} 件</span></div>
    <div class="line"><span>瓶颈</span><span>${eff.bottleneck}</span></div>
    ${meter('AGV 利用率', eff.utilization.agv, 'var(--blue)')}
    ${meter('行车 #1 利用率', eff.utilization.crane, 'var(--red)')}
    ${eff.advice ? `<div class="line"><span>建议</span><span>${eff.advice}</span></div>` : ''}
    ${shift ? `<div class="line"><span>${shift.hours} 小时班</span><span class="num"><b>${shift.pieces} 件</b>（${shift.perHour.toFixed(1)} 件/h）</span></div>` : ''}
  </div>`;
}

function travelHtml() {
  const tr = site.travel;
  const m = (mm) => (mm / 1000).toFixed(1);
  return `<table class="t"><thead><tr><th>设备 / 轴</th><th>单循环累计</th><th>最大单程</th></tr></thead><tbody>
    <tr><td>${app.product?.model ?? 'AGV'} 载卷</td><td class="num">${m(tr.agv.loaded)} m</td><td class="num" rowspan="2">${m(tr.agv.longest)} m</td></tr>
    <tr><td>${app.product?.model ?? 'AGV'} 空车</td><td class="num">${m(tr.agv.empty)} m</td></tr>
    <tr><td>行车 大车 (X)</td><td class="num">${m(tr.crane.bridge)} m</td><td class="num">${m(tr.crane.longest.x)} m</td></tr>
    <tr><td>行车 小车 (Y)</td><td class="num">${m(tr.crane.trolley)} m</td><td class="num">${m(tr.crane.longest.y)} m</td></tr>
    <tr><td>行车 起升 (Z)</td><td class="num">${m(tr.crane.hoist)} m</td><td class="num">${m(tr.crane.longest.z)} m</td></tr>
    <tr><td>钩心高度</td><td class="num" colspan="2">最低 ${m(tr.crane.zMin)} m · 最高 ${m(tr.crane.zMax)} m</td></tr>
  </tbody></table>
  <div class="acts" style="padding:8px 0 0"><button class="${site.travelVisible ? '' : 'pri'}" data-travel>${site.travelVisible ? '隐藏轨迹线' : '在视口显示轨迹线'}</button></div>`;
}

function laterHtml() {
  return `<div class="later-box"><h3>第 7 步 · 出图下发（后期）</h3>
  <p>方案阶段结束后，把选定产品自动生成结构图纸 → 三维模型 → CAD 生产图纸下发生产；同时生成工艺图纸（涂装、表面花纹 / 图案、文字、涂漆）。目标是从客户方案一路贯通到生产，人在大屏上点数字确认。</p>
  <p class="muted">本轮只放入口，见 PRD R14。需要先确定：出图标准（GB / 企业标准）、图框模板、下发目标系统（PDM / ERP / MES）。</p></div>`;
}

function renderDock() {
  if (!site.process || !app.product) return;
  const body = { points: pointsHtml, params: paramsHtml, process: processHtml, gantt: ganttHtml, eff: () => effHtml(), travel: travelHtml, later: laterHtml, ...(app.dockTabs ?? {}) }[app.tab]();
  $('dockMain').innerHTML = body;
  updatePlayhead();
}
app.renderDock = renderDock;

function renderKpis() {
  if (!site.efficiency) return;
  const eff = site.efficiency;
  const shift = app.shift ?? simulateShift(eff, site.duration, 8);
  const cls = eff.target ? (eff.meets ? 'good' : 'bad') : '';
  $('kpis').innerHTML = `
    <div class="${cls}"><small>单件节拍${eff.target ? ` · 目标 ${eff.target}` : ''}</small><b>${eff.takt.toFixed(0)}<em>s</em></b></div>
    <div><small>${shift.hours} 小时班产</small><b>${shift.pieces}<em>件</em></b></div>
    <div><small>AGV / 瓶颈</small><b>${eff.agvCount}<em>台 · ${eff.bottleneck}</em></b></div>
    <div><small>AGV 利用率</small><b>${(eff.utilization.agv * 100).toFixed(0)}<em>%</em></b></div>
    <div><small>行车利用率</small><b>${(eff.utilization.crane * 100).toFixed(0)}<em>%</em></b></div>`;
}
app.renderKpis = renderKpis;

// Left column: the five process steps, current one highlighted with live progress.
const DEV_CLASS = { AGV: '', 行车: 'crane' };
function renderProcList() {
  if (!site.process) return;
  $('procTotal').textContent = fmtTime(site.duration);
  $('procList').innerHTML = site.process.steps.map((s) => `<li data-play="${s.n}"><span class="n">${String(s.n).padStart(2, '0')}</span><b><span class="dev ${DEV_CLASS[s.device] ?? ''}">${s.device === 'AGV' ? 'AGV' : '行车'}</span>${s.title}</b><small class="num">${fmtTime(s.t0)} – ${fmtTime(s.t1)}</small><span class="d">${s.duration.toFixed(0)}s</span><i class="pg"></i></li>`).join('');
}
const progressOf = (s) => Math.min(100, Math.max(0, ((site.time - s.t0) / s.duration) * 100));
function updateProcList() {
  const n = site.stepAt().n;
  for (const li of $('procList').children) {
    const k = Number(li.dataset.play);
    li.classList.toggle('cur', k === n);
    li.classList.toggle('done', k < n);
    li.querySelector('.pg').style.width = k === n ? `${progressOf(site.process.steps[k - 1])}%` : '0';
  }
}
$('procList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-play]');
  if (li) app.play({ mode: 'step', step: Number(li.dataset.play) });
});

// Bottom timeline: one segment per step, sized by its duration, plus a scrubber over the cycle.
function renderTimeline() {
  if (!site.process) return;
  $('tl').innerHTML = site.process.steps.map((s) => `<button data-play="${s.n}" class="${s.device === '行车' ? 'crane' : 'agv'}" style="flex:${s.duration} 1 0" title="${s.title} · ${s.duration.toFixed(0)} s"><i></i><span>${'①②③④⑤⑥⑦⑧⑨'[s.n - 1] ?? s.n} ${s.title} · ${s.duration.toFixed(0)}s</span></button>`).join('');
}
let scrubbing = false;
function updateTimeline() {
  const n = site.stepAt().n;
  for (const b of $('tl').children) {
    const k = Number(b.dataset.play);
    b.classList.toggle('cur', k === n);
    b.classList.toggle('past', k < n);
    b.firstChild.style.width = k === n ? `${progressOf(site.process.steps[k - 1])}%` : '';
  }
  if (!scrubbing) $('scrub').value = String(Math.round((site.time / site.duration) * 1000));
}
$('tl').addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (b) app.play({ mode: 'step', step: Number(b.dataset.play) });
});
$('scrub').addEventListener('input', (e) => {
  scrubbing = true;
  app.seek((Number(e.target.value) / 1000) * site.duration);
});
$('scrub').addEventListener('change', () => { scrubbing = false; });

app.refresh = () => {
  renderDock();
  renderKpis();
  renderProcList();
  renderTimeline();
  app.save?.();
};

// Short status line over the viewport.
app.toast = (text, err = false) => {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast${err ? ' err' : ''}`;
  el.hidden = false;
  clearTimeout(app.toast.timer);
  app.toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
};

// ---------------------------------------------------------------- playback

app.play = ({ mode = 'all', step, speed } = {}) => {
  if (speed) {
    site.speed = speed;
    markSpeed();
  }
  if (mode === 'pause') site.playing = false;
  else if (mode === 'resume') site.playing = true;
  else if (mode === 'step') {
    site.playWindow(step);
    site.renderPose(); // move the AGV / crane to the step's start before aiming the camera
    app.setView(site.process.steps[step - 1].device === '行车' ? 'crane' : 'follow');
  } else if (mode === 'next') {
    const cur = site.window?.step ?? site.stepAt().n;
    const next = (cur % site.process.steps.length) + 1;
    return app.play({ mode: 'step', step: next });
  } else {
    site.playWindow(null);
    if (mode === 'restart' || mode === 'all') site.time = 0;
    app.setView('overview');
  }
  renderDock();
  return { playing: site.playing, window: site.window, speed: site.speed };
};

app.seek = (t) => {
  site.window = null;
  site.time = Math.max(0, Math.min(t, site.duration - 0.01));
  site.renderPose();
};

site.onWindowEnd = () => renderDock();

// ---------------------------------------------------------------- events

document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => app.setStep(Number(b.dataset.step))));
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => app.setTab(b.dataset.tab, !(app.drawer && app.tab === b.dataset.tab))));
$('drawerClose').addEventListener('click', () => app.setTab(app.tab, false));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => app.setView(b.dataset.view)));
$('playBtn').addEventListener('click', () => {
  if (!site.playing && site.window && site.time >= site.window.t1) site.time = site.window.t0;
  site.playing = !site.playing;
});
function markSpeed() {
  for (const b of $('speeds').children) b.classList.toggle('on', Number(b.dataset.speed) === site.speed);
}
$('speeds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-speed]');
  if (!b) return;
  site.speed = Number(b.dataset.speed);
  markSpeed();
});
$('allBtn').addEventListener('click', () => app.play({ mode: 'all' }));
$('nextBtn').addEventListener('click', () => app.play({ mode: 'next' }));
$('travelBtn').addEventListener('click', () => {
  site.setTravelVisible(!site.travelVisible);
  $('travelBtn').classList.toggle('on', site.travelVisible);
  if (app.tab === 'travel') renderDock();
});
// Idle orbit around the site centre in overview; any drag stops it, the button toggles it.
app.autoRotate = true;
const setRotate = (on) => {
  app.autoRotate = on;
  $('rotateBtn').classList.toggle('on', on);
};
$('rotateBtn').addEventListener('click', () => setRotate(!app.autoRotate));
$('labelBtn').addEventListener('click', () => {
  document.body.classList.toggle('nolabels');
  $('labelBtn').classList.toggle('on', !document.body.classList.contains('nolabels'));
});
$('resetBtn').addEventListener('click', () => {
  app.play({ mode: 'all' });
  setRotate(true);
});

// Panels fold to their header; the camera re-centres on the space they free up.
const relayout = () => {
  resize();
  if (app.view === 'overview' || app.view === 'top') app.setView(app.view);
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-min]');
  if (!b) return;
  b.closest('.panel').classList.toggle('min-on');
  relayout();
});
// One-click clean screen: hide every panel, keep only the 3D site.
const setClean = (on) => {
  document.body.classList.toggle('clean', on);
  relayout();
};
$('clearBtn').addEventListener('click', () => setClean(true));
$('restoreBtn').addEventListener('click', () => setClean(false));
addEventListener('keydown', (e) => {
  if (e.target.closest('textarea,input,select')) return;
  if (e.key === 'h' || e.key === 'H') setClean(!document.body.classList.contains('clean'));
  else if (e.key === 'Escape' && document.body.classList.contains('clean')) setClean(false);
  else if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
});

// Record the 3D view to a WebM file.
app.record = (on = !app.recorder) => {
  if (on && !app.recorder) {
    const chunks = [];
    const type = ['video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 8e6 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const a = document.createElement('a');
      a.download = `卫华方案-v${app.version}.webm`;
      a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    rec.start(500);
    app.recorder = rec;
    app.toast?.('开始录制，再点一次停止并下载');
  } else if (!on && app.recorder) {
    app.recorder.stop();
    app.recorder = null;
  }
  $('recBtn').classList.toggle('on', Boolean(app.recorder));
  $('recBtn').textContent = app.recorder ? '● 停止' : '录制';
  return Boolean(app.recorder);
};
$('recBtn').addEventListener('click', () => app.record());

$('shotBtn').addEventListener('click', () => {
  renderer.render(site.scene, camera);
  const a = document.createElement('a');
  a.download = `卫华方案-v${app.version}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
});

$('dockMain').addEventListener('click', async (e) => {
  const play = e.target.closest('[data-play]');
  if (play) return app.play({ mode: 'step', step: Number(play.dataset.play) });
  const blk = e.target.closest('.blk');
  if (blk) return app.seek(Number(blk.dataset.t) + 0.01);
  const lane = e.target.closest('[data-lane]');
  if (lane) {
    const r = lane.getBoundingClientRect();
    return app.seek(((e.clientX - r.left) / r.width) * site.duration);
  }
  const point = e.target.closest('[data-point]');
  if (point) return app.setView('point', { id: point.dataset.point });
  const product = e.target.closest('[data-product]');
  if (product) {
    await app.selectProduct(product.dataset.product);
    app.bump();
    return undefined;
  }
  if (e.target.closest('[data-travel]')) $('travelBtn').click();
  return undefined;
});

$('dockMain').addEventListener('input', (e) => {
  const v = e.target.dataset.vparam;
  const m = e.target.dataset.mparam;
  if (v) {
    app.setVehicleParams({ [v]: Number(e.target.value) });
  } else if (m) {
    SLIDERS.find((s) => s.key === m).set(Number(e.target.value));
    app.refresh();
  }
});
$('dockMain').addEventListener('change', (e) => {
  if (e.target.dataset.vparam || e.target.dataset.mparam) app.bump();
});

// ---------------------------------------------------------------- loop

// Cached so per-frame label placement never forces a layout.
const viewSize = { w: 1, h: 1 };
function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  // A minimized or hidden window reports 0×0; resizing to that would make the camera aspect NaN.
  if (!w || !h) return;
  viewSize.w = w;
  viewSize.h = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  measureFree();
  camera.updateProjectionMatrix();
  site.resize(w, h);
}
new ResizeObserver(resize).observe(view);

controls.addEventListener('start', () => {
  fly.active = false;
  setRotate(false);
});
const clock = new THREE.Clock();
let lastStep = 0;

// Shadows: every other frame while the timeline plays, a few times a second otherwise
// (enough for edits, uploads and the crane being dragged around).
let shadowAge = Infinity;
let shadowFrame = 0;
function updateShadows(delta) {
  shadowAge += delta;
  shadowFrame++;
  if (site.playing ? shadowFrame % 2 === 0 : shadowAge > 0.25) {
    renderer.shadowMap.needsUpdate = true;
    shadowAge = 0;
  }
}

// Step the pixel ratio down when the frame rate stays low and back up when there is headroom.
// Ignores the first seconds after boot (shader compiles), and stops retrying a ratio that failed twice.
const pixel = { ratio: QUALITY.pixelRatio, floor: Math.min(devicePixelRatio, 1) * 0.75, frames: 0, since: 0, bad: 0, good: 0, failed: {} };
function adaptPixelRatio() {
  const now = performance.now();
  if (!pixel.since) pixel.since = now + 3000;
  if (now < pixel.since) return;
  pixel.frames++;
  const span = now - pixel.since;
  if (span < 1000) return;
  const fps = (pixel.frames * 1000) / span;
  pixel.frames = 0;
  pixel.since = now;
  if (span > 1500 || document.hidden) return; // the tab was in the background
  pixel.bad = fps < 42 ? pixel.bad + 1 : 0;
  pixel.good = fps > 57 ? pixel.good + 1 : 0;
  let next = pixel.ratio;
  if (pixel.bad >= 2 && pixel.ratio > pixel.floor) {
    pixel.failed[pixel.ratio] = (pixel.failed[pixel.ratio] ?? 0) + 1;
    next = Math.max(pixel.floor, pixel.ratio - 0.25);
  } else if (pixel.good >= 5 && pixel.ratio < QUALITY.pixelRatio) {
    const up = Math.min(QUALITY.pixelRatio, pixel.ratio + 0.25);
    if ((pixel.failed[up] ?? 0) < 2) next = up;
  }
  if (next === pixel.ratio) return;
  pixel.ratio = next;
  pixel.bad = pixel.good = 0;
  renderer.setPixelRatio(next);
}

// Compile every shader and upload every texture up front (the roof included, which is hidden
// from the start view), so the first look inside the hall does not stall.
async function warmUp() {
  const roof = site.built?.roof;
  const shown = roof?.visible;
  if (roof) roof.visible = true;
  try {
    await renderer.compileAsync(site.scene, camera);
  } catch (error) {
    console.warn('shader warm-up', error);
  }
  if (roof) roof.visible = shown;
  for (const texture of Object.values(site.textures ?? {})) renderer.initTexture(texture);
}
let manual = false;
// Debug: step frames by hand when the tab is hidden and rAF is paused.
// ResizeObserver is paused too, so re-measure first.
window.__frames = (n = 1) => { resize(); manual = true; for (let i = 0; i < n; i++) frame(1 / 30); manual = false; };
function frame(dt) {
  const delta = dt ?? Math.min(clock.getDelta(), 0.1);
  if (site.timeline && app.product) {
    site.update(delta, camera);
    if (fly.active) {
      if (fly.track) {
        fly.toTarget.copy(subjectOf(app.view));
        fly.toPos.copy(fly.toTarget).add(fly.track);
      }
      fly.t += delta / fly.duration;
      const k = THREE.MathUtils.smootherstep(Math.min(fly.t, 1), 0, 1);
      controls.target.lerpVectors(fly.fromTarget, fly.toTarget, k);
      camera.position.lerpVectors(fly.fromPos, fly.toPos, k);
      if (fly.t >= 1) fly.active = false;
    } else if (app.view === 'follow' || app.view === 'crane') {
      // Lock the orbit centre onto the subject; the user can still orbit and zoom around it.
      const moved = subjectOf(app.view).sub(controls.target);
      controls.target.add(moved);
      camera.position.add(moved);
    }
    controls.autoRotate = app.autoRotate && app.view === 'overview' && !fly.active;
    controls.update(delta);
    fitDepthRange(camera, controls.target);
    updateShadows(delta);
    for (const hook of app.frameHooks ?? []) hook(delta);
    renderer.render(site.scene, camera);
    if (!manual) adaptPixelRatio();
    updateLabels();
    updateHud();
    updatePlayhead();
    updateProcList();
    updateTimeline();
    const n = site.stepAt().n;
    if (n !== lastStep && app.tab === 'process') renderDock();
    lastStep = n;
  }
  if (!manual) requestAnimationFrame(() => frame());
}

// ---------------------------------------------------------------- boot

async function boot() {
  const loading = $('loading');
  try {
    loading.textContent = '正在加载环境与材质…';
    await site.loadEnvironment();
    loading.textContent = '正在解析 CAD 平面图，搭建厂房…';
    const text = await fetch(SAMPLE_PLAN).then((r) => {
      if (!r.ok) throw new Error(`读不到示例平面图（${r.status}）`);
      return r.text();
    });
    await site.loadBase(text, '模拟平面图 sample-plant.dxf');
    app.baseDxf = { text, name: '模拟平面图 sample-plant.dxf' };
    $('source').textContent = '某钢厂冷轧车间 · sample-plant.dxf';
    loading.textContent = '正在加载 AGV1…';
    await app.selectProduct('agv1');
    resize();
    app.setStep(4);
    app.setTab('gantt', false);
    app.library = new Library(app);
    app.library.init();
    // Any panel, the table drawer or a chat card can be popped out into a large window.
    app.popout = initPopout({
      titleFor: (el) => (el.id === 'drawer' ? document.querySelector('#tabs button.on')?.textContent : null),
      onChange: () => relayout(),
    });
    app.setView('overview');
    fly.duration = 0.01;
    loading.textContent = '正在预编译材质…';
    await warmUp();
    loading.hidden = true;
    frame();
  } catch (error) {
    console.error(error);
    loading.textContent = `加载失败：${error.message}`;
    return;
  }
  const tools = createTools(app);
  const agent = new Agent({ tools, app });
  window.__app = app;
  window.__camera = camera;
  window.__controls = controls;
  window.__agent = agent;
  await agent.init();
}
boot();
