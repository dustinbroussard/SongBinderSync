import { v4 as uuidv4 } from 'uuid';
import type { Setlist, Song, SyncStateSnapshot, SyncStatus } from '../types';
import { db, notifyLocalMutation, onLocalMutation, type SyncOutboxItem, type Tombstone } from './db';
import {
  fetchSetlistsForUser,
  fetchSongsByIdsForUser,
  fetchSongsForUser,
  getSession,
  inspectSetlistDeletionCandidateInSupabase,
  inspectSongDeletionCandidateInSupabase,
  isConfigured,
  refreshAuthSession,
  replaceSetlistSongsInSupabase,
  saveSetlistMetadataWithConcurrency,
  saveSongWithConcurrency,
  softDeleteSetlistConditionalInSupabase,
  softDeleteSongConditionalInSupabase,
  subscribeToUserSyncChanges,
  upsertProfile,
} from './supabase';

const DEFAULT_SNAPSHOT: SyncStateSnapshot = {
  status: 'idle',
  isSyncing: false,
  pendingCount: 0,
  lastSyncedAt: null,
  lastSyncVersion: 0,
  lastError: null,
  lastConflictCount: 0,
  schemaWarning: null,
  accountMismatch: null,
};

function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const entries = Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function songsContentEqual(a: Song, b: { title: string; lyrics: string; bpm?: number; metadata: Record<string, any> }, compareExtended: boolean): boolean {
  if ((a.title || '').trim() !== (b.title || '').trim()) return false;
  if ((a.lyrics || '') !== (b.lyrics || '')) return false;
  if (!compareExtended) return true;
  if ((a.bpm ?? undefined) !== (b.bpm ?? undefined)) return false;
  return stableStringify(a.metadata || {}) === stableStringify(b.metadata || {});
}

function setlistsContentEqual(a: Setlist, b: { name: string; songIds: string[] }): boolean {
  if ((a.name || '').trim() !== (b.name || '').trim()) return false;
  if (a.songIds.length !== b.songIds.length) return false;
  for (let i = 0; i < a.songIds.length; i++) {
    if (a.songIds[i] !== b.songIds[i]) return false;
  }
  return true;
}

function appendCopyLabel(base: string, fallback: string, label: 'Conflict Copy' | 'Restored Copy'): string {
  const clean = (base || '').trim() || fallback;
  if (label === 'Conflict Copy') {
    const suffix = ' (Conflict Copy)';
    return clean.endsWith(suffix) ? clean : `${clean}${suffix}`;
  }
  // Restored copies retain their content and separate IDs without a noisy title suffix.
  return clean.replace(/\s+\(Restored Copy\)$/, '');
}

class SyncEngine {
  private snapshot: SyncStateSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners = new Set<() => void>();
  private inFlightPromise: Promise<SyncStateSnapshot> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVisibilitySyncAt = 0;
  private currentUserId: string | null = null;
  private lifecycleCleanup: (() => void) | null = null;
  private realtimeCleanup: (() => void) | null = null;

  constructor() {
    onLocalMutation(() => {
      this.refreshPendingCount().catch(() => {});
      if (this.currentUserId) {
        this.scheduleSync('local_edit', 3000);
      }
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SyncStateSnapshot => {
    return this.snapshot;
  };

  private emit(patch: Partial<SyncStateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.warn('[SyncEngine] Snapshot listener error:', err);
      }
    }
  }

  async refreshPendingCount(): Promise<number> {
    try {
      const count = await db.syncOutbox.count();
      const meta = await db.syncMeta.get('state');
      this.emit({
        pendingCount: count,
        lastSyncedAt: meta?.lastSyncedAt ?? this.snapshot.lastSyncedAt,
        lastSyncVersion: meta?.lastSyncVersion ?? this.snapshot.lastSyncVersion,
      });
      return count;
    } catch {
      return this.snapshot.pendingCount;
    }
  }

  /**
   * Binds foreground PWA lifecycle listeners & Realtime nudge subscription for the active user.
   */
  startLifecycle(userId: string | null) {
    this.stopLifecycle();
    this.currentUserId = userId;
    this.refreshPendingCount().catch(() => {});

    if (!userId || !isConfigured()) {
      this.emit({
        status: navigator.onLine ? 'idle' : 'offline',
        accountMismatch: null,
        lastSyncedAt: null,
        lastSyncVersion: 0,
        lastConflictCount: 0,
        schemaWarning: null,
        lastError: null,
      });
      return;
    }

    const onOnline = () => {
      this.emit({ status: 'idle', lastError: null });
      this.scheduleSync('network_online', 500);
    };

    const onOffline = () => {
      this.emit({ status: 'offline' });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - this.lastVisibilitySyncAt;
        if (elapsed >= 30_000) {
          this.lastVisibilitySyncAt = Date.now();
          this.scheduleSync('visibility_resume', 400);
        }
      }
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    this.lifecycleCleanup = () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };

    this.realtimeCleanup = subscribeToUserSyncChanges(userId, () => {
      this.scheduleSync('realtime_nudge', 1200);
    });

    // Initial startup sync
    this.lastVisibilitySyncAt = Date.now();
    this.scheduleSync('startup', 300);
  }

