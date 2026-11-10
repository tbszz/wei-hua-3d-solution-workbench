import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROJECT_NAME, Workspace, normalize } from './projects.js';

test('a fresh workspace has one project with the scene products and the three build modules', () => {
  const ws = new Workspace(null);
  assert.equal(ws.projects.length, 1);
  assert.equal(ws.active.name, DEFAULT_PROJECT_NAME);
  assert.deepEqual(ws.active.products.map((p) => p.productId), ['agv1', 'double-girder-crane-demo']);
  assert.deepEqual(ws.active.scenes.map((s) => [s.name, s.kind]), [['场景搭建', 'site'], ['鞍座搭建', 'saddle'], ['产品搭建', 'product']]);
  assert.equal(ws.activeScene.name, '场景搭建');
  assert.equal(ws.activeScene.drawing, null);
  assert.deepEqual(ws.archives, []);
  assert.equal(ws.data.v, 2);
});

test('addModule appends a custom module with a unique name', () => {
  const ws = new Workspace(null);
  const p = ws.active;
  const a = ws.addModule(p.id, '吊具搭建', { productId: 'agv1' });
  const b = ws.addModule(p.id, '吊具搭建');
  const c = ws.addModule(p.id, '  ');
  assert.equal(a.kind, 'custom');
  assert.equal(a.productId, 'agv1');
  assert.equal(b.name, '吊具搭建 2');
  assert.equal(c.name, '新模块');
  assert.equal(p.scenes.length, 6);
  assert.equal(ws.activeScene.name, '场景搭建');
});

test('saving an archive deep-copies the project into the case library, newest first', () => {
  const ws = new Workspace(null);
  const p = ws.active;
  ws.activeScene.placed.push({ assetId: 'm1', x: 1, y: 2 });
  const first = ws.archiveProject(p.id, 1000);
  ws.renameProject(p.id, '改过的名字');
  ws.activeScene.placed.push({ assetId: 'm2', x: 3, y: 4 });
  ws.addModule(p.id, '新增');
  const second = ws.archiveProject(undefined, 2000);
  assert.deepEqual(ws.archives.map((a) => a.id), [second.id, first.id]);
  assert.equal(first.archivedAt, 1000);
  assert.equal(first.name, DEFAULT_PROJECT_NAME);
  assert.equal(first.project.scenes.length, 3);
  assert.equal(first.project.scenes[0].placed.length, 1);
  assert.notEqual(first.project, p);
  assert.equal(second.name, '改过的名字');
  assert.equal(second.project.scenes.length, 4);
  ws.renameArchive(first.id, '一期方案');
  assert.equal(ws.archive(first.id).name, '一期方案');
  ws.removeArchive(second.id);
  assert.deepEqual(ws.archives.map((a) => a.id), [first.id]);
  assert.throws(() => ws.archive(second.id), /不存在/);
});

test('restoring an archive makes a fresh active copy and leaves the archive untouched', () => {
  const ws = new Workspace(null);
  const p = ws.active;
  const saddle = p.scenes[1];
  ws.setActive(p.id, saddle.id);
  saddle.placed.push({ assetId: 'm1', x: 1, y: 2 });
  ws.addAsset(p.id, 'f1');
  const rec = ws.archiveProject(p.id, 5);
  const restored = ws.restoreArchive(rec.id);
  assert.equal(ws.active.id, restored.id);
  assert.notEqual(restored.id, p.id);
  assert.equal(restored.name, `${DEFAULT_PROJECT_NAME} 2`);
  assert.deepEqual(restored.scenes.map((s) => s.kind), ['site', 'saddle', 'product']);
  assert.ok(restored.scenes.every((s, i) => s.id !== p.scenes[i].id));
  assert.equal(ws.activeScene.name, '鞍座搭建');
  assert.deepEqual(ws.activeScene.placed, [{ assetId: 'm1', x: 1, y: 2 }]);
  assert.deepEqual(restored.assets, ['f1']);
  assert.deepEqual(restored.products.map((e) => e.productId), p.products.map((e) => e.productId));
  ws.activeScene.placed.push({ assetId: 'm9', x: 0, y: 0 });
  assert.equal(ws.archive(rec.id).project.scenes[1].placed.length, 1);
  assert.equal(ws.projects.length, 2);
});

test('normalize migrates old workspaces: 主场景 becomes 场景搭建 and the missing modules are added', () => {
  const old = {
    v: 1,
    activeProject: 'p1',
    projects: [
      { id: 'p1', name: '老项目', products: [], assets: [], activeScene: 's2', scenes: [{ id: 's1', name: '主场景', drawing: 'd1', placed: [] }, { id: 's2', name: '方案 B', placed: [{ assetId: 'm', x: 0, y: 0 }] }] },
      { id: 'p2', name: '没有主场景', scenes: [{ id: 's3', name: '一号' }] },
    ],
  };
  const ws = new Workspace(old);
  const [a, b] = ws.projects;
  assert.deepEqual(a.scenes.map((s) => [s.id.length > 0, s.name, s.kind]), [[true, '场景搭建', 'site'], [true, '方案 B', 'custom'], [true, '鞍座搭建', 'saddle'], [true, '产品搭建', 'product']]);
  assert.equal(a.scenes[0].id, 's1');
  assert.equal(a.scenes[0].drawing, 'd1');
  assert.equal(a.activeScene, 's2');
  assert.deepEqual(b.scenes.map((s) => [s.name, s.kind]), [['一号', 'site'], ['鞍座搭建', 'saddle'], ['产品搭建', 'product']]);
  assert.deepEqual(ws.archives, []);
  assert.equal(ws.data.v, 2);
  // Saved again as v2, a module the user deleted is not brought back.
  ws.removeScene(b.id, b.scenes[2].id);
  const again = normalize(JSON.parse(JSON.stringify(ws.data)));
  assert.equal(again.projects[1].scenes.length, 2);
  assert.equal(again.projects[0].scenes[1].kind, 'custom');
});

test('normalize keeps valid archives and drops broken ones', () => {
  const ws = new Workspace(null);
  ws.archiveProject(ws.active.id, 42);
  const data = JSON.parse(JSON.stringify(ws.data));
  data.archives.push(null, { id: 'x' }, { id: 'y', project: { name: '旧案例', scenes: [{ name: '主场景' }] }, archivedAt: 'nope' });
  const n = normalize(data);
  assert.equal(n.archives.length, 2);
  assert.equal(n.archives[0].archivedAt, 42);
  assert.equal(n.archives[1].name, '旧案例');
  assert.equal(n.archives[1].archivedAt, 0);
  assert.equal(n.archives[1].project.scenes.length, 1); // v2 data: no migration inside
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
  const p = ws.active;
  ws.removeScene(p.id, p.scenes[2].id);
  ws.removeScene(p.id, p.scenes[1].id);
  assert.throws(() => ws.removeScene(p.id, ws.activeScene.id), /至少/);
});

test('removing the active scene or project falls back to a neighbour', () => {
  const ws = new Workspace(null);
  const first = ws.active;
  const s2 = ws.addScene(first.id, '方案 B', ws.activeScene);
  ws.setActive(first.id, s2.id);
  ws.removeScene(first.id, s2.id);
  assert.equal(ws.activeScene.id, first.scenes[2].id);
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
  assert.equal(ws.projects[0].scenes.length, 3);
  assert.deepEqual(ws.projects[0].products, []);
  assert.deepEqual(ws.projects[0].assets, ['x']);
  assert.equal(ws.activeProject, ws.projects[0].id);
});
