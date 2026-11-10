"""Double-girder overhead crane general drawing: elevation, left view, plan and girder section A-A."""
from __future__ import annotations

import math

from ezdxf.enums import TextEntityAlignment

from cad import (Sheet, SHEETS, BINDING, TITLE_W, TITLE_H, PARAM_ROW_H, SCALES, box, centerline, choose, label,
                 new_doc, poly)
from geometry import CraneGeometry
from plan import Plan, fmt

LEFT, RIGHT, BELOW, TOP_GAP = 34, 26, 36, 32
NOTES_W, NOTES_H = 230, 40
RAIL_EXT = 1000        # runway rail drawn past the end beam, mm
WALKWAY = 800          # 走台宽（示意）
WEB_INSET = 20         # 腹板外侧到翼缘边的距离（示意）


def _detail_scale(g: CraneGeometry, n: int) -> int:
    for nd in SCALES:
        if g.gh / nd <= 60 and nd < n:
            return nd
    return n


def _layout(g: CraneGeometry, plan: Plan, size: str, n: int):
    W, H, c = SHEETS[size]
    x0, y0, x1, y1 = BINDING, c, W - c, H - c
    elev_w, elev_h = (g.S + g.ew) / n, g.trolley_top / n
    side_w = (g.end_len + 2 * RAIL_EXT) / n
    plan_h = (g.end_len + 2 * RAIL_EXT) / n
    table_h = TITLE_H + (len(plan.params) + 3) * PARAM_ROW_H
    nd = _detail_scale(g, n)
    det_w, det_h = max(g.gw / nd + 40, 56), g.gh / nd + 42

    cx = math.ceil(x0 + 3 + LEFT + g.ew / 2 / n)
    ground = math.floor(y1 - TOP_GAP - elev_h)
    plan_cy = math.floor(ground - BELOW - 10 - plan_h / 2)
    left_right = cx + elev_w - g.ew / 2 / n + RIGHT
    side_cx = math.ceil(left_right + 14 + side_w / 2)
    plan_bottom = plan_cy - plan_h / 2 - BELOW
    stack_left = x1 - TITLE_W
    notes_below_plan = plan_bottom - (y0 + 4) >= NOTES_H and x0 + 4 + NOTES_W <= stack_left - 6
    stack_h = table_h + (0 if notes_below_plan else NOTES_H)
    side_bottom = ground - BELOW
    det_cx = (left_right + stack_left) / 2
    det_top = side_bottom - 6
    ok = (
        plan_bottom >= y0 + 2
        and left_right <= stack_left - 6 - det_w                    # room for the section between
        and side_cx + side_w / 2 + RIGHT <= x1 - 2
        and side_bottom >= y0 + stack_h + 4
        and det_top - det_h >= y0 + 4
        and nd < n
    )
    return ok, dict(cx=cx, ground=ground, plan_cy=plan_cy, side_cx=side_cx, nd=nd, det_cx=det_cx,
                    det_top=det_top, notes_below_plan=notes_below_plan, plan_bottom=plan_bottom)


