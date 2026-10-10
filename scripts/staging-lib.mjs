import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REF = /^[a-z0-9]{20}$/
export function parseEnvironment(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) throw new Error('Invalid staging environment line')
    if (Object.hasOwn(values, match[1])) throw new Error('Duplicate staging environment value')
    let value = match[2].trim()
    if (/^["']/.test(value)) {
      if (value.at(-1) !== value[0]) throw new Error('Unclosed staging environment quote')
      value = value.slice(1, -1)
    }
    if (/\$\{|[\r\n\0]/.test(value)) throw new Error('Staging environment values must be explicit')
    values[match[1]] = value
  }
  return values
}

export function validateStaging(values, linkedProductionRef = null) {
  const stagingRef = values.CAREM_STAGING_PROJECT_REF?.trim()
  const productionRef = values.CAREM_PRODUCTION_PROJECT_REF?.trim() || linkedProductionRef
  if (!REF.test(stagingRef ?? '') || !REF.test(productionRef ?? '')) throw new Error('Staging and production project references are required (20 lowercase letters/digits)')
  if (linkedProductionRef && productionRef !== linkedProductionRef) throw new Error('Declared production reference disagrees with this workspace linkage')
  if (stagingRef === productionRef) throw new Error('Staging must use a separate Supabase project; production was refused')
  let url
  try { url = new URL(values.VITE_SUPABASE_URL) } catch { throw new Error('Staging Supabase URL is required') }
  if (url.href !== `https://${stagingRef}.supabase.co/`) throw new Error('Staging URL must match its explicit project reference exactly')
  const key = values.VITE_SUPABASE_ANON_KEY?.trim()
  if (!key || key.startsWith('sb_secret_')) throw new Error('Staging requires a frontend publishable/anon key, never a secret key')
  if (!key.startsWith('sb_publishable_')) {
    let claims
    try { claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8')) } catch { throw new Error('Staging frontend key is not a valid anon/publishable key') }
    if (claims.role !== 'anon' || claims.ref !== stagingRef) throw new Error('Staging anon key belongs to another project or has elevated privileges')
  }
  if (key.startsWith('sb_publishable_') && key.length < 30) throw new Error('Staging publishable key appears incomplete')
  return { stagingRef, productionRef, url: url.origin, key, appEnv: 'staging' }
}

export function loadStaging(file = '.env.staging', env = process.env) {
  const values = existsSync(file) ? parseEnvironment(readFileSync(file, 'utf8')) : { ...env }
  const linked = resolve('supabase/.temp/project-ref')
  const linkedProductionRef = existsSync(linked) ? readFileSync(linked, 'utf8').trim() : null
  return validateStaging(values, linkedProductionRef)
}

export async function probeStaging(config, fetcher = fetch) {
  const checks = []
  const request = async (path) => {
    try { return await fetcher(`${config.url}${path}`, { headers: { apikey: config.key }, signal: AbortSignal.timeout(10000), redirect: 'error' }) }
    catch { return null }
  }
  const health = await request('/auth/v1/health')
  checks.push({ name: 'Auth endpoint responds with the staging key', ok: Boolean(health?.ok) })
  // Anonymous access must not reveal any vehicle or identity-document row. A denial
  // is valid; missing tables are not. Never record response bodies in the report.
  for (const table of ['vehicles', 'identity_documents']) {
    const response = await request(`/rest/v1/${table}?select=id&limit=1`)
    let safe = response && [401, 403].includes(response.status)
    if (response?.status === 200) {
      try { const rows = await response.json(); safe = Array.isArray(rows) && rows.length === 0 } catch { safe = false }
    }
    checks.push({ name: `${table}: anonymous read denied or empty under RLS`, ok: Boolean(safe) })
  }
  return { ok: checks.every((c) => c.ok), checks }
}