  stopLifecycle() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.lifecycleCleanup) {
      this.lifecycleCleanup();
      this.lifecycleCleanup = null;
    }
    if (this.realtimeCleanup) {
      this.realtimeCleanup();
      this.realtimeCleanup = null;
    }
    this.currentUserId = null;
  }

  scheduleSync(reason: string, delayMs: number = 1500) {
    if (!this.currentUserId || !isConfigured()) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.emit({ status: 'offline' });
      return;
    }
    if (this.snapshot.status === 'account_mismatch') return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncNow(reason).catch((err) => {
        console.warn(`[SyncEngine] Scheduled sync (${reason}) failed:`, err);
      });
    }, delayMs);
  }

  async resolveAccountMismatchReplace(newUserId: string): Promise<SyncStateSnapshot> {
    await db.transaction('rw', [db.songs, db.setlists, db.tombstones, db.syncOutbox, db.syncMeta], async () => {
      await db.songs.clear();
      await db.setlists.clear();
      await db.tombstones.clear();
      await db.syncOutbox.clear();
      await db.syncMeta.put({
        id: 'state',
        activeUserId: newUserId,
        lastSyncVersion: 0,
        lastSyncedAt: null,
        lastReconciledAt: null,
      });
    });

    this.emit({
      accountMismatch: null,
      status: 'idle',
      pendingCount: 0,
      lastSyncedAt: null,
      lastSyncVersion: 0,
      lastConflictCount: 0,
      schemaWarning: null,
      lastError: null,
    });
    notifyLocalMutation();
    return this.syncNow('account_replace');
  }

  async resolveAccountMismatchMerge(newUserId: string): Promise<SyncStateSnapshot> {
    await db.transaction('rw', [db.songs, db.setlists, db.tombstones, db.syncOutbox, db.syncMeta], async () => {
      const now = Date.now();
      const songs = await db.songs.toArray();
      const setlists = await db.setlists.toArray();

      if (songs.length > 0) {
        await db.songs.bulkPut(
          songs.map((s) => ({
            ...s,
            remoteId: undefined,
            baseVersion: undefined,
            serverUpdatedAt: undefined,
            dirty: 1,
          }))
        );
        await db.syncOutbox.bulkPut(
          songs.map((s) => ({
            key: `song:${s.id}`,
            entityType: 'song' as const,
            entityId: s.id,
            op: 'upsert' as const,
            queuedAt: now,
            attempts: 0,
          }))
        );
      }

      if (setlists.length > 0) {
        await db.setlists.bulkPut(
          setlists.map((sl) => ({
            ...sl,
            remoteId: undefined,
            baseVersion: undefined,
            serverUpdatedAt: undefined,
            dirty: 1,
          }))
        );
        await db.syncOutbox.bulkPut(
          setlists.map((sl) => ({
            key: `setlist:${sl.id}`,
            entityType: 'setlist' as const,
            entityId: sl.id,
            op: 'upsert' as const,
            queuedAt: now,
            attempts: 0,
          }))
        );
      }

      await db.syncMeta.put({
        id: 'state',
        activeUserId: newUserId,
        lastSyncVersion: 0,
        lastSyncedAt: null,
        lastReconciledAt: null,
      });
    });

    this.emit({
      accountMismatch: null,
      status: 'idle',
      lastSyncedAt: null,
      lastSyncVersion: 0,
      lastConflictCount: 0,
      schemaWarning: null,
      lastError: null,
    });
    await this.refreshPendingCount();
    return this.syncNow('account_merge');
  }

  /**
   * Executes a single-flight, mutex-protected bidirectional sync:
   *   1. Account ownership & session validation
   *   2. Paginated delta Pull + base-version conflict preservation
   *   3. Batched Outbox Push with per-batch IndexedDB checkpoints
   */
  async syncNow(reason: string = 'manual', options?: { forceFullPull?: boolean }): Promise<SyncStateSnapshot> {
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    const execute = async (): Promise<SyncStateSnapshot> => {
      if (!isConfigured()) {
        this.emit({ status: 'error', isSyncing: false, lastError: 'Supabase is not configured.' });
        return this.snapshot;
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        this.emit({ status: 'offline', isSyncing: false });
        return this.snapshot;
      }

      this.emit({ isSyncing: true, status: 'syncing', lastError: null });

      try {
        // 1. Validate or refresh session
        let session = await getSession();
        if (!session?.user?.id) {
          this.emit({
            isSyncing: false,
            status: 'auth_required',
            lastError: 'Session expired. Please sign in again to sync.',
          });
          return this.snapshot;
        }

        const expiresAtMs = (session.expires_at || 0) * 1000;
        if (expiresAtMs > 0 && expiresAtMs - Date.now() < 60_000) {
          try {
            const refreshed = await refreshAuthSession();
            if (refreshed?.user?.id) {
              session = refreshed;
            }
          } catch {
            this.emit({
              isSyncing: false,
              status: 'auth_required',
              lastError: 'Authentication expired. Please sign in again.',
            });
            return this.snapshot;
          }
        }

        const user = session.user;
        const userId = String(user.id).trim();

        // 2. Device Account Isolation & Legacy Ownership Check
        const existingMeta = await db.syncMeta.get('state');
        const accountChanged = Boolean(existingMeta?.activeUserId && existingMeta.activeUserId !== userId);
        const hasRecordedOwner = Boolean(existingMeta?.activeUserId);

        if (!hasRecordedOwner || accountChanged) {
          const [songCount, setlistCount, outboxCount, tombstoneCount] = await Promise.all([
            db.songs.count(),
            db.setlists.count(),
            db.syncOutbox.count(),
            db.tombstones.count(),
          ]);

          const hasLocalData =
            songCount > 0 || setlistCount > 0 || outboxCount > 0 || tombstoneCount > 0;

          if (hasLocalData) {
            this.emit({
              isSyncing: false,
              status: 'account_mismatch',
              accountMismatch: {
                previousUserId: existingMeta?.activeUserId || 'unassigned',
                newUserId: userId,
                localSongCount: songCount,
                localSetlistCount: setlistCount,
                pendingCount: outboxCount,
              },
              lastError: accountChanged
                ? 'Local library belongs to a different signed-in account.'
                : 'Existing local library has no recorded account owner. Choose whether to merge or replace it before syncing.',
            });
            return this.snapshot;
          }

          // Local DB is empty: initialize fresh state and reset all account-specific checkpoints
          await db.syncMeta.put({
            id: 'state',
            activeUserId: userId,
            lastSyncVersion: 0,
            lastSyncedAt: null,
            lastReconciledAt: null,
          });
          this.emit({
            lastSyncedAt: null,
            lastSyncVersion: 0,
            lastConflictCount: 0,
            schemaWarning: null,
            accountMismatch: null,
          });
        }

        await upsertProfile(user);

        // 3. Phase A — Complete Cloud Snapshot Pull & Atomic Local Reconciliation
        const meta = await db.syncMeta.get('state');

        const [songsRes, setlistsRes] = await Promise.all([
          fetchSongsForUser(userId),
          fetchSetlistsForUser(userId),
        ]);

        if (!songsRes.isComplete || !setlistsRes.isComplete || !setlistsRes.relationshipsComplete) {
          throw new Error('Incomplete cloud snapshot received; aborting sync without advancing checkpoint.');
        }

        // If another device inserted a song right between fetchSongsForUser and fetchSetlistsForUser,
        // fetch those referenced song rows before reconciling so valid relationships are never dropped.
        const fetchedSongUuidSet = new Set(
          songsRes.rows.map((r: any) => String(r?.id || '').trim()).filter(Boolean)
        );
        const missingReferencedUuids = new Set<string>();
        for (const remoteSetlist of setlistsRes.rows) {
          if (remoteSetlist?.deleted_at || remoteSetlist?.relationshipsLoaded !== true) continue;
          const refs = Array.isArray(remoteSetlist.songs) ? remoteSetlist.songs : [];
          for (const ref of refs) {
            const clean = String(ref || '').trim();
            if (clean && !fetchedSongUuidSet.has(clean)) {
              missingReferencedUuids.add(clean);
            }
          }
        }
        if (missingReferencedUuids.size > 0) {
          const extraSongs = await fetchSongsByIdsForUser(
            userId,
            Array.from(missingReferencedUuids),
            songsRes.hasExtendedColumns,
            songsRes.hasServerVersion
          );
          for (const extra of extraSongs) {
            const extraId = String(extra?.id || '').trim();
            if (extraId && !fetchedSongUuidSet.has(extraId)) {
              fetchedSongUuidSet.add(extraId);
              songsRes.rows.push(extra);
            }
          }
        }

        let conflictCount = 0;
        let schemaWarning: string | null = null;
        if (!songsRes.hasExtendedColumns || !songsRes.hasServerVersion) {
          schemaWarning =
            'Supabase database is missing Phase 2 migration columns. Run supabase_phase2_migration.sql for full metadata, soft-delete, and version-based sync.';
        }

        let maxPulledVersion = meta?.lastSyncVersion || 0;
        for (const r of songsRes.rows) {
          const v = Number(r.server_version || 0);
          if (v > maxPulledVersion) maxPulledVersion = v;
        }
        for (const r of setlistsRes.rows) {
          const v = Number(r.server_version || 0);
          if (v > maxPulledVersion) maxPulledVersion = v;
        }

        const blockedDeletionErrors: string[] = [];
        const uploadErrors: string[] = [];
        let maxConfirmedVersion = maxPulledVersion;

        await db.transaction(
          'rw',
          [db.songs, db.setlists, db.tombstones, db.syncOutbox, db.syncMeta],
          async () => {
            const [localSongs, localSetlists, localTombstones, outboxItems] = await Promise.all([
              db.songs.toArray(),
              db.setlists.toArray(),
              db.tombstones.toArray(),
              db.syncOutbox.toArray(),
            ]);

            const localSongsById = new Map(localSongs.map((s) => [s.id, s]));
            const localSetlistsById = new Map(localSetlists.map((sl) => [sl.id, sl]));
            const localTombsByKey = new Map(localTombstones.map((t) => [`${t.type}:${t.id}`, t]));
            const outboxByKey = new Map(outboxItems.map((o) => [o.key, o]));

            // Build remoteId -> legacyId lookup from existing local songs + newly fetched remote songs
            const supabaseSongIdToLegacyId = new Map<string, string>();
            for (const s of localSongs) {
              if (s.remoteId) supabaseSongIdToLegacyId.set(s.remoteId, s.id);
            }
            for (const r of songsRes.rows) {
              const legacyId = String(r.legacy_id || '').trim();
              if (r.id && legacyId) supabaseSongIdToLegacyId.set(String(r.id), legacyId);
            }

            const deletedSongIds = new Set<string>();
            const songsToPut: Song[] = [];
            const songIdsToDelete: string[] = [];
            const tombIdsToDelete: string[] = [];
            const tombsToPut: Tombstone[] = [];
            const outboxKeysToDelete: string[] = [];
            const outboxToPut: SyncOutboxItem[] = [];
            const remoteActiveSongLegacyIds = new Set<string>();

            for (const remoteSong of songsRes.rows) {
              const legacyId = String(remoteSong.legacy_id || '').trim();
              if (!legacyId) continue;

              const remoteId = String(remoteSong.id);
              const remoteVersion = Number(remoteSong.server_version || 0);
              const remoteUpdatedAt = remoteSong.updated_at ? new Date(remoteSong.updated_at).getTime() : Date.now();
              const local = localSongsById.get(legacyId);
              const outbox = outboxByKey.get(`song:${legacyId}`);
              const localTomb = localTombsByKey.get(`song:${legacyId}`);

              // Case 1: Remote song is soft-deleted
              if (remoteSong.deleted_at) {
                if (local && (local.dirty === 1 || outbox?.op === 'upsert')) {
                  // Edit-vs-Delete conflict: preserve local edits under a new song ID
                  const conflictKey = `song:${legacyId}:deleted:${remoteVersion > 0 ? remoteVersion : String(remoteSong.deleted_at)}`;
                  const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
                  const restoredId = existingConflict?.entityId || uuidv4();
                  const now = Date.now();
                  songsToPut.push({
                    ...local,
                    id: restoredId,
                    title: appendCopyLabel(local.title, 'Untitled Song', 'Restored Copy'),
                    remoteId: undefined,
                    baseVersion: undefined,
                    serverUpdatedAt: undefined,
                    updatedAt: now,
                    dirty: 1,
                  });
                  outboxToPut.push({
                    key: `song:${restoredId}`,
                    entityType: 'song',
                    entityId: restoredId,
                    op: 'upsert',
                    queuedAt: now,
                    attempts: 0,
                    conflictKey,
                  });
                  conflictCount++;
                }

                deletedSongIds.add(legacyId);
                songIdsToDelete.push(legacyId);
                tombIdsToDelete.push(legacyId);
                outboxKeysToDelete.push(`song:${legacyId}`);
                continue;
              }

              remoteActiveSongLegacyIds.add(legacyId);

              const remoteMeta =
                remoteSong.metadata && typeof remoteSong.metadata === 'object' ? remoteSong.metadata : {};
              const remoteBpm = typeof remoteSong.bpm === 'number' ? remoteSong.bpm : undefined;
              const normalizedTitle = remoteSong.title || local?.title || localTomb?.titleSnapshot || 'Untitled Song';
              const normalizedLyrics =
                typeof remoteSong.lyrics === 'string' ? remoteSong.lyrics : local?.lyrics || '';

              // Pending or blocked local deletion for this song
              if ((localTomb || outbox?.op === 'delete') && outbox?.op !== 'upsert') {
                const tombRemoteId = localTomb?.remoteId || outbox?.remoteId || local?.remoteId;
                const rawTombBase = Number(localTomb?.baseVersion ?? outbox?.baseVersion);
                const hasTombBaseVersion = Number.isFinite(rawTombBase) && rawTombBase > 0;
                const isAlreadyBlocked =
                  localTomb?.baselineStatus === 'conflict_blocked' ||
                  localTomb?.baselineStatus === 'missing_baseline' ||
                  outbox?.status === 'blocked_conflict' ||
                  outbox?.status === 'blocked_missing_baseline';

                if (isAlreadyBlocked) {
                  // Preserve/refresh cloud version locally without duplicating conflict copies or unblocking deletion
                  if (!local || !local.dirty) {
                    songsToPut.push({
                      id: legacyId,
                      title: normalizedTitle,
                      lyrics: normalizedLyrics,
                      createdAt:
                        local?.createdAt ||
                        (remoteSong.created_at ? new Date(remoteSong.created_at).getTime() : Date.now()),
                      updatedAt: remoteUpdatedAt || local?.updatedAt || Date.now(),
                      bpm: songsRes.hasExtendedColumns ? remoteBpm : local?.bpm,
                      metadata: songsRes.hasExtendedColumns ? remoteMeta : local?.metadata || {},
                      remoteId,
                      baseVersion: remoteVersion || local?.baseVersion,
                      serverUpdatedAt: remoteSong.updated_at || local?.serverUpdatedAt,
                      dirty: 0,
                    });
                  }
                  const msg =
                    localTomb?.lastError ||
                    outbox?.lastError ||
                    `Deletion of song "${normalizedTitle}" is blocked and requires user resolution.`;
                  if (!blockedDeletionErrors.includes(msg)) blockedDeletionErrors.push(msg);
                  continue;
                }

                if (localTomb?.baselineStatus === 'ready' && hasTombBaseVersion) {
                  if (!songsRes.hasServerVersion || remoteVersion <= 0) {
                    const conflictKey = `song:${legacyId}:missing-version`;
                    const reasonMsg = `Deletion of song "${normalizedTitle}" was blocked because server_version is unavailable.`;
                    songsToPut.push({
                      id: legacyId,
                      title: normalizedTitle,
                      lyrics: normalizedLyrics,
                      createdAt: remoteSong.created_at ? new Date(remoteSong.created_at).getTime() : Date.now(),
                      updatedAt: remoteUpdatedAt,
                      bpm: songsRes.hasExtendedColumns ? remoteBpm : undefined,
                      metadata: songsRes.hasExtendedColumns ? remoteMeta : {},
                      remoteId,
                      baseVersion: undefined,
                      serverUpdatedAt: remoteSong.updated_at,
                      dirty: 0,
                    });
                    tombsToPut.push({
                      ...localTomb,
                      remoteId: tombRemoteId || remoteId,
                      titleSnapshot: normalizedTitle,
                      baselineStatus: 'missing_baseline',
                      conflictKey,
                      lastError: reasonMsg,
                    });
                    outboxToPut.push({
                      key: `song:${legacyId}`,
                      entityType: 'song',
                      entityId: legacyId,
                      op: 'delete',
                      queuedAt: outbox?.queuedAt || localTomb.deletedAt || Date.now(),
                      attempts: outbox?.attempts || 0,
                      remoteId: tombRemoteId || remoteId,
                      baseVersion: rawTombBase,
                      status: 'blocked_missing_baseline',
                      conflictKey,
                      lastError: reasonMsg,
                    });
                    conflictCount++;
                    if (!blockedDeletionErrors.includes(reasonMsg)) blockedDeletionErrors.push(reasonMsg);
                    continue;
                  }

                  if (remoteVersion === rawTombBase && (!tombRemoteId || tombRemoteId === remoteId)) {
                    // Remote has not changed since deletion baseline: keep deleted locally for Phase B push
                    continue;
                  }

                  // Delete-vs-Edit conflict: preserve cloud version locally & block automatic deletion
                  const conflictKey = `song:${legacyId}:delconflict:v${remoteVersion}`;
                  const reasonMsg = `Deletion of song "${normalizedTitle}" was blocked because a newer cloud version exists.`;
                  songsToPut.push({
                    id: legacyId,
                    title: normalizedTitle,
                    lyrics: normalizedLyrics,
                    createdAt: remoteSong.created_at ? new Date(remoteSong.created_at).getTime() : Date.now(),
                    updatedAt: remoteUpdatedAt,
                    bpm: songsRes.hasExtendedColumns ? remoteBpm : undefined,
                    metadata: songsRes.hasExtendedColumns ? remoteMeta : {},
                    remoteId,
                    baseVersion: remoteVersion,
                    serverUpdatedAt: remoteSong.updated_at,
                    dirty: 0,
                  });
                  tombsToPut.push({
                    ...localTomb,
                    remoteId: tombRemoteId || remoteId,
                    baseVersion: rawTombBase,
                    titleSnapshot: normalizedTitle,
                    baselineStatus: 'conflict_blocked',
                    conflictKey,
                    lastError: reasonMsg,
                  });
                  outboxToPut.push({
                    key: `song:${legacyId}`,
                    entityType: 'song',
                    entityId: legacyId,
                    op: 'delete',
                    queuedAt: outbox?.queuedAt || localTomb.deletedAt || Date.now(),
                    attempts: outbox?.attempts || 0,
                    remoteId: tombRemoteId || remoteId,
                    baseVersion: rawTombBase,
                    status: 'blocked_conflict',
                    conflictKey,
                    lastError: reasonMsg,
                  });
                  conflictCount++;
                  if (!blockedDeletionErrors.includes(reasonMsg)) blockedDeletionErrors.push(reasonMsg);
                  continue;
                }

                // Legacy / missing-baseline / local_only tombstone unexpectedly matching active cloud record
                const conflictKey = `song:${legacyId}:missing-baseline:v${remoteVersion > 0 ? remoteVersion : remoteId}`;
                const reasonMsg = `Deletion of song "${normalizedTitle}" was blocked because it lacked a baseline version; cloud record preserved.`;
                songsToPut.push({
                  id: legacyId,
                  title: normalizedTitle,
                  lyrics: normalizedLyrics,
                  createdAt: remoteSong.created_at ? new Date(remoteSong.created_at).getTime() : Date.now(),
                  updatedAt: remoteUpdatedAt,
                  bpm: songsRes.hasExtendedColumns ? remoteBpm : undefined,
                  metadata: songsRes.hasExtendedColumns ? remoteMeta : {},
                  remoteId,
                  baseVersion: remoteVersion || undefined,
                  serverUpdatedAt: remoteSong.updated_at,
                  dirty: 0,
                });
                tombsToPut.push({
                  id: legacyId,
                  type: 'song',
                  deletedAt: localTomb?.deletedAt || outbox?.queuedAt || Date.now(),
                  remoteId: tombRemoteId || remoteId,
                  baseVersion: localTomb?.baseVersion,
                  serverUpdatedAt: localTomb?.serverUpdatedAt,
                  titleSnapshot: normalizedTitle,
                  baselineStatus: 'missing_baseline',
                  conflictKey,
                  lastError: reasonMsg,
                });
                outboxToPut.push({
                  key: `song:${legacyId}`,
                  entityType: 'song',
                  entityId: legacyId,
                  op: 'delete',
                  queuedAt: outbox?.queuedAt || localTomb?.deletedAt || Date.now(),
                  attempts: outbox?.attempts || 0,
                  remoteId: tombRemoteId || remoteId,
                  baseVersion: localTomb?.baseVersion,
                  status: 'blocked_missing_baseline',
                  conflictKey,
                  lastError: reasonMsg,
                });
                conflictCount++;
                if (!blockedDeletionErrors.includes(reasonMsg)) blockedDeletionErrors.push(reasonMsg);
                continue;
              }

              if (!local) {
                songsToPut.push({
                  id: legacyId,
                  title: normalizedTitle,
                  lyrics: normalizedLyrics,
                  createdAt: remoteSong.created_at ? new Date(remoteSong.created_at).getTime() : Date.now(),
                  updatedAt: remoteUpdatedAt,
                  bpm: songsRes.hasExtendedColumns ? remoteBpm : undefined,
                  metadata: songsRes.hasExtendedColumns ? remoteMeta : {},
                  remoteId,
                  baseVersion: remoteVersion || undefined,
                  serverUpdatedAt: remoteSong.updated_at,
                  dirty: 0,
                });
                if (localTomb) tombIdsToDelete.push(legacyId);
                continue;
              }

              // Local record exists and has NO unpushed edits
              if (!local.dirty && outbox?.op !== 'upsert') {
                songsToPut.push({
                  ...local,
                  title: normalizedTitle,
                  lyrics: normalizedLyrics,
                  updatedAt: remoteUpdatedAt || local.updatedAt,
                  bpm: songsRes.hasExtendedColumns ? remoteBpm : local.bpm,
                  metadata: songsRes.hasExtendedColumns ? remoteMeta : local.metadata || {},
                  remoteId,
                  baseVersion: remoteVersion || local.baseVersion,
                  serverUpdatedAt: remoteSong.updated_at || local.serverUpdatedAt,
                  dirty: 0,
                });
                continue;
              }

              // Local record IS dirty: perform base-version / content comparison
              const remotePayload = {
                title: normalizedTitle,
                lyrics: normalizedLyrics,
                bpm: songsRes.hasExtendedColumns ? remoteBpm : local.bpm,
                metadata: songsRes.hasExtendedColumns ? remoteMeta : local.metadata || {},
              };

              if (songsContentEqual(local, remotePayload, songsRes.hasExtendedColumns)) {
                // Content matches! Check if local has un-synced extended metadata on an un-migrated DB
                const hasUnsyncedMeta =
                  !songsRes.hasExtendedColumns &&
                  (Object.keys(local.metadata || {}).length > 0 || local.bpm !== undefined);

                songsToPut.push({
                  ...local,
                  remoteId,
                  baseVersion: remoteVersion || local.baseVersion,
                  serverUpdatedAt: remoteSong.updated_at || local.serverUpdatedAt,
                  dirty: hasUnsyncedMeta ? 1 : 0,
                });
                if (!hasUnsyncedMeta) {
                  outboxKeysToDelete.push(`song:${legacyId}`);
                }
                continue;
              }

              // Content differs! Determine whether remote changed since our last sync baseline
              // Without a recorded baseline we cannot prove the remote is unchanged.
              // Preserve the local edit as a conflict copy instead of guessing from timestamps.
              const remoteChangedSinceBase =
                local.baseVersion !== undefined
                  ? songsRes.hasServerVersion
                    ? remoteVersion !== local.baseVersion
                    : Boolean(local.serverUpdatedAt && remoteSong.updated_at !== local.serverUpdatedAt)
                  : true;

              if (!remoteChangedSinceBase) {
                // Remote did not advance since our baseline; local wins cleanly and stays dirty for Phase B push
                songsToPut.push({
                  ...local,
                  remoteId,
                  baseVersion: remoteVersion || local.baseVersion,
                });
                continue;
              }

              // TRUE CONCURRENT CONFLICT: Preserve local edit as a new conflict copy, accept remote canonical
              const conflictKey = `song:${legacyId}:v${remoteVersion > 0 ? remoteVersion : remoteId}`;
              const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
              const conflictId = existingConflict?.entityId || uuidv4();
              const now = Date.now();
              songsToPut.push({
                ...local,
                id: conflictId,
                title: appendCopyLabel(local.title, 'Untitled Song', 'Conflict Copy'),
                remoteId: undefined,
                baseVersion: undefined,
                serverUpdatedAt: undefined,
                updatedAt: now,
                dirty: 1,
              });
              outboxToPut.push({
                key: `song:${conflictId}`,
                entityType: 'song',
                entityId: conflictId,
                op: 'upsert',
                queuedAt: now,
                attempts: 0,
                conflictKey,
              });
              songsToPut.push({
                id: legacyId,
                title: normalizedTitle,
                lyrics: normalizedLyrics,
                createdAt: local.createdAt || (remoteSong.created_at ? new Date(remoteSong.created_at).getTime() : now),
                updatedAt: remoteUpdatedAt || now,
                bpm: songsRes.hasExtendedColumns ? remoteBpm : local.bpm,
                metadata: songsRes.hasExtendedColumns ? remoteMeta : local.metadata || {},
                remoteId,
                baseVersion: remoteVersion || undefined,
                serverUpdatedAt: remoteSong.updated_at,
                dirty: 0,
              });
              outboxKeysToDelete.push(`song:${legacyId}`);
              conflictCount++;
            }

            // On un-migrated DB (no deleted_at), detect hard-deletions for previously synced clean records
            if (!songsRes.isIncremental && !songsRes.hasExtendedColumns) {
              for (const local of localSongs) {
                if (
                  !local.dirty &&
                  local.remoteId &&
                  !remoteActiveSongLegacyIds.has(local.id) &&
                  !localTombsByKey.has(`song:${local.id}`)
                ) {
                  deletedSongIds.add(local.id);
                  songIdsToDelete.push(local.id);
                }
              }
            }

            // Reconcile Setlists
            const setlistsToPut: Setlist[] = [];
            const setlistIdsToDelete: string[] = [];
            const remoteActiveSetlistLegacyIds = new Set<string>();

            for (const remoteSetlist of setlistsRes.rows) {
              const legacyId = String(remoteSetlist.legacy_id || '').trim();
              if (!legacyId) continue;

              const remoteId = String(remoteSetlist.id);
              const remoteVersion = Number(remoteSetlist.server_version || 0);
              const remoteUpdatedAt = remoteSetlist.updated_at
                ? new Date(remoteSetlist.updated_at).getTime()
                : Date.now();
              const local = localSetlistsById.get(legacyId);
              const outbox = outboxByKey.get(`setlist:${legacyId}`);
              const localTomb = localTombsByKey.get(`setlist:${legacyId}`);

              if (remoteSetlist.deleted_at) {
                if (local && (local.dirty === 1 || outbox?.op === 'upsert')) {
                  const conflictKey = `setlist:${legacyId}:deleted:${remoteVersion > 0 ? remoteVersion : String(remoteSetlist.deleted_at)}`;
                  const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
                  const restoredId = existingConflict?.entityId || uuidv4();
                  const now = Date.now();
                  setlistsToPut.push({
                    ...local,
                    id: restoredId,
                    name: appendCopyLabel(local.name, 'Untitled Setlist', 'Restored Copy'),
                    songIds: local.songIds.filter((sid) => !deletedSongIds.has(sid)),
                    remoteId: undefined,
                    baseVersion: undefined,
                    serverUpdatedAt: undefined,
                    updatedAt: now,
                    dirty: 1,
                  });
                  outboxToPut.push({
                    key: `setlist:${restoredId}`,
                    entityType: 'setlist',
                    entityId: restoredId,
                    op: 'upsert',
                    queuedAt: now,
                    attempts: 0,
                    conflictKey,
                  });
                  conflictCount++;
                }

                setlistIdsToDelete.push(legacyId);
                tombIdsToDelete.push(legacyId);
                outboxKeysToDelete.push(`setlist:${legacyId}`);
                continue;
              }

              remoteActiveSetlistLegacyIds.add(legacyId);

              const relationshipsLoaded = remoteSetlist.relationshipsLoaded === true;
              const rawRemoteSongRefs =
                relationshipsLoaded && Array.isArray(remoteSetlist.songs)
                  ? remoteSetlist.songs
                  : [];

              const resolvedSongIds: string[] = [];
              if (relationshipsLoaded) {
                for (const sid of rawRemoteSongRefs) {
                  const clean = String(sid || '').trim();
                  if (!clean) continue;
                  const mappedLegacyId = supabaseSongIdToLegacyId.get(clean);
                  if (!mappedLegacyId) {
                    console.warn(
                      `[SyncEngine] Ignoring unresolved Supabase song UUID "${clean}" in setlist "${legacyId}" without substituting raw UUID.`
                    );
                    continue;
                  }
                  if (!deletedSongIds.has(mappedLegacyId)) {
                    resolvedSongIds.push(mappedLegacyId);
                  }
                }
              }

              const effectiveRemoteSongIds = relationshipsLoaded
                ? resolvedSongIds
                : local?.songIds || [];

              const normalizedName =
                remoteSetlist.name || local?.name || localTomb?.titleSnapshot || 'Untitled Setlist';

              // Pending or blocked local deletion for this setlist
              if ((localTomb || outbox?.op === 'delete') && outbox?.op !== 'upsert') {
                const tombRemoteId = localTomb?.remoteId || outbox?.remoteId || local?.remoteId;
                const rawTombBase = Number(localTomb?.baseVersion ?? outbox?.baseVersion);
                const hasTombBaseVersion = Number.isFinite(rawTombBase) && rawTombBase > 0;
                const isAlreadyBlocked =
                  localTomb?.baselineStatus === 'conflict_blocked' ||
                  localTomb?.baselineStatus === 'missing_baseline' ||
                  outbox?.status === 'blocked_conflict' ||
                  outbox?.status === 'blocked_missing_baseline';

                if (isAlreadyBlocked) {
                  if (!local || !local.dirty) {
                    setlistsToPut.push({
                      id: legacyId,
                      name: normalizedName,
                      songIds: effectiveRemoteSongIds,
                      createdAt:
                        local?.createdAt ||
                        (remoteSetlist.created_at ? new Date(remoteSetlist.created_at).getTime() : Date.now()),
                      updatedAt: remoteUpdatedAt || local?.updatedAt || Date.now(),
                      remoteId,
                      baseVersion: remoteVersion || local?.baseVersion,
                      serverUpdatedAt: remoteSetlist.updated_at || local?.serverUpdatedAt,
                      dirty: 0,
                    });
                  }
                  const msg =
                    localTomb?.lastError ||
                    outbox?.lastError ||
                    `Deletion of setlist "${normalizedName}" is blocked and requires user resolution.`;
                  if (!blockedDeletionErrors.includes(msg)) blockedDeletionErrors.push(msg);
                  continue;
                }

                if (localTomb?.baselineStatus === 'ready' && hasTombBaseVersion) {
                  if (!setlistsRes.hasServerVersion || remoteVersion <= 0) {
                    const conflictKey = `setlist:${legacyId}:missing-version`;
                    const reasonMsg = `Deletion of setlist "${normalizedName}" was blocked because server_version is unavailable.`;
                    setlistsToPut.push({
                      id: legacyId,
                      name: normalizedName,
                      songIds: effectiveRemoteSongIds,
                      createdAt: remoteSetlist.created_at
                        ? new Date(remoteSetlist.created_at).getTime()
                        : Date.now(),
                      updatedAt: remoteUpdatedAt,
                      remoteId,
                      baseVersion: undefined,
                      serverUpdatedAt: remoteSetlist.updated_at,
                      dirty: 0,
                    });
                    tombsToPut.push({
                      ...localTomb,
                      remoteId: tombRemoteId || remoteId,
                      titleSnapshot: normalizedName,
                      baselineStatus: 'missing_baseline',
                      conflictKey,
                      lastError: reasonMsg,
                    });
                    outboxToPut.push({
                      key: `setlist:${legacyId}`,
                      entityType: 'setlist',
                      entityId: legacyId,
                      op: 'delete',
                      queuedAt: outbox?.queuedAt || localTomb.deletedAt || Date.now(),
                      attempts: outbox?.attempts || 0,
                      remoteId: tombRemoteId || remoteId,
                      baseVersion: rawTombBase,
                      status: 'blocked_missing_baseline',
                      conflictKey,
                      lastError: reasonMsg,
                    });
                    conflictCount++;
                    if (!blockedDeletionErrors.includes(reasonMsg)) blockedDeletionErrors.push(reasonMsg);
                    continue;
                  }

                  if (remoteVersion === rawTombBase && (!tombRemoteId || tombRemoteId === remoteId)) {
                    // Remote unchanged since deletion baseline: keep deleted locally for Phase B push
                    continue;
                  }

                  // Delete-vs-Edit conflict: preserve cloud setlist locally & block automatic deletion
                  const conflictKey = `setlist:${legacyId}:delconflict:v${remoteVersion}`;
                  const reasonMsg = `Deletion of setlist "${normalizedName}" was blocked because a newer cloud version exists.`;
                  setlistsToPut.push({
                    id: legacyId,
                    name: normalizedName,
                    songIds: effectiveRemoteSongIds,
                    createdAt: remoteSetlist.created_at
                      ? new Date(remoteSetlist.created_at).getTime()
                      : Date.now(),
                    updatedAt: remoteUpdatedAt,
                    remoteId,
                    baseVersion: remoteVersion,
                    serverUpdatedAt: remoteSetlist.updated_at,
                    dirty: 0,
                  });
                  tombsToPut.push({
                    ...localTomb,
                    remoteId: tombRemoteId || remoteId,
                    baseVersion: rawTombBase,
                    titleSnapshot: normalizedName,
                    baselineStatus: 'conflict_blocked',
                    conflictKey,
                    lastError: reasonMsg,
                  });
                  outboxToPut.push({
                    key: `setlist:${legacyId}`,
                    entityType: 'setlist',
                    entityId: legacyId,
                    op: 'delete',
                    queuedAt: outbox?.queuedAt || localTomb.deletedAt || Date.now(),
                    attempts: outbox?.attempts || 0,
                    remoteId: tombRemoteId || remoteId,
                    baseVersion: rawTombBase,
                    status: 'blocked_conflict',
                    conflictKey,
                    lastError: reasonMsg,
                  });
                  conflictCount++;
                  if (!blockedDeletionErrors.includes(reasonMsg)) blockedDeletionErrors.push(reasonMsg);
                  continue;
                }

                // Legacy / missing-baseline / local_only tombstone unexpectedly matching active cloud setlist
                const conflictKey = `setlist:${legacyId}:missing-baseline:v${remoteVersion > 0 ? remoteVersion : remoteId}`;
                const reasonMsg = `Deletion of setlist "${normalizedName}" was blocked because it lacked a baseline version; cloud record preserved.`;
                setlistsToPut.push({
                  id: legacyId,
                  name: normalizedName,
                  songIds: effectiveRemoteSongIds,
                  createdAt: remoteSetlist.created_at
                    ? new Date(remoteSetlist.created_at).getTime()
                    : Date.now(),
                  updatedAt: remoteUpdatedAt,
                  remoteId,
                  baseVersion: remoteVersion || undefined,
                  serverUpdatedAt: remoteSetlist.updated_at,
                  dirty: 0,
                });
                tombsToPut.push({
                  id: legacyId,
                  type: 'setlist',
                  deletedAt: localTomb?.deletedAt || outbox?.queuedAt || Date.now(),
                  remoteId: tombRemoteId || remoteId,
                  baseVersion: localTomb?.baseVersion,
                  serverUpdatedAt: localTomb?.serverUpdatedAt,
                  titleSnapshot: normalizedName,
                  baselineStatus: 'missing_baseline',
                  conflictKey,
                  lastError: reasonMsg,
                });
                outboxToPut.push({
                  key: `setlist:${legacyId}`,
                  entityType: 'setlist',
                  entityId: legacyId,
                  op: 'delete',
                  queuedAt: outbox?.queuedAt || localTomb?.deletedAt || Date.now(),
                  attempts: outbox?.attempts || 0,
                  remoteId: tombRemoteId || remoteId,
                  baseVersion: localTomb?.baseVersion,
                  status: 'blocked_missing_baseline',
                  conflictKey,
                  lastError: reasonMsg,
                });
                conflictCount++;
                if (!blockedDeletionErrors.includes(reasonMsg)) blockedDeletionErrors.push(reasonMsg);
                continue;
              }

              if (!local) {
                setlistsToPut.push({
                  id: legacyId,
                  name: normalizedName,
                  songIds: effectiveRemoteSongIds,
                  createdAt: remoteSetlist.created_at
                    ? new Date(remoteSetlist.created_at).getTime()
                    : Date.now(),
                  updatedAt: remoteUpdatedAt,
                  remoteId,
                  baseVersion: remoteVersion || undefined,
                  serverUpdatedAt: remoteSetlist.updated_at,
                  dirty: 0,
                });
                if (localTomb) tombIdsToDelete.push(legacyId);
                continue;
              }

              if (!local.dirty && outbox?.op !== 'upsert') {
                setlistsToPut.push({
                  ...local,
                  name: normalizedName,
                  songIds: effectiveRemoteSongIds,
                  updatedAt: remoteUpdatedAt || local.updatedAt,
                  remoteId,
                  baseVersion: remoteVersion || local.baseVersion,
                  serverUpdatedAt: remoteSetlist.updated_at || local.serverUpdatedAt,
                  dirty: 0,
                });
                continue;
              }

              if (setlistsContentEqual(local, { name: normalizedName, songIds: effectiveRemoteSongIds })) {
                setlistsToPut.push({
                  ...local,
                  remoteId,
                  baseVersion: remoteVersion || local.baseVersion,
                  serverUpdatedAt: remoteSetlist.updated_at || local.serverUpdatedAt,
                  dirty: 0,
                });
                outboxKeysToDelete.push(`setlist:${legacyId}`);
                continue;
              }

              // Without a recorded baseline we cannot prove the remote is unchanged.
              // Preserve the local edit as a conflict copy instead of guessing from timestamps.
              const remoteChangedSinceBase =
                local.baseVersion !== undefined
                  ? setlistsRes.hasServerVersion
                    ? remoteVersion !== local.baseVersion
                    : Boolean(local.serverUpdatedAt && remoteSetlist.updated_at !== local.serverUpdatedAt)
                  : true;

              if (!remoteChangedSinceBase) {
                setlistsToPut.push({
                  ...local,
                  remoteId,
                  baseVersion: remoteVersion || local.baseVersion,
                });
                continue;
              }

              // Setlist Conflict: keep local as conflict copy, apply remote canonical
              const conflictKey = `setlist:${legacyId}:v${remoteVersion > 0 ? remoteVersion : remoteId}`;
              const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
              const conflictId = existingConflict?.entityId || uuidv4();
              const now = Date.now();
              setlistsToPut.push({
                ...local,
                id: conflictId,
                name: appendCopyLabel(local.name, 'Untitled Setlist', 'Conflict Copy'),
                songIds: local.songIds.filter((sid) => !deletedSongIds.has(sid)),
                remoteId: undefined,
                baseVersion: undefined,
                serverUpdatedAt: undefined,
                updatedAt: now,
                dirty: 1,
              });
              outboxToPut.push({
                key: `setlist:${conflictId}`,
                entityType: 'setlist',
                entityId: conflictId,
                op: 'upsert',
                queuedAt: now,
                attempts: 0,
                conflictKey,
              });
              setlistsToPut.push({
                id: legacyId,
                name: normalizedName,
                songIds: effectiveRemoteSongIds,
                createdAt:
                  local.createdAt ||
                  (remoteSetlist.created_at ? new Date(remoteSetlist.created_at).getTime() : now),
                updatedAt: remoteUpdatedAt || now,
                remoteId,
                baseVersion: remoteVersion || undefined,
                serverUpdatedAt: remoteSetlist.updated_at,
                dirty: 0,
              });
              outboxKeysToDelete.push(`setlist:${legacyId}`);
              conflictCount++;
            }

            if (!setlistsRes.isIncremental && !setlistsRes.hasExtendedColumns) {
              for (const local of localSetlists) {
                if (
                  !local.dirty &&
                  local.remoteId &&
                  !remoteActiveSetlistLegacyIds.has(local.id) &&
                  !localTombsByKey.has(`setlist:${local.id}`)
                ) {
                  setlistIdsToDelete.push(local.id);
                }
              }
            }

            // Strip any newly deleted song IDs from untouched local setlists so UI never retains dangling IDs
            if (deletedSongIds.size > 0) {
              const touchedSetlistIds = new Set([
                ...setlistsToPut.map((s) => s.id),
                ...setlistIdsToDelete,
              ]);
              for (const localSetlist of localSetlists) {
                if (touchedSetlistIds.has(localSetlist.id)) continue;
                if (localSetlist.songIds.some((sid) => deletedSongIds.has(sid))) {
                  setlistsToPut.push({
                    ...localSetlist,
                    songIds: localSetlist.songIds.filter((sid) => !deletedSongIds.has(sid)),
                  });
                }
              }
            }

            // Commit all Step A changes in ONE atomic Dexie transaction
            if (songsToPut.length) await db.songs.bulkPut(songsToPut);
            if (songIdsToDelete.length) await db.songs.bulkDelete(songIdsToDelete);
            if (setlistsToPut.length) await db.setlists.bulkPut(setlistsToPut);
            if (setlistIdsToDelete.length) await db.setlists.bulkDelete(setlistIdsToDelete);
            if (tombIdsToDelete.length) await db.tombstones.bulkDelete(tombIdsToDelete);
            if (tombsToPut.length) await db.tombstones.bulkPut(tombsToPut);
            if (outboxKeysToDelete.length) await db.syncOutbox.bulkDelete(outboxKeysToDelete);
            if (outboxToPut.length) await db.syncOutbox.bulkPut(outboxToPut);

            if (songsRes.hasServerVersion || setlistsRes.hasServerVersion) {
              await db.syncMeta.put({
                id: 'state',
                activeUserId: userId,
                lastSyncVersion: maxPulledVersion,
                lastSyncedAt: meta?.lastSyncedAt || null,
                lastReconciledAt: Date.now(),
              });
            }
          }
        );

        // 4. Phase B — Flush Outbox (Batched & Checkpointed)
        const pendingItems = await db.syncOutbox.orderBy('queuedAt').toArray();
        const songDeletes = pendingItems.filter((o) => o.entityType === 'song' && o.op === 'delete');
        const songUpserts = pendingItems.filter((o) => o.entityType === 'song' && o.op === 'upsert');
        const setlistDeletes = pendingItems.filter((o) => o.entityType === 'setlist' && o.op === 'delete');
        const setlistUpserts = pendingItems.filter((o) => o.entityType === 'setlist' && o.op === 'upsert');

        const preserveSongOnBlockedDelete = async (
          delItem: SyncOutboxItem,
          tomb: Tombstone | undefined,
          remoteRow: any,
          kind: 'conflict' | 'missing_baseline'
        ) => {
          const remoteVersion = Number(remoteRow?.server_version || 0);
          if (remoteVersion > maxConfirmedVersion) maxConfirmedVersion = remoteVersion;

          const remoteUpdatedAt = remoteRow?.updated_at
            ? new Date(remoteRow.updated_at).getTime()
            : Date.now();
          const remoteMeta =
            remoteRow?.metadata && typeof remoteRow.metadata === 'object' ? remoteRow.metadata : {};
          const remoteBpm = typeof remoteRow?.bpm === 'number' ? remoteRow.bpm : undefined;
          const normalizedTitle = remoteRow?.title || tomb?.titleSnapshot || 'Untitled Song';
          const normalizedLyrics = typeof remoteRow?.lyrics === 'string' ? remoteRow.lyrics : '';
          const remoteId = String(remoteRow?.id || tomb?.remoteId || delItem.remoteId || '');
          const conflictKey =
            kind === 'conflict'
              ? `song:${delItem.entityId}:delconflict:v${remoteVersion > 0 ? remoteVersion : remoteId}`
              : `song:${delItem.entityId}:missing-baseline:v${remoteVersion > 0 ? remoteVersion : remoteId}`;
          const reasonMsg =
            kind === 'conflict'
              ? `Deletion of song "${normalizedTitle}" was blocked because a newer cloud version exists.`
              : `Deletion of song "${normalizedTitle}" was blocked because it lacked a baseline version; cloud record preserved.`;

          await db.transaction('rw', [db.songs, db.tombstones, db.syncOutbox], async () => {
            const currentOutbox = await db.syncOutbox.get(delItem.key);
            if (
              currentOutbox &&
              (currentOutbox.op !== 'delete' || currentOutbox.queuedAt !== delItem.queuedAt)
            ) {
              return;
            }

            await db.songs.put({
              id: delItem.entityId,
              title: normalizedTitle,
              lyrics: normalizedLyrics,
              createdAt: remoteRow?.created_at
                ? new Date(remoteRow.created_at).getTime()
                : Date.now(),
              updatedAt: remoteUpdatedAt,
              bpm: remoteBpm,
              metadata: remoteMeta,
              remoteId: remoteId || undefined,
              baseVersion: remoteVersion || undefined,
              serverUpdatedAt: remoteRow?.updated_at,
              dirty: 0,
            });

            await db.tombstones.put({
              id: delItem.entityId,
              type: 'song',
              deletedAt: tomb?.deletedAt || delItem.queuedAt || Date.now(),
              remoteId: tomb?.remoteId || delItem.remoteId || (remoteId || undefined),
              baseVersion: tomb?.baseVersion ?? delItem.baseVersion,
              serverUpdatedAt: tomb?.serverUpdatedAt,
              titleSnapshot: normalizedTitle,
              baselineStatus: kind === 'conflict' ? 'conflict_blocked' : 'missing_baseline',
              conflictKey,
              lastError: reasonMsg,
            });

            await db.syncOutbox.put({
              ...delItem,
              remoteId: tomb?.remoteId || delItem.remoteId || (remoteId || undefined),
              baseVersion: tomb?.baseVersion ?? delItem.baseVersion,
              status: kind === 'conflict' ? 'blocked_conflict' : 'blocked_missing_baseline',
              conflictKey,
              lastError: reasonMsg,
            });

            conflictCount++;
            if (!blockedDeletionErrors.includes(reasonMsg)) {
              blockedDeletionErrors.push(reasonMsg);
            }
          });
        };

        const pushSingleSongDeletion = async (delItem: SyncOutboxItem) => {
          const tomb = await db.tombstones.get(delItem.entityId);
          if (
            delItem.status === 'blocked_conflict' ||
            delItem.status === 'blocked_missing_baseline' ||
            tomb?.baselineStatus === 'conflict_blocked' ||
            tomb?.baselineStatus === 'missing_baseline'
          ) {
            const label = tomb?.titleSnapshot || delItem.entityId;
            const fallbackMsg =
              delItem.status === 'blocked_missing_baseline' || tomb?.baselineStatus === 'missing_baseline'
                ? `Deletion of song "${label}" is blocked because it lacked a baseline version.`
                : `Deletion of song "${label}" is blocked because a newer cloud version exists.`;
            const msg = tomb?.lastError || delItem.lastError || fallbackMsg;
            if (!blockedDeletionErrors.includes(msg)) blockedDeletionErrors.push(msg);
            return;
          }

          const remoteId = tomb?.remoteId || delItem.remoteId;
          const rawBaseVersion = Number(tomb?.baseVersion ?? delItem.baseVersion);
          const hasValidBaseVersion = Number.isFinite(rawBaseVersion) && rawBaseVersion > 0;
          const canAttemptConditionalDelete =
            Boolean(remoteId) &&
            hasValidBaseVersion &&
            (tomb?.baselineStatus === 'ready' || tomb?.baselineStatus === undefined);

          if (canAttemptConditionalDelete) {
            const delRes = await softDeleteSongConditionalInSupabase(
              {
                legacyId: delItem.entityId,
                remoteId,
                baseVersion: rawBaseVersion,
                deletedAt: tomb?.deletedAt || delItem.queuedAt,
              },
              userId
            );

            if (delRes.status === 'deleted' || delRes.status === 'already_deleted') {
              const ver = Number(delRes.row?.server_version || 0);
              if (ver > maxConfirmedVersion) maxConfirmedVersion = ver;
              await db.transaction('rw', [db.tombstones, db.syncOutbox], async () => {
                const curOutbox = await db.syncOutbox.get(delItem.key);
                if (!curOutbox || (curOutbox.op === 'delete' && curOutbox.queuedAt === delItem.queuedAt)) {
                  await db.tombstones.delete(delItem.entityId);
                  await db.syncOutbox.delete(delItem.key);
                }
              });
              return;
            }

            if (delRes.status === 'conflict') {
              await preserveSongOnBlockedDelete(delItem, tomb, delRes.remoteRow, 'conflict');
              return;
            }

            if (delRes.status === 'missing_version_mechanism') {
              if (!schemaWarning) schemaWarning = delRes.error;
              uploadErrors.push(delRes.error);
              return;
            }

            uploadErrors.push(delRes.error);
            return;
          }

          // Legacy / missing-baseline / local_only tombstone: read-only inspect, NEVER issue cloud delete
          const inspectRes = await inspectSongDeletionCandidateInSupabase(
            { legacyId: delItem.entityId, remoteId },
            userId
          );

          if (inspectRes.status === 'not_found' || inspectRes.status === 'already_deleted') {
            if (inspectRes.status === 'already_deleted') {
              const ver = Number(inspectRes.row?.server_version || 0);
              if (ver > maxConfirmedVersion) maxConfirmedVersion = ver;
            }
            await db.transaction('rw', [db.tombstones, db.syncOutbox], async () => {
              const curOutbox = await db.syncOutbox.get(delItem.key);
              if (!curOutbox || (curOutbox.op === 'delete' && curOutbox.queuedAt === delItem.queuedAt)) {
                await db.tombstones.delete(delItem.entityId);
                await db.syncOutbox.delete(delItem.key);
              }
            });
            return;
          }

          if (inspectRes.status === 'active_found') {
            await preserveSongOnBlockedDelete(delItem, tomb, inspectRes.remoteRow, 'missing_baseline');
            return;
          }

          if (inspectRes.status === 'missing_version_mechanism') {
            if (!schemaWarning) schemaWarning = inspectRes.error;
            uploadErrors.push(inspectRes.error);
            return;
          }

          uploadErrors.push(inspectRes.error);
        };

        // B1. Push Song Deletions (version-conditional soft delete only)
        if (songDeletes.length > 0) {
          for (const delItem of songDeletes) {
            await pushSingleSongDeletion(delItem);
          }
        }

        const pushSingleSongWithConcurrency = async (
          sentSnapshot: Song
        ): Promise<{ remoteId?: string; activeInCloud: boolean }> => {
          const writeRes = await saveSongWithConcurrency(sentSnapshot, userId);

          if (writeRes.status === 'ok') {
            const remote = writeRes.row;
            const newVersion = Number(remote?.server_version);
            if (!remote?.id || !Number.isFinite(newVersion) || newVersion <= 0) {
              const errMsg = `Song "${sentSnapshot.title || sentSnapshot.id}" did not receive a confirmed server_version.`;
              uploadErrors.push(errMsg);
              if (!schemaWarning) schemaWarning = errMsg;
              return { activeInCloud: false };
            }

            if (newVersion > maxConfirmedVersion) maxConfirmedVersion = newVersion;

            await db.transaction('rw', [db.songs, db.syncOutbox], async () => {
              const latest = await db.songs.get(sentSnapshot.id);
              const currentOutbox = await db.syncOutbox.get(`song:${sentSnapshot.id}`);
              if (!latest) {
                if (!currentOutbox || currentOutbox.op === 'upsert') {
                  await db.syncOutbox.delete(`song:${sentSnapshot.id}`);
                }
                return;
              }
              const editedDuringPush = latest.updatedAt !== sentSnapshot.updatedAt;
              await db.songs.put({
                ...latest,
                remoteId: String(remote.id),
                baseVersion: newVersion,
                serverUpdatedAt: remote.updated_at || latest.serverUpdatedAt,
                dirty: editedDuringPush ? 1 : 0,
              });
              if (!editedDuringPush) {
                await db.syncOutbox.delete(`song:${sentSnapshot.id}`);
              }
            });

            return { remoteId: String(remote.id), activeInCloud: true };
          }

          if (writeRes.status === 'conflict') {
            const remoteRow = writeRes.remoteRow;
            const remoteVersion = Number(remoteRow?.server_version || 0);
            const remoteUpdatedAt = remoteRow?.updated_at
              ? new Date(remoteRow.updated_at).getTime()
              : Date.now();
            if (remoteVersion > maxConfirmedVersion) maxConfirmedVersion = remoteVersion;

            await db.transaction('rw', [db.songs, db.tombstones, db.syncOutbox], async () => {
              const [latest, outboxItems] = await Promise.all([
                db.songs.get(sentSnapshot.id),
                db.syncOutbox.toArray(),
              ]);
              const currentOutbox = outboxItems.find((o) => o.key === `song:${sentSnapshot.id}`);

              if (remoteRow.deleted_at) {
                if (latest && (!currentOutbox || currentOutbox.op === 'upsert')) {
                  const conflictKey = `song:${sentSnapshot.id}:deleted:${remoteVersion > 0 ? remoteVersion : String(remoteRow.deleted_at)}`;
                  const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
                  const restoredId = existingConflict?.entityId || uuidv4();
                  const now = Date.now();
                  await db.songs.put({
                    ...latest,
                    id: restoredId,
                    title: appendCopyLabel(latest.title, 'Untitled Song', 'Restored Copy'),
                    remoteId: undefined,
                    baseVersion: undefined,
                    serverUpdatedAt: undefined,
                    updatedAt: now,
                    dirty: 1,
                  });
                  await db.syncOutbox.put({
                    key: `song:${restoredId}`,
                    entityType: 'song',
                    entityId: restoredId,
                    op: 'upsert',
                    queuedAt: now,
                    attempts: 0,
                    conflictKey,
                  });
                  conflictCount++;
                }

                await db.songs.delete(sentSnapshot.id);
                await db.tombstones.delete(sentSnapshot.id);
                await db.syncOutbox.delete(`song:${sentSnapshot.id}`);
                return;
              }

              const remoteMeta =
                remoteRow.metadata && typeof remoteRow.metadata === 'object' ? remoteRow.metadata : {};
              const remoteBpm = typeof remoteRow.bpm === 'number' ? remoteRow.bpm : undefined;
              const normalizedTitle = remoteRow.title || latest?.title || 'Untitled Song';
              const normalizedLyrics =
                typeof remoteRow.lyrics === 'string' ? remoteRow.lyrics : latest?.lyrics || '';

              if (latest && (!currentOutbox || currentOutbox.op === 'upsert')) {
                const conflictKey = `song:${sentSnapshot.id}:v${remoteVersion > 0 ? remoteVersion : String(remoteRow.id)}`;
                const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
                const conflictId = existingConflict?.entityId || uuidv4();
                const now = Date.now();
                await db.songs.put({
                  ...latest,
                  id: conflictId,
                  title: appendCopyLabel(latest.title, 'Untitled Song', 'Conflict Copy'),
                  remoteId: undefined,
                  baseVersion: undefined,
                  serverUpdatedAt: undefined,
                  updatedAt: now,
                  dirty: 1,
                });
                await db.syncOutbox.put({
                  key: `song:${conflictId}`,
                  entityType: 'song',
                  entityId: conflictId,
                  op: 'upsert',
                  queuedAt: now,
                  attempts: 0,
                  conflictKey,
                });
                await db.songs.put({
                  id: sentSnapshot.id,
                  title: normalizedTitle,
                  lyrics: normalizedLyrics,
                  createdAt:
                    latest.createdAt ||
                    (remoteRow.created_at ? new Date(remoteRow.created_at).getTime() : now),
                  updatedAt: remoteUpdatedAt || now,
                  bpm: remoteBpm,
                  metadata: remoteMeta,
                  remoteId: String(remoteRow.id),
                  baseVersion: remoteVersion || undefined,
                  serverUpdatedAt: remoteRow.updated_at,
                  dirty: 0,
                });
                await db.syncOutbox.delete(`song:${sentSnapshot.id}`);
                conflictCount++;
              }
            });

            return {
              remoteId: remoteRow.deleted_at ? undefined : String(remoteRow.id),
              activeInCloud: !remoteRow.deleted_at,
            };
          }

          if (writeRes.status === 'missing_version_mechanism') {
            if (!schemaWarning) schemaWarning = writeRes.error;
            uploadErrors.push(writeRes.error);
            return { remoteId: sentSnapshot.remoteId, activeInCloud: false };
          }

          uploadErrors.push(writeRes.error);
          return { remoteId: sentSnapshot.remoteId, activeInCloud: false };
        };

        // B2. Push Song Inserts/Conditional Updates with per-item checkpoints
        if (songUpserts.length > 0) {
          const allTargetSongs = (await db.songs.bulkGet(songUpserts.map((u) => u.entityId))).filter(
            (s): s is Song => Boolean(s)
          );

          // Remove orphaned outbox entries whose songs no longer exist locally
          const foundIds = new Set(allTargetSongs.map((s) => s.id));
          const orphanKeys = songUpserts.filter((u) => !foundIds.has(u.entityId)).map((u) => u.key);
          if (orphanKeys.length) await db.syncOutbox.bulkDelete(orphanKeys);

          for (const song of allTargetSongs) {
            await pushSingleSongWithConcurrency(song);
          }
        }

        const preserveSetlistOnBlockedDelete = async (
          delItem: SyncOutboxItem,
          tomb: Tombstone | undefined,
          remoteRow: any,
          kind: 'conflict' | 'missing_baseline'
        ) => {
          const remoteVersion = Number(remoteRow?.server_version || 0);
          if (remoteVersion > maxConfirmedVersion) maxConfirmedVersion = remoteVersion;

          const remoteUpdatedAt = remoteRow?.updated_at
            ? new Date(remoteRow.updated_at).getTime()
            : Date.now();
          const normalizedName = remoteRow?.name || tomb?.titleSnapshot || 'Untitled Setlist';
          const remoteId = String(remoteRow?.id || tomb?.remoteId || delItem.remoteId || '');

          const latestSongs = await db.songs.toArray();
          const supabaseSongIdToLegacyId = new Map<string, string>();
          for (const s of latestSongs) {
            if (s.remoteId) supabaseSongIdToLegacyId.set(s.remoteId, s.id);
          }
          const rawRefs: string[] = Array.isArray(remoteRow?.songs)
            ? remoteRow.songs.map((r: any) => String(r || '').trim()).filter(Boolean)
            : [];
          const missingUuids = rawRefs.filter((uuid) => !supabaseSongIdToLegacyId.has(uuid));
          const extraActiveSongs: Song[] = [];
          const confirmedDeletedUuids = new Set<string>();

          if (missingUuids.length > 0) {
            try {
              const extraSongs = await fetchSongsByIdsForUser(userId, missingUuids, true, true);
              for (const extra of extraSongs) {
                const extId = String(extra?.id || '').trim();
                const extLegacy = String(extra?.legacy_id || '').trim();
                if (extId && extLegacy) {
                  supabaseSongIdToLegacyId.set(extId, extLegacy);
                  if (extra.deleted_at) {
                    confirmedDeletedUuids.add(extId);
                  } else {
                    extraActiveSongs.push({
                      id: extLegacy,
                      title: extra.title || 'Untitled Song',
                      lyrics: typeof extra.lyrics === 'string' ? extra.lyrics : '',
                      createdAt: extra.created_at
                        ? new Date(extra.created_at).getTime()
                        : Date.now(),
                      updatedAt: extra.updated_at
                        ? new Date(extra.updated_at).getTime()
                        : Date.now(),
                      bpm: typeof extra.bpm === 'number' ? extra.bpm : undefined,
                      metadata:
                        extra.metadata && typeof extra.metadata === 'object' ? extra.metadata : {},
                      remoteId: extId,
                      baseVersion: Number(extra.server_version) || undefined,
                      serverUpdatedAt: extra.updated_at,
                      dirty: 0,
                    });
                  }
                }
              }
            } catch (fetchErr: any) {
              uploadErrors.push(
                `Failed fetching songs referenced by setlist "${normalizedName}": ${fetchErr?.message || fetchErr}`
              );
              return;
            }
          }

          const effectiveRemoteSongIds: string[] = [];
          for (const uuid of rawRefs) {
            if (confirmedDeletedUuids.has(uuid)) continue;
            const mappedLegacy = supabaseSongIdToLegacyId.get(uuid);
            if (mappedLegacy) {
              effectiveRemoteSongIds.push(mappedLegacy);
            } else {
              console.warn(
                `[SyncEngine] Skipping unresolvable Supabase song UUID "${uuid}" while preserving setlist "${delItem.entityId}" without substituting raw UUID.`
              );
            }
          }

          const conflictKey =
            kind === 'conflict'
              ? `setlist:${delItem.entityId}:delconflict:v${remoteVersion > 0 ? remoteVersion : remoteId}`
              : `setlist:${delItem.entityId}:missing-baseline:v${remoteVersion > 0 ? remoteVersion : remoteId}`;
          const reasonMsg =
            kind === 'conflict'
              ? `Deletion of setlist "${normalizedName}" was blocked because a newer cloud version exists.`
              : `Deletion of setlist "${normalizedName}" was blocked because it lacked a baseline version; cloud record preserved.`;

          await db.transaction('rw', [db.songs, db.setlists, db.tombstones, db.syncOutbox], async () => {
            const currentOutbox = await db.syncOutbox.get(delItem.key);
            if (
              currentOutbox &&
              (currentOutbox.op !== 'delete' || currentOutbox.queuedAt !== delItem.queuedAt)
            ) {
              return;
            }

            for (const extraSong of extraActiveSongs) {
              const existingLocal = await db.songs.get(extraSong.id);
              const existingTomb = await db.tombstones.get(extraSong.id);
              if (!existingLocal && !existingTomb) {
                await db.songs.put(extraSong);
              }
            }

            await db.setlists.put({
              id: delItem.entityId,
              name: normalizedName,
              songIds: effectiveRemoteSongIds,
              createdAt: remoteRow?.created_at
                ? new Date(remoteRow.created_at).getTime()
                : Date.now(),
              updatedAt: remoteUpdatedAt,
              remoteId: remoteId || undefined,
              baseVersion: remoteVersion || undefined,
              serverUpdatedAt: remoteRow?.updated_at,
              dirty: 0,
            });

            await db.tombstones.put({
              id: delItem.entityId,
              type: 'setlist',
              deletedAt: tomb?.deletedAt || delItem.queuedAt || Date.now(),
              remoteId: tomb?.remoteId || delItem.remoteId || (remoteId || undefined),
              baseVersion: tomb?.baseVersion ?? delItem.baseVersion,
              serverUpdatedAt: tomb?.serverUpdatedAt,
              titleSnapshot: normalizedName,
              baselineStatus: kind === 'conflict' ? 'conflict_blocked' : 'missing_baseline',
              conflictKey,
              lastError: reasonMsg,
            });

            await db.syncOutbox.put({
              ...delItem,
              remoteId: tomb?.remoteId || delItem.remoteId || (remoteId || undefined),
              baseVersion: tomb?.baseVersion ?? delItem.baseVersion,
              status: kind === 'conflict' ? 'blocked_conflict' : 'blocked_missing_baseline',
              conflictKey,
              lastError: reasonMsg,
            });

            conflictCount++;
            if (!blockedDeletionErrors.includes(reasonMsg)) {
              blockedDeletionErrors.push(reasonMsg);
            }
          });
        };

        const pushSingleSetlistDeletion = async (delItem: SyncOutboxItem) => {
          const tomb = await db.tombstones.get(delItem.entityId);
          if (
            delItem.status === 'blocked_conflict' ||
            delItem.status === 'blocked_missing_baseline' ||
            tomb?.baselineStatus === 'conflict_blocked' ||
            tomb?.baselineStatus === 'missing_baseline'
          ) {
            const label = tomb?.titleSnapshot || delItem.entityId;
            const fallbackMsg =
              delItem.status === 'blocked_missing_baseline' || tomb?.baselineStatus === 'missing_baseline'
                ? `Deletion of setlist "${label}" is blocked because it lacked a baseline version.`
                : `Deletion of setlist "${label}" is blocked because a newer cloud version exists.`;
            const msg = tomb?.lastError || delItem.lastError || fallbackMsg;
            if (!blockedDeletionErrors.includes(msg)) blockedDeletionErrors.push(msg);
            return;
          }

          const remoteId = tomb?.remoteId || delItem.remoteId;
          const rawBaseVersion = Number(tomb?.baseVersion ?? delItem.baseVersion);
          const hasValidBaseVersion = Number.isFinite(rawBaseVersion) && rawBaseVersion > 0;
          const canAttemptConditionalDelete =
            Boolean(remoteId) &&
            hasValidBaseVersion &&
            (tomb?.baselineStatus === 'ready' || tomb?.baselineStatus === undefined);

          if (canAttemptConditionalDelete) {
            const delRes = await softDeleteSetlistConditionalInSupabase(
              {
                legacyId: delItem.entityId,
                remoteId,
                baseVersion: rawBaseVersion,
                deletedAt: tomb?.deletedAt || delItem.queuedAt,
              },
              userId
            );

            if (delRes.status === 'deleted' || delRes.status === 'already_deleted') {
              const ver = Number(delRes.row?.server_version || 0);
              if (ver > maxConfirmedVersion) maxConfirmedVersion = ver;
              await db.transaction('rw', [db.tombstones, db.syncOutbox], async () => {
                const curOutbox = await db.syncOutbox.get(delItem.key);
                if (!curOutbox || (curOutbox.op === 'delete' && curOutbox.queuedAt === delItem.queuedAt)) {
                  await db.tombstones.delete(delItem.entityId);
                  await db.syncOutbox.delete(delItem.key);
                }
              });
              return;
            }

            if (delRes.status === 'conflict') {
              await preserveSetlistOnBlockedDelete(delItem, tomb, delRes.remoteRow, 'conflict');
              return;
            }

            if (delRes.status === 'missing_version_mechanism') {
              if (!schemaWarning) schemaWarning = delRes.error;
              uploadErrors.push(delRes.error);
              return;
            }

            uploadErrors.push(delRes.error);
            return;
          }

          // Legacy / missing-baseline / local_only tombstone: read-only inspect, NEVER issue cloud delete
          const inspectRes = await inspectSetlistDeletionCandidateInSupabase(
            { legacyId: delItem.entityId, remoteId },
            userId
          );

          if (inspectRes.status === 'not_found' || inspectRes.status === 'already_deleted') {
            if (inspectRes.status === 'already_deleted') {
              const ver = Number(inspectRes.row?.server_version || 0);
              if (ver > maxConfirmedVersion) maxConfirmedVersion = ver;
            }
            await db.transaction('rw', [db.tombstones, db.syncOutbox], async () => {
              const curOutbox = await db.syncOutbox.get(delItem.key);
              if (!curOutbox || (curOutbox.op === 'delete' && curOutbox.queuedAt === delItem.queuedAt)) {
                await db.tombstones.delete(delItem.entityId);
                await db.syncOutbox.delete(delItem.key);
              }
            });
            return;
          }

          if (inspectRes.status === 'active_found') {
            await preserveSetlistOnBlockedDelete(delItem, tomb, inspectRes.remoteRow, 'missing_baseline');
            return;
          }

          if (inspectRes.status === 'missing_version_mechanism') {
            if (!schemaWarning) schemaWarning = inspectRes.error;
            uploadErrors.push(inspectRes.error);
            return;
          }

          uploadErrors.push(inspectRes.error);
        };

        // B3. Push Setlist Deletions (version-conditional soft delete only, preserving setlist_songs)
        if (setlistDeletes.length > 0) {
          for (const delItem of setlistDeletes) {
            await pushSingleSetlistDeletion(delItem);
          }
        }

        // B4. Push Setlist Inserts/Conditional Updates & Atomic Song Ordering
        if (setlistUpserts.length > 0) {
          const targetSetlists = (await db.setlists.bulkGet(setlistUpserts.map((u) => u.entityId))).filter(
            (sl): sl is Setlist => Boolean(sl)
          );
          const foundSetlistIds = new Set(targetSetlists.map((sl) => sl.id));
          const orphanKeys = setlistUpserts
            .filter((u) => !foundSetlistIds.has(u.entityId))
            .map((u) => u.key);
          if (orphanKeys.length) await db.syncOutbox.bulkDelete(orphanKeys);

          if (targetSetlists.length > 0) {
            // Load local songs to map legacy song IDs -> remote Supabase UUIDs
            let allSongs = await db.songs.toArray();
            const songRemoteIdByLegacy = new Map<string, string>();
            for (const s of allSongs) {
              if (s.remoteId) songRemoteIdByLegacy.set(s.id, s.remoteId);
            }

            // Safety: if any setlist references an active local song missing a remoteId, push it with concurrency first
            const missingRemoteSongs: Song[] = [];
            const seenMissing = new Set<string>();
            for (const sl of targetSetlists) {
              for (const sid of sl.songIds || []) {
                if (!songRemoteIdByLegacy.has(sid) && !seenMissing.has(sid)) {
                  const songObj = allSongs.find((s) => s.id === sid);
                  if (songObj) {
                    missingRemoteSongs.push(songObj);
                    seenMissing.add(sid);
                  }
                }
              }
            }
            for (const missingSong of missingRemoteSongs) {
              const res = await pushSingleSongWithConcurrency(missingSong);
              if (res.activeInCloud && res.remoteId) {
                songRemoteIdByLegacy.set(missingSong.id, res.remoteId);
              }
            }

            if (missingRemoteSongs.length > 0) {
              allSongs = await db.songs.toArray();
              songRemoteIdByLegacy.clear();
              for (const s of allSongs) {
                if (s.remoteId) songRemoteIdByLegacy.set(s.id, s.remoteId);
              }
            }
            const existingLocalSongIds = new Set(allSongs.map((s) => s.id));

            const resolveSetlistConflictFromRemoteRow = async (setlist: Setlist, remoteRow: any) => {
              const remoteVersion = Number(remoteRow?.server_version || 0);
              const remoteUpdatedAt = remoteRow?.updated_at
                ? new Date(remoteRow.updated_at).getTime()
                : Date.now();
              if (remoteVersion > maxConfirmedVersion) maxConfirmedVersion = remoteVersion;

              let effectiveRemoteSongIds: string[] = [];
              if (!remoteRow.deleted_at) {
                const latestSongs = await db.songs.toArray();
                const supabaseSongIdToLegacyId = new Map<string, string>();
                for (const s of latestSongs) {
                  if (s.remoteId) supabaseSongIdToLegacyId.set(s.remoteId, s.id);
                }
                const rawRefs: string[] = Array.isArray(remoteRow.songs)
                  ? remoteRow.songs.map((r: any) => String(r || '').trim()).filter(Boolean)
                  : [];
                const missingUuids = rawRefs.filter((uuid) => !supabaseSongIdToLegacyId.has(uuid));
                if (missingUuids.length > 0) {
                  const extraSongs = await fetchSongsByIdsForUser(userId, missingUuids, true, true);
                  for (const extra of extraSongs) {
                    const extId = String(extra?.id || '').trim();
                    const extLegacy = String(extra?.legacy_id || '').trim();
                    if (extId && extLegacy) supabaseSongIdToLegacyId.set(extId, extLegacy);
                  }
                }
                for (const uuid of rawRefs) {
                  const mappedLegacy = supabaseSongIdToLegacyId.get(uuid);
                  if (mappedLegacy) {
                    effectiveRemoteSongIds.push(mappedLegacy);
                  }
                }
              }

              await db.transaction('rw', [db.setlists, db.tombstones, db.syncOutbox], async () => {
                const [latest, outboxItems] = await Promise.all([
                  db.setlists.get(setlist.id),
                  db.syncOutbox.toArray(),
                ]);
                const currentOutbox = outboxItems.find((o) => o.key === `setlist:${setlist.id}`);

                if (remoteRow.deleted_at) {
                  if (latest && (!currentOutbox || currentOutbox.op === 'upsert')) {
                    const conflictKey = `setlist:${setlist.id}:deleted:${remoteVersion > 0 ? remoteVersion : String(remoteRow.deleted_at)}`;
                    const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
                    const restoredId = existingConflict?.entityId || uuidv4();
                    const now = Date.now();
                    await db.setlists.put({
                      ...latest,
                      id: restoredId,
                      name: appendCopyLabel(latest.name, 'Untitled Setlist', 'Restored Copy'),
                      remoteId: undefined,
                      baseVersion: undefined,
                      serverUpdatedAt: undefined,
                      updatedAt: now,
                      dirty: 1,
                    });
                    await db.syncOutbox.put({
                      key: `setlist:${restoredId}`,
                      entityType: 'setlist',
                      entityId: restoredId,
                      op: 'upsert',
                      queuedAt: now,
                      attempts: 0,
                      conflictKey,
                    });
                    conflictCount++;
                  }
                  await db.setlists.delete(setlist.id);
                  await db.tombstones.delete(setlist.id);
                  await db.syncOutbox.delete(`setlist:${setlist.id}`);
                  return;
                }

                const normalizedName = remoteRow.name || latest?.name || 'Untitled Setlist';
                if (latest && (!currentOutbox || currentOutbox.op === 'upsert')) {
                  const conflictKey = `setlist:${setlist.id}:v${remoteVersion > 0 ? remoteVersion : String(remoteRow.id)}`;
                  const existingConflict = outboxItems.find((o) => o.conflictKey === conflictKey);
                  const conflictId = existingConflict?.entityId || uuidv4();
                  const now = Date.now();
                  await db.setlists.put({
                    ...latest,
                    id: conflictId,
                    name: appendCopyLabel(latest.name, 'Untitled Setlist', 'Conflict Copy'),
                    remoteId: undefined,
                    baseVersion: undefined,
                    serverUpdatedAt: undefined,
                    updatedAt: now,
                    dirty: 1,
                  });
                  await db.syncOutbox.put({
                    key: `setlist:${conflictId}`,
                    entityType: 'setlist',
                    entityId: conflictId,
                    op: 'upsert',
                    queuedAt: now,
                    attempts: 0,
                    conflictKey,
                  });
                  await db.setlists.put({
                    id: setlist.id,
                    name: normalizedName,
                    songIds: effectiveRemoteSongIds,
                    createdAt:
                      latest.createdAt ||
                      (remoteRow.created_at ? new Date(remoteRow.created_at).getTime() : now),
                    updatedAt: remoteUpdatedAt || now,
                    remoteId: String(remoteRow.id),
                    baseVersion: remoteVersion || undefined,
                    serverUpdatedAt: remoteRow.updated_at,
                    dirty: 0,
                  });
                  await db.syncOutbox.delete(`setlist:${setlist.id}`);
                  conflictCount++;
                }
              });
            };

            const preservePendingSetlistWithMetaBaseline = async (setlist: Setlist, remoteSetlist: any) => {
              const metaVersion = Number(remoteSetlist?.server_version || 0);
              if (metaVersion > maxConfirmedVersion) maxConfirmedVersion = metaVersion;
              await db.transaction('rw', [db.setlists], async () => {
                const latest = await db.setlists.get(setlist.id);
                if (!latest) return;
                await db.setlists.put({
                  ...latest,
                  remoteId: String(remoteSetlist.id),
                  baseVersion: metaVersion > 0 ? metaVersion : latest.baseVersion,
                  serverUpdatedAt: remoteSetlist.updated_at || latest.serverUpdatedAt,
                  dirty: 1,
                });
              });
            };

            for (const setlist of targetSetlists) {
              const unresolvedLocalSongIds = (setlist.songIds || []).filter(
                (sid) => existingLocalSongIds.has(sid) && !songRemoteIdByLegacy.has(sid)
              );
              if (unresolvedLocalSongIds.length > 0) {
                uploadErrors.push(
                  `Setlist "${setlist.name || setlist.id}" skipped because referenced song(s) could not be confirmed in the cloud.`
                );
                continue;
              }

              const metaWriteRes = await saveSetlistMetadataWithConcurrency(setlist, userId);

              if (metaWriteRes.status === 'missing_version_mechanism') {
                if (!schemaWarning) schemaWarning = metaWriteRes.error;
                uploadErrors.push(metaWriteRes.error);
                continue;
              }

              if (metaWriteRes.status === 'conflict_fetch_failed') {
                uploadErrors.push(metaWriteRes.error);
                continue;
              }

              if (metaWriteRes.status === 'conflict') {
                await resolveSetlistConflictFromRemoteRow(setlist, metaWriteRes.remoteRow);
                continue;
              }

              // Status === 'ok'
              const remoteSetlist = metaWriteRes.row;
              const remoteSongIds = (setlist.songIds || [])
                .map((sid) => songRemoteIdByLegacy.get(sid))
                .filter((rid): rid is string => Boolean(rid));

              const metaSavedVersion = Number(remoteSetlist?.server_version);
              const existingBaseVersion = Number(setlist.baseVersion);
              const expectedVersion =
                Number.isFinite(metaSavedVersion) && metaSavedVersion > 0
                  ? metaSavedVersion
                  : Number.isFinite(existingBaseVersion) && existingBaseVersion > 0
                    ? existingBaseVersion
                    : undefined;

              if (!expectedVersion) {
                const errMsg = `Setlist "${setlist.name || setlist.id}" skipped relationship sync because no valid positive expected server_version is available.`;
                uploadErrors.push(errMsg);
                if (!schemaWarning) schemaWarning = errMsg;
                await preservePendingSetlistWithMetaBaseline(setlist, remoteSetlist);
                continue;
              }

              let linkRes: Awaited<ReturnType<typeof replaceSetlistSongsInSupabase>>;
              try {
                linkRes = await replaceSetlistSongsInSupabase(
                  String(remoteSetlist.id),
                  remoteSongIds,
                  userId,
                  expectedVersion
                );
              } catch (linkErr: any) {
                await preservePendingSetlistWithMetaBaseline(setlist, remoteSetlist);
                uploadErrors.push(linkErr?.message || String(linkErr));
                continue;
              }

              if (linkRes.status === 'missing_version_mechanism') {
                await preservePendingSetlistWithMetaBaseline(setlist, remoteSetlist);
                if (!schemaWarning) schemaWarning = linkRes.error;
                uploadErrors.push(linkRes.error);
                continue;
              }

              if (linkRes.status === 'conflict_fetch_failed') {
                await preservePendingSetlistWithMetaBaseline(setlist, remoteSetlist);
                uploadErrors.push(linkRes.error);
                continue;
              }

              if (linkRes.status === 'conflict') {
                await resolveSetlistConflictFromRemoteRow(setlist, linkRes.remoteRow);
                continue;
              }

              const confirmedVersion = linkRes.serverVersion;
              if (confirmedVersion > maxConfirmedVersion) {
                maxConfirmedVersion = confirmedVersion;
              }

              await db.transaction('rw', [db.setlists, db.syncOutbox], async () => {
                const latest = await db.setlists.get(setlist.id);
                const currentOutbox = await db.syncOutbox.get(`setlist:${setlist.id}`);
                if (!latest) {
                  if (!currentOutbox || currentOutbox.op === 'upsert') {
                    await db.syncOutbox.delete(`setlist:${setlist.id}`);
                  }
                  return;
                }
                const editedDuringPush = latest.updatedAt !== setlist.updatedAt;
                await db.setlists.put({
                  ...latest,
                  remoteId: String(remoteSetlist.id),
                  baseVersion: confirmedVersion,
                  serverUpdatedAt: remoteSetlist.updated_at || latest.serverUpdatedAt,
                  dirty: editedDuringPush ? 1 : 0,
                });
                if (!editedDuringPush) {
                  await db.syncOutbox.delete(`setlist:${setlist.id}`);
                }
              });
            }
          }
        }

        // 5. Finalize sync snapshot
        const remainingPending = await db.syncOutbox.count();
        const now = Date.now();
        const latestMeta = await db.syncMeta.get('state');

        let finalStatus: SyncStatus = 'synced';
        let lastError: string | null = null;
        if (uploadErrors.length > 0 || blockedDeletionErrors.length > 0) {
          finalStatus = 'error';
          lastError = [...blockedDeletionErrors, ...uploadErrors].join(' ');
        } else if (conflictCount > 0) {
          finalStatus = 'conflict';
        }

        const effectiveSyncedAt = finalStatus === 'error' ? latestMeta?.lastSyncedAt || null : now;
        const effectiveSyncVersion = Math.max(
          latestMeta?.lastSyncVersion ?? 0,
          maxConfirmedVersion
        );

        await db.syncMeta.put({
          id: 'state',
          activeUserId: userId,
          lastSyncVersion: effectiveSyncVersion,
          lastSyncedAt: effectiveSyncedAt,
          lastReconciledAt: now,
        });

        this.emit({
          status: finalStatus,
          isSyncing: false,
          pendingCount: remainingPending,
          lastSyncedAt: effectiveSyncedAt,
          lastSyncVersion: effectiveSyncVersion,
          lastConflictCount: conflictCount,
          schemaWarning,
          lastError,
        });

        return this.snapshot;
      } catch (err: any) {
        const msg = err?.message || `Sync failed during ${reason}.`;
        console.error('[SyncEngine] Sync error:', err);
        const remainingPending = await db.syncOutbox.count().catch(() => this.snapshot.pendingCount);
        const isAuthErr =
          String(err?.code || '').includes('401') ||
          String(msg).toLowerCase().includes('unauthorized') ||
          String(msg).toLowerCase().includes('jwt');

        this.emit({
          status: isAuthErr ? 'auth_required' : typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
          isSyncing: false,
          pendingCount: remainingPending,
          lastError: msg,
        });
        return this.snapshot;
      }
    };

    const runWithLock = async (): Promise<SyncStateSnapshot> => {
      if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
        let result: SyncStateSnapshot | null = null;
        await navigator.locks.request('songbinder_sync_lock', { ifAvailable: true }, async (lock) => {
          if (!lock) {
            result = this.snapshot;
            return;
          }
          result = await execute();
        });
        return result ?? this.snapshot;
      }
      return execute();
    };

    this.inFlightPromise = runWithLock().finally(() => {
      this.inFlightPromise = null;
    });

    return this.inFlightPromise;
  }
}

export const syncEngine = new SyncEngine();
