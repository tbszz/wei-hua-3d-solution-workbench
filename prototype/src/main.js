// 卫华 3D 方案工作台 prototype: three.js site on the left, Doubao agent on the right.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CATALOG } from '../../demo/src/catalog.js';
import { SAMPLE_PLAN } from '../../demo/src/scene/site.js';
import { applyBands, loadVehicle } from '../../demo/src/vehicle.js';
import { Agent } from './agent.js';
import { ProcessSite } from './engine.js';
import { COIL, fmtTime, simulateShift } from './process.js';
import { createTools } from './tools.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const view = $('view');
const QUALITY = { pixelRatio: 2, shadowSize: 4096, shadowRadius: 4 };

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY.pixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 900);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 2;
controls.maxDistance = 320;

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
  $('version').textContent = `方案 v${app.version}`;
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
  renderDock();
  renderKpis();
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
  renderDock();
  renderKpis();
  return next;
};

app.vehicleState = () => ({ model: app.product?.model, ...stateOf() });

// ---------------------------------------------------------------- camera

const fly = { active: false };
function flyTo(target, position, duration = 0.8) {
  Object.assign(fly, { active: true, t: 0, duration, fromTarget: controls.target.clone(), fromPos: camera.position.clone(), toTarget: target.clone(), toPos: position.clone() });
}

function fitDistance(w, h) {
  const v = THREE.MathUtils.degToRad(camera.fov / 2);
  const hz = Math.atan(Math.tan(v) * camera.aspect);
  return Math.max(w / 2 / Math.tan(hz), h / 2 / Math.tan(v));
}

const hookWorld = () => new THREE.Vector3(site.cranePose.x / 1000, site.cranePose.z / 1000, -site.cranePose.y / 1000);
let lastFollow = new THREE.Vector3();

app.setView = (mode, opts = {}) => {
  app.view = mode;
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === mode);
  const { centre, size } = site.built;
  const c = new THREE.Vector3(centre.x / 1000, 0, -centre.y / 1000);
  if (mode === 'overview') {
    const dir = new THREE.Vector3(-0.26, 0.66, 0.7).normalize();
    flyTo(c, c.clone().addScaledVector(dir, fitDistance(size.x * 0.92, size.y * 1.25)));
  } else if (mode === 'top') {
    flyTo(c, new THREE.Vector3(c.x, fitDistance(size.x * 1.04, size.y * 1.04), c.z + 0.01));
  } else if (mode === 'follow') {
    const p = site.carrier.position.clone().setY(0.6);
    flyTo(p, p.clone().add(new THREE.Vector3(-8, 9, 10)));
    lastFollow = site.carrier.position.clone();
  } else if (mode === 'crane') {
    const h = hookWorld();
    const target = new THREE.Vector3(h.x, 6.5, h.z);
    flyTo(target, target.clone().add(new THREE.Vector3(-13, -3.5, 24)));
    lastFollow = h;
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
  el.style.left = `${(projected.x * 0.5 + 0.5) * view.clientWidth}px`;
  el.style.top = `${(-projected.y * 0.5 + 0.5) * view.clientHeight}px`;
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
  for (const [key, el] of pins) if (!seen.has(key)) {
    el.remove();
    pins.delete(key);
  }
  void step;
}

// ---------------------------------------------------------------- HUD

