# 离线录制（scene-R7 讲解短视频的底座）

按一份镜头脚本，把 demo 的现场页逐帧录成 MP4（1920×1080，30 fps，H.264，yuv420p）。录出来的视频带片头卡、分时字幕、跟着物件走的三维标注、片尾卡、淡入淡出和「演示」角标。镜头可以推近拉远、环绕、跟车、平移、俯冲，段与段之间也能平滑过渡。对应 [PRD](../../docs/PRD.md) 的 scene-R7 和第 10 节「录制一致性」。

现场的时间轴是闭式的（`demo/src/scene/route.js` 的 `poseAt`），镜头位置也由帧号算出来（`shots.mjs`，纯函数），所以第 N 帧的画面只由 N 决定，跟机器卡不卡无关。同一份脚本录两次，逐帧一致。

## 文件

| 文件 | 作用 |
|---|---|
| `record.mjs` | 录制：起 demo 服务 → Playwright 打开现场页 → 逐帧摆镜头、截图 → ffmpeg 编码 |
| `shots.mjs` | 镜头脚本：校验，并把第 N 帧换算成现场时间、镜头位姿、字幕、标注和压黑 |
| `plant.mjs` | 现场目录：厂房里有什么、在哪儿，流程里每个动作在第几秒。复用 demo 的 `parse-cad.js` 和 `route.js` |
| `inspect.mjs` | 把现场目录打出来，写脚本前先看这个 |
| `shots/showcase.json` | 展示片，34 秒，用到了下面所有镜头手法 |
| `shots/sample.json` | 最早的 20 秒示例，只用三个预设镜头 |
| `shots/smoke.json` | 1 秒冒烟脚本，一致性测试用，每种镜头各一小段 |

## 用法

先准备一次：

```bash
git lfs checkout            # 产品模型 *.glb 走 Git LFS，新检出的工作树里可能只是指针文件
cd demo && npm install && cd ..
```

本机要有：ffmpeg 在 PATH 上；Playwright 和它的 Chromium（本地装或全局装都行，脚本会去 `npm root -g` 找）。

在 `3D-工业方案演示/` 下：

```bash
node src/render/inspect.mjs                              # 看能拍什么：产品、物件、流程事件
node src/render/record.mjs src/render/shots/showcase.json
```

产出 `src/render/out/showcase.mp4` 和 `showcase.frames.sha256`（每帧 PNG 的 SHA-256）。脚本会自己在随机空闲端口起一个 Vite 开发服务，录完关掉，不占 5180。

参数：

| 参数 | 作用 |
|---|---|
| `--out 路径.mp4` | 换输出位置，默认 `src/render/out/<脚本名>.mp4` |
| `--seconds N` | 只录前 N 秒 |
| `--frames-dir 目录` | 另存每帧 PNG，方便抽帧检查 |
| `--every N` | 每 N 帧抽一帧（预览用，要配 `--frames-dir`，不出视频）。34 秒的片子 `--every 45` 约 6 秒出 23 张 |
| `--url http://…/` | 用已经在跑的 demo 服务，不自己起 |
| `--no-video` | 不编码，只算帧哈希 |

改脚本时的节奏：先 `--every 45 --frames-dir src/render/out/prev` 抽帧看构图，满意了再整段录。

测试：

```bash
node --test src/render/*.test.mjs
```

包括现场目录（物件、坐标、货物跟车、事件表达式、报错）、镜头运动（环绕角度、缓动、平移、相对车头、blend 衔接、标注和压黑），以及两条录制一致性测试：

- 示例脚本前 2 秒录两次，逐帧哈希相同；
- `shots/smoke.json` 正序录一次、倒序录一次，逐帧哈希相同。这份脚本包含预设、跟车、平移、标注、blend 和压黑。倒序这条证明每帧不依赖上一帧，截图也不会拿到上一帧的画面。

## 能拍什么

`node src/render/inspect.mjs` 列出三样东西（`--json` 出机器可读的版本，后面跟产品 id 可以换车型）：

- **产品库**：`agv1`（AGV1）、`z1-1000-bz`（Z1-1000-BZ），以及各自长、宽、高的范围。脚本里写 `"product"` 和 `"size"`，现场里的车就换成这个型号、这个尺寸。
- **现场物件**：可以当镜头目标、可以挂标注的东西。包括厂房、AGV（也可写 `车`、`agv1`）、钢卷 `COIL`、货箱 `CRATE`、各工位（`RM-01`、`CELL-01`……）、设备（`数控加工中心 A`、`液压机`……）、输送线、桥式起重机、南侧 / 北侧货架、区域名（`来料区`、`机加工区`……）。车和货物会随流程移动，脚本里写名字就行，位置按当时的现场时间算。也可以直接写平面图坐标 `{ "x": 毫米, "y": 毫米, "z": 毫米 }`。
- **流程事件**：示例平面图整个流程 8 分 10 秒，比如 `leg:RM-01`（驶向 RM-01）、`arrive:RM-01`（到站定位）、`load:RM-01`（取货 6 秒）、`unload:CELL-01`（卸货）、`charge:CHG-01`。重复的事件加 `#2`，另有 `start`、`end`。

