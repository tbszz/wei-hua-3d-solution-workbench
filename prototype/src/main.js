// 卫华 3D 方案工作台 prototype: three.js site on the left, Doubao agent on the right.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CATALOG } from '../../demo/src/catalog.js';
import { SAMPLE_PLAN, fitDepthRange } from '../../demo/src/scene/site.js';
import { applyBands, loadVehicle } from '../../demo/src/vehicle.js';
import { Agent } from './agent.js';
import { ProcessSite } from './engine.js';
import { SceneSite } from './scene-site.js';
import { COIL, fmtTime, simulateShift } from './process.js';
import { createTools } from './tools.js';
import { Library } from './library.js';
import { initPopout } from './popout.js';
import { createSceneLocator, initDashboard } from './dashboard.js';

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
// Rhino-style mouse: right-drag rotates, Shift+right-drag pans, Ctrl/Alt+right-drag and the wheel
// zoom, middle-drag pans. The left button is for picking objects (see the selection section).
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

// The AGV + crane process site, and (while a generic drawing is shown) the generated plant.
const processSite = new ProcessSite(renderer, QUALITY);
processSite.speed = 4;
let site = processSite;

// ---------------------------------------------------------------- app state

export const app = {
  get site() {
    return site;
  },
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
  // A zero-size window (hidden tab at boot) can leave the camera at NaN; start from the goal then.
  if (!Number.isFinite(camera.position.lengthSq()) || !Number.isFinite(controls.target.lengthSq())) {
    camera.position.copy(position);
    controls.target.copy(target);
  }
  if (!Number.isFinite(position.lengthSq())) return;
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
// Set by a library jump to the crane: track the whole bridge instead of the hook.
let craneWide = false;
const craneBox = new THREE.Box3();
const subjectOf = (mode) => {
  if (mode === 'follow') return site.carrier.position.clone().setY(0.8);
  if (craneWide && site.crane) return craneBox.setFromObject(site.crane.root).getCenter(new THREE.Vector3()).setY(7);
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

function craneWideOffset() {
  const { centre } = site.built;
  const s = subjectOf('crane');
  const sx = Math.sign(centre.x / 1000 - s.x) || -1;
  const sz = Math.sign(-centre.y / 1000 - s.z) || 1;
  const span = new THREE.Box3().setFromObject(site.crane.root).getSize(new THREE.Vector3());
  const d = fitDistance(Math.max(span.x, span.z) * 1.5, Math.max(span.x, span.z) * 1.1);
  return new THREE.Vector3(sx * 0.55, 0.78, sz * 0.3).normalize().multiplyScalar(d);
}

app.setView = (mode, opts = {}) => {
  if (!opts.noHistory) rememberView();
  craneWide = Boolean(opts.wide && mode === 'crane');
  app.view = mode;
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === mode);
  if (site.isScene) return sceneView(mode, opts);
  const { centre, size } = site.built;
  const c = new THREE.Vector3(centre.x / 1000, 0, -centre.y / 1000);
  if (mode === 'overview') {
    const dir = new THREE.Vector3(-0.26, 0.66, 0.7).normalize();
    // Fit the footprint's diagonal so the site stays framed while it slowly orbits.
    const diag = Math.hypot(size.x, size.y);
    flyTo(c, c.clone().addScaledVector(dir, fitDistance(diag * 1.05, diag * 0.85)));
  } else if (mode === 'top') {
    flyTo(c, new THREE.Vector3(c.x, fitDistance(size.x * 1.04, size.y * 1.04), c.z + 0.01));
  } else if (mode === 'front' || mode === 'right') {
    // Rhino Front looks north (along +Y of the drawing), Right looks west (along -X).
    const t = c.clone().setY(5);
    const front = mode === 'front';
    const d = fitDistance((front ? size.x : size.y) * 1.04, 14);
    flyTo(t, t.clone().add(front ? new THREE.Vector3(0, 0.6, d) : new THREE.Vector3(d, 0.6, 0)));
  } else if (mode === 'follow' || mode === 'crane') {
    // The flight keeps re-aiming at the moving subject, so it lands on it, not where it was.
    const t = subjectOf(mode);
    // wide: jumping from the library frames the whole crane from above the column rows,
    // sized to its span, instead of the close hook shot used while it works.
    const offset = opts.wide && mode === 'crane' ? craneWideOffset() : trackOffset(mode);
    flyTo(t, t.clone().add(offset));
    fly.track = offset;
  } else if (mode === 'point') {
    const p = site.findPoint(opts.id);
    const t = new THREE.Vector3(p.x / 1000, 1, -p.y / 1000);
    flyTo(t, t.clone().add(new THREE.Vector3(-10, 12, 14)));
  }
};

// Generated plant: overview / top as usual, "follow" becomes an eye-level look down a bay,
// "crane" frames one bay's crane from along the runway, "point" frames any CAD point.
function sceneView(mode, opts = {}) {
  fly.track = null;
  const { centre, size } = site.built;
  const c = new THREE.Vector3(centre.x / 1000, 0, -centre.y / 1000);
  const world = (p, h) => new THREE.Vector3(p.x / 1000, h, -p.y / 1000);
  // A unit vector along the runway, in world space.
  const along = site.alongX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1);
  const across = new THREE.Vector3(-along.z, 0, along.x);
  const bayName = opts.bay ?? site.bays[Math.floor((site.bays.length - 1) / 2)]?.name;
  const length = (site.alongX ? size.x : size.y);
  if (mode === 'overview') {
    const dir = new THREE.Vector3(-0.26, 0.66, 0.7).normalize();
    const diag = Math.hypot(size.x, size.y);
    flyTo(c, c.clone().addScaledVector(dir, fitDistance(diag * 1.05, diag * 0.85)));
  } else if (mode === 'top') {
    flyTo(c, new THREE.Vector3(c.x, fitDistance(size.x * 1.04, size.y * 1.04), c.z + 0.01));
  } else if (mode === 'follow' && site.bays.length) {
    const eye = world(site.bayPoint(bayName, 3), 5.5);
    const target = world(site.bayPoint(bayName, length * 0.45), 4);
    flyTo(target, eye, 1.2);
  } else if (mode === 'crane' && site.plant.cranes.length) {
    const cranes = site.plant.cranes;
    const crane = cranes.find((k) => k.attrs.BAY === String(bayName).toUpperCase().replace(/跨$/, '')) ?? cranes[(opts.index ?? 1) - 1] ?? cranes[0];
    const t = world(crane, 8.5);
    flyTo(t, t.clone().addScaledVector(along, -26).addScaledVector(across, 7).setY(13), 1.2);
  } else if (mode === 'point' && Number.isFinite(opts.x) && Number.isFinite(opts.y)) {
    // opts.h: height to aim at (m); opts.size: how much to fit in the frame (m).
    const t = world(opts, opts.h ?? 1);
    const d = Math.max(22, (opts.size ?? 0) * 1.5);
    flyTo(t, t.clone().addScaledVector(new THREE.Vector3(-0.5, 0.55, 0.67).normalize(), d), 1.1);
  } else return sceneView('overview');
  return undefined;
}

