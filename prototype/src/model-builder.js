// Equipment models built from a parts spec the assistant writes after reading a 2D equipment
// drawing (and looking at reference pictures). Every dimension carries its source; the overall
// size must come from the drawing, a parameter table or the user, and the built model must match it.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export const SOURCES = ['图纸标注', '图纸量取', '参数表', '用户给定', '图片估计'];
const HARD = new Set(['图纸标注', '图纸量取', '参数表', '用户给定']);
const MAX_PARTS = 120;
const MAX_INSTANCES = 800;
const TOLERANCE = 0.05;

const COLORS = {
  黄: '#e8b21a', 黄色: '#e8b21a', 卫华黄: '#f2b705', 红: '#c8392b', 红色: '#c8392b', 蓝: '#2f6db5', 蓝色: '#2f6db5',
  灰: '#8a9097', 灰色: '#8a9097', 深灰: '#4a4f55', 黑: '#222', 黑色: '#222', 白: '#eee', 白色: '#eee', 绿: '#3d8a4a', 绿色: '#3d8a4a',
  银: '#c9ccd0', 银色: '#c9ccd0', 铝: '#d4d7db', 钢: '#9aa1a8', 橙: '#e07a1f', 橙色: '#e07a1f',
};

const mm = (v) => Number(v) / 1000;
const pos = (v, name, field) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`零件「${name}」的 ${field} 必须是正数（mm），收到 ${v}`);
  return n / 1000;
};

// Orient a geometry built along +Z (extrusions) so that it runs along `axis`.
function alongAxis(geometry, axis) {
  if (axis === 'x') geometry.rotateY(Math.PI / 2);
  else if (axis === 'y') geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function rectPath(w, h, path = new THREE.Shape()) {
  path.moveTo(-w / 2, -h / 2);
  path.lineTo(w / 2, -h / 2);
  path.lineTo(w / 2, h / 2);
  path.lineTo(-w / 2, h / 2);
  path.closePath();
  return path;
}

function extrude(shape, depth, segments = 12) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: segments });
  g.translate(0, 0, -depth / 2);
  return g;
}

function profileShape(points, name) {
  if (!Array.isArray(points) || points.length < 3) throw new Error(`零件「${name}」的轮廓至少要 3 个点`);
  const pts = points.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p)).map((p) => new THREE.Vector2(mm(p.x), mm(p.y)));
  if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error(`零件「${name}」的轮廓点不是数字`);
  return new THREE.Shape(pts);
}

function geometryOf(part, profiles) {
  const n = part.name;
  const axis = ['x', 'y', 'z'].includes(part.axis) ? part.axis : 'x';
  switch (part.shape) {
    case 'box': {
      const [l, h, w] = part.size_mm ?? [];
      return new THREE.BoxGeometry(pos(l, n, 'size_mm[0] 长'), pos(h, n, 'size_mm[1] 高'), pos(w, n, 'size_mm[2] 宽'));
    }
    case 'cylinder': {
      const r = part.radius_mm ?? (part.diameter_mm ? part.diameter_mm / 2 : undefined);
      const g = new THREE.CylinderGeometry(pos(r, n, 'radius_mm'), pos(r, n, 'radius_mm'), pos(part.length_mm, n, 'length_mm'), 32);
      if (axis === 'x') g.rotateZ(Math.PI / 2);
      else if (axis === 'z') g.rotateX(Math.PI / 2);
      return g;
    }
    case 'tube': {
      const ro = pos(part.outer_radius_mm ?? part.outer_diameter_mm / 2, n, 'outer_radius_mm');
      const ri = pos(part.inner_radius_mm ?? part.inner_diameter_mm / 2, n, 'inner_radius_mm');
      if (ri >= ro) throw new Error(`零件「${n}」内径必须小于外径`);
      const s = new THREE.Shape().absarc(0, 0, ro, 0, Math.PI * 2, false);
      s.holes.push(new THREE.Path().absarc(0, 0, ri, 0, Math.PI * 2, true));
      return alongAxis(extrude(s, pos(part.length_mm, n, 'length_mm'), 48), axis);
    }
    case 'ibeam': {
      const h = pos(part.height_mm, n, 'height_mm');
      const w = pos(part.width_mm, n, 'width_mm');
      const tw = pos(part.web_mm ?? 12, n, 'web_mm');
      const tf = pos(part.flange_mm ?? 16, n, 'flange_mm');
      const s = new THREE.Shape();
      const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + tf], [tw / 2, -h / 2 + tf], [tw / 2, h / 2 - tf], [w / 2, h / 2 - tf], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, h / 2 - tf], [-tw / 2, h / 2 - tf], [-tw / 2, -h / 2 + tf], [-w / 2, -h / 2 + tf]];
      s.moveTo(...pts[0]);
      for (const p of pts.slice(1)) s.lineTo(...p);
      s.closePath();
      return alongAxis(extrude(s, pos(part.length_mm, n, 'length_mm')), axis);
    }
    case 'boxgirder': {
      const h = pos(part.height_mm, n, 'height_mm');
      const w = pos(part.width_mm, n, 'width_mm');
      const t = pos(part.wall_mm ?? 10, n, 'wall_mm');
      const s = rectPath(w, h);
      s.holes.push(rectPath(w - 2 * t, h - 2 * t, new THREE.Path()));
      return alongAxis(extrude(s, pos(part.length_mm, n, 'length_mm')), axis);
    }
    case 'extrude': {
      let points = part.points_mm;
      if (!points && part.profile) {
        points = profiles?.[part.profile];
        if (!points) throw new Error(`零件「${n}」引用的轮廓 ${part.profile} 不存在；先调 read_equipment_drawing，轮廓 id 形如 V1-P3`);
      }
      const shape = profileShape(points, n);
      const g = extrude(shape, pos(part.depth_mm, n, 'depth_mm'));
      g.computeBoundingBox();
      const c = g.boundingBox.getCenter(new THREE.Vector3());
      g.translate(-c.x, -c.y, 0);
      // Profile plane: xy = front view (drawing x→length, y→height, extruded across the width);
      // zy = side view (drawing x→width); xz = plan view (drawing y→width, extruded upwards).
      if (part.plane === 'zy') g.rotateY(-Math.PI / 2);
      else if (part.plane === 'xz') g.rotateX(Math.PI / 2);
      return g;
    }
    default:
      throw new Error(`零件「${n}」的 shape=${part.shape} 不支持；可用 box、cylinder、tube、ibeam、boxgirder、extrude`);
  }
}

