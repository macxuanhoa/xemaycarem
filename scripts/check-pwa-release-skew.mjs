// Two real build directories, isolated loopback server, no hosted calls.
/* global document, caches, innerWidth */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, devices } from '@playwright/test';

if (!process.env.PWA_PREVIOUS_DIST) throw new Error('Set PWA_PREVIOUS_DIST to a retained earlier actual build.');
const previous = await realpath(resolve(process.env.PWA_PREVIOUS_DIST));
const current = await realpath(resolve('dist'));
assert.notEqual(previous, current, 'Previous and current artifacts must be separate');
const oldIndex = await readFile(resolve(previous, 'index.html'), 'utf8');
const newIndex = await readFile(resolve(current, 'index.html'), 'utf8');
assert.notEqual(oldIndex, newIndex, 'Builds must have actually changed hashed assets, not only a worker comment');
assert.notEqual(await readFile(resolve(previous, 'sw.js'), 'utf8'), await readFile(resolve(current, 'sw.js'), 'utf8'));
const entry = html => /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
const oldEntry = entry(oldIndex), newEntry = entry(newIndex);
assert.ok(oldEntry && newEntry);
assert.notEqual(oldEntry, newEntry, 'Distinct production entry chunks are required');
let serveCurrent = false;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
const server = createServer(async (request, response) => {
  try {
    const root = serveCurrent ? current : previous;
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    if (!extname(file)) file = resolve(root, 'index.html');
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(listen => server.listen(0, '127.0.0.1', listen));
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  await context.route('https://**/*', route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/login`);
  await page.getByRole('heading', { name: 'Chào mừng trở lại' }).waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  assert.ok(await page.evaluate(path => [...document.scripts].some(script => script.src && new URL(script.src).pathname === path), oldEntry));
  const username = page.getByRole('textbox', { name: /Tên đăng nhập hoặc email/ });
  await username.fill('synthetic-unsaved-version-skew');
  serveCurrent = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.getByText('Có phiên bản mới. Hãy lưu công việc trước khi cập nhật.').waitFor();
  assert.equal(await username.inputValue(), 'synthetic-unsaved-version-skew');
  assert.equal(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)), true);
  await context.setOffline(true);
  assert.equal(await username.inputValue(), 'synthetic-unsaved-version-skew');
  await context.setOffline(false);
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Cập nhật', exact: true }).click()]);
  await page.getByRole('heading', { name: 'Chào mừng trở lại' }).waitFor();
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration.active?.state === 'activated' && !registration.waiting;
  });
  assert.ok(await page.evaluate(path => [...document.scripts].some(script => script.src && new URL(script.src).pathname === path), newEntry));
  const cached = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) {
      result.push(...(await (await caches.open(name)).keys()).map(request => request.url));
    }
    return result;
  });
  assert.ok(cached.some(url => new URL(url).pathname === newEntry));
  assert.ok(cached.every(url => !/\/(rest|auth|functions)\/v1\//.test(url)), 'Financial/Auth/API responses must not be cached');
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'Chào mừng trở lại' }).waitFor();
  assert.ok(await page.evaluate(path => [...document.scripts].some(script => script.src && new URL(script.src).pathname === path), newEntry));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await context.setOffline(false);
  await page.reload();
  await page.getByRole('heading', { name: 'Chào mừng trở lại' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(`PASS mobile Chromium real previous→current hashed-asset/worker rollout (${oldEntry}→${newEntry}), waiting preserves input, explicit activation, current shell offline/online, no API cache/runtime errors.`);
  console.log('Physical Android/iOS install/process kill/power loss and hosted CDN/GoTrue/schema rollout remain NOT VERIFIED.');
} finally {
  await browser.close();
  await new Promise(close => server.close(close));
}
