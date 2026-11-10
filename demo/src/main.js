import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CATALOG, THUMBNAIL_ROOT } from './catalog.js';
import { SAMPLE_PLAN, Site, fitDepthRange } from './scene/site.js';
import { clampParam, mapAxis } from './stretch.js';
import { STANDARDS, applyBands, highlight, loadVehicle } from './vehicle.js';

const canvas = document.getElementById('view');
const stage = canvas.parentElement;
const labels = document.getElementById('labels');
const loadingEl = document.getElementById('loading');
const $ = (id) => document.getElementById(id);

const isCompact = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
const QUALITY = isCompact ? { pixelRatio: 1.5, shadowSize: 2048, shadowRadius: 3 } : { pixelRatio: 2, shadowSize: 4096, shadowRadius: 4 };
// Below this clearance the panel warns. A demo threshold, to be replaced by the customer's safety rule.
const CLEARANCE_WARNING_MM = 500;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const studio = new THREE.Scene();
studio.background = new THREE.Color(0xf5f6f7);
const pmrem = new THREE.PMREMGenerator(renderer);
studio.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
studio.environmentIntensity = 1.7;

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 900);
camera.position.set(4.9, 3.6, 6.2);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0.2, 0);
controls.maxPolarAngle = Math.PI * 0.495;

const sun = new THREE.DirectionalLight(0xffffff, 0.5);
sun.position.set(4, 9, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
studio.add(sun);

const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.ShadowMaterial({ opacity: 0.2 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
studio.add(ground);

const app = { step: 'select', product: null, vehicle: null, inputs: {}, states: new Map(), active: null };
const stateOf = () => app.states.get(app.product.id);

// Dimension lines (studio only)

const dimGeometry = new THREE.BufferGeometry();
dimGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18 * 3), 3));
const dimLines = new THREE.LineSegments(dimGeometry, new THREE.LineBasicMaterial({ color: 0x1b2127 }));
dimLines.frustumCulled = false;
studio.add(dimLines);

const dimEls = ['length', 'width', 'height'].map((key) => {
  const el = document.createElement('div');
  el.className = 'dim';
  labels.append(el);
  return { key, el, at: new THREE.Vector3() };
});

function formatMm(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function updateDimensions(bands) {
  const { extent } = app.product;
  const state = stateOf();
  const halfL = mapAxis(bands.length, extent.halfLength);
  const halfW = mapAxis(bands.width, extent.halfWidth);
  const top = mapAxis(bands.height, extent.height);
  const offset = 0.34;
  const zFront = halfW + offset;
  const xSide = halfL + offset;
  const tick = 0.05;
  const segments = [
    [-halfL, 0, zFront, halfL, 0, zFront],
    [-halfL, 0, zFront - tick, -halfL, 0, zFront + tick],
    [halfL, 0, zFront - tick, halfL, 0, zFront + tick],
    [xSide, 0, -halfW, xSide, 0, halfW],
    [xSide - tick, 0, -halfW, xSide + tick, 0, -halfW],
    [xSide - tick, 0, halfW, xSide + tick, 0, halfW],
    [-halfL - offset, 0, halfW, -halfL - offset, top, halfW],
    [-halfL - offset - tick, 0, halfW, -halfL - offset + tick, 0, halfW],
    [-halfL - offset - tick, top, halfW, -halfL - offset + tick, top, halfW],
  ];
  const array = dimGeometry.attributes.position.array;
  segments.flat().forEach((value, index) => { array[index] = value; });
  dimGeometry.attributes.position.needsUpdate = true;
  dimEls[0].at.set(0, 0, zFront);
  dimEls[1].at.set(xSide, 0, 0);
  dimEls[2].at.set(-halfL - offset, top / 2, halfW);
  dimEls[0].el.textContent = `长 ${formatMm(state.length)} mm`;
  dimEls[1].el.textContent = `宽 ${formatMm(state.width)} mm`;
  dimEls[2].el.textContent = `高 ${formatMm(state.height)} mm`;
}

const projected = new THREE.Vector3();
function placeLabels() {
  for (const { el, at } of dimEls) {
    projected.copy(at).project(camera);
    el.style.left = `${(projected.x * 0.5 + 0.5) * stage.clientWidth}px`;
    el.style.top = `${(-projected.y * 0.5 + 0.5) * stage.clientHeight}px`;
  }
}

function applyParams() {
  const bands = applyBands(app.product, stateOf());
  updateDimensions(bands);
  if (site?.timeline && app.step === 'site') refreshSiteVehicle();
}

// Panel: catalog

function specLine(product) {
  const { length, width, height } = product.params;
  return `${length.nominal} × ${width.nominal} × ${height.nominal} mm`;
}

function buildCatalog() {
  const list = $('catalog');
  for (const product of CATALOG) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.product = product.id;
    button.setAttribute('aria-pressed', 'false');
    const image = document.createElement('img');
    image.src = `${THUMBNAIL_ROOT}/${product.thumbnail}`;
    image.alt = '';
    const text = document.createElement('span');
    text.innerHTML = '<strong></strong><small></small><small></small>';
    const [name, plate, spec] = text.children;
    name.textContent = product.model;
    plate.textContent = `${product.plate} · ${product.summary}`;
    spec.textContent = specLine(product);
    button.append(image, text);
    button.addEventListener('click', () => chooseProduct(product));
    item.append(button);
    list.append(item);
  }
}

