import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, importSite, setParams, addStationEastOf, addCrane, setProcess, setTakt, simulateShift, travel, checkClearance } from './domain/plan.js';
import { trapezoidProfile } from './domain/motion.js';
import { parseOfflineIntent } from './domain/intents.js';

test('离线验收脚本关键指令按顺序修改 ScenePlan', async () => {
  const plan = emptyPlan();
  let result = await parseOfflineIntent(plan, '导入示例厂房');
  assert.equal(result.ok, true);
  result = await parseOfflineIntent(plan, '在 RM-01 东边 2 米加一个吊装点');
  assert.equal(result.ok, true);
  assert.equal(plan.site.points[0].id, '吊装点-01');
  result = await parseOfflineIntent(plan, '选 AGV1，车长改成 3200');
  assert.equal(result.ok, true);
  assert.equal(plan.product.params.length, 3200);
  result = await parseOfflineIntent(plan, '车长改成 9000');
  assert.equal(result.ok, false);
  result = await parseOfflineIntent(plan, '加一台双梁桥式起重机，跨度 22.5 米，起升 12 米，配 C 形钩');
  assert.equal(result.ok, true);
  result = await parseOfflineIntent(plan, '流程：AGV 从 RM-01 接卷送到吊装点，行车把卷吊到成品区，AGV 回充电位');
  assert.equal(result.card.requiresConfirmation, true);
  result = await parseOfflineIntent(plan, '确认');
  assert.equal(result.ok, true);
  result = await parseOfflineIntent(plan, '节拍改成 90 秒');
  assert.equal(result.ok, true);
  result = await parseOfflineIntent(plan, '模拟一个 8 小时班');
  assert.equal(result.card.completed > 0, true);
  result = await parseOfflineIntent(plan, '显示行程');
  assert.equal(result.ok, true);
  assert.equal(plan.travel.visible, true);
});

test('起重机三轴梯形运动终点误差小于 1mm', () => {
  const profile = trapezoidProfile(22500, 2000, 800, Infinity);
  assert.ok(Math.abs(profile.position - 22500) < 1);
  assert.equal(profile.atEnd, true);
});

test('越界点位和参数拒绝，效率和班次确定性', async () => {
  const plan = emptyPlan();
  await importSite(plan);
  assert.equal(setParams(plan, { length: 9000 }).ok, false);
  assert.equal((await addStationEastOf(plan, { distanceMm: 100000 })).ok, false);
  await addCrane(plan, {});
  await setProcess(plan, { steps: [{ index: 1, equipment: 'AGV1', action: '接卷', from: 'RM-01', to: '成品区', dwellSeconds: 8 }], confirmed: true });
  const takt = setTakt(plan, { seconds: 90 });
  assert.equal(takt.ok, true);
  const a = simulateShift(plan, { hours: 8 }).card;
  const b = simulateShift(plan, { hours: 8 }).card;
  assert.deepEqual(a, b);
  assert.equal(travel(plan).devices.length, 2);
  assert.ok(checkClearance(plan).distanceMm >= 0);
});
