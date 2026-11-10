// The process site: the demo's Site (CAD plant, AGV timeline) plus a crane bay, a hand-off point,
// a finished-goods saddle, the five-step process, step playback and travel lines.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { PALLET, RAIL, buildCargoObject, buildPlant, updateCutaway } from '../../demo/src/scene/build-scene.js';
import { obstaclesOf } from '../../demo/src/scene/clearance.js';
import { parseCad } from '../../demo/src/scene/parse-cad.js';
import { MOTION, buildTimeline, poseAt } from '../../demo/src/scene/route.js';
import { Site } from '../../demo/src/scene/site.js';
import { buildCoil, buildCrane } from './crane.js';
import { CRANE_MOTION, COIL, composeProcess, cranePoseAt, efficiency, ganttBlocks, planCrane, travelStats } from './process.js';

// Coil centre above the cargo object's origin (see buildCargoObject in the demo).
const COIL_CENTRE = PALLET.thickness + 0.03 + 0.22 + 0.8 - 0.18;
const SADDLE = 0.15;
const LANE_Y = 26000;
const COLUMN_PITCH = 8000;

export class ProcessSite extends Site {
  motion = { ...MOTION };

  craneMotion = structuredClone(CRANE_MOTION);

  roles = { pick: 'RM-01', handoff: 'H-01', drop: 'FG-A', home: 'CHG-01' };

  // Points the CAD does not have yet. role: handoff (AGV drop + crane pick), drop (crane floor drop), marker.
  extras = [
    { id: 'H-01', name: '吊装交接点', role: 'handoff', x: 44000, y: 33000 },
    { id: 'FG-A', name: '成品区', role: 'drop', x: 66000, y: 35500 },
  ];

  agvCount = 1;

  target = null;

  window = null;

  travelVisible = false;

  async loadBase(text, sourceName) {
    this.base = parseCad(text);
    this.sourceName = sourceName;
    const beams = this.base.beams.map((b) => b.points[0].y).sort((a, b) => a - b);
    // The crane bay is between the two highest runway beams.
    this.runway = { low: beams.at(-2), high: beams.at(-1) };
    this.rebuild();
  }

  stationNames() {
    const all = new Map();
    for (const s of this.base.stations) all.set(s.id, s.id);
    for (const e of this.extras) all.set(e.id, e.id);
    return all;
  }

  findPoint(id) {
    const extra = this.extras.find((e) => e.id === id);
    if (extra) return { ...extra, source: '对话添加' };
    const station = this.base.stations.find((s) => s.id === id);
    if (station) return { id: station.id, name: station.type === 'CHARGE' ? '充电位' : station.type === 'PICK' ? '取货工位' : '放货工位', role: station.type.toLowerCase(), x: station.x, y: station.y, source: 'CAD' };
    return null;
  }

  points() {
    const cad = this.base.stations.map((s) => this.findPoint(s.id));
    return [...cad, ...this.extras.map((e) => ({ ...e, source: e.source ?? '对话添加' }))];
  }

  coverage() {
    return { minX: 3000, maxX: 93000, minY: this.runway.low + 1500, maxY: this.runway.high - 3000 };
  }

  // Throws a readable reason when a point cannot be used for its role.
  validatePoint({ id, role, x, y }) {
    const { minX, maxX, minY, maxY } = this.built?.bounds ?? { minX: 0, maxX: 96000, minY: 0, maxY: 42000 };
    if (x < minX + 500 || x > maxX - 500 || y < minY + 500 || y > maxY - 500) throw new Error(`点位 ${id} (${Math.round(x)}, ${Math.round(y)}) 在厂房外，厂房范围 X ${minX}–${maxX}、Y ${minY}–${maxY} mm`);
    if (role === 'handoff' || role === 'drop') {
      const c = this.coverage();
      if (y < c.minY || y > c.maxY || x < c.minX || x > c.maxX) throw new Error(`点位 ${id} 不在行车覆盖区，行车钩头可达 X ${c.minX}–${c.maxX}、Y ${c.minY}–${c.maxY} mm`);
    }
    if (role === 'handoff') {
      if (x < 17000 || x > 79000) throw new Error(`吊装交接点要能从主环线 (Y=${LANE_Y}) 直线接入，X 需在 17000–79000 mm`);
      const off = Math.abs(((x + COLUMN_PITCH / 2) % COLUMN_PITCH) - COLUMN_PITCH / 2);
      if (off < 1800) throw new Error(`X=${Math.round(x)} 的支线会穿过 Y=${this.runway.low} 的柱列（柱距 ${COLUMN_PITCH} mm），离柱中心需 ≥ 1800 mm`);
    }
  }

