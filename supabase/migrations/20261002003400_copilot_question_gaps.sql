-- Migration: 20261002003400_copilot_question_gaps.sql
-- Description: Feedback loop for the AI copilot's documentation gaps.
--   * copilot_question_gaps table: one row per distinct question the copilot could not
--     answer (coverage 'none'), with a hit counter and the last asker/role.
--   * public.log_copilot_gap(text): called by the ai-assist Edge Function through the
--     caller's own JWT whenever an answer comes back insufficient; never stores answers.
--   * public.list_copilot_gaps(integer): OWNER-only digest used by the in-app doc page so
--     the owner learns which SOPs to write next. Repeated similar wording collapses on
--     the normalized text; diacritics are kept because search_knowledge uses 'simple'.
-- The table is write/read exclusively through SECURITY DEFINER RPCs: no browser policy
-- exposes another user's questions, and rows contain no business data.

-- ============================================================
-- STEP 1: Table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.copilot_question_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  question_norm text NOT NULL UNIQUE CHECK (char_length(question_norm) BETWEEN 1 AND 500),
  last_role text NOT NULL CHECK (last_role IN ('OWNER', 'MANAGER', 'STAFF')),
  last_asked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  hits integer NOT NULL DEFAULT 1 CHECK (hits >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS copilot_question_gaps_recent
  ON public.copilot_question_gaps (last_seen_at DESC);

-- ============================================================
-- STEP 2: Write RPC (ai-assist copilot path only)
-- ============================================================

CREATE OR REPLACE FUNCTION public.log_copilot_gap(p_question text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_question text := left(btrim(coalesce(p_question, '')), 500);
  -- Collapse all whitespace runs first, then trim: btrim() alone only strips plain
  -- spaces, so tabs/newlines would otherwise fragment otherwise-identical questions.
  v_norm text := btrim(lower(regexp_replace(v_question, '\s+', ' ', 'g')));
BEGIN
  perform private.require_role(ARRAY['OWNER', 'MANAGER', 'STAFF']::public.user_role[]);
  IF length(v_norm) < 2 THEN RETURN; END IF;
  INSERT INTO public.copilot_question_gaps (question, question_norm, last_role, last_asked_by)
  VALUES (v_question, v_norm, private.current_role(), auth.uid())
  ON CONFLICT (question_norm) DO UPDATE
  SET hits = public.copilot_question_gaps.hits + 1,
      question = EXCLUDED.question,
      last_role = EXCLUDED.last_role,
      last_asked_by = EXCLUDED.last_asked_by,
      last_seen_at = now();
END $$;

-- ============================================================
-- STEP 3: OWNER-only digest RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_copilot_gaps(p_days integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
  v_items jsonb;
  v_total integer;
BEGIN
  perform private.require_role(ARRAY['OWNER']::public.user_role[]);
  SELECT count(*) INTO v_total
  FROM public.copilot_question_gaps g
  WHERE g.last_seen_at >= now() - make_interval(days => v_days);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id, 'question', g.question, 'hits', g.hits,
      'last_role', g.last_role, 'asked_first_at', g.created_at, 'last_seen_at', g.last_seen_at
    ) ORDER BY g.hits DESC, g.last_seen_at DESC), '[]'::jsonb) INTO v_items
  FROM public.copilot_question_gaps g
  WHERE g.last_seen_at >= now() - make_interval(days => v_days)
  LIMIT 50;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'days', v_days);
END $$;

-- ============================================================
-- STEP 4: Row level security and privilege lockdown
-- ============================================================

ALTER TABLE public.copilot_question_gaps ENABLE ROW LEVEL SECURITY;

-- Deliberately no policies: even authenticated roles must go through the RPCs above.
REVOKE ALL ON public.copilot_question_gaps FROM public, anon, authenticated;

REVOKE ALL ON FUNCTION public.log_copilot_gap(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_copilot_gap(text) TO authenticated;

REVOKE ALL ON FUNCTION public.list_copilot_gaps(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_copilot_gaps(integer) TO authenticated;
