import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import type { Setlist } from "../types";
import { v4 as uuidv4 } from "uuid";

export function useSetlists() {
  const setlists = useLiveQuery(() => db.setlists.orderBy('updatedAt').reverse().toArray());

  const addSetlist = async (name: string) => {
    const newSetlist: Setlist = {
      id: uuidv4(),
      name,
      songIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.setlists.add(newSetlist);
    return newSetlist;
  };

  const deleteSetlist = async (id: string) => {
    await db.setlists.delete(id);
  };

  const duplicateSetlist = async (id: string, newName: string) => {
    const existing = await db.setlists.get(id);
    if (!existing) return null;
    
    const newSetlist: Setlist = {
      id: uuidv4(),
      name: newName,
      songIds: [...existing.songIds],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.setlists.add(newSetlist);
    return newSetlist;
  };

  return { setlists, addSetlist, deleteSetlist, duplicateSetlist };
}
