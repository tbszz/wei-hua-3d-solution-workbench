# 厂房贴图返工方案（交给 Codex）

日期：2026-11-10

## 1. 现状（未提交，都在工作区）

**性能部分已经完成，要保留：**

- `prototype/src/main.js`
  - 阴影贴图从 4096 PCFSoft 降到 2048 PCF。
  - 阴影按需刷新：播放时隔一帧刷新一次，暂停时每 0.25 s 刷新一次。
  - 关掉 `preserveDrawingBuffer`。
  - 像素比自适应：最高 1.5，掉帧时每档降 0.25。
  - 标签的位置读取缓存的视口尺寸。
  - 启动时预编译着色器（`warmUp`）。
- `prototype/src/style.css`：玻璃面板去掉了 `backdrop-filter`。
- `build-scene.js`
  - `mergeStatic`：同材质的静态网格合并成一次绘制。
  - 屋架和灯只在相机低于屋顶时显示（`updateCutaway` 的第三个参数）。
- 实测 GPU 单帧耗时，Intel UHD，1600×900：

  | 视角 | 现在 | 旧设置 |
  |---|---|---|
  | 总览 | 5–8 ms | 约 2 倍以上 |
  | 跟随 | 11 ms | 54 ms |
  | 行车 | 21 ms | 80 ms |

- 偶发的几百毫秒停顿查过了，不是本项目造成的。测试时 GPU 已经被别的程序占满：Chrome 39%，Wallpaper Engine 30%，WebView 23%。

**观感部分失败，用户反馈：**“太白了，不像真实场景，地板还没原来的好”。

现在的做法：

- 贴图由 `src/scene/make_factory_textures.py` 程序化生成，输出 `data/scene/textures/factory_*.jpg`。
- `demo/src/scene/surface-detail.js` 给所有 MeshStandard 材质叠加世界坐标的磨损。

截图对比见 `docs/plans/texture-refs/`：`before-*` 是改之前，`now-*` 是现在。

## 2. 为什么太白（逐项）

| 部位 | 现在 | 问题 |
|---|---|---|
| 地面 | 程序化贴图基色约 176，再乘材质色 `0xf2f4f6`；没有法线贴图 | 原来用的是实拍扫描的 `painted_concrete_*_1k`，去色后基色 168，对比度 ×0.38，再乘材质色 `0xb4b6b8`（约 0.71），并带法线贴图。现在亮了约 1.4 倍，表面是平的，云斑像大理石 |
| 墙 | `factory_wall_diff` 基色 214–218，材质不压色 | 接近纯白 |
| 柱 / 屋架 | `0xd2d5d8` / `0xdfe2e4` | 太亮，和墙、地面糊成一片 |
| 屋面板 | `MeshBasicMaterial`，基色约 196，乘 `0xe6e8ea` | 不受光照，自发光一样亮 |
| 窗 | `MeshBasicMaterial`，基色约 236 | 一整条发光的白带 |
| 货箱 | 调色板几乎是白色，再乘胶合板贴图 | 偏亮偏粉 |
| 叠加磨损 `surface-detail.js` | 亮度乘子上限 1.18 | 会把颜色提亮 |
| 光照 | 环境光 0.95 + 太阳 1.9，ACES 曝光 0.8 | 亮部被推到肩部，发灰发白 |

结论：照片里的厂房虽然亮，但明度有层次。目标反照率（sRGB 0–255）大致如下：

- 地面 115–140
- 墙 165–185
- 柱 145–165
- 吊车梁 80–95
- 屋面受光后约 140

另外，程序化噪声做不出实拍材质的细节。

## 3. 方案

1. **地面回到实拍贴图**
   - 恢复 HEAD 版本 `loadPlantTextures` 里的 `painted_concrete_diff/rough/nor_gl_1k` 和 `neutralised()`，材质参数恢复为 `color 0xb4b6b8, normalScale 0.35, roughness 0.8`。
   - 可选：换成一张更接近照片的 CC0 实拍抛光混凝土，来源 ambientCG 或 Poly Haven，1K JPG，必须是 CC0，许可写进 README。
   - 保留 6 m 的切缝网格：用一张单独的、很淡的切缝 alpha 叠加层，或在 shader 里画，不要整张换成程序化贴图。
   - 地面标线恢复原来的样式（黄色 AGV 通道和绿色人行道都是满铺色带）。如果要像照片那样，只加白色边线，不要去掉色带。
2. **墙、屋面、窗、货箱改用实拍 CC0 贴图**，每类一张 1K 的图，优先 ambientCG 或 Poly Haven：
   - 墙：波纹钢板（corrugated / metal siding）。
   - 墙裙：砌块或水泥墙面。
   - 屋面：从下方看的压型钢板。
   - 货箱：胶合板。
   - 只保留 `diff` 和 `nor`，必要时加 `rough`，不要 AO 或位移贴图。
   - 程序化的 `factory_*` 只保留窗户（带窗框的那张）。
3. **压低亮度，拉开层次**
   - 按第 2 节的目标反照率调材质色。
   - 屋面板改成 `MeshLambertMaterial` 或 `MeshStandardMaterial`，让它受光。
   - 窗户保持 MeshBasic 不受光，但颜色乘到约 0.8，避免一整条白带。
   - 吊车梁保持深灰 `0x5f646a` 左右。
