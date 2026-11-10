import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.js';

let server;
let base;
const projectId = `api-test-${Date.now()}`;

before(async () => {
  server = startServer(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await unlink(path.join(path.dirname(fileURLToPath(import.meta.url)), `scene-plan-${projectId}.json`)).catch(() => {});
});

async function request(path, options) {
  const response = await fetch(base + path, options);
  const body = await response.json();
  return { response, body };
}

test('exposes product, fixture, and project plan APIs', async () => {
  const products = await request('/api/products');
  assert.equal(products.response.status, 200);
  assert.ok(products.body.products.some((product) => product.id === 'agv1'));

  const fixtures = await request('/api/fixtures');
  assert.equal(fixtures.response.status, 200);
  assert.ok(fixtures.body.fixtures.some((fixture) => fixture.id === 'agv-coil-rack'));

  const plan = await request(`/api/projects/${projectId}/plan`);
  assert.equal(plan.response.status, 200);
  assert.equal(plan.body.projectId, projectId);
  assert.equal(plan.body.plan.version, 0);
  assert.equal(plan.body.product.id, 'agv1');
});

test('project plan patch validates tools and records bounded versions', async () => {
  const changed = await request(`/api/projects/${projectId}/plan`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'set_product', args: { productId: 'z1-1000-bz' } }),
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.plan.product.id, 'z1-1000-bz');
  assert.equal(changed.body.projectId, projectId);

  const rejected = await request(`/api/projects/${projectId}/plan`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'replace_plan', args: { product: { id: 'agv1' } } }),
  });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.error, /未登记/);

  const versions = await request(`/api/projects/${projectId}/plan/versions`);
  assert.equal(versions.response.status, 200);
  assert.ok(versions.body.versions.length >= 2);
  assert.equal(versions.body.versions.at(-1).plan.product.id, 'z1-1000-bz');
});

test('stores file metadata and advances deterministic jobs', async () => {
  const uploaded = await request(`/api/projects/${projectId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '现场.dxf', kind: 'cad', mimeType: 'application/dxf', content: '0\\nSECTION' }),
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.file.name, '现场.dxf');
  assert.equal(uploaded.body.file.contentStored, false);

  const files = await request(`/api/projects/${projectId}/files`);
  assert.equal(files.body.files.length, 1);

  const created = await request('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, type: 'render_image' }),
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.job.status, 'queued');

  let latest = created.body.job;
  for (let attempt = 0; attempt < 8 && latest.status !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = await request(`/api/jobs/${latest.id}`);
    latest = current.body.job;
  }
  assert.equal(latest.status, 'completed');
  assert.equal(latest.progress, 100);
  assert.equal(latest.asset.generation.tool, 'threejs');
});

