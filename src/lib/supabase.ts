import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

let client: ReturnType<typeof createClient> | null = null;

export function isConfigured(): boolean {
  return !!(
    supabaseUrl &&
    supabaseAnonKey
  );
}

export function getClient() {
  if (client || !isConfigured()) return client;
  client = createClient(supabaseUrl, supabaseAnonKey);
  return client;
}

export function getRedirectUrl() {
  try {
    const redirectUrl = new URL(window.location.href);
    redirectUrl.hash = '';
    redirectUrl.search = '';
    return redirectUrl.toString();
  } catch {
    return window.location.href;
  }
}

export async function getSession() {
  const supabaseClient = getClient();
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  return data?.session || null;
}

export async function getCurrentUser() {
  const session = await getSession();
  return session?.user || null;
}

export async function signInWithGoogle() {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  
  const { data, error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: getRedirectUrl(),
    },
  });
  
  if (error) throw error;
  return data;
}

export async function signOut() {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw error;
}

// -------------------------------------------------------------
// Song operations: Full metadata preservation & soft-delete support
// -------------------------------------------------------------

export async function upsertSongToSupabase(song: any, userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!song?.id) throw new Error('Song is missing an id.');
  if (!userId) throw new Error('User id is required for song upsert.');

  const legacyId = String(song.id).trim();
  const rawTitle = String(song.title || '').trim();
  const rawLyrics = String(song.lyrics || '');
  const metadata = song.metadata && typeof song.metadata === 'object' ? song.metadata : {};
  const bpm = typeof song.bpm === 'number' ? song.bpm : null;
  const updatedAtIso = song.updatedAt ? new Date(song.updatedAt).toISOString() : new Date().toISOString();

  // Try full payload preserving all musical metadata, BPM, and active status
  const fullPayload = {
    user_id: String(userId).trim(),
    legacy_id: legacyId,
    title: rawTitle,
    lyrics: rawLyrics,
    metadata,
    bpm,
    deleted_at: null,
    updated_at: updatedAtIso,
  };

  try {
    const result = await (supabaseClient as any)
      .from('songs')
      .upsert(fullPayload, { onConflict: 'user_id,legacy_id' })
      .select('id,user_id,title,lyrics,created_at,updated_at,legacy_id,metadata,bpm,deleted_at')
      .single();

    if (!result.error) {
      return result.data || null;
    }

    // Check if error is due to missing columns (e.g. metadata, bpm, deleted_at not yet migrated)
    const errCode = result.error.code;
    const errMsg = (result.error.message || '').toLowerCase();
    const isColumnMissing = errCode === '42703' || errMsg.includes('column') || errMsg.includes('metadata') || errMsg.includes('bpm') || errMsg.includes('deleted_at');

    if (!isColumnMissing) {
      console.error('[SongSync] Song upsert error', result.error);
      throw result.error;
    }

    console.warn('[SongSync] Supabase "songs" table missing metadata/bpm/deleted_at columns. Run the Phase 1 migration SQL. Falling back to basic payload.');
  } catch (err: any) {
    const errMsg = (err?.message || '').toLowerCase();
    const isColumnMissing = err?.code === '42703' || errMsg.includes('column') || errMsg.includes('metadata') || errMsg.includes('bpm');
    if (!isColumnMissing) {
      throw err;
    }
  }

  // Backwards-compatible fallback if columns are not yet created in Supabase
  const basicPayload = {
    user_id: String(userId).trim(),
    legacy_id: legacyId,
    title: rawTitle,
    lyrics: rawLyrics,
  };

  const fallbackResult = await (supabaseClient as any)
    .from('songs')
    .upsert(basicPayload, { onConflict: 'user_id,legacy_id' })
    .select('id,user_id,title,lyrics,created_at,updated_at,legacy_id')
    .single();

  if (fallbackResult.error) {
    console.error('[SongSync] Song fallback upsert error', fallbackResult.error);
    throw fallbackResult.error;
  }
  return fallbackResult.data || null;
}

