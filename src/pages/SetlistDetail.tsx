import { useEffect, useState, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Play, Plus, Trash2, Search, Download, Type, FileJson, FileType, Music, GripVertical, ChevronUp, ChevronDown } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import type { Song } from "../types";
import { cn } from "../lib/utils";
import jsPDF from "jspdf";
import { motion, AnimatePresence } from "motion/react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  TouchSensor
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface SortableSongItemProps {
  key?: string | number;
  id: string;
  song: Song;
  index: number;
  total: number;
  onRemove: (id: string) => Promise<void> | void;
  onNavigate: (id: string) => Promise<void> | void;
  onMove: (index: number, direction: 'up' | 'down') => Promise<void> | void;
}

function SortableSongItem({ id, song, index, total, onRemove, onNavigate, onMove }: SortableSongItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div 
      ref={setNodeRef} 
      style={style}
      className="bg-bg-tertiary rounded-xl flex border border-border/50 items-center gap-1 group hover:border-primary-accent/30 transition-all-custom p-1"
    >
      <div 
        {...attributes} 
        {...listeners}
        className="flex items-center shrink-0 w-8 h-10 justify-center text-gray-500 cursor-grab active:cursor-grabbing hover:text-white transition-colors"
      >
        <GripVertical className="w-4 h-4" />
      </div>

      <div className="flex flex-col gap-0.5 shrink-0 px-1">
        <button 
          onClick={() => onMove(index, 'up')}
          disabled={index === 0}
          className="text-gray-500 hover:text-primary-accent disabled:opacity-10 transition-colors p-0.5"
        >
          <motion.div whileHover={{ y: -1 }}><ChevronUp className="w-3.5 h-3.5" /></motion.div>
        </button>
        <button 
          onClick={() => onMove(index, 'down')}
          disabled={index === total - 1}
          className="text-gray-500 hover:text-primary-accent disabled:opacity-10 transition-colors p-0.5"
        >
          <motion.div whileHover={{ y: 1 }}><ChevronDown className="w-3.5 h-3.5" /></motion.div>
        </button>
      </div>
      
      <div 
        className="flex-1 min-w-0 py-2 cursor-pointer group/title"
        onClick={() => onNavigate(song.id)}
      >
        <h4 className="text-white font-bold text-xs md:text-sm truncate group-hover/title:text-primary-accent transition-colors">{song.title}</h4>
      </div>
      
      <div className="flex items-center gap-1 shrink-0 pr-1">
        <motion.button 
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => onRemove(song.id)}
          className="w-8 h-8 flex items-center justify-center bg-danger/5 text-danger/40 hover:bg-danger hover:text-white rounded-lg transition-all-custom"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </motion.button>
      </div>
    </div>
  );
}

