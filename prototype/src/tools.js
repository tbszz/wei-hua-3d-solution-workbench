// Agent tools: OpenAI function schemas plus handlers that drive the scene. Every handler validates
// first and throws a readable reason; nothing is clamped silently.
import { CATALOG } from '../../demo/src/catalog.js';
import { effHtml } from './main.js';
import { fmtTime, simulateShift } from './process.js';
import { createExtTools } from './tools-ext.js';

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const SCHEMAS = [
  fn('list_library', '列出资源库：产品库车型、场景库里用户上传并已转换的文件（模型/图纸/图片），以及已放进场景的模型。'),
  fn('place_asset', '把场景库里的三维模型放进厂房（已放过的会挪到新位置）。位置按用户原话给：绝对坐标 x_mm/y_mm，或参考点位 ref 加偏移 east_m/north_m（X 向东、Y 向北）。用户没说位置时先问，不要自己定。', {
    asset: { type: 'string', description: '场景库文件 id 或名称' },
    ref: { type: 'string', description: '参考点位编号，如 RM-01、H-01' },
    east_m: { type: 'number', description: '相对参考点向东米数，向西为负' },
    north_m: { type: 'number', description: '相对参考点向北米数，向南为负' },
    x_mm: { type: 'number' },
    y_mm: { type: 'number' },
    rotate_deg: { type: 'number', description: '俯视逆时针旋转角度（可选）' },
    size_m: { type: 'number', description: '把最长边缩放到这个米数（可选）' },
  }, ['asset']),
  fn('remove_asset', '把已放进场景的模型移出。', { asset: { type: 'string' } }, ['asset']),
  fn('load_site_asset', '用场景库里的 DXF/DWG 图纸替换当前厂房，重新生成点位和工序；图纸缺少约定图层时会保留原厂房并报错。', { asset: { type: 'string' } }, ['asset']),
  fn('record_video', '开始或停止录制三维视口视频（停止后自动下载 WebM）。', { on: { type: 'boolean' } }, ['on']),
  fn('get_scene_state', '读取当前方案状态：产品、参数、点位、工序、节拍、播放进度。'),
  fn('set_step', '切换顶部功能流程步骤（1 图纸变三维·点位标定，2 选型与参数，3 流程说明，4 流程动画，5 效率与节拍，6 行程可视化，7 出图下发·后期），同时切换底部面板。', {
    step: { type: 'integer', minimum: 1, maximum: 7 },
  }, ['step']),
  fn('import_site', '导入示例厂房 CAD（sample-plant.dxf），自动建厂房并识别工位、吊车梁、AGV 路线。'),
  fn('add_station', '加一个作业点位。可以给绝对坐标，或给参考点位加偏移（X 向东、Y 向北，单位米）。role: handoff=吊装交接点（AGV 放货、行车取货，会自动从主环线拉一条支线），drop=行车放卷点，marker=只做标记。', {
    id: { type: 'string', description: '点位编号，如 H-02' },
    name: { type: 'string', description: '中文名称' },
    role: { type: 'string', enum: ['handoff', 'drop', 'marker'] },
    ref: { type: 'string', description: '参考点位编号，如 RM-01' },
    east_m: { type: 'number', description: '相对参考点向东（+X）米数，向西为负' },
    north_m: { type: 'number', description: '相对参考点向北（+Y）米数，向南为负' },
    x_mm: { type: 'number' },
    y_mm: { type: 'number' },
  }, ['id', 'role']),
  fn('select_product', '从产品库选 AGV 车型。', {
    model: { type: 'string', enum: CATALOG.map((p) => p.model) },
  }, ['model']),
  fn('set_params', '改参数。AGV 车体尺寸按产品库范围校验；速度类为示意值；起重机跨度由 CAD 吊车梁间距决定，起升高度受轨顶限制。只传要改的字段。', {
    agv_length_mm: { type: 'number' },
    agv_width_mm: { type: 'number' },
    agv_height_mm: { type: 'number' },
    agv_count: { type: 'integer', description: 'AGV 台数 1–4' },
    agv_speed_mps: { type: 'number', description: 'AGV 主线速度 0.5–1.5 m/s' },
    bridge_speed_mpm: { type: 'number', description: '行车大车速度 20–80 m/min' },
    trolley_speed_mpm: { type: 'number', description: '行车小车速度 10–45 m/min' },
    hoist_speed_mpm: { type: 'number', description: '行车起升速度 4–20 m/min' },
    travel_height_m: { type: 'number', description: '吊运时钩心高度 3–7.5 m' },
    crane_span_m: { type: 'number', description: '起重机跨度 m（必须等于 CAD 吊车梁间距）' },
    crane_lift_m: { type: 'number', description: '起重机额定起升高度 m' },
  }),
  fn('set_process', '把用户的流程说明整理成工序，出确认卡（还没生效）。默认模板：AGV 在取货点接卷 → 送到吊装交接点 → 行车 C 形钩夹卷吊到放卷点 → AGV 空车回充电位。', {
    pick: { type: 'string', description: 'AGV 取货点位，如 RM-01' },
    handoff: { type: 'string', description: '吊装交接点，如 H-01' },
    drop: { type: 'string', description: '行车放卷点，如 FG-A' },
    home: { type: 'string', description: 'AGV 返回的充电位，如 CHG-01' },
  }, ['pick', 'handoff', 'drop', 'home']),
  fn('confirm_process', '用户确认工序表后调用，让工序生效并重新生成动画和时间轴。'),
  fn('play_animation', '播放动画。mode: all 全流程从头播；step 只播第 step 步（镜头对准设备）；next 下一步；pause 暂停；resume 继续。speed 为倍速 0.25–16。', {
    mode: { type: 'string', enum: ['all', 'step', 'next', 'pause', 'resume'] },
    step: { type: 'integer', minimum: 1, maximum: 5 },
    speed: { type: 'number' },
  }, ['mode']),
  fn('seek', '把时间轴跳到某一秒。', { seconds: { type: 'number' } }, ['seconds']),
  fn('set_takt', '设定目标节拍（秒/件），判断能否达到并给出瓶颈和建议。', { target_seconds: { type: 'number' } }, ['target_seconds']),
  fn('simulate_shift', '模拟一个班次，统计完成件数和设备忙闲。结果确定、可复现。', {
    hours: { type: 'number', description: '班次时长 0.5–24 小时' },
  }, ['hours']),
  fn('show_travel', '显示或隐藏行程可视化：视口轨迹线、行程表、甘特图。', { visible: { type: 'boolean' } }, ['visible']),
  fn('set_camera', '切换镜头。', {
    view: { type: 'string', enum: ['overview', 'top', 'follow', 'crane', 'point'] },
    point_id: { type: 'string', description: 'view=point 时的点位编号' },
  }, ['view']),
];