function updateHud() {
  const t = site.time;
  const step = site.stepAt(t);
  const w = site.window;
  $('hudStep').textContent = w ? `第 ${step.n} 步 / 共 ${site.process.steps.length} 步 · 分步播放` : `全流程 · 第 ${step.n} 步进行中`;
  $('hudWindow').textContent = `${fmtTime(step.t0)} – ${fmtTime(step.t1)}`;
  $('hudTitle').textContent = `${step.title}（${step.device}）`;
  $('hudBar').style.width = `${Math.min(100, Math.max(0, ((t - step.t0) / step.duration) * 100))}%`;
  const cp = site.cranePose;
  const row = step.device === '行车'
    ? `<span>钩高 <b class="num">${(cp.z / 1000).toFixed(2)} m</b></span><span>大车 X <b class="num">${(cp.x / 1000).toFixed(1)} m</b></span><span>小车 Y <b class="num">${(cp.y / 1000).toFixed(1)} m</b></span><span>动作 <b>${cp.segment?.label ?? '待机'}</b></span>`
    : `<span>车速 <b class="num">${(Math.abs(site.pose.speed) / 1000).toFixed(2)} m/s</b></span><span>${site.status().text}</span>`;
  $('hudRow').innerHTML = `${row}<span>货物 <b>钢卷 Φ${COIL.diameter / 1000} m · ${COIL.tonnes} t</b>（示意）</span>`;
  const coil = site.coilPosition();
  $('coord').innerHTML = coil
    ? `<span>钢卷 X <b class="num">${Math.round(coil.x).toLocaleString('fr-FR')}</b> Y <b class="num">${Math.round(coil.y).toLocaleString('fr-FR')}</b> Z <b class="num">${Math.round(coil.z).toLocaleString('fr-FR')}</b> mm</span>`
    : '';
  $('clock').textContent = `${fmtTime(t)} / ${fmtTime(site.duration)}`;
  $('playBtn').textContent = site.playing ? '❚❚' : '▶';
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
  app.setTab(STEP_TAB[n]);
  if (n === 6) {
    site.setTravelVisible(true);
    $('travelBtn').classList.add('on');
  }
};

