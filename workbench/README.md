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