4. **叠加磨损只往暗处走**
   - `surface-detail.js` 的亮度乘子改成 `clamp(..., 0.75, 1.0)`，幅度减半。
   - 地面（`DETAIL_FLOOR`）只做大尺度明暗，幅度不超过 ±6%。
   - 以后生成或上传的 GLB 仍然自动吃这层效果，这个机制不要动。
5. **光照**：太阳 1.6–1.8，环境光 0.8–0.9；保留 ACES 0.8，或对照截图微调。
6. **性能红线（不能退步）**
   - 贴图都是 1K 以内的 JPG，总数不超过 15 张。
   - 不加后处理，不加新光源，不加透明材质。
   - 保留第 1 节的全部性能改动。
   - `prototype/src/main.js` 另一个会话也在改，只做小范围编辑，不要整文件覆盖。

## 4. 验收

- 用 `docs/plans/texture-refs/shot.mjs` 截图（全局 Playwright，参数 `--use-angle=d3d11`）：

  ```bash
  node docs/plans/texture-refs/shot.mjs http://localhost:5184 shots/v2 overview follow crane
  ```

- 三个视角都要对照用户给的 4 张现场照片（用户会另附）和 `before-*.png`：
  - 地面不能比 `before-follow.png` 差。
  - 整体不能比照片更白。
- 测帧率前先关掉 Wallpaper Engine 和多余的 Chrome 标签页，否则结果会被其他程序占用 GPU 拉低。
  - 中位帧时间应约 16.7 ms，p95 低于 25 ms。
- `prototype/` 和 `demo/` 里的 `npm test` 都要通过。

## 4.1 进度（2026-11-10，Claude 已完成的部分）

- 第 3 节第 1、3、4、5 项已做完：
  - 地面回到 `painted_concrete_*_1k` + `neutralised()`，材质参数同 HEAD；6 m 切缝改在 `surface-detail.js` 的 `DETAIL_FLOOR` 里画（暗 16%）。
  - 标线恢复满铺色带和原来的颜色。
  - 墙乘 `0xcdced0`，柱 `0x9a9ea2`，吊车梁 `0x5a5f65`，屋架 `0xa4a8ac`，屋面板改为受光的 MeshStandard，窗乘 `0xd0d0d0`，货箱改成牛皮纸色调。
  - 磨损只往暗处走：上限 1.0，幅度减半；地面只暗不亮，最多 6%。
  - 太阳 1.7，环境光 0.85。
- 测试：`demo` 和 `prototype` 的 `npm test` 都通过。
- 帧时间（Intel UHD，1600×900）：三个视角中位数都是 16.7 ms，p95 不超过 19.2 ms。
- **还没做**：第 3 节第 2 项。墙、屋面、货箱还在用程序化贴图，没换成 CC0 实拍贴图，因为需要从 ambientCG 或 Poly Haven 下载。
- `factory_floor_diff.jpg` 和 `factory_floor_rough.jpg` 已经不再引用。

---

## 5. 给 Codex 的提示词

```
你在仓库 E:\卫华黑客松\3D-工业方案演示 工作（three.js r181 + Vite；工作台在 prototype/，场景代码在 demo/src/scene/，prototype 复用它）。
先读 docs/plans/2026-11-10-factory-texture-codex.md，并看 docs/plans/texture-refs/ 里的截图：before-* 是改之前，now-* 是现在。我还会附 4 张真实厂房照片作为目标观感。

任务：把厂房贴图做得像照片里的真实厂房。现在的问题是太白、不真实，地面还不如原来。
要求如下：
1. 地面回到实拍扫描贴图（HEAD 里的 painted_concrete_*_1k 加 neutralised()，材质 color 0xb4b6b8、normalScale 0.35、roughness 0.8），或换成更像照片的 CC0 实拍抛光混凝土（ambientCG / Poly Haven，1K JPG）。6 m 切缝用很淡的叠加层做。地面标线恢复原来的满铺色带。
2. 墙（波纹钢板）、墙裙（砌块）、屋面（压型钢板底面）、货箱（胶合板）改用 CC0 实拍 PBR 贴图，每类最多 diff + nor + rough，都是 1K JPG，放到 data/scene/textures/。在 README 里注明来源和 CC0 许可。程序化贴图只保留窗户。
3. 按文档第 2 节的目标反照率压暗、拉开层次：地面 115–140，墙 165–185，柱 145–165，吊车梁 80–95。屋面改成受光材质，窗户颜色乘约 0.8。
4. demo/src/scene/surface-detail.js 的亮度乘子改成只变暗（上限 1.0），幅度减半；地面幅度不超过 ±6%。保留它对所有 MeshStandard / MeshPhysical 材质（包括以后上传的 GLB）自动生效的机制。
5. 光照：demo/src/scene/site.js 里太阳 1.6–1.8，环境光 0.8–0.9。
6. 不要回退任何性能改动：2048 PCF 阴影按需刷新、自适应像素比、warmUp 预编译、mergeStatic、屋顶从上方隐藏、面板不用 backdrop-filter。不加后处理、新光源或透明材质。另一个会话也在改 prototype/src/main.js，只做小范围编辑。
7. 自检：启动 prototype 开发服务，用 docs/plans/texture-refs/shot.mjs 截 overview / follow / crane 三张图，和照片、before-* 对比，反复调到地面不比 before-follow 差、整体不比照片白为止。prototype/ 和 demo/ 的 npm test 都要通过。
完成后用中文汇报：改了哪些文件、贴图来源、三张截图路径、帧时间。不要提交，等我确认。
```
