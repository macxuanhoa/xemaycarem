import { test, expect } from '@playwright/test';
import { day, installUiuxMock } from '../helpers/uiux-fixtures.mjs';

const rpcUrl = name => `https://xe-test.supabase.co/rest/v1/rpc/${name}`;
const reply = (route, value, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(value),
  headers: { 'access-control-allow-origin': '*' },
});
const customer = {
  customer_name: 'Khách giả lập bàn phím', customer_phone: '0900000000',
  purchases_count: 1, total_spent: 35000000, total_paid: 35000000, total_debt: 0,
  first_purchase_date: day, latest_purchase_date: day, sales: [],
};
const lead = {
  id: '00000000-0000-4000-8000-000000000004', kind: 'VEHICLE_INQUIRY',
  customer_name: 'Yêu cầu giả lập', phone: '0900000001', vehicle_id: null,
  vehicle_name: 'Honda Vision', vehicle_year: null, expected_price: null,
  message: 'Dữ liệu kiểm thử cục bộ.', status: 'NEW', created_at: new Date().toISOString(),
};

test('document index shows loading instead of a false empty result', async ({ page }) => {
  const calls = await installUiuxMock(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(rpcUrl('list_knowledge'), async route => {
    await gate;
    await reply(route, { items: [], total: 0 });
  });
  try {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { name: 'Tài liệu cửa hàng' })).toBeVisible();
    await expect(page.getByText('Đang tải dữ liệu…', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chưa tìm thấy trang nào' })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Chưa tìm thấy trang nào' })).toBeVisible();
  expect(calls.writes).toHaveLength(0);
});

for (const name of ['list_knowledge', 'search_knowledge']) {
  test(`${name} failure remains an error until an explicit successful retry`, async ({ page }) => {
    const calls = await installUiuxMock(page, { failRpc: name });
    let recover = false;
    await page.route(rpcUrl(name), route => recover
      ? reply(route, name === 'list_knowledge' ? { items: [], total: 0 } : [])
      : route.fallback());
    await page.goto('/docs');
    if (name === 'search_knowledge') await page.getByLabel('Tìm trong tài liệu').fill('thanh toán');
    const alert = page.getByRole('alert').filter({ hasText: 'Fixture unavailable' });
    await expect(alert).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chưa tìm thấy trang nào' })).toHaveCount(0);
    recover = true;
    await alert.getByRole('button', { name: 'Thử lại' }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Chưa tìm thấy trang nào' })).toBeVisible();
    expect(calls.writes).toHaveLength(0);
  });
}

test('mobile customer history opens with the keyboard and communications failure is retryable', async ({ page }) => {
  const calls = await installUiuxMock(page, { failRpc: 'list_customer_communications' });
  let recover = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(rpcUrl('list_customers'), route => reply(route, { items: [customer], total: 1 }));
  await page.route(rpcUrl('get_customer_history'), route => reply(route, customer));
  await page.route(rpcUrl('list_customer_communications'), route => recover ? reply(route, []) : route.fallback());
  await page.goto('/customers');
  const opener = page.getByRole('button', { name: `Xem lịch sử mua xe của ${customer.customer_name}` });
  await expect(opener).toBeVisible();
  await page.getByLabel('Tìm khách hàng').focus();
  await page.keyboard.press('Tab');
  await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const alert = dialog.getByRole('alert').filter({ hasText: 'Fixture unavailable' });
  await expect(alert).toBeVisible();
  await expect(dialog.getByText('Chưa có lịch sử liên hệ.', { exact: true })).toHaveCount(0);
  recover = true;
  await alert.getByRole('button', { name: 'Thử lại' }).click();
  await expect(dialog.getByText('Chưa có lịch sử liên hệ.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(calls.writes).toHaveLength(0);
});

test('showroom lead lookup errors remain visible and can be retried without a write', async ({ page }) => {
  const calls = await installUiuxMock(page, { failRpc: 'list_showroom_leads' });
  let recover = false;
  await page.route(rpcUrl('list_showroom_leads'), route => recover
    ? reply(route, { items: [], total: 0 }) : route.fallback());
  await page.goto('/customers');
  const alert = page.getByRole('alert').filter({ hasText: 'Fixture unavailable' });
  await expect(page.getByRole('heading', { name: 'Yêu cầu mới từ Showroom' })).toBeVisible();
  await expect(alert).toBeVisible();
  recover = true;
  await alert.getByRole('button', { name: 'Thử lại' }).click();
  await expect(alert).toHaveCount(0);
  expect(calls.writes).toHaveLength(0);
});

test('a rejected lead status change exposes an explicit retry for the same intended action', async ({ page }) => {
  const calls = await installUiuxMock(page);
  const attempts = [];
  await page.route(rpcUrl('list_showroom_leads'), route => reply(route, { items: [lead], total: 1 }));
  await page.route(rpcUrl('update_showroom_lead_status'), route => {
    attempts.push(route.request().postDataJSON());
    return reply(route, { message: 'Fixture status unavailable. Hãy thử lại.' }, 503);
  });
  await page.goto('/customers');
  await page.getByRole('button', { name: 'Đã liên hệ', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Fixture status unavailable' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Thử lại' }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts).toEqual([
    { p_id: lead.id, p_status: 'CONTACTED' }, { p_id: lead.id, p_status: 'CONTACTED' },
  ]);
  expect(calls.writes).toHaveLength(0);
});

for (const fixture of [
  { route: '/users', group: 'Lọc theo vai trò', initial: /^Tất cả$/, next: /^Chủ cửa hàng/ },
  { route: '/settings', group: 'Danh mục cài đặt', initial: /^Hồ sơ & Đổi mật khẩu$/, next: /^Bộ nhớ viết tắt thu xe$/ },
  { route: '/audit', group: 'Lọc theo nghiệp vụ', initial: /^Tất cả thao tác$/, next: /^Xe & Tồn kho$/ },
]) {
  test(`${fixture.route} exposes the selected filter or category to assistive technology`, async ({ page }) => {
    const calls = await installUiuxMock(page);
    await page.goto(fixture.route);
    const group = page.getByRole('group', { name: fixture.group });
    await expect(group.getByRole('button', { name: fixture.initial })).toHaveAttribute('aria-pressed', 'true');
    await group.getByRole('button', { name: fixture.next }).click();
    await expect(group.getByRole('button', { name: fixture.next })).toHaveAttribute('aria-pressed', 'true');
    await expect(group.getByRole('button', { name: fixture.initial })).toHaveAttribute('aria-pressed', 'false');
    expect(calls.writes).toHaveLength(0);
  });
}
