// 录制底座的测试：镜头脚本换算（快），以及录制一致性（PRD 第 10 节：两次录制逐帧一致，帧哈希比对）。
// 跑法（在 3D-工业方案演示/ 下）：node --test src/render/
// 录制测试要 demo/ 装好依赖、git lfs 模型已检出、本机有 Playwright Chromium，约 1 分钟。
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordShots, startDemoServer } from './record.mjs';
import { frameAt, parseShots } from './shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'shots/sample.json');
const SMOKE = path.join(HERE, 'shots/smoke.json');

describe('镜头脚本', () => {
  const shots = parseShots({
    title: '片头',
    titleSeconds: 1,
    segments: [
      { start: 0, end: 2, camera: 'overview', scene: [10, 20], caption: 'A' },
      { start: 2, end: 3, camera: 'top', scene: [50, 50], caption: 'B' },
    ],
  });

  test('时长和帧数', () => {
    assert.equal(shots.duration, 3);
    assert.equal(shots.frameCount, 90);
  });

  test('段内线性插值，段间硬切', () => {
    assert.equal(frameAt(shots, 0).sceneTime, 10);
    assert.equal(frameAt(shots, 30).sceneTime, 15);
    assert.equal(frameAt(shots, 59).camera, 'overview');
    assert.equal(frameAt(shots, 60).camera, 'top');
    assert.equal(frameAt(shots, 60).sceneTime, 50);
    assert.equal(frameAt(shots, 89).caption, 'B');
  });

  test('片头最后 0.5 秒淡出', () => {
    assert.equal(frameAt(shots, 0).titleOpacity, 1);
    assert.equal(frameAt(shots, 15).titleOpacity, 1);
    assert.ok(Math.abs(frameAt(shots, 24).titleOpacity - 0.4) < 1e-9);
    assert.equal(frameAt(shots, 30).titleOpacity, 0);
  });

  test('坏脚本给出中文错误', () => {
    assert.throws(() => parseShots({ segments: [] }), /没有段落/);
    assert.throws(() => parseShots({ segments: [{ start: 1, end: 2, camera: 'top', scene: [0, 1] }] }), /应从 0 秒开始/);
    assert.throws(() => parseShots({ segments: [{ start: 0, end: 2, camera: 'side', scene: [0, 1] }] }), /镜头预设/);
    assert.throws(() => parseShots({ segments: [{ start: 0, end: 2, camera: 'top', scene: [0] }] }), /scene/);
  });

  test('示例脚本约 20 秒，字幕都标了演示', async () => {
    const { loadShots } = await import('./shots.mjs');
    const sample = loadShots(SAMPLE);
    assert.ok(sample.duration >= 18 && sample.duration <= 22, `时长 ${sample.duration}`);
    assert.deepEqual([...new Set(sample.segments.map((s) => s.camera))], ['overview', 'follow', 'top']);
    for (const segment of sample.segments) assert.match(segment.caption, /演示/);
  });
});

describe('录制一致性', { timeout: 600000 }, () => {
  let server;
  before(async () => { server = await startDemoServer(); });
  after(async () => { await server?.close(); });

  test('同一脚本录两次（示例前 2 秒），逐帧哈希一致', async () => {
    const first = await recordShots({ shotsFile: SAMPLE, seconds: 2, url: server.url });
    const second = await recordShots({ shotsFile: SAMPLE, seconds: 2, url: server.url });
    assert.equal(first.hashes.length, 60);
    const diff = first.hashes.map((hash, i) => (hash === second.hashes[i] ? null : i)).filter((i) => i !== null);
    assert.deepEqual(diff, [], `不一致的帧：${diff.join(', ')}`);
    // 画面确实在动，不是同一张图录了 60 遍。
    assert.ok(new Set(first.hashes).size > 50);
  });

  test('倒序录也一样：每帧只由帧号决定，不依赖前一帧，截图不会拿到上一帧', async () => {
    const forward = await recordShots({ shotsFile: SMOKE, url: server.url });
    const backward = await recordShots({ shotsFile: SMOKE, url: server.url, reverse: true });
    assert.equal(forward.hashes.length, 30);
    const diff = forward.hashes.map((hash, i) => (hash === backward.hashes[i] ? null : i)).filter((i) => i !== null);
    assert.deepEqual(diff, [], `不一致的帧：${diff.join(', ')}`);
  });
});
