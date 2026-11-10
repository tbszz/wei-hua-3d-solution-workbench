"""Bake the factory textures in data/scene/textures/factory_*.

The look follows the site photos of the real plant (2026-11-10): polished grey concrete with
cloudy patches and saw-cut joints, a cream masonry dado under off-white ribbed steel cladding,
bright window bands, a steel roof deck with skylight strips and plywood crates.
Everything is generated (no photo pixels), tiles seamlessly and is deterministic.

    python src/scene/make_factory_textures.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "data" / "scene" / "textures"
rng = np.random.default_rng(20261110)


def noise(h, w, scale, aniso=(1.0, 1.0)):
    """Periodic smooth noise in [0, 1]: white noise low-passed in the frequency domain."""
    white = rng.standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None] * h / aniso[0]
    fx = np.fft.fftfreq(w)[None, :] * w / aniso[1]
    k = np.exp(-(fx**2 + fy**2) * (scale**2) / 2)
    field = np.real(np.fft.ifft2(np.fft.fft2(white) * k))
    field -= field.min()
    return field / max(field.max(), 1e-9)


def fbm(h, w, scales, weights, aniso=(1.0, 1.0)):
    total = sum(weights)
    return sum(noise(h, w, s, aniso) * wt for s, wt in zip(scales, weights)) / total


def save(name, rgb, quality=88):
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    mode = "L" if rgb.ndim == 2 else "RGB"
    Image.fromarray(rgb, mode).save(OUT / name, quality=quality, optimize=True)
    print(f"{name:32s} {rgb.shape[1]}x{rgb.shape[0]}  {(OUT / name).stat().st_size // 1024} KB")


def tint(grey, color):
    return grey[..., None] * np.array(color, dtype=np.float32)[None, None, :] / 255.0


def floor():
    """6 m x 6 m polished concrete, joints on the tile edges."""
    n = 1024
    clouds = fbm(n, n, [0.35, 0.15, 0.06], [1.0, 0.6, 0.3])  # metre-scale cloudy patches
    blotch = fbm(n, n, [0.03, 0.012], [1.0, 0.6])
    speck = rng.random((n, n))
    swirl = fbm(n, n, [0.15], [1.0], aniso=(3.0, 1.0))  # trowel drag, a little directional
    tone = 0.5 + (clouds - 0.5) * 0.85 + (blotch - 0.5) * 0.35 + (swirl - 0.5) * 0.18
    tone += (speck - 0.5) * 0.05
    dark = np.clip((0.38 - clouds) * 2.5, 0, 1)  # the darker damp-looking areas in the photos
    value = 176 + (tone - 0.5) * 46 - dark * 14
    joint = np.zeros((n, n))
    for edge in (0, n - 1):
        joint[edge, :] = joint[:, edge] = 1
    joint[1, :] = joint[:, 1] = 0.5
    joint[n - 2, :] = joint[:, n - 2] = 0.5
    value = value * (1 - joint * 0.55)
    rgb = np.stack([value * 0.985, value * 1.0, value * 1.02], -1)
    save("factory_floor_diff.jpg", rgb)
    # Polished: glossy overall, the dark patches glossier still, joints rough.
    rough = 0.24 + (blotch - 0.5) * 0.16 + (clouds - 0.5) * 0.1 - dark * 0.06
    rough = np.clip(rough + joint * 0.6, 0.08, 1)
    save("factory_floor_rough.jpg", rough * 255)


def wall():
    """4 m wide x 12 m tall: dado 0-1.2 m, flashing, ribbed cladding, eave shadow."""
    w, h = 512, 1536
    px = h / 12.0
    y = (h - 1 - np.arange(h))[:, None] / px  # metres from the floor
    x = np.arange(w)[None, :] / px  # metres along the wall
    grime = fbm(h, w, [0.08, 0.025], [1.0, 0.7])
    streak = fbm(h, w, [0.03], [1.0], aniso=(0.12, 1.0))  # vertical rain-like streaks
    rib_period = 0.25
    phase = (x % rib_period) / rib_period
    # Trapezoid profile: flat pan, slope, crown, slope.
    profile = np.interp(phase, [0, 0.55, 0.66, 0.89, 1.0], [0, 0, 1, 1, 0])
    slope = np.gradient(np.broadcast_to(profile, (h, w)), axis=1)
    clad = 218 + slope * 260 + (grime - 0.5) * 14 - np.clip(streak - 0.62, 0, 1) * 30
    clad = np.broadcast_to(clad, (h, w)).copy()
    dado = 214 + (grime - 0.5) * 24 + (rng.random((h, w)) - 0.5) * 8
    # Block joints every 0.2 m on the dado.
    dado -= ((y % 0.2) < 0.012) * 18
    value = np.where(y < 1.2, dado, clad)
    value = np.where((y >= 1.2) & (y < 1.27), 196, value)  # steel flashing
    value = np.where((y >= 1.27) & (y < 1.31), 150, value)  # its shadow line
    value -= np.clip((0.18 - y) / 0.18, 0, 1) * 42  # floor-level dirt
    value -= np.clip((y - 10.6) / 1.4, 0, 1) * 34  # under the eave
    cream = np.array([1.0, 0.975, 0.915])
    warm = np.array([1.0, 0.99, 0.965])
    color = np.where((y < 1.2)[..., None], cream, warm)
    save("factory_wall_diff.jpg", value[..., None] * color)
    # Normal map from the rib profile (OpenGL convention, +Y up).
    nx = -np.where(y >= 1.31, slope * 9, 0)
    ny = np.zeros_like(nx)
    nz = np.ones_like(nx)
    length = np.sqrt(nx**2 + ny**2 + nz**2)
    normal = np.stack([nx / length, ny / length, nz / length], -1)
    save("factory_wall_nor.jpg", (normal * 0.5 + 0.5) * 255, quality=92)


def window():
    """One 1.5 m x 1.5 m pane: aluminium frame, bright daylight glass with soft reflections."""
    n = 256
    v, u = np.mgrid[0:n, 0:n] / n
    sky = 236 - v * 22  # brighter at the top, like overexposed daylight
    haze = fbm(n, n, [0.1], [1.0])
    glare = np.clip(1 - np.abs((u + v * 0.7) % 1.0 - 0.45) * 7, 0, 1) * 10
    glass = sky + (haze - 0.5) * 10 + glare
    rgb = np.stack([glass * 0.93, glass * 0.97, glass * 1.0], -1)
    frame = (np.minimum.reduce([u, 1 - u, v, 1 - v]) < 0.035) | (np.abs(v - 0.5) < 0.012)
    rgb[frame] = [214, 218, 220]
    shade = (np.minimum.reduce([u, 1 - u, v, 1 - v]) < 0.05) & ~frame
    rgb[shade] *= 0.9
    save("factory_window.jpg", rgb)


def louvre():
    """3 m x 3 m horizontal louvre / sandwich panel, light grey."""
    n = 512
    v = np.arange(n)[:, None] / n * 3.0
    period = 0.1
    phase = (v % period) / period
    shade = np.interp(phase, [0, 0.1, 0.75, 0.85, 1.0], [150, 214, 200, 170, 150])
    grime = fbm(n, n, [0.06], [1.0])
    value = np.broadcast_to(shade, (n, n)) + (grime - 0.5) * 12
    save("factory_louvre.jpg", value[..., None] * np.array([0.98, 1.0, 1.02]))


def roof():
    """8 m x 8 m roof deck seen from inside: ribbed steel, one skylight strip."""
    n = 1024
    px = n / 8.0
    yy, xx = np.mgrid[0:n, 0:n] / px
    rib = np.interp((xx % 0.25) / 0.25, [0, 0.5, 0.6, 0.9, 1.0], [0, 0, 1, 1, 0])
    value = 196 + np.gradient(rib, axis=1) * 180
    value += (fbm(n, n, [0.05], [1.0]) - 0.5) * 12
    # Purlins every 2 m (darker lines across), skylight strip 1.6 m wide in the middle.
    value = np.where((yy % 2.0) < 0.12, 150, value)
    light = (np.abs(xx - 4.0) < 0.8) & (np.abs(yy - 4.0) < 3.0)
    skylight = 250 + (fbm(n, n, [0.1], [1.0]) - 0.5) * 8
    grid = ((yy % 1.0) < 0.04) | (np.abs(xx - 4.0) < 0.02)
    value = np.where(light, np.where(grid, 205, skylight), value)
    rgb = np.stack([value, value, value], -1)
    rgb[light] *= [0.96, 0.99, 1.0]
    save("factory_roof.jpg", rgb)


def plywood():
    """A plywood crate face: grain, battens round the edge, nail heads."""
    n = 512
    v, u = np.mgrid[0:n, 0:n] / n
    grain = fbm(n, n, [0.3, 0.12], [0.6, 1.0], aniso=(20.0, 1.0))
    knots = np.clip(fbm(n, n, [0.04], [1.0]) - 0.75, 0, 1) * 3
    base = np.array([214, 152, 112])  # the salmon-orange crates in the photos
    value = 0.86 + (grain - 0.5) * 0.35 - knots * 0.25
    rgb = value[..., None] * base
    edge = np.minimum.reduce([u, 1 - u, v, 1 - v])
    batten = edge < 0.09
    across = fbm(n, n, [0.3, 0.12], [0.6, 1.0], aniso=(1.0, 20.0))
    rgb[batten] = ((0.8 + (across[batten] - 0.5) * 0.3)[:, None] * np.array([200, 138, 98]))
    rgb[(edge >= 0.09) & (edge < 0.097)] *= 0.62  # shadow under the batten
    for cu in (0.045, 0.955):
        for cv in np.linspace(0.045, 0.955, 7):
            for a, b in ((cu, cv), (cv, cu)):
                nail = (u - a) ** 2 + (v - b) ** 2 < 0.006**2
                rgb[nail] = [80, 76, 72]
    save("factory_plywood.jpg", rgb)


def detail():
    """Shared surface detail for every lit model: R mottling, G fine wear, B streaks."""
    n = 512
    r = fbm(n, n, [0.2, 0.07, 0.025], [1.0, 0.8, 0.5])
    g = 0.5 + (rng.random((n, n)) - 0.5) * 0.5 + (fbm(n, n, [0.012], [1.0]) - 0.5) * 0.6
    b = fbm(n, n, [0.04], [1.0], aniso=(0.12, 1.0))
    rgb = np.stack([r, np.clip(g, 0, 1), b], -1) * 255
    save("factory_detail.jpg", rgb, quality=90)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    floor()
    wall()
    window()
    louvre()
    roof()
    plywood()
    detail()
