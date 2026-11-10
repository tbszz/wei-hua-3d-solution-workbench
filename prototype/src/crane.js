// Procedural double-girder overhead crane (示意). Named parts follow the layer names the real GLB
// will use: 大车 (girders, end trucks, rails, wheels), 小车, 吊具 (block + C-hook), 钢丝绳, 卷材.
import * as THREE from 'three';
import { COIL } from './process.js';

const mat = (color, metalness = 0.3, roughness = 0.5, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// A steel coil with its axis along local x, centred on the origin.
export function buildCoil() {
  const group = new THREE.Group();
  group.name = '卷材';
  const r = COIL.diameter / 2000;
  const half = COIL.width / 2000;
  const steel = mat(0xaeb4ba, 0.92, 0.3);
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, half * 2, 56, 1, true), steel);
  shell.rotation.z = Math.PI / 2;
  shell.castShadow = true;
  group.add(shell);
  const ring = new THREE.RingGeometry(COIL.eye / 2000, r, 56);
  for (const side of [-1, 1]) {
    const face = new THREE.Mesh(ring, mat(0x8c9299, 0.9, 0.42, { side: THREE.DoubleSide }));
    face.rotation.y = (side * Math.PI) / 2;
    face.position.x = side * half;
    face.castShadow = true;
    group.add(face);
  }
  return group;
}

export function buildCrane({ railLow, railHigh, railTop }) {
  const root = new THREE.Group();
  root.name = '行车';
  const yellow = mat(0xf2b705, 0.25, 0.48);
  const red = mat(0xc8101e, 0.25, 0.45);
  const dark = mat(0x2f3236, 0.5, 0.45);
  const steel = mat(0x9aa0a6, 0.8, 0.35);

  const zLow = -railLow / 1000;
  const zHigh = -railHigh / 1000;
  const span = Math.abs(zHigh - zLow);
  const zMid = (zLow + zHigh) / 2;
  const top = railTop;

  const bridge = new THREE.Group();
  bridge.name = '大车';
  // End trucks ride the runway beams.
  for (const z of [zLow, zHigh]) {
    bridge.add(box(4.2, 0.55, 0.62, yellow, 0, top + 0.32, z));
    for (const x of [-1.7, 1.7]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.2, 20), dark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, top + 0.2, z);
      bridge.add(wheel);
    }
    bridge.add(box(0.5, 0.36, 0.5, red, 1.5, top + 0.78, z + (z === zLow ? -0.1 : 0.1)));
  }
  // Two box girders across the span.
  for (const x of [-1.05, 1.05]) {
    bridge.add(box(0.55, 0.95, span + 0.4, yellow, x, top + 1.05, zMid));
    bridge.add(box(0.12, 0.06, span + 0.4, dark, x, top + 1.56, zMid)); // trolley rail
  }
  // Walkway with handrail on the outer side of one girder.
  bridge.add(box(0.75, 0.04, span, mat(0x6b7077, 0.5, 0.6), 1.75, top + 0.62, zMid));
  for (const h of [0.6, 1.15]) bridge.add(box(0.04, 0.04, span, yellow, 2.1, top + 0.62 + h, zMid));
  for (let i = 0; i <= 8; i++) bridge.add(box(0.04, 1.15, 0.04, yellow, 2.1, top + 1.2, zLow - (span * i) / 8));
  // Cab under the girder near the low runway.
  bridge.add(box(1.4, 1.6, 1.4, mat(0xe9ebed, 0.1, 0.4), 1.6, top - 0.35, zLow - 1.6));
  bridge.add(box(1.25, 0.7, 0.02, mat(0x3b5876, 0.2, 0.15, { transparent: true, opacity: 0.75 }), 1.6, top - 0.2, zLow - 0.89));
  root.add(bridge);

  const trolley = new THREE.Group();
  trolley.name = '小车';
  const deck = top + 1.6;
  trolley.add(box(2.9, 0.32, 2.2, red, 0, deck + 0.16, 0));
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.6, 28), steel);
  drum.rotation.z = Math.PI / 2;
  drum.position.set(-0.2, deck + 0.75, 0.1);
  drum.castShadow = true;
  trolley.add(drum);
  trolley.add(box(0.7, 0.55, 0.6, red, 1.05, deck + 0.6, 0.55));
  trolley.add(box(0.5, 0.45, 0.5, dark, 1.05, deck + 0.55, -0.5));
  trolley.add(box(0.9, 0.12, 0.12, yellow, 0, deck + 1.18, -0.95));
  bridge.add(trolley);

  const ropeTop = deck - 0.05;
  const ropes = new THREE.Group();
  ropes.name = '钢丝绳';
  const ropeGeometry = new THREE.CylinderGeometry(0.018, 0.018, 1, 6).translate(0, -0.5, 0);
  for (const [x, z] of [[-0.18, -0.16], [0.18, -0.16], [-0.18, 0.16], [0.18, 0.16]]) {
    const rope = new THREE.Mesh(ropeGeometry, mat(0x2b2d30, 0.7, 0.4));
    rope.position.set(x, ropeTop, z);
    ropes.add(rope);
  }
  trolley.add(ropes);

  // 吊具: origin is the point that sits in the coil eye when engaged.
  const hook = new THREE.Group();
  hook.name = '吊具';
  const blockY = 2.55;
  hook.add(box(0.9, 0.55, 0.62, yellow, 0, blockY, 0));
  for (const z of [-0.18, 0.18]) {
    const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 24), steel);
    sheave.rotation.x = Math.PI / 2;
    sheave.position.set(0, blockY + 0.05, z);
    hook.add(sheave);
  }
  hook.add(box(0.16, 0.5, 0.16, steel, 0, blockY - 0.45, 0));
  const cHook = mat(0xc8101e, 0.3, 0.45);
  const spineX = -(COIL.width / 2000 + 0.42);
  const arch = COIL.diameter / 2000 + 0.42;
  hook.add(box(Math.abs(spineX) + 0.35, 0.34, 0.42, cHook, spineX / 2 + 0.1, arch + 0.17, 0)); // top beam
  hook.add(box(0.34, arch + 0.36, 0.42, cHook, spineX, arch / 2 + 0.02, 0)); // spine
  hook.add(box(Math.abs(spineX) + 0.85, 0.2, 0.36, cHook, (spineX + 0.85) / 2, 0.11, 0)); // arm through the eye
  hook.add(box(0.12, 0.26, 0.4, mat(0xf5b800, 0.2, 0.5), 0.8, 0.13, 0)); // arm tip pad
  trolley.add(hook);

  const coil = buildCoil();
  coil.visible = false;
  hook.add(coil);

  return {
    root,
    bridge,
    trolley,
    hook,
    ropes,
    coil,
    // Place the crane from a plan pose in mm: x bridge, y trolley, z hook-arm height.
    set(pose) {
      bridge.position.x = pose.x / 1000;
      trolley.position.z = -pose.y / 1000;
      const h = pose.z / 1000;
      hook.position.y = h;
      const length = Math.max(0.05, ropeTop - (h + blockY + 0.28));
      for (const rope of ropes.children) rope.scale.y = length;
    },
    labelPoint: new THREE.Vector3(),
  };
}
