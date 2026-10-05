-- Migration: 20261004004000_release_drifted_first_login_gates.sql
-- Description: Follow-up to 20261002003500. That migration released every account
--   still gated by the "change password on first login" interstitial, matching the
--   documented product decision that freshly provisioned staff sign straight into
--   the app. The manage-users Edge Function, however, kept passing
--   must_change_password: true in the create action's update_profile payload —
--   a silent doc-vs-code drift. Any staff account created between 2026-10-02 and
--   this fix therefore still sits on /change-password with a valid temporary
--   credential.
--
--   This forward-only migration replays the same release logic against those
--   drifted rows. The fail-closed guarantee is preserved verbatim: accounts with a
--   pending administrative reset (private.required_password_changes.reset_pending)
--   are NOT released, so OWNER-issued temporary passwords continue to require the
--   real rotation before the gate opens.
--
--   The manage-users source has been corrected in the same change; after this
--   migration and the Edge Function redeploy, no new row can re-enter the gated
--   state via the create path.

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
-- track_required_password_change (still active) clears the stored fingerprints
-- for every released row, matching migration 035's post-condition.
