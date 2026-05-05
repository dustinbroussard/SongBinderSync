import { motion } from "motion/react";
import { useNavigate } from "react-router-dom";
import CustomIcon from "../components/CustomIcon";
import { signInWithGoogle, isConfigured } from "../lib/supabase";
import { useEffect, useState } from "react";

export default function SignIn() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check for OAuth callback
    const hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
      setLoading(true);
      // Let Supabase handle the session restoration
      setTimeout(() => {
        window.location.hash = '';
        navigate('/');
      }, 500);
    }
  }, [navigate]);

  const handleGoogleSignIn = async () => {
    if (!isConfigured()) {
      setError('Supabase is not configured. Please check your environment variables.');
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      await signInWithGoogle();
      // The redirect will happen automatically
    } catch (err) {
      console.error('Sign in error:', err);
      setError('Failed to sign in. Please try again.');
      setLoading(false);
    }
  };

  const handleContinueOffline = () => {
    navigate('/');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg-primary">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        <div className="bg-bg-secondary border border-border p-8 rounded-2xl shadow-2xl">
          {/* Logo and Brand */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="text-center mb-8"
          >
            <div className="w-16 h-16 mx-auto mb-4 rounded-xl bg-primary-accent flex items-center justify-center shadow-lg shadow-primary-accent/20">
              <CustomIcon name="music" lucideFallback="Music" className="w-8 h-8 text-black" />
            </div>
            <h1 className="text-2xl font-bold font-mono-tech tracking-tighter mb-2">SongBinder</h1>
            <p className="text-xs uppercase tracking-widest text-white/40 font-bold">Pro Digital Gig Bag</p>
          </motion.div>

          {/* Welcome Text */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="text-center mb-8"
          >
            <h2 className="text-lg font-semibold text-white mb-3">
              Keep your songs organized and ready on any stage.
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Build setlists, edit lyrics, and run performance mode from one clean library. 
              Sign in to sync your access with Supabase Auth, or keep working locally on this device.
            </p>
          </motion.div>

          {/* Action Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
            className="space-y-3"
          >
            <button
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-gray-100 transition-all-custom disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="currentColor"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  <span>Sign in with Google</span>
                </>
              )}
            </button>

            <button
              onClick={handleContinueOffline}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-bg-tertiary border border-border text-white font-medium px-6 py-3 rounded-lg hover:border-primary-accent transition-all-custom disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue offline
            </button>
          </motion.div>

          {/* Error Message */}
          {error && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-4 p-3 bg-danger/10 border border-danger/30 rounded-lg"
            >
              <p className="text-sm text-danger text-center">{error}</p>
            </motion.div>
          )}

          {/* Info Text */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.5 }}
            className="mt-6 text-xs text-gray-500 text-center"
          >
            Your songs and setlists stay stored in this browser unless you choose to sign in.
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
