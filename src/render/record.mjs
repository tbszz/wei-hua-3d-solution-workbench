#!/usr/bin/env node
// 按镜头脚本逐帧录制现场页：seek → 渲染 → 截图 → ffmpeg 合成 MP4。
// 现场时间轴是闭式的，帧只由「第几帧」决定，跟机器快慢无关，所以同一脚本录两次逐帧一致。
//
//   node src/render/record.mjs src/render/shots/sample.json
//   node src/render/record.mjs <脚本> --out out/a.mp4 --seconds 2 --frames-dir out/frames
//
// 用法、耗时和限制见同目录 README.md。
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWorld } from './plant.mjs';
import { frameAt, loadShots } from './shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_DIR = path.resolve(HERE, '../../demo');
export const OUT_DIR = path.join(HERE, 'out');

// 卫华红、深墨、白。字幕和片头都叠在页面 DOM 上，用系统中文字体，截图时一起进画面。
const OVERLAY_CSS = `
#rec-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Source Han Sans SC", sans-serif;
  color: #fff; -webkit-font-smoothing: antialiased; }
#rec-badge { position: absolute; top: 40px; right: 48px; padding: 6px 18px; background: #D7000F;
  font-size: 28px; font-weight: 700; letter-spacing: 4px; border-radius: 4px; }
#rec-hud { position: absolute; top: 40px; left: 48px; padding: 8px 16px; background: rgba(31, 35, 41, .82);
  font-size: 24px; border-left: 6px solid #D7000F; font-variant-numeric: tabular-nums; }
#rec-hud:empty { display: none; }
#rec-title { position: absolute; left: 96px; bottom: 150px; padding: 28px 40px 30px; background: rgba(31, 35, 41, .92);
  border-left: 12px solid #D7000F; }
#rec-title h1 { margin: 0; font-size: 68px; font-weight: 700; line-height: 1.2; }
#rec-title p { margin: 12px 0 0; font-size: 30px; color: rgba(255, 255, 255, .82); }
#rec-caption { position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); max-width: 1600px;
  padding: 16px 36px; background: rgba(31, 35, 41, .88); border-left: 8px solid #D7000F;
  font-size: 40px; line-height: 1.4; white-space: nowrap; }
#rec-caption:empty { display: none; }
#rec-labels { position: absolute; inset: 0; }
.rec-label { position: absolute; width: 0; height: 0; }
.rec-label i { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%;
  background: #D7000F; box-shadow: 0 0 0 4px rgba(255, 255, 255, .9); }
.rec-label b { position: absolute; left: -1.5px; bottom: 9px; width: 3px; height: 54px; background: #fff; }
.rec-label span { position: absolute; left: -6px; bottom: 63px; padding: 8px 18px; white-space: nowrap;
  background: rgba(31, 35, 41, .92); border-left: 6px solid #D7000F; font-size: 28px; font-weight: 600; }
#rec-end { position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
  background: rgba(31, 35, 41, .86); }
#rec-end h1 { margin: 0; font-size: 76px; font-weight: 700; }
#rec-end h1::after { content: ""; display: block; width: 120px; height: 8px; margin: 28px auto 0; background: #D7000F; }
#rec-end p { margin: 28px 0 0; font-size: 32px; color: rgba(255, 255, 255, .82); }
#rec-fade { position: absolute; inset: 0; background: #1F2329; }
`;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // 本机的 playwright 装在全局，ESM 不会去全局目录找，这里手动找一次。
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright');
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`demo 服务退出了（退出码 ${child.exitCode}）`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 还没起来。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`demo 服务 ${timeoutMs / 1000} 秒内没有起来：${url}`);
}

// 起 demo 的 Vite 开发服务（随机空闲端口，不占 5180）。返回 { url, close }。
export async function startDemoServer() {
  const vite = path.join(DEMO_DIR, 'node_modules/vite/bin/vite.js');
  if (!existsSync(vite)) throw new Error('demo 还没装依赖：先在 demo/ 里跑 npm install');
  const port = await freePort();
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: DEMO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const url = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(url, child);
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${log}`);
  }
  return {
    url,
    close: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    }),
  };
}

function startEncoder(file, shots) {
  mkdirSync(path.dirname(file), { recursive: true });
  const args = [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(shots.fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(shots.fps), '-movflags', '+faststart', file,
  ];
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`起不来 ffmpeg（要在 PATH 上）：${error.message}`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失败（退出码 ${code}）：${errors}`))));
  });
  return {
    write: (buffer) => new Promise((resolve) => {
      if (child.stdin.write(buffer)) resolve();
      else child.stdin.once('drain', resolve);
    }),
    finish: () => {
      child.stdin.end();
      return done;
    },
    // 出错时别让 ffmpeg 一直等输入。
    abort: () => {
      done.catch(() => {});
      child.kill();
    },
  };
}

