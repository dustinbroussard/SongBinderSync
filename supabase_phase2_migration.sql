-- =============================================================================
-- SongBinder Phase 1 + Phase 2 Unified Idempotent Database Migration Script
-- Purpose:
--   1. Preserve musical metadata, BPM, ordered setlist song_ids, and soft-delete
--      tombstones (Phase 1, safe & idempotent if already applied).
--   2. Add server-assigned server_version sequence & triggers as a record-level
--      optimistic concurrency token for safe multi-device writes (Phase 2).
--   3. Guarantee composite (user_id, legacy_id) uniqueness for safe upserts.
--   4. Upgrade public.replace_setlist_songs to accept expected server_version,
--      enforce optimistic concurrency, use B-tree UUID indexes, and return the
--      resulting server_version.
--
-- IMPORTANT INSTRUCTIONS:
-- - DO NOT execute automatically; review first, then run in Supabase SQL Editor.
-- - Safe and NON-DESTRUCTIVE: never drops tables or deletes existing user rows.
-- - Wrapped in BEGIN / COMMIT so any failure rolls back cleanly without partial changes.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Phase 1 Columns & Deleted-At Indexes (Idempotent)
-- -----------------------------------------------------------------------------
ALTER TABLE public.songs
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS bpm integer,
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

ALTER TABLE public.setlists
  ADD COLUMN IF NOT EXISTS song_ids jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.songs'::regclass
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid
         AND a.attnum = k.attnum
        WHERE k.ord <= i.indnkeyatts
      ) = ARRAY['user_id', 'deleted_at']::text[]
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_songs_user_deleted
      ON public.songs (user_id, deleted_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.setlists'::regclass
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid
         AND a.attnum = k.attnum
        WHERE k.ord <= i.indnkeyatts
      ) = ARRAY['user_id', 'deleted_at']::text[]
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_setlists_user_deleted
      ON public.setlists (user_id, deleted_at);
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Phase 2 Record-Level Sync Version Token, Sequence & Data Backfill
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.sync_version_seq START WITH 1 INCREMENT BY 1;

-- Authenticated clients need USAGE and SELECT on public.sync_version_seq because
-- PostgreSQL evaluates column DEFAULT nextval('public.sync_version_seq') under the
-- invoking role before BEFORE INSERT triggers execute.
GRANT USAGE, SELECT ON SEQUENCE public.sync_version_seq TO authenticated;

ALTER TABLE public.songs
  ADD COLUMN IF NOT EXISTS server_version bigint;

ALTER TABLE public.setlists
  ADD COLUMN IF NOT EXISTS server_version bigint;

-- Preserve original updated_at values during legacy_id, song_ids, and server_version
-- backfills by temporarily suppressing only the existing non-internal timestamp triggers
-- and restoring each trigger's exact original enabled/disabled state before commit.
DO $$
DECLARE
  v_trig record;
  v_saved_tables text[] := ARRAY[]::text[];
  v_saved_names text[] := ARRAY[]::text[];
  v_saved_states text[] := ARRAY[]::text[];
  v_idx integer;
  v_restore_cmd text;
