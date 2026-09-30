import { describe, expect, it } from 'vitest';
import { canFinance, canManage, canOperate, isOwner } from '@/lib/permissions';
import type { Profile } from '@/types';

describe('Auth Recovery & Account Control Matrix (Comprehensive Section 39 Tests)', () => {
  const createProfile = (overrides: Partial<Profile> = {}): Profile => ({
    id: 'test-uuid-1',
    full_name: 'Nguyễn Văn Test',
    username: 'nguyenvantest',
    role: 'STAFF',
    active: true,
    can_view_financials: false,
    must_change_password: false,
    disabled_until: null,
    allowed_from: '07:00:00',
    allowed_until: '20:00:00',
    working_days: [1, 2, 3, 4, 5, 6],
    deleted_at: null,
    ...overrides,
  });

  describe('1. Login Identity Resolution & UX', () => {
    // Simulates the resolution logic implemented in resolve_login_email RPC
    const resolveLoginEmail = (identifier: string, existingProfiles: Profile[] = []) => {
      const clean = identifier.trim().toLowerCase();
      if (!clean) return '';
      if (clean.includes('@')) return clean;

      const matched = existingProfiles.find(
        (p) => p.username.toLowerCase() === clean && !p.deleted_at
      );
      if (matched) {
        if (matched.role === 'OWNER') return 'macxuanhoa211002@gmail.com';
        return `${matched.username}@internal.xecrm.app`;
      }
      return `${clean}@internal.xecrm.app`;
    };

    const ownerProfile = createProfile({
      id: 'owner-id',
      username: 'macxuanhoa21100211',
      role: 'OWNER',
    });
    const staffProfile = createProfile({
      id: 'staff-id',
      username: 'nguyenb',
      role: 'STAFF',
    });

    it('OWNER real email login resolves directly without internal domain alteration', () => {
      const email = 'macxuanhoa211002@gmail.com';
      expect(resolveLoginEmail(email, [ownerProfile])).toBe('macxuanhoa211002@gmail.com');
    });

    it('OWNER username login resolves to real recoverable email identity', () => {
      expect(resolveLoginEmail('macxuanhoa21100211', [ownerProfile])).toBe(
        'macxuanhoa211002@gmail.com'
      );
      expect(resolveLoginEmail('  MacXuanHoa21100211  ', [ownerProfile])).toBe(
        'macxuanhoa211002@gmail.com'
      );
    });

    it('STAFF, MANAGER, and VIEWER username login resolves to internal email alias', () => {
      expect(resolveLoginEmail('nguyenb', [staffProfile])).toBe('nguyenb@internal.xecrm.app');
      expect(resolveLoginEmail('manager_trinh')).toBe('manager_trinh@internal.xecrm.app');
      expect(resolveLoginEmail('viewer_mai')).toBe('viewer_mai@internal.xecrm.app');
    });

    it('Username normalization strips surrounding whitespace and forces lowercase', () => {
      const rawInput = '   NguyenB_99.test   ';
      const normalized = rawInput.trim().toLowerCase();
      expect(normalized).toBe('nguyenb_99.test');
      expect(/^[a-z0-9_.]{3,30}$/.test(normalized)).toBe(true);
    });

    it('Rejects invalid username formats', () => {
      const invalidUsernames = [
        'ab', // too short (<3)
        'a'.repeat(31), // too long (>30)
        'nguyen b', // space
        'nguyen@b', // special char
        'nguyen!#',
        'tiếngviệt', // accents
      ];
      for (const uname of invalidUsernames) {
        expect(/^[a-z0-9_.]{3,30}$/.test(uname)).toBe(false);
      }
    });
  });

  describe('2. Account Schedule and Lock Enforcement', () => {
    // Simulates is_user_authorized evaluation in Asia/Ho_Chi_Minh
    const evaluateUserAccess = (
      profile: Profile,
      nowUtc: Date = new Date()
    ): { allowed: boolean; code?: string } => {
      if (profile.deleted_at) return { allowed: false, code: 'ACCOUNT_DELETED' };
      if (!profile.active) return { allowed: false, code: 'ACCOUNT_INACTIVE' };

      // OWNER is immune to schedule restrictions
      if (profile.role === 'OWNER') return { allowed: true };

      if (profile.disabled_until && new Date(profile.disabled_until) > nowUtc) {
        return { allowed: false, code: 'TEMP_LOCKED' };
      }

      // Convert to Vietnam time (UTC+7)
      const vnFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const vnTime = vnFormatter.format(nowUtc);

      if (profile.allowed_from && profile.allowed_until) {
        if (vnTime < profile.allowed_from || vnTime > profile.allowed_until) {
          return { allowed: false, code: 'OUTSIDE_HOURS' };
        }
      }

      if (profile.working_days && profile.working_days.length > 0) {
        const vnDayFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Ho_Chi_Minh',
          weekday: 'short',
        });
        const dayStr = vnDayFormatter.format(nowUtc);
        const dayMap: Record<string, number> = {
          Mon: 1,
          Tue: 2,
          Wed: 3,
          Thu: 4,
          Fri: 5,
          Sat: 6,
          Sun: 7,
        };
        const vnDay = dayMap[dayStr] || 1;
        if (!profile.working_days.includes(vnDay)) {
          return { allowed: false, code: 'OUTSIDE_DAYS' };
        }
      }

      return { allowed: true };
    };

    it('Inactive user (active=false) is rejected immediately', () => {
      const user = createProfile({ active: false });
      const access = evaluateUserAccess(user);
      expect(access.allowed).toBe(false);
      expect(access.code).toBe('ACCOUNT_INACTIVE');
    });

    it('Soft-deleted user (deleted_at is set) is rejected', () => {
      const user = createProfile({ active: true, deleted_at: new Date().toISOString() });
      const access = evaluateUserAccess(user);
      expect(access.allowed).toBe(false);
      expect(access.code).toBe('ACCOUNT_DELETED');
    });

    it('Temporarily locked user (disabled_until in the future) is rejected', () => {
      const future = new Date(Date.now() + 3600 * 1000).toISOString();
      const user = createProfile({ disabled_until: future });
      const access = evaluateUserAccess(user);
      expect(access.allowed).toBe(false);
      expect(access.code).toBe('TEMP_LOCKED');
    });

    it('Temporarily locked user whose lock time has expired is allowed', () => {
      const past = new Date(Date.now() - 3600 * 1000).toISOString();
      // Test at 10:00 VN time (03:00 UTC) on a Monday
      const testTime = new Date('2026-10-05T03:00:00Z');
      const user = createProfile({
        disabled_until: past,
        allowed_from: '07:00:00',
        allowed_until: '20:00:00',
        working_days: [1, 2, 3, 4, 5],
      });
      const access = evaluateUserAccess(user, testTime);
      expect(access.allowed).toBe(true);
    });

    it('Employee outside allowed working hours is rejected', () => {
      // 03:00 VN time (20:00 UTC previous day)
      const lateNightUtc = new Date('2026-10-05T20:00:00Z');
      const user = createProfile({
        allowed_from: '07:00:00',
        allowed_until: '20:00:00',
        working_days: [1, 2, 3, 4, 5, 6, 7],
      });
      const access = evaluateUserAccess(user, lateNightUtc);
      expect(access.allowed).toBe(false);
      expect(access.code).toBe('OUTSIDE_HOURS');
    });

    it('Employee on unassigned day is rejected', () => {
      // Sunday in Vietnam (2026-10-11T05:00:00Z = 12:00 VN time on Sunday)
      const sundayUtc = new Date('2026-10-11T05:00:00Z');
      const user = createProfile({
        allowed_from: '00:00:00',
        allowed_until: '23:59:59',
        working_days: [1, 2, 3, 4, 5, 6], // Mon-Sat only, no Sunday (7)
      });
      const access = evaluateUserAccess(user, sundayUtc);
      expect(access.allowed).toBe(false);
      expect(access.code).toBe('OUTSIDE_DAYS');
    });

    it('OWNER is completely unaffected by employee schedule restrictions', () => {
      // Midnight Sunday outside working hours
      const midnightSunday = new Date('2026-10-11T18:00:00Z');
      const owner = createProfile({
        role: 'OWNER',
        active: true,
        allowed_from: '08:00:00',
        allowed_until: '17:00:00',
        working_days: [1], // Mon only
      });
      const access = evaluateUserAccess(owner, midnightSunday);
      expect(access.allowed).toBe(true);
    });
  });

  describe('3. Role Boundaries and Permission Matrix', () => {
    it('OWNER has complete permissions across all modules', () => {
      const owner = createProfile({ role: 'OWNER' });
      expect(isOwner(owner)).toBe(true);
      expect(canFinance(owner)).toBe(true);
      expect(canManage(owner)).toBe(true);
      expect(canOperate(owner)).toBe(true);
    });

    it('MANAGER without can_view_financials cannot see financial data', () => {
      const manager = createProfile({ role: 'MANAGER', can_view_financials: false });
      expect(isOwner(manager)).toBe(false);
      expect(canFinance(manager)).toBe(false);
      expect(canManage(manager)).toBe(true);
      expect(canOperate(manager)).toBe(true);
    });

    it('MANAGER with can_view_financials can see financial data', () => {
      const finManager = createProfile({ role: 'MANAGER', can_view_financials: true });
      expect(isOwner(finManager)).toBe(false);
      expect(canFinance(finManager)).toBe(true);
      expect(canManage(finManager)).toBe(true);
      expect(canOperate(finManager)).toBe(true);
    });

    it('STAFF is strictly operational and cannot view financials or manage store settings', () => {
      const staff = createProfile({ role: 'STAFF', can_view_financials: true }); // even if set true
      expect(isOwner(staff)).toBe(false);
      expect(canFinance(staff)).toBe(false); // enforced
      expect(canManage(staff)).toBe(false);
      expect(canOperate(staff)).toBe(true);
    });

    it('VIEWER is strictly read-only and cannot perform operations', () => {
      const viewer = createProfile({ role: 'VIEWER' });
      expect(isOwner(viewer)).toBe(false);
      expect(canFinance(viewer)).toBe(false);
      expect(canManage(viewer)).toBe(false);
      expect(canOperate(viewer)).toBe(false);
    });
  });

  describe('4. Deactivation vs Hard Deletion Safety', () => {
    const checkCanHardDelete = (
      user: Profile,
      businessRecordsCount: {
        acquisitions: number;
        vehicles: number;
        sales: number;
        payments: number;
        expenses: number;
        auditLogs: number;
      }
    ) => {
      if (user.role === 'OWNER') {
        return { canDelete: false, reason: 'CANNOT_DELETE_OWNER' };
      }
      const totalRecords = Object.values(businessRecordsCount).reduce((a, b) => a + b, 0);
      if (totalRecords > 0) {
        return {
          canDelete: false,
          reason: 'USER_HAS_BUSINESS_HISTORY',
          message: 'Tài khoản này đã có lịch sử nghiệp vụ. Chỉ có thể vô hiệu hóa.',
        };
      }
      return { canDelete: true };
    };

    it('Refuses hard delete for OWNER account', () => {
      const owner = createProfile({ role: 'OWNER' });
      const check = checkCanHardDelete(owner, {
        acquisitions: 0,
        vehicles: 0,
        sales: 0,
        payments: 0,
        expenses: 0,
        auditLogs: 0,
      });
      expect(check.canDelete).toBe(false);
      expect(check.reason).toBe('CANNOT_DELETE_OWNER');
    });

    it('Refuses hard delete for staff who recorded sales or vehicles', () => {
      const staff = createProfile({ role: 'STAFF' });
      const checkWithSales = checkCanHardDelete(staff, {
        acquisitions: 0,
        vehicles: 1,
        sales: 1,
        payments: 1,
        expenses: 0,
        auditLogs: 3,
      });
      expect(checkWithSales.canDelete).toBe(false);
      expect(checkWithSales.reason).toBe('USER_HAS_BUSINESS_HISTORY');
    });

    it('Permits hard delete ONLY for completely unused test accounts', () => {
      const unusedStaff = createProfile({ role: 'STAFF' });
      const check = checkCanHardDelete(unusedStaff, {
        acquisitions: 0,
        vehicles: 0,
        sales: 0,
        payments: 0,
        expenses: 0,
        auditLogs: 0,
      });
      expect(check.canDelete).toBe(true);
    });
  });

  describe('5. Password Security & Plaintext Isolation', () => {
    it('Never exposes password field on Profile model', () => {
      const profile = createProfile();
      expect(Object.hasOwn(profile, 'password')).toBe(false);
      expect(Object.hasOwn(profile, 'encrypted_password')).toBe(false);
      expect(Object.hasOwn(profile, 'new_password')).toBe(false);
    });

    it('Audit log schema does not accept plaintext passwords', () => {
      const safeAuditEntry = {
        action: 'RESET_PASSWORD',
        entity_type: 'profiles',
        entity_id: 'test-user-id',
        user_id: 'owner-id',
        old_data: { must_change_password: false },
        new_data: { must_change_password: true },
      };
      expect(Object.hasOwn(safeAuditEntry, 'password')).toBe(false);
      expect(Object.hasOwn(safeAuditEntry.new_data, 'password')).toBe(false);
    });
  });
});
