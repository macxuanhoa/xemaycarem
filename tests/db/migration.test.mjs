/**
 * Requirement 17: Database Migration Test
 * Run all migrations against an isolated temporary PostgreSQL database.
 * Never use production database.
 * Confirm:
 * - migrations run from clean database
 * - constraints exist
 * - indexes exist
 * - functions exist
 * - policies exist
 * - expected tables exist
 */

import assert from 'node:assert/strict'
import { createDatabase } from '../../scripts/db-harness.mjs'

export async function runMigrationTests({ engine = 'postgres' } = {}) {
  console.log(`\n--- Starting Database Migration Verification (${engine}) ---`)
  const db = await createDatabase({ engine })

  try {
    // 1. Expected tables exist
    const expectedTables = [
      'profiles',
      'vehicles',
      'vehicle_types',
      'vehicle_financials',
      'vehicle_expenses',
      'sales',
      'sale_financials',
      'payments',
      'business_expenses',
      'vehicle_images',
      'audit_logs',
      'vehicle_activity',
      'system_settings',
      'knowledge_base',
    ]

    const tablesResult = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )
    const existingTables = new Set(tablesResult.rows.map((r) => r.table_name))
    for (const table of expectedTables) {
      assert.ok(existingTables.has(table), `Expected table '${table}' does not exist in public schema`)
    }
    console.log(`✓ All ${expectedTables.length} expected tables exist in public schema`)

    // 2. Row Level Security is enabled on ALL public tables
    const rlsResult = await db.query(
      `SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`
    )
    for (const row of rlsResult.rows) {
      if (expectedTables.includes(row.relname)) {
        assert.equal(row.relrowsecurity, true, `Table '${row.relname}' must have RLS enabled`)
      }
    }
    console.log(`✓ Row Level Security is explicitly ENABLED on all ${expectedTables.length} expected public tables`)

    // 3. Expected primary keys and foreign keys exist
    const pks = await db.query(`
      SELECT tc.table_name, ccu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
    `)
    const pkTables = new Set(pks.rows.map((r) => r.table_name))
    for (const table of expectedTables) {
      assert.ok(pkTables.has(table), `Table '${table}' must have a primary key`)
    }
    console.log(`✓ Primary keys exist on all expected tables`)

    // Foreign keys check
    const fks = await db.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `)
    const fkMap = new Map()
    for (const row of fks.rows) {
      fkMap.set(`${row.table_name}.${row.column_name}->${row.foreign_table_name}`, true)
    }

    assert.ok(fkMap.has('vehicles.created_by->profiles'), 'vehicles.created_by must reference profiles')
    assert.ok(fkMap.has('vehicle_financials.vehicle_id->vehicles'), 'vehicle_financials.vehicle_id must reference vehicles')
    assert.ok(fkMap.has('vehicle_expenses.vehicle_id->vehicles'), 'vehicle_expenses.vehicle_id must reference vehicles')
    assert.ok(fkMap.has('sales.vehicle_id->vehicles'), 'sales.vehicle_id must reference vehicles')
    assert.ok(fkMap.has('sale_financials.sale_id->sales'), 'sale_financials.sale_id must reference sales')
    assert.ok(fkMap.has('payments.sale_id->sales'), 'payments.sale_id must reference sales')
    console.log(`✓ Critical relational foreign key integrity constraints exist`)

    // 4. Unique constraints and partial indexes
    const uniqueIndexes = await db.query(`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    `)
    const indexDefs = new Map(uniqueIndexes.rows.map((r) => [r.indexname, r.indexdef]))

    assert.ok(indexDefs.has('one_completed_sale_per_vehicle'), 'Unique partial index one_completed_sale_per_vehicle must exist')
    assert.match(
      indexDefs.get('one_completed_sale_per_vehicle'),
      /WHERE \(status = 'COMPLETED'::(public\.)?sale_status\)/i,
      'one_completed_sale_per_vehicle must enforce one completed sale per vehicle'
    )

    // Expected performance indexes
    const expectedIndexes = [
      'vehicles_status_purchase',
      'vehicles_license_plate',
      'vehicles_frame_number',
      'vehicles_vehicle_type',
      'vehicle_types_name_norm',
      'vehicles_created_at',
      'vehicle_expenses_vehicle',
      'vehicle_expenses_date',
      'business_expenses_date',
      'sales_date',
      'sales_vehicle',
      'sales_customer_phone',
      'payments_sale',
      'vehicle_images_vehicle',
      'audit_entity',
      'audit_created',
      'activity_vehicle',
    ]
    for (const idx of expectedIndexes) {
      assert.ok(indexDefs.has(idx), `Expected index '${idx}' must exist in public schema`)
    }
    console.log(`✓ Unique constraints and all ${expectedIndexes.length} performance indexes exist`)

    // 4b. Purge guard: the six retired vehicle fields and the two retired quickpick
    // settings must stay gone for good, and the transactional history tables start
    // empty (migration 20261008000300).
    const purgedColumns = await db.query(`
      SELECT table_schema || '.' || table_name || '.' || column_name AS col
      FROM information_schema.columns
      WHERE (table_schema, table_name, column_name) IN (
        ('public','vehicles','brand'),('public','vehicles','model'),('public','vehicles','variant'),
        ('public','vehicles','engine_number'),('public','vehicles','odometer'),('public','vehicles','asking_price'),
        ('public','system_settings','quickpick_brands'),('public','system_settings','quickpick_models'))
    `)
    assert.deepEqual(purgedColumns.rows, [], 'Retired vehicle and quickpick columns must not exist any more')

    // Cặp migration nghỉ hưu CSKH (20261014000500 + 20261014001000) đang được giữ ở
    // supabase/deferred/ theo quyết định của Owner ngày 15/10, nên một DB dựng từ
    // supabase/migrations/ vẫn còn nguyên hệ thống nhắn tin. Guard dưới đây tự đảo
    // theo đúng thực tế trong DB: chưa nghỉ hưu thì chốt "còn nguyên một khối", đã
    // nghỉ hưu thì chốt "biến mất vĩnh viễn" — không bao giờ chấp nhận trạng thái lửng.
    // Đọc supabase/deferred/README.md trước khi chuyển cặp migration về lại.
    const cskhTables = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN
        ('message_outbox','customer_communications','customer_contacts','message_templates')
      ORDER BY table_name
    `)
    const cskhRetired = cskhTables.rows.length === 0
    const cskhColumns = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'system_settings' AND column_name IN
        ('thankyou_manual_enabled','customer_messaging_enabled','sale_thank_you_enabled',
         'primary_message_channel','fallback_channel')
    `)
    if (cskhRetired) {
      assert.deepEqual(cskhTables.rows, [], 'Retired messaging tables must stay dropped')
      assert.equal(cskhColumns.rows[0].n, 0, 'CSKH settings columns must be gone with the retired messaging tables')
    } else {
      assert.equal(cskhTables.rows.length, 4, 'The four CSKH tables must all exist while supabase/deferred/ is unapplied')
      assert.equal(cskhColumns.rows[0].n, 5, 'The five CSKH settings columns must all exist while supabase/deferred/ is unapplied')
    }
    const fkCount = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.table_constraints
      WHERE constraint_type='FOREIGN KEY' AND table_schema='public' AND table_name='vehicles'
        AND constraint_name='vehicles_vehicle_type_id_fkey'
    `)
    assert.equal(fkCount.rows[0].n, 1, 'vehicles.vehicle_type_id must reference vehicle_types')
    const historyCounts = await db.query(`
      SELECT (SELECT count(*) FROM public.audit_logs) + (SELECT count(*) FROM public.vehicle_activity)
        + (SELECT count(*) FROM public.notifications) AS leftover
    `)
    assert.equal(Number(historyCounts.rows[0].leftover), 0, 'Purged history tables must be empty after the migration chain')
    console.log(`✓ Retired columns are gone (${cskhRetired ? 'CSKH retirement applied' : 'CSKH retirement still deferred'}) and every purged history table is empty`)

    // 5. Expected public RPC functions exist and have fixed search_path
    const expectedPublicFunctions = [
      'save_vehicle',
      'save_expense',
      'cancel_expense',
      'sell_vehicle',
      'add_payment',
      'cancel_sale',
      'update_profile',
      'save_settings',
      'list_vehicles',
      'get_vehicle',
      'list_sales',
      'get_sale',
      'list_expenses',
      'list_profiles',
      'get_settings',
      'list_audit',
      'report',
      'dashboard',
      'register_vehicle_image',
      'remove_vehicle_image',
      'search_knowledge',
      'list_knowledge',
      'get_knowledge_article',
      'list_notifications',
      'mark_notifications_read',
      'mark_all_notifications_read',
      'list_vehicle_types',
      'save_vehicle_type',
      'delete_vehicle_type',
    ]

    const procResult = await db.query(`
      SELECT p.proname, p.prosecdef, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
    `)
    const procs = new Map(procResult.rows.map((r) => [r.proname, r]))

    for (const fn of expectedPublicFunctions) {
      assert.ok(procs.has(fn), `Expected RPC function 'public.${fn}' must exist`)
      const def = procs.get(fn)
      assert.equal(def.prosecdef, true, `RPC 'public.${fn}' must be SECURITY DEFINER`)
      assert.ok(
        def.proconfig?.some((cfg) => cfg === 'search_path=' || cfg.startsWith('search_path=')),
        `RPC 'public.${fn}' must enforce a fixed empty search_path for injection safety`
      )
    }
    console.log(`✓ All ${expectedPublicFunctions.length} public RPCs exist with SECURITY DEFINER and fixed search_path`)

    // 5b. The retired thank-you/messaging RPCs must stay gone once the retirement has
    // shipped, so a later CREATE OR REPLACE cannot silently resurrect the subsystem.
    // While the pair sits in supabase/deferred/ those RPCs are legitimately still live.
    const retiredPublicFunctions = [
      'get_sale_communication',
      'list_customer_communications',
      'retry_sale_thank_you',
      'claim_message',
      'finish_mock_message',
      'fail_message',
      'skip_message',
      'renew_message_lease',
      'finish_message',
      'mark_message_delivered',
      'resolve_message_delivery',
      'list_message_templates',
      'preview_message_template',
      'save_message_template',
      'list_sale_contacts',
      'list_automation_contacts',
      'save_sale_contact',
      'verify_sale_contact',
      'delete_sale_contact',
      'mark_thank_you_copied',
      'mark_personal_thank_you_sent',
      'list_sale_thank_you_queue',
    ]
    const resurrected = retiredPublicFunctions.filter((fn) => procs.has(fn))
    if (cskhRetired) {
      assert.deepEqual(resurrected, [], `Retired messaging RPCs must not exist any more: ${resurrected.join(', ')}`)
      console.log(`✓ All ${retiredPublicFunctions.length} retired messaging RPCs stay dropped`)
    } else {
      console.log(`- Nghỉ hưu CSKH còn hoãn ở supabase/deferred/: ${retiredPublicFunctions.length} RPC nhắn tin vẫn còn sống nên chưa chốt đã_drop`)
    }

    // 5c. plpgsql không kiểm tra tên bảng lúc tạo hàm, nên một EXISTS sót trỏ tới bảng đã
    // DROP chỉ nổ khi gọi — đúng lỗi đã làm check_user_can_hard_delete và sell_vehicle_impl
    // hỏng. Quét nguồn mọi hàm đang sống để bắt sớm ngay tại gate. Chỉ có nghĩa khi cặp
    // migration nghỉ hưu CSKH đã được áp: lúc còn hoãn ở supabase/deferred/ thì chưa có
    // đối tượng nào bị DROP nên mọi hàm nhắn tin đều còn tham chiếu hợp lệ.
    const retiredReferencePattern = [
      'message_outbox',
      'customer_communications',
      'customer_contacts',
      'message_templates',
      'customer_messaging_enabled',
      'sale_thank_you_enabled',
      'primary_message_channel',
      'fallback_channel',
      'thankyou_manual_enabled',
      'claim_message',
      'finish_mock_message',
      'fail_message',
      'skip_message',
      'renew_message_lease',
      'finish_message',
      'mark_message_delivered',
      'resolve_message_delivery',
      'list_message_templates',
      'preview_message_template',
      'save_message_template',
      'get_sale_communication',
      'list_customer_communications',
      'retry_sale_thank_you',
      'list_sale_contacts',
      'list_automation_contacts',
      'save_sale_contact',
      'verify_sale_contact',
      'delete_sale_contact',
      'mark_thank_you_copied',
      'mark_personal_thank_you_sent',
      'list_sale_thank_you_queue',
      'lock_message_lease',
      'lock_trusted_message_lease',
      'VERIFY_SALE_CONTACT',
      'SALE_THANK_YOU',
      'AUTO_MESSAGE',
    ].join('|')
    if (!cskhRetired) {
      console.log('- Nghỉ hưu CSKH còn hoãn ở supabase/deferred/: chưa có đối tượng nào bị DROP nên bỏ qua quét tham chiếu treo')
    } else {
      const danglingReferences = await db.query(
        `SELECT n.nspname || '.' || p.proname AS fn
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('public', 'private') AND p.prosrc ~ $1
           ORDER BY 1`,
        [retiredReferencePattern],
      )
      assert.deepEqual(
        danglingReferences.rows.map((r) => r.fn),
        [],
        `Live functions must not reference retired messaging objects: ${danglingReferences.rows.map((r) => r.fn).join(', ')}`,
      )
      console.log('✓ No surviving function body references the retired messaging subsystem')
    }

    // 6. Expected private helper functions exist
    const expectedPrivateFunctions = [
      'current_role',
      'is_active',
      'can_financials',
      'require_role',
      'today',
      'safe_money',
      'money_input',
      'audit',
      'immutable_history',
      'new_auth_user',
      'vehicle_json',
      'sale_json',
      'vehicle_display',
      'vehicle_label_text',
      'vehicle_subtitle_text',
      'vehicle_type_input',
      'vehicle_type_input_optional',
    ]
    const privateProcResult = await db.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'private'
    `)
    const privateProcs = new Set(privateProcResult.rows.map((r) => r.proname))
    for (const pfn of expectedPrivateFunctions) {
      assert.ok(privateProcs.has(pfn), `Expected private function 'private.${pfn}' must exist`)
    }
    console.log(`✓ All ${expectedPrivateFunctions.length} private helper functions exist`)

    // 7. Immutability triggers exist on audit_logs, vehicle_activity, sale_financials
    const triggersResult = await db.query(`
      SELECT event_object_table, trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public' AND trigger_name LIKE 'immutable_%'
    `)
    const triggerMap = new Set(triggersResult.rows.map((r) => `${r.event_object_table}.${r.trigger_name}`))
    assert.ok(triggerMap.has('audit_logs.immutable_audit'), 'immutable_audit trigger must exist on audit_logs')
    assert.ok(triggerMap.has('vehicle_activity.immutable_activity'), 'immutable_activity trigger must exist on vehicle_activity')
    assert.ok(triggerMap.has('sale_financials.immutable_sale_snapshot'), 'immutable_sale_snapshot trigger must exist on sale_financials')
    console.log(`✓ Immutable triggers verified on audit_logs, vehicle_activity, and sale_financials`)

    // 8. RLS Policies count
    const policiesResult = await db.query(`
      SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public'
    `)
    assert.ok(policiesResult.rows.length >= 12, 'Must have at least 12 RLS policies across public tables')
    console.log(`✓ ${policiesResult.rows.length} RLS policies verified across public tables`)

    console.log(`--- Migration verification completed successfully! ---\n`)
  } finally {
    await db.close()
  }
}

// Allow direct CLI invocation: node tests/db/migration.test.mjs
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/migration.test.mjs')) {
  const engine = process.argv.includes('--pglite') ? 'pglite' : 'postgres'
  await runMigrationTests({ engine })
}