def draw(plan: Plan):
    g = CraneGeometry(plan)
    size, n = choose(lambda s, k: _layout(g, plan, s, k)[0], sizes=('A2', 'A1'))
    _, L = _layout(g, plan, size, n)
    doc = new_doc(plan)
    sheet = Sheet(doc, size, n, origin=(L['cx'], L['ground']))
    dy = (L['ground'] - L['plan_cy']) * n
    dx = (L['side_cx'] - L['cx']) * n

    _elevation(sheet, g)
    _side(sheet, g, dx)
    _plan(sheet, g, -dy)
    k = n / L['nd']
    det_origin = sheet.m(L['det_cx'], L['det_top'] - 14 - g.gh / L['nd'])
    det_origin = (round(det_origin[0]), round(det_origin[1]))
    _section(sheet, g, det_origin, k, L['nd'])

    label(sheet, '主视图', g.S / 2, -(BELOW - 5) * n)
    label(sheet, '左视图', dx, -(BELOW - 5) * n)
    label(sheet, '俯视图', g.S / 2, -dy - (g.end_len / 2 + RAIL_EXT) - (BELOW - 5) * n)

    sheet.frame()
    sheet.title_block(plan, '双梁桥式起重机总图')
    extra = [['吊具', (plan.fixture['label'] if plan.fixture else '吊钩') + '（示意）', None, plan.fixture_id or 'hook'],
             ['涂装体系', plan.finish_system['label'], None, '见工艺图']]
    top = sheet.param_table(plan, sheet.inner[1] + TITLE_H, extra)
    notes = [
        '说明（示意）',
        f'1. 本图由方案 {plan.id} v{plan.version} 自动生成。起重机尚无真实模型，方案参数以外的尺寸均为示意。',
        '2. 跨度为大车轨道中心距；起升高度自地面 ±0.000 起至吊钩上极限位置。',
        '3. 轨面标高、端梁长度、轨面以上高度为按示意比例推算的派生尺寸，括号内为参考尺寸。',
        '4. 主梁为箱形截面，板厚为示意，强度、刚度须按卫华设计手册校核。',
        '5. 图框、标题栏、图号规则为示意，待卫华图框标准替换；未注尺寸单位 mm。',
    ]
    if L['notes_below_plan']:
        nx, ny = sheet.inner[0] + 4, sheet.inner[1] + 4 + NOTES_H - 2
    else:
        nx, ny = sheet.inner[2] - TITLE_W, top + NOTES_H - 2
    sheet.mtext('\\P'.join(notes), nx, ny, h=2.6, width=NOTES_W)
    return doc, {'sheet': size, 'scale': f'1:{n}', 'detail_scale': f'1:{L["nd"]}',
                 'views': ['主视图', '左视图', '俯视图', 'A-A 主梁截面']}


def _elev_marker(sheet: Sheet, x, y, text, left=True):
    """Elevation symbol: small triangle on the level line with the value next to it."""
    n = sheet.n
    poly(sheet.msp, [(x, y), (x - 1.5 * n, y + 2.5 * n), (x + 1.5 * n, y + 2.5 * n)], layer='THIN')
    sheet.msp.add_line((x - 1.5 * n, y + 2.5 * n), (x + (-14 if left else 14) * n, y + 2.5 * n),
                       dxfattribs={'layer': 'THIN'})
    px, py = sheet.paper(x + (-13.5 if left else 2) * n, y + 4.2 * n)
    sheet.text(text, px, py, h=2.6)


def _hook(sheet: Sheet, g: CraneGeometry, x: float):
    msp = sheet.msp
    bh, bw, H = g.hook_block_h, g.hook_block_w, g.Hlift
    if g.hook_kind == 'magnet':
        box(msp, x - bw / 2, H, x + bw / 2, H + 0.35 * bh)
        for s in (-1, 1):
            msp.add_line((x + s * bw / 2 * 0.8, H + 0.35 * bh), (x, H + 0.75 * bh), dxfattribs={'layer': 'OUTLINE'})
        box(msp, x - 200, H + 0.75 * bh, x + 200, H + bh)
        return
    box(msp, x - bw / 2, H + 0.45 * bh, x + bw / 2, H + bh)                 # sheave block
    r = min(180, bh * 0.16)
    msp.add_line((x + r, H + r), (x + r, H + 0.45 * bh), dxfattribs={'layer': 'OUTLINE'})  # shank
    msp.add_arc((x, H + r), r, 180, 360, dxfattribs={'layer': 'OUTLINE'})   # saddle at the lift height
    msp.add_line((x - r, H + r), (x - r, H + 1.6 * r), dxfattribs={'layer': 'OUTLINE'})  # tip


