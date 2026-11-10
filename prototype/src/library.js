// Left column resource library, merged with the project title.
//   标准产品库  shared products with standard parameters (backend product library, built-ins)
//   项目库      projects; each has its own 产品库 (copies of standard products + customised ones)
//               and 场景库 (scenes, and the drawings/models uploaded into the project)
// Products and files move between them by drag and drop, by right-click menus, or by the small
// buttons that appear on hover. The tree is kept in projects.js and saved to the backend
// (falls back to localStorage) so it survives a reload.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG, THUMBNAIL_ROOT } from '../../demo/src/catalog.js';
import { Workspace } from './projects.js';
import { readEquipment } from '../../demo/src/scene/read-equipment.js';
import { buildFromSpec, exportGlb, fileName } from './model-builder.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const KIND = { model: '模型', site: '图纸', image: '图片', document: '文档' };
const RAIL_TOP = 9.85; // top of the runway beam in a generated plant, metres
const loader = new GLTFLoader();
const STORE_KEY = 'wh.workspace.v1';
const WS_URL = '/api/projects/workspace/state';
const DRAG_TYPE = 'application/x-wh-lib';
// The scene crane is procedural (示意) and stands for the overhead-crane product below until
// the real crane GLB arrives.
const CATS = [
  { key: 'agv', label: 'AGV', test: (c) => !c || /agv/i.test(c) },
  { key: 'crane', label: '起重机', test: (c) => /crane/i.test(c ?? '') },
  { key: 'other', label: '其他', test: (c) => Boolean(c) && !/agv|crane/i.test(c) },
];
export const SCENE_CRANE = { id: 'double-girder-crane-demo', model: '双梁桥式起重机（示意）', category: 'overhead_crane', summary: '场景中的行车 #1，程序化示意模型' };
const SAMPLE_NAME = 'sample-plant.dxf';

const svg = (d, size = 13) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  locate: svg('<circle cx="8" cy="8" r="4.2"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15"/>', 11),
  folder: svg('<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>'),
  box: svg('<path d="M8 1.8 14 5v6L8 14.2 2 11V5z"/><path d="M2 5l6 3.2L14 5M8 8.2v6"/>'),
  scene: svg('<path d="M1.8 13.5h12.4M3 13.5V6.5l5-3.8 5 3.8v7"/><path d="M6.3 13.5V9.6h3.4v3.9"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>', 12),
  more: svg('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>', 13),
};

async function getJson(url, init) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `${url} ${r.status}`);
  return body;
}

// Guess a product category from what the user called the model.
function categoryOf(name) {
  if (/起重机|行车|吊车|crane/i.test(name)) return 'overhead_crane';
  if (/卷|coil/i.test(name)) return 'coil';
  if (/agv|小车|平板车/i.test(name)) return 'agv';
  if (/大车|车|truck|vehicle/i.test(name)) return 'vehicle';
  return 'equipment';
}

const catalogHas = (id) => CATALOG.some((c) => c.id === id);

export class Library {
  constructor(app) {
    this.app = app;
    this.cat = 'agv';
    this.products = []; // everything the backend knows: standard + customised
    this.assets = [];
    // instance key -> { key, root, asset, x, y, heading, base, height, mount, bay, size }; the first
    // copy of a model is keyed by its id, further copies by id#2, id#3…
    this.placed = new Map();
    this.gltfCache = new Map();
    this.drawings = new Map(); // drawing asset id -> { summary, geometry } from readEquipment
    this.profiles = {}; // outline id -> points (mm), from every equipment drawing read so far
    this.builtModels = new Map(); // model name -> { assetId, productId } built in this session
    this.online = false;
    this.ws = null;
    this.ready = false; // nothing is written back until the saved scene has been restored
    this.switching = false;
    this.drawing = null; // asset id of the loaded drawing; null = the built-in sample plant
    this.processDrawing = null; // the AGV + crane plant's drawing while a generated plant is open
    this.sel = null; // data-row of the selected tree row
    this.drag = null;
    this.renaming = false;
    this.dirty = false;
  }

  // ------------------------------------------------------------------ boot + persistence

  async init() {
    this.ws = new Workspace(await this.loadWorkspace());
    this.bind();
    await this.reload();
    // Bring back the scene that was open last time (drawing, placed models, AGV model).
    const scene = this.ws.activeScene;
    if (scene.drawing || scene.overlay || scene.placed.length || (scene.productId && scene.productId !== this.app.product?.id)) {
      const errors = await this.applyScene(scene);
      if (errors.length) this.app.toast(`场景「${scene.name}」有 ${errors.length} 项没能还原：${errors[0]}`, true);
    }
    this.ready = true;
    this.persistSoon();
    this.render();
  }