function materialOf(part, cache) {
  const color = COLORS[part.color] ?? (/^#?[0-9a-f]{3,6}$/i.test(part.color ?? '') ? `#${String(part.color).replace('#', '')}` : '#9aa1a8');
  const metal = Number.isFinite(part.metal) ? part.metal : 0.35;
  const rough = Number.isFinite(part.rough) ? part.rough : 0.55;
  const key = `${color}|${metal}|${rough}`;
  if (!cache.has(key)) cache.set(key, new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, name: part.color ?? color }));
  return cache.get(key);
}

// Build a THREE.Group from a spec (metres, y up, origin at the bottom centre of the overall box).
export function buildFromSpec(spec, profiles = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('spec 必须是对象');
  const name = String(spec.name ?? '').trim();
  if (!name) throw new Error('spec.name 不能为空，用设备型号或名称');
  const o = spec.overall ?? {};
  const overall = [o.length_mm, o.height_mm, o.width_mm].map(Number);
  if (overall.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error('spec.overall 需要 length_mm、width_mm、height_mm（外形总长、总宽、总高，mm）');
  if (!HARD.has(o.source)) {
    throw new Error(`外形总尺寸的来源是「${o.source ?? '未写'}」。总尺寸必须来自图纸标注、图纸量取、参数表或用户给定，不能靠图片估计；图纸里找不到时请先问用户要总长、总宽、总高`);
  }
  const parts = spec.parts;
  if (!Array.isArray(parts) || !parts.length) throw new Error('spec.parts 不能为空');
  if (parts.length > MAX_PARTS) throw new Error(`零件太多（${parts.length}），上限 ${MAX_PARTS}；重复件用 repeat 表示`);
  const group = new THREE.Group();
  group.name = name;
  const materials = new Map();
  let instances = 0;
  const estimated = [];
  const bySource = {};
  for (const [i, part] of parts.entries()) {
    part.name = String(part.name ?? `零件${i + 1}`);
    if (!SOURCES.includes(part.source)) throw new Error(`零件「${part.name}」缺少 source，必须是 ${SOURCES.join(' / ')} 之一`);
    bySource[part.source] = (bySource[part.source] ?? 0) + 1;
    if (part.source === '图片估计') estimated.push(part.name);
    const geometry = geometryOf(part, profiles);
    const material = materialOf(part, materials);
    const count = Math.max(1, Math.min(200, Math.round(Number(part.repeat?.count) || 1)));
    const step = (part.repeat?.step_mm ?? [0, 0, 0]).map((v) => mm(v || 0));
    const p = (part.position_mm ?? [0, 0, 0]).map((v) => mm(v || 0));
    const r = (part.rotation_deg ?? [0, 0, 0]).map((v) => THREE.MathUtils.degToRad(Number(v) || 0));
    instances += count;
    if (instances > MAX_INSTANCES) throw new Error(`实例总数超过 ${MAX_INSTANCES}，请减少重复件`);
    for (let k = 0; k < count; k++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = count > 1 ? `${part.name}#${k + 1}` : part.name;
      mesh.position.set(p[0] + step[0] * k, p[1] + step[1] * k, p[2] + step[2] * k);
      mesh.rotation.set(r[0], r[1], r[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { source: part.source };
      group.add(mesh);
    }
  }
  // Check the built size against the stated overall size (x length, y height, z width).
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3()).toArray().map((v) => v * 1000);
  const labels = ['总长(x)', '总高(y)', '总宽(z)'];
  const off = size.map((v, i) => ({ label: labels[i], built: Math.round(v), want: overall[i], err: Math.abs(v - overall[i]) / overall[i] })).filter((d) => d.err > TOLERANCE);
  if (off.length) {
    const lo = box.min.toArray().map((v) => Math.round(v * 1000));
    throw new Error(`拼出的外形和 overall 不符：${off.map((d) => `${d.label} 拼出 ${d.built} mm，应为 ${d.want} mm`).join('；')}（允许 ±5%）。当前包围盒最小角 ${JSON.stringify(lo)} mm。约定：position_mm 是零件中心，x 沿长度、y 向上（地面 y=0）、z 沿宽度；请修正零件尺寸或位置后重试`);
  }
  // Origin at the bottom centre so it stands on the floor / rail when placed.
  const c = box.getCenter(new THREE.Vector3());
  for (const child of group.children) child.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  return {
    group,
    report: {
      名称: name,
      外形_mm: { 长: Math.round(size[0]), 宽: Math.round(size[2]), 高: Math.round(size[1]), 来源: o.source },
      零件: parts.length,
      实例: instances,
      尺寸来源统计: bySource,
      图片估计的零件: estimated,
    },
  };
}

export async function exportGlb(group) {
  const exporter = new GLTFExporter();
  const data = await exporter.parseAsync(group, { binary: true });
  return new Blob([data], { type: 'model/gltf-binary' });
}

export function fileName(name) {
  return `${String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)}.glb`;
}
