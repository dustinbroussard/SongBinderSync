import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Sun, Moon, Settings, LogOut, LogIn, Cloud, CloudOff, RefreshCw, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import SettingsModal from "../components/SettingsModal";
import { useTheme } from "../components/ThemeProvider";
import { useAuth, useSyncStatus } from "../components/AuthProvider";
import { syncEngine } from "../lib/syncEngine";
import { useToast } from "../components/ToastProvider";
import CustomIcon from "../components/CustomIcon";

export default function MainLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [showSettings, setShowSettings] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [resolvingMismatch, setResolvingMismatch] = useState(false);
  const { theme, setTheme } = useTheme();
  const { user, signOut } = useAuth();
  const syncState = useSyncStatus();
  const { success, error: toastError, info } = useToast();

  const syncPausedForDiagnostics = new URLSearchParams(window.location.search).get("pauseSync") === "1";
  const isSongs = location.pathname === "/";
  const isSetlists = location.pathname.startsWith("/setlists");

  const handleSignOut = async () => {
    setShowSignOutConfirm(true);
  };

  const confirmSignOut = async () => {
    await signOut();
    navigate('/signin');
    setShowSignOutConfirm(false);
  };

  const syncAndSignOut = async () => {
    const res = await syncEngine.syncNow('pre_signout');
    if (res.status === 'synced' || res.status === 'conflict') {
      await confirmSignOut();
    } else {
      toastError(res.lastError || "Could not finish syncing before sign out.");
    }
  };

  const handleQuickSync = async () => {
    if (syncPausedForDiagnostics) return;
    if (!user) {
      navigate('/signin');
      return;
    }
    if (syncState.status === 'auth_required') {
      navigate('/signin');
      return;
    }
    const res = await syncEngine.syncNow('manual_header');
    if (res.status === 'synced') {
      success("Library synced with cloud");
    } else if (res.status === 'conflict') {
      info(`Synced with ${res.lastConflictCount} conflict copy created`);
    } else if (res.status === 'offline') {
      info("Offline — changes queued locally");
    } else if (res.lastError) {
      toastError(res.lastError);
    }
  };

  const renderSyncIcon = () => {
    if (syncState.isSyncing) {
      return <RefreshCw className="w-3.5 h-3.5 md:w-4 md:h-4 animate-spin text-primary-accent" />;
    }
    if (syncState.status === 'offline') {
      return <CloudOff className="w-3.5 h-3.5 md:w-4 md:h-4 text-gray-500" />;
    }
    if (syncState.status === 'error' || syncState.status === 'auth_required' || syncState.status === 'account_mismatch') {
      return <AlertTriangle className="w-3.5 h-3.5 md:w-4 md:h-4 text-danger" />;
    }
    return (
      <div className="relative">
        <Cloud className={cn("w-3.5 h-3.5 md:w-4 md:h-4", syncState.pendingCount > 0 ? "text-amber-400" : "text-primary-accent")} />
        {syncState.pendingCount > 0 && (
          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400" />
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen w-full max-w-5xl mx-auto overflow-hidden bg-bg-primary relative">
      {/* Header */}
      <header className="flex-none p-3 md:p-6 pb-0">
        <div className="flex items-center justify-between mb-3 md:mb-4">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2 md:gap-3"
          >
            <div className="w-7 h-7 md:w-8 md:h-8 rounded-lg bg-primary-accent flex items-center justify-center shadow-lg shadow-primary-accent/20">
              <CustomIcon name="music" lucideFallback="Music" className="w-3.5 h-3.5 md:w-4 md:h-4 text-black" />
            </div>
            <div>
              <h1 className="text-lg md:text-xl font-bold font-mono-tech tracking-tighter leading-tight">SongBinder</h1>
              <p className="text-[8px] md:text-[9px] uppercase tracking-widest text-white/40 font-bold">Pro Digital Gig Bag</p>
            </div>
          </motion.div>

          <div className="flex items-center gap-1.5 md:gap-2">
            {user && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleQuickSync}
                disabled={syncState.isSyncing || syncPausedForDiagnostics}
                aria-label="Sync library with cloud"
                title={syncPausedForDiagnostics ? "Sync is paused in diagnostic mode" : syncState.pendingCount > 0 ? `Sync (${syncState.pendingCount} pending)` : "Sync library"}
                className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white bg-bg-secondary rounded-lg border border-border shadow-soft transition-all-custom disabled:opacity-60"
              >
                {renderSyncIcon()}
              </motion.button>
            )}

            {user ? (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSignOut}
                disabled={syncPausedForDiagnostics}
                aria-label="Sign out"
                className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white bg-bg-secondary rounded-lg border border-border shadow-soft transition-all-custom disabled:opacity-40"
                title={syncPausedForDiagnostics ? "Sign out is disabled during local queue inspection" : "Sign out"}
              >
                <LogOut className="w-3.5 h-3.5 md:w-4 md:h-4" />
              </motion.button>
            ) : (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => navigate('/signin')}
                aria-label="Sign in"
                className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white bg-bg-secondary rounded-lg border border-border shadow-soft transition-all-custom"
                title="Sign in"
              >
                <LogIn className="w-3.5 h-3.5 md:w-4 md:h-4" />
              </motion.button>
            )}
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle theme"
              title="Toggle theme"
              className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white bg-bg-secondary rounded-lg border border-border shadow-soft transition-all-custom"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5 md:w-4 md:h-4" /> : <Moon className="w-3.5 h-3.5 md:w-4 md:h-4" />}
            </motion.button>
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowSettings(true)}
              aria-label="Open settings"
              title="Settings"
              className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white bg-bg-secondary rounded-lg border border-border shadow-soft transition-all-custom"
            >
              <Settings className="w-3.5 h-3.5 md:w-4 md:h-4" />
            </motion.button>
          </div>
        </div>

        {/* Tab Navigation */}
        <nav className="flex p-1 bg-bg-secondary rounded-lg border border-border shadow-inner">
          <Link
            to="/"
            className={cn(
              "flex-1 px-4 py-2.5 text-xs font-semibold text-center rounded-md transition-all-custom relative z-10",
              isSongs ? "text-white" : "text-gray-500 hover:text-gray-300"
            )}
          >
            <span className="relative z-20">Songs</span>
            {isSongs && (
              <motion.div
                layoutId="nav-bg"
                className="absolute inset-0 bg-bg-tertiary rounded-md shadow-sm border border-border"
                transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
              />
            )}
          </Link>
          <Link
            to="/setlists"
            className={cn(
              "flex-1 px-4 py-2.5 text-xs font-semibold text-center rounded-md transition-all-custom relative z-10",
              isSetlists ? "text-white" : "text-gray-500 hover:text-gray-300"
            )}
          >
            <span className="relative z-20">Setlists</span>
            {isSetlists && (
              <motion.div
                layoutId="nav-bg"
                className="absolute inset-0 bg-bg-tertiary rounded-md shadow-sm border border-border"
                transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
              />
            )}
          </Link>
        </nav>
      </header>

      {syncPausedForDiagnostics && (
        <div className="mx-3 md:mx-6 mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <strong>Read-only diagnostic mode.</strong> Cloud sync is paused in this tab. Please do not edit songs, setlists, import backups, or sign out until the local queue report is collected.
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 overflow-hidden relative mt-2">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="h-full w-full"
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {showSettings && (
          <SettingsModal onClose={() => setShowSettings(false)} />
        )}
      </AnimatePresence>

      {/* Account Switch Isolation Guard */}
      <AnimatePresence>
        {syncState.accountMismatch && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black bg-opacity-80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-bg-secondary border border-border p-6 rounded-xl w-full max-w-md shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-3 text-amber-400">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <h3 className="text-lg font-bold font-mono-tech text-white">Different Account Detected</h3>
              </div>
              <p className="text-sm text-gray-300 mb-4 leading-relaxed">
                This device currently holds {syncState.accountMismatch.localSongCount} song(s) and{' '}
                {syncState.accountMismatch.localSetlistCount} setlist(s) from a previous account.
                Choose how to proceed so accounts stay isolated:
              </p>
              <div className="flex flex-col gap-2">
                <button
                  disabled={resolvingMismatch}
                  onClick={async () => {
                    if (!syncState.accountMismatch) return;
                    setResolvingMismatch(true);
                    await syncEngine.resolveAccountMismatchReplace(syncState.accountMismatch.newUserId);
                    setResolvingMismatch(false);
                  }}
                  className="w-full px-4 py-2.5 rounded-lg bg-primary-accent text-black font-semibold hover:bg-opacity-90 transition-all-custom disabled:opacity-50"
                >
                  Replace Local Data with This Account's Cloud
                </button>
                <button
                  disabled={resolvingMismatch}
                  onClick={async () => {
                    if (!syncState.accountMismatch) return;
                    setResolvingMismatch(true);
                    await syncEngine.resolveAccountMismatchMerge(syncState.accountMismatch.newUserId);
                    setResolvingMismatch(false);
                  }}
                  className="w-full px-4 py-2.5 rounded-lg border border-border text-white font-medium hover:border-primary-accent transition-all-custom disabled:opacity-50"
                >
                  Keep & Merge Local Library into This Account
                </button>
                <button
                  disabled={resolvingMismatch}
                  onClick={confirmSignOut}
                  className="w-full px-4 py-2 rounded-lg text-gray-400 hover:text-white transition-all-custom text-sm"
                >
                  Sign Out
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSignOutConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black bg-opacity-80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-bg-secondary border border-border p-6 rounded-xl w-full max-w-sm shadow-2xl"
            >
              <h3 className="text-lg font-bold font-mono-tech mb-2">Sign Out</h3>
              <p className="text-sm text-gray-400 mb-6">
                {syncState.pendingCount > 0
                  ? `You have ${syncState.pendingCount} unsynced local change(s). Sync before signing out so nothing is left only on this device.`
                  : "Are you sure you want to sign out?"}
              </p>
              <div className="flex flex-col gap-2">
                {syncState.pendingCount > 0 && (
                  <button
                    onClick={syncAndSignOut}
                    disabled={syncState.isSyncing}
                    className="w-full px-4 py-2 rounded-lg bg-primary-accent text-black font-semibold hover:bg-opacity-90 transition-all-custom disabled:opacity-50"
                  >
                    {syncState.isSyncing ? "Syncing..." : "Sync & Sign Out"}
                  </button>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowSignOutConfirm(false)}
                    className="flex-1 px-4 py-2 rounded-lg border border-border text-gray-400 hover:text-white hover:border-gray-500 transition-all-custom"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmSignOut}
                    className="flex-1 px-4 py-2 rounded-lg bg-danger text-white font-medium hover:bg-opacity-90 transition-all-custom"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
