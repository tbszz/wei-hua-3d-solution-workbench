// The chat agent: an OpenAI-compatible tool loop against /llm (the Vite proxy to magpie's Doubao),
// streaming text into the panel and running tools against the scene. Falls back to a small local
// intent parser when the model endpoint is unreachable, using the same tools.

// Doubao through the local magpie proxy.
const MODEL = 'trae-cn/seed-code-pro-0430';
const MAX_ROUNDS = 12;

const SYSTEM = `你是「小华」，卫华集团「3D 方案工作台」里的方案助手。界面左边是 three.js 三维引擎（客户厂房、AGV、双梁桥式起重机、钢卷），右边是你。你只能通过工具改动左边。

规则：
1. 用户要改方案、看动画、算效率、看行程时，必须调用工具；数字一律以工具返回为准，不要编。需要时可一次并行调用多个工具。
2. 参数只来自产品库、CAD 或用户原话。工具报错拒绝时，把原因和可用范围原样告诉用户，不要自作主张换个值重试。
3. 坐标约定：X 向东、Y 向北，单位 mm。"东边 2 米" 即 east_m=2。
4. 流程说明：把用户的话整理成 set_process（取货点、吊装交接点、放卷点、充电位），出确认卡后等用户确认；用户说"确认"再调 confirm_process。
5. 功能流程 7 步：1 图纸变三维·点位标定，2 选型与参数，3 流程说明，4 流程动画，5 效率与节拍，6 行程可视化，7 出图下发（后期，只做介绍）。
6. 回答用简体中文，一到三句话，给关键数字，不要 Markdown 标题和长列表。速度、时间是示意值，必要时提一句。
7. 不知道当前状态时先调 get_scene_state。
8. 每条用户指令只执行一次：工具返回成功就停止，不要为同一条指令再次调用同一工具。"再加一台""车长加 200"这类相对说法，以用户发话时的状态为基准算一次。
9. 零件建模（text-to-cad）：用户要做鞍座、货架、钢卷、托盘等零件三维模型时调 cad_build_part；用户给的是零件 CAD 图纸（场景库里的 DXF/DWG）时调 cad_from_drawing。要"入库"就 register_product=true。生成要几十秒，先说一句"正在建模"。
10. 货位与库存：布置库区用 layout_slots（坐标要在 get_scene_state 的「厂房范围_mm」内，不给起点就自动放在南侧）；输入库存用 fill_inventory，回答时说清"已用货位 n 个，空置货位 n 个"。
11. 行业选型：先 recommend_products（行业 + 单件重量），再 adapt_product 按卷材尺寸/重量适配车体参数；用户要求应用或另存型号时再传 apply / save_as。
12. 技术方案流程演示：用户给流程信息/工序节点时调 define_process，再 play_flow（全流程 mode=full；讲某个节点 mode=node）。这只是说明流程，不做仿真。
13. 生产仿真：用户要评估产线产出、各工位节拍、瓶颈时调 simulate_line（给 stations；用已定义流程用 source=flow；不给则用当前 AGV+行车方案），回答给实际产出/小时、班产范围、瓶颈和"瓶颈加机对比"。
13b. 目标产能：用户说"每分钟跑 3 次""60 秒内要跑 5 次""一小时要出 20 卷"这种"多少时间内跑多少次"的目标时调 set_rate_goal（seconds=时间窗口秒数，count=次数；flow 选流程：current 当前 AGV+行车方案（默认）、sample 示例方案、flow 已定义的工艺流程；用户说的是哪个流程不清楚、而状态里有多个可选时先问一句）。用户要"按这个改/应用到方案"时再传 apply=true（只对 current）。回答给要求节拍、当前节拍、能否达到、瓶颈和各设备达标需要几台；超过模型上限（AGV 4 台、行车 1 台）就说要提速或放宽目标。只说"节拍 X 秒"时仍用 set_takt。
14. 上传文件：用户只能在你这里上传文件（左边资源库只展示和手动放入）。上传结果会以「（用户上传了 n 个文件：…）」告诉你 id、类型和是否可用。三维模型要放进厂房时用 place_asset：位置只按用户原话（"放在 H-01 东边 5 米"→ ref=H-01, east_m=5；"x 30 米 y 12 米"→ x_mm=30000, y_mm=12000；"转 90 度"→ rotate_deg=90），用户没说位置就先问一句放哪，不要自己定；"往北挪 2 米"按「已放入模型」里的当前坐标算一次。图纸（DXF/DWG）用 load_site_asset 载入：带卫华工位图层的替换工序方案厂房；普通厂房图纸会识别柱网、跨、吊车梁、墙和设备，生成新厂房，播完建造过程后在厂房里接着播 AGV + 行车工序动画（见下面「图纸生成的厂房」）。用户明确说"叠底图""只做参考"时才传 overlay=true 叠为底图。转换失败的把原因原样告诉用户。
图纸生成的厂房（状态 JSON 里「模式」为「图纸生成的厂房」）：用户上传普通厂房 DWG/DXF 后，load_site_asset 识别柱网、跨、吊车梁、墙和设备，生成厂房并播放建造过程（地坪→立柱→吊车梁→行车→围护→设备→屋面）。系统同时自动在一个跨里排好 AGV 环线和四个点位（CHG-01 充电位、RM-01 原料上料位、H-01 吊装交接点、FG-01 成品区），厂房建好后接着循环播放工序动画：AGV 接卷 → 跑环线送到交接点 → 该跨行车夹卷吊到成品区 → AGV 空车返回。这不是另一个模式，同一个厂房里先建造后工序。这时：
  - "播放工序动画 / 看 AGV 跑 / 看行车吊运" 用 play_animation mode=process；"重新建造" 是 play_animation mode=all；分步用 mode=step，步骤编号见状态里的「步骤」（建造步骤在前，工序步骤在后）。
  - 镜头：set_camera follow 不给 bay 就跟随 AGV，crane 不给 bay 就跟工序里的行车；给 bay 是看那一跨；point 给 point_id（如 H-01）看点位。
  - 回答工序问题用状态里的「工序」：跨、环线长、单循环、节拍、瓶颈。速度为示意值。
  - 如果状态里「工序」是「未排出」，如实说原因（例如跨太窄），厂房仍然可以看建造。
  - 用户说"把起重机/大车/铝卷放进来"时，先看状态里的资源库或调 list_library 找模型，再调 place_asset。位置用跨（bay：A、B…）和 along_m（沿跨长方向米数）表达；起重机、行车类模型用 mount=runway 装到该跨轨道上；"放 5 卷铝卷"用 count=5。
  - 已放入的模型用 move_asset 移动/旋转/缩放，用 remove_asset 移出；实例 id 见 已放入模型。
  - 用户上传的模型想长期复用、或说"放进产品库"时，调 add_to_product_library。
  - 选型（select_product）、参数（set_params：车体、台数、速度、吊运高度）、节拍目标（set_takt）、目标产能（set_rate_goal）、班次（simulate_shift）、行程（show_travel）在图纸厂房里同样可用，作用于该跨的 AGV 和行车；下方甘特图、工序表、点位表、选型参数、效率节拍、行程统计面板也都对应它。点位由系统自动排布，add_station / set_process 只在示例方案里用。用户明确要回示例方案时才调 exit_scene。
  - 资源库里没有用户要的模型时，直说没有，并请用户在左侧资源库上传（支持 GLB/GLTF/OBJ/STL/FBX/STEP），不要用别的模型冒充。

不凭空生成设备（最重要）：
- 用户只给了厂区图纸。厂房里的行车是按吊车梁位置画的「示意行车」，只表示位置和跨度，不是具体型号。
- 用户要某台具体的起重机、大车、铝卷或其他设备（"生成一台 32 吨双梁起重机""做一个大车模型""铝卷做成 1.8 米直径"），而资源库里没有对应模型时：不要调用任何工具去拼凑、替代或缩放别的模型，也不要自己编尺寸、吨位、外形。直接问用户要这台设备的图纸或三维模型，说明需要什么：设备总图或三维模型文件（STEP/GLB/OBJ/STL/FBX），以及型号、关键尺寸（跨度、起升高度、外形尺寸等）。
- 用户给了尺寸但没给模型、也没给设备图时，同样先确认要不要等模型或图纸，不要用现有模型改尺寸冒充。
- 设备图（DWG/DXF 里画的是起重机、大车等设备的视图，不是厂房）不要用 load_site_asset 去生成厂房。

按二维设备图建三维模型（用户给了设备图纸，可能还有几张外观图片）：
1. 先调 read_equipment_drawing 读图：得到各视图（主视/侧视/俯视…）、全部尺寸标注、参数表和标题栏文字、各视图主要轮廓 id。
2. 有图片就调 view_images 看图，只用来判断外观：颜色、零件形状、零件大致相对位置、梁是箱形还是工字。图片里的尺寸一律不可信。
3. 总长、总宽、总高（起重机即跨度方向长度、端梁方向宽度、总高）必须来自图纸标注、图纸量取、参数表或用户原话。图纸和参数都找不到时，停下来问用户，不要建模。
4. 调 build_equipment_model 一次交完整 spec。坐标：x 沿设备长度（起重机为跨度方向），y 向上（地面或轨顶为 0），z 沿宽度，position_mm 是零件中心，单位 mm。每个零件写 source：图纸标注 / 图纸量取 / 参数表 / 用户给定 / 图片估计。重复件（车轮、栏杆立柱）用 repeat。图纸有完整外形轮廓时可以用 shape=extrude + profile 轮廓 id 直接拉伸。
5. 工具报外形不符时按提示改尺寸或位置再调一次，最多改两次；仍不对就把问题告诉用户。
6. 建好后用一两句话汇报：外形尺寸及来源、零件数、哪些零件是按图片估计的（要请用户核对）。用户要求时再 place_asset 放进厂房，起重机用 mount=runway；跨度和所在跨对不上时如实转告，不要缩放凑数。`;

