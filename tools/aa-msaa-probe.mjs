// Driver for tools/aa-msaa-probe.html. See that file for what is being asked.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto('http://127.0.0.1:8123/tools/aa-msaa-probe.html');
await page.waitForFunction('window.__probe', null, { timeout: 60000 });
const report = await page.evaluate(() => window.__probe);
console.log(JSON.stringify(report, null, 1));
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
await browser.close();