  async loadWorkspace() {
    try {
      const r = await getJson(WS_URL);
      if (r?.state?.projects) return r.state;
    } catch {
      /* backend offline: use the browser copy */
    }
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    } catch {
      return null;
    }
  }

  persistSoon() {
    if (!this.ws || !this.ready) return;
    this.captureScene();
    const data = JSON.stringify(this.ws);
    try {
      localStorage.setItem(STORE_KEY, data);
    } catch {
      /* storage blocked; the backend copy still works */
    }
    clearTimeout(this.saveTimer);
    if (!this.online) return;
    this.saveTimer = setTimeout(() => {
      fetch(WS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: `{"state":${data}}` }).catch(() => {});
    }, 700);
  }

  // Write the live scene (drawing, overlay, placed models, AGV model) into the open scene record.
  captureScene() {
    if (this.switching || !this.ready) return;
    const s = this.ws.activeScene;
    s.drawing = this.drawing;
    s.overlay = this.overlay?.asset.id ?? null;
    s.placed = [...this.placed.values()].map((p) => ({ assetId: p.asset.id, x: Math.round(p.x), y: Math.round(p.y), rotate: p.heading ?? 0, size: p.size ?? null, mount: p.mount ?? 'floor', bay: p.bay ?? null, base: p.base ?? 0 }));
    s.productId = this.app.product?.id ?? s.productId;
  }

  async reload() {
    try {
      const p = await getJson('/api/library/products').catch(() => getJson('/api/products'));
      this.products = p.products ?? [];
      this.online = true;
    } catch {
      this.products = [];
      this.online = false;
    }
    if (!this.products.length) this.products = CATALOG.map((c) => ({ id: c.id, model: c.model, category: 'agv', summary: c.summary, thumbUrl: `${THUMBNAIL_ROOT}/${c.thumbnail}` }));
    if (!this.products.some((p) => p.id === SCENE_CRANE.id)) this.products.push(SCENE_CRANE);
    try {
      this.assets = (await getJson('/api/library/scene')).assets ?? [];
    } catch {
      this.assets = [];
    }
    if (this.ws?.adopt({ products: this.products, assets: this.assets })) this.persistSoon();
    this.render();
  }

  // Standard products only; customised ones (baseProduct) live in the project that made them.
  get std() {
    return this.products.filter((p) => !p.baseProduct);
  }

  placedCount(id) {
    return [...this.placed.values()].filter((p) => p.asset.id === id).length;
  }

  product(id) {
    return this.products.find((p) => p.id === id);
  }

  asset(id) {
    return this.assets.find((a) => a.id === id);
  }

  // ------------------------------------------------------------------ rendering

  render() {
    if (!this.ws) return;
    if (this.renaming || this.drag) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const body = $('libBody');
    const focused = document.activeElement?.closest?.('#libBody .row')?.dataset.row;
    body.innerHTML = this.stdHtml() + this.projectsHtml();
    if (focused) body.querySelector(`.row[data-row="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    this.renderTitle();
  }

  renderTitle() {
    const p = this.ws.active;
    const s = this.ws.activeScene;
    const t = $('projTitle');
    if (t) {
      t.textContent = p.name;
      t.closest('.ph').title = `当前项目：${p.name} · 场景：${s.name}`;
    }
    const chip = $('sceneSel');
    if (chip) {
      chip.textContent = s.name;
      chip.title = `当前场景：${s.name}（点击切换 / 新建场景）`;
    }
    const drawing = this.drawing ? this.asset(this.drawing)?.name ?? '图纸' : SAMPLE_NAME;
    $('source').textContent = `${s.name} · ${drawing}`;
  }

  node(key, defOpen, head, kids, cls = '') {
    return `<div class="node ${cls} ${this.ws.isOpen(key, defOpen) ? '' : 'closed'}" data-open-key="${esc(key)}">${head}<div class="kids">${kids}</div></div>`;
  }

  thumb(p, size = '') {
    const url = p.thumbUrl ?? p.thumbnail;
    const label = /crane/i.test(p.category ?? '') ? '行车' : /agv/i.test(p.category ?? 'agv') ? 'AGV' : '产品';
    return `<span class="th ${size}" style="${url ? `background-image:url(${esc(url)})` : ''}">${url ? '' : label}</span>`;
  }

  stdHtml() {
    const std = this.std;
    const groups = CATS.map((c) => ({ ...c, items: std.filter((p) => c.test(p.category)) })).filter((g) => g.items.length || g.key !== 'other');
    const cat = groups.find((g) => g.key === this.cat) ?? groups[0];
    const cur = this.ws.active;
    const rows = cat.items.map((p) => {
      const use = this.inUse(p);
      const owned = cur.products.some((e) => e.productId === p.id);
      const sub = use ? `<small class="use">● ${esc(use.label)}</small>` : `<small>${esc(p.summary ?? p.category ?? '')}</small>`;
      return `<div class="row std ${use ? 'inuse' : ''} ${this.sel === `std:${p.id}` ? 'sel' : ''}" tabindex="-1" draggable="true" data-row="std:${esc(p.id)}" data-kind="std" data-id="${esc(p.id)}" ${use ? `data-focus="${esc(use.focus)}"` : ''} title="拖到项目里，或右键加入项目">
        ${this.thumb(p, 'lg')}<span class="nm"><b>${esc(p.model ?? p.name)}</b>${sub}</span>
        <span class="racts">${use ? `<button class="go on" data-act="locate" title="跳转到场景中的 ${esc(use.label)}">${ICON.locate}</button>` : ''}<button class="ib ${owned ? 'done' : ''}" data-act="add-cur" title="${owned ? `「${esc(cur.name)}」已有此产品` : `加入当前项目「${esc(cur.name)}」`}">${owned ? '✓' : ICON.plus}</button></span>
      </div>`;
    }).join('');
    const seg = `<div class="cats">${groups.map((g) => `<button data-cat="${g.key}" class="${g.key === cat.key ? 'on' : ''}">${g.label}<em class="num">${g.items.length}</em></button>`).join('')}</div>`;
    const head = `<div class="lsh" data-toggle><i class="car"></i>标准产品库<em class="cnt">${std.length}</em><span class="lsh-note">标准参数</span></div>`;
    return this.node('std', true, head, seg + (rows || `<div class="empty">${cat.label}暂无标准产品</div>`), 'lsec');
  }

  projectsHtml() {
    const ws = this.ws;
    const projects = ws.projects.map((p) => this.projectHtml(p)).join('');
    const head = `<div class="lsh" data-toggle data-drop="new-project"><i class="car"></i>项目库<em class="cnt">${ws.projects.length}</em><button class="ib" data-act="new-project" title="新建项目">${ICON.plus}</button></div>`;
    return this.node('proj', true, head, projects, 'lsec');
  }

  projectHtml(p) {
    const ws = this.ws;
    const cur = p.id === ws.active.id;
    const head = `<div class="row pnode ${cur ? 'cur' : ''} ${this.sel === `pj:${p.id}` ? 'sel' : ''}" tabindex="-1" data-row="pj:${p.id}" data-kind="project" data-project="${p.id}" data-drop="project" data-toggle title="${cur ? '当前项目' : '双击切换到这个项目'}">
      <i class="car"></i><span class="ico">${ICON.folder}</span><span class="nm"><b>${esc(p.name)}</b></span>
      ${cur ? '<span class="tag">当前</span>' : '<span class="racts"><button class="go" data-act="switch">切换</button></span>'}
      <button class="ib more" data-act="menu" title="更多操作">${ICON.more}</button>
    </div>`;
    // project products
    const pp = p.products.map((e) => {
      const prod = this.product(e.productId);
      const name = e.name ?? prod?.model ?? e.productId;
      const custom = Boolean(prod?.baseProduct);
      const base = custom ? this.product(prod.baseProduct)?.model ?? prod.baseProduct : null;
      const use = cur && prod ? this.inUse(prod) : null;
      const sub = !prod ? '<small class="warn">产品库里已没有这个型号</small>' : use ? `<small class="use">● ${esc(use.label)}</small>` : `<small>${custom ? `定制 · 基于 ${esc(base)}` : '标准参数'}</small>`;
      const act = use ? `<button class="go on" data-act="locate" title="跳转到场景中的 ${esc(use.label)}">${ICON.locate}</button>` : cur && prod && this.usable(prod) ? '<button class="go" data-act="use">选用</button>' : '';
      return `<div class="row pp d2 ${use ? 'inuse' : ''} ${this.sel === `pp:${p.id}:${e.key}` ? 'sel' : ''}" tabindex="-1" draggable="true" data-row="pp:${p.id}:${e.key}" data-kind="pp" data-project="${p.id}" data-key="${e.key}" data-id="${esc(e.productId)}" ${use ? `data-focus="${esc(use.focus)}"` : ''}>
        ${prod ? this.thumb(prod) : '<span class="th">?</span>'}<span class="nm"><b>${esc(name)}${custom ? '<i class="kd c">定制</i>' : ''}</b>${sub}</span><span class="racts">${act}</span>
      </div>`;
    }).join('') || '<div class="hint d2">从上面的标准产品库拖进来，或右键「加入项目」</div>';
    const ppHead = `<div class="row fold d1" tabindex="-1" data-row="ppf:${p.id}" data-kind="products" data-project="${p.id}" data-drop="products" data-toggle>
      <i class="car"></i><span class="ico">${ICON.box}</span><span class="nm"><b>产品库</b></span><em class="cnt">${p.products.length}</em><button class="ib" data-act="menu" title="从标准产品库添加">${ICON.plus}</button>
    </div>`;
    // scenes + files
    const scenes = p.scenes.map((s) => {
      const open = cur && s.id === p.activeScene;
      const drawing = s.drawing ? this.asset(s.drawing)?.name ?? '图纸' : '示例厂房';
      const n = s.placed.length;
      return `<div class="row sc d2 ${open ? 'on' : ''} ${this.sel === `sc:${p.id}:${s.id}` ? 'sel' : ''}" tabindex="-1" data-row="sc:${p.id}:${s.id}" data-kind="scene" data-project="${p.id}" data-scene="${s.id}" title="${open ? '正在编辑的场景' : '点击切换到这个场景'}">
        <span class="ico sc">${ICON.scene}</span><span class="nm"><b>${esc(s.name)}</b><small>${esc(drawing)}${n ? ` · ${n} 个模型` : ''}</small></span>
        ${open ? '<span class="tag">打开中</span>' : '<span class="racts"><button class="go" data-act="open-scene">打开</button></span>'}
      </div>`;
    }).join('');
    const files = p.assets.map((id) => this.asset(id)).filter(Boolean).reverse().map((a) => this.assetHtml(p, a, cur)).join('');
    const scHead = `<div class="row fold d1" tabindex="-1" data-row="scf:${p.id}" data-kind="scenes" data-project="${p.id}" data-drop="scenes" data-toggle>
      <i class="car"></i><span class="ico">${ICON.scene}</span><span class="nm"><b>场景库</b></span><em class="cnt">${p.scenes.length + p.assets.length}</em><button class="ib" data-act="menu" title="新建场景 / 上传">${ICON.plus}</button>
    </div>`;
    const filesBlock = files ? `<div class="hint d2 fsep">文件 · 拖进三维视图即可放入</div>${files}` : '';
    const kids = this.node(`pj:${p.id}:pp`, true, ppHead, pp) + this.node(`pj:${p.id}:sc`, true, scHead, scenes + filesBlock);
    return this.node(`pj:${p.id}`, cur, head, kids, `pj ${cur ? 'cur' : ''}`);
  }

  assetHtml(p, a, cur) {
    const ok = Library.usable(a);
    let act = '';
    if (cur && ok && a.kind === 'model') act = this.placed.has(a.id) ? `<button class="go on" data-act="remove">移出</button>` : `<button class="go" data-act="place">放入</button>`;
    else if (cur && ok && a.kind === 'site' && a.meta?.convention === 'generic') act = this.overlay?.asset.id === a.id
      ? `<button class="go on" data-act="unoverlay">移出底图</button>`
      : `<button class="go ${this.drawing === a.id ? 'on' : ''}" data-act="site" title="识别柱网、跨、吊车梁、墙和设备，生成三维厂房并分步播放建造过程">${this.drawing === a.id ? '重新建造' : '生成厂房'}</button>`;
    else if (cur && ok && a.kind === 'site') act = this.drawing === a.id ? '<span class="tag">使用中</span>' : `<button class="go" data-act="site">载入</button>`;
    const thumb = a.thumbUrl ? `background-image:url(${esc(a.thumbUrl)})` : '';
    const sub = ok ? `${KIND[a.kind] ?? a.kind} · ${esc(a.meta?.formatName ?? a.originalFormat)}` : esc(a.message || '无法识别');
    const placed = cur && this.placed.has(a.id);
    return `<div class="row as d2 ${ok ? '' : 'err'} ${placed ? 'inuse' : ''} ${this.sel === `as:${p.id}:${a.id}` ? 'sel' : ''}" tabindex="-1" draggable="${ok}" data-row="as:${p.id}:${a.id}" data-kind="asset" data-project="${p.id}" data-id="${a.id}" ${placed ? `data-focus="asset:${a.id}"` : ''} title="${esc(placed ? '点击跳转到场景中的这个模型' : a.message ?? '')}">
      <span class="th" style="${thumb}">${thumb ? '' : esc(a.originalFormat ?? '')}</span><span class="nm"><b>${esc(a.name)}</b><small>${sub}</small></span><span class="racts">${act}</span>
    </div>`;
  }

  // ------------------------------------------------------------------ events

  bind() {
    const body = $('libBody');
    body.addEventListener('click', (e) => this.onClick(e));
    body.addEventListener('dblclick', (e) => this.onDblClick(e));
    body.addEventListener('contextmenu', (e) => this.onContext(e));
    body.addEventListener('keydown', (e) => this.onKey(e));
    body.addEventListener('dragstart', (e) => this.onDragStart(e));
    body.addEventListener('dragend', () => this.endDrag());
    body.addEventListener('dragover', (e) => this.onDragOver(e));
    body.addEventListener('dragleave', (e) => {
      const t = e.target.closest?.('.drop-ok');
      if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-ok');
    });
    body.addEventListener('drop', (e) => this.onDrop(e));
    body.addEventListener('scroll', () => this.closeMenu(), { passive: true });
    // Scene switchers: the scene chip in the library header and the scene name under the 3D view.
    const src = $('source');
    src.classList.add('scene-pick');
    src.title = '切换场景';
    src.tabIndex = 0;
    const pick = (el) => {
      const r = el.getBoundingClientRect();
      this.openMenu(el, r.left, r.bottom + 4, this.sceneMenu());
      // Open upwards when the switcher sits at the bottom of the window.
      const m = this.menu;
      if (m && r.bottom + 4 + m.offsetHeight > innerHeight - 6) m.style.top = `${Math.max(6, r.top - 4 - m.offsetHeight)}px`;
    };
    src.addEventListener('click', (e) => { e.stopPropagation(); pick(src); });
    src.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pick(src);
    });
    // The header chip is a button, so a click also unfolds a folded library card (main.js).
    $('sceneSel')?.addEventListener('click', (e) => {
      const el = e.currentTarget;
      requestAnimationFrame(() => pick(el)); // after the card has unfolded and settled
    });
    // Products and models can also be dropped straight into the 3D view.
    const view = $('view');
    view.addEventListener('dragover', (e) => {
      if (!this.drag || !this.viewAccepts(this.drag)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      view.classList.add('lib-drop');
    });
    view.addEventListener('dragleave', (e) => {
      if (!view.contains(e.relatedTarget)) view.classList.remove('lib-drop');
    });
    view.addEventListener('drop', (e) => {
      view.classList.remove('lib-drop');
      if (!this.drag || !this.viewAccepts(this.drag)) return;
      e.preventDefault();
      const drag = this.drag;
      this.endDrag();
      this.run(() => this.dropInView(drag, e.clientX, e.clientY));
    });
  }

  rowInfo(row) {
    const d = row?.dataset ?? {};
    return { kind: d.kind, project: d.project, id: d.id, key: d.key, scene: d.scene, row };
  }

  select(row) {
    for (const r of $('libBody').querySelectorAll('.row.sel')) r.classList.remove('sel');
    this.sel = row?.dataset.row ?? null;
    if (row) {
      row.classList.add('sel');
      row.focus({ preventScroll: true });
    }
  }

  toggle(node, on) {
    if (!node?.dataset.openKey) return;
    const open = on ?? node.classList.contains('closed');
    node.classList.toggle('closed', !open);
    this.ws.setOpen(node.dataset.openKey, open);
    this.persistSoon();
  }

  async run(fn) {
    try {
      await fn();
    } catch (error) {
      this.app.toast(error.message, true);
    }
    this.render();
  }

  onClick(e) {
    this.closeMenu();
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      this.cat = cat.dataset.cat;
      this.render();
      return;
    }
    const row = e.target.closest('.row');
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.disabled) return;
      if (row) this.select(row);
      if (act.dataset.act === 'menu') {
        const r = act.getBoundingClientRect();
        this.openMenu(row ?? act, r.left, r.bottom + 2);
        return;
      }
      this.run(() => this.doAct(act.dataset.act, this.rowInfo(row)));
      return;
    }
    const toggler = e.target.closest('[data-toggle]');
    // Section headers, folders and project rows open and fold like a file tree; the caret always does.
    if (toggler && (e.target.closest('.car') || !toggler.classList.contains('pnode'))) {
      this.toggle(toggler.parentElement);
      if (row) this.select(row);
      return;
    }
    if (!row) return;
    this.select(row);
    if (row.classList.contains('pnode')) this.toggle(row.parentElement);
    else if (row.dataset.kind === 'scene') this.run(() => this.doAct('open-scene', this.rowInfo(row)));
    else if (row.dataset.focus) this.app.focusObject(row.dataset.focus);
  }

  onDblClick(e) {
    if (e.target.closest('[data-act], input')) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const info = this.rowInfo(row);
    const primary = { project: 'switch', scene: 'open-scene', pp: 'use', asset: 'primary' }[info.kind];
    if (primary) this.run(() => this.doAct(primary, info));
  }

  onKey(e) {
    if (e.target.closest('input')) return;
    const row = e.target.closest('.row');
    const k = e.key;
    const rows = [...$('libBody').querySelectorAll('.row')].filter((r) => r.offsetParent);
    const i = rows.indexOf(row);
    let handled = true;
    if (k === 'ArrowDown' || k === 'ArrowUp') this.select(rows[Math.min(rows.length - 1, Math.max(0, i + (k === 'ArrowDown' ? 1 : -1)))]);
    else if ((k === 'ArrowRight' || k === 'ArrowLeft') && row?.dataset.toggle !== undefined) this.toggle(row.parentElement, k === 'ArrowRight');
    else if (k === 'Enter' && row) this.onDblClick({ target: row });
    else if (k === 'F2' && row) this.startRename(row);
    else if (k === 'Delete' && row) this.run(() => this.doAct('delete', this.rowInfo(row)));
    else if ((k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) && row) {
      const r = row.getBoundingClientRect();
      this.openMenu(row, r.left + 24, r.bottom);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation(); // keep the 3D view's shortcuts (Delete, arrows, Enter) out of the tree
    }
  }

  // ------------------------------------------------------------------ actions

  async doAct(act, info) {
    const ws = this.ws;
    const app = this.app;
    const { kind, project, id, key, scene } = info;
    switch (act) {
      case 'locate':
        app.focusObject(info.row.dataset.focus);
        return;
      case 'add-cur':
        return this.addProduct(ws.active.id, id);
      case 'new-project':
        return this.newProject();
      case 'switch':
        return this.switchProject(project);
      case 'open-scene':
        return this.openScene(project, scene);
      case 'use':
        return this.useProduct(id);
      case 'place':
        return this.place(id);
      case 'remove':
        this.remove(id);
        app.bump();
        return undefined;
      case 'site':
        return this.loadSite(id);
      case 'unoverlay':
        return this.removeOverlay();
      case 'overlay':
        if (project !== ws.active.id) await this.switchProject(project);
        return this.loadSite(id, { overlay: true });
      case 'model-from': {
        const a = this.asset(id);
        const pics = this.assets.filter((x) => x.kind === 'image' && x.url).map((x) => x.name);
        if (a && !app.agent?.busy) app.agent?.send(`按设备图纸「${a.name}」建三维模型${pics.length ? `，外观参考图片：${pics.join('、')}` : ''}`);
        return undefined;
      }
      case 'primary': {
        const a = this.asset(id);
        if (!a || !Library.usable(a)) return undefined;
        if (project !== ws.active.id) await this.switchProject(project);
        if (a.kind === 'model') return this.placed.has(id) ? this.app.focusObject(`asset:${id}`) : this.place(id);
        if (a.kind === 'site') return this.loadSite(id);
        return undefined;
      }
      case 'delete':
        if (kind === 'project') return this.deleteProject(project);
        if (kind === 'pp') {
          const e = ws.removeProduct(project, key);
          if (e) app.toast(`已从「${ws.project(project).name}」产品库移除 ${this.product(e.productId)?.model ?? e.productId}（标准产品库不受影响）`);
        }
        if (kind === 'scene') return this.deleteScene(project, scene);
        if (kind === 'asset') {
          if (project === ws.active.id) this.remove(id);
          ws.removeAsset(project, id);
          app.toast(`已从「${ws.project(project).name}」场景库移除 ${this.asset(id)?.name ?? id}`);
        }
        this.persistSoon();
        return undefined;
      default:
        return undefined;
    }
  }

  addProduct(projectId, productId, { quiet = false } = {}) {
    const p = this.ws.project(projectId);
    const prod = this.product(productId);
    const { entry, added } = this.ws.addProduct(projectId, productId);
    this.ws.setOpen(`pj:${projectId}`, true);
    this.ws.setOpen(`pj:${projectId}:pp`, true);
    this.ws.setOpen('proj', true);
    this.persistSoon();
    if (!quiet) this.app.toast(added ? `已把 ${prod?.model ?? productId} 加入「${p.name}」产品库` : `「${p.name}」产品库里已经有 ${prod?.model ?? productId}`);
    this.flash(`pp:${projectId}:${entry.key}`);
    return entry;
  }

  addAssetTo(projectId, assetId) {
    const p = this.ws.project(projectId);
    const a = this.asset(assetId);
    const added = this.ws.addAsset(projectId, assetId);
    this.ws.setOpen(`pj:${projectId}`, true);
    this.ws.setOpen(`pj:${projectId}:sc`, true);
    this.persistSoon();
    this.app.toast(added ? `已把 ${a?.name ?? assetId} 加入「${p.name}」场景库` : `「${p.name}」场景库里已经有 ${a?.name ?? assetId}`);
    this.flash(`as:${projectId}:${assetId}`);
  }

  // Highlight a row after the next render, so the eye finds what just moved.
  flash(rowKey) {
    this.sel = rowKey;
    requestAnimationFrame(() => {
      const el = $('libBody').querySelector(`.row[data-row="${CSS.escape(rowKey)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }

  newProject({ withProduct, focus = true } = {}) {
    const p = this.ws.createProject('新项目', withProduct ? [withProduct] : []);
    this.ws.setOpen(`pj:${p.id}`, true);
    this.ws.setOpen('proj', true);
    this.persistSoon();
    this.render();
    // Name it straight away, like a new folder in a file manager.
    if (focus) {
      const row = $('libBody').querySelector(`.row[data-row="pj:${p.id}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      if (row) this.startRename(row);
    }
    return p;
  }

  async deleteProject(id) {
    const p = this.ws.project(id);
    if (this.ws.projects.length <= 1) throw new Error('至少要保留一个项目');
    if (!confirm(`删除项目「${p.name}」？\n项目里的产品引用和场景会一起删除；标准产品库和已上传的文件本身不受影响。`)) return;
    const wasActive = this.ws.active.id === id;
    this.ws.removeProject(id);
    if (wasActive) {
      this.switching = true; // the deleted scene must not be captured into the new active one
      try {
        await this.applyScene(this.ws.activeScene);
      } finally {
        this.switching = false;
      }
    }
    this.persistSoon();
    this.app.toast(`已删除项目「${p.name}」`);
  }

  async deleteScene(projectId, sceneId) {
    const s = this.ws.scene(projectId, sceneId);
    if (!confirm(`删除场景「${s.name}」？`)) return;
    const wasOpen = projectId === this.ws.active.id && this.ws.active.activeScene === sceneId;
    this.ws.removeScene(projectId, sceneId);
    if (wasOpen) {
      this.switching = true;
      try {
        await this.applyScene(this.ws.activeScene);
      } finally {
        this.switching = false;
      }
    }
    this.persistSoon();
    this.app.toast(`已删除场景「${s.name}」`);
  }

  async switchProject(projectId, sceneId) {
    const ws = this.ws;
    if (projectId === ws.active.id && (!sceneId || sceneId === ws.active.activeScene)) return;
    this.captureScene();
    ws.setActive(projectId, sceneId);
    ws.setOpen(`pj:${projectId}`, true);
    const p = ws.active;
    const s = ws.activeScene;
    const errors = await this.applyScene(s);
    this.persistSoon();
    this.app.toast(errors.length ? `已打开「${p.name} / ${s.name}」，${errors.length} 项没能还原：${errors[0]}` : `已打开「${p.name} / ${s.name}」`, errors.length > 0);
  }

  openScene(projectId, sceneId) {
    return this.switchProject(projectId, sceneId);
  }

  async newScene(projectId, { copyCurrent = false } = {}) {
    if (projectId === this.ws.active.id) this.captureScene();
    const from = copyCurrent ? this.ws.activeScene : null;
    const s = this.ws.addScene(projectId, copyCurrent ? `${from.name} 副本` : '新场景', from ?? { productId: this.app.product?.id });
    this.ws.setOpen(`pj:${projectId}:sc`, true);
    await this.switchProject(projectId, s.id);
    this.render();
    const row = $('libBody').querySelector(`.row[data-row="sc:${projectId}:${s.id}"]`);
    if (row) this.startRename(row);
  }

  // Load a scene record into the 3D view. Returns the list of things that could not be restored.
  async applyScene(scene) {
    const app = this.app;
    const errors = [];
    const was = this.switching;
    this.switching = true;
    try {
      if ((scene.drawing ?? null) !== this.drawing) {
        try {
          if (scene.drawing) await this.loadSite(scene.drawing, { quiet: true });
          else await this.loadSample();
        } catch (error) {
          errors.push(error.message);
        }
      }
      if ((scene.overlay ?? null) !== (this.overlay?.asset.id ?? null)) {
        this.removeOverlay();
        const a = scene.overlay && this.asset(scene.overlay);
        if (a) await this.loadOverlay(a, { quiet: true }).catch((error) => errors.push(error.message));
        else if (scene.overlay) errors.push('底图文件已不在场景库');
      }
      for (const id of [...this.placed.keys()]) this.remove(id);
      for (const p of scene.placed) {
        try {
          await this.place(p.assetId, { x: p.x, y: p.y, rotate: p.rotate, size: p.size ?? undefined, mount: p.mount, bay: p.bay ?? undefined, elevation: p.base || undefined, add: true, quiet: true });
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (scene.productId && scene.productId !== app.product?.id && catalogHas(scene.productId) && !app.site.isScene) await app.selectProduct(scene.productId);
    } finally {
      this.switching = was;
    }
    app.refresh();
    app.bump();
    return errors;
  }

  usable(prod) {
    return catalogHas(prod.id) || catalogHas(prod.baseProduct) || prod.id === SCENE_CRANE.id;
  }

  // Put a project product into the open scene: the AGV model is swapped; a customised AGV is
  // its base model with the saved nominal parameters.
  async useProduct(productId) {
    const app = this.app;
    const prod = this.product(productId);
    if (!prod) throw new Error('产品库里已没有这个型号');
    if (prod.id === SCENE_CRANE.id) return app.focusObject('crane');
    const base = catalogHas(prod.id) ? prod.id : prod.baseProduct;
    if (!catalogHas(base)) throw new Error(`${prod.model} 暂无三维模型，不能放进场景`);
    await app.selectProduct(base);
    if (base !== prod.id && prod.params) {
      const values = Object.fromEntries(Object.entries(prod.params).filter(([k, r]) => app.product.params[k] && Number.isFinite(r?.nominal)).map(([k, r]) => [k, r.nominal]));
      if (Object.keys(values).length) app.setVehicleParams(values);
    }
    app.bump();
    this.persistSoon();
    app.toast(`场景中的 AGV 已换成 ${prod.model}`);
    return undefined;
  }

  // ------------------------------------------------------------------ inline rename

  startRename(row) {
    const info = this.rowInfo(row);
    if (!['project', 'pp', 'scene'].includes(info.kind)) return;
    const b = row.querySelector('.nm b');
    if (!b) return;
    const ws = this.ws;
    const current = info.kind === 'project' ? ws.project(info.project).name
      : info.kind === 'scene' ? ws.scene(info.project, info.scene).name
        : ws.project(info.project).products.find((e) => e.key === info.key)?.name ?? this.product(info.id)?.model ?? '';
    this.renaming = true;
    const input = document.createElement('input');
    input.className = 'rn';
    input.value = current;
    input.maxLength = 60;
    b.replaceWith(input);
    row.draggable = false;
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      this.renaming = false;
      const name = input.value.trim();
      if (commit && name && name !== current) {
        if (info.kind === 'project') ws.renameProject(info.project, name);
        else if (info.kind === 'scene') ws.renameScene(info.project, info.scene, name);
        else ws.renameProduct(info.project, info.key, name);
        this.persistSoon();
      }
      this.sel = row.dataset.row;
      this.render();
      $('libBody').querySelector(`.row[data-row="${CSS.escape(this.sel)}"]`)?.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ------------------------------------------------------------------ context menu

  onContext(e) {
    const row = e.target.closest('.row') ?? e.target.closest('.lsh');
    if (!row) return;
    e.preventDefault();
    if (row.classList.contains('row')) this.select(row);
    this.openMenu(row, e.clientX, e.clientY);
  }

  menuFor(row) {
    const ws = this.ws;
    const info = this.rowInfo(row);
    const cur = ws.active;
    const run = (fn) => () => this.run(fn);
    // Never an empty submenu: with no other project, say so and offer a new one.
    const projectsSub = (fn, { except, makeNew } = {}) => {
      const others = ws.projects.filter((p) => p.id !== except);
      return [
        ...(others.length ? others.map((p) => ({ label: p.name, tag: p.id === cur.id ? '当前' : '', act: run(() => fn(p.id)) })) : [{ label: '还没有其他项目', disabled: true }]),
        { sep: true },
        { label: '新建项目…', act: run(makeNew ?? (() => fn(this.newProject().id))) },
      ];
    };
    if (row.classList.contains('lsh')) {
      if (row.closest('[data-open-key="proj"]')) return [{ label: '新建项目', act: run(() => this.newProject()) }];
      return [];
    }
    switch (info.kind) {
      case 'std': {
        const prod = this.product(info.id);
        const use = prod && this.inUse(prod);
        return [
          { label: `加入当前项目「${cur.name}」`, act: run(() => this.addProduct(cur.id, info.id)) },
          { label: '加入到项目', sub: projectsSub((pid) => this.addProduct(pid, info.id), { makeNew: () => this.newProjectWith(info.id) }) },
          { sep: true },
          { label: '在当前场景选用', disabled: !prod || !this.usable(prod) || prod.id === SCENE_CRANE.id, act: run(async () => { this.addProduct(cur.id, info.id, { quiet: true }); await this.useProduct(info.id); }) },
          ...(use ? [{ label: '定位到场景中', act: () => this.app.focusObject(use.focus) }] : []),
        ];
      }
      case 'project': {
        const isCur = info.project === cur.id;
        return [
          { label: '切换到这个项目', disabled: isCur, act: run(() => this.switchProject(info.project)) },
          { label: '新建场景', act: run(() => this.newScene(info.project)) },
          { label: '从标准产品库添加', sub: this.stdSub(info.project) },
          { sep: true },
          { label: '重命名', key: 'F2', act: () => this.startRename(row) },
          { label: '新建项目', act: run(() => this.newProject()) },
          { label: '删除项目', key: 'Del', danger: true, disabled: ws.projects.length <= 1, act: run(() => this.deleteProject(info.project)) },
        ];
      }
      case 'products':
        return [{ lab: '从标准产品库添加' }, ...this.stdSub(info.project)];
      case 'pp': {
        const isCur = info.project === cur.id;
        const prod = this.product(info.id);
        return [
          { label: isCur ? '在当前场景选用' : '切换到此项目并选用', disabled: !prod || !this.usable(prod), act: run(async () => { if (!isCur) await this.switchProject(info.project); await this.useProduct(info.id); }) },
          { label: '复制到项目', sub: projectsSub((pid) => this.addProduct(pid, info.id), { except: info.project, makeNew: () => this.newProjectWith(info.id) }) },
          { sep: true },
          { label: '重命名', key: 'F2', act: () => this.startRename(row) },
          { label: '从项目移除', key: 'Del', danger: true, act: run(() => this.doAct('delete', info)) },
        ];
      }
      case 'scenes':
        return [
          { label: '新建场景', hint: '从示例厂房开始', act: run(() => this.newScene(info.project)) },
          { label: '复制当前场景', disabled: info.project !== cur.id, act: run(() => this.newScene(info.project, { copyCurrent: true })) },
          { sep: true },
          { label: '上传图纸 / 模型…', hint: '交给小华转换', act: () => this.pickUpload(info.project) },
        ];
      case 'scene': {
        const open = info.project === cur.id && cur.activeScene === info.scene;
        return [
          { label: '打开', disabled: open, act: run(() => this.openScene(info.project, info.scene)) },
          { label: '复制场景', act: run(async () => { await this.openScene(info.project, info.scene); await this.newScene(info.project, { copyCurrent: true }); }) },
          { sep: true },
          { label: '重命名', key: 'F2', act: () => this.startRename(row) },
          { label: '删除场景', key: 'Del', danger: true, disabled: ws.project(info.project).scenes.length <= 1, act: run(() => this.deleteScene(info.project, info.scene)) },
        ];
      }
      case 'asset': {
        const a = this.asset(info.id);
        const ok = a && Library.usable(a);
        const isCur = info.project === cur.id;
        const items = [];
        if (ok && a.kind === 'model') {
          if (isCur && this.placed.has(a.id)) items.push({ label: '定位到场景中', act: () => this.app.focusObject(`asset:${a.id}`) }, { label: '移出场景', act: run(() => { this.remove(a.id); this.app.bump(); }) });
          else items.push({ label: isCur ? '放入当前场景' : '切换到此项目并放入', act: run(() => this.doAct('primary', info)) });
        }
        if (ok && a.kind === 'site') {
          items.push({ label: a.meta?.convention === 'generic' ? '生成厂房（分步建造）' : '载入为场景图纸', act: run(() => this.doAct('primary', info)) });
          if (a.meta?.convention === 'generic') items.push({ label: '叠为底图（只做参考）', act: run(() => this.doAct('overlay', info)) });
          items.push({ label: '按设备图建模（交给小华）', act: run(() => this.doAct('model-from', info)) });
        }
        return [
          ...items,
          { label: '复制到项目', sub: projectsSub((pid) => this.addAssetTo(pid, info.id), { except: info.project }) },
          { sep: true },
          { label: '从项目移除', key: 'Del', danger: true, act: run(() => this.doAct('delete', info)) },
        ];
      }
      default:
        return [];
    }
  }

  stdSub(projectId) {
    const p = this.ws.project(projectId);
    const list = this.std.map((prod) => {
      const have = p.products.some((e) => e.productId === prod.id);
      return { label: prod.model ?? prod.id, tag: have ? '已有' : '', disabled: have, act: () => this.run(() => this.addProduct(projectId, prod.id)) };
    });
    return list.length ? list : [{ label: '标准产品库为空', disabled: true }];
  }

  newProjectWith(productId) {
    const p = this.newProject({ withProduct: productId });
    this.app.toast(`已新建项目并加入 ${this.product(productId)?.model ?? productId}，输入项目名称后回车`);
    return p;
  }

  // Uploads go through the 小华 chat (it converts files and reports back); target the project first.
  async pickUpload(projectId) {
    if (projectId !== this.ws.active.id) await this.switchProject(projectId);
    const agent = document.querySelector('.panel.agent');
    agent?.classList.remove('min-on');
    $('chatFiles')?.click();
  }

  // Scene switcher for the scene name under the 3D view: every scene of every project, plus new.
  sceneMenu() {
    const ws = this.ws;
    const cur = ws.active;
    const run = (fn) => () => this.run(fn);
    const sceneItems = (p) => p.scenes.map((s) => {
      const open = p.id === cur.id && s.id === p.activeScene;
      const drawing = s.drawing ? this.asset(s.drawing)?.name ?? '图纸' : '示例厂房';
      return { label: s.name, hint: drawing, tag: open ? '打开中' : '', disabled: open, act: run(() => this.openScene(p.id, s.id)) };
    });
    return [
      { lab: `「${cur.name}」的场景` },
      ...sceneItems(cur),
      { sep: true },
      { label: '新建场景', hint: '从示例厂房开始', act: run(() => this.newScene(cur.id)) },
      { label: '复制当前场景', act: run(() => this.newScene(cur.id, { copyCurrent: true })) },
      ...(ws.projects.length > 1 ? [{ sep: true }, { lab: '其他项目' }, ...ws.projects.filter((p) => p.id !== cur.id).map((p) => ({ label: p.name, sub: sceneItems(p) }))] : []),
    ];
  }

  openMenu(anchor, x, y, list = null) {
    this.closeMenu();
    const items = list ?? this.menuFor(anchor);
    if (!items.length) return;
    const el = document.createElement('div');
    el.className = 'ctx';
    el.setAttribute('role', 'menu');
    const build = (list, host) => {
      for (const it of list) {
        if (it.sep) {
          host.appendChild(document.createElement('hr'));
          continue;
        }
        if (it.lab) {
          const l = document.createElement('div');
          l.className = 'lab';
          l.textContent = it.lab;
          host.appendChild(l);
          continue;
        }
        const b = document.createElement('div');
        if (it.sub && !it.sub.length) it.disabled = true;
        b.className = `ci ${it.danger ? 'danger' : ''} ${it.sub ? 'csub' : ''} ${it.disabled ? 'off' : ''}`;
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        b.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}${it.tag ? `<em>${esc(it.tag)}</em>` : ''}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}${it.sub && !it.disabled ? '<i class="arr">▸</i>' : ''}`;
        if (it.sub && !it.disabled) {
          const sub = document.createElement('div');
          sub.className = 'ctx sub';
          build(it.sub, sub);
          b.appendChild(sub);
          b.addEventListener('mouseenter', () => this.placeSub(b, sub));
          // Clicking the parent item also opens it, for trackpads and slow pointers.
          b.addEventListener('click', (e) => {
            if (sub.contains(e.target)) return;
            e.stopPropagation();
            for (const x of host.querySelectorAll(':scope > .csub.hot')) if (x !== b) x.classList.remove('hot');
            b.classList.toggle('hot');
            this.placeSub(b, sub);
          });
        } else if (!it.disabled) {
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeMenu();
            it.act?.();
          });
        }
        host.appendChild(b);
      }
    };
    build(items, el);
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
    el.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 6))}px`;
    this.menu = el;
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && el.contains(e.target)) return;
      this.closeMenu();
    };
    this.menuClose = close;
    setTimeout(() => {
      addEventListener('pointerdown', close, true);
      addEventListener('keydown', close, true);
      addEventListener('resize', close);
      addEventListener('blur', close);
    });
  }

  // Open a submenu to the right, or to the left when it would leave the window.
  placeSub(item, sub) {
    sub.classList.remove('flip');
    sub.style.top = '';
    requestAnimationFrame(() => {
      const r = sub.getBoundingClientRect();
      if (r.right > innerWidth - 6) sub.classList.add('flip');
      if (r.bottom > innerHeight - 6) sub.style.top = `${innerHeight - 6 - r.bottom - 5}px`;
    });
  }

  closeMenu() {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    const close = this.menuClose;
    removeEventListener('pointerdown', close, true);
    removeEventListener('keydown', close, true);
    removeEventListener('resize', close);
    removeEventListener('blur', close);
  }

  // ------------------------------------------------------------------ drag and drop

  onDragStart(e) {
    const row = e.target.closest?.('.row[draggable="true"]');
    if (!row || this.renaming) return;
    this.closeMenu();
    const info = this.rowInfo(row);
    const name = info.kind === 'asset' ? this.asset(info.id)?.name : this.product(info.id)?.model;
    this.drag = { kind: info.kind, id: info.id, from: info.project ?? null, name: name ?? info.id };
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(this.drag));
    e.dataTransfer.setData('text/plain', this.drag.name);
    e.dataTransfer.effectAllowed = 'copy';
    // A compact pill instead of the whole row as the drag image.
    const pill = document.createElement('div');
    pill.className = 'dragpill';
    pill.textContent = `＋ ${this.drag.name}`;
    document.body.appendChild(pill);
    e.dataTransfer.setDragImage(pill, 12, 14);
    setTimeout(() => pill.remove());
    row.classList.add('dragging');
    document.body.classList.add('lib-dragging');
    // Outline every place this item can go, so the user sees the targets before moving.
    for (const t of $('libBody').querySelectorAll('[data-drop]')) t.classList.toggle('can-drop', Boolean(this.dropMode(this.drag, t)));
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    clearTimeout(this.springTimer);
    document.body.classList.remove('lib-dragging');
    $('view').classList.remove('lib-drop');
    for (const t of $('libBody').querySelectorAll('.can-drop, .drop-ok, .dragging')) t.classList.remove('can-drop', 'drop-ok', 'dragging');
    if (this.dirty) this.render();
  }

  // What dropping `drag` onto target `t` does, or null when it is not allowed.
  dropMode(drag, t) {
    const where = t.dataset.drop;
    const pid = t.dataset.project;
    if (where === 'new-project') return drag.kind === 'std' || drag.kind === 'pp' ? '松开：新建项目并加入' : null;
    const pname = pid ? this.ws.project(pid).name : '';
    if ((drag.kind === 'std' || drag.kind === 'pp') && (where === 'project' || where === 'products')) {
      if (drag.kind === 'pp' && drag.from === pid) return null;
      const have = this.ws.project(pid).products.some((e) => e.productId === drag.id);
      return have ? `「${pname}」已有` : `松开：加入「${pname}」产品库`;
    }
    if (drag.kind === 'asset' && (where === 'project' || where === 'scenes')) {
      if (drag.from === pid) return null;
      return `松开：加入「${pname}」场景库`;
    }
    return null;
  }

  onDragOver(e) {
    if (!this.drag) return;
    const t = e.target.closest('[data-drop]');
    for (const x of $('libBody').querySelectorAll('.drop-ok')) if (x !== t) x.classList.remove('drop-ok');
    const mode = t && this.dropMode(this.drag, t);
    if (!mode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    t.dataset.dropHint = mode;
    if (!t.classList.contains('drop-ok')) {
      t.classList.add('drop-ok');
      // Hovering on a folded project opens it after a moment (spring-loaded folders).
      clearTimeout(this.springTimer);
      const node = t.parentElement;
      if (node?.classList.contains('closed')) this.springTimer = setTimeout(() => this.toggle(node, true), 600);
    }
  }

  onDrop(e) {
    const t = e.target.closest('[data-drop]');
    const drag = this.drag;
    if (!drag || !t || !this.dropMode(drag, t)) return;
    e.preventDefault();
    this.endDrag();
    if (t.dataset.drop === 'new-project') {
      this.newProjectWith(drag.id);
      return;
    }
    const pid = t.dataset.project;
    this.run(() => (drag.kind === 'asset' ? this.addAssetTo(pid, drag.id) : this.addProduct(pid, drag.id)));
  }

  viewAccepts(drag) {
    if (drag.kind === 'asset') {
      const a = this.asset(drag.id);
      return Boolean(a && Library.usable(a) && (a.kind === 'model' || a.kind === 'site'));
    }
    const prod = this.product(drag.id);
    return Boolean(prod && this.usable(prod) && prod.id !== SCENE_CRANE.id);
  }

  // Dropped into the 3D view: models land where the pointer is, drawings load, products are used.
  async dropInView(drag, cx, cy) {
    const ws = this.ws;
    if (drag.from && drag.from !== ws.active.id) await this.switchProject(drag.from);
    if (drag.kind === 'asset') {
      const a = this.asset(drag.id);
      ws.addAsset(ws.active.id, a.id);
      if (a.kind === 'site') return this.loadSite(a.id);
      const at = this.app.floorAt?.(cx, cy);
      return this.place(a.id, at ? { x: at.x, y: at.y } : {});
    }
    if (drag.kind === 'std') this.addProduct(ws.active.id, drag.id, { quiet: true });
    return this.useProduct(drag.id);
  }

  // ------------------------------------------------------------------ uploads + scene objects

  // Called by the 小华 chat panel (the only upload entry). Returns the backend asset records;
  // the files go into the open project's 场景库.
  async upload(files) {
    if (!files.length) return { assets: [], message: '' };
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const r = await fetch('/api/library/scene', { method: 'POST', body: form });
    const body = await r.json().catch(() => ({}));
    if (!r.ok && !body.assets) throw new Error(body.error || `HTTP ${r.status}`);
    const assets = body.assets ?? (body.asset ? [body.asset] : []);
    const pid = this.ws.active.id;
    for (const a of assets) this.ws.addAsset(pid, a.id);
    this.ws.setOpen(`pj:${pid}`, true);
    this.ws.setOpen(`pj:${pid}:sc`, true);
    this.ws.setOpen('proj', true);
    document.querySelector('.panel.lib')?.classList.remove('min-on');
    await this.reload();
    this.persistSoon();
    if (assets[0]) this.flash(`as:${pid}:${assets[0].id}`);
    return { assets, message: body.message ?? '' };
  }

  // Which scene object (if any) this product is in use as, and where clicking it jumps to.
  inUse(p) {
    const app = this.app;
    if (p.id === app.product?.id) return { label: `${app.site.agvCount} 台在场景中`, focus: 'agv', count: app.site.agvCount };
    if (p.id === SCENE_CRANE.id && app.site.crane) return { label: '行车 #1 在场景中', focus: 'crane', count: 1 };
    return null;
  }

  // A selection in the viewport lights up its rows in the tree.
  reveal(kind) {
    if (kind === 'agv' || kind === 'crane') {
      if (this.cat !== kind) {
        this.cat = kind;
        this.render();
      }
    }
    let first = null;
    for (const el of $('libBody').querySelectorAll('.row[data-focus]')) {
      const on = el.dataset.focus === kind;
      el.classList.toggle('sel', on);
      if (on && el.classList.contains('pp')) first ??= el;
    }
    first?.scrollIntoView({ block: 'nearest' });
  }

  static usable(a) {
    return a.status === 'ready' || Boolean(a.url && a.status !== 'failed' && a.status !== 'unsupported');
  }

  find(idOrName) {
    const key = String(idOrName).toLowerCase();
    const exact = this.assets.find((a) => a.id === idOrName);
    if (exact) return exact;
    // Same file uploaded twice: prefer the newest usable copy.
    const hits = [...this.assets].reverse().filter((a) => [a.name, a.originalName].some((n) => n && n.toLowerCase().includes(key)));
    return hits.find((a) => Library.usable(a)) ?? hits[0];
  }

  // A placeable model from either library: { id, name, url, source }.
  findModel(idOrName) {
    const key = String(idOrName ?? '').trim().toLowerCase();
    if (!key) throw new Error('没有给出模型名称');
    const scene = this.assets.filter((a) => a.kind === 'model' && a.url && a.status !== 'failed' && a.status !== 'unsupported')
      .map((a) => ({ id: a.id, name: a.name, url: a.url, source: '场景库' }));
    const products = this.products.filter((p) => p.modelUrl).map((p) => ({ id: p.id, name: p.model ?? p.name, alias: p.name, url: p.modelUrl, source: '产品库', category: p.category }));
    const all = [...products, ...scene];
    const hit = all.find((m) => m.id.toLowerCase() === key)
      ?? all.find((m) => m.name.toLowerCase() === key)
      ?? all.find((m) => m.name.toLowerCase().includes(key) || (m.alias ?? '').toLowerCase().includes(key))
      ?? all.find((m) => key.includes(m.name.toLowerCase()));
    if (!hit) {
      const have = all.map((m) => `${m.name}（${m.source}）`).join('、') || '无';
      throw new Error(`资源库里没有「${idOrName}」的模型，不能凭空生成或拿别的模型代替。请向用户索要这台设备的图纸或三维模型（STEP/GLB/OBJ/STL/FBX，并说明型号和关键尺寸），上传到左侧资源库后再放入。现有可放入的模型：${have}`);
    }
    return hit;
  }

  async loadGltf(url) {
    if (!this.gltfCache.has(url)) this.gltfCache.set(url, loader.loadAsync(url).catch((error) => {
      this.gltfCache.delete(url);
      throw error;
    }));
    return (await this.gltfCache.get(url)).scene;
  }

  findPlaced(id) {
    if (this.placed.has(id)) return this.placed.get(id);
    const key = String(id ?? '').toLowerCase();
    const list = [...this.placed.values()];
    return list.find((p) => p.asset.id === id) ?? list.find((p) => p.asset.name.toLowerCase().includes(key) || key.includes(p.asset.name.toLowerCase()));
  }

  // Load a model, scale it to a sane size and stand it on the floor (or on a crane runway).
  // opts: x, y (mm) | bay + along (m); size (m, longest side); heading (deg); count; mount; elevation (m).
  async place(id, opts = {}) {
    const model = this.findModel(id);
    const site = this.app.site;
    if (opts.heading === undefined && opts.rotate !== undefined) opts = { ...opts, heading: opts.rotate };
    if (!site.isScene && !opts.add) for (const e of [...this.placed.values()].filter((p) => p.asset.id === model.id)) this.remove(e.key);
    const count = Math.max(1, Math.min(20, Math.round(Number(opts.count) || 1)));
    const mount = opts.mount === 'runway' ? 'runway' : 'floor';
    if (mount === 'runway' && !site.isScene) throw new Error('只有图纸生成的厂房里才能把模型装到行车轨道上');
    const template = await this.loadGltf(model.url);
    const box = new THREE.Box3().setFromObject(template);
    const dims = box.getSize(new THREE.Vector3());
    const longest = Math.max(dims.x, dims.y, dims.z) || 1;
    // Uploaded CAD often comes in millimetres; anything over 60 "m" is treated as mm.
    let k = longest > 60 ? 0.001 : 1;
    let heading = Number(opts.heading) || 0;
    let bay = null;
    let base = 0;
    let anchor;
    let spanNote;
    if (mount === 'runway') {
      bay = site.bay(opts.bay ?? site.bays[0]?.name);
      if (!bay) throw new Error(`没有 ${opts.bay} 跨，可选：${site.bays.map((b) => `${b.name} 跨`).join('、')}`);
      const crane = site.plant.cranes.find((c) => c.attrs.BAY === bay.name);
      const span = (Number(crane?.attrs.SPAN) || bay.span - 1100) / 1000 + 0.6;
      // Lay the model's long horizontal side across the bay. It keeps its own size: a model that
      // does not fit the rail span is reported, never stretched to fit.
      const horiz = Math.max(dims.x, dims.z) * (opts.size ? opts.size / longest : k);
      if (Math.abs(horiz / span - 1) > 0.03) spanNote = `模型横向 ${horiz.toFixed(2)} m，该跨轨道外缘约 ${span.toFixed(2)} m，相差 ${Math.round((horiz / span - 1) * 100)}%；按模型原尺寸放置，没有缩放，请核对这台设备的跨度是否对应这一跨`;
      const longAlongX = dims.x >= dims.z;
      const acrossIsWorldZ = site.alongX;
      if (opts.heading === undefined || opts.heading === null) heading = longAlongX === acrossIsWorldZ ? 90 : 0;
      base = opts.elevation ?? RAIL_TOP;
      anchor = opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : site.bayPoint(bay.name, opts.along ?? null);
      if (opts.along === undefined && opts.x === undefined && crane) anchor = site.alongX ? { x: crane.x, y: bay.centre } : { x: bay.centre, y: crane.y };
      site.setCraneHidden(bay.name, true);
    } else {
      base = opts.elevation ?? 0;
      if (opts.x !== undefined && opts.y !== undefined) anchor = { x: opts.x, y: opts.y };
      else if (site.isScene && (opts.bay || opts.along !== undefined)) anchor = site.bayPoint(opts.bay ?? site.bays[0]?.name, opts.along ?? null);
      else if (site.isScene) anchor = site.bayPoint(site.bays[Math.floor((site.bays.length - 1) / 2)]?.name ?? 'A', null);
      else {
        const centre = site.built.centre;
        anchor = { x: centre.x + (this.placed.size % 3) * 4000 - 4000, y: centre.y - site.built.size.y * 0.3 };
      }
    }
    if (opts.size) k = opts.size / longest;
    const sized = dims.clone().multiplyScalar(k);
    // Copies go in a row along the runway (scene) or along X, one footprint plus 1 m apart.
    const pitch = (Math.max(sized.x, sized.z) + 1) * 1000;
    const along = site.isScene && !site.alongX ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const results = [];
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * pitch;
      const at = { x: anchor.x + along.x * offset, y: anchor.y + along.y * offset };
      const root = new THREE.Group();
      const object = template.clone(true);
      object.scale.setScalar(k);
      const c = box.getCenter(new THREE.Vector3());
      object.position.set(-c.x * k, -box.min.y * k, -c.z * k);
      object.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      root.add(object);
      let n = 1;
      while (this.placed.has(n === 1 ? model.id : `${model.id}#${n}`)) n++;
      const key = n === 1 ? model.id : `${model.id}#${n}`;
      root.name = `asset:${key}`;
      const entry = { key, root, asset: model, x: at.x, y: at.y, heading, base, height: sized.y, mount, bay: bay?.name ?? null, size: +Math.max(sized.x, sized.y, sized.z).toFixed(2) };
      this.applyPose(entry);
      site.scene.add(root);
      this.placed.set(key, entry);
      results.push(entry);
    }
    if (model.source === '场景库' && this.ws && !this.switching) this.ws.addAsset(this.ws.active.id, model.id);
    if (!opts.quiet) {
      this.app.bump();
      this.app.toast(`已放入 ${model.name}${count > 1 ? ` × ${count}` : ''}${bay ? `（${bay.name} 跨行车轨道）` : ''}`);
    }
    this.app.renderDock?.();
    this.app.renderKpis?.();
    this.app.save?.();
    this.render();
    return {
      名称: model.name,
      来源: model.source,
      实例: results.map((e) => ({ id: e.key, x_mm: Math.round(e.x), y_mm: Math.round(e.y) })),
      尺寸_m: sized.toArray().map((v) => +v.toFixed(2)),
      朝向_deg: heading,
      安装: mount === 'runway' ? `${bay.name} 跨行车轨道，底面 ${base} m，已替换该跨示意行车` : `地面${base ? `，抬高 ${base} m` : ''}`,
      跨度提示: spanNote,
    };
  }

  applyPose(entry) {
    entry.root.position.set(entry.x / 1000, entry.base, -entry.y / 1000);
    entry.root.rotation.y = THREE.MathUtils.degToRad(entry.heading);
  }

  // Move / turn / resize a placed model. Absolute (x, y, heading, size) or relative (east, north, rotate).
  move(id, { x, y, east, north, heading, rotate, size, bay, along, elevation } = {}) {
    const entry = this.findPlaced(id);
    if (!entry) throw new Error(`场景里没有 ${id}。已放入：${this.placedList().map((p) => p.id).join('、') || '无'}`);
    const site = this.app.site;
    if (bay !== undefined || along !== undefined) {
      if (!site.isScene) throw new Error('按跨定位只在图纸生成的厂房里可用');
      const p = site.bayPoint(bay ?? entry.bay ?? site.bays[0]?.name, along ?? null);
      entry.x = p.x;
      entry.y = p.y;
      if (entry.mount === 'runway' && p.bay.name !== entry.bay) {
        site.setCraneHidden(entry.bay, false);
        site.setCraneHidden(p.bay.name, true);
        entry.bay = p.bay.name;
      }
    }
    if (x !== undefined) entry.x = x;
    if (y !== undefined) entry.y = y;
    if (east) entry.x += east * 1000;
    if (north) entry.y += north * 1000;
    if (heading !== undefined) entry.heading = heading;
    if (rotate) entry.heading = (entry.heading + rotate) % 360;
    if (elevation !== undefined) entry.base = elevation;
    if (size) {
      const object = entry.root.children[0];
      const k = size / entry.size;
      object.scale.multiplyScalar(k);
      object.position.multiplyScalar(k);
      entry.height *= k;
      entry.size = size;
    }
    this.applyPose(entry);
    this.app.bump();
    this.app.renderDock?.();
    this.app.save?.();
    return { id: entry.key, 名称: entry.asset.name, x_mm: Math.round(entry.x), y_mm: Math.round(entry.y), 朝向_deg: entry.heading, 底面高度_m: entry.base, 最长边_m: entry.size };
  }

  remove(id) {
    const entry = this.findPlaced(id);
    if (!entry) return false;
    entry.root.removeFromParent();
    this.placed.delete(entry.key);
    if (entry.mount === 'runway' && this.app.site.isScene && ![...this.placed.values()].some((p) => p.mount === 'runway' && p.bay === entry.bay)) this.app.site.setCraneHidden(entry.bay, false);
    this.app.renderDock?.();
    this.app.renderKpis?.();
    this.app.save?.();
    this.render();
    return entry.key;
  }

  clearPlaced() {
    const n = this.placed.size;
    for (const entry of this.placed.values()) entry.root.removeFromParent();
    this.placed.clear();
    this.app.save?.();
    this.render();
    return n;
  }

  // Register an uploaded model as a product so it shows in the product library.
  async registerProduct(idOrName, { model, name, category, params = {} } = {}) {
    const asset = this.find(idOrName);
    if (!asset || asset.kind !== 'model') throw new Error(`场景库里没有模型 ${idOrName}`);
    if (asset.status !== 'ready') throw new Error(`${asset.name} 还没有转换成功，不能入产品库`);
    const label = model ?? asset.name;
    const r = await getJson('/api/library/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: label, name: name ?? label, category: category ?? categoryOf(`${label} ${name ?? ''}`), modelAssetId: asset.id, params }),
    });
    await this.reload();
    if (this.ws && !this.switching && r.product) this.ws.addProduct(this.ws.active.id, r.product.id);
    this.persistSoon();
    return r.product;
  }

  // A converted drawing. Drawings with the Weihua layer convention (A-WALL / AGV-PATH / AGV-STAT)
  // replace the AGV + crane process plant; any other plant drawing is read for its columns, bays,
  // runway beams, walls and machines and built as a new plant, stage by stage. overlay=true only lays
  // the linework on the floor for reference.
  async loadSite(id, { quiet = false, overlay = false } = {}) {
    const asset = this.find(id);
    if (!asset || asset.kind !== 'site') throw new Error(`场景库里没有图纸 ${id}`);
    if (overlay) return this.loadOverlay(asset, { quiet });
    const dxfUrl = asset.meta?.dxfUrl ?? asset.meta?.originalDxfUrl;
    if (!dxfUrl) throw new Error(`${asset.name} 没有可用的 DXF`);
    const text = await fetch(dxfUrl).then((r) => {
      if (!r.ok) throw new Error(`读不到 ${asset.name} 的 DXF（${r.status}）`);
      return r.text();
    });
    const name = asset.originalName ?? asset.name;
    if (asset.meta?.convention === 'generic') return this.buildPlant(asset, text, name, null, { quiet });
    try {
      await this.loadDxf(text, name, asset.id, `图纸 ${asset.name} 无法生成工序`);
    } catch (error) {
      // Not a process drawing after all: build it as a plant instead.
      return this.buildPlant(asset, text, name, error.message, { quiet });
    }
    if (this.ws && !this.switching) this.ws.addAsset(this.ws.active.id, asset.id);
    if (!quiet) this.app.toast(`已载入图纸 ${asset.name}`);
    this.app.save?.();
    return { 图纸: asset.name, 模式: 'AGV + 行车工序', 工序数: this.app.site.process.steps.length };
  }

  // Back to the built-in sample plant (a new scene starts from it).
  loadSample() {
    const s = this.app.sampleDxf;
    if (!s) throw new Error('示例厂房没有加载');
    return this.loadDxf(s.text, s.name, null, '示例厂房无法生成工序');
  }

  async loadDxf(text, name, drawingId, failMsg) {
    const app = this.app;
    if (app.site.isScene) app.exitScene();
    const prev = app.baseDxf;
    try {
      await app.site.loadBase(text, name);
      app.baseDxf = { text, name };
    } catch (error) {
      if (prev) await app.site.loadBase(prev.text, prev.name);
      throw new Error(`${failMsg}：${error.message}`);
    }
    this.drawing = drawingId;
    this.processDrawing = drawingId;
    for (const { root } of this.placed.values()) app.site.scene.add(root);
    this.removeOverlay();
    app.refresh();
    app.setView('overview');
    app.bump();
  }

  // Generate a plant from a drawing and play its construction (地坪→立柱→吊车梁→行车→围护→设备→屋面).
  async buildPlant(asset, text, name, note, { quiet = false } = {}) {
    this.removeOverlay();
    const r = await this.app.enterScene(text, name, asset);
    this.drawing = asset.id;
    if (this.ws && !this.switching) this.ws.addAsset(this.ws.active.id, asset.id);
    if (!quiet) this.app.toast(`已按图纸 ${asset.name} 生成厂房，正在分步播放建造过程`);
    this.app.save?.();
    this.render();
    return {
      图纸: asset.name,
      模式: '图纸生成厂房（建造动画）',
      识别: r.summary,
      建造步骤: r.steps.map((s) => `${s.n} ${s.title} ${s.duration}s`),
      清空了之前放入的模型: r.cleared || undefined,
      说明: note ? `图纸不含工序图层（${note}），按普通厂房图生成` : undefined,
    };
  }

  // Leaving a generated plant puts the AGV + crane plant (and its drawing) back.
  sceneExited() {
    this.drawing = this.processDrawing;
    this.app.save?.();
    this.render();
  }

  // A 2D equipment drawing (DXF/DWG in the scene library) read into views, dimensions and outlines.
  async readDrawing(idOrName) {
    const asset = this.find(idOrName);
    if (!asset || asset.kind !== 'site') throw new Error(`场景库里没有图纸 ${idOrName}。现有图纸：${this.assets.filter((a) => a.kind === 'site').map((a) => a.name).join('、') || '无'}`);
    const dxfUrl = asset.meta?.dxfUrl ?? asset.meta?.originalDxfUrl;
    if (!dxfUrl) throw new Error(`${asset.name} 没有可用的 DXF（${asset.message ?? asset.status}）`);
    const text = await fetch(dxfUrl).then((r) => {
      if (!r.ok) throw new Error(`读不到 ${asset.name} 的 DXF（${r.status}）`);
      return r.text();
    });
    const read = readEquipment(text, asset.originalName ?? asset.name);
    // Outline ids are unique per drawing only, so a later drawing overrides an earlier one.
    Object.assign(this.profiles, read.geometry);
    this.drawings.set(asset.id, read);
    return { asset, ...read };
  }

  // Reference pictures from the scene library, downscaled to JPEG data URLs for the vision model.
  async imageData(names, max = 1024) {
    const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
    const images = list.length ? list.map((n) => this.find(n)) : this.assets.filter((a) => a.kind === 'image');
    const missing = list.filter((n, i) => !images[i] || images[i].kind !== 'image');
    if (missing.length) throw new Error(`场景库里没有图片 ${missing.join('、')}。现有图片：${this.assets.filter((a) => a.kind === 'image').map((a) => a.name).join('、') || '无'}`);
    if (!images.length) throw new Error('场景库里还没有图片，请先上传设备的参考图片');
    const out = [];
    for (const a of images.slice(0, 4)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = a.url;
      await img.decode();
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      out.push({ name: a.name, size: [img.naturalWidth, img.naturalHeight], url: canvas.toDataURL('image/jpeg', 0.85) });
    }
    return out;
  }

  // Build an equipment model from a parts spec, store it as GLB in the scene library and
  // optionally register it as a product. A rebuild under the same name replaces this session's
  // earlier version and swaps any placed copies.
  async buildModel(spec, { register = true, category, label } = {}) {
    const { group, report } = buildFromSpec(spec, this.profiles);
    const blob = await exportGlb(group);
    const file = new File([blob], fileName(report.名称), { type: 'model/gltf-binary' });
    const prev = this.builtModels.get(report.名称);
    const { assets: added } = await this.upload([file]);
    const asset = added.find((a) => a.kind === 'model' && a.status !== 'failed' && a.status !== 'unsupported');
    if (!asset) throw new Error(`模型已生成，但存入场景库失败：${added[0]?.message ?? '上传没有返回资源'}`);
    let product = null;
    if (register) {
      product = await this.registerProduct(asset.id, {
        model: report.名称,
        name: label ?? spec.label ?? report.名称,
        category: category ?? spec.category,
        // The product store takes numeric ranges only: record the overall size as fixed values.
        params: Object.fromEntries([['length', '总长', report.外形_mm.长], ['width', '总宽', report.外形_mm.宽], ['height', '总高', report.外形_mm.高]]
          .map(([key, l, v]) => [key, { label: `${l}（${report.外形_mm.来源}）`, min: v, nominal: v, max: v }])),
      });
    }
    const replaced = [];
    if (prev) {
      for (const entry of [...this.placed.values()].filter((p) => p.asset.id === prev.assetId || p.asset.id === prev.productId)) {
        const { x, y, heading, base, mount, bay } = entry;
        this.remove(entry.key);
        await this.place(product?.id ?? asset.id, { x, y, heading, elevation: base, mount, bay });
        replaced.push(entry.key);
      }
      await fetch(`/api/library/scene/${prev.assetId}`, { method: 'DELETE' }).catch(() => {});
      if (prev.productId) await fetch(`/api/library/products/${prev.productId}`, { method: 'DELETE' }).catch(() => {});
      await this.reload();
    }
    this.builtModels.set(report.名称, { assetId: asset.id, productId: product?.id ?? null });
    return { ...report, 场景库id: asset.id, 产品库id: product?.id ?? null, 替换了旧版本: prev ? true : undefined, 已同步替换场景中的实例: replaced.length ? replaced : undefined };
  }

  placedList() {
    return [...this.placed.values()].map((p) => ({ id: p.key, 名称: p.asset.name, 来源: p.asset.source, x_mm: Math.round(p.x), y_mm: Math.round(p.y), 朝向_deg: p.heading, 安装: p.mount === 'runway' ? `${p.bay} 跨行车轨道` : '地面', 最长边_m: p.size }));
  }

  // Draw the converted linework (mm) just above the floor, centred on the current plant.
  async loadOverlay(asset, { quiet = false } = {}) {
    if (!asset.url) throw new Error(`${asset.name} 没有可用的底图数据`);
    const data = await getJson(asset.url);
    const box = data.bbox;
    if (!box || !data.lines?.length) throw new Error(`${asset.name} 里没有可用的线条`);
    const site = this.app.site;
    const centre = site.built.centre;
    const dx = centre.x - (box.minX + box.maxX) / 2;
    const dy = centre.y - (box.minY + box.maxY) / 2;
    const byLayer = new Map();
    for (const line of data.lines) {
      const pts = line.points;
      const arr = byLayer.get(line.layer) ?? [];
      const n = line.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        arr.push((a.x + dx) / 1000, 0, -(a.y + dy) / 1000, (b.x + dx) / 1000, 0, -(b.y + dy) / 1000);
      }
      byLayer.set(line.layer, arr);
    }
    const palette = [0x2f4f6f, 0xc0392b, 0x7f8c8d, 0x1e8449, 0x8e44ad, 0xb9770e];
    const root = new THREE.Group();
    root.name = `overlay:${asset.id}`;
    root.position.y = 0.04;
    [...byLayer.values()].forEach((arr, i) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({ color: palette[i % palette.length], transparent: true, opacity: 0.85 });
      root.add(new THREE.LineSegments(geo, mat));
    });
    this.removeOverlay();
    site.scene.add(root);
    this.overlay = { root, asset };
    if (this.ws && !this.switching) this.ws.addAsset(this.ws.active.id, asset.id);
    this.app.bump();
    const w = ((box.maxX - box.minX) / 1000).toFixed(0);
    const h = ((box.maxY - box.minY) / 1000).toFixed(0);
    if (!quiet) this.app.toast(`${asset.name} 没有工位/AGV 图层，已叠为底图参考（${data.lines.length} 条线，约 ${w}×${h} m），工序沿用当前厂房`);
    this.app.save?.();
    this.render();
    return { 底图: asset.name, 线条数: data.lines.length, 尺寸_m: [+w, +h], 说明: '图纸不含 A-WALL/AGV-PATH/AGV-STAT 图层，不能生成工序' };
  }

  removeOverlay() {
    if (!this.overlay) return false;
    this.overlay.root.removeFromParent();
    this.overlay.root.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.overlay = null;
    this.app.bump();
    this.app.save?.();
    this.render();
    return true;
  }

  // Summary for the agent: what the standard library has and what the open project holds.
  summary() {
    const ws = this.ws;
    const p = ws.active;
    return {
      标准产品库: this.std.map((x) => ({ id: x.id, 型号: x.model ?? x.name, 类别: x.category })),
      当前项目: p.name,
      当前场景: ws.activeScene.name,
      项目产品库: p.products.map((e) => ({ id: e.productId, 名称: e.name ?? this.product(e.productId)?.model ?? e.productId, 定制: Boolean(this.product(e.productId)?.baseProduct) })),
      项目场景: p.scenes.map((s) => s.name),
      项目文件: p.assets.map((id) => this.asset(id)).filter(Boolean).map((a) => ({ id: a.id, 名称: a.name, 类型: a.kind, 可用: Library.usable(a), 图纸类型: a.kind === 'site' ? (a.meta?.convention === 'generic' ? '普通厂房图（生成厂房）' : '工序图纸') : undefined })),
      其他项目: ws.projects.filter((x) => x.id !== p.id).map((x) => x.name),
    };
  }
}