  composePlant() {
    const base = this.base;
    const template = base.stations.find((s) => s.block === 'AGV_STAND' && Math.abs(s.heading - Math.PI / 2) < 0.01);
    const plant = { ...base, paths: [...base.paths], cranes: [], stations: base.stations.map((s) => ({ ...s, order: [] })) };
    for (const extra of this.extras.filter((e) => e.role === 'handoff')) {
      plant.paths.push({ points: [{ x: extra.x, y: LANE_Y }, { x: extra.x, y: extra.y }], closed: false });
      plant.stations.push({
        ...template,
        id: extra.id,
        type: 'DROP',
        cargo: '',
        order: [],
        x: extra.x,
        y: extra.y,
        heading: Math.PI / 2,
        rects: template.rects.map((r) => ({ ...r, x: r.x - template.x + extra.x, y: r.y - template.y + extra.y })),
        attrs: { ID: extra.id, TYPE: 'DROP', SEQ: '' },
      });
    }
    const station = (id) => plant.stations.find((s) => s.id === id);
    const pick = station(this.roles.pick);
    const handoff = station(this.roles.handoff);
    const home = station(this.roles.home);
    if (!pick || pick.type !== 'PICK') throw new Error(`取货工位 ${this.roles.pick} 不存在或不是取货类型`);
    if (!handoff) throw new Error(`吊装交接点 ${this.roles.handoff} 不存在`);
    if (!home || home.type !== 'CHARGE') throw new Error(`返回点 ${this.roles.home} 不是充电位`);
    pick.cargo = 'COIL';
    home.order = [0, 3];
    pick.order = [1];
    handoff.order = [2];
    return plant;
  }

  rebuild() {
    const plant = this.composePlant();
    const timeline = buildTimeline(plant, this.motion);
    if (this.built) this.scene.remove(this.built.group);
    for (const item of this.cargoObjects ?? []) this.scene.remove(item.object);
    if (this.extrasGroup) this.scene.remove(this.extrasGroup);
    this.plant = plant;
    this.timeline = timeline;
    this.built = buildPlant(plant, this.textures);
    this.scene.add(this.built.group);
    this.obstacles = obstaclesOf(plant);
    this.cargoObjects = timeline.cargo.map((item) => {
      const object = buildCargoObject(item.kind);
      const coilParts = object.children.filter((c) => c.geometry?.type === 'CylinderGeometry' || c.geometry?.type === 'RingGeometry');
      this.scene.add(object);
      return { item, object, coilParts };
    });
    this.extrasGroup = new THREE.Group();
    this.scene.add(this.extrasGroup);
    this.buildCraneBay();
    this.replan();
    this.placeSun();
    this.renderPose();
  }

