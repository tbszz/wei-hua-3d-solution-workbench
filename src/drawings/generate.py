"""出图下发原型（功能流程第 7 步）：方案 JSON → 结构总图 DXF + 涂装与标识工艺图 SVG/PDF。

    python src/drawings/generate.py src/drawings/examples/agv1-long.json out/
    python src/drawings/generate.py plan.json out/ --png      # 另出 PNG 预览

输出在 <out>/<方案 id>/ 下：structure.dxf、process.svg、process.pdf、manifest.json，
加 --png 时还有 structure.png、process.png。方案参数超出范围时打印原因并以退出码 2 结束。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from plan import Plan, PlanError, fmt, load_plan, rel  # noqa: E402

DISCLAIMER = '示意：方案阶段自动出图，图框、色号、涂层体系、标识尺寸均为示意值，不得直接用于生产。'


def export_drawings(plan_in, out_dir: Path, png: bool = False) -> dict:
    """Generate every drawing for one plan. plan_in is a path or a dict. Returns the manifest.

    This is the function an Agent tool (export_drawings) would wrap."""
    import process
    plan: Plan = load_plan(plan_in)
    target = Path(out_dir) / plan.id
    target.mkdir(parents=True, exist_ok=True)

    if plan.category == 'crane':
        import crane_dxf as structure
    else:
        import agv_dxf as structure
    doc, info = structure.draw(plan)
    dxf_path = target / 'structure.dxf'
    doc.saveas(dxf_path)
    files = {'structure_dxf': dxf_path}
    if png:
        from preview import dxf_to_png
        files['structure_png'] = dxf_to_png(doc, target / 'structure.png')

    proc = process.draw(plan, target / 'process', png=png)
    for ext, path in proc.pop('files').items():
        files[f'process_{ext}'] = path

    manifest = {
        'plan': {'id': plan.id, 'version': plan.version, 'project': plan.project, 'date': plan.date},
        'product': {'id': plan.product_id, 'model': plan.model, 'category': plan.category,
                    'config': rel(plan.config_path)},
        'drawing_no': plan.drawing_no,
        'params': {k: {'label': p.label, 'value': p.value, 'unit': p.unit, 'range': [p.min, p.max],
                       'source': p.source} for k, p in plan.params.items()},
        'fixture': plan.fixture_id,
        'structure': info,
        'process': proc,
        'files': {k: v.name for k, v in files.items()},
        'status': DISCLAIMER,
    }
    (target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    files['manifest'] = target / 'manifest.json'
    manifest['paths'] = files
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='方案 JSON → 结构总图 DXF + 涂装与标识工艺图 SVG/PDF（示意）')
    ap.add_argument('plan', type=Path, help='方案 JSON')
    ap.add_argument('out', type=Path, help='输出目录，图纸写在 <out>/<方案 id>/')
    ap.add_argument('--png', action='store_true', help='另出 PNG 预览')
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    try:
        m = export_drawings(args.plan, args.out, png=args.png)
    except PlanError as e:
        print(f'方案校验失败：{e}', file=sys.stderr)
        return 2
    s = m['structure']
    params = '，'.join(f'{p["label"]} {fmt(p["value"])}{" " + p["unit"] if p["unit"] else ""}'
                      for p in m['params'].values() if p['source'] == 'plan')
    print(f'{m["product"]["model"]} · 方案 {m["plan"]["id"]} v{m["plan"]["version"]}（{params}）')
    print(f'结构总图 {s["sheet"]} {s["scale"]}，工艺图视图 {m["process"]["view_scale"]}')
    for path in m['paths'].values():
        print(f'  {path}')
    print(DISCLAIMER)
    return 0


if __name__ == '__main__':
    sys.exit(main())
