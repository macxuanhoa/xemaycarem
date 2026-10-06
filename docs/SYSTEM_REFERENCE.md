# Tham chiếu hệ thống (sinh tự động)

File này do `scripts/build-system-docs.mjs` sinh ra từ chính mã nguồn — **không sửa tay**, sửa script hoặc nguồn rồi chạy `npm run knowledge:system`. Nội dung luôn khớp migration mới nhất, routes trong `src/App.tsx`, thư mục `supabase/functions` và các statement tạo bucket.

## Danh sách chức năng database (RPC)

Toàn bộ hàm `public` mà ứng dụng gọi được, lấy từ định nghĩa cuối cùng trong `supabase/migrations`. Cột quyền là `private.require_role` khai báo trong thân hàm; "kiểm tra quyền riêng" nghĩa là hàm dùng cơ chế khác (so sánh vai trò trực tiếp, chủ tài khoản cuối cùng, v.v.).

| RPC | Tham số | Vai trò cần |
| --- | --- | --- |
| acquire_vehicle | p_data jsonb | OWNER, MANAGER, STAFF |
| add_payment | p_data jsonb | OWNER, MANAGER, STAFF |
| cancel_acquisition | p_id uuid, p_reason text | OWNER, MANAGER |
| cancel_expense | p_kind text,p_id uuid,p_reason text | OWNER, MANAGER |
| cancel_sale | p_id uuid,p_reason text | OWNER, MANAGER |
| check_user_access | không tham số | kiểm tra quyền riêng trong hàm |
| check_user_can_hard_delete | p_user_id UUID | OWNER |
| claim_message | p_message_id uuid,p_provider_mode text | OWNER, MANAGER, STAFF |
| complete_password_change | không tham số | kiểm tra quyền riêng trong hàm |
| create_showroom_lead | p_data jsonb | kiểm tra quyền riêng trong hàm |
| daily_reconciliation | p_date date DEFAULT NULL | OWNER, MANAGER |
| dashboard | p_from date DEFAULT (date_trunc('month'::text, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)))::date, p_to date DEFAULT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text))::date | OWNER, MANAGER, STAFF |
| delete_acquisition | p_id uuid, p_reason text | OWNER, MANAGER |
| delete_announcement | p_id uuid | OWNER |
| delete_vehicle | p_id uuid, p_reason text | OWNER, MANAGER |
| fail_message | p_message_id uuid,p_error_code text,p_safe_message text,p_permanent boolean DEFAULT false | OWNER, MANAGER, STAFF |
| finish_mock_message | p_message_id uuid,p_provider_message_id text | OWNER, MANAGER, STAFF |
| get_acquisition_for_vehicle | p_vehicle_id uuid | OWNER, MANAGER |
| get_customer_history | p_phone text | OWNER, MANAGER, STAFF |
| get_identity_document | p_subject_type text, p_subject_id uuid | OWNER, MANAGER |
| get_knowledge_article | p_slug text | OWNER, MANAGER, STAFF |
| get_operation_result | p_operation text,p_request_id uuid | OWNER, MANAGER, STAFF |
| get_payment_receipt_request | p_request_id uuid | OWNER, MANAGER, STAFF |
| get_sale | p_id uuid | OWNER, MANAGER, STAFF |
| get_sale_communication | p_sale_id uuid | OWNER, MANAGER, STAFF |
| get_settings | không tham số | OWNER, MANAGER, STAFF |
| get_vehicle | p_id uuid | OWNER, MANAGER, STAFF |
| global_search | p_query text, p_limit integer DEFAULT 10 | OWNER, MANAGER, STAFF |
| import_vehicles | p_vehicles jsonb | OWNER, MANAGER, STAFF |
| list_acquisitions | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_active_announcements | không tham số | kiểm tra quyền riêng trong hàm |
| list_announcements | không tham số | OWNER |
| list_audit | p_filters jsonb default '{}' | OWNER |
| list_copilot_gaps | p_days integer DEFAULT 30 | OWNER |
| list_customer_communications | p_phone text | OWNER, MANAGER, STAFF |
| list_customers | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_expenses | p_filters jsonb default '{}' | OWNER, MANAGER |
| list_knowledge | không tham số | OWNER, MANAGER, STAFF |
| list_notifications | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_payment_receipts | p_sale_id uuid | OWNER, MANAGER, STAFF |
| list_profiles | không tham số | OWNER |
| list_receivables | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_sales | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_showroom_leads | p_filters jsonb DEFAULT '{}' | OWNER, MANAGER, STAFF |
| list_showroom_vehicles | p_filters jsonb DEFAULT '{}' | kiểm tra quyền riêng trong hàm |
| list_vehicles | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| log_copilot_gap | p_question text | OWNER, MANAGER, STAFF |
| mark_all_notifications_read | không tham số | OWNER, MANAGER, STAFF |
| mark_notifications_read | p_ids uuid[] | OWNER, MANAGER, STAFF |
| prepare_payment_receipt | p_data jsonb | OWNER, MANAGER, STAFF |
| register_identity_document_image | p_subject_type text, p_subject_id uuid, p_side text, p_storage_path text | OWNER, MANAGER |
| register_vehicle_image | p_vehicle_id uuid,p_storage_path text,p_display_order integer default 0 | OWNER, MANAGER, STAFF |
| reject_payment_receipt | p_id uuid,p_reason text | OWNER, MANAGER |
| remove_identity_document_image | p_subject_type text, p_subject_id uuid, p_side text | OWNER, MANAGER |
| remove_vehicle_image | p_id uuid | OWNER, MANAGER, STAFF |
| renew_message_lease | p_message_id uuid,p_lease_token uuid | kiểm tra quyền riêng trong hàm |
| report | p_kind text, p_filters jsonb DEFAULT '{}' | OWNER, MANAGER |
| require_password_change | p_user_id uuid, p_reset_pending boolean DEFAULT false | OWNER |
| resolve_login_email | p_identifier TEXT | kiểm tra quyền riêng trong hàm |
| resolve_message_delivery | p_message_id uuid,p_resolution text,p_evidence_reference text | OWNER, MANAGER |
| retry_sale_thank_you | p_sale_id uuid | OWNER, MANAGER |
| save_announcement | p_data jsonb | OWNER |
| save_expense | p_kind text,p_data jsonb,p_id uuid DEFAULT NULL | OWNER, MANAGER |
| save_identity_document | p_data jsonb | OWNER, MANAGER |
| save_settings | p_data jsonb | OWNER |
| save_vehicle | p_data jsonb,p_id uuid DEFAULT NULL | OWNER, MANAGER, STAFF |
| search_knowledge | p_query text, p_limit integer DEFAULT 8 | OWNER, MANAGER, STAFF |
| sell_vehicle | p_data jsonb | OWNER, MANAGER, STAFF |
| set_announcement_active | p_id uuid, p_active boolean | OWNER |
| skip_message | p_message_id uuid,p_error_code text,p_safe_message text | OWNER, MANAGER, STAFF |
| transfer_ownership | p_target_user uuid | OWNER |
| update_profile | p_id uuid, p_data jsonb | OWNER, MANAGER, STAFF |
| update_sale_due_date | p_sale_id uuid,p_due_date date | OWNER, MANAGER, STAFF |
| update_showroom_lead_status | p_id uuid, p_status text | OWNER, MANAGER, STAFF |
| validate_import_vehicles | p_vehicles jsonb | OWNER, MANAGER, STAFF |

