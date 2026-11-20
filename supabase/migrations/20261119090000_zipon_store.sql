-- Additive, server-only access to the existing V4 tables. No family data migration.
CREATE TABLE IF NOT EXISTS public.zipon_settings (scope TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS public.zipon_events (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS zipon_events_time ON public.zipon_events(scope, created_at DESC);
CREATE TABLE IF NOT EXISTS public.zipon_state (scope TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS public.zipon_leases (scope TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at DOUBLE PRECISION NOT NULL);
ALTER TABLE public.zipon_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zipon_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zipon_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zipon_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zipon_settings, public.zipon_events, public.zipon_state, public.zipon_leases FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zipon_settings, public.zipon_events, public.zipon_state, public.zipon_leases TO service_role;

CREATE OR REPLACE FUNCTION public.zipon_store_v1(op TEXT, p JSONB DEFAULT '{}'::JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  result JSONB;
  row_value JSONB;
  row_revision INTEGER;
  event JSONB;
  affected INTEGER;
  inserted INTEGER := 0;
  epoch DOUBLE PRECISION := extract(epoch FROM clock_timestamp());
  since TEXT;
  until TEXT;
BEGIN
  IF op = 'init' THEN
    INSERT INTO public.zipon_settings(scope, value, revision, updated_at)
      VALUES ('family', (p->'settings')::TEXT, 0, p->>'now') ON CONFLICT(scope) DO NOTHING;
    RETURN 'true'::JSONB;
  ELSIF op = 'snapshot' THEN
    SELECT value::JSONB, revision INTO row_value, row_revision FROM public.zipon_settings WHERE scope = 'family';
    SELECT jsonb_build_array(row_value, row_revision,
      coalesce((SELECT jsonb_agg(x.value::JSONB ORDER BY x.created_at DESC, x.id DESC)
        FROM (SELECT value, created_at, id FROM public.zipon_events WHERE scope = 'family' ORDER BY created_at DESC, id DESC LIMIT 50) x), '[]'::JSONB),
      (SELECT count(*) FROM public.zipon_events WHERE scope = 'family'),
      (SELECT value::JSONB FROM public.zipon_state WHERE scope = 'family')) INTO result;
    RETURN result;
  ELSIF op = 'settings_read' THEN
    SELECT jsonb_build_array(value::JSONB, revision) INTO result FROM public.zipon_settings WHERE scope = 'family';
    RETURN result;
  ELSIF op IN ('settings_save', 'import') THEN
    IF op = 'settings_save' OR p->'settings' <> 'null'::JSONB THEN
      UPDATE public.zipon_settings SET value = (p->'settings')::TEXT, revision = revision + 1, updated_at = p->>'now'
        WHERE scope = 'family' AND revision = (p->>'revision')::INTEGER RETURNING revision INTO row_revision;
      IF NOT FOUND THEN RAISE EXCEPTION 'ZIPON_REVISION_CONFLICT'; END IF;
    END IF;
    IF op = 'settings_save' THEN RETURN to_jsonb(row_revision); END IF;
  ELSIF op = 'events' THEN
    IF coalesce(p->>'day', '') <> '' THEN
      since := to_char(((p->>'day')::DATE::TIMESTAMP AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      until := to_char((((p->>'day')::DATE + 1)::TIMESTAMP AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    END IF;
    SELECT jsonb_build_array(
      coalesce((SELECT jsonb_agg(x.value::JSONB ORDER BY x.created_at DESC, x.id DESC) FROM
        (SELECT value, created_at, id FROM public.zipon_events
          WHERE scope = 'family' AND (since IS NULL OR created_at >= since AND created_at < until)
          AND (p->>'kind' = 'all' OR kind LIKE (p->>'kind') || '%')
          ORDER BY created_at DESC, id DESC LIMIT least((p->>'limit')::INTEGER, 5001) OFFSET (p->>'offset')::INTEGER) x), '[]'::JSONB),
      (SELECT count(*) FROM public.zipon_events WHERE scope = 'family'
        AND (since IS NULL OR created_at >= since AND created_at < until)
        AND (p->>'kind' = 'all' OR kind LIKE (p->>'kind') || '%'))) INTO result;
    RETURN result;
  ELSIF op = 'claim' THEN
    INSERT INTO public.zipon_leases(scope, owner, expires_at) VALUES ('family', p->>'owner', epoch + 15)
      ON CONFLICT(scope) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE public.zipon_leases.expires_at < epoch OR public.zipon_leases.owner = p->>'owner';
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN to_jsonb(affected = 1);
  ELSIF op = 'release' THEN
    DELETE FROM public.zipon_leases WHERE scope = 'family' AND owner = p->>'owner';
    RETURN 'null'::JSONB;
  ELSIF op = 'state_write' THEN
    UPDATE public.zipon_leases SET expires_at = epoch + 15 WHERE scope = 'family' AND owner = p->>'owner' AND expires_at > epoch;
    IF NOT FOUND THEN RAISE EXCEPTION 'ZIPON_LEASE_EXPIRED'; END IF;
    SELECT value::JSONB INTO row_value FROM public.zipon_state WHERE scope = 'family';
    IF row_value->'sample'->>'session' = p->'sample'->>'session'
      AND (row_value->'sample'->>'seq')::BIGINT >= (p->'sample'->>'seq')::BIGINT THEN RETURN 'null'::JSONB; END IF;
    INSERT INTO public.zipon_state(scope, value) VALUES ('family', jsonb_build_object('sample', p->'sample', 'last_seen', p->>'seen_at')::TEXT)
      ON CONFLICT(scope) DO UPDATE SET value = excluded.value;
    RETURN 'null'::JSONB;
  ELSIF op = 'state_read' THEN
    SELECT value::JSONB INTO result FROM public.zipon_state WHERE scope = 'family';
    RETURN result;
  ELSIF op <> 'events_add' THEN
    RAISE EXCEPTION 'ZIPON_UNSUPPORTED_OPERATION';
  END IF;
  -- Event insert and optional settings import form one transaction.
  FOR event IN SELECT value FROM jsonb_array_elements(p->'rows') LOOP
    INSERT INTO public.zipon_events(id, scope, kind, created_at, value, legacy)
      VALUES (event->>'id', 'family', event->>'kind', event->>'created_at', event::TEXT, CASE WHEN (event->>'legacy')::BOOLEAN THEN 1 ELSE 0 END)
      ON CONFLICT(id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted := inserted + affected;
  END LOOP;
  DELETE FROM public.zipon_events WHERE scope = 'family' AND legacy = 0 AND id NOT IN
    (SELECT id FROM public.zipon_events WHERE scope = 'family' AND legacy = 0 ORDER BY created_at DESC, id DESC LIMIT 2000);
  RETURN to_jsonb(inserted);
END;
$$;
REVOKE ALL ON FUNCTION public.zipon_store_v1(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zipon_store_v1(TEXT, JSONB) TO service_role;
NOTIFY pgrst, 'reload schema';
