# 3D 工业方案演示

面向工业物料搬运业务的三维方案演示：输入简单参数就能改产品模型的尺寸，再搭出客户现场的三维场景，用来代替 CAD 图纸给客户讲方案。

需求来自 2026-11-09 的会议纪要：[智能纪要：3D](https://ecn67yprnus3.feishu.cn/docx/OjBFdQKi7oyvBOxukmycwijDnLb)。纪要由 AI 生成，可能不准确，下面的内容以会上确认为准。

## 定位

- **解决的问题**：传统方案靠 CAD 图纸讲解，不直观，影响获客。
- **场景**：AGV 物料搬运 + 起重机吊装。11-09 纪要写的是“暂不做吊装”，2026-11-10 改为起重机也进 P0，范围见 [PRD](docs/PRD.md) 第 4 节。
- **核心**：标品的参数化自动建模。
- **以后可以延展**：对接研发环节自动出图、AR 实景展示。

## 需求优先级

| 优先级 | 需求 | 代码位置 |
|---|---|---|
| 1 | 输入简单尺寸参数，快速调整三维产品模型的真实大小，适配不同客户的定制尺寸 | `src/parametric/`、`demo/src/vehicle.js` |
| 2 | 基于模拟 CAD 平面图，用 AI 生成并还原客户现场的三维场景，AGV 转运等动作要做到毫米级精度还原 | `src/scene/`、`demo/src/scene/` |
| 3 | 优化灯光、材质等细节，输出高真实感的渲染，避免工程裸模的质感 | `demo/src/scene/` |

## 边界

- 先跑通基础架构和核心功能；炫酷特效、特殊场景放到后期迭代。
- 呈现上看重工艺流程的准确性，完整还原工艺流程和方案细节。
- 优先在手机、电脑屏幕上做动态展示。
- 暂不做 AR，不做消费级的 360 度旋转交互，也不追求复杂的交互操作。
- 模型格式没有特殊限制，任意格式都可以。

## 待办

**素材和方案**

- [ ] 把产品三维模型转码简化，结构上只保留外观和大小相关的内容
- [ ] 绘制模拟的三维场景、产品三维模型和货物，并提供模拟的 CAD 图数据
- [ ] 归整产品模型，构思整体模拟场景和最终的作品表现方向
- [ ] 梳理面向客户展示的最终呈现形式

**开发**

- [ ] 启动参数化功能开发：输入简单参数即可改三维模型大小（纪要记为来自赵政，计划 11-09 当晚启动）
- [ ] 收到素材后，推进场景搭建和渲染

**其他**

- [ ] 把调研记录发给对方，用于后续招标相关工作（和 3D 开发本身无关）

## 目录

| 位置 | 放什么 | 状态 |
|---|---|---|
| `docs/` | [实景方案 Agent 可行性分析与 PRD](docs/PRD.md)、[CAD 平面图约定](docs/cad-convention.md) | PRD 是草案 |
| `data/product-models/raw/` | 需求方提供的产品三维模型原件，不入库 | 空 |
| `data/product-models/simplified/` | 转码简化后的模型和缩略图 | AGV1、Z1-1000-BZ |
| `data/cad/` | 模拟的客户现场 CAD 平面图 | 示例图，布局照 Rhino 厂房截图目测 |
| `data/scene/` | 场景贴图和 HDRI，[来源](data/scene/SOURCES.md) | Poly Haven CC0 |
| `data/cargo/` | 货物模型 | 空，货物目前用程序生成 |
| `src/parametric/` | 离线：模型预处理脚本、产品参数配置 | 原型 |
| `src/scene/` | 离线：生成示例平面图 | 原型 |
| `src/render/` | 离线渲染 | 未用，灯光材质都在网页里 |
| `demo/` | 手机和电脑端的网页演示 | 原型 |

整个 `data/` 是网页的静态目录，打包时会全部带上，所以原件不要放进 `data/` 再发布。

## 运行演示

```bash
cd demo
npm install
npm run dev
```

打开 <http://127.0.0.1:5180>，按三步走：

1. **选型**：从产品库选车型。
2. **尺寸**：改长、宽、高，标品跟着移动，大小不变。
3. **现场**：把这台车放进厂房跑完整工艺流程，看坐标、航向、最小净距，可以跟随、俯视、导出 4K 图片、导入自己的 DXF。

```bash
cd demo
npm test
```

往产品库加车型：跑预处理脚本生成 GLB 和 manifest，新建一份 `src/parametric/*.config.json`，在 `demo/src/catalog.js` 登记。参数范围目前都是临时值。

现场的路线、工位来自 `data/cad/sample-plant.dxf`，图层和属性见 [CAD 平面图约定](docs/cad-convention.md)。厂房是照截图目测的，设备和工位是编的；拿到厂房 STP 后再换。

现场的灯光材质：HDRI 环境光 + 方向光阴影，地面和墙用 PBR 贴图，车底有接触阴影。靠近镜头的墙自动隐藏，但还在投影。没有做 GTAO 环境光遮蔽，手机上太贵，而且它不认车体的顶点拉伸。

AGV1（2026-11-10 提供）：颜色直接读 OBJ 的 `usemtl`；重新生成：

```bash
blender -b --factory-startup --python src/parametric/preprocess_agv1.py -- <AGV1.obj> data/product-models/simplified/agv1.glb data/product-models/simplified/agv1.manifest.json
```

下面是 Z1-1000-BZ 的说明。

车长变化时拉长顶盖板，不增减块数（2026-11-10 确认）。实际被拉长的是中间两侧那两块 0.8 m 盖板，其余盖板带安装板或孔位，只平移。

车身型号以 `Z1-1000-BZ` 为准（2026-11-10 确认）。源 FBX 上四处印的是 `Z1-10000/BZ`，预处理时改正，源文件本身没有改。

配色按 2026-11-10 提供的 Rhino 截图目测，FBX 和 STP 都不带颜色。零件和颜色的对应写在 `preprocess_z1.py`，色值写在 `src/parametric/paints.json`。

标品位置：激光导航 4 个，在两侧中段和前后两端，红顶蓝底（2026-11-10 确认）；急停 4 个，在车架四角，红钮黄圈。

重新生成模型（原始 FBX 不入库，路径按实际填）：

```bash
blender -b --factory-startup --python src/parametric/preprocess_z1.py -- <Z1-1000-BZ.fbx> src/parametric/z1.config.json data/product-models/simplified/z1-1000-bz.glb data/product-models/simplified/z1-1000-bz.manifest.json
```

## 还要确认

- AGV1 车尾铭牌印的是 `WL/30000t`，侧面是 `30t`，模型没有改，要确认是不是 30000 kg。
- 纪要没有写交付的具体形式（视频、网页或其他）；车体调参先按网页 three.js 做。
- 总结里写的是「通过 AI 生成」场景，卡片里写的是「基于 CAD 模拟数据搭建」，AI 在这一步具体做什么要确认。
- 「毫米级精度」是对模型、动作还是渲染的要求，验收时怎么算，需要定义。
- 待办里没有写清每项的负责人。

纪要里的文字记录和妙记没有读，上面只根据总结和待办整理。

## 卫华 3D 方案工作台（第一版）

新增 workbench/：左侧复用 three.js 厂房与路线引擎，右侧是支持 SSE 的 Agent 对话。未配置模型 key 时可离线跑完整演示脚本，在线模式可通过 .env 接入 Anthropic、MiniMax 或 BigModel。

~~~bash
cd workbench
npm install
npm run dev
~~~

打开 <http://127.0.0.1:5181>；服务端使用 8787 端口。详细脚本、工具白名单、示意模型说明和验收截图见 [workbench/README.md](workbench/README.md)。