async function chooseProduct(product, advance = true) {
  loadingEl.hidden = false;
  loadingEl.textContent = `正在加载 ${product.model}…`;
  try {
    const vehicle = await loadVehicle(product);
    if (app.vehicle) {
      highlight(app.vehicle, null);
      app.vehicle.root.removeFromParent();
    }
    app.product = product;
    app.vehicle = vehicle;
    app.active = null;
    if (!app.states.has(product.id)) {
      app.states.set(product.id, Object.fromEntries(Object.entries(product.params).map(([key, param]) => [key, param.nominal])));
    }
    studio.add(vehicle.root);
    vehicle.root.position.set(0, 0, 0);
    vehicle.root.rotation.set(0, 0, 0);
    for (const button of document.querySelectorAll('#catalog button')) {
      button.setAttribute('aria-pressed', String(button.dataset.product === product.id));
    }
    buildParams();
    buildStandards();
    syncInputs();
    applyParams();
    $('stats').textContent = `网页模型 ${(vehicle.manifest.triangles / 10000).toFixed(1)} 万面（原始 ${(vehicle.manifest.sourceTriangles / 10000).toFixed(0)} 万面）`;
    autoFrame = true;
    loadingEl.hidden = true;
    if (advance) await goTo('size');
  } catch (error) {
    console.error(error);
    loadingEl.textContent = `模型加载失败：${error.message}`;
  }
}

// Panel: parameters

function buildParams() {
  const root = $('params');
  root.replaceChildren();
  app.inputs = {};
  for (const [key, param] of Object.entries(app.product.params)) {
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="param-head">
        <label for="n-${key}">${param.label}</label>
        <span class="value-box"><input id="n-${key}" type="number" inputmode="decimal" min="${param.min}" max="${param.max}" step="${param.step}" />mm</span>
      </div>
      <input id="r-${key}" type="range" aria-label="${param.label}" min="${param.min}" max="${param.max}" step="${param.step}" />
      <div class="range-ends"><span>${param.min}</span><span>标准 ${param.nominal}</span><span>${param.max}</span></div>`;
    root.append(row);
    const number = row.querySelector(`#n-${key}`);
    const range = row.querySelector(`#r-${key}`);
    app.inputs[key] = { number, range };
    range.addEventListener('input', () => setParam(key, Number(range.value)));
    number.addEventListener('change', () => setParam(key, number.valueAsNumber));
  }
}

function setParam(key, value) {
  const clamped = clampParam(app.product.params[key], value);
  stateOf()[key] = Number(clamped.toFixed(3));
  syncInputs();
  applyParams();
}

function syncInputs() {
  const state = stateOf();
  for (const [key, { number, range }] of Object.entries(app.inputs)) {
    number.value = state[key];
    range.value = state[key];
  }
}

function buildStandards() {
  const list = $('standards');
  list.replaceChildren();
  const { manifest } = app.vehicle;
  const buttons = [];
  for (const item of STANDARDS) {
    const info = manifest.classes[item.key];
    if (!info) continue;
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = item.swatch;
    const name = document.createElement('span');
    name.textContent = item.label;
    button.append(swatch, name);
    if (item.showSize) {
      const size = info.max.map((v, i) => Math.round((v - info.min[i]) * 1000));
      const dims = document.createElement('span');
      dims.className = 'size';
      dims.textContent = `${size[0]}×${size[1]}×${size[2]}`;
      button.append(dims);
    }
    button.addEventListener('click', () => {
      app.active = app.active === item.key ? null : item.key;
      highlight(app.vehicle, app.active);
      for (const b of buttons) b.setAttribute('aria-pressed', String(b === button && app.active !== null));
    });
    buttons.push(button);
    li.append(button);
    list.append(li);
  }
}

// Steps

const TITLES = { select: '产品选型', size: () => app.product.model, site: () => `${app.product.model} 现场运行` };