// 在页面里摆好第 N 帧：镜头、现场时间、字幕、标注、片头片尾、压黑。整段在一次 evaluate 里做完，少来回。
function applyFrame({ pose, sceneTime, caption, captionOpacity, titleOpacity, endOpacity, fade, labels }) {
  const recorder = window.__recorder;
  recorder.setCameraPose(pose);
  recorder.seek(sceneTime);
  recorder.renderFrame();
  const state = recorder.state();
  const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  document.getElementById('rec-hud').textContent = `现场 ${clock(state.time)}　${state.status}`;
  document.getElementById('rec-title').style.opacity = String(titleOpacity);
  document.getElementById('rec-end').style.opacity = String(endOpacity);
  document.getElementById('rec-fade').style.opacity = String(fade);
  const captionEl = document.getElementById('rec-caption');
  captionEl.textContent = caption;
  captionEl.style.opacity = String(captionOpacity);
  const layer = document.getElementById('rec-labels');
  while (layer.children.length < labels.length) {
    const el = document.createElement('div');
    el.className = 'rec-label';
    el.innerHTML = '<b></b><i></i><span></span>';
    layer.append(el);
  }
  const screen = recorder.project(labels.map((label) => label.point));
  [...layer.children].forEach((el, i) => {
    const label = labels[i];
    const at = screen[i];
    el.hidden = !label || !at.visible || label.opacity <= 0;
    if (el.hidden) return;
    el.style.left = `${at.x.toFixed(1)}px`;
    el.style.top = `${at.y.toFixed(1)}px`;
    el.style.opacity = String(label.opacity * captionOpacity);
    el.lastElementChild.textContent = label.text;
    // 标签或圆点有一部分出了画面就整个不显示，免得只剩半截。
    const tag = el.lastElementChild.getBoundingClientRect();
    const inside = tag.top >= 0 && tag.left >= 0 && tag.right <= innerWidth && at.y + 9 <= innerHeight;
    if (!inside) el.hidden = true;
  });
}

function installOverlay({ title, subtitle, badge, ending }) {
  const root = document.createElement('div');
  root.id = 'rec-overlay';
  root.innerHTML = '<div id="rec-labels"></div><div id="rec-hud"></div><div id="rec-badge"></div><div id="rec-title"><h1></h1><p></p></div>'
    + '<div id="rec-caption"></div><div id="rec-end"><h1></h1><p></p></div><div id="rec-fade"></div>';
  root.querySelector('#rec-end h1').textContent = ending?.title ?? '';
  root.querySelector('#rec-end p').textContent = ending?.subtitle ?? '';
  root.querySelector('#rec-badge').textContent = badge;
  root.querySelector('#rec-badge').hidden = !badge;
  root.querySelector('#rec-title h1').textContent = title;
  root.querySelector('#rec-title p').textContent = subtitle;
  root.querySelector('#rec-title').hidden = !title;
  document.body.append(root);
  return document.fonts.ready.then(() => true);
}

/**
 * 录一份镜头脚本。
 * @param {object} options
 * @param {string} options.shotsFile 镜头脚本 JSON
 * @param {string} [options.out] MP4 路径；不给就不编码，只算帧哈希
 * @param {number} [options.seconds] 只录前几秒
 * @param {string} [options.framesDir] 同时把每帧 PNG 存到这个目录
 * @param {string} [options.url] 已经在跑的 demo 地址；不给就自己起一个
 * @param {boolean} [options.reverse] 倒序录（只算哈希时用，验证每帧不依赖前一帧）
 * @param {(info: object) => void} [options.onProgress]
 * @returns {Promise<{ hashes: string[], frames: number, seconds: number, renderer: string }>}
 */