export async function fetchSongsForUser(userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient || !userId) return [];

  // Try selecting all columns including metadata, bpm, and deleted_at
  try {
    const result = await supabaseClient
      .from('songs')
      .select('id,user_id,title,lyrics,created_at,updated_at,legacy_id,metadata,bpm,deleted_at')
      .eq('user_id', userId);

    if (!result.error) {
      return result.data || [];
    }

    const errCode = result.error.code;
    const errMsg = (result.error.message || '').toLowerCase();
    const isColumnMissing = errCode === '42703' || errMsg.includes('column') || errMsg.includes('metadata') || errMsg.includes('bpm');

    if (!isColumnMissing) {
      console.error('[SongSync] Songs fetch error', result.error);
      throw result.error;
    }
  } catch (err) {
    // Column missing; fall through to basic select
  }

  // Fallback select for older schema without metadata/bpm/deleted_at columns
  const fallbackResult = await supabaseClient
    .from('songs')
    .select('id,user_id,title,lyrics,created_at,updated_at,legacy_id')
    .eq('user_id', userId);

  if (fallbackResult.error) {
    console.error('[SongSync] Songs fallback fetch error', fallbackResult.error);
    throw fallbackResult.error;
  }
  return fallbackResult.data || [];
}

/**
 * Propagates a song deletion tombstone to Supabase so other devices know the song was deleted.
 */
export async function markSongDeletedInSupabase(legacyId: string, deletedAt: number, userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient || !legacyId || !userId) return;

  const deletedIso = new Date(deletedAt).toISOString();

  try {
    // Attempt soft delete with tombstone timestamp
    const { error } = await (supabaseClient as any)
      .from('songs')
      .update({ deleted_at: deletedIso })
      .eq('user_id', userId)
      .eq('legacy_id', legacyId);

    if (!error) return;

    // If deleted_at column is missing, perform hard delete as fallback
    const errMsg = (error.message || '').toLowerCase();
    if (error.code === '42703' || errMsg.includes('column') || errMsg.includes('deleted_at')) {
      await (supabaseClient as any)
        .from('songs')
        .delete()
        .eq('user_id', userId)
        .eq('legacy_id', legacyId);
    }
  } catch (err) {
    console.warn('[SongSync] Error marking song deleted in Supabase:', err);
  }
}

// -------------------------------------------------------------
// Setlist operations: Atomic updates, song order, & soft-deletes
// -------------------------------------------------------------

export async function upsertSetlistToSupabase(setlist: any, userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!setlist?.id) throw new Error('Setlist is missing an id.');
  if (!userId) throw new Error('User id is required for setlist upsert.');

  const legacyId = String(setlist.id).trim();
  const rawName = String(setlist.name || '').trim();
  const updatedAtIso = setlist.updatedAt ? new Date(setlist.updatedAt).toISOString() : new Date().toISOString();

  // Upsert setlist record without writing song_ids.
  // The replace_setlist_songs RPC (or fallback) is the authoritative writer of song_ids alongside relational links.
  const fullPayload = {
    user_id: String(userId).trim(),
    legacy_id: legacyId,
    name: rawName,
    deleted_at: null,
    updated_at: updatedAtIso,
  };

  try {
    const result = await (supabaseClient as any)
      .from('setlists')
      .upsert(fullPayload, { onConflict: 'user_id,legacy_id' })
      .select('id,user_id,name,created_at,updated_at,legacy_id,deleted_at')
      .single();

    if (!result.error) {
      return result.data || null;
    }

    const errCode = result.error.code;
    const errMsg = (result.error.message || '').toLowerCase();
    const isColumnMissing = errCode === '42703' || errMsg.includes('column') || errMsg.includes('deleted_at');

    if (!isColumnMissing) {
      console.error('[SongSync] Setlist upsert error', result.error);
      throw result.error;
    }

    console.warn('[SongSync] Supabase "setlists" table missing deleted_at column. Falling back to basic payload.');
  } catch (err: any) {
    const errMsg = (err?.message || '').toLowerCase();
    const isColumnMissing = err?.code === '42703' || errMsg.includes('column') || errMsg.includes('deleted_at');
    if (!isColumnMissing) throw err;
  }

  // Backwards-compatible fallback if columns are not yet in Supabase
  const basicPayload = {
    user_id: String(userId).trim(),
    legacy_id: legacyId,
    name: rawName,
  };

  const fallbackResult = await (supabaseClient as any)
    .from('setlists')
    .upsert(basicPayload, { onConflict: 'user_id,legacy_id' })
    .select('id,user_id,name,created_at,updated_at,legacy_id')
    .single();

  if (fallbackResult.error) {
    console.error('[SongSync] Setlist fallback upsert error', fallbackResult.error);
    throw fallbackResult.error;
  }
  return fallbackResult.data || null;
}

