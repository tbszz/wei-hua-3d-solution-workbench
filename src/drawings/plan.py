"""Load a plan JSON and check it against the product configs.

A plan is the ScenePlan from PRD 7.3 trimmed to what drawing needs: the product, its edited
parameters, the fixture and the finish options. Every parameter ends up resolved: values the plan
gives are range-checked, missing ones fall back to the nominal value or a derived default, and each
value remembers where it came from so the drawings can say so.
"""
from __future__ import annotations

import datetime as _dt
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
PARAMETRIC = PROJECT / 'src' / 'parametric'
MODELS = PROJECT / 'data' / 'product-models' / 'simplified'


class PlanError(ValueError):
    """The plan cannot be drawn. The message is meant for the person or Agent that wrote it."""


@dataclass
class Param:
    key: str
    label: str
    unit: str
    value: float
    min: float
    max: float
    step: float
    source: str  # 'plan', 'nominal' or 'derived'

    def text(self) -> str:
        return f'{fmt(self.value)} {self.unit}'.strip()

    def range_text(self) -> str:
        return f'{fmt(self.min)}–{fmt(self.max)}'


@dataclass
class Plan:
    raw: dict
    path: Path | None
    id: str
    version: int | str
    project: str
    customer: str
    date: str
    drawn_by: str
    product: dict              # the product config as loaded
    product_id: str
    category: str              # 'agv' or 'crane'
    config_path: Path
    params: dict[str, Param]
    fixture_id: str | None
    fixture: dict | None
    finish_system_id: str
    finish_system: dict
    zones: list[dict]          # zone with resolved paint: {id, name, paint, hex, code, source}
    markings: dict[str, dict]  # nameplate / capacity / logo, each {label, text, size, enabled}
    manifest: dict | None = None
    notes: list[str] = field(default_factory=list)

    def value(self, key: str) -> float:
        return self.params[key].value

    @property
    def model(self) -> str:
        return self.product['model']

    @property
    def drawing_no(self) -> str:
        """Drawing number in the form <model>-<plan>-<version>; marked 示意 until Weihua's rule is known."""
        model = re.sub(r'[^A-Za-z0-9]+', '', self.product['id']).upper()
        plan = re.sub(r'[^A-Za-z0-9]+', '', self.id).upper()[-8:]
        return f'WH-{model}-{plan}-V{self.version}'


def fmt(value: float) -> str:
    """Format a dimension the way the DXF dimension style does: no trailing zeros, at most 1 decimal."""
    rounded = round(float(value), 1)
    if rounded == int(rounded):
        return str(int(rounded))
    return f'{rounded:.1f}'


def load_json(path: Path) -> dict:
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def catalog() -> dict[str, tuple[dict, Path]]:
    """All products drawing knows about, by product id."""
    products = {}
    for path in sorted(PARAMETRIC.glob('*.config.json')):
        config = load_json(path)
        config.setdefault('category', 'agv')
        products[config['id']] = (config, path)
    crane_path = HERE / 'crane.config.json'
    crane = load_json(crane_path)
    products[crane['id']] = (crane, crane_path)
    return products


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT).as_posix()
    except ValueError:
        return str(path)


def _param_key(given: str, params: dict) -> str | None:
    if given in params:
        return given
    for suffix in ('_mm', '_t'):
        if given.endswith(suffix) and given[: -len(suffix)] in params:
            return given[: -len(suffix)]
    return None


def _on_step(value: float, lo: float, step: float) -> bool:
    n = (value - lo) / step
    return abs(n - round(n)) < 1e-6


def _check_value(key: str, spec: dict, value, config_path: Path) -> float:
    label = spec.get('label', key)
    unit = spec.get('unit', 'mm')
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise PlanError(f'参数 {label}（{key}）必须是数字，收到 {value!r}')
    lo, hi, step = spec['min'], spec['max'], spec['step']
    where = f'范围见 {rel(config_path)}'
    if not lo <= value <= hi:
        raise PlanError(
            f'参数 {label}（{key}）= {fmt(value)} {unit} 超出范围：允许 {fmt(lo)}–{fmt(hi)} {unit}，'
            f'步长 {fmt(step) if step >= 0.1 else step} {unit}（{where}）')
    if not _on_step(value, lo, step):
        raise PlanError(
            f'参数 {label}（{key}）= {value} {unit} 不在步长上：从 {fmt(lo)} 起每 {step} {unit} 一档（{where}）')
    return float(value)


