import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CalibrationError, calibrate, imageToGround, worldToImage } from './calibrate.js';

// Synthetic photos are taken with a real three.js camera, so the test does not share maths with calibrate.js.

function rectangle({ origin, angleDeg, ab, bc, mirrored = false }) {
  const a = THREE.MathUtils.degToRad(angleDeg);
  const along = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  const across = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(mirrored ? -1 : 1);
  const A = new THREE.Vector3(...origin);
  const B = A.clone().addScaledVector(along, ab);
  return [A, B, B.clone().addScaledVector(across, bc), A.clone().addScaledVector(across, bc)];
}

function shoot({ width, height, fov, position, target }) {
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.05, 1000);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld();
  const toPixel = (point) => {
    const v = point.clone().project(camera);
    return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
  };
  return { camera, toPixel, focalPx: height / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2)) };
}

function cameraFrom(result) {
  const { camera: c, imageSize } = result;
  const camera = new THREE.PerspectiveCamera(c.fov, c.aspect, c.near, c.far);
  camera.position.set(...c.position);
  camera.quaternion.set(...c.quaternion);
  camera.updateMatrixWorld();
  return (point) => {
    const v = new THREE.Vector3(...point).project(camera);
    return [((v.x + 1) / 2) * imageSize.width, ((1 - v.y) / 2) * imageSize.height];
  };
}

// Deterministic noise in [-amplitude, amplitude].
function noise(seed, amplitude) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296 - 0.5) * 2 * amplitude;
  };
}

const SCENES = [
  { name: '手机横拍，斜看柱网', width: 4000, height: 3000, fov: 55, position: [-2, 1.6, 9], target: [3, 0, -2], rect: { origin: [-1, 0, -4], angleDeg: 10, ab: 8, bc: 6 } },
  { name: '竖拍，高机位俯看地砖', width: 3024, height: 4032, fov: 70, position: [0.5, 3.2, 4], target: [0.3, 0, -1.5], rect: { origin: [-0.6, 0, -0.3], angleDeg: -25, ab: 1.8, bc: 1.2 } },
  { name: '逆时针点选（镜像顺序）', width: 1920, height: 1080, fov: 40, position: [6, 2.2, 10], target: [0, 0, 0], rect: { origin: [-2, 0, -2], angleDeg: 35, ab: 4, bc: 3, mirrored: true } },
];

for (const scene of SCENES) {
  test(`无噪声反解：${scene.name}`, () => {
    const shot = shoot(scene);
    const corners = rectangle(scene.rect);
    const points = corners.map(shot.toPixel);
    const result = calibrate({ imageSize: scene, points, ground: { ab: scene.rect.ab, bc: scene.rect.bc } });

    assert.ok(result.ok);
    assert.ok(Math.abs(result.focalPx - shot.focalPx) / shot.focalPx < 1e-6, `焦距 ${result.focalPx} vs ${shot.focalPx}`);
    assert.ok(Math.abs(result.camera.fov - scene.fov) < 1e-5);
    assert.ok(Math.abs(result.cameraHeight - scene.position[1]) < 1e-6, `机高 ${result.cameraHeight}`);
    assert.ok(result.error < 1e-6, `误差 ${result.error}`);
    assert.ok(result.reprojectionPx < 1e-6);

    // Pose is checked frame-free: distance from the camera to each corner.
    const truePosition = new THREE.Vector3(...scene.position);
    corners.forEach((corner, i) => {
      const solved = new THREE.Vector3(...result.camera.position).distanceTo(new THREE.Vector3(...result.corners[i]));
      assert.ok(Math.abs(solved - truePosition.distanceTo(corner)) < 1e-6);
    });

    // The returned three.js camera reproduces the clicks and also points above the floor (catches a mirrored pose).
    const project = cameraFrom(result);
    result.corners.forEach((corner, i) => {
      const p = project(corner);
      assert.ok(Math.hypot(p[0] - points[i][0], p[1] - points[i][1]) < 1e-4);
    });
    const raised = (corner) => [corner[0], 1.5, corner[2]];
    const truth = shot.toPixel(corners[2].clone().setY(1.5));
    const solved = project(raised(result.corners[2]));
    assert.ok(Math.hypot(truth[0] - solved[0], truth[1] - solved[1]) < 1e-4, `离地 1.5 m 的点 ${solved} vs ${truth}`);
  });
}

