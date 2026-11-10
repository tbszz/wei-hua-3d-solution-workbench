// Parametric CAD parts through the text-to-cad engine (`cad` CLI + build123d).
// A request names a template and plain numbers; we never run model-written Python.
// Flow: job script -> `cad run` -> `cad model export` (GLB + STEP) + snapshot PNG
//       -> scene library asset (model) -> optional product library entry.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importUpload, getSceneAsset, saveProductDetailed } from '../library/index.js';
import { dataRoot, filesDir, libraryDir, readJson, serialize, writeJsonAtomic, LibraryError } from '../library/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = here;
const RUN_TIMEOUT_MS = 240_000;

// label, unit mm unless noted, [min, default, max]
export const TEMPLATES = {
  saddle_v: {
    label: 'V 型鞍座', category: 'saddle', note: '卷材横放在 V 形槽里，两侧带橡胶垫',
    params: {
      length: ['长度（沿卷轴）', 400, 1400, 4000], width: ['宽度', 400, 1200, 3000], height: ['高度', 150, 450, 1500],
      base_t: ['底板厚', 10, 40, 120], groove_angle: ['V 槽夹角（°）', 60, 90, 150], min_t: ['槽底最小厚度', 40, 120, 600], pad_t: ['橡胶垫厚（0 为无）', 0, 20, 60],
    },
  },
  saddle_cradle: {
    label: '弧形鞍座', category: 'saddle', note: '顶面按卷材外径切出圆弧座',
    params: {
      length: ['长度（沿卷轴）', 400, 1400, 4000], width: ['宽度', 400, 1300, 3000], height: ['高度', 150, 500, 1500],
      base_t: ['底板厚', 10, 40, 120], coil_d: ['适配卷材外径', 600, 1600, 3000], min_t: ['槽底最小厚度', 40, 120, 600],
    },
  },
  coil: {
    label: '钢卷', category: 'coil', note: '轴线水平放置',
    params: { diameter: ['外径', 400, 1600, 3000], eye: ['内径', 300, 600, 1000], width: ['宽度', 200, 1350, 2500] },
  },
  rack: {
    label: '横梁式货架', category: 'rack', note: '蓝色立柱 + 橙色横梁',
    params: {
      bays: ['列数（个）', 1, 3, 12], levels: ['层数（层）', 1, 4, 10], bay_width: ['每列宽', 1000, 2700, 4500], depth: ['进深', 600, 1100, 2000],
      level_height: ['层高', 600, 1500, 3000], upright: ['立柱截面', 60, 90, 200], beam_h: ['横梁高', 60, 120, 250], first_level: ['首层高度', 0, 200, 2000],
    },
  },
  pallet: {
    label: '托盘', category: 'pallet', note: '三纵梁托盘',
    params: { length: ['长', 600, 1200, 2500], width: ['宽', 600, 1000, 2000], height: ['高', 80, 150, 300] },
  },
};
const INTEGER_PARAMS = new Set(['bays', 'levels']);

export class CadError extends LibraryError {}

function binary() {
  if (process.env.CAD_BIN) return process.env.CAD_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'cad.exe' : 'cad');
  return fsSync.existsSync(local) ? local : 'cad';
}

function run(args, cwd, timeout = RUN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(binary(), args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (error, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      if (error) {
        const tail = out.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
        reject(new CadError(500, `CAD 引擎执行失败（${args[0]}）：${error.killed ? '超时' : tail || error.message}`));
      } else resolve(out);
    });
  });
}

const num = (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value);

