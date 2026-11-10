// DXF plan -> plain plant data, in millimetres. Layer rules: docs/cad-convention.md.
import DxfParser from 'dxf-parser';

class Attrib {
  ForEntityName = 'ATTRIB';

  parseEntity(scanner, curr) {
    const entity = { type: curr.value };
    curr = scanner.next();
    while (!scanner.isEOF() && curr.code !== 0) {
      if (curr.code === 2) entity.tag = String(curr.value);
      else if (curr.code === 1) entity.text = String(curr.value);
      curr = scanner.next();
    }
    return entity;
  }
}

class SeqEnd {
  ForEntityName = 'SEQEND';

  parseEntity(scanner, curr) {
    const entity = { type: curr.value };
    curr = scanner.next();
    while (!scanner.isEOF() && curr.code !== 0) curr = scanner.next();
    return entity;
  }
}

const REQUIRED_LAYERS = ['A-WALL', 'AGV-PATH', 'AGV-STAT'];
const INSERT_GROUPS = {
  'S-COLS': 'columns', 'Q-RACK': 'racks', 'Q-MACH': 'machines', 'Q-CONV': 'conveyors', 'Q-CRAN': 'cranes',
  'A-DOOR': 'doors', 'A-GLAZ': 'glazing', 'AGV-STAT': 'stations',
};
const MARK_COLORS = { 'A-FLOR-YEL': 'yellow', 'A-FLOR-GRN': 'green', 'A-FLOR-MARK': 'white' };

function polyline(entity) {
  const points = entity.vertices.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge ?? 0 }));
  return { points, closed: Boolean(entity.shape), width: entity.width ?? entity.constantWidth ?? 0 };
}

function blockRects(block) {
  const rects = [];
  for (const entity of block?.entities ?? []) {
    if (entity.type !== 'LWPOLYLINE') continue;
    const xs = entity.vertices.map((v) => v.x);
    const ys = entity.vertices.map((v) => v.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    rects.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, d: y1 - y0 });
  }
  return rects;
}

function placeRects(insert, rects) {
  const a = ((insert.rotation ?? 0) * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const [sx, sy] = [Math.abs(insert.xScale ?? 1), Math.abs(insert.yScale ?? 1)];
  return rects.map((r) => ({
    x: insert.position.x + r.cx * sx * c - r.cy * sy * s,
    y: insert.position.y + r.cx * sx * s + r.cy * sy * c,
    w: r.w * sx,
    d: r.d * sy,
    heading: a,
  }));
}

export function parseCad(text) {
  const parser = new DxfParser();
  parser.registerEntityHandler(Attrib);
  parser.registerEntityHandler(SeqEnd);
  let dxf;
  try {
    dxf = parser.parseSync(text);
  } catch (error) {
    throw new Error(`DXF 无法解析：${error.message}`);
  }
  const insunits = dxf.header?.$INSUNITS;
  if (insunits !== undefined && insunits !== 4) throw new Error(`图纸单位必须是毫米（$INSUNITS=4），当前是 ${insunits}`);

  const layers = new Set(dxf.entities.map((entity) => entity.layer));
  const missing = REQUIRED_LAYERS.filter((layer) => !layers.has(layer));
  if (missing.length) throw new Error(`图纸缺少图层：${missing.join('、')}`);

  const plant = {
    walls: [], beams: [], paths: [], marks: [], labels: [],
    columns: [], racks: [], machines: [], conveyors: [], cranes: [], doors: [], glazing: [], stations: [],
  };
  let lastInsert = null;
  for (const entity of dxf.entities) {
    if (entity.type === 'ATTRIB') {
      if (lastInsert && entity.tag) lastInsert.attrs[entity.tag] = entity.text ?? '';
      continue;
    }
    if (entity.type === 'SEQEND') {
      lastInsert = null;
      continue;
    }
    lastInsert = null;
    if (entity.type === 'INSERT' && INSERT_GROUPS[entity.layer]) {
      const item = {
        block: entity.name,
        x: entity.position.x,
        y: entity.position.y,
        heading: ((entity.rotation ?? 0) * Math.PI) / 180,
        rects: placeRects(entity, blockRects(dxf.blocks[entity.name])),
        attrs: {},
      };
      plant[INSERT_GROUPS[entity.layer]].push(item);
      lastInsert = item;
    } else if (entity.type === 'LWPOLYLINE') {
      const line = polyline(entity);
      if (entity.layer === 'A-WALL') plant.walls.push(line);
      else if (entity.layer === 'S-BEAM') plant.beams.push(line);
      else if (entity.layer === 'AGV-PATH') plant.paths.push(line);
      else if (MARK_COLORS[entity.layer]) plant.marks.push({ ...line, color: MARK_COLORS[entity.layer] });
    } else if (entity.type === 'TEXT' && entity.layer === 'A-ANNO-TEXT') {
      const at = entity.endPoint ?? entity.startPoint;
      plant.labels.push({ text: entity.text, x: at.x, y: at.y, height: entity.textHeight });
    }
  }

  plant.stations = plant.stations.map((station) => {
    const { ID: id, TYPE: type, SEQ: seq, CARGO: cargo = '' } = station.attrs;
    if (!id || !type || !seq) throw new Error(`工位缺少 ID/TYPE/SEQ 属性（块 ${station.block}）`);
    if (!['PICK', 'DROP', 'CHARGE'].includes(type)) throw new Error(`工位 ${id} 的 TYPE 不认识：${type}`);
    const order = seq.split(',').map(Number);
    if (order.some(Number.isNaN)) throw new Error(`工位 ${id} 的 SEQ 不是数字：${seq}`);
    return { ...station, id, type, order, cargo };
  });
  if (plant.stations.length < 2) throw new Error('至少需要 2 个工位');
  return plant;
}