BEGIN
  FOR v_trig IN
    SELECT
      c.relname AS table_name,
      t.tgname AS trigger_name,
      t.tgenabled::text AS trigger_state
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND (
        (c.relname = 'songs' AND t.tgname IN ('songs_set_updated_at', 'trg_songs_updated_at'))
        OR
        (c.relname = 'setlists' AND t.tgname IN ('setlists_set_updated_at', 'trg_setlists_updated_at'))
      )
    ORDER BY c.relname, t.tgname
  LOOP
    IF v_trig.trigger_state <> 'D' THEN
      v_saved_tables := array_append(v_saved_tables, v_trig.table_name::text);
      v_saved_names := array_append(v_saved_names, v_trig.trigger_name::text);
      v_saved_states := array_append(v_saved_states, v_trig.trigger_state);

      EXECUTE format(
        'ALTER TABLE public.%I DISABLE TRIGGER %I',
        v_trig.table_name,
        v_trig.trigger_name
      );
    END IF;
  END LOOP;

  BEGIN
    -- Backfill legacy_id if any existing row has NULL legacy_id so unique index succeeds
    UPDATE public.songs
    SET legacy_id = id::text
    WHERE legacy_id IS NULL;

    UPDATE public.setlists
    SET legacy_id = id::text
    WHERE legacy_id IS NULL;

    -- Safe backfill of setlists.song_ids from setlist_songs in position order
    UPDATE public.setlists s
    SET song_ids = sub.aggregated_song_ids
    FROM (
      SELECT
        ss.setlist_id,
        jsonb_agg(ss.song_id::text ORDER BY ss.position ASC) AS aggregated_song_ids
      FROM public.setlist_songs ss
      GROUP BY ss.setlist_id
    ) sub
    WHERE s.id = sub.setlist_id
      AND (s.song_ids IS NULL OR s.song_ids = '[]'::jsonb);

    -- Backfill server_version only for existing rows that don't have one yet
    UPDATE public.songs
    SET server_version = nextval('public.sync_version_seq')
    WHERE server_version IS NULL;

    UPDATE public.setlists
    SET server_version = nextval('public.sync_version_seq')
    WHERE server_version IS NULL;
  EXCEPTION WHEN OTHERS THEN
    FOR v_idx IN 1..COALESCE(array_length(v_saved_names, 1), 0) LOOP
      v_restore_cmd := CASE v_saved_states[v_idx]
        WHEN 'A' THEN 'ENABLE ALWAYS TRIGGER'
        WHEN 'R' THEN 'ENABLE REPLICA TRIGGER'
        ELSE 'ENABLE TRIGGER'
      END;
      EXECUTE format(
        'ALTER TABLE public.%I %s %I',
        v_saved_tables[v_idx],
        v_restore_cmd,
        v_saved_names[v_idx]
      );
    END LOOP;
    RAISE;
  END;

  FOR v_idx IN 1..COALESCE(array_length(v_saved_names, 1), 0) LOOP
    v_restore_cmd := CASE v_saved_states[v_idx]
      WHEN 'A' THEN 'ENABLE ALWAYS TRIGGER'
      WHEN 'R' THEN 'ENABLE REPLICA TRIGGER'
      ELSE 'ENABLE TRIGGER'
    END;
    EXECUTE format(
      'ALTER TABLE public.%I %s %I',
      v_saved_tables[v_idx],
      v_restore_cmd,
      v_saved_names[v_idx]
    );
  END LOOP;
END
$$;

ALTER TABLE public.songs
  ALTER COLUMN server_version SET DEFAULT nextval('public.sync_version_seq'),
  ALTER COLUMN server_version SET NOT NULL;

ALTER TABLE public.setlists
  ALTER COLUMN server_version SET DEFAULT nextval('public.sync_version_seq'),
  ALTER COLUMN server_version SET NOT NULL;

-- Precheck duplicate data and avoid duplicate indexes before creating unique/composite indexes.
-- Note: This migration enforces uniqueness on public.songs (user_id, legacy_id) and
-- public.setlists (user_id, legacy_id); it does not create new unique indexes on
-- public.setlist_songs (setlist_id, song_id) or (setlist_id, position).
DO $$
DECLARE
  v_dup_count integer;
  v_sample text;
