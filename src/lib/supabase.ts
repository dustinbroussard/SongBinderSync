import { createClient, type AuthChangeEvent, type Session } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

const PAGE_SIZE = 500;
const UPSERT_BATCH_SIZE = 50;

let client: ReturnType<typeof createClient> | null = null;

export function isConfigured(): boolean {
  return !!(supabaseUrl && supabaseAnonKey);
}

export function getClient() {
  if (client || !isConfigured()) return client;
  client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
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

export async function refreshAuthSession() {
  const supabaseClient = getClient();
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.refreshSession();
  if (error) throw error;
  return data?.session || null;
}

export async function getCurrentUser() {
  const session = await getSession();
  return session?.user || null;
}

export function subscribeToAuthChanges(
  callback: (event: AuthChangeEvent, session: Session | null) => void
): () => void {
  const supabaseClient = getClient();
  if (!supabaseClient) return () => {};
  const { data } = supabaseClient.auth.onAuthStateChange(callback);
  return () => {
    data.subscription.unsubscribe();
  };
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

function isMissingColumnError(err: any, columnHints: string[] = []): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim().toUpperCase();
  const message = String(err.message || '').toLowerCase();
  if (code === '42703' || code === 'PGRST204') return true;
  if (message.includes('column') && message.includes('does not exist')) return true;
  if (message.includes('schema cache') && columnHints.some((hint) => message.includes(hint))) return true;
  return false;
}

// -------------------------------------------------------------
// Song operations: Conditional optimistic concurrency, fetch, soft delete
// -------------------------------------------------------------

const SONG_PHASE2_COLUMNS =
  'id,user_id,title,lyrics,created_at,updated_at,legacy_id,metadata,bpm,deleted_at,server_version';

export type ConditionalWriteResult<T = any> =
  | { status: 'ok'; row: T }
  | { status: 'conflict'; remoteRow: T }
  | { status: 'conflict_fetch_failed'; error: string }
  | { status: 'missing_version_mechanism'; error: string };

type CloudRowFetchResult<T = any> =
  | { status: 'ok'; row: T }
  | { status: 'not_found' }
  | { status: 'missing_version_mechanism'; error: string }
  | { status: 'error'; error: string };

function isUniqueViolationError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim();
  const message = String(err.message || '').toLowerCase();
  return code === '23505' || message.includes('duplicate key value violates unique constraint');
}

export async function fetchSongByIdForUser(
  userId: string,
  remoteId: string
): Promise<CloudRowFetchResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) return { status: 'error', error: 'Supabase client is not configured.' };
  const cleanUserId = String(userId || '').trim();
  const cleanRemoteId = String(remoteId || '').trim();
  if (!cleanUserId || !cleanRemoteId) {
    return { status: 'error', error: 'User id and remote song id are required.' };
  }

  const { data, error } = await (supabaseClient as any)
    .from('songs')
    .select(SONG_PHASE2_COLUMNS)
    .eq('user_id', cleanUserId)
    .eq('id', cleanRemoteId)
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'metadata', 'bpm', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase songs table is missing required Phase 2 columns (server_version/metadata/bpm/deleted_at).',
      };
    }
    return { status: 'error', error: error.message || String(error) };
  }

  if (!data) return { status: 'not_found' };
  const version = Number(data.server_version);
  if (!Number.isFinite(version) || version <= 0) {
    return {
      status: 'missing_version_mechanism',
      error: 'Supabase songs record is missing a valid positive server_version.',
    };
  }
  return { status: 'ok', row: data };
}

export async function fetchSongByLegacyIdForUser(
  userId: string,
  legacyId: string
): Promise<CloudRowFetchResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) return { status: 'error', error: 'Supabase client is not configured.' };
  const cleanUserId = String(userId || '').trim();
  const cleanLegacyId = String(legacyId || '').trim();
  if (!cleanUserId || !cleanLegacyId) {
    return { status: 'error', error: 'User id and legacy song id are required.' };
  }

  const { data, error } = await (supabaseClient as any)
    .from('songs')
    .select(SONG_PHASE2_COLUMNS)
    .eq('user_id', cleanUserId)
    .eq('legacy_id', cleanLegacyId)
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'metadata', 'bpm', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase songs table is missing required Phase 2 columns (server_version/metadata/bpm/deleted_at).',
      };
    }
    return { status: 'error', error: error.message || String(error) };
  }

  if (!data) return { status: 'not_found' };
  const version = Number(data.server_version);
  if (!Number.isFinite(version) || version <= 0) {
    return {
      status: 'missing_version_mechanism',
      error: 'Supabase songs record is missing a valid positive server_version.',
    };
  }
  return { status: 'ok', row: data };
}

function mapCloudFetchToConflict(
  fetched: CloudRowFetchResult<any>,
  notFoundMessage: string
): ConditionalWriteResult<any> {
  if (fetched.status === 'ok') {
    return { status: 'conflict', remoteRow: fetched.row };
  }
  if (fetched.status === 'missing_version_mechanism') {
    return { status: 'missing_version_mechanism', error: fetched.error };
  }
  if (fetched.status === 'not_found') {
    return { status: 'conflict_fetch_failed', error: notFoundMessage };
  }
  return { status: 'conflict_fetch_failed', error: fetched.error };
}

