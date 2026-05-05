import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import type { Song } from "../types";
import { v4 as uuidv4 } from "uuid";
import Fuse from "fuse.js";

type SortBy = 'title' | 'updatedAt';
type SortOrder = 'asc' | 'desc';

export function useSongs(searchQuery: string = "", sortBy: SortBy = 'title', sortOrder: SortOrder = 'asc') {
  const songs = useLiveQuery(
    async () => {
      const allSongs = await db.songs.toArray();
      
      let filteredSongs = allSongs;
      if (searchQuery) {
        const fuse = new Fuse(allSongs, {
          keys: ['title', 'lyrics'],
          threshold: 0.3,
        });
        filteredSongs = fuse.search(searchQuery).map(r => r.item);
      }

      return filteredSongs.sort((a, b) => {
        let comparison = 0;
        if (sortBy === 'title') {
          comparison = a.title.localeCompare(b.title);
        } else if (sortBy === 'updatedAt') {
          comparison = (a.updatedAt || 0) - (b.updatedAt || 0);
        }
        return sortOrder === 'asc' ? comparison : -comparison;
      });
    },
    [searchQuery, sortBy, sortOrder]
  );

  const addSong = async (title: string, lyrics: string = "") => {
    const newSong: Song = {
      id: uuidv4(),
      title,
      lyrics,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {}
    };
    await db.songs.add(newSong);
    return newSong;
  };

  const deleteSong = async (id: string) => {
    await db.songs.delete(id);
    // Also remove from all setlists
    const setlists = await db.setlists.toArray();
    for (const setlist of setlists) {
      if (setlist.songIds.includes(id)) {
        await db.setlists.update(setlist.id, {
          songIds: setlist.songIds.filter(sId => sId !== id),
          updatedAt: Date.now()
        });
      }
    }
  };

  return { songs, addSong, deleteSong };
}
