// Vite's normal .env fallback may point at production. Supply an isolated envDir
// and override the inherited VITE_* environment before Vite reads configuration.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { loadStaging } from './staging-lib.mjs'

const args = process.argv.slice(2)
const envIndex = args.indexOf('--env')
let envDir
try {
  const config = loadStaging(envIndex < 0 ? '.env.staging' : args[envIndex + 1])
  for (const name of Object.keys(process.env)) if (name.startsWith('VITE_')) delete process.env[name]
  process.env.VITE_SUPABASE_URL = config.url
  process.env.VITE_SUPABASE_ANON_KEY = config.key
  process.env.VITE_APP_ENV = 'staging'
  const scratch = resolve('scratch')
  mkdirSync(scratch, { recursive: true })
  envDir = mkdtempSync(join(scratch, 'staging-env-'))
  writeFileSync(join(envDir, '.env.staging'), 'VITE_APP_ENV=staging\n')
  const { build } = await import('vite')
  await build({ mode: 'staging', envDir, build: { outDir: 'scratch/staging-dist', emptyOutDir: true } })
  console.log('PASS  isolated staging build created in scratch/staging-dist')
} catch (error) {
  console.error(`FAIL  ${error.message}`)
  process.exitCode = 1
} finally {
  if (envDir) {
    const rel = relative(realpathSync(resolve('scratch')), realpathSync(envDir))
    if (!rel.startsWith('staging-env-') || rel.includes(sep) || rel === '..') {
      console.error('FAIL  unsafe staging environment cleanup path; files preserved')
      process.exitCode = 1
    } else rmSync(envDir, { recursive: true, force: true })
  }
}
