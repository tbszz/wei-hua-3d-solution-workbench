"""Process sheet: paint zones, surface markings and the coating specification table.

Drawn with matplotlib on an A3 landscape page in millimetres and saved as SVG and PDF (and PNG
for review). Text stays text in the SVG, so the sheet can be searched and checked. All views on
a sheet share one standard scale, printed in each view title.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.patches import Circle, Polygon, Rectangle  # noqa: E402

from geometry import AgvGeometry, Box, CraneGeometry  # noqa: E402
from plan import Plan, fmt  # noqa: E402

PAGE_W, PAGE_H = 420, 297
MM = 72 / 25.4  # points per millimetre
INK = '#222222'
RED = '#c00000'
PART = '#d8d8d8'  # bought-in parts, masked during painting
TITLE_SPACE = 9  # paper mm above each view for its title
SCALES = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 300, 400, 500]


def _font():
    names = {f.name for f in font_manager.fontManager.ttflist}
    for name in ('SimHei', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'WenQuanYi Zen Hei'):
        if name in names:
            return name
    return 'sans-serif'


plt.rcParams.update({
    'font.family': 'sans-serif', 'font.sans-serif': [_font(), 'DejaVu Sans'], 'axes.unicode_minus': False,
    'svg.fonttype': 'none', 'pdf.fonttype': 42, 'hatch.linewidth': 0.4,
})


@dataclass
class Marking:
    key: str
    label: str
    text: str
    face: str          # 'y-', 'y+', 'x-', 'x+' for AGV; 'front' for the crane girder face
    u0: float
    v0: float
    u1: float
    v1: float
    where: str         # human-readable position, tied to the parameters
    placed: str        # 'model' (from the 3D model) or 'rule' (placed by a rule, 示意)

    @property
    def center(self):
        return ((self.u0 + self.u1) / 2, (self.v0 + self.v1) / 2)


# --------------------------------------------------------------------------------------------
# AGV faces. Each face is shown as seen from outside: (u, v) with v = height.
def _face_uv(face: str, b: Box):
    """Rectangle of a box projected on a face, as (u0, v0, u1, v1)."""
    (x0, y0, z0), (x1, y1, z1) = b.lo, b.hi
    if face == 'y-':
        return x0, z0, x1, z1
    if face == 'y+':
        return -x1, z0, -x0, z1
    if face == 'x-':
        return -y1, z0, -y0, z1
    if face == 'x+':
        return y0, z0, y1, z1
    if face == 'top':
        return x0, y0, x1, y1
    raise ValueError(face)


def _face_of(g: AgvGeometry, b: Box) -> str | None:
    c = b.center
    d = {'y-': c[1] + g.W / 2, 'y+': g.W / 2 - c[1], 'x-': c[0] + g.L / 2, 'x+': g.L / 2 - c[0]}
    face = min(d, key=d.get)
    return face if d[face] < 120 else None


def _overlap(a, b, gap=0.0):
    return not (a[2] + gap <= b[0] or b[2] + gap <= a[0] or a[3] + gap <= b[1] or b[3] + gap <= a[1])


def _where(g: AgvGeometry, face: str, rect) -> str:
    cu, cv = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    if face in ('y-', 'y+'):
        x = cu if face == 'y-' else -cu
        side = '右侧面' if face == 'y-' else '左侧面'
        return f'{side}，中心距车头 {fmt(g.L / 2 - x)}，离地 {fmt(cv)}'
    end = '车尾端面' if face == 'x-' else '车头端面'
    off = f'偏中心 {fmt(abs(cu))}' if abs(cu) > 0.5 else '居中'
    return f'{end}，{off}，离地 {fmt(cv)}'


def _search(g: AgvGeometry, face: str, size, taken):
    """First free spot on a face for a marking of the given size, scanning from the face centre."""
    w, h = size
    zb, ztop = g.body.lo[2], g.classes['frame'].hi[2]
    half = (g.L if face in ('y-', 'y+') else g.W) / 2
    obstacles = [_face_uv(face, b) for k, b in g.groups.items() if _face_of(g, b) == face]
    obstacles += [m for f, m in taken if f == face]
    v_center = (zb + ztop) / 2
    v_options = [v_center, ztop - 15 - h / 2, zb + 15 + h / 2]
    step = 20
    for i in range(int(half / step) + 1):
        for u in ((-i * step, i * step) if i else (0,)):
            for v in v_options:
                r = (u - w / 2, v - h / 2, u + w / 2, v + h / 2)
                if r[0] < -half + 40 or r[2] > half - 40 or r[1] < zb + 10 or r[3] > ztop - 5:
                    continue
                if any(_overlap(r, o, 20) for o in obstacles):
                    continue
                return r
    return None


def agv_markings(plan: Plan, g: AgvGeometry) -> list[Marking]:
    out: list[Marking] = []
    taken = []
    patterns = {'capacity': ('_load', 'side_label'), 'logo': ('logo',), 'nameplate': ('nameplate',)}
    rule_faces = {'capacity': ('y-', 'y+'), 'logo': ('y-', 'y+'), 'nameplate': ('x-',)}
    for key, spec in plan.markings.items():
        if not spec['enabled']:
            continue
        found = [(k, b) for k, b in g.groups.items() if any(p in k for p in patterns[key])]
        if found:
            for name, b in sorted(found):
                face = _face_of(g, b) or 'y+'
                r = _face_uv(face, b)
                taken.append((face, r))
                out.append(Marking(key, spec['label'], spec['text'], face, *r, _where(g, face, r), 'model'))
            continue
        for face in rule_faces[key]:
            r = _search(g, face, spec['size'], taken)
            if r is None:
                raise ValueError(f'{spec["label"]} 在 {face} 面上放不下')
            taken.append((face, r))
            out.append(Marking(key, spec['label'], spec['text'], face, *r, _where(g, face, r), 'rule'))
    return out


def crane_markings(plan: Plan, g: CraneGeometry) -> list[Marking]:
    out = []
    mid_v = g.girder_bottom + g.gh / 2
    spec = plan.markings

    def add(key, cx):
        s = spec[key]
        if not s['enabled']:
            return
        w, h = s['size']
        h = min(h, g.gh * 0.7)
        r = (cx - w / 2, mid_v - h / 2, cx + w / 2, mid_v + h / 2)
        where = f'主梁外侧腹板，中心距左轨中心 {fmt(cx)}，离地 {fmt(mid_v)}，两侧对称'
        out.append(Marking(key, s['label'], s['text'], 'front', *r, where, 'rule'))

    cap_w = spec['capacity']['size'][0]
    logo_w = spec['logo']['size'][0]
    add('capacity', g.S / 2)
    gap = min(1500, max(300, g.S / 2 - cap_w / 2 - logo_w - g.taper - 300))
    add('logo', g.S / 2 - cap_w / 2 - gap - logo_w / 2)
    add('nameplate', g.S - g.taper - 300 - spec['nameplate']['size'][0] / 2)
    return out


# --------------------------------------------------------------------------------------------
class Page:
    def __init__(self):
        self.fig = plt.figure(figsize=(PAGE_W / 25.4, PAGE_H / 25.4))
        ax = self.fig.add_axes([0, 0, 1, 1])
        ax.set_xlim(0, PAGE_W)
        ax.set_ylim(0, PAGE_H)
        ax.set_axis_off()
        self.ax = ax

    def text(self, x, y, s, size=3.0, **kw):
        """size is the character height in mm."""
        kw.setdefault('va', 'center')
        self.ax.text(x, y, s, fontsize=size * MM * 1.15, color=kw.pop('color', INK), **kw)

    def rect(self, x0, y0, x1, y1, lw=0.35, fc='none', ec=INK, **kw):
        self.ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, lw=lw * MM, fc=fc, ec=ec, **kw))

    def line(self, a, b, lw=0.25, color=INK):
        self.ax.plot([a[0], b[0]], [a[1], b[1]], lw=lw * MM, color=color)

    def table(self, x, y_top, widths, rows, row_h=6.0, size=2.6, swatch_col=None, header=True):
        y = y_top
        total = sum(widths)
        for i, row in enumerate(rows):
            if header and i == 0:
                self.rect(x, y - row_h, x + total, y, lw=0, fc='#efefef')
            cx = x
            for j, (w, cell) in enumerate(zip(widths, row)):
                if j == swatch_col and i > 0 and cell:
                    self.rect(cx + 1.2, y - row_h + 1.2, cx + 7, y - 1.2, lw=0.2, fc=cell)
                    self.text(cx + 8.2, y - row_h / 2, cell, size)
                elif cell:
                    self.text(cx + 1.2, y - row_h / 2, cell, size)
                cx += w
            y -= row_h
        for k in range(len(rows) + 1):
            self.line((x, y_top - k * row_h), (x + total, y_top - k * row_h), lw=0.2)
        cx = x
        for w in [0, *widths]:
            cx += w
            self.line((cx, y_top), (cx, y), lw=0.2)
        return y

    def view(self, x0, y_top, xlim, ylim, n, title):
        """Axes at scale 1:n whose top-left corner is (x0, y_top) in paper mm."""
        w = (xlim[1] - xlim[0]) / n
        h = (ylim[1] - ylim[0]) / n
        ax = self.fig.add_axes([x0 / PAGE_W, (y_top - h) / PAGE_H, w / PAGE_W, h / PAGE_H])
        ax.set_xlim(*xlim)
        ax.set_ylim(*ylim)
        ax.set_axis_off()
        self.text(x0 + w / 2, y_top + 3.5, f'{title}（1:{n}）', 3.5, ha='center')
        return ax


def _scale(k: float) -> int:
    """Largest standard drawing scale 1:n with 1/n <= k (paper mm per model mm)."""
    for n in SCALES:
        if 1 / n <= k:
            return n
    raise ValueError('视图太大，1:500 也放不下')


def _ext(lim):
    return lim[1] - lim[0]


def _zone_patch(ax, rect, zone, z=1):
    u0, v0, u1, v1 = rect
    ax.add_patch(Rectangle((u0, v0), u1 - u0, v1 - v0, fc=zone['hex'], ec=INK, lw=0.3, zorder=z))


def _letter(ax, x, y, s, r_data, z=10):
    ax.add_patch(Circle((x, y), r_data, fc='white', ec=INK, lw=0.5, zorder=z))
    ax.text(x, y, s, ha='center', va='center', fontsize=7, zorder=z + 1)


def _marking_patch(ax, m: Marking, num: int, unit: float):
    ax.add_patch(Rectangle((m.u0, m.v0), m.u1 - m.u0, m.v1 - m.v0, fc='white', ec=RED, lw=0.8,
                           ls='-' if m.placed == 'model' else '--', zorder=20))
    cx, cy = m.center
    if m.u1 - m.u0 >= unit * 2.5 and m.v1 - m.v0 >= unit * 1.6:
        ax.text(cx, cy, str(num), ha='center', va='center', fontsize=6, color=RED, zorder=21)
    else:  # too small for the number: put it just above the box
        ax.text(cx, m.v1 + unit * 0.4, str(num), ha='center', va='bottom', fontsize=6, color=RED, zorder=21)


def _dim_row(ax, x_ref, cx, y, v_to, label, unit):
    """Red dimension from a reference line (front end or rail centre) to a marking centre."""
    ax.annotate('', xy=(cx, y), xytext=(x_ref, y),
                arrowprops=dict(arrowstyle='<->', lw=0.5, color=RED, shrinkA=0, shrinkB=0))
    ax.plot([cx, cx], [y, v_to], color=RED, lw=0.3, ls=':')
    ax.text((cx + x_ref) / 2, y + unit * 0.5, label, ha='center', va='bottom', fontsize=5.5, color=RED)


# --------------------------------------------------------------------------------------------
def _agv_face_zones(plan: Plan, g: AgvGeometry, face: str):
    """Painted rectangles on a face in drawing order, as (rect, zone)."""
    items = []
    zb = g.body.lo[2]
    for zone in plan.zones:
        for cls in zone['classes']:
            groups = g.parts(cls)
            if groups:
                if face == 'top':
                    continue
                for b in groups.values():
                    near = (face == 'y-' and b.center[1] < 0) or (face == 'y+' and b.center[1] > 0) \
                        or (face == 'x-' and b.center[0] < 0) or (face == 'x+' and b.center[0] > 0)
                    if near:
                        u0, _, u1, _ = _face_uv(face, b)
                        items.append(((u0, 0, u1, zb), zone, 0.0))
                continue
            b = g.classes.get(cls)
            if b is None:
                continue
            r = list(_face_uv(face, b))
            half_u = (g.L if face in ('y-', 'y+', 'top') else g.W) / 2
            r[0], r[2] = max(r[0], -half_u), min(r[2], half_u)
            if face == 'top':
                half_v = g.W / 2
                r[1], r[3] = max(r[1], -half_v), min(r[3], half_v)
            items.append((tuple(r), zone, b.hi[2]))
    if face == 'top':  # seen from above: the highest surface wins
        items.sort(key=lambda it: it[2])
    else:
        items.sort(key=lambda it: -(it[0][2] - it[0][0]) * (it[0][3] - it[0][1]))
    return [(r, z) for r, z, _ in items]


def _visible(items):
    """Rectangles not fully covered by a rectangle drawn after them."""
    out = []
    for i, (r, zone) in enumerate(items):
        covered = any(o[0] <= r[0] and o[1] <= r[1] and o[2] >= r[2] and o[3] >= r[3] for o, _ in items[i + 1:])
        if not covered:
            out.append((r, zone))
    return out


def _agv_parts(g: AgvGeometry, face: str):
    rects = []
    for name, b in g.groups.items():
        if name.startswith(('drive', 'side', 'end', 'logo')) or '_load' in name:
            continue
        if face == 'top' or _face_of(g, b) == face:
            rects.append(_face_uv(face, b))
    return rects


def _agv_limits(g: AgvGeometry, face: str, marks):
    unit = g.L / 100
    half_u = (g.L if face in ('y-', 'y+', 'top') else g.W) / 2
    pad = unit * 4
    if face == 'top':
        return (-half_u - pad, half_u + pad), (-g.W / 2 - pad, g.W / 2 + pad)
    rows = len([m for m in marks if m.face == face]) if face in ('y-', 'y+') else 0
    below = unit * (8 + 4 * rows)
    return (-half_u - pad, half_u + pad), (-below, g.H + unit * 4)


def _draw_agv_face(ax, g: AgvGeometry, plan: Plan, face: str, marks, nums):
    unit = g.L / 100
    half_u = (g.L if face in ('y-', 'y+', 'top') else g.W) / 2
    items = _agv_face_zones(plan, g, face)
    for r, zone in items:
        _zone_patch(ax, r, zone)
    for r in _agv_parts(g, face):
        ax.add_patch(Rectangle((r[0], r[1]), r[2] - r[0], r[3] - r[1], fc=PART, ec='#777777', lw=0.3, zorder=5))
    if face != 'top':
        ax.plot(ax.get_xlim(), [0, 0], color='#777777', lw=0.5)
    # Zone letters: inside the zone when there is room, otherwise on a leader below the view.
    seen = []
    letter_r = unit * 1.6
    for r, zone in _visible(items):
        if zone['id'] in seen:
            continue
        seen.append(zone['id'])
        cx = r[0] + (r[2] - r[0]) * (0.12 + 0.1 * len(seen))
        if r[3] - r[1] > letter_r * 2.6:
            _letter(ax, cx, (r[1] + r[3]) / 2, zone['id'], letter_r)
        else:
            ty = -unit * 4
            ax.plot([cx, cx], [r[1], ty + letter_r], color=INK, lw=0.4)
            _letter(ax, cx, ty, zone['id'], letter_r)
    face_marks = [m for m in marks if m.face == face]
    for m in face_marks:
        _marking_patch(ax, m, nums[id(m)], unit)
    if face in ('y-', 'y+'):
        # Positions measured from the front end, which moves with the length parameter.
        front = half_u if face == 'y-' else -half_u
        for i, m in enumerate(face_marks):
            y = -unit * (9 + 4 * i)
            _dim_row(ax, front, m.center[0], y, m.v0, f'{nums[id(m)]}: {fmt(abs(front - m.center[0]))}', unit)
        if face_marks:
            ax.plot([front, front], [-unit * (9 + 4 * len(face_marks)), 0], color=RED, lw=0.3, ls=':')
        ax.text(front, g.H + unit * 0.8, '车头', ha='center', va='bottom', fontsize=6)


def _agv_views(page: Page, plan: Plan, g: AgvGeometry, marks, nums, area) -> int:
    x0, y0, x1, y1 = area
    W, H = x1 - x0, y1 - y0
    lim = {f: _agv_limits(g, f, marks) for f in ('y-', 'y+', 'top', 'x-')}
    w = {f: _ext(l[0]) for f, l in lim.items()}
    h = {f: _ext(l[1]) for f, l in lim.items()}
    gap = 8
    titles = {'y-': '右侧面', 'y+': '左侧面', 'top': '俯视（台面）', 'x-': '车尾端面'}
    # Layout A: two side faces, then top view and end face side by side. Layout B: all four
    # stacked. Use whichever gives the larger scale.
    n_row = _scale(min(W / w['y-'], (W - gap) / (w['top'] + w['x-']),
                       (H - 3 * TITLE_SPACE) / (h['y-'] + h['y+'] + max(h['top'], h['x-']))))
    n_stack = _scale(min(W / max(w.values()), (H - 4 * TITLE_SPACE) / sum(h.values())))
    if n_stack < n_row:
        n = n_stack
        rows = [['y-'], ['y+'], ['top'], ['x-']]
    else:
        n = n_row
        rows = [['y-'], ['y+'], ['top', 'x-']]
    heights = [max(h[f] for f in row) / n for row in rows]
    spare = (H - len(rows) * TITLE_SPACE - sum(heights)) / len(rows)
    y = y1 - TITLE_SPACE
    for row, row_h in zip(rows, heights):
        row_w = sum(w[f] for f in row) / n
        gx = gap + (W - row_w - gap) / 3 if len(row) > 1 else 0
        xa = x0 + (W - row_w - gx * (len(row) - 1)) / 2
        for face in row:
            ax = page.view(xa, y, *lim[face], n, titles[face])
            _draw_agv_face(ax, g, plan, face, marks, nums)
            xa += w[face] / n + gx
        y -= row_h + TITLE_SPACE + spare
    return n


def _crane_views(page: Page, plan: Plan, g: CraneGeometry, marks, nums, area) -> int:
    x0, y0, x1, y1 = area
    W, H = x1 - x0, y1 - y0
    zones = {z['classes'][0]: z for z in plan.zones}
    S, ew = g.S, g.ew
    unit = S / 100
    top, bot, end_bot = g.girder_top, g.girder_bottom, g.girder_top - g.girder_end_h
    hb_y = bot - g.hook_block_h - 300
    railing = 1050
    xlim = (-ew - unit * 4, S + ew + unit * 4)
    ylim = (hb_y - unit * (6 + 3.5 * len(marks)), max(g.trolley_top, top + railing) + unit * 3)
    el = g.end_len
    plim = (-el / 2 - unit * 3, el / 2 + unit * 3)
    k = min(W / _ext(xlim), (H - 2 * TITLE_SPACE) / (_ext(ylim) + _ext(plim)))
    n = _scale(k)
    spare = (H - 2 * TITLE_SPACE - (_ext(ylim) + _ext(plim)) / n) / 2
    xa = x0 + (W - _ext(xlim) / n) / 2

    # Elevation of the girder outer face: girder, end beams, trolley, hook, railing.
    ax = page.view(xa, y1 - TITLE_SPACE, xlim, ylim, n, '主视（主梁外侧面）')
    t = g.taper
    a, b = ew / 2, S - ew / 2
    girder = [(a, top), (b, top), (b, end_bot), (b - 300, end_bot), (S - t, bot), (t, bot), (a + 300, end_bot),
              (a, end_bot)]
    ax.add_patch(Polygon(girder, fc=zones['girder']['hex'], ec=INK, lw=0.4, zorder=2))
    for xc in (0, S):
        ax.add_patch(Rectangle((xc - ew / 2, g.end_bottom), ew, g.eh, fc=zones['end_beam']['hex'], ec=INK, lw=0.4,
                               zorder=3))
    rail_y = top + g.TROLLEY_RAIL_H
    ax.add_patch(Rectangle((S / 2 - g.TROLLEY_LEN / 2, rail_y), g.TROLLEY_LEN, g.TROLLEY_H,
                           fc=zones['trolley']['hex'], ec=INK, lw=0.4, zorder=3))
    ax.add_patch(Rectangle((a, top), b - a, railing, fc=zones['walkway']['hex'], ec='none', alpha=0.35, zorder=0))
    ax.plot([a, b], [top + railing, top + railing], color=INK, lw=0.6, zorder=1)
    x = a
    while x <= b + 1:
        ax.plot([x, x], [top, top + railing], color=INK, lw=0.4, zorder=1)
        x += 1500
    ax.add_patch(Rectangle((S / 2 - g.hook_block_w / 2, hb_y), g.hook_block_w, g.hook_block_h,
                           fc=zones['hook']['hex'], ec=INK, lw=0.4, hatch='////', zorder=3))
    for s in (-1, 1):
        ax.plot([S / 2 + s * 120] * 2, [hb_y + g.hook_block_h, bot], color=INK, lw=0.4)
    for m in marks:
        _marking_patch(ax, m, nums[id(m)], unit)
    base = hb_y - unit * 4
    for i, m in enumerate(marks):
        _dim_row(ax, 0, m.center[0], base - unit * 3.5 * i, m.v0, f'{nums[id(m)]}: {fmt(m.center[0])}', unit)
    yl = base - unit * 3.5 * (len(marks) - 1)
    ax.plot([0, 0], [yl, g.end_bottom], color=RED, lw=0.3, ls=':')
    ax.text(0, yl - unit * 0.6, '左轨中心', ha='center', va='top', fontsize=5.5, color=RED)
    r = unit * 1.3
    _letter(ax, S * 0.15, (top + bot) / 2 + 150, 'A', r)
    _letter(ax, -ew / 2 - r * 1.6, g.end_bottom + g.eh / 2, 'B', r)
    cy = rail_y + g.TROLLEY_H / 2
    lx = S / 2 - g.TROLLEY_LEN / 2 - unit * 4
    _letter(ax, lx, cy, 'C', r)
    ax.plot([lx + r, S / 2 - g.TROLLEY_LEN / 2], [cy, cy], color=INK, lw=0.4)
    hy = hb_y + g.hook_block_h / 2
    hx = S / 2 + g.hook_block_w / 2 + unit * 4
    _letter(ax, hx, hy, 'D', r)
    ax.plot([S / 2 + g.hook_block_w / 2, hx - r], [hy, hy], color=INK, lw=0.4)
    _letter(ax, S * 0.85, top + railing / 2, 'E', r)

    # Plan.
    zw = g.gauge / 2 + g.gw / 2
    ax2 = page.view(xa, y1 - TITLE_SPACE * 2 - _ext(ylim) / n - spare, xlim, plim, n, '俯视')
    ax2.add_patch(Rectangle((a, zw), b - a, 800, fc=zones['walkway']['hex'], ec=INK, lw=0.3))
    for zc in g.girder_z:
        ax2.add_patch(Rectangle((a, zc - g.gw / 2), b - a, g.gw, fc=zones['girder']['hex'], ec=INK, lw=0.4))
    for xc in (0, S):
        ax2.add_patch(Rectangle((xc - ew / 2, -el / 2), ew, el, fc=zones['end_beam']['hex'], ec=INK, lw=0.4))
    half = g.gauge / 2 + g.gw / 2 + 150
    ax2.add_patch(Rectangle((S / 2 - g.TROLLEY_LEN / 2, -half), g.TROLLEY_LEN, 2 * half,
                            fc=zones['trolley']['hex'], ec=INK, lw=0.4, zorder=3))
    _letter(ax2, S * 0.3, -g.gauge / 2, 'A', r)
    _letter(ax2, S * 0.3, g.gauge / 2, 'A', r)
    _letter(ax2, S * 0.7, zw + 400, 'E', r)
    _letter(ax2, 0, -el / 2 - unit * 1.6, 'B', r)
    _letter(ax2, S / 2 + g.TROLLEY_LEN / 2 + unit * 3, 0, 'C', r)
    ax2.plot([S / 2 + g.TROLLEY_LEN / 2, S / 2 + g.TROLLEY_LEN / 2 + unit * 3 - r], [0, 0], color=INK, lw=0.4)
    return n


# --------------------------------------------------------------------------------------------
def draw(plan: Plan, out_base: Path, png: bool = False) -> dict:
    page = Page()
    x0, y0, x1, y1 = 25, 5, PAGE_W - 5, PAGE_H - 5
    page.rect(0, 0, PAGE_W, PAGE_H, lw=0.2, ec='#999999')
    page.rect(x0, y0, x1, y1, lw=0.6)
    right_x = x1 - 182
    # “示意” stamp and title.
    page.rect(x0 + 6, y1 - 22, x0 + 98, y1 - 6, lw=0.5, ec=RED)
    page.text(x0 + 10, y1 - 14, '示 意', 9, color=RED)
    page.text(x0 + 46, y1 - 11, '方案阶段自动出图', 3.5, color=RED)
    page.text(x0 + 46, y1 - 17.5, '不得直接用于生产', 3.5, color=RED)
    page.text(x0 + 104, y1 - 9.5, '涂装与标识工艺图', 6)
    page.text(x0 + 104, y1 - 16, f'{plan.model} · 方案 {plan.id} v{plan.version}', 3.0)
    page.text(x0 + 104, y1 - 20.5, plan.finish_system['label'], 3.0)

    view_area = (x0 + 6, y0 + 16, right_x - 8, y1 - 30)
    if plan.category == 'agv':
        g = AgvGeometry(plan)
        marks = agv_markings(plan, g)
        nums = {id(m): i + 1 for i, m in enumerate(marks)}
        scale = _agv_views(page, plan, g, marks, nums, view_area)
        ref = '车头'
    else:
        g = CraneGeometry(plan)
        marks = crane_markings(plan, g)
        nums = {id(m): i + 1 for i, m in enumerate(marks)}
        scale = _crane_views(page, plan, g, marks, nums, view_area)
        ref = '左轨中心'
    page.text(x0 + 6, y0 + 9, '图例：实线红框为三维模型上的标识位置，虚线红框为按规则放置的示意位置；'
              '灰色为外购标品，涂装时遮蔽。', 2.4, color='#444444')
    page.text(x0 + 6, y0 + 4.5, f'红色尺寸为标识中心到{ref}的距离（mm），随方案参数变化。', 2.4, color='#444444')

    # Right column: zone table, coating system, markings, notes, title block.
    y = y1 - 6
    page.text(right_x, y - 2, '一、涂装分区', 3.4)
    rows = [['分区', '部位', '面漆色值', '色号', '来源']]
    for z in plan.zones:
        rows.append([z['id'], z['name'], z['hex'], z['code'] if z['code'].startswith('paints') else '示意，未登记',
                     z['source']])
    y = page.table(right_x, y - 5, [10, 26, 30, 42, 72], rows, row_h=6, size=2.5, swatch_col=2)

    sysd = plan.finish_system
    page.text(right_x, y - 5, '二、涂层体系与工艺说明（数值示意）', 3.4)
    rows = [['工序', '材料 / 要求', '干膜厚度', '颜色']]
    rows.append(['表面处理', sysd['surface_prep'], '—', '—'])
    for c in sysd['coats']:
        rows.append([c['coat'], c['product'], f'{c["dft_um"]} μm', c['color']])
    total = sum(c['dft_um'] for c in sysd['coats'])
    rows.append(['总干膜', '外购标品、铭牌座、导电面遮蔽不涂', f'≥ {total} μm', '—'])
    y = page.table(right_x, y - 8, [22, 98, 30, 30], rows, row_h=6, size=2.5)
    page.text(right_x, y - 4, '检验：' + '；'.join(sysd['checks']) + '（示意）', 2.4)

    page.text(right_x, y - 11, '三、表面文字与标识', 3.4)
    rows = [['号', '标识', '内容', '尺寸', '位置（随参数）']]
    for m in marks:
        size = f'{fmt(m.u1 - m.u0)}×{fmt(m.v1 - m.v0)}'
        rows.append([str(nums[id(m)]), m.label, m.text, size, m.where])
    y = page.table(right_x, y - 14, [8, 22, 26, 20, 104], rows, row_h=5.5, size=2.3)

    notes = [
        '说明（示意）',
        '1. 色值取自 src/parametric/paints.json 或模型源文件，色号（RAL / 国标色卡）待卫华提供。',
        '2. 涂层材料、膜厚、检验项为示意，以卫华涂装工艺规范为准。',
        '3. 标识尺寸、字体和 Logo 图形待卫华 VI 规范；吨位文字随方案起重量 / 型号更新。',
        '4. 位置尺寸单位 mm，由方案参数和三维模型 manifest 推算。',
    ]
    yn = y - 5
    for i, s in enumerate(notes):
        page.text(right_x, yn - i * 4.2, s, 2.5 if i else 3.0)

    tb = [
        ['项目', plan.project, '图号', plan.drawing_no + '-GY'],
        ['产品', plan.model, '方案', f'{plan.id} v{plan.version}'],
        ['图名', '涂装与标识工艺图', '比例', f'1:{scale}（视图）'],
        ['日期', plan.date, '设计', plan.drawn_by],
        ['单位', '卫华集团（示意）', '状态', '示意 · 非生产图纸'],
    ]
    page.table(right_x, y0 + 5 * 7, [16, 74, 16, 74], tb, row_h=7, size=2.8, header=False)

    out_base.parent.mkdir(parents=True, exist_ok=True)
    files = {}
    for ext in ('svg', 'pdf') + (('png',) if png else ()):
        path = out_base.with_suffix('.' + ext)
        page.fig.savefig(path, dpi=200 if ext == 'png' else None, facecolor='white')
        files[ext] = path
    plt.close(page.fig)
    return {
        'files': files,
        'view_scale': f'1:{scale}',
        'zones': [{k: z[k] for k in ('id', 'name', 'paint', 'hex', 'code', 'source')} for z in plan.zones],
        'markings': [dict(no=nums[id(m)], key=m.key, label=m.label, text=m.text, face=m.face,
                          size=[m.u1 - m.u0, m.v1 - m.v0], where=m.where, placed=m.placed) for m in marks],
        'coating_total_dft_um': total,
    }
