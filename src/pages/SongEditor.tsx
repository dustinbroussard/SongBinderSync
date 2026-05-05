import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Play, Sparkles, X, Loader2, Mic, Settings, ChevronRight, CheckCircle2, Sun, Moon, Minus, Plus, ListMusic } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { cn } from "../lib/utils";
import { GoogleGenAI } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { normalizeLyricsBlock, normalizeSectionLabels, normalizeSmartQuotes, cleanAIOutput, extractPerformanceNotes } from "../lib/normalization";
import { useTheme } from "../components/ThemeProvider";
import { useSetlists } from "../hooks/useSetlists";

import PerformancePreview from "../components/PerformancePreview";

type EditMode = 'lyrics' | 'preview';

// Syllable counting heuristic
function getSyllablesCount(text: string) {
  if (!text.trim()) return 0;
  // Check if it's a section label - don't count syllables for these
  if (text.trim().startsWith('[') && text.trim().endsWith(']')) return 0;

  const words = text.toLowerCase()
    .replace(/[^a-z ]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0);
  
  if (words.length === 0) return 0;
  
  return words.reduce((acc, word) => {
    if (word.length <= 2) return acc + 1;
    // Basic heuristic: count vowel clusters
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    word = word.replace(/^y/, '');
    const res = word.match(/[aeiouy]{1,2}/g);
    return acc + (res ? Math.max(1, res.length) : 1);
  }, 0);
}