const SUGGESTIONS = ['做一个 Φ1800 钢卷用的 V 型鞍座并入库', '布置 A 区鞍座货位 2 行 10 列', '库存 14 卷，填进货位', '钢铁行业 25 吨钢卷怎么选型', '仿真 开卷60s 矫直75s 剪切90s 堆垛50s 跑 8 小时', '播放全流程', '只看第 3 步', '节拍改成 90 秒', '模拟一个 8 小时班', '显示行程', '车长改成 3200', '加一台 AGV', '在 H-01 东边 8 米加一个吊装点'];
const SCENE_SUGGESTIONS = ['播放工序动画', '跟随 AGV', '看行车吊运', '重新建造', '只看行车就位', '资源库里有哪些模型', '把起重机装到 B 跨轨道上', '在 A 跨放 5 卷铝卷', '俯视', '返回原方案'];

const KIND = { model: '三维模型', site: '图纸', image: '图片', document: '文档' };
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const usable = (a) => a.status === 'ready' || Boolean(a.url && a.status !== 'failed' && a.status !== 'unsupported');

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const num = (s) => (s in CN_NUM ? CN_NUM[s] : Number(s));

// Offline phrases for the generated plant (scene mode) and for the scene library.
function sceneIntent(t, app) {
  const calls = [];
  const lib = app.library;
  const site = app.site;
  let m;
  if (/(生成|建|造).*厂房|按图纸|图纸生成/.test(t)) {
    const drawing = [...lib.assets].reverse().find((a) => a.kind === 'site' && a.meta?.convention === 'generic' && a.status === 'ready');
    if (drawing) calls.push(['load_site_asset', { asset: drawing.id }]);
    return calls;
  }
  if (/返回|回到|退出/.test(t) && /原|方案|工序/.test(t)) return [['exit_scene', {}]];
  if (/资源库|有哪些模型|模型列表/.test(t)) calls.push(['list_library', {}]);
  if ((m = t.match(/入产品库|放进产品库|加到产品库|登记/)) && (m = t.match(/把?(.+?)(放|加|登记)/))) calls.push(['add_to_product_library', { asset: m[1] }]);
  else if (site.isScene && /放|装|摆/.test(t) && !/移出|删除|删掉|去掉/.test(t)) {
    // "把起重机装到 B 跨轨道上" / "在 A 跨放 5 卷铝卷"
    const any = t.match(/([A-Za-z])跨/);
    const count = t.match(/([\d一二两三四五六七八九十]+)(?:个|台|卷|件)/);
    const name = t.replace(/^(把|在)/, '').replace(/[A-Za-z]跨/g, '').replace(/([\d一二两三四五六七八九十]+)(个|台|卷|件)/, '').replace(/(放|装|摆|加)(到|进|在|上)?|轨道|行车梁|吊车梁|上|里|中|场景/g, '').trim();
    if (name) {
      const args = { asset: name };
      if (any) args.bay = any[1].toUpperCase();
      if (count) args.count = num(count[1]);
      if (/轨道|行车梁|吊车梁/.test(t) || /起重机|行车|吊车|crane/i.test(name)) args.mount = 'runway';
      calls.push(['place_asset', args]);
    }
  } else if (/移出|删除|删掉|去掉/.test(t) && (m = t.match(/(?:移出|删除|删掉|去掉)(.+)/))) calls.push(['remove_asset', { asset: /全部|所有/.test(m[1]) ? 'all' : m[1] }]);
  if (!site.isScene) return calls;
  if (/重新建造|重新播放|从头/.test(t)) calls.push(['play_animation', { mode: 'all' }]);
  else if (site.flow && /工序|AGV|跑环线|吊运|送卷/i.test(t) && /播放|看|动画|演示|跑/.test(t) && !/第/.test(t)) {
    calls.push(['play_animation', { mode: 'process' }]);
    if (/行车|吊运/.test(t)) calls.push(['set_camera', { view: 'crane' }]);
    else if (/跟随|跟着|AGV/i.test(t)) calls.push(['set_camera', { view: 'follow' }]);
    return calls;
  }
  if (site.flow && /跟随|跟着/.test(t) && /AGV|小车/i.test(t)) return [...calls, ['set_camera', { view: 'follow' }]];
  const steps = site.process.steps;
  const named = steps.find((s) => t.includes(s.title.slice(0, 2)) && /只看|播放|看/.test(t));
  if ((m = t.match(/第([1-9一二三四五六七八九])步/))) calls.push(['play_animation', { mode: 'step', step: num(m[1]) }]);
  else if (named && !/跨/.test(t)) calls.push(['play_animation', { mode: 'step', step: named.n }]);
  else if (/下一步/.test(t)) calls.push(['play_animation', { mode: 'next' }]);
  else if (/暂停/.test(t)) calls.push(['play_animation', { mode: 'pause' }]);
  else if (/继续/.test(t)) calls.push(['play_animation', { mode: 'resume' }]);
  else if (/建造|播放/.test(t) && !calls.length) calls.push(['play_animation', { mode: 'all' }]);
  const bay = t.match(/([A-Za-z])跨/)?.[1]?.toUpperCase();
  if (/俯视/.test(t)) calls.push(['set_camera', { view: 'top' }]);
  else if (/总览/.test(t)) calls.push(['set_camera', { view: 'overview' }]);
  else if (/看.*(行车|起重机)/.test(t) && !calls.some(([n]) => n === 'place_asset')) calls.push(['set_camera', { view: 'crane', bay }]);
  else if (/室内|跨里|进去/.test(t)) calls.push(['set_camera', { view: 'follow', bay }]);
  return calls;
}

