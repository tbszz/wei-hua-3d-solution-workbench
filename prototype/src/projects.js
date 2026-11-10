// Project workspace kept beside the standard product library.
// 产品库 (standard products) is shared and read-only here: products with standard parameters.
// AI3D工厂 is the active project: its build modules (each one a scene: 场景搭建 / 鞍座搭建 /
// 产品搭建 / modules the user adds), its own product list (copies of standard products and the
// products customised for it) and the drawings/models uploaded to it.
// 项目案例库 holds archived snapshots of projects (data.archives); restoring one makes a fresh copy.
// Pure data: no DOM, no three.js, so it can be tested with node --test.

export const DEFAULT_PROJECT_NAME = '冷轧车间 AGV + 行车方案';
// Build modules every new project starts with. Each module is a scene record with a `kind`.
export const MODULES = [
  { kind: 'site', name: '场景搭建' },
  { kind: 'saddle', name: '鞍座搭建' },
  { kind: 'product', name: '产品搭建' },
];
export const MODULE_KINDS = [...MODULES.map((m) => m.kind), 'custom'];
export const DEFAULT_SCENE_NAME = MODULES[0].name;
const LEGACY_SCENE_NAME = '主场景'; // the single scene of workspaces saved before modules existed
// Names older versions gave a scene automatically. A v2 workspace can hold one of these as an extra
// custom scene next to an empty 场景搭建 (the plant the user was really working in); v3 folds it
// into 场景搭建 so a project shows exactly 场景搭建 / 鞍座搭建 / 产品搭建 plus scenes the user named.
const AUTO_SCENE_NAMES = ['场景', '新场景', '主场景', '新模块'];
const VERSION = 3;
// `drawing` of a scene the user started blank: an empty floor, no sample plant and no drawing.
export const BLANK_DRAWING = 'blank';

let seq = 0;
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const clean = (s, fallback) => String(s ?? '').trim().slice(0, 60) || fallback;
const copy = (x) => JSON.parse(JSON.stringify(x));
const kindOf = (k) => (MODULE_KINDS.includes(k) ? k : 'custom');

export function newScene(name = DEFAULT_SCENE_NAME, from = null, kind = null) {
  return {
    id: uid('s'),
    name: clean(name, DEFAULT_SCENE_NAME),
    kind: kindOf(kind ?? from?.kind), // which build module this scene is: site | saddle | product | custom
    drawing: from?.drawing ?? null, // scene-library asset id of the base drawing; null = the sample plant; BLANK_DRAWING = empty floor
    label: from?.label ?? null, // the line under the scene name (e.g. which plant it is); null = derived from the drawing
    overlay: from?.overlay ?? null, // asset id of a drawing laid over the floor for reference
    placed: (from?.placed ?? []).map((p) => ({ ...p })),
    productId: from?.productId ?? null,
  };
}

export const defaultModules = () => MODULES.map((m) => newScene(m.name, null, m.kind));

export function newProject(name, products = []) {
  const scenes = defaultModules();
  return {
    id: uid('p'),
    name: clean(name, '新项目'),
    products: products.map((productId) => ({ key: uid('pp'), productId, name: null })),
    scenes,
    assets: [],
    activeScene: scenes[0].id,
  };
}

export function defaultWorkspace() {
  const project = newProject(DEFAULT_PROJECT_NAME, ['agv1', 'double-girder-crane-demo']);
  project.scenes[0].productId = 'agv1';
  return { v: VERSION, activeProject: project.id, projects: [project], archives: [], open: {} };
}

// Workspaces saved before build modules existed had free scenes: the 主场景 becomes 场景搭建 and the
// missing default modules are added after the existing scenes, so nothing the user made is lost.
function migrateScenes(scenes) {
  if (!scenes.some((s) => s.kind === 'site')) {
    const main = scenes.find((s) => s.name === LEGACY_SCENE_NAME) ?? scenes[0];
    if (main) {
      main.kind = 'site';
      if (main.name === LEGACY_SCENE_NAME) main.name = MODULES[0].name;
    }
  }
  for (const m of MODULES) if (!scenes.some((s) => s.kind === m.kind)) scenes.push(newScene(m.name, null, m.kind));
  return scenes;
}

const isEmptyScene = (s) => !s.drawing && !s.overlay && !s.placed.length;

// v2 -> v3: an auto-named custom scene is folded into an empty 场景搭建 (its drawing, models and
// product move over, the scene id is kept as an alias for activeScene). Returns the id map.
function foldAutoScene(scenes) {
  const site = scenes.find((s) => s.kind === 'site');
  const extra = scenes.find((s) => s.kind === 'custom' && AUTO_SCENE_NAMES.includes(s.name));
  if (!site || !extra || !isEmptyScene(site)) return null;
  Object.assign(site, { drawing: extra.drawing, overlay: extra.overlay, placed: extra.placed, productId: extra.productId ?? site.productId });
  scenes.splice(scenes.indexOf(extra), 1);
  return { from: extra.id, to: site.id };
}