## 镜头脚本

完整例子见 [`shots/showcase.json`](shots/showcase.json)。顶层：

```json
{
  "title": "AGV1 钢卷搬运方案",
  "subtitle": "模拟厂房 sample-plant.dxf · 演示数据",
  "titleSeconds": 3.5,
  "badge": "演示",
  "product": "agv1",
  "size": { "length": 3200 },
  "ending": { "title": "AGV1 钢卷搬运方案", "subtitle": "演示数据……", "seconds": 3 },
  "fps": 30, "width": 1920, "height": 1080,
  "segments": [ … ]
}
```

- `product` / `size`：车型和尺寸（毫米）。不写尺寸用标准值；超范围的夹到范围内，和网页滑块一样。
- `title` / `subtitle`：片头卡，显示 `titleSeconds` 秒，最后 0.5 秒淡出，字幕随后淡入。
- `ending`：片尾卡，最后 `seconds` 秒淡入，压住字幕。
- 左上角自动显示现场时钟和 AGV 当前工况（取自 `Site.status()`），右上角是 `badge` 角标。

### 段落

```json
{
  "start": 10, "end": 16,
  "scene": ["load:RM-01", "load:RM-01.end"],
  "camera": { "target": "AGV", "angle": [38, 135], "distance": 7.5, "height": 3.6, "fov": 32, "ease": "linear" },
  "blend": 1.5,
  "fadeIn": 0, "fadeOut": 0,
  "caption": [{ "at": 0, "text": "演示：支架下降，钢卷落到车上" }, { "at": 3, "text": "演示：整个取货动作 6 秒" }],
  "labels": [{ "at": "钢卷", "text": "钢卷（演示货物）", "lift": 0.1, "from": 0.3 }]
}
```

- `start` / `end`：视频里的秒，各段首尾相接，从 0 开始。
- `scene`：这一段对应的现场时间 `[起, 止]`，段内线性映射。可以写秒数，也可以写流程事件：
  - `"load:RM-01"` 事件开始，`"load:RM-01.end"` 结束，`"load:RM-01.mid"` 中点；
  - 加减秒数要带 `s`：`"leg:CELL-01+24s"`、`"arrive:CELL-01-2s"`、`"load:RM-01.end+1.5s"`（工位名里有减号，所以必须带 `s`）。
  - `[起, 止]` 跨度比段长大就是快放，相等是实时，两端相同是定格。
- `camera`：预设字符串 `overview` / `follow` / `top`（和网页三个按钮一致），或者一个镜头对象：

| 字段 | 含义 | 默认 |
|---|---|---|
| `target` | 看哪儿：物件名、`{x, y}` 毫米坐标；写 `[A, B]` 是从 A 平移到 B | 必填 |
| `angle` | 镜头在目标的哪个方位，度。0° 在目标南面往北看，90° 在东面，180° 北面，270° 西面 | 30 |
| `relative` | `true` 时 `angle` 相对车头：0° 车前，90° 车左侧，180° 车后 | false |
| `distance` | 水平距离，米 | 10 |
| `height` | 镜头离地高度，米 | 4 |
| `lookHeight` | 看向的高度，米。不写就看物件自身的高度（车看车台面以上，设备看半高） | 物件高度 |
| `fov` | 视角，度。变小就是变焦推近 | 网页总览的视角 |
| `ease` | 段内运动的缓动：`linear` / `in` / `out` / `inOut` | `inOut` |

  数值字段都可以写 `[起, 止]`，段内按 `ease` 从起变到止。常用手法：

| 想要的效果 | 写法 |
|---|---|
| 推近 / 拉远 | `distance` 和 `height` 写 `[远, 近]` / `[近, 远]` |
| 变焦（机位不动） | `fov: [40, 24]` |
| 环绕 | `angle: [38, 135]`，配 `ease: "linear"` 匀速转 |
| 跟车 / 追尾 | `target: "AGV"`，`relative: true`，`angle` 在 180 附近 |
| 俯冲 / 升起俯瞰 | `angle: 0`，`distance: [8, 1]`，`height: [30, 52]` |
| 横移过一排设备 | `target: ["数控加工中心 A", "液压机"]` |
| 定格细看 | `scene` 两端相同，镜头照样可以动 |

