// A 2D equipment drawing (crane, trolley, vehicle, coil...) read for what a modeller needs:
// the views on the sheet, every dimension with its value, the parameter / title text and the
// main outlines of each view. Nothing is guessed here; the summary only reports the drawing.
import DxfParser from 'dxf-parser';
import { area, box, collect, UNITS } from './infer-plant.js';

const VIEW_WORDS = /视图|主视|侧视|俯视|左视|右视|仰视|立面|侧面|平面|剖面|断面|[A-Z]\s*-\s*[A-Z]|向\s*[A-Z]|局部|详图|大样/;
const PARAM_WORDS = /跨度|起重量|起升|高度|速度|轨距|轮距|基距|轨道|工作级别|型号|规格|自重|功率|电压|长度|宽度|直径|外径|内径|孔径|卷宽|卷重|吨|[Tt]\b|[Ss]\s*=|[Hh]\s*=|[Ll]\s*=|[Φφ⌀]|%%[cC]/;

const round = (v) => Math.round(v);

// Ramer-Douglas-Peucker on a closed or open point list.
function simplify(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [p, q] = [points[a], points[b]];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    let best = -1;
    let far = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((q.x - p.x) * (p.y - points[i].y) - (p.x - points[i].x) * (q.y - p.y)) / len;
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Merge boxes that touch or sit within `gap` of each other (one view = one connected group).
function groupBoxes(items, gap) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const order = items.map((_, i) => i).sort((a, b) => items[a].b.x0 - items[b].b.x0);
  for (let n = 0; n < order.length; n++) {
    const i = order[n];
    const a = items[i].b;
    for (let m = n + 1; m < order.length; m++) {
      const j = order[m];
      const b = items[j].b;
      if (b.x0 > a.x1 + gap) break;
      if (b.y0 <= a.y1 + gap && b.y1 >= a.y0 - gap) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()];
}

function cleanText(t) {
  return String(t ?? '').replace(/%%[cC]/g, 'Φ').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;|[{}]/g, '').trim();
}

