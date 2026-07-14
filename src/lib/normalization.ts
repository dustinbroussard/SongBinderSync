export function normalizeSmartQuotes(str: string): string {
  if (!str) return str;
  return str
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-");
}

export function normalizeSetlistName(name: string): string {
  if (!name) return "Untitled Setlist";
  let normalized = name
    .replace(/\.(txt|docx)$/i, "")
    .replace(/_/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "Untitled Setlist";

  return normalized.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
}

export function normalizeSongTitleValue(str: string): string {
  if (!str) return "";
  let normalized = str
    .replace(/\.(txt|docx)$/i, "")
    .replace(/_/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "";

  return normalized.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
}

export function normalizeLyricsBlock(lyrics: string, title?: string): string {
  if (!lyrics) return lyrics;
  let normalized = lyrics
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+$/gm, "");

  normalized = normalized.replace(/\n{3,}/g, "\n\n");

  if (title) {
    const lines = normalized.split('\n');
    if (lines.length > 0 && lines[0].trim().toLowerCase() === title.toLowerCase()) {
      lines.shift();
      if (lines.length > 0 && lines[0].trim() === "") lines.shift();
      normalized = lines.join('\n');
    }
  }

  return normalized.trim();
}

export function normalizeSectionLabels(text: string): string {
  if (!text) return text;
  
  const sectionKeywords = [
    "intro", "verse", "prechorus", "pre-chorus", "chorus", "bridge", 
    "instrumental", "refrain", "reprise", "outro", "end"
  ];
  const regex = /^(\[?)\s*(intro|verse|prechorus|pre-chorus|chorus|bridge|instrumental|refrain|reprise|outro|end)\b(?:\s+([0-9]+|[a-zA-Z])\b)?\s*(:|\])?/i;

  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length < 120) {
      const match = trimmed.match(regex);
      if (match) {
        let keyword = match[2].toLowerCase();
        if (keyword === 'prechorus') keyword = 'pre-chorus';
        keyword = keyword.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
        const identifier = match[3] ? ` ${match[3].toUpperCase()}` : '';
        const normalizedLabel = `[${keyword}${identifier}]`;
        
        const remaining = trimmed.substring(match[0].length).trim();
        let cleanRemaining = remaining;
        
        if (match[4] === ':') {
          if (cleanRemaining.endsWith(']')) {
            cleanRemaining = cleanRemaining.slice(0, -1).trim();
          }
          return `${normalizedLabel} [${cleanRemaining}]`;
        }
        
        if (cleanRemaining) {
          return `${normalizedLabel} ${cleanRemaining}`;
        } else {
          return normalizedLabel;
        }
      }
    }
    return line;
  }).join('\n');
}

