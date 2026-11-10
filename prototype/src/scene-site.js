// A plant generated from any factory drawing: the building, its crane bays and a construction
// sequence (ground -> columns -> runway -> cranes -> envelope -> equipment -> roof), then the
// AGV + crane process in one of its bays (scene-flow.js): the AGV runs its loop, the bay's crane
// takes the coil at the hand-off stand and puts it down in the finished-goods area. Build and
// process share one step list and timeline; after the build the process loops.
import * as THREE from 'three';
import { PALLET, RAIL, buildCargoObject, buildCrane, buildPlant, updateCutaway } from '../../demo/src/scene/build-scene.js';
import { inferPlant } from '../../demo/src/scene/infer-plant.js';
import { MOTION, buildTimeline } from '../../demo/src/scene/route.js';
import { Site } from '../../demo/src/scene/site.js';
import { buildCoil, buildCrane as buildWorkingCrane } from './crane.js';
import { ProcessSite } from './engine.js';
import { CRANE_MOTION, COIL, composeProcess, cranePoseAt, efficiency, ganttBlocks, planCrane, travelStats } from './process.js';
import { planSceneFlow } from './scene-flow.js';

// Coil centre above the cargo object's origin (as in engine.js).
const COIL_CENTRE = PALLET.thickness + 0.03 + 0.22 + 0.8 - 0.18;
const SADDLE = 0.15;
const RUNWAY_TOP = 9.4 + 0.45;
// The process runs this many times faster than the build, so a cycle reads in about two minutes.
const PROCESS_PACE = 3;

const easeOut = (k) => 1 - (1 - k) ** 3;
const easeBack = (k) => {
  const c = 1.4;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
};
const clamp01 = (k) => Math.min(1, Math.max(0, k));

export class SceneSite extends Site {
  isScene = true;

  speed = 1;

  window = null;

  agvCount = 1;

  motion = { ...MOTION };

  craneMotion = structuredClone(CRANE_MOTION);

  roles = { pick: 'RM-01', handoff: 'H-01', drop: 'FG-01', home: 'CHG-01' };

  flow = null;

  target = null;

  travelVisible = false;

  // Copy the HDR environment and textures from the site that already loaded them.
  share(from) {
    this.scene.environment = from.scene.environment;
    this.scene.environmentIntensity = from.scene.environmentIntensity;
    this.textures = from.textures;
    this.contact.visible = false;
  }

  loadDrawing(text, sourceName, asset = null, opts = {}) {
    this.loadPlant(inferPlant(text, sourceName), sourceName, asset, opts);
  }

  // A blank scene: only the floor (w × h mm), no building, cranes or process; models go in by hand.
  loadBlank(sourceName = '空白场景', { w = 60000, h = 30000 } = {}) {
    const outline = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    const plant = {
      walls: [{ points: outline, closed: true, width: 250 }], // only fixes the floor's extent; not built
      beams: [], paths: [], marks: [], labels: [], columns: [], racks: [], machines: [], conveyors: [], cranes: [],
      doors: [], glazing: [], stations: [], columnShapes: [], rails: [], yard: null,
    };
    const summary = { 来源: sourceName, 厂房_m: [w / 1000, h / 1000], 方向: '空白场地', 跨: [], 柱距_m: null, 柱线: 0, 柱: { 钢柱: 0, 混凝土柱: 0 }, 吊车梁: 0, 行车: 0, 大门: 0, 窗: 0, 设备: 0, 分区: 0, 轨道: 0, 地面线条: 0, 厂区: false };
    const bounds = { x0: 0, y0: 0, x1: w, y1: h, w, h, cx: w / 2, cy: h / 2 };
    this.loadPlant({ plant, summary, bays: [], bounds, alongX: w >= h }, sourceName, null, { blank: true });
  }

