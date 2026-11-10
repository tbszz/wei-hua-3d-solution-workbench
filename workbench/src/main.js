import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Site } from './site.js';
import { CATALOG as VEHICLE_CATALOG } from '../../demo/src/catalog.js';
import { loadVehicle } from '../../demo/src/vehicle.js';

const root = document.querySelector('#app');
root.innerHTML = `
<header class="topbar">
  <div class="brand"><span class="brand-mark">卫华</span><span>3D 方案工作台</span><span class="demo-badge">示意数据</span></div>
  <div class="mode" id="mode">离线模式</div>
  <nav class="workflow" aria-label="方案流程">${['图纸与点位','选型参数','流程说明','全流程动画','效率节拍','行程可视化','出图下发'].map((label, i) => `<button data-step="${i + 1}" class="${i === 0 ? 'active' : ''}" ${i === 6 ? 'disabled' : ''}><b>${i + 1}</b><span>${label}</span>${i === 6 ? '<em>后期</em>' : ''}</button>`).join('')}</nav>
</header>
<main class="workspace">
  <section class="viewport-shell">
    <div class="viewport-toolbar"><span id="scene-state">等待导入厂房</span><div class="camera-actions"><button data-camera="overview">总览</button><button data-camera="top">俯视</button><button data-camera="crane">行车</button><button id="show-travel">轨迹</button></div></div>
    <div class="viewport"><canvas id="view"></canvas><div id="viewport-labels"></div><div id="viewport-toast" hidden></div></div>
    <section class="bottom-panel">
      <div class="panel-tabs">${['时间轴','工序表','点位表','效率','行程 / 甘特图'].map((label, i) => `<button data-tab="${i}" class="${i === 0 ? 'active' : ''}">${label}</button>`).join('')}</div>
      <div id="panel-content"></div>
    </section>
  </section>
  <aside class="agent-panel">
    <div class="agent-head"><div><p class="eyebrow">WEIHUA AGENT</p><h1>方案协作</h1></div><span class="version" id="version">v0</span></div>
    <div class="plan-summary" id="plan-summary"></div>
    <div class="chat-log" id="chat-log"><div class="bubble assistant">你好，我是卫华方案 Agent。可以导入示例厂房、配置 AGV / 起重机、生成工序和播放动画。当前模式见顶部状态。</div></div>
    <form class="chat-form" id="chat-form"><textarea id="chat-input" rows="2" placeholder="例如：导入示例厂房"></textarea><button class="send" type="submit">发送</button></form>
    <div class="quick"><button data-command="导入示例厂房">导入示例厂房</button><button data-command="选 AGV1，车长改成 3200">AGV1 · 3200</button><button data-command="流程：AGV 从 RM-01 接卷送到吊装点，行车把卷吊到成品区，AGV 回充电位">生成流程</button></div>
  </aside>
</main>
<div id="r14" class="modal" hidden><div class="modal-card"><button class="modal-close">×</button><h2>第 7 步：出图下发（后期）</h2><p>按 PRD R14，本版本只保留说明入口。出图、视频录制和下发将在后续版本接入渲染任务与视频生产线。</p></div></div>
<div id="selection-modal" class="modal selection-modal" hidden aria-hidden="true"><div class="selection-card" role="dialog" aria-modal="true" aria-labelledby="selection-title"><button class="modal-close selection-close" aria-label="关闭">×</button><div class="selection-kicker">SELECTION / DETAIL</div><div class="selection-card-head" data-drag-handle><div><h2 id="selection-title">选型参数</h2><p id="selection-subtitle">服务端 ScenePlan</p></div><span class="selection-state">已校验</span></div><div id="selection-card-content"></div><div class="selection-card-actions"><button class="ghost-action selection-close">返回视口</button><button class="primary-action" id="selection-chat">让 Agent 调整</button></div></div></div>`;

