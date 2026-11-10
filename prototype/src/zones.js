// 区域标注: named areas and points on the floor of any scene (原材料存储区, 1#气垫炉上线点 …),
// shown with the same white label + coloured dot as the process points, coloured by what the
// name says. Three ways in: read from the drawing (TEXT entities or exploded-curve text via OCR),
// 小华's tools, or by hand (click the floor). Markers are kept per scene.
import * as THREE from 'three';

export const ZONE_KINDS = [
  { key: 'buffer', label: '暂存 / 缓存', color: '#F5B800', test: /暂存|缓存|缓冲|待料|暂放|周转/ },
  { key: 'charge', label: '充电', color: '#2EA121', test: /充电|换电/ },
  { key: 'handoff', label: '吊装 / 交接', color: '#D7000F', test: /吊装|交接/ },
  { key: 'in', label: '上线 / 上料 / 入库', color: '#2B7DE9', test: /上线|上料|入库|入口|来料|进料|收货/ },
  { key: 'out', label: '下线 / 出库 / 成品', color: '#1F2329', test: /下线|下料|出库|出口|成品|发货/ },
  { key: 'inspect', label: '检验', color: '#8E44AD', test: /检验|质检|检测|检查|试验/ },
  { key: 'storage', label: '存储 / 库区', color: '#13A8A8', test: /存储|仓|库|料场|堆场|货位|货架/ },
  { key: 'process', label: '工艺 / 产线', color: '#E8710A', test: /线|炉|冷却|加工|机|工位|车间|焊|涂|装配|酸洗|轧/ },
  { key: 'area', label: '其他区域', color: '#5B6B7F', test: /./ },
];
const KIND = Object.fromEntries(ZONE_KINDS.map((k) => [k.key, k]));
const ZONE_END = /(区|点|位|线|炉|库|仓|台|间|房|站|口|场|段|处|架|坑|道)$/;
const STORE = 'weihua.zones.v1';

export function classifyZone(name) {
  return ZONE_KINDS.find((k) => k.test.test(String(name ?? ''))).key;
}
// A point (…点 / …位) gets a round dot, an area a square one.
export const shapeOf = (name) => (/[点位]$/.test(String(name ?? '')) ? 'point' : 'area');