export async function insertSongToSupabase(
  song: any,
  userId: string
): Promise<ConditionalWriteResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!userId) throw new Error('User id is required for song insert.');
  if (!song?.id) throw new Error('Song is missing an id.');

  const cleanUserId = String(userId).trim();
  const legacyId = String(song.id).trim();
  const payload = {
    user_id: cleanUserId,
    legacy_id: legacyId,
    title: String(song.title || '').trim(),
    lyrics: String(song.lyrics || ''),
    metadata: song.metadata && typeof song.metadata === 'object' ? song.metadata : {},
    bpm: typeof song.bpm === 'number' ? song.bpm : null,
    deleted_at: null,
  };

  const { data, error } = await (supabaseClient as any)
    .from('songs')
    .insert(payload)
    .select(SONG_PHASE2_COLUMNS);

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'metadata', 'bpm', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase songs table is missing Phase 2 version/metadata columns. Run supabase_phase2_migration.sql before syncing edits.',
      };
    }

    if (isUniqueViolationError(error)) {
      const fetched = await fetchSongByLegacyIdForUser(cleanUserId, legacyId);
      return mapCloudFetchToConflict(
        fetched,
        `Song "${song.title || legacyId}" collided with an existing cloud record that could not be fetched.`
      );
    }

    console.error('[SongSync] Song insert error', error);
    throw error;
  }

  const insertedRow = data?.[0];
  const newVersion = Number(insertedRow?.server_version);
  if (!insertedRow?.id || !Number.isFinite(newVersion) || newVersion <= 0) {
    return {
      status: 'missing_version_mechanism',
      error:
        'Supabase songs insert did not return a valid positive server_version. Ensure Phase 2 server_version defaults/triggers are installed.',
    };
  }

  return { status: 'ok', row: insertedRow };
}

export async function updateSongConditionalInSupabase(
  song: any,
  userId: string
): Promise<ConditionalWriteResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!userId) throw new Error('User id is required for song update.');
  if (!song?.id) throw new Error('Song is missing an id.');

  const cleanUserId = String(userId).trim();
  const remoteId = song.remoteId ? String(song.remoteId).trim() : '';
  const baseVersion = Number(song.baseVersion);

  if (!remoteId) {
    return insertSongToSupabase(song, cleanUserId);
  }

  if (!Number.isFinite(baseVersion) || baseVersion <= 0) {
    const fetched = await fetchSongByIdForUser(cleanUserId, remoteId);
    return mapCloudFetchToConflict(
      fetched,
      `Song "${song.title || song.id}" is missing a valid baseVersion and its remote record could not be fetched.`
    );
  }

  const updatePayload = {
    title: String(song.title || '').trim(),
    lyrics: String(song.lyrics || ''),
    metadata: song.metadata && typeof song.metadata === 'object' ? song.metadata : {},
    bpm: typeof song.bpm === 'number' ? song.bpm : null,
    deleted_at: null,
  };

  const { data, error } = await (supabaseClient as any)
    .from('songs')
    .update(updatePayload)
    .eq('user_id', cleanUserId)
    .eq('id', remoteId)
    .eq('server_version', baseVersion)
    .select(SONG_PHASE2_COLUMNS);

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'metadata', 'bpm', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase songs table is missing Phase 2 version/metadata columns. Run supabase_phase2_migration.sql before syncing edits.',
      };
    }
    console.error('[SongSync] Song conditional update error', error);
    throw error;
  }

  if (!data || data.length === 0) {
    const fetched = await fetchSongByIdForUser(cleanUserId, remoteId);
    return mapCloudFetchToConflict(
      fetched,
      `Song "${song.title || song.id}" failed optimistic concurrency check at version ${baseVersion}, and the current remote row could not be retrieved.`
    );
  }

  const updatedRow = data[0];
  const newVersion = Number(updatedRow?.server_version);
  if (!Number.isFinite(newVersion) || newVersion <= 0 || newVersion === baseVersion) {
    return {
      status: 'missing_version_mechanism',
      error:
        'Supabase songs update did not advance server_version. Ensure the Phase 2 server_version trigger is active before trusting concurrent writes.',
    };
  }

  return { status: 'ok', row: updatedRow };
}

export async function saveSongWithConcurrency(
  song: any,
  userId: string
): Promise<ConditionalWriteResult<any>> {
  if (!song?.id) throw new Error('Song is missing an id.');
  if (song.remoteId) {
    return updateSongConditionalInSupabase(song, userId);
  }
  return insertSongToSupabase(song, userId);
}

export interface FetchSongsResult {
  rows: any[];
  hasExtendedColumns: boolean;
  hasServerVersion: boolean;
  isIncremental: boolean;
  isComplete: boolean;
}

export async function fetchSongsForUser(
  userId: string,
  _options?: { sinceVersion?: number }
): Promise<FetchSongsResult> {
  const supabaseClient = getClient();
  if (!supabaseClient || !userId) {
    return {
      rows: [],
      hasExtendedColumns: false,
      hasServerVersion: false,
      isIncremental: false,
      isComplete: false,
    };
  }

  // Retrieve the complete cloud snapshot across all pages using immutable PK ordering
  // so concurrent server_version updates cannot shift rows across page boundaries.
  const fetchAllPages = async (selectColumns: string) => {
    const allRows: any[] = [];
    const seenIds = new Set<string>();
    let offset = 0;

    while (true) {
      const { data, error } = await (supabaseClient as any)
        .from('songs')
        .select(selectColumns)
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) return { data: null, error };

      const page = data || [];
      for (const row of page) {
        const rowId = String(row?.id || '').trim();
        if (rowId && seenIds.has(rowId)) continue;
        if (rowId) seenIds.add(rowId);
        allRows.push(row);
      }

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return { data: allRows, error: null };
  };

  // 1. Try Phase 2 schema (with server_version + metadata + bpm + deleted_at)
  const p2 = await fetchAllPages(
    'id,user_id,title,lyrics,created_at,updated_at,legacy_id,metadata,bpm,deleted_at,server_version'
  );
  if (!p2.error) {
    return {
      rows: p2.data || [],
      hasExtendedColumns: true,
      hasServerVersion: true,
      isIncremental: false,
      isComplete: true,
    };
  }
  if (!isMissingColumnError(p2.error, ['server_version', 'metadata', 'bpm', 'deleted_at'])) {
    console.error('[SongSync] Songs fetch error', p2.error);
    throw p2.error;
  }

  // 2. Try Phase 1 schema (metadata, bpm, deleted_at without server_version)
  const p1 = await fetchAllPages(
    'id,user_id,title,lyrics,created_at,updated_at,legacy_id,metadata,bpm,deleted_at'
  );
  if (!p1.error) {
    return {
      rows: p1.data || [],
      hasExtendedColumns: true,
      hasServerVersion: false,
      isIncremental: false,
      isComplete: true,
    };
  }
  if (!isMissingColumnError(p1.error, ['metadata', 'bpm', 'deleted_at'])) {
    console.error('[SongSync] Songs Phase 1 fetch error', p1.error);
    throw p1.error;
  }

  // 3. Fallback to legacy schema (paginated)
  const legacy = await fetchAllPages('id,user_id,title,lyrics,created_at,updated_at,legacy_id');
  if (legacy.error) {
    console.error('[SongSync] Songs fallback fetch error', legacy.error);
    throw legacy.error;
  }

  return {
    rows: legacy.data || [],
    hasExtendedColumns: false,
    hasServerVersion: false,
    isIncremental: false,
    isComplete: true,
  };
}

