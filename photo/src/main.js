// Photo site: calibrate a floor rectangle in a photo, drop a catalog product into it, export a PNG.
import { CATALOG, THUMBNAIL_ROOT } from '../../demo/src/catalog.js';
import { CORNER_NAMES, CalibrationError, calibrate, imageToGround } from './calibrate.js';
import { PhotoOverlay } from './overlay.js';

const SAMPLE = '/photo/sample-floor';
const EXPORT_MAX = 3840;
const $ = (id) => document.getElementById(id);

const stage = $('stage');
const frame = $('frame');
const photo = $('photo');
const handles = $('handles');
const loupe = $('loupe');
const overlay = new PhotoOverlay($('gl'));

const app = {
  step: 'photo',
  name: '',
  size: null,
  points: [],
  calibration: null,
  product: null,
  pose: { x: 0, z: 0, heading: 0 },
  drag: null,
  dirty: true,
};

const status = (text) => {
  $('status').textContent = text;
};
const redraw = () => {
  app.dirty = true;
};

// Layout: the frame keeps the photo's aspect ratio inside the stage, so frame pixels map linearly to photo pixels.

function layout() {
  if (!app.size) return;
  const pad = 16;
  const sw = stage.clientWidth - pad * 2;
  const sh = stage.clientHeight - pad * 2;
  const k = Math.min(sw / app.size.width, sh / app.size.height);
  const w = Math.round(app.size.width * k);
  const h = Math.round(app.size.height * k);
  Object.assign(frame.style, { width: `${w}px`, height: `${h}px`, left: `${(stage.clientWidth - w) / 2}px`, top: `${(stage.clientHeight - h) / 2}px` });
  $('marks').setAttribute('viewBox', `0 0 ${app.size.width} ${app.size.height}`);
  $('marks').setAttribute('preserveAspectRatio', 'none');
  overlay.setSize(w, h, Math.min(window.devicePixelRatio, 2));
  redraw();
}

function toPhoto(event) {
  const rect = frame.getBoundingClientRect();
  const u = ((event.clientX - rect.left) / rect.width) * app.size.width;
  const v = ((event.clientY - rect.top) / rect.height) * app.size.height;
  return [Math.min(app.size.width, Math.max(0, u)), Math.min(app.size.height, Math.max(0, v))];
}

// Steps

function setStep(step) {
  app.step = step;
  for (const button of document.querySelectorAll('.steps button')) {
    if (button.dataset.step === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  for (const name of ['photo', 'points', 'place']) $(`step-${name}`).hidden = name !== step;
  frame.dataset.mode = step;
  overlay.showGrid(step === 'points' && $('grid').checked);
  overlay.carrier.visible = step === 'place';
  updateSteps();
  redraw();
}

function updateSteps() {
  const buttons = Object.fromEntries([...document.querySelectorAll('.steps button')].map((b) => [b.dataset.step, b]));
  buttons.points.disabled = !app.size;
  buttons.place.disabled = !app.calibration;
  $('to-place').disabled = !app.calibration;
}

// Photo

async function loadPhoto(url, name, preset) {
  await new Promise((resolve, reject) => {
    photo.onload = resolve;
    photo.onerror = () => reject(new Error('照片读不出来，换一张 JPG 或 PNG 试试。'));
    photo.src = url;
  });
  app.name = name;
  app.size = { width: photo.naturalWidth, height: photo.naturalHeight };
  app.points = preset?.points ?? [];
  app.calibration = null;
  if (preset) {
    $('ab').value = preset.ab;
    $('bc').value = preset.bc;
  }
  frame.hidden = false;
  $('empty').hidden = true;
  $('photo-info').textContent = `${name}：${app.size.width} × ${app.size.height}`;
  layout();
  recalibrate();
  setStep('points');
}

$('upload').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    await loadPhoto(URL.createObjectURL(file), file.name);
    status('照片只在本机浏览器里处理，不上传。');
  } catch (error) {
    $('photo-info').textContent = error.message;
  }
});

$('sample').addEventListener('click', async () => {
  const meta = await fetch(`${SAMPLE}.json`).then((r) => r.json());
  await loadPhoto(`${SAMPLE}.jpg`, '示例照片（程序生成，demo_data）', { points: meta.rectangle.pixels, ab: meta.rectangle.ab, bc: meta.rectangle.bc });
  status('示例照片已带参考点（黄线中心），可以拖动试试误差怎么变。');
});

// Points

function drawPoints() {
  handles.replaceChildren(
    ...app.points.map(([u, v], i) => {
      const el = document.createElement('div');
      el.className = 'handle';
      el.dataset.index = i;
      el.style.left = `${(u / app.size.width) * 100}%`;
      el.style.top = `${(v / app.size.height) * 100}%`;
      const label = document.createElement('span');
      label.textContent = CORNER_NAMES[i];
      el.append(label);
      return el;
    }),
  );
  $('quad').setAttribute('points', app.points.map((p) => p.join(',')).join(' '));
  const next = CORNER_NAMES[app.points.length];
  $('progress').textContent = app.points.length < 4 ? `已点 ${app.points.length} / 4，下一个点 ${next}` : '4 个点已点完，可以拖动微调。';
}

