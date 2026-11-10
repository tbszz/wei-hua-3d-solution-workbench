"""DXF to PNG with ezdxf's matplotlib backend, for eyeballing the layout."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from ezdxf.addons.drawing import Frontend, RenderContext  # noqa: E402
from ezdxf.addons.drawing.config import BackgroundPolicy, Configuration, LineweightPolicy  # noqa: E402
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend  # noqa: E402


def dxf_to_png(doc, png: Path, width_px: int = 3300) -> Path:
    msp = doc.modelspace()
    extents = [e for e in msp if e.dxf.layer == 'THIN' and e.dxftype() == 'LWPOLYLINE']
    fig = plt.figure()
    ax = fig.add_axes([0, 0, 1, 1])
    config = Configuration(background_policy=BackgroundPolicy.WHITE,
                           lineweight_policy=LineweightPolicy.ABSOLUTE, lineweight_scaling=1.0)
    Frontend(RenderContext(doc), MatplotlibBackend(ax), config=config).draw_layout(msp, finalize=True)
    ax.set_axis_off()
    x0, x1 = ax.get_xlim()
    y0, y1 = ax.get_ylim()
    aspect = (y1 - y0) / (x1 - x0)
    fig.set_size_inches(width_px / 300, width_px / 300 * aspect)
    png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(png, dpi=300, facecolor='white')
    plt.close(fig)
    return png
