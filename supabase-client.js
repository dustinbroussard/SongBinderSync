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

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
  }

  function buildSongBaseRow(song, userId) {
    return {
      user_id: String(userId || '').trim(),
      legacy_id: String(song?.id || '').trim(),
      title: String(song?.title || '').trim(),
      lyrics: String(song?.lyrics || ''),
    };
  }

  function isMissingColumnError(error) {
    const message = String(error?.message || error?.details || '').toLowerCase();
    return message.includes('column') && (
      message.includes('created_at') ||
      message.includes('updated_at') ||
      message.includes('legacy_id')
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

    const result = await supabaseClient
      .from('songs')
      .select('id,user_id,title,lyrics,created_at,updated_at,legacy_id')
      .eq('user_id', userId);
    if (result.error) {
      logSyncError('Songs fetch', result.error);
      throw result.error;
    }
    console.info('[SongSync] Songs fetch row keys', Object.keys(result.data?.[0] || {}));
    return result.data || [];
  }

  async function fetchSetlistsForUser(userId) {
    const supabaseClient = getClient();
    if (!supabaseClient || !userId) return [];

    const result = await supabaseClient
      .from('setlists')
      .select('id,user_id,name,created_at,updated_at,legacy_id')
      .eq('user_id', userId);
    if (result.error) {
      logSyncError('Setlists fetch', result.error);
      if (String(result.error?.message || result.error?.details || '').toLowerCase().includes('legacy_id')) {
        throw new Error('public.setlists.legacy_id is required for stable local-to-remote sync. Run the provided migration SQL first.');
      }
      throw result.error;
    }
    console.info('[SongSync] Setlists fetch row keys', Object.keys(result.data?.[0] || {}));

    let linkRows = [];
    const remoteSetlistIds = (result.data || [])
      .map((setlist) => String(setlist?.id || '').trim())
      .filter(Boolean);
    try {
      let linkResult = await supabaseClient
        .from('setlist_songs')
        .select('setlist_id,song_id,position')
        .eq('user_id', userId);
      if (!linkResult.error && (!linkResult.data || !linkResult.data.length) && remoteSetlistIds.length) {
        console.info('[SongSync] setlist_songs user_id lookup returned no rows; retrying by setlist_id.');
        linkResult = await supabaseClient
          .from('setlist_songs')
          .select('setlist_id,song_id,position')
          .in('setlist_id', remoteSetlistIds);
      }
      if (linkResult.error) throw linkResult.error;
      console.info('[SongSync] setlist_songs fetch row keys', Object.keys(linkResult.data?.[0] || {}));
      linkRows = (linkResult.data || []).slice().sort((a, b) => {
        const left = Number.isFinite(Number(a?.position)) ? Number(a.position) : 0;
        const right = Number.isFinite(Number(b?.position)) ? Number(b.position) : 0;
        return left - right;
      });
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
      user_id: userId,
      legacy_id: song?.id,
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
      .upsert(filteredPayload, { onConflict: 'user_id,legacy_id' });
    if (result.error) {
      logSyncError('Song upsert', result.error);
      throw result.error;
    }
    return result.data || null;
  }

  function buildSetlistBaseRow(setlist, userId) {
    return {
      user_id: String(userId || '').trim(),
      legacy_id: String(setlist?.id || '').trim(),
      name: String(setlist?.name || '').trim(),
    };
  }

  async function upsertSetlistToSupabase(setlist, userId) {
    const supabaseClient = getClient();
    if (!supabaseClient) throw new Error('Supabase client is not configured.');
    if (!setlist?.id) throw new Error('Setlist is missing an id.');
    if (!userId) throw new Error('User id is required for setlist upsert.');

    const rawPayload = {
      user_id: userId,
      legacy_id: setlist?.id,
      name: setlist?.name,
      songs: setlist?.songs,
      created_at: setlist?.createdAt || setlist?.created_at || null,
      updated_at: setlist?.updatedAt || setlist?.updated_at || null,
    };
    const filteredPayload = buildSetlistBaseRow(setlist, userId);
    logSyncPayload('Setlist upsert', rawPayload, filteredPayload);

    const result = await supabaseClient
      .from('setlists')
      .upsert(filteredPayload, { onConflict: 'user_id,legacy_id' });
    if (result.error) {
      logSyncError('Setlist upsert', result.error);
      if (String(result.error?.message || result.error?.details || '').toLowerCase().includes('legacy_id')) {
        throw new Error('public.setlists.legacy_id is required for stable local-to-remote sync. Run the provided migration SQL first.');
      }
      throw result.error;
    }
    return result.data || null;
  }

  async function replaceSetlistSongsInSupabase(setlistId, remoteSongIds, userId) {
    const supabaseClient = getClient();
    if (!supabaseClient) throw new Error('Supabase client is not configured.');
    if (!setlistId) throw new Error('Setlist id is missing.');
    if (!userId) throw new Error('User id is required for setlist song sync.');

    try {
      const { error: deleteError } = await supabaseClient
        .from('setlist_songs')
        .delete()
        .eq('user_id', userId)
        .eq('setlist_id', String(setlistId));
      if (deleteError) throw deleteError;

      const orderedSongIds = Array.isArray(remoteSongIds) ? remoteSongIds.filter(Boolean) : [];
      if (!orderedSongIds.length) return { skipped: false, count: 0 };

      const rows = orderedSongIds.map((songId, index) => ({
        user_id: String(userId),
        setlist_id: String(setlistId),
        song_id: String(songId),
        position: index + 1,
      }));
      logSyncPayload('setlist_songs replace', {
        setlist_id: setlistId,
        user_id: userId,
        orderedSongIds,
      }, rows);
      console.info('[SongSync] setlist_songs replace preview', rows.slice(0, 5).map((row) => ({
        setlist_id: row.setlist_id,
        song_id: row.song_id,
        position: row.position,
      })));

      const { error: insertError } = await supabaseClient
        .from('setlist_songs')
        .insert(rows);
      if (insertError) {
        logSyncError('setlist_songs replace', insertError);
        throw insertError;
      }

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
