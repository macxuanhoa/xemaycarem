import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";

const url = process.env.PWA_TEST_URL ?? "http://127.0.0.1:4173";
const manifest = JSON.parse(
  await readFile("dist/manifest.webmanifest", "utf8"),
);
assert.equal(manifest.name, "Cà Rem - Quản Lý Cửa Hàng Xe");
assert.equal(manifest.display, "standalone");
assert.ok(
  manifest.icons.some(
    (icon) => icon.sizes === "512x512" && icon.purpose === "maskable",
  ),
);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForURL("**/login");
  await page.getByRole("heading", { name: "Chào mừng trở lại" }).waitFor();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cachedUrls = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = [];
    for (const name of names) {
      const cache = await caches.open(name);
      urls.push(...(await cache.keys()).map((request) => request.url));
    }
    return urls;
  });
  assert.ok(cachedUrls.some((entry) => new URL(entry).pathname === "/index.html"));
  assert.ok(cachedUrls.some((entry) => new URL(entry).pathname.startsWith("/assets/")));
  assert.ok(cachedUrls.every((entry) => !/\/(rest|auth|functions)\/v1\//.test(entry)), "API responses must not be cached by the service worker");
  const cdp = await context.newCDPSession(page);
  const installability = await cdp.send("Page.getInstallabilityErrors");
  assert.deepEqual(installability.installabilityErrors, []);
  await page.screenshot({
    path: "test-results/login-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: "test-results/login-mobile.png",
    fullPage: true,
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("heading", { name: "Chào mừng trở lại" }).waitFor();
  await context.setOffline(false);
  await page.reload();
  await page.getByRole("heading", { name: "Chào mừng trở lại" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS production manifest, icons, Chromium installability, service worker control, static precache without API responses, desktop/mobile login, offline application shell and online recovery; no browser runtime errors.",
  );
} finally {
  await browser.close();
}
