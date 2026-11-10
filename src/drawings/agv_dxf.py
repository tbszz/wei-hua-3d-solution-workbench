"""AGV structure drawing: front, top and left views (first-angle projection, GB style)."""
from __future__ import annotations

import math

from cad import (Sheet, SHEETS, BINDING, TITLE_W, TITLE_H, PARAM_ROW_H, box, centerline, choose, label, new_doc, poly)
from geometry import AgvGeometry
from plan import Plan, fmt

# Paper margins around each view, in mm, reserved for dimensions and labels.
BELOW = 36     # two dimension rows + view label
LEFT = 32      # two vertical dimension rows
RIGHT = 22
TOP_GAP = 30   # under the “示意” stamp
NOTES_H = 38


def _layout(g: AgvGeometry, plan: Plan, size: str, n: int):
    W, H, c = SHEETS[size]
    x0, y0, x1, y1 = BINDING, c, W - c, H - c
    fix = g.fixture_outline()
    top_z = g.H + (fix[2] if fix else 0)
    front_w, front_h = g.overall_length / n, top_z / n
    plan_h = g.overall_width / n
    side_w = g.overall_width / n
    table_h = TITLE_H + (len(plan.params) + 4) * PARAM_ROW_H   # title block + parameter table
    block_h = table_h + NOTES_H                                # + notes, stacked on the right

    cx = math.ceil(x0 + 3 + LEFT + front_w / 2)          # paper x of model x = 0
    ground = math.floor(y1 - TOP_GAP - front_h)           # paper y of the ground line
    plan_cy = math.floor(ground - BELOW - 6 - plan_h / 2)
    side_cx = math.ceil(cx + front_w / 2 + RIGHT + 14 + side_w / 2)
    plan_bottom = plan_cy - plan_h / 2 - BELOW
    ok = (
        plan_bottom >= y0 + 2                                       # top view fits above the bottom
        and (cx + front_w / 2 + 18 <= x1 - TITLE_W - 4              # top view clears the table ...
             or plan_bottom >= y0 + table_h + 4)                    # ... or sits above it
        and side_cx + side_w / 2 + RIGHT <= x1 - 2                  # side view fits on the right
        and ground - BELOW >= y0 + block_h + 4                      # side view clears the stacked block
    )
    return ok, (cx, ground, plan_cy, side_cx)


def draw(plan: Plan):
    g = AgvGeometry(plan)
    size, n = choose(lambda s, k: _layout(g, plan, s, k)[0])
    _, (cx, ground, plan_cy, side_cx) = _layout(g, plan, size, n)
    doc = new_doc(plan)
    sheet = Sheet(doc, size, n, origin=(cx, ground))
    msp = sheet.msp
    dy = (ground - plan_cy) * n     # top view centre, model y = -dy
    dx = (side_cx - cx) * n         # side view centre, model x = dx
    fix = g.fixture_outline()

    _front(sheet, g, fix)
    _top(sheet, g, -dy)
    _side(sheet, g, dx, fix)
    _dims(sheet, g, dx, dy, fix)
    _ground(msp, -g.overall_length / 2 - 8 * n, g.overall_length / 2 + 8 * n)
    _ground(msp, dx - g.overall_width / 2 - 8 * n, dx + g.overall_width / 2 + 8 * n)

    label(sheet, '主视图', 0, -(BELOW - 5) * n)
    label(sheet, '俯视图', 0, -dy - g.overall_width / 2 - (BELOW - 5) * n)
    label(sheet, '左视图', dx, -(BELOW - 5) * n)

    sheet.frame()
    sheet.title_block(plan, f'{plan.model} 结构总图')
    extra = [
        ['夹具', (plan.fixture['label'] + '（示意）') if plan.fixture else '无', None, plan.fixture_id or ''],
        ['涂装体系', plan.finish_system['label'], None, '见工艺图'],
    ]
    top = sheet.param_table(plan, sheet.inner[1] + TITLE_H, extra)
    notes = [
        '说明（示意）',
        f'1. 本图由方案 {plan.id} v{plan.version} 自动生成，外形尺寸随方案参数变化，未表达内部结构。',
        f'2. 车长、车宽按车身计，不含激光导航支架（单侧凸出 {fmt(g.protrusion)} mm），括号内为参考尺寸。',
        '3. 激光导航、驱动单元、急停等标品只平移不缩放，位置按三维模型 manifest 推算。',
        '4. 夹具为示意外形，以夹具图为准；未注尺寸单位 mm。',
        '5. 图框、标题栏、图号规则为示意，待卫华图框标准替换。',
    ]
    x = sheet.inner[2] - TITLE_W
    sheet.mtext('\\P'.join(notes), x, top + NOTES_H - 2, h=2.6, width=TITLE_W)
    return doc, {'sheet': size, 'scale': f'1:{n}', 'views': ['主视图', '俯视图', '左视图']}


def _ground(msp, xa, xb):
    msp.add_line((xa, 0), (xb, 0), dxfattribs={'layer': 'THIN'})


