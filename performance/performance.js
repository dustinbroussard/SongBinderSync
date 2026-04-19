// Register Service Worker (CSP-friendly) and support subfolder hosting
try {
  if ('serviceWorker' in navigator) {
    const swUrl = (() => {
      try {
        return new URL('../sw.js', window.location.href).href;
      } catch {
        return '../sw.js';
      }
    })();
    const showSwUpdateBanner = (registration) => {
      if (document.getElementById('sw-update-banner')) return;
      const banner = document.createElement('div');
      banner.id = 'sw-update-banner';
      banner.className = 'sw-update-banner';
      banner.innerHTML = `
        <span>Update available.</span>
        <button type="button" class="btn sw-update-btn">Reload</button>
      `;
      banner.querySelector('.sw-update-btn')?.addEventListener('click', () => {
        try { registration.waiting?.postMessage({ type: 'SKIP_WAITING' }); } catch {}
      });
      document.body.appendChild(banner);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.location.reload();
        });
      }
    };
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swUrl).then((registration) => {
        if (registration.waiting) {
          showSwUpdateBanner(registration);
        }
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showSwUpdateBanner(registration);
            }
          });
        });
      }).catch(() => {});
    });
  }
} catch {}

async function ensurePersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;
    const already = await navigator.storage.persisted?.();
    if (already) return;
    const granted = await navigator.storage.persist();
    if (!granted) {
      console.warn('Persistent storage request was denied; performance data may be evicted.');
    }
  } catch (err) {
    console.warn('Unable to request persistent storage', err);
  }
}
ensurePersistentStorage();

function safeParseFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

