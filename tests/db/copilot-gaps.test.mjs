import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Copilot documentation-gap loop: unanswered questions are recorded under the caller's
// own role, collapse on normalized text, and only the OWNER can read the digest.
export async function runCopilotGapTests(externalDb, { engine = 'pglite' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled'].map(name => [name, randomUUID()]))
  const run = (name, operation) => asUser(db, users[name], operation)
  const read = (name, fn, args = '', values = []) => run(name, client => rpc(client, fn, args, values))
  let passed = 0
  const test = async (name, operation) => { await operation(); passed++; console.log(`PASS gaps ${passed}. ${name}`) }

  try {
    const suite = randomUUID().slice(0, 8)
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${name}-${suite}@example.test`, JSON.stringify({ full_name: `Kiểm thử ${name}` })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role, active=$2 WHERE id=$3', [name === 'disabled' ? 'STAFF' : name.toUpperCase(), name !== 'disabled', id])
    }
    const question = `Quy trình đổi biển số xe tồn ${suite}?`

    await test('STAFF records an unanswered question and repeats collapse on normalized text', async () => {
      await read('staff', 'log_copilot_gap', '$1::text', [question])
      // Whitespace and padding variants collapse onto one row. Vietnamese case folding is
      // deliberately NOT asserted: the database has no unaccent/special-casing map.
      await read('staff', 'log_copilot_gap', '$1::text', [`  ${question}	 `])
      await read('manager', 'log_copilot_gap', '$1::text', [` ${question} `])
      const rows = await db.query('SELECT question_norm, hits, last_role FROM public.copilot_question_gaps WHERE question_norm = $1', [question.toLowerCase().replace(/\s+/g, ' ').trim()])
      // Whitespace-collapse normalization means the three calls share one row.
      assert.equal(rows.rows.length, 1, 'one collapsed row expected')
      assert.ok(rows.rows[0].hits >= 3, `expected hits to accumulate, got ${rows.rows[0].hits}`)
      assert.equal(rows.rows[0].last_role, 'MANAGER', 'the most recent caller role wins')
    })

    await test('disabled accounts and anon cannot record gaps', async () => {
      await assert.rejects(() => read('disabled', 'log_copilot_gap', '$1::text', [question]), /ACCESS_DENIED/)
      await assert.rejects(() => asUser(db, null, client => rpc(client, 'log_copilot_gap', '$1::text', [question]), 'anon'), /permission denied for function/)
    })

    await test('empty and one-character questions are dropped without touching the log', async () => {
      const before = await db.query('SELECT count(*)::int AS n FROM public.copilot_question_gaps')
      await read('staff', 'log_copilot_gap', '$1::text', ['  '])
      await read('staff', 'log_copilot_gap', '$1::text', ['x'])
      const after = await db.query('SELECT count(*)::int AS n FROM public.copilot_question_gaps')
      assert.equal(after.rows[0].n, before.rows[0].n)
    })

    await test('the gap table is unreachable from browser roles; RPCs are the only door', async () => {
      await assert.rejects(() => run('owner', client => client.query('SELECT * FROM public.copilot_question_gaps')), /permission denied for table/)
      await assert.rejects(() => run('staff', client => client.query('SELECT * FROM public.copilot_question_gaps')), /permission denied for table/)
    })

    await test('OWNER reads the digest ranked by hits; MANAGER and STAFF are rejected', async () => {
      const digest = await read('owner', 'list_copilot_gaps', '$1::int', [30])
      assert.ok(digest.total >= 1 && digest.days === 30)
      const hit = digest.items.find(item => item.question.startsWith(`Quy trình đổi biển số xe tồn ${suite}`))
      assert.ok(hit && hit.hits >= 3 && hit.last_role === 'MANAGER')
      assert.ok(digest.items.every((item, index, all) => index === 0 || all[index - 1].hits >= item.hits), 'items must be ranked by hits')
      for (const name of ['manager', 'staff']) {
        await assert.rejects(() => read(name, 'list_copilot_gaps', '$1::int', [30]), /ACCESS_DENIED/)
      }
      await assert.rejects(() => asUser(db, null, client => rpc(client, 'list_copilot_gaps', '$1::int', [30]), 'anon'), /permission denied for function/)
    })

    await test('window is clamped server-side and answers are never stored', async () => {
      const digest = await read('owner', 'list_copilot_gaps', '$1::int', [9999])
      assert.equal(digest.days, 365, 'window must be clamped to one year')
      const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='copilot_question_gaps'")
      const names = columns.rows.map(row => row.column_name)
      assert.ok(!names.some(name => /answer|response|evidence/i.test(name)), 'the log must store questions only')
    })

    console.log(`\nCopilot gap-log checks passed: ${passed}`)
  } finally {
    if (!externalDb) await db.close()
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/copilot-gaps.test.mjs')) {
  await runCopilotGapTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
