"""出图原型的回归测试：DXF 回读的尺寸等于方案参数（误差 0），越界参数报错并说明范围。

    .venv/Scripts/python -m pytest src/drawings/tests -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import ezdxf
import pytest

HERE = Path(__file__).resolve().parent
DRAWINGS = HERE.parent
sys.path.insert(0, str(DRAWINGS))

from cad import APPID  # noqa: E402
from generate import export_drawings, main  # noqa: E402
from plan import PlanError, fmt, load_plan  # noqa: E402

EXAMPLES = DRAWINGS / 'examples'


def example(name: str) -> dict:
    return json.loads((EXAMPLES / name).read_text(encoding='utf-8'))


def with_params(base: str, **params) -> dict:
    plan = example(base)
    plan['product']['params'] = {**plan['product']['params'], **params}
    return plan


def tagged_dims(doc):
    """(role, param, value, dimension) for every dimension tagged by the generator."""
    out = []
    for d in doc.modelspace().query('DIMENSION'):
        if d.has_xdata(APPID):
            tags = d.get_xdata(APPID)
            out.append((tags[0].value, tags[1].value, tags[2].value, d))
    return out


def dimlfac(d) -> float:
    return d.override().get('dimlfac', d.doc.dimstyles.get(d.dxf.dimstyle).dxf.get('dimlfac', 1.0))


def shown_text(d) -> str:
    block = d.get_geometry_block()
    texts = [e.plain_text() for e in block if e.dxftype() == 'MTEXT']
    assert len(texts) == 1
    return texts[0]


def check_structure(plan_dict, tmp_path):
    m = export_drawings(plan_dict, tmp_path)
    plan = load_plan(plan_dict)
    doc = ezdxf.readfile(m['paths']['structure_dxf'])
    dims = tagged_dims(doc)
    shown = set()
    for role, param, value, d in dims:
        measured = d.get_measurement() * dimlfac(d)
        assert abs(measured - value) < 1e-9, f'{param}: 量得 {measured}，标注值 {value}'
        expected = (d.dxf.get('text', '') or '<>').replace('<>', fmt(value))
        assert shown_text(d) == expected, f'{param}: 图上显示 {shown_text(d)!r}，应为 {expected!r}'
        if role == 'param':
            assert value == plan.params[param].value, f'{param}: 标注 {value}，方案 {plan.params[param].value}'
            shown.add(param)
    # Every length parameter of the product is dimensioned on the sheet.
    lengths = {k for k, p in plan.params.items() if p.unit == 'mm'}
    assert lengths <= shown, f'图上缺少参数尺寸：{sorted(lengths - shown)}'
    return m, doc


@pytest.mark.parametrize('name', ['agv1-long.json', 'crane-22m5.json'])
def test_examples(name, tmp_path):
    m, doc = check_structure(example(name), tmp_path)
    assert {l.dxf.name for l in doc.layers} >= {'OUTLINE', 'CENTER', 'DIM', 'TEXT', 'FRAME'}
    svg = Path(m['paths']['process_svg']).read_text(encoding='utf-8')
    assert '示 意' in svg and '涂装与标识工艺图' in svg
    assert Path(m['paths']['process_pdf']).stat().st_size > 10_000
    assert '示意' in m['status']


def test_example_values(tmp_path):
    m, _ = check_structure(example('agv1-long.json'), tmp_path)
    assert m['params']['length']['value'] == 3600 and m['params']['length']['source'] == 'plan'
    m, doc = check_structure(example('crane-22m5.json'), tmp_path)
    assert m['params']['span']['value'] == 22500 and m['params']['lift_height']['value'] == 12000
    spans = [v for role, p, v, _ in tagged_dims(doc) if p == 'span']
    assert spans == [22500]


@pytest.mark.parametrize('length,width,height', [(2200, 1000, 250), (6000, 2400, 600), (4370, 1730, 410)])
def test_agv_dimensions_follow_params(length, width, height, tmp_path):
    plan = load_plan(example('agv1-long.json'))
    ranges = {k: (p.min, p.max) for k, p in plan.params.items()}
    values = {}
    for key, v in (('length', length), ('width', width), ('height', height)):
        lo, hi = ranges[key]
        values[f'{key}_mm'] = min(max(v, lo), hi)
    check_structure(with_params('agv1-long.json', **values), tmp_path)


@pytest.mark.parametrize('span,lift,cap', [(10500, 6000, 5), (31500, 30000, 50), (16500, 9000, 10)])
def test_crane_dimensions_follow_params(span, lift, cap, tmp_path):
    check_structure(with_params('crane-22m5.json', span_mm=span, lift_height_mm=lift, capacity_t=cap), tmp_path)


@pytest.mark.parametrize('params,needle', [
    ({'length_mm': 6500}, '允许 2200–6000 mm'),
    ({'length_mm': 1000}, '允许 2200–6000 mm'),
    ({'length_mm': 3605}, '每 10 mm 一档'),
    ({'height_mm': 'abc'}, '高'),
])
def test_agv_out_of_range(params, needle):
    with pytest.raises(PlanError) as e:
        load_plan(with_params('agv1-long.json', **params))
    assert needle in str(e.value)
    assert 'agv1.config.json' in str(e.value) or 'abc' in str(e.value)


@pytest.mark.parametrize('params,needle', [
    ({'span_mm': 40000}, '允许 10500–31500 mm'),
    ({'lift_height_mm': 3000}, '允许 6000–30000 mm'),
    ({'capacity_t': 80}, '允许 5–50 t'),
])
def test_crane_out_of_range(params, needle):
    with pytest.raises(PlanError) as e:
        load_plan(with_params('crane-22m5.json', **params))
    assert needle in str(e.value)
    assert 'crane.config.json' in str(e.value)


def test_unknown_param():
    with pytest.raises(PlanError, match='没有参数 wheel_mm'):
        load_plan(with_params('agv1-long.json', wheel_mm=100))


def test_incompatible_fixture():
    plan = example('agv1-long.json')
    plan['product']['fixture_id'] = 'hook'
    with pytest.raises(PlanError, match='不能装在'):
        load_plan(plan)


def test_unknown_paint_and_zone():
    plan = example('agv1-long.json')
    plan['finish']['zones'] = {'A': 'purple'}
    with pytest.raises(PlanError, match='purple'):
        load_plan(plan)
    plan['finish']['zones'] = {'Z': 'yellow'}
    with pytest.raises(PlanError, match='没有涂装分区 Z'):
        load_plan(plan)


def test_cli_exit_code(tmp_path, capsys):
    bad = tmp_path / 'bad.json'
    bad.write_text(json.dumps(with_params('crane-22m5.json', span_mm=40000)), encoding='utf-8')
    assert main([str(bad), str(tmp_path / 'out')]) == 2
    assert '10500–31500' in capsys.readouterr().err
    assert main([str(EXAMPLES / 'crane-22m5.json'), str(tmp_path / 'out')]) == 0
    assert (tmp_path / 'out' / 'P-QD-001' / 'structure.dxf').exists()
