import { X, Download, Upload, Check, Monitor, Moon, Sun, Palette, Trash2, AlertTriangle, Cloud } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { db } from "../lib/db";
import { v4 as uuidv4 } from "uuid";
import { useTheme } from "./ThemeProvider";
import { useAuth } from "./AuthProvider";
import { 
  getCurrentUser, 
  upsertSongToSupabase, 
  upsertSetlistToSupabase, 
  replaceSetlistSongsInSupabase,
  fetchSongsForUser,
  fetchSetlistsForUser,
  upsertProfile
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
  const { theme, setTheme, accent, setAccent } = useTheme();
  const { user } = useAuth();

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
      alert("Failed to export backup");
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
      alert("Failed to export setlists");
    }
  };

  const clearAllSongs = async () => {
    try {
      await db.songs.clear();
      alert("All songs have been deleted.");
      window.location.reload();
    } catch (err) {
      console.error(err);
      alert("Failed to clear songs.");
    }
  };

  const clearAllSetlists = async () => {
    try {
      await db.setlists.clear();
      alert("All setlists have been deleted.");
      window.location.reload();
    } catch (err) {
      console.error(err);
      alert("Failed to clear setlists.");
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
      
      alert("Import successful!");
      window.location.reload();
    } catch (err) {
      console.error(err);
      alert("Failed to import backup. Please make sure the JSON file is correctly formatted.");
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

      const songs = await db.songs.toArray();
      for (const song of songs) {
        await upsertSongToSupabase(song, user.id);
      }

      const setlists = await db.setlists.toArray();
      for (const setlist of setlists) {
        const remoteSetlist = await upsertSetlistToSupabase(setlist, user.id);
        if (remoteSetlist && remoteSetlist[0]?.id) {
          await replaceSetlistSongsInSupabase(
            setlist.id,
            setlist.songIds || [],
            user.id
          );
        }
      }

      setSyncStatus("Push to cloud completed successfully!");
      setTimeout(() => setSyncStatus(null), 3000);
    } catch (err) {
      console.error(err);
      setSyncStatus("Failed to push to cloud. Please try again.");
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
      const remoteSongs = await fetchSongsForUser(user.id);
      const supabaseIdToLegacyId = new Map<string, string>();
      
      for (const remoteSong of remoteSongs as any[]) {
        const existingSong = await db.songs.get(remoteSong.legacy_id);
        if (!existingSong) {
          await db.songs.put({
            id: remoteSong.legacy_id,
            title: remoteSong.title,
            lyrics: remoteSong.lyrics,
            createdAt: new Date(remoteSong.created_at).getTime(),
            updatedAt: new Date(remoteSong.updated_at).getTime(),
            metadata: {}
          });
        }
        // Map Supabase song ID to legacy ID
        supabaseIdToLegacyId.set(String(remoteSong.id), String(remoteSong.legacy_id));
      }

      const remoteSetlists = await fetchSetlistsForUser(user.id);
      for (const remoteSetlist of remoteSetlists as any[]) {
        const existingSetlist = await db.setlists.get(remoteSetlist.legacy_id);
        if (!existingSetlist) {
          // Convert Supabase song IDs to legacy IDs
          const legacySongIds = (remoteSetlist.songs || [])
            .map((songId: string) => supabaseIdToLegacyId.get(String(songId)))
            .filter(Boolean) as string[];
          
          await db.setlists.put({
            id: remoteSetlist.legacy_id,
            name: remoteSetlist.name,
            songIds: legacySongIds,
            createdAt: new Date(remoteSetlist.created_at).getTime(),
            updatedAt: new Date(remoteSetlist.updated_at).getTime()
          });
        }
      }

      setSyncStatus("Pull from cloud completed successfully!");
      setTimeout(() => setSyncStatus(null), 3000);
      window.location.reload();
    } catch (err) {
      console.error(err);
      setSyncStatus("Failed to pull from cloud. Please try again.");
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-bg-secondary border border-border p-6 rounded-xl w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto no-scrollbar">
        <div className="flex justify-between items-center mb-6 sticky top-0 bg-bg-secondary z-10 pb-2 border-b border-white/5">
          <h2 className="text-xl font-bold font-mono-tech">Settings</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full transition-all-custom">
            <X className="w-5 h-5" />
          </button>
        </div>

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
