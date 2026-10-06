// Edge Function: manage-users
// Secure administrative user management for Xe CRM.
// OWNER performs all account administration; MANAGER may only re-assign the
// role of STAFF accounts (their juniors). No service role key is exposed to browser.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2.117.2/cors';

export { corsHeaders };

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');

// Số ngày giữ tài khoản trong thùng rác trước khi dọn vĩnh viễn (purge/sweep).
const TRASH_RETENTION_DAYS = 30;

// CORS origin policy. Production deployments MUST set ALLOWED_ORIGINS to a
// comma-separated list of exact browser origins (no trailing slashes), e.g.
//   https://carem.example,http://127.0.0.1:5173
// Requests from any other origin receive no Access-Control-Allow-Origin header,
// so the browser blocks the response. When unset (local development only) the
// Supabase SDK default headers are used; authentication and role checks still
// apply to every POST.
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function corsFor(request: Request): Record<string, string> {
  if (allowedOrigins.length === 0) return corsHeaders;
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '300',
  };
}

Deno.serve(async (request: Request) => {
  // Handle preflight OPTIONS request before any auth or business logic
  if (request.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsFor(request) });
  }

  const response = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsFor(request),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });

  if (request.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' });
  if (!url || !anonKey || !serviceKey) return response(503, { error: 'SERVER_CONFIGURATION_REQUIRED' });

  try {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return response(401, { error: 'AUTH_REQUIRED' });

    // Caller client operates with the user's JWT to verify identity and role
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await caller.auth.getUser(authorization.slice(7));
    if (authError || !authData.user) return response(401, { error: 'AUTH_REQUIRED' });

    const { data: profile, error: profileError } = await caller
      .from('profiles')
      .select('role, active, deleted_at')
      .eq('id', authData.user.id)
      .single();
    const callerRole = profile?.role;
    if (profileError || !['OWNER', 'MANAGER'].includes(callerRole ?? '') || !profile.active || profile?.deleted_at) {
      return response(403, { error: 'ACCESS_DENIED' });
    }
    const { data: access, error: accessError } = await caller.rpc('check_user_access');
    if (accessError || !access?.allowed || access.must_change_password) {
      return response(403, { error: 'ACCESS_DENIED' });
    }
    // Every action except role management of juniors is OWNER-only.
    const requireOwner = () => response(403, { error: 'ACCESS_DENIED' });

    // Parse and validate input payload
    const text = await request.text();
    if (text.length > 16384) return response(413, { error: 'INPUT_TOO_LARGE' });
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return response(400, { error: 'INVALID_INPUT' });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return response(400, { error: 'INVALID_INPUT' });
    }

    const action = typeof body.action === 'string' ? body.action : 'create';
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = typeof body.role === 'string' ? body.role : 'STAFF';
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    if (action !== 'create' && action !== 'sweep' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return response(400, { error: 'INVALID_USER_ID' });
    }

    const disabledUntil = typeof body.disabled_until === 'string' ? body.disabled_until : null;
    const disableReason = typeof body.disable_reason === 'string' ? body.disable_reason : null;

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Helper: Count active OWNER accounts
    const countActiveOwners = async (): Promise<number> => {
      const { data, error } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'OWNER')
        .eq('active', true)
        .is('deleted_at', null);
      if (error) throw error;
      return data?.length ?? 0;
    };

    // Helper: load the current target profile for guards and audit
    const loadTargetProfile = async (): Promise<Record<string, unknown> | Response> => {
      const { data, error } = await admin
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (error || !data) return response(404, { error: 'USER_NOT_FOUND', message: 'Không tìm thấy người dùng.' });
      return data as Record<string, unknown>;
    };

    // Helper: Audit log privileged action
    const auditAction = async (
      action: string,
      targetUserId: string,
      oldData: Record<string, unknown> | null,
      newData: Record<string, unknown> | null
    ): Promise<void> => {
      try {
        // Insert directly into audit_logs using service role
        await admin.from('audit_logs').insert({
          user_id: authData.user.id,
          action,
          entity_type: 'profiles',
          entity_id: targetUserId,
          old_data: oldData,
          new_data: newData,
        });
      } catch (error) {
        console.error('Audit logging failed', { action, targetUserId, error });
        // Audit failure should not block the action itself
      }
    };

    // Helper: dọn vĩnh viễn MỘT tài khoản đang trong thùng rác.
    //   * check_user_can_hard_delete.can_delete = true  -> xóa sạch profile + auth.
    //   * can_delete = false (đã có lịch sử)            -> tombstone: giữ profile, đặt purged_at.
    // Dùng service-role để bỏ qua gate update_profile; KHÔNG xóa raw auth.users.
    const purgeOne = async (
      target: Record<string, unknown>
    ): Promise<{ outcome: 'deleted' | 'tombstoned' | 'already' | 'failed'; error?: Response }> => {
      const id = String(target.id);
      if (target.purged_at) return { outcome: 'already' };

      const { data: check, error: checkError } = await caller.rpc('check_user_can_hard_delete', { p_user_id: id });
      if (checkError) {
        return { outcome: 'failed', error: response(500, { error: 'PURGE_CHECK_FAILED', message: 'Không kiểm tra được điều kiện xóa vĩnh viễn.' }) };
      }

      if (check?.can_delete) {
        // Lưu profile đầy đủ để rollback nếu xóa auth thất bại (auth và Postgres không chung transaction).
        const { data: savedProfile } = await admin.from('profiles').select('*').eq('id', id).single();
        const { error: profileDeleteError } = await admin.from('profiles').delete().eq('id', id);
        if (profileDeleteError) {
          console.error('Purge profile deletion failed', profileDeleteError);
          return { outcome: 'failed', error: response(500, { error: 'PROFILE_DELETE_FAILED', message: 'Không thể xóa hồ sơ người dùng.' }) };
        }
        const { error: authDeleteError } = await admin.auth.admin.deleteUser(id);
        if (authDeleteError) {
          console.error('Purge auth deletion failed', authDeleteError);
          if (savedProfile) {
            const { error: restoreError } = await admin.from('profiles').insert(savedProfile);
            if (restoreError) console.error('Purge profile restoration requires repair', { id });
          }
          return { outcome: 'failed', error: response(500, { error: 'AUTH_DELETE_FAILED', message: 'Không thể xóa tài khoản xác thực.' }) };
        }
        await auditAction('HARD_DELETE_USER', id, { username: target.username }, null);
        return { outcome: 'deleted' };
      }

      const now = new Date().toISOString();
      const { error: tombstoneError } = await admin.from('profiles').update({ purged_at: now }).eq('id', id);
      if (tombstoneError) {
        console.error('Purge tombstone failed', tombstoneError);
        return { outcome: 'failed', error: response(500, { error: 'PURGE_TOMBSTONE_FAILED', message: 'Không thể đánh dấu xóa vĩnh viễn.' }) };
      }
      await auditAction('PURGE_USER', id, { deleted_at: target.deleted_at }, { purged_at: now });
      return { outcome: 'tombstoned' };
    };

    // 1. CREATE USER (OWNER ONLY). New accounts follow the shared staff schedule.
    if (action === 'create') {
      if (callerRole !== 'OWNER') return requireOwner();

      // Validate username format: 3-30 chars, lowercase, letters/numbers/underscore/dot only
      if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
        return response(400, { error: 'INVALID_USERNAME', message: 'Tên đăng nhập từ 3-30 ký tự (chữ thường, số, _, .)' });
      }

      // Prohibit creating OWNER through normal user provisioning
      if (!['MANAGER', 'STAFF'].includes(role)) {
        return response(400, { error: 'INVALID_ROLE', message: 'Chỉ có thể tạo vai trò Quản lý hoặc Nhân viên.' });
      }

      if (fullName.length < 1 || fullName.length > 120) {
        return response(400, { error: 'INVALID_NAME', message: 'Họ và tên từ 1 đến 120 ký tự.' });
      }

      if (password.length < 6 || password.length > 128) {
        return response(400, { error: 'INVALID_PASSWORD', message: 'Mật khẩu từ 6 đến 128 ký tự.' });
      }

      // Check username uniqueness beforehand
      const { data: existingProfile, error: lookupError } = await admin
        .from('profiles')
        .select('id')
        .ilike('username', username)
        .maybeSingle();
      if (lookupError) {
        console.error('Lookup error:', lookupError);
        return response(503, { error: 'USER_LOOKUP_FAILED', details: lookupError.message || lookupError });
      }
      if (existingProfile) {
        return response(400, { error: 'USERNAME_EXISTS', message: 'Tên đăng nhập đã tồn tại trong hệ thống.' });
      }

      // Generate internal Supabase Auth email identity for staff
      const internalEmail = `${username}@internal.xecrm.app`;

      // Create Auth user
      const { data: createdAuth, error: createAuthError } = await admin.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, username },
      });

      if (createAuthError || !createdAuth.user) {
        console.error('User provisioning failed', createAuthError);
        // GoTrue surfaces policy errors (e.g. minimum password length) in
        // English. Never forward them raw — map the known ones and fall back
        // to a neutral Vietnamese message so the UI stays in one language.
        const raw = createAuthError?.message ?? '';
        const pwMin = /password should be at least (\d+) characters?/i.exec(raw);
        const friendly = pwMin
          ? `Mật khẩu phải có ít nhất ${pwMin[1]} ký tự.`
          : /already|exists|duplicate/i.test(raw)
            ? 'Tài khoản với thông tin này đã tồn tại.'
            : 'Không thể tạo tài khoản. Vui lòng kiểm tra lại thông tin.';
        return response(400, { error: 'USER_CREATION_FAILED', message: friendly });
      }

      const newUserId = createdAuth.user.id;

      // Activate profile with chosen configuration and controls.
      // Per shop-owner product decision (docs/DECISIONS.md): a freshly
      // provisioned account must sign straight into the app — no
      // /change-password interstitial on first login. The auth trigger
      // `private.new_auth_user` already defaults must_change_password = false,
      // so we intentionally do NOT override it here. Administrative
      // `reset_password` below still gates with the flag (fail-closed).
      const { error: profileError } = await caller.rpc('update_profile', {
        p_id: newUserId,
        p_data: {
          full_name: fullName,
          role,
          active: true,
          can_view_financials: body.can_view_financials === true,
          username,
        },
      });

      if (profileError) {
        console.error('Profile activation failed, rolling back Auth user', { id: newUserId, error: profileError });
        // Safe rollback: eliminate orphaned Auth user so no inconsistent state is left behind
        const { data: inactiveProfile, error: rollbackLookupError } = await admin.from('profiles').select('*').eq('id', newUserId).maybeSingle();
        if (rollbackLookupError || inactiveProfile?.active) {
          return response(500, { error: 'PROVISIONING_ROLLBACK_FAILED', message: 'Chưa thể xác nhận trạng thái tài khoản. Vui lòng kiểm tra trước khi tạo lại.' });
        }
        const { error: rollbackProfileError } = await admin.from('profiles').delete().eq('id', newUserId);
        if (rollbackProfileError) return response(500, { error: 'PROVISIONING_ROLLBACK_FAILED' });
        const { error: rollbackError } = await admin.auth.admin.deleteUser(newUserId);
        if (rollbackError) {
          if (inactiveProfile) await admin.from('profiles').insert(inactiveProfile);
          console.error('Inactive provisioning rollback requires repair', { id: newUserId });
          return response(500, { error: 'PROVISIONING_ROLLBACK_FAILED', message: 'Chưa thể hoàn tất tạo tài khoản. Hồ sơ chưa được kích hoạt; vui lòng thử lại.' });
        }
        return response(500, { error: 'PROFILE_ACTIVATION_FAILED', message: 'Lỗi kích hoạt hồ sơ tài khoản. Đã hoàn tác an toàn.' });
      }

      // Audit user creation
      await auditAction('CREATE_USER', newUserId, null, { username, full_name: fullName, role });

      return response(201, { id: newUserId, username });
    }

    // 2. RESET TEMPORARY PASSWORD (OWNER ONLY)
    if (action === 'reset_password') {
      if (callerRole !== 'OWNER') return requireOwner();
      if (password.length < 6 || password.length > 128) {
        return response(400, { error: 'INVALID_INPUT', message: 'Mật khẩu từ 6 đến 128 ký tự.' });
      }
      if (userId === authData.user.id) {
        return response(400, { error: 'SELF_RESET_NOT_ALLOWED', message: 'Dùng chức năng đổi mật khẩu hoặc khôi phục qua email cho tài khoản của bạn.' });
      }
      // Gate existing sessions before changing Auth credentials. A pending reset
      // cannot complete password change until its new temporary hash is recorded.
      const { error: beginError } = await caller.rpc('require_password_change', {
        p_user_id: userId, p_reset_pending: true,
      });
      if (beginError) return response(500, { error: 'PASSWORD_REQUIREMENT_FAILED', message: 'Chưa thể kiểm soát truy cập; mật khẩu chưa được thay đổi.' });

      // Use Supabase Admin API to update password securely (no raw SQL password writes)
      const { error: resetError } = await admin.auth.admin.updateUserById(userId, { password });
      if (resetError) {
        await admin.rpc('require_password_change', { p_user_id: userId, p_reset_pending: false });
        console.error('Password reset failed', resetError);
        return response(400, { error: 'PASSWORD_RESET_FAILED', message: 'Không thể đặt lại mật khẩu.' });
      }

      // Require user to change temporary password on next login
      const { error: requirementError } = await admin.rpc('require_password_change', {
        p_user_id: userId, p_reset_pending: false,
      });
      if (requirementError) {
        // A reset is never reported as complete unless server-side change gating
        // was saved. Fail closed if the administrative RPC unexpectedly fails.
        console.error('Password requirement failed; account remains gated', { id: userId });
        return response(500, { error: 'PASSWORD_REQUIREMENT_FAILED', message: 'Mật khẩu đã thay đổi nhưng chưa hoàn tất kiểm soát truy cập. Vui lòng kiểm tra tài khoản trước khi tiếp tục.' });
      }

      // Audit password reset (without logging the password itself)
      await auditAction('RESET_TEMP_PASSWORD', userId, null, { must_change_password: true });

      return response(200, { success: true, message: 'Đã đặt lại mật khẩu tạm thành công.' });
    }

    // 3. TEMPORARY USAGE BAN (OWNER ONLY) — always bounded by an expiry.
    // The account stays "active"; check_user_access rejects logins until then.
    if (action === 'disable') {
      if (callerRole !== 'OWNER') return requireOwner();
      if (!disabledUntil || isNaN(Date.parse(disabledUntil)) || Date.parse(disabledUntil) <= Date.now()) {
        return response(400, { error: 'BAN_DURATION_REQUIRED', message: 'Lệnh cấm phải có thời điểm kết thúc trong tương lai.' });
      }

      const currentProfile = await loadTargetProfile();
      if (currentProfile instanceof Response) return currentProfile;
      if (currentProfile.role === 'OWNER') {
        return response(400, { error: 'CANNOT_BAN_OWNER', message: 'Không thể cấm tài khoản Chủ cửa hàng.' });
      }

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: {
          active: true,
          disabled_until: disabledUntil,
          disable_reason: disableReason || null,
        },
      });
      if (error) {
        console.error('Ban failed', error);
        return response(400, { error: 'USER_BAN_FAILED', message: error.message });
      }

      // Audit the ban action
      await auditAction(
        'TEMP_BAN_USER',
        userId,
        { disabled_until: currentProfile.disabled_until, disable_reason: currentProfile.disable_reason },
        { disabled_until: disabledUntil, disable_reason: disableReason || null }
      );

      return response(200, { success: true });
    }

    // 4. RESTORE / ACTIVATE ACCOUNT (OWNER ONLY)
    if (action === 'restore') {
      if (callerRole !== 'OWNER') return requireOwner();

      const currentProfile = await loadTargetProfile();
      if (currentProfile instanceof Response) return currentProfile;

      // Đã dọn vĩnh viễn -> không bao giờ khôi phục được.
      if (currentProfile.purged_at) {
        return response(400, { error: 'ALREADY_PURGED', message: 'Tài khoản đã xóa vĩnh viễn, không thể khôi phục.' });
      }
      // Quá cửa sổ 30 ngày trong thùng rác -> hết hạn khôi phục.
      const deletedAtMs = currentProfile.deleted_at ? new Date(String(currentProfile.deleted_at)).getTime() : NaN;
      if (!Number.isNaN(deletedAtMs) && Date.now() - deletedAtMs > TRASH_RETENTION_DAYS * 86400000) {
        return response(400, { error: 'RESTORE_WINDOW_EXPIRED', message: 'Đã quá 30 ngày trong thùng rác, không thể khôi phục.' });
      }

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: {
          active: true,
          deleted_at: null,
          disabled_until: null,
          disable_reason: null,
        },
      });
      if (error) {
        console.error('Restore failed', error);
        return response(400, { error: 'USER_RESTORE_FAILED', message: error.message });
      }

      // Audit the restore action
      await auditAction('ENABLE_USER', userId, { active: currentProfile.active, deleted_at: currentProfile.deleted_at }, { active: true, deleted_at: null });

      return response(200, { success: true });
    }

    // 5. DELETE ACCOUNT = SOFT DEACTIVATE (Preserves historical attribution)
    if (action === 'delete') {
      if (callerRole !== 'OWNER') return requireOwner();

      const currentProfile = await loadTargetProfile();
      if (currentProfile instanceof Response) return currentProfile;

      // Prevent deleting the final active OWNER
      if (currentProfile.role === 'OWNER' && currentProfile.active) {
        const activeOwnerCount = await countActiveOwners();
        if (activeOwnerCount <= 1) {
          return response(400, { error: 'CANNOT_DELETE_FINAL_OWNER', message: 'Không thể xóa Chủ cửa hàng cuối cùng. Hệ thống phải có một Chủ cửa hàng hoạt động.' });
        }
      }

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: {
          active: false,
          deleted_at: new Date().toISOString(),
          disable_reason: disableReason || 'Xóa bởi chủ cửa hàng',
        },
      });
      if (error) {
        console.error('Delete (deactivate) failed', error);
        return response(400, { error: 'USER_DELETE_FAILED', message: error.message });
      }

      // Audit the delete action
      await auditAction('DISABLE_USER', userId, { active: currentProfile.active, deleted_at: currentProfile.deleted_at }, { active: false, deleted_at: new Date().toISOString() });

      return response(200, { success: true });
    }

    // 6. HARD DELETE UNUSED ACCOUNT ONLY (Refused if any business history exists)
    if (action === 'hard_delete') {
      if (callerRole !== 'OWNER') return requireOwner();

      // Check whether user has ever participated in store operations
      const { data: checkData, error: checkError } = await caller.rpc('check_user_can_hard_delete', {
        p_user_id: userId,
      });

      if (checkError || !checkData?.can_delete) {
        return response(400, {
          error: checkData?.reason || 'CANNOT_HARD_DELETE',
          message: checkData?.message || 'Tài khoản đã có lịch sử nghiệp vụ. Chỉ có thể xóa tài khoản (giữ lịch sử).',
        });
      }

      const { data: savedProfile, error: savedProfileError } = await admin.from('profiles').select('*').eq('id', userId).single();
      if (savedProfileError || !savedProfile) return response(500, { error: 'PROFILE_NOT_FOUND' });

      // Delete profile first to satisfy ON DELETE RESTRICT on auth.users foreign key
      const { error: profileDeleteError } = await admin.from('profiles').delete().eq('id', userId);
      if (profileDeleteError) {
        console.error('Profile deletion failed', profileDeleteError);
        return response(500, { error: 'PROFILE_DELETE_FAILED', message: 'Không thể xóa hồ sơ người dùng.' });
      }

      // Delete Auth user
      const { error: authDeleteError } = await admin.auth.admin.deleteUser(userId);
      if (authDeleteError) {
        console.error('Auth user deletion failed', authDeleteError);
        // Auth Admin and PostgreSQL do not share one transaction. Restore the
        // profile if Auth deletion fails so the account cannot become orphaned.
        const { error: restoreError } = await admin.from('profiles').insert(savedProfile);
        if (restoreError) console.error('Profile restoration requires repair', { id: userId });
        return response(500, { error: 'AUTH_DELETE_FAILED', message: 'Không thể xóa tài khoản xác thực.' });
      }

      await auditAction('HARD_DELETE_USER', userId, { username: savedProfile.username }, null);

      return response(200, { success: true, message: 'Đã xóa hoàn toàn tài khoản chưa sử dụng.' });
    }

    // 6b. PURGE A TRASHED ACCOUNT PERMANENTLY (OWNER ONLY)
    //     Chưa có lịch sử -> xóa sạch; đã có lịch sử -> tombstone (giữ dữ liệu, chặn đăng nhập).
    if (action === 'purge') {
      if (callerRole !== 'OWNER') return requireOwner();

      const currentProfile = await loadTargetProfile();
      if (currentProfile instanceof Response) return currentProfile;

      if (currentProfile.role === 'OWNER') {
        return response(400, { error: 'CANNOT_DELETE_OWNER', message: 'Không thể xóa vĩnh viễn tài khoản Chủ cửa hàng.' });
      }
      if (!currentProfile.deleted_at) {
        return response(400, { error: 'NOT_IN_TRASH', message: 'Tài khoản chưa nằm trong thùng rác.' });
      }

      const result = await purgeOne(currentProfile);
      if (result.error) return result.error;
      if (result.outcome === 'already') {
        return response(400, { error: 'ALREADY_PURGED', message: 'Tài khoản đã xóa vĩnh viễn.' });
      }
      return response(200, { success: true, outcome: result.outcome });
    }

    // 6c. SWEEP THE TRASH: dọn mọi tài khoản quá hạn lưu (OWNER ONLY).
    //     Chạy khi OWNER mở trang Nhân sự (Supabase free plan không có scheduler).
    if (action === 'sweep') {
      if (callerRole !== 'OWNER') return requireOwner();

      const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86400000).toISOString();
      const { data: expired, error: listError } = await admin
        .from('profiles')
        .select('id, username, deleted_at, purged_at, role')
        .not('deleted_at', 'is', null)
        .lt('deleted_at', cutoff)
        .is('purged_at', null);
      if (listError) {
        console.error('Sweep listing failed', listError);
        return response(500, { error: 'SWEEP_LIST_FAILED', message: 'Không thể quét thùng rác.' });
      }

      let fullyDeleted = 0;
      let tombstonedCount = 0;
      for (const row of expired ?? []) {
        if (row.role === 'OWNER') continue;
        const result = await purgeOne(row);
        if (result.outcome === 'deleted') fullyDeleted += 1;
        else if (result.outcome === 'tombstoned') tombstonedCount += 1;
        else if (result.outcome === 'failed') console.error('Sweep purge skipped', { id: row.id });
      }
      return response(200, { success: true, fully_deleted: fullyDeleted, tombstoned: tombstonedCount });
    }

    // 7. CHANGE ROLE (OWNER for anyone below OWNER; MANAGER only for STAFF accounts)
    if (action === 'change_role') {
      if (!['STAFF', 'MANAGER'].includes(role)) {
        return response(400, { error: 'INVALID_ROLE', message: 'Vai trò không hợp lệ. Chỉ có thể thay đổi thành Nhân viên hoặc Quản lý.' });
      }

      const currentProfile = await loadTargetProfile();
      if (currentProfile instanceof Response) return currentProfile;

      if (userId === authData.user.id) {
        return response(400, { error: 'SELF_ROLE_CHANGE_NOT_ALLOWED', message: 'Không thể tự thay đổi vai trò của chính bạn.' });
      }

      if (callerRole === 'MANAGER') {
        // A manager may only re-assign roles of STAFF accounts (their juniors).
        if (currentProfile.role !== 'STAFF') return requireOwner();
      } else if (currentProfile.role === 'OWNER') {
        // OWNER accounts change only through the ownership handover flow.
        return response(400, { error: 'OWNER_ROLE_VIA_HANDOVER', message: 'Tài khoản Chủ cửa hàng chỉ thay đổi qua chuyển giao quyền.' });
      }

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: { role },
      });
      if (error) {
        console.error('Role change failed', error);
        return response(400, { error: 'ROLE_CHANGE_FAILED', message: error.message });
      }

      // Audit the role change
      await auditAction('CHANGE_ROLE', userId, { role: currentProfile.role }, { role });

      return response(200, { success: true });
    }

    // 8. TRANSFER OWNERSHIP (OWNER ONLY) — the system keeps exactly one OWNER.
    // transfer_ownership promotes the target and demotes the previous owner to
    // MANAGER in a single database transaction.
    if (action === 'promote_to_owner') {
      if (callerRole !== 'OWNER') return requireOwner();
      if (userId === authData.user.id) {
        return response(400, { error: 'SELF_TRANSFER_NOT_ALLOWED', message: 'Bạn đang là Chủ cửa hàng.' });
      }

      const currentProfile = await loadTargetProfile();
      if (currentProfile instanceof Response) return currentProfile;

      if (!currentProfile.active || currentProfile.deleted_at) {
        return response(400, { error: 'USER_NOT_ACTIVE', message: 'Chỉ có thể chuyển giao cho tài khoản đang hoạt động.' });
      }
      if (currentProfile.role === 'OWNER') {
        return response(400, { error: 'ALREADY_OWNER', message: 'Tài khoản này đã là Chủ cửa hàng.' });
      }

      const { error } = await caller.rpc('transfer_ownership', { p_target_user: userId });
      if (error) {
        console.error('Ownership transfer failed', error);
        return response(400, { error: 'TRANSFER_FAILED', message: error.message });
      }

      // Audit the transfer
      await auditAction('TRANSFER_OWNER', userId, { role: currentProfile.role }, { role: 'OWNER' });

      return response(200, { success: true });
    }

    // 9. LIFT BAN / RE-ENABLE USER (OWNER ONLY)
    if (action === 'enable_user') {
      if (callerRole !== 'OWNER') return requireOwner();

      const currentProfile = await loadTargetProfile();
      if (currentProfile instanceof Response) return currentProfile;

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: {
          active: true,
          disabled_until: null,
          disable_reason: null,
        },
      });
      if (error) {
        console.error('Enable user failed', error);
        return response(400, { error: 'ENABLE_FAILED', message: error.message });
      }

      // Audit the enable action
      await auditAction('ENABLE_USER', userId, { active: currentProfile.active, disabled_until: currentProfile.disabled_until }, { active: true, disabled_until: null });

      return response(200, { success: true });
    }

    return response(400, { error: 'INVALID_ACTION' });
  } catch (error) {
    console.error('User management request failed', error);
    return response(500, { error: 'SERVER_ERROR', message: 'Đã xảy ra lỗi hệ thống.' });
  }
});
