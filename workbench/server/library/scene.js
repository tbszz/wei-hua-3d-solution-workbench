// Scene library: uploaded files, their detected kind and converted outputs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LibraryError, clone, filesDir, libraryDir, readJson, serialize, writeFileAtomic, writeJsonAtomic } from './store.js';
import { detectFormat, extOf, imageInfo, kindOf } from './detect.js';
import { ConversionError, DWG_UNSUPPORTED, convertModel, convertSite, isModel, isSite, pickMainEntry, unzipSafely, VirtualFiles } from './convert.js';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const sceneFile = () => path.join(libraryDir(), 'scene.json');
const FILES_URL = '/library/files';

const FORMAT_NAMES = {
  glb: 'GLB', gltf: 'glTF', obj: 'OBJ', stl: 'STL', ply: 'PLY', fbx: 'FBX', dae: 'Collada (DAE)', '3mf': '3MF', step: 'STEP', iges: 'IGES', brep: 'BREP',
  dxf: 'DXF', dwg: 'DWG', png: 'PNG', jpg: 'JPEG', webp: 'WebP', zip: 'ZIP', pdf: 'PDF',
};

async function loadAssets() {
  const file = await readJson(sceneFile(), { version: 1, assets: [] });
  return Array.isArray(file.assets) ? file.assets : [];
}

export async function listSceneAssets() {
  return clone(await serialize('scene', loadAssets));
}

export async function getSceneAsset(id) {
  return (await listSceneAssets()).find((asset) => asset.id === String(id)) ?? null;
}

