// 小华's solution-stage tools beyond the sample plant: text-to-cad parts, storage slots and
// inventory, industry selection + parametric adaptation, flow demo and line simulation.
// Merged into tools.js (schemas + handlers + state summary).
import * as THREE from 'three';
import { Warehouse } from './warehouse.js';
import { FlowDemo } from './flow.js';
import { LineViz } from './lineviz.js';
import { replicate, simulateLine } from './linesim.js';

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = { type: 'number' };
const int = { type: 'integer' };

const STATION = {
  type: 'object',
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, cycle_s: { type: 'number', description: '单件加工节拍（秒）' },
    servers: { type: 'integer', description: '并行设备台数，默认 1' }, cv: { type: 'number', description: '节拍波动系数 0–0.6，默认 0.1' },
    buffer: { type: 'integer', description: '工位前缓存件数，默认 2' }, mtbf_min: { type: 'number', description: '平均故障间隔（分钟），可选' }, mttr_min: { type: 'number', description: '平均修复时间（分钟），可选' },
    at: { type: 'string', description: '放在已有点位 id 上（可选）' }, x_mm: num, y_mm: num,
  },
  required: ['name', 'cycle_s'],
};

export const EXT_SCHEMAS = [
  fn('cad_build_part', '用 text-to-cad（build123d）按参数生成零件三维模型（GLB + STEP + 预览图），自动存入场景库，可选登记到产品库、放进厂房。模板：saddle_v（V型鞍座：length,width,height,base_t,groove_angle,min_t,pad_t）、saddle_cradle（弧形鞍座：length,width,height,base_t,coil_d,min_t）、coil（钢卷：diameter,eye,width）、rack（货架：bays,levels,bay_width,depth,level_height,upright,beam_h,first_level）、pallet（length,width,height）、primitives（params.items=[{shape:box|cylinder,size:[x,y,z]|radius,height,pos:[x,y,z],rot:[rx,ry,rz],op:add|cut}]）。单位 mm，未给的参数用默认值。首次建模约 30–60 秒。', {
    template: { type: 'string', enum: ['saddle_v', 'saddle_cradle', 'coil', 'rack', 'pallet', 'primitives'] },
    params: { type: 'object', description: '模板参数（mm）' },
    name: { type: 'string', description: '模型名称，如「V型鞍座-Φ1800」' },
    register_product: { type: 'boolean', description: '同时登记进产品库（入库）' },
    category: { type: 'string', description: '产品类别，默认按模板（saddle/rack/coil/pallet）' },
    capacity_t: num,
    industries: { type: 'array', items: { type: 'string' }, description: '适用行业' },
    place: { type: 'boolean', description: '生成后放进厂房' }, x_mm: num, y_mm: num,
  }, ['template']),
  fn('cad_from_drawing', '把场景库里的零件 CAD 图纸（DXF/DWG，如鞍座侧视图）识别出外轮廓和孔，用 text-to-cad 拉伸成三维实体，存入场景库，可选登记产品库。', {
    drawing: { type: 'string', description: '场景库图纸 id 或名称' },
    depth_mm: { type: 'number', description: '拉伸长度（mm），侧视图即零件长度，默认 1400' },
    view: { type: 'string', enum: ['side', 'plan'], description: 'side=侧视图（沿卷轴拉伸，默认），plan=平面图（向上拉伸）' },
    name: { type: 'string' }, register_product: { type: 'boolean' }, capacity_t: num,
    industries: { type: 'array', items: { type: 'string' } }, place: { type: 'boolean' },
  }, ['drawing']),
  fn('layout_slots', '按参数或货位表在厂房里布置库区货位，生成真实三维（鞍座/货架/地面货位）。参数式：起点 origin + 行列 + 间距；表格式：slots=[{id,x_mm,y_mm,level}]。会检查是否超出厂房、与立柱/设备/其他库区冲突（冲突货位自动跳过并报告）。saddle_asset 可用场景库里 CAD 生成的鞍座模型。', {
    zone: { type: 'string', description: '库区编号，如 A' }, name: { type: 'string' },
    type: { type: 'string', enum: ['saddle', 'rack', 'floor'] }, item: { type: 'string', enum: ['coil', 'pallet'] },
    origin_x_mm: num, origin_y_mm: num, rows: int, cols: int, levels: int, pitch_x_mm: num, pitch_y_mm: num, heading_deg: num,
    coil_d_mm: num, coil_w_mm: num, saddle_asset: { type: 'string', description: '场景库鞍座模型 id 或名称（可选）' },
    saddle: { type: 'object', description: '内置鞍座参数 length,width,height,groove_angle（mm/°，可选）' },
    slots: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, x_mm: num, y_mm: num, level: int } } },
  }, ['zone']),
  fn('fill_inventory', '输入库存信息，自动把货物填进货位并统计已用/空置货位。三种给法：used（已用个数）或 ratio（0–1 占用率）；skus=[{sku,count,weight_t}] 按品种数量；items=[{slot,sku}] 指定货位。strategy：sequential 顺序 / random 随机 / low_first 先低层。超过容量的部分会报告。', {
    zone: { type: 'string', description: '库区编号，不给则所有库区' }, used: int, ratio: num, sku: { type: 'string' },
    skus: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, count: int, weight_t: num } } },
    items: { type: 'array', items: { type: 'object', properties: { slot: { type: 'string' }, sku: { type: 'string' } } } },
    strategy: { type: 'string', enum: ['sequential', 'random', 'low_first'] },
  }),
  fn('clear_inventory', '清空库存（货位保留），或 remove=true 删除整个库区。', { zone: { type: 'string' }, remove: { type: 'boolean' } }),
  fn('recommend_products', '按应用行业、额定载荷、类别从产品库选型，给出排序和理由（载荷按 1.25 倍安全系数校核）。', {
    industry: { type: 'string', description: '如 钢铁、汽车、港口' }, load_t: { type: 'number', description: '单件最大重量（吨）' },
    category: { type: 'string', description: 'agv / overhead_crane / saddle …（可选）' }, application: { type: 'string', description: '如 钢卷转运（可选）' },
  }),
  fn('adapt_product', '按目标工况对选中的 AGV 做参数化适配：根据卷材外径/宽度/重量算出车体长宽并校核载荷与产品库范围；apply=true 直接应用到方案，save_as 给名称则另存为定制型号入产品库。', {
    product: { type: 'string', description: '车型，不给则当前车型' }, coil_d_mm: num, coil_w_mm: num, load_t: num,
    apply: { type: 'boolean' }, save_as: { type: 'string' },
  }),
  fn('define_process', '输入流程信息和工序节点，用于技术方案流程演示（只说明流程，不做仿真）。每个节点可绑定已有点位 at（或 x_mm/y_mm，或不给自动排布），可带子步骤 substeps 用于节点流程演示。', {
    name: { type: 'string' },
    nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, device: { type: 'string' }, duration_s: num, desc: { type: 'string' }, at: { type: 'string' }, x_mm: num, y_mm: num, substeps: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, duration_s: num, desc: { type: 'string' } } } } }, required: ['name'] } },
    loop: { type: 'boolean' },
  }, ['nodes']),
  fn('play_flow', '播放流程演示：mode=full 全流程（令牌沿路径走过每个节点），mode=node 节点流程（镜头飞到该节点，逐个讲子步骤）；stop=true 停止。', {
    mode: { type: 'string', enum: ['full', 'node'] }, node: { type: 'string', description: '节点 id、序号或名称' }, speed: num, stop: { type: 'boolean' },
  }),
  fn('simulate_line', '产线生产仿真（离散事件，带随机波动、有限缓存、故障停机，多次重复取范围）：模拟各工位时序节拍，输出实际产出/小时、班产、理论产能、线平衡效率、瓶颈、各工位加工/堵塞/待料/故障占比、在制品、流转时间，并在三维里回放、给出瓶颈加机后的产出对比。stations 不给时：source=flow 用已定义的工艺流程节点；默认用当前 AGV+行车方案。', {
    stations: { type: 'array', items: STATION }, source: { type: 'string', enum: ['flow', 'current'] },
    hours: { type: 'number', description: '仿真时长（小时），默认 8' }, arrival_s: { type: 'number', description: '来料间隔（秒），不给=来料充足' },
    warmup_h: num, replications: { type: 'integer', description: '重复次数 1–10，默认 5' }, replay_speed: { type: 'number', description: '三维回放倍速，默认 120' },
  }),
];