async function goTo(step) {
  if (step !== 'select' && !app.product) return;
  if (step === 'site') {
    const ready = await enterSite();
    if (!ready) return;
  } else if (app.step === 'site') {
    leaveSite();
  }
  app.step = step;
  for (const name of ['select', 'size', 'site']) $(`step-${name}`).hidden = name !== step;
  for (const button of document.querySelectorAll('.steps button')) {
    if (button.dataset.step === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  const title = TITLES[step];
  $('title').textContent = typeof title === 'function' ? title() : title;
  showDimensions(step === 'size');
  $('stats').hidden = step === 'site';
}

function showDimensions(visible) {
  labels.hidden = !visible;
  dimLines.visible = visible;
}

// Site

let site = null;
let viewMode = 'overview';
const lastCarrier = new THREE.Vector3();

async function ensureSite() {
  if (site) return site;
  const instance = new Site(renderer, QUALITY);
  await instance.loadEnvironment();
  const text = await fetch(SAMPLE_PLAN).then((response) => {
    if (!response.ok) throw new Error(`读不到示例平面图（${response.status}）`);
    return response.text();
  });
  await instance.loadPlanText(text, '模拟平面图 sample-plant.dxf');
  site = instance;
  instance.speed = Number($('speed').value);
  buildStops();
  $('source').textContent = instance.sourceName;
  return site;
}

async function enterSite() {
  loadingEl.hidden = false;
  loadingEl.textContent = '正在搭建现场…';
  try {
    await ensureSite();
  } catch (error) {
    console.error(error);
    loadingEl.textContent = `现场加载失败：${error.message}`;
    return false;
  }
  site.setVehicle(app.vehicle.root, app.product, stateOf());
  applyBands(app.product, stateOf());
  renderer.toneMappingExposure = 0.8;
  loadingEl.hidden = true;
  setView('overview');
  refreshSiteVehicle();
  return true;
}

function leaveSite() {
  studio.add(app.vehicle.root);
  app.vehicle.root.position.set(0, 0, 0);
  app.vehicle.root.rotation.set(0, 0, 0);
  renderer.toneMappingExposure = 0.62;
  controls.minDistance = 1.5;
  controls.maxDistance = 30;
  controls.target.set(0, 0.2, 0);
  camera.position.set(4.9, 3.6, 6.2);
  autoFrame = true;
  controls.maxPolarAngle = Math.PI * 0.495;
}

let clearanceTimer = 0;
function refreshSiteVehicle() {
  site.updateVehicleSize(app.product, stateOf());
  site.renderPose();
  clearTimeout(clearanceTimer);
  clearanceTimer = setTimeout(() => {
    const worst = site.clearance();
    const el = $('clearance');
    const hit = worst.distance < CLEARANCE_WARNING_MM;
    el.className = `clearance${hit ? ' warn' : ''}`;
    el.textContent = worst.distance <= 0
      ? `碰撞：车或货物会撞到 ${worst.label}，请减小尺寸或改路线`
      : `全程最小净距 ${Math.round(worst.distance)} mm（${worst.label}）${hit ? `，低于 ${CLEARANCE_WARNING_MM} mm` : ''}`;
  }, 120);
}

function buildStops() {
  const list = $('stops');
  list.replaceChildren();
  const names = { PICK: '取货', DROP: '卸货', CHARGE: '充电' };
  site.timeline.stops.forEach((station, index) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${index + 1}. ${station.id}`;
    const kind = document.createElement('span');
    kind.textContent = names[station.type];
    li.append(name, kind);
    list.append(li);
  });
  $('scrub').max = String(Math.round(site.timeline.duration * 10));
}

function setView(mode) {
  viewMode = mode;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === mode));
  autoFrame = false;
  const { centre, size } = site.built;
  const cx = centre.x / 1000;
  const cz = -centre.y / 1000;
  controls.minDistance = 2;
  controls.maxDistance = 320;
  if (mode === 'overview') {
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(cx, 0, cz);
    fitFromDirection(new THREE.Vector3(cx, 0, cz), new THREE.Vector3(-0.26, 0.66, 0.7).normalize(), size);
  } else if (mode === 'top') {
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(cx, 0, cz);
    camera.position.set(cx, fitDistance(size.x * 1.04, size.y * 1.04), cz + 0.01);
  } else {
    controls.maxPolarAngle = Math.PI * 0.49;
    const { position } = site.carrier;
    controls.target.copy(position).setY(0.5);
    // High enough to see over the machines.
    camera.position.set(position.x - 6, 9, position.z + 7.5);
    lastCarrier.copy(position);
  }
}

// Moves the camera back along a direction until the whole hall is in frame.
function fitFromDirection(target, direction, size) {
  const corners = [];
  for (const x of [-1, 1]) for (const z of [-1, 1]) for (const y of [0, 12]) corners.push(new THREE.Vector3(target.x + (x * size.x) / 2, y, target.z + (z * size.y) / 2));
  const point = new THREE.Vector3();
  for (let distance = 20; distance < 400; distance *= 1.03) {
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const fits = corners.every((corner) => {
      point.copy(corner).project(camera);
      return Math.abs(point.x) < 0.97 && Math.abs(point.y) < 0.95;
    });
    if (fits) return;
  }
}

function fitDistance(width, depth) {
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  return Math.max(width / 2 / Math.tan(horizontal), depth / 2 / Math.tan(vertical));
}

function updateSitePanel() {
  const { pose } = site;
  const norm = ((((pose.heading * 180) / Math.PI) % 360) + 360) % 360;
  $('r-x').textContent = `${pose.x.toFixed(1)} mm`;
  $('r-y').textContent = `${pose.y.toFixed(1)} mm`;
  $('r-h').textContent = `${norm.toFixed(2)}°`;
  $('r-v').textContent = `${(pose.speed / 1000).toFixed(2)} m/s`;
  const { text, stop } = site.status();
  $('status').textContent = text;
  [...$('stops').children].forEach((li, index) => li.setAttribute('aria-current', String(index === stop)));
  const scrub = $('scrub');
  if (document.activeElement !== scrub) scrub.value = String(Math.round(site.time * 10));
  const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  $('clock').textContent = `${clock(site.time)} / ${clock(site.timeline.duration)}`;
}

async function importPlan(file) {
  const source = $('source');
  try {
    await site.loadPlanText(await file.text(), `已导入 ${file.name}`);
    buildStops();
    source.className = 'hint';
    source.textContent = site.sourceName;
    site.setVehicle(app.vehicle.root, app.product, stateOf());
    setView('overview');
    refreshSiteVehicle();
  } catch (error) {
    console.error(error);
    source.className = 'hint error';
    source.textContent = `导入失败：${error.message}`;
  }
}

function exportImage() {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const previous = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.min(3840 / width, 3));
  renderer.setSize(width, height, false);
  renderer.render(site.scene, camera);
  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${app.product.id}-现场-${Math.round(site.time)}s.png`;
    link.click();
    URL.revokeObjectURL(link.href);
  }, 'image/png');
  renderer.setPixelRatio(previous);
  renderer.setSize(width, height, false);
}

// Loop

function resize() {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

let autoFrame = true;
controls.addEventListener('start', () => { autoFrame = false; });
const toCamera = new THREE.Vector3();

function framingDistance() {
  const state = stateOf();
  const halfL = state.length / 2000 + 0.55;
  const halfW = state.width / 2000 + 0.55;
  const radius = Math.hypot(halfL, halfW, state.height / 2000);
  const verticalHalf = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * camera.aspect);
  return (radius * 1.04) / Math.sin(Math.min(verticalHalf, horizontalHalf));
}

function frameVehicle() {
  if (!autoFrame || !app.product) return;
  toCamera.subVectors(camera.position, controls.target);
  const distance = THREE.MathUtils.lerp(toCamera.length(), framingDistance(), 0.14);
  camera.position.copy(controls.target).addScaledVector(toCamera.normalize(), distance);
}

const clock = new THREE.Clock();
function animate() {
  const delta = Math.min(clock.getDelta(), 0.1);
  if (app.step === 'site') {
    site.update(delta, camera);
    if (viewMode === 'follow') {
      const { position } = site.carrier;
      const moved = position.clone().sub(lastCarrier);
      controls.target.add(moved);
      camera.position.add(moved);
      lastCarrier.copy(position);
    }
    updateSitePanel();
    controls.update();
    fitDepthRange(camera, controls.target);
    renderer.render(site.scene, camera);
  } else {
    frameVehicle();
    controls.update();
    fitDepthRange(camera, controls.target);
    renderer.render(studio, camera);
    placeLabels();
  }
  requestAnimationFrame(animate);
}

for (const button of document.querySelectorAll('.steps button')) button.addEventListener('click', () => goTo(button.dataset.step));
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
$('to-site').addEventListener('click', () => goTo('site'));
$('reset').addEventListener('click', () => {
  for (const [key, param] of Object.entries(app.product.params)) stateOf()[key] = param.nominal;
  autoFrame = true;
  syncInputs();
  applyParams();
});
$('play').addEventListener('click', () => {
  site.playing = !site.playing;
  $('play').textContent = site.playing ? '暂停' : '播放';
});
$('speed').addEventListener('change', () => { site.speed = Number($('speed').value); });
$('scrub').addEventListener('input', () => {
  site.time = Number($('scrub').value) / 10;
  site.renderPose();
});
$('export').addEventListener('click', exportImage);
$('dxf').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (file) importPlan(file);
  event.target.value = '';
});

buildCatalog();
new ResizeObserver(resize).observe(stage);
resize();
showDimensions(false);
chooseProduct(CATALOG[0], false);
animate();
