// A plant generated from any factory drawing: no AGV process, just the building, its crane
// bays and a construction sequence (ground -> columns -> runway -> cranes -> envelope ->
// equipment -> roof) that plays on the same step list and timeline as the process.
import * as THREE from 'three';
import { buildCrane, buildPlant, updateCutaway } from '../../demo/src/scene/build-scene.js';
import { inferPlant } from '../../demo/src/scene/infer-plant.js';
import { Site } from '../../demo/src/scene/site.js';

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

  // Copy the HDR environment and textures from the site that already loaded them.
  share(from) {
    this.scene.environment = from.scene.environment;
    this.scene.environmentIntensity = from.scene.environmentIntensity;
    this.textures = from.textures;
    this.contact.visible = false;
  }

  loadDrawing(text, sourceName, asset = null) {
    const { plant, summary, bays, bounds, alongX } = inferPlant(text, sourceName);
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
    this.scene.add(this.built.group);
    this.timeline = { scene: true };
    this.process = { steps: this.buildSteps() };
    this.duration = this.process.steps.at(-1).t1;
    this.time = 0;
    this.playing = true;
    this.window = null;
    this.hiddenCranes = new Set();
    this.placeSun();
    this.renderPose();
  }

  buildSteps() {
    const s = this.summary;
    const st = this.built.stages;
    const span = this.bays.length ? `${this.bays.length} 跨 × ${(this.bays[0].span / 1000).toFixed(1)} m` : '单跨';
    const plan = [
      ['ground', '场地与地坪', `厂房 ${s.厂房_m[0]} × ${s.厂房_m[1]} m，涂装混凝土地坪${s.厂区 ? '，厂区道路' : ''}；地面标线 ${s.地面线条} 条、分区 ${s.分区} 个${s.轨道 ? `、轨道 ${s.轨道} 条` : ''}`, 3],
      ['frame', '立柱吊装', `钢柱 ${s.柱.钢柱} 根、混凝土柱 ${s.柱.混凝土柱} 根，柱线 ${s.柱线} 条${s.柱距_m ? `，柱距 ${s.柱距_m} m` : ''}（按图纸截面拉伸）`, 4],
      ['beam', '吊车梁', `吊车梁 ${s.吊车梁} 根，${span}，梁底 8.95 m`, 2.5],
      ['crane', '行车就位', `双梁桥式起重机 ${s.行车} 台，每跨一台，轨上高 9.8 m`, 2.5],
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
    if (this.window) return this.process.steps[this.window.step - 1];
    return this.process.steps.find((s) => t < s.t1) ?? this.process.steps.at(-1);
  }

  get building() {
    return this.time < this.duration;
  }

  update(delta, camera) {
    if (!this.timeline) return;
    if (this.playing) {
      this.time += delta * this.speed;
      const end = this.window ? this.window.t1 : this.duration;
      if (this.time >= end) {
        this.time = end;
        this.playing = false;
        if (this.window) this.onWindowEnd?.(this.window);
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

  resize() {}
}