// Clamp nothing silently: out-of-range numbers are an error the agent can explain.
export function resolveParams(template, input = {}) {
  const spec = TEMPLATES[template];
  if (!spec) throw new CadError(400, `不认识的零件模板：${template}。可用：${Object.keys(TEMPLATES).join('、')}、primitives、profile`);
  const params = {};
  const errors = [];
  for (const [key, [label, min, nominal, max]] of Object.entries(spec.params)) {
    let value = input[key] === undefined || input[key] === null ? nominal : num(input[key]);
    if (!Number.isFinite(value)) { errors.push(`${label} 必须是数字`); continue; }
    if (INTEGER_PARAMS.has(key)) value = Math.round(value);
    if (value < min || value > max) errors.push(`${label} ${value} 超出范围 ${min}–${max}`);
    params[key] = value;
  }
  const unknown = Object.keys(input).filter((key) => !(key in spec.params));
  if (unknown.length) errors.push(`模板「${spec.label}」没有参数：${unknown.join('、')}`);
  if (template === 'coil' && params.eye >= params.diameter) errors.push('钢卷内径必须小于外径');
  if (errors.length) throw new CadError(400, errors.join('；'));
  return params;
}

const finite = (value) => Number.isFinite(num(value));
const vec3 = (value, fallback) => (Array.isArray(value) && value.length === 3 && value.every(finite) ? value.map(num) : fallback);

function resolvePrimitives(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length || items.length > 80) throw new CadError(400, 'primitives 需要 1–80 个 items');
  return {
    items: items.map((item, index) => {
      const shape = item.shape === 'cylinder' ? 'cylinder' : 'box';
      const out = { shape, pos: vec3(item.pos, [0, 0, 0]), rot: vec3(item.rot, [0, 0, 0]), op: item.op === 'cut' ? 'cut' : 'add' };
      if (shape === 'cylinder') {
        out.radius = num(item.radius);
        out.height = num(item.height);
        if (!(out.radius > 0 && out.height > 0)) throw new CadError(400, `第 ${index + 1} 个圆柱缺少正数 radius / height`);
      } else {
        out.size = vec3(item.size, null);
        if (!out.size || out.size.some((v) => !(v > 0))) throw new CadError(400, `第 ${index + 1} 个方块缺少正数 size [长,宽,高]`);
      }
      if (typeof item.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(item.color)) out.color = item.color;
      return out;
    }),
  };
}

function resolveProfile(input = {}) {
  const pts = (list) => (Array.isArray(list) ? list.filter((p) => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1])).map((p) => [num(p[0]), num(p[1])]) : []);
  const points = pts(input.points);
  if (points.length < 3 || points.length > 4000) throw new CadError(400, '轮廓至少 3 个点');
  const depth = num(input.depth);
  if (!(depth > 0 && depth < 50_000)) throw new CadError(400, '拉伸长度 depth 必须是 0–50000 的数字（mm）');
  const holes = (Array.isArray(input.holes) ? input.holes : []).map(pts).filter((hole) => hole.length >= 3).slice(0, 200);
  return { points, depth, holes, axis: input.axis === 'z' ? 'z' : 'x' };
}

function jobScript(spec) {
  // The spec travels as base64 JSON so nothing in it can become Python code.
  const payload = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  return [
    'import base64, json, sys',
    'import build123d  # noqa: F401  (tells cad run to load the build123d integration)',
    'from cad import model',
    `sys.path.insert(0, ${JSON.stringify(PARTS_DIR)})`,
    'import weihua_parts',
    '',
    `SPEC = json.loads(base64.b64decode("${payload}").decode("utf-8"))`,
    '',
    '',
    '@model',
    'def part():',
    '    return weihua_parts.build(SPEC)',
    '',
    '',
    'if __name__ == "__main__":',
    '    part()',
    '',
  ].join('\n');
}

let queue = Promise.resolve();
const serialized = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

async function patchAsset(id, patch) {
  const file = path.join(libraryDir(), 'scene.json');
  return serialize('scene', async () => {
    const data = await readJson(file, { version: 1, assets: [] });
    const asset = data.assets.find((item) => item.id === id);
    if (!asset) return null;
    Object.assign(asset, patch.top ?? {});
    asset.meta = { ...(asset.meta ?? {}), ...(patch.meta ?? {}) };
    await writeJsonAtomic(file, data);
    return JSON.parse(JSON.stringify(asset));
  });
}

function bboxOf(out) {
  const match = out.match(/bounds\s+([\d,.]+)\s*×\s*([\d,.]+)\s*×\s*([\d,.]+)\s*mm/);
  return match ? match.slice(1, 4).map((v) => Number(v.replaceAll(',', ''))) : null;
}

