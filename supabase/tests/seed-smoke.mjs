import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

const db = await createDatabase({ engine: 'pglite' })
try {
  const seed = await readFile(new URL('../seed.sql', import.meta.url), 'utf8')
  await db.exec(seed)
  assert.equal((await db.query('select count(*)::int as count from public.vehicles')).rows[0].count, 0)
  const owner = randomUUID()
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'seed-owner@example.test','{\"full_name\":\"Seed Owner\"}')", [owner])
  await db.query("update public.profiles set role='OWNER',active=true where id=$1", [owner])
  await db.exec(seed)
  await asUser(db, owner, async (client) => {
    const inventory = await rpc(client, 'list_vehicles')
    assert.equal(inventory.total, 8)
    const available = await rpc(client, 'report', "'inventory'")
    assert.equal(available.total, 6)
    assert.ok(available.items.every((vehicle) => ['IN_STOCK', 'RESERVED'].includes(vehicle.status)))
    const saleReport = await rpc(client, 'report', "'sales'")
    assert.equal(saleReport.total, 2)
    const dashboard = await rpc(client, 'dashboard')
    assert.equal(dashboard.in_stock, 5)
    assert.equal(dashboard.reserved, 1)
    assert.equal(dashboard.sold_today, 1)
    assert.equal(dashboard.today_revenue, 31_000_000)
    assert.equal(dashboard.today_profit, 4_850_000)
    assert.equal(dashboard.inventory_cost, 232_900_000)
    assert.equal(dashboard.inventory_cost_pending, 0)
    assert.equal(dashboard.aging.reduce((sum, item) => sum + item.count, 0), 6)
    const expensive = await rpc(client, 'list_vehicles', "'{\"sort\":\"highest_cost\",\"limit\":1}'::jsonb")
    assert.equal(expensive.items[0].vehicle_title, '59-H1 101.01 · RLHKC2025SEED001')
    assert.equal(expensive.items[0].vehicle_type, 'Xe tay ga')
    const old = await rpc(client, 'list_vehicles', "'{\"sort\":\"longest_stock\",\"status\":\"AVAILABLE\",\"limit\":1}'::jsonb")
    assert.equal(old.items[0].vehicle_subtitle, 'Xe số · 2024 · Đỏ')
    assert.equal('model' in expensive.items[0], false)
    assert.equal('asking_price' in expensive.items[0], false)
    const byType = await rpc(client, 'list_vehicles', "'{\"vehicle_type\":\"Ga 50cc\"}'::jsonb")
    assert.equal(byType.total, 1)
    const pages = await Promise.all([0, 3, 6].map((offset) => rpc(client, 'list_vehicles', '$1::jsonb', [JSON.stringify({ offset, limit: 3 })])))
    assert.equal(new Set(pages.flatMap((page) => page.items.map((item) => item.id))).size, 8)
  })
  await db.exec(seed)
  assert.equal((await db.query('select count(*)::int as count from public.vehicles')).rows[0].count, 8)
  // Every seeded vehicle is classified and the trail behind it is real.
  assert.equal((await db.query('select count(*)::int as n from public.vehicles where vehicle_type_id is null')).rows[0].n, 0)
  console.log('PASS development seed, idempotency, dashboard, reports, sorting, and pagination')
} finally {
  await db.close()
}