const $ = (selector) => document.querySelector(selector);
const canvas = $('#view');
const viewport = $('.viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 900);
camera.position.set(62, 64, 72);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
const fallbackScene = new THREE.Scene();
fallbackScene.background = new THREE.Color(0xf5f6f7);
fallbackScene.add(new THREE.HemisphereLight(0xffffff, 0x6f7780, 2.4));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 100), new THREE.MeshStandardMaterial({ color: 0xcbd0d4, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
fallbackScene.add(ground);
let site;
let craneGroup;
let pointGroup = new THREE.Group();
let pointLabels = [];
fallbackScene.add(pointGroup);
let plan = null;
let activeTab = 0;
let selectedStep = 0;
let lastTime = performance.now();

function addToast(text, danger = false) {
  const toast = $('#viewport-toast');
  toast.textContent = text;
  toast.className = danger ? 'danger' : '';
  toast.hidden = false;
  clearTimeout(addToast.timer);
  addToast.timer = setTimeout(() => { toast.hidden = true; }, 3400);
}
function formatMm(value) { return Number(value).toLocaleString('zh-CN'); }

function craneDemo(data) {
  const group = new THREE.Group();
  group.name = '双梁桥式起重机（示意）';
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf5b800, metalness: 0.28, roughness: 0.42 });
  const red = new THREE.MeshStandardMaterial({ color: 0xd7000f, metalness: 0.15, roughness: 0.48 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x353a40, metalness: 0.7, roughness: 0.3 });
  const span = (data?.params?.span ?? 22500) / 1000;
  const lift = (data?.params?.liftHeight ?? 12000) / 1000;
  const main = new THREE.Group(); main.name = '大车';
  for (const z of [-span / 2, span / 2]) main.add(new THREE.Mesh(new THREE.BoxGeometry(48, 0.42, 0.34), yellow));
  main.add(new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.5, span), yellow));
  for (const x of [-22, 22]) main.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.5, 0.5), yellow).translateY(3.2));
  group.add(main);
  const trolley = new THREE.Group(); trolley.name = '小车';
  trolley.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 2.2), red));
  trolley.position.y = 7.2; group.add(trolley);
  const hook = new THREE.Group(); hook.name = '吊具';
  hook.add(new THREE.Mesh(new THREE.BoxGeometry(0.18, 4.3, 0.18), steel));
  const cHook = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.13, 12, 28, Math.PI * 1.5), yellow);
  cHook.rotation.z = Math.PI / 2; cHook.position.y = -2.1; hook.add(cHook);
  hook.position.set(0, 7.1, 0); group.add(hook);
  const rope = new THREE.Group(); rope.name = '钢丝绳';
  rope.add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 5.5, 8), steel));
  rope.position.set(0, 9.8, 0); group.add(rope);
  group.position.set(48, 0, -20);
  group.traverse((node) => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; } });
  return group;
}

function redrawPoints() {
  pointGroup.clear();
  pointLabels = [];
  $('#viewport-labels').replaceChildren();
  if (!plan?.site) return;
  for (const station of [...plan.site.stations, ...plan.site.points]) {
    const color = station.type === 'PICK' ? 0xd7000f : station.type === 'CHARGE' ? 0x2b7de9 : 0xf5b800;
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.18, 20), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22 }));
    marker.position.set(station.x / 1000, 0.16, -station.y / 1000);
    marker.userData.stationId = station.id;
    pointGroup.add(marker);
    const label = document.createElement('span'); label.className = 'point-label'; label.textContent = station.id; $('#viewport-labels').append(label); pointLabels.push({ label, station });
  }
}

function updatePointLabels() {
  if (!site) return;
  const projected = new THREE.Vector3();
  for (const item of pointLabels) { projected.set(item.station.x / 1000, 0.3, -item.station.y / 1000).project(camera); item.label.style.left = ((projected.x * 0.5 + 0.5) * viewport.clientWidth) + 'px'; item.label.style.top = ((-projected.y * 0.5 + 0.5) * viewport.clientHeight) + 'px'; }
}

