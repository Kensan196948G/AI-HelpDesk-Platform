// G3 追加: STEP2 の構造 discovery（A08a の送信操作を特定）
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
await page.waitForTimeout(800);
const startBtn = page.getByRole('button', { name: '新しい相談をはじめる' });
if (await startBtn.count()) { await startBtn.first().click(); await page.waitForTimeout(700); }
// 相談種類を選ぶ（最初の w-choice）
const choice = page.locator('button.w-choice').first();
if (await choice.count()) { await choice.click(); await page.waitForTimeout(300); }
const next = page.getByRole('button', { name: 'つぎへ' });
if (await next.count()) { await next.first().click(); await page.waitForTimeout(900); }
await page.screenshot({ path: out + '/G3-step2.png', fullPage: true });

const snap = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  return {
    buttons: [...document.querySelectorAll('button')].filter(vis).map((b) => ({ text: (b.textContent || '').trim().slice(0, 40), disabled: b.disabled, cls: b.className || null })).slice(0, 50),
    inputs: [...document.querySelectorAll('input, textarea, select')].filter(vis).map((i) => ({ tag: i.tagName, id: i.id || null, type: i.type || null, placeholder: i.placeholder || null })).slice(0, 30),
    activeStep: (() => { const el = [...document.querySelectorAll('.w-stp')].find((e) => e.classList.contains('on')); return el ? el.textContent.trim() : null; })(),
    markers: ['入力してください', '選んでください', '必須です', 'AI に相談'].filter((m) => document.body.innerText.includes(m)),
    textHead: document.body.innerText.slice(0, 800),
  };
});
writeFileSync(out + '/G3-step2-discovery.json', JSON.stringify({ errors, snap }, null, 2));
console.log(JSON.stringify(snap, null, 2));
await browser.close();