def _front(sheet: Sheet, g: AgvGeometry, fix):
    msp = sheet.msp
    L, H = g.L, g.H
    zb = g.body.lo[2]
    box(msp, -L / 2, zb, L / 2, H)
    frame_top = g.classes['frame'].hi[2]
    if (H - frame_top) / sheet.n > 0.6:
        msp.add_line((-L / 2, frame_top), (L / 2, frame_top), dxfattribs={'layer': 'OUTLINE'})
    strip = g.classes.get('strip')
    if strip:
        for z in (strip.lo[2], strip.hi[2]):
            msp.add_line((-L / 2, z), (L / 2, z), dxfattribs={'layer': 'THIN'})
    for name, b in g.parts('laser_end').items():
        box(msp, b.lo[0], b.lo[2], b.hi[0], b.hi[2])
    for name, b in g.parts('laser_side').items():
        if b.center[1] < 0:  # the side facing the viewer
            box(msp, b.lo[0], b.lo[2], b.hi[0], b.hi[2])
    if 'charging' in g.groups and g.groups['charging'].center[1] < 0:
        b = g.groups['charging']
        box(msp, b.lo[0], b.lo[2], b.hi[0], b.hi[2])
    seen = set()
    for name, b in g.parts('drive').items():
        x = round(b.center[0], 3)
        if x in seen:
            continue
        seen.add(x)
        r = min(b.size[0], b.size[2]) / 2
        msp.add_circle((x, r), r, dxfattribs={'layer': 'HIDDEN'})
        centerline(msp, (x, r - r - 3 * sheet.n), (x, r + r + 3 * sheet.n))
    centerline(msp, (0, -4 * sheet.n), (0, H + (fix[2] if fix else 0) + 5 * sheet.n))
    if fix:
        fl, fw, fh, sd, posts = fix
        if posts:
            pw = 80
            box(msp, -fl / 2, H, fl / 2, H + 40)
            for i in range(posts // 2):
                x = -fl / 2 + i * (fl - pw) / max(posts // 2 - 1, 1)
                box(msp, x, H + 40, x + pw, H + fh)
        else:
            poly(msp, [(-fl / 2, H), (fl / 2, H), (fl / 2, H + fh), (-fl / 2, H + fh)])
            msp.add_line((-fl / 2, H + fh - sd), (fl / 2, H + fh - sd), dxfattribs={'layer': 'HIDDEN'})
        _leader(sheet, (fl / 4, H + fh), f'{g.plan.fixture["label"]}（示意）')


def _top(sheet: Sheet, g: AgvGeometry, cy: float):
    msp = sheet.msp
    L, W = g.L, g.W
    box(msp, -L / 2, cy - W / 2, L / 2, cy + W / 2)
    deck = g.classes['deck']
    if min(L / 2 - deck.hi[0], W / 2 - deck.hi[1]) / sheet.n > 0.6:
        box(msp, deck.lo[0], cy + deck.lo[1], deck.hi[0], cy + deck.hi[1], layer='THIN')
    for prefix in ('laser_end', 'laser_side'):
        for b in g.parts(prefix).values():
            box(msp, b.lo[0], cy + b.lo[1], b.hi[0], cy + b.hi[1])
    for b in g.parts('estop').values():
        msp.add_circle((b.center[0], cy + b.center[1]), b.size[0] / 2, dxfattribs={'layer': 'OUTLINE'})
    for b in g.parts('drive').values():
        box(msp, b.lo[0], cy + b.lo[1], b.hi[0], cy + b.hi[1], layer='HIDDEN')
    if 'hmi' in g.groups:
        b = g.groups['hmi']
        box(msp, b.lo[0], cy + b.lo[1], b.hi[0], cy + b.hi[1])
    ext = g.overall_length / 2 + 5 * sheet.n
    centerline(msp, (-ext, cy), (ext, cy))
    centerline(msp, (0, cy - g.overall_width / 2 - 4 * sheet.n), (0, cy + g.overall_width / 2 + 4 * sheet.n))
    # Travel direction arrow inside the body, pointing to the front (+x).
    n = sheet.n
    ax, ay = L / 2 - 30 * n, cy + W / 4
    if ax > 0:
        msp.add_line((ax - 12 * n, ay), (ax, ay), dxfattribs={'layer': 'THIN'})
        poly(msp, [(ax, ay), (ax - 3 * n, ay + 1.2 * n), (ax - 3 * n, ay - 1.2 * n)], layer='THIN')
        label(sheet, '车头', ax - 6 * n, ay + 3 * n, h=2.5)


def _side(sheet: Sheet, g: AgvGeometry, cx: float, fix):
    """Left view: looking at the rear end, horizontal axis is -y."""
    msp = sheet.msp
    W, H = g.W, g.H
    zb = g.body.lo[2]
    box(msp, cx - W / 2, zb, cx + W / 2, H)
    frame_top = g.classes['frame'].hi[2]
    if (H - frame_top) / sheet.n > 0.6:
        msp.add_line((cx - W / 2, frame_top), (cx + W / 2, frame_top), dxfattribs={'layer': 'OUTLINE'})
    for b in g.parts('laser_side').values():
        box(msp, cx - b.hi[1], b.lo[2], cx - b.lo[1], b.hi[2])
    for name, b in g.parts('laser_end').items():
        if b.center[0] < 0:
            box(msp, cx - b.hi[1], b.lo[2], cx - b.lo[1], b.hi[2])
    for b in g.parts('drive').values():
        if b.center[0] < 0:
            box(msp, cx - b.hi[1], 0, cx - b.lo[1], min(b.hi[2], zb + 1), layer='HIDDEN')
    centerline(msp, (cx, -4 * sheet.n), (cx, H + (fix[2] if fix else 0) + 5 * sheet.n))
    if fix:
        fl, fw, fh, sd, posts = fix
        if posts:
            box(msp, cx - fw / 2, H, cx + fw / 2, H + 40)
            for s in (-1, 1):
                x = cx + s * (fw / 2 - 40)
                box(msp, x - 40, H + 40, x + 40, H + fh)
        else:
            poly(msp, [(cx - fw / 2, H), (cx + fw / 2, H), (cx + fw / 2, H + fh), (cx + fw * 0.3, H + fh),
                       (cx, H + fh - sd), (cx - fw * 0.3, H + fh), (cx - fw / 2, H + fh)])


def _leader(sheet: Sheet, at, text):
    n = sheet.n
    x, y = at
    tx, ty = x + 10 * n, y + 8 * n
    sheet.msp.add_line((x, y), (tx, ty), dxfattribs={'layer': 'THIN'})
    sheet.msp.add_line((tx, ty), (tx + len(text) * 2.6 * n, ty), dxfattribs={'layer': 'THIN'})
    px, py = sheet.paper(tx, ty)
    sheet.text(text, px + 1, py + 2.2, h=2.6)


def _dims(sheet: Sheet, g: AgvGeometry, dx: float, dy: float, fix):
    n = sheet.n
    L, W, H = g.L, g.W, g.H
    zb = g.body.lo[2]
    OL, OW = g.overall_length, g.overall_width
    # Front view: length, overall length, height.
    sheet.dim((-L / 2, zb), (L / 2, zb), (0, -10 * n), param='length', value=L)
    lasers = list(g.parts('laser_end').values())
    if lasers and OL > L:
        lo = min(lasers, key=lambda b: b.lo[0])
        hi = max(lasers, key=lambda b: b.hi[0])
        sheet.dim((lo.lo[0], lo.lo[2]), (hi.hi[0], hi.lo[2]), (0, -20 * n), text='(<>)', param='overall_length',
                  value=OL, role='reference')
    sheet.dim((-L / 2, 0), (-L / 2, H), (-OL / 2 - 12 * n, 0), angle=90, param='height', value=H)
    if fix:
        sheet.dim((-fix[0] / 2, 0), (-fix[0] / 2, H + fix[2]), (-OL / 2 - 22 * n, 0), angle=90, text='(<>)',
                  param='height_with_fixture', value=H + fix[2], role='reference')
    # Top view: width, overall width, wheelbase, track.
    cy = -dy
    sheet.dim((-L / 2, cy - W / 2), (-L / 2, cy + W / 2), (-OL / 2 - 12 * n, cy), angle=90, param='width', value=W)
    sides = list(g.parts('laser_side').values())
    if sides and OW > W:
        lo = min(sides, key=lambda b: b.lo[1])
        hi = max(sides, key=lambda b: b.hi[1])
        sheet.dim((lo.lo[0], cy + lo.lo[1]), (hi.lo[0], cy + hi.hi[1]), (-OL / 2 - 22 * n, cy), angle=90,
                  text='(<>)', param='overall_width', value=OW, role='reference')
    drives = sorted(g.parts('drive').values(), key=lambda b: b.center[0])
    if len(drives) >= 2:
        a, b = drives[0], drives[-1]
        sheet.dim((a.center[0], cy + a.lo[1]), (b.center[0], cy + b.lo[1]), (0, cy - OW / 2 - 12 * n),
                  param='wheelbase', value=g.wheelbase, role='derived')
        ys = sorted(drives, key=lambda d: d.center[1])
        sheet.dim((ys[-1].hi[0], cy + ys[0].center[1]), (ys[-1].hi[0], cy + ys[-1].center[1]),
                  (OL / 2 + 10 * n, cy), angle=90, param='track', value=g.track, role='derived')
    # Side view: width again, and the fixture outline.
    sheet.dim((dx - W / 2, zb), (dx + W / 2, zb), (dx, -10 * n), param='width', value=W)
    if fix:
        fw = fix[1]
        sheet.dim((dx - fw / 2, H + fix[2]), (dx + fw / 2, H + fix[2]), (dx, H + fix[2] + 8 * n), text='(<>)',
                  param='fixture_width', value=fw, role='reference')