  loadPlant({ plant, summary, bays, bounds, alongX }, sourceName, asset = null, { bay = null, blank = false } = {}) {
    this.blank = blank;
    // Lay the AGV loop and its stands into the plant before it is built, so they go up with it.
    this.flow = null;
    this.flowError = null;
    if (blank) this.flowError = '空白场景没有 AGV + 行车工序';
    else {
      try {
        this.flow = planSceneFlow({ plant, bays, alongX, prefer: bay });
        plant.paths.push(...this.flow.paths);
        plant.stations.push(...this.flow.stations);
      } catch (error) {
        this.flowError = error.message;
      }
    }
    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.group.traverse((o) => o.geometry?.dispose());
    }
    this.plant = plant;
    this.summary = summary;
    this.bays = bays;
    this.alongX = alongX;
    this.hallBounds = bounds;
    this.sourceName = sourceName;
    this.asset = asset;
    this.built = buildPlant(plant, this.textures);
    if (blank) {
      // Keep the floor only: walls, roof and the rest stay out (and out of the build steps).
      for (const [name, pivot] of Object.entries(this.built.stages)) {
        if (name === 'ground') continue;
        pivot.visible = false;
        pivot.userData.empty = true;
      }
      this.built.sides = [];
    }
    this.scene.add(this.built.group);
    this.timeline = { scene: true };
    const steps = this.buildSteps();
    this.buildEnd = steps.at(-1).t1;
    this.process = { steps };
    this.duration = this.buildEnd;
    this.time = 0;
    this.playing = true;
    this.window = null;
    this.hiddenCranes = new Set();
    if (this.flow) this.setupFlow();
    this.placeSun();
    this.renderPose();
  }

  // AGV timeline, cargo, the bay's working crane, the finished-goods saddle and the five process
  // steps, appended after the build steps.
  setupFlow() {
    const f = this.flow;
    this.runway = { low: f.ra, high: f.rb };
    this.buildFlowTimeline();
    // The working crane rolls in with the 行车就位 stage; the bay's sketch crane makes way for it.
    const stages = this.built.stages;
    const holder = (stage) => {
      const g = new THREE.Group();
      g.position.copy(stages[stage].children[0].position);
      stages[stage].add(g);
      return g;
    };
    this.crane = buildWorkingCrane({ railLow: f.crane.railLow, railHigh: f.crane.railHigh, railTop: RUNWAY_TOP });
    this.crane.root.rotation.y = f.crane.rotation;
    holder('crane').add(this.crane.root);
    this.setCraneHidden(f.bay.name, true);
    // Two saddles, a floor mark and the landed coil, turned like the crane (coil axis along the runway).
    const drop = f.points.drop;
    const yard = new THREE.Group();
    yard.position.set(drop.x / 1000, 0, -drop.y / 1000);
    yard.rotation.y = f.crane.rotation;
    holder('equip').add(yard);
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.3, roughness: 0.6 });
    for (const z of [0, -2.2]) {
      for (const dx of [-0.45, 0.45]) {
        const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.3, SADDLE * 2, 1.4), dark);
        saddle.position.set(dx, SADDLE, z);
        saddle.castShadow = saddle.receiveShadow = true;
        yard.add(saddle);
      }
    }
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd7000f, transparent: true, opacity: 0.12, depthWrite: false }));
    mark.position.set(0, 0.012, -1.1);
    yard.add(mark);
    this.fgCoil = buildCoil();
    this.fgCoil.position.set(0, SADDLE + COIL.diameter / 2000, 0);
    yard.add(this.fgCoil);
    const previous = buildCoil();
    previous.position.set(0, SADDLE + COIL.diameter / 2000, -2.2);
    yard.add(previous);
    this.replan();
  }

  // AGV timeline and its cargo objects (again after an AGV speed change).
  buildFlowTimeline() {
    for (const { object } of this.cargoObjects ?? []) this.scene.remove(object);
    this.timeline = buildTimeline(this.plant, this.motion);
    this.cargoObjects = this.timeline.cargo.map((item) => {
      const object = buildCargoObject(item.kind);
      const coilParts = object.children.filter((c) => c.geometry?.type === 'CylinderGeometry' || c.geometry?.type === 'RingGeometry');
      this.scene.add(object);
      return { item, object, coilParts };
    });
  }

  replan() {
    const f = this.flow;
    const unload = this.timeline.steps.find((s) => s.type === 'dwell' && s.kind === 'unload');
    const pickZ = ((this.deckHeight ?? 0.4) + RAIL.raised + COIL_CENTRE) * 1000;
    const dropZ = (SADDLE + COIL.diameter / 2000) * 1000;
    this.cranePlan = planCrane({ home: f.crane.home, pick: { ...f.crane.pick, z: pickZ }, drop: { ...f.crane.drop, z: dropZ }, ready: unload.t1, motion: this.craneMotion });
    const flow = composeProcess(this.timeline, this.cranePlan, this.roles);
    this.flowDuration = flow.duration;
    this.efficiency = efficiency(this.timeline, this.cranePlan, { agvCount: this.agvCount, target: this.target });
    this.gantt = ganttBlocks(this.timeline, this.cranePlan, this.flowDuration);
    this.travel = travelStats(this.timeline, this.cranePlan);
    const T = this.buildEnd;
    const build = this.process.steps.filter((s) => s.device === '建造');
    const steps = [...build];
    for (const s of flow.steps) steps.push({ ...s, local: s.n, n: steps.length + 1, t0: s.t0 + T, t1: s.t1 + T });
    this.process = { steps };
    this.duration = T + this.flowDuration;
    // The AGV, its coil and the stands show up once the equipment stage is in.
    this.flowVisibleAt = build.find((s) => s.stage === 'equip')?.t1 ?? T;
    this.summary.工序 = `${f.bay.name} 跨：AGV 环线 ${(f.loopLength / 1000).toFixed(0)} m + 行车吊运，单循环 ${this.flowDuration.toFixed(0)} s`;
    if (this.time > this.duration) this.time = T;
    this.buildTravelLines();
  }

  setAgvCount(count) {
    this.agvCount = Math.max(1, Math.min(4, Math.round(Number(count) || 1)));
    this.syncVehicleFleet(this.agvCount);
    if (this.flow) this.replan();
  }

  setMotion({ agvSpeed, bridgeSpeed, trolleySpeed, hoistSpeed, travelHeight }) {
    if (agvSpeed) this.motion.laneSpeed = agvSpeed;
    if (bridgeSpeed) this.craneMotion.bridge.speed = bridgeSpeed;
    if (trolleySpeed) this.craneMotion.trolley.speed = trolleySpeed;
    if (hoistSpeed) this.craneMotion.hoist.speed = hoistSpeed;
    if (travelHeight) this.craneMotion.travelHeight = travelHeight;
    if (!this.flow) return;
    if (agvSpeed) this.buildFlowTimeline();
    this.replan();
  }

  // Crane plan point (mm) to world metres; the plan frame is turned with the crane.
  hookPoint(p) {
    return this.flow.alongX ? [p.x / 1000, p.z / 1000, -p.y / 1000] : [-p.y / 1000, p.z / 1000, -p.x / 1000];
  }

  // Where the hook reaches across the bay (drawing mm).
  coverage() {
    const f = this.flow;
    if (!f) return null;
    const v = [f.ra + 1500, f.rb - 3000];
    return f.alongX ? { minX: f.u0, maxX: f.u1, minY: v[0], maxY: v[1] } : { minX: v[0], maxX: v[1], minY: f.u0, maxY: f.u1 };
  }

  updateVehicleSize(product, state) {
    super.updateVehicleSize(product, state);
    if (this.cranePlan) this.replan();
  }

  points() {
    return this.flow ? Object.values(this.flow.points).map((p) => ({ ...p, source: '图纸自动排布' })) : [];
  }

  findPoint(id) {
    return this.points().find((p) => p.id === id) ?? null;
  }

  buildSteps() {
    const s = this.summary;
    const st = this.built.stages;
    const span = this.bays.length ? `${this.bays.length} 跨 × ${(this.bays[0].span / 1000).toFixed(1)} m` : '单跨';
    const plan = [
      ['ground', '场地与地坪', `厂房 ${s.厂房_m[0]} × ${s.厂房_m[1]} m，涂装混凝土地坪${s.厂区 ? '，厂区道路' : ''}；地面标线 ${s.地面线条} 条、分区 ${s.分区} 个${s.轨道 ? `、轨道 ${s.轨道} 条` : ''}`, 3],
      ['frame', '立柱吊装', `钢柱 ${s.柱.钢柱} 根、混凝土柱 ${s.柱.混凝土柱} 根，柱线 ${s.柱线} 条${s.柱距_m ? `，柱距 ${s.柱距_m} m` : ''}（按图纸截面拉伸）`, 4],
      ['beam', '吊车梁', `吊车梁 ${s.吊车梁} 根，${span}，梁底 8.95 m`, 2.5],
      ['crane', '行车就位', `示意行车 ${s.行车} 台，按吊车梁位置每跨一台，只表示位置和跨度；具体型号需提供起重机图纸或模型后替换`, 2.5],
      ['envelope', '围护：墙板 门窗', `压型钢板墙 + 1.2 m 砌块墙裙，大门 ${s.大门} 樘，采光窗/百叶 ${s.窗} 处`, 3.5],
      ['equip', '设备进场', `图纸识别设备 ${s.设备} 台`, 2.5],
      ['roof', '屋面系统', '钢桁架、檩条、高天棚灯、屋面板', 3],
    ];
    let t = 0;
    const steps = [];
    for (const [stage, title, detail, duration] of plan) {
      if (st[stage].userData.empty) continue;
      steps.push({ n: steps.length + 1, stage, title, detail, t0: t, t1: t + duration, duration, device: '建造' });
      t += duration;
    }
    return steps;
  }

  playWindow(step) {
    if (!step) {
      this.window = null;
      this.playing = true;
      return;
    }
    const s = this.process.steps[step - 1];
    this.window = { t0: s.t0, t1: s.t1, step };
    this.time = s.t0;
    this.playing = true;
  }

  stepAt(t = this.time) {
    const steps = this.process.steps;
    if (this.window) return steps[this.window.step - 1];
    if (!this.flow || t < this.buildEnd) return steps.find((s) => t < s.t1) ?? steps.at(-1);
    // Process steps overlap (the AGV returns while the crane works): the latest-starting one wins.
    const covering = steps.filter((s) => s.device !== '建造' && t >= s.t0 && t < s.t1);
    return covering.at(-1) ?? steps.at(-1);
  }

  get building() {
    return this.time < this.buildEnd;
  }

  // Seconds into the process cycle (0 while the plant is still going up).
  get processTime() {
    return Math.min(Math.max(this.time - this.buildEnd, 0), this.flowDuration ?? 0);
  }

  update(delta, camera) {
    if (!this.timeline) return;
    if (this.playing) {
      this.time += delta * this.speed * (this.flow && !this.building ? PROCESS_PACE : 1);
      if (this.window) {
        if (this.time >= this.window.t1) {
          this.time = this.window.t1;
          this.playing = false;
          this.onWindowEnd?.(this.window);
        }
      } else if (this.time >= this.duration) {
        // Built: the process cycle repeats; without one, the build stops at the end.
        if (this.flow) this.time = this.buildEnd + ((this.time - this.buildEnd) % this.flowDuration);
        else {
          this.time = this.duration;
          this.playing = false;
        }
      }
    }
    this.renderPose();
    const roofStep = this.process.steps.find((s) => s.stage === 'roof');
    const raising = roofStep && this.time >= roofStep.t0 && this.time < roofStep.t1;
    updateCutaway(this.built.sides, camera, this.built.roof);
    // While the roof goes up it is shown from any angle (trusses only); once built the cutaway rules.
    if (raising) this.built.roof.visible = true;
    if (this.built.roof.userData.deck) this.built.roof.userData.deck.visible = !raising;
  }

  // Each stage pivot is placed for the current time; the plant is at rest once all are done.
  renderPose() {
    const { stages, size } = this.built;
    for (const name of Object.keys(stages)) {
      const pivot = stages[name];
      const step = this.process.steps.find((s) => s.stage === name);
      pivot.scale.set(1, 1, 1);
      pivot.position.y = 0;
      pivot.userData.slide = 0;
      if (!step) continue;
      const k = clamp01((this.time - step.t0) / step.duration);
      pivot.visible = this.time >= step.t0;
      if (!pivot.visible || k >= 1) {
        this.slide(pivot, 0);
        continue;
      }
      if (name === 'ground') {
        const e = easeOut(k);
        pivot.scale.set(Math.max(e, 0.001), 1, Math.max(e, 0.001));
      } else if (name === 'frame' || name === 'envelope' || name === 'equip') {
        pivot.scale.y = Math.max(name === 'envelope' ? easeOut(k) : easeBack(k), 0.001);
      } else if (name === 'beam') {
        pivot.position.y = (1 - easeOut(k)) * 10;
      } else if (name === 'crane') {
        this.slide(pivot, (1 - easeOut(k)) * -(this.alongX ? size.x : size.y) * 0.55);
      } else if (name === 'roof') {
        pivot.position.y = (1 - easeOut(k)) * 14;
      }
    }
    this.renderFlow();
  }

  // AGV, cargo and crane at the current process time.
  renderFlow() {
    if (!this.flow) {
      // No AGV route (blank scene, or no bay found): the AGV would sit at the origin, off the floor.
      for (const carrier of this.carriers ?? []) carrier.visible = false;
      this.contact.visible = false;
      return;
    }
    if (!this.cranePlan) return;
    const show = this.time >= this.flowVisibleAt;
    const t = this.time;
    this.time = this.processTime;
    super.renderPose();
    const local = this.time;
    this.time = t;
    for (const carrier of this.carriers) carrier.visible = show;
    this.contact.visible = show;
    const { carryStart, carryEnd } = this.cranePlan;
    for (const { object, coilParts } of this.cargoObjects) {
      object.visible = object.visible && show;
      for (const part of coilParts) part.visible = local < carryStart;
    }
    this.crane.coil.visible = local >= carryStart && local < carryEnd;
    this.fgCoil.visible = local >= carryEnd;
    this.cranePose = cranePoseAt(this.cranePlan, local);
    this.crane.set(this.cranePose);
  }

  // Hook arm point in world space (m).
  hookWorld(target = new THREE.Vector3()) {
    return this.crane.hook.getWorldPosition(target);
  }

  // Bridge position along the runway and trolley position from the low rail, in m.
  craneReadout() {
    const p = this.cranePose;
    return { bridge: (p.x - this.flow.u0) / 1000, trolley: Math.abs(p.y - this.flow.crane.railLow) / 1000, hook: p.z / 1000 };
  }

  // Coil centre in drawing mm.
  coilPosition() {
    if (!this.flow) return null;
    const local = this.processTime;
    const { carryStart, carryEnd } = this.cranePlan;
    let world;
    if (local >= carryStart && local < carryEnd) world = this.hookWorld();
    else if (local >= carryEnd) world = this.fgCoil.getWorldPosition(new THREE.Vector3());
    else {
      const object = this.cargoObjects[0]?.object;
      if (!object) return null;
      world = object.position.clone().setY(object.position.y + COIL_CENTRE);
    }
    return { x: world.x * 1000, y: -world.z * 1000, z: world.y * 1000 };
  }

  // Cranes roll in along the runway.
  slide(pivot, metres) {
    const base = pivot.userData.base ?? (pivot.userData.base = pivot.position.clone());
    pivot.position.x = base.x + (this.alongX ? metres : 0);
    pivot.position.z = base.z + (this.alongX ? 0 : -metres);
  }

  // Procedural cranes, one per bay, in the order of this.bays.
  craneInfo() {
    return this.plant.cranes.map((c, i) => ({ index: i + 1, bay: c.attrs.BAY, x: c.x, y: c.y, span: Number(c.attrs.SPAN), replaced: this.hiddenCranes.has(c.attrs.BAY) }));
  }

  // A crane model mounted in a bay replaces that bay's procedural crane.
  setCraneHidden(bay, hidden) {
    // The process bay always shows its working crane instead of the sketch one.
    if (!hidden && this.flow && bay === this.flow.bay.name) return;
    if (hidden) this.hiddenCranes.add(bay);
    else this.hiddenCranes.delete(bay);
    // Cranes are merged per material, so rebuild them with the hidden ones left out.
    const content = this.built.stages.crane.children[0];
    for (const child of [...content.children]) {
      content.remove(child);
      child.geometry?.dispose();
    }
    for (const crane of this.plant.cranes) if (!this.hiddenCranes.has(crane.attrs.BAY)) buildCrane(crane, content);
  }

  bay(name) {
    const key = String(name ?? '').trim().toUpperCase().replace(/跨$/, '').replace(/\s/g, '');
    return this.bays.find((b) => b.name === key) ?? this.bays[Number(key) - 1];
  }

  // CAD point for "bay B, 40 m from the start of the runway".
  bayPoint(name, along = null) {
    const b = this.bay(name);
    if (!b) throw new Error(`没有 ${name} 跨，可选：${this.bays.map((x) => `${x.name} 跨`).join('、')}`);
    const hb = this.hallBounds;
    const [u0, u1] = this.alongX ? [hb.x0, hb.x1] : [hb.y0, hb.y1];
    const u = along === null || along === undefined ? (u0 + u1) / 2 : u0 + along * 1000;
    if (u < u0 || u > u1) throw new Error(`沿跨距离 ${along} m 超出厂房长度 0–${((u1 - u0) / 1000).toFixed(1)} m`);
    return this.alongX ? { x: u, y: b.centre, bay: b } : { x: b.centre, y: u, bay: b };
  }

}

// Travel lines and their visibility work the same as in the process plant.
for (const name of ['buildTravelLines', 'setTravelVisible', 'resize']) SceneSite.prototype[name] = ProcessSite.prototype[name];