def _elevation(sheet: Sheet, g: CraneGeometry):
    msp, n = sheet.msp, sheet.n
    S, ew = g.S, g.ew
    for xc in (0, S):
        box(msp, xc - ew / 2, g.end_bottom, xc + ew / 2, g.end_top)                       # end beam, end on
        box(msp, xc - 75, g.rail_top, xc + 75, g.end_bottom, layer='OUTLINE')              # wheel, edge on
        box(msp, xc - 40, g.rail_top - g.RAIL_H, xc + 40, g.rail_top, layer='OUTLINE')    # runway rail
        box(msp, xc - 250, g.rail_top - g.RAIL_H - 900, xc + 250, g.rail_top - g.RAIL_H, layer='THIN')
        centerline(msp, (xc, -4 * n), (xc, g.trolley_top + 4 * n))
    # Main girder with tapered ends.
    a, b = ew / 2, S - ew / 2
    t = g.taper
    top, bot, end_bot = g.girder_top, g.girder_bottom, g.girder_top - g.girder_end_h
    poly(msp, [(a, top), (b, top), (b, end_bot), (b - 300, end_bot), (S - t, bot), (t, bot), (a + 300, end_bot),
               (a, end_bot)])
    msp.add_line((a, top + g.TROLLEY_RAIL_H), (b, top + g.TROLLEY_RAIL_H), dxfattribs={'layer': 'OUTLINE'})
    # Trolley at mid-span, ropes and hook.
    xm = S / 2
    tl = g.TROLLEY_LEN
    box(msp, xm - tl / 2, top + g.TROLLEY_RAIL_H, xm + tl / 2, g.trolley_top)
    for s in (-1, 1):
        msp.add_circle((xm + s * (tl / 2 - 350), top + g.TROLLEY_RAIL_H + 150), 150, dxfattribs={'layer': 'HIDDEN'})
    for s in (-1, 1):
        msp.add_line((xm + s * 120, bot), (xm + s * 120, g.Hlift + g.hook_block_h), dxfattribs={'layer': 'OUTLINE'})
    _hook(sheet, g, xm)
    centerline(msp, (xm, -4 * n), (xm, g.trolley_top + 4 * n))
    # Ground.
    msp.add_line((-ew / 2 - 10 * n, 0), (S + ew / 2 + 10 * n, 0), dxfattribs={'layer': 'THIN'})
    _elev_marker(sheet, S + ew / 2 + 6 * n, 0, '±0.000', left=False)
    # Section mark A-A at a quarter span.
    xa = round(S / 4)
    for y0, y1 in ((top + 2 * n, top + 7 * n), (bot - 7 * n, bot - 2 * n)):
        msp.add_line((xa, y0), (xa, y1), dxfattribs={'layer': 'OUTLINE', 'lineweight': 70})
    for y in (top + 9.5 * n, bot - 9.5 * n):
        px, py = sheet.paper(xa, y)
        sheet.text('A', px, py, h=4, align=TextEntityAlignment.MIDDLE_CENTER)
    # Dimensions.
    sheet.dim((0, 0), (S, 0), (0, -12 * n), param='span', value=S)
    sheet.dim((S + ew / 2, 0), (-ew / 2, 0), (0, -22 * n), text='(<>)', param='overall_width', value=S + ew,
              role='reference')
    hx = xm + max(tl, g.hook_block_w) / 2 + 12 * n
    sheet.dim((xm, 0), (xm, g.Hlift), (hx, 0), angle=90, param='lift_height', value=g.Hlift)
    sheet.dim((-ew / 2, 0), (-ew / 2, g.rail_top), (-ew / 2 - 14 * n, 0), angle=90, text='轨面标高 (<>)',
              param='rail_top', value=g.rail_top, role='derived')
    sheet.dim((S + ew / 2, g.rail_top), (S + ew / 2, g.trolley_top), (S + ew / 2 + 14 * n, 0), angle=90,
              text='(<>)', param='height_above_rail', value=g.height_above_rail, role='derived')


