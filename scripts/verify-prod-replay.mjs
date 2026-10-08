// Release-validation: replay the PENDING migrations (026-031) on top of the REAL live
// production schema baseline captured in backups/, then prove the result CONVERGES to the
// canonical final state produced by a clean 001->031 build. This is what validates that
// migration 031 reconciles the genuine production drift, not just a fresh reconstruction.
//
// It uses the public+private DDL-only dump (no PII rows) so no real personal data ever
// enters this disposable engine. Read-only with respect to production.
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from './db-harness.mjs'

const LIVE_DUMP = resolve('backups/carem-prod-20261002-live-schema.sql')
const PENDING = (name) => name >= '20261001002600' // 026..031

async function column(db, sql) {
  const res = await db.query(sql)
  return res.rows.map((row) => Object.values(row)[0])
}

async function pairs(db, sql) {
  const res = await db.query(sql)
  return res.rows
}

// Strip SQL line comments and collapse whitespace so a drift that is only comments or
// formatting is not mistaken for a logic change.
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim()
}

// Structural fingerprints for public+private only (the schemas that carry CRM business
// logic and that 031 reconciles). Storage/auth platform objects are identical by contract.
const FINGERPRINTS = {
  columns: `SELECT table_schema||'.'||table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'')
    FROM information_schema.columns WHERE table_schema IN ('public','private') ORDER BY 1`,
  policies: `SELECT schemaname||'.'||tablename||' '||policyname||' '||cmd::text||' roles:'||array_to_string(roles,',')||' qual:'||coalesce(qual::text,'')||' with:'||coalesce(with_check::text,'')
    FROM pg_policies WHERE schemaname IN ('public','private') ORDER BY 1`,
  constraints: `SELECT n.nspname||'.'||c.relname||' '||con.conname||' '||pg_get_constraintdef(con.oid)
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') ORDER BY 1`,
  indexes: `SELECT schemaname||'.'||tablename||' '||indexname||' '||indexdef FROM pg_indexes WHERE schemaname IN ('public','private') ORDER BY 1`,
  // Grant ACLs are stored as an ordered array, but the security meaning is the
  // grantee->privilege SET, not the physical order the GRANTs happened to land in.
  // A live-dump baseline and a clean build can therefore hold the identical grants
  // in a different element order. Sort the tokens so this compares semantics, not
  // insertion order, and only flags a genuine add/remove/change of a grantee.
  table_grants: `SELECT n.nspname||'.'||t.relname||' '||pg_catalog.pg_get_userbyid(t.relowner)||' '||coalesce((SELECT string_agg(acl, ';' ORDER BY acl) FROM unnest(t.relacl::text[]) AS acl),'')
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ('public','private') AND t.relkind='r' ORDER BY 1`,
  function_grants: `SELECT n.nspname||'.'||p.proname||'('||pg_get_function_arguments(p.oid)||') '||coalesce((SELECT string_agg(acl, ';' ORDER BY acl) FROM unnest(p.proacl::text[]) AS acl),'')
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') ORDER BY 1`,
}

function diff(label, a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  const onlyInProd = a.filter((x) => !setB.has(x))
  const onlyInFresh = b.filter((x) => !setA.has(x))
  const ok = onlyInProd.length === 0 && onlyInFresh.length === 0
  console.log(`${ok ? 'PASS' : 'DIFF'}  ${label}  (prod-baseline=${a.length}, fresh=${b.length}, prodOnly=${onlyInProd.length}, freshOnly=${onlyInFresh.length})`)
  for (const x of onlyInProd.slice(0, 12)) console.log(`    - only in [prod+026-031]: ${x}`)
  for (const x of onlyInFresh.slice(0, 12)) console.log(`    - only in [fresh 001-031]: ${x}`)
  return ok
}

const failures = []
console.log('Booting fresh canonical build (001->031)...')
const fresh = await createDatabase({ engine: 'postgres' })

console.log('Booting live production baseline + pending 026->031...')
const prod = await createDatabase({ engine: 'postgres', loadDump: LIVE_DUMP, migrationFilter: PENDING })

// Targeted invariants on the reconciled production baseline.
const knowledge = await column(prod, 'SELECT count(*)::int FROM public.knowledge_base')
console.log(`knowledge_base rows on reconciled prod baseline: ${knowledge[0]}`)
const identityBucket = await column(prod, "SELECT coalesce(bool_or(public)::text, 'NO-BUCKET') FROM storage.buckets WHERE id='identity-documents' OR name='identity-documents'")
console.log(`identity-documents bucket public flag: ${identityBucket[0]}`)

console.log('\n=== Convergence: [live prod schema + 026-031] vs [clean 001-031] (public+private) ===')
for (const [label, sql] of Object.entries(FINGERPRINTS)) {
  const a = await column(prod, sql)
  const b = await column(fresh, sql)
  if (!diff(label, a, b)) failures.push(label)
}

// Function-body drift needs nuance: two builds that both run the SAME 031 must already
// match for every function 031 rewrites. Any residual difference is therefore a function
// 031 does NOT touch, i.e. the live body vs the local migration body. Classify whether the
// gap is only comments/formatting (harmless) or genuine code (must reconcile before push).
const BODY_SQL = `SELECT n.nspname||'.'||p.proname||'('||pg_get_function_arguments(p.oid)||')' AS key, p.prosrc AS body
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private')`
const prodBodies = new Map((await pairs(prod, BODY_SQL)).map((r) => [r.key, r.body]))
const freshBodies = new Map((await pairs(fresh, BODY_SQL)).map((r) => [r.key, r.body]))
const allKeys = [...new Set([...prodBodies.keys(), ...freshBodies.keys()])].sort()
const codeDrift = []
const commentDrift = []
const report = []
for (const key of allKeys) {
  const p = prodBodies.get(key)
  const f = freshBodies.get(key)
  if (p === undefined || f === undefined) { codeDrift.push(key + ' [missing in one build]'); continue }
  if (p === f) continue
  if (stripComments(p) === stripComments(f)) { commentDrift.push(key); report.push(`### COMMENT/FORMAT-ONLY: ${key}\n(prod)\n${p}\n(fresh)\n${f}\n`) }
  else { codeDrift.push(key); report.push(`### CODE DRIFT: ${key}\n(prod)\n${p}\n(fresh)\n${f}\n`) }
}
console.log(`\nfunction bodies: ${allKeys.length} total, ${codeDrift.length} code-drift, ${commentDrift.length} comment/format-only, ${allKeys.length - codeDrift.length - commentDrift.length} identical`)
for (const k of codeDrift) console.log(`    CODE-DRIFT ${k}`)
if (codeDrift.length) failures.push('function-code-drift')
await writeFile(resolve('backups/function-drift.txt'), report.join('\n---\n\n'), 'utf8')
console.log('wrote full body diffs to backups/function-drift.txt')

await prod.close()
await fresh.close()

console.log('\n=== RESULT ===')
if (failures.length) {
  console.log(`FAIL: 031 did NOT fully reconcile production drift in: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('PASS: pending migrations 026-031 apply cleanly on the live production baseline and converge to the canonical final state.')
