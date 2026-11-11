// G3 UI スモーク（A05 Normal State + A08a の discovery）
// 使い方: PLAYWRIGHT_CORE_PATH=... BASE_URL=http://127.0.0.1:19360 node docs/evidence/qa-20261111/ui-smoke.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const base = process.env.BASE_URL || 'http://127.0.0.1:19360';
const outDir = 'docs/evidence/qa-20261111';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const response = await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(1500);

const title = await page.title();
const bodyText = (await page.textContent('body')) || '';
await page.screenshot({ path: outDir + '/G3-normal.png', fullPage: true });

// discovery: 見えているボタン・入力欄を列挙（A08a の操作対象を決めるため）
const visible = await page.evaluate(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const buttons = [...document.querySelectorAll('button')]
    .filter(vis)
    .map((b) => ({ text: (b.textContent || '').trim().slice(0, 40), id: b.id || null, cls: b.className || null }))
    .slice(0, 80);
  const inputs = [...document.querySelectorAll('input, textarea')]
    .filter(vis)
    .map((i) => ({ tag: i.tagName, type: i.type || null, id: i.id || null, placeholder: i.placeholder || null }))
    .slice(0, 40);
  return { buttons, inputs, hasAiChat: /AI相談/.test(document.body.innerText) };
});

const result = {
  url: page.url(),
  status: response ? response.status() : null,
  title,
  bodyLength: bodyText.length,
  hasKeyText: {
    aiConsult: bodyText.includes('AI相談'),
    step1: bodyText.includes('STEP 1') || bodyText.includes('① 受付'),
  },
  consoleErrors: errors,
  visible,
};
writeFileSync(outDir + '/G3-discovery.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
