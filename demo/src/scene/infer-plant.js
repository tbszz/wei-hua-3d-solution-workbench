// Any DXF plan (no layer convention) -> plant data for buildPlant, in millimetres.
// Reads the geometry the way a person would: small closed outlines are columns, the smallest
// big outline that holds the columns is the hall, column rows give the crane bays, other
// rectangles are zones or machines, the rest is floor linework.
import DxfParser from 'dxf-parser';

export const UNITS = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 14: 100 };
const COLUMN_MAX = 2500;
const WALL_WIDTH = 240;
const BEAM_TOP = 8950; // underside of the runway beam (see buildPlant)
const STEEL_HEIGHT = 12000;
const MACHINE_BLOCKS = ['MACH_CNC', 'MACH_PRESS', 'MACH_WELD'];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function box(points) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export function area(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

function inside(p, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function arc(center, radius, start, end, k) {
  let sweep = end - start;
  if (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(6, Math.ceil((24 * sweep) / (Math.PI * 2)));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = start + (sweep * i) / n;
    return { x: (center.x + radius * Math.cos(a)) * k, y: (center.y + radius * Math.sin(a)) * k };
  });
}

// Every drawable entity as a point list, block inserts expanded one level deep.
export function collect(dxf, k) {
  const out = [];
  const labels = [];
  const add = (layer, raw, closed) => {
    let points = raw.filter((p, i) => Number.isFinite(p.x) && Number.isFinite(p.y) && (i === 0 || dist(p, raw[i - 1]) > 1));
    if (points.length < 2) return;
    if (closed && points.length > 2 && dist(points[0], points.at(-1)) < 1) points = points.slice(0, -1);
    else if (!closed && points.length > 3 && dist(points[0], points.at(-1)) < 1) {
      points = points.slice(0, -1);
      closed = true;
    }
    out.push({ layer, points, closed });
  };
  const visit = (entity, tf) => {
    const p = (v) => tf({ x: v.x * k, y: v.y * k });
    const layer = entity.layer ?? '0';
    switch (entity.type) {
      case 'LINE':
        if (entity.vertices?.length >= 2) add(layer, entity.vertices.map(p), false);
        break;
      case 'LWPOLYLINE':
      case 'POLYLINE':
        if (entity.vertices?.length >= 2) add(layer, entity.vertices.map(p), Boolean(entity.shape));
        break;
      case 'SPLINE': {
        const pts = entity.fitPoints?.length >= 2 ? entity.fitPoints : entity.controlPoints;
        if (pts?.length >= 2) add(layer, pts.map(p), Boolean(entity.closed));
        break;
      }
      case 'CIRCLE':
        add(layer, arc(entity.center, entity.radius, 0, Math.PI * 2, 1).map((v) => tf({ x: v.x * k, y: v.y * k })), true);
        break;
      case 'ARC':
        add(layer, arc(entity.center, entity.radius, entity.startAngle, entity.endAngle, 1).map((v) => tf({ x: v.x * k, y: v.y * k })), false);
        break;
      case 'TEXT':
      case 'MTEXT': {
        const at = entity.startPoint ?? entity.position;
        if (at && entity.text) labels.push({ text: String(entity.text).replace(/\\[A-Za-z][^;]*;|[{}]/g, '').slice(0, 40), ...p(at), height: (entity.textHeight ?? entity.height ?? 300) * k });
        break;
      }
      default:
    }
  };
  const identity = (v) => v;
  for (const entity of dxf.entities ?? []) {
    if (entity.type === 'INSERT' && dxf.blocks?.[entity.name]) {
      const a = ((entity.rotation ?? 0) * Math.PI) / 180;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const [sx, sy] = [entity.xScale ?? 1, entity.yScale ?? 1];
      const at = entity.position;
      const tf = (v) => ({ x: at.x * k + v.x * sx * c - v.y * sy * s, y: at.y * k + v.x * sx * s + v.y * sy * c });
      for (const child of dxf.blocks[entity.name].entities ?? []) if (child.type !== 'INSERT') visit({ ...child, layer: child.layer === '0' ? entity.layer : child.layer }, tf);
    } else visit(entity, identity);
  }
  return { shapes: out, labels };
}

// Group sorted values that sit within `gap` of their neighbour; returns cluster centres.
function clusters(values, gap) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const last = groups.at(-1);
    if (last && v - last.at(-1) <= gap) last.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => ({ at: (g[0] + g.at(-1)) / 2, count: g.length }));
}