function lengths() {
  return { ab: Number.parseFloat($('ab').value), bc: Number.parseFloat($('bc').value) };
}

function recalibrate() {
  drawPoints();
  const box = $('calib-error');
  box.hidden = true;
  $('result').hidden = true;
  app.calibration = null;
  if (app.points.length === 4) {
    try {
      const calibration = calibrate({ imageSize: app.size, points: app.points, ground: lengths() });
      app.calibration = calibration;
      overlay.setCalibration(calibration);
      showResult(calibration);
    } catch (error) {
      if (!(error instanceof CalibrationError)) throw error;
      box.textContent = error.message;
      box.hidden = false;
    }
  }
  if (!app.calibration) overlay.renderer.clear();
  overlay.showGrid(app.step === 'points' && $('grid').checked && !!app.calibration);
  updateSteps();
  updateExport();
  redraw();
}

function showResult(c) {
  $('result').hidden = false;
  $('error').textContent = `${(c.error * 100).toFixed(1)}%`;
  $('badge').textContent = c.ok ? '可出图' : '不能出图';
  $('badge').classList.toggle('bad', !c.ok);
  $('message').textContent = c.message;
  const rows = c.checks.map((check) => {
    const bad = check.error > c.maxError ? ' class="bad"' : '';
    return `<tr><td>${check.side}</td><td>${check.known.toFixed(2)}</td><td>${check.measured.toFixed(3)}</td><td${bad}>${(check.error * 100).toFixed(2)}%</td></tr>`;
  });
  $('checks').innerHTML = `<tr><th>边</th><th>已知 m</th><th>反算 m</th><th>误差</th></tr>${rows.join('')}`;
  $('r-focal').textContent = `${c.focal35mm.toFixed(0)} mm`;
  $('r-height').textContent = `${c.cameraHeight.toFixed(2)} m`;
  $('r-pitch').textContent = `${c.pitchDeg.toFixed(1)}°`;
  $('r-reproj').textContent = `${c.reprojectionPx.toFixed(1)} px`;
  $('warnings').textContent = c.warnings.join(' ');
}

for (const id of ['ab', 'bc']) $(id).addEventListener('input', recalibrate);
$('clear').addEventListener('click', () => {
  app.points = [];
  recalibrate();
});
$('grid').addEventListener('change', () => {
  overlay.showGrid($('grid').checked && !!app.calibration);
  redraw();
});

// Loupe: 3x zoom around the pointer while aiming or dragging a corner.
function showLoupe([u, v]) {
  const ctx = loupe.getContext('2d');
  const k = frame.clientWidth / app.size.width;
  const span = 160 / (3 * k);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 160, 160);
  ctx.drawImage(photo, u - span / 2, v - span / 2, span, span, 0, 0, 160, 160);
  ctx.strokeStyle = '#d7000f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(80, 60);
  ctx.lineTo(80, 100);
  ctx.moveTo(60, 80);
  ctx.lineTo(100, 80);
  ctx.stroke();
  loupe.hidden = false;
}

// Product placement

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
    const { length, width, height } = product.params;
    text.innerHTML = '<strong></strong><small></small><small></small>';
    text.children[0].textContent = product.model;
    text.children[1].textContent = product.summary;
    text.children[2].textContent = `${length.nominal} × ${width.nominal} × ${height.nominal} mm（标准尺寸）`;
    button.append(image, text);
    button.addEventListener('click', () => chooseProduct(product));
    item.append(button);
    list.append(item);
  }
}

async function chooseProduct(product) {
  status(`正在加载 ${product.model}…`);
  try {
    await overlay.setProduct(product);
  } catch (error) {
    console.error(error);
    status(`模型加载失败：${error.message}`);
    return;
  }
  app.product = product;
  for (const button of document.querySelectorAll('#catalog button')) button.setAttribute('aria-pressed', String(button.dataset.product === product.id));
  setPose(app.pose);
  updateExport();
  status(`${product.model} 按标准尺寸放进照片。`);
}

function centrePose() {
  const c = app.calibration.corners;
  const x = c.reduce((s, p) => s + p[0], 0) / 4;
  const z = c.reduce((s, p) => s + p[2], 0) / 4;
  return { x, z, heading: 0 };
}

function setPose(pose) {
  const heading = ((((pose.heading + 180) % 360) + 360) % 360) - 180;
  app.pose = { ...pose, heading };
  $('heading').value = String(Math.round(heading));
  $('heading-out').textContent = `${Math.round(heading)}°`;
  overlay.setPose(app.pose);
  redraw();
}

