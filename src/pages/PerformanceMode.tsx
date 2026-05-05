import { useEffect, useState, useRef, useMemo, type MouseEvent, type TouchEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Settings, ArrowLeft, Play, Pause, Sun, Moon, AArrowDown, AArrowUp, ListMusic, ChevronLeft, ChevronRight, Gauge, Music, ListOrdered, X, Minus, Plus, Sparkles, Mic, Search, PlusCircle } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import type { Song } from "../types";
import { cn } from "../lib/utils";
import { useTheme } from "../components/ThemeProvider";
import { motion, AnimatePresence } from "motion/react";

// Persistent Settings Management
const GLOBAL_PERF_SETTINGS = 'songbinder_global_perf_v2';
const RECENT_PERF_SETTINGS = 'songbinder_recent_perf_v2';

const getGlobalSettings = () => {
  const defaults = {
    lineHeight: 1.5,
    sectionSpacing: 2,
    isBold: false,
    textAlign: 'center' as 'left' | 'center'
  };
  try {
    const saved = localStorage.getItem(GLOBAL_PERF_SETTINGS);
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  } catch {
    return defaults;
  }
};

const getRecentFallback = () => {
  const defaults = {
    fontSize: 28,
    layoutMode: 'standard' as 'standard' | 'split',
    scrollSpeed: 1,
    autoScrollDelay: 3,
    fontFamily: 'sans' as 'sans' | 'serif' | 'mono'
  };
  try {
    const saved = localStorage.getItem(RECENT_PERF_SETTINGS);
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  } catch {
    return defaults;
  }
};

