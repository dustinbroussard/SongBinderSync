/* global supabase */
(function initSongBinderSupabase() {
  const env = window.__ENV__ || {};
  const supabaseUrl = String(env.SUPABASE_URL || '').trim();
  const supabaseAnonKey = String(env.SUPABASE_ANON_KEY || '').trim();
  let client = null;

  function isConfigured() {
    return !!(
      supabaseUrl &&
      supabaseAnonKey &&
      window.supabase &&
      typeof supabase.createClient === 'function'
    );
  }

  function getClient() {
    if (client || !isConfigured()) return client;
    client = supabase.createClient(supabaseUrl, supabaseAnonKey);
    return client;
  }

  function getRedirectUrl() {
    try {
      const redirectUrl = new URL(window.location.href);
      redirectUrl.hash = '';
      redirectUrl.search = '';
      return redirectUrl.toString();
    } catch {
      return window.location.href;
    }
  }

  async function getSession() {
    const supabaseClient = getClient();
    if (!supabaseClient) return null;
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    return data?.session || null;
  }

  async function getCurrentUser() {
    const session = await getSession();
    return session?.user || null;
  }

  function logSyncPayload(label, rawPayload, filteredPayload) {
    console.info(`[SongSync] ${label} raw payload`, rawPayload);
    console.info(`[SongSync] ${label} filtered payload`, filteredPayload);
    console.info(`[SongSync] ${label} final payload being sent`, filteredPayload);
  }

  function logSyncError(label, error) {
    console.error(`[SongSync] ${label} Supabase error`, error);
  }

  function buildSongBaseRow(song, userId) {
    return {
      id: String(song?.id || '').trim(),
      user_id: String(userId || '').trim(),
      title: String(song?.title || '').trim(),
      lyrics: String(song?.lyrics || ''),
    };
  }

  function isMissingColumnError(error) {
    const message = String(error?.message || error?.details || '').toLowerCase();
    return message.includes('column') && (
      message.includes('created_at') ||
      message.includes('updated_at')
    );
  }

  function isMissingTableError(error) {
    const message = String(error?.message || error?.details || '').toLowerCase();
    return error?.code === '42P01' ||
      message.includes('relation') && message.includes('does not exist') ||
      message.includes('setlist_songs');
  }

  async function upsertProfile(user) {
    const supabaseClient = getClient();
    if (!supabaseClient || !user?.id) return { skipped: true };
    const rawPayload = {
      id: user.id,
      email: user.email || null,
    };
    const filteredPayload = {
      id: String(user.id).trim(),
    };

    logSyncPayload('Profile upsert', rawPayload, filteredPayload);

    const { error } = await supabaseClient
      .from('profiles')
      .upsert(filteredPayload, { onConflict: 'id' });
    if (error) {
      logSyncError('Profile upsert', error);
      throw error;
    }
    return { skipped: false };
  }

  async function fetchSongsForUser(userId) {
    const supabaseClient = getClient();
    if (!supabaseClient || !userId) return [];

    let result = await supabaseClient
      .from('songs')
      .select('id,user_id,title,lyrics,created_at,updated_at')
      .eq('user_id', userId);

    if (result.error && isMissingColumnError(result.error)) {
      result = await supabaseClient
        .from('songs')
        .select('id,user_id,title,lyrics')
        .eq('user_id', userId);
    }
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function fetchSetlistsForUser(userId) {
    const supabaseClient = getClient();
    if (!supabaseClient || !userId) return [];

    let result = await supabaseClient
      .from('setlists')
      .select('id,user_id,name,songs,created_at,updated_at')
      .eq('user_id', userId);

    if (result.error && isMissingColumnError(result.error)) {
      result = await supabaseClient
        .from('setlists')
        .select('id,user_id,name,songs')
        .eq('user_id', userId);
    }
    if (result.error) throw result.error;

    let linkRows = [];
    try {
      const linkResult = await supabaseClient
        .from('setlist_songs')
        .select('setlist_id,song_id,position')
        .eq('user_id', userId)
        .order('position', { ascending: true });
      if (linkResult.error) throw linkResult.error;
      linkRows = linkResult.data || [];
    } catch (error) {
      if (!isMissingTableError(error) && !isMissingColumnError(error)) throw error;
      linkRows = [];
    }

    const songIdsBySetlist = new Map();
    for (const row of linkRows) {
      const setlistId = String(row?.setlist_id || '').trim();
      const songId = String(row?.song_id || '').trim();
      if (!setlistId || !songId) continue;
      if (!songIdsBySetlist.has(setlistId)) songIdsBySetlist.set(setlistId, []);
      songIdsBySetlist.get(setlistId).push(songId);
    }

    return (result.data || []).map((setlist) => {
      const setlistId = String(setlist?.id || '').trim();
      if (!songIdsBySetlist.has(setlistId)) return setlist;
      return {
        ...setlist,
        songs: songIdsBySetlist.get(setlistId),
      };
    });
  }

  async function upsertSongToSupabase(song, userId) {
    const supabaseClient = getClient();
    if (!supabaseClient) throw new Error('Supabase client is not configured.');
    if (!song?.id) throw new Error('Song is missing an id.');
    if (!userId) throw new Error('User id is required for song upsert.');

    const rawPayload = {
      id: song?.id,
      user_id: userId,
      title: song?.title,
      lyrics: song?.lyrics,
      created_at: song?.createdAt || song?.created_at || null,
      updated_at: song?.lastEditedAt || song?.updatedAt || song?.updated_at || null,
      createdAt: song?.createdAt,
      updatedAt: song?.updatedAt,
      lastEditedAt: song?.lastEditedAt,
      favorite: song?.favorite,
      chords: song?.chords,
      notes: song?.notes,
      tags: song?.tags,
    };
    const filteredPayload = buildSongBaseRow(song, userId);

    logSyncPayload('Song upsert', rawPayload, filteredPayload);

    const result = await supabaseClient
      .from('songs')
      .upsert(filteredPayload, { onConflict: 'id' });
    if (result.error) {
      logSyncError('Song upsert', result.error);
      throw result.error;
    }
    return result.data || null;
  }

  function buildSetlistBaseRow(setlist, userId) {
    return {
      id: String(setlist?.id || '').trim(),
      user_id: String(userId || '').trim(),
      name: String(setlist?.name || '').trim(),
      songs: Array.isArray(setlist?.songs) ? setlist.songs.filter(Boolean) : [],
    };
  }

  function buildSetlistTimestampRow(setlist, userId) {
    const baseRow = buildSetlistBaseRow(setlist, userId);
    const createdAt = setlist?.createdAt || setlist?.created_at || null;
    const updatedAt =
      setlist?.updatedAt ||
      setlist?.updated_at ||
      createdAt ||
      Date.now();

    return {
      ...baseRow,
      created_at: createdAt || updatedAt,
      updated_at: updatedAt,
    };
  }

  async function upsertSetlistToSupabase(setlist, userId) {
    const supabaseClient = getClient();
    if (!supabaseClient) throw new Error('Supabase client is not configured.');
    if (!setlist?.id) throw new Error('Setlist is missing an id.');
    if (!userId) throw new Error('User id is required for setlist upsert.');

    let result = await supabaseClient
      .from('setlists')
      .upsert(buildSetlistTimestampRow(setlist, userId), { onConflict: 'id' });

    if (result.error && isMissingColumnError(result.error)) {
      result = await supabaseClient
        .from('setlists')
        .upsert(buildSetlistBaseRow(setlist, userId), { onConflict: 'id' });
    }
    if (result.error) throw result.error;
    return result.data || null;
  }

  async function replaceSetlistSongsInSupabase(setlist, userId) {
    const supabaseClient = getClient();
    if (!supabaseClient) throw new Error('Supabase client is not configured.');
    if (!setlist?.id) throw new Error('Setlist is missing an id.');
    if (!userId) throw new Error('User id is required for setlist song sync.');

    try {
      const { error: deleteError } = await supabaseClient
        .from('setlist_songs')
        .delete()
        .eq('user_id', userId)
        .eq('setlist_id', String(setlist.id));
      if (deleteError) throw deleteError;

      const orderedSongIds = Array.isArray(setlist.songs) ? setlist.songs.filter(Boolean) : [];
      if (!orderedSongIds.length) return { skipped: false, count: 0 };

      const rows = orderedSongIds.map((songId, index) => ({
        user_id: String(userId),
        setlist_id: String(setlist.id),
        song_id: String(songId),
        position: index,
      }));

      const { error: insertError } = await supabaseClient
        .from('setlist_songs')
        .insert(rows);
      if (insertError) throw insertError;

      return { skipped: false, count: rows.length };
    } catch (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) {
        return { skipped: true, count: 0 };
      }
      throw error;
    }
  }

  window.SongBinderSupabase = Object.freeze({
    getClient,
    getSession,
    getCurrentUser,
    getRedirectUrl,
    isConfigured,
    upsertProfile,
    fetchSongsForUser,
    fetchSetlistsForUser,
    upsertSongToSupabase,
    upsertSetlistToSupabase,
    replaceSetlistSongsInSupabase,
  });
})();