function updateScene() {
  if (!site || !plan) return;
  site.updateVehicleSize(VEHICLE_CATALOG.find((x) => x.id === plan.product.id) ?? VEHICLE_CATALOG[0], { ...plan.product.params, height: plan.product.params.height ?? 381.9 });
  site.renderPose();
  if (craneGroup) craneGroup.visible = Boolean(plan.crane);
  if (plan.crane && !craneGroup) { craneGroup = craneDemo(plan.crane); site.scene.add(craneGroup); }
  redrawPoints();
  $('#scene-state').textContent = plan.site?.source ? `${plan.site.source} · ${plan.site.stations.length + plan.site.points.length} 个点位` : '等待导入厂房';
  $('#version').textContent = `v${plan.version}`;
  $('#plan-summary').innerHTML = `<span>${plan.product.model}</span><span>${formatMm(plan.product.params.length ?? 0)} × ${formatMm(plan.product.params.width ?? 0)} mm</span><span>${plan.fixtures.length ? plan.fixtures.join(' · ') : '未配置夹具'}</span>`;
  renderPanel();
}

function openSelectionCard(kind = 'product', value = null) {
  if (!plan) return;
  const modal = $('#selection-modal');
  const content = $('#selection-card-content');
  const title = $('#selection-title');
  const subtitle = $('#selection-subtitle');
  const product = plan.product ?? {};
  const params = product.params ?? {};
  if (kind === 'point' && value) {
    title.textContent = value.id || '点位详情';
    subtitle.textContent = `${value.type ?? 'DROP'} · ${value.demo ? '演示添加' : 'CAD 导入'}`;
    content.innerHTML = `<div class="selection-hero point-hero"><div class="point-glyph">${value.type === 'PICK' ? '取' : value.type === 'CHARGE' ? '充' : '吊'}</div><div><b>${value.name ?? value.id ?? '作业点'}</b><span>现场标定点位</span></div></div><div class="selection-grid"><div><small>X 坐标</small><strong>${formatMm(value.x)} <em>mm</em></strong></div><div><small>Y 坐标</small><strong>${formatMm(value.y)} <em>mm</em></strong></div><div><small>点位类型</small><strong>${value.type ?? 'DROP'}</strong></div><div><small>数据来源</small><strong>${value.demo ? '演示添加' : 'CAD 图纸'}</strong></div></div><div class="selection-note"><span>●</span> 双击视口可继续添加吊装点，服务端会校验边界。</div>`;
  } else {
    title.textContent = product.model ?? '选型参数';
    subtitle.textContent = `${product.type === 'agv' ? 'AGV 运输车' : '产品方案'} · ScenePlan v${plan.version ?? 0}`;
    const fixtures = plan.fixtures?.length ? plan.fixtures.join(' · ') : '未配置';
    const capacity = product.payload ?? product.capacity;
    content.innerHTML = `<div class="selection-hero"><div class="product-glyph">AGV</div><div><b>${product.model ?? '未选型'}</b><span>参数来自产品库 · 可追溯</span></div><span class="demo-chip">${product.demo ? '示意模型' : '产品模型'}</span></div><div class="selection-section-title">车体尺寸 <span>单位：mm</span></div><div class="selection-grid"><div><small>车长</small><strong>${formatMm(params.length)} <em>mm</em></strong></div><div><small>车宽</small><strong>${formatMm(params.width)} <em>mm</em></strong></div><div><small>车高</small><strong>${formatMm(params.height)} <em>mm</em></strong></div><div><small>额定载荷</small><strong>${capacity == null ? '—' : formatMm(capacity)} <em>${capacity == null ? '' : 'kg'}</em></strong></div></div><div class="selection-section-title">方案配置</div><div class="selection-detail-list"><div><span>适配夹具</span><b>${fixtures}</b></div><div><span>最小净距</span><b class="ok-text">服务端已校验</b></div><div><span>参数出处</span><b>产品库 / demo_data</b></div></div>`;
  }
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeSelectionCard() {
  const modal = $('#selection-modal');
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function renderPanel() {
  if (!plan) return;
  const content = $('#panel-content');
  if (activeTab === 0) {
    const steps = plan.process.length ? plan.process : plan.pendingProcess ?? [];
    content.innerHTML = `<div class="timeline">${steps.length ? steps.map((s, i) => `<button class="${i === selectedStep ? 'selected' : ''}" data-process-index="${i}"><b>${s.index}</b><span>${s.action}</span><small>${s.equipment} · ${s.dwellSeconds}s</small></button>`).join('') : '<div class="empty">生成工序后显示闭式时间轴</div>'}</div>`;
  } else if (activeTab === 1) {
    const steps = plan.process.length ? plan.process : plan.pendingProcess ?? [];
    content.innerHTML = steps.length ? `<table><thead><tr><th>#</th><th>设备</th><th>动作</th><th>起点 → 终点</th><th>停留</th></tr></thead><tbody>${steps.map((s) => `<tr><td>${s.index}</td><td>${s.equipment}</td><td>${s.action}</td><td>${s.from} → ${s.to}</td><td>${s.dwellSeconds}s</td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无工序</div>';
  } else if (activeTab === 2) {
    const points = [...(plan.site?.stations ?? []), ...(plan.site?.points ?? [])];
    content.innerHTML = `<div class="panel-heading"><div><b>点位表</b><span>${points.length} 个作业点</span></div><button class="panel-detail-button" data-open-selection="product">查看选型参数 ↗</button></div><table class="point-table"><thead><tr><th>ID</th><th>类型</th><th>X</th><th>Y</th><th>来源</th><th></th></tr></thead><tbody>${points.map((p, index) => `<tr data-point-index="${index}"><td><b>${p.id}</b></td><td><span class="type-pill type-${String(p.type ?? '').toLowerCase()}">${p.type}</span></td><td>${Math.round(p.x)}</td><td>${Math.round(p.y)}</td><td>${p.demo ? '演示添加' : 'CAD'}</td><td><button class="row-open" data-point-index="${index}" aria-label="打开 ${p.id}">↗</button></td></tr>`).join('')}</tbody></table>`;
    content.querySelectorAll('[data-point-index]').forEach((node) => node.addEventListener('click', () => openSelectionCard('point', points[Number(node.dataset.pointIndex)])));
    content.querySelectorAll('[data-open-selection]').forEach((node) => node.addEventListener('click', () => openSelectionCard('product')));
  } else if (activeTab === 3) {
    const m = plan.takt?.cycleSeconds ? plan.takt : { cycleSeconds: plan.process.length ? 150 : 150, targetSeconds: plan.takt?.targetSeconds ?? 120 };
    content.innerHTML = `<div class="metric-grid"><div><small>单件循环</small><strong>${(m.cycleSeconds ?? 150).toFixed(1)} s</strong></div><div><small>目标节拍</small><strong>${m.targetSeconds ?? 120} s</strong></div><div><small>件 / 小时</small><strong>${(3600 / (m.cycleSeconds ?? 150)).toFixed(1)}</strong></div><div><small>状态</small><strong class="${m.achieved === false ? 'danger-text' : ''}">${m.achieved === false ? '有差距' : '可达到'}</strong></div></div>${plan.takt.shift ? `<p class="shift-result">8 小时班：${plan.takt.shift.completed} 件 · 利用率 ${(plan.takt.shift.utilization * 100).toFixed(1)}%</p>` : ''}`;
  } else {
    const travel = plan.travel?.devices ?? [];
    content.innerHTML = plan.travel?.visible ? `<div class="travel-grid">${travel.map((d) => `<div><b>${d.device}</b>${d.axes.map((a) => `<span>${a.axis} <strong>${formatMm(a.distanceMm)} mm</strong> / 最大 ${formatMm(a.maxSingleMm)} mm</span>`).join('')}</div>`).join('')}</div><div class="gantt">${(plan.travel.gantt ?? []).map((g) => `<div class="gantt-row"><span>${g.device}</span><i style="width:${Math.max(10, g.duration * 2)}px" title="${g.label}">${g.kind}</i></div>`).join('')}</div>` : '<div class="empty">输入“显示行程”显示轨迹线、行程表和甘特图</div>';
  }
  content.querySelectorAll('[data-process-index]').forEach((button) => button.addEventListener('click', () => { selectedStep = Number(button.dataset.processIndex); sendCommand(`只看第 ${selectedStep + 1} 步`); }));
}

function addBubble(text, role = 'assistant', danger = false) {
  const bubble = document.createElement('div'); bubble.className = `bubble ${role}${danger ? ' danger' : ''}`; bubble.textContent = text; $('#chat-log').append(bubble); $('#chat-log').scrollTop = $('#chat-log').scrollHeight; return bubble;
}
function addCard(card) {
  const el = document.createElement('div'); el.className = 'result-card';
  if (card.type === 'solution') el.innerHTML = `<b>方案卡 · ${card.product?.model ?? '产品'}</b><span>尺寸 ${formatMm(card.product?.params?.length)} × ${formatMm(card.product?.params?.width)} mm</span><span>夹具：${card.fixture ?? '未配置'} · 净距：服务端校验</span>`;
  else if (card.type === 'process') el.innerHTML = `<b>工序表确认卡</b>${card.steps.map((s) => `<span>${s.index}. ${s.equipment} · ${s.action} · ${s.from} → ${s.to}</span>`).join('')}${card.requiresConfirmation ? '<em>请输入“确认”写入方案</em>' : '<em>已写入 ScenePlan</em>'}`;
  else if (card.type === 'efficiency') el.innerHTML = `<b>效率卡</b><span>循环 ${card.cycleSeconds.toFixed(1)}s · ${card.piecesPerHour.toFixed(1)} 件/小时</span><span>瓶颈：${card.bottleneck} · ${card.achievable ? '可达到目标节拍' : '需要优化'}</span>`;
  else if (card.type === 'shift') el.innerHTML = `<b>班次模拟卡</b><span>${card.hours} 小时 · 完成 ${card.completed} 件</span><span>利用率 ${(card.utilization * 100).toFixed(1)}% · 确定性种子 ${card.seed}</span>`;
  else if (card.type === 'travel') el.innerHTML = '<b>行程可视化</b><span>轨迹线、行程表和甘特图已打开</span>';
  else if (card.type === 'crane') el.innerHTML = `<b>起重机方案卡 · 示意</b><span>跨度 ${formatMm(card.crane?.params?.span)} mm · 起升 ${formatMm(card.crane?.params?.liftHeight)} mm</span><span>子对象：大车 · 小车 · 吊具 · 钢丝绳 · C 形钩</span>`;
  else el.innerHTML = `<b>${card.type}</b><span>${JSON.stringify(card)}</span>`;
  $('#chat-log').append(el); $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
}

async function sendCommand(text) {
  if (!text.trim()) return;
  addBubble(text, 'user');
  $('#chat-input').value = '';
  const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', assistant, currentEvent = 'message';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n'); buffer = events.pop();
    for (const raw of events) {
      let data = '';
      for (const line of raw.split('\n')) { if (line.startsWith('event: ')) currentEvent = line.slice(7); if (line.startsWith('data: ')) data += line.slice(6); }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (currentEvent === 'meta') { $('#mode').textContent = payload.provider === 'magpie-doubao' ? 'Magpie · 豆包' : payload.mode === 'online' ? '在线模式' : '离线模式'; continue; }
      if (currentEvent === 'token') { assistant ??= addBubble('', 'assistant'); assistant.textContent += payload.text; continue; }
      if (currentEvent === 'scene_plan.updated') { plan = payload; updateScene(); continue; }
      if (currentEvent === 'result.card') addCard(payload);
      if (currentEvent === 'done' && payload.error) { assistant?.remove(); addBubble(payload.error, 'assistant', true); }
    }
  }
  if (!assistant) addBubble('已处理。', 'assistant');
}