def _side(sheet: Sheet, g: CraneGeometry, dx: float):
    """Left view, looking along the span: runway direction is horizontal."""
    msp, n = sheet.msp, sheet.n
    el, wb = g.end_len, g.wheelbase
    msp.add_line((dx - el / 2 - RAIL_EXT, 0), (dx + el / 2 + RAIL_EXT, 0), dxfattribs={'layer': 'THIN'})
    box(msp, dx - el / 2 - RAIL_EXT, g.rail_top - g.RAIL_H, dx + el / 2 + RAIL_EXT, g.rail_top)
    box(msp, dx - el / 2 - RAIL_EXT, g.rail_top - g.RAIL_H - 900, dx + el / 2 + RAIL_EXT, g.rail_top - g.RAIL_H,
        layer='THIN')
    box(msp, dx - el / 2, g.end_bottom, dx + el / 2, g.end_top)
    for s in (-1, 1):
        x = dx + s * wb / 2
        msp.add_circle((x, g.wheel_center), g.WHEEL_D / 2, dxfattribs={'layer': 'HIDDEN'})
        centerline(msp, (x, g.wheel_center - g.WHEEL_D / 2 - 3 * n), (x, g.end_top + 3 * n))
    for zc in g.girder_z:
        x = dx + zc
        x0, x1 = x - g.gw / 2, x + g.gw / 2
        # Visible below the end beam, hidden behind it.
        poly(msp, [(x0, g.end_bottom), (x0, g.girder_bottom), (x1, g.girder_bottom), (x1, g.end_bottom)], close=False)
        poly(msp, [(x0, g.end_bottom), (x0, g.end_top), (x1, g.end_top), (x1, g.end_bottom)], layer='HIDDEN',
             close=False)
        box(msp, x - 35, g.girder_top, x + 35, g.girder_top + g.TROLLEY_RAIL_H)
        centerline(msp, (x, g.girder_bottom - 3 * n), (x, g.trolley_top + 3 * n))
    half = g.gauge / 2 + g.gw / 2 + 150
    box(msp, dx - half, g.girder_top + g.TROLLEY_RAIL_H, dx + half, g.trolley_top)
    _hook(sheet, g, dx)
    centerline(msp, (dx, -4 * n), (dx, g.trolley_top + 4 * n))
    # Dimensions.
    g0, g1 = dx - g.gauge / 2, dx + g.gauge / 2
    sheet.dim((g0, g.trolley_top), (g1, g.trolley_top), (dx, g.trolley_top + 8 * n), param='trolley_gauge',
              value=g.gauge)
    # Above the trolley, so the extension lines stay short and clear of the hook.
    sheet.dim((dx - wb / 2, g.end_top), (dx + wb / 2, g.end_top), (dx, g.trolley_top + 16 * n), param='wheelbase',
              value=wb)
    sheet.dim((dx - el / 2, g.end_top), (dx + el / 2, g.end_top), (dx, g.trolley_top + 24 * n), text='(<>)',
              param='end_beam_length', value=el, role='derived')
    xr = dx + el / 2
    sheet.dim((xr, g.end_bottom), (xr, g.end_top), (xr + RAIL_EXT + 8 * n, 0), angle=90, param='end_beam_height',
              value=g.eh)
    xl = dx - g.gauge / 2 - g.gw / 2
    sheet.dim((xl, g.girder_bottom), (xl, g.girder_top), (dx - el / 2 - RAIL_EXT - 8 * n, 0), angle=90,
              param='girder_height', value=g.gh)


