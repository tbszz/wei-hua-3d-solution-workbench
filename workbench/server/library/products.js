// Product library: built-ins seeded from code (demo/src/catalog.js + server CATALOG), user products persisted.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../domain/catalog.js';
import { LibraryError, clone, libraryDir, readJson, serialize, writeJsonAtomic } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_CATALOG = path.resolve(here, '../../../demo/src/catalog.js');
const MODEL_URL = '/library/product-models';
const RESERVED = new Set(['source', 'overridden', 'createdAt', 'updatedAt']);
const productsFile = () => path.join(libraryDir(), 'products.json');

// demo/src/catalog.js imports JSON configs the Vite way; read the same files directly.
function demoConfigs() {
  let source = '';
  try {
    source = fs.readFileSync(DEMO_CATALOG, 'utf8');
  } catch {
    return [];
  }
  const files = [...source.matchAll(/import\s+\w+\s+from\s+['"](.+?\.json)['"]/g)].map((match) => path.resolve(path.dirname(DEMO_CATALOG), match[1]));
  return files.flatMap((file) => {
    try {
      return [JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))];
    } catch {
      return [];
    }
  });
}

export function builtinProducts() {
  const seeds = [];
  const seen = new Set();
  for (const config of demoConfigs()) {
    const base = CATALOG.find((item) => item.id === config.id) ?? {};
    seeds.push({
      id: config.id,
      model: config.model ?? base.model,
      category: base.category ?? 'agv',
      capacityT: base.capacityT ?? null,
      fixture: base.fixture ?? [],
      summary: config.summary ?? base.summary ?? '',
      plate: config.plate ?? base.plate ?? '',
      params: clone(config.params ?? base.params ?? {}),
      extent: config.extent ?? null,
      bands: config.bands ?? null,
      protrusion: config.protrusion ?? null,
      modelUrl: config.glb ? `${MODEL_URL}/${config.glb}` : null,
      thumbUrl: config.thumbnail ? `${MODEL_URL}/${config.thumbnail}` : null,
      manifestUrl: config.manifest ? `${MODEL_URL}/${config.manifest}` : null,
      note: config.note ?? undefined,
      source: 'builtin',
      overridden: false,
    });
    seen.add(config.id);
  }
  for (const item of CATALOG) {
    if (seen.has(item.id)) continue;
    seeds.push({ ...clone(item), summary: item.summary ?? '', modelUrl: null, thumbUrl: null, procedural: true, source: 'builtin', overridden: false });
  }
  return seeds;
}

async function loadAll() {
  const seeds = builtinProducts();
  const file = await readJson(productsFile(), null);
  if (!file) {
    const now = new Date().toISOString();
    const seeded = seeds.map((item) => ({ ...item, createdAt: now, updatedAt: now }));
    await writeJsonAtomic(productsFile(), { version: 1, seededAt: now, products: seeded });
    return seeded;
  }
  const stored = Array.isArray(file.products) ? file.products : [];
  const builtinIds = new Set(seeds.map((item) => item.id));
  const merged = seeds.map((seed) => {
    const saved = stored.find((item) => item.id === seed.id);
    if (saved?.overridden) return { ...saved, source: 'builtin', overridden: true };
    return { ...seed, createdAt: saved?.createdAt ?? file.seededAt, updatedAt: saved?.updatedAt ?? file.seededAt };
  });
  for (const item of stored) if (!builtinIds.has(item.id) && item.source === 'user') merged.push(item);
  return merged;
}

async function persist(products) {
  const file = await readJson(productsFile(), {});
  await writeJsonAtomic(productsFile(), { version: 1, seededAt: file.seededAt ?? new Date().toISOString(), products });
}

export async function listProducts() {
  return clone(await serialize('products', loadAll));
}

export async function getProduct(id) {
  const products = await listProducts();
  const key = String(id ?? '').trim();
  return products.find((item) => item.id === key) ?? products.find((item) => String(item.model).toLowerCase() === key.toLowerCase()) ?? null;
}

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

export function validateProduct(product) {
  const errors = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(product.id ?? ''))) errors.push('产品 id 只能用字母、数字、点、下划线和短横线，最长 64 位');
  if (typeof product.model !== 'string' || !product.model.trim()) errors.push('型号（model）不能为空');
  else if (product.model.length > 80) errors.push('型号（model）最长 80 个字');
  if (typeof product.category !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(product.category)) errors.push('类别（category）不能为空，只能用字母、数字、下划线，例如 agv、overhead_crane');
  if (product.capacityT !== undefined && product.capacityT !== null && !(isNum(product.capacityT) && product.capacityT >= 0)) errors.push('额定载荷（capacityT）必须是不小于 0 的数字');
  const params = product.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params)) errors.push('参数（params）必须是对象');
  else {
    for (const [key, param] of Object.entries(params)) {
      const label = param?.label || key;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) { errors.push(`参数名「${key}」只能用字母、数字和下划线`); continue; }
      if (!param || typeof param !== 'object') { errors.push(`参数「${label}」必须是对象`); continue; }
      const missing = ['min', 'nominal', 'max'].filter((field) => !isNum(param[field]));
      if (missing.length) { errors.push(`参数「${label}」缺少数字字段：${missing.join('、')}`); continue; }
      if (!(param.min <= param.nominal && param.nominal <= param.max)) errors.push(`参数「${label}」范围不对：要求 最小值 ≤ 标称值 ≤ 最大值（当前 ${param.min} / ${param.nominal} / ${param.max}）`);
      if (param.step !== undefined && !(isNum(param.step) && param.step > 0)) errors.push(`参数「${label}」的步长必须是正数`);
      if (param.label !== undefined && typeof param.label !== 'string') errors.push(`参数「${key}」的名称（label）必须是文字`);
    }
  }
  for (const field of ['modelUrl', 'thumbUrl']) {
    if (product[field] !== undefined && product[field] !== null && typeof product[field] !== 'string') errors.push(`${field} 必须是文字链接`);
  }
  if (JSON.stringify(product).length > 256 * 1024) errors.push('产品数据太大（超过 256 KB）');
  return errors;
}

