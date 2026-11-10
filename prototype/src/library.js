// Left column resource library: product library (selectable vehicles and registered product
// models) and scene library (uploads converted by the backend into GLB / site JSON).
// Models from either library can be placed into the plant any number of times.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG } from '../../demo/src/catalog.js';
import { readEquipment } from '../../demo/src/scene/read-equipment.js';
import { buildFromSpec, exportGlb, fileName } from './model-builder.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const KIND = { model: '模型', site: '图纸', image: '图片', document: '文档' };
const RAIL_TOP = 9.85; // top of the runway beam in a generated plant, metres
const loader = new GLTFLoader();

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

export class Library {
  constructor(app) {
    this.app = app;
    this.tab = 'products';
    this.products = [];
    this.assets = [];
    this.placed = new Map(); // instance key -> { key, root, asset, x, y, heading, base, height, mount, bay }
    this.gltfCache = new Map();
    this.online = false;
    this.drawings = new Map(); // drawing asset id -> { summary, geometry } from readEquipment
    this.profiles = {}; // outline id -> points (mm), from every equipment drawing read so far
    this.builtModels = new Map(); // model name -> { assetId, productId } built in this session
  }

  async init() {
    $('libTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lib]');
      if (b) this.show(b.dataset.lib);
    });
    $('libBody').addEventListener('click', (e) => this.onClick(e));
    const drop = $('drop');
    $('fileInput').addEventListener('change', (e) => {
      this.upload([...e.target.files]);
      e.target.value = '';
    });
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      this.upload([...e.dataTransfer.files]);
    });
    await this.reload();
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
    if (!this.products.length) this.products = CATALOG.map((c) => ({ id: c.id, model: c.model, name: c.name, summary: c.summary }));
    try {
      this.assets = (await getJson('/api/library/scene')).assets ?? [];
    } catch {
      this.assets = [];
    }
    this.render();
  }

  show(tab) {
    this.tab = tab;
    for (const b of $('libTabs').children) b.classList.toggle('on', b.dataset.lib === tab);
    this.render();
  }

  placedCount(id) {
    return [...this.placed.values()].filter((p) => p.asset.id === id).length;
  }

  render() {
    const app = this.app;
    const scene = app.site?.isScene;
    const back = scene ? `<div class="item"><span class="th">↩</span><b>${esc(app.site.sourceName)}</b><small>图纸生成的厂房</small><button class="go" data-exit>返回原方案</button></div>` : '';
    if (this.tab === 'products') {
      $('libBody').innerHTML = back + (this.products.map((p) => {
        const selectable = CATALOG.some((c) => c.id === p.id) && !scene;
        const on = app.product?.id === p.id;
        const n = this.placedCount(p.id);
        let act;
        if (selectable) act = `<button class="go ${on ? 'on' : ''}" data-product="${esc(p.id)}">${on ? '使用中' : '选用'}</button>`;
        else if (p.modelUrl) act = `<button class="go" data-place="${esc(p.id)}">${n ? `再放一个 · ${n}` : '放入场景'}</button>`;
        else act = '<button class="go" disabled title="暂无三维模型">选用</button>';
        const thumb = p.thumbUrl ?? p.thumbnail;
        return `<div class="item"><span class="th" style="${thumb ? `background-image:url(${esc(thumb)})` : ''}">${thumb ? '' : esc((p.category ?? 'AGV').slice(0, 4).toUpperCase())}</span><b>${esc(p.model ?? p.name)}</b><small>${esc(p.name ?? p.category ?? '')}</small>${act}</div>`;
      }).join('') || '<div class="empty">产品库为空</div>');
      return;
    }
    if (!this.assets.length) {
      $('libBody').innerHTML = back + `<div class="empty">${this.online ? '还没有上传文件' : '后端未连接，暂不能上传'}</div>`;
      return;
    }
    $('libBody').innerHTML = back + [...this.assets].reverse().map((a) => {
      const ok = a.status === 'ready' || (a.url && a.status !== 'failed' && a.status !== 'unsupported');
      let act = '';
      const n = this.placedCount(a.id);
      if (ok && a.kind === 'model') act = `<button class="go" data-place="${a.id}">${n ? `再放一个 · ${n}` : '放入场景'}</button>`;
      else if (ok && a.kind === 'site') {
        const current = app.site?.asset?.id === a.id;
        act = a.meta?.convention === 'generic'
          ? `<button class="go ${current ? 'on' : ''}" data-site="${a.id}" title="按图纸识别柱网、跨、吊车梁、墙和设备，生成三维厂房并播放建造过程">${current ? '重新建造' : '生成厂房'}</button>`
          : `<button class="go" data-site="${a.id}">载入</button>`;
        act = `<span class="btns">${act}<button class="go sub" data-model-from="${a.id}" title="这是一张设备图（起重机、大车等）：交给小华读图，按图纸尺寸建三维模型">设备建模</button></span>`;
      }
      const thumb = a.thumbUrl ? `background-image:url(${esc(a.thumbUrl)})` : '';
      const sub = ok ? `${KIND[a.kind] ?? a.kind} · ${esc(a.meta?.formatName ?? a.originalFormat)}` : esc(a.message || '无法识别');
      return `<div class="item ${ok ? '' : 'err'}" title="${esc(a.message ?? '')}"><span class="th" style="${thumb}">${thumb ? '' : esc(a.originalFormat ?? '')}</span><b>${esc(a.name)}</b><small>${sub}</small>${act}</div>`;
    }).join('');
  }

  async onClick(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const app = this.app;
    try {
      if (b.dataset.product) {
        await app.selectProduct(b.dataset.product);
        app.bump();
        app.toast(`已选用 ${app.product.model}`);
      } else if (b.dataset.place) await this.place(b.dataset.place);
      else if (b.dataset.site) await this.loadSite(b.dataset.site);
      else if (b.dataset.modelFrom) {
        const a = this.find(b.dataset.modelFrom);
        const pics = this.assets.filter((x) => x.kind === 'image' && x.url).map((x) => x.name);
        if (!app.agent?.busy) app.agent?.send(`按设备图纸「${a.name}」建三维模型${pics.length ? `，外观参考图片：${pics.join('、')}` : ''}`);
      }
      else if (b.dataset.exit !== undefined) {
        app.exitScene();
        app.toast('已返回原 AGV + 行车方案');
      }
    } catch (error) {
      app.toast(error.message, true);
    }
    this.render();
  }

  async upload(files) {
    if (!files.length) return [];
    const drop = $('drop');
    drop.classList.add('busy');
    this.app.toast(`正在上传并转换 ${files.length} 个文件…`);
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      const r = await getJson('/api/library/scene', { method: 'POST', body: form });
      const added = r.assets ?? (r.asset ? [r.asset] : []);
      const bad = added.filter((a) => a.status === 'failed' || a.status === 'unsupported');
      this.app.toast(bad.length ? `${added.length - bad.length} 个已入库，${bad.length} 个失败：${bad[0].message}` : `${added.length} 个文件已存入场景库`, bad.length > 0);
      await this.reload();
      this.show('scene');
      return added;
    } catch (error) {
      this.app.toast(`上传失败：${error.message}`, true);
      return [];
    } finally {
      drop.classList.remove('busy');
    }
  }

  find(idOrName) {
    const key = String(idOrName).toLowerCase();
    return this.assets.find((a) => a.id === idOrName) ?? this.assets.find((a) => a.name.toLowerCase().includes(key));
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
    this.app.bump();
    this.app.toast(`已放入 ${model.name}${count > 1 ? ` × ${count}` : ''}${bay ? `（${bay.name} 跨行车轨道）` : ''}`);
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
    this.render();
    return entry.key;
  }

  clearPlaced() {
    const n = this.placed.size;
    for (const entry of this.placed.values()) entry.root.removeFromParent();
    this.placed.clear();
    this.render();
    return n;
  }

  // Register an uploaded model as a product so it shows in the product library.
  async addProduct(idOrName, { model, name, category, params = {} } = {}) {
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
    this.show('products');
    return r.product;
  }

  // A converted drawing. Drawings with the Weihua layer convention drive the AGV + crane process;
  // any other plant drawing is read for its columns, bays and walls and built as a new plant.
  async loadSite(id) {
    const asset = this.find(id);
    if (!asset || asset.kind !== 'site') throw new Error(`场景库里没有图纸 ${id}`);
    const dxfUrl = asset.meta?.dxfUrl ?? asset.meta?.originalDxfUrl;
    if (!dxfUrl) throw new Error(`${asset.name} 没有可用的 DXF`);
    const text = await fetch(dxfUrl).then((r) => {
      if (!r.ok) throw new Error(`读不到 ${asset.name} 的 DXF（${r.status}）`);
      return r.text();
    });
    const app = this.app;
    const name = asset.originalName ?? asset.name;
    if (asset.meta?.convention === 'generic') return this.buildPlant(asset, text, name);
    if (app.site.isScene) app.exitScene();
    const prev = app.baseDxf;
    try {
      await app.site.loadBase(text, name);
      app.baseDxf = { text, name };
      document.getElementById('source').textContent = asset.name;
    } catch (error) {
      if (prev) await app.site.loadBase(prev.text, prev.name);
      // Not a process drawing after all: build it as a plant instead.
      return this.buildPlant(asset, text, name, error.message);
    }
    for (const { root } of this.placed.values()) app.site.scene.add(root);
    app.refresh();
    app.setView('overview');
    app.bump();
    app.toast(`已载入图纸 ${asset.name}`);
    this.render();
    return { 图纸: asset.name, 模式: 'AGV + 行车工序', 工序数: app.site.process.steps.length };
  }

  async buildPlant(asset, text, name, note) {
    const r = await this.app.enterScene(text, name, asset);
    this.app.toast(`已按图纸 ${asset.name} 生成厂房，正在播放建造过程`);
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
    const added = await this.upload([file]);
    const asset = added.find((a) => a.kind === 'model' && a.status !== 'failed' && a.status !== 'unsupported');
    if (!asset) throw new Error(`模型已生成，但存入场景库失败：${added[0]?.message ?? '上传没有返回资源'}`);
    let product = null;
    if (register) {
      product = await this.addProduct(asset.id, {
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
    this.show(product ? 'products' : 'scene');
    return { ...report, 场景库id: asset.id, 产品库id: product?.id ?? null, 替换了旧版本: prev ? true : undefined, 已同步替换场景中的实例: replaced.length ? replaced : undefined };
  }

  placedList() {
    return [...this.placed.values()].map((p) => ({ id: p.key, 名称: p.asset.name, 来源: p.asset.source, x_mm: Math.round(p.x), y_mm: Math.round(p.y), 朝向_deg: p.heading, 安装: p.mount === 'runway' ? `${p.bay} 跨行车轨道` : '地面', 最长边_m: p.size }));
  }
}
