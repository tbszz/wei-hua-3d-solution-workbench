import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadPlan, runOffline, runOnline, runTool, sse, listPlanVersions } from './runtime.js';
import { libraryRouter } from './library/routes.js';
import { createCadRouter } from './cad/routes.js';
import { TOOL_NAMES } from './domain/plan.js';

export const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const projects = new Map();
const jobs = new Map();

export const FIXTURES = [
  { id: 'agv-coil-rack', model: '卷材支架', category: 'agv_fixture', compatibleProducts: ['agv1', 'z1-1000-bz'], demo: true, source: 'demo_data' },
  { id: 'c-hook', model: 'C 形钩', category: 'crane_fixture', compatibleProducts: ['double-girder-crane-demo'], demo: true, source: 'demo_data' },
];

const hasOnlineKey = () => String(process.env.MAGPIE_ENABLED || '').toLowerCase() === 'true' || Boolean(process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY || process.env.BIGMODEL_API_KEY);
const clone = (value) => JSON.parse(JSON.stringify(value));
const projectIdOf = (value) => String(value || 'default').trim() || 'default';
const planPayload = (projectId, plan) => ({ ...clone(plan), projectId, plan: clone(plan) });

function filesFor(projectId) {
  const key = projectIdOf(projectId);
  if (!projects.has(key)) projects.set(key, []);
  return projects.get(key);
}

function makeFile(projectId, body = {}) {
  const name = String(body.name || body.filename || '').trim();
  if (!name) return { error: '文件名不能为空。' };
  const declaredSize = body.size === undefined ? undefined : Number(body.size);
  if (declaredSize !== undefined && (!Number.isFinite(declaredSize) || declaredSize < 0)) return { error: '文件大小无效。' };
  const content = body.content === undefined || body.content === null ? '' : String(body.content);
  const size = declaredSize === undefined ? Buffer.byteLength(content, 'utf8') : declaredSize;
  const file = {
    id: `file_${randomUUID().replaceAll('-', '')}`,
    projectId: projectIdOf(projectId),
    name,
    kind: String(body.kind || body.type || 'asset'),
    mimeType: String(body.mimeType || body.mimetype || 'application/octet-stream'),
    size,
    source: String(body.source || 'upload'),
    containsCustomerInfo: Boolean(body.containsCustomerInfo ?? body.contains_customer_info),
    createdAt: new Date().toISOString(),
    contentStored: false,
  };
  filesFor(projectId).push(file);
  return { file: clone(file) };
}

function createJob(projectId, body = {}) {
  const key = projectIdOf(projectId);
  const type = String(body.type || body.kind || 'render_image');
  const allowed = new Set(['render_image', 'record_video', 'interactive_page']);
  if (!allowed.has(type)) return { error: `任务类型不支持：${type}。` };
  const id = `job_${randomUUID().replaceAll('-', '')}`;
  const job = {
    id,
    projectId: key,
    type,
    status: 'queued',
    progress: 0,
    message: '任务已排队。',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    asset: null,
  };
  jobs.set(id, job);
  const stages = [
    { delay: 20, status: 'running', progress: 25, message: '正在准备 ScenePlan。' },
    { delay: 45, status: 'running', progress: 65, message: '正在执行引擎任务。' },
    { delay: 75, status: 'completed', progress: 100, message: '任务已完成。', asset: { kind: type, generation: { tool: 'threejs' } } },
  ];
  for (const stage of stages) {
    const timer = setTimeout(() => {
      const current = jobs.get(id);
      if (!current) return;
      Object.assign(current, stage, { updatedAt: new Date().toISOString() });
    }, stage.delay);
    timer.unref?.();
  }
  return { job: clone(job) };
}

async function projectPlan(projectId) {
  return loadPlan(projectIdOf(projectId));
}

async function patchProjectPlan(projectId, req, res) {
  const key = projectIdOf(projectId);
  const plan = await projectPlan(key);
  const tool = req.body?.tool || req.body?.op;
  const args = req.body?.args || {};
  const result = await runTool(plan, tool, args, key);
  if (result.ok === false) return res.status(400).json(result);
  return res.json({ ...result, projectId: key, plan: result.plan ?? await projectPlan(key) });
}

