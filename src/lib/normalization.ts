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
    "instrumental", "refrain", "reprise", "outro"
  ];
  const keywordRegex = new RegExp(`^\\W*(${sectionKeywords.join('|')})\\b(?:\\s+([0-9]+|[a-zA-Z])\\b)?`, 'i');

  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length < 50) {
      const match = trimmed.match(keywordRegex);
      if (match) {
        let keyword = match[1].toLowerCase();
        if (keyword === 'prechorus') keyword = 'pre-chorus';
        keyword = keyword.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
        const identifier = match[2] ? ` ${match[2].toUpperCase()}` : '';
        return `[${keyword}${identifier}]`;
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
    "instrumental", "refrain", "reprise", "outro"
  ];
  const keywordRegex = new RegExp(`^\\W*(${sectionKeywords.join('|')})\\b(?:\\s+([0-9]+|[a-zA-Z])\\b)?`, 'i');

  const notes: string[] = [];
  const lines = text.split('\n');
  const cleanedLines = lines.map(line => {
    let currentLine = line;
    // Find all [...] blocks
    const bracketRegex = /\[(.*?)\]/g;
    let match;
    
    // We iterate backwards to replace without affecting indices, 
    // or just use replace with a function.
    currentLine = currentLine.replace(bracketRegex, (fullMatch, content) => {
      // Check if this fullMatch (e.g. "[Verse 1]") looks like a section label
      // To be a section label, it should typically be the whole line or start with a keyword.
      // But here we are looking at a block within a line.
      
      const isSection = keywordRegex.test(content.trim());
      
      if (isSection) {
        return fullMatch; // Keep it
      } else {
        notes.push(content.trim());
        return ""; // Remove it
      }
    });

    return currentLine;
  });

  return {
    cleanedText: cleanedLines.join('\n').replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(),
    performanceNotes: notes.length > 0 ? notes.join('; ') : null
  };
}
