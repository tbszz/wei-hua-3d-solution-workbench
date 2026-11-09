"""Convert Z1-1000-BZ.fbx into a web GLB ready for parametric stretching.

Run headless:
  blender -b --factory-startup --python preprocess_z1.py -- <fbx> <config.json> <out.glb> <out.manifest.json>

Body meshes (skirt, deck, frame, plate) stretch per vertex and carry no extra data.
Every other mesh is rigid: each vertex stores _ANCHOR, in glTF axes (x=length, y=height, z=width),
and moves by the stretch offset of that anchor, so the part keeps its exact size.
"""
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, CONFIG, OUT_GLB, OUT_MANIFEST = argv[:4]
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:6.1f}s]', *a, flush=True)


CENTER_Y = 19.534
GROUND_Z = -0.0475

SKIRT = {544, 708, 709, 710, 719, 720, 545, 683, 684, 685}
DECK = {352, 357, 360, 563, 564, 541, 721}
FRAME = {1, 3, 542, 718, 543, 560}
BODY_MATERIAL = {f'物件_{n}': 'skirt' for n in SKIRT}
BODY_MATERIAL.update({f'物件_{n}': 'deck' for n in DECK})
BODY_MATERIAL.update({f'物件_{n}': 'frame' for n in FRAME})

# Triangle budget by largest dimension (m). Body parts are only planar-dissolved.
BUDGET = [(0.02, 40), (0.06, 140), (0.2, 700), (1.0, 4000), (math.inf, 12000)]
STANDARD = {'hmi', 'estop', 'laser', 'charging'}
ZLOCK = {'drive', 'wheel', 'charging'}


def budget_for(max_dim, cls):
    n = next(b for limit, b in BUDGET if max_dim < limit)
    if cls in STANDARD:
        return n * 4
    return n // 3 if cls == 'drive' else n  # drive units are only visible from below


def classify(name, c, size, zmax):
    """c and zmax use ground-based z; returns (material class, rigid group or None)."""
    x, y, z = c
    ax, ay = abs(x), abs(y)
    if name in BODY_MATERIAL:
        return BODY_MATERIAL[name], None
    # Plates and rails seated in deck openings must widen with the opening, or gaps appear.
    if name.startswith('M12') or name == '物件_353' or (size[1] > 1.0 and size[0] < 0.02 and z > 0.44):
        return 'plate', None
    if 'G_ST70' in name or '6AV2' in name or (-0.52 < x < -0.22 and 0.82 < y < 1.0 and 0.2375 < z < 0.4375):
        return 'hmi', 'hmi'
    # Red buttons with a yellow ring at the four frame corners.
    if abs(ax - 2.121) < 0.03 and 0.90 < ay < 0.975 and 0.36 < z < 0.44:
        return 'estop', f'estop{"+" if x > 0 else "-"}{"+" if y > 0 else "-"}'
    # Laser navigation units: red top, blue base, mid-side and on both ends.
    if ax < 0.06 and 0.90 < ay < 1.0 and 0.2875 < z < 0.4075:
        return 'laser', f'laser_side{"+" if y > 0 else "-"}'
    if 2.2 < ax < 2.45 and ay < 0.1 and 0.28 < z < 0.42:
        return 'laser', f'laser_end{"+" if x > 0 else "-"}'
    if x < -2.46 and ay < 0.13 and z < 0.2075:
        return 'charging', 'charging'
    if min(size) < 0.003:
        # The logo spans the height band, so its pieces must share one anchor to stay together.
        if ay > 0.99 and 1.25 < ax < 1.65 and 0.14 < z < 0.24:
            return 'decal', f'logo{"+" if y > 0 else "-"}'
        return 'decal', ('side_label' if -1.0 < x < -0.85 and ay > 0.9 else None)
    if -1.0 < x < -0.85 and ay > 0.9:
        return 'misc', 'side_label'
    if ax > 1.85 and 0.5 <= ay <= 1.0 and zmax < 0.2875:
        group = f'drive{"+" if x > 0 else "-"}{"+" if y > 0 else "-"}'
        is_wheel = abs(size[0] - 0.23) < 0.01 and abs(size[2] - 0.23) < 0.01 and size[1] < 0.09
        return ('wheel' if is_wheel else 'drive'), group
    return 'misc', None


def is_exterior(bmin, bmax):
    return bmax[2] > 0.4875 or max(abs(bmin[0]), abs(bmax[0])) > 2.42 or max(abs(bmin[1]), abs(bmax[1])) > 0.92


