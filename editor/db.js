// Minimal IndexedDB bridge for the editor to share songs with the main app
// Requires ../lib/idb.min.js to be loaded first

(function(){
  const DB_NAME = 'hrr-setlist-db';
  const DB_VERSION = 2;
  const REQUIRED_STORES = ['songs', 'setlists', 'meta'];
  let _db;
  let _dbWasReset = false;

  const hasRequiredStores = (db) =>
    REQUIRED_STORES.every((name) => db.objectStoreNames.contains(name));

  const upgradeSchema = (db) => {
    if (!db.objectStoreNames.contains('songs')) {
      const songs = db.createObjectStore('songs', { keyPath: 'id' });
      try { songs.createIndex('title', 'title', { unique: false }); } catch {}
    }
    if (!db.objectStoreNames.contains('setlists')) {
      const setlists = db.createObjectStore('setlists', { keyPath: 'id' });
      try { setlists.createIndex('name', 'name', { unique: false }); } catch {}
    }
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta');
    }
  };

  async function backupExistingData(db) {
    const backup = { songs: [], setlists: [] };
    try {
      const storeNames = Array.from(db.objectStoreNames);
      if (storeNames.includes('songs')) backup.songs = await db.getAll('songs');
      if (storeNames.includes('setlists')) backup.setlists = await db.getAll('setlists');
    } catch (e) {
      console.warn('Failed to backup data before DB reset', e);
    }
    return backup;
  }

  async function restoreBackup(db, backup) {
    if (!backup) return;
    try {
      if (Array.isArray(backup.songs) && backup.songs.length) {
        const tx = db.transaction('songs', 'readwrite');
        for (const song of backup.songs) await tx.store.put(song);
        await tx.done;
      }
    } catch (e) {
      console.warn('Failed to restore songs after DB reset', e);
    }
    try {
      if (Array.isArray(backup.setlists) && backup.setlists.length) {
        const tx = db.transaction('setlists', 'readwrite');
        for (const setlist of backup.setlists) await tx.store.put(setlist);
        await tx.done;
      }
    } catch (e) {
      console.warn('Failed to restore setlists after DB reset', e);
    }
  }

  async function open() {
    if (_db) return _db;
    // Mirror main app schema as closely as possible
    _db = await idb.openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        upgradeSchema(db);
      }
    });
    if (!hasRequiredStores(_db)) {
      const backup = await backupExistingData(_db);
      try {
        _db.close();
        await idb.deleteDB(DB_NAME);
        _db = await idb.openDB(DB_NAME, DB_VERSION, { upgrade: upgradeSchema });
        _dbWasReset = true;
      } catch {}
      try {
        await restoreBackup(_db, backup);
      } catch (e) {
        console.warn('Failed to restore DB backup', e);
      }
    }
    return _db;
  }

  async function getAllSongs() {
    const db = await open();
    const rows = await db.getAll('songs');
    return Array.isArray(rows) ? rows : [];
  }

  async function putSong(song) {
    const db = await open();
    return db.put('songs', song);
  }

  async function putSongs(songs) {
    const db = await open();
    const tx = db.transaction('songs', 'readwrite');
    for (const s of songs) await tx.store.put(s);
    await tx.done;
  }

  async function deleteSong(id) {
    const db = await open();
    return db.delete('songs', id);
  }

  window.EditorDB = { getAllSongs, putSong, putSongs, deleteSong, wasReset: () => _dbWasReset };
})();
