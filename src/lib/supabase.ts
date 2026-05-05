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

// Song operations
export async function upsertSongToSupabase(song: any, userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!song?.id) throw new Error('Song is missing an id.');
  if (!userId) throw new Error('User id is required for song upsert.');

  const payload = {
    user_id: String(userId).trim(),
    legacy_id: String(song.id).trim(),
    title: String(song.title || '').trim(),
    lyrics: String(song.lyrics || ''),
  };

  const result = await supabaseClient
    .from('songs')
    .upsert(payload, { onConflict: 'user_id,legacy_id' });
  
  if (result.error) {
    console.error('[SongSync] Song upsert error', result.error);
    throw result.error;
  }
  return result.data || null;
}

export async function fetchSongsForUser(userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient || !userId) return [];

  const result = await supabaseClient
    .from('songs')
    .select('id,user_id,title,lyrics,created_at,updated_at,legacy_id')
    .eq('user_id', userId);
  
  if (result.error) {
    console.error('[SongSync] Songs fetch error', result.error);
    throw result.error;
  }
  return result.data || [];
}

// Setlist operations
export async function upsertSetlistToSupabase(setlist: any, userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient) throw new Error('Supabase client is not configured.');
  if (!setlist?.id) throw new Error('Setlist is missing an id.');
  if (!userId) throw new Error('User id is required for setlist upsert.');

  const payload = {
    user_id: String(userId).trim(),
    legacy_id: String(setlist.id).trim(),
    name: String(setlist.name || '').trim(),
  };

  const result = await supabaseClient
    .from('setlists')
    .upsert(payload, { onConflict: 'user_id,legacy_id' });
  
  if (result.error) {
    console.error('[SongSync] Setlist upsert error', result.error);
    throw result.error;
  }
  return result.data || null;
}

export async function fetchSetlistsForUser(userId: string) {
  const supabaseClient = getClient();
  if (!supabaseClient || !userId) return [];

  const result = await supabaseClient
    .from('setlists')
    .select('id,user_id,name,created_at,updated_at,legacy_id')
    .eq('user_id', userId);
  
  if (result.error) {
    console.error('[SongSync] Setlists fetch error', result.error);
    throw result.error;
  }

  let linkRows: any[] = [];
  const remoteSetlistIds = (result.data || [])
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
    
    if (linkResult.error) throw linkResult.error;
    linkRows = (linkResult.data || []).slice().sort((a: any, b: any) => {
      const left = Number.isFinite(Number(a?.position)) ? Number(a.position) : 0;
      const right = Number.isFinite(Number(b?.position)) ? Number(b.position) : 0;
      return left - right;
    });
  } catch (error) {
    console.warn('[SongSync] setlist_songs fetch failed, continuing without song links', error);
    linkRows = [];
  }

  const songIdsBySetlist = new Map<string, string[]>();
  for (const row of linkRows) {
    const setlistId = String(row?.setlist_id || '').trim();
    const songId = String(row?.song_id || '').trim();
    if (!setlistId || !songId) continue;
    if (!songIdsBySetlist.has(setlistId)) songIdsBySetlist.set(setlistId, []);
    songIdsBySetlist.get(setlistId)!.push(songId);
  }

  return (result.data || []).map((setlist: any) => {
    const setlistId = String(setlist?.id || '').trim();
    if (!songIdsBySetlist.has(setlistId)) return setlist;
    return {
      ...setlist,
      songs: songIdsBySetlist.get(setlistId),
    };
  });
}

export async function replaceSetlistSongsInSupabase(setlistId: string, remoteSongIds: string[], userId: string) {
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

    const { error: insertError } = await supabaseClient
      .from('setlist_songs')
      .insert(rows);
    
    if (insertError) {
      console.error('[SongSync] setlist_songs replace error', insertError);
      throw insertError;
    }

    return { skipped: false, count: rows.length };
  } catch (error) {
    console.warn('[SongSync] setlist_songs replace failed, skipping', error);
    return { skipped: true, count: 0 };
  }
}

export async function upsertProfile(user: any) {
  const supabaseClient = getClient();
  if (!supabaseClient || !user?.id) return { skipped: true };
  
  const payload = {
    id: String(user.id).trim(),
  };

  const { error } = await supabaseClient
    .from('profiles')
    .upsert(payload, { onConflict: 'id' });
  
  if (error) {
    console.error('[SongSync] Profile upsert error', error);
    throw error;
  }
  return { skipped: false };
}