# Neither the FBX nor the STP stores colour, so parts are painted by name and position.
# Paint names are defined in demo/src/main.js. Every material is named "<class>:<paint>".
DEFAULT_PAINT = {'skirt': 'silver', 'deck': 'deck', 'frame': 'frame', 'plate': 'window', 'decal': 'ink',
                 'wheel': 'wheel', 'drive': 'drive', 'misc': 'misc', 'hmi': 'hmi_key', 'estop': 'ink',
                 'laser': 'ink', 'charging': 'charging'}
NAMED_PAINT = {'物件_542': 'silver', '物件_718': 'silver', '物件_543': 'shelf', '物件_560': 'shelf',
               '物件_3': 'shelf', '物件_353': 'deck', '物件_711': 'yellow'}
NAMED_PAINT.update({f'物件_{n}': 'label' for n in range(648, 656)})  # the 10t badges
DECK_PANELS = {f'物件_{n}' for n in (352, 357, 360, 563, 564)}
BUMPERS = {'物件_541', '物件_721'}


def near(size, *target, tol=0.012):
    return all(abs(float(s) - t) < tol for s, t in zip(size, target))


def is_corner_window(r, ax, ay):
    return ax > 2.3 and ay > 0.85 and near(r['size'], 0.174, 0.173, 0.175)


def part_paint(r):
    name, cls, size = r['name'], r['cls'], r['size']
    x, y, z = (r['bmin'] + r['bmax']) / 2
    ax, ay = abs(x), abs(y)
    if name in NAMED_PAINT:
        return NAMED_PAINT[name]
    if cls == 'decal':
        if name in RED_GLYPHS or (abs(ay - 1.0) < 0.005 and 1.25 < ax < 1.65 and 0.14 < z < 0.24):
            return 'red'
        if z > 0.49 and max(size) >= 0.03:
            return 'brass'
        if near(size, 0.002, 0.72, 0.05) and ax > 2.4:
            return 'green'
    if cls == 'estop':
        if min(size) < 0.003 and max(size) > 0.05:
            return 'estop_ring'
        return 'estop_red' if near(size, 0.042, 0.058, 0.034) or near(size, 0.058, 0.042, 0.034) else 'ink'
    if cls == 'laser' and 0.055 < max(size[:2]) < 0.13 and size[2] > 0.003:
        if z < 0.34 and size[2] > 0.03:
            return 'laser_blue'
        if size[2] < 0.09:
            return 'laser_red'
    if ax > 2.3 and ay > 0.85 and near(size, 0.09, 0.1, 0.041):
        return 'green'
    if cls == 'hmi' and 'G_ST70' in name and max(size) > 0.2:
        return 'hmi_panel'
    return DEFAULT_PAINT[cls]


def face_paints(r, me):
    """One paint per polygon. Only a few parts carry more than one colour."""
    name = r['name']
    x, y, _ = (r['bmin'] + r['bmax']) / 2
    if name in DECK_PANELS:
        return ['deck' if p.normal.z > 0.7 else 'edge' for p in me.polygons]
    if name in BUMPERS:
        return ['edge' if abs(p.normal.z) < 0.5 and abs(p.normal.y) > 0.3 else 'bumper' for p in me.polygons]
    if is_corner_window(r, abs(x), abs(y)):
        out_x, out_y = math.copysign(math.sqrt(0.5), x), math.copysign(math.sqrt(0.5), y)
        reach = [p.center.x * out_x + p.center.y * out_y for p in me.polygons]
        front = max(reach) - 0.012
        return ['window_rim' if p.normal.x * out_x + p.normal.y * out_y > 0.5 and d > front else 'window_dark'
                for p, d in zip(me.polygons, reach)]
    paint = part_paint(r)
    if paint == 'hmi_panel':
        return ['hmi_screen' if p.normal.y > 0.7 and abs(p.center.x + 0.373) < 0.051 and 0.3125 < p.center.z < 0.4055
                else 'hmi_panel' for p in me.polygons]
    return [paint] * len(me.polygons)


cfg = json.load(open(CONFIG, encoding='utf-8'))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=SRC, use_image_search=False, ignore_leaf_bones=True)
log('imported', len(bpy.data.objects))

for o in [o for o in bpy.data.objects if o.type != 'MESH']:
    for child in o.children:
        world = child.matrix_world.copy()
        child.parent = None
        child.matrix_world = world
bpy.context.view_layer.update()

