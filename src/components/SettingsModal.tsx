import { X, Download, Upload, Check, Monitor, Moon, Sun, Palette, Trash2, AlertTriangle, Cloud } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { db } from "../lib/db";
import { v4 as uuidv4 } from "uuid";
import { useTheme } from "./ThemeProvider";
import { useAuth } from "./AuthProvider";
import { 
  upsertSongToSupabase, 
  upsertSetlistToSupabase, 
  replaceSetlistSongsInSupabase,
  fetchSongsForUser,
  fetchSetlistsForUser,
  upsertProfile,
  markSongDeletedInSupabase,
  markSetlistDeletedInSupabase
} from "../lib/supabase";

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [showDeleteSongsConfirm, setShowDeleteSongsConfirm] = useState(false);
  const [showDeleteSetlistsConfirm, setShowDeleteSetlistsConfirm] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const { theme, setTheme, accent, setAccent } = useTheme();
  const { user } = useAuth();

  const showNotice = (text: string, type: 'success' | 'error' = 'success') => {
    setNotice({ text, type });
    setTimeout(() => setNotice(null), 4000);
  };

  const accents = [
    { id: "green", color: "#22c55e" },
    { id: "blue", color: "#3b82f6" },
    { id: "red", color: "#ef4444" },
    { id: "purple", color: "#a855f7" },
    { id: "orange", color: "#f97316" },
    { id: "gold", color: "#FDD023" },
    { id: "old-gold", color: "#D3BC8D" },
  ];

  const parseDate = (val: any) => {
    if (!val) return Date.now();
    if (typeof val === 'number') return val;
    return new Date(val).getTime();
  };

  const handleExport = async () => {
    try {
      const songs = await db.songs.toArray();
      const setlists = await db.setlists.toArray();
      // To match the requested format:
      const exportData = {
        songs: songs.map(s => ({
          ...s,
          createdAt: new Date(s.createdAt).toISOString(),
          lastEditedAt: new Date(s.updatedAt).toISOString()
        })),
        setlists: setlists.map(sl => ({
          id: sl.id,
          name: sl.name,
          songs: sl.songIds,
          createdAt: new Date(sl.createdAt).toISOString(),
          updatedAt: new Date(sl.updatedAt).toISOString()
        }))
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `songbinder_backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showNotice("Failed to export backup", "error");
    }
  };

  const handleExportSetlists = async () => {
    try {
      const setlists = await db.setlists.toArray();
      const exportData = {
        setlists: setlists.map(sl => ({
          id: sl.id,
          name: sl.name,
          songs: sl.songIds,
          createdAt: new Date(sl.createdAt).toISOString(),
          updatedAt: new Date(sl.updatedAt).toISOString()
        }))
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `songbinder_setlists_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showNotice("Failed to export setlists", "error");
    }
  };

  const clearAllSongs = async () => {
    try {
      await db.songs.clear();
      showNotice("All songs have been deleted.");
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      console.error(err);
      showNotice("Failed to clear songs.", "error");
    }
  };

  const clearAllSetlists = async () => {
    try {
      await db.setlists.clear();
      showNotice("All setlists have been deleted.");
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      console.error(err);
      showNotice("Failed to clear setlists.", "error");
    }
  };

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (parsed.songs && Array.isArray(parsed.songs)) {
        for (const s of parsed.songs) {
          await db.songs.put({
            id: s.id || uuidv4(),
            title: s.title || "Untitled",
            lyrics: s.lyrics || "",
            createdAt: parseDate(s.createdAt),
            updatedAt: parseDate(s.lastEditedAt || s.updatedAt),
            metadata: s.metadata || {}
          });
        }
      }

      if (parsed.setlists && Array.isArray(parsed.setlists)) {
        for (const s of parsed.setlists) {
          await db.setlists.put({
            id: s.id || uuidv4(),
            name: s.name || "Untitled Setlist",
            songIds: s.songIds || s.songs || [],
            createdAt: parseDate(s.createdAt),
            updatedAt: parseDate(s.updatedAt)
          });
        }
      }
      
      showNotice("Import successful!");
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      console.error(err);
      showNotice("Failed to import backup. Please ensure the file is valid JSON.", "error");
    } finally {
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handlePushToCloud = async () => {
    if (!user) {
      setSyncStatus("Please sign in to push to cloud.");
      return;
    }

    setPushing(true);
    setSyncStatus("Pushing to cloud...");

    try {
      await upsertProfile(user);

      // 1. Read local tombstones before uploading and build separate sets of deleted IDs
      const tombstones = await db.tombstones.toArray();
      const deletedSongIds = new Set(
        tombstones
          .filter(t => t.type === 'song')
          .map(t => String(t.id).trim())
      );
      const deletedSetlistIds = new Set(
        tombstones
          .filter(t => t.type === 'setlist')
          .map(t => String(t.id).trim())
      );

      // Synchronize local deletion tombstones to cloud so other devices won't resurrect them
      for (const tomb of tombstones) {
        if (tomb.type === 'song') {
          await markSongDeletedInSupabase(tomb.id, tomb.deletedAt, user.id);
        } else if (tomb.type === 'setlist') {
          await markSetlistDeletedInSupabase(tomb.id, tomb.deletedAt, user.id);
        }
      }

      // 2. Exclude tombstoned songs from active upload loop (cannot be marked deleted and uploaded active in same push)
      const allSongs = await db.songs.toArray();
      const activeSongs = allSongs.filter(song => !deletedSongIds.has(String(song.id).trim()));

      const legacySongIdToSupabaseId = new Map<string, string>();
      for (const song of activeSongs) {
        const remoteSong = await upsertSongToSupabase(song, user.id);
        if (remoteSong?.id) {
          legacySongIdToSupabaseId.set(String(song.id), String(remoteSong.id));
        }
      }

      // 3. Exclude tombstoned setlists from active upload loop
      const allSetlists = await db.setlists.toArray();
      const activeSetlists = allSetlists.filter(setlist => !deletedSetlistIds.has(String(setlist.id).trim()));

      const partialSetlists: string[] = [];

      for (const setlist of activeSetlists) {
        const remoteSetlist = await upsertSetlistToSupabase(setlist, user.id);
        if (remoteSetlist?.id) {
          // Filter song IDs to exclude deleted songs and map to remote Supabase song IDs
          const remoteSongIds = (setlist.songIds || [])
            .map(songId => String(songId).trim())
            .filter(songId => !deletedSongIds.has(songId))
            .map(songId => legacySongIdToSupabaseId.get(songId))
            .filter(Boolean) as string[];

          const syncResult = await replaceSetlistSongsInSupabase(
            remoteSetlist.id,
            remoteSongIds,
            user.id
          );

          if (syncResult && (syncResult as any).skipped && (syncResult as any).error) {
            throw (syncResult as any).error;
          }

          if (syncResult && (syncResult as any).method === 'direct_partial') {
            partialSetlists.push(setlist.name || 'Untitled Setlist');
          }
        }
      }

      if (partialSetlists.length > 0) {
        const partialMsg = `Push partially completed: ${activeSongs.length} song(s) and ${activeSetlists.length} setlist(s) backed up. Warning: Relational links were saved, but JSONB column updates failed for ${partialSetlists.length} setlist(s) (${partialSetlists.join(', ')}). The next sync will self-heal.`;
        setSyncStatus(partialMsg);
        showNotice(partialMsg, "error");
        setTimeout(() => setSyncStatus(null), 8000);
      } else {
        const statusMsg = `Push completed: ${activeSongs.length} song(s) and ${activeSetlists.length} setlist(s) backed up (${tombstones.length} deletion(s) synchronized).`;
        setSyncStatus(statusMsg);
        showNotice(statusMsg);
        setTimeout(() => setSyncStatus(null), 4000);
      }
    } catch (err: any) {
      console.error(err);
      const errMsg = err?.message ? `Failed to push to cloud: ${err.message}` : "Failed to push to cloud. Please check network connection.";
      setSyncStatus(errMsg);
      showNotice(errMsg, "error");
    } finally {
      setPushing(false);
    }
  };

  const handlePullFromCloud = async () => {
    if (!user) {
      setSyncStatus("Please sign in to pull from cloud.");
      return;
    }

    setPulling(true);
    setSyncStatus("Pulling from cloud...");

    try {
      // 1. Fetch remote songs (including metadata, bpm, and deleted_at)
      const remoteSongs = await fetchSongsForUser(user.id);
      const localTombstones = new Map((await db.tombstones.toArray()).map(t => [t.id, t]));
      const supabaseIdToLegacyId = new Map<string, string>();
      const knownLegacySongIds = new Set<string>();

      let pulledSongsCount = 0;
      let deletedSongsCount = 0;

      for (const remoteSong of remoteSongs as any[]) {
        const legacySongId = String(remoteSong.legacy_id || '').trim();
        if (!legacySongId) continue;

        const remoteUpdatedAt = remoteSong.updated_at ? new Date(remoteSong.updated_at).getTime() : 0;
        const localTombstone = localTombstones.get(legacySongId);

        // If song was deleted locally after the remote version was updated, DO NOT resurrect
        if (localTombstone && localTombstone.type === 'song' && localTombstone.deletedAt >= remoteUpdatedAt) {
          continue;
        }

        // If remote song is marked deleted in the cloud, apply deletion locally
        if (remoteSong.deleted_at) {
          await db.songs.delete(legacySongId);
          await db.tombstones.put({
            id: legacySongId,
            type: 'song',
            deletedAt: new Date(remoteSong.deleted_at).getTime()
          });
          deletedSongsCount++;
          continue;
        }

        // Active song: Merge metadata safely without losing local keys, notes, or tempo
        const existingSong = await db.songs.get(legacySongId);

        // Never overwrite existing local metadata if remote metadata is missing or empty
        const remoteMeta = (remoteSong.metadata && typeof remoteSong.metadata === 'object' && Object.keys(remoteSong.metadata).length > 0)
          ? remoteSong.metadata
          : null;

        const localMeta = existingSong?.metadata || {};

        const finalMetadata = remoteMeta 
          ? { ...localMeta, ...remoteMeta }
          : localMeta;

        const bpm = typeof remoteSong.bpm === 'number'
          ? remoteSong.bpm
          : (existingSong?.bpm !== undefined ? existingSong.bpm : undefined);

        await db.songs.put({
          id: legacySongId,
          title: remoteSong.title || existingSong?.title || 'Untitled Song',
          lyrics: typeof remoteSong.lyrics === 'string' ? remoteSong.lyrics : (existingSong?.lyrics || ''),
          createdAt: existingSong?.createdAt || (remoteSong.created_at ? new Date(remoteSong.created_at).getTime() : Date.now()),
          updatedAt: remoteUpdatedAt || existingSong?.updatedAt || Date.now(),
          bpm,
          metadata: finalMetadata
        });

        // Clear older local tombstone now that an active remote record is accepted
        if (localTombstone) {
          await db.tombstones.delete(legacySongId);
        }

        supabaseIdToLegacyId.set(String(remoteSong.id), legacySongId);
        knownLegacySongIds.add(legacySongId);
        pulledSongsCount++;
      }

      // 2. Fetch remote setlists (including ordered songs and deleted_at)
      const remoteSetlists = await fetchSetlistsForUser(user.id);
      let pulledSetlistsCount = 0;

      for (const remoteSetlist of remoteSetlists as any[]) {
        const legacySetlistId = String(remoteSetlist.legacy_id || '').trim();
        if (!legacySetlistId) continue;

        const remoteUpdatedAt = remoteSetlist.updated_at ? new Date(remoteSetlist.updated_at).getTime() : 0;
        const localTombstone = localTombstones.get(legacySetlistId);

        // If setlist was deleted locally after the remote version was updated, DO NOT resurrect
        if (localTombstone && localTombstone.type === 'setlist' && localTombstone.deletedAt >= remoteUpdatedAt) {
          continue;
        }

        // If remote setlist was marked deleted in cloud, apply deletion locally
        if (remoteSetlist.deleted_at) {
          await db.setlists.delete(legacySetlistId);
          await db.tombstones.put({
            id: legacySetlistId,
            type: 'setlist',
            deletedAt: new Date(remoteSetlist.deleted_at).getTime()
          });
          continue;
        }

        const existingSetlist = await db.setlists.get(legacySetlistId);

        // Resolve song IDs from relational setlist_songs links or direct song_ids column
        let resolvedSongIds: string[] = [];
        if (Array.isArray(remoteSetlist.songs) && remoteSetlist.songs.length > 0) {
          resolvedSongIds = remoteSetlist.songs
            .map((songId: string) => {
              const normalized = String(songId);
              return supabaseIdToLegacyId.get(normalized) || normalized;
            })
            .filter(songId => knownLegacySongIds.has(songId));
        } else if (Array.isArray(remoteSetlist.song_ids) && remoteSetlist.song_ids.length > 0) {
          resolvedSongIds = remoteSetlist.song_ids
            .map((songId: string) => {
              const normalized = String(songId);
              return supabaseIdToLegacyId.get(normalized) || normalized;
            })
            .filter(songId => knownLegacySongIds.has(songId));
        } else if (existingSetlist && Array.isArray(existingSetlist.songIds) && existingSetlist.songIds.length > 0) {
          // Safeguard local setlist songs if remote links failed during a previous push
          resolvedSongIds = existingSetlist.songIds;
        }

        await db.setlists.put({
          id: legacySetlistId,
          name: remoteSetlist.name || existingSetlist?.name || 'Untitled Setlist',
          songIds: resolvedSongIds,
          createdAt: existingSetlist?.createdAt || (remoteSetlist.created_at ? new Date(remoteSetlist.created_at).getTime() : Date.now()),
          updatedAt: remoteUpdatedAt || existingSetlist?.updatedAt || Date.now()
        });

        if (localTombstone) {
          await db.tombstones.delete(legacySetlistId);
        }
        pulledSetlistsCount++;
      }

      const statusMsg = `Pull completed: ${pulledSongsCount} song(s) and ${pulledSetlistsCount} setlist(s) synchronized.`;
      setSyncStatus(statusMsg);
      showNotice(statusMsg);
      setTimeout(() => setSyncStatus(null), 4000);
    } catch (err) {
      console.error(err);
      setSyncStatus("Failed to pull from cloud. Please check network connection.");
      showNotice("Failed to pull from cloud.", "error");
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-bg-secondary border border-border p-6 rounded-xl w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto no-scrollbar">
        <div className="flex justify-between items-center mb-6 sticky top-0 bg-bg-secondary z-10 pb-2 border-b border-white/5">
          <h2 className="text-xl font-bold font-mono-tech">Settings</h2>
          <button 
            onClick={onClose} 
            aria-label="Close settings"
            className="p-2 text-gray-400 hover:text-white rounded-full transition-all-custom"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {notice && (
          <div className={`mb-4 p-3 rounded-lg text-xs font-bold ${notice.type === 'error' ? 'bg-danger/10 text-danger border border-danger/30' : 'bg-primary-accent/10 text-primary-accent border border-primary-accent/30'}`}>
            {notice.text}
          </div>
        )}

        <div className="space-y-4">
          <div className="bg-bg-tertiary p-4 rounded-lg border border-white border-opacity-5">
            <h3 className="font-medium text-white mb-4 flex items-center gap-2">
              <Palette className="w-4 h-4 text-primary-accent" />
              Appearance
            </h3>
            
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 block mb-2 font-medium uppercase tracking-wider">Theme</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setTheme('dark')}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border transition-all-custom ${theme === 'dark' ? 'bg-primary-accent text-black border-primary-accent shadow-md' : 'border-border text-gray-400 hover:text-white hover:border-gray-500 bg-bg-secondary'}`}
                  >
                    <Moon className="w-4 h-4" />
                    Dark
                  </button>
                  <button
                    onClick={() => setTheme('light')}
                     className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border transition-all-custom ${theme === 'light' ? 'bg-primary-accent text-black border-primary-accent shadow-md' : 'border-border text-gray-400 hover:text-white hover:border-gray-500 bg-bg-secondary'}`}
                  >
                    <Sun className="w-4 h-4" />
                    Light
                  </button>
                  <button
                    onClick={() => setTheme('system')}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border transition-all-custom ${theme === 'system' ? 'bg-primary-accent text-black border-primary-accent shadow-md' : 'border-border text-gray-400 hover:text-white hover:border-gray-500 bg-bg-secondary'}`}
                  >
                    <Monitor className="w-4 h-4" />
                    System
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-2 font-medium uppercase tracking-wider">Accent Color</label>
                <div className="flex gap-3">
                  {accents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setAccent(a.id as any)}
                      className={`w-8 h-8 rounded-full flex items-center justify-center shadow-md transition-transform hover:scale-110 ${accent === a.id ? 'ring-2 ring-white ring-offset-2 ring-offset-bg-tertiary' : ''}`}
                      style={{ backgroundColor: a.color }}
                      aria-label={`Select ${a.id} accent color`}
                    >
                      {accent === a.id && <Check className="w-4 h-4 text-black mix-blend-multiply" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-bg-tertiary p-4 rounded-lg border border-white border-opacity-5">
            <h3 className="font-medium text-white mb-2 flex items-center gap-2">
                <Download className="w-4 h-4 text-primary-accent" />
                Data Backup & Restore
            </h3>
            <p className="text-sm text-gray-400 mb-4 font-body leading-relaxed">Export your songs and setlists as a JSON file, or import an existing backup.</p>
            
            <div className="flex flex-col gap-2">
              <button 
                onClick={handleExport}
                className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-white border-opacity-10 text-white font-medium px-4 py-2 rounded-lg hover:border-primary-accent transition-all-custom"
              >
                <Download className="w-4 h-4 text-primary-accent" />
                Backup All Data
              </button>

              <button 
                onClick={handleExportSetlists}
                className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-white border-opacity-10 text-white font-medium px-4 py-2 rounded-lg hover:border-primary-accent transition-all-custom"
              >
                <Download className="w-4 h-4 text-primary-accent" />
                Export All Setlists
              </button>
              
              <button 
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="w-full flex items-center justify-center gap-2 bg-primary-accent text-black font-medium px-4 py-2 rounded-lg hover:bg-opacity-90 transition-all-custom disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                {importing ? "Importing..." : "Import Backup"}
              </button>
              <input 
                type="file" 
                accept="application/json" 
                className="hidden" 
                ref={fileInputRef}
                onChange={handleImport}
              />
            </div>
          </div>

          <div className="bg-bg-tertiary p-4 rounded-lg border border-white border-opacity-5">
            <h3 className="font-medium text-white mb-2 flex items-center gap-2">
                <Cloud className="w-4 h-4 text-primary-accent" />
                Cloud Sync
            </h3>
            <p className="text-sm text-gray-400 mb-4 font-body leading-relaxed">
              {user 
                ? `Signed in as ${user.email}. Push your local data to the cloud or pull remote data to your device.`
                : "Sign in to enable cloud sync with Supabase."}
            </p>
            
            {syncStatus && (
              <p className="text-xs text-primary-accent mb-3 font-medium">{syncStatus}</p>
            )}
            
            <div className="flex flex-col gap-2">
              <button 
                onClick={handlePushToCloud}
                disabled={pushing || !user}
                className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-white border-opacity-10 text-white font-medium px-4 py-2 rounded-lg hover:border-primary-accent transition-all-custom disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Cloud className="w-4 h-4 text-primary-accent" />
                {pushing ? "Pushing..." : "Push to Cloud"}
              </button>
              
              <button 
                onClick={handlePullFromCloud}
                disabled={pulling || !user}
                className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-white border-opacity-10 text-white font-medium px-4 py-2 rounded-lg hover:border-primary-accent transition-all-custom disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4 text-primary-accent" />
                {pulling ? "Pulling..." : "Pull from Cloud"}
              </button>
            </div>
          </div>

          <div className="bg-danger/5 p-4 rounded-lg border border-danger/20">
            <h3 className="font-medium text-danger mb-2 flex items-center gap-2 uppercase tracking-widest text-[10px] font-black">
              <AlertTriangle className="w-4 h-4" />
              Danger Zone
            </h3>
            <p className="text-[11px] text-danger/70 mb-4 font-medium">Use with caution. These actions are irreversible.</p>
            
            <div className="flex flex-col gap-2">
              {!showDeleteSongsConfirm ? (
                <button 
                  onClick={() => setShowDeleteSongsConfirm(true)}
                  className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-danger/30 text-danger hover:bg-danger hover:text-white font-bold px-4 py-2 rounded-lg transition-all-custom text-xs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete All Songs
                </button>
              ) : (
                <div className="flex flex-col gap-2 bg-danger/10 p-3 rounded-lg border border-danger/30">
                  <p className="text-[10px] font-bold text-danger uppercase text-center">Are you absolutely sure?</p>
                  <div className="flex gap-2">
                    <button 
                      onClick={clearAllSongs}
                      className="flex-1 bg-danger text-white font-black uppercase tracking-widest text-[9px] py-2 rounded-md hover:bg-opacity-90 transition-all"
                    >
                      Yes, Delete Everything
                    </button>
                    <button 
                      onClick={() => setShowDeleteSongsConfirm(false)}
                      className="flex-1 bg-bg-secondary text-gray-400 font-black uppercase tracking-widest text-[9px] py-2 rounded-md hover:text-white transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {!showDeleteSetlistsConfirm ? (
                <button 
                  onClick={() => setShowDeleteSetlistsConfirm(true)}
                  className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-danger/30 text-danger hover:bg-danger hover:text-white font-bold px-4 py-2 rounded-lg transition-all-custom text-xs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete All Setlists
                </button>
              ) : (
                <div className="flex flex-col gap-2 bg-danger/10 p-3 rounded-lg border border-danger/30">
                  <p className="text-[10px] font-bold text-danger uppercase text-center">Are you absolutely sure?</p>
                  <div className="flex gap-2">
                    <button 
                      onClick={clearAllSetlists}
                      className="flex-1 bg-danger text-white font-black uppercase tracking-widest text-[9px] py-2 rounded-md hover:bg-opacity-90 transition-all"
                    >
                      Yes, Delete Everything
                    </button>
                    <button 
                      onClick={() => setShowDeleteSetlistsConfirm(false)}
                      className="flex-1 bg-bg-secondary text-gray-400 font-black uppercase tracking-widest text-[9px] py-2 rounded-md hover:text-white transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