export async function fetchSongsByIdsForUser(
  userId: string,
  songUuids: string[],
  hasExtendedColumns: boolean,
  hasServerVersion: boolean
): Promise<any[]> {
  const supabaseClient = getClient();
  const cleanIds = Array.from(new Set(songUuids.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!supabaseClient || !userId || cleanIds.length === 0) return [];

  const selectColumns = hasServerVersion
    ? 'id,user_id,title,lyrics,created_at,updated_at,legacy_id,metadata,bpm,deleted_at,server_version'
    : hasExtendedColumns
    ? 'id,user_id,title,lyrics,created_at,updated_at,legacy_id,metadata,bpm,deleted_at'
    : 'id,user_id,title,lyrics,created_at,updated_at,legacy_id';

  const rows: any[] = [];
  for (let i = 0; i < cleanIds.length; i += 100) {
    const chunk = cleanIds.slice(i, i + 100);
    const { data, error } = await (supabaseClient as any)
      .from('songs')
      .select(selectColumns)
      .eq('user_id', userId)
      .in('id', chunk);

    if (error) {
      console.error('[SongSync] Failed fetching referenced songs by ID:', error);
      throw error;
    }
    if (data?.length) rows.push(...data);
  }

  return rows;
}

export type ConditionalDeleteResult<T = any> =
  | { status: 'deleted'; row: T }
  | { status: 'already_deleted'; row?: T }
  | { status: 'conflict'; remoteRow: T }
  | { status: 'fetch_failed'; error: string }
  | { status: 'missing_version_mechanism'; error: string };

export type DeletionInspectResult<T = any> =
  | { status: 'not_found' }
  | { status: 'already_deleted'; row: T }
  | { status: 'active_found'; remoteRow: T }
  | { status: 'fetch_failed'; error: string }
  | { status: 'missing_version_mechanism'; error: string };

export async function inspectSongDeletionCandidateInSupabase(
  params: { legacyId: string; remoteId?: string },
  userId: string
): Promise<DeletionInspectResult<any>> {
  const cleanUserId = String(userId || '').trim();
  const cleanRemoteId = params.remoteId ? String(params.remoteId).trim() : '';
  const cleanLegacyId = params.legacyId ? String(params.legacyId).trim() : '';

  if (!cleanUserId || (!cleanRemoteId && !cleanLegacyId)) {
    return { status: 'fetch_failed', error: 'User id and song identifier are required.' };
  }

  let fetched = cleanRemoteId
    ? await fetchSongByIdForUser(cleanUserId, cleanRemoteId)
    : await fetchSongByLegacyIdForUser(cleanUserId, cleanLegacyId);

  if (fetched.status === 'not_found' && cleanRemoteId && cleanLegacyId) {
    fetched = await fetchSongByLegacyIdForUser(cleanUserId, cleanLegacyId);
  }

  if (fetched.status === 'missing_version_mechanism') {
    return { status: 'missing_version_mechanism', error: fetched.error };
  }
  if (fetched.status === 'error') {
    return { status: 'fetch_failed', error: fetched.error };
  }
  if (fetched.status === 'not_found') {
    return { status: 'not_found' };
  }

  if (fetched.row?.deleted_at) {
    return { status: 'already_deleted', row: fetched.row };
  }
  return { status: 'active_found', remoteRow: fetched.row };
}

export async function softDeleteSongConditionalInSupabase(
  params: { legacyId: string; remoteId?: string; baseVersion?: number; deletedAt?: number },
  userId: string
): Promise<ConditionalDeleteResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) {
    return { status: 'fetch_failed', error: 'Supabase client is not configured.' };
  }
  const cleanUserId = String(userId || '').trim();
  const cleanLegacyId = String(params.legacyId || '').trim();
  const cleanRemoteId = params.remoteId ? String(params.remoteId).trim() : '';
  const baseVersion = Number(params.baseVersion);

  if (!cleanUserId || !cleanLegacyId) {
    return { status: 'fetch_failed', error: 'User id and song id are required for deletion.' };
  }

  if (!cleanRemoteId || !Number.isFinite(baseVersion) || baseVersion <= 0) {
    const inspected = await inspectSongDeletionCandidateInSupabase(
      { legacyId: cleanLegacyId, remoteId: cleanRemoteId },
      cleanUserId
    );
    if (inspected.status === 'not_found') return { status: 'already_deleted' };
    if (inspected.status === 'already_deleted') {
      return { status: 'already_deleted', row: inspected.row };
    }
    if (inspected.status === 'active_found') {
      return { status: 'conflict', remoteRow: inspected.remoteRow };
    }
    return inspected;
  }

  const deletedIso = new Date(params.deletedAt || Date.now()).toISOString();
  const { data, error } = await (supabaseClient as any)
    .from('songs')
    .update({ deleted_at: deletedIso })
    .eq('user_id', cleanUserId)
    .eq('id', cleanRemoteId)
    .eq('server_version', baseVersion)
    .is('deleted_at', null)
    .select(SONG_PHASE2_COLUMNS);

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'metadata', 'bpm', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase songs table is missing Phase 2 deleted_at/server_version columns. Run supabase_phase2_migration.sql before syncing deletions.',
      };
    }
    console.error('[SongSync] Song conditional soft-delete error', error);
    return { status: 'fetch_failed', error: error.message || String(error) };
  }

  if (!data || data.length === 0) {
    const inspected = await inspectSongDeletionCandidateInSupabase(
      { legacyId: cleanLegacyId, remoteId: cleanRemoteId },
      cleanUserId
    );
    if (inspected.status === 'not_found') return { status: 'already_deleted' };
    if (inspected.status === 'already_deleted') {
      return { status: 'already_deleted', row: inspected.row };
    }
    if (inspected.status === 'active_found') {
      return { status: 'conflict', remoteRow: inspected.remoteRow };
    }
    return inspected;
  }

  const deletedRow = data[0];
  const newVersion = Number(deletedRow?.server_version);
  if (!deletedRow?.deleted_at || !Number.isFinite(newVersion) || newVersion <= 0 || newVersion === baseVersion) {
    return {
      status: 'missing_version_mechanism',
      error:
        'Supabase songs soft-delete did not advance server_version or record deleted_at. Ensure the Phase 2 server_version trigger is active.',
    };
  }

  return { status: 'deleted', row: deletedRow };
}

