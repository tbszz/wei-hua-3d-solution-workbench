import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCad } from '../../../demo/src/scene/parse-cad.js';
import { CATALOG, getProduct, searchProducts } from './catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_STEPS = [
  { index: 1, equipment: 'AGV1', action: '接卷', from: 'RM-01', to: '吊装点-01', cargo: '钢卷', dwellSeconds: 8 },
  { index: 2, equipment: '双梁桥式起重机', action: '大车、小车走位', from: '吊装点-01', to: '成品区', cargo: '钢卷', dwellSeconds: 12 },
  { index: 3, equipment: '双梁桥式起重机', action: 'C 形钩下降、夹卷、起升', from: '吊装点-01', to: '成品区', cargo: '钢卷', dwellSeconds: 18 },
  { index: 4, equipment: 'AGV1', action: '空车回充电位', from: '成品区', to: 'CHG-01', cargo: '无', dwellSeconds: 5 },
];

export const clone = (value) => JSON.parse(JSON.stringify(value));
export function emptyPlan() {
  const p = getProduct('agv1');
  return {
    version: 0,
    product: { id: p.id, model: p.model, params: Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, v.nominal])) },
    crane: null, fixtures: [],
    site: { source: null, stations: [], points: [], bounds: null, plant: null },
    process: [], pendingProcess: null,
    takt: { targetSeconds: 120, achieved: null, gapSeconds: null },
    animation: { playing: false, mode: 'full', stepIndex: null, time: 0 },
    travel: { visible: false, devices: [], gantt: [] },
    camera: { preset: 'overview', target: null }, lastAction: null,
  };
}
const bump = (plan, action) => { plan.version += 1; plan.lastAction = action; return plan; };
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const ok = (plan, message, extra = {}) => ({ ok: true, plan: clone(plan), message, ...extra });

export function setProduct(plan, { productId }) {
  const p = getProduct(productId);
  if (!p) return fail(`未找到产品 ${productId}。可选：${CATALOG.map((x) => x.model).join('、')}`);
  plan.product = { id: p.id, model: p.model, params: Object.fromEntries(Object.entries(p.params).filter(([k]) => ['length', 'width', 'height'].includes(k)).map(([k, v]) => [k, v.nominal])) };
  return ok(bump(plan, 'set_product'), `已选择 ${p.model}`, { card: { type: 'solution', product: plan.product, fixture: plan.fixtures[0] ?? null } });
}

export function setParams(plan, params = {}) {
  const p = getProduct(plan.product.id);
  const next = { ...plan.product.params };
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const spec = p?.params[key];
    if (!spec) return fail(`参数 ${key} 不适用于 ${plan.product.model}。`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) return fail(`${spec.label} ${raw} mm 超出范围 ${spec.min}–${spec.max} mm。`, { field: key, range: [spec.min, spec.max] });
    const snapped = Math.round(value / spec.step) * spec.step;
    if (Math.abs(snapped - value) > 1e-6) return fail(`${spec.label} 必须按 ${spec.step} mm 步进。`, { field: key, step: spec.step });
    next[key] = value;
  }
  plan.product.params = next;
  return ok(bump(plan, 'set_params'), `参数已更新：${Object.entries(next).map(([k, v]) => `${k} ${v} mm`).join('、')}`, { card: { type: 'solution', product: plan.product, fixture: plan.fixtures[0] ?? null } });
}

export function attachFixture(plan, { fixture }) {
  if (!['agv-coil-rack', 'c-hook'].includes(fixture)) return fail('示意夹具仅支持 agv-coil-rack、c-hook。');
  if (fixture === 'c-hook' && !plan.crane) return fail('C 形钩需要先添加双梁桥式起重机。');
  if (!plan.fixtures.includes(fixture)) plan.fixtures.push(fixture);
  return ok(bump(plan, 'attach_fixture'), `已配置${fixture === 'c-hook' ? ' C 形钩' : ' AGV 卷材支架'}。`, { card: { type: 'solution', product: plan.product, fixture } });
}

