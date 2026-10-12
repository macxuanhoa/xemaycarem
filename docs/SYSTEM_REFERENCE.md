# Tham chiếu hệ thống (sinh tự động)

File này do `scripts/build-system-docs.mjs` sinh ra từ chính mã nguồn — **không sửa tay**, sửa script hoặc nguồn rồi chạy `npm run knowledge:system`. Nội dung luôn khớp migration mới nhất, routes trong `src/App.tsx`, thư mục `supabase/functions` và các statement tạo bucket.

## Danh sách chức năng database (RPC)

Toàn bộ hàm `public` mà ứng dụng gọi được, lấy từ định nghĩa cuối cùng trong `supabase/migrations`. Cột quyền là `private.require_role` khai báo trong thân hàm; "kiểm tra quyền riêng" nghĩa là hàm dùng cơ chế khác (so sánh vai trò trực tiếp, chủ tài khoản cuối cùng, v.v.).

| RPC | Tham số | Vai trò cần |
| --- | --- | --- |
| acquire_vehicle | p_data jsonb | OWNER, MANAGER, STAFF |
| add_payment | p_data jsonb | OWNER, MANAGER, STAFF |
| approve_brand_memory | p_id uuid, p_approve boolean | OWNER |
| cancel_acquisition | p_id uuid, p_reason text | OWNER, MANAGER |
| cancel_expense | p_kind text, p_id uuid, p_reason text | OWNER, MANAGER, STAFF |
| cancel_sale | p_id uuid,p_reason text | OWNER, MANAGER |
| cancel_sale_approval | p_approval_id uuid, p_reason text DEFAULT NULL | OWNER, MANAGER, STAFF |
| cancel_vietqr_payment_request | p_data jsonb | kiểm tra quyền riêng trong hàm |
| check_user_access | không tham số | kiểm tra quyền riêng trong hàm |
| check_user_can_hard_delete | p_user_id UUID | OWNER |
| check_vehicle_duplicates | p_data jsonb | OWNER, MANAGER, STAFF |
| claim_message | p_message_id uuid,p_provider_mode text | OWNER, MANAGER, STAFF |
| complete_password_change | không tham số | kiểm tra quyền riêng trong hàm |
| confirm_bank_transaction | p_data jsonb | kiểm tra quyền riêng trong hàm |
| confirm_vietqr_payment | p_data jsonb | kiểm tra quyền riêng trong hàm |
| create_showroom_lead | p_data jsonb | kiểm tra quyền riêng trong hàm |
| create_vietqr_payment_request | p_data jsonb | kiểm tra quyền riêng trong hàm |
| daily_reconciliation | p_date date DEFAULT NULL::date | OWNER, MANAGER |
| dashboard | p_from date DEFAULT (date_trunc('month'::text, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)))::date, p_to date DEFAULT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text))::date | OWNER, MANAGER, STAFF |
| delete_acquisition | p_id uuid, p_reason text | OWNER, MANAGER |
| delete_announcement | p_id uuid | OWNER |
| delete_identity_document_image | p_subject_type text, p_subject_id uuid, p_side text | OWNER, MANAGER |
| delete_sale_contact | p_id uuid | OWNER, MANAGER, STAFF |
| delete_vehicle | p_id uuid, p_reason text | OWNER, MANAGER |
| delete_vehicle_type | p_id uuid | OWNER |
| fail_message | p_message_id uuid,p_error_code text,p_safe_message text,p_permanent boolean,p_lease_token uuid | kiểm tra quyền riêng trong hàm |
| find_matching_vehicles | p_query text, p_limit integer DEFAULT 8 | OWNER, MANAGER, STAFF |
| finish_message | p_message_id uuid,p_provider_message_id text,p_lease_token uuid | kiểm tra quyền riêng trong hàm |
| finish_mock_message | p_message_id uuid,p_provider_message_id text | OWNER, MANAGER, STAFF |
| get_acquisition_for_vehicle | p_vehicle_id uuid | OWNER, MANAGER |
| get_active_vietqr_request | p_vehicle_id uuid,p_sale_id uuid DEFAULT NULL | kiểm tra quyền riêng trong hàm |
| get_bank_webhook_state | không tham số | OWNER |
| get_customer_history | p_phone text | OWNER, MANAGER, STAFF |
| get_identity_document | p_subject_type text, p_subject_id uuid | OWNER, MANAGER |
| get_knowledge_article | p_slug text | OWNER, MANAGER, STAFF |
| get_operation_result | p_operation text, p_request_id uuid | OWNER, MANAGER, STAFF |
| get_payment_receipt_request | p_request_id uuid | OWNER, MANAGER, STAFF |
| get_post_ai_usage | p_days integer DEFAULT 7 | OWNER |
| get_post_studio_context | p_vehicle_id uuid | OWNER, MANAGER, STAFF |
| get_sale | p_id uuid | OWNER, MANAGER, STAFF |
| get_sale_communication | p_sale_id uuid | OWNER, MANAGER, STAFF |
| get_seasonal_theme | không tham số | OWNER, MANAGER, STAFF |
| get_settings | không tham số | OWNER, MANAGER, STAFF |
| get_vehicle | p_id uuid | OWNER, MANAGER, STAFF |
| get_vietqr_matching_status | p_qr_request_id uuid | kiểm tra quyền riêng trong hàm |
| get_vietqr_payment_request | p_id uuid | kiểm tra quyền riêng trong hàm |
| global_search | p_query text, p_limit integer DEFAULT 10 | OWNER, MANAGER, STAFF |
| ignore_bank_transaction | p_data jsonb | kiểm tra quyền riêng trong hàm |
| import_vehicles | p_vehicles jsonb | OWNER, MANAGER, STAFF |
| ingest_bank_transaction | p_data jsonb | kiểm tra quyền riêng trong hàm |
| link_bank_transaction | p_data jsonb | kiểm tra quyền riêng trong hàm |
| list_acquisitions | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_active_announcements | không tham số | kiểm tra quyền riêng trong hàm |
| list_announcements | không tham số | OWNER |
| list_audit | p_filters jsonb default '{}' | OWNER |
| list_automation_contacts | p_limit integer DEFAULT 50 | OWNER |
| list_bank_transactions | p_filters jsonb DEFAULT '{}'::jsonb | kiểm tra quyền riêng trong hàm |
| list_brand_memory | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_client_issues | p_days integer DEFAULT 7 | OWNER |
| list_copilot_gaps | p_days integer DEFAULT 30 | OWNER |
| list_customer_communications | p_phone text | OWNER, MANAGER, STAFF |
| list_customers | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_expenses | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER |
| list_knowledge | không tham số | OWNER, MANAGER, STAFF |
| list_message_templates | không tham số | OWNER, MANAGER, STAFF |
| list_notifications | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_payment_receipts | p_sale_id uuid | OWNER, MANAGER, STAFF |
| list_pending_approvals | p_filters jsonb DEFAULT '{}'::jsonb | OWNER |
| list_post_draft_versions | p_draft_id uuid | OWNER, MANAGER, STAFF |
| list_post_drafts | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_profiles | không tham số | OWNER |
| list_receivables | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_sale_contacts | p_sale_id uuid | OWNER, MANAGER, STAFF |
| list_sale_thank_you_queue | p_sale_id uuid | OWNER, MANAGER, STAFF |
| list_sales | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| list_showroom_leads | p_filters jsonb DEFAULT '{}' | OWNER, MANAGER, STAFF |
| list_showroom_vehicles | p_filters jsonb DEFAULT '{}'::jsonb | kiểm tra quyền riêng trong hàm |
| list_vehicle_duplicate_reviews | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER |
| list_vehicle_types | không tham số | kiểm tra quyền riêng trong hàm |
| list_vehicles | p_filters jsonb DEFAULT '{}'::jsonb | OWNER, MANAGER, STAFF |
| log_copilot_gap | p_question text | OWNER, MANAGER, STAFF |
| log_post_ai_usage | p_task text, p_model text, p_input_tokens bigint DEFAULT 0, p_output_tokens bigint DEFAULT 0, p_outcome text DEFAULT 'OK' | OWNER, MANAGER, STAFF |
| lookup_identity_document_vehicles | p_id_number text | OWNER, MANAGER |
| lookup_vehicle_identifiers | p_license_plate text DEFAULT NULL, p_frame_number text DEFAULT NULL | OWNER, MANAGER, STAFF |
| mark_all_notifications_read | không tham số | OWNER, MANAGER, STAFF |
| mark_message_delivered | p_message_id uuid,p_provider_message_id text,p_lease_token uuid | kiểm tra quyền riêng trong hàm |
| mark_notifications_read | p_ids uuid[] | OWNER, MANAGER, STAFF |
| mark_personal_thank_you_sent | p_data jsonb | OWNER, MANAGER, STAFF |
| mark_thank_you_copied | p_sale_id uuid | OWNER, MANAGER, STAFF |
| prepare_payment_receipt | p_data jsonb | OWNER, MANAGER, STAFF |
| preview_message_template | p_data jsonb | OWNER, MANAGER, STAFF |
| register_identity_document_image | p_subject_type text, p_subject_id uuid, p_side text, p_storage_path text | OWNER, MANAGER |
| register_vehicle_image | p_vehicle_id uuid,p_storage_path text,p_display_order integer default 0 | OWNER, MANAGER, STAFF |
| reject_payment_receipt | p_id uuid,p_reason text | OWNER, MANAGER |
| remove_identity_document_image | p_subject_type text, p_subject_id uuid, p_side text | OWNER, MANAGER |
| remove_vehicle_image | p_id uuid | OWNER, MANAGER, STAFF |
| renew_message_lease | p_message_id uuid,p_lease_token uuid | kiểm tra quyền riêng trong hàm |
| replace_vietqr_payment_request | p_data jsonb | kiểm tra quyền riêng trong hàm |
| report | p_kind text, p_filters jsonb DEFAULT '{}' | OWNER, MANAGER |
| report_client_issue | p_data jsonb | OWNER, MANAGER, STAFF |
| request_delete_vehicle | p_id uuid, p_reason text | OWNER, MANAGER, STAFF |
| request_sale_below_cost | p_data jsonb | OWNER, MANAGER, STAFF |
| request_vehicle_duplicate_review | p_data jsonb | OWNER, MANAGER, STAFF |
| require_password_change | p_user_id uuid, p_reset_pending boolean DEFAULT false | OWNER |
| resolve_login_email | p_identifier TEXT | kiểm tra quyền riêng trong hàm |
| resolve_message_delivery | p_message_id uuid,p_resolution text,p_evidence_reference text | OWNER, MANAGER |
| resolve_sale_approval | p_approval_id uuid, p_action text, p_note text DEFAULT NULL, p_request_id uuid DEFAULT NULL | OWNER |
| resolve_vehicle_deletion | p_request_id uuid, p_action text, p_note text DEFAULT NULL | OWNER |
| resolve_vehicle_duplicate_review | p_approval_id uuid, p_action text, p_reason text DEFAULT NULL, p_request_id uuid DEFAULT NULL | OWNER, MANAGER |
| retry_sale_thank_you | p_sale_id uuid | OWNER, MANAGER |
| save_announcement | p_data jsonb | OWNER |
| save_brand_memory | p_data jsonb | OWNER, MANAGER, STAFF |
| save_expense | p_kind text, p_data jsonb, p_id uuid DEFAULT NULL | OWNER, MANAGER, STAFF |
| save_identity_document | p_data jsonb | OWNER, MANAGER |
| save_message_template | p_data jsonb | OWNER |
| save_post_draft | p_data jsonb | OWNER, MANAGER, STAFF |
| save_sale_contact | p_data jsonb | OWNER, MANAGER, STAFF |
| save_seasonal_theme | p_data jsonb | OWNER |
| save_settings | p_data jsonb | OWNER |
| save_vehicle | p_data jsonb,p_id uuid DEFAULT NULL | OWNER, MANAGER, STAFF |
| save_vehicle_type | p_id uuid, p_name text | OWNER |
| search_knowledge | p_query text, p_limit integer DEFAULT 8 | OWNER, MANAGER, STAFF |
| sell_vehicle | p_data jsonb | OWNER, MANAGER, STAFF |
| set_announcement_active | p_id uuid, p_active boolean | OWNER |
| set_post_draft_status | p_id uuid, p_status text, p_add_to_library boolean DEFAULT false | OWNER, MANAGER, STAFF |
| skip_message | p_message_id uuid,p_error_code text,p_safe_message text | OWNER, MANAGER, STAFF |
| transfer_ownership | p_target_user uuid | OWNER |
| update_profile | p_id uuid, p_data jsonb | OWNER, MANAGER, STAFF |
| update_sale_due_date | p_sale_id uuid,p_due_date date | OWNER, MANAGER, STAFF |
| update_showroom_lead_status | p_id uuid, p_status text | OWNER, MANAGER, STAFF |
| validate_import_vehicles | p_vehicles jsonb | OWNER, MANAGER, STAFF |
| verify_sale_contact | p_data jsonb | OWNER, MANAGER |

