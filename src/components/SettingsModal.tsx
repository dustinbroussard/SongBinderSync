import { X, Download, Upload, Check, Monitor, Moon, Sun, Palette, Trash2, AlertTriangle, Cloud, RefreshCw, CloudDownload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { db, clearAllSongsLocal, clearAllSetlistsLocal, bulkImportBackupLocal, previewBackupImport, type BackupImportSummary } from "../lib/db";
import { v4 as uuidv4 } from "uuid";
import { useTheme } from "./ThemeProvider";
import { useAuth, useSyncStatus } from "./AuthProvider";
import { syncEngine } from "../lib/syncEngine";
import type { Setlist, Song } from "../types";

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ songs: Song[]; setlists: Setlist[]; summary: BackupImportSummary } | null>(null);
  const [showDeleteSongsConfirm, setShowDeleteSongsConfirm] = useState(false);
  const [showDeleteSetlistsConfirm, setShowDeleteSetlistsConfirm] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const { theme, setTheme, accent, setAccent } = useTheme();
  const { user } = useAuth();
  const syncState = useSyncStatus();

  const showNotice = (text: string, type: 'success' | 'error' = 'success') => {
    setNotice({ text, type });
    setTimeout(() => setNotice(null), 5000);
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
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  };

  const handleExport = async () => {
    try {
      const songs = await db.songs.toArray();
      const setlists = await db.setlists.toArray();
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
      await clearAllSongsLocal();
      setShowDeleteSongsConfirm(false);
      showNotice("All songs have been deleted and queued for cloud sync.");
    } catch (err) {
      console.error(err);
      showNotice("Failed to clear songs.", "error");
    }
  };

  const clearAllSetlists = async () => {
    try {
      await clearAllSetlistsLocal();
      setShowDeleteSetlistsConfirm(false);
      showNotice("All setlists have been deleted and queued for cloud sync.");
    } catch (err) {
      console.error(err);
      showNotice("Failed to clear setlists.", "error");
    }
  };

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setPendingImport(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      const importedSongs: Song[] = Array.isArray(parsed.songs)
        ? parsed.songs.map((s: any) => ({
            id: s.id || uuidv4(),
            title: s.title || "Untitled",
            lyrics: s.lyrics || "",
            createdAt: parseDate(s.createdAt),
            updatedAt: parseDate(s.lastEditedAt || s.updatedAt),
            bpm: typeof s.bpm === 'number' ? s.bpm : undefined,
            metadata: s.metadata && typeof s.metadata === 'object' ? s.metadata : {}
          }))
        : [];

      const importedSetlists: Setlist[] = Array.isArray(parsed.setlists)
        ? parsed.setlists.map((s: any) => ({
            id: s.id || uuidv4(),
            name: s.name || "Untitled Setlist",
            songIds: s.songIds || s.songs || [],
            createdAt: parseDate(s.createdAt),
            updatedAt: parseDate(s.updatedAt)
          }))
        : [];

      // Preview is deliberately read-only: nothing is written until the user confirms.
      const summary = await previewBackupImport(importedSongs, importedSetlists);
      setPendingImport({ songs: importedSongs, setlists: importedSetlists, summary });
      showNotice(
        `Backup preview ready: ${summary.added} new, ${summary.matched} matched, and ${summary.updated} updated song(s).`
      );
    } catch (err) {
      console.error(err);
      showNotice("Failed to read backup. Please ensure the file is valid JSON.", "error");
    } finally {
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const confirmImport = async () => {
    if (!pendingImport || importing) return;
    setImporting(true);
    try {
      const result = await bulkImportBackupLocal(pendingImport.songs, pendingImport.setlists);
      setPendingImport(null);
      showNotice(
        `Import complete: ${result.added} added, ${result.matched} matched, ${result.updated} updated, ${result.setlists} setlist(s) imported.`
      );
    } catch (err) {
      console.error(err);
      showNotice("Failed to import backup. Your existing library was not intentionally cleared.", "error");
    } finally {
      setImporting(false);
    }
  };

  const handleSyncNow = async (forceFullPull = false) => {
    if (!user) {
      showNotice("Please sign in to sync with the cloud.", "error");
      return;
    }

    const res = await syncEngine.syncNow(forceFullPull ? 'manual_full' : 'manual', { forceFullPull });
    if (res.status === 'synced') {
      showNotice("Library synchronized with cloud.");
    } else if (res.status === 'conflict') {
      showNotice(
        `Sync completed with ${res.lastConflictCount} conflict(s) preserved as Conflict Copy.`,
        "error"
      );
    } else if (res.status === 'offline') {
      showNotice("You are offline. Changes are saved locally and will sync automatically when online.", "error");
    } else if (res.lastError) {
      showNotice(res.lastError, "error");
    }
  };

  const formatSyncTime = (ms: number | null) => {
    if (!ms) return 'Never';
    return new Date(ms).toLocaleString();
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
              {pendingImport && (
                <div className="mt-3 p-3 rounded-lg border border-primary-accent/30 bg-primary-accent/5 space-y-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Backup import preview</p>
                    <p className="text-xs text-gray-400 mt-1">Exact matches will reuse existing songs. Different lyrics or musical details remain separate songs, even when the title is the same.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded bg-bg-secondary p-2"><span className="text-gray-400">New songs</span><p className="text-lg font-bold text-white">{pendingImport.summary.added}</p></div>
                    <div className="rounded bg-bg-secondary p-2"><span className="text-gray-400">Already in library</span><p className="text-lg font-bold text-white">{pendingImport.summary.matched}</p></div>
                    <div className="rounded bg-bg-secondary p-2"><span className="text-gray-400">Same ID, changed content</span><p className="text-lg font-bold text-white">{pendingImport.summary.updated}</p></div>
                    <div className="rounded bg-bg-secondary p-2"><span className="text-gray-400">Same title, different content</span><p className="text-lg font-bold text-white">{pendingImport.summary.sameTitleDifferentContent}</p></div>
                  </div>
                  <p className="text-xs text-gray-400">{pendingImport.summary.setlists} setlist(s) will be imported. Their song references will be remapped to matched songs where appropriate.</p>
                  <div className="flex gap-2">
                    <button onClick={confirmImport} disabled={importing} className="flex-1 bg-primary-accent text-black font-bold px-3 py-2 rounded-md text-xs disabled:opacity-50">{importing ? "Importing..." : "Confirm Import"}</button>
                    <button onClick={() => setPendingImport(null)} disabled={importing} className="flex-1 bg-bg-secondary text-gray-300 px-3 py-2 rounded-md text-xs disabled:opacity-50">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-bg-tertiary p-4 rounded-lg border border-white border-opacity-5">
            <h3 className="font-medium text-white mb-2 flex items-center gap-2">
              <Cloud className="w-4 h-4 text-primary-accent" />
              Cloud Sync
            </h3>
            <p className="text-sm text-gray-400 mb-3 font-body leading-relaxed">
              {user
                ? `Signed in as ${user.email}. Changes sync automatically and preserve offline conflicts as copies.`
                : "Sign in to enable automatic multi-device sync with Supabase."}
            </p>

            {user && (
              <div className="mb-3 p-3 rounded-lg bg-bg-secondary border border-border/60 text-xs space-y-1">
                <div className="flex justify-between text-gray-400">
                  <span>Pending local edits:</span>
                  <span className="text-white font-semibold">{syncState.pendingCount}</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Last synced:</span>
                  <span className="text-white font-semibold">{formatSyncTime(syncState.lastSyncedAt)}</span>
                </div>
                {syncState.lastError && (
                  <p className="text-danger pt-1 font-medium">{syncState.lastError}</p>
                )}
                {syncState.schemaWarning && (
                  <p className="text-amber-400 pt-1 font-medium">{syncState.schemaWarning}</p>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <button
                onClick={() => handleSyncNow(false)}
                disabled={syncState.isSyncing || !user}
                className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-white border-opacity-10 text-white font-medium px-4 py-2 rounded-lg hover:border-primary-accent transition-all-custom disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`w-4 h-4 text-primary-accent ${syncState.isSyncing ? 'animate-spin' : ''}`} />
                {syncState.isSyncing ? "Syncing..." : "Sync Now"}
              </button>

              <button
                onClick={() => handleSyncNow(true)}
                disabled={syncState.isSyncing || !user}
                className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-white border-opacity-10 text-gray-300 text-xs font-medium px-4 py-2 rounded-lg hover:border-primary-accent transition-all-custom disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-3.5 h-3.5 text-primary-accent" />
                Full Cloud Re-Sync
              </button>

              <div className="mt-3 pt-3 border-t border-white/10">
                <p className="text-xs text-gray-400 mb-2">
                  If this device gets out of sync, replace its local library with the current copy stored in Supabase.
                </p>
                {!showRestoreConfirm ? (
                  <button
                    onClick={() => setShowRestoreConfirm(true)}
                    disabled={syncState.isSyncing || restoring || !user}
                    className="w-full flex items-center justify-center gap-2 bg-bg-secondary border border-primary-accent/40 text-primary-accent font-semibold px-4 py-2 rounded-lg hover:bg-primary-accent/10 transition-all-custom disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <CloudDownload className="w-4 h-4" />
                    Restore This Device from Cloud
                  </button>
                ) : (
                  <div className="flex flex-col gap-3 bg-amber-500/10 p-3 rounded-lg border border-amber-500/30">
                    <div className="flex items-start gap-2 text-amber-300">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-bold">Replace this device's local data?</p>
                        <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                          This discards unsynchronized changes on this device and downloads the current cloud library. It does not delete or change anything in Supabase or on your other devices.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          if (!user || restoring) return;
                          setRestoring(true);
                          try {
                            const result = await syncEngine.restoreFromCloud(String(user.id));
                            setShowRestoreConfirm(false);
                            showNotice(`Restored ${result.pendingCount === 0 ? 'the cloud library' : 'cloud data'} on this device.`);
                          } catch (err: any) {
                            showNotice(err?.message || 'Cloud restore failed. Your previous local data was preserved when possible.', 'error');
                          } finally {
                            setRestoring(false);
                          }
                        }}
                        disabled={restoring || syncState.isSyncing || !user}
                        className="flex-1 bg-primary-accent text-black font-bold px-3 py-2 rounded-md text-xs disabled:opacity-50"
                      >
                        {restoring ? "Restoring..." : "Yes, Restore from Cloud"}
                      </button>
                      <button
                        onClick={() => setShowRestoreConfirm(false)}
                        disabled={restoring}
                        className="flex-1 bg-bg-secondary text-gray-300 px-3 py-2 rounded-md text-xs disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
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