function boundsOf(plant) {
  const xs = plant.walls.flatMap((w) => w.points.map((p) => p.x));
  const ys = plant.walls.flatMap((w) => w.points.map((p) => p.y));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export async function importSite(plan, { dxfText, source = 'sample-plant.dxf' } = {}) {
  const text = dxfText ?? await fs.readFile(path.join(root, 'data/cad/sample-plant.dxf'), 'utf8');
  const plant = parseCad(text);
  plan.site = { source, stations: plant.stations.map((s) => ({ id: s.id, type: s.type, x: s.x, y: s.y, heading: s.heading, cargo: s.cargo })), points: [], bounds: boundsOf(plant), plant };
  return ok(bump(plan, 'import_site'), `已导入 ${source}，识别 ${plant.stations.length} 个工位和 ${plant.beams.length} 条 S-BEAM 吊车梁。`, { card: { type: 'site', stations: plan.site.stations } });
}

export function setStation(plan, { id, x, y, type = 'DROP', name = '吊装点' }) {
  if (!plan.site.bounds) return fail('请先导入厂房。');
  const point = { x: Number(x), y: Number(y) }, b = plan.site.bounds;
  if (![point.x, point.y].every(Number.isFinite) || point.x < b.minX || point.x > b.maxX || point.y < b.minY || point.y > b.maxY) return fail(`点位越界：可用范围 X ${b.minX}–${b.maxX} mm，Y ${b.minY}–${b.maxY} mm。`);
  const pointId = id || `${name}-${String(plan.site.points.length + 1).padStart(2, '0')}`;
  if (plan.site.stations.some((s) => s.id === pointId) || plan.site.points.some((s) => s.id === pointId)) return fail(`点位 ${pointId} 已存在。`);
  plan.site.points.push({ id: pointId, type, name, x: point.x, y: point.y, heading: 0, demo: true });
  return ok(bump(plan, 'set_station'), `已添加点位 ${pointId}（${Math.round(point.x)}，${Math.round(point.y)} mm）。`, { card: { type: 'station', point: plan.site.points.at(-1) } });
}

export function addStationEastOf(plan, { stationId = 'RM-01', distanceMm = 2000 } = {}) {
  const s = plan.site.stations.find((x) => x.id === stationId);
  if (!s) return fail(`找不到工位 ${stationId}，请先导入厂房。`);
  return setStation(plan, { id: `吊装点-${String(plan.site.points.length + 1).padStart(2, '0')}`, x: s.x + Number(distanceMm), y: s.y, type: 'DROP', name: '吊装点' });
}

export function setProcess(plan, { steps = DEFAULT_STEPS, confirmed = false } = {}) {
  const known = new Set([...plan.site.stations.map((s) => s.id), ...plan.site.points.map((s) => s.id), '成品区']);
  for (const step of steps) if (!known.has(step.from) || !known.has(step.to)) return fail(`工序 ${step.index ?? ''} 的点位不存在：${step.from} → ${step.to}。`);
  if (!confirmed) {
    plan.pendingProcess = steps.map((s, i) => ({ ...s, index: i + 1, dwellSeconds: Number(s.dwellSeconds ?? 10) }));
    return ok(plan, '已生成工序表，请确认后写入方案。', { card: { type: 'process', steps: plan.pendingProcess, requiresConfirmation: true } });
  }
  plan.process = (steps.length ? steps : plan.pendingProcess ?? DEFAULT_STEPS).map((s, i) => ({ ...s, index: i + 1, dwellSeconds: Number(s.dwellSeconds ?? 10) }));
  plan.pendingProcess = null;
  return ok(bump(plan, 'set_process'), `已确认 ${plan.process.length} 步工序。`, { card: { type: 'process', steps: plan.process, requiresConfirmation: false } });
}

export function playAnimation(plan, { mode = 'full', stepIndex = null } = {}) {
  if (!plan.process.length) plan.process = clone(DEFAULT_STEPS);
  plan.animation = { playing: true, mode, stepIndex: stepIndex === null ? null : Number(stepIndex), time: 0 };
  return ok(bump(plan, 'play_animation'), mode === 'full' ? '开始播放全流程。' : `开始播放第 ${Number(stepIndex) + 1} 步：${plan.process[Number(stepIndex)]?.action ?? '未知动作'}。`, { card: { type: 'animation', ...plan.animation } });
}

export function efficiency(plan) {
  const cycleSeconds = plan.process.length ? plan.process.reduce((sum, s) => sum + Number(s.dwellSeconds ?? 0), 0) + 62 : 150;
  const takt = plan.takt?.targetSeconds ?? 120;
  const bottleneck = plan.process.reduce((max, s) => Number(s.dwellSeconds ?? 0) > Number(max.dwellSeconds ?? 0) ? s : max, { action: 'AGV / 起重机协同', dwellSeconds: 0 });
  return { cycleSeconds, piecesPerHour: 3600 / cycleSeconds, utilization: Math.min(1, takt / cycleSeconds), bottleneck: bottleneck.action, targetSeconds: takt };
}

export function setTakt(plan, { seconds }) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 10 || value > 3600) return fail('目标节拍范围为 10–3600 秒。');
  const m = efficiency(plan);
  plan.takt = { ...m, targetSeconds: value, achieved: m.cycleSeconds <= value, gapSeconds: Math.max(0, m.cycleSeconds - value) };
  return ok(bump(plan, 'set_takt'), plan.takt.achieved ? `目标节拍 ${value} 秒可达到。` : `目标节拍 ${value} 秒暂时达不到，差距 ${plan.takt.gapSeconds.toFixed(1)} 秒。`, { card: { type: 'efficiency', ...m, targetSeconds: value, achievable: plan.takt.achieved } });
}

