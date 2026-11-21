import { useLiveQuery } from "dexie-react-hooks";
import { db, createSetlistLocal, deleteSetlistLocal } from "../lib/db";

export function useSetlists() {
  const setlists = useLiveQuery(() => db.setlists.orderBy('updatedAt').reverse().toArray());

  const addSetlist = async (name: string) => {
    return createSetlistLocal(name, []);
  };

  const deleteSetlist = async (id: string) => {
    await deleteSetlistLocal(id);
  };

  const duplicateSetlist = async (id: string, newName: string) => {
    const existing = await db.setlists.get(id);
    if (!existing) return null;
    return createSetlistLocal(newName, existing.songIds);
  };

  return { setlists, addSetlist, deleteSetlist, duplicateSetlist };
}
