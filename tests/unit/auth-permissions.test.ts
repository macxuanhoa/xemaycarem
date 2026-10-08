import { describe, expect, it } from 'vitest'
import { canDeleteVehicle, canFinance, canManage, canManageVehicleExpenses, canOperate, canRequestVehicleDelete, isOwner, roleLabels } from '@/lib/permissions'
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

  describe('canDeleteVehicle (hard-delete gate)', () => {
    it('allows OWNER and MANAGER regardless of financial flag', () => {
      expect(canDeleteVehicle(makeProfile('OWNER', true))).toBe(true)
      expect(canDeleteVehicle(makeProfile('MANAGER', false))).toBe(true)
      expect(canDeleteVehicle(makeProfile('MANAGER', true))).toBe(true)
    })

    it('denies STAFF, inactive high-level accounts, and unauthenticated users', () => {
      expect(canDeleteVehicle(makeProfile('STAFF', true))).toBe(false)
      expect(canDeleteVehicle(makeProfile('OWNER', true, false))).toBe(false)
      expect(canDeleteVehicle(makeProfile('MANAGER', true, false))).toBe(false)
      expect(canDeleteVehicle(null)).toBe(false)
    })
  })

  describe('canManageVehicleExpenses (STAFF vehicle-expense parity)', () => {
    it('opens vehicle expenses to every active operator (STAFF parity with MANAGER)', () => {
      expect(canManageVehicleExpenses(makeProfile('OWNER', true))).toBe(true)
      expect(canManageVehicleExpenses(makeProfile('MANAGER', false))).toBe(true)
      expect(canManageVehicleExpenses(makeProfile('STAFF', false))).toBe(true)
    })

    it('denies inactive accounts and unauthenticated users', () => {
      expect(canManageVehicleExpenses(makeProfile('STAFF', false, false))).toBe(false)
      expect(canManageVehicleExpenses(null)).toBe(false)
    })
  })

  describe('canRequestVehicleDelete (STAFF delete-request gate)', () => {
    it('is exclusive to active STAFF (MANAGER/OWNER keep the direct delete instead)', () => {
      expect(canRequestVehicleDelete(makeProfile('STAFF', false))).toBe(true)
      expect(canRequestVehicleDelete(makeProfile('MANAGER', true))).toBe(false)
      expect(canRequestVehicleDelete(makeProfile('OWNER', true))).toBe(false)
    })

    it('denies inactive STAFF and unauthenticated users', () => {
      expect(canRequestVehicleDelete(makeProfile('STAFF', false, false))).toBe(false)
      expect(canRequestVehicleDelete(null)).toBe(false)
    })

    it('request-based delete never grants the direct purge to STAFF', () => {
      const staff = makeProfile('STAFF', false)
      expect(canRequestVehicleDelete(staff)).toBe(true)
      expect(canDeleteVehicle(staff)).toBe(false)
    })
  })

  describe('Role Labels', () => {
    it('provides clear Vietnamese human-readable labels for all 3 roles', () => {
      expect(roleLabels.OWNER).toBe('Chủ cửa hàng')
      expect(roleLabels.MANAGER).toBe('Quản lý')
      expect(roleLabels.STAFF).toBe('Nhân viên')
    })
  })

  describe('Fictional profile fixtures check', () => {
    it('correctly maps predefined fictional fixtures', () => {
      expect(canFinance(FICTIONAL_PROFILES.OWNER)).toBe(true)
      expect(canFinance(FICTIONAL_PROFILES.MANAGER_FINANCIAL)).toBe(true)
      expect(canFinance(FICTIONAL_PROFILES.MANAGER_OPERATIONAL)).toBe(false)
      expect(canOperate(FICTIONAL_PROFILES.STAFF)).toBe(true)
      expect(canOperate(FICTIONAL_PROFILES.INACTIVE)).toBe(false)
    })
  })
})
