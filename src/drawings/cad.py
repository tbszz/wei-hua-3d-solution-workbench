"""Shared DXF plumbing: layers, text and dimension styles, sheet frame, title block, tables.

Everything is drawn in model space at 1:1 millimetres. The frame is drawn n times larger for a
1:n sheet, which keeps every dimension equal to the real size. Sheet positions are written in paper
millimetres and converted with Sheet.m().
"""
from __future__ import annotations

import ezdxf
from ezdxf.enums import TextEntityAlignment, MTextEntityAlignment

from plan import Plan, fmt, rel

APPID = 'WEIHUA_DRAW'
FONT = 'simhei.ttf'
SCALES = [5, 10, 15, 20, 25, 30, 40, 50, 60, 100, 150, 200, 250, 300, 400, 500]
SHEETS = {'A3': (420, 297, 5), 'A2': (594, 420, 10), 'A1': (841, 594, 10)}  # width, height, margin c
BINDING = 25  # GB/T 14689 装订边 a
TITLE_W, TITLE_H = 180, 56
PARAM_ROW_H = 6

# name: (aci colour, linetype, lineweight in 1/100 mm, description)
LAYERS = {
    'OUTLINE': (7, 'Continuous', 50, '轮廓（粗实线）'),
    'HIDDEN': (6, 'DASHED', 25, '不可见轮廓（虚线）'),
    'CENTER': (1, 'CENTER', 18, '中心线（点画线）'),
    'DIM': (3, 'Continuous', 18, '尺寸'),
    'TEXT': (7, 'Continuous', 18, '文字'),
    'FRAME': (7, 'Continuous', 35, '图框和标题栏'),
    'THIN': (8, 'Continuous', 18, '细实线：地面、剖面线、引线'),
    'STAMP': (1, 'Continuous', 35, '“示意”标记'),
}


def new_doc(plan: Plan) -> ezdxf.document.Drawing:
    doc = ezdxf.new('R2018', setup=True)
    doc.units = ezdxf.units.MM
    doc.header['$MEASUREMENT'] = 1
    doc.header['$INSUNITS'] = 4
    for name, (color, linetype, lw, desc) in LAYERS.items():
        layer = doc.layers.add(name, color=color, linetype=linetype, lineweight=lw)
        layer.description = desc
    doc.styles.add('WH_CN', font=FONT)
    doc.appids.add(APPID)
    custom = doc.header.custom_vars
    custom.append('方案', f'{plan.id} v{plan.version}')
    custom.append('产品', f'{plan.product_id} {plan.model}')
    for p in plan.params.values():
        custom.append(p.key, fmt(p.value))
    custom.append('状态', '示意，非生产图纸')
    return doc