export default function SetlistDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const setlist = useLiveQuery(() => db.setlists.get(id || ""), [id]);
  const allSongs = useLiveQuery(() => db.songs.toArray(), []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!setlist || !over || active.id === over.id) return;

    const oldIndex = setlist.songIds.indexOf(active.id as string);
    const newIndex = setlist.songIds.indexOf(over.id as string);

    const newSongIds = arrayMove(setlist.songIds, oldIndex, newIndex);
    
    await db.setlists.update(setlist.id, {
      songIds: newSongIds,
      updatedAt: Date.now()
    });
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!setlist || !allSongs) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 font-medium">
        <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.5 }}>
          Loading setlist...
        </motion.div>
      </div>
    );
  }

  const setlistSongs = setlist.songIds
    .map(songId => allSongs.find(s => s.id === songId))
    .filter((s): s is Song => s !== undefined);

  const sortSetlist = async (type: 'title' | 'key') => {
    let sorted = [...setlistSongs];
    
    if (type === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (type === 'key') {
      sorted.sort((a, b) => {
        const keyA = a.metadata?.key || '';
        const keyB = b.metadata?.key || '';
        return keyA.localeCompare(keyB);
      });
    }

    await db.setlists.update(setlist.id, {
      songIds: sorted.map(s => s.id),
      updatedAt: Date.now()
    });
  };

  const exportTXT = () => {
    const content = setlist.name + "\n\n" + setlistSongs.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${setlist.name}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  const exportFullTXT = () => {
    const content = setlist.name + "\n\n" + setlistSongs.map((s, i) => {
      return `${i + 1}. ${s.title}\n\n${s.lyrics || "(No lyrics)"}\n\n-------------------\n`;
    }).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${setlist.name}_Full.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  const exportJSON = () => {
    const data = {
        id: setlist.id,
        name: setlist.name,
        songs: setlist.songIds,
        createdAt: new Date(setlist.createdAt).toISOString(),
        updatedAt: new Date(setlist.updatedAt).toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${setlist.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  const exportPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(20);
    doc.text(setlist.name, 10, 20);
    doc.setFontSize(12);
    setlistSongs.forEach((song, i) => {
        doc.text(`${i + 1}. ${song.title}`, 10, 30 + (i * 10));
    });
    doc.save(`${setlist.name}.pdf`);
    setShowExportMenu(false);
  };

  const exportFullPDF = () => {
    const doc = new jsPDF();
    let y = 20;
    const margin = 10;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    doc.setFontSize(22);
    doc.text(setlist.name, margin, y);
    y += 15;

    setlistSongs.forEach((song, i) => {
      // Song Title
      if (y > pageHeight - 30) {
        doc.addPage();
        y = 20;
      }
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text(`${i + 1}. ${song.title}`, margin, y);
      y += 10;

      // Lyrics
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      const lines = doc.splitTextToSize(song.lyrics || "(No lyrics)", pageWidth - (margin * 2));
      
      lines.forEach((line: string) => {
        if (y > pageHeight - 15) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, margin, y);
        y += 5;
      });
      y += 10; // Extra space between songs
    });

    doc.save(`${setlist.name}_Lyrics.pdf`);
    setShowExportMenu(false);
  };

  const availableSongs = allSongs
    .filter(s => !setlist.songIds.includes(s.id))
    .filter(s => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.lyrics.toLowerCase().includes(q);
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  const addSongToSetlist = async (songId: string) => {
    await db.setlists.update(setlist.id, {
      songIds: [...setlist.songIds, songId],
      updatedAt: Date.now()
    });
  };

  const removeSongFromSetlist = async (songId: string) => {
    await db.setlists.update(setlist.id, {
      songIds: setlist.songIds.filter(id => id !== songId),
      updatedAt: Date.now()
    });
  };

  const moveSong = async (index: number, direction: 'up' | 'down') => {
    const newSongIds = [...setlist.songIds];
    if (direction === 'up' && index > 0) {
      const temp = newSongIds[index - 1];
      newSongIds[index - 1] = newSongIds[index];
      newSongIds[index] = temp;
    } else if (direction === 'down' && index < newSongIds.length - 1) {
      const temp = newSongIds[index + 1];
      newSongIds[index + 1] = newSongIds[index];
      newSongIds[index] = temp;
    } else {
      return;
    }

    await db.setlists.update(setlist.id, {
      songIds: newSongIds,
      updatedAt: Date.now()
    });
  };

  const handleTitleChange = async (newName: string) => {
    if (newName.trim() && newName !== setlist.name) {
      await db.setlists.update(setlist.id, {
        name: newName.trim(),
        updatedAt: Date.now()
      });
    }
  };

  const deleteSetlist = async () => {
    await db.setlists.delete(setlist.id);
    navigate('/setlists');
  };

  return (
    <div className="h-full flex flex-col p-3 md:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex flex-none items-center justify-between gap-4 mb-4 md:mb-6">
        <div className="flex items-center gap-3 overflow-hidden">
          <motion.button 
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => navigate('/setlists')}
            className="p-2.5 md:p-3 bg-bg-secondary border border-border rounded-xl text-gray-400 hover:text-white transition-all-custom shadow-soft shrink-0"
          >
            <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
          </motion.button>
          <div className="flex flex-col min-w-0">
            <input
              type="text"
              defaultValue={setlist.name}
              onBlur={(e) => handleTitleChange(e.target.value)}
              className="bg-transparent text-lg md:text-2xl font-bold tracking-tight border-b-2 border-transparent hover:border-primary-accent/30 focus:border-primary-accent focus:outline-none transition-all-custom px-0 py-0.5 truncate"
            />
            <div className="flex items-center gap-2 text-[9px] md:text-[11px] text-gray-500 font-black uppercase tracking-widest mt-0.5">
              <span>{setlistSongs.length} Songs</span>
              <span className="w-1 h-1 rounded-full bg-gray-700" />
              <span>{Math.round(setlistSongs.length * 3.5)} Mins</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setShowDeleteConfirm(true)}
            className="p-2 md:p-2.5 bg-bg-secondary border border-border text-danger hover:text-white hover:bg-danger rounded-xl transition-all-custom shadow-soft flex items-center justify-center shrink-0"
            title="Delete Setlist"
          >
            <Trash2 className="w-3.5 h-3.5 md:w-4 md:h-4" />
          </motion.button>
          <div className="relative" ref={exportMenuRef}>
            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="p-2 md:p-2.5 bg-bg-secondary border border-border text-white rounded-xl hover:bg-bg-tertiary transition-all-custom shadow-soft flex items-center justify-center shrink-0"
            >
              <Download className="w-3.5 h-3.5 md:w-4 md:h-4" />
            </motion.button>
            <AnimatePresence>
              {showExportMenu && (
                <motion.div 
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute right-0 mt-3 w-44 bg-bg-tertiary border border-border rounded-2xl shadow-elevation p-1.5 z-50 overflow-hidden"
                >
                  <button onClick={exportTXT} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-bg-quaternary text-[11px] font-black uppercase tracking-widest text-gray-400 hover:text-white rounded-xl transition-all-custom text-left">
                    <Type className="w-4 h-4 text-primary-accent" /> List TXT
                  </button>
                  <button onClick={exportFullTXT} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-bg-quaternary text-[11px] font-black uppercase tracking-widest text-gray-400 hover:text-white rounded-xl transition-all-custom text-left">
                    <Type className="w-4 h-4 text-primary-accent" /> Full TXT
                  </button>
                  <button onClick={exportJSON} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-bg-quaternary text-[11px] font-black uppercase tracking-widest text-gray-400 hover:text-white rounded-xl transition-all-custom text-left">
                    <FileJson className="w-4 h-4 text-secondary-text" /> JSON
                  </button>
                  <button onClick={exportPDF} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-bg-quaternary text-[11px] font-black uppercase tracking-widest text-gray-400 hover:text-white rounded-xl transition-all-custom text-left">
                    <FileType className="w-4 h-4 text-tertiary-accent" /> List PDF
                  </button>
                  <button onClick={exportFullPDF} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-bg-quaternary text-[11px] font-black uppercase tracking-widest text-gray-400 hover:text-white rounded-xl transition-all-custom text-left">
                    <FileType className="w-4 h-4 text-tertiary-accent" /> Lyrics PDF
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate(`/performance/setlist/${setlist.id}`)}
            disabled={setlistSongs.length === 0}
            className="group bg-primary-accent text-black font-black uppercase tracking-widest px-4 md:px-5 h-10 md:h-11 rounded-xl hover:bg-opacity-90 shadow-lg shadow-primary-accent/20 transition-all-custom flex items-center justify-center gap-2 disabled:opacity-30 text-[9px] md:text-[10px]"
          >
            <Play className="w-3.5 h-3.5 fill-black group-hover:scale-110 transition-transform" />
            <span className="hidden sm:inline">Perform</span>
          </motion.button>
        </div>
      </div>

      {/* Main split view */}
      <div className="flex-1 flex flex-col lg:flex-row gap-6 md:gap-8 min-h-0 overflow-y-auto lg:overflow-hidden p-1">
        {/* Left: Available Songs */}
        <div className="flex-[1] flex flex-col min-h-0 bg-bg-secondary/30 rounded-3xl border border-border p-3 md:p-4 overflow-hidden">
          <div className="flex-none mb-3 relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 group-focus-within:text-white transition-colors" />
            <input 
              type="text" 
              placeholder="Search library..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-bg-primary text-white rounded-xl pl-10 pr-4 py-2 border border-border focus:border-primary-accent focus:outline-none transition-all-custom text-xs md:text-sm shadow-inner"
            />
          </div>
          <div className="flex-none flex items-center justify-between mb-3 px-1">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">
              Available <span className="text-white">Songs</span>
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto pr-1 space-y-2 custom-scrollbar no-scrollbar pb-4">
             {availableSongs.map((song) => (
                <motion.div 
                  key={song.id} 
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  className="bg-bg-tertiary hover:bg-bg-quaternary rounded-xl flex items-center justify-between group transition-all-custom cursor-pointer border border-border/50 hover:border-primary-accent/30 p-1" 
                  onClick={() => addSongToSetlist(song.id)}
                >
                  <div className="flex-1 min-w-0 px-3 py-2">
                    <h4 className="text-gray-300 font-bold text-xs md:text-sm group-hover:text-white transition-colors truncate">{song.title}</h4>
                  </div>
                  <div className="w-8 h-8 md:w-9 md:h-9 flex items-center justify-center text-primary-accent bg-primary-accent/5 group-hover:bg-primary-accent group-hover:text-black rounded-lg transition-all-custom shrink-0">
                    <Plus className="w-4 h-4 stroke-[3px]" />
                  </div>
                </motion.div>
              ))}
            {availableSongs.length === 0 && (
              <div className="text-center py-12 opacity-50">
                <Music className="w-8 h-8 mx-auto mb-3 text-gray-700" />
                <p className="text-gray-500 text-[10px] font-black uppercase tracking-widest">No matching songs</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Current Setlist */}
        <div className="flex-[1.2] flex flex-col min-h-0 bg-bg-secondary/30 rounded-3xl border border-border p-3 md:p-4 overflow-hidden">
          <div className="flex-none flex items-center justify-between mb-3 px-1">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">
              Current <span className="text-white">Setlist</span>
            </h3>
          </div>
          
          <div className="flex-1 overflow-y-auto pr-1 space-y-2 custom-scrollbar no-scrollbar pb-4">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext 
                items={setlist.songIds}
                strategy={verticalListSortingStrategy}
              >
                {setlistSongs.map((song, index) => (
                  <SortableSongItem 
                    key={song.id}
                    id={song.id}
                    song={song} 
                    index={index}
                    total={setlistSongs.length}
                    onRemove={removeSongFromSetlist}
                    onNavigate={(id) => navigate(`/performance/song/${id}`)}
                    onMove={moveSong}
                  />
                ))}
              </SortableContext>
            </DndContext>
            
            {setlistSongs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center opacity-40">
                <div className="w-10 h-10 rounded-full border-2 border-dashed border-gray-600 flex items-center justify-center mb-3">
                  <Plus className="w-5 h-5 text-gray-600" />
                </div>
                <p className="font-black text-[10px] uppercase tracking-widest text-gray-500">Drag or add songs</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDeleteConfirm(false)}
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
                Are you sure you want to delete <span className="text-white font-bold">"{setlist.name}"</span>? This will not delete the songs themselves, only the setlist arrangement.
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={deleteSetlist}
                  className="w-full bg-danger text-white font-black uppercase tracking-widest text-[11px] py-4 rounded-xl hover:bg-opacity-90 transition-all-custom shadow-lg shadow-danger/20"
                >
                  Delete Setlist
                </button>
                <button 
                  onClick={() => setShowDeleteConfirm(false)}
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
