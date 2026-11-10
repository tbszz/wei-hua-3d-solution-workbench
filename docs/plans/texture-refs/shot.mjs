// usage: node shot.mjs <url> <outPrefix> [views...]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const root = require('child_process').execSync('npm root -g').toString().trim();
const { chromium } = require(root + '/playwright');
const [url, out, ...views] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] , headless: true});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
await page.goto(url);
await page.waitForFunction(() => window.__app?.site?.process && document.getElementById('loading')?.hidden, null, { timeout: 120000 });
await page.evaluate(() => { document.body.classList.add('clean'); dispatchEvent(new Event('resize')); });
const gl = await page.evaluate(() => { const g = document.querySelector('canvas').getContext('webgl2'); const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; });
console.log('GPU', gl);
for (const v of (views.length ? views : ['overview'])) {
  const [mode, extra] = v.split(':');
  await page.evaluate(([m, e]) => {
    __app.autoRotate = false;
    if (m === 'cam') { const [px,py,pz,tx,ty,tz] = e.split(',').map(Number); __app.setView('overview'); __camera.position.set(px,py,pz); __controls.target.set(tx,ty,tz); window.__fixCam=[px,py,pz,tx,ty,tz]; }
    else __app.setView(m);
  }, [mode, extra]);
  await page.waitForTimeout(1500);
  if (mode === 'cam') await page.evaluate(() => { const [px,py,pz,tx,ty,tz]=window.__fixCam; __camera.position.set(px,py,pz); __controls.target.set(tx,ty,tz); __controls.update(); });
  await page.waitForTimeout(300);
  // measure fps over 3s
  const stats = await page.evaluate(() => new Promise((res) => { const d = []; const t0 = performance.now(); let last = t0; const f = () => { const now = performance.now(); d.push(now - last); last = now; if (now - t0 < 4000) requestAnimationFrame(f); else { d.sort((a, b) => a - b); res({ fps: d.length / ((now - t0) / 1000), med: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1], pr: __app.site.renderer.getPixelRatio() }); } }; requestAnimationFrame(f); }));
  const fps = stats.fps; console.log('   frame ms median', stats.med.toFixed(1), 'p95', stats.p95.toFixed(1), 'max', stats.max.toFixed(0), 'pixelRatio', stats.pr);
  const info = await page.evaluate(() => { const r = __app.site.renderer.info; return { calls: r.render.calls, tris: r.render.triangles, tex: r.memory.textures, progs: r.programs.length }; });
  console.log(v, 'fps', fps.toFixed(1), JSON.stringify(info));
  await page.screenshot({ path: `${out}-${v.replace(/[:,.]/g, '_')}.png` });
}
await browser.close();