BEGIN
  -- Songs: check non-null (user_id, legacy_id) duplicates matching standard B-tree unique semantics
  SELECT COUNT(*), MIN(user_id::text || ' / ' || legacy_id)
  INTO v_dup_count, v_sample
  FROM (
    SELECT user_id, legacy_id
    FROM public.songs
    WHERE user_id IS NOT NULL
      AND legacy_id IS NOT NULL
    GROUP BY user_id, legacy_id
    HAVING COUNT(*) > 1
  ) dup_songs;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: public.songs has % duplicate (user_id, legacy_id) group(s) (e.g. %), violating unique index idx_songs_user_legacy_id_unique. Resolve duplicates manually before retrying.',
      v_dup_count, v_sample;
  END IF;

  -- Setlists: check non-null (user_id, legacy_id) duplicates matching standard B-tree unique semantics
  SELECT COUNT(*), MIN(user_id::text || ' / ' || legacy_id)
  INTO v_dup_count, v_sample
  FROM (
    SELECT user_id, legacy_id
    FROM public.setlists
    WHERE user_id IS NOT NULL
      AND legacy_id IS NOT NULL
    GROUP BY user_id, legacy_id
    HAVING COUNT(*) > 1
  ) dup_setlists;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: public.setlists has % duplicate (user_id, legacy_id) group(s) (e.g. %), violating unique index idx_setlists_user_legacy_id_unique. Resolve duplicates manually before retrying.',
      v_dup_count, v_sample;
  END IF;

  -- Non-blocking diagnostic check for existing setlist_songs relationship/ordering pairs
  SELECT COUNT(*), MIN(setlist_id::text || ' / ' || song_id::text)
  INTO v_dup_count, v_sample
  FROM (
    SELECT setlist_id, song_id
    FROM public.setlist_songs
    WHERE setlist_id IS NOT NULL
      AND song_id IS NOT NULL
    GROUP BY setlist_id, song_id
    HAVING COUNT(*) > 1
  ) dup_rel;

  IF v_dup_count > 0 THEN
    RAISE NOTICE
      'Diagnostic notice: public.setlist_songs contains % repeated (setlist_id, song_id) group(s) (e.g. %). No unique index on (setlist_id, song_id) is added by this migration.',
      v_dup_count, v_sample;
  END IF;

  SELECT COUNT(*), MIN(setlist_id::text || ' / pos ' || position::text)
  INTO v_dup_count, v_sample
  FROM (
    SELECT setlist_id, position
    FROM public.setlist_songs
    WHERE setlist_id IS NOT NULL
      AND position IS NOT NULL
    GROUP BY setlist_id, position
    HAVING COUNT(*) > 1
  ) dup_pos;

  IF v_dup_count > 0 THEN
    RAISE NOTICE
      'Diagnostic notice: public.setlist_songs contains % duplicate (setlist_id, position) group(s) (e.g. %). No unique index on (setlist_id, position) is added by this migration.',
      v_dup_count, v_sample;
  END IF;

  -- Create unique upsert target indexes only if no equivalent unique index already exists
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.songs'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid
         AND a.attnum = k.attnum
        WHERE k.ord <= i.indnkeyatts
      ) = ARRAY['user_id', 'legacy_id']::text[]
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_user_legacy_id_unique
      ON public.songs (user_id, legacy_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.setlists'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid
         AND a.attnum = k.attnum
        WHERE k.ord <= i.indnkeyatts
      ) = ARRAY['user_id', 'legacy_id']::text[]
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_setlists_user_legacy_id_unique
      ON public.setlists (user_id, legacy_id);
  END IF;

  -- Fast version indexes (skip if equivalent index already exists)
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.songs'::regclass
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid
         AND a.attnum = k.attnum
        WHERE k.ord <= i.indnkeyatts
      ) = ARRAY['user_id', 'server_version']::text[]
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_songs_user_server_version
      ON public.songs (user_id, server_version);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.setlists'::regclass
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid
         AND a.attnum = k.attnum
        WHERE k.ord <= i.indnkeyatts
      ) = ARRAY['user_id', 'server_version']::text[]
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_setlists_user_server_version
      ON public.setlists (user_id, server_version);
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. Authoritative Server Timestamp & Sync Version Trigger
--    Assigns a fresh record-level server_version concurrency token on every
--    INSERT/UPDATE (including soft deletes and RPC updates). Sets server
--    updated_at := now() on INSERT, while existing UPDATE timestamp triggers
--    (public.set_updated_at()) continue setting NEW.updated_at = now() on UPDATE
--    without duplicate timestamp writes or trigger-order conflicts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.songbinder_touch_sync_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := now();
  END IF;
  NEW.server_version := nextval('public.sync_version_seq');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_songs_touch_sync_metadata ON public.songs;
CREATE TRIGGER trg_songs_touch_sync_metadata
  BEFORE INSERT OR UPDATE ON public.songs
  FOR EACH ROW
  EXECUTE FUNCTION public.songbinder_touch_sync_metadata();

DROP TRIGGER IF EXISTS trg_setlists_touch_sync_metadata ON public.setlists;
CREATE TRIGGER trg_setlists_touch_sync_metadata
  BEFORE INSERT OR UPDATE ON public.setlists
  FOR EACH ROW
  EXECUTE FUNCTION public.songbinder_touch_sync_metadata();

-- -----------------------------------------------------------------------------
-- 4. Upgraded Atomic Setlist Song Ordering RPC (Version-Guarded + UUID-indexed)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.replace_setlist_songs(text, text[]);
DROP FUNCTION IF EXISTS public.replace_setlist_songs(text, text[], bigint);

CREATE FUNCTION public.replace_setlist_songs(
  p_setlist_id text,
  p_song_ids text[],
  p_expected_server_version bigint
) RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_setlist_uuid uuid;
  v_song_uuids uuid[];
  v_song_uuid uuid;
  v_pos int := 1;
  v_current_version bigint;
  v_new_version bigint;