const nearest = (lines, v) => lines.reduce((best, line) => (Math.abs(line - v) < Math.abs(best - v) ? line : best), lines[0]);
const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};

function rectOf(points) {
  const [a, b, c] = points;
  const heading = Math.atan2(b.y - a.y, b.x - a.x);
  const centre = { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
  return { x: centre.x, y: centre.y, w: dist(a, b), d: dist(b, c), heading };
}

export function inferPlant(text, sourceName = '') {
  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(text);
  } catch (error) {
    throw new Error(`DXF 无法解析：${error.message}`);
  }
  const k = UNITS[dxf.header?.$INSUNITS] ?? 1;
  const { shapes, labels } = collect(dxf, k);
  if (!shapes.length) throw new Error('图纸里没有可用的线条');

  // 1. Columns: small closed outlines.
  const columnShapes = [];
  const rest = [];
  for (const shape of shapes) {
    const b = box(shape.points);
    const big = Math.max(b.w, b.h);
    if (shape.closed && shape.points.length >= 4 && big <= COLUMN_MAX && Math.min(b.w, b.h) >= 80) {
      const concreteLayer = /水泥|混凝土|砼|concrete|^rc|col-c/i.test(shape.layer);
      const steelLayer = /钢|steel/i.test(shape.layer);
      const concrete = concreteLayer || (!steelLayer && shape.points.length === 4 && Math.min(b.w, b.h) >= 600);
      columnShapes.push({ points: shape.points, layer: shape.layer, kind: concrete ? 'concrete' : 'steel', cx: b.cx, cy: b.cy });
    } else rest.push({ ...shape, b, area: shape.closed ? area(shape.points) : 0 });
  }

  // 2. The hall: the smallest big outline that holds most of the columns.
  const closed = rest.filter((s) => s.closed && s.points.length >= 3).sort((a, b) => a.area - b.area);
  const centres = columnShapes.map((c) => ({ x: c.cx, y: c.cy }));
  let hall = null;
  if (centres.length >= 4) {
    hall = closed.find((s) => s.area > 1e8 && centres.filter((p) => inside(p, s.points)).length >= centres.length * 0.85);
  }
  hall ??= closed.at(-1);
  let outline;
  if (hall) outline = hall.points;
  else {
    const b = box(centres.length ? centres : rest.flatMap((s) => s.points));
    outline = [{ x: b.x0 - 1000, y: b.y0 - 1000 }, { x: b.x1 + 1000, y: b.y0 - 1000 }, { x: b.x1 + 1000, y: b.y1 + 1000 }, { x: b.x0 - 1000, y: b.y1 + 1000 }];
  }
  const hb = box(outline);
  if (hb.w < 6000 || hb.h < 6000) throw new Error(`识别出的厂房只有 ${(hb.w / 1000).toFixed(1)} × ${(hb.h / 1000).toFixed(1)} m，不像厂房平面图`);
  const hallArea = area(outline);
  const yard = closed.find((s) => s !== hall && s.area > hallArea * 1.15 && inside({ x: hb.cx, y: hb.cy }, s.points));
  const inHall = (p) => inside(p, outline);
  const columns = columnShapes.filter((c) => inHall({ x: c.cx, y: c.cy }) || !hall);

  // 3. Grid. The runway runs along the long side of the hall; rows of columns sit across it.
  const alongX = hb.w >= hb.h;
  const U = (p) => (alongX ? p.x : p.y);
  const V = (p) => (alongX ? p.y : p.x);
  const XY = (u, v) => (alongX ? { x: u, y: v } : { x: v, y: u });
  const turn = alongX ? 0 : Math.PI / 2; // heading of something that runs along the runway
  const across = turn + Math.PI / 2;
  const uLines = clusters(columns.map((c) => U({ x: c.cx, y: c.cy })), 1200).filter((c) => c.count >= 2).map((c) => c.at);
  const rows = clusters(columns.map((c) => V({ x: c.cx, y: c.cy })), 1200).filter((c) => c.count >= 2).map((c) => c.at);
  const gridColumns = [];
  if (uLines.length && rows.length) {
    const seen = new Set();
    for (const c of columns) {
      const u = nearest(uLines, U({ x: c.cx, y: c.cy }));
      const v = nearest(rows, V({ x: c.cx, y: c.cy }));
      const key = `${u}|${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gridColumns.push({ block: 'GRID', ...XY(u, v), heading: 0, rects: [], attrs: {} });
    }
  }

  // Columns: concrete stops under the runway beam, steel goes up to the roof.
  const hasConcrete = columns.some((c) => c.kind === 'concrete');
  // Steel columns off the grid lines are crane columns: they stop under the runway beam too.
  for (const c of columns) {
    const v = V({ x: c.cx, y: c.cy });
    const offGrid = rows.length && Math.abs(v - nearest(rows, v)) > 250;
    c.height = c.kind === 'concrete' || offGrid ? BEAM_TOP : STEEL_HEIGHT;
  }

  // 4. Crane bays between neighbouring rows, runway beams on the crane-column side of each row.
  const offsets = [];
  for (const c of columns) {
    if (c.kind !== 'steel') continue;
    const v = V({ x: c.cx, y: c.cy });
    const off = Math.abs(v - nearest(rows, v));
    if (off > 250 && off < 1500) offsets.push(off);
  }
  const beamOffset = median(offsets) ?? (hasConcrete ? 550 : 750);
  const u0 = uLines.length ? uLines[0] : alongX ? hb.x0 + 3000 : hb.y0 + 3000;
  const u1 = uLines.length ? uLines.at(-1) : alongX ? hb.x1 - 3000 : hb.y1 - 3000;
  const beams = [];
  const cranes = [];
  const bays = [];
  const stagger = [0.32, 0.62, 0.46, 0.76, 0.24];
  for (let i = 0; i + 1 < rows.length; i++) {
    const [va, vb] = [rows[i], rows[i + 1]];
    const span = vb - va;
    if (span < 9000 || span > 40000) continue;
    const [ra, rb] = [va + beamOffset, vb - beamOffset];
    for (const v of [ra, rb]) beams.push({ points: [XY(u0, v), XY(u1, v)], closed: false, width: 500 });
    const vc = (va + vb) / 2;
    const name = String.fromCharCode(65 + bays.length);
    bays.push({ name, from: va, to: vb, span, centre: vc, label: XY(u0 + 6000, vc) });
    const u = u0 + (u1 - u0) * stagger[i % stagger.length];
    const girder = rb - ra - 400;
    const rects = [
      { ...XY(u - 1100, vc), w: girder, d: 600, heading: across },
      { ...XY(u + 1100, vc), w: girder, d: 600, heading: across },
      // End trucks straddle the 500 mm runway beam; the same width would make their side faces
      // coincide with the beam's and z-fight.
      { ...XY(u, ra), w: 5200, d: 640, heading: turn },
      { ...XY(u, rb), w: 5200, d: 640, heading: turn },
    ];
    cranes.push({ block: 'CRANE', ...XY(u, vc - span * 0.12), heading: across, rects, attrs: { HEIGHT: '9800', BAY: name, SPAN: String(Math.round(rb - ra)) } });
  }

  // 5. Walls, gable doors on every bay, window bands along the long walls.
  const walls = [{ points: outline, closed: true, width: WALL_WIDTH }];
  const doors = [];
  const glazing = [];
  const [ue0, ue1] = alongX ? [hb.x0, hb.x1] : [hb.y0, hb.y1];
  const [ve0, ve1] = alongX ? [hb.y0, hb.y1] : [hb.x0, hb.x1];
  const doorBays = bays.length ? bays.map((b) => b.centre) : [(ve0 + ve1) / 2];
  for (const u of [ue0, ue1]) {
    for (const v of doorBays) doors.push({ block: 'DOOR', ...XY(u, v), heading: across, rects: [{ ...XY(u, v), w: 6000, d: WALL_WIDTH, heading: across }], attrs: { HEIGHT: '6000' } });
  }
  const pitchLines = uLines.length >= 2 ? uLines : Array.from({ length: Math.max(2, Math.round((ue1 - ue0) / 8000)) + 1 }, (_, i, a) => ue0 + ((ue1 - ue0) * i) / (a.length - 1));
  for (const v of [ve0, ve1]) {
    for (let i = 0; i + 1 < pitchLines.length; i++) {
      const [a, b] = [pitchLines[i], pitchLines[i + 1]];
      const w = b - a - 1600;
      if (w < 2000) continue;
      const at = XY((a + b) / 2, v);
      glazing.push({ block: 'WIN', ...at, heading: turn, rects: [{ ...at, w, d: WALL_WIDTH, heading: turn }], attrs: { SILL: '1500', HEIGHT: '2600' } });
      if (i % 2 === 0) glazing.push({ block: 'PANEL_3000', ...at, heading: turn, rects: [{ ...at, w, d: WALL_WIDTH, heading: turn }], attrs: { SILL: '6800', HEIGHT: '2200' } });
    }
  }

  // 6. Everything else inside the site: zones, machines, rails, floor linework.
  const longest = Math.max(hb.w, hb.h);
  const marks = [];
  const machines = [];
  const rails = [];
  const open = [];
  for (const s of rest) {
    if (s === hall || s === yard) continue;
    const centre = { x: s.b.cx, y: s.b.cy };
    if (yard ? !inside(centre, yard.points) : !inHall(centre)) continue;
    if (s.closed) {
      const big = Math.max(s.b.w, s.b.h);
      if (s.area >= 60e6 || big >= 15000) marks.push({ points: s.points, closed: true, width: 160, color: 'yellow' });
      else if (s.points.length === 4 && big >= 2000 && inHall(centre)) {
        const rect = rectOf(s.points);
        const height = Math.min(4200, 1800 + Math.sqrt(s.area / 1e6) * 260);
        machines.push({ block: MACHINE_BLOCKS[machines.length % MACHINE_BLOCKS.length], x: rect.x, y: rect.y, heading: rect.heading, rects: [rect], attrs: { HEIGHT: String(Math.round(height)) } });
      } else marks.push({ points: s.points, closed: true, width: 60, color: 'white' });
      continue;
    }
    const length = s.points.reduce((sum, p, i) => (i ? sum + dist(s.points[i - 1], p) : 0), 0);
    const a = s.points[0];
    const b = s.points.at(-1);
    const dir = Math.atan2(b.y - a.y, b.x - a.x);
    const alongRunway = Math.abs(Math.sin(dir - turn)) < 0.02;
    // Axis and crane centre lines that run the whole hall are reference lines, not paint.
    if (alongRunway && length > longest * 0.6) continue;
    open.push({ ...s, length, dir });
  }
  // Two long parallel lines 1–3.6 m apart are a track.
  const used = new Set();
  const straight = open.filter((s) => s.points.length === 2 && s.length >= 20000);
  for (const a of straight) {
    if (used.has(a)) continue;
    for (const b of straight) {
      if (a === b || used.has(b) || Math.abs(Math.sin(a.dir - b.dir)) > 0.01) continue;
      const nx = -Math.sin(a.dir);
      const ny = Math.cos(a.dir);
      const gap = Math.abs((b.points[0].x - a.points[0].x) * nx + (b.points[0].y - a.points[0].y) * ny);
      if (gap < 1000 || gap > 3600) continue;
      used.add(a);
      used.add(b);
      rails.push({ points: a.points }, { points: b.points });
      break;
    }
  }
  for (const s of open) if (!used.has(s)) marks.push({ points: s.points, closed: false, width: s.length > 5000 ? 100 : 50, color: 'white' });

  const plant = {
    walls, beams, paths: [], marks, labels,
    columns: gridColumns, racks: [], machines, conveyors: [], cranes, doors, glazing, stations: [],
    columnShapes: columns.map(({ points, kind, height }) => ({ points, kind, height })),
    rails,
    yard: yard ? { points: yard.points } : null,
  };
  const summary = {
    来源: sourceName,
    厂房_m: [+(hb.w / 1000).toFixed(1), +(hb.h / 1000).toFixed(1)],
    方向: alongX ? '行车沿 X 向运行' : '行车沿 Y 向运行',
    跨: bays.map((b) => `${b.name} 跨 ${(b.span / 1000).toFixed(1)} m`),
    柱距_m: uLines.length >= 2 ? +((uLines[1] - uLines[0]) / 1000).toFixed(1) : null,
    柱线: uLines.length,
    柱: { 钢柱: columns.filter((c) => c.kind === 'steel').length, 混凝土柱: columns.filter((c) => c.kind === 'concrete').length },
    吊车梁: beams.length,
    行车: cranes.length,
    大门: doors.length,
    窗: glazing.length,
    设备: machines.length,
    分区: marks.filter((m) => m.color === 'yellow').length,
    轨道: rails.length / 2,
    地面线条: marks.filter((m) => m.color === 'white').length,
    厂区: Boolean(yard),
  };
  return { plant, summary, bays, bounds: hb, alongX };
}
