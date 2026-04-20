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

  window.SongBinderSupabase = Object.freeze({
    getClient,
    getRedirectUrl,
    isConfigured,
  });
})();
