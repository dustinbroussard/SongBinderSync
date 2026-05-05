import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Download, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // Configurable frequency: 'session', 'daily', 'weekly'
    const PROMPT_FREQUENCY = 'session'; 

    // Check if already installed
    if (
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true
    ) {
      setIsStandalone(true);
      return;
    }

    // Check if user dismissed it based on frequency
    if (PROMPT_FREQUENCY === 'session') {
      const hasDismissedSession = sessionStorage.getItem('pwa_prompt_dismissed');
      if (hasDismissedSession) return;
    } else {
      const lastDismissedDate = localStorage.getItem('pwa_prompt_dismissed_date');
      if (lastDismissedDate) {
        const timeSince = Date.now() - parseInt(lastDismissedDate, 10);
        const daysSince = timeSince / (1000 * 60 * 60 * 24);
        
        if (PROMPT_FREQUENCY === 'daily' && daysSince < 1) return;
        if (PROMPT_FREQUENCY === 'weekly' && daysSince < 7) return;
      }
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setIsVisible(true);
    };

    const handleAppInstalled = () => {
      setIsVisible(false);
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
      setIsVisible(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setIsVisible(false);
    sessionStorage.setItem('pwa_prompt_dismissed', 'true');
    localStorage.setItem('pwa_prompt_dismissed_date', Date.now().toString());
  };

  if (isStandalone || !isVisible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 bg-bg-secondary border border-border shadow-elevation rounded-2xl p-4 z-[9999]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center justify-center w-12 h-12 bg-primary-accent rounded-xl shrink-0">
            <Download className="w-6 h-6 text-black" />
          </div>
          <div className="flex-1">
            <h3 className="text-white font-bold mb-1 tracking-tight text-lg">Install SongBinder</h3>
            <p className="text-sm text-gray-400 mb-4">
              Add this app to your home screen for quick access and offline mode.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleInstallClick}
                className="flex-1 bg-primary-accent text-black font-black py-2 rounded-lg hover:opacity-90 transition-opacity text-sm"
              >
                Install App
              </button>
              <button
                onClick={handleDismiss}
                className="flex-1 bg-white/5 text-gray-300 font-bold py-2 rounded-lg hover:bg-white/10 transition-colors text-sm border border-white/5"
              >
                Not Now
              </button>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
