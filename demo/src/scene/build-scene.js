// Plant data (millimetres) -> three.js objects (metres). CAD (x, y) maps to world (x, height, -y),
// so a CAD heading is exactly a rotation about +Y.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WALL_HEIGHT = 12;
const SHOW_PATH_COLOR = 0xff6a1a;
const MARK_HEX = { yellow: 0xb8921c, green: 0x1d6a2d, white: 0xd8d8d2 };
const ROOF_HEIGHT = WALL_HEIGHT;
const FLOOR_TILE = 6; // metres per floor texture tile (joint grid)

export const PALLET = { length: 2200, width: 3300, thickness: 0.14 };
export const RAIL = { lowered: -0.06, raised: 0.12, height: 0.14 };

const worldX = (x) => x / 1000;
const worldZ = (y) => -y / 1000;

const standard = (color, metalness = 0.1, roughness = 0.6, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });

function placed(geometry, material, x, h, y, heading = 0) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(worldX(x), h, worldZ(y));
  mesh.rotation.y = heading;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function matrix(x, h, y, heading = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(worldX(x), h, worldZ(y)),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading),
    new THREE.Vector3(sx, sy, sz),
  );
}

function instanced(geometry, material, matrices) {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// A local offset in a rectangle's own frame, returned as CAD coordinates.
function offsetFrom(rect, u, v) {
  const [c, s] = [Math.cos(rect.heading), Math.sin(rect.heading)];
  return { x: rect.x + u * c - v * s, y: rect.y + u * s + v * c };
}

function flattenPolyline(line) {
  const count = line.points.length;
  const out = [];
  for (let i = 0; i < (line.closed ? count : count - 1); i++) {
    const a = line.points[i];
    const b = line.points[(i + 1) % count];
    out.push({ x: a.x, y: a.y });
    if (!a.bulge) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    const sweep = 4 * Math.atan(a.bulge);
    const offset = (chord * (1 - a.bulge * a.bulge)) / (4 * a.bulge);
    const cx = (a.x + b.x) / 2 - (dy / chord) * offset;
    const cy = (a.y + b.y) / 2 + (dx / chord) * offset;
    const radius = Math.hypot(a.x - cx, a.y - cy);
    const start = Math.atan2(a.y - cy, a.x - cx);
    const steps = Math.ceil(Math.abs(sweep) / ((4 * Math.PI) / 180));
    for (let k = 1; k < steps; k++) {
      const angle = start + (sweep * k) / steps;
      out.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    }
  }
  if (!line.closed) out.push({ x: line.points[count - 1].x, y: line.points[count - 1].y });
  return out;
}

function ribbon(line, width, height) {
  const pts = flattenPolyline(line);
  const n = pts.length;
  const half = width / 2;
  const position = [];
  const index = [];
  const direction = (a, b) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  pts.forEach((p, i) => {
    const prev = line.closed ? pts[(i - 1 + n) % n] : pts[Math.max(i - 1, 0)];
    const next = line.closed ? pts[(i + 1) % n] : pts[Math.min(i + 1, n - 1)];
    const inward = i === 0 && !line.closed ? direction(p, next) : direction(prev, p);
    const outward = i === n - 1 && !line.closed ? direction(prev, p) : direction(p, next);
    const tx = inward.x + outward.x;
    const ty = inward.y + outward.y;
    const length = Math.hypot(tx, ty);
    const normal = { x: -ty / length, y: tx / length };
    const miter = half / Math.max(0.5, normal.x * -inward.y + normal.y * inward.x);
    position.push(worldX(p.x + normal.x * miter), height, worldZ(p.y + normal.y * miter));
    position.push(worldX(p.x - normal.x * miter), height, worldZ(p.y - normal.y * miter));
  });
  const quads = line.closed ? n : n - 1;
  for (let i = 0; i < quads; i++) {
    const [a, b, c, d] = [i * 2, i * 2 + 1, ((i + 1) % n) * 2, ((i + 1) % n) * 2 + 1];
    index.push(a, b, c, c, b, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(position.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geometry.setIndex(index);
  return geometry;
}

function hSection(flange, depth, web = 0.03, thickness = 0.04) {
  const parts = [
    new THREE.BoxGeometry(flange, 1, thickness).translate(0, 0.5, depth / 2 - thickness / 2),
    new THREE.BoxGeometry(flange, 1, thickness).translate(0, 0.5, -depth / 2 + thickness / 2),
    new THREE.BoxGeometry(web, 1, depth).translate(0, 0.5, 0),
  ];
  return mergeGeometries(parts);
}

function scaleUv(geometry, u, v) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  return geometry;
}

function textPlane(text, heightMm) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const font = 'bold 96px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + 24;
  canvas.height = 128;
  const paint = canvas.getContext('2d');
  paint.font = font;
  paint.textAlign = 'center';
  paint.textBaseline = 'middle';
  paint.fillStyle = 'rgba(240,240,232,.88)';
  paint.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const height = (heightMm / 1000) * 1.35;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry((height * canvas.width) / canvas.height, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function buildRacks(plant, group, textures) {
  const upright = new THREE.BoxGeometry(0.09, 1, 0.09);
  const beam = new THREE.BoxGeometry(1, 0.12, 0.05);
  const pallet = new THREE.BoxGeometry(1.1, 0.14, 0.95);
  const carton = new THREE.BoxGeometry(1, 1, 1);
  const lists = { upright: [], beam: [], pallet: [], carton: [] };
  const cartonColors = [];
  // Tints over the plywood map: kraft cartons, a few grey-blue and olive ones.
  const palette = [0xc8bcae, 0xbcb0a2, 0xd0c4b4, 0x9aa4ad, 0x98a28a];
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (const rack of plant.racks) {
    const rect = rack.rects[0];
    const height = Number(rack.attrs.HEIGHT ?? 6000) / 1000;
    const levels = Number(rack.attrs.LEVELS ?? 4);
    for (const u of [-1, 1]) {
      for (const v of [-1, 1]) {
        const at = offsetFrom(rect, (u * rect.w) / 2 - u * 45, (v * rect.d) / 2 - v * 45);
        lists.upright.push(matrix(at.x, height / 2, at.y, rect.heading, 1, height, 1));
      }
    }
    const spacing = height / levels;
    for (let level = 0; level < levels; level++) {
      const h = 0.15 + level * spacing;
      for (const v of [-1, 1]) {
        const at = offsetFrom(rect, 0, (v * rect.d) / 2 - v * 60);
        lists.beam.push(matrix(at.x, h + 0.06, at.y, rect.heading, rect.w / 1000 - 0.1, 1, 1));
      }
      for (const u of [-650, 650]) {
        if (random() < 0.18) continue;
        const at = offsetFrom(rect, u, 0);
        lists.pallet.push(matrix(at.x, h + 0.19, at.y, rect.heading));
        const tall = 0.45 + random() * (spacing - 0.95);
        lists.carton.push(matrix(at.x, h + 0.26 + tall / 2, at.y, rect.heading, 1.02, tall, 0.86));
        cartonColors.push(palette[Math.floor(random() * palette.length)]);
      }
    }
  }
  group.add(instanced(upright, standard(0x1f4f9a, 0.3, 0.45), lists.upright));
  group.add(instanced(beam, standard(0xe0661a, 0.25, 0.45), lists.beam));
  group.add(instanced(pallet, standard(0x8b6a43, 0, 0.85, { map: textures.plywoodColor, normalMap: textures.plywoodNormal, roughnessMap: textures.plywoodRough }), lists.pallet));
  const cartons = instanced(carton, standard(0x9f7654, 0, 0.82, { map: textures.plywoodColor, normalMap: textures.plywoodNormal, roughnessMap: textures.plywoodRough }), lists.carton);
  cartonColors.forEach((color, i) => cartons.setColorAt(i, new THREE.Color(color)));
  group.add(cartons);
}

const MACHINE_LOOK = {
  MACH_CNC: { body: 0xd8dbdd, top: 0x2d5f8f, band: 0xd9681e },
  MACH_PRESS: { body: 0x2f6f9f, top: 0x234e70, band: 0xf2b81c },
  MACH_WELD: { body: 0xe2b23a, top: 0x585c60, band: 0x202226 },
};

function buildMachine(machine, group) {
  const rect = machine.rects[0];
  const look = MACHINE_LOOK[machine.block] ?? MACHINE_LOOK.MACH_CNC;
  const height = Number(machine.attrs.HEIGHT ?? 3000) / 1000;
  const [w, d] = [rect.w / 1000, rect.d / 1000];
  const add = (geometry, material, h, u = 0, v = 0) => {
    const at = offsetFrom(rect, u * 1000, v * 1000);
    group.add(placed(geometry, material, at.x, h, at.y, rect.heading));
  };
  add(new THREE.BoxGeometry(w + 0.16, 0.14, d + 0.16), standard(0x2f3236, 0.2, 0.7), 0.07);
  const bodyHeight = height * 0.74;
  add(new THREE.BoxGeometry(w, bodyHeight, d), standard(look.body, 0.25, 0.42), 0.14 + bodyHeight / 2);
  add(new THREE.BoxGeometry(w * 0.72, height * 0.26, d * 0.72), standard(look.top, 0.2, 0.5), 0.14 + bodyHeight + height * 0.13);
  add(new THREE.BoxGeometry(w + 0.012, 0.16, d + 0.012), standard(look.band, 0.1, 0.5), 0.14 + bodyHeight * 0.82);
  const glass = standard(0x1d2a33, 0.6, 0.18, { envMapIntensity: 1.4 });
  for (const v of [-1, 1]) {
    add(new THREE.BoxGeometry(w * 0.56, bodyHeight * 0.48, 0.02), glass, 0.14 + bodyHeight * 0.46, 0, (v * (d + 0.01)) / 2);
  }
  add(new THREE.BoxGeometry(0.5, 0.82, 0.3), standard(0x3b3f44, 0.3, 0.45), 0.14 + bodyHeight * 0.42, w / 2 + 0.25, 0);
}

function buildConveyor(conveyor, group) {
  const rect = conveyor.rects[0];
  const height = Number(conveyor.attrs.HEIGHT ?? 900) / 1000;
  const [w, d] = [rect.w / 1000, rect.d / 1000];
  for (const v of [-1, 1]) {
    const at = offsetFrom(rect, 0, (v * rect.d) / 2 - v * 40);
    group.add(placed(new THREE.BoxGeometry(w, 0.16, 0.08), standard(0x2e6a3f, 0.2, 0.5), at.x, height - 0.08, at.y, rect.heading));
  }
  const rollers = [];
  for (let u = -w / 2 + 0.1; u < w / 2; u += 0.14) {
    const at = offsetFrom(rect, u * 1000, 0);
    rollers.push(matrix(at.x, height - 0.03, at.y, rect.heading));
  }
  group.add(instanced(new THREE.CylinderGeometry(0.04, 0.04, d - 0.16, 10).rotateX(Math.PI / 2), standard(0xb6babd, 0.75, 0.32), rollers));
  const legs = [];
  for (let u = -w / 2 + 0.25; u < w / 2; u += 1.4) {
    for (const v of [-1, 1]) {
      const at = offsetFrom(rect, u * 1000, (v * rect.d) / 2 - v * 60);
      legs.push(matrix(at.x, (height - 0.16) / 2, at.y, rect.heading, 1, height - 0.16, 1));
    }
  }
  group.add(instanced(new THREE.BoxGeometry(0.06, 1, 0.06), standard(0x2f3236, 0.3, 0.5), legs));
}

export function buildCrane(crane, group) {
  const height = Number(crane.attrs.HEIGHT ?? 9800) / 1000;
  const yellow = standard(0xf2b81c, 0.15, 0.45);
  crane.rects.forEach((rect, index) => {
    const [w, d] = [rect.w / 1000, rect.d / 1000];
    const h = index < 2 ? 0.9 : 0.6;
    group.add(placed(new THREE.BoxGeometry(w, h, d), yellow, rect.x, height - (index < 2 ? 0 : 0.2), rect.y, rect.heading));
  });
  group.add(placed(new THREE.BoxGeometry(2.0, 0.8, 1.8), standard(0xc22e22, 0.2, 0.5), crane.x, height + 0.8, crane.y, crane.heading));
  group.add(placed(new THREE.CylinderGeometry(0.02, 0.02, 4, 6), standard(0x222426, 0.6, 0.4), crane.x, height - 2, crane.y));
  group.add(placed(new THREE.BoxGeometry(0.5, 0.5, 0.26), yellow, crane.x, height - 4.1, crane.y));
}

function buildDoor(door, centre, textures) {
  const rect = door.rects[0];
  const height = Number(door.attrs.HEIGHT ?? 4500) / 1000;
  const w = rect.w / 1000;
  const normalX = -Math.sin(rect.heading);
  const normalY = Math.cos(rect.heading);
  const outward = (rect.x - centre.x) * normalX + (rect.y - centre.y) * normalY > 0 ? 1 : -1;
  const panel = standard(0x5d6267, 0.45, 0.45, { map: textures.corrugatedColor, normalMap: textures.corrugatedNormal, roughnessMap: textures.corrugatedRough });
  const at = offsetFrom(rect, 0, outward * 800);
  const ramp = offsetFrom(rect, 0, outward * 2400);
  return [
    placed(scaleUv(new THREE.BoxGeometry(w, height, 0.27), w / 1.5, height / 1.5), panel, rect.x, height / 2, rect.y, rect.heading),
    placed(new THREE.BoxGeometry(w + 0.5, 0.14, 1.6), standard(0x4a4d51, 0.3, 0.55), at.x, height + 0.3, at.y, rect.heading),
    placed(new THREE.BoxGeometry(w + 1.2, 0.06, 4.8), standard(0x8e9296, 0.05, 0.8), ramp.x, 0.03, ramp.y, rect.heading),
  ];
}

function buildStation(station, group) {
  const dynamic = { station, rails: [], lifts: [] };
  if (station.block === 'AGV_CHARGE') {
    const rect = station.rects[0];
    group.add(placed(new THREE.BoxGeometry(rect.w / 1000, 1.6, rect.d / 1000), standard(0xd5d8da, 0.25, 0.45), rect.x, 0.8, rect.y, rect.heading));
    const lamp = offsetFrom(rect, -rect.w / 2 - 6, 0);
    group.add(placed(new THREE.BoxGeometry(0.012, 0.16, 0.8), standard(0x2fd13d, 0, 0.4, { emissive: 0x25d13a, emissiveIntensity: 1.2 }), lamp.x, 1.25, lamp.y, rect.heading));
    return dynamic;
  }
  const steel = standard(0x3a6ea5, 0.25, 0.45);
  const post = standard(0x2f3236, 0.35, 0.5);
  for (const rect of station.rects) {
    const rail = placed(new THREE.BoxGeometry(rect.w / 1000, RAIL.height, rect.d / 1000), steel, rect.x, 0, rect.y, rect.heading);
    group.add(rail);
    dynamic.rails.push(rail);
    for (const u of [-1500, 0, 1500]) {
      const at = offsetFrom(rect, u, 0);
      const lift = placed(new THREE.BoxGeometry(0.2, 1, 0.2), post, at.x, 0, at.y, rect.heading);
      group.add(lift);
      dynamic.lifts.push(lift);
    }
    const foot = placed(new THREE.BoxGeometry(rect.w / 1000 + 0.3, 0.05, rect.d / 1000 + 0.4), standard(0x40444a, 0.3, 0.6), rect.x, 0.025, rect.y, rect.heading);
    group.add(foot);
  }
  return dynamic;
}

export function setStationLift(dynamic, railTop) {
  for (const rail of dynamic.rails) rail.position.y = railTop - RAIL.height / 2;
  const postHeight = Math.max(0.02, railTop - RAIL.height);
  for (const lift of dynamic.lifts) {
    lift.position.y = postHeight / 2;
    lift.scale.y = postHeight;
  }
}

export function buildCargoObject(kind, textures = sharedTextures) {
  const group = new THREE.Group();
  const frame = standard(0x4b4f55, 0.45, 0.5);
  const width = PALLET.width / 1000;
  const length = PALLET.length / 1000;
  const add = (geometry, material, h, x = 0, z = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, h, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  for (const u of [-0.95, 0, 0.95]) add(new THREE.BoxGeometry(0.16, PALLET.thickness, width), frame, PALLET.thickness / 2, u);
  add(new THREE.BoxGeometry(length, 0.03, width * 0.62), standard(0x6e7278, 0.5, 0.45), PALLET.thickness + 0.015);
  const base = PALLET.thickness + 0.03;
  if (kind === 'COIL') {
    add(new THREE.BoxGeometry(1.5, 0.22, 1.5), standard(0x2a2c30, 0.3, 0.6), base + 0.11);
    const steel = standard(0xaeb4ba, 0.92, 0.3);
    const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.35, 56, 1, true), steel);
    coil.rotation.x = Math.PI / 2;
    coil.position.y = base + 0.22 + 0.8 - 0.18;
    const ring = new THREE.RingGeometry(0.3, 0.8, 56);
    for (const side of [-1, 1]) {
      const face = new THREE.Mesh(ring, standard(0x8c9299, 0.9, 0.42, { side: THREE.DoubleSide }));
      face.position.set(0, coil.position.y, side * 0.675);
      face.rotation.y = side > 0 ? 0 : Math.PI;
      face.castShadow = true;
      group.add(face);
    }
    coil.castShadow = true;
    group.add(coil);
  } else {
    const wood = standard(textures?.plywoodColor ? 0x9f7654 : 0xb48a58, 0, 0.82, { map: textures?.plywoodColor ?? null, normalMap: textures?.plywoodNormal ?? null, roughnessMap: textures?.plywoodRough ?? null });
    add(new THREE.BoxGeometry(1.9, 1.3, 1.7), wood, base + 0.65);
    const strap = standard(0x2b2d31, 0.4, 0.5);
    for (const x of [-0.6, 0.6]) add(new THREE.BoxGeometry(0.06, 1.33, 1.73), strap, base + 0.65, x);
  }
  return group;
}

function repeatTexture(texture, colorSpace) {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  if (colorSpace) texture.colorSpace = colorSpace;
  return texture;
}

// The source concrete is green. Keep its wear pattern, drop its hue. (Canvas filters are missing on iOS Safari.)
function neutralised(texture) {
  const { width, height } = texture.image;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(texture.image, 0, 0);
  const image = context.getImageData(0, 0, width, height);
  const { data } = image;
  let sum = 0;
  const grey = new Float32Array(width * height);
  for (let i = 0; i < grey.length; i++) {
    grey[i] = 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
    sum += grey[i];
  }
  const mean = sum / grey.length;
  for (let i = 0; i < grey.length; i++) {
    const value = 168 + (grey[i] - mean) * 0.38;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = value;
  }
  context.putImageData(image, 0, 0);
  texture.image = canvas;
  texture.needsUpdate = true;
  return texture;
}

let sharedTextures = null;

// Floor: scanned painted concrete. Walls, roof, doors, crates: baked by src/scene/make_factory_textures.py.
export async function loadPlantTextures(maxAnisotropy = 8) {
  const loader = new THREE.TextureLoader();
  const root = '/scene/textures';
  const load = (name, colorSpace, anisotropy = 2) => loader.loadAsync(`${root}/${name}`).then((t) => {
    repeatTexture(t, colorSpace);
    t.anisotropy = Math.min(anisotropy, maxAnisotropy);
    return t;
  });
  const sRGB = THREE.SRGBColorSpace;
  const [floorColor, floorRough, floorNormal, corrugatedColor, corrugatedNormal, corrugatedRough, blockColor, blockNormal, blockRough, window, plywoodColor, plywoodNormal, plywoodRough] = await Promise.all([
    load('painted_concrete_diff_1k.jpg', sRGB, 8).then(neutralised),
    load('painted_concrete_rough_1k.jpg', null, 8),
    load('painted_concrete_nor_gl_1k.jpg', null, 8),
    load('corrugated_iron_diff_1k.jpg', sRGB, 4),
    load('corrugated_iron_nor_1k.jpg', null, 4),
    load('corrugated_iron_rough_1k.jpg', null, 4),
    load('concrete_block_diff_1k.jpg', sRGB, 4),
    load('concrete_block_nor_1k.jpg', null, 4),
    load('concrete_block_rough_1k.jpg', null, 4),
    load('factory_window.jpg', sRGB),
    load('plywood_diff_1k.jpg', sRGB, 4),
    load('plywood_nor_1k.jpg', null, 4),
    load('plywood_rough_1k.jpg', null, 4),
  ]);
  sharedTextures = { floorColor, floorRough, floorNormal, corrugatedColor, corrugatedNormal, corrugatedRough, blockColor, blockNormal, blockRough, window, plywoodColor, plywoodNormal, plywoodRough, detail: floorColor };
  return sharedTextures;
}

// Roof trusses on every column line, purlins, high-bay lamps and a roof deck that is only
// visible from inside (it faces down, so from above it is back-face culled).
function buildRoof(plant, bounds, centre, sizeX, sizeY, textures) {
  const group = new THREE.Group();
  group.name = '屋面';
  const lines = [...new Set(plant.columns.map((c) => c.x))].sort((a, b) => a - b);
  const [z0, z1] = [worldZ(bounds.minY), worldZ(bounds.maxY)];
  const bottom = ROOF_HEIGHT - 1.4;
  const top = ROOF_HEIGHT - 0.12;
  const bars = [];
  const along = new THREE.Vector3(0, 0, 1);
  const bar = (a, b, thick) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const length = dir.length();
    bars.push(new THREE.Matrix4().compose(
      a.clone().add(b).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(along, dir.normalize()),
      new THREE.Vector3(thick, thick, length),
    ));
  };
  const panels = Math.max(2, Math.round(sizeY / 2));
  for (const lineX of lines) {
    const x = worldX(lineX);
    bar(new THREE.Vector3(x, bottom, z0), new THREE.Vector3(x, bottom, z1), 0.2);
    bar(new THREE.Vector3(x, top, z0), new THREE.Vector3(x, top, z1), 0.2);
    for (let i = 0; i < panels; i++) {
      const za = z0 + ((z1 - z0) * i) / panels;
      const zb = z0 + ((z1 - z0) * (i + 1)) / panels;
      bar(new THREE.Vector3(x, bottom, za), new THREE.Vector3(x, top, za), 0.09);
      const low = i % 2 === 0;
      bar(new THREE.Vector3(x, low ? bottom : top, za), new THREE.Vector3(x, low ? top : bottom, zb), 0.08);
    }
  }
  const [x0, x1] = [worldX(bounds.minX), worldX(bounds.maxX)];
  for (let z = z1 + 1.5; z < z0 - 1; z += 3) bar(new THREE.Vector3(x0, top + 0.06, z), new THREE.Vector3(x1, top + 0.06, z), 0.14);
  const steel = instanced(new THREE.BoxGeometry(1, 1, 1), standard(0xa4a8ac, 0.35, 0.5), bars);
  steel.castShadow = false;
  steel.receiveShadow = false;
  group.add(steel);

  const lamps = [];
  for (let i = 0; i < lines.length - 1; i++) {
    for (let z = z1 + 4; z < z0 - 2; z += 7) lamps.push(new THREE.Matrix4().makeTranslation((worldX(lines[i]) + worldX(lines[i + 1])) / 2, bottom - 0.5, z));
  }
  const lampMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.2, 0.32, 12), new THREE.MeshBasicMaterial({ color: 0xf4f7ff }), lamps.length);
  lamps.forEach((m, i) => lampMesh.setMatrixAt(i, m));
  group.add(lampMesh);

  const deck = new THREE.Mesh(
    scaleUv(new THREE.PlaneGeometry(sizeX, sizeY).rotateX(Math.PI / 2), sizeX / 8, sizeY / 8),
    // Lit, so the deck sits in shade under the trusses instead of glowing.
    new THREE.MeshStandardMaterial({ map: textures.corrugatedColor, normalMap: textures.corrugatedNormal, roughnessMap: textures.corrugatedRough, color: 0xa9adb0, metalness: 0.08, roughness: 0.72, side: THREE.DoubleSide }),
  );
  deck.receiveShadow = false;
  deck.position.set(worldX(centre.x), ROOF_HEIGHT, worldZ(centre.y));
  group.add(deck);
  group.userData.deck = deck;
  return group;
}