export default function SongEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const song = useLiveQuery(() => db.songs.get(id || ""), [id]);
  const { theme, setTheme } = useTheme();
  const { setlists } = useSetlists();

  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [performanceNotes, setPerformanceNotes] = useState("");
  const [mode, setMode] = useState<EditMode>('lyrics');
  const [isSaving, setIsSaving] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [showFontSizeControls, setShowFontSizeControls] = useState(false);
  const [showSetlistModal, setShowSetlistModal] = useState(false);
  const [showMobileSettings, setShowMobileSettings] = useState(false);
  const [editorFontSize, setEditorFontSize] = useState(() => {
    const saved = localStorage.getItem('editor_font_size');
    return saved ? parseInt(saved, 10) : 24;
  });
  const [advancedMode, setAdvancedMode] = useState(() => {
    const saved = localStorage.getItem('editor_advanced_mode');
    return saved === 'true';
  });

  const toggleAdvancedMode = () => {
    const newVal = !advancedMode;
    setAdvancedMode(newVal);
    localStorage.setItem('editor_advanced_mode', newVal.toString());
  };

  const fontSizeRef = useRef<HTMLDivElement>(null);
  const lyricsEditorRef = useRef<HTMLTextAreaElement>(null);
  const lyricsBgRef = useRef<HTMLDivElement>(null);

  const handleLyricsScroll = () => {
    if (lyricsEditorRef.current && lyricsBgRef.current) {
      lyricsBgRef.current.scrollTop = lyricsEditorRef.current.scrollTop;
    }
  };

  // Handle click outside for font size controls
  useEffect(() => {
    const handleClickOutside = (event: globalThis.MouseEvent | globalThis.TouchEvent) => {
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

  const handleFontSizeChange = (newSize: number) => {
    setEditorFontSize(newSize);
    localStorage.setItem('editor_font_size', newSize.toString());
  };

  // AI Assistant state
  const [showAIModal, setShowAIModal] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResult, setAiResult] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiTargetSection, setAiTargetSection] = useState("");
  const [aiActionType, setAiActionType] = useState<'generate' | 'rephrase'>('generate');

  useEffect(() => {
    if (song) {
      setTitle(song.title);
      setLyrics(song.lyrics);
      setPerformanceNotes(song.metadata?.performanceNotes || song.metadata?.productionNotes || "");
    }
  }, [song]);

  const handleSave = async () => {
    if (!song) return;
    setIsSaving(true);
    
    // Normalize content
    let processedLyrics = normalizeSmartQuotes(lyrics);
    const { cleanedText: lyricsWithoutNotes, performanceNotes: extractedNotes } = extractPerformanceNotes(processedLyrics);
    processedLyrics = normalizeSectionLabels(normalizeLyricsBlock(lyricsWithoutNotes, title));

    // Merge notes
    let finalNotes = performanceNotes;
    if (extractedNotes) {
      const existingNotesList = performanceNotes.split(';').map(n => n.trim()).filter(Boolean);
      const newNotesList = extractedNotes.split(';').map(n => n.trim()).filter(Boolean);
      const mergedNotes = Array.from(new Set([...existingNotesList, ...newNotesList]));
      finalNotes = mergedNotes.join('; ');
    }

    const updatedMetadata = {
      ...song.metadata,
      performanceNotes: finalNotes
    };

    await db.songs.update(song.id, {
      title,
      lyrics: processedLyrics,
      metadata: updatedMetadata,
      updatedAt: Date.now()
    });
    
    // Ensure state reflects normalized version
    if (lyrics !== processedLyrics) setLyrics(processedLyrics);
    if (performanceNotes !== finalNotes) setPerformanceNotes(finalNotes);

    setIsSaving(false);
    setShowStatus(true);
    setTimeout(() => setShowStatus(false), 2000);
  };

  useEffect(() => {
    if (!song) return;
    const timeout = setTimeout(() => {
      if (title !== song.title || lyrics !== song.lyrics || performanceNotes !== (song.metadata?.performanceNotes || song.metadata?.productionNotes || "")) {
        handleSave();
      }
    }, 1500);
    return () => clearTimeout(timeout);
  }, [title, lyrics, performanceNotes, song]);

  const askAI = async () => {
    if (!aiPrompt.trim()) return;
    setIsAiLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `Act as an expert songwriter.
      Current Mode: ${mode}
      Song Title: ${title}
      Current Lyrics: ${lyrics}
      
      Target Section: ${aiTargetSection || 'General/New Section'}
      Action Type: ${aiActionType === 'rephrase' ? 'REPHRASE/ALTERNATIVES for the existing section' : 'GENERATE NEW CONTENT'}
      
      User Request/Style: ${aiPrompt}
      
      If Action Type is REPHRASE:
      Focus on providing 3-4 creative alternatives or a polished version of the target section within the existing context.
      
      If Action Type is GENERATE:
      Create a new section that fits the flow of the current song.
      
      Return ONLY the requested content (lyrics) without any conversational filler or "Here is your content" preambles.`;
      
      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });
      
      setAiResult(cleanAIOutput(response.text || ""));
    } catch (err) {
      console.error(err);
      setAiResult("Failed to contact AI Assistant.");
    }
    setIsAiLoading(false);
  };

  const toggleSetlistMembership = async (setlistId: string) => {
    if (!song) return;
    const setlist = await db.setlists.get(setlistId);
    if (!setlist) return;

    const isMember = setlist.songIds.includes(song.id);
    const newSongIds = isMember 
      ? setlist.songIds.filter(sid => sid !== song.id)
      : [...setlist.songIds, song.id];

    await db.setlists.update(setlistId, {
      songIds: newSongIds,
      updatedAt: Date.now()
    });
  };

  const approveAIResult = () => {
    if (mode === 'lyrics') {
      setLyrics(prev => prev + '\n' + aiResult);
    }
    setShowAIModal(false);
    setAiPrompt("");
    setAiResult("");
  };

  const rejectAIResult = () => {
    setAiResult("");
  };

  const startDictation = () => {
    const SpeechRecognitionInfo = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionInfo) return;
    
    const recognition = new SpeechRecognitionInfo();
    recognition.lang = 'en-US';
    recognition.start();
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      if (mode === 'lyrics') setLyrics(prev => prev + '\n' + transcript);
    };
  };

  const songSettingsPanelNode = !song ? null : (
      <div className="space-y-6">
        <div className="bg-bg-secondary border border-border p-4 rounded-2xl shadow-soft">
          <label className="text-[9px] font-bold uppercase tracking-widest text-primary-accent mb-2 block">Key & Tempo</label>
          <div className="grid grid-cols-2 gap-4">
            <input 
              placeholder="Key" 
              value={song.metadata?.key || ""}
              onChange={(e) => {
                db.songs.update(song.id, {
                  metadata: { ...song.metadata, key: e.target.value }
                });
              }}
              className="bg-bg-primary border border-border rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-accent transition-colors" 
            />
            <input 
              placeholder="BPM" 
              type="number"
              value={song.metadata?.tempo || ""}
              onChange={(e) => {
                db.songs.update(song.id, {
                  metadata: { ...song.metadata, tempo: Number(e.target.value) }
                });
              }}
              className="bg-bg-primary border border-border rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-accent transition-colors" 
            />
          </div>
        </div>

        <div className="bg-bg-secondary border border-border p-4 rounded-2xl shadow-soft">
          <label className="text-[9px] font-bold uppercase tracking-widest text-primary-accent mb-2 block">Editor Preferences</label>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Advanced Mode</span>
              <button 
                onClick={toggleAdvancedMode}
                className={cn(
                    "w-10 h-5 rounded-full transition-all-custom relative",
                    advancedMode ? "bg-primary-accent" : "bg-bg-tertiary"
                )}
              >
                <div className={cn(
                    "absolute top-1 w-3 h-3 rounded-full bg-white transition-all-custom",
                    advancedMode ? "right-1" : "left-1"
                )} />
              </button>
            </div>
          </div>
        </div>

        <div className="bg-bg-secondary border border-border p-4 rounded-2xl shadow-soft">
          <label className="text-[9px] font-bold uppercase tracking-widest text-primary-accent mb-2 block">Setlist Management</label>
          <button 
            onClick={() => setShowSetlistModal(true)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-bg-primary hover:bg-bg-tertiary border border-border rounded-xl transition-all-custom group"
          >
            <div className="flex items-center gap-2">
              <ListMusic className="w-4 h-4 text-gray-400 group-hover:text-primary-accent transition-colors" />
              <span className="text-xs text-gray-400 group-hover:text-white transition-colors">Add to Setlist</span>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-gray-600 group-hover:text-primary-accent transition-colors" />
          </button>
        </div>

        <div className="bg-bg-secondary border border-border p-4 rounded-2xl shadow-soft">
          <label className="text-[9px] font-bold uppercase tracking-widest text-primary-accent mb-2 block">Performance Defaults</label>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Auto-Scroll</span>
              <button 
                onClick={() => {
                    const newVal = !(song.metadata?.autoScroll ?? false);
                    db.songs.update(song.id, {
                        metadata: { ...song.metadata, autoScroll: newVal }
                    });
                }}
                className={cn(
                    "w-10 h-5 rounded-full transition-all-custom relative",
                    song.metadata?.autoScroll ? "bg-primary-accent" : "bg-bg-tertiary"
                )}
              >
                <div className={cn(
                    "absolute top-1 w-3 h-3 rounded-full bg-white transition-all-custom",
                    song.metadata?.autoScroll ? "right-1" : "left-1"
                )} />
              </button>
            </div>
          </div>
        </div>

        <div className="bg-bg-secondary border border-border p-4 rounded-2xl shadow-soft">
          <label className="text-[9px] font-bold uppercase tracking-widest text-primary-accent mb-2 block">Performance Notes</label>
          <textarea 
            placeholder="Style, mood, synth patches..." 
            value={performanceNotes}
            onChange={(e) => setPerformanceNotes(e.target.value)}
            className="w-full bg-bg-primary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-primary-accent transition-colors resize-none h-24 custom-scrollbar" 
          />
        </div>

        <div className="bg-bg-secondary border border-border p-4 rounded-2xl shadow-soft">
          <div className="space-y-3">
            <div className="py-2 border-b border-white/5 flex items-center justify-between text-[11px]">
              <span className="text-gray-400">Current Revision</span>
              <span className="text-gray-600 font-mono">v1.2</span>
            </div>
            <div className="py-1 flex items-center gap-2 text-gray-600 text-[11px] cursor-not-allowed italic">
              <ChevronRight className="w-3 h-3" /> No prior versions
            </div>
          </div>
        </div>
        
        <div className="bg-primary-accent/5 border border-primary-accent/10 p-5 rounded-2xl">
          <p className="text-xs text-primary-accent/70 font-medium leading-relaxed italic">
            "Songwriting is about finding the space between the words."
          </p>
        </div>
      </div>
  );

  if (!song) return (
    <div className="flex items-center justify-center h-screen">
      <motion.div animate={{ opacity: [0.4, 1, 0.4] }} className="text-gray-500 font-black uppercase tracking-widest">Opening Notebook...</motion.div>
    </div>
  );

  const isAnyModalOpen = showAIModal || showMobileSettings || showSetlistModal;

  return (
    <div className="flex flex-col h-screen w-full bg-bg-primary overflow-hidden">
      {/* Header */}
      <header className="flex-none px-4 md:px-6 py-3 md:py-4 flex items-center justify-between glass-morphism border-b border-white/5 z-20">
        <div className="flex items-center gap-3 md:gap-4 flex-1 min-w-0">
          <motion.button 
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => navigate('/')}
            className="p-2 md:p-3 bg-bg-secondary border border-border rounded-xl text-gray-400 hover:text-white transition-all-custom shadow-soft"
          >
            <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
          </motion.button>
          <div className="flex flex-col flex-1 min-w-0">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-transparent text-sm md:text-base leading-6 font-bold tracking-tight border-b-2 border-transparent hover:border-primary-accent/30 focus:border-primary-accent focus:outline-none transition-all-custom py-0.5 truncate w-full max-w-xl"
              placeholder="Untitled Masterpiece"
            />
            <AnimatePresence>
              {showStatus && (
                <motion.div 
                  initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="flex items-center gap-1 text-[8px] md:text-[9px] font-black uppercase tracking-widest text-secondary-text mt-0.5"
                >
                  <CheckCircle2 className="w-2.5 h-2.5" /> Auto-Saved
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        
        <div className="flex items-center gap-2 md:gap-3 ml-2 shrink-0">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-2 md:p-3 bg-bg-secondary border border-border rounded-xl text-gray-400 hover:text-white transition-all-custom shadow-soft flex items-center justify-center shrink-0"
            title="Toggle Theme"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </motion.button>
          
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate(`/performance/song/${song.id}`)}
            className="group flex items-center justify-center gap-2 px-3 py-1 bg-primary-accent text-black font-black uppercase tracking-widest text-[9px] md:text-[10px] rounded-xl hover:bg-opacity-90 shadow-lg shadow-primary-accent/20 transition-all-custom"
          >
            <Play className="w-4 h-4 fill-black group-hover:scale-110 transition-transform" />
            <span className="hidden sm:inline">Perform</span>
          </motion.button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden lg:flex-row flex-col">
        {/* Editor Main Section */}
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Subtle Controls */}
          <div className="flex flex-none h-[60px] md:h-[70px] px-4 md:px-6 border-b border-border bg-bg-secondary/30 items-center justify-between gap-3 overflow-x-auto no-scrollbar">
            <div className="flex items-center justify-center gap-1 bg-bg-primary/50 p-1 rounded-xl border border-border shrink-0">
              {(['lyrics', 'preview'] as EditMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    "px-3 md:px-4 py-1.5 md:py-2 rounded-lg text-[9px] md:text-[10px] font-black uppercase tracking-widest transition-all-custom",
                    mode === m ? "bg-white text-black shadow-soft" : "text-gray-500 hover:text-white"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            
            <div className="flex items-center gap-2 shrink-0">
              {advancedMode && (
                <>
                  <motion.button 
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => setShowAIModal(true)}
                    className="p-2.5 text-primary-accent bg-primary-accent/10 hover:bg-primary-accent/20 rounded-xl transition-all-custom border border-primary-accent/20"
                  >
                    <Sparkles className="w-4.5 h-4.5 md:w-5 md:h-5" />
                  </motion.button>
                  <motion.button 
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={startDictation}
                    className="p-2.5 text-gray-400 hover:text-white bg-bg-secondary border border-border rounded-xl transition-all-custom"
                  >
                    <Mic className="w-4.5 h-4.5 md:w-5 md:h-5" />
                  </motion.button>
                </>
              )}
              <motion.button 
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => setShowMobileSettings(true)}
                className="p-2.5 text-gray-400 hover:text-white bg-bg-secondary border border-border rounded-xl transition-all-custom lg:hidden"
              >
                <Settings className="w-4.5 h-4.5" />
              </motion.button>
            </div>
          </div>

          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="flex-1 overflow-hidden p-4 md:p-10 relative"
          >
            {mode === 'preview' ? (
              <div className="w-full h-full rounded-2xl overflow-hidden border border-border shadow-inner bg-bg-primary">
                <PerformancePreview 
                  song={{
                    ...song,
                    title,
                    lyrics,
                    metadata: {
                      ...song?.metadata,
                      performanceNotes
                    }
                  }} 
                  theme={theme}
                />
              </div>
            ) : advancedMode ? (
              <div className="w-full h-full relative group">
                <div 
                  ref={lyricsBgRef}
                  className="absolute inset-0 px-10 md:px-14 py-4 leading-[1.6] whitespace-pre-wrap break-words overflow-hidden pointer-events-none pb-32 font-sans"
                  style={{ fontSize: `${editorFontSize}px` }}
                >
                  {lyrics.split('\n').map((line, i) => {
                    const count = getSyllablesCount(line);
                    const isSection = line.trim().startsWith('[') && line.trim().endsWith(']');
                    return (
                      <div key={i} className="relative min-h-[1.6em]">
                        {!isSection && count > 0 && (
                          <span 
                            className="absolute -left-7 md:-left-8 text-yellow-500 font-mono-tech select-none opacity-60"
                            style={{ fontSize: `${Math.max(10, editorFontSize * 0.4)}px`, top: '0.4em' }}
                          >
                            {count}
                          </span>
                        )}
                        {isSection && (
                          <div className="absolute inset-0 bg-primary-accent/10 rounded-lg -mx-2 pointer-events-none" />
                        )}
                        <div className={cn(
                          "transition-all relative",
                          isSection ? "text-primary-accent font-bold" : "text-white"
                        )}>
                          {line || (i === lyrics.split('\n').length - 1 ? '' : ' ')}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <textarea
                  ref={lyricsEditorRef}
                  spellCheck={false}
                  value={lyrics}
                  onChange={(e) => setLyrics(e.target.value)}
                  onScroll={handleLyricsScroll}
                  placeholder="Begin writing lyrics here..."
                  className="absolute inset-0 w-full h-full bg-transparent px-10 md:px-14 py-4 resize-none leading-[1.6] focus:outline-none custom-scrollbar pb-32 font-sans"
                  style={{ 
                    fontSize: `${editorFontSize}px`,
                    color: 'transparent',
                    caretColor: theme === 'dark' ? 'white' : 'black'
                  }}
                />
              </div>
            ) : (
              <textarea
                ref={lyricsEditorRef}
                spellCheck={false}
                value={lyrics}
                onChange={(e) => setLyrics(e.target.value)}
                placeholder="Begin writing lyrics here..."
                className="w-full h-full bg-transparent px-10 md:px-14 py-4 resize-none leading-[1.6] focus:outline-none custom-scrollbar pb-32 font-sans"
                style={{ 
                  fontSize: `${editorFontSize}px`,
                  color: theme === 'dark' ? 'white' : 'black',
                  caretColor: theme === 'dark' ? 'white' : 'black'
                }}
              />
            )}
          </motion.div>
        </div>

        {/* Sidebar Info */}
        <aside className="lg:w-80 flex-none border-l border-border bg-bg-secondary/20 p-6 overflow-y-auto hidden lg:block">
          <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 mb-6">Song Information</h3>
          {songSettingsPanelNode}
        </aside>
      </div>

      {/* AI Modal */}
      <AnimatePresence>
        {showAIModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[120] p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-bg-secondary border border-white/10 p-8 rounded-[2.5rem] w-full max-w-xl shadow-elevation relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-6">
                <button onClick={() => { setShowAIModal(false); setAiResult(''); }} className="p-2 text-gray-500 hover:text-white transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="mb-8">
                <div className="bg-primary-accent/10 w-12 h-12 rounded-2xl flex items-center justify-center mb-4">
                  <Sparkles className="w-6 h-6 text-primary-accent" />
                </div>
                <h3 className="text-2xl font-bold tracking-tight">AI Songwriting Assistant</h3>
                <p className="text-gray-400 text-sm mt-1">Refine your {mode} with generative intelligence.</p>
              </div>
              
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-2 block">Target Section</label>
                    <input 
                      placeholder="e.g. Verse 2, Bridge..."
                      value={aiTargetSection}
                      onChange={e => setAiTargetSection(e.target.value)}
                      className="w-full bg-bg-primary text-white border border-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-primary-accent transition-all-custom"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-2 block">Action</label>
                    <div className="flex bg-bg-primary rounded-xl p-1 border border-border">
                      <button 
                        onClick={() => setAiActionType('generate')}
                        className={cn(
                          "flex-1 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all-custom",
                          aiActionType === 'generate' ? "bg-white text-black" : "text-gray-500 hover:text-white"
                        )}
                      >
                        New
                      </button>
                      <button 
                        onClick={() => setAiActionType('rephrase')}
                        className={cn(
                          "flex-1 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all-custom",
                          aiActionType === 'rephrase' ? "bg-white text-black" : "text-gray-500 hover:text-white"
                        )}
                      >
                        Rephrase
                      </button>
                    </div>
                  </div>
                </div>

                <textarea
                  autoFocus
                  placeholder={mode === 'lyrics' ? "Style, mood, or specific rhyme scheme..." : "Progression style, mood, or specific constraints..."}
                  value={aiPrompt}
                  onChange={e => setAiPrompt(e.target.value)}
                  className="w-full bg-bg-primary text-lg text-white border border-border rounded-2xl p-5 min-h-[120px] resize-none focus:outline-none focus:border-primary-accent transition-all-custom shadow-inner"
                />
                
                <AnimatePresence mode="wait">
                  {isAiLoading ? (
                    <motion.div 
                      key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center justify-center py-8 text-primary-accent"
                    >
                      <Loader2 className="w-8 h-8 animate-spin mb-3" />
                      <p className="text-[10px] font-black uppercase tracking-widest">Consulting Muse...</p>
                    </motion.div>
                  ) : aiResult ? (
                    <motion.div 
                      key="result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                      className="bg-bg-primary border border-border rounded-2xl p-6 relative group"
                    >
                      <h4 className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-3">Suggested Idea:</h4>
                      <p className="text-white text-lg font-medium leading-relaxed pr-8">{aiResult}</p>
                      <div className="mt-6 flex justify-end gap-3">
                        <button 
                          onClick={rejectAIResult}
                          className="px-6 py-3 bg-bg-tertiary text-gray-400 font-black uppercase tracking-widest text-[10px] rounded-xl hover:text-white transition-colors border border-white/5"
                        >
                          Reject
                        </button>
                        <button 
                          onClick={approveAIResult}
                          className="px-6 py-3 bg-primary-accent text-black font-black uppercase tracking-widest text-[10px] rounded-xl hover:bg-opacity-90 shadow-soft"
                        >
                          Approve & Apply
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <div className="flex justify-end">
                      <button 
                        onClick={askAI}
                        disabled={!aiPrompt.trim()}
                        className="bg-primary-accent text-black font-black uppercase tracking-widest text-[11px] px-8 py-4 rounded-2xl disabled:opacity-30 hover:bg-opacity-90 shadow-soft transition-all-custom"
                      >
                        Generate Ideas
                      </button>
                    </div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Mobile Settings Drawer */}
      <AnimatePresence>
        {showMobileSettings && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-end justify-center z-[110]">
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="bg-bg-secondary border-t border-white/10 rounded-t-[2.5rem] w-full max-w-lg p-8 shadow-elevation relative max-h-[85vh] overflow-y-auto no-scrollbar"
            >
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <div className="bg-primary-accent/10 p-2 rounded-xl">
                    <Settings className="w-5 h-5 text-primary-accent" />
                  </div>
                  <h3 className="text-xl font-bold tracking-tight">Song Settings</h3>
                </div>
                <button onClick={() => setShowMobileSettings(false)} className="p-2 bg-bg-tertiary rounded-full text-gray-500 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {songSettingsPanelNode}

              <div className="mt-8">
                <button 
                  onClick={() => setShowMobileSettings(false)}
                  className="w-full py-4 bg-primary-accent text-black font-black uppercase tracking-widest text-[11px] rounded-2xl hover:opacity-90 transition-all-custom"
                >
                  Close Settings
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Setlist Modal */}
      <AnimatePresence>
        {showSetlistModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[120] p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-bg-secondary border border-white/10 p-8 rounded-[2.5rem] w-full max-w-md shadow-elevation relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-6">
                <button onClick={() => setShowSetlistModal(false)} className="p-2 text-gray-500 hover:text-white transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="mb-6">
                <div className="bg-primary-accent/10 w-12 h-12 rounded-2xl flex items-center justify-center mb-4">
                  <ListMusic className="w-6 h-6 text-primary-accent" />
                </div>
                <h3 className="text-2xl font-bold tracking-tight">Add to Setlist</h3>
                <p className="text-gray-400 text-sm mt-1">Manage which setlists include this song.</p>
              </div>

              <div className="space-y-2 max-h-[40vh] overflow-y-auto no-scrollbar pr-2">
                {setlists?.map(setlist => {
                  const isMember = setlist.songIds.includes(song.id);
                  return (
                    <button
                      key={setlist.id}
                      onClick={() => toggleSetlistMembership(setlist.id)}
                      className={cn(
                        "w-full flex items-center justify-between p-4 rounded-2xl border transition-all-custom",
                        isMember 
                          ? "bg-primary-accent/10 border-primary-accent/30 text-primary-accent" 
                          : "bg-bg-primary border-border text-gray-400 hover:text-white hover:border-gray-500"
                      )}
                    >
                      <div className="flex flex-col items-start">
                        <span className="font-bold text-sm tracking-tight">{setlist.name}</span>
                        <span className="text-[10px] text-gray-500 uppercase tracking-widest">{setlist.songIds.length} Songs</span>
                      </div>
                      <div className={cn(
                        "w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all-custom",
                        isMember ? "bg-primary-accent border-primary-accent" : "border-gray-700"
                      )}>
                        {isMember && <CheckCircle2 className="w-4 h-4 text-black" />}
                      </div>
                    </button>
                  );
                })}
              </div>

              {setlists?.length === 0 && (
                <div className="text-center py-12 px-6 bg-bg-primary rounded-3xl border border-dashed border-border mb-6">
                   <p className="text-gray-500 text-xs font-medium italic">No setlists created yet.</p>
                </div>
              )}

              <div className="mt-8">
                <button 
                  onClick={() => setShowSetlistModal(false)}
                  className="w-full py-4 bg-bg-tertiary text-white font-black uppercase tracking-widest text-[11px] rounded-2xl hover:bg-bg-quaternary transition-all-custom"
                >
                  Done
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Persistent Floating Font Size Tool */}
      <AnimatePresence>
        {!isAnyModalOpen && (
          <div className="fixed inset-x-0 bottom-8 md:bottom-12 flex justify-center z-[9999] pointer-events-none">
            <div ref={fontSizeRef} className="pointer-events-auto">
              <AnimatePresence mode="wait">
                {!showFontSizeControls ? (
                  <motion.button
                    key="trigger"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
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
                    initial={{ opacity: 0, scale: 0.9, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.9, y: 20 }}
                    className="flex items-center justify-between w-[150px] h-[40px] bg-primary-accent rounded-full p-1 shadow-elevation border border-primary-accent/30"
                  >
                    <button 
                      className="p-2 text-black/60 hover:text-black rounded-full hover:bg-black/10 transition-colors" 
                      onClick={() => handleFontSizeChange(Math.max(6, editorFontSize - 2))}
                    >
                      <Minus className="w-4.5 h-4.5 stroke-[4px]" />
                    </button>
                    
                    <div className="text-black font-black font-mono-tech text-sm min-w-[2.5rem] text-center">
                      {editorFontSize}
                    </div>

                    <button 
                      className="p-2 text-black/60 hover:text-black rounded-full hover:bg-black/10 transition-colors" 
                      onClick={() => handleFontSizeChange(Math.min(96, editorFontSize + 2))}
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
        )}
      </AnimatePresence>
    </div>
  );
}