def _clamp_round(value: float, step: float, spec: dict) -> float:
    snapped = round(value / step) * step
    return float(min(spec['max'], max(spec['min'], snapped)))


def _derive_crane(key: str, params: dict[str, Param], spec: dict) -> float | None:
    if key == 'girder_height':
        return _clamp_round(params['span'].value / 17, 50, spec)
    if key == 'wheelbase':
        return _clamp_round(params['span'].value / 5, 100, spec)
    if key == 'trolley_gauge':
        q = params['capacity_t'].value
        return float(2000 if q <= 20 else 2500 if q <= 32 else 3000)
    return None


def _resolve_params(config: dict, config_path: Path, given: dict) -> dict[str, Param]:
    specs = config['params']
    if not isinstance(given, dict):
        raise PlanError('product.params 必须是对象，例如 {"length_mm": 3600}')
    values = {}
    for name, value in given.items():
        key = _param_key(name, specs)
        if key is None:
            allowed = '、'.join(f'{k}（{s["label"]}）' for k, s in specs.items())
            raise PlanError(f'{config["model"]} 没有参数 {name}，可用：{allowed}')
        values[key] = _check_value(key, specs[key], value, config_path)
    params: dict[str, Param] = {}
    derived_rules = config.get('derived', {})
    for key, spec in specs.items():  # order matters: derived values read earlier ones
        unit = spec.get('unit', 'mm')
        if key in values:
            value, source = values[key], 'plan'
        else:
            value, source = None, 'nominal'
            if key in derived_rules and config.get('category') == 'crane':
                value = _derive_crane(key, params, spec)
                source = 'derived'
            if value is None:
                value, source = float(spec['nominal']), 'nominal'
        params[key] = Param(key, spec.get('label', key), unit, value, spec['min'], spec['max'], spec['step'], source)
    return params


def _check_crane(params: dict[str, Param]) -> None:
    v = {k: p.value for k, p in params.items()}
    if v['girder_width'] + 600 > v['trolley_gauge']:
        raise PlanError(
            f'小车轨距 {fmt(v["trolley_gauge"])} mm 至少要比主梁宽 {fmt(v["girder_width"])} mm 大 600 mm，'
            f'两根主梁之间要留出钢丝绳和吊钩的通道（示意规则）')
    if 2 * v['girder_flange_t'] >= v['girder_height'] / 4:
        raise PlanError(f'主梁翼缘板厚 {fmt(v["girder_flange_t"])} mm 相对主梁高 {fmt(v["girder_height"])} mm 过厚')
    if 2 * v['girder_web_t'] >= v['girder_width'] / 4:
        raise PlanError(f'主梁腹板厚 {fmt(v["girder_web_t"])} mm 相对主梁宽 {fmt(v["girder_width"])} mm 过厚')
    if v['trolley_gauge'] + v['girder_width'] > v['wheelbase'] + 2000:
        raise PlanError(
            f'两根主梁外缘 {fmt(v["trolley_gauge"] + v["girder_width"])} mm 超出端梁长度，'
            f'请加大大车基距（当前 {fmt(v["wheelbase"])} mm）或减小小车轨距')
    if v['girder_height'] > v['span'] / 10:
        raise PlanError(f'主梁高 {fmt(v["girder_height"])} mm 超过跨度的 1/10，示意比例不合理')


def _resolve_paint(paint: str, paints: dict, where: str) -> dict:
    if paint.startswith('#'):
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', paint):
            raise PlanError(f'{where} 的颜色 {paint} 不是 #rrggbb 格式')
        return {'paint': paint, 'hex': paint.lower(), 'code': '未登记（示意）'}
    if paint not in paints:
        raise PlanError(f'{where} 的涂装 {paint} 不在 src/parametric/paints.json，可用：{"、".join(paints)}')
    return {'paint': paint, 'hex': paints[paint]['color'].lower(), 'code': f'paints.json:{paint}'}


