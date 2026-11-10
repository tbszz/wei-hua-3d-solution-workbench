// 录制底座的测试：现场目录、镜头脚本换算、镜头运动（快），以及录制一致性（PRD 第 10 节：两次录制逐帧一致，帧哈希比对）。
// 跑法（在 3D-工业方案演示/ 下）：node --test src/render/*.test.mjs
// 录制测试要 demo/ 装好依赖、git lfs 模型已检出、本机有 Playwright Chromium，约 1 分钟。
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadWorld } from './plant.mjs';
import { recordShots, startDemoServer } from './record.mjs';
import { cameraPose, frameAt, loadShots, parseShots } from './shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'shots/sample.json');
const SMOKE = path.join(HERE, 'shots/smoke.json');
const SHOWCASE = path.join(HERE, 'shots/showcase.json');
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const near3 = (a, b, eps = 1e-6) => a.every((v, i) => near(v, b[i], eps));
// 网页给的预设位姿（录制时从页面取）；单元测试里用固定值代替。
const PRESETS = {
  overview: { position: [40, 60, 30], target: [40, 0, -15], fov: 45 },
  top: { position: [40, 90, -15], target: [40, 0, -15.01], fov: 45 },
};

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
    assert.throws(() => parseShots({ segments: [{ start: 0, end: 2, camera: 'top', scene: ['load:RM-01', 9] }] }), /要带现场目录/);
  });

  test('示例脚本约 20 秒，字幕都标了演示', () => {
    const sample = loadShots(SAMPLE);
    assert.ok(sample.duration >= 18 && sample.duration <= 22, `时长 ${sample.duration}`);
    assert.deepEqual([...new Set(sample.segments.map((s) => s.camera))], ['overview', 'follow', 'top']);
    for (const segment of sample.segments) for (const { text } of segment.captions) assert.match(text, /演示/);
  });
});

describe('现场目录', () => {
  const world = loadWorld({});

  test('物件：厂房、车、货物、工位、设备、货架都在，别名能用', () => {
    const names = world.objects.map((item) => item.name);
    for (const name of ['厂房', 'AGV', 'RM-01', 'CELL-01', 'CELL-02', 'FG-01', '南侧货架', '北侧货架']) assert.ok(names.includes(name), name);
    assert.ok(world.objects.some((item) => item.kind === '货物 钢卷'));
    assert.ok(world.objects.some((item) => item.kind === '设备'));
    assert.deepEqual(world.locate('车', 160), world.locate('AGV', 160));
    assert.deepEqual(world.locate('agv1', 160), world.locate('AGV', 160));
  });

  test('坐标：平面图毫米 → 场景米，z 取南北反向', () => {
    const station = world.objects.find((item) => item.name === 'RM-01');
    assert.deepEqual(world.locate('RM-01'), [station.x / 1000, 1, -station.y / 1000]);
    assert.deepEqual(world.locate({ x: 1000, y: 2000, z: 500 }), [1, 0.5, -2]);
  });

  test('钢卷：取货前在 RM-01，车上随车走，卸货后在 CELL-01', () => {
    const load = world.events.find((event) => event.id === 'load:RM-01');
    const unload = world.events.find((event) => event.id === 'unload:CELL-01');
    const [rx, , rz] = world.locate('RM-01');
    const [cx, , cz] = world.locate('CELL-01');
    const waiting = world.locate('钢卷', 10);
    assert.ok(near(waiting[0], rx) && near(waiting[2], rz));
    const t = (load.t1 + unload.t0) / 2;
    const riding = world.locate('钢卷', t);
    const agv = world.locate('AGV', t);
    assert.ok(near(riding[0], agv[0]) && near(riding[2], agv[2]));
    const delivered = world.locate('钢卷', unload.t1 + 5);
    assert.ok(near(delivered[0], cx) && near(delivered[2], cz));
  });

  test('流程事件表达式：起点、.end、.mid、±秒（工位名里有减号也不混）', () => {
    const load = world.events.find((event) => event.id === 'load:RM-01');
    const arrive = world.events.find((event) => event.id === 'arrive:CELL-01');
    assert.ok(load.t1 - load.t0 > 1);
    assert.equal(world.resolveTime('load:RM-01'), load.t0);
    assert.equal(world.resolveTime('load:RM-01.end'), load.t1);
    assert.equal(world.resolveTime('load:RM-01.mid'), (load.t0 + load.t1) / 2);
    assert.ok(near(world.resolveTime('load:RM-01+2s'), load.t0 + 2));
    assert.ok(near(world.resolveTime('arrive:CELL-01-2s'), arrive.t0 - 2));
    assert.ok(near(world.resolveTime('load:RM-01.end+1.5s'), load.t1 + 1.5));
    assert.equal(world.resolveTime('end'), world.duration);
    assert.equal(world.resolveTime('start-5s'), 0);
  });

  test('写错名字给出中文错误，并列出能用的', () => {
    assert.throws(() => world.locate('天车 9'), /现场里没有「天车 9」.*RM-01/);
    assert.throws(() => world.resolveTime('load:XX-01'), /没有这个流程事件.*load:RM-01/);
    assert.throws(() => world.resolveTime('load:RM-01+2'), /没有这个流程事件/);
    assert.throws(() => loadWorld({ product: 'nope' }), /产品库里没有 nope/);
    assert.throws(() => loadWorld({ size: { span: 1 } }), /没有尺寸参数 span/);
  });

  test('尺寸超范围夹到产品范围内，和网页滑块一致', () => {
    const big = loadWorld({ size: { length: 1e9 } });
    assert.equal(big.product.size.length, big.product.params.length.max);
  });
});

