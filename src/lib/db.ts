import Dexie, { type Table } from 'dexie';
import type { Song, Setlist } from '../types';

export interface Tombstone {
  id: string;
  type: 'song' | 'setlist';
  deletedAt: number;
}

export class SongBinderDB extends Dexie {
  songs!: Table<Song, string>;
  setlists!: Table<Setlist, string>;
  tombstones!: Table<Tombstone, string>;

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
  }
}

export const db = new SongBinderDB();

/**
 * Records a deletion tombstone in local IndexedDB so deletions are remembered
 * across pulls and can be safely synchronized to the cloud.
 */
export async function recordTombstone(id: string, type: 'song' | 'setlist'): Promise<void> {
  try {
    const cleanId = String(id).trim();
    if (!cleanId) return;
    await db.tombstones.put({
      id: cleanId,
      type,
      deletedAt: Date.now()
    });
  } catch (err) {
    console.warn('[DB] Failed to record tombstone:', err);
  }
}

/**
 * Clears a tombstone when a song or setlist is re-created or restored locally.
 */
export async function clearTombstone(id: string): Promise<void> {
  try {
    const cleanId = String(id).trim();
    if (!cleanId) return;
    await db.tombstones.delete(cleanId);
  } catch (err) {
    console.warn('[DB] Failed to clear tombstone:', err);
  }
}