// "每分钟跑 3 次" / "60 秒内跑 5 次" / "一小时出 20 卷" → set_rate_goal.
const CN = '[一二两三四五六七八九十]';
function rateIntent(t) {
  const m = t.match(new RegExp(String.raw`(每|一个?|(\d+(?:\.\d+)?|${CN})个?)(秒钟?|分钟|小时)(?:之?内|里)?(?:要|能|得|需要)?(?:跑|做|出|运|送|吊|完成)?(\d+|${CN})(次|卷|件|趟)`));
  if (!m) return null;
  const n = m[2] ? num(m[2]) : 1;
  const unit = { 秒: 1, 秒钟: 1, 分钟: 60, 小时: 3600 }[m[3]];
  const args = { seconds: n * unit, count: num(m[4]) };
  if (/工艺流程/.test(t)) args.flow = 'flow';
  else if (/示例方案/.test(t)) args.flow = 'sample';
  if (/应用|按这个改|直接改|照这个改/.test(t)) args.apply = true;
  return ['set_rate_goal', args];
}

// Offline: map common phrases to tool calls.
function localIntent(text, app) {
  const t = text.replace(/\s+/g, '');
  const rate = rateIntent(t);
  if (rate) return [rate];
  const scene = sceneIntent(t, app);
  if (scene.length || app.site.isScene) return scene;
  const calls = [];
  let m;
  if (/导入.*厂房|示例厂房/.test(t)) calls.push(['import_site', {}]);
  if ((m = t.match(/第([1-5一二三四五])步/))) calls.push(['play_animation', { mode: 'step', step: num(m[1]) }]);
  else if (/下一步/.test(t)) calls.push(['play_animation', { mode: 'next' }]);
  else if (/暂停/.test(t)) calls.push(['play_animation', { mode: 'pause' }]);
  else if (/全流程|播放/.test(t)) calls.push(['play_animation', { mode: 'all' }]);
  if ((m = t.match(/节拍.*?(\d+(?:\.\d+)?)/))) calls.push(['set_takt', { target_seconds: Number(m[1]) }]);
  if ((m = t.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十])个?小时/))) calls.push(['simulate_shift', { hours: num(m[1]) }]);
  const params = {};
  for (const [word, key] of [['车长', 'agv_length_mm'], ['车宽', 'agv_width_mm'], ['车高', 'agv_height_mm']]) {
    if ((m = t.match(new RegExp(`${word}\\D*?(\\d+(?:\\.\\d+)?)(米|m)?`)))) params[key] = Number(m[1]) * (m[2] || Number(m[1]) < 20 ? 1000 : 1);
  }
  if (/加一台AGV|再加.*AGV/i.test(t)) params.agv_count = app.site.agvCount + 1;
  if ((m = t.match(/(\d)台AGV/i))) params.agv_count = Number(m[1]);
  if (Object.keys(params).length) calls.push(['set_params', params]);
  if (/隐藏(行程|轨迹)/.test(t)) calls.push(['show_travel', { visible: false }]);
  else if (/行程|轨迹/.test(t)) calls.push(['show_travel', { visible: true }]);
  if (/^确认/.test(t)) calls.push(['confirm_process', {}]);
  if ((m = t.match(/流程.*?(RM-\d+).*?(H-\d+|吊装点).*?(FG-\w+|成品区).*?(CHG-\d+|充电位)/i))) {
    const r = app.site.roles;
    calls.push(['set_process', { pick: m[1].toUpperCase(), handoff: /H-/i.test(m[2]) ? m[2].toUpperCase() : r.handoff, drop: /FG-/i.test(m[3]) ? m[3].toUpperCase() : r.drop, home: /CHG-/i.test(m[4]) ? m[4].toUpperCase() : r.home }]);
  }
  if ((m = t.match(/在([A-Z]+-\d+)(东|西|南|北)边?(\d+(?:\.\d+)?)米加一?个?(吊装点|放卷点|标记点|点位?)/i))) {
    const d = Number(m[3]);
    const dir = { 东: [d, 0], 西: [-d, 0], 北: [0, d], 南: [0, -d] }[m[2]];
    const role = m[4] === '吊装点' ? 'handoff' : m[4] === '放卷点' ? 'drop' : 'marker';
    const prefix = { handoff: 'H', drop: 'FG', marker: 'P' }[role];
    let i = 2;
    while (app.site.findPoint(`${prefix}-0${i}`)) i += 1;
    calls.push(['add_station', { id: `${prefix}-0${i}`, role, ref: m[1].toUpperCase(), east_m: dir[0], north_m: dir[1] }]);
  }
  const lastModel = app.lastUploads?.filter((a) => a.kind === 'model' && usable(a)).at(-1);
  if (lastModel && (m = t.match(/放(?:在|到)([A-Z]+-\d+)(?:的)?(东|西|南|北)边?(\d+(?:\.\d+)?)米/i))) {
    const d = Number(m[3]);
    const [east_m, north_m] = { 东: [d, 0], 西: [-d, 0], 北: [0, d], 南: [0, -d] }[m[2]];
    calls.push(['place_asset', { asset: lastModel.id, ref: m[1].toUpperCase(), east_m, north_m }]);
  } else if (lastModel && (m = t.match(/放(?:在|到)([A-Z]+-\d+)/i))) calls.push(['place_asset', { asset: lastModel.id, ref: m[1].toUpperCase() }]);
  if (/俯视/.test(t)) calls.push(['set_camera', { view: 'top' }]);
  else if (/跟随/.test(t)) calls.push(['set_camera', { view: 'follow' }]);
  else if (/总览/.test(t)) calls.push(['set_camera', { view: 'overview' }]);
  return calls;
}