export default function PerformanceMode() {
  const { mode, id } = useParams();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  const [currentSongIndex, setCurrentSongIndex] = useState(() => {
    const saved = localStorage.getItem(`setlist_progress_${mode}_${id}`);
    return saved ? Math.max(0, parseInt(saved, 10)) : 0;
  });
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDelaying, setIsDelaying] = useState(false);
  
  // HUD and state that doesn't persist per song strictly but has fallback
  const [scrollSpeed, setScrollSpeed] = useState(() => getRecentFallback().scrollSpeed);
  const [fontSize, setFontSize] = useState(() => getRecentFallback().fontSize); 
  const [layoutMode, setLayoutMode] = useState<'standard' | 'split'>(() => getRecentFallback().layoutMode);
  const [autoScrollDelay, setAutoScrollDelay] = useState(() => getRecentFallback().autoScrollDelay);
  const [fontFamily, setFontFamily] = useState<'sans' | 'serif' | 'mono'>(() => getRecentFallback().fontFamily);

  // Global Settings (Always the same across all songs)
  const [textAlign, setTextAlign] = useState<'left' | 'center'>(() => getGlobalSettings().textAlign);
  const [lineHeight, setLineHeight] = useState(() => getGlobalSettings().lineHeight);
  const [sectionSpacing, setSectionSpacing] = useState(() => getGlobalSettings().sectionSpacing);
  const [isBold, setIsBold] = useState(() => getGlobalSettings().isBold);

  // Metronome state (not song specific but persistent in app session)
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [metronomeVolume, setMetronomeVolume] = useState(0.5);
  const [bpm, setBpm] = useState(120);

  const [showSettings, setShowSettings] = useState(false);
  const [showFontSizeControls, setShowFontSizeControls] = useState(false);
  const [showSections, setShowSections] = useState(false);
  const [showInsertModal, setShowInsertModal] = useState(false);
  const [manualInjections, setManualInjections] = useState<{ index: number, song: Song }[]>([]);
  const [voiceSearchQuery, setVoiceSearchQuery] = useState("");
  const [isListening, setIsListening] = useState(false);
  
  const contentRef = useRef<HTMLDivElement>(null);
  const fontSizeRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<number | null>(null);
  const touchEndRef = useRef<number | null>(null);

  const songRecord = useLiveQuery(() => mode === 'song' ? db.songs.get(id || "") : undefined, [mode, id]);
  const setlistRecord = useLiveQuery(() => mode === 'setlist' ? db.setlists.get(id || "") : undefined, [mode, id]);
  const allSongs = useLiveQuery(() => db.songs.toArray(), []);

  const playlist = useMemo(() => {
    const base: Song[] = [];
    if (mode === 'song' && songRecord) {
      base.push(songRecord);
    } else if (mode === 'setlist' && setlistRecord && allSongs) {
      setlistRecord.songIds.forEach(songId => {
        const s = allSongs.find(s => s.id === songId);
        if (s) base.push(s);
      });
    } else if (mode === 'library' && allSongs) {
      base.push(...[...allSongs].sort((a, b) => a.title.localeCompare(b.title)));
    }

    if (manualInjections.length === 0) return base;

    let result = [...base];
    [...manualInjections].sort((a, b) => b.index - a.index).forEach(inj => {
      result.splice(inj.index + 1, 0, inj.song);
    });
    return result;
  }, [mode, songRecord, setlistRecord, allSongs, manualInjections]);

  const currentSong = playlist[Math.min(currentSongIndex, Math.max(0, playlist.length - 1))] || playlist[0];

  useEffect(() => {
    if (playlist.length > 0) {
      if (currentSongIndex >= playlist.length) setCurrentSongIndex(playlist.length - 1);
      const storageKey = mode === 'library' ? 'setlist_progress_library' : `setlist_progress_${mode}_${id}`;
      localStorage.setItem(storageKey, currentSongIndex.toString());
    }
  }, [currentSongIndex, playlist.length, mode, id]);

  // Load song settings with global fallback logic
  useEffect(() => {
    if (currentSong) {
      const g = getGlobalSettings();
      const fallback = getRecentFallback();
      
      // Global keys are strictly from global store (all songs share them)
      setTextAlign(g.textAlign);
      setLineHeight(g.lineHeight);
      setSectionSpacing(g.sectionSpacing);
      setIsBold(g.isBold);

      // Song-specific keys with recent fallback
      const m = currentSong.metadata || {};
      setFontSize(m.fontSize ?? fallback.fontSize);
      setLayoutMode(m.layoutMode ?? fallback.layoutMode);
      setScrollSpeed(m.scrollSpeed ?? fallback.scrollSpeed);
      setAutoScrollDelay(m.autoScrollDelay ?? fallback.autoScrollDelay);
      setFontFamily(m.fontFamily ?? fallback.fontFamily);
      
      // Special case: Tempo
      if (m.tempo) setBpm(m.tempo); 
      else if (currentSong.bpm) setBpm(currentSong.bpm);
      else setBpm(120);

      setIsPlaying(false); // Reset playback on song change
    }
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [currentSong?.id]);

  // Metronome Sound Engine
  const audioContextRef = useRef<AudioContext | null>(null);
  const metronomeIntervalRef = useRef<any>(null);

  useEffect(() => {
    if (metronomeEnabled && isPlaying) {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      
      const interval = (60 / bpm) * 1000;
      let nextTickTime = audioContextRef.current.currentTime;

      const playTick = () => {
        if (!audioContextRef.current) return;
        const osc = audioContextRef.current.createOscillator();
        const envelope = audioContextRef.current.createGain();

        osc.frequency.value = 1000;
        osc.type = 'sine';

        envelope.gain.setValueAtTime(metronomeVolume, audioContextRef.current.currentTime);
        envelope.gain.exponentialRampToValueAtTime(0.001, audioContextRef.current.currentTime + 0.1);

        osc.connect(envelope);
        envelope.connect(audioContextRef.current.destination);

        osc.start();
        osc.stop(audioContextRef.current.currentTime + 0.1);
      };

      metronomeIntervalRef.current = setInterval(() => {
        playTick();
      }, interval);
    } else {
      if (metronomeIntervalRef.current) {
        clearInterval(metronomeIntervalRef.current);
      }
    }

    return () => {
      if (metronomeIntervalRef.current) {
        clearInterval(metronomeIntervalRef.current);
      }
    };
  }, [metronomeEnabled, isPlaying, bpm, metronomeVolume]);

  const toggleMetronome = () => {
    setMetronomeEnabled(!metronomeEnabled);
  };

  // Save changes logic
  const saveSetting = async (key: string, value: any) => {
    const globalKeys = ['lineHeight', 'sectionSpacing', 'isBold', 'textAlign'];
    
    // 1. Update State immediately
    switch (key) {
      case 'fontSize': setFontSize(value); break;
      case 'scrollSpeed': setScrollSpeed(value); break;
      case 'autoScrollDelay': setAutoScrollDelay(value); break;
      case 'textAlign': setTextAlign(value); break;
      case 'isBold': setIsBold(value); break;
      case 'fontFamily': setFontFamily(value); break;
      case 'lineHeight': setLineHeight(value); break;
      case 'sectionSpacing': setSectionSpacing(value); break;
      case 'layoutMode': setLayoutMode(value); break;
    }

    if (globalKeys.includes(key)) {
      // 2. Persistent across ALL songs
      const currentGlobals = getGlobalSettings();
      localStorage.setItem(GLOBAL_PERF_SETTINGS, JSON.stringify({ ...currentGlobals, [key]: value }));
    } else if (currentSong) {
      // 3. Persistent per song
      const latestSong = await db.songs.get(currentSong.id);
      if (latestSong) {
        await db.songs.update(currentSong.id, {
          metadata: { ...latestSong.metadata, [key]: value }
        });
      }
      
      // 4. Update the fallback for other songs (most recent)
      const currentFallback = getRecentFallback();
      localStorage.setItem(RECENT_PERF_SETTINGS, JSON.stringify({ ...currentFallback, [key]: value }));
    }
  };

  const handleFontSizeChange = (newSize: number) => {
    setFontSize(newSize);
    saveSetting('fontSize', newSize);
  };

  const handleInsertSong = (song: Song) => {
    setManualInjections(prev => [...prev, { index: currentSongIndex, song }]);
    setShowInsertModal(false);
    if ('vibrate' in navigator) navigator.vibrate([30, 30, 30]);
  };

  const startVoiceSearch = () => {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) return;
    
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setVoiceSearchQuery(transcript);
    };
    recognition.start();
  };

  const handleScrollSpeedChange = (newSpeed: number) => {
    setScrollSpeed(newSpeed);
    saveSetting('scrollSpeed', newSpeed);
  };

  const togglePlayback = () => {
    const newVal = !isPlaying;
    setIsPlaying(newVal);
    saveSetting('autoScroll', newVal);
    if ('vibrate' in navigator) navigator.vibrate(20);
  };

  const handleTouchStart = (e: TouchEvent) => {
    touchStartRef.current = e.targetTouches[0].clientX;
    touchEndRef.current = null;
  };

  const handleTouchMove = (e: TouchEvent) => {
    touchEndRef.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (touchStartRef.current === null || touchEndRef.current === null) return;
    const distance = touchStartRef.current - touchEndRef.current;
    
    if (distance > 60) {
      if (currentSongIndex < playlist.length - 1) {
        if ('vibrate' in navigator) navigator.vibrate(20);
        setCurrentSongIndex(i => i + 1);
        setIsPlaying(false);
        if(contentRef.current) contentRef.current.scrollTop = 0;
      }
    } else if (distance < -60) {
      if (currentSongIndex > 0) {
        if ('vibrate' in navigator) navigator.vibrate(20);
        setCurrentSongIndex(i => i - 1);
        setIsPlaying(false);
        if(contentRef.current) contentRef.current.scrollTop = 0;
      }
    }
  };

  const handleContentClick = (e: MouseEvent<HTMLDivElement>) => {
    // Top-level tap mostly toggles playback, but side taps can still navigate on desktop
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    
    // Tap zones: left 15% = prev, right 15% = next, center = toggle playback (only for larger screens or non-touch usually, but keeping it as fallback)
    if (x < width * 0.15) {
      if (currentSongIndex > 0) {
        if ('vibrate' in navigator) navigator.vibrate(20);
        setCurrentSongIndex(i => i - 1);
        setIsPlaying(false);
        if(contentRef.current) contentRef.current.scrollTop = 0;
      }
    } else if (x > width * 0.85) {
      if (currentSongIndex < playlist.length - 1) {
        if ('vibrate' in navigator) navigator.vibrate(20);
        setCurrentSongIndex(i => i + 1);
        setIsPlaying(false);
        if(contentRef.current) contentRef.current.scrollTop = 0;
      }
    } else {
      togglePlayback();
    }
  };

  // Keyboard shortcut bindings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (e.code === 'ArrowRight') {
        if (currentSongIndex < playlist.length - 1) {
          setCurrentSongIndex(i => i + 1);
        }
      } else if (e.code === 'ArrowLeft') {
        if (currentSongIndex > 0) {
          setCurrentSongIndex(i => i - 1);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, currentSongIndex, playlist.length]);

  const sections = useMemo(() => {
    if (!currentSong?.lyrics) return [];
    return currentSong.lyrics.split('\n').filter(line => line.trim().startsWith('[') && line.trim().endsWith(']'));
  }, [currentSong]);

  const firstLyricalSection = useMemo(() => {
    if (!currentSong?.lyrics) return null;
    // Split lyrics by section headers [Section]
    const parts = (currentSong.lyrics || '').split(/(\[.*?\])/);
    
    for (let i = 1; i < parts.length; i += 2) {
      const header = parts[i].trim();
      const nextContent = parts[i + 1] || "";
      const contentLines = nextContent.trim().split('\n').filter(l => l.trim().length > 0);
      
      // Heuristic for "real lyrics": has lines that are not just instrumental markers
      const hasActualLyrics = contentLines.some(line => {
        const lower = line.toLowerCase();
        return !lower.includes('instrumental') && !lower.includes('solo') && !lower.includes('pause');
      }) && contentLines.length > 0;

      const isIntro = header.toLowerCase().includes('intro');
      
      // Skip Intro if it has no actual lyrics
      if (isIntro && !hasActualLyrics) continue;
      
      if (hasActualLyrics) return header;
    }
    return null;
  }, [currentSong]);

  const cleanSectionLabel = (label: string): string | null => {
    const trimmed = label.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    const content = trimmed.slice(1, -1).trim();
    
    const sectionKeywords = [
      "intro", "verse", "pre-chorus", "prechorus", "chorus", "bridge", 
      "instrumental", "refrain", "reprise", "outro"
    ];

    for (const keyword of sectionKeywords) {
      const regex = new RegExp(`^(${keyword})\\b(?:\\s+([0-9]+|[a-zA-Z])\\b)?`, 'i');
      const match = content.match(regex);
      if (match) {
        let key = match[1].toLowerCase();
        if (key === 'prechorus') key = 'pre-chorus';
        key = key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
        
        const identifier = match[2] ? ` ${match[2].toUpperCase()}` : '';
        return `[${key}${identifier}]`;
      }
    }
    return null;
  };

  const isSectionLine = (line: string): boolean => cleanSectionLabel(line) !== null;


  const scrollToSection = (section: string) => {
    setShowSections(false);
    if (!contentRef.current) return;
    
    const elements = contentRef.current.querySelectorAll('[data-section]');
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].getAttribute('data-section') === section) {
        elements[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
    }
  };

  useEffect(() => {
    let timeout: any;
    if (isPlaying && autoScrollDelay > 0) {
      setIsDelaying(true);
      timeout = setTimeout(() => {
        setIsDelaying(false);
      }, autoScrollDelay * 1000);
    } else {
      setIsDelaying(false);
    }
    return () => clearTimeout(timeout);
  }, [isPlaying, autoScrollDelay, currentSongIndex]);

  useEffect(() => {
    if (!isPlaying || isDelaying || !contentRef.current) return;
    
    let animationFrameId: number;
    let lastTime = performance.now();
    
    const scroll = (time: number) => {
      const deltaTime = time - lastTime;
      if (deltaTime > 16) { 
        const element = contentRef.current;
        if (element) {
          element.scrollTop += Math.max(0, Math.pow(scrollSpeed, 1.5) * 0.02) * (deltaTime / 16);
        }
        lastTime = time;
      }
      animationFrameId = requestAnimationFrame(scroll);
    };
    
    animationFrameId = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying, isDelaying, scrollSpeed, currentSongIndex]);

  useEffect(() => {
    let wakeLock: any = null;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        console.warn(`${err}`);
      }
    };
    requestWakeLock();
    return () => {
      if (wakeLock !== null) wakeLock.release();
    };
  }, []);

  // Handle click outside for font size controls
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (fontSizeRef.current && !fontSizeRef.current.contains(event.target as Node)) {
        setShowFontSizeControls(false);
      }
    };

    if (showFontSizeControls) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [showFontSizeControls]);

  if (!currentSong) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg-primary">
        <motion.div 
          animate={{ opacity: [0.4, 1, 0.4] }} 
          transition={{ repeat: Infinity, duration: 2 }}
          className="text-gray-500 font-black uppercase tracking-[0.3em]"
        >
          Preparing Stage...
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-bg-primary transition-colors duration-500 overflow-hidden relative">
      {/* Visual Metronome Pulser */}
      {metronomeEnabled && isPlaying && (
        <div className="fixed top-0 left-0 w-full h-1 z-[60] pointer-events-none">
          <motion.div 
            animate={{ opacity: [1, 0], scaleX: [1, 1.1] }}
            transition={{ duration: 60 / bpm, repeat: Infinity, ease: "linear" }}
            className="w-full h-full bg-primary-accent shadow-[0_0_10px_rgba(34,197,94,0.5)]"
          />
        </div>
      )}

      {/* HUD Header */}
      <header className="flex-none p-2 md:p-4 flex items-center justify-between glass-morphism border-b border-white/5 z-50">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => {
              if (mode === 'song') navigate(`/song/${id}`);
              else if (mode === 'setlist') navigate(`/setlists/${id}`);
              else navigate('/');
            }}
            className="p-2 md:p-2.5 bg-bg-secondary border border-border rounded-xl text-gray-400 hover:text-white transition-all-custom shrink-0"
          >
            <ArrowLeft className="w-4 h-4 md:w-5 md:h-5 text-white" />
          </motion.button>
          
          <div className="min-w-0">
            <motion.h2 
              key={currentSong.id}
              initial={{ opacity: 0, x: -5 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-sm md:text-xl font-bold tracking-tight text-white leading-tight truncate pr-2"
            >
              {currentSong.title}
            </motion.h2>
            <div className="flex items-center gap-1.5 text-[8px] md:text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-0.5">
              <span className="text-primary-accent">{currentSongIndex + 1} / {playlist.length}</span>
              {firstLyricalSection && (
                <>
                  <span className="w-0.5 h-0.5 rounded-full bg-gray-700" />
                  <span className="text-white/40 italic">Starts: {cleanSectionLabel(firstLyricalSection) || firstLyricalSection}</span>
                </>
              )}
              {currentSong?.metadata?.key && (
                <>
                  <span className="w-0.5 h-0.5 rounded-full bg-gray-700" />
                  <span>{currentSong.metadata.key}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 md:gap-3 shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 mr-1">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowInsertModal(true)}
              className="p-2 bg-primary-accent/10 hover:bg-primary-accent/20 rounded-lg border border-primary-accent/20 text-primary-accent transition-all-custom flex items-center gap-2 px-3"
              title="Insert Song"
            >
              <PlusCircle className="w-4 h-4" />
              <span className="text-[9px] font-black uppercase tracking-wider hidden lg:inline">Insert</span>
            </motion.button>
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="p-2 bg-white/5 hover:bg-white/10 rounded-lg border border-white/5 text-gray-400 transition-all-custom"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setShowSections(true)}
              className="p-2 bg-white/5 hover:bg-white/10 rounded-lg border border-white/5 text-gray-400 transition-all-custom"
            >
              <ListOrdered className="w-4 h-4" />
            </button>
          </div>
          
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 md:p-2.5 bg-bg-secondary border border-border rounded-lg text-gray-400 hover:text-white transition-all-custom"
          >
            <Settings className="w-4 h-4 md:w-5 md:h-5" />
          </button>

          <motion.button 
            layoutId="playback-btn"
            whileTap={{ scale: 0.9 }}
            onClick={togglePlayback}
            className={cn(
              "w-9 h-9 md:w-11 md:h-11 rounded-lg transition-all-custom flex items-center justify-center shadow-elevation transform-gpu",
              isPlaying ? "bg-danger text-white shadow-danger/20" : "bg-primary-accent text-black shadow-primary-accent/20"
            )}
          >
            {isPlaying ? <Pause className="w-4 h-4 md:w-5 md:h-5" /> : <Play className="w-4 h-4 md:w-5 md:h-5 ml-0.5 fill-black" />}
          </motion.button>
        </div>
      </header>

      {/* Main Content */}
      <div 
        ref={contentRef}
        className="flex-1 overflow-y-auto px-3 md:px-12 custom-scrollbar relative"
        style={{ fontSize: `${fontSize}px` }}
        onClick={handleContentClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >

        <AnimatePresence mode="wait">
            <div className="flex-1 w-full bg-primary-accent/20 h-1 absolute top-0 left-0">
              <motion.div 
                className="h-full bg-primary-accent" 
                initial={{ width: 0 }}
                animate={{ width: isDelaying && autoScrollDelay > 0 ? '100%' : 0 }}
                transition={{ duration: isDelaying ? autoScrollDelay : 0, ease: "linear" }}
              />
            </div>
          <motion.div 
            key={currentSong.id}
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            transition={{ duration: 0.5, ease: "circOut" }}
            className={cn(
              "max-w-7xl mx-auto py-12 md:py-20 pb-[50vh]",
              textAlign === 'center' ? "text-center" : "text-left"
            )}
          >
            {/* Performance Notes Prompt */}
            {(currentSong.metadata?.performanceNotes || currentSong.metadata?.productionNotes) && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="mb-12 p-6 bg-primary-accent/5 border border-primary-accent/10 rounded-3xl max-w-2xl mx-auto text-center"
              >
                <div className="flex items-center justify-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-primary-accent animate-pulse" />
                  <span className="text-[11px] font-black uppercase tracking-[0.3em] text-primary-accent">Performance Notes</span>
                </div>
                <p className="text-sm md:text-base text-gray-300 font-medium italic leading-relaxed">
                  "{currentSong.metadata.performanceNotes || currentSong.metadata.productionNotes}"
                </p>
              </motion.div>
            )}

            {currentSong.lyrics ? (
              layoutMode === 'split' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-16">
                  {/* Lyrics Column Left */}
                  <div className="space-y-0.5">
                    <h4 className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500 mb-6 border-b border-white/5 pb-2">Lyrics Left</h4>
                    {(currentSong.lyrics || '').split('\n').filter((_, i) => i % 2 === 0).map((line, i) => {
                       const cleanedLabel = cleanSectionLabel(line);
                       const isSectionStr = cleanedLabel !== null;
                       const isRawBracketed = line.trim().startsWith('[') && line.trim().endsWith(']');
                       const lyricsLines = (currentSong.lyrics || '').split('\n');
                       const firstLyricalIdx = firstLyricalSection ? lyricsLines.findIndex(l => l.trim() === firstLyricalSection) : -1;
                       const shouldHideProductionNote = isRawBracketed && !isSectionStr && firstLyricalIdx !== -1 && i < firstLyricalIdx;

                       return (
                        <p 
                          key={i}
                          data-section={isSectionStr ? cleanedLabel : undefined}
                          className={cn(
                            "whitespace-pre-wrap leading-snug font-medium transition-colors min-h-[1.2em]",
                            shouldHideProductionNote && "hidden",
                            fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono-tech' : 'font-sans',
                            isBold && "font-bold",
                            isSectionStr 
                              ? cn(
                                  "text-primary-accent font-black tracking-[0.25em] uppercase font-mono-tech pt-3 pb-1.5 bg-primary-accent/5",
                                  textAlign === 'center' ? "rounded-xl px-4 inline-block" : "border-l-4 border-primary-accent/30 pl-4 rounded-r-xl block w-full"
                                )
                              : "text-white block w-full"
                          )}
                          style={{ 
                            fontSize: `${fontSize}px`, 
                            textAlign: textAlign,
                            marginTop: isSectionStr ? `${sectionSpacing * 2}rem` : '0',
                            marginBottom: isSectionStr ? `${sectionSpacing * 0.25}rem` : '0',
                            lineHeight: isSectionStr ? '1.2' : lineHeight
                          }}
                        >
                          {isSectionStr ? cleanedLabel : line}
                        </p>
                       );
                    })}
                  </div>
                  {/* Lyrics Column Right */}
                  <div className="space-y-0.5">
                    <h4 className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500 mb-6 border-b border-white/5 pb-2">Lyrics Right</h4>
                    {(currentSong.lyrics || '').split('\n').filter((_, i) => i % 2 !== 0).map((line, i) => {
                       const cleanedLabel = cleanSectionLabel(line);
                       const isSectionStr = cleanedLabel !== null;
                       const isRawBracketed = line.trim().startsWith('[') && line.trim().endsWith(']');
                       const lyricsLines = (currentSong.lyrics || '').split('\n');
                       const firstLyricalIdx = firstLyricalSection ? lyricsLines.findIndex(l => l.trim() === firstLyricalSection) : -1;
                       const shouldHideProductionNote = isRawBracketed && !isSectionStr && firstLyricalIdx !== -1 && i < firstLyricalIdx;

                       return (
                        <p 
                          key={i}
                          data-section={isSectionStr ? cleanedLabel : undefined}
                          className={cn(
                            "whitespace-pre-wrap leading-snug font-medium transition-colors min-h-[1.2em]",
                            shouldHideProductionNote && "hidden",
                            fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono-tech' : 'font-sans',
                            isBold && "font-bold",
                            isSectionStr 
                              ? cn(
                                  "text-primary-accent font-black tracking-[0.25em] uppercase font-mono-tech pt-3 pb-1.5 bg-primary-accent/5",
                                  textAlign === 'center' ? "rounded-xl px-4 inline-block" : "border-l-4 border-primary-accent/30 pl-4 rounded-r-xl block w-full"
                                )
                              : "text-white block w-full"
                          )}
                          style={{ 
                            fontSize: `${fontSize}px`, 
                            textAlign: textAlign,
                            marginTop: isSectionStr ? `${sectionSpacing * 2}rem` : '0',
                            marginBottom: isSectionStr ? `${sectionSpacing * 0.25}rem` : '0',
                            lineHeight: isSectionStr ? '1.2' : lineHeight
                          }}
                        >
                          {isSectionStr ? cleanedLabel : line}
                        </p>
                       );
                    })}
                  </div>
                </div>
              ) : (
                (currentSong.lyrics || '').split('\n').map((lLine, i) => {
                  const cleanedLabel = cleanSectionLabel(lLine);
                  const isSectionStr = cleanedLabel !== null;
                  const isRawBracketed = lLine.trim().startsWith('[') && lLine.trim().endsWith(']');
                  
                  // Hide unrecognized bracketed text before the first lyrical section
                  const lyricsLines = (currentSong.lyrics || '').split('\n');
                  const firstLyricalIdx = firstLyricalSection ? lyricsLines.findIndex(l => l.trim() === firstLyricalSection) : -1;
                  const shouldHideProductionNote = isRawBracketed && !isSectionStr && firstLyricalIdx !== -1 && i < firstLyricalIdx;

                  return (
                    <div key={i} className={cn("pt-0 pb-1", shouldHideProductionNote && "hidden")}>
                      {lLine && (
                        <p 
                          data-section={isSectionStr ? cleanedLabel : undefined}
                          className={cn(
                            "whitespace-pre-wrap leading-snug font-medium transition-colors",
                            fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono-tech' : 'font-sans',
                            isBold && "font-bold",
                            isSectionStr 
                              ? cn(
                                  "text-primary-accent font-black tracking-[0.25em] uppercase font-mono-tech pt-3 pb-1.5 bg-primary-accent/5",
                                  textAlign === 'center' ? "rounded-xl px-4 inline-block" : "border-l-4 border-primary-accent pl-4 rounded-r-xl block w-full"
                                )
                              : "text-white block w-full"
                          )}
                          style={{ 
                            fontSize: `${fontSize}px`, 
                            textAlign: textAlign,
                            marginTop: isSectionStr ? `${sectionSpacing * 2}rem` : '0',
                            marginBottom: isSectionStr ? `${sectionSpacing * 0.25}rem` : '0',
                            lineHeight: isSectionStr ? '1.2' : lineHeight
                          }}
                        >
                          {isSectionStr ? cleanedLabel : lLine}
                        </p>
                      )}
                    </div>
                  );
                })
              )
            ) : (
              <div className="flex flex-col items-center justify-center py-32 text-gray-500 opacity-50">
                <p className="font-black uppercase tracking-[0.3em]">No Lyrics Available</p>
                <p className="text-sm mt-4 font-bold">Please add lyrics in the song editor to perform.</p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Floating UI Elements */}
      <div className="fixed left-4 top-1/2 -translate-y-1/2 z-40 pointer-events-none hidden md:block">
        <motion.button 
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          disabled={currentSongIndex === 0}
          onClick={(e) => { e.stopPropagation(); if('vibrate' in navigator) navigator.vibrate(20); setCurrentSongIndex(i => i - 1); setIsPlaying(false); if(contentRef.current) contentRef.current.scrollTop = 0; }}
          className="w-12 h-12 flex items-center justify-center bg-bg-secondary/80 backdrop-blur-md border border-border hover:bg-bg-tertiary rounded-full disabled:opacity-0 transition-opacity pointer-events-auto text-gray-400 hover:text-white shadow-lg"
        >
          <ChevronLeft className="w-6 h-6 pr-1" />
        </motion.button>
      </div>

      <div className="fixed right-4 top-1/2 -translate-y-1/2 z-40 pointer-events-none hidden md:block">
        <motion.button 
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          disabled={currentSongIndex === playlist.length - 1}
          onClick={(e) => { e.stopPropagation(); if('vibrate' in navigator) navigator.vibrate(20); setCurrentSongIndex(i => i + 1); setIsPlaying(false); if(contentRef.current) contentRef.current.scrollTop = 0; }}
          className="w-12 h-12 flex items-center justify-center bg-bg-secondary/80 backdrop-blur-md border border-border hover:bg-bg-tertiary rounded-full disabled:opacity-0 transition-opacity pointer-events-auto text-gray-400 hover:text-white shadow-lg"
        >
          <ChevronRight className="w-6 h-6 pl-1" />
        </motion.button>
      </div>


      <AnimatePresence>
        {showInsertModal && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowInsertModal(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ scale: 0.9, y: 20, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, y: 20, opacity: 0 }}
              className="relative bg-bg-secondary border border-border w-full max-w-lg rounded-[2.5rem] p-6 shadow-elevation overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-black text-xl tracking-tight text-white flex items-center gap-3">
                  <PlusCircle className="w-6 h-6 text-primary-accent" /> Insert <span className="text-primary-accent">Song</span>
                </h3>
                <button onClick={() => setShowInsertModal(false)} className="bg-bg-tertiary p-2 rounded-xl text-gray-500 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="relative mb-6">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
                <input 
                  type="text" 
                  placeholder="Search library..." 
                  value={voiceSearchQuery}
                  onChange={(e) => setVoiceSearchQuery(e.target.value)}
                  className="w-full bg-bg-tertiary text-white rounded-2xl pl-12 pr-12 py-3.5 border border-border focus:border-primary-accent focus:outline-none transition-all-custom text-base shadow-inner"
                  autoFocus
                />
                <button 
                  onClick={startVoiceSearch}
                  className={cn(
                    "absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-xl transition-all-custom",
                    isListening ? "bg-danger text-white animate-pulse" : "bg-bg-quaternary text-gray-400 hover:text-white"
                  )}
                >
                  <Mic className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-2">
                {allSongs?.filter(s => 
                  s.title.toLowerCase().includes(voiceSearchQuery.toLowerCase())
                ).map(song => (
                  <motion.button
                    key={song.id}
                    whileHover={{ x: 5 }}
                    onClick={() => handleInsertSong(song)}
                    className="w-full text-left px-5 py-4 bg-bg-tertiary hover:bg-bg-quaternary border border-border/50 rounded-2xl flex items-center justify-between group transition-all-custom"
                  >
                    <div>
                      <h4 className="text-white font-bold text-base group-hover:text-primary-accent transition-colors">{song.title}</h4>
                    </div>
                    <Plus className="w-5 h-5 text-gray-600 group-hover:text-primary-accent transition-colors" />
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Sections Jump Menu Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative bg-bg-secondary border border-border w-full max-w-md rounded-[2rem] p-6 shadow-elevation overflow-hidden"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-black text-xl tracking-tight text-white flex items-center gap-2">
                  <Settings className="w-6 h-6 text-primary-accent" /> Settings
                </h3>
                <button onClick={() => setShowSettings(false)} className="bg-bg-tertiary p-2 rounded-full text-gray-500 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase text-gray-500 tracking-wider">Scroll Delay</label>
                    <div className="flex items-center gap-4 bg-bg-tertiary p-3 rounded-xl border border-border">
                      <input 
                        type="range" min="0" max="60" step="1" 
                        value={autoScrollDelay} 
                        onChange={(e) => {
                          setAutoScrollDelay(Number(e.target.value));
                          saveSetting('autoScrollDelay', Number(e.target.value));
                        }} 
                        className="flex-1 accent-primary-accent"
                      />
                      <span className="text-xs font-bold text-white min-w-[20px]">{autoScrollDelay}s</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase text-gray-500 tracking-wider">Scroll Speed</label>
                    <div className="flex items-center gap-4 bg-bg-tertiary p-3 rounded-xl border border-border">
                      <input 
                        type="range" min="1" max="25" step="1" 
                        value={scrollSpeed} 
                        onChange={(e) => handleScrollSpeedChange(Number(e.target.value))} 
                        className="flex-1 accent-primary-accent"
                      />
                      <span className="text-xs font-bold text-white min-w-[20px]">{scrollSpeed}</span>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-white/5 space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-gray-500 tracking-wider">Alignment</label>
                      <div className="flex p-1 bg-bg-tertiary rounded-xl border border-border">
                        <button onClick={() => saveSetting('textAlign', 'left')} className={cn("flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all", textAlign === 'left' ? "bg-bg-quaternary text-white shadow-sm" : "text-gray-500")}>Left</button>
                        <button onClick={() => saveSetting('textAlign', 'center')} className={cn("flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all", textAlign === 'center' ? "bg-bg-quaternary text-white shadow-sm" : "text-gray-500")}>Center</button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-gray-500 tracking-wider">Weight</label>
                      <button onClick={() => saveSetting('isBold', !isBold)} className={cn("w-full py-2 rounded-xl text-[10px] font-black border transition-all", isBold ? "bg-primary-accent border-primary-accent text-black" : "bg-bg-tertiary border-border text-gray-500")}>{isBold ? 'BOLD' : 'NORMAL'}</button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase text-gray-500 tracking-wider">Font Family</label>
                    <div className="flex p-1 bg-bg-tertiary rounded-xl border border-border">
                      {['sans', 'serif', 'mono'].map((f) => (
                        <button key={f} onClick={() => saveSetting('fontFamily', f)} className={cn("flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all capitalize", fontFamily === f ? "bg-bg-quaternary text-white shadow-sm" : "text-gray-500")}>{f}</button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-gray-500 tracking-wider">Line Height: {lineHeight.toFixed(1)}</label>
                      <input type="range" min="1" max="2.5" step="0.1" value={lineHeight} onChange={(e) => saveSetting('lineHeight', parseFloat(e.target.value))} className="w-full h-1.5 bg-bg-tertiary rounded-lg appearance-none cursor-pointer accent-primary-accent" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-gray-500 tracking-wider">Section Gaps: {sectionSpacing.toFixed(1)}</label>
                      <input type="range" min="0.5" max="4" step="0.5" value={sectionSpacing} onChange={(e) => saveSetting('sectionSpacing', parseFloat(e.target.value))} className="w-full h-1.5 bg-bg-tertiary rounded-lg appearance-none cursor-pointer accent-primary-accent" />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-black uppercase text-gray-400 mb-2 block tracking-wider">Layout</label>
                    <div className="flex bg-bg-tertiary rounded-xl p-1 border border-border">
                      <button 
                        onClick={() => { setLayoutMode('standard'); saveSetting('layoutMode', 'standard'); }} 
                        className={cn("flex-1 text-[10px] font-bold py-2 rounded-lg transition-colors", layoutMode === 'standard' ? "bg-white/10 text-white" : "text-gray-500")}
                      >
                        Standard
                      </button>
                      <button 
                        onClick={() => { setLayoutMode('split'); saveSetting('layoutMode', 'split'); }} 
                        className={cn("flex-1 text-[10px] font-bold py-2 rounded-lg transition-colors", layoutMode === 'split' ? "bg-white/10 text-white" : "text-gray-500")}
                      >
                        Split
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-black uppercase text-gray-400 mb-2 block tracking-wider">Metronome</label>
                    <button 
                      onClick={toggleMetronome}
                      className={cn(
                        "w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-colors border",
                        metronomeEnabled ? "bg-primary-accent/10 border-primary-accent text-primary-accent" : "bg-bg-tertiary border-border text-gray-400"
                      )}
                    >
                      <Gauge className="w-3.5 h-3.5" />
                      {metronomeEnabled ? "Active" : "Disabled"}
                    </button>
                  </div>
                </div>

                {metronomeEnabled && (
                  <div>
                    <label className="text-xs font-black uppercase text-gray-400 mb-2 block tracking-wider">BPM: {bpm}</label>
                    <div className="flex items-center gap-4 bg-bg-tertiary p-3 rounded-xl border border-border">
                      <input 
                        type="range" min="40" max="250" step="1" 
                        value={bpm} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setBpm(val);
                          db.songs.update(currentSong.id, { 
                            metadata: { ...currentSong.metadata, tempo: val }
                          });
                        }} 
                        className="flex-1 accent-primary-accent h-1.5 rounded-lg cursor-pointer bg-white/10 appearance-none"
                      />
                      <input 
                        type="number"
                        value={bpm}
                        onChange={(e) => {
                          const val = Math.min(250, Math.max(40, Number(e.target.value)));
                          setBpm(val);
                          db.songs.update(currentSong.id, { 
                            metadata: { ...currentSong.metadata, tempo: val }
                          });
                        }}
                        className="w-16 bg-transparent text-right font-mono-tech text-white font-bold text-sm focus:outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end pt-6 mt-2">
                 <button onClick={() => setShowSettings(false)} className="bg-primary-accent text-black hover:opacity-90 px-6 py-3 rounded-xl font-black transition-all-custom w-full sm:w-auto">Save & Close</button>
              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSections && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSections(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative bg-bg-secondary border border-border w-full max-w-sm rounded-[2rem] p-6 shadow-elevation overflow-hidden"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-black uppercase tracking-widest text-primary-accent flex items-center gap-2">
                  <ListOrdered className="w-5 h-5" /> Jump to Section
                </h3>
                <button onClick={() => setShowSections(false)} className="text-gray-500 hover:text-white transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="max-h-[60vh] overflow-y-auto custom-scrollbar space-y-2 pr-2">
                {sections.length > 0 ? (
                  sections.map((sec, i) => (
                    <button
                      key={i}
                      onClick={() => scrollToSection(sec)}
                      className="w-full text-left px-5 py-3 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl font-bold font-mono-tech text-white transition-all-custom"
                    >
                      {cleanSectionLabel(sec)}
                    </button>
                  ))
                ) : (
                  <div className="text-center py-10 opacity-50 font-bold uppercase tracking-widest text-xs">
                    No [Section] markers found
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Persistent Floating Font Size Tool */}
      <div className="fixed inset-x-0 top-14 md:top-20 flex justify-center z-[9999] pointer-events-none">
        <div ref={fontSizeRef} className="pointer-events-auto">
          <AnimatePresence mode="wait">
            {!showFontSizeControls ? (
              <motion.button
                key="trigger"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowFontSizeControls(!showFontSizeControls)}
                className="w-12 h-12 flex items-center justify-center bg-primary-accent text-black backdrop-blur-md border border-white/10 rounded-full shadow-elevation hover:bg-opacity-90 transition-colors group relative"
              >
                 <span className="font-bold text-lg group-hover:scale-110 transition-transform">Tt</span>
              </motion.button>
            ) : (
              <motion.div
                key="controls"
                initial={{ opacity: 0, scale: 0.9, y: -20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -20 }}
                className="flex items-center justify-between w-[150px] h-[40px] bg-primary-accent rounded-full p-1 shadow-elevation border border-primary-accent/30"
              >
                <button 
                  className="p-2 text-black/60 hover:text-black rounded-full hover:bg-black/10 transition-colors" 
                  onClick={() => handleFontSizeChange(Math.max(6, fontSize - 2))}
                >
                  <Minus className="w-4.5 h-4.5 stroke-[4px]" />
                </button>
                
                <div className="text-black font-black font-mono-tech text-sm min-w-[2.5rem] text-center">
                  {fontSize}
                </div>

                <button 
                  className="p-2 text-black/60 hover:text-black rounded-full hover:bg-black/10 transition-colors" 
                  onClick={() => handleFontSizeChange(Math.min(96, fontSize + 2))}
                >
                  <Plus className="w-4.5 h-4.5 stroke-[4px]" />
                </button>
                <button 
                  onClick={() => setShowFontSizeControls(false)}
                  className="p-1 text-black/40 hover:text-black absolute -top-8 left-1/2 -translate-x-1/2 bg-white/20 backdrop-blur-sm rounded-full pointer-events-auto"
                >
                   <X className="w-4 h-4" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