document.addEventListener('DOMContentLoaded', () => {
    // ==== TOASTS ====
    function showToast(message, type = 'success', timeout = 2500) {
      const toast = document.createElement('div');
      toast.className = `toast toast-${type} show`;
      toast.textContent = message;
      document.body.appendChild(toast);
      requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
      setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, timeout);
    }
    function confirmDialog(message, onYes, onNo) {
      const modal = document.createElement('div');
      modal.className = 'modal'; modal.style.display = 'flex';
      const content = document.createElement('div'); content.className = 'modal-content';
      const h2 = document.createElement('h2'); h2.textContent = 'Confirm';
      const p = document.createElement('p'); p.textContent = String(message || 'Are you sure?');
      const actions = document.createElement('div'); actions.className = 'modal-actions';
      const yes = document.createElement('button'); yes.className = 'btn'; yes.id = 'confirm-yes'; yes.textContent = 'Yes';
      const no = document.createElement('button'); no.className = 'btn'; no.id = 'confirm-no'; no.textContent = 'No';
      actions.appendChild(yes); actions.appendChild(no);
      content.appendChild(h2); content.appendChild(p); content.appendChild(actions);
      modal.appendChild(content);
      document.body.appendChild(modal);
      yes.onclick = () => { modal.remove(); onYes && onYes(); };
      no.onclick = () => { modal.remove(); onNo && onNo(); };
    }

    function escapeHTML(s){
      return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // ==== DB MODULE (dupe for performance context)
    const DB = (() => {
      const DB_NAME = 'hrr-setlist-db';
      const DB_VERSION = 2;
      const REQUIRED_STORES = ['songs', 'setlists', 'meta'];
      let _db;
      let _dbWasReset = false;
      const hasRequiredStores = (db) => REQUIRED_STORES.every((name) => db.objectStoreNames.contains(name));
      const upgradeSchema = (db) => {
        if(!db.objectStoreNames.contains('songs')){ const s=db.createObjectStore('songs',{keyPath:'id'}); if(s.createIndex) s.createIndex('title','title',{unique:false}); }
        if(!db.objectStoreNames.contains('setlists')){ const sl=db.createObjectStore('setlists',{keyPath:'id'}); if(sl.createIndex) sl.createIndex('name','name',{unique:false}); }
        if(!db.objectStoreNames.contains('meta')){ db.createObjectStore('meta'); }
      };
      async function backupExistingData(db){
        const backup = { songs: [], setlists: [] };
        try{
          const storeNames = Array.from(db.objectStoreNames);
          if (storeNames.includes('songs')) backup.songs = await db.getAll('songs');
          if (storeNames.includes('setlists')) backup.setlists = await db.getAll('setlists');
        }catch(e){
          console.warn('Failed to backup data before DB reset', e);
        }
        return backup;
      }
      async function restoreBackup(db, backup){
        if (!backup) return;
        try{
          if (Array.isArray(backup.songs) && backup.songs.length){
            const tx = db.transaction('songs', 'readwrite');
            for (const song of backup.songs) await tx.store.put(song);
            await tx.done;
          }
        }catch(e){
          console.warn('Failed to restore songs after DB reset', e);
        }
        try{
          if (Array.isArray(backup.setlists) && backup.setlists.length){
            const tx = db.transaction('setlists', 'readwrite');
            for (const setlist of backup.setlists) await tx.store.put(setlist);
            await tx.done;
          }
        }catch(e){
          console.warn('Failed to restore setlists after DB reset', e);
        }
      }
      async function open(){
        if(_db) return _db;
        _db = await idb.openDB(DB_NAME, DB_VERSION, { upgrade(db){ upgradeSchema(db); } });
        if(!hasRequiredStores(_db)){
          const backup = await backupExistingData(_db);
          try{
            _db.close();
            await idb.deleteDB(DB_NAME);
            _db = await idb.openDB(DB_NAME, DB_VERSION, { upgrade: upgradeSchema });
            _dbWasReset = true;
          }catch(_){}
          try{
            await restoreBackup(_db, backup);
          }catch(e){
            console.warn('Failed to restore DB backup', e);
          }
        }
        return _db;
      }
      return {
        async getAllSongs(){ const db=await open(); return db.getAll('songs'); },
        async getAllSetlists(){ const db=await open(); return db.getAll('setlists'); },
        async getMeta(key){ const db=await open(); return db.get('meta', key); },
        async putMeta(key, val){ const db=await open(); return db.put('meta', val, key); },
        async putSongs(songs){ const db=await open(); const tx=db.transaction('songs','readwrite'); for (const s of songs) await tx.store.put(s); await tx.done; },
        async putSetlists(setlists){ const db=await open(); const tx=db.transaction('setlists','readwrite'); for (const s of setlists) await tx.store.put(s); await tx.done; },
        wasReset(){ return _dbWasReset; }
      };
    })();
    const app = {
        // DOM Elements
        performanceMode: document.getElementById('performance-mode'),
        performanceSongInfo: document.getElementById('performance-song-info'),
        lyricsDisplay: document.getElementById('lyrics-display'),
        lyricsContent: document.getElementById('lyrics-content'),
        fontControlsEl: document.getElementById('font-controls'),
        decreaseFontBtn: document.getElementById('decrease-font-btn'),
        increaseFontBtn: document.getElementById('increase-font-btn'),
        fontSizeDisplay: document.getElementById('font-size-display'),
        toggleThemeBtn: document.getElementById('theme-toggle-btn'),
        exitPerformanceBtn: document.getElementById('exit-performance-btn'),
        scrollToTopBtn: document.getElementById('scroll-to-top-btn'),
        autoScrollBtn: document.getElementById('auto-scroll-btn'),
        autoscrollSettingsBtn: document.getElementById('autoscroll-settings-btn'),
        autoscrollDelayModal: document.getElementById('autoscroll-delay-modal'),
        autoscrollDelaySlider: document.getElementById('autoscroll-delay-slider'),
        autoscrollDelayValue: document.getElementById('autoscroll-delay-value'),
        autoscrollSpeedSlider: document.getElementById('autoscroll-speed-slider'),
        autoscrollSpeedValue: document.getElementById('autoscroll-speed-value'),
        tapFeedbackSelect: document.getElementById('tap-feedback-select'),
        closeAutoscrollDelayModal: document.getElementById('close-autoscroll-delay-modal'),

        // State
        songs: [],
        performanceSetlistId: null,
        autoFitManuallyOverridden: false,
        performanceSongs: [],
        currentPerformanceSongIndex: 0,
        isPerformanceMode: true,
        autoScrollTimer: null,
        autoScrollDelayTimer: null,
        defaultAutoScrollSpeed: Number(localStorage.getItem('autoscrollSpeed')) || 1,
        autoScrollSpeed: Number(localStorage.getItem('autoscrollSpeed')) || 1,
        autoScrollActive: false,
        autoscrollDelay: Number(localStorage.getItem('autoscrollDelay')) || 3,
        resizeObserver: null,

        fontSize: 32, // default value; will set per song
        perSongFontSizes: safeParseFromStorage('perSongFontSizes', {}),
        perSongAutoscrollSpeeds: safeParseFromStorage('perSongAutoscrollSpeeds', {}),
        autoScrollOnStart: safeParseFromStorage('autoScrollOnStart', {}),
        minFontSize: 16,
        maxFontSize: 72,
        fontSizeStep: 1,
        fontFab: null,
        _fontOutsideHandler: null,
        _fontControlsTimer: null,
        isChordsVisible: (localStorage.getItem('performanceShowChords') === '1'),
        explicitSongSelection: false,
        tapFeedbackMode: localStorage.getItem('tapFeedbackMode') || 'none',
        audioCtx: null,
        isFontPanelOpen: false,

        // Initialize
        init() {
            (async () => {
            // Keep screen awake and lock orientation where possible
            try {
                if ('wakeLock' in navigator) {
                    let wl;
                    const request = async () => {
                        try { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', ()=>{}); } catch {}
                    };
                    document.addEventListener('visibilitychange', () => {
                        if (document.visibilityState === 'visible') request();
                    });
                    request();
                }
                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('landscape').catch(()=>{});
                }
            } catch {}
            // Run migration if needed (e.g., if opened directly)
            try {
              const migrated = await DB.getMeta('migrated');
              if (migrated !== true) {
                const songs = safeParseFromStorage('songs', []);
                const setlists = safeParseFromStorage('setlists', []);
                if (songs && songs.length) await DB.putSongs(songs);
                if (setlists && setlists.length) await DB.putSetlists(setlists);
                await DB.putMeta('migrated', true);
              }
            } catch(e) {}
            await this.loadData();
            try {
                if (DB.wasReset && DB.wasReset() && !sessionStorage.getItem('dbResetToastShown')) {
                    showToast('Storage was reset; please re-import your backup.', 'info', 5000);
                    sessionStorage.setItem('dbResetToastShown', '1');
                }
            } catch {}
            this.setupEventListeners();
            await this.loadPerformanceState();
            this.displayCurrentPerformanceSong();
            this.setupResizeObserver();
            this.initFontControlsMobile();
            window.addEventListener('resize', (() => {
                let t;
                return () => { clearTimeout(t); t = setTimeout(() => this.initFontControlsMobile(), 200); };
            })());
            })();
        },

        // Setup resize observer for auto-fit (unchanged)
        setupResizeObserver() {
            if (window.ResizeObserver) {
                this.resizeObserver = new ResizeObserver(() => {
                    if (!this.autoFitManuallyOverridden) {
                        clearTimeout(this.resizeTimeout);
                        this.resizeTimeout = setTimeout(() => {
                            // Optionally, you could auto-fit here if you want
                        }, 100);
                    }
                });
                this.resizeObserver.observe(this.performanceMode);
            }
        },

        // Load data
        async loadData() {
            try { this.songs = await DB.getAllSongs(); } catch (e) { this.songs = []; }
            const theme = (localStorage.getItem('theme') === 'light') ? 'light' : 'dark';
            document.documentElement.dataset.theme = theme;
        },

        // Load performance state from query parameters
        async loadPerformanceState() {
            const params = new URLSearchParams(window.location.search);
            this.performanceSetlistId = params.get('setlistId') || null;
            const songId = params.get('songId');
            this.explicitSongSelection = !!songId;
            const idsParam = params.get('ids');
            if (!this.performanceSetlistId) {
                // Default to last performed setlist if none specified
                try {
                    const lpRaw = localStorage.getItem('lastPerformance');
                    const lp = lpRaw ? JSON.parse(lpRaw) : null;
                    if (lp && lp.setlistId) this.performanceSetlistId = lp.setlistId;
                } catch {}
            }
            let selectedSong = null;
            if (songId) {
                selectedSong = this.songs.find(s => s.id === songId) || null;
            }
            if (this.performanceSetlistId) {
                const setlists = await DB.getAllSetlists();
                const setlist = (setlists||[]).find(s => s.id === this.performanceSetlistId);
                if (setlist) {
                    this.performanceSongs = setlist.songs
                        .map(id => this.songs.find(s => s.id === id))
                        .filter(Boolean);
                } else if (idsParam) {
                    // Fallback for local file environments where IDB may not share across pages
                    const ids = idsParam.split(',').filter(Boolean);
                    this.performanceSongs = ids
                        .map(id => this.songs.find(s => s.id === id))
                        .filter(Boolean);
                }
            } else if (idsParam) {
                const ids = idsParam.split(',').filter(Boolean);
                this.performanceSongs = ids
                    .map(id => this.songs.find(s => s.id === id))
                    .filter(Boolean);
            } else if (songId && selectedSong) {
                this.performanceSongs = [selectedSong];
            } else {
                this.performanceSongs = this.songs;
            }
            if (!Array.isArray(this.performanceSongs) || !this.performanceSongs.length) {
                if (songId && selectedSong) {
                    this.performanceSongs = [selectedSong];
                } else {
                    this.performanceSongs = this.songs;
                }
            }
            if (songId && selectedSong) {
                let idx = this.performanceSongs.findIndex(s => s.id === songId);
                if (idx === -1) {
                    const seen = new Set();
                    const merged = [selectedSong];
                    for (const s of this.performanceSongs) {
                        if (!s || seen.has(s.id) || s.id === selectedSong.id) continue;
                        seen.add(s.id);
                        merged.push(s);
                    }
                    this.performanceSongs = merged;
                    idx = 0;
                }
                this.currentPerformanceSongIndex = idx;
            } else {
                this.currentPerformanceSongIndex = 0;
            }
            await this.maybeResumeSetlist();
        },

        async maybeResumeSetlist() {
            if (this.explicitSongSelection) {
                if (this.currentPerformanceSongIndex < 0 || this.currentPerformanceSongIndex >= this.performanceSongs.length) {
                    this.currentPerformanceSongIndex = 0;
                }
                return;
            }
            const lastPerfRaw = localStorage.getItem('lastPerformance');
            let lastPerf = null;
            if (lastPerfRaw) {
                try { lastPerf = JSON.parse(lastPerfRaw); } catch (e) {}
            }
            return await new Promise((resolve) => {
                // Only prompt if we're entering the SAME setlist as before, and it wasn't at the beginning
                if (
                    lastPerf &&
                    lastPerf.setlistId &&
                    lastPerf.setlistId === this.performanceSetlistId &&
                    typeof lastPerf.songIndex === 'number' &&
                    lastPerf.songIndex > 0 &&
                    this.performanceSongs[lastPerf.songIndex]
                ) {
                    confirmDialog(
                        `Resume this setlist where we left off? (Song ${lastPerf.songIndex + 1}: ${this.performanceSongs[lastPerf.songIndex]?.title || 'Unknown'})`,
                        () => { this.currentPerformanceSongIndex = lastPerf.songIndex; resolve(); },
                        () => { this.currentPerformanceSongIndex = 0; resolve(); }
                    );
                } else {
                    this.currentPerformanceSongIndex = 0;
                    resolve();
                }
            });
        },

        // Setup event listeners
        setupEventListeners() {
            // FONT SIZE BUTTONS
            this.decreaseFontBtn.addEventListener('click', () => this.adjustFontSize(-this.fontSizeStep));
            this.increaseFontBtn.addEventListener('click', () => this.adjustFontSize(this.fontSizeStep));
            this.toggleThemeBtn.addEventListener('click', () => this.handlePerformanceThemeToggle());
            this.exitPerformanceBtn.addEventListener('click', () => this.exitPerformanceMode());
            this.scrollToTopBtn.addEventListener('click', () => {
                this.lyricsDisplay.scrollTo({ top: 0, behavior: 'smooth' });
            });
            this.autoScrollBtn.addEventListener('click', () => this.toggleAutoScroll());
            this.autoscrollSettingsBtn.addEventListener('click', () => {
                this.autoscrollDelayModal.style.display = 'block';
                this.autoscrollDelaySlider.value = this.autoscrollDelay;
                this.autoscrollDelayValue.textContent = this.autoscrollDelay + 's';
                this.autoscrollSpeedSlider.value = this.autoScrollSpeed;
                this.autoscrollSpeedValue.textContent = this.autoScrollSpeed;
                if (this.tapFeedbackSelect) {
                    this.tapFeedbackSelect.value = this.tapFeedbackMode || 'none';
                }
                const chordToggle = document.getElementById('show-chords-toggle');
                if (chordToggle) chordToggle.checked = !!this.isChordsVisible;
            });
            this.autoscrollDelaySlider.addEventListener('input', (e) => {
                this.autoscrollDelayValue.textContent = e.target.value + 's';
            });
            this.autoscrollSpeedSlider.addEventListener('input', (e) => {
                this.autoscrollSpeedValue.textContent = e.target.value;
            });
            this.closeAutoscrollDelayModal.addEventListener('click', () => {
                this.autoscrollDelay = Number(this.autoscrollDelaySlider.value);
                localStorage.setItem('autoscrollDelay', this.autoscrollDelay);
                this.autoScrollSpeed = Number(this.autoscrollSpeedSlider.value);
                localStorage.setItem('autoscrollSpeed', this.autoScrollSpeed);
                this.defaultAutoScrollSpeed = this.autoScrollSpeed;
                this.storeAutoscrollSpeedForCurrentSong();
                if (this.tapFeedbackSelect) {
                    this.tapFeedbackMode = this.tapFeedbackSelect.value || 'none';
                    localStorage.setItem('tapFeedbackMode', this.tapFeedbackMode);
                }
                const chordToggle = document.getElementById('show-chords-toggle');
                if (chordToggle) {
                    this.isChordsVisible = chordToggle.checked;
                    localStorage.setItem('performanceShowChords', this.isChordsVisible ? '1' : '0');
                    this.displayCurrentPerformanceSong();
                    if (this.isChordsVisible && !localStorage.getItem('chordsHintShown')) {
                        try {
                            showToast('Chords shown. Tip: adjust font size for best alignment.', 'info', 3500);
                            localStorage.setItem('chordsHintShown', '1');
                        } catch {}
                    }
                }
                this.autoscrollDelayModal.style.display = 'none';
            });
            const chordToggle = document.getElementById('show-chords-toggle');
            if (chordToggle) chordToggle.addEventListener('change', (e)=>{
                this.isChordsVisible = !!e.target.checked;
                localStorage.setItem('performanceShowChords', this.isChordsVisible ? '1' : '0');
                this.displayCurrentPerformanceSong();
                if (this.isChordsVisible && !localStorage.getItem('chordsHintShown')) {
                    try {
                        showToast('Chords shown. Tip: adjust font size for best alignment.', 'info', 3500);
                        localStorage.setItem('chordsHintShown', '1');
                    } catch {}
                }
            });
            if (this.tapFeedbackSelect) {
                this.tapFeedbackSelect.addEventListener('change', (e) => {
                    this.tapFeedbackMode = e.target.value || 'none';
                    localStorage.setItem('tapFeedbackMode', this.tapFeedbackMode);
                    if (this.tapFeedbackMode !== 'none') {
                        this.playTapFeedback('nav');
                    }
                });
            }
            this.lyricsDisplay.addEventListener('scroll', () => this.updateScrollButtonsVisibility());
            this.lyricsDisplay.addEventListener('touchstart', () => this.stopAutoScroll());
            this.lyricsDisplay.addEventListener('mousedown', () => this.stopAutoScroll());

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isFontPanelOpen) {
                    this.hideFontControls();
                }
            });

            // Touch swipe navigation is handled by the global setupSwipeNav() below
        },
        handleDoubleTapSection(direction) {
            const target = direction > 0 ? 'chorus' : 'verse 1';
            const success = this.jumpToSongSection(target);
            if (!success) {
                try {
                    showToast(`No ${direction > 0 ? 'Chorus' : 'Verse 1'} tag found.`, 'info', 1800);
                } catch {}
            }
        },

        jumpToSongSection(targetLabel) {
            const container = this.lyricsContent || this.lyricsDisplay;
            if (!container) return false;
            const normalized = targetLabel.toLowerCase();
            let match = null;
            const firstVerseRegex = /\bverse\s*(1|one|i)\b/;
            const labels = container.querySelectorAll('.section-label');
            labels.forEach((el) => {
                if (match) return;
                const text = (el.textContent || '').toLowerCase();
                if (!text) return;
                if (normalized === 'verse 1') {
                    if (firstVerseRegex.test(text)) {
                        match = el;
                    }
                } else if (text.includes(normalized)) {
                    match = el;
                }
            });
            if (!match) return false;
            match.scrollIntoView({ behavior: 'smooth', block: 'center' });
            match.classList.add('section-highlight');
            setTimeout(() => match.classList.remove('section-highlight'), 1200);
            this.playTapFeedback('section');
            return true;
        },

        flashCornerButton(btn) {
            if (!btn) return;
            btn.classList.remove('glow');
            clearTimeout(btn._glowTimer);
            btn.classList.add('glow');
            btn._glowTimer = setTimeout(() => {
                btn.classList.remove('glow');
            }, 320);
        },

        applySlideTransition(direction) {
            const target = this.lyricsContent;
            if (!target) return;
            if (!direction) {
                target.style.transition = '';
                target.style.transform = '';
                target.style.opacity = '';
                return;
            }
            const offset = direction > 0 ? 28 : -28;
            target.style.transition = '';
            target.style.transform = '';
            target.style.opacity = '';
            requestAnimationFrame(() => {
                target.style.transition = 'none';
                target.style.transform = `translateX(${offset}px)`;
                target.style.opacity = '0.72';
                requestAnimationFrame(() => {
                    target.style.transition = 'transform 160ms ease, opacity 160ms ease';
                    target.style.transform = 'translateX(0)';
                    target.style.opacity = '1';
                    const cleanup = () => {
                        target.style.transition = '';
                        target.style.transform = '';
                        target.style.opacity = '';
                    };
                    target.addEventListener('transitionend', cleanup, { once: true });
                });
            });
        },

        playTapFeedback(kind = 'nav') {
            if (!this.tapFeedbackMode || this.tapFeedbackMode === 'none') return;
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                navigator.vibrate(this.tapFeedbackMode === 'click' ? 8 : 12);
            }
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!this.audioCtx) {
                try {
                    this.audioCtx = new AudioCtx();
                } catch {
                    this.audioCtx = null;
                }
            }
            const ctx = this.audioCtx;
            if (!ctx) return;
            if (ctx.state === 'suspended') {
                ctx.resume().catch(()=>{});
            }
            if (this.tapFeedbackMode === 'click') {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = 620;
                const now = ctx.currentTime;
                gain.gain.setValueAtTime(0, now);
                gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
                osc.connect(gain).connect(ctx.destination);
                osc.start(now);
                osc.stop(now + 0.15);
            } else if (this.tapFeedbackMode === 'whoosh') {
                const duration = 0.22;
                const bufferSize = Math.floor(ctx.sampleRate * duration);
                const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    const decay = 1 - i / bufferSize;
                    data[i] = (Math.random() * 2 - 1) * Math.pow(decay, 1.5);
                }
                const noise = ctx.createBufferSource();
                noise.buffer = buffer;
                const gain = ctx.createGain();
                const now = ctx.currentTime;
                gain.gain.value = 0.22;
                gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
                noise.connect(gain).connect(ctx.destination);
                noise.start(now);
                noise.stop(now + duration);
            }
        },

        persistAutoScrollPreference(forceValue) {
            const song = this.performanceSongs[this.currentPerformanceSongIndex];
            if (!song || !song.id) return;
            const shouldStart = typeof forceValue === 'boolean' ? forceValue : this.autoScrollActive;
            if (shouldStart) {
                this.autoScrollOnStart[song.id] = true;
            } else {
                delete this.autoScrollOnStart[song.id];
            }
            localStorage.setItem('autoScrollOnStart', JSON.stringify(this.autoScrollOnStart));
        },

        storeAutoscrollSpeedForCurrentSong() {
            const song = this.performanceSongs[this.currentPerformanceSongIndex];
            if (!song || !song.id) return;
            this.perSongAutoscrollSpeeds[song.id] = this.autoScrollSpeed;
            localStorage.setItem('perSongAutoscrollSpeeds', JSON.stringify(this.perSongAutoscrollSpeeds));
        },


        // Floating font controls (mobile/tablet) modeled after editor
        initFontControlsMobile() {
            const isMobile = window.innerWidth <= 1024;
            if (!this.fontControlsEl) return;
            if (!isMobile) {
                this.fontControlsEl.classList.add('visible');
                if (this.fontFab && this.fontFab.parentNode) this.fontFab.parentNode.removeChild(this.fontFab);
                this.fontFab = null;
                this.isFontPanelOpen = false;
                this.clearFontControlsHideTimer?.();
                return;
            }
            // On mobile: keep hidden until user taps FAB
            this.fontControlsEl.classList.remove('visible');
            if (!this.fontFab) {
                const btn = document.createElement('button');
                btn.className = 'font-fab';
                btn.title = 'Font controls';
                btn.innerHTML = '<i class="fas fa-text-height"></i>';
                document.body.appendChild(btn);
                btn.addEventListener('click', () => {
                    if (this.isFontPanelOpen) this.hideFontControls();
                    else this.showFontControls();
                });
                this.fontFab = btn;
            }
            // Hide when clicking outside controls
            if (!this._fontOutsideHandler) {
                this._fontOutsideHandler = (e) => {
                    const path = e.composedPath ? e.composedPath() : [];
                    const hitsPanel = path.includes(this.fontControlsEl) || (this.fontControlsEl?.contains?.(e.target));
                    const hitsFab = path.includes(this.fontFab) || (this.fontFab?.contains?.(e.target));
                    if (!this.fontControlsEl.classList.contains('visible')) return;
                    if (hitsPanel) return;
                    if (hitsFab) return;
                    this.hideFontControls();
                };
                document.addEventListener('click', this._fontOutsideHandler);
            }
        },

        showFontControls() {
            if (!this.fontControlsEl) return;
            this.fontControlsEl.classList.add('visible');
            if (this.fontFab) this.fontFab.classList.add('is-open');
            this.isFontPanelOpen = true;
            this.clearFontControlsHideTimer();
        },

        hideFontControls() {
            if (!this.fontControlsEl) return;
            this.fontControlsEl.classList.remove('visible');
            if (this.fontFab) this.fontFab.classList.remove('is-open');
            this.isFontPanelOpen = false;
            this.clearFontControlsHideTimer();
        },

        clearFontControlsHideTimer() {
            if (this._fontControlsTimer) {
                clearTimeout(this._fontControlsTimer);
                this._fontControlsTimer = null;
            }
        },

        // Display current song
        displayCurrentPerformanceSong(direction = 0) {
            const song = this.performanceSongs[this.currentPerformanceSongIndex];
            if (!song) return;

            this.autoFitManuallyOverridden = false; // Reset override for new song

            // Process lyrics
            let lines = (song.lyrics || '').split('\n').map(line => line.trimEnd());
            const chordsLines = String(song.chords || '').split('\n');
            const normTitle = song.title.trim().toLowerCase();
            let removed = 0;
            while (lines.length && removed < 2) {
                if (!lines[0] || lines[0].toLowerCase() === normTitle) {
                    lines.shift(); removed++;
                } else break;
            }

            const songNumber = this.currentPerformanceSongIndex + 1;
            const totalSongs = this.performanceSongs.length;
            this.performanceSongInfo.innerHTML = `
                <h2>${escapeHTML(song.title)}</h2>
                <div class="song-progress">(${songNumber} / ${totalSongs || 1})</div>
            `;

            // Render lines with optional chords
            this.lyricsDisplay.classList.toggle('show-chords', !!this.isChordsVisible);
            const renderTarget = this.lyricsContent || this.lyricsDisplay;
            if (!renderTarget) return;
            renderTarget.innerHTML = '';
            const frag = document.createDocumentFragment();
            let chordIdx = 0;
            for (let i = 0; i < lines.length; i++) {
                const lyricLine = lines[i];
                if (/^\s*\[[^\n\]]+\]\s*$/.test(lyricLine)) {
                    const el = document.createElement('div');
                    el.className = 'section-label';
                    el.textContent = lyricLine.trim();
                    frag.appendChild(el);
                    continue;
                }
                const lyricEl = document.createElement('div');
                lyricEl.className = 'lyric-line';
                lyricEl.textContent = lyricLine;
                if (this.isChordsVisible) {
                    const block = document.createElement('div');
                    block.className = 'lyric-block';
                    block.appendChild(lyricEl);
                    const chordText = chordsLines[chordIdx] || '';
                    if (chordText && chordText.trim()) {
                        const chordEl = document.createElement('div');
                        chordEl.className = 'chord-line';
                        chordEl.textContent = chordText;
                        block.appendChild(chordEl);
                    }
                    frag.appendChild(block);
                } else {
                    frag.appendChild(lyricEl);
                }
                chordIdx++;
            }
            renderTarget.appendChild(frag);
            const spacer = document.createElement('div');
            spacer.className = 'lyrics-tail-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            renderTarget.appendChild(spacer);
            this.applySlideTransition(direction);

            // Restore per-song font size if present, else use last-used or default
            let fs = this.perSongFontSizes[song.id];
            if (typeof fs !== 'number') {
                fs = this.fontSize || 32;
            }
            this.fontSize = fs;
            this.updateFontSize();

            // Restore per-song autoscroll speed if present
            if (song.id && typeof this.perSongAutoscrollSpeeds[song.id] !== 'undefined') {
                const perSongSpeed = Number(this.perSongAutoscrollSpeeds[song.id]);
                if (!Number.isNaN(perSongSpeed) && perSongSpeed > 0) {
                    this.autoScrollSpeed = perSongSpeed;
                } else {
                    this.autoScrollSpeed = this.defaultAutoScrollSpeed;
                }
            } else {
                this.autoScrollSpeed = this.defaultAutoScrollSpeed || this.autoScrollSpeed || 1;
            }
            if (this.autoscrollSpeedSlider) {
                this.autoscrollSpeedSlider.value = this.autoScrollSpeed;
            }
            if (this.autoscrollSpeedValue) {
                this.autoscrollSpeedValue.textContent = this.autoScrollSpeed;
            }

            this.stopAutoScroll();
            const shouldAutoStart = song.id && this.autoScrollOnStart[song.id];
            if (shouldAutoStart && this.canAutoScroll()) {
                this.startAutoScroll();
            } else if (shouldAutoStart) {
                const songId = song.id;
                setTimeout(() => {
                    if (!this.autoScrollOnStart[songId]) return;
                    if (this.autoScrollActive) return;
                    const activeSong = this.performanceSongs[this.currentPerformanceSongIndex];
                    if (!activeSong || activeSong.id !== songId) return;
                    if (this.canAutoScroll()) {
                        this.startAutoScroll();
                        this.updateAutoScrollButton();
                    }
                }, 250);
            }
            this.updateAutoScrollButton();
            this.autoScrollBtn?.blur();
        },

        // Font size methods
	adjustFontSize(amount) {
	    this.fontSize = Math.max(this.minFontSize, Math.min(this.maxFontSize, this.fontSize + amount));
	    this.updateFontSize();
	    // Save font size for this song
	    const song = this.performanceSongs[this.currentPerformanceSongIndex];
	    if (song && song.id) {
		this.perSongFontSizes[song.id] = this.fontSize;
		localStorage.setItem('perSongFontSizes', JSON.stringify(this.perSongFontSizes));
	    }
	},

        updateFontSize() {
            if (this.lyricsDisplay) {
                this.lyricsDisplay.style.fontSize = this.fontSize + 'px';
            }
            if (this.fontSizeDisplay) {
                this.fontSizeDisplay.textContent = `${Math.round(this.fontSize)}px`;
            }
            setTimeout(() => this.updateScrollButtonsVisibility(), 100);
        },

        // Navigate to next/previous song
        navigatePerformanceSong(direction, opts = {}) {
            const { silent = false } = opts || {};
            const newIndex = this.currentPerformanceSongIndex + direction;
            if (newIndex >= 0 && newIndex < this.performanceSongs.length) {
                this.currentPerformanceSongIndex = newIndex;
                this.displayCurrentPerformanceSong(direction);
                if (!silent) {
                    this.playTapFeedback('nav');
                }
                return true;
            }
            return false;
        },

        // Toggle theme
        handlePerformanceThemeToggle() {
            const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = next;
            localStorage.setItem('theme', next);
        },

        // Exit performance mode
        exitPerformanceMode() {
            const perf = {
                setlistId: this.performanceSetlistId || null,
                songIndex: this.currentPerformanceSongIndex,
                timestamp: Date.now()
            };
            localStorage.setItem('lastPerformance', JSON.stringify(perf));
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
            }
            window.location.href = '../index.html#performance';
        },

        // The rest: autoscroll, buttons, etc. are unchanged from your original

        startAutoScroll() {
            this.stopAutoScroll();
            const container = this.lyricsDisplay;
            if (!container) return;
            if (container.scrollHeight <= container.clientHeight) return;

            this.autoScrollActive = true;
            this.autoScrollDelayTimer = setTimeout(() => {
                this.autoScrollTimer = setInterval(() => {
                    if (!this.autoScrollActive) return;
                    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
                        this.stopAutoScroll();
                        return;
                    }
                    container.scrollTop += this.autoScrollSpeed;
                }, 50);
            }, this.autoscrollDelay * 1000);
        },

        stopAutoScroll() {
            this.autoScrollActive = false;
            if (this.autoScrollTimer) {
                clearInterval(this.autoScrollTimer);
                this.autoScrollTimer = null;
            }
            if (this.autoScrollDelayTimer) {
                clearTimeout(this.autoScrollDelayTimer);
                this.autoScrollDelayTimer = null;
            }
        },

        toggleAutoScroll() {
            // If content doesn't need scrolling, keep button visible but ignore action
            if (!this.canAutoScroll()) {
                try { showToast('Page fits on screen'); } catch {}
                return;
            }
            if (this.autoScrollActive) {
                this.stopAutoScroll();
            } else {
                this.startAutoScroll();
            }
            this.persistAutoScrollPreference();
            this.updateAutoScrollButton();
        },

        canAutoScroll() {
            const container = this.lyricsDisplay;
            if (!container) return false;
            return container.scrollHeight > (container.clientHeight + 2);
        },

        updateAutoScrollButton() {
            const btn = this.autoScrollBtn;
            if (!btn) return;
            btn.innerHTML = this.autoScrollActive
                ? '<i class="fas fa-pause"></i>'
                : '<i class="fas fa-angle-double-down"></i>';
            btn.title = this.autoScrollActive ? 'Pause Autoscroll' : 'Start Autoscroll';
        },

        updateScrollButtonsVisibility() {
            const container = this.lyricsDisplay;
            if (!container) return;
            const needsScroll = container.scrollHeight > container.clientHeight;
            const hasScrolled = container.scrollTop > 2;

            if (hasScrolled) {
                this.scrollToTopBtn.classList.remove('invisible');
            } else {
                this.scrollToTopBtn.classList.add('invisible');
            }

            // Always show the autoscroll button; disable if not needed
            this.autoScrollBtn.style.display = 'flex';
            if (!needsScroll) this.stopAutoScroll();
            this.autoScrollBtn.classList.toggle('disabled', !needsScroll);
        },

        updateScrollBtnVisibility() {
            this.updateScrollButtonsVisibility();
        }
    };

    // ==== SWIPE NAV ====
    (function setupSwipeNav() {
      const zone = document.getElementById('lyrics-display');
      if (!zone) return;
      let startX=0, startY=0, startTime=0, dragging=false, movedY=0, multiTouch=false, targetWasControl=false, horizontalSwipe=false;
      const MIN_X = 80; // px: require a more intentional swipe
      const MAX_ANGLE_TAN = Math.tan(35 * Math.PI / 180); // allow a slightly wider angle
      const MAX_DURATION = 800; // ms: allow slower swipes
      const MAX_PREF_SCROLL_Y = 30; // px: ignore if user scrolled vertically
      const EDGE_GUARD = 24; // px: ignore iOS left/right edge back/forward gesture
      function isControl(el) {
        return el.closest('.performance-controls, .font-fab, #font-controls, .auto-scroll-btn, .scroll-to-top-btn, .modal');
      }
      zone.addEventListener('touchstart', (e) => {
        if (app.isFontPanelOpen) return;
        if (e.touches.length !== 1) { multiTouch = true; dragging = false; return; }
        multiTouch = false;
        const t = e.touches[0];
        startX = t.clientX; startY = t.clientY; startTime = performance.now();
        dragging = true; movedY = 0; targetWasControl = !!isControl(e.target); horizontalSwipe = false;
        // Edge guard to avoid iOS back/forward swipe
        const w = window.innerWidth || document.documentElement.clientWidth;
        if (startX < EDGE_GUARD || startX > (w - EDGE_GUARD)) { dragging = false; }
      }, { passive: false });
      zone.addEventListener('touchmove', (e) => {
        if (app.isFontPanelOpen) return;
        if (e.touches.length !== 1) { multiTouch = true; dragging = false; return; }
        if (!dragging || multiTouch) return;
        const t = e.touches[0];
        movedY = Math.max(movedY, Math.abs(t.clientY - startY));
        const dx = t.clientX - startX; const dy = t.clientY - startY;
        // If movement is mostly horizontal, prevent default to avoid browser gestures/scroll conflict
        if (!horizontalSwipe && Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.15) {
          horizontalSwipe = true;
        }
        if (horizontalSwipe) {
          try { e.preventDefault(); } catch {}
        }
      }, { passive: false });
      zone.addEventListener('touchend', (e) => {
        if (app.isFontPanelOpen) { dragging = false; return; }
        if (multiTouch) { dragging = false; if (e.touches.length === 0) multiTouch = false; return; }
        if (!dragging) { dragging = false; return; }
        dragging = false; if (targetWasControl) return;
        const dt = performance.now() - startTime; if (dt > MAX_DURATION) return;
        const end = e.changedTouches[0]; const dx = end.clientX - startX; const dy = end.clientY - startY;
        if (Math.abs(dx) < MIN_X) return;
        if (Math.abs(dy) > Math.abs(dx) * MAX_ANGLE_TAN) return;
        if (movedY > MAX_PREF_SCROLL_Y) return;
        // Prevent accidental browser navigation
        try { e.preventDefault(); } catch {}
        if (dx < 0) { app.navigatePerformanceSong(1); } else { app.navigatePerformanceSong(-1); }
      }, { passive: false });
      zone.addEventListener('touchcancel', () => {
        dragging = false;
        multiTouch = false;
      }, { passive: true });
    })();

    // During performance mode, intercept back swipe/back button to avoid exiting unintentionally
    (function lockHistoryDuringPerformance(){
      try {
        if (window.history && window.history.pushState) {
          history.pushState({ pm: 1 }, '');
          window.addEventListener('popstate', () => {
            const overlay = document.getElementById('performance-mode');
            if (overlay) { history.pushState({ pm: 1 }, ''); }
          });
        }
      } catch {}
    })();

    app.init();
});
