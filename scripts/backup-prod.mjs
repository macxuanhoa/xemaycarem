// Manual/scheduled production logical backup. Produces a complete dated set:
// schema dump, data dump, migration ledger, Storage inventory, and
// every Storage object BINARY (which pg_dump does not include), plus a manifest with
// SHA-256 fingerprints. Run before any production write, or let the daily Windows task
// run it. Requires the pinned Supabase CLI linked to production (supabase/.temp)
// and Docker running for `db dump`. Output goes to backups/ which is git-ignored —
// never commit or share these files, they contain real customer data and password hashes.
//
// Usage:
//   npm run backup:prod                 one dated set, nothing deleted
//   npm run backup:prod -- --prune      also apply the 7-day/4-week/12-month retention
//   CAREM_BACKUP_OFFSITE=D:\backup      mirror the new set to a second location (USB or
//                                       synced folder) — see --help for the opt-in file
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BACKUP_DIR, MIRROR_MARKER, SET_PREFIX, checkSetIntegrity, containedPath, dumpPublicCounts, listSets, offsiteTarget, parseQueryRows, planRetention, readHealth, sha256, writeFileSyncSafe, writeHealth } from './backup-lib.mjs'

const argv = process.argv.slice(2)
const FLAGS = { prune: argv.includes('--prune') || process.env.CAREM_BACKUP_PRUNE === 'on', help: argv.includes('--help') }
if (FLAGS.help) {
  console.log('backup-prod.mjs — takes one complete production backup set into backups/ (git-ignored).\n' +
    '  --prune   delete sets outside the 7 daily / 4 weekly / 12 monthly retention window\n' +
    '            (never touches a set without a manifest, never touches the newest four)\n' +
    '  env CAREM_BACKUP_OFFSITE=<folder>  copy the new set there too; create the file\n' +
    `            ${MIRROR_MARKER} inside that folder once to prove it is meant for backups.`)
  process.exit(0)
}

const LOG_FILE = join(BACKUP_DIR, 'backup.log')
function log(msg) {
  console.log(msg)
  appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
}