function check(name, value, min, max, unit) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) throw new Error(`${name} ${value} ${unit} 超出范围 ${min}–${max} ${unit}`);
}

const card = (title, right, body) => `<div class="card"><h4>${title}<span class="r">${right}</span></h4>${body}</div>`;

export function processCard(site, roles, { pending, steps }) {
  const names = { pick: roles.pick, handoff: roles.handoff, drop: roles.drop, home: roles.home };
  const list = steps ?? [
    { n: 1, device: 'AGV', title: `${names.pick} 接卷` },
    { n: 2, device: 'AGV', title: `${names.pick} → ${names.handoff} 运送` },
    { n: 3, device: '行车', title: `${names.handoff} 夹卷起升` },
    { n: 4, device: '行车', title: `${names.handoff} → ${names.drop} 吊运放卷` },
    { n: 5, device: 'AGV', title: `${names.handoff} → ${names.home} 空车返回` },
  ];
  const rows = list.map((s) => `<div><span>${s.n}</span><span>${s.device === 'AGV' ? 'AGV' : '行车 #1'}</span><span>${s.title}</span><span class="num">${s.duration ? `${s.duration.toFixed(0)} s` : '待算'}</span></div>`).join('');
  const right = pending ? '<span class="warn">待确认 · 5 步</span>' : '<span class="ok">已确认 · 5 步</span>';
  const acts = pending ? '<div class="acts" style="padding-top:8px"><button class="pri" data-action="confirm-process">确认工序</button><button data-action="cancel-process">取消</button></div>' : '';
  return card('工序表', right, `<div class="tbl">${rows}</div>${acts}`);
}

