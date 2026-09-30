import { describe, expect, it, vi } from 'vitest'
import { loadEdgeHandler } from '../helpers/edge-handler'

const userId = '11111111-1111-4111-8111-111111111111'
const password = 'Disposable-Test-Only-123!'
function harness(options: { role?: string; mustChange?: boolean; updateError?: boolean; authDeleteError?: boolean; requirementError?: boolean } = {}) {
  const operations: string[] = []
  const savedProfile = { id: userId, username: 'test_staff', full_name: 'Test', role: 'STAFF', active: false, must_change_password: false }
  const caller = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: '22222222-2222-4222-8222-222222222222' } }, error: null })) },
    from: () => {
      const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: { role: options.role ?? 'OWNER', active: true, deleted_at: null }, error: null }) }
      return chain
    },
    rpc: vi.fn(async (name: string) => name === 'check_user_access'
      ? { data: { allowed: true, must_change_password: !!options.mustChange }, error: null }
      : name === 'check_user_can_hard_delete' ? { data: { can_delete: true }, error: null }
      : { data: null, error: options.updateError ? { message: 'test failure' } : null }),
  }
  const admin = {
    rpc: vi.fn(async () => { operations.push('contain_requirement'); return { data: null, error: options.requirementError ? { message: 'test failure' } : null } }),
    auth: { admin: {
      createUser: vi.fn(async () => { operations.push('create_auth'); return { data: { user: { id: userId } }, error: null } }),
      updateUserById: vi.fn(async () => ({ data: { user: { id: userId } }, error: null })),
      deleteUser: vi.fn(async () => { operations.push('delete_auth'); return { data: {}, error: options.authDeleteError ? { message: 'test failure' } : null } }),
    } },
    from: () => {
      let isLookup = false
      let mutation = ''
      const chain = {
        select: () => chain,
        ilike: () => { isLookup = true; return chain },
        eq: () => mutation ? Promise.resolve({ error: null }) : chain,
        single: async () => ({ data: savedProfile, error: null }),
        maybeSingle: async () => ({ data: isLookup ? null : savedProfile, error: null }),
        update: vi.fn(() => { mutation = 'update'; operations.push('contain_requirement'); return chain }),
        delete: () => { mutation = 'delete'; operations.push('delete_profile'); return chain },
        insert: vi.fn(async () => { operations.push('restore_profile'); return { error: null } }),
      }
      return chain
    },
  }
  const createClient = vi.fn((...args: unknown[]) => args[1] === 'test-service' ? admin : caller)
  const handler = loadEdgeHandler('supabase/functions/manage-users/index.ts', {
    env: { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'test-public', SUPABASE_SERVICE_ROLE_KEY: 'test-service' }, createClient,
  })
  const invoke = (body: Record<string, unknown>) => handler(new Request('https://example.test/manage-users', {
    method: 'POST', headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { invoke, admin, caller, createClient, operations }
}

describe('Actual manage-users Edge handler security and partial failures', () => {
  it('rejects staff and temporary-password owners before creating an Admin client', async () => {
    for (const options of [{ role: 'STAFF' }, { mustChange: true }]) {
      const h = harness(options)
      expect((await h.invoke({ action: 'reset_password', user_id: userId, password })).status).toBe(403)
      expect(h.createClient).toHaveBeenCalledTimes(1)
      expect(h.admin.auth.admin.updateUserById).not.toHaveBeenCalled()
    }
  })
  it('never reports reset success if forcing password change fails', async () => {
    const h = harness({ requirementError: true })
    const response = await h.invoke({ action: 'reset_password', user_id: userId, password })
    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('PASSWORD_REQUIREMENT_FAILED')
    expect(h.operations).toContain('contain_requirement')
  })
  it('removes the inactive profile before rolling back Auth provisioning', async () => {
    const h = harness({ updateError: true })
    const response = await h.invoke({ action: 'create', username: 'test_staff', full_name: 'Test Staff', role: 'STAFF', password })
    expect(response.status).toBe(500)
    expect(h.operations).toEqual(['create_auth', 'delete_profile', 'delete_auth'])
    expect(JSON.stringify(await response.json())).not.toContain(password)
  })
  it('restores the profile when hard-delete Auth Admin operation fails', async () => {
    const h = harness({ authDeleteError: true })
    expect((await h.invoke({ action: 'hard_delete', user_id: userId })).status).toBe(500)
    expect(h.operations).toEqual(['delete_profile', 'delete_auth', 'restore_profile'])
  })
  it('validates target UUID before performing a privileged mutation', async () => {
    const h = harness()
    expect((await h.invoke({ action: 'reset_password', user_id: 'not-an-id', password })).status).toBe(400)
    expect(h.admin.auth.admin.updateUserById).not.toHaveBeenCalled()
  })
  it('stops before changing Auth credentials if the initial session gate cannot be saved', async () => {
    const h = harness({ updateError: true })
    expect((await h.invoke({ action: 'reset_password', user_id: userId, password })).status).toBe(500)
    expect(h.admin.auth.admin.updateUserById).not.toHaveBeenCalled()
  })
})
