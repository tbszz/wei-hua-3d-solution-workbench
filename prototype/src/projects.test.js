import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROJECT_NAME, Workspace, normalize } from './projects.js';

test('a fresh workspace has one project with the scene products and one scene', () => {
  const ws = new Workspace(null);
  assert.equal(ws.projects.length, 1);
  assert.equal(ws.active.name, DEFAULT_PROJECT_NAME);
  assert.deepEqual(ws.active.products.map((p) => p.productId), ['agv1', 'double-girder-crane-demo']);
  assert.equal(ws.active.scenes.length, 1);
  assert.equal(ws.activeScene.drawing, null);
});

test('adding a standard product twice keeps one entry', () => {
  const ws = new Workspace(null);
  const p = ws.createProject('热轧车间');
  assert.equal(ws.addProduct(p.id, 'agv1').added, true);
  assert.equal(ws.addProduct(p.id, 'agv1').added, false);
  assert.equal(p.products.length, 1);
});

test('names stay unique and the last project or scene cannot be deleted', () => {
  const ws = new Workspace(null);
  const a = ws.createProject('新项目');
  const b = ws.createProject('新项目');
  assert.equal(b.name, '新项目 2');
  ws.removeProject(a.id);
  ws.removeProject(b.id);
  assert.throws(() => ws.removeProject(ws.active.id), /至少/);
  assert.throws(() => ws.removeScene(ws.active.id, ws.activeScene.id), /至少/);
});

test('removing the active scene or project falls back to a neighbour', () => {
  const ws = new Workspace(null);
  const first = ws.active;
  const s2 = ws.addScene(first.id, '方案 B', ws.activeScene);
  ws.setActive(first.id, s2.id);
  ws.removeScene(first.id, s2.id);
  assert.equal(ws.activeScene.id, first.scenes[0].id);
  const other = ws.createProject('二期');
  ws.setActive(other.id);
  ws.removeProject(other.id);
  assert.equal(ws.active.id, first.id);
});

test('orphan uploads and customised products are adopted by the active project once', () => {
  const ws = new Workspace(null);
  const other = ws.createProject('二期');
  ws.addAsset(other.id, 'a1');
  const changed = ws.adopt({ products: [{ id: 'agv1' }, { id: 'agv-custom', baseProduct: 'agv1' }], assets: [{ id: 'a1' }, { id: 'a2' }] });
  assert.equal(changed, true);
  assert.deepEqual(ws.active.assets, ['a2']);
  assert.ok(ws.active.products.some((p) => p.productId === 'agv-custom'));
  assert.equal(ws.adopt({ products: [{ id: 'agv-custom', baseProduct: 'agv1' }], assets: [{ id: 'a2' }] }), false);
});

test('normalize repairs broken stored data', () => {
  const ws = normalize({ projects: [{ name: '', scenes: [], products: [{}], assets: ['x', 'x', 3] }], activeProject: 'nope' });
  assert.equal(ws.projects[0].name, '未命名项目');
  assert.equal(ws.projects[0].scenes.length, 1);
  assert.deepEqual(ws.projects[0].products, []);
  assert.deepEqual(ws.projects[0].assets, ['x']);
  assert.equal(ws.activeProject, ws.projects[0].id);
});
