// 现场目录：厂房里有哪些东西、在哪儿，AGV 流程里每个动作在第几秒。
// 直接复用 demo 的 parse-cad.js 和 route.js（纯 JS，不碰浏览器），和网页里算出来的完全一样。
// 坐标：平面图是毫米（X 向东，Y 向北）；三维场景是米，x = X/1000，z = -Y/1000，y 向上。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const SAMPLE_DXF = path.join(ROOT, 'data/cad/sample-plant.dxf');
const PARAMETRIC = path.join(ROOT, 'src/parametric');
const SCENE_SRC = path.join(ROOT, 'demo/src/scene');

const { parseCad } = await import(pathToFileURL(path.join(SCENE_SRC, 'parse-cad.js')).href);
const { buildTimeline, cargoStateAt, poseAt } = await import(pathToFileURL(path.join(SCENE_SRC, 'route.js')).href);

const CARGO_NAMES = { COIL: '钢卷', CRATE: '货箱' };
const STATION_KINDS = { PICK: '取货工位', DROP: '卸货工位', CHARGE: '充电桩' };
const EVENT_TEXT = { arrive: '到站定位', load: '取货（支架下降，货落到车上）', unload: '卸货（支架上升，货离车）', charge: '充电', leg: '行驶' };

export function listProducts() {
  return readdirSync(PARAMETRIC)
    .filter((name) => name.endsWith('.config.json'))
    .map((name) => JSON.parse(readFileSync(path.join(PARAMETRIC, name), 'utf8')))
    .map(({ id, model, summary, plate, params }) => ({ id, model, summary, plate, params }));
}

// 产品和尺寸：没写的尺寸用标准值，超范围的夹到范围内（和网页滑块一致）。
export function resolveProduct(productId = 'agv1', size = {}) {
  const product = listProducts().find((item) => item.id === productId);
  if (!product) throw new Error(`产品库里没有 ${productId}，现有：${listProducts().map((item) => item.id).join('、')}`);
  const resolved = {};
  for (const [key, param] of Object.entries(product.params)) {
    const value = size[key] ?? param.nominal;
    resolved[key] = Math.min(param.max, Math.max(param.min, value));
  }
  for (const key of Object.keys(size)) {
    if (!product.params[key]) throw new Error(`${product.model} 没有尺寸参数 ${key}，只有 ${Object.keys(product.params).join('、')}`);
  }
  return { ...product, size: resolved };
}

function centreOf(rects) {
  const xs = rects.flatMap((r) => [r.x - r.w / 2, r.x + r.w / 2]);
  const ys = rects.flatMap((r) => [r.y - r.d / 2, r.y + r.d / 2]);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
}

function eventsOf(timeline) {
  const events = [];
  const seen = new Map();
  const push = (kind, station, t0, t1) => {
    const base = `${kind}:${station.id}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = count > 1 ? `${base}#${count}` : base;
    const text = kind === 'leg' ? `${EVENT_TEXT.leg}，前往 ${station.id}` : `${station.id} ${EVENT_TEXT[kind]}`;
    events.push({ id, kind, station: station.id, t0, t1, text });
  };
  let legStart = null;
  for (const step of timeline.steps) {
    if (step.type !== 'dwell') {
      legStart ??= step.t0;
      continue;
    }
    if (step.kind === 'settle') {
      if (legStart !== null) push('leg', step.station, legStart, step.t0);
      legStart = null;
      push('arrive', step.station, step.t0, step.t1);
    } else {
      push(step.kind, step.station, step.t0, step.t1);
    }
  }
  events.push({ id: 'start', kind: 'start', station: '', t0: 0, t1: 0, text: '流程开始' });
  events.push({ id: 'end', kind: 'end', station: '', t0: timeline.duration, t1: timeline.duration, text: '流程结束' });
  return events;
}

/**
 * 载入现场。返回 { plant, timeline, product, objects, events, locate, headingAt, resolveTime }。
 * objects：[{ name, aliases, kind, x, y（毫米）, z（米，镜头看向的高度）, size: { w, d, h }（米）, moving }]
 */
