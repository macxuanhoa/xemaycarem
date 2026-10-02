/* global document, window */
import { chromium } from 'playwright';

async function main() {
  console.log('Testing live Vercel deployment: https://xemaycarem.vercel.app');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  const responseErrors = [];
  page.on('response', res => {
    if (res.status() >= 400) {
      responseErrors.push(`${res.status()} ${res.url()}`);
    }
  });

  // 1. Visit root page
  const response = await page.goto('https://xemaycarem.vercel.app', { waitUntil: 'networkidle' });
  console.log('Root HTTP Status:', response?.status());
  const title = await page.title();
  console.log('Page Title:', title);

  // 2. Check login form elements
  const userInput = await page.$('input[autocomplete="username email"]');
  const passInput = await page.$('input[autocomplete="current-password"]');
  const submitBtn = await page.$('button[type="submit"]');
  console.log('Has Username input:', !!userInput);
  console.log('Has Password input:', !!passInput);
  console.log('Has Submit button:', !!submitBtn);

  // 3. Check Motorcycle SVG / Branding
  const motorcycleSvg = await page.$('.motorcycle-hero-card svg');
  console.log('Has Motorcycle SVG graphic:', !!motorcycleSvg);

  // 4. Test nested SPA route direct reload
  const inventoryRes = await page.goto('https://xemaycarem.vercel.app/inventory', { waitUntil: 'networkidle' });
  console.log('Direct reload /inventory HTTP status:', inventoryRes?.status());
  const currentUrl = page.url();
  console.log('Direct reload navigated URL:', currentUrl);

  // 5. Test PWA manifest and service worker
  const manifestRes = await page.request.get('https://xemaycarem.vercel.app/manifest.webmanifest');
  console.log('/manifest.webmanifest status:', manifestRes.status());
  const swRes = await page.request.get('https://xemaycarem.vercel.app/sw.js');
  console.log('/sw.js status:', swRes.status());

  // 6. Test mobile viewport
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('https://xemaycarem.vercel.app/login', { waitUntil: 'networkidle' });
  const hasHorizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > window.innerWidth + 1;
  });
  console.log('Mobile horizontal overflow detected:', hasHorizontalOverflow);

  // 7. Check errors
  console.log('Console errors count:', consoleErrors.length);
  if (consoleErrors.length > 0) {
    console.log('Console errors:', consoleErrors);
  }
  console.log('HTTP >=400 count:', responseErrors.length);
  if (responseErrors.length > 0) {
    console.log('Failed requests:', responseErrors);
  }

  await browser.close();

  if (response?.status() === 200 && !hasHorizontalOverflow && consoleErrors.length === 0) {
    console.log('ALL VERIFICATION CHECKS PASSED!');
    process.exit(0);
  } else {
    console.error('VERIFICATION CHECKS FAILED!');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
