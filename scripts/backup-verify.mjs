// Restore drill for the production backup sets. A dump nobody has ever restored is a
// rumour, not a backup, so this proves three things without touching production:
//   1. every file in the set still matches the SHA-256 recorded in its manifest
//   2. schema.sql replays into a disposable PostgreSQL and the business rows in data.sql
//      replay on top of it, with row counts reconciled against the manifest
//   3. the Storage object binaries are actually on disk and are real image bytes
// Rows for the managed `auth`/`storage` schemas are expected to fail against the local
// stub (the stub carries a deliberately small auth.users column list) — those are counted
// as PLATFORM_ROWS and never fail the drill, but the same line reminds the operator that a
// real restore needs a Supabase-managed Auth backup, not this replay.
// Usage: npm run backup:verify
//        node scripts/backup-verify.mjs --integrity-only (daily file checks)
//        node scripts/backup-verify.mjs --if-due (weekly local replay)
//        npm run backup:verify -- --set 2026-10-03-124513 | -- --list
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase } from './db-harness.mjs'
import sharp from 'sharp'
import { BACKUP_DIR, SET_PREFIX, checkSetIntegrity, containedPath, listSets, needsRestoreDrill, readHealth, readManifestCounts, sha256, splitStatements, writeFileSyncSafe, writeHealth } from './backup-lib.mjs'

const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] }
const sets = listSets()

if (argv.includes('--list')) {
  for (const s of sets) console.log(`${s.stamp}  ${s.manifest ? 'manifest' : 'NO MANIFEST'}  ${s.files.length} files  ${(s.bytes / 1024).toFixed(0)} KiB  storage:${s.storageDir ? 'yes' : 'no'}`)
  process.exit(0)
}
if (argv.includes('--if-due') && !needsRestoreDrill(readHealth())) {
  console.log('PASS  weekly local restore drill is current; no replay needed today')
  process.exit(0)
}

const wanted = argOf('--set')
// Drill the newest COMPLETE set: a set still being written by an interrupted or in-flight
// run has no manifest yet, and pretending it is a restore point would be worse than none.
const completeSets = sets.filter((s) => s.manifest)
const dangling = sets.filter((s) => !s.manifest && s.stamp !== completeSets.at(-1)?.stamp)
const set = wanted ? sets.find((s) => s.stamp === wanted) : completeSets.at(-1)
if (!set) { console.log('FAIL  no complete backup set (with MANIFEST.md) exists in backups/'); process.exit(1) }
for (const s of dangling) console.log(`NOTE  ${s.stamp} is an incomplete run (${s.files.length} files, no manifest) - not treated as a restore point`)

console.log(`Restore drill for ${set.stamp} (${set.files.length} files, ${(set.bytes / 1024).toFixed(0)} KiB)`)
const integrityOnly = argv.includes('--integrity-only')
const report = { stamp: set.stamp, scope: integrityOnly ? 'files-and-storage' : 'local-business-replay', platformRestoreProven: false, startedAt: new Date().toISOString(), checks: [], ok: true }
const record = (name, ok, detail = '') => {
  report.checks.push({ name, ok, detail })
  if (!ok) report.ok = false
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Anything touching the managed auth/storage schemas is platform data, not business data.
const isPlatformStmt = (stmt) => /(?:^|[^A-Za-z0-9_])"?(?:auth|storage)"?\./.test(stmt)

// Platform extensions Supabase installs but a local PostgreSQL does not ship (vault,
// pg_stat_statements). The dump creates them, so replaying it verbatim aborts on the first
// one. Each is skipped ONLY after proving nothing in the dump references its own schema, so
// a genuine dependency can never be papered over.
const CORE_EXTENSIONS = new Set(['pgcrypto', 'uuid-ossp']) // migrations/RPC actually use these
// Schema mà extension THẬT SỰ tạo đối tượng trong đó. Supabase cài pg_cron/pg_net với
// "WITH SCHEMA pg_catalog", nhưng đối tượng của chúng lại nằm trong schema cron/net.
// Dùng thẳng pg_catalog để dò tham chiếu là sai: pg_catalog là schema lõi, dump nào cũng
// tham chiếu (pg_catalog.now(), pg_catalog.hashtextextended…), nên công cụ luôn kết luận
// "không an toàn để bỏ qua" và làm hỏng bước chạy thử khôi phục từ 17/10.
const PLATFORM_OBJECT_SCHEMAS = { pg_cron: 'cron', pg_net: 'net', supabase_vault: 'vault', pgmq: 'pgmq' }
const CORE_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'public'])
async function loadSchemaResilient(database, sqlIn) {
  let sql = sqlIn
  const skipped = []
  const created = []
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await database.exec(sql)
      return { skipped, created, sql }
    } catch (error) {
      const message = String(error?.message || error)
      // Supabase owns the realtime publication on the hosted platform; a local engine has
      // no idea about it, so create the empty publication the dump expects to alter.
      const pub = /publication "([A-Za-z0-9_]+)" does not exist/i.exec(message)?.[1]
      if (pub && !created.includes(pub)) {
        await database.exec(`CREATE PUBLICATION "${pub}"`)
        created.push(pub)
        continue
      }
      const ext = /extension "([a-z0-9_]+)" is not available/i.exec(message)?.[1]
      if (!ext || CORE_EXTENSIONS.has(ext) || skipped.includes(ext)) throw error
      const declared = new RegExp(`CREATE EXTENSION IF NOT EXISTS "${ext}"[^;]*WITH SCHEMA "([a-z0-9_]+)"`, 'i').exec(sql)?.[1]
      const schema = PLATFORM_OBJECT_SCHEMAS[ext]
        ?? (CORE_SCHEMAS.has(declared ?? '') ? ext.replace(/^supabase_/, '').replace(/^pg_/, '') : declared)
        ?? ext.replace(/^supabase_/, '')
      if (new RegExp(`\\b${schema}\\.[a-z_]`, 'i').test(sql.replace(new RegExp(`CREATE EXTENSION IF NOT EXISTS "${ext}"[^;]*;`, 'i'), ''))) {
        throw new Error(`extension ${ext} is unavailable but the dump still references ${schema}.* objects - not safe to skip`)
      }
      skipped.push(`${ext} (schema ${schema})`)
      sql = sql.replace(new RegExp(`CREATE EXTENSION IF NOT EXISTS "${ext}"[^;]*;`, 'i'), `-- SKIPPED PLATFORM EXTENSION ${ext}`)
    }
  }
  throw new Error('schema load did not converge after repeated platform-object repairs')
}

