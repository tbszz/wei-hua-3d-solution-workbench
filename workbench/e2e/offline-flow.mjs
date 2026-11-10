import { chromium } from 'playwright-core';

const executablePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(process.env.WORKBENCH_URL ?? 'http://127.0.0.1:5181/', { waitUntil: 'networkidle' });
const commands = [
  '导入示例厂房',
  '在 RM-01 东边 2 米加一个吊装点',
  '选 AGV1，车长改成 3200',
  '车长改成 9000',
  '加一台双梁桥式起重机，跨度 22.5 米，起升 12 米，配 C 形钩',
  '流程：AGV 从 RM-01 接卷送到吊装点，行车把卷吊到成品区，AGV 回充电位',
  '确认',
  '播放全流程',
  '只看第 3 步',
  '节拍改成 90 秒',
  '模拟一个 8 小时班',
  '显示行程',
];
for (const [index, command] of commands.entries()) {
  await page.locator('#chat-input').fill(command);
  await page.locator('.send').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/step-' + String(index + 1).padStart(2, '0') + '.png', fullPage: true });
}
if ((await page.locator('#scene-state').textContent()).includes('等待')) throw new Error('场景没有加载');
if ((await page.locator('.result-card').count()) < 8) throw new Error('结果卡片不足');
await browser.close();
console.log('offline flow passed: ' + commands.length + ' commands');
