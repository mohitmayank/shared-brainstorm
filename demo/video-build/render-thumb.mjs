import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('file://' + process.cwd() + '/thumbnail.html');
await page.waitForTimeout(400);
await page.screenshot({ path: 'youtube-thumbnail@2x.png' });
await browser.close();
console.log('rendered youtube-thumbnail@2x.png');