// -------------------------------------------------------------
// Setlist operations: Conditional optimistic concurrency, fetch, atomic RPC
// -------------------------------------------------------------

const SETLIST_PHASE2_COLUMNS =
  'id,user_id,name,created_at,updated_at,legacy_id,song_ids,deleted_at,server_version';

async function fetchOrderedLinksForSingleSetlist(
  supabaseClient: any,
  userId: string,
  setlistRemoteId: string
): Promise<{ songIds: string[]; error: string | null }> {
  const fetchAllPages = async (includeSurrogateId: boolean) => {
    const rows: any[] = [];
    const seenLinkIds = new Set<string>();
    let offset = 0;

    while (true) {
      let query = supabaseClient
        .from('setlist_songs')
        .select(includeSurrogateId ? 'id,setlist_id,song_id,position' : 'setlist_id,song_id,position')
        .eq('user_id', userId)
        .eq('setlist_id', setlistRemoteId)
        .order('position', { ascending: true })
        .order('song_id', { ascending: true });

      if (includeSurrogateId) {
        query = query.order('id', { ascending: true });
      }

      const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
      if (error) return { data: null, error };

      const page = data || [];
      for (const row of page) {
        if (includeSurrogateId && row?.id !== undefined && row?.id !== null) {
          const linkId = String(row.id);
          if (seenLinkIds.has(linkId)) continue;
          seenLinkIds.add(linkId);
        }
        rows.push(row);
      }

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return { data: rows, error: null };
  };

  let relResult = await fetchAllPages(true);
  if (relResult.error && isMissingColumnError(relResult.error, ['id'])) {
    relResult = await fetchAllPages(false);
  }

  if (relResult.error) {
    return { songIds: [], error: relResult.error.message || String(relResult.error) };
  }

  const linkRows = [...(relResult.data || [])];
  linkRows.sort((a: any, b: any) => {
    const posLeft = Number.isFinite(Number(a?.position)) ? Number(a.position) : 0;
    const posRight = Number.isFinite(Number(b?.position)) ? Number(b.position) : 0;
    if (posLeft !== posRight) return posLeft - posRight;

    const songCmp = String(a?.song_id || '').localeCompare(String(b?.song_id || ''));
    if (songCmp !== 0) return songCmp;

    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  });

  return {
    songIds: linkRows.map((r: any) => String(r?.song_id || '').trim()).filter(Boolean),
    error: null,
  };
}

async function fetchSetlistWithLinksByFilter(
  userId: string,
  filterColumn: 'id' | 'legacy_id',
  filterValue: string
): Promise<CloudRowFetchResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) return { status: 'error', error: 'Supabase client is not configured.' };
  const cleanUserId = String(userId || '').trim();
  const cleanVal = String(filterValue || '').trim();
  if (!cleanUserId || !cleanVal) {
    return { status: 'error', error: 'User id and setlist identifier are required.' };
  }

  const { data: row, error } = await (supabaseClient as any)
    .from('setlists')
    .select(SETLIST_PHASE2_COLUMNS)
    .eq('user_id', cleanUserId)
    .eq(filterColumn, cleanVal)
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'song_ids', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase setlists table is missing required Phase 2 columns (server_version/song_ids/deleted_at).',
      };
    }
    return { status: 'error', error: error.message || String(error) };
  }

  if (!row) return { status: 'not_found' };
  const version = Number(row.server_version);
  if (!Number.isFinite(version) || version <= 0) {
    return {
      status: 'missing_version_mechanism',
      error: 'Supabase setlists record is missing a valid positive server_version.',
    };
  }

  if (row.deleted_at) {
    return {
      status: 'ok',
      row: { ...row, songs: [], relationshipsLoaded: false },
    };
  }

  const linksRes = await fetchOrderedLinksForSingleSetlist(supabaseClient, cleanUserId, String(row.id));
  if (linksRes.error) {
    return {
      status: 'error',
      error: `Fetched conflicting setlist metadata, but failed to load setlist_songs links: ${linksRes.error}`,
    };
  }

  return {
    status: 'ok',
    row: {
      ...row,
      songs: linksRes.songIds,
      relationshipsLoaded: true,
    },
  };
}

