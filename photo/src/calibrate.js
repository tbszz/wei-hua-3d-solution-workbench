// Photo calibration from four ground points.
//
// The user clicks the four corners of a rectangle lying on the floor (tiles, a painted bay, a column grid)
// and types the length of two adjacent sides. Assuming the principal point is the image centre and pixels
// are square, the camera has 7 unknowns (focal length + 6 pose); the four points give 8 equations, so one
// is left over. After fitting, the clicked corners are cast back onto the floor and the four side lengths are
// compared with the typed ones. That relative error is what decides whether the photo may be exported.
//
// No three.js dependency. Output coordinates follow three.js: metres, y up, floor at y = 0.
//
// Internally the floor is a plane frame (X, Y, Z = 0) and the camera follows the OpenCV convention
// (x right, y down, z forward): image = K (R P + t).

export const MAX_ERROR = 0.03;
export const CORNER_NAMES = ['A', 'B', 'C', 'D'];

const SIDES = [[0, 1], [1, 2], [2, 3], [3, 0]];
const MIN_SPREAD = 0.02; // shortest allowed distance between two points, as a share of the image diagonal
const MIN_HEIGHT = 0.01; // three points closer than this (share of diagonal) to one line count as collinear
const MIN_DEPTH_RATIO = 1.05; // farthest corner must be at least 5 % farther from the camera than the nearest
const FOCAL_35MM = [13, 200]; // plausible phone/camera range; outside it the photo was probably cropped

export class CalibrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalibrationError';
  }
}

const fail = (message) => {
  throw new CalibrationError(message);
};

// Small linear algebra

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => Math.hypot(...a);
const scale = (a, k) => a.map((v) => v * k);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const matVec = (m, v) => m.map((row) => dot(row, v));
const transpose = (m) => m[0].map((_, j) => m.map((row) => row[j]));
const matMul = (a, b) => a.map((row) => transpose(b).map((col) => dot(row, col)));

function solveLinear(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const k = a[row][col] / a[col][col];
      for (let c = col; c <= n; c++) a[row][c] -= k * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

function rodrigues(w) {
  const theta = norm(w);
  const [x, y, z] = theta < 1e-12 ? [0, 0, 0] : scale(w, 1 / theta);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

// Nearest rotation to the columns r1, r2 (Gram-Schmidt split evenly between the two).
function rotationFromColumns(r1, r2) {
  const a = scale(r1, 1 / norm(r1));
  const b = scale(r2, 1 / norm(r2));
  const bisector = scale(sub(a, scale(b, -1)), 0.5);
  const half = scale(sub(a, b), 0.5);
  const x = scale(bisector, 1 / norm(bisector));
  const y = scale(half, 1 / norm(half));
  const c1 = scale(sub(x, scale(y, -1)), Math.SQRT1_2);
  const c2 = scale(sub(x, y), Math.SQRT1_2);
  const c3 = cross(c1, c2);
  return transpose([c1, c2, c3]);
}

// Input checks

function readPoint(point, label) {
  const [u, v] = Array.isArray(point) ? point : [point?.x, point?.y];
  if (!Number.isFinite(u) || !Number.isFinite(v)) fail(`点 ${label} 的坐标不是数字。`);
  return [u, v];
}

function readGround(ground) {
  if (ground?.quad) {
    if (ground.quad.length !== 4) fail('已知四边形要给 4 个地面坐标。');
    return ground.quad.map((p, i) => readPoint(p, `${CORNER_NAMES[i]}（地面）`));
  }
  const { ab, bc } = ground ?? {};
  if (!Number.isFinite(ab) || ab <= 0) fail('AB 边长要填大于 0 的数（单位：米）。');
  if (!Number.isFinite(bc) || bc <= 0) fail('BC 边长要填大于 0 的数（单位：米）。');
  return [[0, 0], [ab, 0], [ab, bc], [0, bc]];
}

const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function checkQuad(points, size, where) {
  const minDistance = MIN_SPREAD * size;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      if (d < minDistance) {
        fail(`${where}点 ${CORNER_NAMES[i]} 和 ${CORNER_NAMES[j]} 太近（相距 ${d.toFixed(1)}，至少要 ${minDistance.toFixed(1)}）。请把 4 个点分散到更大的范围。`);
      }
    }
  }
  for (const skip of [3, 2, 1, 0]) {
    const idx = [0, 1, 2, 3].filter((i) => i !== skip);
    const [a, b, c] = idx.map((i) => points[i]);
    const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]), Math.hypot(a[0] - c[0], a[1] - c[1]));
    const height = Math.abs(turn(a, b, c)) / longest;
    if (height < MIN_HEIGHT * size) {
      fail(`${where}点 ${idx.map((i) => CORNER_NAMES[i]).join('、')} 几乎在一条直线上。4 个点要是矩形的 4 个角，不能有 3 个点共线。`);
    }
  }
  const turns = [0, 1, 2, 3].map((i) => Math.sign(turn(points[i], points[(i + 1) % 4], points[(i + 2) % 4])));
  if (!turns.every((s) => s === turns[0])) {
    fail(`${where}4 个点围成的形状有交叉或凹角。请按 A→B→C→D 顺着矩形的边点一圈。`);
  }
}

