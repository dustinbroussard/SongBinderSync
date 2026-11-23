import Dexie, { type Table } from 'dexie';
import { v4 as uuidv4 } from 'uuid';
import type { Song, Setlist } from '../types';

export type TombstoneBaselineStatus =
  | 'ready'
  | 'local_only'
  | 'missing_baseline'
  | 'conflict_blocked';

export interface Tombstone {
  id: string;
  type: 'song' | 'setlist';
  deletedAt: number;
  remoteId?: string;
  baseVersion?: number;
  serverUpdatedAt?: string;
  titleSnapshot?: string;
  baselineStatus?: TombstoneBaselineStatus;
  conflictKey?: string;
  lastError?: string;
}

export interface SyncOutboxItem {
  key: string; // `${entityType}:${entityId}`
  entityType: 'song' | 'setlist';
  entityId: string;
  op: 'upsert' | 'delete';
  queuedAt: number;
  attempts: number;
  lastError?: string;
  conflictKey?: string;
  remoteId?: string;
  baseVersion?: number;
  status?: 'pending' | 'blocked_conflict' | 'blocked_missing_baseline';
}

export interface SyncMetaRecord {
  id: string; // 'state'
  activeUserId: string | null;
  lastSyncVersion: number;
  lastSyncedAt: number | null;
  lastReconciledAt: number | null;
}

export class SongBinderDB extends Dexie {
  songs!: Table<Song, string>;
  setlists!: Table<Setlist, string>;
  tombstones!: Table<Tombstone, string>;
  syncOutbox!: Table<SyncOutboxItem, string>;
  syncMeta!: Table<SyncMetaRecord, string>;

  constructor() {
    super('SongBinderDB');
    this.version(1).stores({
      songs: 'id, title, isFavorite, createdAt, updatedAt',
      setlists: 'id, name, createdAt, updatedAt'
    });
    this.version(2).stores({
      songs: 'id, title, isFavorite, createdAt, updatedAt',
      setlists: 'id, name, createdAt, updatedAt',
      tombstones: 'id, type, deletedAt'
    });
    this.version(3)
      .stores({
        songs: 'id, title, createdAt, updatedAt, dirty, remoteId',
        setlists: 'id, name, createdAt, updatedAt, dirty, remoteId',
        tombstones: 'id, type, deletedAt',
        syncOutbox: 'key, entityType, entityId, queuedAt',
        syncMeta: 'id'
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        await tx
          .table('songs')
          .toCollection()
          .modify((song: any) => {
            if (song.dirty === undefined) song.dirty = 1;
          });
        await tx
          .table('setlists')
          .toCollection()
          .modify((setlist: any) => {
            if (setlist.dirty === undefined) setlist.dirty = 1;
          });

        const songs = await tx.table('songs').toArray();
        const setlists = await tx.table('setlists').toArray();
        const tombstones = await tx.table('tombstones').toArray();
        const outboxTable = tx.table('syncOutbox');

        const tombSet = new Set(tombstones.map((t: Tombstone) => `${t.type}:${t.id}`));

        for (const song of songs) {
          if (!tombSet.has(`song:${song.id}`)) {
            await outboxTable.put({
              key: `song:${song.id}`,
              entityType: 'song',
              entityId: song.id,
              op: 'upsert',
              queuedAt: song.updatedAt || now,
              attempts: 0
            });
          }
        }

        for (const setlist of setlists) {
          if (!tombSet.has(`setlist:${setlist.id}`)) {
            await outboxTable.put({
              key: `setlist:${setlist.id}`,
              entityType: 'setlist',
              entityId: setlist.id,
              op: 'upsert',
              queuedAt: setlist.updatedAt || now,
              attempts: 0
            });
          }
        }

        for (const tomb of tombstones) {
          await outboxTable.put({
            key: `${tomb.type}:${tomb.id}`,
            entityType: tomb.type,
            entityId: tomb.id,
            op: 'delete',
            queuedAt: tomb.deletedAt || now,
            attempts: 0
          });
        }
      });

    // Version 4: remove internal recovery labels from song/setlist names.
    // Preserve the recovered records and queue the clean names for cloud sync.
    this.version(4)
      .stores({
        songs: 'id, title, createdAt, updatedAt, dirty, remoteId',
        setlists: 'id, name, createdAt, updatedAt, dirty, remoteId',
        tombstones: 'id, type, deletedAt',
        syncOutbox: 'key, entityType, entityId, queuedAt',
        syncMeta: 'id'
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const suffix = /\s+\(Restored Copy\)$/;
        const songs = await tx.table('songs').toArray();
        const setlists = await tx.table('setlists').toArray();

        for (const song of songs as any[]) {
          if (typeof song.title !== 'string' || !suffix.test(song.title)) continue;
          song.title = song.title.replace(suffix, '').trim() || 'Untitled Song';
          song.updatedAt = now;
          song.dirty = 1;
          await tx.table('songs').put(song);
          await tx.table('syncOutbox').put({
            key: `song:${song.id}`,
            entityType: 'song',
            entityId: song.id,
            op: 'upsert',
            queuedAt: now,
            attempts: 0
          });
        }

        for (const setlist of setlists as any[]) {
          if (typeof setlist.name !== 'string' || !suffix.test(setlist.name)) continue;
          setlist.name = setlist.name.replace(suffix, '').trim() || 'Untitled Setlist';
          setlist.updatedAt = now;
          setlist.dirty = 1;
          setlist.songBinderRecoveryLabelCleanup = true;
          await tx.table('setlists').put(setlist);
          await tx.table('syncOutbox').put({
            key: `setlist:${setlist.id}`,
            entityType: 'setlist',
            entityId: setlist.id,
            op: 'upsert',
            queuedAt: now,
            attempts: 0
          });
        }
      });

    // Version 5: clear the temporary recovery marker without deleting records.
    // Similar names and overlapping song lists are not proof that two setlists are duplicates.
    // Preserve both records and let the user decide; migrations must never infer destructive merges.
    this.version(5)
      .stores({
        songs: 'id, title, createdAt, updatedAt, dirty, remoteId',
        setlists: 'id, name, createdAt, updatedAt, dirty, remoteId',
        tombstones: 'id, type, deletedAt',
        syncOutbox: 'key, entityType, entityId, queuedAt',
        syncMeta: 'id'
      })
      .upgrade(async (tx) => {
        const setlists = await tx.table('setlists').toArray() as any[];
        for (const candidate of setlists) {
          if (candidate.songBinderRecoveryLabelCleanup !== true) continue;
          delete candidate.songBinderRecoveryLabelCleanup;
          await tx.table('setlists').put(candidate);
        }
      });
  }
}

