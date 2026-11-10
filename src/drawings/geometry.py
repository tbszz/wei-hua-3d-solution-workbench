"""Product outlines in millimetres, computed from the resolved plan.

AGV: the same piecewise-linear stretch as demo/src/stretch.js, applied to the bounding boxes in the
model manifest. Body boxes stretch corner by corner; standard parts (lasers, drives, labels) keep
their size and move with their centre, which is what the 3D demo does with its anchors.
Axes follow the manifest: x along the length (+ = front), y across, z up, ground at z = 0.

Crane: a schematic double-girder overhead crane. Only the plan parameters are real inputs; every
other proportion here is a placeholder until Weihua's design data is available.
"""
from __future__ import annotations

from dataclasses import dataclass

from plan import Plan

AXES = {'length': 0, 'width': 1, 'height': 2}


@dataclass(frozen=True)
class Band:
    inner: float  # mm
    outer: float
    growth: float
    mirrored: bool

    @property
    def scale(self) -> float:
        return 1 + self.growth / (self.outer - self.inner)

    def map(self, v: float) -> float:
        sign = (-1 if v < 0 else 1) if self.mirrored else 1
        a = abs(v) if self.mirrored else v
        if a <= self.inner:
            return v
        if a >= self.outer:
            return round(sign * (a + self.growth), 6)
        return round(sign * (self.inner + (a - self.inner) * self.scale), 6)


def band_for(band: dict, nominal: float, value: float) -> Band:
    change = value - nominal
    return Band(band['inner'] * 1000, band['outer'] * 1000, change / 2 if band['mirrored'] else change, band['mirrored'])


@dataclass(frozen=True)
class Box:
    lo: tuple[float, float, float]
    hi: tuple[float, float, float]

    @property
    def center(self):
        return tuple((a + b) / 2 for a, b in zip(self.lo, self.hi))

    @property
    def size(self):
        return tuple(b - a for a, b in zip(self.lo, self.hi))


class AgvGeometry:
    def __init__(self, plan: Plan):
        cfg = plan.product
        self.plan = plan
        self.L = plan.value('length')
        self.W = plan.value('width')
        self.H = plan.value('height')
        self.protrusion = cfg.get('protrusion', 0)
        self.bands = [band_for(cfg['bands'][k], cfg['params'][k]['nominal'], plan.value(k)) for k in AXES]
        m = plan.manifest
        self.classes = {k: self._stretch(v) for k, v in m['classes'].items()}
        self.groups = {k: self._move(v) for k, v in m['groups'].items()}
        # Body outline straight from the parameters, so dimensions read back exactly.
        frame = self.classes['frame']
        self.body = Box((-self.L / 2, -self.W / 2, frame.lo[2]), (self.L / 2, self.W / 2, self.H))
        self.deck_z = self.classes['deck'].lo[2]

    def _mm(self, box: dict):
        return [v * 1000 for v in box['min']], [v * 1000 for v in box['max']]

    def _stretch(self, box: dict) -> Box:
        lo, hi = self._mm(box)
        return Box(tuple(b.map(v) for b, v in zip(self.bands, lo)), tuple(b.map(v) for b, v in zip(self.bands, hi)))

    def _move(self, box: dict) -> Box:
        lo, hi = self._mm(box)
        c = [(a + b) / 2 for a, b in zip(lo, hi)]
        d = [b.map(v) - v for b, v in zip(self.bands, c)]
        return Box(tuple(round(a + o, 6) for a, o in zip(lo, d)), tuple(round(a + o, 6) for a, o in zip(hi, d)))

    def parts(self, prefix: str) -> dict[str, Box]:
        return {k: v for k, v in self.groups.items() if k.startswith(prefix)}

    @property
    def wheelbase(self) -> float:
        drives = self.parts('drive')
        xs = sorted({round(b.center[0], 3) for b in drives.values()})
        return xs[-1] - xs[0]

    @property
    def track(self) -> float:
        drives = self.parts('drive')
        ys = sorted({round(b.center[1], 3) for b in drives.values()})
        return ys[-1] - ys[0]

    @property
    def overall_length(self) -> float:
        lasers = self.parts('laser_end')
        return max(self.L / 2, *(b.hi[0] for b in lasers.values())) - min(-self.L / 2, *(b.lo[0] for b in lasers.values()))

    @property
    def overall_width(self) -> float:
        lasers = self.parts('laser_side')
        return max(self.W / 2, *(b.hi[1] for b in lasers.values())) - min(-self.W / 2, *(b.lo[1] for b in lasers.values()))

    def fixture_outline(self):
        """Fixture on the deck as (length, width, height, saddle_depth); None without a fixture."""
        f = self.plan.fixture
        if not f:
            return None
        o = f['outline']
        return (round(self.L * o['length_ratio'], 0), round(self.W * o['width_ratio'], 0), o['height'],
                o.get('saddle_depth', 0), o.get('post_count', 0))


class CraneGeometry:
    """Double-girder overhead crane. x along the span from the left runway rail, z along the runway,
    y up from the floor (±0.000)."""

    WHEEL_D = 600          # 大车车轮直径（示意）
    RAIL_H = 150           # 大车轨道 + 压板高（示意）
    TROLLEY_RAIL_H = 90    # 小车轨道高（示意）
    TROLLEY_H = 1100       # 小车架 + 起升机构高（示意）
    TROLLEY_LEN = 2600     # 小车沿跨度方向长（示意）
    GAP_HOOK_GIRDER = 300  # 吊钩上极限时滑轮组顶到主梁底的距离（示意）
    END_OVERHANG = 600     # 端梁超出车轮中心的长度（示意）

    def __init__(self, plan: Plan):
        v = plan.value
        self.plan = plan
        self.S = v('span')
        self.Hlift = v('lift_height')
        self.gauge = v('trolley_gauge')
        self.wheelbase = v('wheelbase')
        self.gh = v('girder_height')
        self.gw = v('girder_width')
        self.tf = v('girder_flange_t')
        self.tw = v('girder_web_t')
        self.eh = v('end_beam_height')
        self.ew = v('end_beam_width')
        fixture = plan.fixture or {'outline': {'block_height': 1100, 'block_width': 700}, 'kind': 'hook'}
        self.hook_kind = fixture['kind']
        self.hook_block_h = fixture['outline']['block_height']
        self.hook_block_w = fixture['outline']['block_width']
        # Hook saddle (or magnet face) at the top limit sits at the lift height.
        self.girder_bottom = self.Hlift + self.hook_block_h + self.GAP_HOOK_GIRDER
        self.girder_top = self.girder_bottom + self.gh
        # End beams carry the wheels; girder tops are flush with end-beam tops.
        self.end_top = self.girder_top
        self.end_bottom = self.end_top - self.eh
        self.wheel_center = self.end_bottom + self.WHEEL_D * 0.25
        self.rail_top = self.wheel_center - self.WHEEL_D / 2
        self.end_len = self.wheelbase + 2 * self.END_OVERHANG
        self.trolley_top = self.girder_top + self.TROLLEY_RAIL_H + self.TROLLEY_H
        self.taper = round(min(self.S * 0.08, 2000), 0)  # 主梁端部变截面长度（示意）
        self.girder_end_h = max(self.eh, self.gh * 0.55)

    @property
    def height_above_rail(self) -> float:
        return self.trolley_top - self.rail_top

    @property
    def girder_z(self):
        return (-self.gauge / 2, self.gauge / 2)
