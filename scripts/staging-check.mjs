// Read-only readiness checks. No CLI linkage, migrations or production writes.
import { loadStaging, probeStaging } from './staging-lib.mjs'
import { writeFileSyncSafe } from './backup-lib.mjs'

const args = process.argv.slice(2)
const envIndex = args.indexOf('--env')
try {
  const config = loadStaging(envIndex < 0 ? '.env.staging' : args[envIndex + 1])
  console.log('PASS  staging URL/key target a separate explicitly named Supabase project')
  if (!args.includes('--offline')) {
    const report = await probeStaging(config)
    for (const check of report.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`)
    writeFileSyncSafe('scratch/staging-readiness.json', JSON.stringify({ at: new Date().toISOString(), stagingRef: config.stagingRef, productionRef: config.productionRef, ...report, hostedRoleSmokeProven: false }, null, 2) + '\n')
    console.log('OWNER/MANAGER/STAFF login, Storage image access and business flow checks still require separate staging accounts.')
    if (!report.ok) process.exitCode = 1
  }
} catch (error) {
  // Validation errors are fixed messages and never contain key values.
  console.error(`FAIL  ${error.message}`)
  process.exitCode = 1
}