export const db = new SongBinderDB();

// Lightweight listener system so SyncEngine can schedule debounced background syncs
type LocalMutationListener = () => void;
const mutationListeners = new Set<LocalMutationListener>();

export function onLocalMutation(listener: LocalMutationListener): () => void {
  mutationListeners.add(listener);
  return () => {
    mutationListeners.delete(listener);
  };
}

export function notifyLocalMutation() {
  for (const listener of mutationListeners) {
    try {
      listener();
    } catch (err) {
      console.warn('[DB] Local mutation listener failed:', err);
    }
  }
}

/**
 * Records a deletion tombstone in local IndexedDB so deletions are remembered
 * across pulls and can be safely synchronized to the cloud.
 */
export async function recordTombstone(id: string, type: 'song' | 'setlist'): Promise<void> {
  const cleanId = String(id).trim();
  if (!cleanId) return;
  await db.tombstones.put({
    id: cleanId,
    type,
    deletedAt: Date.now()
  });
}

/**
 * Clears a tombstone when a song or setlist is re-created or restored locally.
 */
export async function clearTombstone(id: string): Promise<void> {
  const cleanId = String(id).trim();
  if (!cleanId) return;
  await db.tombstones.delete(cleanId);
}

// -----------------------------------------------------------------------------
// Transactional Local Write Helpers (Guarantee updatedAt, dirty=1, & Outbox)
// -----------------------------------------------------------------------------