export async function fetchSetlistsForUser(userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient || !userId) return [];

  let setlistsData: any[] = [];

  // Try selecting full columns including song_ids and deleted_at
  try {
    const result = await supabaseClient
      .from('setlists')
      .select('id,user_id,name,created_at,updated_at,legacy_id,song_ids,deleted_at')
      .eq('user_id', userId);

    if (!result.error) {
      setlistsData = result.data || [];
    } else {
      const errCode = result.error.code;
      const errMsg = (result.error.message || '').toLowerCase();
      const isColumnMissing = errCode === '42703' || errMsg.includes('column') || errMsg.includes('song_ids');

      if (!isColumnMissing) {
        console.error('[SongSync] Setlists fetch error', result.error);
        throw result.error;
      }
    }
  } catch {
    // Column missing; fall through to basic select
  }

  if (!setlistsData.length) {
    const fallbackResult = await supabaseClient
      .from('setlists')
      .select('id,user_id,name,created_at,updated_at,legacy_id')
      .eq('user_id', userId);

    if (fallbackResult.error) {
      console.error('[SongSync] Setlists fallback fetch error', fallbackResult.error);
      throw fallbackResult.error;
    }
    setlistsData = fallbackResult.data || [];
  }

  // Fetch relational links from setlist_songs
  let linkRows: any[] = [];
  const remoteSetlistIds = setlistsData
    .map((setlist: any) => String(setlist?.id || '').trim())
    .filter(Boolean);

  try {
    let linkResult = await supabaseClient
      .from('setlist_songs')
      .select('setlist_id,song_id,position')
      .eq('user_id', userId);

    if (!linkResult.error && (!linkResult.data || !linkResult.data.length) && remoteSetlistIds.length) {
      linkResult = await supabaseClient
        .from('setlist_songs')
        .select('setlist_id,song_id,position')
        .in('setlist_id', remoteSetlistIds);
    }

    if (!linkResult.error) {
      linkRows = (linkResult.data || []).slice().sort((a: any, b: any) => {
        const left = Number.isFinite(Number(a?.position)) ? Number(a.position) : 0;
        const right = Number.isFinite(Number(b?.position)) ? Number(b.position) : 0;
        return left - right;
      });
    }
  } catch (error) {
    console.warn('[SongSync] setlist_songs fetch failed, continuing with direct setlist song_ids', error);
  }

  const songIdsBySetlist = new Map<string, string[]>();
  for (const row of linkRows) {
    const setlistId = String(row?.setlist_id || '').trim();
    const songId = String(row?.song_id || '').trim();
    if (!setlistId || !songId) continue;
    if (!songIdsBySetlist.has(setlistId)) songIdsBySetlist.set(setlistId, []);
    songIdsBySetlist.get(setlistId)!.push(songId);
  }

  return setlistsData.map((setlist: any) => {
    const setlistId = String(setlist?.id || '').trim();
    const relationalSongs = songIdsBySetlist.get(setlistId);
    
    // Prefer relational linkRows if available, otherwise fall back to direct song_ids column
    const songs = (relationalSongs && relationalSongs.length > 0)
      ? relationalSongs
      : (Array.isArray(setlist?.song_ids) ? setlist.song_ids : []);

    return {
      ...setlist,
      songs,
    };
  });
}

