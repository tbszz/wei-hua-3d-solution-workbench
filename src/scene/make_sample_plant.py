"""Write the simulated plant floor plan used by the site demo.

  python make_sample_plant.py <out.dxf>

Millimetres. Layers and block attributes follow docs/cad-convention.md. The layout copies the
Rhino plant screenshot of 2026-11-10 by eye: a long hall, four dock doors at the west end, three
crane-runway column rows, a yellow main aisle around a central production pad. Stations and
machines are invented.
"""
import math
import sys

import ezdxf
from ezdxf import units
from ezdxf.enums import TextEntityAlignment

OUT = sys.argv[1]
HALL_X, HALL_Y = 96000, 42000
BAY = 8000
ROWS = (0, 8000, 30000, 42000)
RING_W, RING_E, RING_S, RING_N, RING_R = 12000, 84000, 12000, 26000, 4000
QUARTER = math.tan(math.radians(90) / 4)  # bulge of a 90 degree arc

doc = ezdxf.new('R2013', setup=True)
doc.units = units.MM
msp = doc.modelspace()
for name, color in [('A-WALL', 8), ('A-DOOR', 8), ('A-GLAZ', 5), ('S-COLS', 2), ('S-BEAM', 1), ('Q-RACK', 5), ('Q-MACH', 4),
                    ('Q-CONV', 4), ('Q-CRAN', 2), ('A-FLOR-YEL', 2), ('A-FLOR-GRN', 3), ('A-FLOR-MARK', 2), ('A-ANNO-TEXT', 7),
                    ('AGV-PATH', 6), ('AGV-STAT', 1)]:
    doc.layers.add(name, color=color)


def rect(cx, cy, w, d):
    return [(cx - w / 2, cy - d / 2), (cx + w / 2, cy - d / 2), (cx + w / 2, cy + d / 2), (cx - w / 2, cy + d / 2)]


def block(name, *rects, attrs=()):
    b = doc.blocks.new(name)
    for cx, cy, w, d in rects:
        b.add_lwpolyline(rect(cx, cy, w, d), close=True)
    for i, tag in enumerate(attrs):
        b.add_attdef(tag, (0, -400 * i), dxfattribs={'height': 250})


STATION_ATTRS = ['ID', 'TYPE', 'SEQ', 'CARGO']
block('COL_500', (0, 0, 500, 500), attrs=['HEIGHT'])
block('COL_300', (0, 0, 300, 300), attrs=['HEIGHT'])
block('RACK_2700', (0, 0, 2700, 1100), attrs=['HEIGHT', 'LEVELS'])
block('MACH_CNC', (0, 0, 8000, 4000), attrs=['NAME', 'HEIGHT'])
block('MACH_PRESS', (0, 0, 6000, 3500), attrs=['NAME', 'HEIGHT'])
block('MACH_WELD', (0, 0, 7000, 3600), attrs=['NAME', 'HEIGHT'])
block('CONV_6000', (0, 0, 6000, 1200), attrs=['NAME', 'HEIGHT'])
block('CRANE_12M', (0, 750, 11600, 500), (0, -750, 11600, 500), (-5800, 0, 800, 3200), (5800, 0, 800, 3200), attrs=['NAME', 'HEIGHT'])
block('DOCK_4000', (0, 0, 4000, 300), attrs=['HEIGHT'])
block('WIN_1200', (0, 0, 1200, 60), attrs=['SILL', 'HEIGHT'])
block('PANEL_3000', (0, 0, 3000, 80), attrs=['SILL', 'HEIGHT'])
# Lifting stand: two rails along the AGV heading, 3000 mm clear between them.
block('AGV_STAND', (0, 1650, 3000, 300), (0, -1650, 3000, 300), attrs=STATION_ATTRS)
# Charger: a cabinet beyond the nose of the parked AGV.
block('AGV_CHARGE', (3300, 0, 500, 1200), attrs=STATION_ATTRS)


def insert(name, layer, x, y, rot=0, **attrs):
    ref = msp.add_blockref(name, (x, y), dxfattribs={'layer': layer, 'rotation': rot})
    ref.add_auto_attribs({k: str(v) for k, v in attrs.items()})


def poly(layer, points, width=None, close=False):
    attribs = {'layer': layer}
    if width:
        attribs['const_width'] = width
    msp.add_lwpolyline(points, format='xyb', close=close, dxfattribs=attribs)


def line(layer, a, b, width=None):
    poly(layer, [(*a, 0), (*b, 0)], width)


poly('A-WALL', [(0, 0, 0), (HALL_X, 0, 0), (HALL_X, HALL_Y, 0), (0, HALL_Y, 0)], width=240, close=True)

for x in range(0, HALL_X + 1, BAY):
    for y in ROWS:
        if y in (8000, 30000):
            insert('COL_500', 'S-COLS', x, y, HEIGHT=10500)
        else:
            insert('COL_300', 'S-COLS', x, y + (150 if y == 0 else -150), HEIGHT=10500)
for y in ROWS[1:]:
    line('S-BEAM', (0, y if y != HALL_Y else y - 150), (HALL_X, y if y != HALL_Y else y - 150), 400)

insert('CRANE_12M', 'Q-CRAN', 10000, 36000, 90, NAME='桥式起重机 1', HEIGHT=9800)
insert('CRANE_12M', 'Q-CRAN', 86000, 36000, 90, NAME='桥式起重机 2', HEIGHT=9800)