export async function fetchSetlistWithLinksById(
  userId: string,
  remoteSetlistId: string
): Promise<CloudRowFetchResult<any>> {
  return fetchSetlistWithLinksByFilter(userId, 'id', remoteSetlistId);
}

export async function fetchSetlistWithLinksByLegacyId(
  userId: string,
  legacyId: string
): Promise<CloudRowFetchResult<any>> {
  return fetchSetlistWithLinksByFilter(userId, 'legacy_id', legacyId);
}

export async function insertSetlistMetadataToSupabase(
  setlist: any,
  userId: string
): Promise<ConditionalWriteResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!userId) throw new Error('User id is required for setlist insert.');
  if (!setlist?.id) throw new Error('Setlist is missing an id.');

  const cleanUserId = String(userId).trim();
  const legacyId = String(setlist.id).trim();
  // Do NOT write song_ids here: replace_setlist_songs RPC is authoritative for ordering
  const payload = {
    user_id: cleanUserId,
    legacy_id: legacyId,
    name: String(setlist.name || '').trim(),
    deleted_at: null,
  };

  const { data, error } = await (supabaseClient as any)
    .from('setlists')
    .insert(payload)
    .select(SETLIST_PHASE2_COLUMNS);

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'song_ids', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase setlists table is missing Phase 2 version/deleted_at columns. Run supabase_phase2_migration.sql before syncing edits.',
      };
    }

    if (isUniqueViolationError(error)) {
      const fetched = await fetchSetlistWithLinksByLegacyId(cleanUserId, legacyId);
      return mapCloudFetchToConflict(
        fetched,
        `Setlist "${setlist.name || legacyId}" collided with an existing cloud record that could not be fetched.`
      );
    }

    console.error('[SongSync] Setlist insert error', error);
    throw error;
  }

  const insertedRow = data?.[0];
  const newVersion = Number(insertedRow?.server_version);
  if (!insertedRow?.id || !Number.isFinite(newVersion) || newVersion <= 0) {
    return {
      status: 'missing_version_mechanism',
      error:
        'Supabase setlists insert did not return a valid positive server_version. Ensure Phase 2 server_version defaults/triggers are installed.',
    };
  }

  return { status: 'ok', row: insertedRow };
}

export async function updateSetlistMetadataConditionalInSupabase(
  setlist: any,
  userId: string
): Promise<ConditionalWriteResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!userId) throw new Error('User id is required for setlist update.');
  if (!setlist?.id) throw new Error('Setlist is missing an id.');

  const cleanUserId = String(userId).trim();
  const remoteId = setlist.remoteId ? String(setlist.remoteId).trim() : '';
  const baseVersion = Number(setlist.baseVersion);

  if (!remoteId) {
    return insertSetlistMetadataToSupabase(setlist, cleanUserId);
  }

  if (!Number.isFinite(baseVersion) || baseVersion <= 0) {
    const fetched = await fetchSetlistWithLinksById(cleanUserId, remoteId);
    return mapCloudFetchToConflict(
      fetched,
      `Setlist "${setlist.name || setlist.id}" is missing a valid baseVersion and its remote record could not be fetched.`
    );
  }

  // Do NOT write song_ids here: replace_setlist_songs RPC is authoritative for ordering
  const updatePayload = {
    name: String(setlist.name || '').trim(),
    deleted_at: null,
  };

  const { data, error } = await (supabaseClient as any)
    .from('setlists')
    .update(updatePayload)
    .eq('user_id', cleanUserId)
    .eq('id', remoteId)
    .eq('server_version', baseVersion)
    .select(SETLIST_PHASE2_COLUMNS);

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'song_ids', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase setlists table is missing Phase 2 version/deleted_at columns. Run supabase_phase2_migration.sql before syncing edits.',
      };
    }
    console.error('[SongSync] Setlist conditional update error', error);
    throw error;
  }

  if (!data || data.length === 0) {
    const fetched = await fetchSetlistWithLinksById(cleanUserId, remoteId);
    return mapCloudFetchToConflict(
      fetched,
      `Setlist "${setlist.name || setlist.id}" failed optimistic concurrency check at version ${baseVersion}, and the current remote row could not be retrieved.`
    );
  }

  const updatedRow = data[0];
  const newVersion = Number(updatedRow?.server_version);
  if (!Number.isFinite(newVersion) || newVersion <= 0 || newVersion === baseVersion) {
    return {
      status: 'missing_version_mechanism',
      error:
        'Supabase setlists update did not advance server_version. Ensure the Phase 2 server_version trigger is active before trusting concurrent writes.',
    };
  }

  return { status: 'ok', row: updatedRow };
}

export async function saveSetlistMetadataWithConcurrency(
  setlist: any,
  userId: string
): Promise<ConditionalWriteResult<any>> {
  if (!setlist?.id) throw new Error('Setlist is missing an id.');
  if (setlist.remoteId) {
    return updateSetlistMetadataConditionalInSupabase(setlist, userId);
  }
  return insertSetlistMetadataToSupabase(setlist, userId);
}

export interface FetchSetlistsResult {
  rows: any[];
  hasExtendedColumns: boolean;
  hasServerVersion: boolean;
  isIncremental: boolean;
  isComplete: boolean;
  relationshipsComplete: boolean;
}

