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
  fn('list_library', '列出资源库：标准产品库车型，当前项目的产品库、场景和文件（用户上传并已转换的模型/图纸/图片），以及已放进场景的模型。'),
  fn('place_asset', '把产品库或场景库里的三维模型（起重机、大车、铝卷、设备等）放进当前厂房，可一次放多个。图纸生成的厂房里可按跨定位（bay + along_m），起重机类模型用 mount=runway 装到该跨行车轨道上（自动横跨该跨、替换该跨的示意行车；按模型原尺寸，不缩放，跨度对不上会提示）。不给位置就放在中间跨的中部。AGV + 行车工序方案里位置按用户原话给：绝对坐标 x_mm/y_mm，或参考点位 ref 加偏移 east_m/north_m（X 向东、Y 向北），已放过的会挪到新位置；用户没说位置时先问，不要自己定。', {
    asset: { type: 'string', description: '模型 id 或名称，如 “起重机”“铝卷”' },
    bay: { type: 'string', description: '跨名，如 A、B（图纸生成的厂房）' },
    along_m: { type: 'number', description: '沿跨长方向距厂房起点的米数' },
    ref: { type: 'string', description: '参考点位编号，如 RM-01、H-01（工序方案）' },
    east_m: { type: 'number', description: '相对参考点向东米数，向西为负' },
    north_m: { type: 'number', description: '相对参考点向北米数，向南为负' },
    x_mm: { type: 'number' },
    y_mm: { type: 'number' },
    mount: { type: 'string', enum: ['floor', 'runway'], description: 'floor 放地面（默认）；runway 装到行车轨道上' },
    count: { type: 'integer', description: '放几个，沿跨长方向排成一排，1–20' },
    size_m: { type: 'number', description: '把最长边缩放到这个米数（可选；默认按模型原尺寸，毫米模型自动换算）' },
    heading_deg: { type: 'number', description: '绕竖轴转角（度，俯视逆时针）' },
    elevation_m: { type: 'number', description: '底面离地高度（米），如放在货架上' },
  }, ['asset']),
  fn('move_asset', '移动 / 旋转 / 缩放已放入场景的模型实例。可给绝对位置（x_mm/y_mm 或 bay/along_m）、相对平移（east_m/north_m）、绝对朝向 heading_deg 或相对转角 rotate_deg、新的最长边 size_m。', {
    asset: { type: 'string', description: '实例 id（list_library 的 已放入场景.id）或模型名' },
    bay: { type: 'string' },
    along_m: { type: 'number' },
    x_mm: { type: 'number' },
    y_mm: { type: 'number' },
    east_m: { type: 'number', description: '向 +X 平移米数' },
    north_m: { type: 'number', description: '向 +Y 平移米数' },
    heading_deg: { type: 'number' },
    rotate_deg: { type: 'number' },
    size_m: { type: 'number' },
    elevation_m: { type: 'number' },
  }, ['asset']),
  fn('remove_asset', '把已放进场景的模型实例移出；asset=all 清空全部。', { asset: { type: 'string' } }, ['asset']),
  fn('add_to_product_library', '把场景库里上传好的模型登记进产品库（之后在产品库里能看到并直接放入场景）。', {
    asset: { type: 'string', description: '场景库模型 id 或名称' },
    model: { type: 'string', description: '产品型号 / 显示名，默认用文件名' },
    name: { type: 'string', description: '中文名称，如 “双梁桥式起重机”' },
    category: { type: 'string', description: '分类（英文小写），如 overhead_crane、coil、vehicle；不填按名称推断' },
  }, ['asset']),
  fn('load_site_asset', '载入场景库里的 DXF/DWG 图纸。普通厂房图纸：识别柱网、跨、吊车梁、墙、门窗和设备，生成新的三维厂房并播放建造过程（地坪→立柱→吊车梁→行车→围护→设备→屋面）。带卫华约定图层（A-WALL/AGV-PATH/AGV-STAT）的图纸：替换 AGV + 行车工序方案的厂房。用户明确只要"叠底图""只做参考"时传 overlay=true，只把线条铺在地面上，不建厂房。', { asset: { type: 'string' }, overlay: { type: 'boolean', description: '只叠为底图参考，不生成厂房' } }, ['asset']),
  fn('exit_scene', '离开图纸生成的厂房，回到原来的 AGV + 行车工序方案。'),
  fn('read_equipment_drawing', '读取场景库里的二维设备图（起重机、大车、小车、铝卷等设备的 DWG/DXF，不是厂房图）：返回各视图（标题、图面尺寸）、所有尺寸标注值、参数表与标题栏文字、各视图主要闭合轮廓（id 如 V1-P3，可用于 extrude 零件）。图面比例会按标注自动换算成实际 mm。', {
    asset: { type: 'string', description: '图纸 id 或名称' },
  }, ['asset']),
  fn('get_profile_points', '取某个轮廓的全部点坐标（mm，相对所在视图左下角），用于核对外形或手工改写 points_mm。', {
    id: { type: 'string', description: '轮廓 id，如 V1-P3' },
  }, ['id']),
  fn('view_images', '查看场景库里的参考图片（设备照片、效果图、三维截图），图片会随后发给你。只用来判断外观、颜色、零件形状和相对位置，不能当尺寸来源。不给 assets 就看全部图片（最多 4 张）。', {
    assets: { type: 'array', items: { type: 'string' }, description: '图片 id 或名称' },
  }),
  fn('build_equipment_model', '按零件清单用 three.js 建设备三维模型，导出 GLB 存入场景库，并（默认）登记进产品库，之后可用 place_asset 放进厂房。外形总尺寸必须来自图纸或用户；拼出的模型外形和 overall 相差超过 5% 会被拒绝。同名再建会替换本次会话里的旧版本。', {
    spec: {
      type: 'object',
      description: '坐标：x 沿设备长度（起重机为跨度方向），y 向上（底面 0），z 沿宽度；position_mm 是零件中心；单位 mm。',
      properties: {
        name: { type: 'string', description: '型号或名称，如 “QD32t-22.5m 双梁桥式起重机”' },
        label: { type: 'string', description: '中文名称' },
        category: { type: 'string', description: 'overhead_crane / trolley / vehicle / coil / equipment' },
        overall: {
          type: 'object',
          properties: { length_mm: { type: 'number' }, width_mm: { type: 'number' }, height_mm: { type: 'number' }, source: { type: 'string', enum: ['图纸标注', '图纸量取', '参数表', '用户给定'] } },
          required: ['length_mm', 'width_mm', 'height_mm', 'source'],
        },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              shape: { type: 'string', enum: ['box', 'cylinder', 'tube', 'ibeam', 'boxgirder', 'extrude'] },
              size_mm: { type: 'array', items: { type: 'number' }, description: 'box：[长 x, 高 y, 宽 z]' },
              length_mm: { type: 'number', description: 'cylinder/tube/ibeam/boxgirder 的长度' },
              axis: { type: 'string', enum: ['x', 'y', 'z'], description: '长度方向，默认 x' },
              radius_mm: { type: 'number', description: 'cylinder 半径' },
              outer_radius_mm: { type: 'number', description: 'tube 外半径（钢卷/铝卷外径的一半）' },
              inner_radius_mm: { type: 'number', description: 'tube 内半径' },
              height_mm: { type: 'number', description: 'ibeam/boxgirder 截面高' },
              width_mm: { type: 'number', description: 'ibeam/boxgirder 截面宽' },
              web_mm: { type: 'number' },
              flange_mm: { type: 'number' },
              wall_mm: { type: 'number', description: 'boxgirder 板厚' },
              profile: { type: 'string', description: 'extrude：read_equipment_drawing 给出的轮廓 id' },
              points_mm: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'extrude：自定义轮廓点 [[x,y],…]' },
              plane: { type: 'string', enum: ['xy', 'zy', 'xz'], description: 'extrude 轮廓所在面：xy 主视（图上 x→长度，y→高度，沿宽度拉伸），zy 侧视（图上 x→宽度），xz 俯视（图上 y→宽度，向上拉伸）' },
              depth_mm: { type: 'number', description: 'extrude 拉伸厚度' },
              position_mm: { type: 'array', items: { type: 'number' }, description: '零件中心 [x, y, z]' },
              rotation_deg: { type: 'array', items: { type: 'number' } },
              repeat: { type: 'object', properties: { count: { type: 'integer' }, step_mm: { type: 'array', items: { type: 'number' } } } },
              color: { type: 'string', description: '如 黄、红、深灰、#f2b705' },
              metal: { type: 'number' },
              rough: { type: 'number' },
              source: { type: 'string', enum: ['图纸标注', '图纸量取', '参数表', '用户给定', '图片估计'] },
            },
            required: ['name', 'shape', 'position_mm', 'source'],
          },
        },
      },
      required: ['name', 'overall', 'parts'],
    },
    register_product: { type: 'boolean', description: '是否登记进产品库，默认 true' },
  }, ['spec']),
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
  fn('play_animation', '播放动画。工序方案里是 AGV + 行车工序；图纸生成的厂房里是建造过程。mode: all 从头播；step 只播第 step 步（镜头对准该步）；next 下一步；pause 暂停；resume 继续。speed 为倍速 0.25–16。', {
    mode: { type: 'string', enum: ['all', 'step', 'next', 'pause', 'resume'] },
    step: { type: 'integer', minimum: 1, maximum: 9 },
    speed: { type: 'number' },
  }, ['mode']),
  fn('seek', '把时间轴跳到某一秒。', { seconds: { type: 'number' } }, ['seconds']),
  fn('set_takt', '设定目标节拍（秒/件），判断能否达到并给出瓶颈和建议。', { target_seconds: { type: 'number' } }, ['target_seconds']),
  fn('simulate_shift', '模拟一个班次，统计完成件数和设备忙闲。结果确定、可复现。', {
    hours: { type: 'number', description: '班次时长 0.5–24 小时' },
  }, ['hours']),
  fn('show_travel', '显示或隐藏行程可视化：视口轨迹线、行程表、甘特图。', { visible: { type: 'boolean' } }, ['visible']),
  fn('set_camera', '切换镜头。overview 总览，top 俯视；工序方案里 follow 跟随 AGV、crane 跟行车、point 看点位；图纸生成的厂房里 follow 是站在某跨里看（可给 bay），crane 看某跨的行车（bay），point 看某个坐标或已放入的模型（asset）。', {
    view: { type: 'string', enum: ['overview', 'top', 'follow', 'crane', 'point'] },
    point_id: { type: 'string', description: 'view=point 时的点位编号（工序方案）' },
    bay: { type: 'string', description: '跨名（图纸生成的厂房）' },
    asset: { type: 'string', description: 'view=point 时看这个已放入的模型' },
    x_mm: { type: 'number' },
    y_mm: { type: 'number' },
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
  // The current site changes when a drawing is built as a new plant, so always look it up.
  const site = new Proxy({}, {
    get(_, key) {
      const s = app.site;
      const v = s[key];
      return typeof v === 'function' ? v.bind(s) : v;
    },
    set(_, key, value) {
      app.site[key] = value;
      return true;
    },
  });
  const span = () => Math.abs(site.runway.high - site.runway.low) / 1000;
  const maxLift = () => 8.5;

  const sceneSummary = () => ({
    模式: '图纸生成的厂房',
    图纸: site.sourceName,
    识别结果: site.summary,
    跨: site.bays.map((b) => ({ 跨: b.name, 跨度_m: +(b.span / 1000).toFixed(1), 中心线_mm: Math.round(b.centre) })),
    沿跨方向: site.alongX ? '+X（along_m 从厂房西端算起）' : '+Y（along_m 从厂房南端算起）',
    厂房范围_mm: site.hallBounds,
    示意行车: site.craneInfo().map((c) => ({ 跨: c.bay, 跨度_m: c.span / 1000, 已被模型替换: c.replaced })),
    建造步骤: site.process.steps.map((s) => ({ n: s.n, 阶段: s.title, 用时_s: s.duration, 内容: s.detail })),
    已放入模型: app.library.placedList(),
    播放: { 时间_s: +site.time.toFixed(1), 总长_s: +site.duration.toFixed(1), 播放中: site.playing, 分步: site.window?.step ?? null, 倍速: site.speed, 建造完成: site.time >= site.duration },
  });

  // Frame placed model instances: aim at their middle height, fit the whole row.
  const look = (entries) => {
    const list = entries.filter(Boolean);
    if (!list.length) return;
    const xs = list.map((e) => e.x);
    const ys = list.map((e) => e.y);
    const spread = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 1000;
    const e = list[0];
    app.setView('point', { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2, h: e.base + e.height / 2, size: e.size + spread });
  };

  // Tools that only make sense for the AGV + crane process plant.
  const processOnly = (name) => {
    if (site.isScene) throw new Error(`${name}只用于 AGV + 行车工序方案；当前是按图纸 ${site.sourceName} 生成的厂房。需要的话先调用 exit_scene 回到工序方案`);
  };

  const stateSummary = () => {
    if (site.isScene) return sceneSummary();
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
      项目库: app.library?.ws ? app.library.summary() : null,
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
      processOnly('顶部流程步骤');
      check('步骤', step, 1, 7, '');
      app.setStep(step);
      const result = { step };
      if (step === 7) result.note = '第 7 步出图下发是后期功能，本轮只有入口和说明（PRD R14）。';
      return { result, chip: `第 ${step} 步` };
    },

    import_site: () => {
      app.exitScene();
      app.setStep(1);
      app.setView('overview');
      const p = site.base;
      const result = { 文件: site.sourceName, 厂房_m: `${site.built.size.x} × ${site.built.size.y}`, 工位: p.stations.map((s) => s.id), 吊车梁: p.beams.length, AGV路线: p.paths.length, 柱: p.columns.length, 设备: p.machines.length, 货架: p.racks.length, 行车跨度_m: span() };
      return { result, chip: `识别 ${p.stations.length} 个工位、${p.beams.length} 条吊车梁` };
    },

    add_station: ({ id, name, role, ref, east_m = 0, north_m = 0, x_mm, y_mm }) => {
      processOnly('作业点位');
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
      processOnly('AGV 选型');
      const product = await app.selectProduct(model);
      app.setStep(2);
      app.bump();
      return { result: { 已选: product.model, 参数: app.vehicleState(), 范围: product.params }, chip: product.model, card: specCard() };
    },

    set_params: (args) => {
      processOnly('AGV / 行车参数');
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
      processOnly('工序表');
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
      processOnly('工序确认');
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
      if (!site.isScene) app.setStep(4);
      if (site.isScene && mode === 'resume' && site.time >= site.duration) mode = 'all';
      const r = app.play({ mode, step, speed });
      const s = r.window ? site.process.steps[r.window.step - 1] : null;
      const all = site.isScene ? '建造全过程' : '全流程';
      return {
        result: s ? { 播放: `第 ${s.n} 步 ${s.title}`, 用时_s: +s.duration.toFixed(1), 说明: s.detail } : { 播放: mode, [`${all}_s`]: +site.duration.toFixed(1), 倍速: site.speed },
        chip: s ? `第 ${s.n} 步 · ${s.title}` : `${{ all, pause: '暂停', resume: '继续' }[mode] ?? mode} · ${site.speed}×`,
      };
    },

    seek: ({ seconds }) => {
      check('时刻', seconds, 0, site.duration, 's');
      app.seek(seconds);
      const s = site.stepAt();
      return { result: { 时刻: fmtTime(seconds), 当前工序: s.title }, chip: fmtTime(seconds) };
    },

    set_takt: ({ target_seconds }) => {
      processOnly('节拍分析');
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
      processOnly('班次模拟');
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
      processOnly('行程可视化');
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
          当前厂房: site.isScene ? `图纸生成：${site.sourceName}` : 'AGV + 行车工序方案',
          ...lib.summary(),
          全部上传文件: lib.assets.map((a) => ({ id: a.id, 名称: a.name, 类型: a.kind, 状态: a.status, 说明: a.message || undefined })),
          已放入场景: lib.placedList(),
        },
        chip: `标准产品 ${lib.std.length} · ${lib.ws.active.name}`,
      };
    },

    place_asset: async ({ asset, bay, along_m, ref, east_m = 0, north_m = 0, x_mm, y_mm, mount, count, size_m, heading_deg, elevation_m }) => {
      let x = x_mm;
      let y = y_mm;
      if (ref) {
        const base = site.findPoint?.(ref);
        if (!base) throw new Error(`参考点位 ${ref} 不存在${site.points ? `，现有：${site.points().map((p) => p.id).join('、')}` : ''}`);
        x = base.x + east_m * 1000;
        y = base.y + north_m * 1000;
      }
      if ((x === undefined) !== (y === undefined)) throw new Error('坐标要成对给：x_mm 和 y_mm，或 ref 加 east_m/north_m');
      const b = site.built?.bounds;
      if (b && x !== undefined && (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) throw new Error(`位置 (${Math.round(x)}, ${Math.round(y)}) 在厂房外，厂房范围 X ${Math.round(b.minX)}–${Math.round(b.maxX)}、Y ${Math.round(b.minY)}–${Math.round(b.maxY)} mm`);
      const r = await app.library.place(asset, { bay, along: along_m, x, y, mount, count, size: size_m, heading: heading_deg, elevation: elevation_m });
      if (site.isScene) look(r.实例.map((e) => app.library.findPlaced(e.id)));
      else app.setView('overview');
      return { result: r, chip: `放入 ${r.名称}${r.实例.length > 1 ? ` × ${r.实例.length}` : ''}` };
    },

    move_asset: ({ asset, bay, along_m, x_mm, y_mm, east_m, north_m, heading_deg, rotate_deg, size_m, elevation_m }) => {
      const r = app.library.move(asset, { bay, along: along_m, x: x_mm, y: y_mm, east: east_m, north: north_m, heading: heading_deg, rotate: rotate_deg, size: size_m, elevation: elevation_m });
      if (site.isScene) look([app.library.findPlaced(r.id)]);
      return { result: r, chip: `调整 ${r.id}` };
    },

    remove_asset: ({ asset }) => {
      if (/^(all|全部|所有)$/i.test(String(asset))) {
        const lib = app.library;
        const ids = [...lib.placed.keys()];
        for (const id of ids) lib.remove(id);
        app.bump();
        return { result: { 已移出: ids }, chip: `清空 ${ids.length} 个模型` };
      }
      const key = app.library.remove(asset);
      if (!key) throw new Error(`场景里没有 ${asset}。已放入：${app.library.placedList().map((p) => p.id).join('、') || '无'}`);
      app.bump();
      return { result: { 已移出: key }, chip: `移出 ${key}` };
    },

    add_to_product_library: async ({ asset, model, name, category }) => {
      const p = await app.library.registerProduct(asset, { model, name, category });
      return { result: { 已登记: { id: p.id, 型号: p.model, 名称: p.name, 分类: p.category }, 说明: '已出现在左侧产品库，可用 place_asset 放入场景' }, chip: `入产品库 ${p.model}` };
    },

    load_site_asset: async ({ asset, overlay }) => {
      const r = await app.library.loadSite(asset, { overlay: overlay === true });
      return { result: r, chip: r.底图 ? `底图 ${r.底图}` : r.模式?.startsWith('图纸生成') ? `生成厂房 · ${r.图纸}` : `图纸 ${r.图纸}` };
    },

    read_equipment_drawing: async ({ asset }) => {
      const r = await app.library.readDrawing(asset);
      const s = r.summary;
      return { result: s, chip: `读图 ${r.asset.name} · ${s.视图.length} 视图 · ${s.标注总数} 个标注` };
    },

    get_profile_points: ({ id }) => {
      const pts = app.library.profiles[id];
      if (!pts) throw new Error(`没有轮廓 ${id}；先调 read_equipment_drawing，轮廓 id 见各视图的 主要轮廓`);
      return { result: { id, 点: pts.map((p) => [Math.round(p.x), Math.round(p.y)]) }, chip: `轮廓 ${id} · ${pts.length} 点` };
    },

    view_images: async ({ assets }) => {
      const images = await app.library.imageData(assets ?? []);
      return {
        result: { 图片: images.map((i) => ({ 名称: i.name, 像素: i.size })), 说明: '图片随后作为用户消息发给你' },
        images: images.map((i) => ({ name: i.name, url: i.url })),
        chip: `看图 ${images.map((i) => i.name).join('、')}`,
      };
    },

    build_equipment_model: async ({ spec, register_product }) => {
      const r = await app.library.buildModel(spec, { register: register_product !== false });
      return { result: { ...r, 下一步: '可用 place_asset 放进厂房（起重机 mount=runway）；图片估计的零件请提醒用户核对' }, chip: `建模 ${r.名称} · ${r.零件} 个零件` };
    },

    exit_scene: () => {
      if (!site.isScene) throw new Error('当前已经是 AGV + 行车工序方案');
      app.exitScene();
      return { result: { 已返回: 'AGV + 行车工序方案', 说明: '图纸生成的厂房和其中放入的模型已移除，需要时可以重新 load_site_asset' }, chip: '返回工序方案' };
    },

    record_video: ({ on }) => {
      const recording = app.record(on);
      return { result: { 录制中: recording }, chip: recording ? '开始录制' : '停止录制 · 已下载' };
    },

    set_camera: ({ view, point_id, bay, asset, x_mm, y_mm }) => {
      if (site.isScene) {
        const opts = { bay };
        if (bay) site.bayPoint(bay); // throws a readable error for an unknown bay
        const placed = view === 'point' && asset ? app.library.findPlaced(asset) : null;
        if (asset && view === 'point' && !placed) throw new Error(`场景里没有 ${asset}`);
        if (view === 'point' && !placed && (!Number.isFinite(x_mm) || !Number.isFinite(y_mm))) throw new Error('view=point 需要 asset 或 x_mm/y_mm');
        if (placed) look([placed]);
        else app.setView(view, view === 'point' ? { x: x_mm, y: y_mm } : opts);
        return { result: { 镜头: view, 跨: bay ?? null }, chip: { overview: '总览', top: '俯视', follow: `室内${bay ? ` · ${bay} 跨` : ''}`, crane: `行车${bay ? ` · ${bay} 跨` : ''}`, point: asset ?? '定位' }[view] };
      }
      if (view === 'point' && !site.findPoint(point_id)) throw new Error(`点位 ${point_id} 不存在`);
      app.setView(view, { id: point_id });
      return { result: { 镜头: view }, chip: { overview: '总览', top: '俯视', follow: '跟随 AGV', crane: '行车', point: point_id }[view] };
    },
  };

  const extApp = new Proxy(app, { get: (target, key) => (key === 'site' ? site : Reflect.get(target, key)) });
  const ext = createExtTools(extApp, { runCore: (name, args) => H[name](args ?? {}) });
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