// `from` is the stored version (0 when unknown).
function normalizeProject(p, from = VERSION) {
  let scenes = (Array.isArray(p.scenes) ? p.scenes : []).filter((s) => s && typeof s === 'object').map((s) => ({ ...newScene(s.name, s), id: s.id || uid('s') }));
  if (from < 2) scenes = migrateScenes(scenes);
  let active = p.activeScene;
  if (from < 3) {
    const moved = foldAutoScene(scenes);
    if (moved && active === moved.from) active = moved.to;
  }
  if (!scenes.length) scenes = defaultModules();
  return {
    id: p.id || uid('p'),
    name: clean(p.name, '未命名项目'),
    products: (Array.isArray(p.products) ? p.products : []).filter((x) => x?.productId).map((x) => ({ key: x.key || uid('pp'), productId: x.productId, name: x.name ?? null })),
    scenes,
    assets: [...new Set((Array.isArray(p.assets) ? p.assets : []).filter((x) => typeof x === 'string'))],
    activeScene: scenes.some((s) => s.id === active) ? active : scenes[0].id,
  };
}

function normalizeArchive(a, from) {
  if (!a || typeof a !== 'object' || !a.project || typeof a.project !== 'object') return null;
  const project = normalizeProject(a.project, from);
  const at = Number(a.archivedAt);
  // projectId: the project the case was archived from (its 项目编号); older records use the copy's id.
  return { id: a.id || uid('a'), projectId: String(a.projectId || project.id), name: clean(a.name, project.name), archivedAt: Number.isFinite(at) ? at : 0, project };
}

// Repair whatever came back from storage so the UI never meets a half-formed record.
export function normalize(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.projects) || !data.projects.length) return defaultWorkspace();
  const from = Number(data.v) || 0;
  const projects = data.projects.filter((p) => p && typeof p === 'object').map((p) => normalizeProject(p, from));
  if (!projects.length) return defaultWorkspace();
  return {
    v: VERSION,
    activeProject: projects.some((p) => p.id === data.activeProject) ? data.activeProject : projects[0].id,
    projects,
    archives: (Array.isArray(data.archives) ? data.archives : []).map((a) => normalizeArchive(a, from)).filter(Boolean),
    open: data.open && typeof data.open === 'object' ? { ...data.open } : {},
  };
}

export class Workspace {
  constructor(data) {
    this.data = normalize(data);
  }

  get projects() {
    return this.data.projects;
  }

  get archives() {
    return this.data.archives;
  }

  get active() {
    return this.project(this.data.activeProject);
  }

  get activeScene() {
    const p = this.active;
    return p.scenes.find((s) => s.id === p.activeScene) ?? p.scenes[0];
  }

  project(id) {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new Error('项目不存在');
    return p;
  }

  scene(projectId, sceneId) {
    const s = this.project(projectId).scenes.find((x) => x.id === sceneId);
    if (!s) throw new Error('场景不存在');
    return s;
  }

  isOpen(key, fallback = true) {
    return this.data.open[key] ?? fallback;
  }

  setOpen(key, on) {
    this.data.open[key] = Boolean(on);
  }