// Dimension value in drawing units: explicit text if it is a number, else the stored measurement,
// else the distance between the definition points.
function dimensionOf(entity, k) {
  const type = (entity.dimensionType ?? 0) & 7;
  const p1 = entity.linearOrAngularPoint1;
  const p2 = entity.linearOrAngularPoint2;
  let measured = Number(entity.actualMeasurement);
  let geometric = null;
  let direction = '倾斜';
  if ((type === 0 || type === 1) && p1 && p2) {
    const a = ((entity.angle ?? 0) * Math.PI) / 180;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    geometric = type === 0 ? Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) : Math.hypot(dx, dy);
    const ang = type === 0 ? a : Math.atan2(dy, dx);
    const c = Math.abs(Math.cos(ang));
    direction = c > 0.98 ? '水平' : c < 0.02 ? '竖直' : '倾斜';
  } else if (type === 3) direction = '直径';
  else if (type === 4) direction = '半径';
  else if (type === 2 || type === 5) direction = '角度';
  if (!Number.isFinite(measured) || measured <= 0) measured = geometric;
  const raw = cleanText(entity.text);
  const shown = raw && raw !== '<>' ? raw.replace('<>', measured ? String(+measured.toFixed(1)) : '') : null;
  const number = Number((shown ?? '').replace(/^[ΦRr]/, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
  const value = direction === '角度' ? measured : Number.isFinite(number) && shown && /^\s*[ΦRr]?\s*\d/.test(shown) ? number : measured * k;
  const at = entity.middleOfText ?? entity.anchorPoint ?? p1;
  return { direction, value, text: shown, geometric: geometric === null ? null : geometric * k, at: at ? { x: at.x * k, y: at.y * k } : null };
}

export function readEquipment(text, sourceName = '') {
  const dxf = new DxfParser().parseSync(text);
  const insunits = dxf.header?.$INSUNITS ?? 4;
  const k = UNITS[insunits] ?? 1;
  const { shapes, labels } = collect(dxf, k);
  if (!shapes.length) throw new Error('图纸里没有可识别的线条');

  // Dimensions, including those inside blocks one level down.
  const dims = [];
  const visitDim = (e) => {
    if (e.type !== 'DIMENSION') return;
    const d = dimensionOf(e, k);
    if (d.at && Number.isFinite(d.value) && d.value > 0) dims.push(d);
  };
  for (const e of dxf.entities ?? []) visitDim(e);
  // MTEXT / TEXT with full length (collect() trims labels to 40 chars).
  const texts = [];
  for (const e of dxf.entities ?? []) {
    if (e.type !== 'TEXT' && e.type !== 'MTEXT') continue;
    const at = e.startPoint ?? e.position;
    const t = cleanText(e.text);
    if (at && t) texts.push({ text: t.slice(0, 120), x: at.x * k, y: at.y * k, height: (e.textHeight ?? e.height ?? 0) * k });
  }
  for (const l of labels) if (!texts.some((t) => Math.abs(t.x - l.x) < 1 && Math.abs(t.y - l.y) < 1)) texts.push({ text: cleanText(l.text), x: l.x, y: l.y, height: l.height });

  // Drawing scale: a dimension whose shown value differs from its geometric length by a constant
  // ratio means the views are drawn at 1:n while the dimensions give the real size.
  const ratios = dims.filter((d) => d.geometric > 1 && d.text && /^\s*\d/.test(d.text)).map((d) => d.value / d.geometric).sort((a, b) => a - b);
  let scale = 1;
  if (ratios.length >= 2) {
    const mid = ratios[Math.floor(ratios.length / 2)];
    const agree = ratios.filter((r) => Math.abs(r / mid - 1) < 0.02).length;
    if (agree >= Math.max(2, ratios.length * 0.6) && Math.abs(mid - 1) > 0.02) scale = mid;
  }

  // Views: connected groups of linework. Tiny groups (arrows, hatching islands) join the nearest view.
  const items = shapes.map((s) => ({ s, b: box(s.points) }));
  const all = box(shapes.flatMap((s) => s.points));
  const diag = Math.hypot(all.w, all.h) || 1;
  let groups = groupBoxes(items, diag * 0.012).map((g) => ({ items: g, b: box(g.flatMap((i) => [{ x: i.b.x0, y: i.b.y0 }, { x: i.b.x1, y: i.b.y1 }])) }));
  groups.sort((a, b) => b.b.w * b.b.h - a.b.w * a.b.h);
  const big = groups.filter((g) => Math.hypot(g.b.w, g.b.h) > diag * 0.06);
  // Text-heavy groups (title block, parameter tables) are not views.
  const textsIn = (b, pad = 0) => texts.filter((t) => t.x >= b.x0 - pad && t.x <= b.x1 + pad && t.y >= b.y0 - pad && t.y <= b.y1 + pad);
  const views = [];
  const tables = [];
  for (const g of big) {
    const inner = textsIn(g.b);
    const isTable = inner.length >= 6 && g.items.every((i) => i.s.points.length <= 5) && g.items.length < inner.length * 6;
    (isTable ? tables : views).push(g);
  }
  views.splice(8);
  views.forEach((v, i) => {
    v.id = `V${i + 1}`;
    v.dims = [];
    v.texts = [];
  });
  const nearestView = (p) => {
    let best = null;
    let bestD = Infinity;
    for (const v of views) {
      const dx = Math.max(v.b.x0 - p.x, 0, p.x - v.b.x1);
      const dy = Math.max(v.b.y0 - p.y, 0, p.y - v.b.y1);
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return bestD < diag * 0.08 ? best : null;
  };
  for (const d of dims) nearestView(d.at)?.dims.push(d);
  const loose = [];
  for (const t of texts) {
    const inTable = tables.some((g) => t.x >= g.b.x0 && t.x <= g.b.x1 && t.y >= g.b.y0 && t.y <= g.b.y1);
    const v = inTable ? null : nearestView(t);
    if (v) v.texts.push(t);
    else loose.push(t);
  }

  // Outlines per view: the biggest closed shapes, simplified, in mm relative to the view's lower-left.
  const geometry = {};
  const viewSummary = views.map((v) => {
    const tol = Math.hypot(v.b.w, v.b.h) * 0.002;
    const closed = v.items.filter((i) => i.s.closed && i.s.points.length >= 3).map((i) => ({ i, a: area(i.s.points) })).sort((a, b) => b.a - a.a).slice(0, 24);
    const outlines = closed.map(({ i }, n) => {
      const id = `${v.id}-P${n + 1}`;
      const pts = simplify(i.s.points, tol).map((p) => ({ x: (p.x - v.b.x0) * scale, y: (p.y - v.b.y0) * scale }));
      geometry[id] = pts.slice(0, 400);
      const b = box(pts);
      return { id, 图层: i.s.layer, 点数: pts.length, 左下_mm: [round(b.x0), round(b.y0)], 宽高_mm: [round(b.w), round(b.h)] };
    });
    const title = v.texts.filter((t) => VIEW_WORDS.test(t.text)).sort((a, b) => b.height - a.height)[0]?.text ?? null;
    const dimsOut = v.dims.map((d) => ({
      值: +d.value.toFixed(1),
      方向: d.direction,
      ...(d.text && d.text !== String(+d.value.toFixed(1)) ? { 标注文字: d.text } : {}),
      位置_mm: [round((d.at.x - v.b.x0) * scale), round((d.at.y - v.b.y0) * scale)],
    })).sort((a, b) => b.值 - a.值).slice(0, 60);
    return {
      id: v.id,
      标题: title,
      图面尺寸_mm: [round(v.b.w * scale), round(v.b.h * scale)],
      标注: dimsOut,
      文字: [...new Set(v.texts.map((t) => t.text))].slice(0, 30),
      主要轮廓: outlines.slice(0, 12),
      线条数: v.items.length,
    };
  });

  // Table rows read left to right, top to bottom.
  const tableText = tables.flatMap((g) => textsIn(g.b).sort((a, b) => b.y - a.y || a.x - b.x).map((t) => t.text));
  const params = [...new Set([...loose, ...views.flatMap((v) => v.texts)].map((t) => t.text).filter((t) => PARAM_WORDS.test(t) && t.length <= 120 && !tableText.includes(t)))].slice(0, 80);
  const summary = {
    来源: sourceName,
    单位: `${{ 0: '未指定(按mm)', 1: 'inch', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'm' }[insunits] ?? insunits}`,
    图面比例: scale === 1 ? '1:1（或无法从标注推算）' : `约 1:${+scale.toFixed(2)}（标注值 ÷ 图面长度），以下图面尺寸和轮廓已换算为实际 mm`,
    图幅_mm: [round(all.w), round(all.h)],
    视图: viewSummary,
    参数文字: params,
    表格与标题栏: [...new Set(tableText)].slice(0, 80),
    其他文字: [...new Set(loose.map((t) => t.text))].filter((t) => !params.includes(t) && !tableText.includes(t)).slice(0, 40),
    标注总数: dims.length,
    说明: '标注.值 是图纸给出的尺寸（mm，角度为度），可作为「图纸标注」来源；图面尺寸、轮廓宽高是量取值，作为「图纸量取」来源；轮廓 id 可用于 extrude 零件的 profile。',
  };
  if (!views.length) throw new Error('没在图纸里找到视图（只有文字或表格）');
  return { summary, geometry, scale };
}
