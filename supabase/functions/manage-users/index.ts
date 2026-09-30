// Edge Function: manage-users
// Secure administrative user management for Xe CRM.
// Accessible strictly by authenticated OWNER role. No service role key is exposed to browser.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2.117.2/cors';

export { corsHeaders };

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');

Deno.serve(async (request: Request) => {
  // Handle preflight OPTIONS request before any auth or business logic
  if (request.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders });
  }

  const response = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });

  if (request.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' });
  if (!url || !anonKey || !serviceKey) return response(503, { error: 'SERVER_CONFIGURATION_REQUIRED' });

  try {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return response(401, { error: 'AUTH_REQUIRED' });

    // Caller client operates with the user's JWT to verify OWNER identity
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
    if (profileError || profile?.role !== 'OWNER' || !profile.active || profile?.deleted_at) {
      return response(403, { error: 'ACCESS_DENIED' });
    }
    const { data: access, error: accessError } = await caller.rpc('check_user_access');
    if (accessError || !access?.allowed || access.must_change_password) {
      return response(403, { error: 'ACCESS_DENIED' });
    }

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
    if (action !== 'create' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return response(400, { error: 'INVALID_USER_ID' });
    }

    const allowedFrom = typeof body.allowed_from === 'string' ? body.allowed_from : '00:00:00';
    const allowedUntil = typeof body.allowed_until === 'string' ? body.allowed_until : '23:59:59';
    const workingDays = Array.isArray(body.working_days) ? body.working_days : [1, 2, 3, 4, 5, 6, 7];

    const disabledUntil = typeof body.disabled_until === 'string' ? body.disabled_until : null;
    const disableReason = typeof body.disable_reason === 'string' ? body.disable_reason : null;

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. CREATE USER (OWNER ONLY)
    if (action === 'create') {
      // Validate username format: 3-30 chars, lowercase, letters/numbers/underscore/dot only
      if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
        return response(400, { error: 'INVALID_USERNAME', message: 'Tên đăng nhập từ 3-30 ký tự (chữ thường, số, _, .)' });
      }

      // Prohibit creating OWNER through normal user provisioning
      if (!['MANAGER', 'STAFF', 'VIEWER'].includes(role)) {
        return response(400, { error: 'INVALID_ROLE', message: 'Chỉ có thể tạo vai trò Quản lý, Nhân viên hoặc Người xem.' });
      }

      if (fullName.length < 1 || fullName.length > 120) {
        return response(400, { error: 'INVALID_NAME', message: 'Họ và tên từ 1 đến 120 ký tự.' });
      }

      if (password.length < 12 || password.length > 128) {
        return response(400, { error: 'INVALID_PASSWORD', message: 'Mật khẩu từ 12 đến 128 ký tự.' });
      }

      // Check username uniqueness beforehand
      const { data: existingProfile, error: lookupError } = await admin
        .from('profiles')
        .select('id')
        .ilike('username', username)
        .maybeSingle();
      if (lookupError) return response(503, { error: 'USER_LOOKUP_FAILED' });
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
        return response(400, { error: 'USER_CREATION_FAILED', message: createAuthError?.message || 'Không thể tạo tài khoản.' });
      }

      const newUserId = createdAuth.user.id;

      // Activate profile with chosen configuration and controls
      const { error: profileError } = await caller.rpc('update_profile', {
        p_id: newUserId,
        p_data: {
          full_name: fullName,
          role,
          active: true,
          can_view_financials: body.can_view_financials === true,
          username,
          must_change_password: true, // Temporary password requires change on first login
          allowed_from: allowedFrom,
          allowed_until: allowedUntil,
          working_days: workingDays,
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

      return response(201, { id: newUserId, username });
    }

    // 2. RESET TEMPORARY PASSWORD
    if (action === 'reset_password') {
      if (!userId || password.length < 12 || password.length > 128) {
        return response(400, { error: 'INVALID_INPUT', message: 'Mật khẩu từ 12 đến 128 ký tự.' });
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

      return response(200, { success: true, message: 'Đã đặt lại mật khẩu tạm thành công.' });
    }

    // 3. DISABLE / LOCK ACCOUNT
    if (action === 'disable') {
      if (!userId) return response(400, { error: 'INVALID_INPUT' });

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: {
          active: disabledUntil ? true : false,
          disabled_until: disabledUntil || null,
          disable_reason: disableReason || null,
        },
      });
      if (error) {
        console.error('Disable failed', error);
        return response(400, { error: 'USER_DISABLE_FAILED', message: error.message });
      }

      return response(200, { success: true });
    }

    // 4. RESTORE / ACTIVATE ACCOUNT
    if (action === 'restore') {
      if (!userId) return response(400, { error: 'INVALID_INPUT' });

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

      return response(200, { success: true });
    }

    // 5. NORMAL DELETE = SOFT DEACTIVATE (Preserves historical attribution)
    if (action === 'delete') {
      if (!userId) return response(400, { error: 'INVALID_INPUT' });

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: {
          active: false,
          deleted_at: new Date().toISOString(),
          disable_reason: disableReason || 'Vô hiệu hóa bởi chủ cửa hàng',
        },
      });
      if (error) {
        console.error('Delete (deactivate) failed', error);
        return response(400, { error: 'USER_DELETE_FAILED', message: error.message });
      }

      return response(200, { success: true });
    }

    // 6. HARD DELETE UNUSED ACCOUNT ONLY (Refused if any business history exists)
    if (action === 'hard_delete') {
      if (!userId) return response(400, { error: 'INVALID_INPUT' });

      // Check whether user has ever participated in store operations
      const { data: checkData, error: checkError } = await caller.rpc('check_user_can_hard_delete', {
        p_user_id: userId,
      });

      if (checkError || !checkData?.can_delete) {
        return response(400, {
          error: checkData?.reason || 'CANNOT_HARD_DELETE',
          message: checkData?.message || 'Tài khoản đã có lịch sử nghiệp vụ. Chỉ có thể vô hiệu hóa.',
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

      return response(200, { success: true, message: 'Đã xóa hoàn toàn tài khoản chưa sử dụng.' });
    }

    // 7. UPDATE SCHEDULE
    if (action === 'update_schedule') {
      if (!userId) return response(400, { error: 'INVALID_INPUT' });

      const { error } = await caller.rpc('update_profile', {
        p_id: userId,
        p_data: {
          allowed_from: allowedFrom,
          allowed_until: allowedUntil,
          working_days: workingDays,
        },
      });
      if (error) {
        console.error('Schedule update failed', error);
        return response(400, { error: 'SCHEDULE_UPDATE_FAILED', message: error.message });
      }

      return response(200, { success: true });
    }

    return response(400, { error: 'INVALID_ACTION' });
  } catch (error) {
    console.error('User management request failed', error);
    return response(500, { error: 'SERVER_ERROR', message: 'Đã xảy ra lỗi hệ thống.' });
  }
});
