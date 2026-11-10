// Production-line simulation in the 3D view and the dock: stations as pads with machines
// coloured by state, queues as stacked parts, parts travelling between stations, replayed from
// the simulation trace at a chosen speed. Plus the KPI dashboard (产出 / 节拍 / 瓶颈 / 利用率 / 甘特).
import * as THREE from 'three';
import { STATES, STATE_NAMES } from './linesim.js';

const STATE_COLORS = { idle: '#9aa3ad', busy: '#2ea121', blocked: '#f5b800', down: '#d7000f' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const hm = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;

export class LineViz {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = '产线仿真';
    this.result = null;
    this.rep = null;
    this.input = null;
    this.positions = [];
    this.simTime = 0;
    this.speed = 120;
    this.playing = false;
    this.tokens = [];
  }

  // Station positions: explicit x/y, a point id (at), or a row across the plant.
  layout(stations) {
    const site = this.app.site;
    const b = site.built?.bounds ?? { minX: 0, maxX: 96000, minY: 0, maxY: 42000 };
    const free = stations.filter((s) => !s.at && !(Number.isFinite(s.x_mm) && Number.isFinite(s.y_mm)));
    return stations.map((s) => {
      if (s.at) {
        const p = site.findPoint(s.at);
        if (!p) throw new Error(`工位「${s.name ?? s.id}」的位置 ${s.at} 不是已有点位`);
        return { x: p.x, y: p.y };
      }
      if (Number.isFinite(s.x_mm) && Number.isFinite(s.y_mm)) return { x: s.x_mm, y: s.y_mm };
      const k = free.indexOf(s);
      return { x: b.minX + ((b.maxX - b.minX) * (k + 1)) / (free.length + 1), y: b.minY + (b.maxY - b.minY) * 0.62 };
    });
  }

  show(input, rep) {
    this.input = input;
    this.rep = rep;
    this.result = rep.first;
    this.positions = this.layout(input.stations);
    this.simTime = 0;
    this.cursor = 0;
    this.moveCursor = 0;
    this.states = this.result.machines.map(() => 0);
    this.queues = input.stations.map(() => 0);
    this.build();
    this.playing = true;
    this.speed = input.replay_speed ?? 120;
    this.focus();
  }

  build() {
    this.group.clear();
    if (this.group.parent !== this.app.site.scene) this.app.site.scene.add(this.group);
    const st = this.input.stations;
    this.machineMeshes = [];
    this.queueMeshes = [];
    const padMat = new THREE.MeshStandardMaterial({ color: '#d9dde3', roughness: 0.9 });
    st.forEach((s, i) => {
      const { x, y } = this.positions[i];
      const servers = s.servers ?? 1;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(Math.max(3, servers * 1.8 + 1), 0.08, 3.2), padMat);
      pad.position.set(x / 1000, 0.04, -y / 1000);
      pad.receiveShadow = true;
      this.group.add(pad);
      for (let k = 0; k < servers; k++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.6, 1.8), new THREE.MeshStandardMaterial({ color: STATE_COLORS.idle, roughness: 0.6, metalness: 0.2 }));
        m.position.set(x / 1000 + (k - (servers - 1) / 2) * 1.8, 0.88, -y / 1000);
        m.castShadow = true;
        this.group.add(m);
        this.machineMeshes.push(m);
      }
      const q = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), new THREE.MeshStandardMaterial({ color: '#aeb4ba', metalness: 0.7, roughness: 0.35 }), 12);
      q.count = 0;
      q.userData.base = new THREE.Vector3(x / 1000 - Math.max(3, servers * 1.8 + 1) / 2 - 0.6, 0, -y / 1000 + 1);
      this.group.add(q);
      this.queueMeshes.push(q);
    });
    // conveyor / transfer path
    for (let i = 0; i < st.length - 1; i++) {
      const a = new THREE.Vector3(this.positions[i].x / 1000, 0.1, -this.positions[i].y / 1000);
      const b = new THREE.Vector3(this.positions[i + 1].x / 1000, 0.1, -this.positions[i + 1].y / 1000);
      const len = a.distanceTo(b);
      const belt = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, len), new THREE.MeshStandardMaterial({ color: '#4a5560', roughness: 0.8 }));
      belt.position.copy(a).lerp(b, 0.5);
      belt.lookAt(b.x, belt.position.y, b.z);
      this.group.add(belt);
    }
    this.tokenGeo = new THREE.BoxGeometry(0.5, 0.35, 0.5);
    this.tokenMat = new THREE.MeshStandardMaterial({ color: '#c9a227', metalness: 0.6, roughness: 0.35 });
  }

  focus() {
    const app = this.app;
    if (!app.flyTo) return;
    app.view = 'line';
    const xs = this.positions.map((p) => p.x);
    const ys = this.positions.map((p) => p.y);
    const span = Math.max(16000, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 1000;
    const t = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2000, 0, -(Math.min(...ys) + Math.max(...ys)) / 2000);
    app.flyTo(t, t.clone().add(new THREE.Vector3(-0.15, 0.7, 0.7).normalize().multiplyScalar(span * 0.95)));
  }

  seek(t) {
    // rebuild state from the start (states + queue lengths) up to t
    this.cursor = 0;
    this.moveCursor = 0;
    this.states = this.result.machines.map(() => 0);
    this.simTime = 0;
    this.advance(t, false);
  }

  advance(to, animate = true) {
    const log = this.result.log;
    while (this.cursor < log.length && log[this.cursor][0] <= to) {
      const [, index, state] = log[this.cursor++];
      this.states[index] = state;
    }
    const moves = this.result.moves;
    while (this.moveCursor < moves.length && moves[this.moveCursor][0] <= to) {
      const [, from] = moves[this.moveCursor++];
      if (animate && from < this.input.stations.length - 1 && this.tokens.length < 40) this.spawnToken(from);
    }
    this.simTime = to;
  }

  spawnToken(from) {
    const a = new THREE.Vector3(this.positions[from].x / 1000, 0.32, -this.positions[from].y / 1000);
    const b = new THREE.Vector3(this.positions[from + 1].x / 1000, 0.32, -this.positions[from + 1].y / 1000);
    const mesh = new THREE.Mesh(this.tokenGeo, this.tokenMat);
    mesh.position.copy(a);
    this.group.add(mesh);
    this.tokens.push({ mesh, a, b, t: 0 });
  }

  // Queue length per station isn't in the trace; derive it: parts that arrived (moves into i)
  // minus parts started there. Approximation for display: blocked machines upstream + busy share.
  queueEstimate() {
    const st = this.result.stations;
    return st.map((s, i) => {
      if (i === 0) return 0;
      const blockedUp = this.result.machines.filter((m, k) => m.station === i - 1 && STATES[this.states[k]] === 'blocked').length;
      const busyHere = this.result.machines.filter((m, k) => m.station === i && STATES[this.states[k]] === 'busy').length;
      return Math.min(12, blockedUp ? (s.buffer ?? 2) : Math.round(s.avgQueue * (busyHere ? 1 : 0.5)));
    });
  }

  update(dt) {
    if (!this.result) return;
    if (this.playing) {
      const horizon = this.result.hours * 3600;
      let to = this.simTime + dt * this.speed;
      if (to > horizon) { to = horizon; this.playing = false; }
      this.advance(to);
    }
    this.machineMeshes.forEach((m, k) => m.material.color.set(STATE_COLORS[STATES[this.states[k]]]));
    const q = this.queueEstimate();
    const dummy = new THREE.Object3D();
    this.queueMeshes.forEach((mesh, i) => {
      mesh.count = q[i];
      for (let n = 0; n < q[i]; n++) {
        dummy.position.copy(mesh.userData.base).add(new THREE.Vector3(0, 0.2 + (n % 4) * 0.37, -Math.floor(n / 4) * 0.6));
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    this.tokens = this.tokens.filter((tk) => {
      tk.t += dt / 1.2;
      tk.mesh.position.copy(tk.a).lerp(tk.b, Math.min(1, tk.t));
      if (tk.t >= 1) { tk.mesh.removeFromParent(); return false; }
      return true;
    });
    if (this.app.tab === 'linesim' && performance.now() - (this.lastDock ?? 0) > 500) {
      this.lastDock = performance.now();
      const el = document.getElementById('linesimClock');
      if (el) el.textContent = `${hm(this.simTime)} / ${hm(this.result.hours * 3600)} · ${this.playing ? `${this.speed}× 回放中` : '已暂停'}`;
      const cursor = document.getElementById('linesimCursor');
      if (cursor) cursor.style.left = `calc(96px + (100% - 96px) * ${Math.min(1, this.simTime / this.ganttSpan()).toFixed(4)})`;
    }
  }

  labels({ pin, place, seen }) {
    if (!this.result) return;
    const by = this.result.stations;
    this.input.stations.forEach((s, i) => {
      const key = `line:${i}`;
      seen.add(key);
      const idx = this.result.machines.map((m, k) => (m.station === i ? k : -1)).filter((k) => k >= 0);
      const now = idx.map((k) => STATE_NAMES[STATES[this.states[k]]]);
      const label = [...new Set(now)].join('/');
      const isNeck = this.result.bottleneck.name === by[i].name;
      place(pin(key, isNeck ? 'handoff' : 'asset', `<span class="lab">${esc(by[i].name)} · ${label} · 利用率 ${pct(by[i].utilization)}${isNeck ? ' · 瓶颈' : ''}</span>`), new THREE.Vector3(this.positions[i].x / 1000, 3.2, -this.positions[i].y / 1000));
    });
  }

  ganttSpan() {
    return Math.min(this.result.hours * 3600, this.input.gantt_minutes ? this.input.gantt_minutes * 60 : 3600);
  }

  dockHtml() {
    if (!this.result) return '<div class="later-box"><h3>产线仿真</h3><p class="muted">还没有仿真结果。对小华说：「按 开卷 60s、矫直 75s、剪切 90s（2 台）、堆垛 50s 仿真 8 小时」。</p></div>';
    const r = this.result;
    const rep = this.rep;
    const kpi = (label, value, sub = '') => `<div style="flex:1;min-width:110px;border:1px solid #e5e6eb;border-radius:6px;padding:6px 8px"><div class="muted" style="font-size:11px">${label}</div><div style="font-size:18px;font-weight:700" class="num">${value}</div>${sub ? `<div class="muted" style="font-size:11px">${sub}</div>` : ''}</div>`;
    const kpis = `<div style="display:flex;gap:6px;flex-wrap:wrap">
      ${kpi('实际产出', `${rep.throughput.mean.toFixed(1)} 件/h`, `${rep.runs} 次仿真 ${rep.throughput.min.toFixed(1)}–${rep.throughput.max.toFixed(1)}`)}
      ${kpi(`${r.hours} h 班产`, `${Math.round(rep.shiftOutput.mean)} 件`, `${rep.shiftOutput.min}–${rep.shiftOutput.max}`)}
      ${kpi('理论产能', `${r.theoreticalPerHour.toFixed(1)} 件/h`, `理论节拍 ${r.theoreticalTakt_s?.toFixed(0)} s`)}
      ${kpi('线平衡效率', pct(r.lineEfficiency), `实际节拍 ${r.actualTakt_s ? r.actualTakt_s.toFixed(0) : '—'} s`)}
      ${kpi('瓶颈工位', esc(r.bottleneck.name), r.leadTime_s ? `平均流转 ${(r.leadTime_s.avg / 60).toFixed(1)} min` : '')}
      ${kpi('平均在制品', r.avgWip.toFixed(1), '件')}</div>`;
    const bars = r.stations.map((s) => {
      const seg = (k, v) => (v > 0.002 ? `<span title="${STATE_NAMES[k]} ${pct(v)}" style="display:inline-block;height:10px;width:${(v * 100).toFixed(2)}%;background:${STATE_COLORS[k]}"></span>` : '');
      return `<tr><td>${esc(s.name)}${s.name === r.bottleneck.name ? ' <span class="warn">瓶颈</span>' : ''}</td><td class="num">${s.cycle_s}s×${s.servers}</td><td class="num">${s.capacityPerHour.toFixed(1)}</td>
        <td style="min-width:160px"><div style="display:flex;width:100%;background:#f2f3f5">${seg('busy', s.utilization)}${seg('blocked', s.blocked)}${seg('idle', s.starved)}${seg('down', s.down)}</div></td>
        <td class="num">${pct(s.utilization)}</td><td class="num">${pct(s.blocked)}</td><td class="num">${pct(s.starved)}</td><td class="num">${pct(s.down)}</td><td class="num">${s.avgQueue.toFixed(1)} / ${s.maxQueue}</td></tr>`;
    }).join('');
    const span = this.ganttSpan();
    const rows = r.machines.map((m, k) => {
      const segs = [];
      let state = 0;
      let since = 0;
      for (const [t, index, s] of r.log) {
        if (index !== k) continue;
        if (t > span) break;
        if (t > since) segs.push([since, t, state]);
        state = s;
        since = t;
      }
      segs.push([since, span, state]);
      const name = r.stations[m.station].name + (r.stations[m.station].servers > 1 ? ` #${m.k + 1}` : '');
      return `<div style="display:flex;align-items:center;gap:6px;height:14px"><span style="width:90px;font-size:11px;white-space:nowrap;overflow:hidden">${esc(name)}</span><div style="position:relative;flex:1;height:10px;background:#f2f3f5">${segs.filter(([a, b]) => b > a).map(([a, b, s]) => `<span style="position:absolute;left:${(a / span) * 100}%;width:${((b - a) / span) * 100}%;top:0;bottom:0;background:${STATE_COLORS[STATES[s]]}"></span>`).join('')}</div></div>`;
    }).join('');
    const legend = Object.entries(STATE_COLORS).map(([k, c]) => `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:10px"><i style="width:10px;height:10px;background:${c};display:inline-block"></i>${STATE_NAMES[k]}</span>`).join('');
    return `<div style="padding:2px">${kpis}
      <table class="tbl-plain" style="width:100%;margin-top:8px;font-size:12px"><thead><tr><th>工位</th><th>节拍×台数</th><th>能力 件/h</th><th>时间构成</th><th>加工</th><th>堵塞</th><th>待料</th><th>故障</th><th>队列 均/峰</th></tr></thead><tbody>${bars}</tbody></table>
      <div style="margin-top:8px;display:flex;justify-content:space-between;font-size:12px"><b>工位时序（前 ${Math.round(span / 60)} 分钟）</b><span>${legend}</span><span id="linesimClock" class="num"></span></div>
      <div style="position:relative;margin-top:4px">${rows}<div id="linesimCursor" style="position:absolute;top:0;bottom:0;width:2px;background:#d7000f;left:96px"></div></div>
      <div class="acts" style="padding-top:8px"><button class="pri" data-linesim="play">${this.playing ? '❚❚ 暂停回放' : '▶ 回放'}</button><button data-linesim="restart">从头回放</button><button data-linesim="faster">加速</button></div></div>`;
  }
}