async function handleChat(req, res, projectId = 'default') {
  const key = projectIdOf(projectId);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const plan = await projectPlan(key);
  const text = String(req.body?.message || '');
  const emit = (event, payload) => sse(res, event, payload);
  emit('meta', { mode: hasOnlineKey() ? 'online' : 'offline', provider: String(process.env.MAGPIE_ENABLED || '').toLowerCase() === 'true' ? 'magpie-doubao' : 'default', projectId: key });
  const result = hasOnlineKey()
    ? await runOnline(plan, text, emit, key)
    : await runOffline(plan, text, key);
  if (result.message && result.mode === 'offline') {
    for (const chunk of result.message.match(/.{1,28}/gu) || []) emit('token', { text: chunk });
  }
  if (result.plan) emit('scene_plan.updated', result.plan);
  if (result.card) emit('result.card', result.card);
  emit('done', { ok: result.ok !== false, message: result.message, error: result.error, mode: result.mode || 'offline', projectId: key });
  res.end();
}

app.use(cors());
app.use(libraryRouter); // product/scene library, uploads, project state + chat history (before the 8 MB JSON parser)
app.use(express.json({ limit: '8mb' }));
app.use(createCadRouter()); // text-to-cad parametric parts -> scene library / product library

// The page's agent runs its tool loop in the browser (so every tool call lands in the 3D view)
// and reaches the OpenAI-compatible model through here; key and CORS stay on the server.
const llmBase = () => String(process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:7897/v1').replace(/\/$/, '');
app.all('/api/llm/*path', async (req, res) => {
  const url = `${llmBase()}/${[].concat(req.params.path).join('/')}`;
  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.MAGPIE_API_KEY || process.env.LLM_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
      signal: abort.signal,
    });
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: `模型服务不可用：${error.message}` });
    else res.end();
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: hasOnlineKey() ? 'online' : 'offline', provider: String(process.env.MAGPIE_ENABLED || '').toLowerCase() === 'true' ? 'magpie-doubao' : 'default', tools: TOOL_NAMES.length, projects: projects.size, jobs: jobs.size }));
app.get('/api/fixtures', (req, res) => {
  const productId = String(req.query.productId || '').trim();
  const fixtures = productId ? FIXTURES.filter((fixture) => fixture.compatibleProducts.includes(productId)) : FIXTURES;
  res.json({ fixtures: clone(fixtures) });
});

app.get('/api/plan', async (req, res) => res.json(await loadPlan(req.query.projectId)));
app.patch('/api/plan', async (req, res) => {
  const projectId = req.body?.projectId || req.query.projectId;
  const plan = await loadPlan(projectId);
  const result = await runTool(plan, req.body?.tool || req.body?.op, req.body?.args || {}, projectId);
  res.status(result.ok === false ? 400 : 200).json(result);
});

app.get('/api/projects/:projectId/plan', async (req, res) => {
  const key = projectIdOf(req.params.projectId);
  res.json(planPayload(key, await projectPlan(key)));
});
app.patch('/api/projects/:projectId/plan', async (req, res) => patchProjectPlan(req.params.projectId, req, res));
app.get('/api/projects/:projectId/plan/versions', async (req, res) => {
  const key = projectIdOf(req.params.projectId);
  await projectPlan(key);
  res.json({ projectId: key, versions: listPlanVersions(key) });
});

app.post('/api/projects/:projectId/files', (req, res) => {
  const result = makeFile(req.params.projectId, req.body);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  return res.status(201).json({ ok: true, ...result });
});
app.get('/api/projects/:projectId/files', (req, res) => {
  const key = projectIdOf(req.params.projectId);
  res.json({ projectId: key, files: clone(filesFor(key)) });
});

app.post('/api/jobs', (req, res) => {
  const result = createJob(req.body?.projectId, req.body);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  return res.status(202).json({ ok: true, ...result });
});
app.post('/api/projects/:projectId/jobs', (req, res) => {
  const result = createJob(req.params.projectId, req.body);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  return res.status(202).json({ ok: true, ...result });
});
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: '任务不存在。' });
  return res.json({ ok: true, job: clone(job) });
});

async function streamJob(req, res) {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: '任务不存在。' });
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const emit = () => sse(res, 'job.progress', clone(job));
  emit();
  if (job.status === 'completed') return res.end();
  const timer = setInterval(() => {
    emit();
    if (job.status === 'completed' || job.status === 'failed') {
      clearInterval(timer);
      res.end();
    }
  }, 25);
  req.on('close', () => clearInterval(timer));
  return undefined;
}
app.get('/api/jobs/:jobId/events', streamJob);
app.get('/api/jobs/:jobId/stream', streamJob);

app.post('/api/chat', (req, res) => handleChat(req, res, req.body?.projectId));
app.post('/api/projects/:projectId/chat', (req, res) => handleChat(req, res, req.params.projectId));

// Frontend lives in prototype/ (vite 5182) and proxies /api here.

export function startServer(listenPort = port) {
  return app.listen(listenPort, () => console.log(`Weihua workbench server listening on http://127.0.0.1:${listenPort}`));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();

