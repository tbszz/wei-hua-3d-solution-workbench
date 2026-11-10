// The running site: plant model, timeline playback and vehicle/cargo poses.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { PALLET, RAIL, buildCargoObject, buildPlant, loadPlantTextures, setStationLift, updateCutaway } from './build-scene.js';
import { obstaclesOf, sweptClearance } from './clearance.js';
import { parseCad } from './parse-cad.js';
import { installSurfaceDetail } from './surface-detail.js';
import { buildTimeline, cargoStateAt, poseAt } from './route.js';

export const SAMPLE_PLAN = '/cad/sample-plant.dxf';

// Depth precision follows the orbit distance. A fixed 0.1 m near plane leaves about 1 cm of depth
// resolution on the floor at the 300-500 m overview, so the floor paint (4 mm up), the route and the
// contact shadow z-fight with the floor and the whole hall flickers as soon as the camera moves.
// Keeping near at 1 % of the distance to the orbit centre stays well clear of anything in view.
export function fitDepthRange(camera, target) {
  const near = THREE.MathUtils.clamp(camera.position.distanceTo(target) * 0.01, 0.1, 20);
  if (Math.abs(near - camera.near) < camera.near * 0.02) return;
  camera.near = near;
  camera.updateProjectionMatrix();
}

function softShadowTexture() {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const edge = (v) => THREE.MathUtils.smoothstep(Math.min(v, size - 1 - v), 4, 34);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data[(y * size + x) * 4 + 3] = 255 * edge(x) * edge(y);
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class Site {
  scene = new THREE.Scene();

  time = 0;

  speed = 1;

  playing = true;

  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.scene.background = new THREE.Color(0xdfe2e5);
    this.sun = new THREE.DirectionalLight(0xfffaf2, 1.7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(quality.shadowSize);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = quality.shadowRadius;
    this.scene.add(this.sun, this.sun.target);
    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: softShadowTexture(), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -24 }),
    );
    this.contact.position.y = 0.022;
    this.scene.add(this.contact);
    this.carrier = new THREE.Group();
    this.scene.add(this.carrier);
    // The first carrier is the primary AGV used for cargo and camera tracking.
    // Additional carriers are lightweight clones that follow the same CAD route
    // with a phase offset when the plan requests more than one AGV.
    this.carriers = [this.carrier];
    this.vehicleRoot = null;
    this.vehicleProduct = null;
    this.deckHeight = 0.5;
  }

  async loadEnvironment() {
    const hdr = await new HDRLoader().loadAsync('/scene/hdri/hangar_interior_1k.hdr');
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
    this.scene.environmentIntensity = 0.85;
    hdr.dispose();
    pmrem.dispose();
    this.textures = await loadPlantTextures(this.renderer.capabilities.getMaxAnisotropy());
    // Factory wear on every lit material, including product GLBs and models uploaded later.
    installSurfaceDetail(this.textures.detail);
  }

  async loadPlanText(text, sourceName) {
    const plant = parseCad(text);
    const timeline = buildTimeline(plant);
    if (this.built) this.scene.remove(this.built.group);
    for (const item of this.cargoObjects ?? []) this.scene.remove(item.object);
    this.plant = plant;
    this.timeline = timeline;
    this.sourceName = sourceName;
    this.built = buildPlant(plant, this.textures);
    this.scene.add(this.built.group);
    this.obstacles = obstaclesOf(plant);
    this.cargoObjects = timeline.cargo.map((item) => {
      const object = buildCargoObject(item.kind);
      this.scene.add(object);
      return { item, object };
    });
    this.time = 0;
    this.placeSun();
    this.renderPose();
  }

  placeSun() {
    const { centre, size } = this.built;
    const cx = centre.x / 1000;
    const cz = -centre.y / 1000;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx - 34, 92, cz + 46);
    const camera = this.sun.shadow.camera;
    const reach = Math.hypot(size.x, size.y) / 2 + 6;
    Object.assign(camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 10, far: 240 });
    camera.updateProjectionMatrix();
  }

  setVehicle(root, product, state) {
    for (const carrier of this.carriers ?? []) {
      carrier.removeFromParent();
      carrier.clear();
    }
    this.carrier = new THREE.Group();
    this.scene.add(this.carrier);
    this.carriers = [this.carrier];
    this.vehicleRoot = root;
    this.vehicleProduct = product;
    this.carrier.add(root);
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    this.updateVehicleSize(product, state);
    this.syncVehicleFleet(this.agvCount ?? 1);
  }

  syncVehicleFleet(count = 1) {
    const wanted = Math.max(1, Math.min(4, Math.round(Number(count) || 1)));
    if (!this.vehicleRoot) return;
    while (this.carriers.length < wanted) {
      const carrier = new THREE.Group();
      carrier.add(this.vehicleRoot.clone(true));
      this.scene.add(carrier);
      this.carriers.push(carrier);
    }
    while (this.carriers.length > wanted) {
      const carrier = this.carriers.pop();
      carrier.removeFromParent();
      carrier.clear();
    }
  }

  updateVehicleSize(product, state) {
    this.vehicleSize = { length: state.length, width: state.width };
    this.protrusion = product.protrusion ?? 0;
    this.deckHeight = state.height / 1000;
    this.contact.scale.set(state.length / 1000 + 0.55, 1, state.width / 1000 + 0.55);
  }

  clearance() {
    const vehicle = { length: this.vehicleSize.length + this.protrusion * 2, width: this.vehicleSize.width + this.protrusion * 2 };
    return sweptClearance(this.timeline, this.obstacles, vehicle, PALLET);
  }

  update(delta, camera) {
    if (!this.timeline) return;
    updateCutaway(this.built.sides, camera, this.built.roof);
    if (this.playing) {
      this.time += delta * this.speed;
      if (this.time >= this.timeline.duration) this.time %= this.timeline.duration;
    }
    this.renderPose();
  }

  renderPose() {
    this.pose = poseAt(this.timeline, this.time);
    const routeDuration = this.timeline.duration;
    for (let index = 0; index < this.carriers.length; index += 1) {
      const phase = index === 0 ? 0 : (routeDuration * index) / this.carriers.length;
      const pose = poseAt(this.timeline, (this.time + phase) % routeDuration);
      this.carriers[index].position.set(pose.x / 1000, 0, -pose.y / 1000);
      this.carriers[index].rotation.y = pose.heading;
    }
    const { x, y, heading } = this.pose;
    this.contact.position.x = x / 1000;
    this.contact.position.z = -y / 1000;
    this.contact.rotation.y = heading;

    const deck = this.deckHeight;
    const railLow = deck + RAIL.lowered;
    const railHigh = deck + RAIL.raised;
    const lifts = new Map();
    for (const { item, object } of this.cargoObjects) {
      const state = cargoStateAt(item, this.time);
      if (state.on === 'vehicle') {
        object.visible = true;
        object.position.set(x / 1000, deck, -y / 1000);
        object.rotation.y = heading;
        lifts.set(item.from.id, Math.max(lifts.get(item.from.id) ?? 0, 0));
        continue;
      }
      const station = state.on === 'from' ? item.from : item.to;
      const railTop = railLow + (railHigh - railLow) * state.lift;
      object.visible = true;
      object.position.set(station.x / 1000, Math.max(deck, railTop), -station.y / 1000);
      object.rotation.y = station.heading;
      lifts.set(station.id, Math.max(lifts.get(station.id) ?? 0, state.lift));
    }
    for (const dynamic of this.built.stations) {
      if (dynamic.rails.length) setStationLift(dynamic, railLow + (railHigh - railLow) * (lifts.get(dynamic.station.id) ?? 0));
    }
  }

  // A plain-language line for what the AGV is doing now, plus the index of the current stop.
  status() {
    const { step } = this.pose;
    const stops = this.timeline.stops;
    let stop = 0;
    for (const candidate of this.timeline.steps) {
      if (candidate.t0 > step.t0) break;
      if (candidate.type === 'dwell' && candidate.kind === 'settle') stop += 1;
    }
    const next = stops[Math.min(stop + (step.type === 'dwell' && step.kind !== 'charge' ? 0 : 1), stops.length - 1)];
    let text;
    if (step.type === 'turn') text = `原地转向，前往 ${next.id}`;
    else if (step.type === 'run') text = `${step.gear < 0 ? '倒车驶出' : '行驶'}，前往 ${next.id}${step.loaded ? '（载货）' : ''}`;
    else if (step.kind === 'load') text = `${step.station.id} 支架下降，货物落到车上`;
    else if (step.kind === 'unload') text = `${step.station.id} 支架上升，货物离车`;
    else if (step.kind === 'settle') text = `到达 ${step.station.id}，定位校准`;
    else text = `${step.station.id} 充电`;
    return { text, stop };
  }
}