export async function createSongLocal(title: string, lyrics: string = ''): Promise<Song> {
  const now = Date.now();
  const newSong: Song = {
    id: uuidv4(),
    title,
    lyrics,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    dirty: 1
  };

  await db.transaction('rw', db.songs, db.tombstones, db.syncOutbox, async () => {
    await db.songs.add(newSong);
    await db.tombstones.delete(newSong.id);
    await db.syncOutbox.put({
      key: `song:${newSong.id}`,
      entityType: 'song',
      entityId: newSong.id,
      op: 'upsert',
      queuedAt: now,
      attempts: 0
    });
  });

  notifyLocalMutation();
  return newSong;
}

export async function updateSongLocal(
  id: string,
  updater: (current: Song) => Partial<Song>
): Promise<Song | null> {
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;

  let updatedSong: Song | null = null;

  await db.transaction('rw', db.songs, db.tombstones, db.syncOutbox, async () => {
    const existing = await db.songs.get(cleanId);
    if (!existing) return;

    const now = Date.now();
    const patch = updater(existing);
    updatedSong = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: now,
      dirty: 1
    };

    await db.songs.put(updatedSong);
    await db.tombstones.delete(cleanId);
    await db.syncOutbox.put({
      key: `song:${cleanId}`,
      entityType: 'song',
      entityId: cleanId,
      op: 'upsert',
      queuedAt: now,
      attempts: 0
    });
  });

  if (updatedSong) {
    notifyLocalMutation();
  }
  return updatedSong;
}

export async function deleteSongLocal(id: string): Promise<void> {
  const cleanId = String(id || '').trim();
  if (!cleanId) return;

  await db.transaction('rw', db.songs, db.setlists, db.tombstones, db.syncOutbox, async () => {
    const now = Date.now();
    const existing = await db.songs.get(cleanId);
    const existingTomb = existing ? undefined : await db.tombstones.get(cleanId);

    const remoteId = existing?.remoteId
      ? String(existing.remoteId).trim()
      : existingTomb?.remoteId;
    const rawBase = Number(existing ? existing.baseVersion : existingTomb?.baseVersion);
    const baseVersion = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : undefined;
    const baselineStatus: TombstoneBaselineStatus = existing
      ? remoteId
        ? baseVersion
          ? 'ready'
          : 'missing_baseline'
        : 'local_only'
      : existingTomb?.baselineStatus || (remoteId && baseVersion ? 'ready' : 'missing_baseline');

    await db.songs.delete(cleanId);
    await db.tombstones.put({
      id: cleanId,
      type: 'song',
      deletedAt: now,
      remoteId,
      baseVersion,
      serverUpdatedAt: existing?.serverUpdatedAt ?? existingTomb?.serverUpdatedAt,
      titleSnapshot: existing?.title ?? existingTomb?.titleSnapshot,
      baselineStatus,
    });
    await db.syncOutbox.put({
      key: `song:${cleanId}`,
      entityType: 'song',
      entityId: cleanId,
      op: 'delete',
      queuedAt: now,
      attempts: 0,
      remoteId,
      baseVersion,
      status: 'pending',
    });

    const setlists = await db.setlists.toArray();
    for (const setlist of setlists) {
      if (setlist.songIds.includes(cleanId)) {
        const updatedSetlist: Setlist = {
          ...setlist,
          songIds: setlist.songIds.filter((sId) => sId !== cleanId),
          updatedAt: now,
          dirty: 1
        };
        await db.setlists.put(updatedSetlist);
        await db.syncOutbox.put({
          key: `setlist:${setlist.id}`,
          entityType: 'setlist',
          entityId: setlist.id,
          op: 'upsert',
          queuedAt: now,
          attempts: 0
        });
      }
    }
  });

  notifyLocalMutation();
}