import { popButton } from './popout.js';

export class Agent {
  messages = [];

  model = null;

  online = false;

  busy = false;

  pending = []; // files staged in the chat box, uploaded on send

  constructor({ tools, app }) {
    this.tools = tools;
    this.app = app;
    this.msgs = document.getElementById('msgs');
    this.form = document.getElementById('form');
    this.input = document.getElementById('prompt');
    this.status = document.getElementById('llmStatus');
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${this.input.scrollHeight}px`;
    });
    document.getElementById('sugg').innerHTML = SUGGESTIONS.map((s) => `<button type="button">${s}</button>`).join('');
    document.getElementById('sugg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && !this.busy) this.send(b.textContent);
    });
    this.msgs.addEventListener('click', (e) => this.onCardAction(e));
    // A card popped out of the chat still runs its buttons.
    document.addEventListener('click', (e) => { if (e.target.closest('.pop-body .card')) this.onCardAction(e); });
    this.initAttach();
  }

  // Files: paper-clip button, drag onto the 小华 panel, or paste. They wait as chips until send,
  // so the user can say where to put them in the same message.
  initAttach() {
    this.attachEl = document.getElementById('attach');
    const picker = document.getElementById('chatFiles');
    picker.addEventListener('change', () => {
      this.stage([...picker.files]);
      picker.value = '';
    });
    const panel = this.form.closest('.agent') ?? this.form;
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    panel.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      panel.classList.add('dropping');
    });
    panel.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    panel.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) panel.classList.remove('dropping');
    });
    panel.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      panel.classList.remove('dropping');
      this.stage([...e.dataTransfer.files]);
    });
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      this.stage(files);
    });
    this.attachEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-unstage]');
      if (!b) return;
      this.pending.splice(Number(b.dataset.unstage), 1);
      this.renderAttach();
    });
  }

  stage(files) {
    for (const f of files) if (!this.pending.some((p) => p.name === f.name && p.size === f.size)) this.pending.push(f);
    this.renderAttach();
    this.input.focus();
  }

  renderAttach() {
    this.attachEl.hidden = !this.pending.length;
    this.attachEl.parentElement.classList.toggle('has-files', this.pending.length > 0);
    this.attachEl.innerHTML = this.pending.map((f, i) => `<span class="file"><b>${esc(f.name.split('.').pop().toUpperCase())}</b>${esc(f.name)}<small>${fmtSize(f.size)}</small><button type="button" data-unstage="${i}" title="移除">×</button></span>`).join('');
  }

  async init() {
    const wanted = new URLSearchParams(location.search).get('model');
    // /models is only a health check; the Doubao model id is pinned (override with ?model=).
    // Prefer the backend passthrough (/api/llm); fall back to the dev-server proxy (/llm).
    this.online = false;
    for (const base of ['/api/llm', '/llm']) {
      try {
        const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) throw new Error(String(r.status));
        this.llm = base;
        this.model = wanted || MODEL;
        this.online = true;
        break;
      } catch {
        // try the next route
      }
    }
    this.status.className = `st ${this.online ? 'on' : 'off'}`;
    this.status.textContent = this.online ? `在线 · ${this.model.split('/').pop()}` : '离线模式';
    this.status.title = this.online ? `${this.llm} · ${this.model}` : '连不上模型服务，用本地规则解析常用指令';
    const s = this.app.site;
    const offline = this.online ? '' : '（离线：按本地规则解析常用指令）';
    if (s.isScene) this.assistantBlock().text.textContent = `已按图纸 ${s.sourceName} 生成厂房。可以让我重播建造、看某一跨，或把资源库里的起重机、大车、铝卷放进来。${offline}`;
    else {
      const eff = s.efficiency;
      this.assistantBlock().text.textContent = `${s.sourceName} · ${this.app.product?.model ?? 'AGV'} + 行车，全流程 ${Math.round(s.duration)} s，节拍 ${eff.takt.toFixed(0)} s（瓶颈 ${eff.bottleneck}）。说一句话改方案，场景会跟着变。上传普通厂房图纸后，说"按图纸生成厂房"即可建新厂房。${offline}`;
    }
  }

  // Suggestion chips follow the plant on the left.
  setSuggestions(scene) {
    if (this.sceneSugg === scene) return;
    this.sceneSugg = scene;
    document.getElementById('sugg').innerHTML = (scene ? SCENE_SUGGESTIONS : SUGGESTIONS).map((s) => `<button type="button">${s}</button>`).join('');
  }

  submit() {
    const text = this.input.value.trim();
    const files = this.pending;
    if ((!text && !files.length) || this.busy) return;
    this.input.value = '';
    this.input.style.height = 'auto';
    this.pending = [];
    this.renderAttach();
    this.send(text, files);
  }

  scroll() {
    this.msgs.scrollTop = this.msgs.scrollHeight;
  }

  userBubble(text, files = []) {
    const el = document.createElement('div');
    el.className = 'u';
    if (text) el.append(document.createTextNode(text));
    if (files.length) {
      const list = document.createElement('div');
      list.className = 'ufiles';
      list.innerHTML = files.map((f) => `<span>📎 ${esc(f.name)}</span>`).join('');
      el.append(list);
    }
    this.msgs.append(el);
    this.scroll();
  }

  assistantBlock() {
    const block = document.createElement('div');
    block.className = 'a';
    this.msgs.append(block);
    const self = {
      block,
      text: null,
      chips: null,
      newText() {
        self.text = document.createElement('div');
        self.text.className = 'text';
        block.append(self.text);
        self.chips = null;
        return self.text;
      },
      chip(name, label, ok) {
        if (!self.chips) {
          self.chips = document.createElement('div');
          self.chips.className = 'chips';
          block.append(self.chips);
        }
        const c = document.createElement('span');
        c.className = `chip ${ok ? '' : 'err'}`;
        c.innerHTML = `<b>${ok ? '✓' : '✕'}</b><code>${name}</code> `;
        c.append(document.createTextNode(label));
        self.chips.append(c);
      },
      card(html) {
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        const el = wrap.firstElementChild;
        el.querySelector(':scope > h4')?.insertAdjacentHTML('beforeend', popButton('弹出这张卡片'));
        // Only the newest card stays open; earlier ones fold to their title (click to reopen).
        for (const old of document.querySelectorAll('#msgs .card:not(.fold)')) if (old.querySelector(':scope > h4')) old.classList.add('fold');
        block.append(el);
        self.chips = null;
        self.text = null;
      },
    };
    self.newText();
    return self;
  }

  setBusy(busy) {
    this.busy = busy;
    document.getElementById('send').disabled = busy;
  }

  async send(text, files = []) {
    this.userBubble(text, files);
    this.setBusy(true);
    const ui = this.assistantBlock();
    try {
      let note = '';
      if (files.length) {
        note = await this.uploadFiles(files, ui);
        if (!note) return;
      }
      if (!text) {
        this.replyToUpload(ui, note);
        return;
      }
      if (this.online) await this.runOnline(note ? `${text}\n${note}` : text, ui);
      else await this.runOffline(text, ui);
    } catch (error) {
      console.error(error);
      if (this.online && !ui.block.querySelector('.chip')) {
        ui.text.textContent = `豆包接口出错（${error.message}），这一句改用本地规则处理：`;
        await this.runOffline(text, ui);
      } else {
        (ui.text ?? ui.newText()).textContent += `\n出错了：${error.message}`;
      }
    } finally {
      ui.block.querySelector('.thinking')?.remove();
      this.setSuggestions(Boolean(this.app.site.isScene));
      this.setBusy(false);
      this.scroll();
    }
  }

  // Upload through the library, show a result card, and return a note that tells the model the ids.
  async uploadFiles(files, ui) {
    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.textContent = `上传并转换 ${files.length} 个文件`;
    ui.block.append(thinking);
    this.scroll();
    let assets;
    try {
      ({ assets } = await this.app.library.upload(files));
    } catch (error) {
      ui.text.textContent = `上传失败：${error.message}。${this.app.library.online ? '' : '后端（8787）没连上，文件没有存下来。'}`;
      return '';
    } finally {
      thinking.remove();
    }
    this.app.lastUploads = assets;
    const rows = assets.map((a) => {
      const ok = usable(a);
      const what = ok ? `${KIND[a.kind] ?? a.kind} · ${esc(a.meta?.formatName ?? a.originalFormat ?? '')}` : esc(a.message || '无法识别');
      let act = '';
      if (ok && a.kind === 'site') act = `<button data-action="load-site" data-asset="${esc(a.id)}">${a.meta?.convention === 'generic' ? '生成厂房' : '载入为厂房'}</button>`;
      return `<div class="up ${ok ? '' : 'err'}"><span class="th" style="${a.thumbUrl ? `background-image:url(${esc(a.thumbUrl)})` : ''}">${a.thumbUrl ? '' : esc((a.originalFormat ?? '').toUpperCase())}</span><b>${esc(a.name)}</b><small>${what}</small>${act}</div>`;
    }).join('');
    const ready = assets.filter(usable).length;
    ui.card(`<div class="card upcard"><h4>已存入场景库<span class="r ${ready === assets.length ? 'ok' : 'warn'}">${ready}/${assets.length} 可用</span></h4><div class="uplist">${rows}</div></div>`);
    ui.newText();
    this.scroll();
    const desc = assets.map((a) => `id=${a.id} 名称=${a.name} 类型=${KIND[a.kind] ?? a.kind}${usable(a) ? '' : ` 不可用（${a.message || '无法识别'}）`}${a.kind === 'site' && a.meta?.convention === 'generic' ? ' 无工位图层只能叠底图' : ''}`).join('；');
    return `（用户上传了 ${assets.length} 个文件：${desc}）`;
  }

  // Files sent without text: ask where to put them instead of guessing a position.
  replyToUpload(ui, note) {
    const assets = this.app.lastUploads ?? [];
    const models = assets.filter((a) => a.kind === 'model' && usable(a));
    const sites = assets.filter((a) => a.kind === 'site' && usable(a));
    const bad = assets.filter((a) => !usable(a));
    const parts = [];
    if (models.length) {
      const ids = this.app.site.points().slice(0, 2).map((p) => p.id);
      parts.push(`${models.map((a) => a.name).join('、')} 已转成三维模型。要放在哪？比如"放在 ${ids[0] ?? 'H-01'} 东边 5 米"或"放在 x 30 米、y 12 米，转 90 度"；也可以在左边场景库手动点「放入场景」。`);
    }
    if (sites.length) parts.push(`图纸 ${sites.map((a) => a.name).join('、')} 可以点卡片上的按钮载入，或直接说"载入这张图纸"。`);
    if (bad.length) parts.push(`${bad.map((a) => `${a.name}：${a.message || '无法识别'}`).join('；')}。`);
    const reply = parts.join('') || '文件已存入场景库。';
    ui.text.textContent = reply;
    this.messages.push({ role: 'user', content: note }, { role: 'assistant', content: reply });
  }

  async execute(name, args, ui) {
    try {
      const out = await this.tools.run(name, args);
      ui.chip(name, out.chip ?? '', true);
      if (out.card) ui.card(out.card);
      if (out.images?.length) ui.pendingImages = [...(ui.pendingImages ?? []), ...out.images];
      return { ok: true, ...out.result };
    } catch (error) {
      ui.chip(name, error.message, false);
      return { ok: false, error: error.message };
    } finally {
      this.scroll();
    }
  }

  async runOffline(text, ui) {
    // "生成一台起重机" with no such model in the library: ask for the drawing, don't make one up.
    const t = text.replace(/\s+/g, '');
    const wanted = t.match(/(?:生成|做|画|建|造|设计|来)(?:一|几|[\d两三四五]+)?(?:台|个|卷|辆|套)?(.*?(起重机|行车|吊车|大车|铝卷|钢卷|卷材|设备|小车|车))/);
    if (wanted) {
      let found = null;
      try {
        found = this.app.library.findModel(wanted[1]);
      } catch {
        found = null;
      }
      if (!found) {
        (ui.text ?? ui.newText()).textContent += `资源库里还没有「${wanted[1]}」的模型，我不会凭空生成。请提供这台设备的图纸或三维模型（STEP/GLB/OBJ/STL/FBX），并说明型号和关键尺寸（如跨度、起升高度、外形尺寸），上传到左侧资源库后我再放进厂房。`;
        return;
      }
    }
    if (/建模|三维模型|3D 模型|3d模型|设备图/.test(t) && /图纸|设备图|图片|建/.test(t)) {
      (ui.text ?? ui.newText()).textContent += '按设备图纸建三维模型需要读图和看图，要用在线模型（豆包）。当前连不上模型服务，请恢复网络后再试；图纸和图片已经在资源库里的话不用重新上传。';
      return;
    }
    const calls = localIntent(text, this.app);
    if (!calls.length) {
      (ui.text ?? ui.newText()).textContent += this.app.site.isScene
        ? '离线模式只认常用指令：重新建造、只看第 N 步、看 B 跨行车、俯视、资源库里有哪些模型、把起重机装到 B 跨轨道上、在 A 跨放 5 卷铝卷、删掉铝卷、返回原方案。'
        : '离线模式只认常用指令：按图纸生成厂房、导入示例厂房、只看第 N 步、播放全流程、节拍改成 N 秒、模拟 N 小时班、显示行程、车长改成 N、加一台 AGV、在 RM-01 东边 2 米加一个点。';
      return;
    }
    const results = [];
    for (const [name, args] of calls) results.push(await this.execute(name, args, ui));
    const failed = results.filter((r) => !r.ok);
    (ui.text ?? ui.newText()).textContent += failed.length ? `有 ${failed.length} 项没做：${failed.map((f) => f.error).join('；')}` : '已按指令更新左侧方案。';
  }

  systemMessage() {
    return { role: 'system', content: `${SYSTEM}\n\n当前方案状态（JSON，每轮自动更新）：\n${JSON.stringify(this.tools.stateSummary())}` };
  }

  // Keep the last turns, cutting only at a user message so tool calls stay paired with their results.
  history() {
    const max = 40;
    let tail = this.messages;
    if (tail.length > max) {
      tail = tail.slice(-max);
      const first = tail.findIndex((m) => m.role === 'user');
      if (first > 0) tail = tail.slice(first);
    }
    // Only the latest pictures are sent again; older ones become a text note.
    const last = tail.findLastIndex((m) => Array.isArray(m.content));
    return tail.map((m, i) => (Array.isArray(m.content) && i !== last ? { ...m, content: `${m.content[0].text}（图片已看过，此处省略）` } : m));
  }

  async runOnline(text, ui) {
    this.messages.push({ role: 'user', content: text });
    // set_params fields already changed during this user turn; a repeat is refused so relative
    // requests ("再加一台") can't be re-applied against the refreshed state.
    const changedThisTurn = new Set();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const thinking = document.createElement('div');
      thinking.className = 'thinking';
      thinking.textContent = round ? '继续处理' : '思考中';
      ui.block.append(thinking);
      this.scroll();
      const reply = await this.stream(ui, thinking);
      thinking.remove();
      const assistant = { role: 'assistant', content: reply.content || '' };
      if (reply.toolCalls.length) assistant.tool_calls = reply.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
      this.messages.push(assistant);
      if (!reply.toolCalls.length) return;
      for (const call of reply.toolCalls) {
        let args;
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          args = null;
        }
        const repeated = call.name === 'set_params' && args ? Object.keys(args).filter((k) => changedThisTurn.has(k)) : [];
        let result;
        if (!args) result = { ok: false, error: '参数不是合法 JSON' };
        else if (repeated.length) result = { ok: false, error: `本条指令已经改过 ${repeated.join('、')}，不再重复修改；请直接把当前结果告诉用户` };
        else result = await this.execute(call.name, args, ui);
        if (call.name === 'set_params' && result.ok) for (const k of Object.keys(args)) changedThisTurn.add(k);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      // Pictures fetched by view_images go to the model as a user message right after the tool results.
      if (ui.pendingImages?.length) {
        const images = ui.pendingImages;
        ui.pendingImages = null;
        this.messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `（view_images 取到的参考图片，按顺序：${images.map((i) => i.name).join('、')}。只用来判断外观和零件相对位置，尺寸以图纸为准。）` },
            ...images.map((i) => ({ type: 'image_url', image_url: { url: i.url } })),
          ],
        });
      }
      ui.newText();
    }
    (ui.text ?? ui.newText()).textContent += '（工具调用轮数到上限，先停在这里）';
  }

  async stream(ui, thinking) {
    const response = await fetch(`${this.llm}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [this.systemMessage(), ...this.history()], tools: this.tools.schemas, tool_choice: 'auto', stream: true, temperature: 0.2 }),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 160)}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const calls = [];
    const target = ui.text ?? ui.newText();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const data = line.trim();
        if (!data.startsWith('data:')) continue;
        const payload = data.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content && thinking) thinking.textContent = '思考中';
        if (delta.content) {
          content += delta.content;
          target.textContent = content;
          this.scroll();
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? calls.length;
          calls[i] ??= { id: '', name: '', arguments: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
          if (thinking) thinking.textContent = `调用 ${calls.map((c) => c?.name).filter(Boolean).join('、')}`;
        }
      }
    }
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
    return { content, toolCalls };
  }

  // Buttons inside result cards run the same tools, and the model hears about it next turn.
  async onCardAction(e) {
    const button = e.target.closest('[data-action]');
    if (!button || this.busy) return;
    const action = button.dataset.action;
    button.closest('.acts')?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const ui = this.assistantBlock();
    let note = '';
    if (action === 'confirm-process') {
      await this.execute('confirm_process', {}, ui);
      note = '（用户点了「确认工序」按钮，工序已生效）';
    } else if (action === 'cancel-process') {
      this.app.pendingProcess = null;
      ui.text.textContent = '已取消这次工序修改，沿用原工序。';
      note = '（用户取消了待确认的工序）';
    } else if (action === 'add-agv') {
      const r = await this.execute('set_params', { agv_count: this.app.site.agvCount + 1 }, ui);
      if (r.ok) await this.execute('set_takt', { target_seconds: this.app.site.target }, ui);
      note = `（用户点了「加一台 AGV」，现在 ${this.app.site.agvCount} 台）`;
    } else if (action === 'apply-goal') {
      const g = { seconds: Number(button.dataset.seconds), count: Number(button.dataset.count) };
      const r = await this.execute('set_rate_goal', { ...g, flow: 'current', apply: true }, ui);
      note = `（用户点了「按目标产能应用到方案」：${r.ok === false ? `失败 ${r.error}` : `每 ${g.seconds} 秒 ${g.count} 次，现在 AGV ${this.app.site.agvCount} 台`}）`;
    } else if (action === 'load-site') {
      const id = button.dataset.asset;
      const r = await this.execute('load_site_asset', { asset: id }, ui);
      ui.block.querySelector('.text:empty')?.remove();
      ui.newText().textContent = r.ok ? (r.底图 ? `已叠为底图（${r.线条数} 条线），工序沿用当前厂房。` : r.模式?.startsWith('图纸生成') ? `已按图纸生成厂房，正在分步播放建造过程（${r.建造步骤?.length ?? 7} 步）。` : `已载入图纸，生成 ${r.工序数} 道工序。`) : `没载入：${r.error}`;
      note = `（用户点了「载入图纸」${id}：${r.ok ? '成功' : `失败 ${r.error}`}）`;
    } else if (action === 'play-bottleneck') {
      const step = this.app.site.efficiency.bottleneck === '行车' ? 4 : 2;
      await this.execute('play_animation', { mode: 'step', step }, ui);
      note = `（用户点了「只看瓶颈这一步」，播放第 ${step} 步）`;
    }
    if (note) this.messages.push({ role: 'user', content: note }, { role: 'assistant', content: '好的。' });
    this.scroll();
  }
}

