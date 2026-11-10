// REST API for the product library, scene library and project persistence.
import express from 'express';
import busboy from 'busboy';
import * as library from './index.js';
import { filesDir, productModelsDir } from './store.js';

const MAX_FILES_PER_REQUEST = 50;
const json = express.json({ limit: '50mb' });

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error('[library]', error);
    res.status(status).json({ ok: false, error: status === 500 ? `服务器处理失败：${error.message}` : error.message });
  }
};

// Collect every uploaded file; an oversize file is marked truncated instead of failing the request.
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: library.MAX_UPLOAD_BYTES, files: MAX_FILES_PER_REQUEST } });
    } catch {
      reject(Object.assign(new Error('请用 multipart/form-data 上传，字段名 files'), { status: 400 }));
      return;
    }
    const files = [];
    let filesLimitHit = false;
    parser.on('file', (field, stream, info) => {
      const chunks = [];
      const entry = { field, filename: info.filename, mimeType: info.mimeType, truncated: false, buffer: null };
      files.push(entry);
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => { entry.truncated = true; chunks.length = 0; });
      stream.on('end', () => { entry.buffer = entry.truncated ? Buffer.alloc(0) : Buffer.concat(chunks); });
    });
    parser.on('filesLimit', () => { filesLimitHit = true; });
    parser.on('error', (error) => reject(Object.assign(error, { status: 400 })));
    parser.on('close', () => resolve({ files, filesLimitHit }));
    req.pipe(parser);
  });
}

function staticFrom(getDir, options) {
  const cache = new Map();
  return (req, res, next) => {
    const dir = getDir();
    if (!cache.has(dir)) cache.set(dir, express.static(dir, options));
    cache.get(dir)(req, res, next);
  };
}

export function createLibraryRouter() {
  const router = express.Router();

  router.use('/library/files', staticFrom(filesDir, { dotfiles: 'deny', index: false, maxAge: '1h', fallthrough: false }));
  router.use('/library/product-models', staticFrom(productModelsDir, { dotfiles: 'deny', index: false, maxAge: '1h', fallthrough: false }));

  // Products
  router.get('/api/products', handle(async (_req, res) => res.json({ products: await library.listProducts() })));
  router.get('/api/library/products', handle(async (_req, res) => res.json({ ok: true, products: await library.listProducts() })));
  router.post('/api/library/products', json, handle(async (req, res) => {
    const { product } = await library.saveProductDetailed(req.body, { mode: 'create' });
    res.status(201).json({ ok: true, product });
  }));
  router.get('/api/library/products/:id', handle(async (req, res) => {
    const product = await library.getProduct(req.params.id);
    if (!product) return res.status(404).json({ ok: false, error: `产品不存在：${req.params.id}` });
    return res.json({ ok: true, product });
  }));
  router.put('/api/library/products/:id', json, handle(async (req, res) => {
    const body = { ...(req.body ?? {}), id: req.params.id };
    const { product, created } = await library.saveProductDetailed(body, { mode: 'upsert' });
    res.status(created ? 201 : 200).json({ ok: true, product });
  }));
  router.delete('/api/library/products/:id', handle(async (req, res) => res.json({ ok: true, ...await library.deleteProduct(req.params.id) })));

  // Scene assets
  router.get('/api/library/scene', handle(async (req, res) => {
    const kind = String(req.query.kind || '');
    const assets = await library.listSceneAssets();
    res.json({ ok: true, assets: kind ? assets.filter((asset) => asset.kind === kind) : assets });
  }));
  router.post('/api/library/scene', handle(async (req, res) => {
    const { files, filesLimitHit } = await readMultipart(req);
    const uploads = files.filter((file) => file.field === 'files' || file.field === 'file' || file.field === 'files[]');
    if (!uploads.length) return res.status(400).json({ ok: false, error: '没有收到文件，请用字段名 files 上传', assets: [] });
    const assets = [];
    for (const file of uploads) {
      assets.push(await library.importUpload({ filename: file.filename, buffer: file.buffer, mimeType: file.mimeType, truncated: file.truncated }));
    }
    const ready = assets.filter((asset) => asset.status === 'ready').length;
    return res.status(201).json({
      ok: ready > 0,
      assets,
      message: `收到 ${assets.length} 个文件，${ready} 个可用${filesLimitHit ? `；一次最多上传 ${MAX_FILES_PER_REQUEST} 个，其余未处理` : ''}`,
    });
  }));
  router.get('/api/library/scene/:id', handle(async (req, res) => {
    const asset = await library.getSceneAsset(req.params.id);
    if (!asset) return res.status(404).json({ ok: false, error: `素材不存在：${req.params.id}` });
    return res.json({ ok: true, asset });
  }));
  // Names written on a drawing (TEXT entities, plus exploded-curve text read by OCR unless ?read=0).
  router.get('/api/library/scene/:id/text', handle(async (req, res) => res.json({ ok: true, ...await library.readSceneText(req.params.id, { read: req.query.read !== '0' }) })));
  router.delete('/api/library/scene/:id', handle(async (req, res) => res.json({ ok: true, asset: await library.deleteSceneAsset(req.params.id) })));

  // Project state for the browser engine
  router.get('/api/projects/:id/state', handle(async (req, res) => res.json(await library.getProjectState(req.params.id))));
  router.put('/api/projects/:id/state', json, handle(async (req, res) => {
    const record = await library.saveProjectState(req.params.id, req.body?.state, { baseVersion: req.body?.baseVersion });
    res.json({ ok: true, version: record.version, updatedAt: record.updatedAt });
  }));
  router.get('/api/projects/:id/state/versions', handle(async (req, res) => res.json({ ok: true, versions: await library.listProjectStateVersions(req.params.id) })));
  router.get('/api/projects/:id/state/versions/:version', handle(async (req, res) => res.json(await library.getProjectStateVersion(req.params.id, req.params.version))));
  router.get('/api/projects/:id/chat-history', handle(async (req, res) => res.json({ ok: true, messages: await library.getChatHistory(req.params.id) })));
  router.post('/api/projects/:id/chat-history', json, handle(async (req, res) => {
    const messages = await library.appendChatHistory(req.params.id, req.body);
    res.status(201).json({ ok: true, count: messages.length, messages });
  }));

  // Body-parser errors on our routes
  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: '请求体不是合法的 JSON' });
    if (error?.type === 'entity.too.large') return res.status(413).json({ ok: false, error: '请求体太大（上限 50 MB）' });
    if (error?.status === 404 || error?.statusCode === 404) return res.status(404).json({ ok: false, error: '文件不存在' });
    return next(error);
  });

  return router;
}

export const libraryRouter = createLibraryRouter();