$('heading').addEventListener('input', () => setPose({ ...app.pose, heading: Number($('heading').value) }));
$('exposure').addEventListener('input', () => {
  overlay.setExposure(Number($('exposure').value));
  $('exposure-out').textContent = Number($('exposure').value).toFixed(2);
  redraw();
});
$('center').addEventListener('click', () => setPose(centrePose()));
$('back').addEventListener('click', () => setStep('points'));
$('to-place').addEventListener('click', async () => {
  setStep('place');
  setPose(centrePose());
  if (!app.product) await chooseProduct(CATALOG[0]);
});

// Pointer handling on the photo

frame.addEventListener('pointerdown', (event) => {
  if (!app.size || event.button !== 0) return;
  const at = toPhoto(event);
  if (app.step === 'points') {
    const handle = event.target.closest('.handle');
    if (handle) {
      app.drag = { kind: 'corner', index: Number(handle.dataset.index) };
    } else if (app.points.length < 4) {
      app.points.push(at);
      app.drag = { kind: 'corner', index: app.points.length - 1 };
      recalibrate();
    } else {
      return;
    }
    showLoupe(at);
  } else if (app.step === 'place' && app.calibration && app.product) {
    const ground = imageToGround(app.calibration, at);
    if (!ground) return;
    const dx = ground[0] - app.pose.x;
    const dz = ground[2] - app.pose.z;
    if (Math.hypot(dx, dz) > overlay.footprintRadius()) {
      setPose({ ...app.pose, x: ground[0], z: ground[2] });
      app.drag = { kind: 'vehicle', dx: 0, dz: 0 };
    } else {
      app.drag = { kind: 'vehicle', dx, dz };
    }
    frame.classList.add('dragging');
  } else {
    return;
  }
  frame.setPointerCapture(event.pointerId);
  event.preventDefault();
});

frame.addEventListener('pointermove', (event) => {
  if (!app.size) return;
  const at = toPhoto(event);
  if (!app.drag) {
    if (app.step === 'points' && app.points.length < 4 && event.pointerType === 'mouse') showLoupe(at);
    return;
  }
  if (app.drag.kind === 'corner') {
    app.points[app.drag.index] = at;
    showLoupe(at);
    recalibrate();
  } else {
    const ground = imageToGround(app.calibration, at);
    if (ground) setPose({ ...app.pose, x: ground[0] - app.drag.dx, z: ground[2] - app.drag.dz });
  }
});

const endDrag = () => {
  app.drag = null;
  loupe.hidden = true;
  frame.classList.remove('dragging');
};
frame.addEventListener('pointerup', endDrag);
frame.addEventListener('pointercancel', endDrag);
frame.addEventListener('pointerleave', () => {
  if (!app.drag) loupe.hidden = true;
});

frame.addEventListener(
  'wheel',
  (event) => {
    if (app.step !== 'place' || !app.product) return;
    event.preventDefault();
    setPose({ ...app.pose, heading: app.pose.heading + Math.sign(event.deltaY) * 5 });
  },
  { passive: false },
);

for (const button of document.querySelectorAll('.steps button')) {
  button.addEventListener('click', () => {
    if (button.dataset.step === 'place') $('to-place').click();
    else setStep(button.dataset.step);
  });
}

// Export

function exportSize() {
  const scale = Math.min(1, EXPORT_MAX / Math.max(app.size.width, app.size.height));
  return [Math.round(app.size.width * scale), Math.round(app.size.height * scale)];
}

function updateExport() {
  const button = $('export');
  const info = $('export-info');
  if (!app.calibration) {
    button.disabled = true;
    info.textContent = '先完成标定。';
  } else if (!app.calibration.ok) {
    button.disabled = true;
    info.textContent = `标定误差 ${(app.calibration.error * 100).toFixed(1)}% 超过 3%，不能出图。回到第 2 步重新点。`;
  } else if (!app.product) {
    button.disabled = true;
    info.textContent = '先选一台车。';
  } else {
    button.disabled = false;
    const [w, h] = exportSize();
    info.textContent = `导出 ${w} × ${h} PNG，车按标准尺寸，标定误差 ${(app.calibration.error * 100).toFixed(1)}%。`;
  }
}

function composite() {
  const caption = `卫华 · 照片现场 · ${app.product.model} · 标定误差 ${(app.calibration.error * 100).toFixed(1)}%`;
  return overlay.compose(photo, { maxSide: EXPORT_MAX, caption });
}

$('export').addEventListener('click', () => {
  const started = performance.now();
  const canvas = composite();
  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `照片现场-${app.product.id}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    status(`已导出 ${canvas.width} × ${canvas.height}，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`);
  }, 'image/png');
});

// Loop

function frameLoop() {
  if (app.dirty && app.size && app.calibration) {
    overlay.render();
    app.dirty = false;
  }
  requestAnimationFrame(frameLoop);
}

buildCatalog();
new ResizeObserver(layout).observe(stage);
requestAnimationFrame(frameLoop);
setStep('photo');

if (import.meta.env.DEV) window.photoSite = { app, overlay, composite };