  buildCraneBay() {
    if (this.crane) this.scene.remove(this.crane.root);
    const beamTop = 9.4 + 0.45;
    this.crane = buildCrane({ railLow: this.runway.low, railHigh: this.runway.high, railTop: beamTop });
    this.scene.add(this.crane.root);
    const drop = this.findPoint(this.roles.drop);
    // Two saddle blocks and a floor mark for the finished coil.
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.3, roughness: 0.6 });
    for (const dx of [-0.45, 0.45]) {
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.3, SADDLE * 2, 1.4), dark);
      saddle.position.set(drop.x / 1000 + dx, SADDLE, -drop.y / 1000);
      saddle.castShadow = saddle.receiveShadow = true;
      this.extrasGroup.add(saddle);
    }
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd7000f, transparent: true, opacity: 0.12, depthWrite: false }));
    mark.position.set(drop.x / 1000, 0.012, -drop.y / 1000);
    this.extrasGroup.add(mark);
    this.fgCoil = buildCoil();
    this.fgCoil.position.set(drop.x / 1000, SADDLE + COIL.diameter / 2000, -drop.y / 1000);
    this.extrasGroup.add(this.fgCoil);
    // A previous coil already parked beside it, so the area reads as finished goods.
    const previous = buildCoil();
    previous.position.set(drop.x / 1000, SADDLE + COIL.diameter / 2000, -drop.y / 1000 - 2.2);
    for (const dx of [-0.45, 0.45]) {
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.3, SADDLE * 2, 1.4), dark);
      saddle.position.set(drop.x / 1000 + dx, SADDLE, -drop.y / 1000 - 2.2);
      this.extrasGroup.add(saddle);
    }
    this.extrasGroup.add(previous);
  }

  // Crane plan and process numbers; cheap, so it runs after every parameter change.
  replan() {
    const handoff = this.findPoint(this.roles.handoff);
    const drop = this.findPoint(this.roles.drop);
    const unload = this.timeline.steps.find((s) => s.type === 'dwell' && s.kind === 'unload');
    const pickZ = (this.deckHeight + RAIL.raised + COIL_CENTRE) * 1000;
    const dropZ = (SADDLE + COIL.diameter / 2000) * 1000;
    const home = { x: Math.max(handoff.x - 14000, 12000), y: (this.runway.low + this.runway.high) / 2, z: 7000 };
    this.cranePlan = planCrane({ home, pick: { x: handoff.x, y: handoff.y, z: pickZ }, drop: { x: drop.x, y: drop.y, z: dropZ }, ready: unload.t1, motion: this.craneMotion });
    const names = { pick: this.roles.pick, handoff: this.roles.handoff, drop: this.roles.drop, home: this.roles.home };
    this.process = composeProcess(this.timeline, this.cranePlan, names);
    this.duration = this.process.duration;
    this.gantt = ganttBlocks(this.timeline, this.cranePlan, this.duration);
    this.travel = travelStats(this.timeline, this.cranePlan);
    this.efficiency = efficiency(this.timeline, this.cranePlan, { agvCount: this.agvCount, target: this.target });
    if (this.time > this.duration) this.time = 0;
    this.buildTravelLines();
  }

  updateVehicleSize(product, state) {
    super.updateVehicleSize(product, state);
    if (this.cranePlan) this.replan();
  }

  setAgvCount(count) {
    this.agvCount = Math.max(1, Math.min(4, Math.round(Number(count) || 1)));
    this.syncVehicleFleet(this.agvCount);
    this.replan();
  }

  setMotion({ agvSpeed, bridgeSpeed, trolleySpeed, hoistSpeed, travelHeight }) {
    if (agvSpeed) this.motion.laneSpeed = agvSpeed;
    if (bridgeSpeed) this.craneMotion.bridge.speed = bridgeSpeed;
    if (trolleySpeed) this.craneMotion.trolley.speed = trolleySpeed;
    if (hoistSpeed) this.craneMotion.hoist.speed = hoistSpeed;
    if (travelHeight) this.craneMotion.travelHeight = travelHeight;
    if (agvSpeed) this.rebuild();
    else this.replan();
  }

  // Play the whole cycle (window null) or just one step's time window.
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

  update(delta, camera) {
    if (!this.timeline) return;
    updateCutaway(this.built.sides, camera, this.built.roof);
    if (this.playing) {
      this.time += delta * this.speed;
      if (this.window) {
        if (this.time >= this.window.t1) {
          this.time = this.window.t1;
          this.playing = false;
          this.onWindowEnd?.(this.window);
        }
      } else if (this.time >= this.duration) this.time %= this.duration;
    }
    this.renderPose();
  }

  renderPose() {
    if (!this.cranePlan) return;
    super.renderPose();
    const t = this.time;
    const { carryStart, carryEnd } = this.cranePlan;
    const carried = t >= carryStart && t < carryEnd;
    const landed = t >= carryEnd;
    for (const { coilParts } of this.cargoObjects) for (const part of coilParts) part.visible = t < carryStart;
    this.crane.coil.visible = carried;
    this.fgCoil.visible = landed;
    this.cranePose = cranePoseAt(this.cranePlan, t);
    this.crane.set(this.cranePose);
  }

  // Which process step is active at time t (the latest-starting one that covers t).
  stepAt(t = this.time) {
    if (this.window) return this.process.steps[this.window.step - 1];
    const covering = this.process.steps.filter((s) => t >= s.t0 && t < s.t1);
    return covering.at(-1) ?? this.process.steps.at(-1);
  }

  coilPosition() {
    const t = this.time;
    const { carryStart, carryEnd } = this.cranePlan;
    if (t >= carryStart && t < carryEnd) return { x: this.cranePose.x, y: this.cranePose.y, z: this.cranePose.z };
    if (t >= carryEnd) return { ...this.cranePlan.drop };
    const object = this.cargoObjects[0]?.object;
    if (!object) return null;
    return { x: object.position.x * 1000, y: -object.position.z * 1000, z: (object.position.y + COIL_CENTRE) * 1000 };
  }

  buildTravelLines() {
    if (this.travelGroup) {
      this.scene.remove(this.travelGroup);
      this.travelGroup.traverse((o) => o.geometry?.dispose());
    }
    this.travelGroup = new THREE.Group();
    this.travelGroup.visible = this.travelVisible;
    this.scene.add(this.travelGroup);
    this.lineMaterials = [];
    const line = (points, color, width, dashed = false) => {
      if (points.length < 2) return;
      const geometry = new LineGeometry();
      geometry.setPositions(points.flat());
      const material = new LineMaterial({ color, linewidth: width, dashed, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.95, depthTest: false });
      material.resolution.set(innerWidth, innerHeight);
      const object = new Line2(geometry, material);
      object.computeLineDistances();
      object.renderOrder = 10;
      this.lineMaterials.push(material);
      this.travelGroup.add(object);
    };
    // AGV: loaded legs blue, empty legs green dashed.
    let current = null;
    const flush = () => {
      if (current) line(current.points, current.loaded ? 0x2b7de9 : 0x2ea121, current.loaded ? 5 : 3.5, !current.loaded);
    };
    for (const step of this.timeline.steps) {
      if (step.type !== 'run') continue;
      const loaded = Boolean(step.loaded);
      if (!current || current.loaded !== loaded) {
        flush();
        current = { loaded, points: [] };
      }
      const n = Math.max(2, Math.ceil(step.length / 400));
      for (let i = 0; i <= n; i++) {
        const p = poseAt(this.timeline, step.t0 + (step.duration * i) / n);
        current.points.push([p.x / 1000, 0.06, -p.y / 1000]);
      }
    }
    flush();
    // Crane hook path, red.
    const hookPoints = [];
    for (let t = this.cranePlan.start; t <= this.cranePlan.end; t += 0.5) {
      const p = cranePoseAt(this.cranePlan, t);
      hookPoints.push([p.x / 1000, p.z / 1000, -p.y / 1000]);
    }
    line(hookPoints, 0xd7000f, 4, true);
  }

  setTravelVisible(visible) {
    this.travelVisible = visible;
    if (this.travelGroup) this.travelGroup.visible = visible;
  }

  resize(width, height) {
    for (const m of this.lineMaterials ?? []) m.resolution.set(width, height);
  }

  addPoint({ id, name, role, x, y }) {
    if (this.findPoint(id)) throw new Error(`点位 ${id} 已存在`);
    this.validatePoint({ id, role, x, y });
    this.extras.push({ id, name, role, x, y });
    if (role === 'handoff') this.rebuild();
    return this.findPoint(id);
  }

  setRoles(roles) {
    const previous = { ...this.roles };
    Object.assign(this.roles, roles);
    try {
      const drop = this.findPoint(this.roles.drop);
      if (!drop) throw new Error(`放卷点 ${this.roles.drop} 不存在`);
      const handoff = this.findPoint(this.roles.handoff);
      if (!handoff || handoff.role !== 'handoff') throw new Error(`${this.roles.handoff} 不是吊装交接点（需 role=handoff，AGV 可达且在行车覆盖区）`);
      this.validatePoint({ ...drop, role: 'drop' });
      this.rebuild();
    } catch (error) {
      this.roles = previous;
      this.rebuild();
      throw error;
    }
  }
}