## Màn hình ứng dụng và quyền mở

Trích từ cây route trong `src/App.tsx` (thành phần `Protected` kế thừa theo cây).

| Đường dẫn | Quyền mở |
| --- | --- |
| `/login` | công khai (không cần đăng nhập) |
| `/showroom` | công khai (không cần đăng nhập) |
| `/loading-demo` | công khai (không cần đăng nhập) |
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
| `/bank-reconciliation` | MANAGER hoặc OWNER |
| `/users` | MANAGER hoặc OWNER |
| `/approvals` | MANAGER hoặc OWNER |
| `/duplicate-reviews` | MANAGER hoặc OWNER |
| `/audit` | chỉ OWNER |
| `/*` | công khai (không cần đăng nhập) |

## Edge Functions

| Function | Vai trò |
| --- | --- |
| ai-assist | No service-role/database credential exists in this function. Model output is either a draft for human review or a validated plan for explicit read RPCs. |
| bank-webhook | Inbound transfers are authenticated before database access. The response is identical for matched/unmatched/replayed outcomes and contains no financial data. |
| manage-users | Secure administrative user management for Xe CRM. OWNER performs all account administration; MANAGER may only re-assign the |
| post-ai | Cà Rem AI Sales Assistant (post-ai). GEMINI_API_KEY chỉ tồn tại trong Edge Function Secrets; hàm KHÔNG có service-role key: mọi dữ liệu xe, bộ nhớ thương |
| process-message | Provider-agnostic outbox worker. V1 supports MOCK/DISABLED; V2 registers the official adapters (ZALO_OA, FB_MESSENGER, SMS) which fail closed WITHOUT credentials. |
| reset-owner | Retired recovery endpoint. Recovery uses Supabase Auth or owner-authorized manage-users operations; this endpoint can no longer alter any account. |

## Bucket ảnh riêng tư

Khai báo `storage.buckets` trong migration; đường dẫn object luôn là `<uuid-chủ>/<uuid-ngẫu-nhiên>.<đuôi>` và trình duyệt chỉ xem qua signed URL ngắn hạn.

| Bucket | Chế độ | Giới hạn dung lượng | Định dạng |
| --- | --- | --- | --- |
| vehicle-images | riêng tư | 8 MB | image/jpeg,image/png,image/webp,image/avif |
| identity-documents | riêng tư | 8 MB | image/jpeg,image/png,image/webp,image/avif |
