// Left column resource library: product library (selectable vehicles) and scene library
// (uploads converted by the backend into GLB / site JSON that three.js can load).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CATALOG } from '../../demo/src/catalog.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const KIND = { model: '模型', site: '图纸', image: '图片', document: '文档' };
const loader = new GLTFLoader();

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

export class Library {
  constructor(app) {
    this.app = app;
    this.tab = 'products';
    this.products = [];
    this.assets = [];
    this.placed = new Map(); // asset id -> { root, asset }
    this.online = false;
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

  render() {
    const app = this.app;
    if (this.tab === 'products') {
      $('libBody').innerHTML = this.products.map((p) => {
        const usable = CATALOG.some((c) => c.id === p.id);
        const on = app.product?.id === p.id;
        return `<div class="item"><span class="th" style="${p.thumbnail ? `background-image:url(${esc(p.thumbnail)})` : ''}">${p.thumbnail ? '' : 'AGV'}</span><b>${esc(p.model ?? p.name)}</b><small>${esc(p.name ?? p.category ?? '')}</small><button class="go ${on ? 'on' : ''}" data-product="${esc(p.id)}" ${usable ? '' : 'disabled title="暂无三维模型"'}>${on ? '使用中' : '选用'}</button></div>`;
      }).join('') || '<div class="empty">产品库为空</div>';
      return;
    }
    if (!this.assets.length) {
      $('libBody').innerHTML = `<div class="empty">${this.online ? '还没有上传文件' : '后端未连接，暂不能上传'}</div>`;
      return;
    }
    $('libBody').innerHTML = [...this.assets].reverse().map((a) => {
      const ok = a.status === 'ready' || (a.url && a.status !== 'failed' && a.status !== 'unsupported');
      let act = '';
      if (ok && a.kind === 'model') act = this.placed.has(a.id) ? `<button class="go on" data-remove="${a.id}">移出</button>` : `<button class="go" data-place="${a.id}">放入场景</button>`;
      else if (ok && a.kind === 'site') act = `<button class="go" data-site="${a.id}">载入</button>`;
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
      else if (b.dataset.remove) this.remove(b.dataset.remove);
      else if (b.dataset.site) await this.loadSite(b.dataset.site);
    } catch (error) {
      app.toast(error.message, true);
    }
    this.render();
  }

  async upload(files) {
    if (!files.length) return;
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
    } catch (error) {
      this.app.toast(`上传失败：${error.message}`, true);
    } finally {
      drop.classList.remove('busy');
    }
  }

  find(idOrName) {
    const key = String(idOrName).toLowerCase();
    return this.assets.find((a) => a.id === idOrName) ?? this.assets.find((a) => a.name.toLowerCase().includes(key));
  }

  // Load the converted GLB, scale it to a sane size and stand it on the floor near (x, y) mm.
  async place(id, { x, y, size } = {}) {
    const asset = this.find(id);
    if (!asset) throw new Error(`场景库里没有 ${id}`);
    if (asset.kind !== 'model' || !asset.url) throw new Error(`${asset.name} 不是可放入场景的模型`);
    this.remove(asset.id);
    const gltf = await loader.loadAsync(asset.url);
    const root = new THREE.Group();
    root.name = `asset:${asset.id}`;
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const dims = box.getSize(new THREE.Vector3());
    const longest = Math.max(dims.x, dims.y, dims.z) || 1;
    // Uploaded CAD often comes in millimetres; anything over 60 "m" is treated as mm.
    let k = longest > 60 ? 0.001 : 1;
    if (size) k = size / longest;
    model.scale.setScalar(k);
    const c = box.getCenter(new THREE.Vector3());
    model.position.set(-c.x * k, -box.min.y * k, -c.z * k);
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    root.add(model);
    const site = this.app.site;
    const centre = site.built.centre;
    const px = x ?? centre.x + (this.placed.size % 3) * 4000 - 4000;
    const py = y ?? centre.y - site.built.size.y * 0.3;
    root.position.set(px / 1000, 0, -py / 1000);
    site.scene.add(root);
    this.placed.set(asset.id, { root, asset, x: px, y: py, height: dims.y * k });
    this.app.bump();
    this.app.toast(`已放入 ${asset.name}`);
    this.app.save?.();
    this.render();
    return { 名称: asset.name, x_mm: Math.round(px), y_mm: Math.round(py), 尺寸_m: dims.multiplyScalar(k).toArray().map((v) => +v.toFixed(2)) };
  }

  remove(id) {
    const entry = this.placed.get(id) ?? [...this.placed.values()].find((p) => p.asset.name.includes(id));
    if (!entry) return false;
    entry.root.removeFromParent();
    this.placed.delete(entry.asset.id);
    this.render();
    return true;
  }

  // A converted drawing replaces the site; if it does not carry the AGV-STAT conventions we
  // put the previous drawing back so the scene never ends up half built.
  async loadSite(id) {
    const asset = this.find(id);
    if (!asset || asset.kind !== 'site') throw new Error(`场景库里没有图纸 ${id}`);
    const dxfUrl = asset.meta?.dxfUrl ?? asset.meta?.originalDxfUrl;
    if (!dxfUrl) throw new Error(`${asset.name} 没有可用的 DXF`);
    const text = await fetch(dxfUrl).then((r) => r.text());
    const app = this.app;
    const prev = app.baseDxf;
    try {
      await app.site.loadBase(text, asset.originalName ?? asset.name);
      app.baseDxf = { text, name: asset.originalName ?? asset.name };
      document.getElementById('source').textContent = asset.name;
    } catch (error) {
      if (prev) await app.site.loadBase(prev.text, prev.name);
      throw new Error(`图纸 ${asset.name} 无法生成工序：${error.message}`);
    }
    for (const { root } of this.placed.values()) app.site.scene.add(root);
    app.refresh();
    app.setView('overview');
    app.bump();
    app.toast(`已载入图纸 ${asset.name}`);
    return { 图纸: asset.name, 工序数: app.site.process.steps.length };
  }

  placedList() {
    return [...this.placed.values()].map((p) => ({ id: p.asset.id, 名称: p.asset.name, x_mm: Math.round(p.x), y_mm: Math.round(p.y) }));
  }
}
