# Database contract

All operations require a verified Supabase session and an active profile. Functions are atomic PostgreSQL transactions. Table writes are denied to browser roles. Financial columns live in separate RLS-protected tables; the JSON functions omit sensitive keys unless the caller is OWNER or MANAGER with `can_view_financials`.

| RPC | Arguments | Result |
| --- | --- | --- |
| list_vehicles | p_filters jsonb = {} | {items,total} |
| get_vehicle | p_id uuid | Vehicle with images, expenses, sales, activity |
| save_vehicle | p_data jsonb, p_id uuid = null | UUID |
| sell_vehicle | p_data jsonb | sale UUID |
| cancel_sale | p_id uuid, p_reason text | void |
| add_payment | p_data jsonb | payment UUID |
| list_sales | p_filters jsonb = {} | {items,total} |
| get_sale | p_id uuid | Sale with vehicle, payments, paid_amount, remaining_amount |
| list_expenses | p_filters jsonb = {} | {items,total} |
| save_expense | p_kind text, p_data jsonb, p_id uuid = null | UUID |
| cancel_expense | p_kind text, p_id uuid, p_reason text | void |
| dashboard | p_from date = first day of month, p_to date = today | Metrics and lists |
| report | p_kind text, p_filters jsonb = {} | {items,total} |
| list_audit | p_filters jsonb = {} | {items,total} |
| list_profiles | none | Profile[] |
| update_profile | p_id uuid, p_data jsonb | void |
| get_settings | none | settings object |
| save_settings | p_data jsonb | void |
| register_vehicle_image | p_vehicle_id uuid, p_storage_path text, p_display_order int = 0 | UUID |
| remove_vehicle_image | p_id uuid | void |

List filters: `offset` (default 0), `limit` (default 25; max 100), `search`. Vehicle filters: `status` (enum value, `ALL`, or `AVAILABLE`/`UNSOLD` for IN_STOCK and RESERVED), `brand`, `year`, `min_price`, `max_price`, `date_from`, `date_to`, `sort` (`newest`, `oldest`, `highest_cost`, `highest_price`, `longest_stock`). Sales/expense/report dates: `from`, `to` (also accept `date_from`, `date_to`). Expense kind: `vehicle` or `business` (default both), with optional `vehicle_id`. Report kind: `sales`, `inventory`, `profit`, `vehicle_expenses`, `business_expenses`.

Dashboard period totals, daily sales, top profits, recent sales and recent expenses obey the selected inclusive date range. Today/month counters use the Asia/Ho_Chi_Minh business date. Inventory is current stock; `inventory_cost_pending` counts missing costs and `inventory_indicator` is LOW/NORMAL/HIGH using saved low/high stock thresholds. Inventory reports filter current stock by intake date; they are not historical stock reconstructions.

Vehicle purchase cost is optional only for operational users. Missing cost is stored as NULL, exposed as `cost_pending:true`, and blocks selling until an authorized financial user enters the actual purchase cost. `purchase_price` and `total_cost` keys are absent for unauthorized users. Expense lists require OWNER or MANAGER. Staff can add/update operational vehicle information and sell vehicles with completed costs.

Sale creation data: `vehicle_id,customer_name,customer_phone,sale_price,sale_date,initial_payment,payment_method,notes`. Payment data: `sale_id,amount,payment_method,payment_date,reference,notes`. Required VND amounts are exact nonnegative integers, single-entry cap 1,000,000,000,000. Payment amounts must be positive, and total payments may not exceed the sale price. Payments remain immutable; cancelling a sale excludes its retained payments from active collection totals and marks them `VOIDED`, preserving their history. Actual bank/cash refunds are handled outside this V1 app and must be reconciled separately.

Vehicle images use the private `vehicle-images` bucket, JPEG/PNG/WebP/AVIF only, max 8 MiB. Path is `<vehicle UUID>/<random UUID>.<extension>`. Register metadata after successful upload, then generate short-lived signed URLs. Removing metadata soft-deletes it and removes read access through the storage policy. Objects are retained for audit/backup and can be pruned administratively after the retention period.

`manage-users` Edge Function accepts POST `{email,password,full_name,role,can_view_financials}` for an OWNER to create a user. Role/status updates use `update_profile` RPC; self-profile updates accept only full_name. The final active OWNER cannot be disabled/demoted. Owner provisioning for the first account is documented separately and requires a trusted SQL session.