// ---------------------------------------------------------------- Rhino-style navigation

// Assigned once the toolbar functions below exist (they are declared further down the file).
let setRotateLater = () => {};
let setCleanLater = () => {};

// View history for Home (undo view change) / End (redo view change).
const viewHist = { back: [], fwd: [] };
const snapView = () => ({ p: camera.position.clone(), t: controls.target.clone(), view: app.view });
function rememberView() {
  const last = viewHist.back.at(-1);
  if (last && last.p.distanceTo(camera.position) < 1e-3 && last.t.distanceTo(controls.target) < 1e-3) return;
  viewHist.back.push(snapView());
  if (viewHist.back.length > 60) viewHist.back.shift();
  viewHist.fwd.length = 0;
}
function markView(mode) {
  app.view = mode;
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === mode);
}
function stepView(from, to) {
  const s = from.pop();
  if (!s) return false;
  to.push(snapView());
  // A stored tracking view is a moment of a moving subject, so it comes back as a free view.
  markView(s.view === 'follow' || s.view === 'crane' ? 'free' : s.view);
  setRotateLater(false);
  flyTo(s.t, s.p, 0.45);
  return true;
}
app.undoView = () => stepView(viewHist.back, viewHist.fwd);
app.redoView = () => stepView(viewHist.fwd, viewHist.back);

function takeOver(pan = false) {
  fly.active = false;
  setRotateLater(false);
  // Panning away from a tracked subject leaves the tracking view.
  if (pan && (app.view === 'follow' || app.view === 'crane')) markView('free');
}
const sph = new THREE.Spherical();
function orbitBy(dTheta, dPhi) {
  takeOver();
  const off = camera.position.clone().sub(controls.target);
  sph.setFromVector3(off);
  sph.theta += dTheta;
  sph.phi = THREE.MathUtils.clamp(sph.phi + dPhi, 0.02, controls.maxPolarAngle);
  camera.position.copy(controls.target).add(off.setFromSpherical(sph));
}
function panBy(dx, dy) {
  takeOver(true);
  const k = camera.position.distanceTo(controls.target) * 0.06;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const move = right.multiplyScalar(dx * k).addScaledVector(up, dy * k);
  camera.position.add(move);
  controls.target.add(move);
}
function zoomBy(f) {
  takeOver();
  const off = camera.position.clone().sub(controls.target);
  off.setLength(THREE.MathUtils.clamp(off.length() * f, controls.minDistance, controls.maxDistance));
  camera.position.copy(controls.target).add(off);
}
// Frame a box from the current viewing direction (Rhino ZoomExtents / ZoomSelected).
function frameBox(box, label) {
  rememberView();
  const centre = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const dir = camera.position.clone().sub(controls.target).normalize();
  markView('free');
  setRotateLater(false);
  flyTo(centre, centre.clone().addScaledVector(dir, Math.max(controls.minDistance + 1, fitDistance(r * 2.1, r * 2.1))));
  if (label) app.toast(label);
}
app.zoomExtents = () => {
  const { centre, size } = site.built;
  const c = new THREE.Vector3(centre.x / 1000, 5, -centre.y / 1000);
  frameBox(new THREE.Box3().setFromCenterAndSize(c, new THREE.Vector3(size.x, 10, size.y)), '缩放至全部（ZE）');
};
app.zoomSelected = () => {
  const roots = selectables().filter((s) => s.key === selection.key).map((s) => s.root);
  if (!roots.length) return app.toast('没有选取物件，先左键点选一个设备', true);
  const box = new THREE.Box3();
  for (const r of roots) box.expandByObject(r);
  frameBox(box, '缩放至选取（ZS）');
};

