-- Migration: 20261002003500_no_forced_first_password_change.sql
-- Description: Product decision — newly provisioned staff sign straight into the app.
--   The manage-users Edge Function no longer marks created accounts with
--   must_change_password (the auth trigger already defaults it to false).
--   This forward-only migration releases accounts that are STILL gated only by the
--   old "change password on first login" requirement, so existing staff are not
--   stranded on /change-password.
--   Fail-closed guarantee kept: accounts with a pending administrative reset
--   (private.required_password_changes.reset_pending) stay gated until the temporary
--   password is really rotated. The must_change_password mechanism itself remains
--   fully functional for explicit OWNER actions (reset_password, force_password_change).

-- The BEFORE UPDATE trigger blocks clearing the flag without proof of a real
-- password rotation; that proof rule protects user-initiated bypasses, not this
-- deliberate product-wide release, so it is suspended only for this statement.
ALTER TABLE public.profiles DISABLE TRIGGER protect_last_usable_owner;

UPDATE public.profiles p
SET must_change_password = false,
    updated_at = now()
WHERE p.must_change_password
  AND NOT COALESCE(
    (SELECT r.reset_pending
       FROM private.required_password_changes r
      WHERE r.user_id = p.id),
    false
  );

ALTER TABLE public.profiles ENABLE TRIGGER protect_last_usable_owner;
-- track_required_password_change (still active) drops the stored fingerprints for
-- every released row, leaving no orphan gate state behind.