SHIFT = Matrix.Translation((0, -CENTER_Y, -GROUND_Z))
source_tris = 0
scale_fixed = 0
records = []
for o in [o for o in bpy.data.objects if o.type == 'MESH']:
    M = o.matrix_world.copy()
    if abs(M.to_scale()[0] - 1.0) < 1e-4:
        M = Matrix.Scale(0.001, 4) @ M
        scale_fixed += 1
    me = o.data
    me.transform(SHIFT @ M)
    if M.to_3x3().determinant() < 0:
        me.flip_normals()
    o.matrix_world = Matrix.Identity(4)
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    bmin, bmax = co.min(0), co.max(0)
    size = bmax - bmin
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    source_tris += tris
    cls, group = classify(o.name, (bmin + bmax) / 2, size, bmax[2])
    records.append({'o': o, 'name': o.name, 'bmin': bmin, 'bmax': bmax, 'size': size, 'tris': tris, 'cls': cls, 'group': group})
log('baked', len(records), 'tris', source_tris, 'scale fixed', scale_fixed)
for o in [o for o in bpy.data.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)

# The source model prints Z1-10000/BZ on four faces; the product is Z1-1000-BZ.
# Each run lists its glyph parts in reading order: Z 1 - 1 0 0 0 0 / B Z.
TEXT_RUNS = [
    (0, [577, 578, 579, 580, 581, 582, 583, 584, 576, 586, 585]),
    (0, [599, 600, 601, 602, 603, 604, 605, 606, 598, 608, 607]),
    (1, [574, 573, 572, 571, 570, 569, 568, 567, 575, 565, 566]),
    (1, [596, 595, 594, 593, 592, 591, 590, 589, 597, 587, 588]),
]
HYPHEN, LAST_ZEROS, SLASH = 2, (6, 7), 8
RED_GLYPHS = {f'物件_{numbers[i]}' for _, numbers in TEXT_RUNS for i in (9, 10)}  # the "BZ"


def shift_part(r, axis, delta):
    offset = [0.0, 0.0, 0.0]
    offset[axis] = delta
    r['o'].data.transform(Matrix.Translation(offset))
    r['bmin'][axis] += delta
    r['bmax'][axis] += delta


def correct_model_text(records):
    """Remove the extra zero, close the gap around it and turn the slash into a hyphen."""
    by_name = {r['name']: r for r in records}
    removed = set()
    for axis, numbers in TEXT_RUNS:
        run = [by_name[f'物件_{n}'] for n in numbers]
        centre = [float(r['bmin'][axis] + r['bmax'][axis]) / 2 for r in run]
        pitch = centre[LAST_ZEROS[1]] - centre[LAST_ZEROS[0]]

        hyphen, slash = run[HYPHEN], run[SLASH]
        old_mesh = slash['o'].data
        slash['o'].data = hyphen['o'].data.copy()
        bpy.data.meshes.remove(old_mesh)
        slash.update(bmin=hyphen['bmin'].copy(), bmax=hyphen['bmax'].copy(), size=hyphen['size'].copy(), tris=hyphen['tris'])
        shift_part(slash, axis, centre[SLASH] - centre[HYPHEN])

        extra_zero = run[LAST_ZEROS[1]]
        bpy.data.objects.remove(extra_zero['o'])
        removed.add(extra_zero['name'])
        for i, r in enumerate(run):
            if i != LAST_ZEROS[1]:
                shift_part(r, axis, pitch / 2 if i < LAST_ZEROS[1] else -pitch / 2)
    return [r for r in records if r['name'] not in removed]


records = correct_model_text(records)
log('corrected model text on', len(TEXT_RUNS), 'faces')

dropped = 0
kept = []
for r in records:
    if max(r['size']) < 0.02 and r['cls'] not in STANDARD and not is_exterior(r['bmin'], r['bmax']):
        bpy.data.objects.remove(r['o'])
        dropped += 1
    else:
        kept.append(r)
records = kept
log('dropped hidden small parts', dropped)

# Flat, exact surfaces lose their 5 mm edge tessellation without changing shape.
DISSOLVE = {'skirt', 'deck', 'frame', 'plate', 'decal', 'hmi', 'charging'}
for r in records:
    if r['cls'] not in DISSOLVE or r['tris'] < 200:
        continue
    me = r['o'].data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), use_dissolve_boundaries=False, verts=bm.verts, edges=bm.edges)
    bm.to_mesh(me)
    bm.free()
    r['tris'] = sum(len(p.vertices) - 2 for p in me.polygons)
log('dissolved tris now', sum(r['tris'] for r in records))

BODY_CLASSES = {'skirt', 'deck', 'frame', 'plate'}
to_decimate = []
for r in records:
    if r['cls'] in BODY_CLASSES:
        continue
    target = budget_for(float(max(r['size'])), r['cls'])
    if r['tris'] > target:
        m = r['o'].modifiers.new('d', 'DECIMATE')
        m.ratio = max(target / r['tris'], 0.002)
        to_decimate.append(r)
