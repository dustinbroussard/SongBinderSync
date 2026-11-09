-- =============================================================================
-- SongBinder Phase 1 Database Migration Script (Security Hardened)
-- Purpose: Enable complete metadata preservation, safe deletion synchronization,
--          and atomic setlist song ordering without breaking existing data.
-- 
-- IMPORTANT INSTRUCTIONS:
-- - DO NOT run this script automatically; review it first.
-- - To execute, paste this script into your Supabase Dashboard: SQL Editor -> Run.
-- - This script is completely NON-DESTRUCTIVE:
--     * It never drops or recreates existing tables.
--     * It preserves all existing rows, foreign keys, RLS policies, and legacy IDs.
-- =============================================================================

-- 1. Preserve complete musical metadata, BPM, and soft-delete tombstones on songs
ALTER TABLE public.songs 
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS bpm integer,
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

-- Index to quickly query active vs deleted songs per user
CREATE INDEX IF NOT EXISTS idx_songs_user_deleted 
  ON public.songs (user_id, deleted_at);

-- 2. Preserve ordered song IDs and soft-delete tombstones on setlists
ALTER TABLE public.setlists 
  ADD COLUMN IF NOT EXISTS song_ids jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

-- Index to quickly query active vs deleted setlists per user
CREATE INDEX IF NOT EXISTS idx_setlists_user_deleted 
  ON public.setlists (user_id, deleted_at);

-- Safe backfill: Populate song_ids for existing setlists from setlist_songs in position order.
-- Only targets setlists where song_ids is empty or null, preserving any existing order.
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

-- 3. Secure Atomic Setlist Song Ordering Function
-- Hardened Security Features:
--   a) Derives user identity exclusively from auth.uid() (caller cannot pass arbitrary user_id).
--   b) Locks the target setlist row using FOR UPDATE to prevent race conditions.
--   c) Verifies that target setlist belongs to the authenticated user and is not deleted.
--   d) Validates that EVERY song in p_song_ids belongs to the authenticated user and is active.
--   e) Performs all validation BEFORE modifying setlist_songs (if validation fails, existing links are untouched).
--   f) Sets search_path = '' to prevent search path hijacking attacks.
--   g) Atomically updates both setlist_songs and setlists.song_ids in the same transaction.
--   h) Revokes execution from PUBLIC and anon; grants execution strictly to authenticated users.
CREATE OR REPLACE FUNCTION public.replace_setlist_songs(
  p_setlist_id text,
  p_song_ids text[]
) RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_setlist_id uuid;
  v_song_id text;
  v_song_db_id uuid;
  v_pos int := 1;
BEGIN
  -- 1. Derive user identity exclusively from auth.uid()
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: User is not authenticated';
  END IF;

  -- 2. Lock target setlist row and verify ownership and active status
  SELECT s.id INTO v_setlist_id
  FROM public.setlists s
  WHERE s.id::text = p_setlist_id 
    AND s.user_id = v_user_id 
    AND s.deleted_at IS NULL
  FOR UPDATE;

  IF v_setlist_id IS NULL THEN
    RAISE EXCEPTION 'Access denied: Setlist not found, deleted, or unauthorized';
  END IF;

  -- 3 & 4. Validate ALL requested song IDs BEFORE modifying any data:
  -- Verify every song belongs to the authenticated user and is active (not deleted).
  IF p_song_ids IS NOT NULL AND array_length(p_song_ids, 1) > 0 THEN
    IF EXISTS (
      SELECT 1 
      FROM unnest(p_song_ids) AS requested(requested_song_id)
      WHERE NOT EXISTS (
        SELECT 1 
        FROM public.songs s 
        WHERE s.id::text = requested.requested_song_id 
          AND s.user_id = v_user_id 
          AND s.deleted_at IS NULL
      )
    ) THEN
      RAISE EXCEPTION 'Validation failed: One or more songs are invalid, deleted, or unauthorized';
    END IF;
  END IF;

  -- 5. All validations passed. Atomic modification within this transaction:
  -- Clear previous entries for this setlist
  DELETE FROM public.setlist_songs 
  WHERE setlist_id::text = p_setlist_id AND user_id = v_user_id;

  -- Re-insert songs in the exact specified order
  IF p_song_ids IS NOT NULL AND array_length(p_song_ids, 1) > 0 THEN
    FOREACH v_song_id IN ARRAY p_song_ids LOOP
      -- Fetch exact primary key from songs table to guarantee type compatibility
      SELECT s.id INTO v_song_db_id
      FROM public.songs s
      WHERE s.id::text = v_song_id;

      INSERT INTO public.setlist_songs (setlist_id, song_id, user_id, position)
      VALUES (v_setlist_id, v_song_db_id, v_user_id, v_pos);
      v_pos := v_pos + 1;
    END LOOP;
  END IF;

  -- Atomically update setlists.song_ids to guarantee 100% ongoing consistency between both representations
  UPDATE public.setlists
  SET song_ids = COALESCE(to_jsonb(p_song_ids), '[]'::jsonb),
      updated_at = now()
  WHERE id = v_setlist_id;
END;
$$;

-- 6. Explicitly revoke execution from unauthenticated roles and grant only to authenticated users
REVOKE ALL ON FUNCTION public.replace_setlist_songs(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_setlist_songs(text, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.replace_setlist_songs(text, text[]) TO authenticated;

-- Documentation comments
COMMENT ON COLUMN public.songs.metadata IS 'Stores musical key, tempo, time signature, performance notes, tags, and formatting.';
COMMENT ON COLUMN public.songs.bpm IS 'Song tempo in beats per minute.';
COMMENT ON COLUMN public.songs.deleted_at IS 'Timestamp of deletion. Prevents deleted songs from resurrecting across devices.';
COMMENT ON COLUMN public.setlists.song_ids IS 'Ordered array of Supabase song UUIDs, providing atomic redundancy alongside relational setlist_songs links.';
COMMENT ON COLUMN public.setlists.deleted_at IS 'Timestamp of deletion. Prevents deleted setlists from resurrecting across devices.';
COMMENT ON FUNCTION public.replace_setlist_songs(text, text[]) IS 'Atomic, authenticated transaction to replace ordered songs in setlist_songs and update setlists.song_ids.';
