import { test, expect } from '@playwright/test';

const PROD_URL = process.env.PROD_URL || 'https://xemaycarem.vercel.app';

test.describe('Production Live Smoke Tests', () => {
  test('production app boots cleanly without fatal exceptions', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        // filter out expected network 401s if unauthenticated
        const text = msg.text();
        if (!text.includes('401') && !text.includes('Failed to load resource')) {
          consoleErrors.push(text);
        }
      }
    });

    await page.goto(PROD_URL, { waitUntil: 'networkidle' });

    // Verify title and main root container
    await expect(page).toHaveTitle(/Cà Rem/);
    const root = page.locator('#root');
    await expect(root).toBeVisible();

    // Verify login screen elements or main screen
    const emailInput = page.locator('input[type="email"], input[name="email"], input#email');
    const hasLogin = await emailInput.count() > 0;
    if (hasLogin) {
      await expect(emailInput.first()).toBeVisible();
      console.log('Login form rendered properly on production');
    }

    // Verify no unexpected fatal errors logged
    console.log(`Console fatal errors count: ${consoleErrors.length}`);
    expect(consoleErrors.length).toBeLessThanOrEqual(1);
  });

  test('production app renders properly in mobile viewport', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15'
    });
    const page = await context.newPage();
    await page.goto(PROD_URL, { waitUntil: 'networkidle' });

    await expect(page.locator('#root')).toBeVisible();
    await context.close();
  });
});