export function cleanAIOutput(output: string): string {
  if (!output) return output;
  return output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function extractPerformanceNotes(text: string): { cleanedText: string; performanceNotes: string | null } {
  if (!text) return { cleanedText: text, performanceNotes: null };

  const sectionKeywords = [
    "intro", "verse", "prechorus", "pre-chorus", "chorus", "bridge", 
    "instrumental", "refrain", "reprise", "outro", "end"
  ];
  const keywordRegex = new RegExp(`^\\W*(${sectionKeywords.join('|')})\\b(?:\\s+([0-9]+|[a-zA-Z])\\b)?`, 'i');

  const notes: string[] = [];
  const lines = text.split('\n');
  const cleanedLines = lines.map(line => {
    let currentLine = line;
    const bracketRegex = /\[(.*?)\]/g;
    
    currentLine = currentLine.replace(bracketRegex, (fullMatch, content) => {
      const isSection = keywordRegex.test(content.trim());
      if (isSection) {
        return fullMatch;
      } else {
        notes.push(content.trim());
        return "";
      }
    });

    return currentLine;
  });

  return {
    cleanedText: cleanedLines.join('\n').replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(),
    performanceNotes: notes.length > 0 ? notes.join('; ') : null
  };
}

export function cleanLineOfNotes(line: string): string {
  if (!line) return line;
  
  const sectionKeywords = [
    "intro", "verse", "prechorus", "pre-chorus", "chorus", "bridge", 
    "instrumental", "refrain", "reprise", "outro", "end"
  ];
  
  const isSectionKeyword = (str: string) => {
    const trimmed = str.trim();
    return sectionKeywords.some(keyword => {
      const regex = new RegExp(`^${keyword}\\b(?:\\s+([0-9]+|[a-zA-Z])\\b)?`, 'i');
      return regex.test(trimmed);
    });
  };

  const bracketRegex = /\[(.*?)\]/g;
  
  let cleaned = line.replace(bracketRegex, (fullMatch, content) => {
    const trimmedContent = content.trim();
    const colonIndex = trimmedContent.indexOf(':');
    const possibleSection = colonIndex !== -1 ? trimmedContent.substring(0, colonIndex).trim() : trimmedContent;
    
    if (isSectionKeyword(possibleSection)) {
      if (colonIndex !== -1) {
        const sectionWords = possibleSection.toLowerCase().split(/\s+/);
        const normalizedSectionWords = sectionWords.map(w => {
          if (w === 'prechorus') return 'Pre-Chorus';
          if (w === 'pre-chorus') return 'Pre-Chorus';
          return w.charAt(0).toUpperCase() + w.slice(1);
        });
        return `[${normalizedSectionWords.join(' ')}]`;
      }
      return fullMatch;
    } else {
      return "";
    }
  });
  
  return cleaned.replace(/\s+/g, ' ').trim();
}

interface SectionNotes {
  sectionName: string;
  notes: string[];
}

export function parsePerformanceNotesBySection(lyrics: string): SectionNotes[] {
  if (!lyrics) return [];

  const sectionKeywords = [
    "intro", "verse", "prechorus", "pre-chorus", "chorus", "bridge", 
    "instrumental", "refrain", "reprise", "outro", "end"
  ];
  
  const isSectionKeyword = (str: string) => {
    const trimmed = str.trim();
    return sectionKeywords.some(keyword => {
      const regex = new RegExp(`^${keyword}\\b(?:\\s+([0-9]+|[a-zA-Z])\\b)?`, 'i');
      return regex.test(trimmed);
    });
  };

  const sectionsList: SectionNotes[] = [];
  let currentSection: SectionNotes | null = null;
  const lines = lyrics.split('\n');

  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;

    const bracketRegex = /\[(.*?)\]/g;
    let match;
    const lineNotes: string[] = [];
    let lineHasSectionLabel = false;
    let detectedSectionName = "";

    const brackets: string[] = [];
    while ((match = bracketRegex.exec(trimmedLine)) !== null) {
      brackets.push(match[1]);
    }

    brackets.forEach(bracketContent => {
      const content = bracketContent.trim();
      if (!content) return;

      const colonIndex = content.indexOf(':');
      const possibleSectionPart = colonIndex !== -1 ? content.substring(0, colonIndex).trim() : content;

      if (isSectionKeyword(possibleSectionPart)) {
        lineHasSectionLabel = true;
        const sectionWords = possibleSectionPart.toLowerCase().split(/\s+/);
        const normalizedSectionWords = sectionWords.map(w => {
          if (w === 'prechorus') return 'Pre-Chorus';
          if (w === 'pre-chorus') return 'Pre-Chorus';
          return w.charAt(0).toUpperCase() + w.slice(1);
        });
        detectedSectionName = `[${normalizedSectionWords.join(' ')}]`;

        if (colonIndex !== -1) {
          const notePart = content.substring(colonIndex + 1).trim();
          if (notePart) {
            lineNotes.push(notePart);
          }
        }
      } else {
        lineNotes.push(content);
      }
    });

    if (lineHasSectionLabel) {
      currentSection = {
        sectionName: detectedSectionName,
        notes: []
      };
      sectionsList.push(currentSection);
    }

    if (lineNotes.length > 0) {
      if (!currentSection) {
        currentSection = {
          sectionName: "[General]",
          notes: []
        };
        sectionsList.push(currentSection);
      }
      currentSection.notes.push(...lineNotes);
    }
  });

  return sectionsList;
}
