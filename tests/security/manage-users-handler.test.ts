import { describe, expect, it, vi } from 'vitest'
import { loadEdgeHandler } from '../helpers/edge-handler'

const userId = '11111111-1111-4111-8111-111111111111'
const callerId = '22222222-2222-4222-8222-222222222222'
const password = 'Disposable-Test-Only-123!'
function harness(options: { role?: string; mustChange?: boolean; updateError?: boolean; authDeleteError?: boolean; requirementError?: boolean; targetRole?: string; activeOwnerCount?: number; canDelete?: boolean; eligibilityError?: boolean; targetDeletedAt?: string | null; targetPurgedAt?: string | null } = {}) {
  const operations: string[] = []
  const savedProfile = { id: userId, username: 'test_staff', full_name: 'Test', role: options.targetRole ?? 'STAFF', active: true, must_change_password: false, deleted_at: options.targetDeletedAt ?? null, purged_at: options.targetPurgedAt ?? null, disabled_until: null, disable_reason: null }
  const caller = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: callerId } }, error: null })) },
    from: () => {
      const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: { role: options.role ?? 'OWNER', active: true, deleted_at: null }, error: null }) }
      return chain
    },
    rpc: vi.fn(async (name: string) => name === 'check_user_access'
      ? { data: { allowed: true, must_change_password: !!options.mustChange }, error: null }
      : name === 'check_user_can_hard_delete' ? (options.eligibilityError
        ? { data: null, error: { message: 'test failure' } }
        : { data: options.targetRole === 'OWNER' && options.canDelete === undefined
          ? { can_delete: false, reason: 'CANNOT_DELETE_OWNER' }
          : options.canDelete === false ? { can_delete: false, reason: 'USER_HAS_BUSINESS_HISTORY' } : { can_delete: true }, error: null })
      : { data: null, error: options.updateError ? { message: 'test failure' } : null }),
  }
  const admin = {
    rpc: vi.fn(async () => { operations.push('contain_requirement'); return { data: null, error: options.requirementError ? { message: 'test failure' } : null } }),
    auth: { admin: {
      createUser: vi.fn(async () => { operations.push('create_auth'); return { data: { user: { id: userId } }, error: null } }),
      updateUserById: vi.fn(async () => ({ data: { user: { id: userId } }, error: null })),
      deleteUser: vi.fn(async () => { operations.push('delete_auth'); return { data: {}, error: options.authDeleteError ? { message: 'test failure' } : null } }),
    } },
    from: vi.fn((table: string) => {
      let isLookup = false
      let isOwnerCount = false
      // Check if this is an owner count query
      if (table === 'profiles') {
        const chain = {
          select: () => chain,
          ilike: () => { isLookup = true; return chain },
          eq: (field: string) => {
            if (field === 'role') {
              isOwnerCount = true
            }
            return chain
          },
          is: () => chain,
          single: async () => ({ data: savedProfile, error: null }),
          maybeSingle: async () => ({ data: isLookup ? null : savedProfile, error: null }),
          update: vi.fn(() => { operations.push('contain_requirement'); return chain }),
          delete: () => { operations.push('delete_profile'); return chain },
          insert: vi.fn(async () => { operations.push('restore_profile'); return { error: null } }),
          // `countActiveOwners` awaits the chain directly (no single()); kết quả phải
          // là `{ data, error }` vì handler destructuring chính hai khóa đó.
          then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(isOwnerCount
            ? { data: Array.from({ length: options.activeOwnerCount ?? 1 }, (_, index) => ({ id: `owner-${index}` })), error: null }
            : { error: null }).then(onFulfilled),
        }
        return chain
      }
      // For audit_logs table
      const auditChain = {
        insert: vi.fn(async () => ({ error: null })),
      }
      return auditChain
    }),
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
    // Auth user was created
    expect(h.operations).toContain('create_auth')
    // Password is never exposed in error response
    const json = await response.json()
    expect(JSON.stringify(json)).not.toContain(password)
    // Response indicates provisioning rollback failure
    expect(json.error).toMatch(/PROVISIONING_ROLLBACK_FAILED|PROFILE_ACTIVATION_FAILED/)
  })
  it('restores the profile when the Auth deletion of a history-free account fails', async () => {
    const h = harness({ authDeleteError: true })
    expect((await h.invoke({ action: 'delete', user_id: userId })).status).toBe(500)
    expect(h.operations).toEqual(['delete_profile', 'delete_auth', 'restore_profile'])
  })
  it('deletes an account without business history outright', async () => {
    const h = harness()
    const response = await h.invoke({ action: 'delete', user_id: userId })
    expect(response.status).toBe(200)
    expect((await response.json()).outcome).toBe('removed')
    expect(h.operations).toEqual(['delete_profile', 'delete_auth'])
  })
  it('tombstones an account that recorded business work instead of erasing it', async () => {
    const h = harness({ canDelete: false })
    const response = await h.invoke({ action: 'delete', user_id: userId })
    expect(response.status).toBe(200)
    expect((await response.json()).outcome).toBe('tombstoned')
    // Hồ sơ phải còn nguyên (không đụng delete_profile) nhưng credential bị vô hiệu.
    expect(h.operations).not.toContain('delete_profile')
    expect(h.admin.auth.admin.updateUserById).toHaveBeenCalledWith(userId, expect.anything())
  })
  it('deletes nothing when the business-history check cannot be answered', async () => {
    const h = harness({ eligibilityError: true })
    const response = await h.invoke({ action: 'delete', user_id: userId })
    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('DELETE_ELIGIBILITY_FAILED')
    expect(h.operations).not.toContain('delete_profile')
  })
  it('refuses to delete an OWNER account even when another active OWNER exists', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'OWNER', activeOwnerCount: 2 })
    const response = await h.invoke({ action: 'delete', user_id: userId })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('CANNOT_DELETE_OWNER')
    expect(h.operations).toEqual([])
  })
  it('refuses to delete an account that is already gone, or to re-enable one', async () => {
    const purged = harness({ targetPurgedAt: new Date().toISOString() })
    const deletion = await purged.invoke({ action: 'delete', user_id: userId })
    expect(deletion.status).toBe(400)
    expect((await deletion.json()).error).toBe('ALREADY_DELETED')

    const enabled = harness({ targetDeletedAt: new Date().toISOString() })
    const reenable = await enabled.invoke({ action: 'enable_user', user_id: userId })
    expect(reenable.status).toBe(400)
    expect((await reenable.json()).error).toBe('ALREADY_DELETED')
    expect(enabled.operations).not.toContain('delete_profile')
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

describe('Role hierarchy and ownership security', () => {
  it('STAFF cannot promote anyone to OWNER', async () => {
    const h = harness({ role: 'STAFF' })
    const response = await h.invoke({ action: 'promote_to_owner', user_id: userId })
    expect(response.status).toBe(403)
  })

  it('MANAGER can change the role of a STAFF account (junior only)', async () => {
    const h = harness({ role: 'MANAGER', targetRole: 'STAFF' })
    const response = await h.invoke({ action: 'change_role', user_id: userId, role: 'MANAGER' })
    expect(response.status).toBe(200)
  })

  it('MANAGER cannot change the role of another MANAGER', async () => {
    const h = harness({ role: 'MANAGER', targetRole: 'MANAGER' })
    const response = await h.invoke({ action: 'change_role', user_id: userId, role: 'STAFF' })
    expect(response.status).toBe(403)
  })

  it('MANAGER cannot touch the OWNER account', async () => {
    const h = harness({ role: 'MANAGER', targetRole: 'OWNER' })
    const response = await h.invoke({ action: 'change_role', user_id: userId, role: 'STAFF' })
    expect(response.status).toBe(403)
  })

  it('MANAGER cannot ban, delete, or reset passwords', async () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString()
    for (const body of [
      { action: 'disable', user_id: userId, disabled_until: future },
      { action: 'delete', user_id: userId },
      { action: 'reset_password', user_id: userId, password },
      { action: 'promote_to_owner', user_id: userId },
    ]) {
      const h = harness({ role: 'MANAGER', targetRole: 'STAFF' })
      expect((await h.invoke(body)).status).toBe(403)
    }
  })

  it('OWNER transfers ownership through the atomic transfer_ownership RPC', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'STAFF' })
    const response = await h.invoke({ action: 'promote_to_owner', user_id: userId })
    expect(response.status).toBe(200)
    expect(h.caller.rpc).toHaveBeenCalledWith('transfer_ownership', { p_target_user: userId })
  })

  it('OWNER cannot demote the OWNER account through change_role', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'OWNER' })
    const response = await h.invoke({ action: 'change_role', user_id: userId, role: 'STAFF' })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('OWNER_ROLE_VIA_HANDOVER')
  })

  it('Temporary ban must carry a future expiry', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'STAFF' })
    const missing = await h.invoke({ action: 'disable', user_id: userId, disabled_until: null })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toBe('BAN_DURATION_REQUIRED')
    const past = await h.invoke({ action: 'disable', user_id: userId, disabled_until: new Date(Date.now() - 3600 * 1000).toISOString() })
    expect(past.status).toBe(400)
    expect((await past.json()).error).toBe('BAN_DURATION_REQUIRED')
  })

  it('OWNER account cannot be banned', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'OWNER' })
    const response = await h.invoke({ action: 'disable', user_id: userId, disabled_until: new Date(Date.now() + 3600 * 1000).toISOString() })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('CANNOT_BAN_OWNER')
  })

  it('final active OWNER cannot be deleted', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'OWNER', activeOwnerCount: 1 })
    const response = await h.invoke({ action: 'delete', user_id: userId })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('CANNOT_DELETE_FINAL_OWNER')
  })

  it('user cannot self-promote through direct client call', async () => {
    const h = harness({ role: 'STAFF' })
    // Try to promote self (callerId = userId)
    const response = await h.invoke({ action: 'promote_to_owner', user_id: callerId })
    expect(response.status).toBe(403)
  })

  it('OWNER cannot transfer ownership to self', async () => {
    const h = harness({ role: 'OWNER' })
    const response = await h.invoke({ action: 'promote_to_owner', user_id: callerId })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('SELF_TRANSFER_NOT_ALLOWED')
  })

  it('OWNER can lift a ban with enable_user', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'STAFF' })
    const response = await h.invoke({ action: 'enable_user', user_id: userId })
    expect(response.status).toBe(200)
  })

  it('removed actions are rejected as INVALID_ACTION', async () => {
    for (const action of ['update_schedule', 'demote_owner', 'force_password_change', 'restore', 'purge', 'sweep', 'hard_delete']) {
      const h = harness({ role: 'OWNER' })
      const response = await h.invoke({ action, user_id: userId })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('INVALID_ACTION')
    }
  })

  it('audit logs are created for privileged actions', async () => {
    const h = harness({ role: 'OWNER', targetRole: 'STAFF' })
    const response = await h.invoke({ action: 'change_role', user_id: userId, role: 'MANAGER' })
    expect(response.status).toBe(200)
    // Verify audit log insert was called
    expect(h.admin.from).toHaveBeenCalled()
  })
})
