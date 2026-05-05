export type Song = {
  id: string;
  title: string;
  lyrics: string;
  createdAt: number;
  updatedAt: number;
  metadata: {
    key?: string;
    tempo?: number;
    timeSignature?: string;
    notes?: string;
    tags?: string[];
    fontSize?: number;
    scrollSpeed?: number;
    autoScroll?: boolean;
    autoScrollDelay?: number;
    textAlign?: 'left' | 'center';
    performanceNotes?: string;
    productionNotes?: string; // Kept for backwards compatibility
    layoutMode?: 'standard' | 'split';
    fontFamily?: 'sans' | 'serif' | 'mono';
  };
};

export type Setlist = {
  id: string;
  name: string;
  songIds: string[];
  createdAt: number;
  updatedAt: number;
};