// ---------------------------------------------------------------- selection

// Left click picks a device (AGV, crane, placed model) with a Rhino-style yellow box; Esc clears.
const selection = { key: null, helpers: [] };
function selectables() {
  const list = (site.carriers ?? [site.carrier]).filter(Boolean).map((root, i) => ({ key: 'agv', root, name: `${app.product?.model ?? 'AGV'}${site.agvCount > 1 ? ` #${i + 1}` : ''}` }));
  if (site.crane) list.push({ key: 'crane', root: site.crane.root, name: '行车 #1 · 双梁桥式起重机（示意）' });
  for (const p of app.library?.placed.values() ?? []) list.push({ key: `asset:${p.asset.id}`, root: p.root, name: p.asset.name });
  return list;
}
app.select = (key) => {
  for (const h of selection.helpers) {
    h.removeFromParent();
    h.dispose();
  }
  selection.helpers = [];
  const hits = key ? selectables().filter((s) => s.key === key) : [];
  selection.key = hits.length ? key : null;
  for (const s of hits) {
    const h = new THREE.BoxHelper(s.root, 0xffd21f);
    h.material.depthTest = false;
    h.material.transparent = true;
    h.renderOrder = 999;
    h.userData.root = s.root;
    site.scene.add(h);
    selection.helpers.push(h);
  }
  app.library?.reveal(selection.key);
  return hits[0] ?? null;
};
function updateSelection() {
  if (!selection.key) return;
  // The crane and the AGVs are rebuilt after some edits; re-attach the highlight to the new ones.
  if (selection.helpers.some((h) => !h.userData.root.parent)) return void app.select(selection.key);
  for (const h of selection.helpers) h.update();
}
// Jump from the library (or a pick) to an object in the scene.
app.focusObject = (key) => {
  const hit = app.select(key);
  if (!hit) return app.toast('场景中找不到这个物件', true);
  if (key === 'agv') app.setView('follow', { wide: true });
  else if (key === 'crane') app.setView('crane', { wide: true });
  else frameBox(new THREE.Box3().setFromObject(hit.root));
  setRotateLater(false);
  app.toast(`已跳转到 ${hit.name}`);
  return hit;
};

const raycaster = new THREE.Raycaster();
const pickStart = { x: 0, y: 0, on: false };
// Runs before OrbitControls (capture on the parent): choose what the right button does.
view.addEventListener('pointerdown', (e) => {
  if (e.target !== canvas) return;
  if (e.button === 2) controls.mouseButtons.RIGHT = (e.ctrlKey || e.metaKey || e.altKey) && !e.shiftKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
  if (e.button === 0) Object.assign(pickStart, { x: e.clientX, y: e.clientY, on: true });
}, true);

// The right button belongs to the 3D view: a right-drag that starts on the scene always rotates and
// never opens the browser menu, wherever it is released. Cancelling pointerdown also suppresses the
// legacy mousedown/mouseup that page-level mouse-gesture scripts listen for.
let rightDrag = 0;
addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || e.target !== canvas) return;
  e.preventDefault();
  rightDrag = Infinity;
}, true);
addEventListener('pointerup', (e) => {
  if (e.button === 2 && rightDrag === Infinity) rightDrag = performance.now() + 400;
}, true);
for (const type of ['contextmenu', 'auxclick']) {
  addEventListener(type, (e) => {
    if (e.button !== 2 && type === 'auxclick') return;
    if (e.target !== canvas && performance.now() > rightDrag) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
canvas.addEventListener('lostpointercapture', () => {
  if (rightDrag === Infinity) rightDrag = performance.now() + 400;
});
// Floor point (mm, plan coordinates) under a window position; used when a model is dragged in.
app.floorAt = (cx, cy) => {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return null;
  return { x: p.x * 1000, y: -p.z * 1000 };
};
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !pickStart.on) return;
  pickStart.on = false;
  if (Math.hypot(e.clientX - pickStart.x, e.clientY - pickStart.y) > 5) return;
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const items = selectables();
  const hit = raycaster.intersectObjects(items.map((s) => s.root), true).find((h) => h.object.visible);
  let found = null;
  for (let o = hit?.object; o && !found; o = o.parent) found = items.find((s) => s.root === o);
  if (!found) return void app.select(null);
  app.select(found.key);
  app.toast(`已选取 ${found.name}（ZS 回车缩放至选取，Esc 取消）`);
});

