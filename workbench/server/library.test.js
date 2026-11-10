import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'weihua-library-'));
process.env.WORKBENCH_DATA_DIR = dataDir;

const library = await import('./library/index.js');
const { THREE, exportGlb } = await import('./library/three-node.js');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { DWG_UNSUPPORTED } = await import('./library/convert.js');
const { startServer } = await import('./index.js');

let server;
let base;

before(async () => {
  server = startServer(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

// ---------- fixtures ----------

// Axis-aligned box from (0,0,0) to (sx,sy,sz) as 12 triangles with outward winding.
function boxTriangles(sx, sy, sz) {
  const v = (i) => [(i & 1) * sx, ((i >> 1) & 1) * sy, ((i >> 2) & 1) * sz];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return quads.flatMap(([a, b, c, d]) => [[v(a), v(b), v(c)], [v(a), v(c), v(d)]]);
}

function asciiStl(sx, sy, sz) {
  const facets = boxTriangles(sx, sy, sz).map((tri) => `facet normal 0 0 0\nouter loop\n${tri.map((p) => `vertex ${p.join(' ')}`).join('\n')}\nendloop\nendfacet`);
  return Buffer.from(`solid box\n${facets.join('\n')}\nendsolid box\n`);
}

function binaryStl(sx, sy, sz) {
  const tris = boxTriangles(sx, sy, sz);
  const buffer = Buffer.alloc(84 + tris.length * 50);
  buffer.write('solid binary header that starts like ascii', 0, 'latin1');
  buffer.writeUInt32LE(tris.length, 80);
  tris.forEach((tri, i) => {
    let offset = 84 + i * 50 + 12;
    for (const p of tri) for (const c of p) { buffer.writeFloatLE(c, offset); offset += 4; }
  });
  return buffer;
}

function objBox(sx, sy, sz, { mtl = false } = {}) {
  const lines = [];
  if (mtl) lines.push('mtllib box.mtl', 'usemtl painted');
  for (let i = 0; i < 8; i += 1) lines.push(`v ${(i & 1) * sx} ${((i >> 1) & 1) * sy} ${((i >> 2) & 1) * sz}`);
  lines.push('vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1');
  for (const quad of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) {
    lines.push(`f ${quad.map((index, k) => `${index + 1}/${k + 1}`).join(' ')}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

function plyBox(sx, sy, sz) {
  const verts = Array.from({ length: 8 }, (_, i) => `${(i & 1) * sx} ${((i >> 1) & 1) * sy} ${((i >> 2) & 1) * sz}`);
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]].map((f) => `4 ${f.join(' ')}`);
  return Buffer.from(['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'element face 6', 'property list uchar int vertex_indices', 'end_header', ...verts, ...faces, ''].join('\n'));
}

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Minimal AP214 STEP of an axis-aligned box in millimetres.
function stepBox(sx, sy, sz) {
  const out = [];
  let n = 100;
  const add = (text) => { n += 1; out.push(`#${n}=${text};`); return `#${n}`; };
  const real = (value) => (Number.isInteger(value) ? `${value}.` : String(value));
  const point = (p) => add(`CARTESIAN_POINT('',(${p.map(real).join(',')}))`);
  const dir = (d) => add(`DIRECTION('',(${d.map(real).join(',')}))`);
  const coords = Array.from({ length: 8 }, (_, i) => [(i & 1) * sx, ((i >> 1) & 1) * sy, ((i >> 2) & 1) * sz]);
  const vertices = coords.map((c) => add(`VERTEX_POINT('',${point(c)})`));
  const edges = new Map();
  const edge = (a, b) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (!edges.has(key)) {
      const [from, to] = a < b ? [a, b] : [b, a];
      const delta = coords[to].map((value, k) => value - coords[from][k]);
      const length = Math.hypot(...delta);
      const line = add(`LINE('',${point(coords[from])},${add(`VECTOR('',${dir(delta.map((d) => d / length))},${real(length)})`)})`);
      edges.set(key, { id: add(`EDGE_CURVE('',${vertices[from]},${vertices[to]},${line},.T.)`), from });
    }
    const found = edges.get(key);
    return add(`ORIENTED_EDGE('',*,*,${found.id},${found.from === a ? '.T.' : '.F.'})`);
  };
  const faceDefs = [
    [[0, 2, 3, 1], [0, 0, -1], [1, 0, 0]], [[4, 5, 7, 6], [0, 0, 1], [1, 0, 0]],
    [[0, 1, 5, 4], [0, -1, 0], [1, 0, 0]], [[2, 6, 7, 3], [0, 1, 0], [1, 0, 0]],
    [[0, 4, 6, 2], [-1, 0, 0], [0, 1, 0]], [[1, 3, 7, 5], [1, 0, 0], [0, 1, 0]],
  ];
  const faces = faceDefs.map(([loop, normal, ref]) => {
    const oriented = loop.map((a, k) => edge(a, loop[(k + 1) % 4]));
    const bound = add(`FACE_OUTER_BOUND('',${add(`EDGE_LOOP('',(${oriented.join(',')}))`)},.T.)`);
    const plane = add(`PLANE('',${add(`AXIS2_PLACEMENT_3D('',${point(coords[loop[0]])},${dir(normal)},${dir(ref)})`)})`);
    return add(`ADVANCED_FACE('',(${bound}),${plane},.T.)`);
  });
  const solid = add(`MANIFOLD_SOLID_BREP('box',${add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
  const header = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('box'),'2;1');", "FILE_NAME('box.step','2026-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;',
    "#1=APPLICATION_CONTEXT('automotive design');",
    "#2=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#1);",
    "#3=PRODUCT_CONTEXT('',#1,'mechanical');",
    "#4=PRODUCT('Box','Box','',(#3));",
    "#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');",
    "#6=PRODUCT_DEFINITION_FORMATION('','',#4);",
    "#7=PRODUCT_DEFINITION('design','',#6,#5);",
    "#8=PRODUCT_DEFINITION_SHAPE('','',#7);",
    '#9=SHAPE_DEFINITION_REPRESENTATION(#8,#10);',
    `#10=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,${solid}),#19);`,
    "#11=AXIS2_PLACEMENT_3D('',#12,#13,#14);",
    "#12=CARTESIAN_POINT('',(0.,0.,0.));", "#13=DIRECTION('',(0.,0.,1.));", "#14=DIRECTION('',(1.,0.,0.));",
    '#15=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
    '#16=( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );',
    '#17=( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );',
    "#18=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#15,'distance_accuracy_value','confusion accuracy');",
    "#19=( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#18)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#15,#16,#17)) REPRESENTATION_CONTEXT('',''));",
  ];
  return Buffer.from([...header, ...out, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n'));
}

// ---------- helpers ----------

async function loadGlb(asset) {
  assert.equal(asset.status, 'ready', asset.message);
  assert.equal(asset.kind, 'model');
  assert.match(asset.url, /^\/library\/files\/a_[a-z0-9]+\/model\.glb$/);
  const bytes = await fs.readFile(path.join(dataDir, 'library', 'files', ...asset.url.split('/').slice(3)));
  assert.equal(bytes.toString('latin1', 0, 4), 'glTF');
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const box = new THREE.Box3().setFromObject(gltf.scene);
  return { gltf, size: box.getSize(new THREE.Vector3()), min: box.min };
}

function assertSize(actual, expected, label) {
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-3, `${label} ${axis}: ${actual[axis]} != ${expected[axis]}`);
}

async function convertsTo(filename, buffer, expected) {
  const asset = await library.importUpload({ filename, buffer });
  const { size, min, gltf } = await loadGlb(asset);
  assertSize(size, expected, filename);
  assertSize(asset.meta.bboxM, expected, `${filename} meta`);
  assert.ok(Math.abs(min.y) < 1e-6, `${filename} should sit on y=0`);
  assert.ok(asset.meta.triangles >= 12);
  return { asset, gltf };
}

// ---------- conversion ----------

test('ascii STL in mm (Z-up) becomes a Y-up GLB in metres', async () => {
  const { asset } = await convertsTo('盒子.stl', asciiStl(2000, 1000, 500), { x: 2, y: 0.5, z: 1 });
  assert.equal(asset.originalFormat, 'stl');
  assert.equal(asset.meta.scaleApplied, 0.001);
  assert.equal(asset.originalName, '盒子.stl');
});

test('binary STL whose header starts with "solid" is still read as binary', async () => {
  const { asset } = await convertsTo('box-binary.stl', binaryStl(2000, 1000, 500), { x: 2, y: 0.5, z: 1 });
  assert.equal(asset.meta.triangles, 12);
});

test('OBJ and PLY in metres keep their size', async () => {
  await convertsTo('box.obj', objBox(1, 2, 3), { x: 1, y: 2, z: 3 });
  await convertsTo('box.ply', plyBox(1.5, 0.5, 0.25), { x: 1.5, y: 0.5, z: 0.25 });
});

test('GLB round-trips, and content wins over a wrong extension', async () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 2), new THREE.MeshStandardMaterial({ color: 0x3366ff }));
  scene.add(mesh);
  const glb = await exportGlb(scene);
  const { gltf } = await convertsTo('equipment.glb', glb, { x: 4, y: 1, z: 2 });
  let color = null;
  gltf.scene.traverse((object) => { if (object.isMesh) color = object.material.color.getHex(); });
  assert.equal(color, 0x3366ff);
  const renamed = await library.importUpload({ filename: 'mislabelled.stl', buffer: glb });
  assert.equal(renamed.originalFormat, 'glb');
  assert.equal(renamed.status, 'ready');
});

test('zip with OBJ + MTL + texture packs materials and the image into the GLB', async () => {
  const zip = Buffer.from(zipSync({
    'parts/box.obj': objBox(1, 1, 1, { mtl: true }),
    'parts/box.mtl': Buffer.from('newmtl painted\nKd 0.8 0.2 0.1\nmap_Kd tex/paint.png\n'),
    'parts/tex/paint.png': png(4, 4),
    'readme.txt': Buffer.from('notes'),
  }));
  const { asset, gltf } = await convertsTo('bundle.zip', zip, { x: 1, y: 1, z: 1 });
  assert.equal(asset.originalFormat, 'zip');
  assert.equal(asset.meta.innerFormat, 'obj');
  assert.equal(asset.meta.mainEntry, 'parts/box.obj');
  assert.equal(gltf.parser.json.images?.length, 1);
  assert.equal(gltf.parser.json.images[0].mimeType, 'image/png');

  // The textured GLB itself can be uploaded again and keeps its embedded image.
  const glb = await fs.readFile(path.join(dataDir, 'library', 'files', asset.id, 'model.glb'));
  const again = await convertsTo('textured.glb', glb, { x: 1, y: 1, z: 1 });
  assert.equal(again.gltf.parser.json.images?.length, 1);
});

test('Collada and 3MF honour their declared units and up axis', async () => {
  const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><unit name="millimeter" meter="0.001"/><up_axis>Z_UP</up_axis></asset>
<library_geometries><geometry id="g"><mesh>
<source id="p"><float_array id="pa" count="9">0 0 0 1000 0 0 0 2000 500</float_array>
<technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
<triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles>
</mesh></geometry></library_geometries>
<library_visual_scenes><visual_scene id="s"><node id="n"><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#s"/></scene></COLLADA>`;
  const daeAsset = await library.importUpload({ filename: 'tri.dae', buffer: Buffer.from(dae) });
  assertSize((await loadGlb(daeAsset)).size, { x: 1, y: 0.5, z: 2 }, 'dae');

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1000" y="0" z="0"/><vertex x="0" y="2000" z="0"/><vertex x="0" y="0" z="500"/></vertices>
<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles>
</mesh></object></resources><build><item objectid="1"/></build></model>`;
  const rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const threeMf = Buffer.from(zipSync({ '_rels/.rels': Buffer.from(rels), '3D/3dmodel.model': Buffer.from(model) }));
  const mfAsset = await library.importUpload({ filename: 'tet.3mf', buffer: threeMf });
  assert.equal(mfAsset.originalFormat, '3mf');
  assertSize((await loadGlb(mfAsset)).size, { x: 1, y: 0.5, z: 2 }, '3mf');
});

test('zip with path traversal entries is handled without escaping', async () => {
  const zip = Buffer.from(zipSync({ '../../evil.obj': objBox(1, 1, 1), 'ok/box.stl': asciiStl(1, 1, 1) }));
  const asset = await library.importUpload({ filename: 'evil.zip', buffer: zip });
  assert.equal(asset.status, 'ready', asset.message);
  assert.equal(asset.meta.mainEntry, 'ok/box.stl');
  await assert.rejects(fs.access(path.join(dataDir, 'evil.obj')));
});

test('STEP box (mm) converts through occt-import-js', async () => {
  const { asset } = await convertsTo('box.step', stepBox(2000, 1000, 500), { x: 2, y: 0.5, z: 1 });
  assert.equal(asset.originalFormat, 'step');
});

test('sample DXF becomes site JSON with stations and paths', async () => {
  const dxf = await fs.readFile(path.resolve(here, '../../data/cad/sample-plant.dxf'));
  const asset = await library.importUpload({ filename: 'sample-plant.dxf', buffer: dxf });
  assert.equal(asset.status, 'ready', asset.message);
  assert.equal(asset.kind, 'site');
  assert.equal(asset.meta.convention, 'weihua');
  assert.ok(asset.meta.counts.stations >= 2);
  assert.ok(asset.meta.dxfUrl.endsWith('/original.dxf'));
  const site = JSON.parse(await fs.readFile(path.join(dataDir, 'library', 'files', asset.id, 'site.json'), 'utf8'));
  for (const key of ['stations', 'beams', 'paths', 'walls', 'columns', 'machines', 'racks']) assert.ok(Array.isArray(site[key]), key);
});

test('a DXF outside the layer convention falls back to generic linework', async () => {
  const dxf = Buffer.from(['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '5000', '21', '3000', '31', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'));
  const asset = await library.importUpload({ filename: 'plain.dxf', buffer: dxf });
  assert.equal(asset.status, 'ready', asset.message);
  assert.equal(asset.meta.convention, 'generic');
  assert.match(asset.message, /图层约定/);
});

test('PNG is stored as a floor-plan image with its size', async () => {
  const asset = await library.importUpload({ filename: 'floor.png', buffer: png(3, 2) });
  assert.equal(asset.status, 'ready');
  assert.equal(asset.kind, 'image');
  assert.deepEqual([asset.meta.width, asset.meta.height], [3, 2]);
  assert.match(asset.url, /original\.png$/);
});

test('documents are kept, unknown and DWG files are reported in Chinese', async () => {
  const pdf = await library.importUpload({ filename: 'spec.pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
  assert.equal(pdf.kind, 'document');
  assert.equal(pdf.status, 'ready');
  const unknown = await library.importUpload({ filename: 'data.xyz', buffer: Buffer.from([0, 1, 2, 3, 250, 251, 252]) });
  assert.equal(unknown.status, 'unsupported');
  assert.match(unknown.message, /暂不支持|无法识别/);
  const dwg = await library.importUpload({ filename: 'plant.dwg', buffer: Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(512)]) });
  assert.equal(dwg.originalFormat, 'dwg');
  assert.equal(dwg.status, 'unsupported');
  assert.equal(dwg.message, DWG_UNSUPPORTED);
  const broken = await library.importUpload({ filename: 'broken.glb', buffer: Buffer.from('glTF\x01\x00\x00\x00') });
  assert.equal(broken.status, 'failed');
  assert.ok(broken.message);
});

// ---------- REST ----------

async function call(method, url, body) {
  const response = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}

test('product CRUD persists across a restart and builtin edits are overrides', async () => {
  const list = await call('GET', '/api/library/products');
  assert.equal(list.status, 200);
  const ids = list.body.products.map((product) => product.id);
  for (const id of ['agv1', 'z1-1000-bz', 'double-girder-crane-demo']) assert.ok(ids.includes(id), id);
  const agv1 = list.body.products.find((product) => product.id === 'agv1');
  assert.equal(agv1.source, 'builtin');
  const model = await fetch(base + agv1.modelUrl);
  assert.equal(model.status, 200);
  assert.equal(Buffer.from(await model.arrayBuffer()).toString('latin1', 0, 4), 'glTF');
  assert.equal((await call('GET', '/api/products')).body.products.length, list.body.products.length);

  const created = await call('POST', '/api/library/products', {
    id: 'agv-test', model: 'AGV-T', category: 'agv', capacityT: 5,
    params: { length: { label: '车长', nominal: 3000, min: 2000, max: 4000, step: 10 } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.product.source, 'user');
  assert.equal((await call('POST', '/api/library/products', { id: 'agv-test', model: 'x', category: 'agv' })).status, 409);

  const bad = await call('PUT', '/api/library/products/agv-test', { params: { length: { nominal: 9000 } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /最小值 ≤ 标称值 ≤ 最大值/);

  const edited = await call('PUT', '/api/library/products/agv1', { params: { length: { max: 7000 } } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.product.params.length.max, 7000);
  assert.equal(edited.body.product.params.length.min, 2200);
  assert.equal(edited.body.product.overridden, true);

  // A fresh Node process reading the same data dir sees the same library.
  const script = `const lib = await import(${JSON.stringify(pathToFileURL(path.join(here, 'library/index.js')).href)}); const list = await lib.listProducts(); console.log(JSON.stringify(list.map((p) => [p.id, p.source, p.params?.length?.max ?? null])));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, WORKBENCH_DATA_DIR: dataDir } });
  const reloaded = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.deepEqual(reloaded.find(([id]) => id === 'agv-test'), ['agv-test', 'user', 4000]);
  assert.deepEqual(reloaded.find(([id]) => id === 'agv1'), ['agv1', 'builtin', 7000]);

  const reset = await call('DELETE', '/api/library/products/agv1');
  assert.equal(reset.body.reset, true);
  assert.equal((await call('GET', '/api/library/products/agv1')).body.product.params.length.max, 6000);
  assert.equal((await call('DELETE', '/api/library/products/agv-test')).body.deleted, true);
  assert.equal((await call('GET', '/api/library/products/agv-test')).status, 404);
});

