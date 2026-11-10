// three.js layer drawn over the photo: the product rendered through the calibrated camera on a transparent
// background, with a contact shadow and a directional shadow caught by an invisible floor.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyBands, loadVehicle } from '../../demo/src/vehicle.js';

const GRID = 0xffffff; // white reads on both dark and light floors
const RED = 0xd7000f;

// Same soft-edged square as the demo's site contact shadow.
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

export class PhotoOverlay {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);

  carrier = new THREE.Group();

  vehicle = null;

  product = null;

  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: false });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.8;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 1.4;

    this.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 4;
    Object.assign(this.sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 40 });
    this.scene.add(this.sun, this.sun.target);

    // Invisible floor that only shows the shadow.
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.38 }));
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: softShadowTexture(), color: 0x000000, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }),
    );
    this.contact.position.y = 0.004;
    this.carrier.add(this.contact);
    this.scene.add(this.carrier);

    this.grid = new THREE.Group();
    this.scene.add(this.grid);
  }

  setSize(width, height, pixelRatio) {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  setExposure(value) {
    this.renderer.toneMappingExposure = value;
  }

  setCalibration(calibration) {
    const { camera: c } = calibration;
    this.camera.fov = c.fov;
    this.camera.aspect = c.aspect;
    this.camera.near = c.near;
    this.camera.far = c.far;
    this.camera.position.set(...c.position);
    this.camera.quaternion.set(...c.quaternion);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.buildGrid(calibration);
  }

  // 1 m grid around the calibrated rectangle, plus the rectangle itself, to judge the calibration by eye.
  buildGrid(calibration) {
    for (const child of [...this.grid.children]) {
      child.geometry.dispose();
      child.removeFromParent();
    }
    const xs = calibration.corners.map((p) => p[0]);
    const zs = calibration.corners.map((p) => p[2]);
    const pad = 3;
    const [x0, x1] = [Math.floor(Math.min(...xs) - pad), Math.ceil(Math.max(...xs) + pad)];
    const [z0, z1] = [Math.floor(Math.min(...zs) - pad), Math.ceil(Math.max(...zs) + pad)];
    const lines = [];
    for (let x = x0; x <= x1; x++) lines.push(x, 0, z0, x, 0, z1);
    for (let z = z0; z <= z1; z++) lines.push(x0, 0, z, x1, 0, z);
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)),
      new THREE.LineBasicMaterial({ color: GRID, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }),
    );
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(calibration.corners.flat(), 3)),
      new THREE.LineBasicMaterial({ color: RED, depthWrite: false, toneMapped: false }),
    );
    grid.position.y = outline.position.y = 0.003;
    grid.renderOrder = outline.renderOrder = 2;
    this.grid.add(grid, outline);
  }

  showGrid(visible) {
    this.grid.visible = visible;
  }

  async setProduct(product) {
    const vehicle = await loadVehicle(product);
    if (this.vehicle) this.vehicle.root.removeFromParent();
    this.vehicle = vehicle;
    this.product = product;
    this.state = Object.fromEntries(Object.entries(product.params).map(([key, param]) => [key, param.nominal]));
    vehicle.root.position.set(0, 0, 0);
    vehicle.root.rotation.set(0, 0, 0);
    this.carrier.add(vehicle.root);
    this.contact.scale.set(this.state.length / 1000 + 0.3, 1, this.state.width / 1000 + 0.3);
    return this.state;
  }

  setPose({ x, z, heading }) {
    this.carrier.position.set(x, 0, z);
    this.carrier.rotation.y = THREE.MathUtils.degToRad(heading);
    // Light from high up, a little behind the camera, so the shadow falls visibly onto the floor.
    const toCamera = new THREE.Vector3().subVectors(this.camera.position, this.carrier.position).setY(0);
    if (toCamera.lengthSq() < 1e-6) toCamera.set(0, 0, 1);
    toCamera.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    this.sun.position.copy(this.carrier.position).addScaledVector(toCamera, 6).setY(14);
    this.sun.target.position.copy(this.carrier.position);
  }

  // Radius of the product footprint, for picking.
  footprintRadius() {
    if (!this.state) return 0;
    return Math.hypot(this.state.length, this.state.width) / 2000;
  }

  render() {
    if (this.product) applyBands(this.product, this.state);
    this.renderer.render(this.scene, this.camera);
  }

  // Draws photo + product at the photo's own size (capped at maxSide) and returns a 2D canvas.
  compose(photo, { maxSide = 3840, caption = '' } = {}) {
    const scale = Math.min(1, maxSide / Math.max(photo.naturalWidth, photo.naturalHeight));
    const width = Math.round(photo.naturalWidth * scale);
    const height = Math.round(photo.naturalHeight * scale);
    const canvas = this.renderer.domElement;
    const previous = { pixelRatio: this.renderer.getPixelRatio(), width: canvas.width, height: canvas.height, grid: this.grid.visible };
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.drawImage(photo, 0, 0, width, height);
    this.grid.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.render();
    ctx.drawImage(canvas, 0, 0, width, height);
    this.grid.visible = previous.grid;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(previous.width, previous.height, false);
    this.render();
    if (caption) {
      const size = Math.max(12, Math.round(width / 110));
      ctx.font = `${size}px "Microsoft YaHei UI", "PingFang SC", sans-serif`;
      const pad = size * 0.6;
      const textWidth = ctx.measureText(caption).width;
      ctx.fillStyle = 'rgba(31, 35, 41, 0.72)';
      ctx.fillRect(pad, height - pad - size * 1.8, textWidth + size * 1.2, size * 1.8);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(caption, pad + size * 0.6, height - pad - size * 0.9);
    }
    return out;
  }
}