export function simulateShift(plan, { hours = 8 } = {}) {
  const m = efficiency(plan), seconds = Number(hours) * 3600, completed = Math.floor(seconds / m.cycleSeconds);
  const utilization = Math.min(1, (completed * m.cycleSeconds) / seconds);
  const out = { hours: Number(hours), cycleSeconds: m.cycleSeconds, completed, utilization, idleSeconds: Math.max(0, seconds - completed * m.cycleSeconds), seed: 42 };
  plan.takt = { ...plan.takt, shift: out };
  return ok(bump(plan, 'simulate_shift'), `已模拟 ${hours} 小时班：完成 ${completed} 件，设备利用率 ${(utilization * 100).toFixed(1)}%。`, { card: { type: 'shift', ...out } });
}

export function travel(plan) {
  const agvDistance = plan.site?.plant ? Math.round((plan.site.plant.paths ?? []).reduce((sum, p) => sum + p.points.slice(1).reduce((inner, point, i) => inner + Math.hypot(point.x - p.points[i].x, point.y - p.points[i].y), 0), 0)) : 0;
  const devices = [
    { device: 'AGV1', axes: [{ axis: '车体中心', distanceMm: agvDistance, maxSingleMm: 42000 }] },
    { device: '双梁桥式起重机', axes: [{ axis: '大车', distanceMm: 45000, maxSingleMm: 22500 }, { axis: '小车', distanceMm: 18000, maxSingleMm: 9000 }, { axis: '起升', distanceMm: 24000, maxSingleMm: 12000 }] },
  ];
  const gantt = (plan.process.length ? plan.process : DEFAULT_STEPS).map((s, i) => ({ device: s.equipment, label: s.action, start: i * 30, duration: Number(s.dwellSeconds ?? 10), kind: s.equipment.includes('AGV') ? '行走' : '起升' }));
  return { devices, gantt };
}

export function showTravel(plan) { plan.travel = { visible: true, ...travel(plan) }; return ok(bump(plan, 'show_travel'), '已显示设备轨迹、行程表和甘特图。', { card: { type: 'travel', ...plan.travel } }); }
export function checkClearance(plan) { const distance = Math.max(0, 2000 - Number(plan.product.params.width ?? 1500) / 2); return { distanceMm: distance, warning: distance < 500, label: distance < 500 ? 'A-WALL' : 'AGV-PATH' }; }
export function setCamera(plan, { preset = 'overview' } = {}) { const allowed = ['overview', 'top', 'follow', 'crane']; if (!allowed.includes(preset)) return fail(`镜头仅支持 ${allowed.join('、')}。`); plan.camera = { preset, target: preset === 'crane' ? 'S-BEAM' : null }; return ok(bump(plan, 'set_camera'), `镜头已切换到${preset}。`); }

export function addCrane(plan, { span = 22500, liftHeight = 12000, fixture = 'c-hook' } = {}) {
  const p = getProduct('double-girder-crane-demo');
  for (const [key, value] of [['span', span], ['liftHeight', liftHeight]]) {
    const spec = p.params[key];
    if (Number(value) < spec.min || Number(value) > spec.max) return fail(`${spec.label} ${value} mm 超出范围 ${spec.min}–${spec.max} mm。`);
  }
  plan.crane = { id: p.id, model: p.model, params: { span: Number(span), liftHeight: Number(liftHeight) }, parts: ['大车', '小车', '吊具', '钢丝绳'], demo: true };
  if (fixture) plan.fixtures = [...new Set([...plan.fixtures, fixture])];
  return ok(bump(plan, 'add_crane'), `已添加双梁桥式起重机：跨度 ${span} mm，起升 ${liftHeight} mm，配置 C 形钩。`, { card: { type: 'crane', crane: plan.crane, fixture } });
}

export function executeTool(plan, name, args = {}) {
  switch (name) {
    case 'search_products': return { ok: true, plan: clone(plan), products: searchProducts(args.query) };
    case 'get_product': return { ok: true, plan: clone(plan), product: getProduct(args.productId) ?? null };
    case 'set_product': return setProduct(plan, args);
    case 'set_params': return setParams(plan, args);
    case 'attach_fixture': return attachFixture(plan, args);
    case 'import_site': return importSite(plan, args);
    case 'set_station': return setStation(plan, args);
    case 'set_process': return setProcess(plan, args);
    case 'play_animation': return playAnimation(plan, args);
    case 'set_takt': return setTakt(plan, args);
    case 'simulate_shift': return simulateShift(plan, args);
    case 'show_travel': return showTravel(plan);
    case 'check_clearance': return { ok: true, plan: clone(plan), clearance: checkClearance(plan) };
    case 'set_camera': return setCamera(plan, args);
    case 'add_crane': return addCrane(plan, args);
    default: return fail(`工具未登记：${name}`);
  }
}

export const TOOL_NAMES = ['search_products','get_product','set_product','set_params','attach_fixture','import_site','set_station','set_process','play_animation','set_takt','simulate_shift','show_travel','check_clearance','set_camera','add_crane'];