- `blend`：本段开头用几秒，从上一段结束时的机位平滑飞过来。不写就是硬切。上一段和本段的现场时间不连续时（比如中间跳过了 20 秒路程）别用 blend，镜头会先对着空地飞。
- `fadeIn` / `fadeOut`：段首 / 段尾压黑（深墨 `#1F2329`）的秒数。
- `caption`：字符串，或 `[{ "at": 段内秒, "text": … }]` 分时切换。单行，超过约 38 个汉字会出画。
- `labels`：钉在三维物件上的标注，跟着物件和镜头走。`at` 是物件名或坐标，`lift` 是在物件看点之上再抬几米（默认 1），`from` 是段内第几秒开始淡入（默认 0.2），段尾 0.3 秒淡出。物件在镜头后面时不显示。

写错物件名、事件名、预设或字段，会报中文错误，并列出能用的名字。

配色：卫华红 `#D7000F`、深墨 `#1F2329`、白色。字体用系统中文字体（Windows 上是微软雅黑）。

## 用自然语言编排

脚本是给人和 agent 一起写的。用户说要拍什么，agent 先跑 `inspect.mjs` 查到对应的物件和事件，写一份 `shots/*.json`，`--every` 抽帧看构图，调好后整段录。比如：

> 「用 Z1-1000-BZ、长 6 米的车，拍它在 CELL-02 取货箱：先从焊接区上空推近，绕车转半圈看支架下降，再跟着它开到成品区卸货，最后升起俯瞰全厂。30 秒左右。」

对应 `product: "z1-1000-bz"`、`size: { "length": 6000 }`，场景用 `arrive:CELL-02`、`load:CELL-02`、`leg:FG-01`、`unload:FG-01`。镜头依次是推近（target `焊接区`）、环绕（target `AGV`）、相对车头跟车、升起俯瞰（target `厂房`）。

能调的只有现场里已有的东西：示例平面图上的物件、产品库里的车型和尺寸、流程里实际发生的动作。脚本不能让车走别的路线，也不能加平面图上没有的设备。

## 录制钩子（demo 侧）

现场页地址加 `?record=1&product=agv1`（可再加 `&length=3200&width=1600&height=400`，单位毫米）：跳过选型直接进现场，隐藏右侧面板，画布铺满窗口，停掉实时时钟。页面准备好后挂出：

```js
window.__recorder = {
  duration,                 // 现场流程总秒数
  seek(t),                  // 跳到现场第 t 秒（闭式位姿）
  setCamera(preset),        // 'overview' | 'follow' | 'top'
  presetPose(preset),       // 摆到预设并返回 { position, target, fov }
  setCameraPose({ position, target, fov }), // 脚本算好的机位，场景米
  project(points),          // 三维点 → 屏幕像素 { x, y, visible }，摆标注用
  renderFrame(),            // 按当前时间和镜头画一帧；跟随镜头直接按车的位置摆，不累积
  state(),                  // { time, x, y, heading, speed, status, product, size }
};
```

加载失败时挂 `window.__recorderError`（中文原因）。改动在 `demo/src/main.js` 末尾和 `style.css` 的 `body.recording`，不带 `?record` 时行为不变。

## 耗时

本机（Intel UHD 核显，ANGLE/D3D11，Node 22）：

| 内容 | 用时 |
|---|---|
| 展示片 34 秒 / 1020 帧，含编码 | 约 156 秒（成片约 34 MB） |
| 示例脚本 20 秒 / 600 帧，含编码 | 约 83 秒 |
| `--every 45` 抽帧预览 34 秒的片子 | 约 6 秒 |
| `node --test src/render/*.test.mjs` | 约 40 秒 |

大头是截图：每帧约 0.13 秒（CDP `Page.captureScreenshot`，`optimizeForSpeed`）。启动服务、浏览器、加载现场约 4 秒。

## 限制

- **一致性只在同一台机器、同一套显卡驱动和 Chromium 版本内成立**。换机器、换显卡或退到 SwiftShader 软件渲染，像素会不同，哈希不能跨机器比。
- 平面图固定用示例 `sample-plant.dxf`，还不能导入别的 DXF；车只走 `route.js` 算出来的那条路线。
- 镜头不做碰撞检测：机位太低、太近会穿进设备或墙里，要靠抽帧预览发现。
- `blend` 在两段之间直线插值机位，转角大时中途可能掠过物件。
- 字幕单行显示，超过约 38 个汉字会超出画面；没有自动换行和分句。
- 没有声音。配音和精剪交给 E 视频生产线。
- 字幕、标注和片头片尾是叠在页面上的 DOM，截的是整页，不是画布直出。
- PRD 里的 `MediaAsset` 写入、`Claim` 出处检查、`explainer-script` 分镜生成、录制进度推送（SSE）都还没做，这里只是录制底座。
- 用的是 Vite 开发服务，第一次打开要现编译依赖，慢几秒。