// Homography from plane (X, Y) to image (x, y): x ~ H [X, Y, 1].

function normalizer(points) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const spread = points.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / points.length;
  const k = Math.SQRT2 / spread;
  return { matrix: [[k, 0, -k * cx], [0, k, -k * cy], [0, 0, 1]], inverse: [[1 / k, 0, cx], [0, 1 / k, cy], [0, 0, 1]] };
}

function homography(from, to) {
  const nf = normalizer(from);
  const nt = normalizer(to);
  const apply = (m, p) => {
    const q = matVec(m, [p[0], p[1], 1]);
    return [q[0] / q[2], q[1] / q[2]];
  };
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = apply(nf.matrix, from[i]);
    const [x, y] = apply(nt.matrix, to[i]);
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]);
    b.push(x);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]);
    b.push(y);
  }
  const h = solveLinear(A, b);
  if (!h) fail('4 个点算不出透视关系，请检查点的位置。');
  const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  return matMul(matMul(nt.inverse, Hn), nf.matrix);
}

// Camera model

function project(camera, P) {
  const c = matVec(camera.R, [P[0], P[1], 0]).map((v, i) => v + camera.t[i]);
  if (c[2] <= 1e-9) return null;
  return [(camera.f * c[0]) / c[2], (camera.f * c[1]) / c[2]];
}

function poseFromHomography(H, f) {
  const cols = transpose(H);
  const b = cols.map((h) => [h[0] / f, h[1] / f, h[2]]);
  let lambda = 2 / (norm(b[0]) + norm(b[1]));
  if (b[2][2] * lambda < 0) lambda = -lambda; // plane origin in front of the camera
  const R = rotationFromColumns(scale(b[0], lambda), scale(b[1], lambda));
  return { f, R, t: scale(b[2], lambda) };
}

function residuals(camera, world, image) {
  const out = [];
  for (let i = 0; i < world.length; i++) {
    const p = project(camera, world[i]);
    if (!p) return null;
    out.push(p[0] - image[i][0], p[1] - image[i][1]);
  }
  return out;
}

const cost = (r) => (r ? dot(r, r) : Infinity);

function perturb(camera, delta) {
  return {
    f: camera.f * Math.exp(delta[0]),
    R: matMul(rodrigues(delta.slice(1, 4)), camera.R),
    t: camera.t.map((v, i) => v + delta[4 + i]),
  };
}

// Levenberg-Marquardt over log focal, a local rotation increment and translation.
function refine(start, world, image) {
  let camera = start;
  let r = residuals(camera, world, image);
  let current = cost(r);
  if (!Number.isFinite(current)) return null;
  let lambda = 1e-3;
  const step = 1e-6;
  for (let iter = 0; iter < 200 && current > 1e-24; iter++) {
    const J = [];
    for (let k = 0; k < 7; k++) {
      const d = new Array(7).fill(0);
      d[k] = step;
      const plus = residuals(perturb(camera, d), world, image);
      d[k] = -step;
      const minus = residuals(perturb(camera, d), world, image);
      if (!plus || !minus) return null;
      J.push(plus.map((v, i) => (v - minus[i]) / (2 * step)));
    }
    const A = J.map((a) => J.map((b) => dot(a, b)));
    const g = J.map((a) => dot(a, r));
    let improved = false;
    while (lambda < 1e12) {
      const damped = A.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (v + 1e-12) : v)));
      const delta = solveLinear(damped, g.map((v) => -v));
      if (delta) {
        const candidate = perturb(camera, delta);
        const rc = residuals(candidate, world, image);
        const next = cost(rc);
        if (next < current) {
          const gain = current - next;
          camera = candidate;
          r = rc;
          lambda = Math.max(lambda / 3, 1e-12);
          improved = true;
          if (gain < 1e-15 * current) iter = Infinity;
          current = next;
          break;
        }
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { camera, cost: current };
}

