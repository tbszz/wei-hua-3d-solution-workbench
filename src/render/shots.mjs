// 镜头脚本：读入、校验，并把视频第 N 帧换算成现场时间、镜头位姿、字幕、标注和淡入淡出。
// 纯函数，不碰浏览器；镜头位置只由帧号决定，所以录几次都一样。格式说明见 README.md。
import { readFileSync } from 'node:fs';

export const CAMERA_PRESETS = ['overview', 'follow', 'top'];
const EASINGS = {
  linear: (u) => u,
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  inOut: (u) => u * u * (3 - 2 * u),
};
const EPSILON = 1e-9;
const DEG = Math.PI / 180;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, f) => a + (b - a) * f;
const lerp3 = (a, b, f) => a.map((v, i) => lerp(v, b[i], f));

export function loadShots(file, world) {
  return parseShots(JSON.parse(readFileSync(file, 'utf8')), world);
}

// [起, 止] 或单个数：随镜头进度插值。
function ranged(value, fallback) {
  const v = value ?? fallback;
  return Array.isArray(v) ? v : [v, v];
}

function checkTarget(target, world, where) {
  if (typeof target === 'object' && target !== null) {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error(`${where}的坐标要写成 { "x": 毫米, "y": 毫米 }`);
    return;
  }
  world?.locate(target, 0);
}

function parseCamera(camera, world, where) {
  if (typeof camera === 'string') {
    if (!CAMERA_PRESETS.includes(camera)) throw new Error(`${where}的镜头预设只能是 ${CAMERA_PRESETS.join(' / ')}，或写成镜头对象，脚本写的是 ${camera}`);
    return camera;
  }
  if (typeof camera !== 'object' || camera === null || camera.target === undefined) throw new Error(`${where}的镜头对象要有 target`);
  const pan = Array.isArray(camera.target);
  const targets = pan ? camera.target : [camera.target];
  if (pan && targets.length !== 2) throw new Error(`${where}的 target 写数组时是 [起点, 终点]`);
  targets.forEach((target) => checkTarget(target, world, where));
  const ease = camera.ease ?? 'inOut';
  if (!EASINGS[ease]) throw new Error(`${where}的 ease 只能是 ${Object.keys(EASINGS).join(' / ')}`);
  return {
    targets,
    angle: ranged(camera.angle, 30),
    distance: ranged(camera.distance, 10),
    height: ranged(camera.height, 4),
    fov: camera.fov === undefined ? null : ranged(camera.fov),
    lookHeight: camera.lookHeight === undefined ? null : ranged(camera.lookHeight),
    relative: Boolean(camera.relative),
    ease,
  };
}

function parseCaptions(caption, where) {
  if (caption === undefined || caption === '') return [];
  if (typeof caption === 'string') return [{ at: 0, text: caption }];
  if (!Array.isArray(caption)) throw new Error(`${where}的 caption 写字符串，或 [{ "at": 段内秒, "text": … }]`);
  return caption.map((item) => ({ at: item.at ?? 0, text: item.text ?? '' })).sort((a, b) => a.at - b.at);
}

