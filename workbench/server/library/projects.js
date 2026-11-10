// Project persistence for the browser engine: versioned opaque state snapshots and chat history.
import fs from 'node:fs/promises';
import path from 'node:path';
import { LibraryError, projectsDir, readJson, serialize, writeJsonAtomic } from './store.js';

export const KEEP_VERSIONS = 50;
export const KEEP_MESSAGES = 200;
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

function projectDir(projectId) {
  const id = String(projectId ?? '').trim();
  if (!id || id.length > 80 || /^\.+$/.test(id)) throw new LibraryError(400, '项目 id 不能为空，最长 80 个字符');
  const safe = encodeURIComponent(id).replace(/%/g, '_').replace(/\*/g, '_');
  return path.join(projectsDir(), safe);
}

const versionFile = (dir, version) => path.join(dir, 'versions', `v${String(version).padStart(6, '0')}.json`);

export async function getProjectState(projectId) {
  const dir = projectDir(projectId);
  const current = await readJson(path.join(dir, 'state.json'), null);
  return current ?? { version: 0, state: null, updatedAt: null };
}

export async function saveProjectState(projectId, state) {
  if (state === undefined) throw new LibraryError(400, '缺少 state 字段');
  const dir = projectDir(projectId);
  return serialize(`project:${dir}`, async () => {
    const current = await readJson(path.join(dir, 'state.json'), { version: 0 });
    const record = { version: (Number(current.version) || 0) + 1, state, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(versionFile(dir, record.version), record);
    await writeJsonAtomic(path.join(dir, 'state.json'), record);
    const names = (await fs.readdir(path.join(dir, 'versions')).catch(() => [])).filter((name) => /^v\d+\.json$/.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_VERSIONS))) await fs.unlink(path.join(dir, 'versions', name)).catch(() => {});
    return record;
  });
}

export async function listProjectStateVersions(projectId) {
  const dir = path.join(projectDir(projectId), 'versions');
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => /^v\d+\.json$/.test(name)).sort().reverse();
  const versions = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const [record, info] = await Promise.all([readJson(file, null), fs.stat(file).catch(() => null)]);
    if (record) versions.push({ version: record.version, updatedAt: record.updatedAt, size: info?.size ?? null });
  }
  return versions;
}

export async function getProjectStateVersion(projectId, version) {
  const number = Number(version);
  if (!Number.isInteger(number) || number < 1) throw new LibraryError(400, '版本号必须是正整数');
  const record = await readJson(versionFile(projectDir(projectId), number), null);
  if (!record) throw new LibraryError(404, `版本 ${number} 不存在（只保留最近 ${KEEP_VERSIONS} 个）`);
  return record;
}

export async function getChatHistory(projectId) {
  const file = await readJson(path.join(projectDir(projectId), 'chat-history.json'), { messages: [] });
  return Array.isArray(file.messages) ? file.messages : [];
}

function cleanMessage(message) {
  if (!message || typeof message !== 'object') throw new LibraryError(400, '消息必须是对象：{ role, text, tools? }');
  const role = String(message.role ?? '');
  if (!ROLES.has(role)) throw new LibraryError(400, `消息角色不认识：${role}（可用 user、assistant、system、tool）`);
  if (typeof message.text !== 'string') throw new LibraryError(400, '消息 text 必须是文字');
  if (message.text.length > 50000) throw new LibraryError(400, '单条消息超过 50000 字');
  const clean = { role, text: message.text, at: typeof message.at === 'string' ? message.at : new Date().toISOString() };
  if (message.tools !== undefined) {
    if (JSON.stringify(message.tools).length > 200000) throw new LibraryError(400, '消息里的 tools 数据太大');
    clean.tools = message.tools;
  }
  return clean;
}

// Accepts one message or { messages: [...] }.
export async function appendChatHistory(projectId, body) {
  const incoming = Array.isArray(body?.messages) ? body.messages : [body];
  const messages = incoming.map(cleanMessage);
  const dir = projectDir(projectId);
  return serialize(`chat:${dir}`, async () => {
    const all = [...await getChatHistory(projectId), ...messages].slice(-KEEP_MESSAGES);
    await writeJsonAtomic(path.join(dir, 'chat-history.json'), { messages: all });
    return all;
  });
}