/**
 * Determines whether an error returned from Supabase RPC indicates that the function
 * is genuinely missing or unavailable on the database schema, as opposed to a business logic,
 * authorization, or validation error.
 */
function isRpcUnavailableError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim().toUpperCase();
  const message = String(err.message || '').toLowerCase();

  // 1. PostgREST error code: Function not found in schema cache
  if (code === 'PGRST202') return true;

  // 2. PostgreSQL error code: undefined_function (SQLSTATE 42883)
  if (code === '42883') return true;

  // 3. HTTP 404 Not Found specifically for missing replace_setlist_songs RPC endpoint.
  // Unrelated 404s (e.g., general route, proxy, or gateway errors) are never classified as an unavailable RPC.
  const details = String(err.details || '').toLowerCase();
  if (err.status === 404 && (message.includes('replace_setlist_songs') || details.includes('replace_setlist_songs'))) {
    return true;
  }

  // 4. Exact PostgREST / Postgres missing-function message patterns only
  if (
    message.includes('could not find the function public.replace_setlist_songs in the schema cache') ||
    message.includes('could not find the function replace_setlist_songs in the schema cache') ||
    message.includes('function replace_setlist_songs does not exist') ||
    message.includes('function public.replace_setlist_songs does not exist')
  ) {
    return true;
  }

  return false;
}

/**
 * Replaces songs in setlist_songs in Supabase with transaction safety.
 * - Primary Path: Atomic Postgres RPC (replace_setlist_songs) providing true ACID atomicity.
 * - Secondary Fallback: Client-side sequential compensation ONLY when the RPC is confirmed missing.
 */