export function parseShots(raw, world) {
  const shots = {
    title: raw.title ?? '',
    subtitle: raw.subtitle ?? '',
    titleSeconds: raw.titleSeconds ?? 3,
    badge: raw.badge ?? '演示',
    product: raw.product ?? 'agv1',
    size: raw.size ?? {},
    ending: raw.ending ?? null,
    fps: raw.fps ?? 30,
    width: raw.width ?? 1920,
    height: raw.height ?? 1080,
    segments: raw.segments ?? [],
  };
  if (!Number.isInteger(shots.fps) || shots.fps <= 0) throw new Error(`fps 必须是正整数：${shots.fps}`);
  if (!shots.segments.length) throw new Error('镜头脚本没有段落');
  let cursor = 0;
  shots.segments = shots.segments.map((segment, index) => {
    const where = `第 ${index + 1} 段`;
    const { start, end, scene } = segment;
    if (Math.abs(start - cursor) > EPSILON) throw new Error(`${where}应从 ${cursor} 秒开始，脚本写的是 ${start}`);
    if (!(end > start)) throw new Error(`${where}的结束时间要大于开始时间`);
    if (!Array.isArray(scene) || scene.length !== 2) throw new Error(`${where}的 scene 要写成 [现场开始, 现场结束]，可以是秒数或流程事件`);
    const sceneRange = scene.map((value) => {
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${where}的 scene 秒数不对：${value}`);
        return value;
      }
      if (!world) throw new Error(`${where}的 scene 用了流程事件，要带现场目录解析`);
      return world.resolveTime(value);
    });
    const labels = (segment.labels ?? []).map((label) => {
      if (!label.text || label.at === undefined) throw new Error(`${where}的标注要有 at 和 text`);
      checkTarget(label.at, world, where);
      return { at: label.at, text: label.text, lift: label.lift ?? 1, from: label.from ?? 0.2 };
    });
    cursor = end;
    return {
      start,
      end,
      scene: sceneRange,
      camera: parseCamera(segment.camera, world, where),
      captions: parseCaptions(segment.caption, where),
      labels,
      blend: index === 0 ? 0 : (segment.blend ?? 0),
      fadeIn: segment.fadeIn ?? 0,
      fadeOut: segment.fadeOut ?? 0,
    };
  });
  shots.duration = cursor;
  shots.frameCount = Math.round(shots.duration * shots.fps);
  return shots;
}

function sceneTimeAt(segment, t) {
  const f = (t - segment.start) / (segment.end - segment.start);
  return lerp(segment.scene[0], segment.scene[1], f);
}

// 一段镜头在进度 u（0..1）、现场时间 sceneTime 时的位姿：{ position, target, fov }，场景米。
// presets 是网页给的总览、俯视位姿（固定），跟随按网页的同一套偏移算。
export function cameraPose(camera, u, sceneTime, world, presets) {
  const baseFov = presets.overview.fov;
  if (camera === 'overview' || camera === 'top') return presets[camera];
  if (camera === 'follow') {
    const [x, , z] = world.locate('AGV', sceneTime);
    return { position: [x - 6, 9, z + 7.5], target: [x, 0.5, z], fov: baseFov };
  }
  const e = EASINGS[camera.ease](clamp01(u));
  const ends = camera.targets.map((target) => world.locate(target, sceneTime));
  const focus = ends.length === 2 ? lerp3(ends[0], ends[1], e) : ends[0];
  const lookY = camera.lookHeight ? lerp(...camera.lookHeight, e) : focus[1];
  let angle = lerp(...camera.angle, e) * DEG;
  // 相对车头：0° 在车前，90° 在车的左侧，180° 在车后。
  if (camera.relative) angle += world.headingAt(sceneTime) + Math.PI / 2;
  const distance = lerp(...camera.distance, e);
  return {
    position: [focus[0] + Math.sin(angle) * distance, lerp(...camera.height, e), focus[2] + Math.cos(angle) * distance],
    target: [focus[0], lookY, focus[2]],
    fov: camera.fov ? lerp(...camera.fov, e) : baseFov,
  };
}

function segmentPose(segment, t, world, presets) {
  const u = (t - segment.start) / (segment.end - segment.start);
  return cameraPose(segment.camera, u, sceneTimeAt(segment, t), world, presets);
}

// 第 index 帧（从 0 起）的全部内容。
export function frameAt(shots, index, world, presets) {
  const t = index / shots.fps;
  const position = shots.segments.findIndex((item) => t < item.end - EPSILON);
  const segmentIndex = position === -1 ? shots.segments.length - 1 : position;
  const segment = shots.segments[segmentIndex];
  const sceneTime = sceneTimeAt(segment, t);
  const local = t - segment.start;

  let pose = null;
  if (world && presets) {
    pose = segmentPose(segment, t, world, presets);
    // blend：从上一段结束时的镜头平滑飞过来，不硬切。
    if (segment.blend > 0 && local < segment.blend) {
      const previous = shots.segments[segmentIndex - 1];
      const from = segmentPose(previous, previous.end, world, presets);
      const f = EASINGS.inOut(local / segment.blend);
      pose = { position: lerp3(from.position, pose.position, f), target: lerp3(from.target, pose.target, f), fov: lerp(from.fov, pose.fov, f) };
    }
  }

  // 片头卡：前 titleSeconds 秒显示，最后 0.5 秒淡出；片尾卡：最后 seconds 秒淡入。
  const titleOpacity = shots.title ? clamp01((shots.titleSeconds - t) / 0.5) : 0;
  const endOpacity = shots.ending ? clamp01((t - (shots.duration - (shots.ending.seconds ?? 3))) / 0.6) : 0;
  // 段首段尾的压黑。
  const fadeIn = segment.fadeIn > 0 ? 1 - clamp01(local / segment.fadeIn) : 0;
  const fadeOut = segment.fadeOut > 0 ? 1 - clamp01((segment.end - t) / segment.fadeOut) : 0;
  const caption = segment.captions.filter((item) => item.at <= local + EPSILON).at(-1)?.text ?? '';
  const labels = world
    ? segment.labels.map((label) => {
      const point = world.locate(label.at, sceneTime);
      point[1] += label.lift;
      const opacity = clamp01((local - label.from) / 0.4) * clamp01((segment.end - t) / 0.3);
      return { text: label.text, point, opacity };
    })
    : [];
  return {
    index,
    t,
    segment,
    sceneTime,
    pose,
    camera: segment.camera,
    caption,
    captionOpacity: (1 - titleOpacity) * (1 - endOpacity),
    titleOpacity,
    endOpacity,
    fade: Math.max(fadeIn, fadeOut),
    labels,
  };
}