function productParams(template, params) {
  const spec = TEMPLATES[template];
  if (!spec) return {};
  return Object.fromEntries(Object.entries(spec.params).map(([key, [label, min, , max]]) => [key, { label: label.replace(/（.*?）/, ''), nominal: params[key], min, max, step: INTEGER_PARAMS.has(key) ? 1 : 10 }]));
}

// body: { template, params, name, register_product, product: { id, category, capacityT, industries, summary } }
export async function buildPart(body = {}) {
  const template = String(body.template || '');
  let params;
  if (template === 'primitives') params = resolvePrimitives(body.params);
  else if (template === 'profile') params = resolveProfile(body.params);
  else params = resolveParams(template, body.params ?? {});
  const label = TEMPLATES[template]?.label ?? (template === 'profile' ? '轮廓拉伸件' : '组合零件');
  const name = String(body.name || `${label}-${Date.now().toString(36)}`).replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
  return serialized(() => buildNow({ template, params, name, label, body }));
}

async function buildNow({ template, params, name, label, body }) {
  const started = Date.now();
  const jobId = `cad_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const dir = path.join(dataRoot(), 'cad', jobId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'part.py'), jobScript({ template, params }), 'utf8');
  const out = await run(['run', 'part.py'], dir);
  const docId = out.match(/id:\s*([0-9a-f-]{36})/)?.[1];
  if (!docId) throw new CadError(500, `CAD 引擎没有返回模型 id：${out.split(/\r?\n/).filter(Boolean).slice(-4).join(' / ')}`);
  const bboxMm = bboxOf(out);
  await run(['model', 'export', docId, 'model.glb', 'model.step'], dir, 120_000);
  await run(['model', 'snapshot', docId, 'preview.png'], dir, 120_000).catch(() => null);
  const glb = await fs.readFile(path.join(dir, 'model.glb'));
  let asset = await importUpload({ filename: `${name}.glb`, buffer: glb, mimeType: 'model/gltf-binary' });
  if (asset.status !== 'ready') throw new CadError(500, `模型入库失败：${asset.message}`);
  const target = path.join(filesDir(), asset.id);
  await fs.copyFile(path.join(dir, 'model.step'), path.join(target, 'model.step'));
  const hasPng = fsSync.existsSync(path.join(dir, 'preview.png'));
  if (hasPng) await fs.copyFile(path.join(dir, 'preview.png'), path.join(target, 'preview.png'));
  const stepUrl = `/library/files/${asset.id}/model.step`;
  const thumbUrl = hasPng ? `/library/files/${asset.id}/preview.png` : null;
  asset = (await patchAsset(asset.id, {
    top: thumbUrl ? { thumbUrl } : {},
    meta: { stepUrl, cad: { engine: 'text-to-cad/build123d', template, params, bboxMm, jobId }, source: 'cad' },
  })) ?? asset;

  let product = null;
  if (body.register_product) {
    const extra = body.product ?? {};
    const input = {
      model: name,
      category: extra.category || TEMPLATES[template]?.category || 'part',
      summary: extra.summary || `${label}，text-to-cad 参数化生成${bboxMm ? `，外形 ${bboxMm.join(' × ')} mm` : ''}`,
      params: template in TEMPLATES ? productParams(template, params) : {},
      modelAssetId: asset.id,
      cad: { template, params, stepUrl },
    };
    input.id = extra.id ? String(extra.id) : `cad-${template.replace(/_/g, '-')}-${Date.now().toString(36)}`;
    if (Number.isFinite(num(extra.capacityT))) input.capacityT = num(extra.capacityT);
    if (Array.isArray(extra.industries)) input.industries = extra.industries.map(String).slice(0, 12);
    if (thumbUrl) input.thumbUrl = thumbUrl;
    ({ product } = await saveProductDetailed(input));
  }
  return { ok: true, asset, product, bboxMm, stepUrl, thumbUrl, seconds: Math.round((Date.now() - started) / 100) / 10, template, params };
}

// ---- drawing -> part ---------------------------------------------------------

const area = (pts) => Math.abs(pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
const inside = (p, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
};
const dedupe = (pts) => pts.filter((p, i) => { const q = pts[(i + 1) % pts.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 0.01; });

// Join open segments end-to-end into closed loops (drawings are often made of LINEs).
function chainLoops(open, tol) {
  const loops = [];
  const pool = open.map((line) => line.points.slice());
  while (pool.length) {
    let chain = pool.shift();
    let grown = true;
    while (grown) {
      grown = false;
      const end = chain[chain.length - 1];
      for (let i = 0; i < pool.length; i += 1) {
        const seg = pool[i];
        const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
        if (near(seg[0], end)) chain = chain.concat(seg.slice(1));
        else if (near(seg[seg.length - 1], end)) chain = chain.concat(seg.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (chain.length > 3 && Math.hypot(chain[0].x - chain[chain.length - 1].x, chain[0].y - chain[chain.length - 1].y) <= tol) loops.push(chain.slice(0, -1));
  }
  return loops;
}

export function profileFromSite(site, { layer } = {}) {
  const scale = site.units === 'm' ? 1000 : 1;
  const lines = (site.lines ?? []).filter((line) => !layer || line.layer === layer);
  const closed = lines.filter((line) => line.closed && line.points.length >= 3).map((line) => dedupe(line.points));
  const span = Math.max(1, (site.bbox?.maxX ?? 1) - (site.bbox?.minX ?? 0), (site.bbox?.maxY ?? 1) - (site.bbox?.minY ?? 0));
  const loops = closed.concat(chainLoops(lines.filter((line) => !line.closed && line.points.length >= 2), span * 1e-4)).filter((pts) => pts.length >= 3);
  if (!loops.length) throw new CadError(400, '图纸里找不到封闭轮廓（需要闭合多段线，或首尾相接的线段）');
  loops.sort((a, b) => area(b) - area(a));
  const outer = loops[0];
  const holes = loops.slice(1).filter((loop) => loop.every((p) => inside(p, outer)) && area(loop) < area(outer) * 0.9);
  const xs = outer.map((p) => p.x);
  const ys = outer.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const minY = Math.min(...ys);
  const map = (pts) => pts.map((p) => [Math.round((p.x - cx) * scale * 100) / 100, Math.round((p.y - minY) * scale * 100) / 100]);
  return {
    points: map(outer),
    holes: holes.map(map),
    sizeMm: [Math.round((Math.max(...xs) - Math.min(...xs)) * scale), Math.round((Math.max(...ys) - minY) * scale)],
    loops: loops.length,
  };
}

// body: { assetId, depth, name, axis ('x' side view | 'z' plan view), layer, register_product, product }
export async function buildFromDrawing(body = {}) {
  const asset = await getSceneAsset(String(body.assetId || ''));
  if (!asset) throw new CadError(404, `场景库里找不到图纸：${body.assetId}`);
  if (asset.kind !== 'site' || asset.status !== 'ready') throw new CadError(400, `「${asset.name}」不是已解析的 CAD 图纸（DXF/DWG）`);
  const site = JSON.parse(await fs.readFile(path.join(filesDir(), asset.id, 'site.json'), 'utf8'));
  const outline = profileFromSite(site, { layer: body.layer });
  const depth = num(body.depth) || 1400;
  const result = await buildPart({
    template: 'profile',
    params: { points: outline.points, holes: outline.holes, depth, axis: body.axis === 'z' ? 'z' : 'x' },
    name: body.name || `${asset.name}-实体`,
    register_product: body.register_product,
    product: { category: 'saddle', ...(body.product ?? {}) },
  });
  return { ...result, drawing: { id: asset.id, name: asset.name, outlineSizeMm: outline.sizeMm, holes: outline.holes.length, loopsFound: outline.loops } };
}

export async function cadStatus() {
  try {
    const out = await run(['status'], process.cwd(), 20_000);
    return { ok: true, engine: out.split(/\r?\n/)[0], templates: Object.fromEntries(Object.entries(TEMPLATES).map(([key, spec]) => [key, { label: spec.label, note: spec.note, params: spec.params }])) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