export async function clearAllSongsLocal(): Promise<void> {
  await db.transaction('rw', db.songs, db.setlists, db.tombstones, db.syncOutbox, async () => {
    const now = Date.now();
    const allSongs = await db.songs.toArray();

    if (allSongs.length > 0) {
      await db.tombstones.bulkPut(
        allSongs.map((s) => {
          const remoteId = s.remoteId ? String(s.remoteId).trim() : undefined;
          const rawBase = Number(s.baseVersion);
          const baseVersion = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : undefined;
          const baselineStatus: TombstoneBaselineStatus = remoteId
            ? baseVersion
              ? 'ready'
              : 'missing_baseline'
            : 'local_only';
          return {
            id: s.id,
            type: 'song' as const,
            deletedAt: now,
            remoteId,
            baseVersion,
            serverUpdatedAt: s.serverUpdatedAt,
            titleSnapshot: s.title,
            baselineStatus,
          };
        })
      );
      await db.syncOutbox.bulkPut(
        allSongs.map((s) => {
          const remoteId = s.remoteId ? String(s.remoteId).trim() : undefined;
          const rawBase = Number(s.baseVersion);
          const baseVersion = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : undefined;
          return {
            key: `song:${s.id}`,
            entityType: 'song' as const,
            entityId: s.id,
            op: 'delete' as const,
            queuedAt: now,
            attempts: 0,
            remoteId,
            baseVersion,
            status: 'pending' as const,
          };
        })
      );
    }

    await db.songs.clear();

    const setlists = await db.setlists.toArray();
    const modifiedSetlists: Setlist[] = [];
    const setlistOutbox: SyncOutboxItem[] = [];

    for (const setlist of setlists) {
      if (setlist.songIds.length > 0) {
        modifiedSetlists.push({
          ...setlist,
          songIds: [],
          updatedAt: now,
          dirty: 1
        });
        setlistOutbox.push({
          key: `setlist:${setlist.id}`,
          entityType: 'setlist',
          entityId: setlist.id,
          op: 'upsert',
          queuedAt: now,
          attempts: 0
        });
      }
    }

    if (modifiedSetlists.length > 0) {
      await db.setlists.bulkPut(modifiedSetlists);
      await db.syncOutbox.bulkPut(setlistOutbox);
    }
  });

  notifyLocalMutation();
}

export async function createSetlistLocal(name: string, songIds: string[] = []): Promise<Setlist> {
  const now = Date.now();
  const newSetlist: Setlist = {
    id: uuidv4(),
    name,
    songIds: [...songIds],
    createdAt: now,
    updatedAt: now,
    dirty: 1
  };

  await db.transaction('rw', db.setlists, db.tombstones, db.syncOutbox, async () => {
    await db.setlists.add(newSetlist);
    await db.tombstones.delete(newSetlist.id);
    await db.syncOutbox.put({
      key: `setlist:${newSetlist.id}`,
      entityType: 'setlist',
      entityId: newSetlist.id,
      op: 'upsert',
      queuedAt: now,
      attempts: 0
    });
  });

  notifyLocalMutation();
  return newSetlist;
}

export async function updateSetlistLocal(
  id: string,
  updater: (current: Setlist) => Partial<Setlist>
): Promise<Setlist | null> {
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;

  let updatedSetlist: Setlist | null = null;

  await db.transaction('rw', db.setlists, db.tombstones, db.syncOutbox, async () => {
    const existing = await db.setlists.get(cleanId);
    if (!existing) return;

    const now = Date.now();
    const patch = updater(existing);
    updatedSetlist = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: now,
      dirty: 1
    };

    await db.setlists.put(updatedSetlist);
    await db.tombstones.delete(cleanId);
    await db.syncOutbox.put({
      key: `setlist:${cleanId}`,
      entityType: 'setlist',
      entityId: cleanId,
      op: 'upsert',
      queuedAt: now,
      attempts: 0
    });
  });

  if (updatedSetlist) {
    notifyLocalMutation();
  }
  return updatedSetlist;
}

export async function deleteSetlistLocal(id: string): Promise<void> {
  const cleanId = String(id || '').trim();
  if (!cleanId) return;

  await db.transaction('rw', db.setlists, db.tombstones, db.syncOutbox, async () => {
    const now = Date.now();
    const existing = await db.setlists.get(cleanId);
    const existingTomb = existing ? undefined : await db.tombstones.get(cleanId);

    const remoteId = existing?.remoteId
      ? String(existing.remoteId).trim()
      : existingTomb?.remoteId;
    const rawBase = Number(existing ? existing.baseVersion : existingTomb?.baseVersion);
    const baseVersion = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : undefined;
    const baselineStatus: TombstoneBaselineStatus = existing
      ? remoteId
        ? baseVersion
          ? 'ready'
          : 'missing_baseline'
        : 'local_only'
      : existingTomb?.baselineStatus || (remoteId && baseVersion ? 'ready' : 'missing_baseline');

    await db.setlists.delete(cleanId);
    await db.tombstones.put({
      id: cleanId,
      type: 'setlist',
      deletedAt: now,
      remoteId,
      baseVersion,
      serverUpdatedAt: existing?.serverUpdatedAt ?? existingTomb?.serverUpdatedAt,
      titleSnapshot: existing?.name ?? existingTomb?.titleSnapshot,
      baselineStatus,
    });
    await db.syncOutbox.put({
      key: `setlist:${cleanId}`,
      entityType: 'setlist',
      entityId: cleanId,
      op: 'delete',
      queuedAt: now,
      attempts: 0,
      remoteId,
      baseVersion,
      status: 'pending',
    });
  });

  notifyLocalMutation();
}

