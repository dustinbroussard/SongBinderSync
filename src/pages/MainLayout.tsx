import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Search, Sun, Moon, Settings, Music, LogOut, LogIn } from "lucide-react";
import { cn } from "../lib/utils";
import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import SettingsModal from "../components/SettingsModal";
import { useTheme } from "../components/ThemeProvider";
import { useAuth } from "../components/AuthProvider";
import CustomIcon from "../components/CustomIcon";

export default function MainLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [showSettings, setShowSettings] = useState(false);
  const { theme, setTheme } = useTheme();
  const { user, signOut } = useAuth();

  const isSongs = location.pathname === "/";
  const isSetlists = location.pathname.startsWith("/setlists");

  const handleSignOut = async () => {
    await signOut();
    navigate('/signin');
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
            {user ? (
              <motion.button 
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSignOut}
                className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white bg-bg-secondary rounded-lg border border-border shadow-soft transition-all-custom"
                title="Sign out"
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
    </div>
  );
}
