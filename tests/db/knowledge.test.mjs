import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Knowledge base contract: documents are searchable evidence for the AI copilot and
// every read is limited to the caller's audience tier. Runs on the disposable harness.
export async function runKnowledgeTests(externalDb, { engine = 'pglite' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled'].map(name => [name, randomUUID()]))
  const run = (name, operation) => asUser(db, users[name], operation)
  const read = (name, fn, args = '', values = []) => run(name, client => rpc(client, fn, args, values))
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  let passed = 0
  const test = async (name, operation) => { await operation(); passed++; console.log(`PASS knowledge ${passed}. ${name}`) }
  const audienceFor = role => ({ OWNER: ['ALL', 'STAFF', 'MANAGER', 'OWNER'], MANAGER: ['ALL', 'STAFF', 'MANAGER'], STAFF: ['ALL', 'STAFF'] })[role]

  try {
    const suite = randomUUID().slice(0, 8)
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${name}-${suite}@example.test`, JSON.stringify({ full_name: `Kiểm thử ${name}` })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role, active=$2 WHERE id=$3', [name === 'disabled' ? 'STAFF' : name.toUpperCase(), name !== 'disabled', id])
    }

    await test('documentation corpus is seeded with one section per evidence slug', async () => {
      const stats = await row("SELECT count(*)::int AS total, count(*) FILTER (WHERE audience='ALL')::int AS public_rows, count(*) FILTER (WHERE audience='OWNER')::int AS owner_rows, count(*) FILTER (WHERE search IS NOT NULL)::int AS indexed FROM public.knowledge_base")
      assert.ok(stats.total > 50, `expected a seeded corpus, got ${stats.total}`)
      assert.ok(stats.public_rows > 0 && stats.owner_rows > 0, 'corpus must contain both public and OWNER-only tiers')
      assert.equal(stats.indexed, stats.total, 'every row must be indexed for full-text search')
      const duplicates = await row('SELECT count(*)::int AS duplicates FROM (SELECT slug FROM public.knowledge_base GROUP BY slug HAVING count(*)>1) d')
      assert.equal(duplicates.duplicates, 0)
    })

    await test('browser roles cannot write documentation', async () => {
      await assert.rejects(() => run('owner', client => client.query("INSERT INTO public.knowledge_base(slug,title,body_md) VALUES('hack-','x','y')")), /permission denied/)
    })

    // A distinctive token taken from a real OWNER-tier row keeps the assertions content-independent.
    const ownerRow = await row("SELECT slug, title FROM public.knowledge_base WHERE audience='OWNER' ORDER BY slug LIMIT 1")
    const term = (ownerRow.title.match(/[A-Za-z]{5,}/) ?? ['supabase'])[0].toLowerCase()

    await test('OWNER retrieves grounded evidence rows with excerpt and route data', async () => {
      const items = await read('owner', 'search_knowledge', '$1::text', [term])
      assert.ok(Array.isArray(items) && items.length > 0, `expected results for '${term}'`)
      const hit = items.find(item => item.slug === ownerRow.slug)
      assert.ok(hit, 'the OWNER document must be retrievable by its OWNER caller')
      for (const item of items) {
        assert.ok(item.slug && item.title && typeof item.excerpt === 'string' && item.excerpt.length > 0)
        assert.ok(Number(item.rank) > 0, 'ranked results must carry a positive relevance score')
      }
    })

    await test('STAFF cannot retrieve or open OWNER-only documentation', async () => {
      const staffItems = await read('staff', 'search_knowledge', '$1::text', [term])
      assert.ok(!staffItems.some(item => item.slug === ownerRow.slug), 'restricted document must not leak through search')
      await assert.rejects(() => read('staff', 'get_knowledge_article', '$1::text', [ownerRow.slug]), /KNOWLEDGE_NOT_FOUND/)
    })

    await test('each role only ever sees its own audience tier', async () => {
      for (const [name, role] of [['owner', 'OWNER'], ['manager', 'MANAGER'], ['staff', 'STAFF']]) {
        const index = await read(name, 'list_knowledge')
        assert.ok(index.total === index.items.length && index.total > 0)
        const leaked = index.items.filter(item => !audienceFor(role).includes(item.audience))
        assert.equal(leaked.length, 0, `${role} must not list ${leaked.map(i => i.audience).join(',')}`)
      }
      const ownerCount = (await read('owner', 'list_knowledge')).total
      const staffCount = (await read('staff', 'list_knowledge')).total
      assert.ok(ownerCount > staffCount, 'OWNER index must be a strict superset of STAFF')
    })

    await test('restricted sections open for the OWNER viewer and stay hidden from anon', async () => {
      const article = await read('owner', 'get_knowledge_article', '$1::text', [ownerRow.slug])
      assert.equal(article.slug, ownerRow.slug)
      assert.ok(article.body_md.length > 0 && article.source_path)
      // anon lacks EXECUTE entirely, so PostgreSQL rejects before the function body runs.
      await assert.rejects(() => asUser(db, null, client => rpc(client, 'get_knowledge_article', '$1::text', [ownerRow.slug]), 'anon'), /permission denied for function/)
    })

    await test('disabled accounts and empty or noisy queries return no knowledge', async () => {
      await assert.rejects(() => read('disabled', 'search_knowledge', '$1::text', [term]), /ACCESS_DENIED/)
      assert.deepEqual(await read('owner', 'search_knowledge', '$1::text', ['']), [])
      assert.deepEqual(await read('owner', 'search_knowledge', '$1::text', ['a']), [])
      assert.deepEqual(await read('owner', 'search_knowledge', '$1::text', ['zzqxvjqblnonexistentterm']), [])
    })

    await test('search honours the bounded result limit', async () => {
      const capped = await read('owner', 'search_knowledge', '$1::text,$2::int', [term, 2])
      assert.ok(capped.length <= 2)
      const clamped = await read('owner', 'search_knowledge', '$1::text,$2::int', [term, 999])
      assert.ok(clamped.length <= 20, 'limit must be clamped server-side')
    })

    console.log(`\nKnowledge base checks passed: ${passed}`)
  } finally {
    if (!externalDb) await db.close()
  }
  return { db, users, run, read }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/knowledge.test.mjs')) {
  await runKnowledgeTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