export async function clearAllSetlistsLocal(): Promise<void> {
  await db.transaction('rw', db.setlists, db.tombstones, db.syncOutbox, async () => {
    const now = Date.now();
    const allSetlists = await db.setlists.toArray();

    if (allSetlists.length > 0) {
      await db.tombstones.bulkPut(
        allSetlists.map((sl) => {
          const remoteId = sl.remoteId ? String(sl.remoteId).trim() : undefined;
          const rawBase = Number(sl.baseVersion);
          const baseVersion = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : undefined;
          const baselineStatus: TombstoneBaselineStatus = remoteId
            ? baseVersion
              ? 'ready'
              : 'missing_baseline'
            : 'local_only';
          return {
            id: sl.id,
            type: 'setlist' as const,
            deletedAt: now,
            remoteId,
            baseVersion,
            serverUpdatedAt: sl.serverUpdatedAt,
            titleSnapshot: sl.name,
            baselineStatus,
          };
        })
      );
      await db.syncOutbox.bulkPut(
        allSetlists.map((sl) => {
          const remoteId = sl.remoteId ? String(sl.remoteId).trim() : undefined;
          const rawBase = Number(sl.baseVersion);
          const baseVersion = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : undefined;
          return {
            key: `setlist:${sl.id}`,
            entityType: 'setlist' as const,
            entityId: sl.id,
            op: 'delete' as const,
            queuedAt: now,
            attempts: 0,
            remoteId,
            baseVersion,
            status: 'pending' as const,
          };
        })
      );
    }

    await db.setlists.clear();
  });

  notifyLocalMutation();
}

export async function createSetlistWithNewSongsLocal(
  newSongs: Song[],
  setlist: Setlist
): Promise<void> {
  await db.transaction('rw', db.songs, db.setlists, db.tombstones, db.syncOutbox, async () => {
    const now = Date.now();
    if (newSongs.length > 0) {
      const dirtySongs = newSongs.map((s) => ({ ...s, dirty: 1 as const }));
      await db.songs.bulkAdd(dirtySongs);
      await db.tombstones.bulkDelete(dirtySongs.map((s) => s.id));
      await db.syncOutbox.bulkPut(
        dirtySongs.map((s) => ({
          key: `song:${s.id}`,
          entityType: 'song' as const,
          entityId: s.id,
          op: 'upsert' as const,
          queuedAt: now,
          attempts: 0
        }))
      );
    }

    const dirtySetlist: Setlist = { ...setlist, dirty: 1 };
    await db.setlists.add(dirtySetlist);
    await db.tombstones.delete(dirtySetlist.id);
    await db.syncOutbox.put({
      key: `setlist:${dirtySetlist.id}`,
      entityType: 'setlist',
      entityId: dirtySetlist.id,
      op: 'upsert',
      queuedAt: now,
      attempts: 0
    });
  });

  notifyLocalMutation();
}

export interface BackupImportSummary {
  added: number;
  matched: number;
  updated: number;
  sameTitleDifferentContent: number;
  setlists: number;
}

function normalizeSongText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function stableImportMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableImportMetadata);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Sync conflict status is app bookkeeping, not part of a song's content identity.
      .filter(([key, child]) => child !== undefined && key !== 'syncConflictStatus')
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, child]) => [key, stableImportMetadata(child)]));
  }
  return typeof value === 'string' ? value.normalize('NFKC') : value;
}

/**
 * Stable content identity for imports. Keep every metadata field in the identity:
 * notes, tags, performance notes, and production notes can all be meaningful song data.
 * Only normalize title whitespace/case and platform-specific lyric line endings.
 */