function card(title, right, body) {
  return `<div class="card"><h4>${title}<span class="r">${right}</span></h4>${body}</div>`;
}

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || `${url} ${r.status}`);
  return data;
}

export function createExtTools(app, { runCore }) {
  const site = app.site;
  const warehouse = new Warehouse(app);
  const flow = new FlowDemo(app);
  const line = new LineViz(app);
  app.warehouse = warehouse;
  app.flow = flow;
  app.line = line;
  app.frameHooks = [...(app.frameHooks ?? []), () => warehouse.update(), (dt) => flow.update(dt), (dt) => line.update(dt)];
  app.labelHooks = [...(app.labelHooks ?? []), (ctx) => warehouse.labels(ctx), (ctx) => flow.labels(ctx), (ctx) => line.labels(ctx)];
  app.dockTabs = { ...(app.dockTabs ?? {}), slots: () => slotsHtml(), flow: () => flow.dockHtml(), linesim: () => line.dockHtml() };

  document.getElementById('dockMain')?.addEventListener('click', (e) => {
    const f = e.target.closest('[data-flow]');
    if (f) {
      if (f.dataset.flow === 'stop') flow.stop();
      else flow.start({ mode: 'full' });
      app.renderDock();
    }
    const l = e.target.closest('[data-linesim]');
    if (l && line.result) {
      if (l.dataset.linesim === 'play') line.playing = !line.playing;
      if (l.dataset.linesim === 'restart') { line.seek(0); line.playing = true; }
      if (l.dataset.linesim === 'faster') line.speed = Math.min(1200, line.speed * 2);
      app.renderDock();
    }
  });

  function slotsHtml() {
    if (!warehouse.zones.size) return '<div class="later-box"><h3>货位库存</h3><p class="muted">还没有库区。对小华说：「在厂房南侧布置 A 区鞍座货位 2 行 10 列」，再说「库存 14 卷，填进去」。</p></div>';
    const s = warehouse.stats();
    const rows = s.库区.map((z) => `<tr><td>${esc(z.库区)}</td><td>${esc(z.名称)}</td><td>${z.类型}</td><td>${esc(z.货物)}</td><td class="num">${z.货位总数}</td><td class="num">${z.已用}</td><td class="num">${z.空置}</td>
      <td style="min-width:120px"><div style="background:#e8f5e9;height:10px"><div style="background:#2b7de9;height:10px;width:${z.利用率}"></div></div></td><td class="num">${z.利用率}</td></tr>`).join('');
    const sku = Object.entries(s.按品种).map(([k, v]) => `<span class="chip" style="border-left:10px solid ${warehouse.skuColors?.[k] ?? '#aeb4ba'}">${esc(k)} ${v}</span>`).join(' ');
    return `<div style="display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;padding:2px 0 6px"><b style="font-size:16px">已用货位 <span class="num">${s.已用货位}</span> 个 · 空置货位 <span class="num">${s.空置货位}</span> 个</b><span class="muted">共 ${s.货位总数} 个 · 利用率 ${s.利用率}</span>${sku}</div>
      <table class="tbl-plain" style="width:100%;font-size:12px"><thead><tr><th>库区</th><th>名称</th><th>类型</th><th>货物</th><th>货位</th><th>已用</th><th>空置</th><th>占用</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const lookAtZone = () => {
    const c = warehouse.centre();
    if (!c || !app.flyTo) return;
    app.view = 'zone';
    const t = new THREE.Vector3(c.x / 1000, 0, -c.y / 1000);
    app.flyTo(t, t.clone().add(new THREE.Vector3(-0.35, 0.75, 0.6).normalize().multiplyScalar(Math.max(18, c.span / 1000 * 1.1))));
  };

  const placeAsset = async (asset, x, y) => {
    await app.library.reload();
    return app.library.place(asset.id, { x, y });
  };

  const partCard = (r, extra = '') => {
    const dims = r.bboxMm ? `${r.bboxMm.join(' × ')} mm` : '';
    const img = r.thumbUrl ? `<img src="${r.thumbUrl}" alt="" style="width:100%;max-height:150px;object-fit:contain;background:#eef2f7;border-radius:4px">` : '';
    return card(esc(r.asset.name), 'text-to-cad', `${img}<div class="spec">
      <div><small>外形</small><span class="num">${dims}</span><span class="src">build123d</span></div>
      <div><small>文件</small><a href="${r.asset.url}" download>GLB</a> · <a href="${r.stepUrl}" download>STEP</a><span class="src">场景库 ${r.asset.id}</span></div>
      ${r.product ? `<div><small>产品库</small>${esc(r.product.model)}（${esc(r.product.id)}）<span class="src">已入库</span></div>` : ''}${extra}</div>`);
  };

  const H = {
    cad_build_part: async (a) => {
      const product = { category: a.category, capacityT: a.capacity_t, industries: a.industries };
      const r = await postJson('/api/cad/part', { template: a.template, params: a.params ?? {}, name: a.name, register_product: Boolean(a.register_product), product });
      let placed = null;
      if (a.place) placed = await placeAsset(r.asset, a.x_mm, a.y_mm);
      else await app.library.reload();
      app.bump();
      return {
        result: { 模型: r.asset.name, 场景库id: r.asset.id, 外形_mm: r.bboxMm, 参数: r.params, STEP: r.stepUrl, 产品库: r.product ? { id: r.product.id, 型号: r.product.model } : '未登记', 已放入: placed, 用时_s: r.seconds },
        chip: `CAD 建模 · ${r.asset.name}`,
        card: partCard(r),
      };
    },

    cad_from_drawing: async (a) => {
      const lib = app.library;
      await lib.reload();
      const drawing = lib.find(a.drawing);
      if (!drawing) throw new Error(`场景库里没有图纸 ${a.drawing}`);
      const r = await postJson('/api/cad/from-drawing', { assetId: drawing.id, depth: a.depth_mm, axis: a.view === 'plan' ? 'z' : 'x', name: a.name, register_product: Boolean(a.register_product), product: { capacityT: a.capacity_t, industries: a.industries } });
      let placed = null;
      if (a.place) placed = await placeAsset(r.asset, a.x_mm, a.y_mm);
      else await lib.reload();
      app.bump();
      return {
        result: { 图纸: drawing.name, 识别轮廓_mm: r.drawing.outlineSizeMm, 孔数: r.drawing.holes, 封闭轮廓数: r.drawing.loopsFound, 模型: r.asset.name, 场景库id: r.asset.id, 外形_mm: r.bboxMm, 产品库: r.product ? r.product.id : '未登记', 已放入: placed },
        chip: `图纸→模型 · ${r.asset.name}`,
        card: partCard(r, `<div><small>图纸识别</small>轮廓 ${r.drawing.outlineSizeMm.join(' × ')} mm · ${r.drawing.holes} 个孔<span class="src">${esc(drawing.name)}</span></div>`),
      };
    },

    layout_slots: async (a) => {
      if (a.saddle_asset) await app.library.reload();
      const r = await warehouse.layout(a);
      app.setTab('slots', true);
      lookAtZone();
      return { result: { ...r, 提示: '货位已生成，可用 fill_inventory 填入库存' }, chip: `库区 ${r.库区} · ${r.货位总数} 货位` };
    },

    fill_inventory: (a) => {
      const r = warehouse.fill(a);
      app.setTab('slots', true);
      lookAtZone();
      return { result: r, chip: `已用 ${r.已用货位} · 空置 ${r.空置货位}`, card: card('库存统计', `利用率 ${r.利用率}`, `<div class="spec"><div><small>已用货位</small><span class="num">${r.已用货位} 个</span></div><div><small>空置货位</small><span class="num">${r.空置货位} 个</span></div>${r.超出容量未入库 ? `<div><small>超出容量</small><span class="warn">${r.超出容量未入库} 件未入库</span></div>` : ''}</div>`) };
    },

    clear_inventory: (a) => {
      if (a.remove) {
        if (!a.zone) throw new Error('删除库区需要给 zone');
        if (!warehouse.remove(a.zone)) throw new Error(`没有库区 ${a.zone}`);
        app.bump();
        app.renderDock();
        return { result: { 已删除库区: a.zone }, chip: `删除库区 ${a.zone}` };
      }
      const r = warehouse.clear(a.zone);
      app.renderDock();
      return { result: r, chip: '清空库存' };
    },

    recommend_products: async (a) => {
      await app.library.reload();
      const list = app.library.products;
      const need = a.load_t ? a.load_t * 1.25 : null;
      const scored = list.map((p) => {
        const reasons = [];
        let score = 0;
        const inds = p.industries ?? [];
        if (a.category && p.category !== a.category) return null;
        if (a.industry) {
          if (inds.some((x) => x.includes(a.industry) || a.industry.includes(x))) { score += 3; reasons.push(`适用于${a.industry}`); } else reasons.push(`未标注${a.industry}行业`);
        }
        if (need !== null) {
          if (p.capacityT === null || p.capacityT === undefined) reasons.push('无额定载荷数据');
          else if (p.capacityT >= need) { score += 4 - Math.min(2, (p.capacityT - need) / need); reasons.push(`额定 ${p.capacityT} t ≥ 需求 ${a.load_t}×1.25=${need.toFixed(1)} t`); } else { score -= 10; reasons.push(`额定 ${p.capacityT} t 不足（需 ${need.toFixed(1)} t）`); }
        }
        if (a.application && (p.applications ?? []).some((x) => x.includes(a.application) || a.application.includes(x))) { score += 2; reasons.push(`应用：${a.application}`); }
        return { id: p.id, 型号: p.model, 类别: p.category, 额定载荷_t: p.capacityT ?? null, 行业: inds, 得分: +score.toFixed(2), 结论: score > 0 ? '推荐' : score < -5 ? '不满足' : '可选', 理由: reasons };
      }).filter(Boolean).sort((x, y) => y.得分 - x.得分);
      if (!scored.length) throw new Error(`产品库里没有类别 ${a.category} 的产品`);
      const rows = scored.slice(0, 8).map((s) => `<tr><td>${esc(s.型号)}</td><td>${esc(s.类别)}</td><td class="num">${s.额定载荷_t ?? '—'}</td><td class="${s.结论 === '推荐' ? 'ok' : s.结论 === '不满足' ? 'warn' : ''}">${s.结论}</td><td style="font-size:11px">${esc(s.理由.join('；'))}</td></tr>`).join('');
      return { result: { 条件: a, 排序: scored.slice(0, 8) }, chip: `选型 · ${scored[0].型号}`, card: card('产品选型', `${a.industry ?? ''} ${a.load_t ? `${a.load_t} t` : ''}`, `<table class="tbl-plain" style="width:100%;font-size:12px"><thead><tr><th>型号</th><th>类别</th><th>载荷 t</th><th>结论</th><th>理由</th></tr></thead><tbody>${rows}</tbody></table>`) };
    },

    adapt_product: async (a) => {
      if (a.product) await runCore('select_product', { model: a.product });
      const p = app.product;
      const coilD = a.coil_d_mm ?? 1600;
      const coilW = a.coil_w_mm ?? 1350;
      const load = a.load_t ?? 20;
      // deck carries the coil saddle: length along the coil axis + 2×400 mm clearance, width ≥ 0.9 × coil OD
      const want = { length: Math.ceil((coilW + 800) / 10) * 10, width: Math.ceil((coilD * 0.9) / 10) * 10 };
      const issues = [];
      const values = {};
      for (const [k, v] of Object.entries(want)) {
        const range = p.params[k];
        const clamped = Math.min(range.max, Math.max(range.min, v));
        if (v > range.max) issues.push(`${range.label} 需要 ${v} mm，超过 ${p.model} 上限 ${range.max} mm`);
        values[k] = clamped;
      }
      if (p.capacityT && p.capacityT < load * 1.25) issues.push(`额定 ${p.capacityT} t < 需求 ${load}×1.25=${(load * 1.25).toFixed(1)} t`);
      let applied = null;
      if (a.apply && !issues.length) applied = (await runCore('set_params', { agv_length_mm: values.length, agv_width_mm: values.width })).result;
      let saved = null;
      if (a.save_as && !issues.length) {
        const params = Object.fromEntries(Object.entries(p.params).map(([k, r]) => [k, { ...r, nominal: values[k] ?? r.nominal }]));
        const r = await postJson('/api/library/products', { model: a.save_as, category: p.category ?? 'agv', capacityT: p.capacityT, params, summary: `${p.model} 定制：适配 Φ${coilD}×${coilW} mm / ${load} t 卷材`, baseProduct: p.id, industries: p.industries ?? [] });
        saved = r.product?.id ?? r.id ?? a.save_as;
        await app.library.reload();
      }
      return {
        result: { 车型: p.model, 工况: { 卷材外径_mm: coilD, 卷材宽_mm: coilW, 重量_t: load }, 推荐车体_mm: values, 校核: issues.length ? issues : '通过', 已应用: applied ? '是' : '否', 另存型号: saved },
        chip: issues.length ? `适配不通过 · ${p.model}` : `适配 ${p.model} ${values.length}×${values.width}`,
        card: card('参数化适配', issues.length ? '<span class="warn">不通过</span>' : '<span class="ok">通过</span>', `<div class="spec"><div><small>工况</small>Φ${coilD}×${coilW} mm · ${load} t</div><div><small>${esc(p.model)} 车体</small><span class="num">${values.length} × ${values.width} mm</span></div>${issues.map((x) => `<div><small>问题</small><span class="warn">${esc(x)}</span></div>`).join('')}${saved ? `<div><small>产品库</small>已另存 ${esc(saved)}</div>` : ''}</div>`),
      };
    },

    define_process: (a) => {
      const r = flow.define(a);
      app.setTab('flow', true);
      flow.focus(null);
      return { result: r, chip: `流程 · ${r.节点数} 个节点` };
    },

    play_flow: (a) => {
      if (a.stop) { flow.stop(); app.renderDock(); return { result: { 已停止: true }, chip: '停止演示' }; }
      const r = flow.start(a);
      app.setTab('flow', true);
      return { result: r, chip: a.mode === 'node' ? `节点流程 · ${a.node}` : '全流程演示' };
    },

    simulate_line: async (a) => {
      let stations = a.stations;
      if (!stations?.length && a.source === 'flow') {
        if (!flow.flow) throw new Error('还没有定义工艺流程');
        stations = flow.flow.nodes.map((n) => ({ id: n.id, name: n.name, cycle_s: n.duration_s ?? 60, x_mm: n.x, y_mm: n.y }));
      }
      if (!stations?.length) {
        const eff = site.efficiency;
        stations = [
          { id: 'AGV', name: `${app.product.model} 运送`, cycle_s: +eff.agvCycle.toFixed(1), servers: site.agvCount, cv: 0.08, buffer: 1 },
          { id: 'CRANE', name: '行车 吊运', cycle_s: +eff.craneCycle.toFixed(1), servers: 1, cv: 0.1, buffer: 1 },
        ];
      }
      const input = { stations, hours: a.hours ?? 8, arrival_s: a.arrival_s, warmup_h: a.warmup_h ?? 0, replay_speed: a.replay_speed };
      const runs = Math.min(10, Math.max(1, a.replications ?? 5));
      const rep = replicate(input, runs);
      const r = rep.first;
      // what-if: one more machine at the bottleneck
      const neck = r.stations.findIndex((s) => s.name === r.bottleneck.name);
      let whatIf = null;
      if (neck >= 0 && (stations[neck].servers ?? 1) < 20) {
        const more = stations.map((s, i) => (i === neck ? { ...s, servers: (s.servers ?? 1) + 1 } : s));
        const alt = simulateLine({ ...input, stations: more }, { trace: false });
        whatIf = { 改动: `${r.bottleneck.name} +1 台`, 产出_每小时: +alt.throughputPerHour.toFixed(1), 提升: `${(((alt.throughputPerHour - r.throughputPerHour) / Math.max(r.throughputPerHour, 1e-9)) * 100).toFixed(1)}%`, 新瓶颈: alt.bottleneck.name };
      }
      line.show(input, rep);
      app.setTab('linesim', true);
      return {
        result: {
          仿真: `${input.hours} h × ${runs} 次（随机种子可复现）`,
          实际产出_每小时: { 均值: +rep.throughput.mean.toFixed(1), 范围: [+rep.throughput.min.toFixed(1), +rep.throughput.max.toFixed(1)] },
          班产_件: { 均值: Math.round(rep.shiftOutput.mean), 范围: [rep.shiftOutput.min, rep.shiftOutput.max] },
          理论产能_每小时: +r.theoreticalPerHour.toFixed(1), 线平衡效率: `${(r.lineEfficiency * 100).toFixed(1)}%`, 实际节拍_s: r.actualTakt_s ? +r.actualTakt_s.toFixed(1) : null,
          瓶颈: r.bottleneck.name, 平均在制品: +r.avgWip.toFixed(1), 流转时间_min: r.leadTime_s ? { 平均: +(r.leadTime_s.avg / 60).toFixed(1), P90: +(r.leadTime_s.p90 / 60).toFixed(1) } : null,
          工位: r.stations.map((s) => ({ 工位: s.name, 节拍_s: s.cycle_s, 台数: s.servers, 能力_每小时: +s.capacityPerHour.toFixed(1), 加工: `${(s.utilization * 100).toFixed(0)}%`, 堵塞: `${(s.blocked * 100).toFixed(0)}%`, 待料: `${(s.starved * 100).toFixed(0)}%`, 故障: `${(s.down * 100).toFixed(0)}%` })),
          瓶颈加机对比: whatIf,
        },
        chip: `仿真 ${rep.throughput.mean.toFixed(1)} 件/h · 瓶颈 ${r.bottleneck.name}`,
      };
    },
  };

  const state = () => ({
    厂房范围_mm: site.built?.bounds ? Object.fromEntries(Object.entries(site.built.bounds).map(([k, v]) => [k, Math.round(v)])) : null,
    货位库存: warehouse.zones.size ? (({ 库区, ...rest }) => ({ ...rest, 库区: 库区.map((z) => ({ 库区: z.库区, 类型: z.类型, 货位: z.货位总数, 已用: z.已用, 范围_mm: z.范围_mm })) }))(warehouse.stats()) : null,
    工艺流程: flow.flow ? { 名称: flow.flow.name, 节点: flow.flow.nodes.map((n) => `${n.n}.${n.name}`), 演示中: flow.current() ? `${flow.current().node.name}` : null } : null,
    产线仿真: line.result ? { 产出_每小时: +line.rep.throughput.mean.toFixed(1), 瓶颈: line.result.bottleneck.name, 工位: line.result.stations.map((s) => s.name) } : null,
  });

  return { schemas: EXT_SCHEMAS, handlers: H, state };
}