describe('镜头运动', () => {
  const world = loadWorld({});
  const orbit = (fields) => parseShots({ segments: [{ start: 0, end: 1, scene: [0, 0], camera: fields }] }, world).segments[0].camera;

  test('环绕：0° 在目标南面，90° 在东面，高度和 lookHeight 照写', () => {
    const [x, , z] = world.locate('RM-01');
    const south = cameraPose(orbit({ target: 'RM-01', angle: 0, distance: 10, height: 5 }), 0, 0, world, PRESETS);
    assert.ok(near3(south.position, [x, 5, z + 10]));
    assert.ok(near3(south.target, [x, 1, z]));
    assert.equal(south.fov, PRESETS.overview.fov);
    const east = cameraPose(orbit({ target: 'RM-01', angle: 90, distance: 10, height: 5, lookHeight: 0, fov: 30 }), 0, 0, world, PRESETS);
    assert.ok(near3(east.position, [x + 10, 5, z]));
    assert.ok(near3(east.target, [x, 0, z]));
    assert.equal(east.fov, 30);
  });

  test('[起, 止] 按缓动插值：两端精确，inOut 中点正好一半、起步慢', () => {
    const camera = orbit({ target: 'RM-01', angle: 0, distance: [20, 10], height: [8, 4], fov: [50, 30] });
    const [, , z] = world.locate('RM-01');
    assert.ok(near(cameraPose(camera, 0, 0, world, PRESETS).position[2], z + 20));
    assert.ok(near(cameraPose(camera, 1, 0, world, PRESETS).position[2], z + 10));
    const mid = cameraPose(camera, 0.5, 0, world, PRESETS);
    assert.ok(near(mid.position[1], 6) && near(mid.fov, 40));
    assert.ok(cameraPose(camera, 0.1, 0, world, PRESETS).position[1] > 8 - 0.4);
  });

  test('target 写 [A, B] 是平移，从 A 移到 B', () => {
    const camera = orbit({ target: ['RM-01', 'CELL-01'], angle: 0, distance: 5, height: 20, ease: 'linear' });
    assert.ok(near3(cameraPose(camera, 0, 0, world, PRESETS).target, world.locate('RM-01')));
    assert.ok(near3(cameraPose(camera, 1, 0, world, PRESETS).target, world.locate('CELL-01')));
  });

  test('relative：0° 在车头前方，180° 在车后（车正向行驶时）', () => {
    for (const t of [160, 250]) {
      const a = world.locate('AGV', t);
      const b = world.locate('AGV', t + 0.3);
      const velocity = [b[0] - a[0], b[2] - a[2]];
      for (const [angle, sign] of [[0, 1], [180, -1]]) {
        const pose = cameraPose(orbit({ target: 'AGV', angle, distance: 10, height: 4, relative: true }), 0, t, world, PRESETS);
        const offset = [pose.position[0] - a[0], pose.position[2] - a[2]];
        assert.ok((velocity[0] * offset[0] + velocity[1] * offset[1]) * sign > 0, `t=${t} angle=${angle}`);
      }
    }
  });

  test('blend：下一段第一帧和上一段结束位姿重合，blend 结束后回到本段位姿', () => {
    const shots = parseShots({
      segments: [
        { start: 0, end: 1, scene: [0, 0], camera: { target: 'RM-01', angle: 0, distance: 10, height: 5 } },
        { start: 1, end: 3, scene: [0, 0], blend: 1, camera: { target: 'CELL-01', angle: 90, distance: 6, height: 3, fov: 30 } },
      ],
    }, world);
    const end = cameraPose(shots.segments[0].camera, 1, 0, world, PRESETS);
    const first = frameAt(shots, 30, world, PRESETS).pose;
    assert.ok(near3(first.position, end.position) && near3(first.target, end.target) && near(first.fov, end.fov));
    const settled = frameAt(shots, 60, world, PRESETS).pose;
    assert.ok(near3(settled.position, cameraPose(shots.segments[1].camera, 0.5, 0, world, PRESETS).position));
    const halfway = frameAt(shots, 45, world, PRESETS).pose;
    assert.ok(halfway.fov < end.fov && halfway.fov > 30);
  });

  test('标注、分时字幕、压黑、片尾卡', () => {
    const shots = parseShots({
      ending: { title: '完', seconds: 1 },
      segments: [{
        start: 0, end: 2, scene: ['load:RM-01', 'load:RM-01.end'], fadeIn: 0.5, fadeOut: 0.5,
        camera: { target: '钢卷', angle: 0, distance: 6, height: 3 },
        caption: [{ at: 1, text: '二' }, { at: 0, text: '一' }],
        labels: [{ at: '钢卷', text: '钢卷', lift: 0.5 }],
      }],
    }, world);
    const start = frameAt(shots, 0, world, PRESETS);
    assert.equal(start.caption, '一');
    assert.equal(start.fade, 1);
    assert.equal(start.labels[0].opacity, 0);
    const middle = frameAt(shots, 30, world, PRESETS);
    assert.equal(middle.caption, '二');
    assert.equal(middle.fade, 0);
    assert.equal(middle.labels[0].opacity, 1);
    assert.ok(near(middle.labels[0].point[1], world.locate('钢卷', middle.sceneTime)[1] + 0.5));
    assert.equal(frameAt(shots, 29, world, PRESETS).endOpacity, 0);
    assert.ok(frameAt(shots, 59, world, PRESETS).endOpacity > 0.9);
  });

  test('镜头对象写错给出中文错误', () => {
    assert.throws(() => orbit({ angle: 0 }), /要有 target/);
    assert.throws(() => orbit({ target: '不存在' }), /现场里没有「不存在」/);
    assert.throws(() => orbit({ target: ['RM-01'] }), /\[起点, 终点\]/);
    assert.throws(() => orbit({ target: 'RM-01', ease: 'bounce' }), /ease 只能是/);
    assert.throws(() => orbit({ target: { x: 1 } }), /毫米/);
  });

  test('展示脚本能解析：scene 在流程范围内、字幕都标了演示', () => {
    const showcase = loadShots(SHOWCASE, world);
    assert.ok(showcase.duration >= 25 && showcase.duration <= 45, `时长 ${showcase.duration}`);
    for (const segment of showcase.segments) {
      for (const t of segment.scene) assert.ok(t >= 0 && t <= world.duration);
      for (const { text } of segment.captions) assert.match(text, /演示/);
    }
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

  test('倒序录也一样（含环绕、跟车、平移、标注、blend、压黑）：每帧只由帧号决定，不依赖前一帧', async () => {
    const forward = await recordShots({ shotsFile: SMOKE, url: server.url });
    const backward = await recordShots({ shotsFile: SMOKE, url: server.url, reverse: true });
    assert.equal(forward.hashes.length, 30);
    const diff = forward.hashes.map((hash, i) => (hash === backward.hashes[i] ? null : i)).filter((i) => i !== null);
    assert.deepEqual(diff, [], `不一致的帧：${diff.join(', ')}`);
    assert.ok(new Set(forward.hashes).size > 25);
  });
});
