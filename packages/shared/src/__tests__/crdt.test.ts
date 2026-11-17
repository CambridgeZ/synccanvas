import { describe, expect, it } from 'vitest';
import { CRDTDocument, type CRDTOperation } from '../index';

function seededShuffle<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const arr = [...items];
  let s = seed >>> 0;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

describe('CRDTDocument Strong Eventual Consistency (SEC)', () => {
  it('merges orthogonal property edits on the same shape without overwriting each other', () => {
    const docA = new CRDTDocument('room-1', 'client-A');
    const docB = new CRDTDocument('room-1', 'client-B');

    // Client A creates shared rectangle R1
    const createOp = docA.createElement(
      'rect',
      {
        left: 100,
        top: 100,
        width: 160,
        height: 120,
        fill: '#ef4444',
        stroke: '#1e293b',
      },
      'rect-shared',
    );
    docB.applyOp(createOp);

    // Concurrent offline mutations:
    // Client A drags position (left, top)
    const moveOpA = docA.updateElementProps('rect-shared', {
      left: 420,
      top: 310,
    })!;

    // Client B simultaneously resizes & recolors (scaleX, scaleY, fill)
    const styleScaleOpB = docB.updateElementProps('rect-shared', {
      scaleX: 1.75,
      scaleY: 1.5,
      fill: '#10b981',
    })!;

    // Cross-deliver in opposite orders
    docA.applyOp(styleScaleOpB);
    docB.applyOp(moveOpA);

    const matA = docA.getMaterializedElement('rect-shared')!;
    const matB = docB.getMaterializedElement('rect-shared')!;

    expect(matA).toEqual(matB);
    expect(matA.left).toBe(420);
    expect(matA.top).toBe(310);
    expect(matA.scaleX).toBe(1.75);
    expect(matA.scaleY).toBe(1.5);
    expect(matA.fill).toBe('#10b981');
  });

  it('resolves concurrent same-property conflicts deterministically via (lamport, clientId)', () => {
    const docA = new CRDTDocument('room-1', 'client-A');
    const docB = new CRDTDocument('room-1', 'client-B');

    const createOp = docA.createElement('ellipse', { fill: '#ffffff' }, 'el-1');
    docB.applyOp(createOp);

    // Synchronize clocks so both produce identical Lamport timestamps
    const docC = CRDTDocument.fromSnapshot(docA.toSnapshot(), 'client-C');
    // Both docB and docC witnessed createOp; let's align lamport = 5 on both
    docB.clock.syncFloor(5);
    docC.clock.syncFloor(5);

    const opB = docB.updateElementProps('el-1', { fill: '#3b82f6' })!; // lamport 6, client-B
    const opC = docC.updateElementProps('el-1', { fill: '#f59e0b' })!; // lamport 6, client-C

    expect(opB.lamport).toBe(opC.lamport);

    // Apply in opposite order across docB and docC
    docB.applyOp(opC);
    docC.applyOp(opB);

    // 'client-C' > 'client-B' lexicographically, so '#f59e0b' wins everywhere
    expect(docB.getMaterializedElement('el-1')!.fill).toBe('#f59e0b');
    expect(docC.getMaterializedElement('el-1')!.fill).toBe('#f59e0b');
  });

  it('handles concurrent delete vs property modify with Delete-Wins and lossless Undo resurrection', () => {
    const docA = new CRDTDocument('room-1', 'client-A');
    const docB = new CRDTDocument('room-1', 'client-B');

    const createOp = docA.createElement('rect', { left: 50, top: 60 }, 'el-del');
    docB.applyOp(createOp);

    // User A deletes el-del while User B concurrently moves el-del offline
    const delOpA = docA.setElementDeleted('el-del', true)!;
    const moveOpB = docB.updateElementProps('el-del', { left: 500, top: 600 })!;

    docA.applyOp(moveOpB);
    docB.applyOp(delOpA);

    // Both replicas hide the deleted element (Delete-Wins)
    expect(docA.getVisibleElements()).toHaveLength(0);
    expect(docB.getVisibleElements()).toHaveLength(0);

    // When User A undoes the delete, User B's concurrent coordinate edit is preserved!
    const undeleteOpA = docA.setElementDeleted('el-del', false)!;
    docB.applyOp(undeleteOpA);

    expect(docA.getVisibleElements()).toHaveLength(1);
    expect(docB.getVisibleElements()).toHaveLength(1);
    expect(docA.getMaterializedElement('el-del')!.left).toBe(500);
    expect(docB.getMaterializedElement('el-del')!.top).toBe(600);
  });

  it('converges identically across 5 replicas under arbitrary out-of-order permutations & 25% duplicate delivery', () => {
    const writers = [
      new CRDTDocument('room-fuzz', 'writer-1'),
      new CRDTDocument('room-fuzz', 'writer-2'),
      new CRDTDocument('room-fuzz', 'writer-3'),
    ];

    const allOps: CRDTOperation[] = [];
    const elementIds = ['shape-1', 'shape-2', 'shape-3', 'shape-4', 'shape-5'];

    // Create 5 shapes across writers
    elementIds.forEach((id, idx) => {
      const w = writers[idx % writers.length];
      const op = w.createElement(
        idx % 2 === 0 ? 'rect' : 'arrow',
        { left: idx * 40, top: idx * 30, fill: '#6366f1', zIndex: idx + 1 },
        id,
      );
      allOps.push(op);
      writers.forEach((peer) => peer.applyOp(op));
    });

    // Generate 55 mixed concurrent mutations (moves, style edits, layer reorders, deletes, restores)
    const colors = ['#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6'];
    for (let step = 0; step < 55; step += 1) {
      const w = writers[step % writers.length];
      const targetId = elementIds[(step * 3) % elementIds.length];

      if (step % 11 === 0) {
        const op = w.setElementDeleted(targetId, true);
        if (op) allOps.push(op);
      } else if (step % 13 === 0) {
        const op = w.setElementDeleted(targetId, false);
        if (op) allOps.push(op);
      } else if (step % 7 === 0) {
        const op = w.reorderElementLayer(targetId, step % 2 === 0 ? 'front' : 'backward');
        if (op) allOps.push(op);
      } else {
        const op = w.updateElementProps(targetId, {
          left: (step * 17) % 800,
          top: (step * 23) % 600,
          fill: colors[step % colors.length],
          scaleX: 1 + (step % 4) * 0.25,
        });
        if (op) allOps.push(op);
      }

      // Periodically gossip among writers
      if (step % 5 === 0) {
        for (const op of allOps.slice(-6)) {
          writers.forEach((peer) => peer.applyOp(op));
        }
      }
    }

    // Feed shuffled + duplicated op streams (even where updates arrive BEFORE creates!) to 5 fresh replicas
    const replicas = [101, 202, 303, 404, 505].map((seed, idx) => {
      const doc = new CRDTDocument('room-fuzz', `replica-${idx}`);
      const shuffled = seededShuffle(allOps, seed);
      const withDuplicates = [...shuffled, ...shuffled.filter((_, i) => i % 4 === 0)];
      doc.applyOps(withDuplicates);
      return doc;
    });

    const referenceElements = replicas[0].toSnapshot().elements;
    const referenceVisible = replicas[0].getVisibleElements();

    for (let i = 1; i < replicas.length; i += 1) {
      expect(replicas[i].toSnapshot().elements).toEqual(referenceElements);
      expect(replicas[i].getVisibleElements()).toEqual(referenceVisible);
    }

    // Also verify state-based mergeSnapshot idempotency & equivalence
    const snapshotReplica = new CRDTDocument('room-fuzz', 'snapshot-replica');
    snapshotReplica.mergeSnapshot(replicas[0].toSnapshot());
    snapshotReplica.mergeSnapshot(replicas[2].toSnapshot());
    expect(snapshotReplica.toSnapshot().elements).toEqual(referenceElements);
  });
});