BEGIN
  -- 1. Derive user identity exclusively from auth.uid()
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: User is not authenticated';
  END IF;

  -- 2. Parse UUID parameters upfront so queries use native primary-key B-tree indexes
  BEGIN
    v_setlist_uuid := p_setlist_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Validation failed: Invalid setlist UUID "%"', p_setlist_id;
  END;

  IF p_song_ids IS NOT NULL AND array_length(p_song_ids, 1) > 0 THEN
    BEGIN
      SELECT array_agg(elem::uuid ORDER BY ord)
      INTO v_song_uuids
      FROM unnest(p_song_ids) WITH ORDINALITY AS t(elem, ord);
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Validation failed: One or more song IDs are not valid UUIDs';
    END;
  ELSE
    v_song_uuids := ARRAY[]::uuid[];
  END IF;

  -- 3. Lock target setlist row, verify ownership and active status, and read server_version
  SELECT s.server_version
  INTO v_current_version
  FROM public.setlists s
  WHERE s.id = v_setlist_uuid
    AND s.user_id = v_user_id
    AND s.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied: Setlist not found, deleted, or unauthorized';
  END IF;

  -- 4. Require a positive expected version and exact version match before any mutations
  IF p_expected_server_version IS NULL OR p_expected_server_version <= 0 THEN
    RAISE EXCEPTION 'Validation failed: Expected server_version must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  IF v_current_version IS NULL OR v_current_version <= 0 THEN
    RAISE EXCEPTION 'Missing version: Setlist % does not have a valid server_version', v_setlist_uuid
      USING ERRCODE = 'P0002';
  END IF;

  IF v_current_version <> p_expected_server_version THEN
    RAISE EXCEPTION 'CONFLICT: Setlist server_version mismatch (expected %, current %)',
      p_expected_server_version, v_current_version
      USING ERRCODE = 'P0409';
  END IF;

  -- 5. Validate and share-lock ALL requested song rows BEFORE modifying links
  IF array_length(v_song_uuids, 1) > 0 THEN
    PERFORM 1
    FROM public.songs s
    WHERE s.id = ANY(v_song_uuids)
      AND s.user_id = v_user_id
      AND s.deleted_at IS NULL
    FOR SHARE;

    IF EXISTS (
      SELECT 1
      FROM unnest(v_song_uuids) AS requested(requested_song_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.songs s
        WHERE s.id = requested.requested_song_id
          AND s.user_id = v_user_id
          AND s.deleted_at IS NULL
      )
    ) THEN
      RAISE EXCEPTION 'Validation failed: One or more songs are invalid, deleted, or unauthorized';
    END IF;
  END IF;

  -- 6. Atomically replace relational links and JSONB song_ids
  DELETE FROM public.setlist_songs
  WHERE setlist_id = v_setlist_uuid
    AND user_id = v_user_id;

  IF array_length(v_song_uuids, 1) > 0 THEN
    FOREACH v_song_uuid IN ARRAY v_song_uuids LOOP
      INSERT INTO public.setlist_songs (setlist_id, song_id, user_id, position)
      VALUES (v_setlist_uuid, v_song_uuid, v_user_id, v_pos);
      v_pos := v_pos + 1;
    END LOOP;
  END IF;

  UPDATE public.setlists
  SET song_ids = COALESCE(to_jsonb(p_song_ids), '[]'::jsonb)
  WHERE id = v_setlist_uuid
    AND user_id = v_user_id
  RETURNING server_version INTO v_new_version;

  IF v_new_version IS NULL OR v_new_version <= 0 THEN
    RAISE EXCEPTION 'Missing version: Setlist update did not return a positive server_version'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_new_version;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_setlist_songs(text, text[], bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_setlist_songs(text, text[], bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.replace_setlist_songs(text, text[], bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.songbinder_touch_sync_metadata() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.songbinder_touch_sync_metadata() FROM anon;
GRANT EXECUTE ON FUNCTION public.songbinder_touch_sync_metadata() TO authenticated;

COMMENT ON COLUMN public.songs.server_version IS 'Server-assigned sequence version bumped on every insert, update, or soft-delete as a record-level optimistic concurrency token (not a commit-ordered global cursor).';
COMMENT ON COLUMN public.setlists.server_version IS 'Server-assigned sequence version bumped on every insert, update, or soft-delete as a record-level optimistic concurrency token (not a commit-ordered global cursor).';
COMMENT ON FUNCTION public.replace_setlist_songs(text, text[], bigint) IS 'Atomic, authenticated, version-guarded transaction replacing ordered setlist_songs and setlists.song_ids, returning the new server_version.';

COMMIT;
