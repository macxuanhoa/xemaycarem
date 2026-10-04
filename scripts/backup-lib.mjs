// Shared helpers for the production backup tooling (backup-prod / backup-verify /
// backup-status). Everything here is READ-ONLY against production: it only inspects the
// local git-ignored `backups/` tree. A backup "set" is one dated run identified by its
// stamp, e.g. carem-prod-2026-10-03-124513 with files -schema.sql, -data.sql,
// -migration-history.txt, -MANIFEST.md and an optional -storage/<bucket>/<path> tree.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const BACKUP_DIR = 'backups'
export const SET_PREFIX = 'carem-prod-'
export const HEALTH_FILE = join(BACKUP_DIR, 'LATEST.json')
export const MIRROR_MARKER = '.carem-backup-mirror'

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
export const sha256_16 = (file) => sha256(file).slice(0, 16).toUpperCase()

// Two stamp layouts exist in backups/: the dashed one this tooling writes
// (2026-10-03-160938) and an older compact one from earlier manual runs
// (20261002-091111). Both are recognised so old restore points are never invisible, and
// every set also carries a normalized `key` because mixed layouts do not sort lexically.
const STAMP_RE = /^(\d{4})-?(\d{2})-?(\d{2})-(\d{2})(\d{2})(\d{2})$/
const SET_NAME_RE = new RegExp(`^${SET_PREFIX}(\\d{4}-?\\d{2}-?\\d{2}-\\d{6})(?=-|$)`)

export function parseStamp(stamp) {
  const m = STAMP_RE.exec(stamp)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  // Backups are taken in local shop time (Asia/Ho_Chi_Minh machines); interpreting the
  // stamp in the local zone is what makes "daily / weekly / monthly" bucketing correct.
  return new Date(y, mo - 1, d, h, mi, s)
}

export const normalizeStamp = (stamp) => {
  const m = STAMP_RE.exec(stamp)
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}${m[5]}${m[6]}` : stamp
}

// Every set folder/file belonging to one stamp, walked so the Storage sub-tree is included.
function filesForStamp(stamp) {
  const found = []
  ;(function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (relative(BACKUP_DIR, full).split(sep)[0].startsWith(SET_PREFIX + stamp)) found.push(full)
    }
  })(BACKUP_DIR)
  return found.sort((a, b) => a.localeCompare(b))
}

// Lists runs in chronological order. A set without a manifest is still reported so an
// interrupted run is visible instead of silently vanishing from the numbers.
export function listSets() {
  if (!existsSync(BACKUP_DIR)) return []
  const stamps = new Set()
  for (const entry of readdirSync(BACKUP_DIR)) {
    const stamp = SET_NAME_RE.exec(entry)?.[1]
    if (stamp && parseStamp(stamp)) stamps.add(stamp)
  }
  return [...stamps]
    .map((stamp) => ({ stamp, key: normalizeStamp(stamp) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ stamp, key }) => {
      const files = filesForStamp(stamp)
      const manifestPath = join(BACKUP_DIR, `${SET_PREFIX}${stamp}-MANIFEST.md`)
      return {
        stamp,
        key,
        date: parseStamp(stamp),
        files,
        bytes: files.reduce((n, f) => n + statSync(f).size, 0),
        manifest: existsSync(manifestPath) ? manifestPath : null,
        storageDir: existsSync(join(BACKUP_DIR, `${SET_PREFIX}${stamp}-storage`)) ? join(BACKUP_DIR, `${SET_PREFIX}${stamp}-storage`) : null,
      }
    })
}

// The manifest line `## Row counts at capture` -> { 'vehicles': 0, 'auth.users': 2, ... }
export function readManifestCounts(manifestPath) {
  const text = readFileSync(manifestPath, 'utf8')
  const line = text.split('\n').find((l) => /=/.test(l) && !l.startsWith('#') && l.includes('|'))
  if (!line) return {}
  const counts = {}
  for (const part of line.replace(/\|/g, ',').split(',')) {
    const m = /^\s*([\w.]+)=(\d+)\s*$/.exec(part)
    if (m) counts[m[1]] = Number(m[2])
  }
  return counts
}

// The manifest hashes drive the corruption check: `path | N bytes | sha256:XXXX...`, with
// older sets carrying a trailing note or the original Storage object path after the hash.
export function readManifestHashes(manifestPath) {
  const out = []
  for (const l of readFileSync(manifestPath, 'utf8').split('\n')) {
    const m = /^(\S+) \| (\d+) bytes \| sha256:([0-9A-Fa-f]{16,64})/.exec(l.trim())
    if (m) out.push({ path: m[1], size: Number(m[2]), sha: m[3].toLowerCase() })
  }
  return out
}