function songImportFingerprint(song: Song): string {
  const lyrics = String(song.lyrics ?? '').normalize('NFKC').replace(/\r\n?/g, '\n');
  return JSON.stringify([
    normalizeSongText(song.title),
    lyrics,
    typeof song.bpm === 'number' ? song.bpm : null,
    stableImportMetadata(song.metadata || {})
  ]);
}

export async function previewBackupImport(songs: Song[], setlists: Setlist[]): Promise<BackupImportSummary> {
  const existingSongs = await db.songs.toArray();
  const byId = new Map(existingSongs.map((song) => [song.id, song]));
  const byFingerprint = new Map<string, Song>();
  const byTitle = new Map<string, Song[]>();
  for (const song of existingSongs) {
    const fingerprint = songImportFingerprint(song);
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, song);
    const title = normalizeSongText(song.title);
    byTitle.set(title, [...(byTitle.get(title) || []), song]);
  }

  const seenIncoming = new Set<string>();
  const summary: BackupImportSummary = {
    added: 0,
    matched: 0,
    updated: 0,
    sameTitleDifferentContent: 0,
    setlists: setlists.length
  };

  for (const song of songs) {
    const existingById = byId.get(song.id);
    const fingerprint = songImportFingerprint(song);
    if (existingById) {
      const previousFingerprint = songImportFingerprint(existingById);
      if (previousFingerprint === fingerprint) {
        summary.matched++;
      } else {
        summary.updated++;
        if (byFingerprint.get(previousFingerprint)?.id === existingById.id) {
          byFingerprint.delete(previousFingerprint);
        }
        const previousTitle = normalizeSongText(existingById.title);
        const nextTitle = normalizeSongText(song.title);
        if (previousTitle !== nextTitle) {
          byTitle.set(previousTitle, (byTitle.get(previousTitle) || []).filter((candidate) => candidate.id !== existingById.id));
        }
      }
      // Treat the post-import version as the canonical match for later entries
      // in this same backup, including entries with different IDs.
      byFingerprint.set(fingerprint, existingById);
      const nextTitle = normalizeSongText(song.title);
      if (!(byTitle.get(nextTitle) || []).some((candidate) => candidate.id === existingById.id)) {
        byTitle.set(nextTitle, [...(byTitle.get(nextTitle) || []), song]);
      }
      seenIncoming.add(fingerprint);
      continue;
    }
    if (byFingerprint.has(fingerprint) || seenIncoming.has(fingerprint)) {
      summary.matched++;
      continue;
    }
    summary.added++;
    const normalizedTitle = normalizeSongText(song.title);
    if ((byTitle.get(normalizedTitle) || []).length > 0) {
      summary.sameTitleDifferentContent++;
    }
    byTitle.set(normalizedTitle, [...(byTitle.get(normalizedTitle) || []), song]);
    seenIncoming.add(fingerprint);
  }
  return summary;
}

