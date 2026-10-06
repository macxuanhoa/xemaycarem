// Local-only lifecycle test with the real production Workbox worker.
// Changing only worker bytes tests waiting/activation; different asset/schema versions remain a separate rollout test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '@playwright/test';
const root = resolve('dist');
let revision = 1;
const mime = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    if (!extname(file)) file = resolve(root, 'index.html');
    let data = await readFile(file);
    if (path === '/sw.js') data = Buffer.from(data.toString() + `\n// isolated-lifecycle-revision:${revision}\n`);
    response.writeHead(200, { 'Content-Type':mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control':'no-store' });
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/login`);
  await page.getByRole('heading', { name:'Chào mừng trở lại' }).waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const username = page.getByRole('textbox', { name:/Tên đăng nhập hoặc email/ });
  await username.fill('synthetic-unsaved-login');
  revision = 2;
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
  await page.getByText('Có phiên bản mới. Hãy lưu công việc trước khi cập nhật.').waitFor();
  assert.equal(await username.inputValue(), 'synthetic-unsaved-login');
  assert.equal(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)), true);
  await Promise.all([page.waitForEvent('load'),page.getByRole('button', { name:'Cập nhật', exact:true }).click()]);
  await page.getByRole('heading', { name:'Chào mừng trở lại' }).waitFor();
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration.active?.state === 'activated' && !registration.waiting;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name:'Chào mừng trở lại' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS real production worker byte update waits for explicit consent, preserves input while waiting, activates after click and retains offline shell. Asset/schema version skew NOT VERIFIED.');
} finally { await browser.close(); await new Promise(close => server.close(close)); }
