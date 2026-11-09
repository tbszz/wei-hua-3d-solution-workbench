# 模拟 CAD 平面图约定

网页现场读 DXF 平面图，按图层和块属性生成三维场景和 AGV 路线。只要按这份约定出图，导入后不用改代码。

示例图是 `data/cad/sample-plant.dxf`，由 `src/scene/make_sample_plant.py` 生成。解析代码在 `demo/src/scene/parse-cad.js`。

## 基本规则

- 单位毫米（`$INSUNITS = 4`），其他单位会被拒绝。
- 平面图 X、Y 对应地面，网页里映射为 `(x/1000, 高度, -y/1000)` 米。块的旋转角就是朝向，0° 指向 +X，逆时针为正。
- 必须有的图层：`A-WALL`、`AGV-PATH`、`AGV-STAT`。缺了会报错，并列出缺哪几个。
- 高度写在块属性 `HEIGHT` 里，平面图本身没有高度。

## 图层

图层名沿用 AIA/NCS 的写法，`Q-` 和 `AGV-` 是这个项目自己加的。

| 图层 | 内容 | 图元 |
|---|---|---|
| `A-WALL` | 外墙 | 带宽度的闭合多段线 |
| `A-DOOR` | 大门 | 块，属性 `HEIGHT` |
| `A-GLAZ` | 窗和墙板 | 块，属性 `SILL`（窗台高）、`HEIGHT` |
| `S-COLS` | 钢柱 | 块 `COL_500` / `COL_300`，属性 `HEIGHT` |
| `S-BEAM` | 吊车梁 | 带宽度的多段线 |
| `Q-RACK` | 货架 | 块，属性 `HEIGHT`、`LEVELS` |
| `Q-MACH` | 设备 | 块 `MACH_CNC` / `MACH_PRESS` / `MACH_WELD`，属性 `NAME`、`HEIGHT` |
| `Q-CONV` | 输送线 | 块，属性 `HEIGHT` |
| `Q-CRAN` | 行车（静止，暂不做吊装） | 块，属性 `HEIGHT` |
| `A-FLOR-YEL` / `-GRN` / `-MARK` | 地面黄、绿、白标线 | 带宽度的多段线 |
| `A-ANNO-TEXT` | 地面文字 | TEXT |
| `AGV-PATH` | AGV 中心线 | 多段线，弧段用凸度 |
| `AGV-STAT` | 工位 | 块，见下 |

## 工位

工位块放在 AGV 停车时的车体中心，块的旋转角是 AGV 车头朝向。

| 属性 | 含义 | 例子 |
|---|---|---|
| `ID` | 工位编号，界面上显示 | `RM-01` |
| `TYPE` | `PICK` 取货、`DROP` 卸货、`CHARGE` 充电 | `PICK` |
| `SEQ` | 第几站，从 0 开始。起点兼终点写两个序号 | `0,5` |
| `CARGO` | 取货工位的货物，`COIL` 钢卷或 `CRATE` 木箱 | `COIL` |

块 `AGV_STAND` 是货架工位，由两条平行轨道组成，车从中间穿过；块 `AGV_CHARGE` 是充电柜。

路线从工位沿 `AGV-PATH` 连接：路线相切的地方连续行驶，不相切的地方原地转向，从尽头支路退出时倒车。

## 精度

运动是按时间算出来的确定结果，不是逐帧积分，所以同一时刻的位姿永远相同。`demo/src/scene/route.test.js` 检查的是：

- 车到工位时，位置误差小于 1 mm，角度误差小于 0.01°。
- 整个循环里，车体中心偏离路线小于 1 mm。

这里的精度指车体中心相对图纸的数学位置。真实车辆的定位误差、转向响应没有建模；速度和加速度是 `route.js` 里 `MOTION` 的演示值，需要换成实测参数。

## 净距

现场页显示全程最小净距：沿时间轴每 0.1 秒用车体和货物的外框对所有障碍物算一次距离。换车型或改尺寸后重新计算。

低于 500 mm 时变红。这个数是演示阈值，取自 [美国 VA AGV 设计手册](https://www.cfm.va.gov/til/dManual/dmAT-AGV-AMR.pdf)里对固定障碍物的最小间距，正式项目要换成客户的安全规范。
