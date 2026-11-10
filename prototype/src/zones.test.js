import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyZone, isZoneName, shapeOf } from './zones.js';

test('zone names pick their colour class from what they say', () => {
  const cases = {
    原材料检验区: 'inspect',
    高温冷却暂存点: 'buffer',
    原材料出库暂存点: 'buffer',
    成品暂存点: 'buffer',
    高温冷却区: 'process',
    原材料存储区: 'storage',
    成品出库区: 'out',
    化学线上线点: 'in',
    '1#气垫炉下线点': 'out',
    '2#气垫炉': 'process',
    CHG充电位: 'charge',
    吊装交接点: 'handoff',
    办公区: 'area',
  };
  for (const [name, kind] of Object.entries(cases)) assert.equal(classifyZone(name), kind, name);
});

test('points get a round dot, areas a square one', () => {
  assert.equal(shapeOf('1#气垫炉上线点'), 'point');
  assert.equal(shapeOf('CHG-01 充电位'), 'point');
  assert.equal(shapeOf('原材料存储区'), 'area');
  assert.equal(shapeOf('化学线'), 'area');
});

test('only zone-like drawing text becomes a marker', () => {
  for (const t of ['原材料存储区', '2#气垫炉', '化学线下线点', '成品库']) assert.ok(isZoneName(t), t);
  for (const t of ['1#', '22500', '审核', '设计说明', 'A', '图纸比例 1:100']) assert.ok(!isZoneName(t), t);
});