function cleanName(filename) {
  const base = path.basename(String(filename || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return base.slice(0, 200) || '未命名文件';
}

const fileUrl = (id, name) => `${FILES_URL}/${id}/${name}`;

async function writeOutput(id, name, data) {
  await writeFileAtomic(path.join(filesDir(), id, name), data);
  return fileUrl(id, name);
}

async function convertInto(asset, { format, buffer, vfs = null, mainDir = '' }) {
  const kind = kindOf(format);
  asset.kind = kind === 'zip' ? 'document' : (kind ?? 'document');
  if (kind === 'model') {
    const { glb, meta, message } = await convertModel({ format, buffer, name: asset.name, vfs, mainDir });
    asset.url = await writeOutput(asset.id, 'model.glb', glb);
    asset.meta = { ...asset.meta, ...meta, glbBytes: glb.length };
    asset.message = message;
  } else if (kind === 'site') {
    const { site, dxf, meta, message } = await convertSite({ format, buffer });
    asset.url = await writeOutput(asset.id, 'site.json', JSON.stringify(site));
    asset.meta = { ...asset.meta, ...meta };
    if (dxf) asset.meta.dxfUrl = await writeOutput(asset.id, 'converted.dxf', dxf);
    asset.message = message;
  } else if (kind === 'image') {
    const info = imageInfo(buffer);
    if (asset.originalFormat === 'zip') asset.url = await writeOutput(asset.id, `image.${format}`, buffer);
    asset.thumbUrl = asset.url;
    asset.meta = { ...asset.meta, ...(info?.width ? { width: info.width, height: info.height } : {}), mimeType: info?.mime };
    asset.message = '图片已保存，可作为平面底图使用';
  } else {
    asset.kind = 'document';
    asset.message = '文件已保存，仅供参考，不参与三维转换';
  }
  asset.status = 'ready';
}

function unknownMessage(format) {
  return format && format !== 'unknown'
    ? `暂不支持 .${format} 文件。三维模型请用 GLB/glTF/OBJ/STL/PLY/FBX/DAE/3MF/STEP/IGES，厂房图请用 DXF，底图请用 PNG/JPG/WebP`
    : '无法识别文件格式。三维模型请用 GLB/glTF/OBJ/STL/PLY/FBX/DAE/3MF/STEP/IGES，厂房图请用 DXF，底图请用 PNG/JPG/WebP';
}

async function convertZip(asset, buffer) {
  const entries = unzipSafely(buffer);
  const main = pickMainEntry(entries);
  asset.meta.zipEntries = entries.size;
  if (!main) {
    const images = [...entries.keys()].filter((name) => ['png', 'jpg', 'webp'].includes(extOf(name)));
    if (entries.size === 1 && images.length === 1) {
      const data = Buffer.from(entries.get(images[0]));
      asset.meta.mainEntry = images[0];
      asset.meta.innerFormat = extOf(images[0]);
      return convertInto(asset, { format: extOf(images[0]), buffer: data });
    }
    asset.kind = 'document';
    asset.status = 'unsupported';
    asset.message = `压缩包里没有找到可识别的模型或图纸（共 ${entries.size} 个文件），已原样保存`;
    return undefined;
  }
  asset.meta.mainEntry = main.name;
  asset.meta.innerFormat = main.format;
  const data = Buffer.from(entries.get(main.name));
  const mainDir = path.posix.dirname(main.name) === '.' ? '' : path.posix.dirname(main.name);
  await convertInto(asset, { format: main.format, buffer: data, vfs: new VirtualFiles(entries), mainDir });
  asset.message = `压缩包主文件：${main.name}；${asset.message}`;
  return undefined;
}

// Store one uploaded file, detect its format and convert it. Never throws for bad input:
// problems come back as status 'failed' / 'unsupported' with a Chinese message.
export async function importUpload({ filename, buffer, mimeType, truncated = false } = {}) {
  const name = cleanName(filename);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const id = `a_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
  const detected = detectFormat(name, data);
  const ext = /^[a-z0-9]{1,8}$/.test(extOf(name)) ? path.extname(name).slice(1).toLowerCase() : 'bin';
  const asset = {
    id,
    name: path.basename(name, path.extname(name)) || name,
    originalName: name,
    originalFormat: detected.format,
    kind: kindOf(detected.format) === 'zip' ? 'document' : (kindOf(detected.format) ?? 'document'),
    status: 'failed',
    size: data.length,
    createdAt: new Date().toISOString(),
    url: null,
    meta: { detectedBy: detected.detectedBy, mimeType: mimeType || undefined, formatName: FORMAT_NAMES[detected.format] },
    message: '',
  };
  try {
    asset.meta.originalUrl = await writeOutput(id, `original.${ext}`, data);
    if (kindOf(detected.format) === 'image' || kindOf(detected.format) === 'document') asset.url = asset.meta.originalUrl;
    if (truncated || data.length > MAX_UPLOAD_BYTES) throw new ConversionError('文件超过 200 MB，未处理');
    if (!data.length) throw new ConversionError('文件是空的');
    if (detected.format === 'zip') await convertZip(asset, data);
    else if (isModel(detected.format) || isSite(detected.format) || kindOf(detected.format) === 'image' || kindOf(detected.format) === 'document') {
      await convertInto(asset, { format: detected.format, buffer: data });
    } else {
      asset.kind = 'document';
      throw new ConversionError(unknownMessage(detected.format), 'unsupported');
    }
    if (asset.kind === 'site') {
      asset.meta.originalDxfUrl = asset.originalFormat === 'dxf' ? asset.meta.originalUrl : undefined;
      asset.meta.dxfUrl ??= asset.meta.originalUrl;
    }
  } catch (error) {
    asset.status = error instanceof ConversionError ? error.status : 'failed';
    asset.message = error instanceof ConversionError ? error.message : `处理失败：${error.message}`;
    if (asset.status === 'unsupported' && detected.format === 'dwg') asset.message = DWG_UNSUPPORTED;
    if (asset.kind !== 'image' && asset.kind !== 'document') asset.url = null;
  }
  asset.meta = JSON.parse(JSON.stringify(asset.meta));
  await serialize('scene', async () => {
    const assets = await loadAssets();
    assets.push(asset);
    await writeJsonAtomic(sceneFile(), { version: 1, assets });
  });
  return clone(asset);
}

export async function deleteSceneAsset(id) {
  const key = String(id ?? '');
  const removed = await serialize('scene', async () => {
    const assets = await loadAssets();
    const index = assets.findIndex((asset) => asset.id === key);
    if (index < 0) return null;
    const [asset] = assets.splice(index, 1);
    await writeJsonAtomic(sceneFile(), { version: 1, assets });
    return asset;
  });
  if (!removed) throw new LibraryError(404, `素材不存在：${key}`);
  if (/^a_[a-z0-9]+$/.test(key)) await fs.rm(path.join(filesDir(), key), { recursive: true, force: true });
  return clone(removed);
}
