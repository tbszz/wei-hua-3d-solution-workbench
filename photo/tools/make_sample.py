"""Render a synthetic factory-floor photo with a known camera, for demos and end-to-end checks.

The photo is programme-generated (demo_data), not a customer site. A yellow painted bay of 6 m x 4 m lies on
the floor; the JSON next to the image gives the true camera and the pixel positions of the bay corners
(line centres), so a calibration from the page can be compared with the truth.

    python photo/tools/make_sample.py

Writes data/photo/sample-floor.jpg and data/photo/sample-floor.json. Needs numpy and Pillow.
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
TEXTURE = ROOT / 'data/scene/textures/painted_concrete_diff_1k.jpg'
OUT = ROOT / 'data/photo'

W, H, SS = 2400, 1800, 2
FOV = 55.0
EYE = np.array([-1.8, 2.3, 7.5])
TARGET = np.array([2.0, 0.0, -1.5])
BAY = {'origin': (-0.8, 1.6), 'ab': 6.0, 'bc': 4.0}  # A at (x, z); AB along +x, BC along -z
LINE = 0.12  # painted line width, m
TILE = 2.4  # metres covered by one copy of the concrete texture
HALL = {'left': -9.0, 'right': 13.0, 'back': -22.0, 'ceiling': 9.0}
COLUMNS = [(x, z) for x in (-6.0, 2.0, 10.0) for z in (-14.0, -6.0)] + [(10.0, 2.0)]
COLUMN_HALF = 0.3
LIGHTS = [(x, z) for x in (-4.0, 4.0) for z in (-16.0, -8.0, 0.0)]


def basis():
    forward = TARGET - EYE
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return right, up, forward


RIGHT, UP, FORWARD = basis()
FOCAL = (H / 2) / math.tan(math.radians(FOV / 2))


def project(point):
    d = np.asarray(point, float) - EYE
    z = d @ FORWARD
    return [W / 2 + FOCAL * (d @ RIGHT) / z, H / 2 - FOCAL * (d @ UP) / z]


def bay_corners():
    x0, z0 = BAY['origin']
    return [(x0, z0), (x0 + BAY['ab'], z0), (x0 + BAY['ab'], z0 - BAY['bc']), (x0, z0 - BAY['bc'])]


def paint_mask(x, z):
    """1 where the floor carries yellow paint: bay outline plus an aisle line."""
    (ax, az), _, (cx, cz), _ = bay_corners()
    half = LINE / 2
    inside_x = (x > ax - half) & (x < cx + half)
    inside_z = (z < az + half) & (z > cz - half)
    near_x = (np.abs(x - ax) < half) | (np.abs(x - cx) < half)
    near_z = (np.abs(z - az) < half) | (np.abs(z - cz) < half)
    bay = (near_x & inside_z) | (near_z & inside_x)
    aisle = (np.abs(x - 8.0) < half) | (np.abs(x + 3.2) < half)
    return bay | (aisle & (z < 6))


def render_rows(v0, v1, texture):
    us = (np.arange(W * SS) + 0.5) / SS
    vs = (np.arange(v0 * SS, v1 * SS) + 0.5) / SS
    u, v = np.meshgrid(us, vs)
    dirs = (RIGHT[None, None] * ((u - W / 2) / FOCAL)[..., None]
            - UP[None, None] * ((v - H / 2) / FOCAL)[..., None]
            + FORWARD[None, None])
    dirs /= np.linalg.norm(dirs, axis=-1, keepdims=True)
    dx, dy, dz = dirs[..., 0], dirs[..., 1], dirs[..., 2]
    big = np.full(dx.shape, np.inf)

    def plane(axis_d, origin, value):
        with np.errstate(divide='ignore', invalid='ignore'):
            t = (value - origin) / axis_d
        return np.where(t > 1e-6, t, np.inf)

    hits = {
        'floor': plane(dy, EYE[1], 0.0),
        'ceiling': plane(dy, EYE[1], HALL['ceiling']),
        'back': plane(dz, EYE[2], HALL['back']),
        'left': plane(dx, EYE[0], HALL['left']),
        'right': plane(dx, EYE[0], HALL['right']),
    }
    column_t = big.copy()
    column_face = np.zeros(dx.shape, np.int8)
    for cx, cz in COLUMNS:
        lo = np.array([cx - COLUMN_HALF, 0.0, cz - COLUMN_HALF])
        hi = np.array([cx + COLUMN_HALF, HALL['ceiling'], cz + COLUMN_HALF])
        with np.errstate(divide='ignore', invalid='ignore'):
            t1 = (lo - EYE) / dirs
            t2 = (hi - EYE) / dirs
        tmin = np.minimum(t1, t2)
        tnear = tmin.max(axis=-1)
        tfar = np.maximum(t1, t2).min(axis=-1)
        hit = (tnear <= tfar) & (tnear > 0) & (tnear < column_t)
        column_t = np.where(hit, tnear, column_t)
        column_face = np.where(hit, tmin.argmax(axis=-1) + 1, column_face)
    hits['column'] = column_t

    names = list(hits)
    stack = np.stack([hits[n] for n in names])
    which = stack.argmin(axis=0)
    t = stack.min(axis=0)
    p = EYE[None, None] + dirs * t[..., None]
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    rgb = np.zeros(dx.shape + (3,))

    # Floor: concrete texture, paint, light pools, darkening near walls and column feet.
    floor = which == names.index('floor')
    th, tw = texture.shape[:2]
    tx = ((x / TILE) % 1.0 * tw).astype(int) % tw
    ty = ((z / TILE) % 1.0 * th).astype(int) % th
    base = texture[ty, tx] * np.array([0.92, 0.94, 0.95])
    yellow = np.array([0.86, 0.66, 0.08])
    base = np.where(paint_mask(x, z)[..., None], yellow * (0.75 + 0.25 * texture[ty, tx].mean(-1, keepdims=True)), base)
    light = 0.62 + sum(0.32 * np.exp(-((x - lx) ** 2 + (z - lz) ** 2) / 30.0) for lx, lz in LIGHTS)
    wall_gap = np.minimum.reduce([x - HALL['left'], HALL['right'] - x, z - HALL['back']])
    column_gap = np.min([np.maximum(np.abs(x - cx), np.abs(z - cz)) - COLUMN_HALF for cx, cz in COLUMNS], axis=0)
    occlusion = (1 - 0.35 * np.exp(-np.maximum(wall_gap, 0) / 0.5)) * (1 - 0.45 * np.exp(-np.maximum(column_gap, 0) / 0.25))
    rgb = np.where(floor[..., None], base * (light * occlusion)[..., None], rgb)

    # Walls: dark dado, light ribbed cladding above, a window band.
    for name in ('back', 'left', 'right'):
        mask = which == names.index(name)
        along = x if name == 'back' else z
        rib = 0.9 + 0.1 * (np.abs(((along / 0.9) % 1.0) - 0.5) < 0.08)
        wall = np.where((y < 1.4)[..., None], np.array([0.33, 0.42, 0.40]), np.array([0.80, 0.82, 0.83]) * rib[..., None])
        window = (y > 5.6) & (y < 6.8)
        wall = np.where(window[..., None], np.array([0.86, 0.90, 0.95]), wall)
        shade = {'back': 0.92, 'left': 0.78, 'right': 0.70}[name]
        rgb = np.where(mask[..., None], wall * shade, rgb)

    ceiling = which == names.index('ceiling')
    strip = sum(np.exp(-((x - lx) ** 2) / 0.08 - ((z - lz) ** 2) / 2.0) for lx, lz in LIGHTS)
    rgb = np.where(ceiling[..., None], np.array([0.28, 0.29, 0.31]) + np.clip(strip, 0, 1)[..., None] * 0.7, rgb)

    # Columns: painted steel, hazard band at the foot, shaded by face.
    column = which == names.index('column')
    face_shade = np.choose(np.clip(column_face, 0, 3), [1.0, 0.72, 1.0, 0.9])
    paint = np.array([0.55, 0.60, 0.66])
    band = (y < 1.0) & ((((y + x + z) / 0.25) % 2) < 1)
    colour = np.where(band[..., None], np.array([0.85, 0.66, 0.06]), paint)
    colour = np.where(((y < 1.0) & ~band)[..., None], np.array([0.08, 0.08, 0.08]), colour)
    rgb = np.where(column[..., None], colour * face_shade[..., None], rgb)

    # Haze with distance.
    haze = 1 - np.exp(-t / 55.0)
    rgb = rgb * (1 - haze[..., None] * 0.5) + np.array([0.78, 0.80, 0.82]) * haze[..., None] * 0.5
    rgb = rgb.reshape(v1 - v0, SS, W, SS, 3).mean(axis=(1, 3))
    return rgb


def main():
    texture = np.asarray(Image.open(TEXTURE).convert('RGB'), float) / 255.0
    rows = [render_rows(v, min(v + 150, H), texture) for v in range(0, H, 150)]
    rgb = np.concatenate(rows)
    yy, xx = np.mgrid[0:H, 0:W]
    r = np.hypot((xx - W / 2) / (W / 2), (yy - H / 2) / (H / 2))
    rgb *= (1 - 0.18 * r ** 2)[..., None]
    rgb += np.random.default_rng(3).normal(0, 0.012, rgb.shape)
    image = Image.fromarray((np.clip(rgb, 0, 1) ** (1 / 1.1) * 255).astype(np.uint8))
    image = image.filter(ImageFilter.GaussianBlur(0.4))

    corners = [(x, 0.0, z) for x, z in bay_corners()]
    pixels = [project(c) for c in corners]
    for u, v in pixels:
        assert 40 < u < W - 40 and 40 < v < H - 40, (u, v)

    OUT.mkdir(parents=True, exist_ok=True)
    image.save(OUT / 'sample-floor.jpg', quality=88)
    meta = {
        'note': '程序生成的示意照片（demo_data），不是客户现场。黄线中心围成 6 m x 4 m 的矩形，A 近左、B 近右、C 远右、D 远左。',
        'generator': 'photo/tools/make_sample.py',
        'imageSize': {'width': W, 'height': H},
        'camera': {'position': EYE.tolist(), 'target': TARGET.tolist(), 'fovDeg': FOV, 'focalPx': FOCAL},
        'rectangle': {
            'ab': BAY['ab'],
            'bc': BAY['bc'],
            'corners': [list(c) for c in corners],
            'pixels': [[round(u, 2), round(v, 2)] for u, v in pixels],
        },
    }
    (OUT / 'sample-floor.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('corners px', [[round(u), round(v)] for u, v in pixels])


if __name__ == '__main__':
    main()