export async function replaceSetlistSongsInSupabase(setlistId: string, remoteSongIds: string[], userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!setlistId) throw new Error('Setlist id is missing.');
  if (!userId) throw new Error('User id is required for setlist song sync.');

  const orderedSongIds = Array.isArray(remoteSongIds) ? remoteSongIds.filter(Boolean) : [];

  // Attempt atomic server transaction via RPC if migration script was executed
  try {
    const { error: rpcError } = await (supabaseClient as any)
      .rpc('replace_setlist_songs', {
        p_setlist_id: String(setlistId),
        p_song_ids: orderedSongIds.map(String),
      });

    if (!rpcError) {
      return { skipped: false, count: orderedSongIds.length, method: 'rpc' };
    }

    // Strict Error Classification:
    // Only fall back to client-side sequential update if the RPC is demonstrably missing/unavailable.
    // Never fall back on authentication, authorization, ownership, or validation failures.
    if (isRpcUnavailableError(rpcError)) {
      console.warn('[SongSync] replace_setlist_songs RPC is not installed on Supabase. Falling back to client-side sequential update.', rpcError);
    } else {
      console.error('[SongSync] replace_setlist_songs RPC rejected with validation or database error:', rpcError);
      throw rpcError;
    }
  } catch (rpcCallErr: any) {
    if (isRpcUnavailableError(rpcCallErr)) {
      console.warn('[SongSync] replace_setlist_songs RPC is not available. Falling back to client-side sequential update.', rpcCallErr);
    } else {
      throw rpcCallErr;
    }
  }

  // Fallback Preflight Security Validation:
  // Avoid relying solely on caller-supplied userId: Verify active authenticated Supabase session
  const currentUser = await getCurrentUser();
  if (!currentUser || !currentUser.id) {
    throw new Error('Unauthorized: No active authenticated Supabase session.');
  }
  if (currentUser.id !== userId) {
    throw new Error('Forbidden: Caller userId does not match authenticated user session.');
  }
  const effectiveUserId = currentUser.id;

  // 1. Verify target setlist exists, belongs to authenticated user, and is active (deleted_at IS NULL)
  const { data: setlistRow, error: setlistFetchErr } = await (supabaseClient as any)
    .from('setlists')
    .select('id, user_id, deleted_at')
    .eq('id', String(setlistId))
    .single();

  if (setlistFetchErr || !setlistRow) {
    console.error('[SongSync] Preflight failed: Target setlist not found or unauthorized', setlistFetchErr);
    throw new Error(`Validation failed: Target setlist not found or unauthorized (${setlistFetchErr?.message || 'not found'}).`);
  }

  if (setlistRow.user_id !== effectiveUserId) {
    throw new Error('Forbidden: Target setlist does not belong to the authenticated user.');
  }

  if (setlistRow.deleted_at) {
    throw new Error('Validation failed: Target setlist has been deleted.');
  }

  // 2. If songs are requested, verify EVERY requested song exists, belongs to authenticated user,
  // and has deleted_at IS NULL BEFORE modifying any existing links.
  if (orderedSongIds.length > 0) {
    const { data: songsData, error: songsFetchErr } = await (supabaseClient as any)
      .from('songs')
      .select('id, user_id, deleted_at')
      .in('id', orderedSongIds);

    if (songsFetchErr) {
      console.error('[SongSync] Preflight failed: Could not query songs for validation', songsFetchErr);
      throw new Error(`Validation failed: Error querying songs for validation (${songsFetchErr.message || songsFetchErr}).`);
    }

    const activeUserSongs = new Set(
      (songsData || [])
        .filter((s: any) => s.user_id === effectiveUserId && !s.deleted_at)
        .map((s: any) => String(s.id))
    );

    for (const songId of orderedSongIds) {
      if (!activeUserSongs.has(String(songId))) {
        throw new Error(`Validation failed: Song "${songId}" is invalid, deleted, or unauthorized.`);
      }
    }
  }

  // Safe client-side replacement:
  // 1. Snapshot existing links before making changes
  const { data: snapshotData, error: snapshotError } = await (supabaseClient as any)
    .from('setlist_songs')
    .select('setlist_id,song_id,position,user_id')
    .eq('user_id', effectiveUserId)
    .eq('setlist_id', String(setlistId));

  if (snapshotError) {
    console.error('[SongSync] Aborting setlist update: Failed to query existing setlist_songs snapshot.', snapshotError);
    throw new Error(`Failed to snapshot existing setlist links before update: ${snapshotError.message || snapshotError}`);
  }

  const existingLinks: any[] = snapshotData || [];

  try {
    // 2. Delete existing links
    const { error: deleteError } = await (supabaseClient as any)
      .from('setlist_songs')
      .delete()
      .eq('user_id', userId)
      .eq('setlist_id', String(setlistId));

    if (deleteError) {
      console.error('[SongSync] Failed to clear existing setlist_songs links:', deleteError);
      throw deleteError;
    }

    // 3. Handle intentionally emptied setlist:
    // Must update public.setlists.song_ids to [] so both representations agree
    if (!orderedSongIds.length) {
      let emptyUpdateError: any = null;
      try {
        const { error: updateError } = await (supabaseClient as any)
          .from('setlists')
          .update({
            song_ids: [],
            updated_at: new Date().toISOString()
          })
          .eq('id', String(setlistId))
          .eq('user_id', String(userId));
        
        if (updateError) {
          emptyUpdateError = updateError;
        }
      } catch (err) {
        emptyUpdateError = err;
      }

      if (emptyUpdateError) {
        console.warn('[SongSync] Partial success: setlist_songs cleared, but setlists.song_ids update to [] failed. Next sync will self-heal.', emptyUpdateError);
        return {
          skipped: false,
          count: 0,
          method: 'direct_partial',
          warning: 'Relational links cleared, but song_ids update to [] failed. Next sync will self-heal.'
        };
      }

      return { skipped: false, count: 0, method: 'direct' };
    }

    // 4. Insert new ordered rows for non-empty setlist
    const rows = orderedSongIds.map((songId, index) => ({
      user_id: String(userId),
      setlist_id: String(setlistId),
      song_id: String(songId),
      position: index + 1,
    }));

    const { error: insertError } = await (supabaseClient as any)
      .from('setlist_songs')
      .insert(rows);

    if (insertError) {
      console.error('[SongSync] setlist_songs insert error, attempting client-side compensating restoration', insertError);
      
      // Best-effort compensating restoration using saved snapshot
      let restorationFailed = false;
      let restorationError: any = null;
      if (existingLinks.length > 0) {
        try {
          const { error: restoreErr } = await (supabaseClient as any)
            .from('setlist_songs')
            .insert(existingLinks);
          if (restoreErr) {
            restorationFailed = true;
            restorationError = restoreErr;
          }
        } catch (rErr) {
          restorationFailed = true;
          restorationError = rErr;
        }
      }

      if (restorationFailed) {
        console.error('[SongSync] CRITICAL: Compensating restoration failed. Setlist songs on cloud may be empty until next sync.', restorationError);
        throw new Error(`Replacement failed (${insertError.message || insertError}) and compensating restoration failed (${restorationError?.message || restorationError}). Local Dexie data remains intact.`);
      }

      throw insertError;
    }

    // 5. Client-side sequential fallback for setlists.song_ids:
    // IMPORTANT ARCHITECTURAL NOTE:
    // This fallback is NOT ACID-atomic. It executes as a separate, sequential HTTP request after
    // relational setlist_songs rows are successfully inserted. If an interruption occurs here,
    // relational links are already safe in Supabase, and the next sync cycle will heal the song_ids column.
    let songIdsUpdateError: any = null;
    try {
      const { error: updateError } = await (supabaseClient as any)
        .from('setlists')
        .update({
          song_ids: orderedSongIds,
          updated_at: new Date().toISOString()
        })
        .eq('id', String(setlistId))
        .eq('user_id', String(userId));
      
      if (updateError) {
        songIdsUpdateError = updateError;
      }
    } catch (fallbackUpdateErr) {
      songIdsUpdateError = fallbackUpdateErr;
    }

    if (songIdsUpdateError) {
      console.warn('[SongSync] Partial success: setlist_songs rows updated, but setlists.song_ids JSONB update failed. Relational links are intact; next sync will repair the JSONB column.', songIdsUpdateError);
      return {
        skipped: false,
        count: rows.length,
        method: 'direct_partial',
        warning: 'Relational links replaced, but song_ids column update failed. Next sync will self-heal.'
      };
    }

    return { skipped: false, count: rows.length, method: 'direct' };
  } catch (error) {
    console.error('[SongSync] replaceSetlistSongsInSupabase direct fallback failed:', error);
    throw error;
  }
}

