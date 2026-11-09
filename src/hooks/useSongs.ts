import { useMemo, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import type { Song } from "../types";
import { v4 as uuidv4 } from "uuid";
import Fuse from "fuse.js";

type SortBy = 'title' | 'updatedAt';
type SortOrder = 'asc' | 'desc';

export function useSongs(
  searchQuery: string = "",
  sortBy: SortBy = 'title',
  sortOrder: SortOrder = 'asc'
) {
  // Query Dexie once for all songs and subscribe only to database modifications.
  // Avoid re-querying IndexedDB and deserializing full lyrics on every keystroke.
  const allSongs = useLiveQuery(() => db.songs.toArray(), []);

  // Pre-build and memoize the Fuse.js search index only when allSongs changes.
  const fuse = useMemo(() => {
    if (!allSongs || allSongs.length === 0) return null;
    return new Fuse(allSongs, {
      keys: [
        { name: 'title', weight: 0.8 },
        { name: 'lyrics', weight: 0.2 },
      ],
      threshold: 0.35,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }, [allSongs]);

  // Synchronous, zero-latency in-memory search and relevance sorting
  const songs = useMemo(() => {
    if (!allSongs) return undefined;

    const trimmedQuery = searchQuery.trim().toLowerCase();

    // If no search query, perform simple sorting
    if (!trimmedQuery) {
      return [...allSongs].sort((a, b) => {
        let comparison = 0;
        if (sortBy === 'title') {
          comparison = a.title.localeCompare(b.title);
        } else if (sortBy === 'updatedAt') {
          comparison = (a.updatedAt || 0) - (b.updatedAt || 0);
        }
        return sortOrder === 'asc' ? comparison : -comparison;
      });
    }

    // High-performance tiered matching:
    // Tier 1: Exact prefix matches on title (e.g. "Three Buck Interlude")
    // Tier 2: Exact substring matches in title (e.g. "Court Of The Moon (Still Three Bucks Shy)")
    // Tier 3: Fuzzy matches and lyrics matches via Fuse.js
    const prefixMatches: Song[] = [];
    const substringMatches: Song[] = [];

    for (const song of allSongs) {
      const lowerTitle = (song.title || "").toLowerCase();
      if (lowerTitle.startsWith(trimmedQuery)) {
        prefixMatches.push(song);
      } else if (lowerTitle.includes(trimmedQuery)) {
        substringMatches.push(song);
      }
    }

    // Sort prefix & substring matches alphabetically
    prefixMatches.sort((a, b) => a.title.localeCompare(b.title));
    substringMatches.sort((a, b) => a.title.localeCompare(b.title));

    const matchedIds = new Set([
      ...prefixMatches.map(s => s.id),
      ...substringMatches.map(s => s.id)
    ]);

    // Fuzzy & lyrics match for anything else (typos or matching words in lyrics)
    let fuzzyMatches: Song[] = [];
    if (fuse && trimmedQuery.length >= 2) {
      const results = fuse.search(trimmedQuery);
      fuzzyMatches = results
        .map(r => r.item)
        .filter(song => !matchedIds.has(song.id));
    }

    return [...prefixMatches, ...substringMatches, ...fuzzyMatches];
  }, [allSongs, fuse, searchQuery, sortBy, sortOrder]);

  const addSong = useCallback(async (title: string, lyrics: string = "") => {
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
  }, []);

  const deleteSong = useCallback(async (id: string) => {
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
  }, []);

  return { songs, addSong, deleteSong };
}