app.setTab = (tab) => {
  app.tab = tab;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
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
    <div class="stepsband"><span style="font-size:12px;color:var(--ink3)">工序（点击分步播放）</span><div class="sb">${band}</div></div>
    <div class="seq"><div class="who">${app.product?.model ?? 'AGV'}<small>${app.agvNote ?? '载重 30 t'}</small></div><div class="lane" data-lane>${blocks(site.gantt.agv)}</div></div>
    <div class="seq"><div class="who">行车 #1<small>跨度 ${span} m</small></div><div class="lane" data-lane>${blocks(site.gantt.crane)}</div></div>
    <div class="playhead" id="playhead"><span id="phLabel">00:00</span></div>
  </div>
  <div class="glegend"><span><i class="mv"></i>行走 / 运行</span><span><i class="pk"></i>取放 / 夹紧</span><span><i class="lf"></i>起升 / 下降</span><span><i class="ch"></i>充电</span><span><i class="id" style="border:1px dashed #C9CDD4"></i>空闲</span><span>点击色块或时间轴跳到对应时刻</span></div>`;
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
  return `<table class="t"><thead><tr><th>点位</th><th>名称</th><th>作业</th><th>X mm</th><th>Y mm</th><th>来源</th></tr></thead><tbody>${rows.join('')}</tbody></table>
  <p class="muted" style="font-size:12px;margin-top:6px">厂房 ${site.sourceName}；行车钩头可达 X ${c.minX}–${c.maxX}、Y ${c.minY}–${c.maxY} mm。点一行镜头飞过去；对话里说“在 RM-01 东边 2 米加一个点”可以加点位。</p>`;
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
  const prod = CATALOG.map((p) => `<button data-product="${p.id}" class="${p.id === product.id ? 'on' : ''}">${p.model}<span class="muted" style="font-size:11px;margin-left:6px">${p.summary}</span></button>`).join('');
  const vehicle = Object.entries(product.params).map(([k, p]) => `<div class="param"><label>${p.label}<b class="num">${Math.round(state[k])} mm</b></label><input type="range" data-vparam="${k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${state[k]}"><small>产品库范围 ${p.min}–${p.max} mm</small></div>`).join('');
  const motion = SLIDERS.map((s) => `<div class="param"><label>${s.label}<b class="num">${Number(s.get().toFixed(2))} ${s.unit}</b></label><input type="range" data-mparam="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.get()}"><small>示意值 ${s.min}–${s.max} ${s.unit}</small></div>`).join('');
  return `<div class="prod">${prod}</div><div class="params">${vehicle}${motion}
  <div class="param"><label>起重机<b>双梁桥式（示意）</b></label><small>跨度 ${(Math.abs(site.runway.high - site.runway.low) / 1000).toFixed(2)} m 由 CAD 吊车梁间距决定；吊具 C 形钩；卷材 Φ${COIL.diameter / 1000} m × ${COIL.width / 1000} m，${COIL.tonnes} t（示意）</small></div></div>`;
}

function processHtml() {
  const cur = site.stepAt().n;
  const rows = site.process.steps.map((s) => `<tr class="clickable ${s.n === cur ? 'cur' : ''}" data-play="${s.n}"><td>${s.n}</td><td>${s.device === 'AGV' ? app.product?.model ?? 'AGV' : '行车 #1'}</td><td><b>${s.title}</b><div class="muted" style="font-size:11.5px">${s.detail}</div></td><td class="num">${fmtTime(s.t0)}–${fmtTime(s.t1)}</td><td class="num">${s.duration.toFixed(1)} s</td></tr>`).join('');
  return `<table class="t"><thead><tr><th>#</th><th>设备</th><th>动作</th><th>时段</th><th>用时</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="muted" style="font-size:12px;margin-top:6px">工序串成一条闭式时间轴：AGV 走 CAD 路线，行车按大车 / 小车 / 起升三轴梯形速度曲线运动。点一行只播这一步。</p>`;
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
  return `<table class="t"><thead><tr><th>设备 / 轴</th><th>单循环累计</th><th>最大单程</th><th>说明</th></tr></thead><tbody>
    <tr><td>${app.product?.model ?? 'AGV'} 载卷</td><td class="num">${m(tr.agv.loaded)} m</td><td class="num" rowspan="2">${m(tr.agv.longest)} m</td><td>蓝色实线</td></tr>
    <tr><td>${app.product?.model ?? 'AGV'} 空车</td><td class="num">${m(tr.agv.empty)} m</td><td>绿色虚线</td></tr>
    <tr><td>行车 大车 (X)</td><td class="num">${m(tr.crane.bridge)} m</td><td class="num">${m(tr.crane.longest.x)} m</td><td rowspan="3">红色虚线为钩心轨迹</td></tr>
    <tr><td>行车 小车 (Y)</td><td class="num">${m(tr.crane.trolley)} m</td><td class="num">${m(tr.crane.longest.y)} m</td></tr>
    <tr><td>行车 起升 (Z)</td><td class="num">${m(tr.crane.hoist)} m</td><td class="num">${m(tr.crane.longest.z)} m</td></tr>
    <tr><td>钩心高度</td><td class="num" colspan="2">最低 ${m(tr.crane.zMin)} m · 最高 ${m(tr.crane.zMax)} m</td><td></td></tr>
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
  const body = { points: pointsHtml, params: paramsHtml, process: processHtml, gantt: ganttHtml, eff: () => effHtml(), travel: travelHtml, later: laterHtml }[app.tab]();
  $('dockMain').innerHTML = body;
  updatePlayhead();
}
app.renderDock = renderDock;

function renderKpis() {
  if (!site.efficiency) return;
  const eff = site.efficiency;
  const shift = app.shift ?? simulateShift(eff, site.duration, 8);
  const cls = eff.target ? (eff.meets ? 'good' : 'bad') : '';
  const sub = eff.target ? (eff.meets ? `达到目标 ${eff.target} s` : `未达到，差 ${eff.gap.toFixed(1)} s`) : `瓶颈：${eff.bottleneck}`;
  const tr = site.travel;
  $('kpis').innerHTML = `
    <div class="kpi ${cls}"><div class="l">单件节拍${eff.target ? ` · 目标 ${eff.target} s` : ''}</div><div class="v num">${eff.takt.toFixed(0)}<small>s</small></div><div class="s">${sub}</div></div>
    <div class="kpi"><div class="l">${shift.hours} 小时班产量</div><div class="v num">${shift.pieces}<small>件</small></div><div class="s">${(3600 / eff.takt).toFixed(1)} 件/小时 · ${eff.agvCount} 台 AGV</div></div>
    <div class="travel">
      <div><span>行程 · 单循环</span><span>累计</span><span>利用率</span></div>
      <div><span>${app.product?.model ?? 'AGV'}</span><span class="num">${(tr.agv.total / 1000).toFixed(1)} m</span><span class="num">${(eff.utilization.agv * 100).toFixed(0)}%</span></div>
      <div><span>行车 大车 / 小车</span><span class="num">${(tr.crane.bridge / 1000).toFixed(1)} / ${(tr.crane.trolley / 1000).toFixed(1)} m</span><span class="num">${(eff.utilization.crane * 100).toFixed(0)}%</span></div>
      <div><span>行车 起升</span><span class="num">${(tr.crane.hoist / 1000).toFixed(1)} m</span><span></span></div>
    </div>`;
}
app.renderKpis = renderKpis;

app.refresh = () => {
  renderDock();
  renderKpis();
};

// ---------------------------------------------------------------- playback

app.play = ({ mode = 'all', step, speed } = {}) => {
  if (speed) {
    site.speed = speed;
    $('speedSel').value = String(speed);
  }
  if (mode === 'pause') site.playing = false;
  else if (mode === 'resume') site.playing = true;
  else if (mode === 'step') {
    site.playWindow(step);
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
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => app.setTab(b.dataset.tab)));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => app.setView(b.dataset.view)));
$('playBtn').addEventListener('click', () => {
  if (!site.playing && site.window && site.time >= site.window.t1) site.time = site.window.t0;
  site.playing = !site.playing;
});
$('speedSel').addEventListener('change', (e) => { site.speed = Number(e.target.value); });
$('allBtn').addEventListener('click', () => app.play({ mode: 'all' }));
$('nextBtn').addEventListener('click', () => app.play({ mode: 'next' }));
$('travelBtn').addEventListener('click', () => {
  site.setTravelVisible(!site.travelVisible);
  $('travelBtn').classList.toggle('on', site.travelVisible);
  if (app.tab === 'travel') renderDock();
});
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

function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  site.resize(w, h);
}
new ResizeObserver(resize).observe(view);

controls.addEventListener('start', () => { fly.active = false; });
const clock = new THREE.Clock();
let lastStep = 0;
let manual = false;
// Debug: step frames by hand when the tab is hidden and rAF is paused.
window.__frames = (n = 1) => { manual = true; for (let i = 0; i < n; i++) frame(1 / 30); manual = false; };
function frame(dt) {
  const delta = dt ?? Math.min(clock.getDelta(), 0.1);
  if (site.timeline && app.product) {
    site.update(delta, camera);
    if (fly.active) {
      fly.t += delta / fly.duration;
      const k = THREE.MathUtils.smootherstep(Math.min(fly.t, 1), 0, 1);
      controls.target.lerpVectors(fly.fromTarget, fly.toTarget, k);
      camera.position.lerpVectors(fly.fromPos, fly.toPos, k);
      if (fly.t >= 1) fly.active = false;
    } else if (app.view === 'follow' || app.view === 'crane') {
      const now = app.view === 'follow' ? site.carrier.position.clone() : hookWorld();
      const moved = now.clone().sub(lastFollow);
      if (app.view === 'crane') moved.y = 0;
      controls.target.add(moved);
      camera.position.add(moved);
      lastFollow.copy(now);
    }
    if (fly.active && (app.view === 'follow' || app.view === 'crane')) lastFollow.copy(app.view === 'follow' ? site.carrier.position : hookWorld());
    controls.update();
    renderer.render(site.scene, camera);
    updateLabels();
    updateHud();
    updatePlayhead();
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
    $('source').textContent = '某钢厂冷轧车间 · sample-plant.dxf';
    loading.textContent = '正在加载 AGV1…';
    await app.selectProduct('agv1');
    resize();
    app.setStep(4);
    app.setView('overview');
    fly.duration = 0.01;
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
