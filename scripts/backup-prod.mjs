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

  // ── Bộ dựng lại hệ thống từ đầu (rebuild kit) ────────────────────────────────
  // schema + data + ảnh là CHƯA ĐỦ để "mở web mới mà khách không thấy mất dữ liệu".
  // Một project Supabase trắng còn cần: đúng MỘT hàng system_settings (số tài khoản
  // nhận tiền, cờ webhook, giờ làm việc), danh sách extension, publication Realtime,
  // lịch pg_cron, function đã deploy kèm verify_jwt, và TÊN các biến môi trường bí mật
  // (không bao giờ là giá trị). Thiếu một trong đó là dựng lại xong mà web vẫn liệt.
  const safeQuery = (sql, label) => {
    try { return { read: true, rows: query(sql) } }
    catch (error) {
      log(`rebuild kit: ${label} not readable - ${String(error?.message ?? error).split('\n')[0].slice(0, 140)}`)
      return { read: false, rows: [] }
    }
  }
  const safeCli = (...args) => {
    try { return { read: true, text: supabase(...args) } }
    catch (error) {
      log(`rebuild kit: \`supabase ${args.join(' ')}\` not readable - ${String(error?.message ?? error).split('\n')[0].slice(0, 140)}`)
      return { read: false, text: '' }
    }
  }
  const functionsList = safeCli('functions', 'list')
  const secretsList = safeCli('secrets', 'list')
  // TẨY TRƯỚC KHI GHI. Bài học thật của chính file này: hàng mục pg_cron chứa
  // 'Authorization, Bearer <token>' trong chuỗi command, nên "chụp" cron.job nguyên
  // văn bản là chép thẳng secret vào bản sao lưu rồi đưa lên Google Drive. Quy tắc:
  // mọi chuỗi dài từ 40 ký tự không có khoảng trắng đều bị coi là credential, cộng
  // mọi thứ sau từ khoá Bearer/Password/Key/Token.
  const scrub = (value) => {
    if (typeof value === 'string') {
      return value
        .replace(/\b(Bearer|Authorization|password|secret|token|api[_-]?key)(\s*[:=]\s*|\s+)['"]?([^\s'",)]{6,})/gi,
          (_m, word, sep) => `${word}${sep}<DAU-GIAY>`
        )
        .replace(/[A-Za-z0-9+\/=_-]{40,}/g, '<CHUOI_BI_MAT>')
    }
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]))
    return value
  }
  // Bảng "secrets list" của CLI là table nhiều cột. CHỌC lấy ô ĐẦU TIÊN của mỗi dòng,
  // vì lấy cả dòng là ăn luôn ô giá trị. Dòng không khớp dạng TÊN_biến bị bỏ.
  const secretNames = (raw) => (raw ?? '').split(/\r?\n/)
    .map((line) => /^\s*[│|]\s*([A-Z][A-Z0-9_]{2,})\s*[│|]/.exec(line)?.[1]
      ?? /^\s*([A-Z][A-Z0-9_]{2,})\s*:/.exec(line)?.[1])
    .filter(Boolean).sort()
  // Nguồn đáng tin hơn để biết "phải tạo lại những biến nào": chính mã nguồn Edge
  // Function liệt kê Deno.env.get('...'). Cách này KHÔNG BAO GIỜ đọc trúng giá trị,
  // và vẫn đúng kể cả khi CLI đổi định dạng bảng.
  const requiredSecretNames = () => {
    const found = new Set(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'])
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name)) {
          for (const m of readFileSync(full, 'utf8').matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)) found.add(m[1])
        }
      }
    }
    try { walk('supabase/functions') } catch { /* khong co thu muc -> bo */ }
    return [...found].sort()
  }
  const kit = scrub({
    version: 2,
    capturedAt: now.toISOString(),
    projectRef: projectRef,
    supabaseUrl: `https://${projectRef}.supabase.co`,
    note: 'File này KHÔNG chứa giá trị bí mật: mọi credential đã bị tẩy trước khi ghi. secretVariableNames chỉ là DANH SÁCH TÊN, để chủ biết phải tạo lại những biến nào khi dựng project mới.',
    systemSettings: safeQuery('SELECT * FROM public.system_settings ORDER BY id', 'system_settings'),
    extensions: safeQuery("SELECT extname AS name, extnamespace::regnamespace::text AS schema FROM pg_extension ORDER BY extname", 'extensions'),
    realtimePublications: safeQuery("SELECT p.pubname AS publication, t.schemaname AS schema, t.tablename AS table_name FROM pg_publication p JOIN pg_publication_tables t ON t.pubname = p.pubname ORDER BY 1, 2, 3", 'realtime publications'),
    cronJobs: safeQuery("SELECT jobid, jobname, schedule, command FROM cron.job ORDER BY jobid", 'pg_cron jobs'),
    edgeFunctions: { read: functionsList.read, listing: functionsList.text.split(/\r?\n/).slice(0, 80) },
    secretVariableNames: { read: secretsList.read, names: secretNames(secretsList.text) },
    requiredSecretNames: requiredSecretNames(),
    frontendEnvVariableNames: (() => {
      try {
        return [...new Set(readFileSync('.env.example', 'utf8')
          .split(/\r?\n/).map((line) => /^([A-Z0-9_]+)=/.exec(line)?.[1]).filter(Boolean))].sort()
      } catch { return [] }
    })(),
  })
  writeFileSyncSafe(`${prefix}-rebuild-kit.json`, JSON.stringify(kit, null, 2) + '\n')
  // Cổng chặn lần hai, chạy trên nội dung ĐÃ tẩy. Còn sót bất kỳ credential nào (kể cả
  // hash JWT, key Vercel/Supabase, chuỗi opaque 40+) -> xóa file và HỦY cả bản backup.
  const leaked = JSON.stringify(kit).match(/vcp_[A-Za-z0-9]{6,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ|sb_secret_[A-Za-z0-9]{6,}|postgres:\/\/[^\s"]*:[^\s"]*@|Bearer\s+[A-Za-z0-9+\/=_-]{6,}|[A-Za-z0-9+\/=_-]{40,}/)
  if (leaked) {
    rmSync(`${prefix}-rebuild-kit.json`, { force: true })
    throw new Error(`rebuild kit refuses to store a secret value (${leaked[0].slice(0, 14)}...)`)
  }
  writeFileSyncSafe(`${prefix}-HUONG-DAN-KHOI-PHUC.md`, `# Cách dựng lại Cà Rem từ bản sao lưu này (${stamp})

Bản này dựng lại được ĐƯỜNG TRUY CẬP + DỮ LIỆU + ẢNH, không cần web cũ còn sống.
Đọc hết mục 0 trước khi làm — bỏ mục 0 là dựng xong mà web vẫn lỗi.

## 0. Phải chuẩn bị gì trước
- Tạo project Supabase MỚI (region Singapore) → lấy Project Ref + ANON KEY + SERVICE ROLE KEY.
- Project mới phải BẬT cùng extension (mục 4) và pg_cron (mục 5), nếu không schema.sql sẽ chết ở dòng CREATE EXTENSION.
- File chứa mật khẩu khách hàng và hash mật khẩu nhân viên: chỉ mở trên máy của chủ, không upload nơi công khai.

## 1. Cấu trúc database
  npx supabase db push --db-url "postgres://postgres.<REF>:<MAT_KHAU>@db.<REF>.supabase.co:5432/postgres" --local ..
  hoặc chạy trực tiếp: psql "<DATABASE_URL>" -f "${SET_PREFIX}${stamp}-schema.sql"
  (schema.sql có đầy đủ bảng, RLS, policy, function, trigger, enum, grant)

## 2. Dữ liệu
  psql "<DATABASE_URL>" -f "${SET_PREFIX}${stamp}-data.sql"
  Gồm: xe, thu xe, bán, thanh toán, công nợ, chi phí, lịch sử giao dịch ngân hàng,
  audit, hồ sơ nhân viên, và bảng auth.users (kèm hash mật khẩu).

## 3. Tài khoản đăng nhập
  data.sql đã chứa auth.users. Sau khi nạp:
  - Đăng nhập bằng đúng email/username + mật khẩu CŨ (hash bcrypt mang đi được).
  - Bắt buộc kiểm tra: Auth → Site URL, SMTP, "Confirm email", mật khẩu tối thiểu —
    project mới KHÔNG tự có mấy cái này; xem rebuild-kit.json và docs/OPERATIONS.md.
  - Nếu project mới chặn ghi auth.users: tạo lại từng tài khoản bằng
    npx supabase functions invoke manage-users (hoặc Dashboard → Authentication → Add user)
    rồi đặt lại mật khẩu cho nhân viên.

## 4. Ảnh xe và giấy tờ (pg_dump KHÔNG chứa ảnh, nên ảnh nằm riêng trong bản này)
  npx supabase storage create bucket <ten-bucket> --private   # xem -storage-inventory.json
  npx supabase storage cp "${SET_PREFIX}${stamp}-storage/<bucket>/<duong-dan>" ss:///<bucket>/<duong-dan> --experimental
  Danh mục đầy đủ + sha256 từng ảnh: ${SET_PREFIX}${stamp}-storage-inventory.json

## 5. Function, cron, biến môi trường
  - Xem "${SET_PREFIX}${stamp}-rebuild-kit.json": tên function đã deploy, verify_jwt,
    lịch pg_cron, danh sách TÊN biến bí mật cần tạo lại (giá trị KHÔNG nằm trong backup).
  - npx supabase functions deploy <ten>   (mã nguồn nằm trong supabase/functions/ của repo)
  - npx supabase secrets set <TEN_BIEN>=<gia tri chu tu nho>
    Danh sách biến PHẢI có: look at rebuild-kit.json -> "requiredSecretNames"
    (rút từ đúng mã nguồn Edge Function, nên không bao giờ chứa giá trị cũ).
    LUU Y: token PUSH_SWEEP_TOKEN đang nằm TRONG cu phap cua hang muc cron.job,
    ma pg_dump sao luu ca bang cron -> no co trong data.sql cua moi ban backup tu
    khi bat pg_cron (sau 15/10). Doi moi project thi PHAI doi token do truoc khi
    nap data.sql, va khong dung token cu.
  - Đăng ký lại webhook ngân hàng với SePay/Casso trỏ tới URL project MỚI, rồi bật
    "Bật webhook ngân hàng" trong Cài đặt → Thanh toán & Đối soát.

## 6. Frontend
  - Repo: github.com/macxuanhoa/xemaycarem  (branch integration/one-carem-latest)
  - Vercel: env theo đúng tên ở rebuild-kit.json (frontendEnvVariableNames), rồi
    npx vercel deploy --prod
  - CHÚ Ý: bản sao lưu NÀY KHÔNG chứa mã nguồn web. Nó chứa dữ liệu + ảnh + cấu hình
    database. Mất cả GitHub lẫn máy này thì mất mã nguồn -> giữ một bản clone repo
    ở NƠI THỨ BA (kéo file .bundle hoặc zip repo sang cùng thư mục Google Drive).

## 7. Kiểm tra sau khi dựng
  npm run backup:verify -- --set ${stamp}   (xác minh từng byte của bản này)
  npx playwright test                        (luồng bán xe, thu tiền, đối soát)
  Đăng nhập thử 1 tài khoản nhân viên + mở 1 hồ sơ xe có ảnh.
`)

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
