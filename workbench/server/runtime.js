import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyPlan, clone, executeTool, TOOL_NAMES } from './domain/plan.js';
import { parseOfflineIntent } from './domain/intents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, 'scene-plan.json');
const memoryPlans = new Map();
const versions = new Map();
const MAGPIE_DEFAULT_BASE_URL = 'http://127.0.0.1:7897/v1';
const MAGPIE_DEFAULT_MODEL = 'trae-cn/seed-code-pro-0430';

const magpieEnabled = () => String(process.env.MAGPIE_ENABLED || '').toLowerCase() === 'true';
const magpieBaseUrl = () => String(process.env.MAGPIE_BASE_URL || MAGPIE_DEFAULT_BASE_URL).replace(/\/$/, '');
const magpieModel = () => process.env.MAGPIE_MODEL || MAGPIE_DEFAULT_MODEL;

function projectKey(projectId = 'default') {
  const value = String(projectId || 'default').trim();
  return value || 'default';
}

function statePath(projectId) {
  const key = projectKey(projectId);
  if (key === 'default') return stateFile;
  const safe = encodeURIComponent(key).replace(/%/g, '_');
  return path.join(here, `scene-plan-${safe.slice(0, 80)}.json`);
}

function recordVersion(projectId, plan) {
  const key = projectKey(projectId);
  const list = versions.get(key) ?? [];
  const last = list.at(-1);
  if (last?.version === plan.version) return;
  list.push({ version: plan.version, action: plan.lastAction ?? null, timestamp: new Date().toISOString(), plan: clone(plan) });
  versions.set(key, list.slice(-50));
}

export async function loadPlan(projectId = 'default') {
  const key = projectKey(projectId);
  if (memoryPlans.has(key)) return clone(memoryPlans.get(key));
  try {
    const plan = JSON.parse(await fs.readFile(statePath(key), 'utf8'));
    memoryPlans.set(key, plan);
    recordVersion(key, plan);
    return clone(plan);
  } catch {
    const plan = emptyPlan();
    await savePlan(plan, key);
    return clone(plan);
  }
}
export async function savePlan(plan, projectId = 'default') {
  const key = projectKey(projectId);
  const snapshot = clone(plan);
  memoryPlans.set(key, snapshot);
  recordVersion(key, snapshot);
  try {
    await fs.mkdir(here, { recursive: true });
    await fs.writeFile(statePath(key), JSON.stringify(snapshot, null, 2), 'utf8');
  } catch { /* sandbox/offline mode keeps deterministic in-memory state */ }
  return clone(snapshot);
}

export function listPlanVersions(projectId = 'default') {
  return clone(versions.get(projectKey(projectId)) ?? []);
}

export function resetRuntime() {
  memoryPlans.clear();
  versions.clear();
}
export function sse(res, event, payload) { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }

const TOOL_SCHEMAS = {
  search_products: { properties: { query: { type: 'string' } } },
  get_product: { properties: { productId: { type: 'string' } }, required: ['productId'] },
  set_product: { properties: { productId: { type: 'string' } }, required: ['productId'] },
  set_params: { properties: { length: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, additionalProperties: true },
  attach_fixture: { properties: { fixture: { type: 'string' } }, required: ['fixture'] },
  import_site: { properties: { source: { type: 'string' }, dxfText: { type: 'string' } } },
  set_station: { properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, type: { type: 'string' }, name: { type: 'string' } }, required: ['x', 'y'] },
  set_process: { properties: { steps: { type: 'array' }, confirmed: { type: 'boolean' } }, required: ['steps'] },
  play_animation: { properties: { mode: { type: 'string' }, stepIndex: { type: 'number' } } },
  set_takt: { properties: { seconds: { type: 'number' } }, required: ['seconds'] },
  simulate_shift: { properties: { hours: { type: 'number' } }, required: ['hours'] },
  show_travel: { properties: {} },
  check_clearance: { properties: {} },
  set_camera: { properties: { preset: { type: 'string' } }, required: ['preset'] },
  add_crane: { properties: { span: { type: 'number' }, liftHeight: { type: 'number' }, fixture: { type: 'string' } } },
};

const MAGPIE_TOOLS = TOOL_NAMES.map((name) => ({
  type: 'function',
  function: {
    name,
    description: `卫华方案工具 ${name}，所有修改必须经过服务端 ScenePlan 校验。`,
    parameters: { type: 'object', additionalProperties: true, ...(TOOL_SCHEMAS[name] || { properties: {} }) },
  },
}));

