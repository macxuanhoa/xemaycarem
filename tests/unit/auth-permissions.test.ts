import { describe, expect, it } from 'vitest'
import { canFinance, canManage, canOperate, isOwner, roleLabels } from '@/lib/permissions'
import { FICTIONAL_PROFILES } from '../fixtures/fictional-data'
import type { Profile, Role } from '@/types'

describe('Role and Permission Security (Unit: UI and Permission Helpers)', () => {
  const makeProfile = (role: Role, can_view_financials = false, active = true): Profile => ({
    id: `test-${role.toLowerCase()}`,
    full_name: `Test ${role}`,
    username: `test${role.toLowerCase()}`,
    role,
    active,
    can_view_financials,
    must_change_password: false,
  })

  describe('OWNER role', () => {
    const owner = makeProfile('OWNER', true, true)

    it('has full access: finance, manage, operate, isOwner', () => {
      expect(isOwner(owner)).toBe(true)
      expect(canFinance(owner)).toBe(true)
      expect(canManage(owner)).toBe(true)
      expect(canOperate(owner)).toBe(true)
    })
  })

  describe('MANAGER role', () => {
    it('without financial permission: has operational and manage access, but NOT financial', () => {
      const manager = makeProfile('MANAGER', false, true)
      expect(isOwner(manager)).toBe(false)
      expect(canFinance(manager)).toBe(false)
      expect(canManage(manager)).toBe(true)
      expect(canOperate(manager)).toBe(true)
    })

    it('with explicit financial permission: can view financials', () => {
      const finManager = makeProfile('MANAGER', true, true)
      expect(isOwner(finManager)).toBe(false)
      expect(canFinance(finManager)).toBe(true)
      expect(canManage(finManager)).toBe(true)
      expect(canOperate(finManager)).toBe(true)
    })
  })

  describe('STAFF role', () => {
    it('has operational inventory access but CANNOT manage or view financials', () => {
      const staff = makeProfile('STAFF', false, true)
      expect(isOwner(staff)).toBe(false)
      expect(canFinance(staff)).toBe(false)
      expect(canManage(staff)).toBe(false)
      expect(canOperate(staff)).toBe(true)
    })

    it('cannot view financials even if can_view_financials is erroneously set true', () => {
      const staffWithFinFlag = makeProfile('STAFF', true, true)
      expect(canFinance(staffWithFinFlag)).toBe(false)
      expect(canManage(staffWithFinFlag)).toBe(false)
      expect(isOwner(staffWithFinFlag)).toBe(false)
    })
  })

  describe('VIEWER role', () => {
    it('is strictly read-only: cannot operate, cannot manage, cannot finance, not owner', () => {
      const viewer = makeProfile('VIEWER', false, true)
      expect(isOwner(viewer)).toBe(false)
      expect(canFinance(viewer)).toBe(false)
      expect(canManage(viewer)).toBe(false)
      expect(canOperate(viewer)).toBe(false)
    })

    it('remains denied even if can_view_financials is set true', () => {
      const viewerWithFinFlag = makeProfile('VIEWER', true, true)
      expect(canFinance(viewerWithFinFlag)).toBe(false)
      expect(canOperate(viewerWithFinFlag)).toBe(false)
    })
  })

  describe('Inactive accounts (active=false)', () => {
    it('denies ALL permissions for inactive OWNER', () => {
      const inactiveOwner = makeProfile('OWNER', true, false)
      expect(isOwner(inactiveOwner)).toBe(false)
      expect(canFinance(inactiveOwner)).toBe(false)
      expect(canManage(inactiveOwner)).toBe(false)
      expect(canOperate(inactiveOwner)).toBe(false)
    })

    it('denies ALL permissions for inactive MANAGER', () => {
      const inactiveManager = makeProfile('MANAGER', true, false)
      expect(isOwner(inactiveManager)).toBe(false)
      expect(canFinance(inactiveManager)).toBe(false)
      expect(canManage(inactiveManager)).toBe(false)
      expect(canOperate(inactiveManager)).toBe(false)
    })

    it('denies ALL permissions for inactive STAFF', () => {
      const inactiveStaff = makeProfile('STAFF', false, false)
      expect(isOwner(inactiveStaff)).toBe(false)
      expect(canFinance(inactiveStaff)).toBe(false)
      expect(canManage(inactiveStaff)).toBe(false)
      expect(canOperate(inactiveStaff)).toBe(false)
    })

    it('denies ALL permissions when profile is null or undefined (unauthenticated)', () => {
      expect(isOwner(null)).toBe(false)
      expect(canFinance(null)).toBe(false)
      expect(canManage(null)).toBe(false)
      expect(canOperate(null)).toBe(false)
    })
  })

  describe('Role Labels', () => {
    it('provides clear Vietnamese human-readable labels for all 4 roles', () => {
      expect(roleLabels.OWNER).toBe('Chủ cửa hàng')
      expect(roleLabels.MANAGER).toBe('Quản lý')
      expect(roleLabels.STAFF).toBe('Nhân viên')
      expect(roleLabels.VIEWER).toBe('Chỉ xem')
    })
  })

  describe('Fictional profile fixtures check', () => {
    it('correctly maps predefined fictional fixtures', () => {
      expect(canFinance(FICTIONAL_PROFILES.OWNER)).toBe(true)
      expect(canFinance(FICTIONAL_PROFILES.MANAGER_FINANCIAL)).toBe(true)
      expect(canFinance(FICTIONAL_PROFILES.MANAGER_OPERATIONAL)).toBe(false)
      expect(canOperate(FICTIONAL_PROFILES.STAFF)).toBe(true)
      expect(canOperate(FICTIONAL_PROFILES.VIEWER)).toBe(false)
      expect(canOperate(FICTIONAL_PROFILES.INACTIVE)).toBe(false)
    })
  })
})