$('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); sendCommand($('#chat-input').value); });
document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => sendCommand(button.dataset.command)));
document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { activeTab = Number(button.dataset.tab); document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === button)); renderPanel(); }));
document.querySelectorAll('[data-camera]').forEach((button) => button.addEventListener('click', () => sendCommand(`切换到${button.dataset.camera}镜头`)));
$('#show-travel').addEventListener('click', () => sendCommand('显示行程'));
document.querySelector('[data-step="7"]').addEventListener('click', (event) => { event.preventDefault(); $('#r14').hidden = false; });
$('.modal-close').addEventListener('click', () => { $('#r14').hidden = true; });
document.querySelectorAll('.selection-close').forEach((button) => button.addEventListener('click', closeSelectionCard));
$('#selection-modal').addEventListener('click', (event) => { if (event.target.id === 'selection-modal') closeSelectionCard(); });
$('#selection-chat').addEventListener('click', () => { closeSelectionCard(); $('#chat-input').focus(); addToast('告诉 Agent 你要调整的尺寸或夹具'); });
$('#plan-summary').addEventListener('click', () => openSelectionCard('product'));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeSelectionCard(); $('#r14').hidden = true; } });

const selectionCard = document.querySelector('.selection-card');
const dragHandle = document.querySelector('[data-drag-handle]');
let dragState = null;
dragHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  const rect = selectionCard.getBoundingClientRect();
  dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
  selectionCard.style.left = `${rect.left}px`;
  selectionCard.style.top = `${rect.top}px`;
  selectionCard.style.transform = 'none';
  dragHandle.setPointerCapture(event.pointerId);
  dragHandle.classList.add('dragging');
});
dragHandle.addEventListener('pointermove', (event) => {
  if (!dragState) return;
  const maxLeft = Math.max(8, window.innerWidth - selectionCard.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - selectionCard.offsetHeight - 8);
  const left = Math.min(maxLeft, Math.max(8, event.clientX - dragState.offsetX));
  const top = Math.min(maxTop, Math.max(8, event.clientY - dragState.offsetY));
  selectionCard.style.left = `${left}px`;
  selectionCard.style.top = `${top}px`;
});
const stopDragging = (event) => {
  if (!dragState) return;
  dragState = null;
  dragHandle.releasePointerCapture?.(event.pointerId);
  dragHandle.classList.remove('dragging');
};
dragHandle.addEventListener('pointerup', stopDragging);
dragHandle.addEventListener('pointercancel', stopDragging);

