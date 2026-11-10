#!/usr/bin/env node
// 列出写镜头脚本能用的东西：产品库、现场里的物件（镜头和标注的 target）、流程事件（scene 的时间）。
//   node src/render/inspect.mjs            # 默认 agv1 标准尺寸
//   node src/render/inspect.mjs z1-1000-bz  # 换车型（流程时间不随车型变，物件高度会变）
//   node src/render/inspect.mjs --json
import { listProducts, loadWorld } from './plant.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const productId = args.find((arg) => !arg.startsWith('--')) ?? 'agv1';
const world = loadWorld({ product: productId });
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

if (json) {
  console.log(JSON.stringify({
    products: listProducts(),
    objects: world.objects.map(({ name, aliases, kind, x, y, z, size, moving }) => ({ name, aliases, kind, x: Math.round(x), y: Math.round(y), z, size, moving })),
    events: world.events,
    duration: world.duration,
  }, null, 2));
} else {
  console.log('产品库（product / size）');
  for (const product of listProducts()) {
    const ranges = Object.entries(product.params).map(([key, p]) => `${key} ${p.min}–${p.max}（标准 ${p.nominal}）`).join('，');
    console.log(`  ${product.id.padEnd(12)} ${product.model}  ${product.summary}；${ranges} mm`);
  }
  console.log('\n现场物件（camera.target / labels.at），平面图坐标 mm');
  for (const object of world.objects) {
    const where = object.moving ? '随流程移动' : `X ${Math.round(object.x)}  Y ${Math.round(object.y)}`;
    const size = object.size.w ? `  ${object.size.w.toFixed(1)}×${object.size.d.toFixed(1)}×${object.size.h.toFixed(1)} m` : '';
    const alias = object.aliases.length ? `（也可写 ${object.aliases.join('、')}）` : '';
    console.log(`  ${object.name.padEnd(10)} ${object.kind.padEnd(8)} ${where}${size}${alias}`);
  }
  console.log(`\n流程事件（scene 里写 "事件"、"事件.end"、"事件.mid"、"事件+2s"），全程 ${clock(world.duration)}`);
  for (const event of world.events) {
    console.log(`  ${event.id.padEnd(18)} ${clock(event.t0)} – ${clock(event.t1)}  ${event.text}`);
  }
}