// Is a piece of drawing text the name of a zone/point (rather than a dimension or title-block note)?
export function isZoneName(text) {
  const t = String(text ?? '').trim();
  return t.length >= 2 && t.length <= 20 && /[一-龥]/.test(t) && (ZONE_END.test(t) || t.includes('区'));
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CSS = `
.pin.zone{pointer-events:auto;cursor:pointer}
.pin.zone.area .dot{border-radius:3px}
.pin.zone.sel .lab{outline:2px solid var(--yellow)}
body.zone-placing canvas{cursor:crosshair}
.zpanel{position:absolute;z-index:40;width:300px;padding:10px 12px;font-size:12.5px;color:var(--ink)}
.zpanel h5{margin:0 0 8px;font-size:13px;display:flex;align-items:center;gap:6px}
.zpanel h5 .x{margin-left:auto;color:var(--ink3);font-size:15px;line-height:1}
.zpanel .row{display:flex;gap:6px;margin-bottom:8px}
.zpanel .row button{flex:1;padding:5px 6px;border:1px solid rgba(31,35,41,.14);border-radius:var(--r);background:#fff;color:var(--ink)}
.zpanel .row button.on{background:var(--red);border-color:var(--red);color:#fff}
.zpanel .row button:disabled{opacity:.5}
.zpanel .legend{display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--ink2);font-size:11.5px;margin-bottom:6px}
.zpanel .legend i,.zpanel .zl i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:-1px}
.zpanel .zl{max-height:220px;overflow:auto;border-top:1px solid var(--line)}
.zpanel .zl div{display:flex;align-items:center;gap:4px;padding:4px 2px;border-bottom:1px solid var(--line);cursor:pointer}
.zpanel .zl div:hover{background:var(--surface2)}
.zpanel .zl small{margin-left:auto;color:var(--ink3)}
.zpanel .zl .del{color:var(--ink3);padding:0 4px}
.zpanel .zl .del:hover{color:var(--red)}
.zpanel .muted{color:var(--ink3);padding:6px 0}
.zedit{position:absolute;z-index:41;width:240px;padding:10px;font-size:12.5px}
.zedit input,.zedit select{width:100%;box-sizing:border-box;margin-bottom:6px;padding:5px 6px;border:1px solid rgba(31,35,41,.18);border-radius:var(--r);font:inherit}
.zedit .row{display:flex;gap:6px}
.zedit .row button{flex:1;padding:5px 0;border:1px solid rgba(31,35,41,.14);border-radius:var(--r);background:#fff}
.zedit .row button.ok{background:var(--red);border-color:var(--red);color:#fff}
.zedit .row button.del{color:var(--red)}
`;

export class ZoneMarkers {
  constructor(app) {
    this.app = app;
    this.all = this.load();
    this.key = null;
    this.placing = false;
    this.moving = null; // marker id being moved by the next floor click
    this.selected = null;
    this.ui();
  }

  // ---------------------------------------------------------------- data

  sceneKey() {
    return this.app.library?.ws?.activeScene?.id ?? 'default';
  }

  get list() {
    const key = this.sceneKey();
    if (key !== this.key) {
      this.key = key;
      this.closeEditor();
      this.renderPanel();
    }
    this.all[key] ??= [];
    return this.all[key];
  }

  load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE) ?? '{}');
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.all));
    } catch { /* storage blocked: markers live for this session only */ }
    this.renderPanel();
    this.app.bump?.();
  }

  find(ref) {
    const r = String(ref ?? '').trim();
    if (!r) return null;
    return this.list.find((z) => z.id.toLowerCase() === r.toLowerCase()) ?? this.list.find((z) => z.name === r) ?? this.list.find((z) => z.name.includes(r)) ?? null;
  }

  nextId() {
    const used = new Set(this.list.map((z) => z.id));
    let n = this.list.length + 1;
    while (used.has(`Z-${String(n).padStart(2, '0')}`)) n++;
    return `Z-${String(n).padStart(2, '0')}`;
  }

  add({ name, kind, x, y, source = '手动', from = null }) {
    const clean = String(name ?? '').trim().slice(0, 30);
    if (!clean) throw new Error('区域名称不能为空');
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要位置（x_mm / y_mm，或参考点位 at）');
    if (kind && !KIND[kind]) throw new Error(`类型只能是 ${ZONE_KINDS.map((k) => k.key).join(' / ')}`);
    const marker = { id: this.nextId(), name: clean, kind: kind || classifyZone(clean), shape: shapeOf(clean), x: Math.round(x), y: Math.round(y), source, from };
    this.list.push(marker);
    this.save();
    return marker;
  }

  update(ref, patch) {
    const z = this.find(ref);
    if (!z) throw new Error(`没有区域标注 ${ref}`);
    if (patch.name != null) {
      const clean = String(patch.name).trim().slice(0, 30);
      if (!clean) throw new Error('区域名称不能为空');
      if (z.kind === classifyZone(z.name) && !patch.kind) z.kind = classifyZone(clean);
      z.name = clean;
      z.shape = shapeOf(clean);
    }
    if (patch.kind) {
      if (!KIND[patch.kind]) throw new Error(`类型只能是 ${ZONE_KINDS.map((k) => k.key).join(' / ')}`);
      z.kind = patch.kind;
    }
    if (Number.isFinite(patch.x)) z.x = Math.round(patch.x);
    if (Number.isFinite(patch.y)) z.y = Math.round(patch.y);
    this.save();
    return z;
  }

  remove(ref) {
    const z = this.find(ref);
    if (!z) return null;
    this.list.splice(this.list.indexOf(z), 1);
    if (this.selected === z.id) this.selected = null;
    this.save();
    return z;
  }

  clear(source) {
    const keep = source ? this.list.filter((z) => z.source !== source) : [];
    const n = this.list.length - keep.length;
    this.all[this.sceneKey()] = keep;
    this.save();
    return n;
  }

  summary() {
    return this.list.map((z) => ({ id: z.id, 名称: z.name, 类型: KIND[z.kind]?.label ?? z.kind, x_mm: z.x, y_mm: z.y, 来源: z.source }));
  }

  // ---------------------------------------------------------------- from the drawing

  // The drawing in the scene (the floor overlay, or the base drawing) and how its mm map onto ours.
  drawingInScene(ref) {
    const lib = this.app.library;
    const overlay = lib?.overlay?.asset;
    const base = lib?.drawing ? lib.find?.(lib.drawing) : null;
    const want = ref ? lib?.find?.(ref) : overlay ?? base;
    if (!want) throw new Error(ref ? `场景库里没有图纸 ${ref}` : '场景里还没有图纸：先在场景库载入图纸或把图纸叠为底图');
    if (overlay && want.id === overlay.id) return { asset: want, overlay: true };
    if (base && want.id === base.id) return { asset: want, overlay: false };
    throw new Error(`${want.name} 不在当前场景里：先载入或叠为底图，再识别区域`);
  }

  async readFromDrawing(ref) {
    const { asset, overlay } = this.drawingInScene(ref);
    this.app.toast?.(`正在识别 ${asset.name} 上的区域名称…（炸开的曲线字需要 OCR，首次约 10 秒）`);
    const r = await fetch(`/api/library/scene/${encodeURIComponent(asset.id)}/text`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `读取图纸文字失败 ${r.status}`);
    let dx = 0;
    let dy = 0;
    if (overlay) {
      const off = this.app.library.overlay.offset;
      if (off) ({ dx, dy } = off);
      else if (data.bbox) {
        const c = this.app.site.built.centre;
        dx = c.x - (data.bbox.minX + data.bbox.maxX) / 2;
        dy = c.y - (data.bbox.minY + data.bbox.maxY) / 2;
      }
    }
    const names = data.texts.filter((t) => isZoneName(t.text));
    const before = this.list.filter((z) => z.from === asset.id).length;
    this.all[this.sceneKey()] = this.list.filter((z) => z.from !== asset.id);
    const added = names.map((t) => this.add({ name: t.text.trim(), x: t.x + dx, y: t.y + dy, source: '图纸识别', from: asset.id }));
    this.save();
    return {
      图纸: asset.name,
      识别文字: data.texts.length,
      新增区域: added.length,
      替换旧识别: before,
      区域: added.map((z) => `${z.id} ${z.name}`),
      ...(data.ocrError ? { OCR: data.ocrError } : {}),
      ...(data.texts.length > names.length ? { 跳过: data.texts.filter((t) => !isZoneName(t.text)).map((t) => t.text).slice(0, 20) } : {}),
    };
  }

  // ---------------------------------------------------------------- view

  labels({ pin, place, seen }) {
    // The panel's 从图纸识别 depends on which drawing is in the scene.
    const lib = this.app.library;
    const sig = `${lib?.overlay?.asset.id ?? ''}|${lib?.drawing ?? ''}`;
    if (sig !== this.drawingSig) {
      this.drawingSig = sig;
      this.renderPanel();
    }
    for (const z of this.list) {
      const key = `zm:${z.id}`;
      seen.add(key);
      const k = KIND[z.kind] ?? KIND.area;
      const el = pin(key, `zone ${z.shape} ${this.selected === z.id ? 'sel' : ''}`, `<span class="lab">${esc(z.name)}</span><span class="dot" style="background:${k.color}"></span>`);
      el.dataset.zone = z.id;
      el.title = `${z.id} · ${k.label} · ${z.source}（点击编辑）`;
      place(el, new THREE.Vector3(z.x / 1000, 0.3, -z.y / 1000));
    }
  }

  lookAt(ref) {
    const z = this.find(ref);
    if (!z) throw new Error(`没有区域标注 ${ref}`);
    this.selected = z.id;
    const t = new THREE.Vector3(z.x / 1000, 1, -z.y / 1000);
    this.app.view = 'zone';
    this.app.flyTo?.(t, t.clone().add(new THREE.Vector3(-10, 14, 16)));
    this.app.bump?.();
    return z;
  }

  // ---------------------------------------------------------------- by hand

  ui() {
    if (typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    const labelBtn = document.getElementById('labelBtn');
    this.btn = document.createElement('button');
    this.btn.id = 'zoneBtn';
    this.btn.textContent = '区域';
    this.btn.title = '区域标注：点地面添加、从图纸识别、编辑';
    labelBtn?.after(this.btn);
    this.btn.addEventListener('click', () => this.togglePanel());

    // Floor clicks while placing: capture on the view so the normal object pick does not run.
    const canvas = document.querySelector('canvas');
    const view = canvas?.parentElement;
    const down = { x: 0, y: 0 };
    view?.addEventListener('pointerdown', (e) => Object.assign(down, { x: e.clientX, y: e.clientY }), true);
    view?.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || e.target !== canvas || (!this.placing && !this.moving)) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      e.stopPropagation();
      const p = this.app.floorAt?.(e.clientX, e.clientY);
      if (!p) return;
      if (this.moving) {
        const z = this.update(this.moving, { x: p.x, y: p.y });
        this.moving = null;
        this.syncPlacing();
        this.app.toast?.(`${z.name} 已移到 X ${z.x} Y ${z.y} mm`);
        return;
      }
      this.openEditor({ x: p.x, y: p.y }, e.clientX, e.clientY);
    }, true);

    document.getElementById('labels')?.addEventListener('click', (e) => {
      const el = e.target.closest('.pin.zone');
      if (!el) return;
      const z = this.find(el.dataset.zone);
      if (!z) return;
      this.selected = z.id;
      this.openEditor(z, e.clientX, e.clientY);
      this.app.bump?.();
    });

    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.editor) {
        e.stopPropagation();
        this.closeEditor();
      } else if (this.placing || this.moving) {
        e.stopPropagation();
        this.placing = false;
        this.moving = null;
        this.syncPlacing();
      }
    }, true);
  }

  syncPlacing() {
    document.body.classList.toggle('zone-placing', this.placing || Boolean(this.moving));
    this.renderPanel();
  }

  togglePanel(open = !this.panel) {
    if (!open) {
      this.panel?.remove();
      this.panel = null;
      this.placing = false;
      this.closeEditor();
      this.syncPlacing();
      this.btn?.classList.remove('on');
      return;
    }
    this.panel = document.createElement('div');
    this.panel.className = 'zpanel glass';
    const r = this.btn.getBoundingClientRect();
    this.panel.style.left = `${Math.max(8, Math.min(innerWidth - 310, r.left - 120))}px`;
    this.panel.style.top = `${r.bottom + 8}px`;
    document.body.append(this.panel);
    this.btn.classList.add('on');
    this.panel.addEventListener('click', (e) => this.onPanel(e));
    this.renderPanel();
  }

  renderPanel() {
    if (!this.panel) return;
    const list = this.all[this.sceneKey()] ?? [];
    const lib = this.app.library;
    const hasDrawing = Boolean(lib?.overlay || lib?.drawing);
    const used = new Set(list.map((z) => z.kind));
    const legend = ZONE_KINDS.filter((k) => used.has(k.key) || !list.length).map((k) => `<span><i style="background:${k.color}"></i>${k.label}</span>`).join('');
    const rows = list.map((z) => `<div data-go="${z.id}"><i style="background:${(KIND[z.kind] ?? KIND.area).color};border-radius:${z.shape === 'area' ? '2px' : '50%'}"></i>${esc(z.name)}<small>${z.id} · ${esc(z.source)}</small><span class="del" data-del="${z.id}" title="删除">×</span></div>`).join('');
    this.panel.innerHTML = `<h5>区域标注 <span class="num" style="color:var(--ink3);font-weight:400">${list.length}</span><span class="x" data-close title="关闭">×</span></h5>
      <div class="row"><button data-place class="${this.placing ? 'on' : ''}">${this.placing ? '添加中 · Esc 结束' : '＋ 点地面添加'}</button><button data-read ${hasDrawing ? '' : 'disabled title="先载入图纸或叠为底图"'}>从图纸识别</button></div>
      <div class="legend">${legend}</div>
      <div class="zl">${rows || '<p class="muted">还没有区域标注。点「＋ 点地面添加」后在地面上点一下；或载入带区域名称的图纸后点「从图纸识别」；也可以对小华说「把图纸上的区域标出来」。</p>'}</div>
      ${list.length ? '<div class="row" style="margin:8px 0 0"><button data-clear>清空本场景标注</button></div>' : ''}`;
  }

  async onPanel(e) {
    const t = e.target;
    try {
      if (t.closest('[data-close]')) return this.togglePanel(false);
      if (t.closest('[data-place]')) {
        this.placing = !this.placing;
        this.syncPlacing();
        if (this.placing) this.app.toast?.('在地面上点一下添加区域，Esc 结束');
        return;
      }
      const del = t.closest('[data-del]');
      if (del) {
        const z = this.remove(del.dataset.del);
        if (z) this.app.toast?.(`已删除 ${z.name}`);
        return;
      }
      const go = t.closest('[data-go]');
      if (go) return void this.lookAt(go.dataset.go);
      if (t.closest('[data-clear]')) {
        if (!confirm('清空当前场景的全部区域标注？')) return;
        this.clear();
        return;
      }
      const read = t.closest('[data-read]');
      if (read) {
        read.disabled = true;
        read.textContent = '识别中…';
        const r = await this.readFromDrawing();
        this.app.toast?.(r.新增区域 ? `从 ${r.图纸} 识别出 ${r.新增区域} 个区域` : `${r.图纸} 上没有识别到区域名称${r.OCR ? `（${r.OCR}）` : ''}`, !r.新增区域);
        this.renderPanel();
      }
    } catch (error) {
      this.app.toast?.(error.message, true);
      this.renderPanel();
    }
  }

  // New marker at a floor point (target has no id), or edit an existing one.
  openEditor(target, cx, cy) {
    this.closeEditor();
    const isNew = !target.id;
    const box = document.createElement('div');
    box.className = 'zedit glass';
    box.style.left = `${Math.min(innerWidth - 250, cx + 12)}px`;
    box.style.top = `${Math.min(innerHeight - 170, cy + 12)}px`;
    const opts = ZONE_KINDS.map((k) => `<option value="${k.key}" ${!isNew && target.kind === k.key ? 'selected' : ''}>${k.label}</option>`).join('');
    box.innerHTML = `<input data-name placeholder="名称，如 原材料存储区 / 1#上线点" value="${isNew ? '' : esc(target.name)}" maxlength="30">
      <select data-kind><option value="">按名称自动配色</option>${opts}</select>
      <div class="row">${isNew ? '' : '<button data-move title="再点地面上的新位置">移动</button><button class="del" data-remove>删除</button>'}<button data-cancel>取消</button><button class="ok" data-ok>${isNew ? '添加' : '保存'}</button></div>`;
    document.body.append(box);
    this.editor = box;
    const name = box.querySelector('[data-name]');
    name.focus();
    name.select();
    const submit = () => {
      try {
        const kind = box.querySelector('[data-kind]').value || undefined;
        if (isNew) {
          const z = this.add({ name: name.value, kind, x: target.x, y: target.y });
          this.app.toast?.(`已添加 ${z.id} ${z.name}`);
        } else {
          this.update(target.id, { name: name.value, kind: kind ?? classifyZone(name.value) });
        }
        this.closeEditor();
      } catch (error) {
        this.app.toast?.(error.message, true);
      }
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-ok]')) submit();
      else if (e.target.closest('[data-cancel]')) this.closeEditor();
      else if (e.target.closest('[data-remove]')) {
        this.remove(target.id);
        this.closeEditor();
      } else if (e.target.closest('[data-move]')) {
        this.moving = target.id;
        this.closeEditor();
        this.syncPlacing();
        this.app.toast?.(`在地面上点新位置来移动 ${target.name}，Esc 取消`);
      }
    });
  }

  closeEditor() {
    this.editor?.remove();
    this.editor = null;
  }
}