class Sheet:
    """A frame of the given size at scale 1:n. origin is the paper point where model (0, 0) lies."""

    def __init__(self, doc, size: str, n: int, origin: tuple[float, float]):
        self.doc, self.msp, self.size, self.n = doc, doc.modelspace(), size, n
        self.W, self.H, self.c = SHEETS[size]
        self.ox, self.oy = origin
        self.inner = (BINDING, self.c, self.W - self.c, self.H - self.c)
        doc.header['$LTSCALE'] = n * 4
        doc.header['$DIMSCALE'] = n
        self.dimstyle = f'WH_1_{n}'
        if self.dimstyle not in doc.dimstyles:
            doc.dimstyles.new(self.dimstyle, dxfattribs=dict(
                dimtxsty='WH_CN', dimtxt=3.0, dimasz=2.5, dimexe=2.0, dimexo=1.5, dimgap=1.0, dimdec=1,
                dimzin=8, dimdsep=ord('.'), dimtad=1, dimjust=0, dimtih=0, dimtoh=0, dimscale=n, dimclrd=256, dimclre=256,
                dimclrt=256, dimlfac=1.0, dimblk='', dimtix=0, dimtofl=1))

    # -- coordinates -------------------------------------------------------------------------
    def m(self, x: float, y: float) -> tuple[float, float]:
        """Paper millimetres to model millimetres."""
        return ((x - self.ox) * self.n, (y - self.oy) * self.n)

    def paper(self, x: float, y: float) -> tuple[float, float]:
        return (x / self.n + self.ox, y / self.n + self.oy)

    # -- primitives in paper units -----------------------------------------------------------
    def line(self, a, b, layer='FRAME'):
        self.msp.add_line(self.m(*a), self.m(*b), dxfattribs={'layer': layer})

    def rect(self, x0, y0, x1, y1, layer='FRAME'):
        pts = [self.m(x0, y0), self.m(x1, y0), self.m(x1, y1), self.m(x0, y1)]
        self.msp.add_lwpolyline(pts, close=True, dxfattribs={'layer': layer})

    def text(self, s, x, y, h=3.5, align=TextEntityAlignment.MIDDLE_LEFT, layer='TEXT', color=None):
        attrs = {'layer': layer, 'style': 'WH_CN', 'height': h * self.n}
        if color is not None:
            attrs['color'] = color
        t = self.msp.add_text(str(s), dxfattribs=attrs)
        t.set_placement(self.m(x, y), align=align)
        return t

    def mtext(self, s, x, y, h=3.0, width=None, layer='TEXT'):
        attrs = {'layer': layer, 'style': 'WH_CN', 'char_height': h * self.n,
                 'attachment_point': MTextEntityAlignment.TOP_LEFT, 'line_spacing_factor': 1.25}
        if width:
            attrs['width'] = width * self.n
        t = self.msp.add_mtext(s, dxfattribs=attrs)
        t.dxf.insert = self.m(x, y)
        return t

    # -- frame ---------------------------------------------------------------------------------
    def frame(self):
        self.rect(0, 0, self.W, self.H, layer='THIN')
        self.rect(*self.inner, layer='FRAME')
        # Centring marks on the four sides (GB/T 14689 对中符号).
        x0, y0, x1, y1 = self.inner
        for a, b in [((self.W / 2, 0), (self.W / 2, y0 + 5)), ((self.W / 2, self.H), (self.W / 2, y1 - 5)),
                     ((0, self.H / 2), (x0 + 5, self.H / 2)), ((self.W, self.H / 2), (x1 - 5, self.H / 2))]:
            self.line(a, b)
        # “示意” stamp, top-left, so nobody mistakes the sheet for a released drawing.
        sx, sy = x0 + 6, y1 - 6
        self.rect(sx, sy - 16, sx + 92, sy, layer='STAMP')
        self.text('示 意', sx + 4, sy - 8, h=9, layer='STAMP')
        self.text('方案阶段自动出图', sx + 40, sy - 5, h=3.5, layer='STAMP')
        self.text('不得直接用于生产', sx + 40, sy - 11.5, h=3.5, layer='STAMP')

    def table(self, x, y_top, widths, rows, row_h=7.0, h=3.0):
        """Grid with text, top-left at (x, y_top) in paper mm. A None cell merges into the cell on
        its left. Returns the bottom y."""
        total = sum(widths)
        y = y_top
        self.line((x, y), (x + total, y))
        for row in rows:
            y_next = y - row_h
            self.line((x, y_next), (x + total, y_next))
            cx = x
            for i, (w, cell) in enumerate(zip(widths, row)):
                if i > 0 and cell is not None:
                    self.line((cx, y), (cx, y_next))
                if cell:
                    self.text(cell, cx + 1.5, (y + y_next) / 2, h=h)
                cx += w
            y = y_next
        self.line((x, y_top), (x, y))
        self.line((x + total, y_top), (x + total, y))
        return y

    def title_block(self, plan: Plan, title: str):
        """Simplified GB/T 10609.1 title block, 180 x 56, at the inner bottom-right corner."""
        x1, y0 = self.inner[2], self.inner[1]
        x = x1 - TITLE_W
        rows = [
            ['项目', plan.project, '客户', plan.customer or '—'],
            ['方案', f'{plan.id} v{plan.version}', '图号', plan.drawing_no],
            ['产品', plan.model, '比例', f'1:{self.n}'],
            ['图名', title, '图幅', self.size],
            ['日期', plan.date, '设计', plan.drawn_by],
            ['标准', '图框示意，待卫华图框标准', '审核', '待人工确认'],
            ['单位', '卫华集团（示意）', '状态', '示意 · 非生产图纸'],
        ]
        self.table(x, y0 + TITLE_H, [16, 74, 16, 74], rows, row_h=8, h=3.0)
        self.rect(x, y0, x1, y0 + TITLE_H)

    def param_table(self, plan: Plan, y_bottom: float, extra_rows=()) -> float:
        """Parameter list right above the title block. Returns its top y."""
        src = {'plan': '方案', 'nominal': '额定', 'derived': '派生'}
        rows = [['参数', '取值', '允许范围', '来源']]
        for p in plan.params.values():
            unit = f' {p.unit}' if p.unit else ''
            rows.append([p.label, f'{fmt(p.value)}{unit}', f'{p.range_text()}{unit}', src[p.source]])
        rows.extend(extra_rows)
        rows.append(['参数表来源', rel(plan.config_path), None, None])
        top = y_bottom + PARAM_ROW_H * len(rows)
        x = self.inner[2] - TITLE_W
        self.table(x, top, [36, 44, 50, 50], rows, row_h=PARAM_ROW_H, h=2.8)
        return top

    # -- dimensions in model units ------------------------------------------------------------
    def dim(self, p1, p2, base, angle=0, *, param=None, value=None, role='param', text=None, lfac=None,
            location=None):
        """Linear dimension in model coordinates. param tags it with the plan parameter it shows."""
        override = {}
        if lfac is not None:
            override['dimlfac'] = lfac
        kw = {}
        if text is not None:
            kw['text'] = text
        if location is None and value is not None:
            location = self._outside(p1, p2, base, angle, text, value)
        if location is not None:
            kw['location'] = location
        d = self.msp.add_linear_dim(base=base, p1=p1, p2=p2, angle=angle, dimstyle=self.dimstyle,
                                    override=override, dxfattribs={'layer': 'DIM'}, **kw)
        d.render()
        if param is not None:
            d.dimension.set_xdata(APPID, [(1000, role), (1000, param), (1040, float(value))])
        return d.dimension

    def _outside(self, p1, p2, base, angle, text, value):
        """Text position past the p2 end when the text would not fit between the extension lines."""
        shown = (text or '<>').replace('<>', fmt(value))
        text_len = sum(3.0 if ord(ch) > 0x2E80 else 2.1 for ch in shown)  # paper mm, dimtxt 3.0
        axis = 1 if angle == 90 else 0
        lo, hi = sorted((p1[axis], p2[axis]))
        if (hi - lo) / self.n >= text_len + 4:
            return None
        along = hi + (text_len / 2 + 3) * self.n
        return (base[0], along) if axis == 1 else (along, base[1])


def label(sheet: Sheet, s: str, x_model: float, y_model: float, h=5.0):
    """View title centred under or over a view, positioned in model units."""
    px, py = sheet.paper(x_model, y_model)
    sheet.text(s, px, py, h=h, align=TextEntityAlignment.MIDDLE_CENTER)


def mtext_model(sheet: Sheet, s: str, x_model: float, y_model: float, h=2.5):
    px, py = sheet.paper(x_model, y_model)
    return sheet.text(s, px, py, h=h, align=TextEntityAlignment.MIDDLE_CENTER)


def poly(msp, pts, layer='OUTLINE', close=True):
    return msp.add_lwpolyline(pts, close=close, dxfattribs={'layer': layer})


def box(msp, x0, y0, x1, y1, layer='OUTLINE'):
    return poly(msp, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], layer)


def centerline(msp, a, b):
    msp.add_line(a, b, dxfattribs={'layer': 'CENTER'})


def choose(fits, sizes=('A3', 'A2', 'A1')):
    """First (sheet, scale) for which fits(size, n) is true, smallest sheet then largest scale."""
    for size in sizes:
        for n in SCALES:
            if fits(size, n):
                return size, n
    raise ValueError('产品太大，A1 图幅 1:500 也放不下')
