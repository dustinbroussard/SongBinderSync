import React, { useState, type FormEvent, type MouseEvent } from "react";
import { Search, Plus, Upload, Trash2, X, Copy, Check, ListOrdered, Download, Play, ChevronRight } from "lucide-react";
import CustomIcon from "../components/CustomIcon";
import { useSongs } from "../hooks/useSongs";
import { useNavigate } from "react-router-dom";
import { cn } from "../lib/utils";
import { motion, AnimatePresence } from "motion/react";
import { normalizeSongTitleValue, normalizeSmartQuotes } from "../lib/normalization";
import mammoth from "mammoth";
import { useRef } from "react";
import type { Song } from "../types";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05
    }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 }
};

export default function SongsLibrary() {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<'title' | 'updatedAt'>('title');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  const { songs, addSong, deleteSong } = useSongs(searchQuery, sortBy, sortOrder);
  const [showAddModal, setShowAddModal] = useState(false);
  const [songToDelete, setSongToDelete] = useState<Song | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const handleCopy = async (e: MouseEvent, song: any) => {
    e.stopPropagation();
    try {
      const text = `${song.title}\n\n${song.lyrics || "No content"}`;
      await navigator.clipboard.writeText(text);
      setCopiedId(song.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  const handleDownload = (e: MouseEvent, song: Song) => {
    e.stopPropagation();
    const element = document.createElement("a");
    const file = new Blob([`${song.title}\n\n${song.lyrics || ""}`], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = `${song.title}.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const title = file.name.replace(/\.[^/.]+$/, ""); // Remove extension
      const normalizedTitle = normalizeSongTitleValue(normalizeSmartQuotes(title));

      let content = "";
      if (file.name.endsWith(".docx")) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        content = result.value;
      } else {
        content = await file.text();
      }

      if (normalizedTitle) {
        const song = await addSong(normalizedTitle, content);
        navigate(`/song/${song.id}`);
      }
    } catch (err) {
      console.error("Failed to import song", err);
    } finally {
      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const title = normalizeSongTitleValue(normalizeSmartQuotes(newTitle));
    if (title) {
      const song = await addSong(title);
      setShowAddModal(false);
      setNewTitle("");
      navigate(`/song/${song.id}`);
    }
  };

  const displayedSongs = songs || [];

  return (
    <div className="flex flex-col h-full p-4 md:p-8 relative">
      <div className="flex items-center gap-2 md:gap-4 mb-4 md:mb-8">
        <div className="relative flex-1 group flex items-center min-w-0">
          <Search className="absolute left-3 md:left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 group-focus-within:text-primary-accent transition-colors" />
          <input 
            type="text" 
            placeholder="Search library..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-bg-secondary text-white rounded-full pl-10 md:pl-12 pr-4 md:pr-32 py-2 md:py-3 border border-border focus:outline-none focus:border-primary-accent focus:ring-4 focus:ring-primary-accent/10 shadow-soft transition-all-custom text-sm font-medium"
          />
          <div className="absolute right-3 md:right-4 flex items-center gap-1 md:gap-2">
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="text-gray-500 hover:text-white transition-colors p-1.5">
                <X className="w-4 h-4" />
              </button>
            )}
            <div className="hidden md:flex items-center gap-2">
              <div className="h-4 w-[1px] bg-border mx-1" />
              <button
                 onClick={() => {
                   if (sortBy === 'title') { setSortBy('updatedAt'); setSortOrder('desc'); }
                   else { setSortBy('title'); setSortOrder('asc'); }
                 }}
                 className="text-gray-400 hover:text-white uppercase tracking-wider flex flex-col items-center justify-center leading-none px-1 transition-colors"
                 title={`Sorted by ${sortBy}`}
              >
                 <ListOrdered className="w-3.5 h-3.5" />
                 <span className="text-[8px] font-bold">{sortBy === 'title' ? 'A-Z' : 'DATE'}</span>
              </button>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleImportClick}
            className="w-8 h-8 md:w-9 md:h-9 bg-bg-tertiary text-primary-accent flex items-center justify-center rounded-xl shadow-lg border border-border transition-all-custom"
            title="Import Song (.txt, .docx)"
          >
            <Upload className="w-3.5 h-3.5 md:w-4 md:h-4" />
          </motion.button>
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setShowAddModal(true)}
            className="w-8 h-8 md:w-9 md:h-9 bg-primary-accent text-black flex items-center justify-center rounded-xl shadow-lg shadow-primary-accent/20 border border-primary-accent/50 transition-all-custom"
            title="Add Song"
          >
            <Plus className="w-3.5 h-3.5 md:w-4 md:h-4" />
          </motion.button>
        </div>

        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept=".txt,.docx" 
          onChange={handleFileUpload} 
        />
      </div>

      <div className="flex-1 overflow-y-auto pb-24 md:pb-8">
        {songs === undefined ? (
          <div className="flex items-center justify-center h-64 text-gray-500 font-medium">
            <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.5 }}>
              Loading your music...
            </motion.div>
          </div>
        ) : displayedSongs.length === 0 ? (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex items-center justify-center h-full text-gray-500 flex-col gap-4 text-center max-w-xs mx-auto"
          >
            <div className="w-20 h-20 rounded-full bg-bg-secondary flex items-center justify-center border border-border">
              <Upload className="w-8 h-8 opacity-40 text-primary-accent" />
            </div>
            <div>
              <p className="font-semibold text-white/80">{searchQuery ? "No matching songs found" : "Your library is empty"}</p>
              <p className="text-sm text-gray-500 mt-1">Start by adding a new song.</p>
            </div>
            {!searchQuery && (
              <button 
                onClick={() => setShowAddModal(true)}
                className="bg-bg-tertiary text-primary-accent text-sm font-bold px-5 py-2.5 rounded-xl border border-border hover:bg-bg-quaternary transition-colors"
              >
                Create your first song
              </button>
            )}
          </motion.div>
        ) : (
          <motion.div 
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="grid grid-cols-1 gap-2 mx-auto w-full"
          >
            {displayedSongs.map(song => (
              <motion.div 
                key={song.id} 
                variants={itemVariants}
                className="card-elevation bg-bg-secondary border border-border rounded-xl p-3 flex items-center gap-3 group cursor-pointer active:bg-bg-tertiary"
                onClick={() => navigate(`/song/${song.id}`)}
              >
                <div className="flex-1 min-w-0 pr-1">
                  <h3 className="text-gray-100 font-semibold text-sm leading-tight truncate">{song.title}</h3>
                  <div className="flex items-center gap-2 mt-1 transition-all-custom">
                    {song.metadata?.key && (
                      <span className="text-[9px] font-black uppercase tracking-wider bg-bg-tertiary text-primary-accent px-1.5 py-0.5 rounded border border-primary-accent/20">
                        {song.metadata.key}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-500 font-medium">Updated {new Date(song.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1">
                    <button 
                      onClick={(e) => handleCopy(e, song)}
                      className="p-2 text-gray-400 hover:text-primary-accent rounded-lg transition-all-custom"
                      title="Copy Title & Lyrics"
                    >
                      {copiedId === song.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <button 
                      onClick={(e) => handleDownload(e, song)}
                      className="p-2 text-gray-400 hover:text-primary-accent rounded-lg transition-all-custom"
                      title="Download as .txt"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        setSongToDelete(song);
                      }}
                      className="p-2 text-danger hover:bg-danger/10 rounded-lg transition-all-custom"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="hidden sm:block text-gray-500 group-hover:text-primary-accent transition-colors p-2">
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
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
                <h3 className="text-xl md:text-2xl font-bold tracking-tight">Add New Song</h3>
                <button onClick={() => setShowAddModal(false)} className="p-2 text-gray-400 hover:text-white bg-bg-tertiary rounded-full transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleAdd}>
                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] uppercase font-black tracking-widest text-gray-500 ml-1 mb-2 block">Song Title</label>
                    <input
                      type="text"
                      autoFocus
                      placeholder="e.g. Bohemian Rhapsody"
                      value={newTitle}
                      onChange={e => setNewTitle(e.target.value)}
                      className="w-full bg-bg-primary text-white border border-border rounded-xl p-4 focus:outline-none focus:border-primary-accent focus:ring-4 focus:ring-primary-accent/10 transition-all-custom text-base md:text-lg font-medium"
                    />
                  </div>
                  <div className="flex justify-end gap-3 pt-2">
                    <button 
                      type="button" 
                      onClick={() => setShowAddModal(false)}
                      className="px-6 py-3 rounded-xl text-gray-400 font-bold hover:text-white hover:bg-bg-tertiary transition-all-custom text-sm md:text-base"
                    >
                      Cancel
                    </button>
                    <button 
                      type="submit"
                      disabled={!newTitle.trim()}
                      className="bg-primary-accent text-black font-black px-6 py-3 md:px-8 rounded-xl disabled:opacity-30 hover:bg-opacity-90 shadow-lg shadow-primary-accent/20 active:scale-95 transition-all-custom text-sm md:text-base"
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
        {songToDelete && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSongToDelete(null)}
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
              <h3 className="text-xl font-bold tracking-tight mb-2">Delete Song?</h3>
              <p className="text-gray-400 text-sm mb-8 leading-relaxed">
                Are you sure you want to delete <span className="text-white font-bold">"{songToDelete.title}"</span>? This action cannot be undone.
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => {
                    deleteSong(songToDelete.id);
                    setSongToDelete(null);
                  }}
                  className="w-full bg-danger text-white font-black uppercase tracking-widest text-[11px] py-4 rounded-xl hover:bg-opacity-90 transition-all-custom shadow-lg shadow-danger/20"
                >
                  Delete Permanently
                </button>
                <button 
                  onClick={() => setSongToDelete(null)}
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
