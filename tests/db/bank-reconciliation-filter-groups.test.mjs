/**
 * Database test: list_bank_transactions group filters (migration 20261017000100).
 *
 * This suite deliberately exercises ONLY the read filter over bank_transactions.
 * Rows are inserted directly (no ingest/confirm), so it is completely decoupled
 * from the manual-confirmation money-flow contract that docs/KNOWN_ISSUES.md keeps
 * pending an owner decision. It must stay green regardless of that outcome.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runBankReconciliationFilterGroupTests(_externalDb, { engine = 'postgres' } = {}) {
  const db = _externalDb ?? (await createDatabase({ engine }))
  let passed = 0
  const pass = (name) => { passed += 1; console.log(`PASS ${passed}. ${name}`) }
  try {
    console.log('\n--- Running Database Bank Reconciliation Filter-Group Suite ---')

    const users = Object.fromEntries(['owner', 'staff'].map((r) => [r, randomUUID()]))
    for (const name of Object.keys(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [users[name], `brefg-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role, active=true, can_view_financials=$2 WHERE id=$3',
        [name === 'owner' ? 'OWNER' : 'STAFF', name === 'owner', users[name]])
    }
    const call = (user, filters) => asUser(db, users[user], (client) => rpc(client, 'list_bank_transactions', '$1::jsonb', [JSON.stringify(filters)]))
    const statuses = (list) => list.items.map((t) => t.status).sort()

    // Seed one synthetic row per status so each group bucket is observable.
    // status/match_reason are TEXT with CHECK constraints (no enum type), so a
    // plain text insert is valid — and it never touches ingest/confirm money flow.
    const seed = [
      ['UNMATCHED', 'NO_REFERENCE'],
      ['MATCHED_PENDING', 'PENDING_OWNER_APPROVAL'],
      ['MANUAL_REVIEW', 'AMOUNT_MISMATCH'],
      ['RECEIVED', 'REFERENCE_AMOUNT_MATCH'],
      ['RECORDED', 'AUTO_RECORDED'],
      ['IGNORED', ''],
    ]
    for (const [i, [status, reason]] of seed.entries()) {
      await db.query(
        `INSERT INTO public.bank_transactions(provider, provider_txn_id, amount, status, match_reason, received_at)
         VALUES ('SEPAY', $1, $2, $3, $4, now() - ($5 || ' minutes')::interval)`,
        [`BREFG-${i}`, 1_000_000 + i, status, reason, String(seed.length - i)],
      )
    }

    const attention = await call('owner', { status: 'ATTENTION', limit: 50 })
    assert.deepEqual(statuses(attention), ['MANUAL_REVIEW', 'MATCHED_PENDING', 'UNMATCHED'].sort())
    pass('ATTENTION returns exactly the three pending-decision statuses')

    const history = await call('owner', { status: 'HISTORY', limit: 50 })
    assert.deepEqual(statuses(history), ['IGNORED', 'RECEIVED', 'RECORDED'].sort())
    pass('HISTORY returns exactly the three settled statuses (incl. RECEIVED)')

    const received = await call('owner', { status: 'RECEIVED', limit: 50 })
    assert.deepEqual(statuses(received), ['RECEIVED'])
    pass('Single-value RECEIVED filter is accepted (was INVALID_INPUT before 20261017000100)')

    const all = await call('owner', { limit: 50 })
    assert.equal(all.total, 6)
    assert.equal(all.pending_count, 2) // MATCHED_PENDING + MANUAL_REVIEW only
    pass('No-status returns every row; pending_count counts only MATCHED_PENDING + MANUAL_REVIEW')

    await assert.rejects(() => call('owner', { status: 'NOT_A_STATUS' }), /INVALID_INPUT/)
    pass('Unknown status values are still rejected')

    await assert.rejects(() => call('staff', { status: 'ATTENTION' }), /ACCESS_DENIED|permission denied|row-level security/i)
    pass('Non-financial STAFF cannot read the reconciliation queue through any group filter')

    console.log(`\nBank Reconciliation Filter-Group suite: ${passed} checks passed on ${engine}`)
  } finally {
    if (!_externalDb) await db.close()
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/bank-reconciliation-filter-groups.test.mjs')) {
  await runBankReconciliationFilterGroupTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
