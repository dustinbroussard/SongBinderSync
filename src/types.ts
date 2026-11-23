export type SongMetadata = {
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
  /** Internal marker for a preserved conflict/restoration version; never part of the song title. */
  syncConflictStatus?: 'conflict' | 'restored';
};

export type Song = {
  id: string;
  title: string;
  lyrics: string;
  createdAt: number;
  updatedAt: number;
  bpm?: number;
  metadata: SongMetadata;
  // Phase 2 sync tracking fields (optional for backwards compatibility with imports/exports)
  remoteId?: string;
  baseVersion?: number;
  serverUpdatedAt?: string;
  dirty?: 0 | 1;
  /** Stable identity for a conflict/restoration copy; survives outbox cleanup. */
  syncConflictKey?: string;
};

export type Setlist = {
  id: string;
  name: string;
  songIds: string[];
  createdAt: number;
  updatedAt: number;
  // Phase 2 sync tracking fields
  remoteId?: string;
  baseVersion?: number;
  serverUpdatedAt?: string;
  dirty?: 0 | 1;
  /** Stable identity for a conflict/restoration copy; survives outbox cleanup. */
  syncConflictKey?: string;
};

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'error'
  | 'auth_required'
  | 'account_mismatch'
  | 'conflict';

export type AccountMismatchInfo = {
  previousUserId: string;
  newUserId: string;
  localSongCount: number;
  localSetlistCount: number;
  pendingCount: number;
};

export type SyncStateSnapshot = {
  status: SyncStatus;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncedAt: number | null;
  lastSyncVersion: number;
  lastError: string | null;
  lastConflictCount: number;
  schemaWarning: string | null;
  accountMismatch: AccountMismatchInfo | null;
};