async function runMagpie(plan, text, emit, projectId = 'default') {
  const messages = [
    { role: 'system', content: `你是卫华 3D 方案工作台的方案 Agent。使用工具修改方案，所有参数必须来自产品库、CAD 或用户原话。用简体中文简短回答。当前 ScenePlan：${JSON.stringify(clone(plan))}` },
    { role: 'user', content: text },
  ];
  let currentPlan = clone(plan);
  for (let round = 0; round < 6; round += 1) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.MAGPIE_API_KEY) headers.Authorization = `Bearer ${process.env.MAGPIE_API_KEY}`;
    const response = await fetch(`${magpieBaseUrl()}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: magpieModel(), messages, tools: MAGPIE_TOOLS, tool_choice: 'auto', stream: false, temperature: 0.2 }),
      signal: AbortSignal.timeout(90000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Magpie HTTP ${response.status}: ${raw.slice(0, 240)}`);
    const payload = JSON.parse(raw);
    if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    const message = payload.choices?.[0]?.message ?? {};
    messages.push(message);
    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      const content = message.content || '豆包已处理当前方案。';
      emit?.('token', { text: content });
      return { ok: true, plan: clone(currentPlan), message: content, mode: 'magpie' };
    }
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
      const result = await runTool(currentPlan, name, args, projectId);
      if (result.ok && result.plan) {
        currentPlan = result.plan;
        emit?.('scene_plan.updated', currentPlan);
        if (result.card) emit?.('result.card', result.card);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { ok: true, plan: clone(currentPlan), message: '豆包已完成工具处理。', mode: 'magpie' };
}

export async function runOffline(plan, text, projectId = 'default') {
  const result = await parseOfflineIntent(plan, text);
  if (result.plan) await savePlan(result.plan, projectId);
  return result;
}

export async function runTool(plan, name, args, projectId = 'default') {
  if (!TOOL_NAMES.includes(name)) return { ok: false, error: `工具 ${name} 未登记，已拒绝。` };
  const result = await executeTool(plan, name, args);
  const resolved = await result;
  if (resolved.plan) await savePlan(resolved.plan, projectId);
  return resolved;
}

export async function runOnline(plan, text, emit, projectId = 'default') {
  if (magpieEnabled()) {
    try { return await runMagpie(plan, text, emit, projectId); }
    catch (error) { return { ...(await runOffline(plan, text, projectId)), message: `Magpie 豆包不可用，已切换离线模式：${error.message}`, mode: 'offline' }; }
  }
  const key = process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY || process.env.BIGMODEL_API_KEY;
  if (!key) return runOffline(plan, text, projectId);
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const definitions = TOOL_NAMES.map((name) => sdk.tool(name, `卫华方案工具 ${name}。只能使用当前 ScenePlan。`, { type: 'object', properties: {}, additionalProperties: true }, async (args) => {
      const result = await runTool(plan, name, args, projectId);
      if (!result.ok) return { isError: true, content: [{ type: 'text', text: result.error }] };
      emit?.('scene_plan.updated', result.plan);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }));
    const baseUrl = process.env.MINIMAX_API_KEY ? 'https://api.minimaxi.com/anthropic' : process.env.BIGMODEL_API_KEY ? 'https://open.bigmodel.cn/api/anthropic' : undefined;
    const options = {
      model: process.env.ANTHROPIC_MODEL || process.env.MINIMAX_MODEL || process.env.BIGMODEL_MODEL || 'claude-sonnet-4-5',
      permissionMode: 'dontAsk',
      disallowedTools: ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'NotebookEdit', 'Agent', 'Task'],
      allowedTools: [...TOOL_NAMES],
      mcpServers: { weihua: sdk.createSdkMcpServer({ name: 'weihua', version: '1.0.0', tools: definitions }) },
      ...(baseUrl ? { env: { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: baseUrl } } : {}),
      hooks: { PreToolUse: [{ hooks: [async (input) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: TOOL_NAMES.includes(input.tool_name) ? 'allow' : 'deny', permissionDecisionReason: '仅允许卫华方案登记工具。' } })] }] },
      maxTurns: 6,
    };
    const stream = sdk.query({ prompt: `当前 ScenePlan：${JSON.stringify(clone(plan))}\n用户请求：${text}`, options });
    let final = '';
    for await (const event of stream) {
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.text) { final += event.event.delta.text; emit?.('token', { text: event.event.delta.text }); }
      if (event.type === 'result' && typeof event.result === 'string') final = event.result;
    }
    return { ok: true, plan: clone(plan), message: final || '在线 Agent 已处理。', mode: 'online' };
  } catch (error) {
    return { ...(await runOffline(plan, text, projectId)), message: `在线模型不可用，已切换离线模式：${error.message}`, mode: 'offline' };
  }
}
