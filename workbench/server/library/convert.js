// Upload conversion: 3D formats -> GLB (metres, Y-up), DXF/DWG -> site JSON.
import path from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import DxfParser from 'dxf-parser';
import { THREE, exportGlb, settleTextures } from './three-node.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { parseCad } from '../../../demo/src/scene/parse-cad.js';
import { MODEL_FORMATS, SITE_FORMATS, detectFormat } from './detect.js';

const require = createRequire(import.meta.url);

export class ConversionError extends Error {
  constructor(message, status = 'failed') {
    super(message);
    this.status = status;
  }
}

export const DWG_UNSUPPORTED = 'DWG 暂不能直接解析，请在 CAD 里另存为 DXF 后上传';

const UNIT_SCALE = { micron: 1e-6, millimeter: 0.001, centimeter: 0.01, meter: 1, inch: 0.0254, foot: 0.3048 };
const UNIT_LABEL = { micron: 'µm', millimeter: 'mm', centimeter: 'cm', meter: 'm', inch: 'in', foot: 'ft' };
const toArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const text = (buffer) => Buffer.from(buffer).toString('utf8').replace(/^﻿/, '');

// ---------- virtual file system for multi-file sources (zip, gltf+bin, obj+mtl) ----------

function normalizeEntry(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean)) return null;
  const parts = clean.split('/');
  if (parts.some((part) => part === '..')) return null;
  return parts.filter((part) => part && part !== '.').join('/');
}

export class VirtualFiles {
  constructor(entries = new Map()) {
    this.entries = entries; // normalized path -> Uint8Array
  }