canvas.addEventListener('dblclick', async (event) => {
  if (!site?.plant || !plan?.site?.bounds) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3(); if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return;
  const x = Math.round(hit.x * 1000), y = Math.round(-hit.z * 1000);
  const response = await fetch('/api/plan', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'set_station', args: { x, y, type: 'DROP', name: '吊装点' } }) });
  const result = await response.json(); if (result.ok) { plan = result.plan; updateScene(); addToast(result.message); } else addToast(result.error, true);
});

async function init() {
  const [health, currentPlan] = await Promise.all([
    fetch('/api/health').then((r) => r.json()).catch(() => null),
    fetch('/api/plan').then((r) => r.json()),
  ]);
  plan = currentPlan;
  if (health?.provider === 'magpie-doubao') $('#mode').textContent = 'Magpie · 豆包';
  else if (health?.mode === 'online') $('#mode').textContent = '在线模式';
  else $('#mode').textContent = '离线模式';
  try {
    site = new Site(renderer, { shadowSize: 2048, shadowRadius: 3 });
    await site.loadEnvironment();
    const dxf = await fetch('/cad/sample-plant.dxf').then((r) => r.text());
    await site.loadPlanText(dxf, 'sample-plant.dxf');
    const centre = site.built?.centre;
    if (centre) {
      const targetX = centre.x / 1000;
      const targetZ = -centre.y / 1000;
      controls.target.set(targetX, 0, targetZ);
      camera.position.set(targetX + 62, 64, targetZ + 72);
      controls.update();
    }
    site.playing = false;
    site.setVehicle((await loadVehicle(VEHICLE_CATALOG[0])).root, VEHICLE_CATALOG[0], plan.product.params);
  } catch (error) {
    console.warn('Site engine fallback', error);
    site = null;
    fallbackScene.add(pointGroup);
  }
  updateScene();
  resize();
  requestAnimationFrame(loop);
}
function resize() { const w = viewport.clientWidth, h = viewport.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
function loop(now) {
  const delta = Math.min(0.1, (now - lastTime) / 1000); lastTime = now;
  if (site) { if (plan?.animation?.playing) { site.playing = true; site.speed = plan.animation.mode === 'step' ? 1.4 : 2.8; } site.update(delta, camera); renderer.render(site.scene, camera); updatePointLabels(); } else renderer.render(fallbackScene, camera);
  requestAnimationFrame(loop);
}
new ResizeObserver(resize).observe(viewport);
init();

import './style.css';
