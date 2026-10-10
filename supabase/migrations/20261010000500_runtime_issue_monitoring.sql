-- Closed-vocabulary client diagnostics: no error messages, paths, user IDs,
-- business payloads, image data or credentials are stored in issue records.
BEGIN;

CREATE TABLE public.client_issues (
  issue_day date NOT NULL,
  source text NOT NULL CHECK (source IN ('global','promise','render','rpc','edge')),
  code text NOT NULL CHECK (code IN ('JS_ERROR','UNHANDLED_REJECTION','RENDER_ERROR','NETWORK_ERROR','RPC_SERVER_ERROR','EDGE_SERVER_ERROR','EDGE_RELAY_ERROR')),
  operation text NOT NULL,
  route text NOT NULL,
  release text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('production','staging','development')),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences BETWEEN 1 AND 100000),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issue_day,source,code,operation,route,release,environment)
);
CREATE INDEX client_issues_recent ON public.client_issues(last_seen DESC);
ALTER TABLE public.client_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_issues FROM public, anon, authenticated;

-- This private counter is used only for authorization/rate limits. Actor IDs
-- never appear in diagnostic records or the OWNER digest.
CREATE TABLE private.client_issue_rates (
  actor uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  hits integer NOT NULL DEFAULT 0 CHECK (hits BETWEEN 0 AND 30)
);
REVOKE ALL ON private.client_issue_rates FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.report_client_issue(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_rate private.client_issue_rates;
  v_now timestamptz := clock_timestamp();
  v_day date := (v_now AT TIME ZONE 'UTC')::date;
  v_source text := p_data->>'source';
  v_code text := p_data->>'code';
  v_operation text := p_data->>'operation';
  v_route text := p_data->>'route';
  v_release text := p_data->>'release';
  v_environment text := p_data->>'environment';
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object'
    OR NOT (p_data ?& ARRAY['source','code','operation','route','release','environment'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k NOT IN ('source','code','operation','route','release','environment'))
    OR EXISTS (SELECT 1 FROM jsonb_each(p_data) kv WHERE jsonb_typeof(kv.value) <> 'string')
    OR v_source NOT IN ('global','promise','render','rpc','edge')
    OR v_code NOT IN ('JS_ERROR','UNHANDLED_REJECTION','RENDER_ERROR','NETWORK_ERROR','RPC_SERVER_ERROR','EDGE_SERVER_ERROR','EDGE_RELAY_ERROR')
    OR v_environment NOT IN ('production','staging','development')
    OR v_route NOT IN ('/','/login','/showroom','/reset-password','/change-password','/acquisitions','/acquisitions/new','/vehicles','/vehicles/new','/vehicles/:id','/vehicles/:id/edit','/vehicles/:id/sell','/sales','/sales/:id','/capture','/assist','/copilot','/docs','/docs/:slug','/receivables','/customers','/settings','/intake','/sell','/expenses','/users','/audit','/approvals','/other')
    OR (v_release <> 'unknown' AND v_release !~ '^v?[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(-[a-z]{1,12})?$'
      AND NOT (v_release ~ '^[a-f0-9]{7,40}$' AND v_release ~ '[a-f]'))
    OR (v_operation NOT IN ('other','app','global','ai-assist','manage-users','process-message')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname=v_operation))
  THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_CLIENT_ISSUE'; END IF;

  INSERT INTO private.client_issue_rates(actor,window_start,hits) VALUES(v_actor,v_now,0)
  ON CONFLICT(actor) DO NOTHING;
  SELECT * INTO v_rate FROM private.client_issue_rates WHERE actor=v_actor FOR UPDATE;
  IF v_rate.window_start <= v_now - interval '1 minute' THEN
    v_rate.window_start := v_now; v_rate.hits := 0;
  END IF;
  IF v_rate.hits >= 30 THEN RETURN jsonb_build_object('recorded',false,'reason','rate_limited'); END IF;
  UPDATE private.client_issue_rates SET window_start=v_rate.window_start,hits=v_rate.hits+1 WHERE actor=v_actor;

  -- Serialize the small diagnostic write separately from business operations.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('client_issues:'||v_day::text,0));
  DELETE FROM public.client_issues WHERE last_seen < v_now - interval '90 days';
  -- Counters are bounded by profile count and cascade on profile deletion.
  -- Never prune another actor's locked counter while holding the global lock.
  IF NOT EXISTS(SELECT 1 FROM public.client_issues WHERE issue_day=v_day AND source=v_source AND code=v_code
    AND operation=v_operation AND route=v_route AND release=v_release AND environment=v_environment)
    AND (SELECT count(*) FROM public.client_issues WHERE issue_day=v_day) >= 1000
  THEN RETURN jsonb_build_object('recorded',false,'reason','capacity'); END IF;

  INSERT INTO public.client_issues(issue_day,source,code,operation,route,release,environment,first_seen,last_seen)
  VALUES(v_day,v_source,v_code,v_operation,v_route,v_release,v_environment,v_now,v_now)
  ON CONFLICT(issue_day,source,code,operation,route,release,environment) DO UPDATE
    SET occurrences=least(public.client_issues.occurrences+1,100000),last_seen=EXCLUDED.last_seen;
  RETURN jsonb_build_object('recorded',true);
END $$;

CREATE OR REPLACE FUNCTION public.list_client_issues(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_days integer := greatest(1,least(coalesce(p_days,7),90));
  v_items jsonb; v_total bigint;
BEGIN
  SELECT coalesce(sum(occurrences),0) INTO v_total FROM public.client_issues
    WHERE last_seen >= now()-make_interval(days=>v_days);
  WITH grouped AS (
    SELECT source,code,operation,route,release,environment,sum(occurrences) AS occurrences,
      min(first_seen) AS first_seen,max(last_seen) AS last_seen
    FROM public.client_issues WHERE last_seen >= now()-make_interval(days=>v_days)
    GROUP BY source,code,operation,route,release,environment
    ORDER BY sum(occurrences) DESC,max(last_seen) DESC LIMIT 50
  ) SELECT coalesce(jsonb_agg(to_jsonb(grouped) ORDER BY occurrences DESC,last_seen DESC),'[]'::jsonb)
  INTO v_items FROM grouped;
  RETURN jsonb_build_object('items',v_items,'total_occurrences',v_total,'days',v_days);
END $$;

REVOKE ALL ON FUNCTION public.report_client_issue(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_client_issues(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_client_issue(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_client_issues(integer) TO authenticated;
COMMIT;