export async function recordShots(options) {
  const started = Date.now();
  const raw = JSON.parse(readFileSync(options.shotsFile, 'utf8'));
  const world = loadWorld({ product: raw.product, size: raw.size });
  const shots = loadShots(options.shotsFile, world);
  const frameCount = options.seconds ? Math.min(shots.frameCount, Math.round(options.seconds * shots.fps)) : shots.frameCount;
  const server = options.url ? null : await startDemoServer();
  const base = options.url ?? server.url;
  const { chromium } = await loadPlaywright();
  // 用 GPU（ANGLE/D3D11）渲染；没有 GPU 的机器会退到 SwiftShader，慢但结果同样确定。
  const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  if (options.reverse && (options.out || options.framesDir)) throw new Error('倒序录制只用来算哈希，不能同时出视频');
  if ((options.every ?? 1) > 1 && options.out) throw new Error('隔帧预览不出视频，请加 --no-video');
  const encoder = options.out ? startEncoder(options.out, shots) : null;
  if (options.framesDir) mkdirSync(options.framesDir, { recursive: true });
  const result = { hashes: [], frames: frameCount, seconds: 0, renderer: '' };
  let encoded = false;
  try {
    const page = await browser.newPage({ viewport: { width: shots.width, height: shots.height }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const url = new URL(base);
    url.searchParams.set('record', '1');
    url.searchParams.set('product', shots.product);
    for (const [key, value] of Object.entries(world.product.size)) url.searchParams.set(key, String(value));
    await page.goto(url.href);
    await page.waitForFunction(() => window.__recorder || window.__recorderError, null, { timeout: 120000 });
    const failure = await page.evaluate(() => window.__recorderError);
    if (failure) throw new Error(`现场页没有进入录制模式：${failure}`);
    result.renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    await page.addStyleTag({ content: OVERLAY_CSS });
    await page.evaluate(installOverlay, { title: shots.title, subtitle: shots.subtitle, badge: shots.badge, ending: shots.ending });
    // 总览、俯视的位姿由网页按厂房大小算，取一次；之后每帧的镜头都在 Node 里算好再发过去。
    const presets = await page.evaluate(() => ({
      overview: window.__recorder.presetPose('overview'),
      top: window.__recorder.presetPose('top'),
    }));
    const pageDuration = await page.evaluate(() => window.__recorder.duration);
    if (Math.abs(pageDuration - world.duration) > 1e-6) throw new Error(`网页和录制脚本算出的流程时长不一样（${pageDuration} / ${world.duration}）`);

    // 直接用 CDP 截图：optimizeForSpeed 换更快的 PNG 压缩，像素不变，比 page.screenshot 快约 3 倍。
    const cdp = await page.context().newCDPSession(page);
    // every > 1 时隔帧抽样（预览用，不出视频）。
    const every = options.every ?? 1;
    const order = [...Array(frameCount).keys()].filter((index) => index % every === 0);
    if (options.reverse) order.reverse();
    const hashes = new Array(frameCount);
    for (const [done, index] of order.entries()) {
      const frame = frameAt(shots, index, world, presets);
      await page.evaluate(applyFrame, {
        pose: frame.pose,
        sceneTime: frame.sceneTime,
        caption: frame.caption,
        captionOpacity: frame.captionOpacity,
        titleOpacity: frame.titleOpacity,
        endOpacity: frame.endOpacity,
        fade: frame.fade,
        labels: frame.labels,
      });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      const png = Buffer.from(data, 'base64');
      hashes[index] = createHash('sha256').update(png).digest('hex');
      if (options.framesDir) writeFileSync(path.join(options.framesDir, `frame-${String(index).padStart(5, '0')}.png`), png);
      if (encoder) await encoder.write(png);
      options.onProgress?.({ index: done, frameCount: order.length, elapsed: (Date.now() - started) / 1000 });
    }
    result.hashes = hashes.filter((hash) => hash !== undefined);
    result.frames = order.length;
    if (pageErrors.length) throw new Error(`现场页报错：${pageErrors.join('; ')}`);
    if (encoder) await encoder.finish();
    encoded = true;
  } finally {
    if (encoder && !encoded) encoder.abort();
    await browser.close();
    await server?.close();
  }
  result.seconds = (Date.now() - started) / 1000;
  return result;
}

function parseArgs(argv) {
  const options = { shotsFile: null };
  const names = { '--out': 'out', '--seconds': 'seconds', '--frames-dir': 'framesDir', '--url': 'url', '--every': 'every' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-video') options.noVideo = true;
    else if (names[arg]) options[names[arg]] = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`不认识的参数：${arg}`);
    else options.shotsFile = arg;
  }
  if (!options.shotsFile) throw new Error('用法：node src/render/record.mjs <镜头脚本.json> [--out x.mp4] [--seconds N] [--frames-dir 目录] [--url http://…] [--no-video] [--every N]');
  if (options.seconds !== undefined) options.seconds = Number(options.seconds);
  if (options.every !== undefined) {
    options.every = Number(options.every);
    options.noVideo = true;
  }
  const name = path.basename(options.shotsFile, '.json');
  if (options.noVideo) delete options.out;
  else options.out = path.resolve(options.out ?? path.join(OUT_DIR, `${name}.mp4`));
  options.shotsFile = path.resolve(options.shotsFile);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let lastReport = 0;
  const result = await recordShots({
    ...options,
    onProgress: ({ index, frameCount, elapsed }) => {
      if (index + 1 === frameCount || Date.now() - lastReport > 2000) {
        lastReport = Date.now();
        process.stdout.write(`\r已录 ${index + 1}/${frameCount} 帧，${elapsed.toFixed(1)} 秒`);
      }
    },
  });
  process.stdout.write('\n');
  const hashFile = options.out ? options.out.replace(/\.mp4$/i, '') + '.frames.sha256' : null;
  if (hashFile) writeFileSync(hashFile, result.hashes.map((hash, index) => `${hash}  frame-${String(index).padStart(5, '0')}.png`).join('\n') + '\n');
  console.log(`渲染器：${result.renderer}`);
  console.log(`共 ${result.frames} 帧，用时 ${result.seconds.toFixed(1)} 秒`);
  if (options.out) console.log(`视频：${options.out}\n帧哈希：${hashFile}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