export async function bulkImportBackupLocal(songs: Song[], setlists: Setlist[]): Promise<BackupImportSummary> {
  const summary: BackupImportSummary = {
    added: 0,
    matched: 0,
    updated: 0,
    sameTitleDifferentContent: 0,
    setlists: setlists.length
  };

  await db.transaction('rw', db.songs, db.setlists, db.tombstones, db.syncOutbox, async () => {
    const now = Date.now();
    const existingSongs = await db.songs.toArray();
    const existingById = new Map(existingSongs.map((song) => [song.id, song]));
    const existingByFingerprint = new Map<string, Song>();
    const existingByTitle = new Map<string, Song[]>();
    for (const song of existingSongs) {
      const fingerprint = songImportFingerprint(song);
      if (!existingByFingerprint.has(fingerprint)) existingByFingerprint.set(fingerprint, song);
      const title = normalizeSongText(song.title);
      existingByTitle.set(title, [...(existingByTitle.get(title) || []), song]);
    }

    const canonicalIdByImportedId = new Map<string, string>();
    const incomingByFingerprint = new Map<string, string>();
    const songsToWrite: Song[] = [];

    for (const song of songs) {
      const existingBySameId = existingById.get(song.id);
      const fingerprint = songImportFingerprint(song);
      if (existingBySameId) {
        canonicalIdByImportedId.set(song.id, existingBySameId.id);
        const previousFingerprint = songImportFingerprint(existingBySameId);
        if (previousFingerprint === fingerprint) {
          summary.matched++;
          existingByFingerprint.set(fingerprint, existingBySameId);
          incomingByFingerprint.set(fingerprint, existingBySameId.id);
        } else {
          // The ID is the stable identity for this record, so update it rather than
          // creating another song. Remove its old fingerprint before registering
          // the updated content as canonical for later entries in this backup.
          if (existingByFingerprint.get(previousFingerprint)?.id === existingBySameId.id) {
            existingByFingerprint.delete(previousFingerprint);
          }
          const importedMetadata = song.metadata || {};
          const existingConflictStatus = existingBySameId.metadata?.syncConflictStatus;
          const updatedSong: Song = {
            ...song,
            metadata: {
              ...importedMetadata,
              ...(importedMetadata.syncConflictStatus === undefined && existingConflictStatus
                ? { syncConflictStatus: existingConflictStatus }
                : {})
            },
            syncConflictKey: existingBySameId.syncConflictKey,
            remoteId: existingBySameId.remoteId,
            baseVersion: existingBySameId.baseVersion,
            serverUpdatedAt: existingBySameId.serverUpdatedAt,
            dirty: 1
          };
          songsToWrite.push(updatedSong);
          existingByFingerprint.set(fingerprint, updatedSong);
          incomingByFingerprint.set(fingerprint, updatedSong.id);
          summary.updated++;
        }
        continue;
      }

      const exactExisting = existingByFingerprint.get(fingerprint);
      if (exactExisting) {
        canonicalIdByImportedId.set(song.id, exactExisting.id);
        summary.matched++;
        continue;
      }

      const exactIncomingId = incomingByFingerprint.get(fingerprint);
      if (exactIncomingId) {
        canonicalIdByImportedId.set(song.id, exactIncomingId);
        summary.matched++;
        continue;
      }

      const normalizedTitle = normalizeSongText(song.title);
      if ((existingByTitle.get(normalizedTitle) || []).length > 0) {
        summary.sameTitleDifferentContent++;
      }
      canonicalIdByImportedId.set(song.id, song.id);
      incomingByFingerprint.set(fingerprint, song.id);
      songsToWrite.push({ ...song, dirty: 1 });
      summary.added++;
      existingByTitle.set(normalizedTitle, [
        ...(existingByTitle.get(normalizedTitle) || []),
        song
      ]);
    }

    if (songsToWrite.length > 0) {
      await db.songs.bulkPut(songsToWrite);
      await db.tombstones.bulkDelete(songsToWrite.map((song) => song.id));
      await db.syncOutbox.bulkPut(
        songsToWrite.map((song) => ({
          key: `song:${song.id}`,
          entityType: 'song' as const,
          entityId: song.id,
          op: 'upsert' as const,
          queuedAt: now,
          attempts: 0
        }))
      );
    }

    if (setlists.length > 0) {
      const existingSetlists = await db.setlists.bulkGet(setlists.map((setlist) => setlist.id));
      const mergedSetlists: Setlist[] = setlists.map((setlist, idx) => {
        const existing = existingSetlists[idx];
        const remappedSongIds = (setlist.songIds || []).map((songId) =>
          canonicalIdByImportedId.get(songId) || songId
        );
        return {
          ...setlist,
          songIds: [...new Set(remappedSongIds)],
          remoteId: existing?.remoteId,
          baseVersion: existing?.baseVersion,
          serverUpdatedAt: existing?.serverUpdatedAt,
          dirty: 1
        };
      });
      await db.setlists.bulkPut(mergedSetlists);
      await db.tombstones.bulkDelete(mergedSetlists.map((setlist) => setlist.id));
      await db.syncOutbox.bulkPut(
        mergedSetlists.map((setlist) => ({
          key: `setlist:${setlist.id}`,
          entityType: 'setlist' as const,
          entityId: setlist.id,
          op: 'upsert' as const,
          queuedAt: now,
          attempts: 0
        }))
      );
    }
  });

  notifyLocalMutation();
  return summary;
}