// Command line: type a Rhino command or alias, Enter/Space runs it, Enter on an empty line repeats.
const COMMANDS = {
  ZE: ['缩放至全部', () => app.zoomExtents()],
  ZEA: ['缩放至全部', () => app.zoomExtents()],
  ZOOMEXTENTS: ['缩放至全部', () => app.zoomExtents()],
  ZS: ['缩放至选取', () => app.zoomSelected()],
  ZSA: ['缩放至选取', () => app.zoomSelected()],
  ZOOMSELECTED: ['缩放至选取', () => app.zoomSelected()],
  TOP: ['俯视', () => app.setView('top')],
  FRONT: ['前视', () => app.setView('front')],
  RIGHT: ['右视', () => app.setView('right')],
  PERSPECTIVE: ['透视', () => app.setView('overview')],
  SELNONE: ['取消选取', () => app.select(null)],
  HIDE: ['隐藏面板', () => setCleanLater(true)],
  SHOW: ['显示面板', () => setCleanLater(false)],
  HELP: ['快捷键说明', () => toggleHelp(true)],
};
const cmd = { buf: '', last: null };
const cmdEl = document.createElement('div');
cmdEl.className = 'cmdline';
cmdEl.hidden = true;
view.append(cmdEl);
function showCmd() {
  cmdEl.hidden = !cmd.buf;
  const hint = Object.keys(COMMANDS).filter((k) => cmd.buf && k.startsWith(cmd.buf)).slice(0, 4).map((k) => `${k} ${COMMANDS[k][0]}`).join(' · ');
  cmdEl.innerHTML = `<b>命令:</b><span class="num">${cmd.buf}</span><i></i><small>${hint || '未知命令'}</small>`;
}
function runCmd(name) {
  const c = COMMANDS[name];
  cmd.buf = '';
  showCmd();
  if (!c) return app.toast(`未知命令：${name}`, true);
  cmd.last = name;
  c[1]();
}

// Shortcut sheet (F1).
const helpEl = document.createElement('div');
helpEl.className = 'keyhelp glass';
helpEl.hidden = true;
helpEl.innerHTML = `<header><b>快捷键 · 犀牛 Rhino 习惯</b><button type="button" data-help-x title="关闭（Esc）">✕</button></header>
<div class="kh"><h5>鼠标</h5>
<p><kbd>右键拖动</kbd>旋转视图</p><p><kbd>Shift</kbd>+<kbd>右键拖动</kbd>平移</p><p><kbd>Ctrl</kbd>/<kbd>Alt</kbd>+<kbd>右键拖动</kbd>缩放</p>
<p><kbd>滚轮</kbd>缩放</p><p><kbd>中键拖动</kbd>平移</p><p><kbd>左键单击</kbd>选取设备（黄框），点空白取消</p>
<h5>键盘</h5>
<p><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd>旋转视图</p><p><kbd>Shift</kbd>+方向键 平移</p><p><kbd>PgUp</kbd>/<kbd>PgDn</kbd>缩放</p>
<p><kbd>Home</kbd>/<kbd>End</kbd>上一个 / 下一个视图</p><p><kbd>Ctrl</kbd>+<kbd>F1</kbd>俯视　<kbd>Ctrl</kbd>+<kbd>F2</kbd>前视　<kbd>Ctrl</kbd>+<kbd>F3</kbd>右视</p>
<p><kbd>Ctrl</kbd>+<kbd>F4</kbd> 在浏览器里会关闭标签页，透视请用命令 <kbd>Perspective</kbd> 或「总览」按钮</p><p><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>缩放至全部</p>
<p><kbd>Esc</kbd>取消命令 / 取消选取</p><p><kbd>Delete</kbd>移出选中的上传模型</p>
<h5>命令行（直接打字，回车或空格执行；空行回车重复上一条）</h5>
<p><kbd>ZE</kbd>缩放至全部　<kbd>ZS</kbd>缩放至选取</p><p><kbd>Top</kbd> <kbd>Front</kbd> <kbd>Right</kbd> <kbd>Perspective</kbd>切换视图</p><p><kbd>SelNone</kbd>取消选取　<kbd>Hide</kbd>/<kbd>Show</kbd>隐藏 / 显示面板</p>
<h5>本工作台</h5>
<p><kbd>空格</kbd>播放 / 暂停（命令行为空时）</p><p><kbd>H</kbd>清屏 / 恢复面板</p><p><kbd>F1</kbd>打开 / 关闭本说明</p></div>`;
view.append(helpEl);
function toggleHelp(on = helpEl.hidden) {
  helpEl.hidden = !on;
  $('keysBtn')?.classList.toggle('on', on);
}
helpEl.addEventListener('click', (e) => { if (e.target.closest('[data-help-x]')) toggleHelp(false); });
$('keysBtn')?.addEventListener('click', () => toggleHelp());