// Plain static meshes that share a material become one draw call (and one shadow call).
function mergeStatic(group, keep) {
  const buckets = new Map();
  for (const mesh of [...group.children]) {
    if (!mesh.isMesh || mesh.isInstancedMesh || keep.has(mesh) || mesh.material.transparent) continue;
    const g = mesh.geometry;
    if (!g.index || !g.attributes.uv || !g.attributes.normal || Object.keys(g.attributes).length !== 3) continue;
    const key = `${mesh.material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(mesh);
  }
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const merged = mergeGeometries(meshes.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    }));
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, meshes[0].material);
    mesh.castShadow = meshes[0].castShadow;
    mesh.receiveShadow = meshes[0].receiveShadow;
    for (const m of meshes) {
      group.remove(m);
      m.geometry.dispose();
    }
    group.add(mesh);
  }
}

// Column footprints from the drawing, extruded to their height. One merged mesh per kind.
function extrudedColumns(shapes, material) {
  const parts = shapes.map((column) => {
    const shape = new THREE.Shape(column.points.map((p) => new THREE.Vector2(worldX(p.x), p.y / 1000)));
    return new THREE.ExtrudeGeometry(shape, { depth: column.height / 1000, bevelEnabled: false }).rotateX(-Math.PI / 2); // ExtrudeGeometry is already non-indexed
  });
  if (!parts.length) return null;
  const merged = mergeGeometries(parts.map((g) => {
    g.clearGroups();
    return g;
  }));
  parts.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildRails(rails, group) {
  const steel = standard(0x6a6e73, 0.8, 0.35);
  const bed = standard(0x77797b, 0, 0.9);
  for (const rail of rails) {
    const pts = rail.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const length = Math.hypot(b.x - a.x, b.y - a.y) / 1000;
      if (length < 0.05) continue;
      const heading = Math.atan2(b.y - a.y, b.x - a.x);
      group.add(placed(new THREE.BoxGeometry(length, 0.04, 0.42), bed, (a.x + b.x) / 2, 0.02, (a.y + b.y) / 2, heading));
      group.add(placed(new THREE.BoxGeometry(length, 0.14, 0.07), steel, (a.x + b.x) / 2, 0.07, (a.y + b.y) / 2, heading));
    }
  }
}

// Build stages, in construction order. Each is a pivot at the hall centre so it can be scaled
// or lifted in place by a build animation; at rest they are identity transforms.
export const BUILD_STAGES = ['ground', 'frame', 'beam', 'crane', 'envelope', 'equip', 'roof'];

export function buildPlant(plant, textures) {
  const group = new THREE.Group();
  const xs = plant.walls.flatMap((wall) => wall.points.map((p) => p.x));
  const ys = plant.walls.flatMap((wall) => wall.points.map((p) => p.y));
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  const sizeX = (bounds.maxX - bounds.minX) / 1000;
  const sizeY = (bounds.maxY - bounds.minY) / 1000;

  const stages = {};
  const inner = {};
  for (const name of BUILD_STAGES) {
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.set(worldX(centre.x), 0, worldZ(centre.y));
    const content = new THREE.Group();
    content.position.set(-worldX(centre.x), 0, -worldZ(centre.y));
    pivot.add(content);
    group.add(pivot);
    stages[name] = pivot;
    inner[name] = content;
  }
  const ground = inner.ground;

  const apron = new THREE.Mesh(new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.24 }));
  apron.position.set(worldX(centre.x), -0.02, worldZ(centre.y));
  apron.receiveShadow = true;
  ground.add(apron);

  // The yard around the hall, when the drawing has a site boundary.
  if (plant.yard) {
    const yx = plant.yard.points.map((p) => p.x);
    const yy = plant.yard.points.map((p) => p.y);
    const [w, d] = [(Math.max(...yx) - Math.min(...yx)) / 1000, (Math.max(...yy) - Math.min(...yy)) / 1000];
    const yard = new THREE.Mesh(
      scaleUv(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), w / 10, d / 10),
      new THREE.MeshStandardMaterial({ map: textures.floorColor, roughnessMap: textures.floorRough, color: 0x7d8084, metalness: 0, roughness: 0.92 }),
    );
    yard.position.set(worldX((Math.max(...yx) + Math.min(...yx)) / 2), -0.012, worldZ((Math.max(...yy) + Math.min(...yy)) / 2));
    yard.receiveShadow = true;
    ground.add(yard);
    const kerb = new THREE.Mesh(ribbon({ points: plant.yard.points, closed: true }, 400, 0.002), standard(0xb8b4aa, 0, 0.85));
    kerb.receiveShadow = true;
    ground.add(kerb);
  }

  const floorGeometry = scaleUv(new THREE.PlaneGeometry(sizeX, sizeY).rotateX(-Math.PI / 2), sizeX / FLOOR_TILE, sizeY / FLOOR_TILE);
  // Scanned painted concrete (albedo ~120 sRGB). The 6 m saw-cut joints are drawn by surface-detail.js.
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: textures.floorColor, roughnessMap: textures.floorRough, normalMap: textures.floorNormal,
    normalScale: new THREE.Vector2(0.35, 0.35), color: 0xb4b6b8, metalness: 0, roughness: 0.8,
  });
  floorMaterial.defines = { DETAIL_FLOOR: '' };
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.position.set(worldX(centre.x), 0, worldZ(centre.y));
  floor.receiveShadow = true;
  ground.add(floor);

  const wallMaterial = new THREE.MeshStandardMaterial({
    map: textures.corrugatedColor, normalMap: textures.corrugatedNormal, roughnessMap: textures.corrugatedRough,
    color: 0xb8babd, metalness: 0.08, roughness: 0.68,
  });
  const dadoMaterial = new THREE.MeshStandardMaterial({
    map: textures.blockColor, normalMap: textures.blockNormal, roughnessMap: textures.blockRough,
    color: 0xb6aa94, metalness: 0, roughness: 0.82,
  });
  const sides = [];
  for (const wall of plant.walls) {
    const points = wall.points;
    const edges = wall.closed ? points.length : points.length - 1;
    for (let i = 0; i < edges; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y) / 1000;
      if (length < 0.01) continue;
      const heading = Math.atan2(b.y - a.y, b.x - a.x);
      const upperHeight = WALL_HEIGHT - 1.2;
      const dado = placed(scaleUv(new THREE.BoxGeometry(length + wall.width / 1000, 1.2, wall.width / 1000), length / 3, 1.2 / 2), dadoMaterial, (a.x + b.x) / 2, 0.6, (a.y + b.y) / 2, heading);
      const mesh = placed(scaleUv(new THREE.BoxGeometry(length + wall.width / 1000, upperHeight, wall.width / 1000), length / 3, upperHeight / 3), wallMaterial, (a.x + b.x) / 2, 1.2 + upperHeight / 2, (a.y + b.y) / 2, heading);
      inner.envelope.add(dado, mesh);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const along = { x: (b.x - a.x) / (length * 1000), y: (b.y - a.y) / (length * 1000) };
      const facing = Math.sign((centre.x - mid.x) * -along.y + (centre.y - mid.y) * along.x);
      sides.push({ a, along, length: length * 1000, x: worldX(mid.x), z: worldZ(mid.y), nx: -along.y * facing, nz: -along.x * facing, meshes: [dado, mesh], cut: false });
    }
  }

  if (plant.columnShapes?.length) {
    const concrete = extrudedColumns(plant.columnShapes.filter((c) => c.kind === 'concrete'), standard(0xb1aca2, 0, 0.86));
    const steel = extrudedColumns(plant.columnShapes.filter((c) => c.kind !== 'concrete'), standard(0x8d949b, 0.4, 0.45));
    for (const mesh of [concrete, steel]) if (mesh) inner.frame.add(mesh);
  } else {
    const bigColumn = hSection(0.5, 0.5);
    const smallColumn = hSection(0.3, 0.3);
    const columnLists = new Map();
    for (const column of plant.columns) {
      const geometry = column.block === 'COL_500' ? bigColumn : smallColumn;
      if (!columnLists.has(geometry)) columnLists.set(geometry, []);
      const height = Number(column.attrs.HEIGHT ?? 10500) / 1000;
      columnLists.get(geometry).push(matrix(column.x, 0, column.y, column.heading, 1, height, 1));
    }
    const columnMaterial = standard(0x9a9ea2, 0.3, 0.5);
    for (const [geometry, list] of columnLists) inner.frame.add(instanced(geometry, columnMaterial, list));
  }

  const beamMaterial = standard(0x5a5f65, 0.35, 0.5);
  for (const beam of plant.beams) {
    const a = beam.points[0];
    const b = beam.points.at(-1);
    const length = Math.hypot(b.x - a.x, b.y - a.y) / 1000;
    inner.beam.add(placed(new THREE.BoxGeometry(length, 0.9, beam.width / 1000), beamMaterial, (a.x + b.x) / 2, 9.4, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x)));
  }

  const markGeometries = {};
  // Floor paint: lanes and walkways are full colour bands, thin marks sit on top of them.
  plant.marks.forEach((mark, i) => {
    (markGeometries[mark.color] ??= []).push(ribbon(mark, mark.width || 80, 0.004 + (mark.width > 1000 ? 0 : 0.002) + i * 1e-6));
  });
  for (const [color, list] of Object.entries(markGeometries)) {
    const material = new THREE.MeshStandardMaterial({
      color: MARK_HEX[color], roughness: 0.62, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    material.defines = { DETAIL_FLOOR: '' };
    const merged = mergeGeometries(list);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    ground.add(mesh);
  }
  if (plant.paths.length) {
    const route = new THREE.Mesh(
      mergeGeometries(plant.paths.map((path) => ribbon(path, 50, 0.012))),
      new THREE.MeshBasicMaterial({ color: SHOW_PATH_COLOR, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    ground.add(route);
  }

  for (const label of plant.labels) {
    const mesh = textPlane(label.text, label.height);
    mesh.position.set(worldX(label.x), 0.016, worldZ(label.y));
    ground.add(mesh);
  }
  if (plant.rails?.length) buildRails(plant.rails, ground);

  buildRacks(plant, inner.equip, textures);
  plant.machines.forEach((m) => buildMachine(m, inner.equip));
  plant.conveyors.forEach((c) => buildConveyor(c, inner.equip));
  plant.cranes.forEach((c) => buildCrane(c, inner.crane));
  const fitToWall = (rect, meshes) => {
    let nearest = sides[0];
    let best = Infinity;
    for (const side of sides) {
      const u = THREE.MathUtils.clamp((rect.x - side.a.x) * side.along.x + (rect.y - side.a.y) * side.along.y, 0, side.length);
      const distance = Math.hypot(rect.x - side.a.x - side.along.x * u, rect.y - side.a.y - side.along.y * u);
      if (distance < best) {
        best = distance;
        nearest = side;
      }
    }
    nearest.meshes.push(...meshes);
    inner.envelope.add(...meshes);
  };
  plant.doors.forEach((door) => fitToWall(door.rects[0], buildDoor(door, centre, textures)));

  // Daylight windows are unlit: they read as bright as in the photos and cost nothing to shade.
  const glassMaterial = new THREE.MeshBasicMaterial({ map: textures.window, color: 0xc0c4c7 });
  const panelMaterial = new THREE.MeshStandardMaterial({ map: textures.corrugatedColor, normalMap: textures.corrugatedNormal, roughnessMap: textures.corrugatedRough, color: 0xb8babd, metalness: 0.08, roughness: 0.68 });
  for (const pane of plant.glazing) {
    const rect = pane.rects[0];
    const sill = Number(pane.attrs.SILL ?? 1500) / 1000;
    const height = Number(pane.attrs.HEIGHT ?? 6000) / 1000;
    const glass = pane.block !== 'PANEL_3000';
    const w = rect.w / 1000;
    const geometry = scaleUv(new THREE.BoxGeometry(w, height, 0.28), w / (glass ? 1.5 : 3), height / (glass ? 1.5 : 3));
    const mesh = placed(geometry, glass ? glassMaterial : panelMaterial, rect.x, sill + height / 2, rect.y, rect.heading);
    if (glass) mesh.castShadow = false;
    fitToWall(rect, [mesh]);
  }

  const stations = plant.stations.map((station) => buildStation(station, inner.equip));
  for (const side of sides) for (const mesh of side.meshes) mesh.userData.solid = mesh.material;
  const keep = new Set([floor, ...sides.flatMap((side) => side.meshes), ...stations.flatMap((d) => [...d.rails, ...d.lifts])]);
  for (const name of BUILD_STAGES) mergeStatic(inner[name], keep);
  const roof = buildRoof(plant, bounds, centre, sizeX, sizeY, textures);
  inner.roof.add(roof);
  for (const name of BUILD_STAGES) stages[name].userData.empty = inner[name].children.length === 0;
  return { group, stations, sides, roof, bounds, centre, size: { x: sizeX, y: sizeY }, stages };
}

// Walls between the camera and the hall stop drawing but keep casting shadows.
const CUT_AWAY = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

// The roof (trusses, lamps, deck) only shows from inside the hall; from above it would hide the floor.
export function updateCutaway(sides, camera, roof) {
  if (roof) roof.visible = camera.position.y < ROOF_HEIGHT - 0.4;
  for (const side of sides) {
    const cut = (camera.position.x - side.x) * side.nx + (camera.position.z - side.z) * side.nz < 0;
    if (cut === side.cut) continue;
    side.cut = cut;
    for (const mesh of side.meshes) mesh.material = cut ? CUT_AWAY : mesh.userData.solid;
  }
}