function slugify(model) {
  const slug = String(model ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug && /^[a-z0-9]/.test(slug) ? slug : `p-${randomBytes(3).toString('hex')}`;
}

function mergeParams(existing = {}, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming ?? existing;
  const merged = clone(existing) ?? {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete merged[key];
    else merged[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(merged[key] ?? {}), ...value } : value;
  }
  return merged;
}

// mode: 'create' (POST, id must be new), 'update' (PUT, id must exist) or 'upsert'.
// resolveAsset(id) lets a product point at an uploaded model via modelAssetId.
export async function saveProduct(input, { mode = 'upsert', resolveAsset } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LibraryError(400, '产品数据必须是 JSON 对象');
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => !RESERVED.has(key)));
  if (body.modelAssetId) {
    const asset = resolveAsset ? await resolveAsset(String(body.modelAssetId)) : null;
    if (!asset) throw new LibraryError(400, `找不到上传的模型：${body.modelAssetId}`);
    if (asset.kind !== 'model' || asset.status !== 'ready') throw new LibraryError(400, `上传的文件「${asset.name}」不是可用的三维模型`);
    body.modelUrl = asset.url;
    if (asset.thumbUrl) body.thumbUrl ??= asset.thumbUrl;
    if (asset.meta?.bboxM) body.bboxM ??= asset.meta.bboxM;
  }
  return serialize('products', async () => {
    const products = await loadAll();
    let id = body.id === undefined || body.id === null || body.id === '' ? null : String(body.id).trim();
    if (!id) {
      if (mode === 'update') throw new LibraryError(400, '缺少产品 id');
      id = slugify(body.model);
      let candidate = id;
      for (let n = 2; products.some((item) => item.id === candidate); n += 1) candidate = `${id}-${n}`;
      id = candidate;
    }
    const index = products.findIndex((item) => item.id === id);
    const existing = index >= 0 ? products[index] : null;
    if (mode === 'create' && existing) throw new LibraryError(409, `产品 id 已存在：${id}（修改请用 PUT）`);
    if (mode === 'update' && !existing) throw new LibraryError(404, `产品不存在：${id}`);
    const now = new Date().toISOString();
    const merged = { ...(existing ?? {}), ...body, id, params: mergeParams(existing?.params, body.params) };
    if (merged.params === undefined) merged.params = {};
    const errors = validateProduct(merged);
    if (errors.length) throw new LibraryError(400, errors.join('；'));
    const builtin = existing?.source === 'builtin';
    const record = { ...merged, source: builtin ? 'builtin' : 'user', overridden: builtin ? true : undefined, createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (!builtin) delete record.overridden;
    if (index >= 0) products[index] = record;
    else products.push(record);
    await persist(products);
    return { product: clone(record), created: !existing };
  });
}

export async function deleteProduct(id) {
  return serialize('products', async () => {
    const products = await loadAll();
    const key = String(id ?? '').trim();
    const index = products.findIndex((item) => item.id === key);
    if (index < 0) throw new LibraryError(404, `产品不存在：${key}`);
    const existing = products[index];
    if (existing.source === 'builtin') {
      const seed = builtinProducts().find((item) => item.id === key);
      const now = new Date().toISOString();
      products[index] = { ...seed, createdAt: existing.createdAt ?? now, updatedAt: now };
      await persist(products);
      return { deleted: false, reset: Boolean(existing.overridden), product: clone(products[index]), message: existing.overridden ? '内置产品已恢复默认参数' : '内置产品不能删除，当前已是默认参数' };
    }
    products.splice(index, 1);
    await persist(products);
    return { deleted: true, reset: false, product: clone(existing), message: '产品已删除' };
  });
}