## Màn hình ứng dụng và quyền mở

Trích từ cây route trong `src/App.tsx` (thành phần `Protected` kế thừa theo cây).

| Đường dẫn | Quyền mở |
| --- | --- |
| `/login` | công khai (không cần đăng nhập) |
| `/showroom` | công khai (không cần đăng nhập) |
| `/reset-password` | công khai (không cần đăng nhập) |
| `/change-password` | công khai (không cần đăng nhập) |
| `/` | đăng nhập |
| `/acquisitions` | đăng nhập |
| `/vehicles` | đăng nhập |
| `/vehicles/:id` | đăng nhập |
| `/sales` | đăng nhập |
| `/sales/:id` | đăng nhập |
| `/capture` | đăng nhập |
| `/assist` | đăng nhập |
| `/copilot` | đăng nhập |
| `/docs` | đăng nhập |
| `/docs/:slug` | đăng nhập |
| `/receivables` | đăng nhập |
| `/customers` | đăng nhập |
| `/settings` | đăng nhập |
| `/acquisitions/new` | STAFF trở lên (trong lịch làm việc) |
| `/intake` | STAFF trở lên (trong lịch làm việc) |
| `/vehicles/new` | STAFF trở lên (trong lịch làm việc) |
| `/vehicles/:id/edit` | STAFF trở lên (trong lịch làm việc) |
| `/vehicles/:id/sell` | STAFF trở lên (trong lịch làm việc) |
| `/sell` | STAFF trở lên (trong lịch làm việc) |
| `/expenses` | MANAGER hoặc OWNER |
| `/users` | MANAGER hoặc OWNER |
| `/audit` | chỉ OWNER |
| `/*` | công khai (không cần đăng nhập) |

## Edge Functions

| Function | Vai trò |
| --- | --- |
| ai-assist | No service-role/database credential exists in this function. Model output is either a draft for human review or a validated plan for explicit read RPCs. |
| manage-users | Secure administrative user management for Xe CRM. OWNER performs all account administration; MANAGER may only re-assign the |
| process-message | Provider-agnostic outbox worker. Phase 1 deliberately supports MOCK only. |
| reset-owner | Retired recovery endpoint. Recovery uses Supabase Auth or owner-authorized manage-users operations; this endpoint can no longer alter any account. |

## Bucket ảnh riêng tư

Khai báo `storage.buckets` trong migration; đường dẫn object luôn là `<uuid-chủ>/<uuid-ngẫu-nhiên>.<đuôi>` và trình duyệt chỉ xem qua signed URL ngắn hạn.

| Bucket | Chế độ | Giới hạn dung lượng | Định dạng |
| --- | --- | --- | --- |
| vehicle-images | riêng tư | 8 MB | image/jpeg,image/png,image/webp,image/avif |
| identity-documents | riêng tư | 8 MB | image/jpeg,image/png,image/webp,image/avif |
