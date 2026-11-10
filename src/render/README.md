# 离线录制（scene-R7 讲解短视频的底座）

按一份镜头脚本，把 demo 的现场页逐帧录成 MP4（1920×1080，30 fps，H.264，yuv420p），带片头、字幕和「演示」角标。对应 [PRD](../../docs/PRD.md) 的 scene-R7 和第 10 节「录制一致性」。

现场的时间轴是闭式的（`demo/src/scene/route.js` 的 `poseAt`），第 N 帧的画面只由 N 决定，跟机器卡不卡无关，所以同一份脚本录两次逐帧一致。

## 用法

先准备一次：

```bash
git lfs checkout            # 产品模型 *.glb 走 Git LFS，新检出的工作树里可能只是指针文件
cd demo && npm install && cd ..
```

本机要有：ffmpeg 在 PATH 上；Playwright 和它的 Chromium（本地装或全局装都行，脚本会去 `npm root -g` 找）。

在 `3D-工业方案演示/` 下：

```bash
node src/render/record.mjs src/render/shots/sample.json
```

产出 `src/render/out/sample.mp4` 和 `sample.frames.sha256`（每帧 PNG 的 SHA-256）。脚本会自己在随机空闲端口起一个 Vite 开发服务，录完关掉，不占 5180。

参数：

| 参数 | 作用 |
|---|---|
| `--out 路径.mp4` | 换输出位置，默认 `src/render/out/<脚本名>.mp4` |
| `--seconds N` | 只录前 N 秒 |
| `--frames-dir 目录` | 另存每帧 PNG，方便抽帧检查 |
| `--url http://…/` | 用已经在跑的 demo 服务，不自己起 |
| `--no-video` | 不编码，只算帧哈希 |

测试（镜头脚本换算 + 录制一致性）：

```bash
node --test src/render/*.test.mjs
```

一致性测试有两条：示例脚本前 2 秒录两次，逐帧哈希相同；`shots/smoke.json`（三种镜头各一小段）正序录一次、倒序录一次，逐帧哈希相同。倒序这条证明每帧不依赖上一帧，截图也不会拿到上一帧的画面。

## 镜头脚本

见 [`shots/sample.json`](shots/sample.json)：

```json
{
  "title": "AGV1 钢卷搬运方案",
  "subtitle": "模拟厂房 sample-plant.dxf · 演示数据",
  "titleSeconds": 3,
  "badge": "演示",
  "product": "agv1",
  "fps": 30, "width": 1920, "height": 1080,
  "segments": [
    { "start": 0, "end": 6, "camera": "overview", "scene": [60, 96], "caption": "演示：……" }
  ]
}
```

- `segments` 按视频时间首尾相接，从 0 开始；`start`、`end` 是视频里的秒。
- `scene` 是这一段对应的现场时间区间（秒），段内线性映射。`[60, 96]` 放 6 秒就是 6 倍速；两端相同就是定格。现场时间从流程开始算，示例平面图整个流程约 490 秒，各步骤的起止时间可以用 `buildTimeline` 打出来。
- `camera`：`overview` 总览、`follow` 跟随、`top` 俯视，和网页上三个按钮一致。段与段之间是硬切。
- `caption` 是这一段的字幕；片头卡显示 `titleSeconds` 秒，最后 0.5 秒淡出，同时字幕淡入。
- 左上角自动显示现场时钟和 AGV 当前工况（取自 `Site.status()`），右上角是 `badge` 角标。

配色：卫华红 `#D7000F`、深墨 `#1F2329`、白色。字体用系统中文字体（Windows 上是微软雅黑）。

## 录制钩子（demo 侧）

现场页地址加 `?record=1&product=agv1`：跳过选型直接进现场，隐藏右侧面板，画布铺满窗口，停掉实时时钟。页面准备好后挂出：

```js
window.__recorder = {
  duration,          // 现场流程总秒数
  seek(t),           // 跳到现场第 t 秒（闭式位姿）
  setCamera(preset), // 'overview' | 'follow' | 'top'
  renderFrame(),     // 按当前时间和镜头画一帧；跟随镜头直接按车的位置摆，不累积
  state(),           // { time, x, y, heading, speed, status }
};
```

加载失败时挂 `window.__recorderError`（中文原因）。改动在 `demo/src/main.js` 末尾和 `style.css` 的 `body.recording`，不带 `?record` 时行为不变。

## 耗时

本机（Intel UHD 核显，ANGLE/D3D11，Node 22）：

| 内容 | 用时 |
|---|---|
| 示例脚本 20 秒 / 600 帧，含编码 | 约 83 秒 |
| 30 秒视频（按每帧约 0.14 秒推算） | 约 2 分钟，在 PRD 要求的 3 分钟内 |
| `node --test src/render/*.test.mjs` | 约 36 秒 |

大头是截图：每帧约 0.13 秒（CDP `Page.captureScreenshot`，`optimizeForSpeed`）。启动服务、浏览器、加载现场约 4 秒。

## 限制

- **一致性只在同一台机器、同一套显卡驱动和 Chromium 版本内成立**。换机器、换显卡或退到 SwiftShader 软件渲染，像素会不同，哈希不能跨机器比。
- 镜头只有三个预设，段间硬切，没有推拉摇移和转场；跟随镜头的偏移固定（和网页一致）。
- 只录现场页；车体用产品的标准尺寸，平面图用示例 `sample-plant.dxf`。还不能通过地址传尺寸参数或导入的 DXF。
- 字幕单行显示，超过约 38 个汉字会超出画面；没有自动换行和分句。
- 没有声音。配音和精剪交给 E 视频生产线。
- 字幕和片头是叠在页面上的 DOM，截的是整页，不是画布直出。
- PRD 里的 `MediaAsset` 写入、`Claim` 出处检查、`explainer-script` 分镜生成、录制进度推送（SSE）都还没做，这里只是录制底座。
- 用的是 Vite 开发服务，第一次打开要现编译依赖，慢几秒。
