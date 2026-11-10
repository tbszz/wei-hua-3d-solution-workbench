// 镜头脚本：读入、校验，并把视频第 N 帧换算成现场时间、镜头预设和字幕。
// 纯函数，不碰浏览器，方便单测。
import { readFileSync } from 'node:fs';

export const CAMERA_PRESETS = ['overview', 'follow', 'top'];
const EPSILON = 1e-9;

export function loadShots(file) {
  return parseShots(JSON.parse(readFileSync(file, 'utf8')));
}

export function parseShots(raw) {
  const shots = {
    title: raw.title ?? '',
    subtitle: raw.subtitle ?? '',
    titleSeconds: raw.titleSeconds ?? 3,
    badge: raw.badge ?? '演示',
    product: raw.product ?? 'agv1',
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
    const { start, end, camera, scene, caption = '' } = segment;
    if (Math.abs(start - cursor) > EPSILON) throw new Error(`${where}应从 ${cursor} 秒开始，脚本写的是 ${start}`);
    if (!(end > start)) throw new Error(`${where}的结束时间要大于开始时间`);
    if (!CAMERA_PRESETS.includes(camera)) throw new Error(`${where}的镜头预设只能是 ${CAMERA_PRESETS.join(' / ')}，脚本写的是 ${camera}`);
    if (!Array.isArray(scene) || scene.length !== 2 || scene.some((t) => !Number.isFinite(t) || t < 0)) {
      throw new Error(`${where}的 scene 要写成 [现场开始秒, 现场结束秒]`);
    }
    cursor = end;
    return { start, end, camera, scene, caption };
  });
  shots.duration = cursor;
  shots.frameCount = Math.round(shots.duration * shots.fps);
  return shots;
}

// 第 index 帧（从 0 起）。现场时间在段内线性插值，段与段之间是硬切。
export function frameAt(shots, index) {
  const t = index / shots.fps;
  const segment = shots.segments.find((item) => t < item.end - EPSILON) ?? shots.segments.at(-1);
  const f = (t - segment.start) / (segment.end - segment.start);
  const sceneTime = segment.scene[0] + (segment.scene[1] - segment.scene[0]) * f;
  // 片头卡：前 titleSeconds 秒显示，最后 0.5 秒淡出。
  const fade = 0.5;
  const titleOpacity = shots.title ? Math.max(0, Math.min(1, (shots.titleSeconds - t) / fade)) : 0;
  return { index, t, segment, sceneTime, camera: segment.camera, caption: segment.caption, titleOpacity };
}