// Grandfather-father-son retention: newest 7 days, then one per week for 4 weeks, then
// one per month for 12 months. Returns the sets that may be pruned plus why each kept set
// survived, so the log can be audited later without re-deriving the rules.
export function planRetention(sets, { daily = 7, weekly = 4, monthly = 12 } = {}) {
  const desc = [...sets].sort((a, b) => b.key.localeCompare(a.key))
  const dayRank = new Map()
  for (const s of desc) {
    const day = s.key.slice(0, 10)
    if (!dayRank.has(day)) dayRank.set(day, dayRank.size)
  }
  const newestOfWeek = new Map()
  const newestOfMonth = new Map()
  for (const s of desc) {
    const week = `${s.date.getFullYear()}-W${isoWeek(s.date)}`
    const month = s.key.slice(0, 7)
    if (!newestOfWeek.has(week)) newestOfWeek.set(week, s.key)
    if (!newestOfMonth.has(month)) newestOfMonth.set(month, s.key)
  }
  const weeks = [...newestOfWeek.values()]
  const months = [...newestOfMonth.values()]
  const keep = []
  const prune = []
  for (const s of desc) {
    if (!s.manifest) { keep.push({ set: s, reason: 'INCOMPLETE (no manifest) - never auto-deleted' }); continue }
    const day = dayRank.get(s.key.slice(0, 10))
    if (day < daily) { keep.push({ set: s, reason: `daily #${day + 1}` }); continue }
    if (weeks.includes(s.key) && weeks.indexOf(s.key) < weekly) { keep.push({ set: s, reason: 'weekly grandparent' }); continue }
    if (months.includes(s.key) && months.indexOf(s.key) < monthly) { keep.push({ set: s, reason: 'monthly grandparent' }); continue }
    prune.push(s)
  }
  // A run is never pruned by the same invocation that created it, and the guard floor
  // keeps the newest few sets alive even if the calendar bucketing above is somehow wrong.
  if (desc.length <= 3) return { keep, prune: [] , blockedByFloor: prune }
  return { keep, prune }
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  return Math.ceil(((t - new Date(Date.UTC(t.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)
}

// Where the second copy goes. Either CAREM_BACKUP_OFFSITE (used by CI/ad-hoc) or the first
// real line of backups/offsite.txt, which is the knob the shop owner can edit in Notepad
// after installing Google Drive for Desktop - no command line, no re-install of the task.
export const OFFSITE_FILE = join(BACKUP_DIR, 'offsite.txt')
export function offsiteTarget() {
  const fromEnv = process.env.CAREM_BACKUP_OFFSITE?.trim()
  if (fromEnv) return fromEnv
  if (!existsSync(OFFSITE_FILE)) return null
  const line = readFileSync(OFFSITE_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  return line || null
}

// A second copy only lands where the owner has explicitly opted in, because the dump
// carries customer PII and password hashes: an arbitrary folder path (Downloads, a shared
// drive) is not a safe home for it. The marker file is that opt-in.
export function offsiteOptedIn(target) {
  return Boolean(target) && existsSync(target) && existsSync(join(target, MIRROR_MARKER))
}

// The health marker is the single answer to "is my backup system actually working?"
export function readHealth() {
  if (!existsSync(HEALTH_FILE)) return null
  try {
    return JSON.parse(readFileSync(HEALTH_FILE, 'utf8'))
  } catch {
    return { corrupt: true }
  }
}

export function writeHealth(patch) {
  const current = { ...readHealth(), ...patch, updatedAt: new Date().toISOString() }
  writeFileSyncSafe(HEALTH_FILE, JSON.stringify(current, null, 2) + '\n')
  return current
}

// Splits a pg_dump text file into statements without breaking on semicolons inside string
// literals, quoted identifiers, dollar-quoted bodies or comments — a naive split(';') would
// corrupt Vietnamese text and then report a phantom restore failure. `supabase db dump` also
// wraps the script in psql backslash meta-commands (\restrict / \unrestrict session tokens)
// which are client directives, not SQL: left in, they glue the file header onto the first
// statement and the replay dies on a syntax error at "-".
export function splitStatements(sql) {
  const out = []
  let buf = ''
  let i = 0
  let mode = null // 'line' | 'block' | 's' | 'd' | { dollar: tag }
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (!mode) {
      // psql meta-commands are client directives; drop the whole line, do not keep the '\'.
      if (ch === '\\' && (i === 0 || sql[i - 1] === '\n' || sql[i - 1] === '\r')) {
        while (i < sql.length && sql[i] !== '\n') i++
        continue
      }
      // Comments are dropped, not buffered: keeping them would glue a header block onto the
      // next real statement and then fail the replay with a syntax error at "-".
      if (ch === '-' && next === '-') { mode = 'line'; i += 2; continue }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue }
      if (ch === "'") { mode = 's'; buf += ch; i++; continue }
      if (ch === '"') { mode = 'd'; buf += ch; i++; continue }
      if (ch === '$') {
        const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0]
        if (tag) { mode = { dollar: tag }; buf += tag; i += tag.length; continue }
      }
      if (ch === ';') { const s = buf.trim(); if (s) out.push(s); buf = ''; i++; continue }
      buf += ch; i++; continue
    }
    if (mode === 'line') { if (ch === '\n') { mode = null; buf += ch } i++; continue }
    if (mode === 'block') { if (ch === '*' && next === '/') { mode = null; i += 2; continue } i++; continue }
    if (mode === 's') { buf += ch; if (ch === "'" && next === "'") { buf += next; i += 2; continue } if (ch === "'") mode = null; i++; continue }
    if (mode === 'd') { buf += ch; if (ch === '"') mode = null; i++; continue }
    const tag = mode.dollar
    if (sql.startsWith(tag, i)) { buf += tag; i += tag.length; mode = null; continue }
    buf += ch; i++
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  return out
}

export function writeFileSyncSafe(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}