log('decimating', len(to_decimate))
dg = bpy.context.evaluated_depsgraph_get()
swaps = [(r, bpy.data.meshes.new_from_object(r['o'].evaluated_get(dg))) for r in to_decimate]
for r, new_mesh in swaps:
    old = r['o'].data
    r['o'].modifiers.clear()
    r['o'].data = new_mesh
    bpy.data.meshes.remove(old)
log('decimated')

group_box = {}
for r in records:
    g = r['group']
    if g:
        a, b = group_box.get(g, (r['bmin'], r['bmax']))
        group_box[g] = (np.minimum(a, r['bmin']), np.maximum(b, r['bmax']))

materials = {}
paint_tris = Counter()
for r in records:
    me = r['o'].data
    if 'custom_normal' in me.attributes:
        me.attributes.remove(me.attributes['custom_normal'])
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)
    cls = r['cls']
    a, b = group_box[r['group']] if r['group'] else (r['bmin'], r['bmax'])
    c = (a + b) / 2
    anchor_h = -1.0 if cls in ZLOCK else float(c[2])
    # Blender (x, y, z) -> glTF (x, z, -y). The exporter does not convert custom attributes.
    if cls not in BODY_CLASSES:
        anchor = (float(c[0]), anchor_h, float(-c[1]))
        aa = me.attributes.new('_ANCHOR', 'FLOAT_VECTOR', 'POINT')
        aa.data.foreach_set('vector', np.tile(np.array(anchor, dtype=np.float32), len(me.vertices)))
    paints = face_paints(r, me)
    used = sorted(set(paints))
    me.materials.clear()
    for paint in used:
        mat = materials.get((cls, paint))
        if mat is None:
            mat = materials[(cls, paint)] = bpy.data.materials.new(f'{cls}:{paint}')
        me.materials.append(mat)
    slot = {paint: i for i, paint in enumerate(used)}
    me.polygons.foreach_set('material_index', [slot[paint] for paint in paints])
    me.update()
    for paint, count in Counter(paints).items():
        paint_tris[paint] += count

log('paint polygons', dict(sorted(paint_tris.items())))

by_class = defaultdict(list)
for r in records:
    by_class[r['cls']].append(r)
summary = {}
for cls, rs in by_class.items():
    bpy.ops.object.select_all(action='DESELECT')
    for r in rs:
        # Some FBX parts import unselectable, which makes the join operator cancel.
        r['o'].hide_set(False)
        r['o'].hide_viewport = False
        r['o'].hide_select = False
        r['o'].select_set(True)
    bpy.context.view_layer.objects.active = rs[0]['o']
    if len(rs) > 1:
        before = sum(len(r['o'].data.polygons) for r in rs)
        result = bpy.ops.object.join()
        after = len(bpy.context.view_layer.objects.active.data.polygons)
        if after < before:
            raise RuntimeError(f'join failed for {cls}: {result}, {after} of {before} polygons, first={rs[0]["name"]!r}')
    o = bpy.context.view_layer.objects.active
    o.name = cls
    o.data.name = cls
    o.data.shade_smooth()
    o.data.set_sharp_from_angle(angle=math.radians(32))
    mins = np.min([r['bmin'] for r in rs], axis=0)
    maxs = np.max([r['bmax'] for r in rs], axis=0)
    summary[cls] = {'parts': len(rs), 'tris': sum(len(p.vertices) - 2 for p in o.data.polygons),
                    'min': mins.round(4).tolist(), 'max': maxs.round(4).tolist()}
    log('joined', cls, summary[cls]['parts'], summary[cls]['tris'])

os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', export_yup=True, export_apply=False,
                          export_normals=True, export_texcoords=False, export_tangents=False,
                          export_attributes=True, export_materials='EXPORT', export_cameras=False,
                          export_lights=False, export_extras=False)
total = sum(v['tris'] for v in summary.values())
json.dump({'source': os.path.basename(SRC), 'sourceTriangles': source_tris, 'triangles': total,
           'scaleFixedParts': scale_fixed, 'droppedHiddenParts': dropped, 'classes': summary,
           'groups': {k: {'min': v[0].round(4).tolist(), 'max': v[1].round(4).tolist()} for k, v in group_box.items()}},
          open(OUT_MANIFEST, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
log('DONE tris', total, 'glb MB', round(os.path.getsize(OUT_GLB) / 1e6, 1))
