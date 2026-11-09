"""Convert AGV1.obj into a web GLB ready for parametric stretching.

Run headless:
  blender -b --factory-startup --python preprocess_agv1.py -- <AGV1.obj> <out.glb> <out.manifest.json>

Rhino writes one usemtl per object and encodes its colour in the name (diffuse_R_G_B_A), so the
OBJ needs no .mtl file. Each object is classified from its colour and position. Output axes and
the _ANCHOR convention match preprocess_z1.py. Materials are named "<class>:#rrggbb".
"""
import json
import math
import os
import sys
from collections import defaultdict

import bpy
import numpy as np

SRC, OUT_GLB, OUT_MANIFEST = sys.argv[sys.argv.index('--') + 1:][:3]

# Source origin, in file millimetres: length and width centred, wheels on the ground.
CENTER = np.array([1030.0, -47.41, -24729.8])
BODY_CLASSES = {'frame', 'deck', 'strip'}
LOCK_HEIGHT = {'drive'}
# Triangle budget per object. The laser scanners are 70% of the source triangles.
BUDGET = {'56_56_208': 1800, '27_187_187': 1400, '231_174_5': 1500, '42_23_23': 80, '28_21_21': 60, '42_27_27': 200,
          '133_76_76': 800, '197_175_175': 300, '190_151_10': 1200}
LASER = {'56_56_208', '27_187_187', '231_174_5', '42_23_23', '28_21_21', '42_27_27'}
DRIVE = {'134_36_36', '197_181_181', '197_175_175', '91_136_74'}
HMI = {'212_53_53', '216_216_216', '73_130_250'}
CHARGING = {'103_85_85', '190_151_10'}
TEXT = {'160_149_149', '218_212_212', '240_190_190'}
STRIP = {'48_46_46', '71_60_60'}


def sign(value):
    return '+' if value >= 0 else '-'


def classify(color, lo, hi, tris):
    """Return (class, group). Groups share one anchor, so assemblies move as one piece."""
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    span = hi - lo
    if color == '78_68_68':
        return 'deck', None
    if color in STRIP:
        return 'strip', None
    if color in LASER or (color == '133_76_76' and tris > 10000):
        return 'laser', f'laser_side{sign(cz)}' if abs(cx) < 200 else f'laser_end{sign(cx)}'
    if color == '133_76_76':
        if span[2] > 1000:
            return 'frame', None
        if span[2] < 5:
            return 'hmi', 'hmi'
        return 'drive', f'drive{sign(cx)}{sign(cz)}'
    if color in DRIVE:
        return 'drive', f'drive{sign(cx)}{sign(cz)}'
    if color in HMI:
        return 'hmi', 'hmi'
    if color in CHARGING:
        return 'charging', 'charging'
    if color == '49_255_0':
        return 'light', f'light{sign(cx)}{sign(cz)}'
    if color in TEXT:
        if abs(abs(cx) - 1400) < 1:
            kind = 'code' if color == '240_190_190' else 'load'
            return 'decal', f'end{sign(cx)}_{kind}'
        kind = 'code' if abs(cx) > 650 else 'load'
        return 'decal', f'side{sign(cz)}_{kind}'
    raise ValueError(f'unclassified colour {color} at {lo.round()} {hi.round()}')


verts, parts, current = [], [], None
with open(SRC, encoding='utf-8', errors='replace') as source:
    for line in source:
        if line.startswith('v '):
            verts.append(tuple(map(float, line.split()[1:4])))
        elif line.startswith('usemtl'):
            current = {'color': line.split()[1].removeprefix('diffuse_').rsplit('_', 1)[0], 'faces': []}
            parts.append(current)
        elif line.startswith('f '):
            current['faces'].append([int(token.split('/')[0]) - 1 for token in line.split()[1:]])
verts = np.array(verts, dtype=np.float64) - CENTER
parts = [p for p in parts if p['faces']]
source_tris = sum(len(f) - 2 for p in parts for f in p['faces'])

