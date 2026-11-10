// Storage zones (货位) laid out in the plant from parameters or a slot table, and inventory
// filled into them as real 3D coils / pallets. Plant coordinates in mm, world in metres
// (x = X / 1000, z = -Y / 1000, y up).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { obstaclesOf } from '../../demo/src/scene/clearance.js';

const loader = new GLTFLoader();
const SKU_COLORS = ['#aeb4ba', '#c9a227', '#4f8fd6', '#d96b3b', '#5aa469', '#9b6fd0', '#d4507a', '#3fb6b2'];
const FREE = new THREE.Color('#2ea121');
const USED = new THREE.Color('#2b7de9');
const mat = (color, metalness = 0.4, roughness = 0.6) => new THREE.MeshStandardMaterial({ color, metalness, roughness });

// V saddle cross-section extruded along the coil axis (local X). Returns geometry + where the coil centre sits.
function saddleGeometry({ length = 1400, width = 1200, height = 450, base_t = 40, groove_angle = 90, min_t = 120 }, coilR) {
  const half = THREE.MathUtils.degToRad(groove_angle / 2);
  let depth = Math.max(10, height - base_t - min_t);
  const topHalf = Math.min(depth * Math.tan(half), width / 2 - 40);
  depth = topHalf / Math.tan(half);
  const apex = height - depth;
  const s = new THREE.Shape();
  const pts = [[-width / 2, 0], [width / 2, 0], [width / 2, height], [topHalf, height], [0, apex], [-topHalf, height], [-width / 2, height]];
  s.moveTo(pts[0][0] / 1000, pts[0][1] / 1000);
  for (const [y, z] of pts.slice(1)) s.lineTo(y / 1000, z / 1000);
  const geo = new THREE.ExtrudeGeometry(s, { depth: length / 1000, bevelEnabled: false });
  // shape lies in XY (x = across, y = up), extruded along +Z; turn so the extrusion runs along X
  geo.translate(0, 0, -length / 2000);
  geo.rotateY(Math.PI / 2);
  return { geo, coilCentre: (apex + coilR / Math.sin(half)) / 1000 };
}

// Where the coil centre sits on a saddle built by the CAD module (asset.meta.cad).
function centreFromCad(cad, coilR) {
  const p = cad?.params ?? {};
  if (cad?.template === 'saddle_v') {
    const half = THREE.MathUtils.degToRad((p.groove_angle ?? 90) / 2);
    let depth = Math.max(10, p.height - p.base_t - p.min_t);
    const topHalf = Math.min(depth * Math.tan(half), p.width / 2 - 40);
    depth = topHalf / Math.tan(half);
    return (p.height - depth + coilR / Math.sin(half) + (p.pad_t ?? 0)) / 1000;
  }
  if (cad?.template === 'saddle_cradle') {
    const seat = Math.max(20, Math.min(p.height - p.base_t - p.min_t, (p.coil_d / 2) * (1 - Math.cos(THREE.MathUtils.degToRad(40)))));
    return (p.height - seat + coilR) / 1000;
  }
  return null;
}