  lookup(ref, baseDir = '') {
    let wanted = decodeURIComponent(String(ref)).replace(/\\/g, '/').replace(/^vfs:\/*/, '');
    const direct = normalizeEntry(path.posix.join(baseDir, wanted));
    if (direct && this.entries.has(direct)) return this.entries.get(direct);
    const plain = normalizeEntry(wanted);
    if (plain && this.entries.has(plain)) return this.entries.get(plain);
    const lower = path.posix.basename(wanted).toLowerCase();
    for (const [key, value] of this.entries) if (path.posix.basename(key).toLowerCase() === lower) return value;
    return null;
  }

  manager(baseDir = '') {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (/^(data|blob):/.test(url)) return url;
      const bytes = this.lookup(url.replace(/^vfs:\/*/, ''), url.startsWith('vfs:') ? '' : baseDir);
      if (!bytes) return `data:application/x-missing;base64,`;
      return `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
    });
    return manager;
  }
}

const ZIP_LIMITS = { entries: 5000, totalBytes: 1024 * 1024 * 1024, entryBytes: 512 * 1024 * 1024, ratio: 400 };

export function unzipSafely(buffer) {
  let count = 0;
  let total = 0;
  let problem = null;
  const raw = unzipSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), {
    filter(file) {
      const name = normalizeEntry(file.name);
      if (!name || name.endsWith('/') || name.startsWith('__MACOSX/') || path.posix.basename(name).startsWith('._')) return false;
      count += 1;
      total += file.originalSize;
      if (count > ZIP_LIMITS.entries) problem = '压缩包里的文件太多（超过 5000 个）';
      else if (file.originalSize > ZIP_LIMITS.entryBytes) problem = `压缩包里的 ${name} 解压后超过 512 MB`;
      else if (total > ZIP_LIMITS.totalBytes) problem = '压缩包解压后超过 1 GB';
      else if (file.size > 0 && file.originalSize > 1024 * 1024 && file.originalSize / file.size > ZIP_LIMITS.ratio) problem = `压缩包里的 ${name} 压缩比异常，疑似压缩炸弹`;
      if (problem) throw new ConversionError(problem);
      return true;
    },
  });
  const entries = new Map();
  for (const [name, data] of Object.entries(raw)) {
    const clean = normalizeEntry(name);
    if (clean) entries.set(clean, data);
  }
  return entries;
}

const MAIN_PRIORITY = ['glb', 'gltf', 'fbx', 'obj', 'dae', '3mf', 'step', 'iges', 'brep', 'stl', 'ply', 'dxf', 'dwg'];

export function pickMainEntry(entries) {
  const candidates = [];
  for (const [name, data] of entries) {
    const { format } = detectFormat(name, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    const rank = MAIN_PRIORITY.indexOf(format);
    if (rank >= 0) candidates.push({ name, format, rank, size: data.byteLength, depth: name.split('/').length });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.depth - b.depth || b.size - a.size);
  return candidates[0] ?? null;
}

// ---------- model loading ----------

function defaultMaterial(vertexColors = false) {
  return new THREE.MeshStandardMaterial({ color: vertexColors ? 0xffffff : 0xb8bec6, metalness: 0.1, roughness: 0.7, vertexColors });
}

function meshFromGeometry(geometry, name) {
  const hasColors = Boolean(geometry.attributes.color);
  if (!geometry.attributes.normal && geometry.index !== null) geometry.computeVertexNormals();
  else if (!geometry.attributes.normal && geometry.attributes.position.count % 3 === 0) geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, defaultMaterial(hasColors));
  mesh.name = name;
  return mesh;
}

async function loadGltf(buffer, format, vfs, mainDir) {
  const loader = new GLTFLoader(vfs ? vfs.manager(mainDir) : undefined);
  const data = format === 'glb' ? toArrayBuffer(buffer) : text(buffer);
  if (format === 'gltf') {
    const json = JSON.parse(data);
    const external = [...(json.buffers ?? []), ...(json.images ?? [])].filter((item) => item.uri && !item.uri.startsWith('data:'));
    if (external.length && !vfs) throw new ConversionError('这个 .gltf 引用了外部 .bin/贴图文件，请把 .gltf 和它们一起打成 zip 上传');
    const missing = external.filter((item) => !vfs.lookup(item.uri, mainDir));
    if (missing.some((item) => json.buffers?.includes(item))) throw new ConversionError(`压缩包里缺少文件：${missing.map((item) => item.uri).join('、')}`);
  }
  const gltf = await loader.parseAsync(data, vfs ? `vfs:/${mainDir ? `${mainDir}/` : ''}` : '');
  return { root: gltf.scene, animations: gltf.animations ?? [], units: { scale: null, label: 'm' }, zUp: false };
}

function validateGlbHeader(buffer) {
  if (buffer.length < 20 || buffer.toString('latin1', 0, 4) !== 'glTF') throw new ConversionError('GLB 文件头无效');
  const version = buffer.readUInt32LE(4);
  const length = buffer.readUInt32LE(8);
  if (version !== 2) throw new ConversionError(`只支持 glTF 2.0 的 GLB（当前版本 ${version}）`);
  if (length > buffer.length) throw new ConversionError('GLB 文件不完整（长度不足）');
  if (buffer.readUInt32LE(16) !== 0x4e4f534a) throw new ConversionError('GLB 缺少 JSON 块');
}

async function loadObj(buffer, vfs, mainDir) {
  const source = text(buffer);
  const loader = new OBJLoader();
  const mtlNames = [...source.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((match) => match[1]);
  let materialsLoaded = false;
  for (const name of mtlNames) {
    const bytes = vfs?.lookup(name, mainDir);
    if (!bytes) continue;
    const mtl = new MTLLoader(vfs.manager(mainDir));
    mtl.setMaterialOptions({ ignoreZeroRGBs: true });
    const creator = mtl.parse(text(bytes), `vfs:/${mainDir ? `${mainDir}/` : ''}`);
    creator.preload();
    loader.setMaterials(creator);
    materialsLoaded = true;
    break;
  }
  const root = loader.parse(source);
  return { root, units: { scale: null }, zUp: false, note: mtlNames.length && !materialsLoaded ? '没找到 .mtl 材质文件，已用默认颜色' : '' };
}

function loadStl(buffer) {
  const binary = buffer.length >= 84 && 84 + 50 * buffer.readUInt32LE(80) === buffer.length;
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1');
  if (!binary && !(/^\s*solid/i.test(head) && /facet/i.test(head))) throw new ConversionError('STL 文件不完整或已损坏：既不是有效的二进制 STL（大小和三角形数对不上），也不是 ASCII STL，请重新导出');
  const geometry = new STLLoader().parse(toArrayBuffer(buffer));
  const root = new THREE.Group();
  root.add(meshFromGeometry(geometry, 'stl'));
  return { root, units: { scale: null }, zUp: true };
}

function loadPly(buffer) {
  const geometry = new PLYLoader().parse(toArrayBuffer(buffer));
  const root = new THREE.Group();
  const hasFaces = geometry.index !== null || (geometry.attributes.position.count % 3 === 0 && /element\s+face\s+[1-9]/.test(buffer.toString('latin1', 0, 2048)));
  if (hasFaces) root.add(meshFromGeometry(geometry, 'ply'));
  else root.add(new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.01, vertexColors: Boolean(geometry.attributes.color) })));
  return { root, units: { scale: null }, zUp: false };
}

function loadFbx(buffer, vfs, mainDir) {
  const loader = new FBXLoader(vfs ? vfs.manager(mainDir) : undefined);
  const root = loader.parse(toArrayBuffer(buffer), vfs ? `vfs:/${mainDir ? `${mainDir}/` : ''}` : '');
  const factor = Number(root.userData?.unitScaleFactor);
  const scale = Number.isFinite(factor) && factor > 0 ? factor * 0.01 : null;
  return { root, animations: root.animations ?? [], units: scale ? { scale, label: `FBX 单位 ${factor} cm` } : { scale: null }, zUp: false };
}

function loadDae(buffer, vfs, mainDir) {
  const loader = new ColladaLoader(vfs ? vfs.manager(mainDir) : undefined);
  const result = loader.parse(text(buffer), vfs ? `vfs:/${mainDir ? `${mainDir}/` : ''}` : '');
  if (!result?.scene) throw new ConversionError('Collada 文件解析失败');
  // ColladaLoader already applies <unit> and <up_axis>.
  return { root: result.scene, animations: result.scene.animations ?? [], units: { scale: 1, label: 'm（Collada 单位已换算）' }, zUp: false };
}

function load3mf(buffer) {
  let unit = 'millimeter';
  try {
    const entries = unzipSafely(buffer);
    for (const [name, data] of entries) {
      if (!name.toLowerCase().endsWith('.model')) continue;
      const match = /<model[^>]*\sunit\s*=\s*"([a-z]+)"/i.exec(Buffer.from(data).toString('utf8', 0, 4096));
      if (match) unit = match[1].toLowerCase();
      break;
    }
  } catch (error) {
    if (error instanceof ConversionError) throw error;
  }
  const root = new ThreeMFLoader().parse(toArrayBuffer(buffer));
  const scale = UNIT_SCALE[unit] ?? 0.001;
  return { root, units: { scale, label: UNIT_LABEL[unit] ?? 'mm' }, zUp: true };
}

let occtPromise = null;
function occt() {
  if (!occtPromise) {
    occtPromise = import('occt-import-js').then(({ default: factory }) => factory()).catch((error) => {
      occtPromise = null;
      throw error;
    });
  }
  return occtPromise;
}

async function loadCadSolid(buffer, format) {
  let lib;
  try {
    lib = await occt();
  } catch (error) {
    throw new ConversionError(`STEP/IGES 转换组件加载失败：${error.message}`);
  }
  const params = { linearUnit: 'meter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 };
  const input = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const reader = { step: 'ReadStepFile', iges: 'ReadIgesFile', brep: 'ReadBrepFile' }[format];
  const result = lib[reader](input, params);
  if (!result?.success) throw new ConversionError(`${format.toUpperCase()} 文件无法解析，请确认文件完整`);
  if (!result.meshes?.length) throw new ConversionError(`${format.toUpperCase()} 里没有可显示的实体`);
  const meshes = result.meshes.map((source, index) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.attributes.position.array, 3));
    if (source.attributes.normal) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(source.attributes.normal.array, 3));
    else geometry.computeVertexNormals();
    if (source.index) geometry.setIndex(Array.from(source.index.array));
    const color = source.color ? new THREE.Color().setRGB(...source.color, THREE.SRGBColorSpace) : new THREE.Color(0xb8bec6);
    const faceColors = (source.brep_faces ?? []).filter((face) => face.color);
    let material = new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.6 });
    if (faceColors.length && source.index) {
      const materials = [material];
      const keyed = new Map();
      for (const face of source.brep_faces) {
        let materialIndex = 0;
        if (face.color) {
          const key = face.color.join(',');
          if (!keyed.has(key)) {
            keyed.set(key, materials.length);
            materials.push(new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...face.color, THREE.SRGBColorSpace), metalness: 0.2, roughness: 0.6 }));
          }
          materialIndex = keyed.get(key);
        }
        geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, materialIndex);
      }
      material = materials;
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = source.name || `part-${index + 1}`;
    return mesh;
  });
  const root = new THREE.Group();
  const build = (node, parent) => {
    const group = new THREE.Group();
    group.name = node?.name || '';
    for (const index of node?.meshes ?? []) if (meshes[index]) group.add(meshes[index]);
    for (const child of node?.children ?? []) build(child, group);
    parent.add(group);
  };
  if (result.root) build(result.root, root);
  else meshes.forEach((mesh) => root.add(mesh));
  const brep = format === 'brep';
  return { root, units: brep ? { scale: null } : { scale: 1, label: 'mm（STEP/IGES 按文件单位换算）', declared: 'mm' }, zUp: true };
}

async function loadModel(format, buffer, vfs, mainDir) {
  switch (format) {
    case 'glb': validateGlbHeader(buffer); return loadGltf(buffer, 'glb', vfs, mainDir);
    case 'gltf': return loadGltf(buffer, 'gltf', vfs, mainDir);
    case 'obj': return loadObj(buffer, vfs, mainDir);
    case 'stl': return loadStl(buffer);
    case 'ply': return loadPly(buffer);
    case 'fbx': return loadFbx(buffer, vfs, mainDir);
    case 'dae': return loadDae(buffer, vfs, mainDir);
    case '3mf': return load3mf(buffer);
    case 'step': case 'iges': case 'brep': return loadCadSolid(buffer, format);
    default: throw new ConversionError(`不支持的模型格式：${format}`, 'unsupported');
  }
}

function stats(root) {
  let triangles = 0;
  let meshes = 0;
  let points = 0;
  root.traverse((object) => {
    if (object.isMesh) {
      meshes += 1;
      const geometry = object.geometry;
      triangles += Math.floor((geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0) / 3);
    } else if (object.isPoints) {
      points += object.geometry.attributes.position?.count ?? 0;
    }
  });
  return { triangles, meshes, points };
}

const round = (value, digits = 4) => Number(value.toFixed(digits));

// Rotate Z-up sources, scale to metres, put the base on y=0 and centre x/z.
function normalize(loaded, name) {
  const toRemove = [];
  loaded.root.traverse((object) => { if (object.isLight || object.isCamera) toRemove.push(object); });
  toRemove.forEach((object) => object.parent?.remove(object));

  const inner = new THREE.Group();
  inner.name = 'source';
  inner.add(loaded.root);
  if (loaded.zUp) inner.rotation.x = -Math.PI / 2;
  const wrapper = new THREE.Group();
  wrapper.name = name || 'model';
  wrapper.add(inner);
  wrapper.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(wrapper);
  if (rawBox.isEmpty()) throw new ConversionError('模型里没有可显示的几何体');
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z);
  let scale = loaded.units.scale;
  let sourceUnits = loaded.units.label ?? 'm';
  if (scale === null || scale === undefined) {
    const guessMm = maxDim > 500;
    scale = guessMm ? 0.001 : 1;
    sourceUnits = guessMm ? 'mm（按尺寸推测）' : 'm（按尺寸推测）';
  } else if (loaded.units.label === 'm' && maxDim * scale > 500) {
    scale *= 0.001;
    sourceUnits = 'mm（按尺寸推测）';
  }
  inner.scale.setScalar(scale);
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrapper);
  const center = box.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z);
  inner.position.copy(offset);
  wrapper.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3());
  return {
    wrapper,
    meta: {
      bboxM: { x: round(size.x), y: round(size.y), z: round(size.z) },
      ...stats(wrapper),
      sourceUnits,
      scaleApplied: scale,
      upAxis: loaded.zUp ? 'Z（已转为 Y 向上）' : 'Y',
      originOffsetM: { x: round(offset.x), y: round(offset.y), z: round(offset.z) },
    },
  };
}

export async function convertModel({ format, buffer, name, vfs = null, mainDir = '' }) {
  let loaded;
  try {
    loaded = await loadModel(format, buffer, vfs, mainDir);
    await settleTextures();
  } catch (error) {
    if (format === 'glb' && !(error instanceof ConversionError)) {
      // Compressed (Draco/meshopt) or exotic GLB: keep it as-is.
      return { glb: buffer, meta: { bboxM: null, triangles: null, meshes: null, sourceUnits: 'm（未换算）', scaleApplied: 1 }, message: `GLB 已原样保存，但无法读取尺寸（${error.message}）` };
    }
    throw error instanceof ConversionError ? error : new ConversionError(`${format.toUpperCase()} 解析失败：${error.message}`);
  }
  const { wrapper, meta } = normalize(loaded, name);
  let glb;
  try {
    glb = await exportGlb(wrapper, loaded.animations);
  } catch (error) {
    throw new ConversionError(`导出 GLB 失败：${error.message}`);
  }
  const parts = [`已转换为 GLB（米，Y 向上），${meta.meshes} 个网格，${meta.triangles} 个三角面`];
  if (meta.points) parts.push(`${meta.points} 个点`);
  if (loaded.note) parts.push(loaded.note);
  return { glb, meta, message: parts.join('；') };
}

// ---------- site drawings ----------

const DXF_UNITS = { 0: null, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 14: 100 };

export function decodeDxf(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  if (/ANSI_936|GB2312|GBK/i.test(buffer.toString('latin1', 0, 1 << 16))) {
    try { return new TextDecoder('gbk').decode(buffer); } catch { /* fall through */ }
  }
  return buffer.toString('latin1');
}

const MAX_GENERIC_LINES = 50000;

function arcPoints(center, radius, start, end, segments = 24) {
  let sweep = end - start;
  if (sweep <= 0) sweep += Math.PI * 2;
  const count = Math.max(4, Math.ceil((segments * sweep) / (Math.PI * 2)));
  return Array.from({ length: count + 1 }, (_, i) => {
    const a = start + (sweep * i) / count;
    return { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) };
  });
}

// Fallback when the drawing does not follow the Weihua layer convention: plain linework in mm.
function genericDxf(textContent) {
  const dxf = new DxfParser().parseSync(textContent);
  const unitScale = DXF_UNITS[dxf.header?.$INSUNITS] ?? 1;
  const p = (point) => ({ x: round(point.x * unitScale, 3), y: round(point.y * unitScale, 3) });
  const lines = [];
  const texts = [];
  const inserts = [];
  const layers = {};
  for (const entity of dxf.entities ?? []) {
    layers[entity.layer] = (layers[entity.layer] ?? 0) + 1;
    if (lines.length >= MAX_GENERIC_LINES) continue;
    if (entity.type === 'LINE' && entity.vertices?.length >= 2) lines.push({ layer: entity.layer, points: entity.vertices.map(p), closed: false });
    else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices?.length >= 2) lines.push({ layer: entity.layer, points: entity.vertices.map(p), closed: Boolean(entity.shape) });
    else if (entity.type === 'CIRCLE') lines.push({ layer: entity.layer, points: arcPoints(entity.center, entity.radius, 0, Math.PI * 2).map(p), closed: true });
    else if (entity.type === 'ARC') lines.push({ layer: entity.layer, points: arcPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle).map(p), closed: false });
    else if ((entity.type === 'TEXT' || entity.type === 'MTEXT') && entity.text) {
      const at = entity.startPoint ?? entity.position;
      if (at) texts.push({ layer: entity.layer, text: entity.text, ...p(at), height: (entity.textHeight ?? entity.height ?? 0) * unitScale });
    } else if (entity.type === 'INSERT' && entity.position) inserts.push({ layer: entity.layer, block: entity.name, ...p(entity.position), rotation: entity.rotation ?? 0 });
  }
  const xs = lines.flatMap((line) => line.points.map((point) => point.x));
  const ys = lines.flatMap((line) => line.points.map((point) => point.y));
  const bbox = xs.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : null;
  return { convention: 'generic', units: 'mm', bbox, layers, lines, texts, inserts, truncated: lines.length >= MAX_GENERIC_LINES };
}

const countsOf = (site) => Object.fromEntries(Object.entries(site).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));

export function convertDxf(buffer) {
  if (buffer.toString('latin1', 0, 18) === 'AutoCAD Binary DXF') throw new ConversionError('二进制 DXF 暂不支持，请在 CAD 里另存为 ASCII DXF 后上传', 'unsupported');
  const source = decodeDxf(buffer);
  try {
    const plant = parseCad(source);
    const site = { convention: 'weihua', units: 'mm', ...plant };
    return { site, meta: { convention: 'weihua', counts: countsOf(plant) }, message: `已解析厂房图：${plant.stations.length} 个工位、${plant.paths.length} 条 AGV 路径、${plant.walls.length} 段墙` };
  } catch (conventionError) {
    let site;
    try {
      site = genericDxf(source);
    } catch (error) {
      throw new ConversionError(`DXF 无法解析：${error.message}`);
    }
    if (!site.lines.length && !site.texts.length) throw new ConversionError(`DXF 里没有可用的线条（${conventionError.message}）`);
    return {
      site,
      meta: { convention: 'generic', counts: { lines: site.lines.length, texts: site.texts.length, inserts: site.inserts.length }, layers: Object.keys(site.layers).length, conventionError: conventionError.message },
      message: `图纸未按卫华图层约定（${conventionError.message}），已提取 ${site.lines.length} 条线作为底图参考`,
    };
  }
}

let dwgPromise = null;
function libredwg() {
  if (!dwgPromise) {
    dwgPromise = (async () => {
      const { LibreDwg } = await import('@mlightcad/libredwg-web');
      const wasmDir = path.join(path.dirname(require.resolve('@mlightcad/libredwg-web')), '..', 'wasm') + path.sep;
      return LibreDwg.create(wasmDir);
    })().catch((error) => {
      dwgPromise = null;
      throw error;
    });
  }
  return dwgPromise;
}

export async function dwgToDxf(buffer) {
  let lib;
  try {
    lib = await libredwg();
  } catch {
    throw new ConversionError(DWG_UNSUPPORTED, 'unsupported');
  }
  let output = null;
  try {
    output = lib.dwg_write_dxf(toArrayBuffer(buffer));
  } catch {
    dwgPromise = null; // a wasm abort leaves the instance unusable
  }
  if (!output?.length) throw new ConversionError(DWG_UNSUPPORTED, 'unsupported');
  return Buffer.from(output);
}

export async function convertSite({ format, buffer }) {
  if (format === 'dxf') return { ...convertDxf(buffer), dxf: null };
  const dxf = await dwgToDxf(buffer);
  let result;
  try {
    result = convertDxf(dxf);
  } catch (error) {
    throw new ConversionError(`DWG 已转成 DXF，但${error.message}`, error.status);
  }
  return { ...result, dxf, message: `DWG 已自动转换为 DXF（尽力而为，复杂图纸可能丢失实体）；${result.message}` };
}

export function isModel(format) { return MODEL_FORMATS.has(format); }
export function isSite(format) { return SITE_FORMATS.has(format); }