const VIEW_KEYS = { F1: 'top', F2: 'front', F3: 'right' };
addEventListener('keydown', (e) => {
  if (e.target.closest?.('textarea,input,select,[contenteditable="true"]')) return;
  if (app.popout?.current) return; // the pop-out window owns Esc
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && VIEW_KEYS[k]) {
    e.preventDefault();
    app.setView(VIEW_KEYS[k]);
    return;
  }
  if (ctrl && e.shiftKey && k.toLowerCase() === 'e') {
    e.preventDefault();
    app.zoomExtents();
    return;
  }
  if (k === 'F1') {
    e.preventDefault();
    toggleHelp();
    return;
  }
  if (ctrl || e.altKey) return; // leave the browser's own shortcuts alone
  const step = THREE.MathUtils.degToRad(5);
  if (k.startsWith('Arrow')) {
    e.preventDefault();
    const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0;
    const dy = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
    if (e.shiftKey) panBy(dx, dy);
    else orbitBy(-dx * step, -dy * step);
    return;
  }
  if (k === 'PageUp' || k === 'PageDown') {
    e.preventDefault();
    zoomBy(k === 'PageUp' ? 0.85 : 1 / 0.85);
    return;
  }
  if (k === 'Home' || k === 'End') {
    e.preventDefault();
    if (!(k === 'Home' ? app.undoView() : app.redoView())) app.toast(k === 'Home' ? '没有更早的视图' : '没有下一个视图');
    return;
  }
  if (k === 'Escape') {
    if (cmd.buf) {
      cmd.buf = '';
      showCmd();
    } else if (!helpEl.hidden) toggleHelp(false);
    else if (selection.key) app.select(null);
    else if (document.body.classList.contains('clean')) setCleanLater(false);
    return;
  }
  if (k === 'Backspace' && cmd.buf) {
    e.preventDefault();
    cmd.buf = cmd.buf.slice(0, -1);
    showCmd();
    return;
  }
  if (k === 'Enter' || k === ' ') {
    e.preventDefault();
    if (cmd.buf) runCmd(cmd.buf);
    else if (k === 'Enter' && cmd.last) runCmd(cmd.last);
    else if (k === ' ') $('playBtn').click();
    return;
  }
  if (k === 'Delete' && selection.key) {
    if (selection.key.startsWith('asset:')) {
      app.library.remove(selection.key.slice(6));
      app.select(null);
      app.toast('已把选中的模型移出场景');
    } else app.toast('AGV 和行车是方案设备，不能删除', true);
    return;
  }
  if (/^[a-z]$/i.test(k)) {
    // A lone H keeps toggling the clean screen; letters after others build a command.
    if (!cmd.buf && (k === 'h' || k === 'H')) {
      setCleanLater(!document.body.classList.contains('clean'));
      return;
    }
    cmd.buf += k.toUpperCase();
    showCmd();
  }
});

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

function placedPins(seen) {
  for (const p of app.library?.placed.values() ?? []) {
    const key = `a:${p.asset.id}`;
    seen.add(key);
    place(pin(key, 'asset', `<span class="lab">${p.asset.name}</span>`), new THREE.Vector3(p.x / 1000, p.base + p.height + 0.6, -p.y / 1000));
  }
}

function dropPins(seen) {
  for (const [key, el] of pins) if (!seen.has(key)) {
    el.remove();
    pins.delete(key);
  }
}

// Generated plant: bay names on the floor, one pin per crane, uploaded models.
function updateSceneLabels() {
  const seen = new Set();
  const built = site.stepAt().n > 1 || site.time > 0.5;
  for (const bay of built ? site.bays : []) {
    const key = `bay:${bay.name}`;
    seen.add(key);
    place(pin(key, 'marker', `<span class="lab">${bay.name} 跨 · ${(bay.span / 1000).toFixed(1)} m</span><span class="dot" style="background:#F5B800"></span>`), new THREE.Vector3(bay.label.x / 1000, 0.3, -bay.label.y / 1000));
  }
  const craneStep = site.process.steps.find((s) => s.stage === 'crane');
  if (craneStep && site.time >= craneStep.t1) {
    for (const crane of site.craneInfo()) {
      if (crane.replaced) continue;
      const key = `crane:${crane.bay}`;
      seen.add(key);
      place(pin(key, 'dev', `<span class="lab">行车 ${crane.bay} 跨 · ${(crane.span / 1000).toFixed(1)} m</span>`), new THREE.Vector3(crane.x / 1000, 12.4, -crane.y / 1000));
    }
  }
  placedPins(seen);
  for (const hook of app.labelHooks ?? []) hook({ pin, place, seen });
  dropPins(seen);
}

