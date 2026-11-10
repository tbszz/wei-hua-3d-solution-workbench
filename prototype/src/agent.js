// The chat agent: an OpenAI-compatible tool loop against /llm (the Vite proxy to magpie's Doubao),
// streaming text into the panel and running tools against the scene. Falls back to a small local
// intent parser when the model endpoint is unreachable, using the same tools.

// Doubao through the local magpie proxy.
const MODEL = 'trae-cn/seed-code-pro-0430';
const MAX_ROUNDS = 8;

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
14. 上传文件：用户只能在你这里上传文件（左边资源库只展示和手动放入）。上传结果会以「（用户上传了 n 个文件：…）」告诉你 id、类型和是否可用。三维模型要放进厂房时用 place_asset：位置只按用户原话（"放在 H-01 东边 5 米"→ ref=H-01, east_m=5；"x 30 米 y 12 米"→ x_mm=30000, y_mm=12000；"转 90 度"→ rotate_deg=90），用户没说位置就先问一句放哪，不要自己定；"往北挪 2 米"按「已放入模型」里的当前坐标算一次。图纸（DXF/DWG）用 load_site_asset 载入为厂房，不带工位图层的会自动叠为底图。转换失败的把原因原样告诉用户。`;

const SUGGESTIONS = ['做一个 Φ1800 钢卷用的 V 型鞍座并入库', '布置 A 区鞍座货位 2 行 10 列', '库存 14 卷，填进货位', '钢铁行业 25 吨钢卷怎么选型', '仿真 开卷60s 矫直75s 剪切90s 堆垛50s 跑 8 小时', '播放全流程', '只看第 3 步', '节拍改成 90 秒', '模拟一个 8 小时班', '显示行程', '车长改成 3200', '加一台 AGV', '在 H-01 东边 8 米加一个吊装点'];

const KIND = { model: '三维模型', site: '图纸', image: '图片', document: '文档' };
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const usable = (a) => a.status === 'ready' || Boolean(a.url && a.status !== 'failed' && a.status !== 'unsupported');

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const num = (s) => (s in CN_NUM ? CN_NUM[s] : Number(s));

// Offline: map common phrases to tool calls.
function localIntent(text, app) {
  const calls = [];
  const t = text.replace(/\s+/g, '');
  let m;
  if (/导入|厂房/.test(t)) calls.push(['import_site', {}]);
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
    const eff = s.efficiency;
    this.assistantBlock().text.textContent = `${s.sourceName} · ${this.app.product.model} + 行车，全流程 ${Math.round(s.duration)} s，节拍 ${eff.takt.toFixed(0)} s（瓶颈 ${eff.bottleneck}）。说一句话改方案，场景会跟着变。${this.online ? '' : '（离线：按本地规则解析常用指令）'}`;
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
      if (ok && a.kind === 'site') act = `<button data-action="load-site" data-asset="${esc(a.id)}">${a.meta?.convention === 'generic' ? '叠为底图' : '载入为厂房'}</button>`;
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
      return { ok: true, ...out.result };
    } catch (error) {
      ui.chip(name, error.message, false);
      return { ok: false, error: error.message };
    } finally {
      this.scroll();
    }
  }

  async runOffline(text, ui) {
    const calls = localIntent(text, this.app);
    if (!calls.length) {
      (ui.text ?? ui.newText()).textContent += '离线模式只认常用指令：导入厂房、只看第 N 步、播放全流程、节拍改成 N 秒、模拟 N 小时班、显示行程、车长改成 N、加一台 AGV、在 RM-01 东边 2 米加一个点。';
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
    if (this.messages.length <= max) return this.messages;
    const tail = this.messages.slice(-max);
    const first = tail.findIndex((m) => m.role === 'user');
    return first < 0 ? tail : tail.slice(first);
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
    } else if (action === 'load-site') {
      const id = button.dataset.asset;
      const r = await this.execute('load_site_asset', { asset: id }, ui);
      ui.block.querySelector('.text:empty')?.remove();
      ui.newText().textContent = r.ok ? (r.底图 ? `已叠为底图（${r.线条数} 条线），工序沿用当前厂房。` : `已载入图纸，生成 ${r.工序数} 道工序。`) : `没载入：${r.error}`;
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