test('scene upload: several files in one request, one failing does not fail the others', async () => {
  const form = new FormData();
  form.append('files', new Blob([asciiStl(1000, 1000, 1000)]), '立方体.stl');
  form.append('files', new Blob([Buffer.from('garbage')]), 'mystery.abc');
  form.append('files', new Blob([png(2, 2)]), 'plan.png');
  const response = await fetch(`${base}/api/library/scene`, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.assets.length, 3);
  const [stl, mystery, image] = body.assets;
  assert.equal(stl.status, 'ready');
  assert.equal(stl.name, '立方体');
  assert.equal(mystery.status, 'unsupported');
  assert.equal(image.kind, 'image');

  const glb = await fetch(base + stl.url);
  assert.equal(glb.status, 200);
  assert.equal(Buffer.from(await glb.arrayBuffer()).toString('latin1', 0, 4), 'glTF');

  const listed = await call('GET', '/api/library/scene');
  assert.ok(listed.body.assets.some((asset) => asset.id === stl.id));
  assert.equal((await call('GET', `/api/library/scene/${stl.id}`)).body.asset.id, stl.id);

  const product = await call('POST', '/api/library/products', { model: 'Cube Machine', category: 'machine', modelAssetId: stl.id });
  assert.equal(product.status, 201, JSON.stringify(product.body));
  assert.equal(product.body.product.modelUrl, stl.url);
  assert.equal(product.body.product.id, 'cube-machine');

  assert.equal((await call('DELETE', `/api/library/scene/${stl.id}`)).status, 200);
  assert.equal((await call('GET', `/api/library/scene/${stl.id}`)).status, 404);
  assert.equal((await fetch(base + stl.url)).status, 404);
  const noFiles = await fetch(`${base}/api/library/scene`, { method: 'POST', body: new FormData() });
  assert.equal(noFiles.status, 400);
});