export async function fetchSetlistsForUser(
  userId: string,
  _options?: { sinceVersion?: number }
): Promise<FetchSetlistsResult> {
  const supabaseClient = getClient();
  if (!supabaseClient || !userId) {
    return {
      rows: [],
      hasExtendedColumns: false,
      hasServerVersion: false,
      isIncremental: false,
      isComplete: false,
      relationshipsComplete: false,
    };
  }

  // Retrieve complete setlist snapshot using immutable PK ordering so concurrent writes
  // cannot shift rows across paginated slices.
  const fetchAllSetlistPages = async (selectColumns: string) => {
    const allRows: any[] = [];
    const seenIds = new Set<string>();
    let offset = 0;

    while (true) {
      const { data, error } = await (supabaseClient as any)
        .from('setlists')
        .select(selectColumns)
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) return { data: null, error };

      const page = data || [];
      for (const row of page) {
        const rowId = String(row?.id || '').trim();
        if (rowId && seenIds.has(rowId)) continue;
        if (rowId) seenIds.add(rowId);
        allRows.push(row);
      }

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return { data: allRows, error: null };
  };

  let setlistsData: any[] = [];
  let hasExtendedColumns = false;
  let hasServerVersion = false;

  const p2 = await fetchAllSetlistPages(
    'id,user_id,name,created_at,updated_at,legacy_id,song_ids,deleted_at,server_version'
  );
  if (!p2.error) {
    setlistsData = p2.data || [];
    hasExtendedColumns = true;
    hasServerVersion = true;
  } else if (!isMissingColumnError(p2.error, ['server_version', 'song_ids', 'deleted_at'])) {
    console.error('[SongSync] Setlists fetch error', p2.error);
    throw p2.error;
  } else {
    const p1 = await fetchAllSetlistPages(
      'id,user_id,name,created_at,updated_at,legacy_id,song_ids,deleted_at'
    );
    if (!p1.error) {
      setlistsData = p1.data || [];
      hasExtendedColumns = true;
    } else if (!isMissingColumnError(p1.error, ['song_ids', 'deleted_at'])) {
      console.error('[SongSync] Setlists Phase 1 fetch error', p1.error);
      throw p1.error;
    } else {
      const legacy = await fetchAllSetlistPages('id,user_id,name,created_at,updated_at,legacy_id');
      if (legacy.error) {
        console.error('[SongSync] Setlists fallback fetch error', legacy.error);
        throw legacy.error;
      }
      setlistsData = legacy.data || [];
    }
  }

  if (!setlistsData.length) {
    return {
      rows: [],
      hasExtendedColumns,
      hasServerVersion,
      isIncremental: false,
      isComplete: true,
      relationshipsComplete: true,
    };
  }

  // Track every active setlist whose relationships were explicitly queried
  const songIdsBySetlist = new Map<string, string[]>();
  const fetchedSetlistIds = new Set<string>();
  for (const s of setlistsData) {
    if (s.deleted_at) continue;
    const sid = String(s?.id || '').trim();
    if (sid) {
      songIdsBySetlist.set(sid, []);
      fetchedSetlistIds.add(sid);
    }
  }

  if (fetchedSetlistIds.size > 0) {
    // Retrieve ALL setlist_songs rows for the authenticated user across all pages
    // using deterministic ordering: setlist_id -> position -> song_id -> id.
    const fetchAllRelationshipPages = async (includeSurrogateId: boolean) => {
      const rows: any[] = [];
      const seenLinkIds = new Set<string>();
      let offset = 0;

      while (true) {
        let query = (supabaseClient as any)
          .from('setlist_songs')
          .select(includeSurrogateId ? 'id,setlist_id,song_id,position' : 'setlist_id,song_id,position')
          .eq('user_id', userId)
          .order('setlist_id', { ascending: true })
          .order('position', { ascending: true })
          .order('song_id', { ascending: true });

        if (includeSurrogateId) {
          query = query.order('id', { ascending: true });
        }

        const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
        if (error) return { data: null, error };

        const page = data || [];
        for (const row of page) {
          if (includeSurrogateId && row?.id !== undefined && row?.id !== null) {
            const linkId = String(row.id);
            if (seenLinkIds.has(linkId)) continue;
            seenLinkIds.add(linkId);
          }
          rows.push(row);
        }

        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      return { data: rows, error: null };
    };

    let relResult = await fetchAllRelationshipPages(true);
    if (relResult.error && isMissingColumnError(relResult.error, ['id'])) {
      relResult = await fetchAllRelationshipPages(false);
    }

    if (relResult.error) {
      console.error('[SongSync] Failed fetching setlist_songs links:', relResult.error);
      throw relResult.error;
    }

    const linkRows = [...(relResult.data || [])];
    linkRows.sort((a: any, b: any) => {
      const setlistCmp = String(a?.setlist_id || '').localeCompare(String(b?.setlist_id || ''));
      if (setlistCmp !== 0) return setlistCmp;

      const posLeft = Number.isFinite(Number(a?.position)) ? Number(a.position) : 0;
      const posRight = Number.isFinite(Number(b?.position)) ? Number(b.position) : 0;
      if (posLeft !== posRight) return posLeft - posRight;

      const songCmp = String(a?.song_id || '').localeCompare(String(b?.song_id || ''));
      if (songCmp !== 0) return songCmp;

      return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
    });

    for (const row of linkRows) {
      const setlistId = String(row?.setlist_id || '').trim();
      const songId = String(row?.song_id || '').trim();
      if (!setlistId || !songId || !fetchedSetlistIds.has(setlistId)) continue;
      songIdsBySetlist.get(setlistId)!.push(songId);
    }
  }

  // Because setlist_songs completed for all active setlists, empty arrays represent
  // genuinely empty setlists and must NEVER fall back to stale setlists.song_ids.
  const mergedRows = setlistsData.map((setlist: any) => {
    const setlistId = String(setlist?.id || '').trim();
    const relationshipsLoaded = !setlist?.deleted_at && fetchedSetlistIds.has(setlistId);
    const songs = relationshipsLoaded ? songIdsBySetlist.get(setlistId) ?? [] : [];

    return {
      ...setlist,
      songs,
      relationshipsLoaded,
    };
  });

  return {
    rows: mergedRows,
    hasExtendedColumns,
    hasServerVersion,
    isIncremental: false,
    isComplete: true,
    relationshipsComplete: true,
  };
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

  if (code === 'PGRST202' || code === '42883') return true;

  const details = String(err.details || '').toLowerCase();
  if (err.status === 404 && (message.includes('replace_setlist_songs') || details.includes('replace_setlist_songs'))) {
    return true;
  }

  if (
    message.includes('replace_setlist_songs') &&
    (message.includes('schema cache') || message.includes('does not exist'))
  ) {
    return true;
  }

  return false;
}

function isRpcVersionConflictError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim().toUpperCase();
  const message = String(err.message || '').toLowerCase();
  return code === 'P0409' || message.includes('setlist server_version mismatch');
}