// Back-project an image point onto the plane Z = 0. Returns plane (X, Y) or null above the horizon.
function toPlane(camera, [x, y]) {
  const Rt = transpose(camera.R);
  const centre = scale(matVec(Rt, camera.t), -1);
  const ray = matVec(Rt, [x / camera.f, y / camera.f, 1]);
  if (Math.abs(ray[2]) < 1e-12) return null;
  const s = -centre[2] / ray[2];
  if (s <= 0) return null;
  return [centre[0] + s * ray[0], centre[1] + s * ray[1]];
}

// three.js mapping. Plane (X, Y, Z) -> world (X, side * Z, -side * Y), side picks the half-space holding the camera.
const toWorld = (side, [X, Y, Z]) => [X, side * Z + 0, -side * Y + 0]; // + 0 turns -0 into 0
const fromWorld = (side, [x, y, z]) => [x, -side * z, side * y];

function quaternionFromBasis(x, y, z) {
  const [m11, m21, m31] = x;
  const [m12, m22, m32] = y;
  const [m13, m23, m33] = z;
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/**
 * Calibrate a photo from four floor points.
 * @param {object} input
 * @param {{width:number,height:number}} input.imageSize photo size in pixels
 * @param {Array<[number,number]|{x:number,y:number}>} input.points corners A, B, C, D in pixels, in order round the shape
 * @param {{ab:number,bc:number}|{quad:Array<[number,number]>}} input.ground rectangle side lengths in metres,
 *   or the four corners' floor coordinates in metres
 * @param {number} [input.maxError] export threshold, default 3 %
 */
export function calibrate({ imageSize, points, ground, maxError = MAX_ERROR }) {
  const { width, height } = imageSize ?? {};
  if (!(width > 0 && height > 0)) fail('照片尺寸无效。');
  if (!Array.isArray(points) || points.length !== 4) fail(`要在地面上点 4 个点，现在是 ${points?.length ?? 0} 个。`);
  const pixels = points.map((p, i) => readPoint(p, CORNER_NAMES[i]));
  const plane = readGround(ground);
  const diagonal = Math.hypot(width, height);

  pixels.forEach(([u, v], i) => {
    if (u < 0 || v < 0 || u > width || v > height) fail(`点 ${CORNER_NAMES[i]} 在照片外面。`);
  });
  checkQuad(pixels, diagonal, '');
  const planeSize = Math.max(...plane.flat()) - Math.min(...plane.flat());
  checkQuad(plane, planeSize, '地面坐标里，');

  // Work in centred image coordinates divided by the longer side, so the focal length is around 1.
  const unit = Math.max(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const image = pixels.map(([u, v]) => [(u - cx) / unit, (v - cy) / unit]);

  const H = homography(plane, image);
  // The third row of H is proportional to each corner's depth. Without a depth spread the focal length is unobservable.
  const depths = plane.map(([X, Y]) => Math.abs(H[2][0] * X + H[2][1] * Y + H[2][2]));
  if (Math.max(...depths) / Math.min(...depths) < MIN_DEPTH_RATIO) {
    fail('照片几乎是正对地面拍的，透视太弱，算不出焦距。请斜着拍，让地面上的平行线在照片里明显汇聚。');
  }
  const [h1, h2] = transpose(H);
  const guesses = [
    -(h1[0] * h2[0] + h1[1] * h2[1]) / (h1[2] * h2[2]),
    (h2[0] ** 2 + h2[1] ** 2 - h1[0] ** 2 - h1[1] ** 2) / (h1[2] ** 2 - h2[2] ** 2),
  ]
    .filter((f2) => Number.isFinite(f2) && f2 > 0)
    .map(Math.sqrt)
    .filter((f) => f > 0.05 && f < 50);
  guesses.push(0.5, 0.75, 1.1, 1.6, 2.5);

  let best = null;
  for (const f of guesses) {
    const fit = refine(poseFromHomography(H, f), plane, image);
    if (fit && fit.camera.f > 0 && (!best || fit.cost < best.cost)) best = fit;
  }
  if (!best || !Number.isFinite(best.cost)) fail('这 4 个点和地面矩形对不上，找不到合理的相机位置。请检查点的顺序和位置。');

  const { camera } = best;
  const Rt = transpose(camera.R);
  const centre = scale(matVec(Rt, camera.t), -1);
  const side = centre[2] >= 0 ? 1 : -1;
  const focalPx = camera.f * unit;
  const reprojectionPx = Math.sqrt(best.cost / 4) * unit;

  const measured = image.map((p) => toPlane(camera, p));
  if (measured.some((p) => !p)) fail('有的点落在地平线以上，不在地面上。请重新点。');
  const checks = SIDES.map(([i, j]) => {
    const known = Math.hypot(plane[j][0] - plane[i][0], plane[j][1] - plane[i][1]);
    const length = Math.hypot(measured[j][0] - measured[i][0], measured[j][1] - measured[i][1]);
    return { side: CORNER_NAMES[i] + CORNER_NAMES[j], known, measured: length, error: Math.abs(length - known) / known };
  });
  const error = Math.max(...checks.map((c) => c.error));
  const ok = error <= maxError;

  // three.js camera: local x right, y up, looking down -z.
  const camX = toWorld(side, camera.R[0]);
  const camY = toWorld(side, scale(camera.R[1], -1));
  const camZ = toWorld(side, scale(camera.R[2], -1));
  const position = toWorld(side, centre);
  const fov = (2 * Math.atan(height / 2 / focalPx) * 180) / Math.PI;
  const forward = scale(camZ, -1);
  const pitch = (Math.asin(Math.max(-1, Math.min(1, -forward[1]))) * 180) / Math.PI;
  const corners = plane.map((p) => toWorld(side, [p[0], p[1], 0]));
  const distance = Math.max(...corners.map((c) => norm(sub(c, position))));
  const focal35mm = (focalPx / diagonal) * Math.hypot(36, 24);
  const warnings = [];
  if (focal35mm < FOCAL_35MM[0] || focal35mm > FOCAL_35MM[1]) {
    warnings.push(`算出的等效焦距 ${focal35mm.toFixed(0)} mm 不像手机原图。照片如果裁剪过，主点不在中心，车的高度会不准。`);
  }

  return {
    ok,
    error,
    maxError,
    message: ok
      ? `标定误差 ${(error * 100).toFixed(1)}%，可以出图。`
      : `标定误差 ${(error * 100).toFixed(1)}%，超过 ${(maxError * 100).toFixed(0)}%，不能出图。请放大照片重新点 4 个角，或核对两条边长。`,
    checks,
    warnings,
    reprojectionPx,
    focalPx,
    focal35mm,
    cameraHeight: position[1],
    pitchDeg: pitch,
    imageSize: { width, height },
    corners,
    camera: {
      position,
      quaternion: quaternionFromBasis(camX, camY, camZ),
      up: camY,
      fov,
      aspect: width / height,
      near: Math.max(0.01, position[1] / 20),
      far: Math.max(200, distance * 20),
    },
    // Kept for imageToGround / groundToImage.
    model: { f: camera.f, R: camera.R, t: camera.t, side, unit, cx, cy },
  };
}

/** Image pixel -> floor point [x, 0, z] in three.js world, or null when the pixel is above the horizon. */
export function imageToGround(calibration, [u, v]) {
  const { model } = calibration;
  const p = toPlane(model, [(u - model.cx) / model.unit, (v - model.cy) / model.unit]);
  return p ? toWorld(model.side, [p[0], p[1], 0]) : null;
}

/** three.js world point -> image pixel, or null when it is behind the camera. */
export function worldToImage(calibration, point) {
  const { model } = calibration;
  const [X, Y, Z] = fromWorld(model.side, point);
  const c = matVec(model.R, [X, Y, Z]).map((v, i) => v + model.t[i]);
  if (c[2] <= 1e-9) return null;
  return [model.cx + (model.unit * model.f * c[0]) / c[2], model.cy + (model.unit * model.f * c[1]) / c[2]];
}