export function createTools(app) {
  const site = app.site;
  const span = () => Math.abs(site.runway.high - site.runway.low) / 1000;
  const maxLift = () => 8.5;

  const stateSummary = () => {
    const eff = site.efficiency;
    return {
      方案版本: app.version,
      当前步骤: app.step,
      AGV: { ...app.vehicleState(), 台数: site.agvCount, 主线速度_mps: site.motion.laneSpeed / 1000, 产品库范围: Object.fromEntries(Object.entries(app.product.params).map(([k, p]) => [k, `${p.min}-${p.max} mm`])) },
      起重机: { 型式: '双梁桥式（示意）', 跨度_m: span(), 吊具: 'C 形钩', 大车_mpm: +(site.craneMotion.bridge.speed * 0.06).toFixed(1), 小车_mpm: +(site.craneMotion.trolley.speed * 0.06).toFixed(1), 起升_mpm: +(site.craneMotion.hoist.speed * 0.06).toFixed(1), 吊运高度_m: site.craneMotion.travelHeight / 1000, 额定起升高度_m: app.craneLift ?? null },
      流程角色: site.roles,
      点位: site.points().map((p) => ({ id: p.id, 名称: p.name, role: p.role, x: Math.round(p.x), y: Math.round(p.y), 来源: p.source })),
      工序: site.process.steps.map((s) => ({ n: s.n, 设备: s.device, 动作: s.title, 用时_s: +s.duration.toFixed(1), 起止: `${fmtTime(s.t0)}-${fmtTime(s.t1)}` })),
      效率: { 节拍_s: +eff.takt.toFixed(1), 每小时: +eff.perHour.toFixed(1), 瓶颈: eff.bottleneck, 目标节拍_s: eff.target, AGV单循环_s: +eff.agvCycle.toFixed(1), 行车单循环_s: +eff.craneCycle.toFixed(1) },
      播放: { 时间_s: +site.time.toFixed(1), 总长_s: +site.duration.toFixed(1), 播放中: site.playing, 分步: site.window?.step ?? null, 倍速: site.speed },
      待确认工序: app.pendingProcess ?? null,
      场景库: (app.library?.assets ?? []).slice(-12).map((a) => ({ id: a.id, 名称: a.name, 类型: a.kind, 可用: a.status === 'ready', 底图: a.meta?.convention === 'generic' || undefined })),
      已放入模型: app.library?.placedList() ?? [],
    };
  };

  const specCard = () => {
    const v = app.vehicleState();
    return card('方案卡', `v${app.version}`, `<div class="spec">
      <div><small>${v.model} 车体</small><span class="num">${Math.round(v.length)} × ${Math.round(v.width)} × ${Math.round(v.height)} mm</span><span class="src">产品库</span></div>
      <div><small>台数 / 支架</small>${site.agvCount} 台 · 卷材支架<span class="src">客户口述</span></div>
      <div><small>起重机</small>双梁桥式 · 跨度 <span class="num">${span().toFixed(2)} m</span><span class="src">CAD</span></div>
      <div><small>起升 / 吊具</small>${app.craneLift ? `<span class="num">${app.craneLift} m</span> · ` : ''}C 形钩<span class="src">示意</span></div>
    </div>`);
  };

  const H = {
    get_scene_state: () => ({ result: stateSummary(), chip: '读取方案' }),

    set_step: ({ step }) => {
      check('步骤', step, 1, 7, '');
      app.setStep(step);
      const result = { step };
      if (step === 7) result.note = '第 7 步出图下发是后期功能，本轮只有入口和说明（PRD R14）。';
      return { result, chip: `第 ${step} 步` };
    },

    import_site: () => {
      app.setStep(1);
      app.setView('overview');
      const p = site.base;
      const result = { 文件: site.sourceName, 厂房_m: `${site.built.size.x} × ${site.built.size.y}`, 工位: p.stations.map((s) => s.id), 吊车梁: p.beams.length, AGV路线: p.paths.length, 柱: p.columns.length, 设备: p.machines.length, 货架: p.racks.length, 行车跨度_m: span() };
      return { result, chip: `识别 ${p.stations.length} 个工位、${p.beams.length} 条吊车梁` };
    },

    add_station: ({ id, name, role, ref, east_m = 0, north_m = 0, x_mm, y_mm }) => {
      let x = x_mm;
      let y = y_mm;
      if (ref) {
        const base = site.findPoint(ref);
        if (!base) throw new Error(`参考点位 ${ref} 不存在，现有：${site.points().map((p) => p.id).join('、')}`);
        x = base.x + east_m * 1000;
        y = base.y + north_m * 1000;
      }
      if (typeof x !== 'number' || typeof y !== 'number') throw new Error('需要坐标：给 x_mm/y_mm，或给 ref 加 east_m/north_m');
      const point = site.addPoint({ id, name: name ?? { handoff: '吊装交接点', drop: '放卷点', marker: '标记点' }[role], role, x, y });
      app.newPoints.add(id);
      app.setStep(1);
      app.setView('point', { id });
      app.bump();
      app.refresh();
      return { result: { 已添加: point }, chip: `${id} (${Math.round(x)}, ${Math.round(y)})` };
    },

    select_product: async ({ model }) => {
      const product = await app.selectProduct(model);
      app.setStep(2);
      app.bump();
      return { result: { 已选: product.model, 参数: app.vehicleState(), 范围: product.params }, chip: product.model, card: specCard() };
    },

    set_params: (args) => {
      const product = app.product;
      const taktBefore = site.efficiency.takt;
      const vehicle = {};
      const map = { agv_length_mm: 'length', agv_width_mm: 'width', agv_height_mm: 'height' };
      for (const [arg, key] of Object.entries(map)) {
        if (args[arg] === undefined) continue;
        const p = product.params[key];
        check(`${product.model} ${p.label}`, args[arg], p.min, p.max, 'mm');
        vehicle[key] = args[arg];
      }
      if (args.agv_count !== undefined) check('AGV 台数', args.agv_count, 1, 4, '台');
      if (args.agv_speed_mps !== undefined) check('AGV 主线速度', args.agv_speed_mps, 0.5, 1.5, 'm/s');
      if (args.bridge_speed_mpm !== undefined) check('大车速度', args.bridge_speed_mpm, 20, 80, 'm/min');
      if (args.trolley_speed_mpm !== undefined) check('小车速度', args.trolley_speed_mpm, 10, 45, 'm/min');
      if (args.hoist_speed_mpm !== undefined) check('起升速度', args.hoist_speed_mpm, 4, 20, 'm/min');
      if (args.travel_height_m !== undefined) check('吊运高度', args.travel_height_m, 3, 7.5, 'm');
      if (args.crane_span_m !== undefined && Math.abs(args.crane_span_m - span()) > 0.05) {
        throw new Error(`跨度 ${args.crane_span_m} m 和 CAD 不符：这个厂房吊车梁间距是 ${span().toFixed(2)} m，跨度只能按图纸取。要换跨度需要先改 CAD 的 S-BEAM 图层`);
      }
      if (args.crane_lift_m !== undefined && (args.crane_lift_m < 3 || args.crane_lift_m > maxLift())) {
        throw new Error(`起升高度 ${args.crane_lift_m} m 超出可行范围 3–${maxLift()} m：CAD 吊车梁轨顶 9.85 m，扣掉小车和吊具，钩心最高约 ${maxLift()} m`);
      }
      const changed = [];
      if (Object.keys(vehicle).length) {
        app.setVehicleParams(vehicle);
        changed.push(...Object.entries(vehicle).map(([k, v]) => `${product.params[k].label} ${v} mm`));
      }
      if (args.agv_count !== undefined) {
        site.setAgvCount(args.agv_count);
        changed.push(`AGV ${args.agv_count} 台`);
      }
      const motion = {};
      if (args.agv_speed_mps !== undefined) motion.agvSpeed = args.agv_speed_mps * 1000;
      if (args.bridge_speed_mpm !== undefined) motion.bridgeSpeed = args.bridge_speed_mpm / 0.06;
      if (args.trolley_speed_mpm !== undefined) motion.trolleySpeed = args.trolley_speed_mpm / 0.06;
      if (args.hoist_speed_mpm !== undefined) motion.hoistSpeed = args.hoist_speed_mpm / 0.06;
      if (args.travel_height_m !== undefined) motion.travelHeight = args.travel_height_m * 1000;
      for (const [k, label] of [['agv_speed_mps', 'AGV 速度'], ['bridge_speed_mpm', '大车'], ['trolley_speed_mpm', '小车'], ['hoist_speed_mpm', '起升'], ['travel_height_m', '吊运高度']]) if (args[k] !== undefined) changed.push(`${label} ${args[k]}`);
      if (Object.keys(motion).length) site.setMotion(motion);
      else site.replan();
      if (args.crane_lift_m !== undefined) {
        app.craneLift = args.crane_lift_m;
        changed.push(`起升 ${args.crane_lift_m} m`);
      }
      if (args.crane_span_m !== undefined) changed.push(`跨度 ${span().toFixed(2)} m`);
      if (!changed.length) throw new Error('没有要改的参数');
      app.setStep(2);
      app.bump();
      app.refresh();
      const eff = site.efficiency;
      return { result: { 已修改: changed, 已完成: '本条指令已生效，无需再调用', 当前车体: app.vehicleState(), AGV台数: site.agvCount, 原节拍_s: +taktBefore.toFixed(1), 新节拍_s: +eff.takt.toFixed(1), 瓶颈: eff.bottleneck }, chip: changed.join('、'), card: specCard() };
    },

    set_process: ({ pick, handoff, drop, home }) => {
      const missing = [pick, handoff, drop, home].filter((id) => !site.findPoint(id));
      if (missing.length) throw new Error(`点位不存在：${missing.join('、')}。现有：${site.points().map((p) => p.id).join('、')}`);
      const roles = { pick, handoff, drop, home };
      const pickPoint = site.findPoint(pick);
      if (pickPoint.role !== 'pick') throw new Error(`${pick} 不是取货工位`);
      if (site.findPoint(handoff).role !== 'handoff') throw new Error(`${handoff} 不是吊装交接点（AGV 到不了或不在行车覆盖区）`);
      if (site.findPoint(home).role !== 'charge') throw new Error(`${home} 不是充电位`);
      app.pendingProcess = roles;
      app.setStep(3);
      return { result: { 状态: '已生成工序表，等用户确认', 工序: ['接卷', '运送', '夹卷起升', '吊运放卷', '空车返回'] }, chip: '5 步工序', card: processCard(site, roles, { pending: true }) };
    },

    confirm_process: () => {
      if (!app.pendingProcess) throw new Error('没有待确认的工序表，先用 set_process 整理流程');
      site.setRoles(app.pendingProcess);
      app.pendingProcess = null;
      app.setStep(4);
      app.play({ mode: 'all' });
      app.bump();
      app.refresh();
      const steps = site.process.steps;
      return {
        result: { 已生效: steps.map((s) => ({ n: s.n, 动作: s.title, 用时_s: +s.duration.toFixed(1) })), 全流程_s: +site.duration.toFixed(1) },
        chip: `工序生效 · 全流程 ${fmtTime(site.duration)}`,
        card: processCard(site, site.roles, { pending: false, steps }),
      };
    },

    play_animation: ({ mode, step, speed }) => {
      if (speed !== undefined) check('倍速', speed, 0.25, 16, '×');
      if (mode === 'step') check('步骤', step, 1, site.process.steps.length, '');
      app.setStep(4);
      const r = app.play({ mode, step, speed });
      const s = r.window ? site.process.steps[r.window.step - 1] : null;
      return {
        result: s ? { 播放: `第 ${s.n} 步 ${s.title}`, 用时_s: +s.duration.toFixed(1), 说明: s.detail } : { 播放: mode, 全流程_s: +site.duration.toFixed(1), 倍速: site.speed },
        chip: s ? `第 ${s.n} 步 · ${s.duration.toFixed(0)} s` : `${{ all: '全流程', pause: '暂停', resume: '继续' }[mode] ?? mode} · ${site.speed}×`,
      };
    },

    seek: ({ seconds }) => {
      check('时刻', seconds, 0, site.duration, 's');
      app.seek(seconds);
      const s = site.stepAt();
      return { result: { 时刻: fmtTime(seconds), 当前工序: s.title }, chip: fmtTime(seconds) };
    },

    set_takt: ({ target_seconds }) => {
      check('目标节拍', target_seconds, 10, 3600, 's');
      site.target = target_seconds;
      site.replan();
      app.setStep(5);
      app.bump();
      app.refresh();
      const eff = site.efficiency;
      const acts = !eff.meets && eff.bottleneck === 'AGV' && site.agvCount < 4 ? '<div class="acts"><button class="pri" data-action="add-agv">按建议加一台 AGV</button><button data-action="play-bottleneck">只看瓶颈这一步</button></div>' : '<div class="acts"><button data-action="play-bottleneck">只看瓶颈这一步</button></div>';
      return {
        result: { 目标_s: target_seconds, 当前节拍_s: +eff.takt.toFixed(1), 达到: eff.meets, 差距_s: +eff.gap.toFixed(1), 瓶颈: eff.bottleneck, AGV单循环_s: +eff.agvCycle.toFixed(1), 行车单循环_s: +eff.craneCycle.toFixed(1), 利用率: { AGV: +(eff.utilization.agv * 100).toFixed(0), 行车: +(eff.utilization.crane * 100).toFixed(0) }, 建议: eff.advice ?? null },
        chip: `${target_seconds} s · ${eff.meets ? '可达到' : '未达到'}`,
        card: card('效率分析', '速度参数为示意值', effHtml(eff) + acts),
      };
    },

    simulate_shift: ({ hours }) => {
      check('班次时长', hours, 0.5, 24, '小时');
      const shift = simulateShift(site.efficiency, site.duration, hours);
      app.shift = shift;
      app.setStep(5);
      app.refresh();
      return {
        result: { 小时: hours, 完成件数: shift.pieces, 每小时: +shift.perHour.toFixed(1), 忙碌小时: { AGV: +shift.busyHours.agv.toFixed(1), 行车: +shift.busyHours.crane.toFixed(1) }, 说明: '首件需一个完整循环，之后每个节拍出一件；确定性计算' },
        chip: `${hours} h · ${shift.pieces} 件`,
        card: card('班次模拟', `${hours} 小时 · 可复现`, effHtml(site.efficiency, shift)),
      };
    },

    show_travel: ({ visible }) => {
      site.setTravelVisible(visible);
      document.getElementById('travelBtn').classList.toggle('on', visible);
      if (visible) {
        app.setStep(6);
        app.setView('overview');
      } else app.refresh();
      const t = site.travel;
      return {
        result: { 显示: visible, AGV_m: { 载卷: +(t.agv.loaded / 1000).toFixed(1), 空车: +(t.agv.empty / 1000).toFixed(1) }, 行车_m: { 大车: +(t.crane.bridge / 1000).toFixed(1), 小车: +(t.crane.trolley / 1000).toFixed(1), 起升: +(t.crane.hoist / 1000).toFixed(1) }, 钩心高度_m: [+(t.crane.zMin / 1000).toFixed(2), +(t.crane.zMax / 1000).toFixed(2)] },
        chip: visible ? '轨迹线 · 行程表' : '隐藏轨迹',
      };
    },

    list_library: async () => {
      const lib = app.library;
      await lib.reload();
      return {
        result: {
          产品库: lib.products.map((p) => p.model ?? p.name),
          场景库: lib.assets.map((a) => ({ id: a.id, 名称: a.name, 类型: a.kind, 状态: a.status, 说明: a.message || undefined })),
          已放入场景: lib.placedList(),
        },
        chip: `产品 ${lib.products.length} · 场景 ${lib.assets.length}`,
      };
    },

    place_asset: async ({ asset, ref, east_m = 0, north_m = 0, x_mm, y_mm, rotate_deg, size_m }) => {
      let x = x_mm;
      let y = y_mm;
      if (ref) {
        const base = site.findPoint(ref);
        if (!base) throw new Error(`参考点位 ${ref} 不存在，现有：${site.points().map((p) => p.id).join('、')}`);
        x = base.x + east_m * 1000;
        y = base.y + north_m * 1000;
      }
      if ((x === undefined) !== (y === undefined)) throw new Error('坐标要成对给：x_mm 和 y_mm，或 ref 加 east_m/north_m');
      const b = site.built?.bounds;
      if (b && x !== undefined && (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) throw new Error(`位置 (${Math.round(x)}, ${Math.round(y)}) 在厂房外，厂房范围 X ${Math.round(b.minX)}–${Math.round(b.maxX)}、Y ${Math.round(b.minY)}–${Math.round(b.maxY)} mm`);
      const r = await app.library.place(asset, { x, y, size: size_m, rotate: rotate_deg });
      app.setView('overview');
      return { result: r, chip: `放入 ${r.名称}` };
    },

    remove_asset: ({ asset }) => {
      if (!app.library.remove(asset)) throw new Error(`场景里没有 ${asset}`);
      app.bump();
      return { result: { 已移出: asset }, chip: `移出 ${asset}` };
    },

    load_site_asset: async ({ asset }) => {
      const r = await app.library.loadSite(asset);
      return { result: r, chip: r.底图 ? `底图 ${r.底图}` : `图纸 ${r.图纸}` };
    },

    record_video: ({ on }) => {
      const recording = app.record(on);
      return { result: { 录制中: recording }, chip: recording ? '开始录制' : '停止录制 · 已下载' };
    },

    set_camera: ({ view, point_id }) => {
      if (view === 'point' && !site.findPoint(point_id)) throw new Error(`点位 ${point_id} 不存在`);
      app.setView(view, { id: point_id });
      return { result: { 镜头: view }, chip: { overview: '总览', top: '俯视', follow: '跟随 AGV', crane: '行车', point: point_id }[view] };
    },
  };

  const ext = createExtTools(app, { runCore: (name, args) => H[name](args ?? {}) });
  return {
    schemas: [...SCHEMAS, ...ext.schemas],
    stateSummary: () => ({ ...stateSummary(), ...ext.state() }),
    async run(name, args) {
      const handler = H[name] ?? ext.handlers[name];
      if (!handler) throw new Error(`没有工具 ${name}`);
      return handler(args ?? {});
    },
  };
}