  uniqueName(base, taken) {
    if (!taken.includes(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
  }

  createProject(name = '新项目', products = []) {
    const p = newProject(this.uniqueName(clean(name, '新项目'), this.projects.map((x) => x.name)), products);
    this.projects.push(p);
    return p;
  }

  renameProject(id, name) {
    const p = this.project(id);
    p.name = clean(name, p.name);
    return p;
  }

  removeProject(id) {
    if (this.projects.length <= 1) throw new Error('至少要保留一个项目');
    const i = this.projects.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('项目不存在');
    const [gone] = this.projects.splice(i, 1);
    if (this.data.activeProject === id) this.data.activeProject = this.projects[Math.max(0, i - 1)].id;
    return gone;
  }

  setActive(projectId, sceneId) {
    const p = this.project(projectId);
    this.data.activeProject = p.id;
    if (sceneId) p.activeScene = this.scene(p.id, sceneId).id;
    return p;
  }

  // Adding a product the project already has returns the existing entry instead of a duplicate.
  addProduct(projectId, productId) {
    const p = this.project(projectId);
    const have = p.products.find((x) => x.productId === productId);
    if (have) return { entry: have, added: false };
    const entry = { key: uid('pp'), productId, name: null };
    p.products.push(entry);
    return { entry, added: true };
  }

  removeProduct(projectId, key) {
    const p = this.project(projectId);
    const i = p.products.findIndex((x) => x.key === key);
    if (i < 0) return null;
    return p.products.splice(i, 1)[0];
  }

  renameProduct(projectId, key, name) {
    const entry = this.project(projectId).products.find((x) => x.key === key);
    if (!entry) throw new Error('项目里没有这个产品');
    entry.name = String(name ?? '').trim().slice(0, 60) || null;
    return entry;
  }

  addScene(projectId, name, from = null, kind = 'custom') {
    const p = this.project(projectId);
    const s = newScene(this.uniqueName(clean(name, '新场景'), p.scenes.map((x) => x.name)), from, kind);
    p.scenes.push(s);
    return s;
  }

  // A scene the user adds with ＋ next to 场景搭建 / 鞍座搭建 / 产品搭建. `from` seeds the scene
  // (e.g. { productId }); without a drawing in `from` it starts from the sample plant.
  addModule(projectId, name, from = null) {
    return this.addScene(projectId, clean(name, '新场景'), from, 'custom');
  }

  renameScene(projectId, sceneId, name) {
    const s = this.scene(projectId, sceneId);
    s.name = clean(name, s.name);
    return s;
  }

  // The scene's subtitle (e.g. 示例厂房 -> 3 号冷轧厂房). Empty puts the automatic one back.
  setSceneLabel(projectId, sceneId, label) {
    const s = this.scene(projectId, sceneId);
    s.label = String(label ?? '').trim().slice(0, 60) || null;
    return s;
  }

  removeScene(projectId, sceneId) {
    const p = this.project(projectId);
    if (p.scenes.length <= 1) throw new Error('项目里至少要保留一个场景');
    const i = p.scenes.findIndex((s) => s.id === sceneId);
    if (i < 0) throw new Error('场景不存在');
    const [gone] = p.scenes.splice(i, 1);
    if (p.activeScene === sceneId) p.activeScene = p.scenes[Math.max(0, i - 1)].id;
    return gone;
  }

  addAsset(projectId, assetId) {
    const p = this.project(projectId);
    if (p.assets.includes(assetId)) return false;
    p.assets.push(assetId);
    return true;
  }

  removeAsset(projectId, assetId) {
    const p = this.project(projectId);
    const i = p.assets.indexOf(assetId);
    if (i < 0) return false;
    p.assets.splice(i, 1);
    return true;
  }

  // ---------------------------------------------------------------- 项目案例库 (archives)

  archive(id) {
    const a = this.archives.find((x) => x.id === id);
    if (!a) throw new Error('案例不存在');
    return a;
  }

  // Snapshot a project (deep copy) into the case library, newest first, filed under its project
  // id. The project stays as it is; archiving it again adds a newer version.
  archiveProject(projectId = this.data.activeProject, now = Date.now()) {
    const p = this.project(projectId);
    const record = { id: uid('a'), projectId: p.id, name: p.name, archivedAt: now, project: copy(p) };
    this.archives.unshift(record);
    return record;
  }

  // Archived versions of one project, newest first.
  archivesOf(projectId) {
    return this.archives.filter((a) => a.projectId === projectId);
  }

  // 1-based version number of an archive among the archives of the same project (oldest = 1).
  archiveVersion(archiveId) {
    const a = this.archive(archiveId);
    const list = this.archivesOf(a.projectId);
    return list.length - list.indexOf(a);
  }

  // Restore an archived case as a new project (fresh ids, so the archive itself stays untouched)
  // and make it the active one. Returns the new project.
  restoreArchive(archiveId) {
    const src = copy(this.archive(archiveId).project);
    const ids = new Map();
    const scenes = src.scenes.map((s) => {
      const scene = newScene(s.name, s);
      ids.set(s.id, scene.id);
      return scene;
    });
    if (!scenes.length) scenes.push(...defaultModules());
    const p = {
      id: uid('p'),
      name: this.uniqueName(clean(src.name, '恢复的项目'), this.projects.map((x) => x.name)),
      products: src.products.map((e) => ({ key: uid('pp'), productId: e.productId, name: e.name ?? null })),
      scenes,
      assets: [...src.assets],
      activeScene: ids.get(src.activeScene) ?? scenes[0].id,
    };
    this.projects.push(p);
    this.data.activeProject = p.id;
    return p;
  }

  renameArchive(archiveId, name) {
    const a = this.archive(archiveId);
    a.name = clean(name, a.name);
    return a;
  }

  removeArchive(archiveId) {
    const i = this.archives.findIndex((x) => x.id === archiveId);
    if (i < 0) throw new Error('案例不存在');
    return this.archives.splice(i, 1)[0];
  }

  // Files uploaded before projects existed, or by tools that do not know about projects, and
  // products customised for a job (they carry baseProduct) land in the active project so that
  // nothing goes missing from the tree. Returns true when anything changed.
  adopt({ products = [], assets = [] }) {
    let changed = false;
    const p = this.active;
    const inAny = (fn) => this.projects.some(fn);
    for (const product of products) {
      if (!product.baseProduct) continue;
      if (inAny((x) => x.products.some((e) => e.productId === product.id))) continue;
      this.addProduct(p.id, product.id);
      changed = true;
    }
    for (const asset of assets) {
      if (inAny((x) => x.assets.includes(asset.id))) continue;
      p.assets.push(asset.id);
      changed = true;
    }
    return changed;
  }

  toJSON() {
    return this.data;
  }
}