function overlapRect(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

export class Warehouse {
  constructor(app) {
    this.app = app;
    this.zones = new Map();
    this.group = new THREE.Group();
    this.group.name = '货位库存';
    this.animating = [];
  }

  attach() {
    if (this.group.parent !== this.app.site.scene) this.app.site.scene.add(this.group);
  }

  bounds() {
    return this.app.site.built?.bounds ?? { minX: 0, maxX: 96000, minY: 0, maxY: 42000 };
  }

  obstacles() {
    const plant = this.app.site.plant;
    if (!plant) return [];
    let list = [];
    try {
      list = obstaclesOf(plant).map((o) => {
        const xs = o.poly.map((p) => p.x);
        const ys = o.poly.map((p) => p.y);
        return { label: o.label, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      });
    } catch {
      list = [];
    }
    // Painted lanes and walkways (≥ 1 m wide) must stay clear: cover each segment with squares of the lane width.
    for (const mark of plant.marks ?? []) {
      const w = Number(mark.width) || 0;
      if (w < 1000 || !mark.points?.length) continue;
      const label = mark.color === 'yellow' ? '物流通道' : '人行通道';
      const pts = mark.closed ? [...mark.points, mark.points[0]] : mark.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (w / 2)));
        for (let s = 0; s <= steps; s++) {
          const x = a.x + (b.x - a.x) * s / steps;
          const y = a.y + (b.y - a.y) * s / steps;
          list.push({ label, minX: x - w / 2, maxX: x + w / 2, minY: y - w / 2, maxY: y + w / 2 });
        }
      }
    }
    return list;
  }

  // spec: { zone, name, type: saddle|rack|floor, item: coil|pallet, origin_x_mm, origin_y_mm, rows, cols, levels,
  //         pitch_x_mm, pitch_y_mm, heading_deg, coil_d_mm, coil_w_mm, saddle (params), saddle_asset, slots: [{id,x_mm,y_mm,level}] }
  async layout(spec) {
    const zone = String(spec.zone || '').trim();
    if (!/^[A-Za-z0-9一-龥_-]{1,12}$/.test(zone)) throw new Error('库区编号 zone 需为 1–12 位字母/数字/汉字，如 A、B2、成品区');
    const type = spec.type ?? 'saddle';
    if (!['saddle', 'rack', 'floor'].includes(type)) throw new Error('货位类型 type 只能是 saddle（鞍座）、rack（货架）、floor（地面堆放）');
    const item = spec.item ?? (type === 'rack' ? 'pallet' : 'coil');
    const coilD = spec.coil_d_mm ?? 1600;
    const coilW = spec.coil_w_mm ?? 1350;
    if (coilD < 400 || coilD > 3000 || coilW < 200 || coilW > 2500) throw new Error('卷材外径需 400–3000 mm、宽度 200–2500 mm');
    const levels = type === 'rack' ? spec.levels ?? 3 : 1;
    if (!(Number.isInteger(levels) && levels >= 1 && levels <= 8)) throw new Error('货架层数 levels 需为 1–8');
    const saddleLen = spec.saddle?.length ?? Math.max(1200, coilW + 50);
    const pitchX = spec.pitch_x_mm ?? (type === 'rack' ? 2700 : Math.max(saddleLen, coilW) + 700);
    const pitchY = spec.pitch_y_mm ?? (type === 'rack' ? 1400 : coilD + 900);
    const heading = THREE.MathUtils.degToRad(spec.heading_deg ?? 0);
    let slots = [];
    if (Array.isArray(spec.slots) && spec.slots.length) {
      if (spec.slots.length > 2000) throw new Error('货位表最多 2000 个货位');
      slots = spec.slots.map((s, i) => {
        if (!Number.isFinite(s.x_mm) || !Number.isFinite(s.y_mm)) throw new Error(`货位表第 ${i + 1} 行缺少 x_mm / y_mm`);
        return { id: String(s.id ?? `${zone}-${i + 1}`), x: s.x_mm, y: s.y_mm, level: s.level ?? 1, row: s.row ?? null, col: s.col ?? null };
      });
    } else {
      const rows = spec.rows ?? 2;
      const cols = spec.cols ?? 6;
      if (!(Number.isInteger(rows) && rows >= 1 && rows <= 40 && Number.isInteger(cols) && cols >= 1 && cols <= 60)) throw new Error('行数 rows 需 1–40、列数 cols 需 1–60（整数）');
      if (rows * cols * levels > 2000) throw new Error(`货位总数 ${rows * cols * levels} 超过 2000`);
      const b = this.bounds();
      const ox = spec.origin_x_mm ?? (b.minX + b.maxX) / 2 - ((cols - 1) * pitchX) / 2;
      const oy = spec.origin_y_mm ?? b.minY + (b.maxY - b.minY) * 0.18;
      const [c, s] = [Math.cos(heading), Math.sin(heading)];
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          for (let l = 1; l <= levels; l++) {
            const u = k * pitchX;
            const v = r * pitchY;
            slots.push({ id: `${zone}-${String(r + 1).padStart(2, '0')}-${String(k + 1).padStart(2, '0')}${levels > 1 ? `-L${l}` : ''}`, x: ox + u * c - v * s, y: oy + u * s + v * c, level: l, row: r + 1, col: k + 1 });
          }
        }
      }
    }
    const foot = { x: type === 'rack' ? pitchX - 100 : Math.max(saddleLen, coilW), y: type === 'rack' ? 1100 : (spec.saddle?.width ?? coilD * 0.75) };
    const rectOf = (p) => ({ minX: p.x - foot.x / 2, maxX: p.x + foot.x / 2, minY: p.y - foot.y / 2, maxY: p.y + foot.y / 2 });
    const b = this.bounds();
    const outside = slots.filter((p) => { const r = rectOf(p); return r.minX < b.minX + 300 || r.maxX > b.maxX - 300 || r.minY < b.minY + 300 || r.maxY > b.maxY - 300; });
    if (outside.length) throw new Error(`${outside.length} 个货位超出厂房（如 ${outside[0].id} 在 ${Math.round(outside[0].x)}, ${Math.round(outside[0].y)} mm），厂房范围 X ${Math.round(b.minX)}–${Math.round(b.maxX)}、Y ${Math.round(b.minY)}–${Math.round(b.maxY)} mm`);
    for (const [other, z] of this.zones) {
      if (other === zone) continue;
      const hit = slots.find((p) => z.slots.some((q) => Math.abs(p.x - q.x) < foot.x * 0.9 && Math.abs(p.y - q.y) < foot.y * 0.9));
      if (hit) throw new Error(`货位 ${hit.id} 和库区 ${other} 重叠，请换个起点或间距`);
    }
    const obstacles = this.obstacles();
    const skipped = [];
    if (spec.skip_conflicts !== false && obstacles.length) {
      slots = slots.filter((p) => {
        const r = rectOf(p);
        const hit = obstacles.find((o) => overlapRect(r, o));
        if (hit) skipped.push(`${p.id}（${hit.label}）`);
        return !hit;
      });
    }
    if (!slots.length) throw new Error('所有货位都和立柱/设备/通道冲突，请换个位置');

    let saddleAsset = null;
    if (spec.saddle_asset) {
      saddleAsset = this.app.library?.find(spec.saddle_asset);
      if (!saddleAsset || saddleAsset.kind !== 'model') throw new Error(`场景库里没有鞍座模型 ${spec.saddle_asset}`);
    }
    this.remove(zone);
    const z = {
      zone, name: spec.name ?? `${zone} 区`, type, item, coilD, coilW, levels, pitchX, pitchY, heading, slots: slots.map((p) => ({ ...p, used: false, sku: null, weight: null })),
      saddle: spec.saddle ?? {}, saddleAsset, group: new THREE.Group(), itemMesh: null, slotMesh: null, skipped,
    };
    z.group.name = `库区 ${zone}`;
    await this.buildZone(z);
    this.zones.set(zone, z);
    this.attach();
    this.group.add(z.group);
    this.app.bump?.();
    return this.zoneSummary(z);
  }

  async buildZone(z) {
    const coilR = z.coilD / 2;
    const count = z.slots.length;
    const dummy = new THREE.Object3D();
    // floor markers: one per ground position
    const markGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const markMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
    z.slotMesh = new THREE.InstancedMesh(markGeo, markMat, count);
    z.slotMesh.renderOrder = 2;
    z.levelHeight = (z.coilD + 300) / 1000;
    if (z.type === 'rack') z.levelHeight = (z.saddle.level_height ?? 1500) / 1000;
    z.slots.forEach((p, i) => {
      dummy.position.set(p.x / 1000, 0.015 + (z.type === 'rack' ? (p.level - 1) * z.levelHeight + 0.2 : 0), -p.y / 1000);
      dummy.rotation.set(0, z.heading, 0);
      dummy.scale.set(z.type === 'rack' ? (z.pitchX - 200) / 1000 : Math.max(z.coilW, 1200) / 1000, 1, z.type === 'rack' ? 1.0 : (z.coilD * 0.9) / 1000);
      dummy.updateMatrix();
      z.slotMesh.setMatrixAt(i, dummy.matrix);
      z.slotMesh.setColorAt(i, FREE);
    });
    z.group.add(z.slotMesh);

    z.coilCentre = coilR / 1000;
    if (z.type === 'saddle') {
      const ground = z.slots.filter((p) => p.level === 1);
      if (z.saddleAsset) {
        const gltf = await loader.loadAsync(z.saddleAsset.url);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const dims = box.getSize(new THREE.Vector3());
        const k = Math.max(dims.x, dims.y, dims.z) > 60 ? 0.001 : 1;
        z.coilCentre = centreFromCad(z.saddleAsset.meta?.cad, coilR) ?? dims.y * k + coilR / 1000 * 0.45;
        const c = box.getCenter(new THREE.Vector3());
        // the CAD part's coil axis is its X; GLB keeps X, so it lines up with the zone heading
        for (const p of ground) {
          const root = gltf.scene.clone(true);
          root.scale.setScalar(k);
          root.position.set(-c.x * k, -box.min.y * k, -c.z * k);
          const holder = new THREE.Group();
          holder.add(root);
          holder.position.set(p.x / 1000, 0, -p.y / 1000);
          holder.rotation.y = z.heading;
          holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
          z.group.add(holder);
        }
      } else {
        const { geo, coilCentre } = saddleGeometry({ length: z.saddle.length ?? Math.max(1200, z.coilW + 50), width: z.saddle.width ?? z.coilD * 0.75, height: z.saddle.height ?? 450, groove_angle: z.saddle.groove_angle ?? 90 }, coilR);
        z.coilCentre = coilCentre;
        const mesh = new THREE.InstancedMesh(geo, mat('#5b6f84', 0.5, 0.55), ground.length);
        ground.forEach((p, i) => {
          dummy.position.set(p.x / 1000, 0, -p.y / 1000);
          dummy.rotation.set(0, z.heading, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        z.group.add(mesh);
      }
    } else if (z.type === 'rack') {
      // uprights at bay boundaries (both faces), orange beams per level
      const posts = [];
      const beams = [];
      const top = z.levels * z.levelHeight + 0.4;
      const byRow = new Map();
      for (const p of z.slots.filter((q) => q.level === 1)) {
        const key = p.row ?? 0;
        if (!byRow.has(key)) byRow.set(key, []);
        byRow.get(key).push(p);
      }
      const half = z.pitchX / 2000;
      for (const row of byRow.values()) {
        for (const p of row) {
          for (const sx of [-half, half]) for (const sz of [-0.55, 0.55]) posts.push([p.x / 1000, sx, sz]);
          for (let l = 0; l < z.levels; l++) for (const sz of [-0.55, 0.55]) beams.push([p.x / 1000, -p.y / 1000, l * z.levelHeight + 0.15, sz]);
        }
      }
      const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, top, 0.09), mat('#1f5fa8', 0.3, 0.5), posts.length);
      const rowOf = z.slots.filter((q) => q.level === 1);
      let n = 0;
      for (const p of rowOf) {
        for (const sx of [-half, half]) for (const sz of [-0.55, 0.55]) {
          dummy.position.set(p.x / 1000, top / 2, -p.y / 1000);
          dummy.rotation.set(0, z.heading, 0);
          dummy.translateX(sx);
          dummy.translateZ(sz);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          postMesh.setMatrixAt(n++, dummy.matrix);
        }
      }
      const beamMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(z.pitchX / 1000 - 0.1, 0.12, 0.05), mat('#e8731c', 0.3, 0.5), beams.length);
      n = 0;
      for (const p of rowOf) {
        for (let l = 0; l < z.levels; l++) for (const sz of [-0.55, 0.55]) {
          dummy.position.set(p.x / 1000, l * z.levelHeight + 0.15, -p.y / 1000);
          dummy.rotation.set(0, z.heading, 0);
          dummy.translateZ(sz);
          dummy.updateMatrix();
          beamMesh.setMatrixAt(n++, dummy.matrix);
        }
      }
      postMesh.castShadow = beamMesh.castShadow = true;
      z.group.add(postMesh, beamMesh);
    }

    // inventory items, hidden until filled (scale 0)
    let itemGeo;
    let itemMat;
    if (z.item === 'coil') {
      itemGeo = new THREE.CylinderGeometry(coilR / 1000, coilR / 1000, z.coilW / 1000, 40, 1, false).rotateZ(Math.PI / 2);
      itemMat = mat('#ffffff', 0.85, 0.32);
    } else {
      itemGeo = new THREE.BoxGeometry(1.2, 0.9, 1.0).translate(0, 0.45, 0);
      itemMat = mat('#ffffff', 0.05, 0.8);
    }
    z.itemMesh = new THREE.InstancedMesh(itemGeo, itemMat, count);
    z.itemMesh.castShadow = true;
    z.slots.forEach((_, i) => {
      dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      z.itemMesh.setMatrixAt(i, dummy.matrix);
      z.itemMesh.setColorAt(i, new THREE.Color('#aeb4ba'));
    });
    z.group.add(z.itemMesh);
  }

  itemMatrix(z, p, drop = 0) {
    const dummy = new THREE.Object3D();
    const y = z.item === 'coil'
      ? (z.type === 'rack' ? (p.level - 1) * z.levelHeight + 0.2 + z.coilD / 2000 : z.type === 'floor' ? z.coilD / 2000 : z.coilCentre)
      : (z.type === 'rack' ? (p.level - 1) * z.levelHeight + 0.27 : 0.0);
    dummy.position.set(p.x / 1000, y + drop, -p.y / 1000);
    dummy.rotation.set(0, z.heading, 0);
    dummy.updateMatrix();
    return dummy.matrix;
  }

  // spec: { zone (omit = all zones in order), used, ratio, skus: [{sku, count, weight_t}], items: [{slot, sku}], strategy, replace }
  fill(spec = {}) {
    if (!this.zones.size) throw new Error('还没有货位，先用 layout_slots 布置库区');
    const zones = spec.zone ? [this.zones.get(spec.zone)] : [...this.zones.values()];
    if (zones.some((z) => !z)) throw new Error(`没有库区 ${spec.zone}，现有：${[...this.zones.keys()].join('、')}`);
    if (spec.replace !== false) for (const z of zones) for (const p of z.slots) Object.assign(p, { used: false, sku: null, weight: null });
    const free = zones.flatMap((z) => z.slots.filter((p) => !p.used).map((p) => ({ z, p })));
    const strategy = spec.strategy ?? 'sequential';
    if (strategy === 'random') {
      let seed = spec.seed ?? 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [free[i], free[j]] = [free[j], free[i]]; }
    } else if (strategy === 'low_first') free.sort((a, b) => a.p.level - b.p.level);
    const queue = [];
    if (Array.isArray(spec.items) && spec.items.length) {
      for (const it of spec.items) {
        const hit = zones.flatMap((z) => z.slots.map((p) => ({ z, p }))).find(({ p }) => p.id === it.slot);
        if (!hit) throw new Error(`没有货位 ${it.slot}`);
        hit.p.used = true;
        hit.p.sku = it.sku ?? '在库';
        hit.p.weight = it.weight_t ?? null;
        queue.push(hit);
      }
    }
    const want = [];
    if (Array.isArray(spec.skus)) for (const s of spec.skus) for (let i = 0; i < (s.count ?? 0); i++) want.push({ sku: String(s.sku ?? '在库'), weight: s.weight_t ?? null });
    else {
      const total = free.length;
      const n = spec.used !== undefined ? spec.used : spec.ratio !== undefined ? Math.round(total * spec.ratio) : 0;
      if (!(Number.isInteger(n) && n >= 0)) throw new Error('已用货位数 used 需为非负整数，或给 ratio 0–1');
      for (let i = 0; i < n; i++) want.push({ sku: spec.sku ?? '钢卷', weight: spec.weight_t ?? null });
    }
    const pool = free.filter(({ p }) => !p.used);
    const placed = Math.min(pool.length, want.length);
    for (let i = 0; i < placed; i++) {
      Object.assign(pool[i].p, { used: true, sku: want[i].sku, weight: want[i].weight });
      queue.push(pool[i]);
    }
    const overflow = want.length - placed;
    // colours per SKU, drop-in animation
    const skus = [...new Set(zones.flatMap((z) => z.slots.filter((p) => p.used).map((p) => p.sku)))];
    this.skuColors = Object.fromEntries(skus.map((s, i) => [s, SKU_COLORS[i % SKU_COLORS.length]]));
    for (const z of zones) this.paint(z);
    const t0 = performance.now();
    this.animating = queue.map(({ z, p }, i) => ({ z, p, start: t0 + Math.min(i * 25, 3000) }));
    this.app.bump?.();
    return { ...this.stats(), 本次入库: placed, 超出容量未入库: overflow };
  }

  paint(z) {
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    z.slots.forEach((p, i) => {
      z.slotMesh.setColorAt(i, p.used ? USED : FREE);
      z.itemMesh.setMatrixAt(i, p.used ? this.itemMatrix(z, p) : hidden);
      z.itemMesh.setColorAt(i, new THREE.Color(p.used ? this.skuColors?.[p.sku] ?? '#aeb4ba' : '#aeb4ba'));
    });
    z.slotMesh.instanceColor.needsUpdate = true;
    z.itemMesh.instanceMatrix.needsUpdate = true;
    z.itemMesh.instanceColor.needsUpdate = true;
  }

  clear(zone) {
    const zones = zone ? [this.zones.get(zone)] : [...this.zones.values()];
    if (zones.some((z) => !z)) throw new Error(`没有库区 ${zone}`);
    for (const z of zones) {
      for (const p of z.slots) Object.assign(p, { used: false, sku: null, weight: null });
      this.paint(z);
    }
    this.app.bump?.();
    return this.stats();
  }

  remove(zone) {
    const z = this.zones.get(zone);
    if (!z) return false;
    z.group.removeFromParent();
    z.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.zones.delete(zone);
    return true;
  }

  zoneSummary(z) {
    const used = z.slots.filter((p) => p.used).length;
    const xs = z.slots.map((p) => p.x);
    const ys = z.slots.map((p) => p.y);
    return {
      库区: z.zone, 名称: z.name, 类型: { saddle: '鞍座', rack: '货架', floor: '地面' }[z.type], 货物: z.item === 'coil' ? `钢卷 Φ${z.coilD}×${z.coilW}` : '托盘货物',
      货位总数: z.slots.length, 已用: used, 空置: z.slots.length - used, 利用率: `${((used / z.slots.length) * 100).toFixed(1)}%`,
      层数: z.levels, 间距_mm: [Math.round(z.pitchX), Math.round(z.pitchY)], 范围_mm: { X: [Math.round(Math.min(...xs)), Math.round(Math.max(...xs))], Y: [Math.round(Math.min(...ys)), Math.round(Math.max(...ys))] },
      鞍座模型: z.saddleAsset?.name ?? (z.type === 'saddle' ? '内置 V 型鞍座' : undefined),
      避让跳过数: z.skipped.length || undefined,
      避让跳过: z.skipped.length ? z.skipped.slice(0, 8) : undefined,
    };
  }

  stats() {
    const zones = [...this.zones.values()].map((z) => this.zoneSummary(z));
    const total = zones.reduce((a, z) => a + z.货位总数, 0);
    const used = zones.reduce((a, z) => a + z.已用, 0);
    const bySku = {};
    for (const z of this.zones.values()) for (const p of z.slots) if (p.used) bySku[p.sku] = (bySku[p.sku] ?? 0) + 1;
    return { 货位总数: total, 已用货位: used, 空置货位: total - used, 利用率: total ? `${((used / total) * 100).toFixed(1)}%` : '0%', 按品种: bySku, 库区: zones };
  }

  // frame hook: drop-in animation
  update() {
    if (!this.animating.length) return;
    const now = performance.now();
    const touched = new Set();
    this.animating = this.animating.filter(({ z, p, start }) => {
      const k = Math.min(1, Math.max(0, (now - start) / 450));
      const i = z.slots.indexOf(p);
      const m = this.itemMatrix(z, p, (1 - k * k) * 4);
      if (now < start) m.makeScale(0, 0, 0);
      z.itemMesh.setMatrixAt(i, m);
      touched.add(z);
      return k < 1;
    });
    for (const z of touched) z.itemMesh.instanceMatrix.needsUpdate = true;
  }

  labels({ pin, place, seen }) {
    for (const z of this.zones.values()) {
      const used = z.slots.filter((p) => p.used).length;
      const xs = z.slots.map((p) => p.x);
      const ys = z.slots.map((p) => p.y);
      const key = `wh:${z.zone}`;
      seen.add(key);
      const top = z.type === 'rack' ? z.levels * z.levelHeight + 1 : z.coilD / 1000 + 1.6;
      place(pin(key, 'asset', `<span class="lab">${z.name} · 已用 ${used} / 空 ${z.slots.length - used}</span>`), new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2000, top, -(Math.min(...ys) + Math.max(...ys)) / 2000));
    }
  }

  centre() {
    const all = [...this.zones.values()].flatMap((z) => z.slots);
    if (!all.length) return null;
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, span: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) };
  }
}