bpy.ops.wm.read_factory_settings(use_empty=True)
collection = bpy.context.scene.collection
records = []
for index, part in enumerate(parts):
    used, inverse = np.unique(np.fromiter((i for f in part['faces'] for i in f), dtype=np.int64), return_inverse=True)
    pts = verts[used]
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    tris = sum(len(f) - 2 for f in part['faces'])
    cls, group = classify(part['color'], lo, hi, tris)
    faces, cursor = [], 0
    for face in part['faces']:
        faces.append(inverse[cursor:cursor + len(face)].tolist())
        cursor += len(face)
    mesh = bpy.data.meshes.new(f'p{index}')
    # File (x, height, z) in mm -> Blender (x, -z, height) in m. glTF export brings it back.
    mesh.from_pydata((pts[:, [0, 2, 1]] * [1, -1, 1] / 1000).tolist(), [], faces)
    obj = bpy.data.objects.new(f'p{index}', mesh)
    collection.objects.link(obj)
    bmin = lo[[0, 2, 1]] * [1, 1, 1] / 1000
    bmax = hi[[0, 2, 1]] * [1, 1, 1] / 1000
    # Blender y is -z, so flip the range.
    bmin[1], bmax[1] = -hi[2] / 1000, -lo[2] / 1000
    records.append(dict(obj=obj, color=part['color'], cls=cls, group=group, tris=tris, bmin=bmin, bmax=bmax))

targets = [r for r in records if r['tris'] > BUDGET.get(r['color'], 10 ** 9)]
for r in targets:
    r['obj'].modifiers.new('d', 'DECIMATE').ratio = BUDGET[r['color']] / r['tris']
graph = bpy.context.evaluated_depsgraph_get()
for r, new_mesh in [(r, bpy.data.meshes.new_from_object(r['obj'].evaluated_get(graph))) for r in targets]:
    r['obj'].modifiers.clear()
    r['obj'].data = new_mesh

group_box = {}
for r in records:
    if r['group']:
        a, b = group_box.get(r['group'], (r['bmin'], r['bmax']))
        group_box[r['group']] = (np.minimum(a, r['bmin']), np.maximum(b, r['bmax']))

materials = {}
for r in records:
    mesh = r['obj'].data
    cls = r['cls']
    a, b = group_box[r['group']] if r['group'] else (r['bmin'], r['bmax'])
    c = (a + b) / 2
    if cls not in BODY_CLASSES:
        anchor = (float(c[0]), -1.0 if cls in LOCK_HEIGHT else float(c[2]), float(-c[1]))
        attribute = mesh.attributes.new('_ANCHOR', 'FLOAT_VECTOR', 'POINT')
        attribute.data.foreach_set('vector', np.tile(np.array(anchor, dtype=np.float32), len(mesh.vertices)))
    hex_color = '#%02x%02x%02x' % tuple(int(v) for v in r['color'].split('_'))
    name = f'{cls}:{hex_color}'
    material = materials.get(name) or materials.setdefault(name, bpy.data.materials.new(name))
    mesh.materials.clear()
    mesh.materials.append(material)

by_class = defaultdict(list)
for r in records:
    by_class[r['cls']].append(r)
summary = {}
for cls, rows in by_class.items():
    bpy.ops.object.select_all(action='DESELECT')
    for r in rows:
        r['obj'].select_set(True)
    bpy.context.view_layer.objects.active = rows[0]['obj']
    if len(rows) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = obj.data.name = cls
    obj.data.shade_smooth()
    obj.data.set_sharp_from_angle(angle=math.radians(32))
    summary[cls] = {'parts': len(rows), 'tris': sum(len(p.vertices) - 2 for p in obj.data.polygons),
                    'min': np.min([r['bmin'] for r in rows], axis=0).round(4).tolist(),
                    'max': np.max([r['bmax'] for r in rows], axis=0).round(4).tolist()}

os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', export_yup=True, export_apply=False, export_normals=True,
                          export_texcoords=False, export_tangents=False, export_attributes=True, export_materials='EXPORT',
                          export_cameras=False, export_lights=False, export_extras=False)
total = sum(v['tris'] for v in summary.values())
json.dump({'source': os.path.basename(SRC), 'sourceTriangles': source_tris, 'triangles': total, 'classes': summary,
           'groups': {k: {'min': v[0].round(4).tolist(), 'max': v[1].round(4).tolist()} for k, v in group_box.items()}},
          open(OUT_MANIFEST, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('AGV1 DONE tris', total, 'of', source_tris, 'glb MB', round(os.path.getsize(OUT_GLB) / 1e6, 2), flush=True)
print('AGV1 classes', {k: v['tris'] for k, v in summary.items()}, flush=True)