function updateLabels() {
  if (site.isScene) return updateSceneLabels();
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
  placedPins(seen);
  for (const hook of app.labelHooks ?? []) hook({ pin, place, seen });
  dropPins(seen);
  void step;
  return undefined;
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
function updateSceneHud() {
  const t = site.time;
  const step = site.stepAt(t);
  const s = site.summary;
  $('hudNo').textContent = String(step.n).padStart(2, '0');
  $('hudTitle').textContent = site.building ? step.title : '厂房已建成';
  $('hudDev').textContent = site.building ? '建造中' : '完成';
  $('hudDev').className = 'badge build';
  $('hudWindow').textContent = `${fmtTime(step.t0)} – ${fmtTime(step.t1)}`;
  $('hudBar').style.width = `${site.building ? Math.min(100, Math.max(0, ((t - step.t0) / step.duration) * 100)) : 100}%`;
  setHtml('hudRow', metric('厂房', `${s.厂房_m[0]}×${s.厂房_m[1]}`, 'm') + metric('跨', site.bays.length ? `${site.bays.length}×${(site.bays[0].span / 1000).toFixed(1)}` : '—', 'm') + metric('柱距', s.柱距_m ?? '—', 'm') + metric('本步', step.detail, '', true));
  setHtml('hudChips', `<span class="chip">${site.sourceName}</span><span class="chip">柱 ${s.柱.钢柱 + s.柱.混凝土柱} 根 · 行车 ${s.行车} 台</span><span class="chip">${app.library?.placed.size ?? 0} 个模型已放入</span>`);
  setHtml('coord', '');
  $('clock').textContent = fmtTime(t);
  $('clockTotal').textContent = `/ ${fmtTime(site.duration)}`;
  const playing = site.playing;
  $('playBtn').textContent = playing ? '❚❚ 暂停' : site.building ? '▶ 继续' : '↻ 重新建造';
  $('playBtn').classList.toggle('paused', !playing);
  $('runSt').textContent = playing ? '建造中' : site.building ? '已暂停' : '已建成';
  $('runSt').classList.toggle('pause', !playing);
  $('allBtn').classList.toggle('on', !site.window);
}

function updateHud() {
  if (site.isScene) return updateSceneHud();
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
  return undefined;
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
  // Typed values, checked against the range when the field is committed (Enter / Tab / click away).
  const field = (attr, key, label, value, min, max, unit, digits) => `<div class="param"><label>${label}<small class="num">${min}–${max} ${unit}</small></label><div class="nin"><input type="number" inputmode="decimal" ${attr}="${key}" min="${min}" max="${max}" step="any" value="${Number(value.toFixed(digits))}" title="输入数值后回车，范围 ${min}–${max} ${unit}"><em>${unit}</em></div></div>`;
  const vehicle = Object.entries(product.params).map(([k, p]) => field('data-vparam', k, p.label, state[k], p.min, p.max, 'mm', 1)).join('');
  const motion = SLIDERS.map((s) => field('data-mparam', s.key, s.label, s.get(), s.min, s.max, s.unit, 2)).join('');
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

// Generated plant: what the drawing was read as, the build steps and the models placed in it.
function sceneHtml() {
  const s = site.summary;
  const rows = [
    ['图纸', site.sourceName],
    ['厂房', `${s.厂房_m[0]} × ${s.厂房_m[1]} m（${s.方向}）`],
    ['跨', s.跨.join('、') || '—'],
    ['柱网', `${s.柱线} 条柱线${s.柱距_m ? `，柱距 ${s.柱距_m} m` : ''}；钢柱 ${s.柱.钢柱} · 混凝土柱 ${s.柱.混凝土柱}`],
    ['吊车梁 / 行车', `${s.吊车梁} 根 / ${s.行车} 台`],
    ['门 / 窗', `${s.大门} 樘 / ${s.窗} 处`],
    ['设备 / 分区 / 轨道', `${s.设备} 台 / ${s.分区} 个 / ${s.轨道} 条`],
    ['地面线条', `${s.地面线条} 条${s.厂区 ? '，含厂区边界' : ''}`],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const steps = site.process.steps.map((x) => `<tr class="clickable" data-play="${x.n}"><td>${x.n}</td><td><b>${x.title}</b><div class="muted" style="font-size:11.5px">${x.detail}</div></td><td class="num">${x.duration.toFixed(1)} s</td></tr>`).join('');
  const placed = [...(app.library?.placed.values() ?? [])].map((p) => `<tr><td>${p.asset.name}</td><td class="num">${Math.round(p.x)}, ${Math.round(p.y)}</td><td>${p.mount === 'runway' ? `${p.bay} 跨 行车轨道` : '地面'}</td></tr>`).join('');
  return `<table class="t"><thead><tr><th colspan="2">图纸识别结果（自动）</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="t" style="margin-top:8px"><thead><tr><th>#</th><th>建造步骤</th><th>用时</th></tr></thead><tbody>${steps}</tbody></table>
  ${placed ? `<table class="t" style="margin-top:8px"><thead><tr><th>已放入模型</th><th>X, Y mm</th><th>安装</th></tr></thead><tbody>${placed}</tbody></table>` : ''}`;
}

function renderDock() {
  if (site.isScene) {
    $('dockMain').innerHTML = sceneHtml();
    return;
  }
  if (!site.process || !app.product) return;
  const body = { points: pointsHtml, params: paramsHtml, process: processHtml, gantt: ganttHtml, eff: () => effHtml(), travel: travelHtml, later: laterHtml, ...(app.dockTabs ?? {}) }[app.tab]();
  const focused = document.activeElement?.closest?.('#dockMain input');
  const key = focused && (focused.dataset.vparam ? `[data-vparam="${focused.dataset.vparam}"]` : focused.dataset.mparam ? `[data-mparam="${focused.dataset.mparam}"]` : null);
  $('dockMain').innerHTML = body;
  if (key) {
    const next = $('dockMain').querySelector(key);
    next?.focus();
    next?.select();
  }
  updatePlayhead();
}
app.renderDock = renderDock;

function renderKpis() {
  if (site.isScene) {
    const s = site.summary;
    $('kpis').innerHTML = `
    <div><small>厂房面积</small><b>${Math.round(s.厂房_m[0] * s.厂房_m[1]).toLocaleString('zh-CN')}<em>m²</em></b></div>
    <div><small>跨数 · 跨度</small><b>${site.bays.length}<em>跨 · ${site.bays.length ? (site.bays[0].span / 1000).toFixed(1) : '—'} m</em></b></div>
    <div><small>柱</small><b>${s.柱.钢柱 + s.柱.混凝土柱}<em>根</em></b></div>
    <div><small>行车</small><b>${s.行车}<em>台</em></b></div>
    <div><small>放入模型</small><b>${app.library?.placed.size ?? 0}<em>个</em></b></div>`;
    return;
  }
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
const DEV_CLASS = { AGV: '', 行车: 'crane', 建造: 'build' };
const devName = (d) => (d === 'AGV' ? 'AGV' : d === '行车' ? '行车' : d);
function renderProcList() {
  if (!site.process) return;
  $('procTotal').textContent = fmtTime(site.duration);
  $('procList').innerHTML = site.process.steps.map((s) => `<li data-play="${s.n}"><span class="n">${String(s.n).padStart(2, '0')}</span><b><span class="dev ${DEV_CLASS[s.device] ?? ''}">${devName(s.device)}</span>${s.title}</b><small class="num">${fmtTime(s.t0)} – ${fmtTime(s.t1)}</small><span class="d">${s.duration.toFixed(0)}s</span><i class="pg"></i></li>`).join('');
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
  $('tl').innerHTML = site.process.steps.map((s) => `<button data-play="${s.n}" class="${s.device === '行车' ? 'crane' : s.device === '建造' ? 'build' : 'agv'}" style="flex:${s.duration} 1 0" title="${s.title} · ${s.duration.toFixed(0)} s"><i></i><span>${'①②③④⑤⑥⑦⑧⑨'[s.n - 1] ?? s.n} ${s.title} · ${s.duration.toFixed(0)}s</span></button>`).join('');
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
  app.library?.render();
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
    if (site.isScene) app.setView(site.process.steps[step - 1].stage === 'crane' ? 'crane' : 'overview');
    else app.setView(site.process.steps[step - 1].device === '行车' ? 'crane' : 'follow');
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

processSite.onWindowEnd = () => renderDock();

// ---------------------------------------------------------------- generated plant (scene mode)

const VIEW_NAMES = { process: { follow: '跟随', crane: '行车' }, scene: { follow: '室内', crane: '行车' } };
function setModeUi(scene) {
  document.body.classList.toggle('scene-mode', scene);
  app.agent?.setSuggestions(scene);
  for (const b of document.querySelectorAll('[data-view]')) {
    const name = VIEW_NAMES[scene ? 'scene' : 'process'][b.dataset.view];
    if (name) b.textContent = name;
  }
}

// Fit the orbit limits and the far plane to the plant, so a 200 m hall can still be framed.
function fitCameraLimits() {
  const { size } = site.built;
  const diag = Math.hypot(size.x, size.y);
  controls.maxDistance = Math.max(320, diag * 2.2);
  camera.far = Math.max(900, diag * 6);
  camera.updateProjectionMatrix();
}

// Generate a plant from any factory drawing and play its construction.
app.enterScene = async (text, name, asset = null) => {
  const next = new SceneSite(renderer, QUALITY);
  next.share(processSite);
  next.loadDrawing(text, name, asset);
  next.onWindowEnd = () => renderDock();
  const previous = site;
  const cleared = app.library?.clearPlaced() ?? 0;
  site = next;
  if (previous !== processSite) disposeSite(previous);
  if (!app.processSource) app.processSource = $('source').textContent;
  $('source').textContent = `${name} · 图纸生成厂房`;
  setModeUi(true);
  fitCameraLimits();
  resize();
  app.setTab('scene', false);
  app.refresh();
  app.setView('overview');
  renderer.shadowMap.needsUpdate = true;
  app.bump();
  return { summary: next.summary, steps: next.process.steps, cleared };
};

// Back to the AGV + crane process plant.
app.exitScene = () => {
  if (!site.isScene) return false;
  const old = site;
  app.library?.clearPlaced();
  site = processSite;
  disposeSite(old);
  $('source').textContent = app.processSource ?? '某钢厂冷轧车间 · sample-plant.dxf';
  setModeUi(false);
  fitCameraLimits();
  resize();
  app.setTab('gantt', false);
  app.refresh();
  app.play({ mode: 'all' });
  app.bump();
  app.library?.sceneExited?.();
  return true;
};

function disposeSite(old) {
  old.scene.traverse((o) => {
    if (o.isMesh || o.isLine) o.geometry?.dispose();
  });
  old.sun.shadow.map?.dispose();
}

// ---------------------------------------------------------------- events

document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => app.setStep(Number(b.dataset.step))));
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => app.setTab(b.dataset.tab, !(app.drawer && app.tab === b.dataset.tab))));
$('drawerClose').addEventListener('click', () => app.setTab(app.tab, false));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => app.setView(b.dataset.view)));
$('playBtn').addEventListener('click', () => {
  if (!site.playing && site.window && site.time >= site.window.t1) site.time = site.window.t0;
  else if (site.isScene && !site.playing && !site.building) site.time = 0;
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
setRotateLater = setRotate;
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
  if (['overview', 'top', 'front', 'right'].includes(app.view)) app.setView(app.view, { noHistory: true });
};
// Every card starts folded to its header; clicking the header opens or folds it. Controls inside
// the header (library tabs, pop-out) only open a folded card.
document.addEventListener('click', (e) => {
  const head = e.target.closest('.panel > .ph, .panel > .ahead');
  if (!head) return;
  const panel = head.closest('.panel');
  if (panel.classList.contains('popped')) return;
  const control = e.target.closest('button, input, label, a');
  if (control && !control.matches('[data-min]')) {
    if (!panel.classList.contains('min-on')) return;
    panel.classList.remove('min-on');
  } else panel.classList.toggle('min-on');
  relayout();
});
// Chat cards: only the newest is open; click a card title to open or fold it.
$('msgs').addEventListener('click', (e) => {
  const h = e.target.closest('.card > h4');
  if (h && !e.target.closest('[data-pop]')) h.parentElement.classList.toggle('fold');
});
// One-click clean screen: hide every panel, keep only the 3D site.
const setClean = (on) => {
  document.body.classList.toggle('clean', on);
  relayout();
};
$('clearBtn').addEventListener('click', () => setClean(true));
$('restoreBtn').addEventListener('click', () => setClean(false));
setCleanLater = setClean;

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

// Parameters are typed in; nothing changes until the value is committed, and an out-of-range
// or empty value is refused with the allowed range instead of being clamped silently.
$('dockMain').addEventListener('change', (e) => {
  const input = e.target;
  const v = input.dataset.vparam;
  const m = input.dataset.mparam;
  if (!v && !m) return;
  const value = Number(String(input.value).replace(',', '.'));
  const min = Number(input.min);
  const max = Number(input.max);
  const unit = input.nextElementSibling?.textContent ?? '';
  const label = input.closest('.param')?.querySelector('label')?.firstChild?.textContent ?? '';
  if (input.value === '' || !Number.isFinite(value) || value < min || value > max) {
    input.classList.add('bad');
    app.toast(`${label} 需在 ${min}–${max} ${unit} 之间`, true);
    return;
  }
  input.classList.remove('bad');
  // Re-render after the focus has moved, so Tab lands on the next field of the new markup.
  setTimeout(() => {
    try {
      if (v) app.setVehicleParams({ [v]: value });
      else {
        SLIDERS.find((s) => s.key === m).set(value);
        app.refresh();
      }
      app.bump();
      app.toast(`${label} 已设为 ${value} ${unit}`);
    } catch (error) {
      app.toast(error.message, true);
    }
  }, 0);
});
// No wheel-scrubbing of typed values: the wheel scrolls the drawer instead.
$('dockMain').addEventListener('wheel', (e) => { if (e.target.matches('.nin input')) e.target.blur(); }, { passive: true });
$('dockMain').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.matches('.nin input')) {
    e.target.blur();
    renderDock();
  }
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
  rememberView();
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
  if (site.timeline && (app.product || site.isScene)) {
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
    } else if (!site.isScene && (app.view === 'follow' || app.view === 'crane')) {
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
    updateSelection();
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
    app.sampleDxf = app.baseDxf; // a new scene starts from the sample plant
    $('source').textContent = '主场景 · sample-plant.dxf';
    loading.textContent = '正在加载 AGV1…';
    await app.selectProduct('agv1');
    resize();
    app.setStep(4);
    app.setTab('gantt', false);
    loading.textContent = '正在载入项目库…';
    app.library = new Library(app);
    app.save = () => app.library?.persistSoon();
    await app.library.init();
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
  app.agent = agent;
  window.__app = app;
  window.__camera = camera;
  window.__controls = controls;
  window.__agent = agent;
  await agent.init();
}
// 可视化大屏: plant zones / devices map onto this scene's points and objects (SCENE_MAP in dashboard.js).
initDashboard(app, { locate: createSceneLocator(app) });
boot();
