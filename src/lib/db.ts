import Dexie, { type Table } from 'dexie';
import type { Song, Setlist } from '../types';

export class SongBinderDB extends Dexie {
  songs!: Table<Song, string>;
  setlists!: Table<Setlist, string>;

  constructor() {
    super('SongBinderDB');
    this.version(1).stores({
      songs: 'id, title, isFavorite, createdAt, updatedAt',
      setlists: 'id, name, createdAt, updatedAt'
    });
  }
}

export const db = new SongBinderDB();
