// G3 追加: A08a 入力エラー（STEP2 で件名・本文を空のまま「AIに相談する」）
// 前提: テスト DB の prototype_states をクリア済み（画面状態を持ち越さない）
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const base = process.env.BASE_URL || 'http://127.0.0.1:19360';
const out = 'docs/evidence/qa-20261111';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
const page = await context.newPage();
const errors = [];
const posts = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/cases')) posts.push(r.url()); });

const activeStep = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('.w-stp')].find((e) => e.classList.contains('on'));
  return el ? el.textContent.trim() : null;
});

await page.goto(base + '/', { waitUntil: 'load' });
await page.waitForTimeout(900);

let step = await activeStep();
for (let i = 0; i < 6 && !(step && step.includes('STEP 2')); i += 1) {
  const start = page.getByRole('button', { name: '新しい相談をはじめる' });
  if (await start.count()) { await start.first().click(); await page.waitForTimeout(700); step = await activeStep(); continue; }
  if (step && step.includes('STEP 1')) {
    const choice = page.locator('button.w-choice').first();
    if (await choice.count()) {
      await choice.first().click(); await page.waitForTimeout(250);
      const next = page.getByRole('button', { name: 'つぎへ' });
      if (await next.count()) { await next.first().click(); await page.waitForTimeout(800); step = await activeStep(); continue; }
    }
  }
  const navNew = page.getByRole('button', { name: '新しい相談', exact: true });
  if (await navNew.count()) { await navNew.first().click(); await page.waitForTimeout(500); step = await activeStep(); continue; }
  break;
}

const atStep2 = Boolean(step && step.includes('STEP 2'));
const before = await page.evaluate(() => document.body.innerText);
const sendBtn = page.getByRole('button', { name: /AIに相談する/ });
const sendFound = (await sendBtn.count()) > 0;
if (atStep2 && sendFound) { await sendBtn.first().click(); await page.waitForTimeout(1000); }
const after = await page.evaluate(() => document.body.innerText);
const afterStep = await activeStep();
await page.screenshot({ path: out + '/G3-input-error.png', fullPage: true });

const message = '内容を入力してください';
const toastShown = after.includes(message) && after.split(message).length > before.split(message).length;
const stayed = Boolean(afterStep && afterStep.includes('STEP 2'));
const verdict = atStep2 && sendFound && toastShown && stayed && posts.length === 0 ? 'PASS' : 'FAIL';
const result = {
  verdict, reachedStep2: atStep2, stepAtStart: step, stepAfterSend: afterStep,
  sendButtonFound: sendFound, toastShown, message,
  stayedOnStep2: stayed, postApiCases: posts, consoleErrors: errors,
  bodyLenBefore: before.length, bodyLenAfter: after.length,
};
writeFileSync(out + '/G3-input-error.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