for y in (6000, 15000, 24000, 33000):
    insert('DOCK_4000', 'A-DOOR', 0, y, 90, HEIGHT=4500)
    insert('PANEL_3000', 'A-GLAZ', HALL_X, y, 90, SILL=4000, HEIGHT=2500)
for x in range(BAY // 2, HALL_X, BAY):
    insert('WIN_1200', 'A-GLAZ', x, 0, SILL=1500, HEIGHT=7000)
    insert('WIN_1200', 'A-GLAZ', x, HALL_Y, SILL=1500, HEIGHT=7000)
for y in (2000, 10500, 19500, 28500, 37500):
    insert('WIN_1200', 'A-GLAZ', 0, y, 90, SILL=1500, HEIGHT=7000)

for x in range(15350, 45000, 2700):
    insert('RACK_2700', 'Q-RACK', x, 1100, HEIGHT=6000, LEVELS=4)
for x in range(59350, 84000, 2700):
    insert('RACK_2700', 'Q-RACK', x, 1100, HEIGHT=6000, LEVELS=4)
for x in range(20350, 76000, 2700):
    insert('RACK_2700', 'Q-RACK', x, HALL_Y - 1100, HEIGHT=6000, LEVELS=4)

insert('MACH_CNC', 'Q-MACH', 20000, 19000, NAME='数控加工中心 A', HEIGHT=3200)
insert('MACH_CNC', 'Q-MACH', 28800, 19000, NAME='数控加工中心 B', HEIGHT=3200)
insert('MACH_PRESS', 'Q-MACH', 36000, 22000, NAME='液压机', HEIGHT=4600)
insert('MACH_WELD', 'Q-MACH', 60000, 16000, NAME='焊接工作站', HEIGHT=3000)
insert('MACH_PRESS', 'Q-MACH', 72000, 16000, NAME='折弯机', HEIGHT=3400)
insert('CONV_6000', 'Q-CONV', 72000, 19600, NAME='输送线 1', HEIGHT=900)
insert('CONV_6000', 'Q-CONV', 72000, 22000, NAME='输送线 2', HEIGHT=900)


def rounded_ring(offset):
    w, e, s, n, r = RING_W - offset, RING_E + offset, RING_S - offset, RING_N + offset, RING_R + offset
    return [(w + r, s, 0), (e - r, s, QUARTER), (e, s + r, 0), (e, n - r, QUARTER), (e - r, n, 0), (w + r, n, QUARTER),
            (w, n - r, 0), (w, s + r, QUARTER)]


poly('AGV-PATH', rounded_ring(0), close=True)
line('AGV-PATH', (48000, RING_S), (48000, RING_N))
stations = [
    ('AGV_CHARGE', (52000, RING_S), 52000, 4000, -90, 'CHG-01', 'CHARGE', '0,5', ''),
    ('AGV_STAND', (RING_W, 19000), 5500, 19000, 180, 'RM-01', 'PICK', '1', 'COIL'),
    ('AGV_STAND', (36000, RING_S), 36000, 17000, 90, 'CELL-01', 'DROP', '2', ''),
    ('AGV_STAND', (60000, RING_N), 60000, 21000, -90, 'CELL-02', 'PICK', '3', 'CRATE'),
    ('AGV_STAND', (RING_E, 19000), 90500, 19000, 0, 'FG-01', 'DROP', '4', ''),
]
for name, start, x, y, rot, sid, kind, seq, cargo in stations:
    line('AGV-PATH', start, (x, y))
    insert(name, 'AGV-STAT', x, y, rot, ID=sid, TYPE=kind, SEQ=seq, CARGO=cargo)

poly('A-FLOR-YEL', rounded_ring(0), width=4000, close=True)
poly('A-FLOR-GRN', rounded_ring(2150), width=120, close=True)
poly('A-FLOR-GRN', rounded_ring(-2150), width=120, close=True)
line('A-FLOR-GRN', (9200, 400), (9200, HALL_Y - 400), 2200)
line('A-FLOR-GRN', (86800, 400), (86800, HALL_Y - 400), 2200)
for _, _, x, y, rot, *_rest in stations:
    a = math.radians(rot)
    corners = [(x + u * math.cos(a) - v * math.sin(a), y + u * math.sin(a) + v * math.cos(a), 0)
               for u, v in [(-3000, -2400), (3000, -2400), (3000, 2400), (-3000, 2400)]]
    poly('A-FLOR-MARK', corners, width=80, close=True)

for text, x, y in [('来料区', 5500, 24500), ('机加工区', 24400, 15500), ('总装线', 36000, 14300), ('焊接区', 60000, 23800),
                   ('折弯与输送', 72000, 23600), ('成品区', 90500, 24500), ('充电区', 52000, 6800)]:
    msp.add_text(text, height=600, dxfattribs={'layer': 'A-ANNO-TEXT'}).set_placement((x, y), align=TextEntityAlignment.MIDDLE_CENTER)

auditor = doc.audit()
if auditor.has_errors:
    raise SystemExit(f'DXF audit failed: {auditor.errors}')
doc.saveas(OUT, encoding='utf-8')
print('wrote', OUT, len(msp), 'entities')