function isRpcMissingVersionError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim().toUpperCase();
  const message = String(err.message || '').toLowerCase();
  return (
    code === 'P0002' ||
    message.includes('missing version:') ||
    isMissingColumnError(err, ['server_version', 'song_ids', 'deleted_at'])
  );
}

export type ReplaceSetlistSongsResult =
  | { status: 'ok'; count: number; method: 'rpc'; serverVersion: number }
  | { status: 'conflict'; remoteRow: any }
  | { status: 'conflict_fetch_failed'; error: string }
  | { status: 'missing_version_mechanism'; error: string };

/**
 * Replaces songs in setlist_songs in Supabase using the version-guarded atomic Postgres RPC
 * (replace_setlist_songs(text, text[], bigint)). Never falls back to unguarded direct updates.
 */
export async function replaceSetlistSongsInSupabase(
  setlistId: string,
  remoteSongIds: string[],
  userId: string,
  expectedServerVersion: number
): Promise<ReplaceSetlistSongsResult> {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  const cleanSetlistId = String(setlistId || '').trim();
  const cleanUserId = String(userId || '').trim();
  if (!cleanSetlistId) throw new Error('Setlist id is missing.');
  if (!cleanUserId) throw new Error('User id is required for setlist song sync.');

  const orderedSongIds = Array.isArray(remoteSongIds) ? remoteSongIds.filter(Boolean) : [];
  const expectedVer = Number(expectedServerVersion);

  const handleConflictFetch = async (notFoundMessage: string): Promise<ReplaceSetlistSongsResult> => {
    const fetched = await fetchSetlistWithLinksById(cleanUserId, cleanSetlistId);
    if (fetched.status === 'ok') {
      return { status: 'conflict', remoteRow: fetched.row };
    }
    if (fetched.status === 'missing_version_mechanism') {
      return { status: 'missing_version_mechanism', error: fetched.error };
    }
    if (fetched.status === 'not_found') {
      return { status: 'conflict_fetch_failed', error: notFoundMessage };
    }
    return { status: 'conflict_fetch_failed', error: fetched.error };
  };

  if (!Number.isFinite(expectedVer) || expectedVer <= 0) {
    return handleConflictFetch(
      `Setlist "${cleanSetlistId}" is missing a valid positive expected server_version and its remote record could not be retrieved.`
    );
  }

  let rpcData: any = null;
  let rpcError: any = null;
  try {
    const res = await (supabaseClient as any).rpc('replace_setlist_songs', {
      p_setlist_id: cleanSetlistId,
      p_song_ids: orderedSongIds.map(String),
      p_expected_server_version: expectedVer,
    });
    rpcData = res?.data;
    rpcError = res?.error;
  } catch (rpcCallErr: any) {
    rpcError = rpcCallErr;
  }

  if (rpcError) {
    if (isRpcVersionConflictError(rpcError)) {
      return handleConflictFetch(
        `Setlist "${cleanSetlistId}" relationship update conflicted at version ${expectedVer}, and the current remote setlist could not be retrieved.`
      );
    }

    if (isRpcUnavailableError(rpcError) || isRpcMissingVersionError(rpcError)) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase is missing the version-guarded replace_setlist_songs RPC or server_version mechanism. Run supabase_phase2_migration.sql before syncing setlist relationships.',
      };
    }

    console.error('[SongSync] replace_setlist_songs RPC rejected:', rpcError);
    throw rpcError;
  }

  const parsedVersion = typeof rpcData === 'number' ? rpcData : Number(rpcData);
  if (!Number.isFinite(parsedVersion) || parsedVersion <= 0 || parsedVersion === expectedVer) {
    return {
      status: 'missing_version_mechanism',
      error:
        'Supabase replace_setlist_songs RPC did not return an advanced positive server_version. Ensure supabase_phase2_migration.sql is applied.',
    };
  }

  return {
    status: 'ok',
    count: orderedSongIds.length,
    method: 'rpc',
    serverVersion: parsedVersion,
  };
}