/**
 * Propagates a setlist deletion tombstone to Supabase so other devices know it was deleted.
 */
export async function markSetlistDeletedInSupabase(legacyId: string, deletedAt: number, userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient || !legacyId || !userId) return;

  const deletedIso = new Date(deletedAt).toISOString();

  try {
    const { error } = await (supabaseClient as any)
      .from('setlists')
      .update({ deleted_at: deletedIso })
      .eq('user_id', userId)
      .eq('legacy_id', legacyId);

    if (!error) return;

    const errMsg = (error.message || '').toLowerCase();
    if (error.code === '42703' || errMsg.includes('column') || errMsg.includes('deleted_at')) {
      await (supabaseClient as any)
        .from('setlists')
        .delete()
        .eq('user_id', userId)
        .eq('legacy_id', legacyId);
    }
  } catch (err) {
    console.warn('[SongSync] Error marking setlist deleted in Supabase:', err);
  }
}

export async function upsertProfile(user: any) {
  const supabaseClient = getClient();
  if (!supabaseClient || !user?.id) return { skipped: true };

  const payload = {
    id: String(user.id).trim(),
  };

  const { error } = await (supabaseClient as any)
    .from('profiles')
    .upsert(payload, { onConflict: 'id' });

  if (error) {
    console.error('[SongSync] Profile upsert error', error);
    throw error;
  }
  return { skipped: false };
}
