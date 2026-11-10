// Text a drafter exploded into curves: each character is a handful of SPLINE outlines plus the
// straight LINE strokes between them, so a layout drawing can name its zones (原材料存储区,
// 1#气垫炉上线点 …) without a single TEXT entity. We pick those strokes out of the DXF and let a
// local OCR (RapidOCR via read_drawn_text.py) read them back into positioned labels.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import DxfParser from 'dxf-parser';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'read_drawn_text.py');
const DXF_UNITS = { 0: null, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 14: 100 };
const MIN_SPLINES = 8;

function sizeOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

// splines: [[{x,y}…]], segments: [[{x,y},{x,y}]] (mm). Keeps every spline and the short straight
// segments that sit among them (the glyphs' straight strokes), drops walls and grid lines.
export function glyphStrokes(splines, segments) {
  const curves = splines.filter((s) => s.length >= 2);
  if (curves.length < MIN_SPLINES) return null;
  const sizes = curves.map(sizeOf).sort((a, b) => a - b);
  const unit = sizes[Math.floor(sizes.length / 2)];
  if (!(unit > 0)) return null;
  const cell = unit * 2;
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const occupied = new Set();
  for (const s of curves) for (const p of s) occupied.add(key(p.x, p.y));
  const near = (p) => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (occupied.has(`${cx + i},${cy + j}`)) return true;
    return false;
  };
  const straight = segments.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) < unit * 12 && near(a) && near(b));
  return { unit, strokes: [...curves, ...straight] };
}

// Strokes of a DXF (text content), in mm.
export function strokesFromDxf(source) {
  const dxf = new DxfParser().parseSync(source);
  const k = DXF_UNITS[dxf.header?.$INSUNITS] ?? 1;
  const p = (v) => ({ x: v.x * k, y: v.y * k });
  const splines = [];
  const segments = [];
  for (const e of dxf.entities ?? []) {
    if (e.type === 'SPLINE') {
      const pts = e.controlPoints?.length ? e.controlPoints : e.fitPoints;
      if (pts?.length >= 2) splines.push(pts.map(p));
    } else if (e.type === 'LINE' && e.vertices?.length >= 2) segments.push([p(e.vertices[0]), p(e.vertices[1])]);
    else if ((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && e.vertices?.length >= 2) {
      const v = e.vertices.map(p);
      for (let i = 0; i < v.length - 1; i++) segments.push([v[i], v[i + 1]]);
      if (e.shape) segments.push([v[v.length - 1], v[0]]);
    }
  }
  return glyphStrokes(splines, segments);
}

const NAME_END = /[区点位]/;

// OCR reads two labels set close on one line as one run ("原材料检验区高温冷却暂存点"). Split after
// 区/点/位 when another name follows, and place each part along the run by its share of characters.
export function splitRun(label) {
  const text = String(label.text ?? '').replace(/^[^\p{L}\p{N}#]+/u, '').replace(/[^\p{L}\p{N}#)）]+$/u, '').trim();
  if (!text) return [];
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (NAME_END.test(text[i]) && i + 1 - start >= 2 && text.length - (i + 1) >= 2) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  if (parts.length === 1) return [{ ...label, text }];
  const left = label.x - (label.width ?? 0) / 2;
  let used = 0;
  return parts.map((part) => {
    const share = part.length / text.length;
    const x = left + (used + share / 2) * (label.width ?? 0);
    used += share;
    return { ...label, text: part, x: Math.round(x * 10) / 10, width: Math.round((label.width ?? 0) * share * 10) / 10 };
  });
}

// Resolves to { labels: [...] } or { labels: [], error }; never rejects.
export function readDrawnText(found, { python = process.env.WORKBENCH_PYTHON || 'python', timeoutMs = 120_000 } = {}) {
  if (!found?.strokes?.length) return Promise.resolve({ labels: [] });
  const payload = JSON.stringify({ unit: found.unit, strokes: found.strokes.map((s) => s.map((q) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10])) });
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(python, ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (error) {
      finish({ labels: [], error: `无法启动 Python：${error.message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ labels: [], error: `识别超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    child.on('error', (error) => finish({ labels: [], error: `无法启动 Python（${python}）：${error.message}` }));
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try {
        const data = JSON.parse(line);
        if (data.error) return finish({ labels: [], error: data.error });
        return finish({ labels: (data.labels ?? []).flatMap(splitRun) });
      } catch {
        return finish({ labels: [], error: `识别失败：${(err.trim().split('\n').pop() || '无输出').slice(0, 200)}` });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
