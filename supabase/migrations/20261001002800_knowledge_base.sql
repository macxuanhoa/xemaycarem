-- Migration: 20261001002800_knowledge_base.sql
-- Description: Documentation knowledge base that grounds the AI copilot's answers.
--   * knowledge_base table: one row per documentation section (slug, title, markdown body,
--     audience tier and provenance source_path) with a searchable tsvector column.
--   * private.knowledge_visible(text) resolves the audience tier against the caller's role.
--   * Read RPCs (search/list/article) used by the copilot Edge Function and the in-app doc viewer.
-- Documents are never writable from the browser: seeding happens through migrations only.
-- SECURITY DEFINER functions bypass RLS, so every read repeats the knowledge_visible predicate.

-- ============================================================
-- STEP 1: Table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 120),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  section text CHECK (section IS NULL OR char_length(btrim(section)) BETWEEN 1 AND 200),
  body_md text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 60000),
  audience text NOT NULL DEFAULT 'ALL' CHECK (audience IN ('ALL', 'STAFF', 'MANAGER', 'OWNER')),
  source_path text CHECK (source_path IS NULL OR char_length(source_path) <= 200),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body_md, ''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_base_search ON public.knowledge_base USING GIN (search);
CREATE INDEX IF NOT EXISTS knowledge_base_audience ON public.knowledge_base (audience);

-- ============================================================
-- STEP 2: Audience visibility helper
-- ============================================================

-- OWNER sees everything; MANAGER adds management documents; STAFF sees operational and
-- general guidance. private.current_role() is NULL for disabled, out-of-schedule or
-- deleted accounts, which lands in the ELSE branch and hides every document.
CREATE OR REPLACE FUNCTION private.knowledge_visible(p_audience text) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE private.current_role()
    WHEN 'OWNER' THEN true
    WHEN 'MANAGER' THEN p_audience IN ('ALL', 'STAFF', 'MANAGER')
    WHEN 'STAFF' THEN p_audience IN ('ALL', 'STAFF')
    ELSE false
  END
$$;

-- ============================================================
-- STEP 3: Read RPCs (copilot retrieval + in-app viewer)
-- ============================================================

-- Ranked full-text retrieval for the copilot. Returns short, linkable evidence rows.
CREATE OR REPLACE FUNCTION public.search_knowledge(p_query text, p_limit integer DEFAULT 8) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_terms text := lower(btrim(coalesce(p_query, '')));
  v_query tsquery;
  v_limit integer := greatest(1, least(coalesce(p_limit, 8), 20));
  v_items jsonb;
BEGIN
  perform private.require_role(ARRAY['OWNER', 'MANAGER', 'STAFF']::public.user_role[]);
  IF length(v_terms) < 2 THEN RETURN '[]'::jsonb; END IF;
  v_query := websearch_to_tsquery('simple', v_terms);
  IF numnode(v_query) = 0 THEN RETURN '[]'::jsonb; END IF;

  SELECT coalesce(jsonb_agg(row_to_json(k)::jsonb ORDER BY k.rank DESC, k.title), '[]'::jsonb) INTO v_items
  FROM (
    SELECT k.id::text AS id, k.slug, k.title, k.section, k.audience, k.source_path,
      ts_rank(k.search, v_query) AS rank,
      CASE WHEN char_length(k.body_md) > 320 THEN left(k.body_md, 320) || '…' ELSE k.body_md END AS excerpt
    FROM public.knowledge_base k
    WHERE k.search @@ v_query
      AND private.knowledge_visible(k.audience)
    ORDER BY rank DESC, k.title
    LIMIT v_limit
  ) k;
  RETURN v_items;
END $$;

-- Browsable index of every document section the caller may read.
CREATE OR REPLACE FUNCTION public.list_knowledge() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb;
BEGIN
  perform private.require_role(ARRAY['OWNER', 'MANAGER', 'STAFF']::public.user_role[]);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'slug', k.slug, 'title', k.title, 'section', k.section,
      'audience', k.audience, 'source_path', k.source_path
    ) ORDER BY coalesce(k.source_path, ''), k.slug), '[]'::jsonb)
  INTO v_items
  FROM public.knowledge_base k
  WHERE private.knowledge_visible(k.audience);
  RETURN jsonb_build_object('items', v_items, 'total', jsonb_array_length(v_items));
END $$;

-- Full article for the doc viewer. Restricted or unknown slugs are indistinguishable.
CREATE OR REPLACE FUNCTION public.get_knowledge_article(p_slug text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb;
BEGIN
  perform private.require_role(ARRAY['OWNER', 'MANAGER', 'STAFF']::public.user_role[]);
  SELECT jsonb_build_object(
      'slug', k.slug, 'title', k.title, 'section', k.section, 'body_md', k.body_md,
      'audience', k.audience, 'source_path', k.source_path, 'updated_at', k.updated_at
    ) INTO v_row
  FROM public.knowledge_base k
  WHERE k.slug = btrim(coalesce(p_slug, ''))
    AND private.knowledge_visible(k.audience);
  IF v_row IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'KNOWLEDGE_NOT_FOUND';
  END IF;
  RETURN v_row;
END $$;

-- ============================================================
-- STEP 4: Row level security and privilege lockdown
-- ============================================================

ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_base_read ON public.knowledge_base;
CREATE POLICY knowledge_base_read ON public.knowledge_base
  FOR SELECT TO authenticated
  USING (private.knowledge_visible(audience));

REVOKE ALL ON public.knowledge_base FROM public, anon, authenticated;
GRANT SELECT ON public.knowledge_base TO authenticated;

REVOKE ALL ON FUNCTION private.knowledge_visible(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.knowledge_visible(text) TO authenticated;

REVOKE ALL ON FUNCTION public.search_knowledge(text, integer), public.list_knowledge(),
  public.get_knowledge_article(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_knowledge(text, integer), public.list_knowledge(),
  public.get_knowledge_article(text) TO authenticated;