test('project state keeps versions; chat history appends', async () => {
  const id = 'proj-test';
  assert.deepEqual((await call('GET', `/api/projects/${id}/state`)).body, { version: 0, state: null, updatedAt: null });
  for (let i = 1; i <= 3; i += 1) {
    const saved = await call('PUT', `/api/projects/${id}/state`, { state: { step: i, objects: [{ id: `o${i}` }] } });
    assert.equal(saved.body.version, i);
  }
  const current = await call('GET', `/api/projects/${id}/state`);
  assert.equal(current.body.version, 3);
  assert.deepEqual(current.body.state, { step: 3, objects: [{ id: 'o3' }] });
  const versions = await call('GET', `/api/projects/${id}/state/versions`);
  assert.deepEqual(versions.body.versions.map((v) => v.version), [3, 2, 1]);
  assert.equal((await call('GET', `/api/projects/${id}/state/versions/2`)).body.state.step, 2);
  assert.equal((await call('PUT', `/api/projects/${id}/state`, {})).status, 400);

  await call('POST', `/api/projects/${id}/chat-history`, { role: 'user', text: '加一台 AGV1' });
  const appended = await call('POST', `/api/projects/${id}/chat-history`, { messages: [{ role: 'assistant', text: '已添加', tools: [{ name: 'add_product' }] }] });
  assert.equal(appended.status, 201);
  const history = await call('GET', `/api/projects/${id}/chat-history`);
  assert.deepEqual(history.body.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal((await call('POST', `/api/projects/${id}/chat-history`, { role: 'robot', text: 'x' })).status, 400);
});

test('project state prunes to the last 50 versions', async () => {
  const id = 'prune-test';
  for (let i = 0; i < library.KEEP_VERSIONS + 5; i += 1) await library.saveProjectState(id, { i });
  const versions = await library.listProjectStateVersions(id);
  assert.equal(versions.length, library.KEEP_VERSIONS);
  assert.equal(versions[0].version, library.KEEP_VERSIONS + 5);
  assert.equal(versions.at(-1).version, 6);
});
