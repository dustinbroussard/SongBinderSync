import { useMemo } from "react";
import { cn } from "../lib/utils";
import type { Song } from "../types";

interface PerformancePreviewProps {
  song: Partial<Song>;
  theme?: 'dark' | 'light';
}

// Same logic as PerformanceMode.tsx
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

export default function PerformancePreview({ song, theme = 'dark' }: PerformancePreviewProps) {
  const global = getGlobalSettings();
  const fallback = getRecentFallback();

  const m = song.metadata || {};
  const fontSize = m.fontSize ?? fallback.fontSize;
  const layoutMode = m.layoutMode ?? fallback.layoutMode;
  const fontFamily = m.fontFamily ?? fallback.fontFamily;
  const textAlign = global.textAlign;
  const lineHeight = global.lineHeight;
  const sectionSpacing = global.sectionSpacing;
  const isBold = global.isBold;

  const firstLyricalSection = useMemo(() => {
    if (!song.lyrics) return null;
    const parts = (song.lyrics || '').split(/(\[.*?\])/);
    
    for (let i = 1; i < parts.length; i += 2) {
      const header = parts[i].trim();
      const nextContent = parts[i + 1] || "";
      const contentLines = nextContent.trim().split('\n').filter(l => l.trim().length > 0);
      
      const hasActualLyrics = contentLines.some(line => {
        const lower = line.toLowerCase();
        return !lower.includes('instrumental') && !lower.includes('solo') && !lower.includes('pause');
      }) && contentLines.length > 0;

      const isIntro = header.toLowerCase().includes('intro');
      if (isIntro && !hasActualLyrics) continue;
      if (hasActualLyrics) return header;
    }
    return null;
  }, [song.lyrics]);

  return (
    <div className={cn(
      "w-full h-full overflow-y-auto px-4 md:px-12 custom-scrollbar transition-colors duration-500",
      theme === 'dark' ? "bg-bg-primary" : "bg-white"
    )}>
      <div 
        className={cn(
          "max-w-7xl mx-auto py-12 pb-[30vh]",
          textAlign === 'center' ? "text-center" : "text-left",
          theme === 'dark' ? "text-white" : "text-black"
        )}
      >
        {(song.metadata?.performanceNotes || song.metadata?.productionNotes) && (
          <div className="mb-8 p-4 bg-primary-accent/5 border border-primary-accent/10 rounded-2xl max-w-xl mx-auto text-center">
            <p className="text-xs text-primary-accent/70 font-medium italic">
              "{song.metadata.performanceNotes || song.metadata.productionNotes}"
            </p>
          </div>
        )}

        {layoutMode === 'split' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-0.5">
              <h4 className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500 mb-4 border-b border-border pb-2">Lyrics Left</h4>
              {(song.lyrics || '').split('\n').filter((_, i) => i % 2 === 0).map((line, i) => {
                 const cleanedLabel = cleanSectionLabel(line);
                 const isSectionStr = cleanedLabel !== null;
                 return (
                  <p 
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap leading-snug font-medium transition-colors min-h-[1.2em]",
                      fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono-tech' : 'font-sans',
                      isBold && "font-bold",
                      isSectionStr 
                        ? cn(
                            "text-primary-accent font-black tracking-[0.25em] uppercase font-mono-tech pt-3 pb-1.5 bg-primary-accent/5",
                            textAlign === 'center' ? "rounded-xl px-4 inline-block" : "border-l-4 border-primary-accent/30 pl-4 rounded-r-xl block w-full"
                          )
                        : cn(theme === 'dark' ? "text-white" : "text-black", "block w-full")
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
            <div className="space-y-0.5">
              <h4 className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500 mb-4 border-b border-border pb-2">Lyrics Right</h4>
              {(song.lyrics || '').split('\n').filter((_, i) => i % 2 !== 0).map((line, i) => {
                 const cleanedLabel = cleanSectionLabel(line);
                 const isSectionStr = cleanedLabel !== null;
                 return (
                  <p 
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap leading-snug font-medium transition-colors min-h-[1.2em]",
                      fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono-tech' : 'font-sans',
                      isBold && "font-bold",
                      isSectionStr 
                        ? cn(
                            "text-primary-accent font-black tracking-[0.25em] uppercase font-mono-tech pt-3 pb-1.5 bg-primary-accent/5",
                            textAlign === 'center' ? "rounded-xl px-4 inline-block" : "border-l-4 border-primary-accent/30 pl-4 rounded-r-xl block w-full"
                          )
                        : cn(theme === 'dark' ? "text-white" : "text-black", "block w-full")
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
          (song.lyrics || '').split('\n').map((lLine, i) => {
            const cleanedLabel = cleanSectionLabel(lLine);
            const isSectionStr = cleanedLabel !== null;
            const isRawBracketed = lLine.trim().startsWith('[') && lLine.trim().endsWith(']');
            const lyricsLines = (song.lyrics || '').split('\n');
            const firstLyricalIdx = firstLyricalSection ? lyricsLines.findIndex(l => l.trim() === firstLyricalSection) : -1;
            const shouldHideNote = isRawBracketed && !isSectionStr && firstLyricalIdx !== -1 && i < firstLyricalIdx;

            return (
              <div key={i} className={cn("pt-0 pb-1", shouldHideNote && "hidden")}>
                {lLine && (
                  <p 
                    className={cn(
                      "whitespace-pre-wrap leading-snug font-medium transition-colors",
                      fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono-tech' : 'font-sans',
                      isBold && "font-bold",
                      isSectionStr 
                        ? cn(
                            "text-primary-accent font-black tracking-[0.25em] uppercase font-mono-tech pt-3 pb-1.5 bg-primary-accent/5",
                            textAlign === 'center' ? "rounded-xl px-4 inline-block" : "border-l-4 border-primary-accent pl-4 rounded-r-xl block w-full"
                          )
                        : cn(theme === 'dark' ? "text-white" : "text-black", "block w-full")
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
        )}
      </div>
    </div>
  );
}
