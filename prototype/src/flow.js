// Technical-proposal flow demo: user-defined process nodes shown as a path through the plant,
// played as a whole (全流程) or one node at a time with its sub-steps (节点流程). Explains the
// flow only; timing here is presentation pacing, not simulation.
import * as THREE from 'three';

const ACCENT = new THREE.Color('#d7000f');
const IDLE = new THREE.Color('#2b7de9');
const DONE = new THREE.Color('#2ea121');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class FlowDemo {
  constructor(app) {
    this.app = app;
    this.flow = null;
    this.group = new THREE.Group();
    this.group.name = '工艺流程演示';
    this.play = null; // { mode, index, phase: 'dwell'|'move', t, sub }
  }

  // nodes: [{ id, name, device, duration_s, at (point id) | x_mm, y_mm, desc, substeps: [{ name, duration_s, desc }] }]
  define({ name, nodes, loop = false }) {
    if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > 40) throw new Error('流程需要 2–40 个工序节点');
    const site = this.app.site;
    const b = site.built?.bounds ?? { minX: 0, maxX: 96000, minY: 0, maxY: 42000 };
    const auto = nodes.filter((n) => !n.at && !(Number.isFinite(n.x_mm) && Number.isFinite(n.y_mm)));
    const list = nodes.map((n, i) => {
      if (!n.name) throw new Error(`第 ${i + 1} 个节点缺少名称 name`);
      let x = n.x_mm;
      let y = n.y_mm;
      if (n.at) {
        const p = site.findPoint(n.at) ?? this.app.warehouse?.zones.get(n.at)?.slots[0];
        if (!p) throw new Error(`节点「${n.name}」的位置 ${n.at} 不是已有点位或库区`);
        x = p.x;
        y = p.y;
      } else if (!(Number.isFinite(x) && Number.isFinite(y))) {
        // no location: lay these nodes out along the plant's long axis, in order
        const k = auto.indexOf(n);
        x = b.minX + ((b.maxX - b.minX) * (k + 1)) / (auto.length + 1);
        y = b.minY + (b.maxY - b.minY) * 0.5 + (k % 2 ? 2500 : -2500);
      }
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) throw new Error(`节点「${n.name}」(${Math.round(x)}, ${Math.round(y)}) 在厂房外`);
      const subs = Array.isArray(n.substeps) ? n.substeps.slice(0, 12).map((s) => ({ name: String(s.name ?? s), duration_s: Number(s.duration_s) || null, desc: s.desc ?? '' })) : [];
      return { n: i + 1, id: String(n.id ?? `N${i + 1}`), name: String(n.name), device: n.device ? String(n.device) : '', duration_s: Number(n.duration_s) || null, desc: String(n.desc ?? ''), x, y, subs };
    });
    this.flow = { name: name ?? '工艺流程', nodes: list, loop };
    this.build();
    this.play = null;
    this.app.bump?.();
    const total = list.reduce((a, n) => a + (n.duration_s ?? 0), 0);
    return { 流程: this.flow.name, 节点数: list.length, 节点: list.map((n) => `${n.n}. ${n.name}${n.device ? `（${n.device}）` : ''}${n.duration_s ? ` ${n.duration_s}s` : ''}${n.subs.length ? ` · ${n.subs.length} 个子步骤` : ''}`), 标称总时长_s: total || null };
  }

  build() {
    this.group.clear();
    if (this.group.parent !== this.app.site.scene) this.app.site.scene.add(this.group);
    const nodes = this.flow.nodes;
    const v = (n, h = 0.25) => new THREE.Vector3(n.x / 1000, h, -n.y / 1000);
    this.rings = nodes.map((n) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.12, 12, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: IDLE }));
      ring.position.copy(v(n, 0.15));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.3, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0.18, depthWrite: false }));
      disc.position.copy(v(n, 0.03));
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 8), new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0.5 }));
      beam.position.copy(v(n, 2));
      this.group.add(ring, disc, beam);
      return { ring, disc, beam };
    });
    // path with arrows
    const pts = nodes.map((n) => v(n, 0.3));
    if (this.flow.loop) pts.push(pts[0].clone());
    this.segments = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = a.distanceTo(b);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 8), new THREE.MeshBasicMaterial({ color: '#f5b800' }));
      tube.position.copy(a).lerp(b, 0.5);
      tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 16), new THREE.MeshBasicMaterial({ color: '#f5b800' }));
      cone.position.copy(a).lerp(b, 0.55);
      cone.quaternion.copy(tube.quaternion);
      this.group.add(tube, cone);
      this.segments.push({ a, b });
    }
    this.token = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), new THREE.MeshBasicMaterial({ color: ACCENT }));
    this.token.position.copy(pts[0]).setY(0.9);
    this.token.visible = false;
    this.group.add(this.token);
  }

  pace(seconds) {
    return THREE.MathUtils.clamp((seconds ?? 20) / 12, 1.8, 6);
  }

  start({ mode = 'full', node, speed = 1 } = {}) {
    if (!this.flow) throw new Error('还没有流程，先用 define_process 定义工序节点');
    let index = 0;
    if (mode === 'node') {
      index = this.flow.nodes.findIndex((n) => n.id === node || n.name === node || String(n.n) === String(node));
      if (index < 0) throw new Error(`没有节点 ${node}，可选：${this.flow.nodes.map((n) => `${n.n} ${n.name}`).join('、')}`);
    }
    this.play = { mode, index, phase: 'dwell', t: 0, sub: 0, speed: THREE.MathUtils.clamp(speed, 0.25, 4), finished: false };
    this.token.visible = true;
    const n = this.flow.nodes[index];
    this.token.position.set(n.x / 1000, 0.9, -n.y / 1000);
    this.focus(mode === 'node' ? n : null);
    this.app.site.playing && this.app.play?.(false);
    return { 模式: mode === 'node' ? `节点流程 · ${n.n} ${n.name}` : '全流程', 节点: mode === 'node' ? { 名称: n.name, 设备: n.device || undefined, 说明: n.desc || undefined, 子步骤: n.subs.map((s) => s.name) } : this.flow.nodes.length };
  }

  focus(node) {
    const app = this.app;
    if (!app.flyTo) return;
    app.view = 'flow';
    if (node) {
      const t = new THREE.Vector3(node.x / 1000, 1, -node.y / 1000);
      app.flyTo(t, t.clone().add(new THREE.Vector3(-9, 11, 13)));
    } else {
      const xs = this.flow.nodes.map((n) => n.x);
      const ys = this.flow.nodes.map((n) => n.y);
      const span = Math.max(20000, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 1000;
      const t = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2000, 0, -(Math.min(...ys) + Math.max(...ys)) / 2000);
      app.flyTo(t, t.clone().add(new THREE.Vector3(-0.3, 0.8, 0.6).normalize().multiplyScalar(span * 1.1)));
    }
  }

  stop() {
    this.play = null;
    if (this.token) this.token.visible = false;
    this.paint();
    this.app.renderFlow?.();
  }

  current() {
    if (!this.play || !this.flow) return null;
    const n = this.flow.nodes[this.play.index];
    return { node: n, phase: this.play.phase, sub: n.subs[this.play.sub] ?? null, mode: this.play.mode, finished: this.play.finished };
  }

  paint() {
    if (!this.rings) return;
    this.rings.forEach((r, i) => {
      const active = this.play && this.play.index === i && this.play.phase === 'dwell' && !this.play.finished;
      const done = this.play && (i < this.play.index || this.play.finished);
      const color = active ? ACCENT : done ? DONE : IDLE;
      r.ring.material.color.copy(color);
      r.disc.material.color.copy(color);
      r.beam.material.color.copy(color);
      const s = active ? 1 + 0.12 * Math.sin(performance.now() / 160) : 1;
      r.ring.scale.set(s, 1, s);
    });
  }

  update(dt) {
    const p = this.play;
    if (!p || !this.flow) return;
    this.paint();
    if (p.finished) return;
    p.t += dt * p.speed;
    const nodes = this.flow.nodes;
    const n = nodes[p.index];
    if (p.phase === 'dwell') {
      const subs = n.subs.length;
      const dwell = p.mode === 'node' && subs ? subs * 2.4 : this.pace(n.duration_s);
      const before = p.sub;
      if (subs) p.sub = Math.min(subs - 1, Math.floor((p.t / dwell) * subs));
      if (p.sub !== before) this.app.renderFlow?.();
      this.token.position.y = 0.9 + 0.25 * Math.sin(p.t * 5);
      if (p.t >= dwell) {
        if (p.mode === 'node') { p.finished = true; this.app.renderFlow?.(); return; }
        const last = p.index >= nodes.length - 1;
        if (last && !this.flow.loop) { p.finished = true; this.app.renderFlow?.(); return; }
        p.phase = 'move';
        p.t = 0;
      }
    } else {
      const seg = this.segments[p.index];
      const k = Math.min(1, p.t / 1.4);
      const e = k * k * (3 - 2 * k);
      this.token.position.copy(seg.a).lerp(seg.b, e).setY(0.9);
      if (k >= 1) {
        p.index = (p.index + 1) % nodes.length;
        p.phase = 'dwell';
        p.t = 0;
        p.sub = 0;
        this.app.renderFlow?.();
      }
    }
  }

  labels({ pin, place, seen }) {
    if (!this.flow) return;
    const cur = this.current();
    for (const n of this.flow.nodes) {
      const key = `flow:${n.id}`;
      seen.add(key);
      const active = cur && cur.node === n && cur.phase === 'dwell';
      const sub = active && cur.sub ? ` · ${cur.sub.name}` : '';
      place(pin(key, active ? 'handoff' : 'asset', `<span class="lab">${n.n} ${esc(n.name)}${n.device ? ` · ${esc(n.device)}` : ''}${esc(sub)}</span>`), new THREE.Vector3(n.x / 1000, 4.4, -n.y / 1000));
    }
  }

  dockHtml() {
    if (!this.flow) return '<div class="later-box"><h3>工艺流程</h3><p class="muted">还没有流程。对小华说：「按 开卷→矫直→剪切→堆垛→入库 定义流程并演示」。</p></div>';
    const cur = this.current();
    const boxes = this.flow.nodes.map((n, i) => {
      const active = cur && cur.node === n && !cur.finished;
      const done = cur && (i < this.play.index || cur.finished);
      const style = active ? 'border-color:#d7000f;background:#fff1f0' : done ? 'border-color:#2ea121' : '';
      return `<div class="flow-node" style="flex:0 0 auto;min-width:96px;max-width:160px;border:1.5px solid #c9cdd4;border-radius:6px;padding:6px 8px;${style}">
        <div style="font-weight:600">${n.n}. ${esc(n.name)}</div>
        <div class="muted" style="font-size:11px">${esc(n.device || '—')}${n.duration_s ? ` · ${n.duration_s}s` : ''}</div></div>${i < this.flow.nodes.length - 1 ? '<div style="align-self:center;color:#f5b800;font-weight:700">→</div>' : this.flow.loop ? '<div style="align-self:center;color:#f5b800">↺</div>' : ''}`;
    }).join('');
    let detail = '';
    if (cur) {
      const n = cur.node;
      const subs = n.subs.map((s, i) => `<li style="${cur.sub === s ? 'color:#d7000f;font-weight:600' : ''}">${esc(s.name)}${s.duration_s ? ` <span class="muted">${s.duration_s}s</span>` : ''}${s.desc ? ` — <span class="muted">${esc(s.desc)}</span>` : ''}</li>`).join('');
      detail = `<div style="margin-top:8px"><b>${cur.mode === 'node' ? '节点流程' : '全流程'} · 当前：${n.n} ${esc(n.name)}</b>${cur.finished ? ' <span class="ok">演示完成</span>' : ''}
        ${n.desc ? `<p style="margin:4px 0">${esc(n.desc)}</p>` : ''}${subs ? `<ol style="margin:4px 0 0 18px">${subs}</ol>` : ''}</div>`;
    }
    return `<div style="padding:4px 2px"><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:stretch">${boxes}</div>${detail}
      <div class="acts" style="padding-top:8px"><button class="pri" data-flow="full">▶ 全流程演示</button>${cur ? '<button data-flow="stop">停止</button>' : ''}</div></div>`;
  }
}