def load_plan(path_or_dict, *, today: str | None = None) -> Plan:
    if isinstance(path_or_dict, (str, Path)):
        path = Path(path_or_dict)
        try:
            raw = load_json(path)
        except json.JSONDecodeError as e:
            raise PlanError(f'{path} 不是合法 JSON：{e}') from e
    else:
        path, raw = None, path_or_dict
    if not isinstance(raw, dict):
        raise PlanError('方案必须是 JSON 对象')
    product_in = raw.get('product')
    if not isinstance(product_in, dict) or 'product_id' not in product_in:
        raise PlanError('方案缺少 product.product_id')

    products = catalog()
    product_id = product_in['product_id']
    if product_id not in products:
        raise PlanError(f'产品库没有 {product_id}，可用：{"、".join(products)}')
    config, config_path = products[product_id]
    category = config.get('category', 'agv')
    params = _resolve_params(config, config_path, product_in.get('params', {}))
    if category == 'crane':
        _check_crane(params)

    fixtures = load_json(HERE / 'fixtures.json')['fixtures']
    fixture_id = product_in.get('fixture_id')
    fixture = None
    if fixture_id is not None:
        if fixture_id not in fixtures:
            raise PlanError(f'没有夹具 {fixture_id}，可用：{"、".join(fixtures)}')
        fixture = fixtures[fixture_id]
        if category not in fixture['compatible']['category']:
            ok = [f'{k}（{f["label"]}）' for k, f in fixtures.items() if category in f['compatible']['category']]
            raise PlanError(f'{fixture["label"]}（{fixture_id}）不能装在 {config["model"]} 上，可选：{"、".join(ok)}')

    finishes = load_json(HERE / 'finishes.json')
    paints = load_json(PARAMETRIC / 'paints.json')
    finish_in = raw.get('finish') or {}
    system_id = finish_in.get('system', 'standard')
    if system_id not in finishes['systems']:
        raise PlanError(f'没有涂装体系 {system_id}，可用：{"、".join(finishes["systems"])}')
    spec = finishes['products'][product_id]
    overrides = finish_in.get('zones', {})
    zone_ids = {z['id'] for z in spec['zones']}
    for zid in overrides:
        if zid not in zone_ids:
            raise PlanError(f'{config["model"]} 没有涂装分区 {zid}，可用：{"、".join(sorted(zone_ids))}')
    zones = []
    for zone in spec['zones']:
        paint = overrides.get(zone['id'], zone['paint'])
        source = '方案指定' if zone['id'] in overrides else zone['source']
        zones.append({**zone, **_resolve_paint(paint, paints, f'分区 {zone["id"]} {zone["name"]}'), 'source': source})

    capacity = params['capacity_t'].value if 'capacity_t' in params else None
    markings = {}
    marking_in = finish_in.get('markings', {})
    for key, m in spec['markings'].items():
        opt = marking_in.get(key, True)
        enabled = opt is not False
        text = m['text']
        if isinstance(opt, dict) and 'text' in opt:
            text = str(opt['text'])
        if capacity is not None:
            text = text.replace('{capacity_t}', fmt(capacity))
        markings[key] = {**m, 'text': text, 'enabled': enabled}

    manifest = None
    if category == 'agv':
        manifest = load_json(MODELS / config['manifest'])

    project = raw.get('project') or {}
    drawing = raw.get('drawing') or {}
    return Plan(
        raw=raw, path=path,
        id=str(raw.get('id', 'sp_unnamed')), version=raw.get('version', 1),
        project=project.get('name', '未命名项目'), customer=project.get('customer', ''),
        date=drawing.get('date') or today or _dt.date.today().isoformat(),
        drawn_by=drawing.get('drawn_by', 'scene Agent 自动生成'),
        product=config, product_id=product_id, category=category, config_path=config_path,
        params=params, fixture_id=fixture_id, fixture=fixture,
        finish_system_id=system_id, finish_system=finishes['systems'][system_id],
        zones=zones, markings=markings, manifest=manifest,
    )