export async function inspectSetlistDeletionCandidateInSupabase(
  params: { legacyId: string; remoteId?: string },
  userId: string
): Promise<DeletionInspectResult<any>> {
  const cleanUserId = String(userId || '').trim();
  const cleanRemoteId = params.remoteId ? String(params.remoteId).trim() : '';
  const cleanLegacyId = params.legacyId ? String(params.legacyId).trim() : '';

  if (!cleanUserId || (!cleanRemoteId && !cleanLegacyId)) {
    return { status: 'fetch_failed', error: 'User id and setlist identifier are required.' };
  }

  let fetched = cleanRemoteId
    ? await fetchSetlistWithLinksById(cleanUserId, cleanRemoteId)
    : await fetchSetlistWithLinksByLegacyId(cleanUserId, cleanLegacyId);

  if (fetched.status === 'not_found' && cleanRemoteId && cleanLegacyId) {
    fetched = await fetchSetlistWithLinksByLegacyId(cleanUserId, cleanLegacyId);
  }

  if (fetched.status === 'missing_version_mechanism') {
    return { status: 'missing_version_mechanism', error: fetched.error };
  }
  if (fetched.status === 'error') {
    return { status: 'fetch_failed', error: fetched.error };
  }
  if (fetched.status === 'not_found') {
    return { status: 'not_found' };
  }

  if (fetched.row?.deleted_at) {
    return { status: 'already_deleted', row: fetched.row };
  }
  return { status: 'active_found', remoteRow: fetched.row };
}

export async function softDeleteSetlistConditionalInSupabase(
  params: { legacyId: string; remoteId?: string; baseVersion?: number; deletedAt?: number },
  userId: string
): Promise<ConditionalDeleteResult<any>> {
  const supabaseClient = getClient();
  if (!supabaseClient) {
    return { status: 'fetch_failed', error: 'Supabase client is not configured.' };
  }
  const cleanUserId = String(userId || '').trim();
  const cleanLegacyId = String(params.legacyId || '').trim();
  const cleanRemoteId = params.remoteId ? String(params.remoteId).trim() : '';
  const baseVersion = Number(params.baseVersion);

  if (!cleanUserId || !cleanLegacyId) {
    return { status: 'fetch_failed', error: 'User id and setlist id are required for deletion.' };
  }

  if (!cleanRemoteId || !Number.isFinite(baseVersion) || baseVersion <= 0) {
    const inspected = await inspectSetlistDeletionCandidateInSupabase(
      { legacyId: cleanLegacyId, remoteId: cleanRemoteId },
      cleanUserId
    );
    if (inspected.status === 'not_found') return { status: 'already_deleted' };
    if (inspected.status === 'already_deleted') {
      return { status: 'already_deleted', row: inspected.row };
    }
    if (inspected.status === 'active_found') {
      return { status: 'conflict', remoteRow: inspected.remoteRow };
    }
    return inspected;
  }

  // Soft-delete setlist row only; preserve setlist_songs rows so restore never loses membership.
  const deletedIso = new Date(params.deletedAt || Date.now()).toISOString();
  const { data, error } = await (supabaseClient as any)
    .from('setlists')
    .update({ deleted_at: deletedIso })
    .eq('user_id', cleanUserId)
    .eq('id', cleanRemoteId)
    .eq('server_version', baseVersion)
    .is('deleted_at', null)
    .select(SETLIST_PHASE2_COLUMNS);

  if (error) {
    if (isMissingColumnError(error, ['server_version', 'song_ids', 'deleted_at'])) {
      return {
        status: 'missing_version_mechanism',
        error:
          'Supabase setlists table is missing Phase 2 deleted_at/server_version columns. Run supabase_phase2_migration.sql before syncing deletions.',
      };
    }
    console.error('[SongSync] Setlist conditional soft-delete error', error);
    return { status: 'fetch_failed', error: error.message || String(error) };
  }

  if (!data || data.length === 0) {
    const inspected = await inspectSetlistDeletionCandidateInSupabase(
      { legacyId: cleanLegacyId, remoteId: cleanRemoteId },
      cleanUserId
    );
    if (inspected.status === 'not_found') return { status: 'already_deleted' };
    if (inspected.status === 'already_deleted') {
      return { status: 'already_deleted', row: inspected.row };
    }
    if (inspected.status === 'active_found') {
      return { status: 'conflict', remoteRow: inspected.remoteRow };
    }
    return inspected;
  }

  const deletedRow = data[0];
  const newVersion = Number(deletedRow?.server_version);
  if (!deletedRow?.deleted_at || !Number.isFinite(newVersion) || newVersion <= 0 || newVersion === baseVersion) {
    return {
      status: 'missing_version_mechanism',
      error:
        'Supabase setlists soft-delete did not advance server_version or record deleted_at. Ensure the Phase 2 server_version trigger is active.',
    };
  }

  return { status: 'deleted', row: deletedRow };
}

export async function upsertProfile(user: any) {
  const supabaseClient = getClient();
  if (!supabaseClient || !user?.id) return { skipped: true };

  const payload = {
    id: String(user.id).trim(),
  };

  const { error } = await (supabaseClient as any).from('profiles').upsert(payload, { onConflict: 'id' });

  if (error) {
    console.error('[SongSync] Profile upsert error', error);
    throw error;
  }
  return { skipped: false };
}

/**
 * Lightweight Realtime nudge subscription: notifies the client to run a delta sync
 * when another device updates songs or setlists. Never applies raw WS payloads directly.
 */
export function subscribeToUserSyncChanges(userId: string, onRemoteChange: () => void): () => void {
  const supabaseClient = getClient();
  if (!supabaseClient || !userId) return () => {};

  const cleanUserId = String(userId).trim();
  const channel = supabaseClient
    .channel(`songbinder-sync-${cleanUserId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'songs',
        filter: `user_id=eq.${cleanUserId}`,
      },
      () => onRemoteChange()
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'setlists',
        filter: `user_id=eq.${cleanUserId}`,
      },
      () => onRemoteChange()
    )
    .subscribe();

  return () => {
    supabaseClient.removeChannel(channel).catch(() => {});
  };
}