def _plan(sheet: Sheet, g: CraneGeometry, cy: float):
    msp, n = sheet.msp, sheet.n
    S, ew, el = g.S, g.ew, g.end_len
    ext = el / 2 + RAIL_EXT
    for xc in (0, S):
        for s in (-1, 1):
            msp.add_line((xc + s * 40, cy - ext), (xc + s * 40, cy + ext), dxfattribs={'layer': 'THIN'})
        centerline(msp, (xc, cy - ext - 3 * n), (xc, cy + ext + 3 * n))
        box(msp, xc - ew / 2, cy - el / 2, xc + ew / 2, cy + el / 2)
        for s in (-1, 1):
            z = cy + s * g.wheelbase / 2
            box(msp, xc - 75, z - g.WHEEL_D / 2, xc + 75, z + g.WHEEL_D / 2, layer='HIDDEN')
    for zc in g.girder_z:
        box(msp, ew / 2, cy + zc - g.gw / 2, S - ew / 2, cy + zc + g.gw / 2)
        centerline(msp, (ew / 2 - 3 * n, cy + zc), (S - ew / 2 + 3 * n, cy + zc))
    zw = g.gauge / 2 + g.gw / 2
    box(msp, ew / 2, cy + zw, S - ew / 2, cy + zw + WALKWAY, layer='THIN')        # walkway
    px, py = sheet.paper(S * 0.7, cy + zw + WALKWAY / 2)
    sheet.text('走台（示意）', px, py, h=2.5, align=TextEntityAlignment.MIDDLE_CENTER)
    xm, tl = S / 2, g.TROLLEY_LEN
    half = g.gauge / 2 + g.gw / 2 + 150
    box(msp, xm - tl / 2, cy - half, xm + tl / 2, cy + half)
    centerline(msp, (xm, cy - ext), (xm, cy + ext))
    centerline(msp, (-ew / 2 - 4 * n, cy), (S + ew / 2 + 4 * n, cy))
    # Dimensions.
    sheet.dim((S - ew / 2, cy - g.gauge / 2), (S - ew / 2, cy + g.gauge / 2), (S + ew / 2 + 12 * n, cy), angle=90,
              param='trolley_gauge', value=g.gauge)
    sheet.dim((-ew / 2, cy - el / 2), (ew / 2, cy - el / 2), (0, cy - ext - 8 * n), param='end_beam_width',
              value=ew, location=(ew / 2 + 9 * n, cy - ext - 6.5 * n))


def _section(sheet: Sheet, g: CraneGeometry, origin, k: float, nd: int):
    """Box girder section A-A, drawn k times larger than the sheet scale."""
    msp, n = sheet.msp, sheet.n
    ox, oy = origin
    b, h, tf, tw = g.gw, g.gh, g.tf, g.tw
    P = lambda x, y: (ox + x * k, oy + y * k)  # noqa: E731
    plates = [
        [(-b / 2, h - tf), (b / 2, h - tf), (b / 2, h), (-b / 2, h)],
        [(-b / 2, 0), (b / 2, 0), (b / 2, tf), (-b / 2, tf)],
    ]
    for s in (-1, 1):
        xo = s * (b / 2 - WEB_INSET)
        xi = xo - s * tw
        plates.append([(min(xo, xi), tf), (max(xo, xi), tf), (max(xo, xi), h - tf), (min(xo, xi), h - tf)])
    for pts in plates:
        poly(msp, [P(*p) for p in pts])
        hatch = msp.add_hatch(color=256, dxfattribs={'layer': 'THIN'})
        hatch.set_pattern_fill('ANSI31', scale=n * 0.08)
        hatch.paths.add_polyline_path([P(*p) for p in pts], is_closed=True)
    box(msp, *P(-35, h), *P(35, h + g.TROLLEY_RAIL_H), layer='THIN')
    centerline(msp, P(0, -40), P(0, h + g.TROLLEY_RAIL_H + 40))
    lf = 1 / k
    sheet.dim(P(-b / 2, 0), P(b / 2, 0), (ox, oy - 8 * n), param='girder_width', value=b, lfac=lf)
    sheet.dim(P(-b / 2, 0), P(-b / 2, h), (ox - b / 2 * k - 8 * n, oy), angle=90, param='girder_height', value=h,
              lfac=lf)
    sheet.dim(P(b / 2, h - tf), P(b / 2, h), (ox + b / 2 * k + 7 * n, oy), angle=90, param='girder_flange_t',
              value=tf, lfac=lf)
    xo = b / 2 - WEB_INSET
    sheet.dim(P(xo - tw, h * 0.55), P(xo, h * 0.55), P(0, h * 0.55), param='girder_web_t', value=tw, lfac=lf,
              location=(ox + b / 2 * k + 7 * n, oy + h * 0.55 * k))
    px, py = sheet.paper(ox, oy - 17 * n)
    sheet.text(f'A-A  主梁截面（1:{nd}）', px, py, h=3.5, align=TextEntityAlignment.MIDDLE_CENTER)