export function loadWorld({ dxf = SAMPLE_DXF, product: productId = 'agv1', size = {} } = {}) {
  const plant = parseCad(readFileSync(dxf, 'utf8'));
  const timeline = buildTimeline(plant);
  const product = resolveProduct(productId, size);
  const deck = product.size.height / 1000;
  const objects = [];
  const add = (object) => objects.push({ aliases: [], moving: false, ...object });

  const xs = plant.walls.flatMap((wall) => wall.points.map((p) => p.x));
  const ys = plant.walls.flatMap((wall) => wall.points.map((p) => p.y));
  const hall = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, w: (Math.max(...xs) - Math.min(...xs)) / 1000, d: (Math.max(...ys) - Math.min(...ys)) / 1000 };
  add({ name: '厂房', aliases: ['hall'], kind: '厂房', x: hall.x, y: hall.y, z: 0, size: { w: hall.w, d: hall.d, h: 10.5 } });

  add({ name: 'AGV', aliases: ['agv', '车', product.model, product.id], kind: `车辆 ${product.model}`, x: 0, y: 0, z: deck + 0.4, size: { w: product.size.length / 1000, d: product.size.width / 1000, h: deck }, moving: true });
  for (const item of timeline.cargo) {
    add({ name: item.id, aliases: [CARGO_NAMES[item.kind] ?? item.kind], kind: `货物 ${CARGO_NAMES[item.kind] ?? item.kind}`, x: 0, y: 0, z: deck + 1, size: { w: 2.2, d: 3.3, h: 1.8 }, moving: true });
  }
  for (const station of plant.stations) {
    add({ name: station.id, kind: STATION_KINDS[station.type], x: station.x, y: station.y, z: 1, size: { w: 3, d: 3.3, h: 1 } });
  }
  for (const [group, kind] of [['machines', '设备'], ['conveyors', '输送线'], ['cranes', '起重机']]) {
    plant[group].forEach((item, index) => {
      const box = centreOf(item.rects);
      const h = Number(item.attrs.HEIGHT ?? 3000) / 1000;
      add({ name: item.attrs.NAME || `${kind} ${index + 1}`, kind, x: box.x, y: box.y, z: group === 'cranes' ? h - 1 : h / 2, size: { w: box.w / 1000, d: box.d / 1000, h } });
    });
  }
  for (const [name, test] of [['南侧货架', (rack) => rack.y < hall.y], ['北侧货架', (rack) => rack.y >= hall.y]]) {
    const racks = plant.racks.filter(test);
    if (!racks.length) continue;
    const box = centreOf(racks.flatMap((rack) => rack.rects));
    add({ name, kind: `货架 ×${racks.length}`, x: box.x, y: box.y, z: 3, size: { w: box.w / 1000, d: box.d / 1000, h: 6 } });
  }
  for (const label of plant.labels) add({ name: label.text, kind: '区域', x: label.x, y: label.y, z: 0, size: { w: 0, d: 0, h: 0 } });

  const byName = new Map();
  for (const object of objects) for (const key of [object.name, ...object.aliases]) byName.set(key, object);
  const events = eventsOf(timeline);
  const eventById = new Map(events.map((event) => [event.id, event]));

  // 平面图毫米 → 场景米。
  const toScene = (x, y, z) => [x / 1000, z, -y / 1000];

  function find(name) {
    const object = byName.get(name);
    if (!object) throw new Error(`现场里没有「${name}」。可用的有：${objects.map((item) => item.name).join('、')}`);
    return object;
  }

  // 某个东西在现场第 t 秒的位置（场景米）。也接受 { x, y, z }（平面图毫米，z 也是毫米）。
  function locate(target, t = 0) {
    if (typeof target === 'object' && target !== null) return toScene(target.x, target.y, (target.z ?? 0) / 1000);
    const object = find(target);
    if (object.name === 'AGV') {
      const pose = poseAt(timeline, t);
      return toScene(pose.x, pose.y, object.z);
    }
    const cargo = timeline.cargo.find((item) => item.id === object.name);
    if (cargo) {
      const state = cargoStateAt(cargo, t);
      if (state.on === 'vehicle') {
        const pose = poseAt(timeline, t);
        return toScene(pose.x, pose.y, object.z);
      }
      const station = state.on === 'from' ? cargo.from : cargo.to;
      return toScene(station.x, station.y, object.z);
    }
    return toScene(object.x, object.y, object.z);
  }

  // AGV 车头朝向：场景里绕 y 轴的角度（弧度），和网页里 carrier.rotation.y 一致。
  const headingAt = (t) => poseAt(timeline, t).heading;

  // 现场时间：数字（秒），或 "load:RM-01"、"load:RM-01.end"、"arrive:CELL-01.mid-2s"、"leg:CELL-01+3.5s"。
  function resolveTime(expression) {
    if (typeof expression === 'number') return expression;
    const match = /^(.+?)(?:\.(start|end|mid))?(?:([+-]\d+(?:\.\d+)?)s)?$/.exec(String(expression).trim());
    const event = match && eventById.get(match[1]);
    if (!event) throw new Error(`没有这个流程事件：${expression}。可用的有：${events.map((item) => item.id).join('、')}`);
    const base = match[2] === 'end' ? event.t1 : match[2] === 'mid' ? (event.t0 + event.t1) / 2 : event.t0;
    return Math.max(0, Math.min(timeline.duration, base + Number(match[3] ?? 0)));
  }

  return { plant, timeline, product, objects, events, locate, headingAt, resolveTime, duration: timeline.duration };
}
