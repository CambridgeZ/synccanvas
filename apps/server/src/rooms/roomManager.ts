import {
  CRDTDocument,
  type CollaboratorPresence,
  type CRDTOperation,
  type EphemeralCursorPayload,
  type PresenceUpdatePayload,
  type RoomSummaryDTO,
  type SnapshotSavedPayload,
  type SyncJoinPayload,
  type SyncStatePayload,
} from '@whiteboard/shared';
import type { SqliteWhiteboardStore } from '../storage/sqliteStore';

export interface RoomManagerOptions {
  snapshotOpThreshold: number;
  snapshotIntervalMs: number;
  compactionRetainOps: number;
  onAutoSnapshotSaved?: (payload: SnapshotSavedPayload) => void;
}

interface ManagedRoom {
  roomId: string;
  doc: CRDTDocument;
  latestSeq: number;
  compactedSeq: number;
  dirtyOpsSinceSnapshot: number;
  lastSnapshotAt: number | null;
  updatedAt: number;
  members: Map<string, CollaboratorPresence>; // keyed by socket.id
}

export class RoomManager {
  private readonly store: SqliteWhiteboardStore;
  private readonly opts: RoomManagerOptions;
  private readonly rooms: Map<string, ManagedRoom> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: SqliteWhiteboardStore, opts: RoomManagerOptions) {
    this.store = store;
    this.opts = opts;
  }

  public startPeriodicSnapshotWorker(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      for (const room of this.rooms.values()) {
        if (room.dirtyOpsSinceSnapshot > 0) {
          const saved = this.flushSnapshot(room.roomId);
          if (saved && this.opts.onAutoSnapshotSaved) {
            this.opts.onAutoSnapshotSaved(saved);
          }
        }
      }
    }, this.opts.snapshotIntervalMs);
  }

  public getOrLoadRoom(roomId: string): ManagedRoom {
    const cleanId = roomId.trim() || 'lobby-default';
    let room = this.rooms.get(cleanId);
    if (room) return room;

    const boot = this.store.loadRoomBootState(cleanId);
    const doc = new CRDTDocument(cleanId, 'server-authority', boot.snapshot?.lamport ?? 0);
    if (boot.snapshot) {
      doc.mergeSnapshot(boot.snapshot);
    }
    if (boot.tailOps.length > 0) {
      doc.applyOps(boot.tailOps);
    }

    room = {
      roomId: cleanId,
      doc,
      latestSeq: boot.meta.latestSeq,
      compactedSeq: boot.meta.compactedSeq,
      dirtyOpsSinceSnapshot: 0,
      lastSnapshotAt: boot.meta.lastSnapshotAt,
      updatedAt: boot.meta.updatedAt,
      members: new Map(),
    };

    this.rooms.set(cleanId, room);
    return room;
  }

  /**
   * Handles initial join AND offline-reconnection state merge atomically:
   * 1. Merges any `pendingOps` buffered while client was offline.
   * 2. Persists deduplicated new ops into SQLite WAL.
   * 3. Computes either incremental `delta` ops or full `snapshot` depending on `lastKnownServerSeq`.
   */
  public handleJoinAndSync(
    socketId: string,
    payload: SyncJoinPayload,
  ): {
    roomId: string;
    syncState: SyncStatePayload;
    acceptedOfflineOps: CRDTOperation[];
    snapshotSaved: SnapshotSavedPayload | null;
  } {
    const room = this.getOrLoadRoom(payload.roomId);
    const priorKnownSeq = Math.max(0, Math.floor(payload.lastKnownServerSeq ?? 0));

    let acceptedOfflineOps: CRDTOperation[] = [];
    let ackedOpIds: string[] = [];
    let snapshotSaved: SnapshotSavedPayload | null = null;

    if (Array.isArray(payload.pendingOps) && payload.pendingOps.length > 0) {
      room.doc.applyOps(payload.pendingOps);
      const persistRes = this.store.appendOperations(
        room.roomId,
        payload.pendingOps,
        room.doc.visibleElementCount,
      );
      acceptedOfflineOps = persistRes.accepted;
      ackedOpIds = persistRes.ackedOpIds;
      room.latestSeq = persistRes.latestSeq;
      room.dirtyOpsSinceSnapshot += acceptedOfflineOps.length;
      room.updatedAt = Date.now();
    }

    // Register / refresh collaborator presence (deduplicating stale socket entries of same clientId)
    for (const [existingSocketId, member] of room.members.entries()) {
      if (member.clientId === payload.user.clientId && existingSocketId !== socketId) {
        room.members.delete(existingSocketId);
      }
    }

    const now = Date.now();
    room.members.set(socketId, {
      socketId,
      clientId: payload.user.clientId,
      name: payload.user.name.trim() || '匿名协作者',
      color: payload.user.color || '#6366f1',
      activeTool: payload.activeTool ?? 'pencil',
      cursor: null,
      selectedIds: [],
      joinedAt: now,
      lastActiveAt: now,
    });

    // Choose delta mode if client had a valid prior sequence still covered by SQLite WAL
    const canServeDelta =
      priorKnownSeq > 0 &&
      priorKnownSeq >= room.compactedSeq &&
      priorKnownSeq <= room.latestSeq;

    let syncState: SyncStatePayload;
    if (canServeDelta) {
      const missedOps = this.store
        .getOpsAfter(room.roomId, priorKnownSeq)
        .filter((op) => op.clientId !== payload.user.clientId);

      syncState = {
        roomId: room.roomId,
        mode: 'delta',
        missedOps,
        ackedOpIds,
        serverSeq: room.latestSeq,
        compactedSeq: room.compactedSeq,
        lastSnapshotAt: room.lastSnapshotAt,
        members: this.getRoomMembers(room.roomId),
      };
    } else {
      syncState = {
        roomId: room.roomId,
        mode: 'snapshot',
        snapshot: room.doc.toSnapshot(),
        ackedOpIds,
        serverSeq: room.latestSeq,
        compactedSeq: room.compactedSeq,
        lastSnapshotAt: room.lastSnapshotAt,
        members: this.getRoomMembers(room.roomId),
      };
    }

    if (room.dirtyOpsSinceSnapshot >= this.opts.snapshotOpThreshold) {
      snapshotSaved = this.flushSnapshot(room.roomId);
    }

    return {
      roomId: room.roomId,
      syncState,
      acceptedOfflineOps,
      snapshotSaved,
    };
  }

  public submitOperations(
    roomId: string,
    ops: ReadonlyArray<CRDTOperation>,
  ): {
    accepted: CRDTOperation[];
    ackedOpIds: string[];
    serverSeq: number;
    snapshotSaved: SnapshotSavedPayload | null;
  } {
    const room = this.getOrLoadRoom(roomId);
    if (!ops || ops.length === 0) {
      return {
        accepted: [],
        ackedOpIds: [],
        serverSeq: room.latestSeq,
        snapshotSaved: null,
      };
    }

    room.doc.applyOps(ops);
    const res = this.store.appendOperations(
      room.roomId,
      ops,
      room.doc.visibleElementCount,
    );

    room.latestSeq = res.latestSeq;
    room.dirtyOpsSinceSnapshot += res.accepted.length;
    room.updatedAt = Date.now();

    let snapshotSaved: SnapshotSavedPayload | null = null;
    if (room.dirtyOpsSinceSnapshot >= this.opts.snapshotOpThreshold) {
      snapshotSaved = this.flushSnapshot(room.roomId);
    }

    return {
      accepted: res.accepted,
      ackedOpIds: res.ackedOpIds,
      serverSeq: room.latestSeq,
      snapshotSaved,
    };
  }

  public updateCursorPresence(socketId: string, payload: EphemeralCursorPayload): void {
    const room = this.rooms.get(payload.roomId);
    if (!room) return;
    const member = room.members.get(socketId);
    if (!member) return;
    member.cursor = { x: payload.x, y: payload.y };
    member.activeTool = payload.activeTool;
    member.lastActiveAt = Date.now();
  }

  public updateMemberPresence(
    socketId: string,
    payload: PresenceUpdatePayload,
  ): CollaboratorPresence[] | null {
    const room = this.rooms.get(payload.roomId);
    if (!room) return null;
    const member = room.members.get(socketId);
    if (!member) return null;

    if (payload.activeTool !== undefined) {
      member.activeTool = payload.activeTool;
    }
    if (payload.selectedIds !== undefined) {
      member.selectedIds = payload.selectedIds;
    }
    member.lastActiveAt = Date.now();
    return this.getRoomMembers(room.roomId);
  }

  public touchHeartbeat(socketId: string, roomId: string | null): void {
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    const member = room?.members.get(socketId);
    if (member) {
      member.lastActiveAt = Date.now();
    }
  }

  public removeSocket(socketId: string): Array<{ roomId: string; members: CollaboratorPresence[] }> {
    const affected: Array<{ roomId: string; members: CollaboratorPresence[] }> = [];
    for (const room of this.rooms.values()) {
      if (room.members.delete(socketId)) {
        affected.push({
          roomId: room.roomId,
          members: this.getRoomMembers(room.roomId),
        });
      }
    }
    return affected;
  }

  public getRoomMembers(roomId: string): CollaboratorPresence[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  public flushSnapshot(roomId: string): SnapshotSavedPayload | null {
    const room = this.getOrLoadRoom(roomId);
    const snapshot = room.doc.toSnapshot();
    const elementCount = room.doc.visibleElementCount;

    const { savedAt, compactedSeq } = this.store.saveSnapshot(
      room.roomId,
      room.latestSeq,
      snapshot,
      elementCount,
      this.opts.compactionRetainOps,
    );

    room.compactedSeq = Math.max(room.compactedSeq, compactedSeq);
    room.lastSnapshotAt = savedAt;
    room.dirtyOpsSinceSnapshot = 0;

    return {
      roomId: room.roomId,
      snapshotSeq: room.latestSeq,
      savedAt,
      elementCount,
    };
  }

  public flushAllDirtySnapshots(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.dirtyOpsSinceSnapshot > 0) {
        this.flushSnapshot(room.roomId);
        count += 1;
      }
    }
    return count;
  }

  public getRoomDiagnostics(roomId: string) {
    const room = this.getOrLoadRoom(roomId);
    return {
      roomId: room.roomId,
      latestSeq: room.latestSeq,
      compactedSeq: room.compactedSeq,
      lamport: room.doc.lamport,
      visibleElements: room.doc.visibleElementCount,
      totalRecords: room.doc.totalRecordCount,
      dirtyOpsSinceSnapshot: room.dirtyOpsSinceSnapshot,
      onlineCount: room.members.size,
      lastSnapshotAt: room.lastSnapshotAt,
      updatedAt: room.updatedAt,
    };
  }

  public listRoomSummaries(): RoomSummaryDTO[] {
    const stored = this.store.listRooms();
    const map = new Map<string, RoomSummaryDTO>();

    for (const item of stored) {
      const live = this.rooms.get(item.roomId);
      map.set(item.roomId, {
        roomId: item.roomId,
        onlineCount: live ? live.members.size : 0,
        elementCount: live ? live.doc.visibleElementCount : item.elementCount,
        latestSeq: live ? live.latestSeq : item.latestSeq,
        lastSnapshotAt: live ? live.lastSnapshotAt : item.lastSnapshotAt,
        updatedAt: live ? live.updatedAt : item.updatedAt,
      });
    }

    for (const live of this.rooms.values()) {
      if (!map.has(live.roomId)) {
        map.set(live.roomId, {
          roomId: live.roomId,
          onlineCount: live.members.size,
          elementCount: live.doc.visibleElementCount,
          latestSeq: live.latestSeq,
          lastSnapshotAt: live.lastSnapshotAt,
          updatedAt: live.updatedAt,
        });
      }
    }

    return [...map.values()].sort((a, b) => {
      if (b.onlineCount !== a.onlineCount) return b.onlineCount - a.onlineCount;
      return b.updatedAt - a.updatedAt;
    });
  }

  public dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAllDirtySnapshots();
  }
}
