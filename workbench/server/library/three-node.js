// Makes three.js loaders and GLTFExporter usable in Node.
// - FileReader (GLTFExporter binary output) and DOMParser (Collada/3MF) polyfills.
// - TextureLoader replacement that keeps the original image bytes instead of decoding pixels;
//   the exporter plugin below writes those bytes straight into the GLB.
import { resolveObjectURL } from 'node:buffer';
import { DOMParser as LinkeDOMParser } from 'linkedom';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { imageInfo } from './detect.js';

// GLTFLoader uses self.URL for embedded images.
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    result = null;
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        this.onload?.({ target: this });
        this.onloadend?.({ target: this });
      }, (error) => {
        this.error = error;
        this.onerror?.(error);
        this.onloadend?.({ target: this });
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.({ target: this });
        this.onloadend?.({ target: this });
      });
    }
  };
}

if (typeof globalThis.DOMParser === 'undefined') {
  globalThis.DOMParser = class DOMParser {
    parseFromString(text, type) {
      const xmlType = type === 'text/html' ? 'text/html' : 'text/xml';
      return new LinkeDOMParser().parseFromString(text, xmlType);
    }
  };
}

async function fetchBytes(url) {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const header = url.slice(5, comma);
    const body = url.slice(comma + 1);
    const bytes = header.endsWith(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
    return bytes;
  }
  if (url.startsWith('blob:')) {
    const blob = resolveObjectURL(url);
    if (!blob) throw new Error(`blob 不存在：${url}`);
    return Buffer.from(await blob.arrayBuffer());
  }
  throw new Error(`贴图无法读取：${url}`);
}

const pendingTextures = new Set();

THREE.TextureLoader.prototype.load = function load(url, onLoad, _onProgress, onError) {
  const texture = new THREE.Texture();
  let resolved = url;
  if (this.path && !/^(data|blob):/.test(url)) resolved = this.path + url;
  resolved = this.manager.resolveURL(resolved);
  this.manager.itemStart(resolved);
  const job = fetchBytes(resolved).then((bytes) => {
    const info = imageInfo(bytes);
    texture.image = { width: info?.width || 1, height: info?.height || 1, __bytes: bytes, __mime: info?.mime || null };
    texture.userData.mimeType = info?.mime || 'image/png';
    texture.needsUpdate = true;
    onLoad?.(texture);
    this.manager.itemEnd(resolved);
  }).catch((error) => {
    onError?.(error);
    this.manager.itemError(resolved);
    this.manager.itemEnd(resolved);
  }).finally(() => pendingTextures.delete(job));
  pendingTextures.add(job);
  return texture;
};

export async function settleTextures() {
  while (pendingTextures.size) await Promise.allSettled([...pendingTextures]);
}

const TEXTURE_KEYS = ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap', 'specularMap', 'lightMap', 'displacementMap', 'envMap'];
const GLTF_MIMES = new Set(['image/png', 'image/jpeg']);

// Remove textures we cannot embed, and turn flipY textures into flipped UVs (we embed raw bytes, no pixel flip).
export function prepareForExport(root) {
  root.traverse((object) => {
    if (!object.isMesh && !object.isPoints && !object.isLine) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    let flip = false;
    for (const material of materials) {
      if (!material) continue;
      for (const key of TEXTURE_KEYS) {
        const texture = material[key];
        if (!texture) continue;
        const ok = texture.isTexture && !texture.isCubeTexture && texture.image?.__bytes && GLTF_MIMES.has(texture.image.__mime);
        if (!ok || key === 'envMap' || key === 'lightMap' || key === 'displacementMap' || key === 'bumpMap' || key === 'specularMap') {
          material[key] = null;
          continue;
        }
        if (texture.flipY) flip = true;
      }
    }
    if (flip && object.geometry?.attributes?.uv) {
      object.geometry = object.geometry.clone();
      const uv = object.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i += 1) uv.setY(i, 1 - uv.getY(i));
      uv.needsUpdate = true;
      for (const material of materials) {
        for (const key of TEXTURE_KEYS) if (material?.[key]) material[key].flipY = false;
      }
    }
  });
}

function rawImagePlugin(writer) {
  const original = writer.processImage.bind(writer);
  const seen = new Map();
  writer.processImage = function processImage(image, format, flipY, mimeType = 'image/png') {
    if (!image?.__bytes) return original(image, format, flipY, mimeType);
    if (seen.has(image)) return seen.get(image);
    const json = writer.json;
    if (!json.images) json.images = [];
    const imageDef = { mimeType: image.__mime || mimeType };
    writer.pending.push(writer.processBufferViewImage(new Blob([image.__bytes])).then((index) => { imageDef.bufferView = index; }));
    const index = json.images.push(imageDef) - 1;
    seen.set(image, index);
    return index;
  };
  return {};
}

export async function exportGlb(root, animations = []) {
  await settleTextures();
  prepareForExport(root);
  const run = (options) => {
    const exporter = new GLTFExporter();
    exporter.register(rawImagePlugin);
    return exporter.parseAsync(root, { binary: true, onlyVisible: false, ...options });
  };
  let result;
  try {
    result = await run(animations.length ? { animations } : {});
  } catch (error) {
    if (!animations.length) throw error;
    result = await run({});
  }
  return Buffer.from(result);
}

export { THREE };
