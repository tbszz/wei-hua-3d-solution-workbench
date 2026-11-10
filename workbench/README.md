# 卫华 3D 方案工作台

第一版是“左 three.js 引擎、右 Agent”浏览器工作台。电脑端使用左侧现场视口和右侧对话，手机端自动上下排。界面和演示参数均标注为示意数据。

## 安装与运行

~~~bash
cd workbench
npm install
npm run dev
~~~

打开 <http://127.0.0.1:5181>。npm run dev 启动 Vite 前端和 8787 端口的 Express 服务。也可以分开运行：

~~~bash
npm run server
npm run preview
~~~

开发启动脚本默认连接本机 Magpie 豆包反代（`http://127.0.0.1:7897/v1`），使用 `trae-cn/seed-code-pro-0430`，额度来自 Magpie。也可以复制 `.env.example` 后改 `MAGPIE_BASE_URL` / `MAGPIE_MODEL`，或关闭 `MAGPIE_ENABLED` 回到离线模式；Anthropic、MiniMax、BigModel 仍作为备用在线入口。所有在线调用仍通过同一批业务工具修改 ScenePlan，Magpie 不可用时自动回退离线解析器。

## 演示脚本

依次输入：

- 导入示例厂房
- 在 RM-01 东边 2 米加一个吊装点
- 选 AGV1，车长改成 3200
- 车长改成 9000（会拒绝并显示 2200–6000 mm）
- 加一台双梁桥式起重机，跨度 22.5 米，起升 12 米，配 C 形钩
- 流程：AGV 从 RM-01 接卷送到吊装点，行车把卷吊到成品区，AGV 回充电位
- 确认
- 播放全流程、只看第 3 步、节拍改成 90 秒、模拟一个 8 小时班、显示行程

视口中双击地面可以添加一个吊装点，服务端会做边界校验。右下方五个分页显示时间轴、工序表、点位表、效率以及行程/甘特图。第 7 步“出图下发”是按 PRD R14 保留的后期说明入口。

## 目录

- src/main.js / src/style.css：工作台布局、对话流、卡片和 three.js 视口接线。
- server/index.js / server/runtime.js：Express 5、SSE、ScenePlan 持久化和在线/离线 Agent 入口。
- server/domain/plan.js：产品、参数、点位、工序、效率、班次、行程和净距校验。
- server/domain/motion.js：起重机三轴梯形速度曲线。
- server/skills/：agv-selection、crane-selection、process-planning。
- public/：示例 DXF、现场材质和现有产品模型的静态副本。
- test-results/：离线验收截图。

起重机和 C 形钩是程序生成的示意模型；如果后续放入同名 GLB，可在视口层替换“大车”“小车”“吊具”“钢丝绳”子对象。速度、加速度、取放时间和 8 小时班统计使用确定性的演示值。

## 产品库 / 场景库 / 项目存档（server/library）

数据存放在 `workbench/data/`（已加入 .gitignore，可用环境变量 `WORKBENCH_DATA_DIR` 改位置）：`library/products.json`、`library/scene.json`、`library/files/<素材id>/`（原件 + 转换结果）、`projects/<项目id>/`。内置产品每次从代码读取（`demo/src/catalog.js` 引用的配置 + `server/domain/catalog.js` 的起重机），不提交 JSON。

接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/library/products` | 列出 / 新建产品（POST 的 id 已存在时返回 409；可传 `modelAssetId` 引用已上传的模型） |
| GET / PUT / DELETE | `/api/library/products/:id` | 查看 / 修改（局部合并，参数校验 最小值 ≤ 标称值 ≤ 最大值）/ 删除；内置产品修改会保存为覆盖，删除只恢复默认 |
| GET | `/api/products` | 兼容旧接口，返回产品库 |
| POST | `/api/library/scene` | multipart 上传，字段 `files`（可多个，单个 ≤ 200 MB），返回 `{ ok, assets }`，单个文件失败不影响其他文件 |
| GET | `/api/library/scene`（可选 `?kind=model`）、`/api/library/scene/:id` | 素材列表 / 单个素材 |
| DELETE | `/api/library/scene/:id` | 删除素材及文件 |
| GET | `/api/library/scene/:id/text`（`?read=0` 不跑 OCR） | 图纸上写的文字（毫米坐标）：TEXT/MTEXT 直接读取；被炸成样条曲线的文字用本机 OCR 识别一次并缓存进 `site.json` 的 `drawnText`。前端「区域标注」和小华的 `read_zones_from_drawing` 用它把区域名标到地面上 |
| GET | `/library/files/...`、`/library/product-models/...` | 转换结果和内置产品模型的静态文件 |
| GET / PUT | `/api/projects/:id/state` | 浏览器引擎的状态快照 `{ version, state, updatedAt }`；PUT `{ state }` 版本号加 1，保留最近 50 个版本 |
| GET | `/api/projects/:id/state/versions`、`/api/projects/:id/state/versions/:version` | 版本列表 / 取某个版本 |
| GET / POST | `/api/projects/:id/chat-history` | 对话记录；POST 一条 `{ role, text, tools? }` 或 `{ messages: [...] }`，保留最近 200 条 |

素材记录：`{ id, name, originalName, originalFormat, kind, status, size, createdAt, url, thumbUrl?, meta, message }`，`kind` 为 `model` / `site` / `image` / `document`，`status` 为 `ready` / `failed` / `unsupported`。格式按扩展名和文件头共同识别，文件头优先。

| 上传格式 | 结果 |
| --- | --- |
| GLB、glTF（外部 .bin/贴图需和 .gltf 一起打 zip）、OBJ(+MTL/贴图)、STL（ASCII/二进制）、PLY、FBX、DAE、3MF | `model`：GLB，单位米、Y 向上，底面落在 y=0、水平居中；`meta.bboxM / triangles / meshes / sourceUnits / scaleApplied` |
| STEP/STP、IGES/IGS、BREP | 经 occt-import-js 网格化后转 GLB（STEP/IGES 按文件单位换算） |
| DXF | `site`：符合卫华图层约定的输出 parse-cad 结果（stations、paths、walls、beams……）；不符合约定的退回通用线条（`meta.convention: 'generic'`） |
| DWG | 尽力用 libredwg（wasm）转成 DXF 后同上；转不了返回 `unsupported`，提示另存为 DXF |
| PNG、JPG、WebP | `image`：原图，可作平面底图，`meta.width/height` |
| PDF、Office、TXT、CSV 等 | `document`：只保存，供参考 |
| ZIP | 安全解压（防路径穿越、防压缩炸弹），按 GLB > glTF > FBX > OBJ > DAE > 3MF > STEP > IGES > BREP > STL > PLY > DXF > DWG 选主文件转换 |

图上文字识别依赖本机 Python 的 `rapidocr_onnxruntime`、`pillow`、`numpy`（`pip install rapidocr_onnxruntime`），解释器可用 `WORKBENCH_PYTHON` 指定；缺依赖时接口返回 `ocrError`，普通 TEXT 照常返回。

单位推断：没有声明单位的格式（STL、OBJ、PLY、BREP、未声明的 GLB）如果最大边长 > 500，按毫米处理（缩放 0.001）；STL、3MF、STEP/IGES/BREP 视为 Z 向上并转成 Y 向上；FBX 使用文件里的 UnitScaleFactor，DAE 使用 `<unit>` 和 `<up_axis>`。贴图尽力保留：PNG/JPEG 原样嵌入 GLB，其他贴图格式会被去掉。
