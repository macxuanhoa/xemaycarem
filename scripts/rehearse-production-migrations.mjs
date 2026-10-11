// Read an integrity-checked production backup into disposable native PostgreSQL,
// apply only versions absent from its recorded ledger, and verify business money.
// No hosted connections or writes. Managed Auth/Storage restore is a separate gate.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase } from './db-harness.mjs'
import { BACKUP_DIR, SET_PREFIX, checkSetIntegrity, listSets, splitStatements } from './backup-lib.mjs'

const set = listSets().filter(item => item.manifest).at(-1)
assert.ok(set, 'A verified production backup is required')
assert.ok(checkSetIntegrity(set.manifest).ok, 'Backup checksums failed')
const prefix = join(BACKUP_DIR, `${SET_PREFIX}${set.stamp}`)
const ledger = JSON.parse(readFileSync(`${prefix}-migration-history.txt`, 'utf8'))
assert.ok(Array.isArray(ledger.migrations), 'Recorded migration ledger is required')
const applied = new Set(ledger.migrations.filter(row => row.remote).map(row => row.remote))
assert.ok(applied.size > 0, 'Empty production ledger was refused')
const local = readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()
assert.ok([...applied].every(version => local.some(name => name.startsWith(`${version}_`))), 'Remote-only history must be reconciled')
const pending = local.filter(name => !applied.has(name.slice(0, 14)))
assert.ok(pending.length, 'No pending migrations to rehearse')
const report = { backup: set.stamp, applied: applied.size, pending, managedPlatformRestoreProven: false, checks: [] }
const db = await createDatabase({ engine: 'postgres', applyMigrations: false })
const check = (name) => { report.checks.push(name); console.log(`PASS ${name}`) }

async function loadSchema(sql) {
  const skipped = new Set()
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await db.exec(sql); return [...skipped] }
    catch (error) {
      const pub = /publication "([A-Za-z0-9_]+)" does not exist/i.exec(error.message)?.[1]
      if (pub && !skipped.has(`publication:${pub}`)) {
        await db.exec(`CREATE PUBLICATION "${pub}"`)
        skipped.add(`publication:${pub}`)
        continue
      }
      const ext = /extension "([a-z0-9_]+)" is not available/i.exec(error.message)?.[1]
      assert.ok(ext && !['pgcrypto', 'uuid-ossp'].includes(ext) && !skipped.has(ext), 'Unsupported production schema dependency')
      const statement = new RegExp(`CREATE EXTENSION IF NOT EXISTS "${ext}"[^;]*;`, 'i')
      const schema = new RegExp(`CREATE EXTENSION IF NOT EXISTS "${ext}"[^;]*WITH SCHEMA "([a-z0-9_]+)"`, 'i').exec(sql)?.[1] ?? ext.replace(/^supabase_/, '')
      assert.ok(!new RegExp(`\\b${schema}\\.[a-z_]`, 'i').test(sql.replace(statement, '')), 'Platform extension is referenced by business schema')
      sql = sql.replace(statement, `-- unavailable unused platform extension ${ext}`)
      skipped.add(ext)
    }
  }
  throw new Error('Schema restore did not converge')
}

const MONEY = {
  vehicles: 'SELECT id,status,frame_number,license_plate FROM public.vehicles ORDER BY id',
  acquisitions: 'SELECT id,vehicle_id,purchase_price,acquisition_date FROM public.acquisitions ORDER BY id',
  sales: 'SELECT id,vehicle_id,status,sale_price,sale_date,customer_name,customer_phone FROM public.sales ORDER BY id',
  payments: 'SELECT * FROM public.payments ORDER BY id',
  vehicle_financials: 'SELECT * FROM public.vehicle_financials ORDER BY vehicle_id',
  sale_financials: 'SELECT * FROM public.sale_financials ORDER BY sale_id',
  vehicle_expenses: 'SELECT * FROM public.vehicle_expenses ORDER BY id',
  business_expenses: 'SELECT * FROM public.business_expenses ORDER BY id',
}
const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(MONEY).map(async ([name, sql]) => [name, (await db.query(sql)).rows])))
const schemaSnapshot = async () => (await db.query(`
  SELECT 'function:'||n.nspname||'.'||p.oid::regprocedure::text AS key, md5(pg_get_functiondef(p.oid)) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private')
  UNION ALL SELECT 'column:'||table_schema||'.'||table_name||'.'||column_name, md5(data_type||'|'||is_nullable||'|'||coalesce(column_default,''))
  FROM information_schema.columns WHERE table_schema IN ('public','private')
  UNION ALL SELECT 'policy:'||schemaname||'.'||tablename||'.'||policyname, md5(coalesce(qual,'')||'|'||coalesce(with_check,''))
  FROM pg_policies WHERE schemaname IN ('public','private') ORDER BY key
`)).rows

try {
  report.unavailablePlatformObjects = await loadSchema(readFileSync(`${prefix}-schema.sql`, 'utf8'))
  check('actual production public/private schema restored')
  for (const statement of splitStatements(readFileSync(`${prefix}-data.sql`, 'utf8'))) {
    // Those rows require the managed platform, not the small harness scaffold.
    if (/(?:^|[^A-Za-z0-9_])"?(?:auth|storage)"?\./.test(statement)) continue
    await db.exec(statement)
  }
  await db.exec(`SELECT set_config('search_path', '"$user", public', false)`)
  const before = await snapshot()
  report.businessRowCounts = Object.fromEntries(Object.entries(before).map(([name, rows]) => [name, rows.length]))
  check('actual production business data restored without platform simulation claims')
  for (const migration of pending) {
    const original = readFileSync(join('supabase/migrations', migration), 'utf8')
    // A single CREATE OR REPLACE is already an atomic PostgreSQL statement.
    // Wrap it only for fault injection; multi-statement migrations must carry
    // their own explicit transaction in the original source.
    const singleStatement = splitStatements(original).length === 1
    const sql = singleStatement ? `BEGIN;\n${original}\nCOMMIT;` : original
    assert.match(sql, /^\s*(?:--[^\n]*\n\s*)*BEGIN;/i, `${migration} must be atomic`)
    assert.match(sql.trim(), /COMMIT;$/i, `${migration} must end with COMMIT`)
    const injected = sql.replace(/COMMIT;\s*$/i, () => "DO $$ BEGIN RAISE EXCEPTION 'ISOLATED_RELEASE_ROLLBACK'; END $$;\nCOMMIT;")
    const beforeSchema = await schemaSnapshot()
    await assert.rejects(() => db.exec(injected), /ISOLATED_RELEASE_ROLLBACK/)
    await db.exec('ROLLBACK')
    assert.deepEqual(await schemaSnapshot(), beforeSchema, `${migration} failed rollback changed schema/security`)
    assert.deepEqual(await snapshot(), before, `${migration} failed rollback changed money/history`)
    await db.exec(sql)
    assert.deepEqual(await snapshot(), before, `${migration} changed business money/history`)
    check(`${migration}: actual populated apply and injected failure rollback`)
  }
  const config = (await db.query('SELECT mode,cinematic_enabled FROM public.seasonal_theme_config')).rows[0]
  assert.equal(config.mode, 'DEFAULT')
  assert.equal(config.cinematic_enabled, false)
  check('seasonal seed DEFAULT and cinematic disabled')
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity")).rows[0].n), 0)
  check('all public tables retain RLS')
  report.ok = true
  console.log(`PASS ${pending.length} pending migrations rehearsed on production business snapshot; hosted Auth/Storage remains unverified`)
} finally {
  writeFileSync('scratch/master-production-rehearsal.json', JSON.stringify(report, null, 2))
  await db.close()
}
