// Project workspace kept beside the standard product library.
// 标准产品库 is shared and read-only here: products with standard parameters.
// 项目库 holds projects; each project has its own 产品库 (copies of standard products and the
// products customised for it) and its own 场景库 (scenes plus the drawings/models uploaded to it).
// Pure data: no DOM, no three.js, so it can be tested with node --test.

export const DEFAULT_PROJECT_NAME = '冷轧车间 AGV + 行车方案';
export const DEFAULT_SCENE_NAME = '主场景';

let seq = 0;
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const clean = (s, fallback) => String(s ?? '').trim().slice(0, 60) || fallback;

export function newScene(name = DEFAULT_SCENE_NAME, from = null) {
  return {
    id: uid('s'),
    name: clean(name, DEFAULT_SCENE_NAME),
    drawing: from?.drawing ?? null, // scene-library asset id of the base drawing; null = the sample plant
    overlay: from?.overlay ?? null, // asset id of a drawing laid over the floor for reference
    placed: (from?.placed ?? []).map((p) => ({ ...p })),
    productId: from?.productId ?? null,
  };
}

export function newProject(name, products = []) {
  const scene = newScene();
  return {
    id: uid('p'),
    name: clean(name, '新项目'),
    products: products.map((productId) => ({ key: uid('pp'), productId, name: null })),
    scenes: [scene],
    assets: [],
    activeScene: scene.id,
  };
}

export function defaultWorkspace() {
  const project = newProject(DEFAULT_PROJECT_NAME, ['agv1', 'double-girder-crane-demo']);
  project.scenes[0].productId = 'agv1';
  return { v: 1, activeProject: project.id, projects: [project], open: {} };
}

// Repair whatever came back from storage so the UI never meets a half-formed record.
export function normalize(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.projects) || !data.projects.length) return defaultWorkspace();
  const projects = data.projects.filter((p) => p && typeof p === 'object').map((p) => {
    const scenes = (Array.isArray(p.scenes) ? p.scenes : []).filter(Boolean).map((s) => ({ ...newScene(s.name, s), id: s.id || uid('s') }));
    if (!scenes.length) scenes.push(newScene());
    return {
      id: p.id || uid('p'),
      name: clean(p.name, '未命名项目'),
      products: (Array.isArray(p.products) ? p.products : []).filter((x) => x?.productId).map((x) => ({ key: x.key || uid('pp'), productId: x.productId, name: x.name ?? null })),
      scenes,
      assets: [...new Set((Array.isArray(p.assets) ? p.assets : []).filter((x) => typeof x === 'string'))],
      activeScene: scenes.some((s) => s.id === p.activeScene) ? p.activeScene : scenes[0].id,
    };
  });
  if (!projects.length) return defaultWorkspace();
  return {
    v: 1,
    activeProject: projects.some((p) => p.id === data.activeProject) ? data.activeProject : projects[0].id,
    projects,
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

  addScene(projectId, name, from = null) {
    const p = this.project(projectId);
    const s = newScene(this.uniqueName(clean(name, '新场景'), p.scenes.map((x) => x.name)), from);
    p.scenes.push(s);
    return s;
  }

  renameScene(projectId, sceneId, name) {
    const s = this.scene(projectId, sceneId);
    s.name = clean(name, s.name);
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
