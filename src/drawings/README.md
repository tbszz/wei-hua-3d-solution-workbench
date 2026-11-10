# 出图下发原型（功能流程第 7 步）

方案定稿后，按方案参数自动出两张图：

| 图 | 格式 | 内容 |
|---|---|---|
| 结构总图 | DXF（R2018，1:1 毫米） | AGV：主视、俯视、左视，外形尺寸跟参数走。双梁桥式起重机：主视（跨度、起升高度、轨面标高）、左视（小车轨距、大车基距、端梁）、俯视、A-A 主梁截面。带图框、标题栏、参数表、“示意”章 |
| 涂装与标识工艺图 | SVG + PDF（A3） | 涂装分区（面漆色值、色号来源）、铭牌 / 吨位标 / 卫华 Logo 位的位置和尺寸、涂层体系与膜厚表 |

**这里出的全部是示意图**：图框、标题栏、色号、涂层体系、膜厚、标识尺寸都是占位值，起重机还没有真实模型。图上和 `manifest.json` 里都写了“示意，不得直接用于生产”。

## 用法

在项目根目录（`3D-工业方案演示/`）建虚拟环境，装依赖：

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r src/drawings/requirements.txt
```

出图：

```bash
.venv/Scripts/python src/drawings/generate.py src/drawings/examples/agv1-long.json src/drawings/out --png
```

```bash
.venv/Scripts/python src/drawings/generate.py src/drawings/examples/crane-22m5.json src/drawings/out --png
```

输出在 `out/<方案 id>/`（`out/` 不入库）：

```
structure.dxf     结构总图
process.svg       涂装与标识工艺图
process.pdf
manifest.json     参数、图幅比例、分区、标识位置、生成的文件
structure.png     加 --png 时的预览（ezdxf matplotlib 后端）
process.png
```

参数越界、步长不对、夹具不匹配、色号或分区不存在时，打印原因并以退出码 2 结束，例如：

```
方案校验失败：参数 跨度（span）= 40000 mm 超出范围：允许 10500–31500 mm，步长 500 mm（范围见 src/drawings/crane.config.json）
```

测试：

```bash
.venv/Scripts/python -m pytest src/drawings/tests -q
```

测试把 DXF 读回来，逐个检查带标记的尺寸：量出来的值和方案参数误差为 0，图上显示的文字也等于参数值；每个长度参数都必须在图上标出。另外覆盖越界、步长、未知参数、夹具不匹配、未知色号和分区、命令行退出码。

## 方案 JSON

```json
{
  "id": "P-AGV1-001",
  "version": 2,
  "project": {"name": "卷材车间物流 AGV 方案（示意）", "customer": "示例客户"},
  "product": {
    "product_id": "agv1",
    "params": {"length_mm": 3600},
    "fixture_id": "stand_coil"
  },
  "finish": {
    "system": "standard",
    "zones": {"A": "yellow"},
    "markings": {"logo": false}
  },
  "drawing": {"date": "2026-11-10", "drawn_by": "方案助手（自动）"}
}
```

| 字段 | 说明 |
|---|---|
| `product.product_id` | `agv1`、`z1-1000-bz`（读 `src/parametric/*.config.json`），`qd-double-girder`（读本目录 `crane.config.json`） |
| `product.params` | 改过的参数，键名带不带 `_mm` / `_t` 都行。没给的取额定值；起重机的主梁高、大车基距、小车轨距没给时按跨度和起重量派生，参数表“来源”列会写“派生” |
| `product.fixture_id` | 夹具 / 吊具，见 `fixtures.json`。AGV 用支架，起重机用吊钩或电磁吸盘 |
| `finish.system` | 涂层体系，见 `finishes.json`：`standard`（室内 C3）、`heavy`（室外 C4） |
| `finish.zones` | 覆盖分区面漆，写 `paints.json` 的键名或 `#rrggbb` |
| `finish.markings` | `false` 关掉某个标识，或 `{"text": "..."}` 改文字 |

## 代码结构

| 文件 | 作用 |
|---|---|
| `generate.py` | 命令行入口，`export_drawings()` 出全部图并写 manifest |
| `plan.py` | 读方案、查参数范围、派生起重机参数、解析色号 |
| `geometry.py` | AGV 按 `src/parametric` 的分段拉伸规则算各部件包围盒（和网页 `stretch.js` 同一套）；起重机按参数算示意外形 |
| `cad.py` | 图层、字体、标注样式、图框、标题栏、参数表、带标记的尺寸 |
| `agv_dxf.py` / `crane_dxf.py` | 两类产品的结构总图 |
| `process.py` | 涂装与标识工艺图 |
| `preview.py` | DXF 转 PNG 预览 |
| `crane.config.json` | 双梁起重机的示意参数和范围 |
| `fixtures.json` / `finishes.json` | 夹具外形、涂层体系、分区和标识（全部示意） |

DXF 约定：

- 模型空间 1:1 毫米，图框按 1:n 放大 n 倍画，所以尺寸量出来就是真实尺寸。图幅和比例自动选：AGV 在 A3/A2/A1 里选，起重机在 A2/A1 里选，比例取标准系列。
- 图层：`OUTLINE` 轮廓、`HIDDEN` 不可见轮廓、`CENTER` 中心线、`DIM` 尺寸、`TEXT` 文字、`FRAME` 图框和标题栏、`THIN` 地面剖面线引线、`STAMP` “示意”章。
- 每个由程序生成的尺寸挂 XDATA（应用名 `WEIHUA_DRAW`）：角色（`param` 方案参数 / `derived` 派生 / `reference` 参考）、参数名、数值。括号里的是参考尺寸。下游可以按这个回读核对。
- 文件头自定义变量记了方案号、产品和全部参数。

## 哪些是示意

| 内容 | 现在 | 要换成 |
|---|---|---|
| 图框、标题栏、图号规则 | 按 GB/T 14689、GB/T 10609.1 简化画的 | 卫华图框模板（DWG 块）和图号编码规则 |
| AGV 外形 | 按三维模型包围盒和拉伸规则算，只有外形，没有内部结构 | 卫华结构图或 STEP 模型 |
| 起重机 | 没有模型，除方案参数外的尺寸（端梁、小车、车轮、轨道、吊钩）按经验比例给的 | 卫华 QD 系列设计手册的参数表和总图 |
| 主梁截面板厚 | 额定值，未做强度、刚度校核 | 设计计算结果 |
| 色号 | AGV1 用模型材质色，起重机和 Z1 用 `paints.json` 的演示色，都没有 RAL / 国标色号 | 卫华色卡 |
| 涂层体系、膜厚、检验 | 按常见 C3 / C4 体系填的 | 卫华涂装工艺规范 |
| 标识尺寸和位置 | AGV 能从模型 manifest 找到的用模型位置，找不到的按规则放；起重机全部按规则放 | 卫华 VI 规范和标识布置图 |

## 离生产图纸还差什么

1. **卫华图框标准**：图框块、标题栏字段、图号和版本规则、签字栏。拿到后改 `cad.py` 的 `frame()` 和 `title_block()`，或者直接插入卫华的 DWG 块。
2. **BOM**：总图要有明细栏。需要卫华的物料编码和每个型号的标准 BOM，再按方案参数选规格（比如跨度决定主梁长度、起重量决定起升机构）。
3. **零件图和部件图**：主梁、端梁、小车架的焊接件图，带公差、焊缝符号和技术要求。这要在卫华的参数化模型（SolidWorks / Creo / Inventor）里驱动生成，不适合从这里的示意几何出。
4. **设计校核**：主梁强度、刚度、稳定性计算，轮压和轨道选型。
5. **涂装和标识**：色卡、涂装工艺规范、VI 规范（Logo 图形、字体、吨位标样式）、铭牌内容模板。
6. **下发去向**：下发给 PLM / ERP / MES 的格式和审签流程。

## 以后接到 Agent 工具

`generate.py` 里的 `export_drawings(plan, out_dir, png=False)` 就是工具的实现，输入方案字典，返回 manifest。建议的工具定义：

```json
{
  "name": "export_drawings",
  "description": "按已定稿的方案出结构总图（DXF）和涂装与标识工艺图（SVG/PDF），全部为示意图纸。参数越界时返回错误和允许范围。",
  "input_schema": {
    "type": "object",
    "properties": {
      "plan": {"type": "object", "description": "方案 JSON，结构见 src/drawings/README.md"},
      "preview": {"type": "boolean", "description": "是否同时出 PNG 预览，给用户在对话里看"}
    },
    "required": ["plan"]
  }
}
```

接法：

- 工具里捕获 `PlanError`，把中文消息原样还给模型，模型就能告诉用户“车长最多 6000 mm”，再让用户改方案。
- 返回 manifest 里的图幅、比例、各参数取值和来源、标识位置，加文件下载链接；PNG 预览可以直接贴回对话。
- 下发前要有人工确认这一步：manifest 的 `status` 一直是“示意”，在接入卫华图框和校核之前不应该自动推到 PLM。
