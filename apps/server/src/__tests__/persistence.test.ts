import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CRDTDocument } from '@whiteboard/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomManager } from '../rooms/roomManager';
import { SqliteWhiteboardStore } from '../storage/sqliteStore';

const tempFiles: string[] = [];

function makeTempDbPath(): string {
  const file = path.join(
    os.tmpdir(),
    `wb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  tempFiles.push(file);
  return file;
}

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${f}${suffix}`);
      } catch {
        // ignore
      }
    }
  }
});

describe('SQLite WAL Snapshot Compaction & Server Restart Recovery', () => {
  it('auto-compacts snapshots at threshold, retains tail ops, and restores exact state after server restart', () => {
    const dbPath = makeTempDbPath();
    const store1 = new SqliteWhiteboardStore(dbPath);
    const manager1 = new RoomManager(store1, {
      snapshotOpThreshold: 50,
      snapshotIntervalMs: 60_000,
      compactionRetainOps: 30,
    });

    const clientA = new CRDTDocument('demo-room', 'client-A');
    const opsBatch = [];

    // 1. Create 10 shapes + 55 property updates (65 total ops -> crosses threshold 50!)
    for (let i = 0; i < 10; i += 1) {
      opsBatch.push(
        clientA.createElement(
          'rect',
          { left: i * 25, top: i * 15, fill: '#3b82f6' },
          `rect-${i}`,
        ),
      );
    }
    for (let step = 0; step < 55; step += 1) {
      const op = clientA.updateElementProps(`rect-${step % 10}`, {
        left: 200 + step,
        fill: step % 2 === 0 ? '#10b981' : '#ef4444',
      });
      if (op) opsBatch.push(op);
    }

    // Submit in chunks so threshold triggers snapshot compaction mid-stream + leaves uncompacted tail ops
    const firstChunk = opsBatch.slice(0, 52);
    const tailChunk = opsBatch.slice(52);

    const res1 = manager1.submitOperations('demo-room', firstChunk);
    expect(res1.snapshotSaved).not.toBeNull();
    expect(res1.snapshotSaved!.snapshotSeq).toBe(52);

    const res2 = manager1.submitOperations('demo-room', tailChunk);
    expect(res2.serverSeq).toBe(65);

    // Verify sliding window log compaction pruned early WAL entries (52 - 30 = 22 pruned -> 43 left)
    expect(store1.countStoredOps('demo-room')).toBe(65 - 22);

    const expectedSnapshot = clientA.getVisibleElements();

    // Close store1 WITHOUT flushing dirty tailChunk — simulating abrupt process crash!
    store1.close();

    // Cold-boot store2 & manager2 from disk (`snapshot@52` + `tailOps 53..65`)
    const store2 = new SqliteWhiteboardStore(dbPath);
    const manager2 = new RoomManager(store2, {
      snapshotOpThreshold: 50,
      snapshotIntervalMs: 60_000,
      compactionRetainOps: 30,
    });

    const joinRes = manager2.handleJoinAndSync('sock-new', {
      roomId: 'demo-room',
      user: { clientId: 'viewer-1', name: 'Viewer', color: '#8b5cf6' },
      activeTool: 'select',
      lastKnownServerSeq: 0,
      pendingOps: [],
    });

    expect(joinRes.syncState.mode).toBe('snapshot');
    expect(joinRes.syncState.serverSeq).toBe(65);

    const hydratedClient = CRDTDocument.fromSnapshot(joinRes.syncState.snapshot!, 'viewer-1');
    expect(hydratedClient.getVisibleElements()).toEqual(expectedSnapshot);

    // Also verify offline reconnection merge + deduplication idempotency
    const offlineClient = CRDTDocument.fromSnapshot(joinRes.syncState.snapshot!, 'offline-user');
    const offlineMoveOp = offlineClient.updateElementProps('rect-0', { top: 999 })!;

    const reconnect1 = manager2.handleJoinAndSync('sock-offline-1', {
      roomId: 'demo-room',
      user: { clientId: 'offline-user', name: 'OfflineUser', color: '#f59e0b' },
      activeTool: 'select',
      lastKnownServerSeq: 60,
      pendingOps: [offlineMoveOp],
    });

    expect(reconnect1.acceptedOfflineOps).toHaveLength(1);
    expect(reconnect1.syncState.ackedOpIds).toContain(offlineMoveOp.opId);
    expect(reconnect1.syncState.mode).toBe('delta');

    // Re-submitting exact same pendingOps on flaky retry must NOT duplicate serverSeq!
    const reconnectRetry = manager2.handleJoinAndSync('sock-offline-2', {
      roomId: 'demo-room',
      user: { clientId: 'offline-user', name: 'OfflineUser', color: '#f59e0b' },
      activeTool: 'select',
      lastKnownServerSeq: 60,
      pendingOps: [offlineMoveOp],
    });
    expect(reconnectRetry.acceptedOfflineOps).toHaveLength(0);
    expect(reconnectRetry.syncState.ackedOpIds).toContain(offlineMoveOp.opId);
    expect(reconnectRetry.syncState.serverSeq).toBe(reconnect1.syncState.serverSeq);

    manager2.dispose();
    store2.close();
  });
});
