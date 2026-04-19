window.CONFIG = {
  chordsModeEnabled: true,
  autosaveEnabled: true,
  autoscrollDefaultEnabled: true,
  showExperimentalFeatures: false,
  maxFontSize: 64,
  minFontSize: 16,
  devMode: false,
  openrouterApiKey: '',
  defaultModel: '',
  // New:
  chordLinePrefix: '~',
  assumeNoChords: true,
};

try {
  const host = window.location && window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (isLocal && localStorage.getItem('devMode') === '1') {
    window.CONFIG.devMode = true;
  }
} catch {}
