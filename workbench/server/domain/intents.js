import { DEFAULT_STEPS, addCrane, addStationEastOf, clone, importSite, playAnimation, setParams, setProcess, setProduct, setTakt, showTravel, simulateShift, checkClearance } from './plan.js';

export async function parseOfflineIntent(plan, text) {
  const input = String(text).trim();
  if (/导入.*(示例|厂房|sample)/i.test(input)) return importSite(plan);
  if (/RM-01.*东边.*2.*米/.test(input)) return addStationEastOf(plan, { distanceMm: 2000 });
  if (/选.*AGV1/i.test(input)) {
    const selected = setProduct(plan, { productId: 'agv1' });
    if (!selected.ok) return selected;
    const match = input.match(/车长.*?(\d+(?:\.\d+)?)/);
    return match ? setParams(plan, { length: Number(match[1]) }) : selected;
  }
  if (/车长.*\d/.test(input)) return setParams(plan, { length: Number(input.match(/车长.*?(\d+(?:\.\d+)?)/)?.[1]) });
  if (/双梁.*起重机/.test(input)) {
    return addCrane(plan, {
      span: Number(input.match(/跨度\s*(\d+(?:\.\d+)?)\s*米/)?.[1] ?? 22.5) * 1000,
      liftHeight: Number(input.match(/起升\s*(\d+(?:\.\d+)?)\s*米/)?.[1] ?? 12) * 1000,
      fixture: 'c-hook',
    });
  }
  if (/流程/.test(input)) return setProcess(plan, { steps: DEFAULT_STEPS, confirmed: false });
  if (/^确认/.test(input)) return setProcess(plan, { steps: plan.pendingProcess ?? DEFAULT_STEPS, confirmed: true });
  if (/播放全流程/.test(input)) return playAnimation(plan, { mode: 'full' });
  if (/只看第\s*3\s*步/.test(input)) return playAnimation(plan, { mode: 'step', stepIndex: 2 });
  if (/节拍.*?(\d+(?:\.\d+)?)\s*秒/.test(input)) return setTakt(plan, { seconds: Number(input.match(/节拍.*?(\d+(?:\.\d+)?)/)?.[1]) });
  if (/模拟.*?(\d+(?:\.\d+)?)\s*小时/.test(input)) return simulateShift(plan, { hours: Number(input.match(/模拟.*?(\d+(?:\.\d+)?)/)?.[1]) });
  if (/显示行程/.test(input)) return showTravel(plan);
  if (/净距/.test(input)) return { ok: true, plan: clone(plan), message: `当前全程最小净距 ${Math.round(checkClearance(plan).distanceMm)} mm。`, card: { type: 'clearance', ...checkClearance(plan) } };
  return { ok: true, plan: clone(plan), message: '离线模式已就绪。可输入：导入示例厂房、选 AGV1、添加双梁桥式起重机、流程、播放全流程、显示行程。' };
}