// --------------------------------------------------------------- 1. file integrity
const integrity = checkSetIntegrity(set.manifest)
record('manifest checksums verified on disk', integrity.ok, integrity.ok ? `${integrity.files} files (${integrity.fullHashes ? 'full SHA-256' : 'legacy 16-hex hashes'})` : integrity.failures.slice(0, 5).join('; '))

// ------------------------------------------------------------- 2. schema + data replay
const base = join(BACKUP_DIR, `${SET_PREFIX}${set.stamp}`)
for (const name of ['schema.sql', 'data.sql', 'migration-history.txt']) record(`required ${name} exists`, existsSync(`${base}-${name}`), '')
if (report.ok) {
  const expectedObjects = Number(/storage\.objects=(\d+)/.exec(readFileSync(set.manifest, 'utf8'))?.[1] ?? 0)
  const files = set.storageDir ? collectFiles(set.storageDir) : []
  const bad = []
  if (files.length !== expectedObjects) bad.push(`object count ${files.length} != ${expectedObjects}`)
  for (const file of files) {
    try {
      if (statSync(file).size === 0) throw new Error('empty file')
      // Decode the complete compressed image, not just its first four bytes. A JPEG
      // with its tail missing used to pass the "real image bytes" signature check.
      await sharp(file, { failOn: 'warning', limitInputPixels: 100000000 }).raw().toBuffer()
    } catch { bad.push('Storage image cannot be fully decoded') }
  }
  const inventoryFile = `${base}-storage-inventory.json`
  if (existsSync(inventoryFile)) {
    try {
      const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'))
      if (!Array.isArray(inventory.objects) || inventory.objects.length !== expectedObjects) throw new Error('inventory object count mismatch')
      const seen = new Set()
      for (const object of inventory.objects) {
        const path = `${object.bucket_id}/${object.name}`
        if (seen.has(path)) throw new Error('duplicate inventory object')
        seen.add(path)
        const file = containedPath(`${base}-storage`, path)
        if (statSync(file).size !== object.bytes || sha256(file) !== object.sha256) throw new Error('inventory checksum mismatch')
      }
      record('Storage inventory agrees with every object', true, `${inventory.objects.length} objects; bucket visibility/settings saved`)
    } catch { bad.push('Storage inventory is invalid or disagrees with downloaded objects') }
  }
  record('Storage binaries complete and decoded', bad.length === 0, bad.length ? bad.slice(0, 5).join('; ') : `${files.length} images decoded`)
}
let db = null
try {
  if (!report.ok || integrityOnly) throw { skipReplay: true }
  db = await createDatabase({ engine: 'postgres', applyMigrations: false })
  // Same search_path repair the harness applies after a pg_dump, because the dump ends with
  // set_config('search_path','') and this engine reuses one session.
  const { skipped } = await loadSchemaResilient(db, readFileSync(`${base}-schema.sql`, 'utf8'))
  await db.exec(`SELECT set_config('search_path', '"$user", public', false)`)
  record('schema.sql replays into disposable PostgreSQL', true,
    `public + private DDL accepted${skipped.length ? ` (platform extensions not present locally: ${skipped.join(', ')})` : ''}`)

  const statements = splitStatements(readFileSync(`${base}-data.sql`, 'utf8'))
  console.log(`      ${statements.length} statements parsed from data.sql`)
  const business = { ran: 0, failed: [] }
  const platform = { ran: 0, failed: 0 }
  let inTx = false
  let seen = 0
  for (const stmt of statements) {
    // Unattended runs write to a log, so a heartbeat makes a stall obvious.
    if (++seen % 200 === 0) console.log(`      replayed ${seen}/${statements.length} ...`)
    if (/^\s*(BEGIN|COMMIT)\b/i.test(stmt)) inTx = /^\s*BEGIN/i.test(stmt)
    try {
      await db.exec(stmt)
      if (isPlatformStmt(stmt)) platform.ran++
      else if (/^INSERT\b/i.test(stmt)) business.ran++
    } catch (error) {
      const msg = String(error?.message || error).split('\n')[0].slice(0, 180)
      // An aborted transaction would cascade every later statement into a phantom failure.
      if (inTx) await db.exec('ROLLBACK').catch(() => {})
      if (isPlatformStmt(stmt)) platform.failed++
      else business.failed.push({ stmt: stmt.slice(0, 80), msg })
    }
  }
  record('business data rows replay (public + private)', business.failed.length === 0,
    `${business.ran} INSERTs replayed${business.failed.length ? `; FIRST FAILURE: ${business.failed[0].stmt} -> ${business.failed[0].msg}` : ''}`)
  console.log(`      PLATFORM_ROWS: auth/storage statements ${platform.ran} ok / ${platform.ran + platform.failed} seen — replayed against the local stub only; a real restore must use Supabase-managed Auth backup (docs/OPERATIONS.md).`)

  // ---------------------------------------- 3. reconcile restored counts against manifest
  const manifestText = readFileSync(set.manifest, 'utf8')
  const counts = readManifestCounts(set.manifest)
  const present = new Set((await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map((r) => r.table_name))
  const mismatched = []
  let reconciled = 0
  for (const [table, expected] of Object.entries(counts)) {
    if (table.includes('.')) continue // auth.* is platform data, reported separately
    if (!present.has(table)) { mismatched.push(`${table} absent from the restored schema`); continue }
    const actual = Number((await db.query(`SELECT count(*)::int AS c FROM public."${table}"`)).rows[0].c)
    reconciled++
    if (actual !== expected) mismatched.push(`${table} restored ${actual} != manifest ${expected}`)
  }
  const pass = mismatched.length === 0 && reconciled > 0
  record('restored row counts match manifest', pass,
    mismatched.length ? mismatched.slice(0, 5).join('; ')
      : reconciled === 0 ? 'manifest carries no parseable `table=N` counts (old manifest format) - cannot reconcile'
        : `${reconciled} tables reconciled`)
  const authExpected = Number(/auth\.users=(\d+)/.exec(manifestText)?.[1] ?? 0)
  console.log(`      auth.users recorded in manifest: ${authExpected}`)

  // ------------------------------------------ 4. security posture of the restored schema
  const noRls = (await db.query(`SELECT c.relname AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false`)).rows.map((r) => r.n)
  record('every public table has RLS enabled', noRls.length === 0, noRls.length ? `missing: ${noRls.join(', ')}` : 'ok')
  const fnCount = Number((await db.query(`SELECT count(*)::int AS c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private')`)).rows[0].c)
  console.log(`      functions restored: ${fnCount}`)

} catch (error) {
  if (!error?.skipReplay) record('restore drill completed', false, String(error?.message || error).split('\n')[0].slice(0, 300))
} finally {
  if (db) await db.close().catch(() => {})
}

report.finishedAt = new Date().toISOString()
report.durationMs = new Date(report.finishedAt) - new Date(report.startedAt)
report.failedChecks = report.checks.filter((c) => !c.ok).map((c) => c.name)
writeFileSyncSafe(join(BACKUP_DIR, `${integrityOnly ? 'integrity' : 'verify'}-${set.stamp}.json`), JSON.stringify(report, null, 2) + '\n')
const result = { stamp: set.stamp, ok: report.ok, at: report.finishedAt, failed: report.failedChecks, scope: report.scope, platformRestoreProven: false }
writeHealth(integrityOnly ? { lastIntegrity: result } : { lastVerify: result, lastIntegrity: { ...result, ok: integrity.ok, scope: 'files-and-storage' } })
console.log(`\n=== ${report.ok ? (integrityOnly ? 'FILE AND IMAGE INTEGRITY VERIFIED' : 'LOCAL BUSINESS RESTORE VERIFIED') : 'BACKUP NOT PROVEN'} — ${set.stamp} (${Math.round(report.durationMs / 1000)}s) ===`)
if (!integrityOnly) console.log('Hosted Auth/Storage login, grants and uploaded image access still require a separate Supabase staging drill; this local replay does not prove them.')
if (!report.ok) console.log('Do not rely on this set until every FAIL line above is fixed: take a fresh backup and drill again.')
process.exitCode = report.ok ? 0 : 1

// ------------------------------------------------------------------------ helpers
// splitStatements lives in backup-lib.mjs so it can be imported without running a drill.

function collectFiles(dir) {
  const out = []
  ;(function walk(d) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(full)
    }
  })(dir)
  return out
}
