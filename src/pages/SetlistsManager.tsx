import { useState, type FormEvent, useRef, type ChangeEvent, useMemo } from "react";
import { Plus, ListMusic, Trash2, Copy, X, Camera, Loader2, FileText, Type, Play, ChevronRight, ArrowUpDown, Clock, Calendar, SortAsc } from "lucide-react";
import CustomIcon from "../components/CustomIcon";
import { useSetlists } from "../hooks/useSetlists";
import { useNavigate } from "react-router-dom";
import Tesseract from "tesseract.js";
import Fuse from "fuse.js";
import { db } from "../lib/db";
import { v4 as uuidv4 } from "uuid";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import * as mammoth from "mammoth";
import { normalizeSetlistName, normalizeSongTitleValue, normalizeSmartQuotes } from "../lib/normalization";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1
    }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 }
};

export default function SetlistsManager() {
  const { setlists, addSetlist, deleteSetlist, duplicateSetlist } = useSetlists();
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [importTab, setImportTab] = useState<'text' | 'photo'>('text');
  const [sortBy, setSortBy] = useState<'name' | 'createdAt' | 'updatedAt'>('updatedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [setlistToDelete, setSetlistToDelete] = useState<{id: string, name: string} | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const normalizedName = normalizeSetlistName(normalizeSmartQuotes(newName));
    if (normalizedName) {
      const setlist = await addSetlist(normalizedName);
      setShowAddModal(false);
      setNewName("");
      navigate(`/setlists/${setlist.id}`);
    }
  };

  const processLines = async (lines: string[], sourceName: string) => {
    setIsProcessing(true);
    try {
      const allSongs = await db.songs.toArray();
      const fuse = new Fuse(allSongs, {
        keys: ['title'],
        threshold: 0.4,
      });

      const matchedSongIds: string[] = [];
      for (const rawLine of lines) {
        const line = normalizeSongTitleValue(normalizeSmartQuotes(rawLine));
        if (!line) continue;

        const result = fuse.search(line);
        if (result.length > 0) {
          if (matchedSongIds[matchedSongIds.length - 1] !== result[0].item.id) {
            matchedSongIds.push(result[0].item.id);
          }
        } else {
          // Create the missing song if we don't find it
          const newSong = {
            id: uuidv4(),
            title: line,
            lyrics: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {}
          };
          await db.songs.add(newSong);
          matchedSongIds.push(newSong.id);
        }
      }

      const setlistName = normalizeSetlistName(sourceName);
      const newSetlist = {
        id: uuidv4(),
        name: setlistName || "Untitled Setlist",
        songIds: matchedSongIds,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await db.setlists.add(newSetlist);
      
      setIsProcessing(false);
      setShowImportModal(false);
      navigate(`/setlists/${newSetlist.id}`);
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
    }
  };

  const processOCR = async (file: File) => {
    setIsProcessing(true);
    try {
      const { data: { text } } = await Tesseract.recognize(file, 'eng');
      const lines = text.split('\n')
        .map(l => l.trim().replace(/^[\d\.\-\*]+\s*/, ''))
        .filter(l => l.length > 2);
      await processLines(lines, file.name || 'OCR Setlist');
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
    }
  };

  const processTextFile = async (file: File) => {
    setIsProcessing(true);
    try {
      let text = '';
      if (file.name.toLowerCase().endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value;
      } else {
        text = await file.text();
      }
      
      const lines = text.split('\n')
        .map(l => l.trim().replace(/^[\d\.\-\*]+\s*/, ''))
        .filter(l => l.length > 2);
      await processLines(lines, file.name);
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
    }
  };

  const handlePastedText = () => {
    if (!pastedText.trim()) return;
    const lines = pastedText.split('\n')
      .map(l => l.trim().replace(/^[\d\.\-\*]+\s*/, ''))
      .filter(l => l.length > 2);
    processLines(lines, 'Pasted Text');
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type.startsWith('image/')) {
      processOCR(file);
    } else {
      processTextFile(file);
    }
  };

  const sortedSetlists = useMemo(() => {
    if (!setlists) return [];
    return [...setlists].sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortBy === 'createdAt') {
        comparison = a.createdAt - b.createdAt;
      } else {
        comparison = a.updatedAt - b.updatedAt;
      }
      return sortOrder === 'desc' ? -comparison : comparison;
    });
  }, [setlists, sortBy, sortOrder]);

  return (
    <div className="p-4 md:p-8 flex flex-col h-full relative">
      <div className="flex justify-between items-center mb-4 md:mb-10">
        <div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tight text-white">
            {setlists?.length || 0} Setlists Found
          </h2>
          <p className="text-[10px] md:text-sm text-gray-500 mt-1 font-medium hidden sm:block">Organize your repertoire for the stage.</p>
        </div>
        <div className="flex gap-2 md:gap-3">
          <motion.button 
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setShowImportModal(true)}
            className="border border-border bg-bg-secondary text-white font-bold px-3 py-2 md:px-5 md:py-3 rounded-xl hover:bg-bg-tertiary transition-all-custom flex items-center gap-1.5 md:gap-2 shadow-soft text-xs md:text-base shrink-0"
          >
            <Camera className="w-3.5 h-3.5 md:w-5 md:h-5 text-primary-accent" />
            <span>Import</span>
          </motion.button>
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setShowAddModal(true)}
            className="bg-primary-accent text-black flex items-center justify-center rounded-full shrink-0 shadow-lg shadow-primary-accent/20 transition-all-custom w-9 h-9 md:w-11 md:h-11 border border-primary-accent/50"
            title="New Setlist"
          >
            <Plus className="w-5 h-5" />
          </motion.button>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto pb-24 md:pb-8">
        {setlists === undefined ? (
          <div className="flex items-center justify-center h-64 text-gray-500 font-medium">
             <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.5 }}>
              Loading setlists...
            </motion.div>
          </div>
        ) : setlists.length === 0 ? (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex items-center justify-center h-full text-gray-500 flex-col gap-4 text-center max-w-xs mx-auto"
          >
             <div className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-bg-secondary flex items-center justify-center border border-border">
              <ListMusic className="w-6 h-6 md:w-8 md:h-8 opacity-40 text-primary-accent" />
            </div>
            <div>
              <p className="font-semibold text-white/80 text-sm md:text-base">No setlists created yet</p>
              <p className="text-xs text-gray-500 mt-1">Ready your show flow.</p>
            </div>
            <div className="grid grid-cols-1 gap-2 w-full mt-2">
              <button 
                onClick={() => setShowAddModal(true)}
                className="bg-bg-tertiary text-primary-accent text-xs md:text-sm font-bold px-5 py-3 rounded-xl border border-border hover:bg-bg-quaternary transition-colors"
              >
                Create blank setlist
              </button>
            </div>
          </motion.div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-2">
              <div className="flex bg-bg-secondary p-1 rounded-xl border border-border shrink-0">
                <button 
                  onClick={() => {
                    if (sortBy === 'name') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    else { setSortBy('name'); setSortOrder('asc'); }
                  }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
                    sortBy === 'name' ? "bg-bg-tertiary text-primary-accent shadow-sm" : "text-gray-500 hover:text-gray-400"
                  )}
                >
                  <SortAsc className="w-3 h-3" />
                  Name {sortBy === 'name' && (sortOrder === 'asc' ? '↑' : '↓')}
                </button>
                <button 
                  onClick={() => {
                    if (sortBy === 'updatedAt') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    else { setSortBy('updatedAt'); setSortOrder('desc'); }
                  }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
                    sortBy === 'updatedAt' ? "bg-bg-tertiary text-primary-accent shadow-sm" : "text-gray-500 hover:text-gray-400"
                  )}
                >
                  <Clock className="w-3 h-3" />
                  Updated {sortBy === 'updatedAt' && (sortOrder === 'asc' ? '↑' : '↓')}
                </button>
                <button 
                  onClick={() => {
                    if (sortBy === 'createdAt') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    else { setSortBy('createdAt'); setSortOrder('desc'); }
                  }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
                    sortBy === 'createdAt' ? "bg-bg-tertiary text-primary-accent shadow-sm" : "text-gray-500 hover:text-gray-400"
                  )}
                >
                  <Calendar className="w-3 h-3" />
                  Created {sortBy === 'createdAt' && (sortOrder === 'asc' ? '↑' : '↓')}
                </button>
              </div>
            </div>

            <motion.div 
              variants={containerVariants}
              initial="hidden"
              animate="show"
              className="grid grid-cols-1 gap-2"
            >
              {sortedSetlists.map(setlist => (
              <motion.div 
                key={setlist.id} 
                variants={itemVariants}
                className="card-elevation bg-bg-secondary border border-border rounded-xl p-3 flex items-center gap-3 active:bg-bg-tertiary transition-all-custom group cursor-pointer" 
                onClick={() => navigate(`/setlists/${setlist.id}`)}
              >
                <motion.button 
                  whileTap={{ scale: 0.9 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/performance/setlist/${setlist.id}`);
                  }}
                  className="w-10 h-10 shrink-0 bg-primary-accent/10 text-primary-accent rounded-lg flex items-center justify-center transition-all-custom border border-primary-accent/20 active:bg-primary-accent active:text-black"
                  title="Play Setlist"
                >
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                </motion.button>
                
                <div className="flex-1 min-w-0">
                  <h3 className="text-gray-200 font-bold text-sm tracking-tight truncate group-hover:text-white transition-colors">{setlist.name}</h3>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400 font-medium uppercase tracking-widest mt-1">
                    <span>{setlist.songIds.length} Song{setlist.songIds.length !== 1 ? 's' : ''}</span>
                    <span className="w-1 h-1 rounded-full bg-gray-700" />
                    <span>{new Date(setlist.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="flex items-center gap-0.5 shrink-0">
                  <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={(e) => { e.stopPropagation(); duplicateSetlist(setlist.id, `${setlist.name} (Copy)`); }}
                      className="p-2 text-gray-500 hover:text-white bg-bg-tertiary rounded-lg hover:bg-bg-quaternary transition-colors"
                      title="Duplicate"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); setSetlistToDelete(setlist); }}
                      className="p-2 text-danger hover:bg-danger/10 rounded-lg transition-all-custom"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="sm:hidden p-2 text-gray-500">
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      )}
    </div>

      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAddModal(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-bg-secondary border border-border p-8 rounded-[2rem] w-full max-w-md shadow-elevation overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-primary-accent/20" />
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-bold tracking-tight">New Setlist</h3>
                <button onClick={() => setShowAddModal(false)} className="p-2 text-gray-400 hover:text-white bg-bg-tertiary rounded-full transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleAdd}>
                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] uppercase font-black tracking-widest text-gray-500 ml-1 mb-2 block">Setlist Name</label>
                    <input
                      type="text"
                      autoFocus
                      placeholder="e.g. Acoustic Gig 2024"
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      className="w-full bg-bg-primary text-white border border-border rounded-xl p-4 focus:outline-none focus:border-primary-accent focus:ring-4 focus:ring-primary-accent/10 transition-all-custom text-lg font-medium"
                    />
                  </div>
                  <div className="flex justify-end gap-3 pt-2">
                    <button 
                      type="button" 
                      onClick={() => setShowAddModal(false)}
                      className="px-6 py-3 rounded-xl text-gray-400 font-bold hover:text-white hover:bg-bg-tertiary transition-all-custom"
                    >
                      Cancel
                    </button>
                    <button 
                      type="submit"
                      disabled={!newName.trim()}
                      className="bg-primary-accent text-black font-black px-8 py-3 rounded-xl disabled:opacity-30 hover:bg-opacity-90 shadow-lg shadow-primary-accent/20 active:scale-95 transition-all-custom"
                    >
                      Create
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showImportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               onClick={() => !isProcessing && setShowImportModal(false)}
               className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-bg-secondary border border-border p-8 rounded-[2.5rem] w-full max-w-lg shadow-elevation overflow-hidden"
            >
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h3 className="text-2xl font-bold tracking-tight">Import Setlist</h3>
                  <p className="text-sm text-gray-500 font-medium mt-1">Smartly match text to your library.</p>
                </div>
                {!isProcessing && (
                  <button onClick={() => setShowImportModal(false)} className="p-2 text-gray-400 hover:text-white bg-bg-tertiary rounded-full transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>
              
              {isProcessing ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="relative mb-6">
                    <Loader2 className="w-12 h-12 text-primary-accent animate-spin" />
                    <div className="absolute inset-0 bg-primary-accent/10 blur-xl rounded-full" />
                  </div>
                  <p className="text-xl font-bold text-white text-center">Processing Setlist</p>
                  <p className="text-gray-500 text-sm mt-2 text-center font-medium max-w-xs">We're using AI to read your input and match it with your library songs.</p>
                </div>
              ) : (
                <div className="flex flex-col">
                  <div className="flex p-1 bg-bg-primary rounded-2xl border border-border mb-8 shadow-inner relative overflow-hidden">
                    <button 
                      onClick={() => setImportTab('text')}
                      className={cn(
                        "flex-1 py-3 text-sm font-bold rounded-xl transition-all-custom relative z-10 flex items-center justify-center gap-2",
                        importTab === 'text' ? "text-white" : "text-gray-500 hover:text-gray-300"
                      )}
                    >
                      <Type className="w-4 h-4" />
                      Paste Text
                      {importTab === 'text' && (
                        <motion.div layoutId="import-tab" className="absolute inset-0 bg-bg-tertiary border border-border rounded-xl shadow-sm -z-10" />
                      )}
                    </button>
                    <button 
                      onClick={() => setImportTab('photo')}
                      className={cn(
                        "flex-1 py-3 text-sm font-bold rounded-xl transition-all-custom relative z-10 flex items-center justify-center gap-2",
                        importTab === 'photo' ? "text-white" : "text-gray-500 hover:text-gray-300"
                      )}
                    >
                      <FileText className="w-4 h-4" />
                      OCR Photo
                      {importTab === 'photo' && (
                        <motion.div layoutId="import-tab" className="absolute inset-0 bg-bg-tertiary border border-border rounded-xl shadow-sm -z-10" />
                      )}
                    </button>
                  </div>

                  {importTab === 'text' ? (
                    <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-6">
                      <textarea
                        value={pastedText}
                        onChange={(e) => setPastedText(e.target.value)}
                        placeholder="Paste songs here, one per line...&#10;Hey Jude&#10;Bohemian Rhapsody&#10;Purple Haze"
                        className="w-full bg-bg-primary text-white border border-border rounded-2xl p-5 min-h-[200px] focus:outline-none focus:border-primary-accent focus:ring-4 focus:ring-primary-accent/10 transition-all font-medium text-base resize-none"
                      />
                      <button 
                        onClick={handlePastedText}
                        disabled={!pastedText.trim()}
                        className="bg-primary-accent text-black font-black px-8 py-4 rounded-xl disabled:opacity-30 hover:bg-opacity-90 shadow-lg shadow-primary-accent/20 transition-all-custom"
                      >
                        Match & Import
                      </button>
                    </motion.div>
                  ) : (
                    <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col items-center py-6 text-center">
                      <div className="w-24 h-24 rounded-3xl bg-bg-tertiary flex items-center justify-center border border-border shadow-soft mb-6 group transition-all-custom hover:border-primary-accent/40">
                         <Camera className="w-10 h-10 text-primary-accent group-hover:scale-110 transition-transform" />
                      </div>
                      <h4 className="text-xl font-bold mb-2">Snap & Analyze</h4>
                      <p className="text-gray-500 text-sm mb-8 max-w-xs font-medium">
                        Take a clear photo of a physical setlist. We'll extract the text and match it to your library automatically.
                      </p>
                      <input 
                        type="file" 
                        accept="image/*,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" 
                        capture="environment" 
                        className="hidden" 
                        ref={fileInputRef}
                        onChange={handleFileChange}
                      />
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="bg-primary-accent text-black font-black px-10 py-4 rounded-xl hover:bg-opacity-90 shadow-lg shadow-primary-accent/20 flex items-center justify-center gap-3 w-full"
                      >
                        <Camera className="w-5 h-5" />
                        Select Setlist File/Photo
                      </button>
                      <p className="mt-4 text-[10px] text-gray-500 font-bold uppercase tracking-widest">Supports PNG, JPG, TXT, or DOCX</p>
                    </motion.div>
                  )}
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {setlistToDelete && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSetlistToDelete(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-bg-secondary border border-border p-8 rounded-[2rem] w-full max-w-sm shadow-elevation overflow-hidden text-center"
            >
              <div className="w-16 h-16 bg-danger/10 text-danger rounded-2xl flex items-center justify-center mx-auto mb-6">
                <Trash2 className="w-8 h-8" />
              </div>
              <h3 className="text-xl font-bold tracking-tight mb-2">Delete Setlist?</h3>
              <p className="text-gray-400 text-sm mb-8 leading-relaxed">
                Are you sure you want to delete <span className="text-white font-bold">"{setlistToDelete.name}"</span>? This will not delete the songs themselves.
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => {
                    deleteSetlist(setlistToDelete.id);
                    setSetlistToDelete(null);
                  }}
                  className="w-full bg-danger text-white font-black uppercase tracking-widest text-[11px] py-4 rounded-xl hover:bg-opacity-90 transition-all-custom shadow-lg shadow-danger/20"
                >
                  Delete Setlist
                </button>
                <button 
                  onClick={() => setSetlistToDelete(null)}
                  className="w-full py-4 text-gray-400 font-bold hover:text-white transition-colors text-sm"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
