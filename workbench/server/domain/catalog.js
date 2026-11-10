export const CATALOG = [
  {
    id: 'agv1', model: 'AGV1', category: 'agv', capacityT: 30, fixture: ['agv-coil-rack'],
    industries: ['钢铁', '有色金属', '重型装备', '造船'], applications: ['钢卷转运', '重载搬运'],
    summary: '四角驱动重载平板车，示意', plate: '铭牌 1001 · 30t',
    params: {
      length: { label: '车长', nominal: 2800, min: 2200, max: 6000, step: 10 },
      width: { label: '车宽', nominal: 1500, min: 1200, max: 2600, step: 10 },
      height: { label: '车高', nominal: 381.9, min: 360, max: 700, step: 0.1 },
    },
  },
  {
    id: 'z1-1000-bz', model: 'Z1-1000-BZ', category: 'agv', capacityT: 10, fixture: ['agv-coil-rack'],
    industries: ['汽车', '机械加工', '仓储物流', '有色金属'], applications: ['中载搬运', '工位间转运'],
    summary: '四角驱动平板车，示意', plate: '标牌 10t',
    params: {
      length: { label: '车长', nominal: 5000, min: 4200, max: 8000, step: 10 },
      width: { label: '车宽', nominal: 2000, min: 1600, max: 3000, step: 10 },
      height: { label: '车高', nominal: 512.5, min: 420, max: 900, step: 0.5 },
    },
  },
  {
    id: 'double-girder-crane-demo', model: '双梁桥式起重机（示意）', category: 'overhead_crane', capacityT: 30,
    industries: ['钢铁', '重型装备', '港口', '电力', '造船'], applications: ['卷材吊运', '库区堆垛'],
    fixture: ['c-hook'], summary: 'S-BEAM 上运行的三轴桥式起重机', plate: 'demo_data',
    params: { span: { label: '跨度', nominal: 22500, min: 10000, max: 30000, step: 100 }, liftHeight: { label: '起升高度', nominal: 12000, min: 6000, max: 18000, step: 100 } },
  },
];

export function getProduct(id) {
  return CATALOG.find((item) => item.id === id || item.model.toLowerCase() === String(id).toLowerCase());
}

export function searchProducts(query = '') {
  const q = String(query).trim().toLowerCase();
  return CATALOG.filter((item) => !q || [item.id, item.model, item.summary, item.category].some((value) => String(value).toLowerCase().includes(q)));
}
