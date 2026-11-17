import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CRDTOperation, CRDTSnapshot } from '@whiteboard/shared';

export interface StoredRoomMeta {
  roomId: string;
  latestSeq: number;
  compactedSeq: number;
  elementCount: number;
  lastSnapshotAt: number | null;
  updatedAt: number;
}

export interface RoomBootState {
  meta: StoredRoomMeta;
  snapshot: CRDTSnapshot | null;
  tailOps: CRDTOperation[];
}

export class SqliteWhiteboardStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        latest_seq INTEGER NOT NULL DEFAULT 0,
        compacted_seq INTEGER NOT NULL DEFAULT 0,
        element_count INTEGER NOT NULL DEFAULT 0,
        last_snapshot_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_snapshots (
        room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
        snapshot_seq INTEGER NOT NULL,
        lamport INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_ops (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        server_seq INTEGER NOT NULL,
        op_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        lamport INTEGER NOT NULL,
        op_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, server_seq),
        UNIQUE (room_id, op_id)
      );

      CREATE INDEX IF NOT EXISTS idx_room_ops_seq ON room_ops(room_id, server_seq);
    `);
  }

  public ensureRoom(roomId: string): StoredRoomMeta {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO rooms (room_id, latest_seq, compacted_seq, element_count, last_snapshot_at, updated_at)
         VALUES (?, 0, 0, 0, NULL, ?)
         ON CONFLICT(room_id) DO NOTHING`,
      )
      .run(roomId, now);

    const row = this.db
      .prepare(
        `SELECT room_id, latest_seq, compacted_seq, element_count, last_snapshot_at, updated_at
         FROM rooms WHERE room_id = ?`,
      )
      .get(roomId) as {
      room_id: string;
      latest_seq: number;
      compacted_seq: number;
      element_count: number;
      last_snapshot_at: number | null;
      updated_at: number;
    };

    return {
      roomId: row.room_id,
      latestSeq: Number(row.latest_seq),
      compactedSeq: Number(row.compacted_seq),
      elementCount: Number(row.element_count),
      lastSnapshotAt: row.last_snapshot_at !== null ? Number(row.last_snapshot_at) : null,
      updatedAt: Number(row.updated_at),
    };
  }

  public loadRoomBootState(roomId: string): RoomBootState {
    const meta = this.ensureRoom(roomId);

    const snapRow = this.db
      .prepare(
        `SELECT snapshot_seq, state_json
         FROM room_snapshots
         WHERE room_id = ?`,
      )
      .get(roomId) as { snapshot_seq: number; state_json: string } | undefined;

    let snapshot: CRDTSnapshot | null = null;
    let replayAfterSeq = 0;

    if (snapRow) {
      snapshot = JSON.parse(snapRow.state_json) as CRDTSnapshot;
      replayAfterSeq = Number(snapRow.snapshot_seq);
    }

    const opRows = this.db
      .prepare(
        `SELECT server_seq, op_json
         FROM room_ops
         WHERE room_id = ? AND server_seq > ?
         ORDER BY server_seq ASC`,
      )
      .all(roomId, replayAfterSeq) as Array<{ server_seq: number; op_json: string }>;

    const tailOps: CRDTOperation[] = opRows.map((row) => {
      const parsed = JSON.parse(row.op_json) as CRDTOperation;
      parsed.serverSeq = Number(row.server_seq);
      return parsed;
    });

    return {
      meta,
      snapshot,
      tailOps,
    };
  }

  public getOpsAfter(roomId: string, afterSeq: number): CRDTOperation[] {
    const rows = this.db
      .prepare(
        `SELECT server_seq, op_json
         FROM room_ops
         WHERE room_id = ? AND server_seq > ?
         ORDER BY server_seq ASC`,
      )
      .all(roomId, afterSeq) as Array<{ server_seq: number; op_json: string }>;

    return rows.map((r) => {
      const op = JSON.parse(r.op_json) as CRDTOperation;
      op.serverSeq = Number(r.server_seq);
      return op;
    });
  }

  /**
   * Appends operations atomically with `opId` deduplication so offline outbox retries are 100% idempotent.
   */
  public appendOperations(
    roomId: string,
    ops: ReadonlyArray<CRDTOperation>,
    visibleElementCount: number,
  ): {
    accepted: CRDTOperation[];
    ackedOpIds: string[];
    latestSeq: number;
  } {
    const meta = this.ensureRoom(roomId);
    if (ops.length === 0) {
      return { accepted: [], ackedOpIds: [], latestSeq: meta.latestSeq };
    }

    const checkDupStmt = this.db.prepare(
      `SELECT server_seq FROM room_ops WHERE room_id = ? AND op_id = ?`,
    );
    const insertOpStmt = this.db.prepare(
      `INSERT INTO room_ops (room_id, server_seq, op_id, client_id, lamport, op_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateRoomStmt = this.db.prepare(
      `UPDATE rooms
       SET latest_seq = ?, element_count = ?, updated_at = ?
       WHERE room_id = ?`,
    );

    const accepted: CRDTOperation[] = [];
    const ackedOpIds: string[] = [];
    const now = Date.now();
    let seq = meta.latestSeq;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const rawOp of ops) {
        const existing = checkDupStmt.get(roomId, rawOp.opId) as
          | { server_seq: number }
          | undefined;
        if (existing) {
          ackedOpIds.push(rawOp.opId);
          continue;
        }

        seq += 1;
        const stampedOp: CRDTOperation = {
          ...rawOp,
          roomId,
          serverSeq: seq,
        };

        insertOpStmt.run(
          roomId,
          seq,
          stampedOp.opId,
          stampedOp.clientId,
          stampedOp.lamport,
          JSON.stringify(stampedOp),
          now,
        );

        accepted.push(stampedOp);
        ackedOpIds.push(stampedOp.opId);
      }

      updateRoomStmt.run(seq, visibleElementCount, now, roomId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      accepted,
      ackedOpIds,
      latestSeq: seq,
    };
  }

  /**
   * Compacts full CRDT state into `room_snapshots` and trims old WAL rows prior to sliding window.
   */
  public saveSnapshot(
    roomId: string,
    snapshotSeq: number,
    snapshot: CRDTSnapshot,
    visibleElementCount: number,
    retainOpsCount: number,
  ): { savedAt: number; compactedSeq: number } {
    this.ensureRoom(roomId);
    const savedAt = Date.now();
    const pruneBeforeSeq = Math.max(0, snapshotSeq - retainOpsCount);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO room_snapshots (room_id, snapshot_seq, lamport, state_json, saved_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(room_id) DO UPDATE SET
             snapshot_seq = excluded.snapshot_seq,
             lamport = excluded.lamport,
             state_json = excluded.state_json,
             saved_at = excluded.saved_at`,
        )
        .run(roomId, snapshotSeq, snapshot.lamport, JSON.stringify(snapshot), savedAt);

      if (pruneBeforeSeq > 0) {
        this.db
          .prepare(`DELETE FROM room_ops WHERE room_id = ? AND server_seq <= ?`)
          .run(roomId, pruneBeforeSeq);
      }

      this.db
        .prepare(
          `UPDATE rooms
           SET compacted_seq = MAX(compacted_seq, ?),
               element_count = ?,
               last_snapshot_at = ?,
               updated_at = ?
           WHERE room_id = ?`,
        )
        .run(pruneBeforeSeq, visibleElementCount, savedAt, savedAt, roomId);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      savedAt,
      compactedSeq: pruneBeforeSeq,
    };
  }

  public listRooms(): StoredRoomMeta[] {
    const rows = this.db
      .prepare(
        `SELECT room_id, latest_seq, compacted_seq, element_count, last_snapshot_at, updated_at
         FROM rooms
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all() as Array<{
      room_id: string;
      latest_seq: number;
      compacted_seq: number;
      element_count: number;
      last_snapshot_at: number | null;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      roomId: row.room_id,
      latestSeq: Number(row.latest_seq),
      compactedSeq: Number(row.compacted_seq),
      elementCount: Number(row.element_count),
      lastSnapshotAt: row.last_snapshot_at !== null ? Number(row.last_snapshot_at) : null,
      updatedAt: Number(row.updated_at),
    }));
  }

  public countStoredOps(roomId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM room_ops WHERE room_id = ?`)
      .get(roomId) as { cnt: number };
    return Number(row.cnt);
  }

  public close(): void {
    this.db.close();
  }
}