test('点选有 ±0.5 像素抖动：已知长度反算误差 < 0.5%，焦距和机高误差小', () => {
  const scene = SCENES[0];
  const shot = shoot(scene);
  const jitter = noise(7, 0.5);
  const points = rectangle(scene.rect).map(shot.toPixel).map(([u, v]) => [u + jitter(), v + jitter()]);
  const result = calibrate({ imageSize: scene, points, ground: { ab: 8, bc: 6 } });
  assert.ok(result.ok);
  assert.ok(result.error < 0.005, `误差 ${result.error}`);
  assert.ok(Math.abs(result.focalPx - shot.focalPx) / shot.focalPx < 0.03, `焦距 ${result.focalPx} vs ${shot.focalPx}`);
  assert.ok(Math.abs(result.cameraHeight - 1.6) < 0.05, `机高 ${result.cameraHeight}`);
});

test('边长填错（实际 8 m 填成 7 m）：误差超过 3%，不能出图', () => {
  const scene = SCENES[0];
  const shot = shoot(scene);
  const points = rectangle(scene.rect).map(shot.toPixel);
  const result = calibrate({ imageSize: scene, points, ground: { ab: 7, bc: 6 } });
  assert.equal(result.ok, false);
  assert.ok(result.error > 0.03);
  assert.match(result.message, /超过 3%/);
});

test('点歪一个角（偏 2% 画面）：误差超过 3%', () => {
  const scene = SCENES[0];
  const shot = shoot(scene);
  const points = rectangle(scene.rect).map(shot.toPixel);
  points[2] = [points[2][0] + 100, points[2][1]];
  const result = calibrate({ imageSize: scene, points, ground: { ab: 8, bc: 6 } });
  assert.equal(result.ok, false);
});

test('已知四边形（非矩形）也能标定', () => {
  const scene = SCENES[0];
  const shot = shoot(scene);
  const quad = [[0, 0], [7, 0.5], [6, 5], [-0.5, 4]];
  const points = quad.map(([x, y]) => shot.toPixel(new THREE.Vector3(x, 0, -y)));
  const result = calibrate({ imageSize: scene, points, ground: { quad } });
  assert.ok(result.error < 1e-6);
  assert.ok(Math.abs(result.focalPx - shot.focalPx) / shot.focalPx < 1e-6);
});

test('imageToGround 和 worldToImage 互逆，地平线以上返回 null', () => {
  const scene = SCENES[0];
  const shot = shoot(scene);
  const result = calibrate({ imageSize: scene, points: rectangle(scene.rect).map(shot.toPixel), ground: { ab: 8, bc: 6 } });
  const ground = imageToGround(result, [2100, 2400]);
  assert.equal(ground[1], 0);
  const back = worldToImage(result, ground);
  assert.ok(Math.hypot(back[0] - 2100, back[1] - 2400) < 1e-6);
  assert.equal(imageToGround(result, [2000, 10]), null);
});

const SIZE = { width: 4000, height: 3000 };
const GOOD = [[1000, 2600], [3000, 2600], [2600, 1600], [1400, 1600]];

for (const [name, input, pattern] of [
  ['三点共线', { points: [[500, 2000], [1500, 2000], [2500, 2000], [1500, 1200]] }, /一条直线/],
  ['两点太近', { points: [[1000, 2600], [1020, 2610], [2600, 1600], [1400, 1600]] }, /太近/],
  ['顺序交叉', { points: [GOOD[0], GOOD[1], GOOD[3], GOOD[2]] }, /交叉/],
  ['只点了 3 个点', { points: GOOD.slice(0, 3) }, /4 个点/],
  ['点在照片外', { points: [[-50, 2600], ...GOOD.slice(1)] }, /照片外/],
  ['边长为 0', { ground: { ab: 0, bc: 6 } }, /AB 边长/],
  ['边长不是数字', { ground: { ab: 8, bc: Number.NaN } }, /BC 边长/],
  ['正对地面拍（没有透视）', { points: [[1000, 2500], [3000, 2500], [3000, 1000], [1000, 1000]], ground: { ab: 4, bc: 3 } }, /透视太弱/],
]) {
  test(`退化输入给出可读错误：${name}`, () => {
    assert.throws(
      () => calibrate({ imageSize: SIZE, points: GOOD, ground: { ab: 8, bc: 6 }, ...input }),
      (error) => error instanceof CalibrationError && pattern.test(error.message),
    );
  });
}
