// Loads a catalog product and applies the parametric stretch through shared shader uniforms.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import PAINT from '../../src/parametric/paints.json';
import { STRETCH_VERTEX_MAIN, STRETCH_VERTEX_PARS, bandFor } from './stretch.js';

const MODEL_ROOT = '/product-models/simplified';
const DECAL_OFFSET = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
const BODY_CLASSES = new Set(['skirt', 'deck', 'frame', 'plate', 'strip']);
const DECAL_CLASSES = new Set(['decal', 'strip']);
// Surface finish for products whose colour comes straight from the source file.
const CLASS_FINISH = {
  frame: { metalness: 0.15, roughness: 0.55 },
  deck: { metalness: 0.1, roughness: 0.78 },
  strip: { metalness: 0, roughness: 0.6 },
  drive: { metalness: 0.25, roughness: 0.5 },
  laser: { metalness: 0.2, roughness: 0.42 },
  hmi: { metalness: 0.05, roughness: 0.35 },
  charging: { metalness: 0.6, roughness: 0.35 },
  decal: { metalness: 0, roughness: 0.6 },
  light: { metalness: 0, roughness: 0.45, emissive: '#22c40e', emissiveIntensity: 0.6 },
};

export const STANDARDS = [
  { key: 'laser', label: '激光导航', swatch: '#b82a2a' },
  { key: 'hmi', label: '液晶屏', swatch: '#4982fa', showSize: true },
  { key: 'estop', label: '急停', swatch: '#d2b62c' },
  { key: 'charging', label: '充电接口', swatch: '#b87333', showSize: true },
];

const uniforms = {
  uBandX: { value: new THREE.Vector4() },
  uBandY: { value: new THREE.Vector4() },
  uBandZ: { value: new THREE.Vector4() },
};

export function applyBands(product, state) {
  const { params, bands } = product;
  const length = bandFor(bands.length, params.length.nominal, state.length);
  const width = bandFor(bands.width, params.width.nominal, state.width);
  const height = bandFor(bands.height, params.height.nominal, state.height);
  uniforms.uBandX.value.set(length.inner, length.outer, length.growth, 1);
  uniforms.uBandY.value.set(height.inner, height.outer, height.growth, 0);
  uniforms.uBandZ.value.set(width.inner, width.outer, width.growth, 1);
  return { length, width, height };
}

function injectStretch(material, isBody) {
  if (isBody) material.defines = { ...material.defines, STRETCH_BODY: 1 };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${STRETCH_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${STRETCH_VERTEX_MAIN}`);
  };
  material.customProgramCacheKey = () => 'vehicle-stretch';
  return material;
}

function finishFor(partClass, paint) {
  if (paint.startsWith('#')) return { color: paint, ...(CLASS_FINISH[partClass] ?? { metalness: 0.1, roughness: 0.6 }) };
  if (!PAINT[paint]) throw new Error(`未知涂装 ${partClass}:${paint}`);
  return PAINT[paint];
}

const depthFor = (isBody) => injectStretch(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), isBody);
const depthBody = depthFor(true);
const depthRigid = depthFor(false);
const cache = new Map();

export function loadVehicle(product) {
  if (!cache.has(product.id)) cache.set(product.id, read(product));
  return cache.get(product.id);
}

async function read(product) {
  const [gltf, manifest] = await Promise.all([
    new GLTFLoader().loadAsync(`${MODEL_ROOT}/${product.glb}`),
    fetch(`${MODEL_ROOT}/${product.manifest}`).then((response) => response.json()),
  ]);
  const classMeshes = new Map();
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    const [partClass, paint] = node.material.name.split(':');
    const { geometry } = node;
    const isBody = BODY_CLASSES.has(partClass);
    if (!isBody) {
      if (!geometry.attributes._anchor) throw new Error(`零件 ${node.name} 缺少锚点数据`);
      geometry.setAttribute('aAnchor', geometry.attributes._anchor);
    }
    const finish = finishFor(partClass, paint);
    node.material = injectStretch(new THREE.MeshStandardMaterial(DECAL_CLASSES.has(partClass) ? { ...finish, ...DECAL_OFFSET } : finish), isBody);
    node.customDepthMaterial = isBody ? depthBody : depthRigid;
    node.frustumCulled = false;
    node.castShadow = true;
    node.receiveShadow = !DECAL_CLASSES.has(partClass);
    if (!classMeshes.has(partClass)) classMeshes.set(partClass, []);
    classMeshes.get(partClass).push(node);
  });
  return { root: gltf.scene, manifest, classMeshes };
}

export function highlight(vehicle, active) {
  for (const { key } of STANDARDS) {
    for (const mesh of vehicle.classMeshes.get(key) ?? []) {
      mesh.material.emissive.set(key === active ? 0xff5a1f : 0x000000);
      mesh.material.emissiveIntensity = key === active ? 1.4 : 0;
    }
  }
}
