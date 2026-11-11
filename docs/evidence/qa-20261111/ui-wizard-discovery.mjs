// G3 追加: 相談ウィザードの構造 discovery（A08a の操作対象を決める）
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const base = process.env.BASE_URL || 'http://127.0.0.1:19360';
const out = 'docs/evidence/qa-20261111';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base + '/', { waitUntil: 'load' });
await page.waitForTimeout(1000);
await page.getByRole('button', { name: '新しい相談をはじめる' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: out + '/G3-step1.png', fullPage: true });

const snap = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const buttons = [...document.querySelectorAll('button')].filter(vis)
    .map((b) => ({ text: (b.textContent || '').trim().slice(0, 40), id: b.id || null, cls: b.className || null })).slice(0, 60);
  const inputs = [...document.querySelectorAll('input, textarea, select')].filter(vis)
    .map((i) => ({ tag: i.tagName, type: i.type || null, id: i.id || null, placeholder: i.placeholder || null })).slice(0, 40);
  const text = document.body.innerText;
  const markers = ['入力してください', '選んでください', '必須です', 'STEP 1', 'STEP 2'].filter((m) => text.includes(m));
  return { buttons, inputs, markers, textHead: text.slice(0, 600) };
});
writeFileSync(out + '/G3-step1-discovery.json', JSON.stringify({ errors, snap }, null, 2));
console.log(JSON.stringify(snap, null, 2));
await browser.close();