// Mirrors `supabase <args>` from the local project root; throws on any CLI failure.
// The CLI reports the real reason on stderr (a 400 from the API, a Docker socket miss),
// so an unattended run must carry it into the log instead of a bare exit code.
function supabase(...args) {
  try {
    const require = createRequire(import.meta.url)
    let packageFile
    try { packageFile = require.resolve('supabase/package.json') } catch { throw new Error('Pinned Supabase CLI missing; run npm ci in this workspace') }
    const packageInfo = JSON.parse(readFileSync(packageFile, 'utf8'))
    if (packageInfo.version !== '2.120.0') throw new Error('Supabase CLI version differs from the verified pin; run npm ci')
    const shim = join(dirname(packageFile), packageInfo.bin.supabase)
    // No shell: Storage paths are untrusted data and can contain shell punctuation.
    return execFileSync(process.execPath, [shim, ...args], { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    throw new Error(`supabase ${args.slice(0, 2).join(' ')} failed: ${detail}`)
  }
}

// Read-only SQL over the linked production database, parsed from CLI JSON output.
// SQL is passed through a temp file (not an argument) because shell word-splitting on
// Windows would otherwise break a multi-word SELECT into stray positional args.
const tmpSql = join('scratch', 'backup-query.sql')
mkdirSync(dirname(tmpSql), { recursive: true })
function query(sql) {
  writeFileSyncSafe(tmpSql, sql)
  const stdout = supabase('db', 'query', '--linked', '-o', 'json', '--file', tmpSql)
  // The CLI prints a "Rows returned" banner before the JSON payload on some versions.
  return parseQueryRows(stdout)
}

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const prefix = join(BACKUP_DIR, `${SET_PREFIX}${stamp}`)
const manifestPath = `${prefix}-MANIFEST.md`
const linkedRefFile = join('supabase', '.temp', 'project-ref')
const projectRef = existsSync(linkedRefFile) ? readFileSync(linkedRefFile, 'utf8').trim() : 'unknown'

try {
  mkdirSync(BACKUP_DIR, { recursive: true })
  log(`Backing up linked production project into ${SET_PREFIX}${stamp}-*`)

  supabase('db', 'dump', '--linked', '--file', `${prefix}-schema.sql`)
  log('schema dump done')
  supabase('db', 'dump', '--linked', '--data-only', '--file', `${prefix}-data.sql`)
  log('data dump done')
  writeFileSyncSafe(`${prefix}-migration-history.txt`, supabase('migration', 'list', '--linked'))
  log('migration ledger done')

  // pg_dump on storage.objects only stores metadata rows, never the file bytes, so every
  // object is downloaded separately to <prefix>-storage/<bucket>/<path> for restore.
  const objects = query('SELECT bucket_id, name, metadata, created_at, updated_at FROM storage.objects ORDER BY bucket_id, name')
  for (const { bucket_id: bucket, name } of objects) {
    const dest = containedPath(`${prefix}-storage`, `${bucket}/${name}`)
    mkdirSync(dirname(dest), { recursive: true })
    // The CLI needs --experimental for the storage subcommands and the ss:/// URL form.
    // The current CLI parses the colon in C:/... as a remote URL scheme. Validate
    // the absolute destination, then pass a relative local path on Windows.
    supabase('storage', 'cp', `ss:///${bucket}/${name}`, relative('.', dest).split(sep).join('/'), '--experimental')
    log('storage object downloaded')
  }
  // Empty private buckets still matter for restore documentation; record the full list.
  const buckets = query('SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY id')
  const empty = buckets.filter((b) => !objects.some((o) => o.bucket_id === b.id))
  if (empty.length) log(`buckets with no object to download: ${empty.map((b) => b.id).join(', ')}`)
  writeFileSyncSafe(`${prefix}-storage-inventory.json`, JSON.stringify({ version: 1, capturedAt: now.toISOString(), buckets,
    objects: objects.map((o) => {
      const file = containedPath(`${prefix}-storage`, `${o.bucket_id}/${o.name}`)
      return { ...o, bytes: statSync(file).size, sha256: sha256(file) }
    }),
  }, null, 2) + '\n')

  // Business tables may be legitimately empty; counts make the manifest self-auditing.
  // Row counts derive from the data dump's snapshot, so transactions entered while
  // the later Storage download runs cannot cause a false reconciliation mismatch.
  const BUSINESS_TABLES = ['vehicles', 'acquisitions', 'sales', 'payments', 'sale_financials', 'vehicle_expenses', 'vehicle_activity', 'vehicle_images', 'audit_logs', 'profiles', 'system_settings', 'knowledge_base', 'identity_documents', 'showroom_leads', 'message_events']
  const present = new Set(query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`).map((r) => r.table_name))
  const missing = BUSINESS_TABLES.filter((t) => !present.has(t))
  const wanted = BUSINESS_TABLES.filter((t) => present.has(t))
  const capturedCounts = dumpPublicCounts(readFileSync(`${prefix}-data.sql`, 'utf8'))
  const counts = wanted.map((t) => `${t}=${capturedCounts[t] ?? 0}`).join(', ') + (missing.length ? ` | MISSING_TABLES=${missing.join(',')}` : '')
  const authUsers = query('SELECT count(*)::int AS c FROM auth.users')[0].c

  // Collect every file this run produced (basename carem-prod-<stamp>*), hash it, and
  // write the manifest. Walks the backups/ tree so Storage subdirectories are included.
  const collected = []
  ;(function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else {
        const rel = relative(BACKUP_DIR, full).split(sep).join('/')
        if (rel.startsWith(SET_PREFIX + stamp)) collected.push({ path: rel, size: statSync(full).size, sha: sha256(full) })
      }
    }
  })(BACKUP_DIR)
  collected.sort((a, b) => a.path.localeCompare(b.path))
  writeFileSyncSafe(manifestPath, `# PRODUCTION LOGICAL BACKUP ${stamp} (created by scripts/backup-prod.mjs)

Project: ${projectRef} (linked production). Plan/PITR entitlements must be checked in Supabase Dashboard.
Method: supabase db dump --linked (schema + --data-only), migration list --linked,
supabase storage cp ss:/// for every Storage object binary, read-only row counts.
No password or secret value was printed or stored by this process.
SENSITIVE: data.sql contains auth.users encrypted_password hashes - never commit or share.

## Row counts at capture (business counts derive from data.sql snapshot)
auth.users=${authUsers} | ${counts}
storage.objects=${objects.length} across buckets: ${buckets.map((b) => `${b.id}(${b.public ? 'public' : 'private'})`).join(', ')}

## Files (git-ignored; full SHA-256)
${collected.map((f) => `${f.path} | ${f.size} bytes | sha256:${f.sha}`).join('\n') || 'NONE (dump produced no files - INVESTIGATE)'}

## Restore order
1. schema.sql  2. data.sql  3. re-upload every storage object: ${SET_PREFIX}${stamp}-storage/<bucket>/<path>
   via supabase storage cp <local> ss:///<bucket>/<path> --experimental
4. confirm storage policies per docs/OPERATIONS.md, then run npm run backup:verify on this set first.
`)
  log(`manifest written: ${collected.length} files hashed, ${objects.length} storage object(s)`)
  const integrity = checkSetIntegrity(manifestPath)
  if (!integrity.ok) throw new Error(`backup integrity failed: ${integrity.failures.slice(0, 3).join('; ')}`)

  const setResult = {
    stamp, at: now.toISOString(), files: collected.length,
    bytes: collected.reduce((n, f) => n + f.size, 0),
    storageObjects: objects.length, authUsers, missingTables: missing,
  }
  // Publish this set before copying health; the previous ordering mirrored yesterday's
  // LATEST.json even when today's files had copied successfully.
  writeHealth({ lastBackup: setResult, lastBackupStatus: 'ok', mirrored: null, consecutiveBackupFailures: 0, lastIntegrity: { stamp, at: new Date().toISOString(), ok: true, fullHashes: true } })
  const mirrored = mirrorToOffsite(setResult, log)
  if (FLAGS.prune) pruneOldSets(stamp, log)

  writeHealth({ lastBackup: setResult, lastBackupStatus: 'ok', mirrored, consecutiveBackupFailures: 0 })
  log(`DONE ${stamp} - ${setResult.bytes} bytes, ${setResult.files} files${mirrored ? `, mirrored to ${mirrored}` : ' (no second copy configured)'}`)
  log('Next: npm run backup:verify proves this set can actually be restored.')
} catch (error) {
  const failed = { stamp, at: new Date().toISOString(), error: String(error?.message || error).split('\n')[0].slice(0, 300) }
  writeHealth({ lastBackupFailure: failed, lastBackupStatus: 'failed', consecutiveBackupFailures: (readHealth()?.consecutiveBackupFailures ?? 0) + 1 })
  log(`FAILED ${stamp}: ${failed.error}`)
  process.exitCode = 1
}

// The second copy is additive on purpose: nothing here ever deletes from the mirror, so the
// offsite set only grows. At shop volume that stays far inside a free 15 GB Drive quota.
function mirrorToOffsite(setResult, logFn) {
  const target = offsiteTarget()
  if (!target) { logFn('no second copy configured (backups/offsite.txt is empty) - see docs/OPERATIONS.md'); return null }
  const fail = (reason) => {
    writeHealth({ lastMirror: { stamp: setResult.stamp, at: new Date().toISOString(), ok: false, reason } })
    process.exitCode = 1
    logFn(`second copy FAILED: ${reason}`)
    return null
  }
  const workspaceRel = relative(resolve('.'), resolve(target))
  if (!isAbsolute(target) || (!workspaceRel.startsWith(`..${sep}`) && workspaceRel !== '..' && !isAbsolute(workspaceRel))) return fail('mirror target must be an absolute folder outside this repository')
  if (!existsSync(target)) return fail('configured folder is not reachable (Drive not synced / drive not plugged in)')
  const actualRel = relative(realpathSync('.'), realpathSync(target))
  if (!actualRel.startsWith(`..${sep}`) && actualRel !== '..' && !isAbsolute(actualRel)) return fail('mirror folder resolves inside this repository')
  if (!existsSync(join(target, MIRROR_MARKER))) {
    return fail(`configured folder has no ${MIRROR_MARKER} opt-in file`)
  }
  const setDir = containedPath(target, `${SET_PREFIX}${setResult.stamp}`)
  mkdirSync(setDir, { recursive: true })
  for (const entry of readdirSync(BACKUP_DIR)) {
    if (!entry.startsWith(SET_PREFIX + setResult.stamp)) continue
    cpSync(join(BACKUP_DIR, entry), join(setDir, entry), { recursive: true })
  }
  const integrity = checkSetIntegrity(join(setDir, `${SET_PREFIX}${setResult.stamp}-MANIFEST.md`), setDir)
  const ok = integrity.ok
  if (ok) {
    // Copy only after verifying every mirrored byte, and record the actual mirror result.
    writeHealth({ mirrored: target, lastMirror: { stamp: setResult.stamp, at: new Date().toISOString(), ok: true } })
    cpSync(join(BACKUP_DIR, 'LATEST.json'), join(target, 'LATEST.json'))
  } else return fail('mirrored payload failed checksum verification')
  logFn(`second copy ${ok ? 'written' : 'FAILED to write manifest'} -> ${setDir}`)
  return ok ? target : null
}

// Retention deletes real files, so it only runs when explicitly asked and the plan itself
// refuses to touch incomplete sets or anything inside the guard floor.
function pruneOldSets(currentStamp, log) {
  const sets = listSets().filter((s) => s.stamp !== currentStamp)
  const { prune, blockedByFloor } = planRetention(sets)
  if (blockedByFloor?.length) log(`retention: guard floor active (only ${sets.length} sets) - nothing deleted`)
  if (!prune.length) { log('retention: nothing outside the 7d/4w/12m window'); return }
  const trail = join(BACKUP_DIR, 'retention.log')
  for (const s of prune) {
    for (const file of s.files) rmSync(file, { force: true })
    if (s.storageDir) rmSync(s.storageDir, { recursive: true, force: true })
    const line = `${new Date().toISOString()} pruned ${s.stamp} (${s.files.length} files, ${s.bytes} bytes)`
    appendFileSync(trail, line + '\n')
    log(`retention: ${line}`)
  }
  // Pruning leaves empty storage directories behind; remove only directories just emptied.
  for (const entry of readdirSync(BACKUP_DIR)) {
    const full = join(BACKUP_DIR, entry)
    if (statSync(full).isDirectory() && entry.startsWith(SET_PREFIX) && readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true })
  }
}
