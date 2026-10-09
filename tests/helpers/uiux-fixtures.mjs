// Fictional UI audit fixtures. All remote transport is mocked; writes fail closed.
export const userId = "00000000-0000-4000-8000-000000000001";
export const vehicleId = "00000000-0000-4000-8000-000000000002";
export const saleId = "00000000-0000-4000-8000-000000000003";
export const day = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
export const vehicleTitle = "43A1-123.45 · RLH123456789012345";
export const vehicleSubtitle = "Xe tay ga · 2024 · Đen";
export const vehicle = {
  id: vehicleId,
  internal_code: "XE-UI-001",
  // Hồ sơ xe sau 08/10/2026: không còn Hãng / Dòng / Phiên bản / Số máy / Số km
  // / Giá bán dự kiến; RPC gắn sẵn danh tính mới nên fixture phải có đúng shape.
  vehicle_type_id: "00000000-0000-4000-8000-000000000011",
  vehicle_type: "Xe tay ga",
  vehicle_title: vehicleTitle,
  vehicle_subtitle: vehicleSubtitle,
  year: 2024,
  frame_number: "RLH123456789012345",
  license_plate: "43A1-123.45",
  color: "Đen",
  status: "IN_STOCK",
  purchase_date: day,
  purchase_price: 30000000,
  total_cost: 30000000,
  expense_total: 0,
  cost_pending: false,
  supplier_name: "Nguyễn Văn Thanh",
  supplier_phone: "0905123456",
  notes: "Xe kiểm thử giả định, không phải dữ liệu khách hàng.",
  images: [],
  expenses: [],
  activity: [],
  sales: [],
};
export const evidence = {
  kind: "copilot",
  mode: "deterministic",
  available: true,
  coverage: "both",
  period: "Tháng 09/2026",
  facts: [
    { label: "Xe đang tồn kho", value: 7, display: "7 xe", citation: "m2" },
  ],
  citations: [
    {
      id: "m2",
      type: "metric",
      label: "Xe đang tồn kho",
      detail: "Tháng 09/2026",
      route: "/vehicles",
    },
    {
      id: "v3",
      type: "vehicle",
      label: vehicleTitle,
      detail: vehicleSubtitle,
      route: `/vehicles/${vehicleId}`,
    },
  ],
  doc_excerpts: [],
  answer_markdown:
    "Số liệu kỳ **Tháng 09/2026**:\n- Xe đang tồn kho: **7 xe** [m2]",
  suggestions: [{ label: "Mở danh sách xe", route: "/vehicles" }],
  insufficient: false,
  warnings: [],
};
export async function installUiuxMock(
  page,
  {
    role = "OWNER",
    theme = "light",
    long = false,
    empty = false,
    failRpc,
    ai = evidence,
    anonymous = false,
  } = {},
) {
  const calls = [],
    writes = [],
    remote = [];
  await page.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      return route.continue();
    if (url.hostname.endsWith(".supabase.co"))
      return route.continue();
    remote.push(url.hostname);
    return route.abort();
  });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email: "fixture@example.test",
    created_at: new Date().toISOString(),
    app_metadata: {},
    user_metadata: {},
  };
  const access_token =
    [{ alg: "HS256" }, { sub: userId, exp }]
      .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
      .join(".") + ".mock";
  await page.addInitScript(
    ({ session, theme, anonymous }) => {
      try {
        localStorage.setItem("xe-theme", theme);
        if (!anonymous) {
          localStorage.setItem(
            "sb-xe-test-auth-token",
            JSON.stringify(session),
          );
          localStorage.setItem(
            "sb-atsgqtarxhmxrsugulva-auth-token",
            JSON.stringify(session),
          );
        }
      } catch {
        /* Sandboxed third-party embeds have no storage access. */
      }
    },
    {
      session: {
        access_token,
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        expires_at: exp,
        token_type: "bearer",
        user,
      },
      theme,
      anonymous,
    },
  );
  const v = long
    ? {
        ...vehicle,
        frame_number: "RLH".repeat(33),
        vehicle_title: `43A1-123.45 · ${"RLH".repeat(33)}`,
        supplier_name: "Nguyễn Văn ".repeat(15),
        supplier_phone: "",
        notes: "Xe cũ: ".repeat(90),
      }
    : vehicle;
  await page.route(/https:\/\/[a-z0-9-]+\.supabase\.co\/.*/, async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      name = url.pathname.split("/").at(-1);
    const body = request.postData() ? request.postDataJSON() : {};
    const reply = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
    calls.push({ name, body });
    if (
      /^(save_|sell_|acquire_|import_|cancel_|add_|void_|delete_|purge_|update_|mark_)/.test(
        name,
      )
    ) {
      writes.push({ name, body });
      return reply({ message: "UI audit forbids writes" }, 403);
    }
    if (failRpc === name)
      return reply({ message: "Fixture unavailable. Hãy thử lại." }, 503);
    if (url.pathname === "/auth/v1/user") return reply(user);
    if (url.pathname === "/rest/v1/profiles")
      return reply({
        id: userId,
        full_name: "Chủ kiểm thử",
        username: "owner",
        role,
        active: true,
        can_view_financials: role === "OWNER",
        must_change_password: false,
      });
    if (url.pathname === "/functions/v1/ai-assist") return reply(ai);
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "get_settings")
      return reply({
        store_name: "Cửa hàng kiểm thử",
        address: "",
        phone: "",
        inventory_low_threshold: 5,
        inventory_high_threshold: 25,
      });
    if (name === "get_sale")
      return reply({
        id: saleId,
        sale_code: "BAN-UI-001",
        vehicle_id: vehicleId,
        vehicle: { ...v, status: "SOLD" },
        vehicle_title: vehicleTitle,
        vehicle_subtitle: vehicleSubtitle,
        vehicle_type: v.vehicle_type,
        internal_code: v.internal_code,
        license_plate: v.license_plate,
        customer_name: "Khách kiểm thử",
        customer_phone: "0900000000",
        sale_price: 35000000,
        sale_date: day,
        sold_by: userId,
        employee_name: "Chủ kiểm thử",
        status: "COMPLETED",
        notes: "",
        paid_amount: 10000000,
        remaining_amount: 25000000,
        payments: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        total_cost_snapshot: 30000000,
        gross_profit: 5000000,
      });
    if (name === "get_vehicle") return reply(empty ? null : v);
    if (name === "list_vehicle_types")
      return reply([
        {
          id: "00000000-0000-4000-8000-000000000011",
          name: "Xe tay ga",
          vehicle_count: 1,
        },
        { id: "vt-so", name: "Xe số", vehicle_count: 0 },
        { id: "vt-con", name: "Xe côn tay", vehicle_count: 0 },
        { id: "vt-dien", name: "Xe điện", vehicle_count: 0 },
        { id: "vt-chua", name: "Chưa phân loại", vehicle_count: 0 },
      ]);
    if (
      name === "get_acquisition_for_vehicle" ||
      name === "get_operation_result"
    )
      return reply(null);
    if (name === "list_vehicles")
      return reply({ items: empty ? [] : [v], total: empty ? 0 : 1 });
    if (name === "list_acquisitions")
      return reply({
        items: empty
          ? []
          : [
              {
                ...v,
                vehicle_id: vehicleId,
                acquisition_date: day,
                seller_name: v.supplier_name,
                seller_phone: v.supplier_phone,
                status: "COMPLETED",
                creator_name: "Chủ kiểm thử",
                created_at: new Date().toISOString(),
              },
            ],
        total: empty ? 0 : 1,
      });
    if (name === "global_search")
      return reply({ vehicles: empty ? [] : [v], customers: [], sales: [] });
    if (name === "list_notifications")
      return reply({ items: [], unread_count: 0 });
    if (name === "list_profiles")
      return reply([
        {
          id: userId,
          full_name: "Chủ kiểm thử",
          username: "owner",
          role,
          active: true,
          can_view_financials: role === "OWNER",
          must_change_password: false,
        },
      ]);
    if (name === "list_showroom_vehicles")
      return reply({ items: empty ? [] : [v], total: empty ? 0 : 1 });
    if (name === "dashboard")
      return reply({
        in_stock: 7,
        reserved: 1,
        sold_today: 0,
        sold_month: 3,
        acquired_today: 1,
        acquired_month: 4,
        acquisitions_count: 4,
        acquisition_cost: 120000000,
        inventory_cost: 210000000,
        inventory_cost_pending: 0,
        inventory_indicator: "NORMAL",
        today_revenue: 0,
        month_revenue: 105000000,
        today_profit: 0,
        month_profit: 15000000,
        revenue: 105000000,
        gross_profit: 15000000,
        sales_count: 3,
        business_expenses: 0,
        unpaid_sales_count: 0,
        total_receivables: 0,
        overdue_sales_count: 0,
        total_overdue_debt: 0,
        old_inventory_count: 0,
        recent_sales: [],
        recent_vehicles: [v],
        recent_acquisitions: [],
        recent_expenses: [],
        aging: [],
        longest_stock: [],
        top_profitable: [],
        daily_sales: [],
      });
    if (name === "daily_reconciliation")
      return reply({
        date: day,
        sales_count: 0,
        sales_revenue: 0,
        today_sales_collected: 0,
        debt_collected_today: 0,
        total_collected: 0,
        cash_collected: 0,
        bank_transfer_collected: 0,
        other_collected: 0,
        new_debt_created: 0,
        business_expenses: 0,
        vehicle_expenses: 0,
        total_expenses: 0,
        net_cash_movement: 0,
        payments: [],
        sales: [],
        expenses: [],
      });
    if (name === "validate_import_vehicles")
      return reply({ duplicates: [], errors: [] });
    if (name === "search_knowledge" || name === "list_customer_communications")
      return reply([]);
    if (name.startsWith("list_"))
      return reply({
        items: [],
        total: 0,
        total_receivable: 0,
        total_overdue: 0,
        overdue_count: 0,
        unpaid_count: 0,
      });
    return reply({});
  });
  return { calls, writes, remote };
}
