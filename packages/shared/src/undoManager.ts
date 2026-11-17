import type { CRDTDocument } from './crdtDocument';
import type { CRDTOperation, ElementProps } from './types';

export interface ElementMutationEntry {
  elementId: string;
  beforeProps?: Partial<ElementProps>;
  afterProps?: Partial<ElementProps>;
  beforeDeleted?: boolean;
  afterDeleted?: boolean;
}

export interface UndoTransaction {
  label: string;
  timestamp: number;
  entries: ElementMutationEntry[];
}

/**
 * Per-User Collaborative Undo / Redo Manager
 *
 * Instead of rolling back the global document snapshot (which would destroy teammates' work),
 * each local user action records a transaction of affected properties (`before` -> `after`).
 * Undoing generates brand-new forward CRDTOperations with incremented Lamport timestamps,
 * reverting ONLY the local user's targeted property/tombstone changes while preserving
 * orthogonal edits made concurrently by other collaborators.
 */
export class UndoManager {
  private undoStack: UndoTransaction[] = [];
  private redoStack: UndoTransaction[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth = 100) {
    this.maxDepth = maxDepth;
  }

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public get undoDepth(): number {
    return this.undoStack.length;
  }

  public get redoDepth(): number {
    return this.redoStack.length;
  }

  public record(tx: UndoTransaction): void {
    if (tx.entries.length === 0) return;
    this.undoStack.push(tx);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public recordCreate(elementId: string, createdProps: Partial<ElementProps>): void {
    this.record({
      label: 'create',
      timestamp: Date.now(),
      entries: [
        {
          elementId,
          beforeDeleted: true,
          afterDeleted: false,
          afterProps: { ...createdProps },
        },
      ],
    });
  }

  public recordDelete(elementIds: ReadonlyArray<string>): void {
    if (elementIds.length === 0) return;
    this.record({
      label: 'delete',
      timestamp: Date.now(),
      entries: elementIds.map((elementId) => ({
        elementId,
        beforeDeleted: false,
        afterDeleted: true,
      })),
    });
  }

  public recordUpdate(
    mutations: ReadonlyArray<{
      elementId: string;
      beforeProps: Partial<ElementProps>;
      afterProps: Partial<ElementProps>;
    }>,
    label = 'modify',
  ): void {
    const valid = mutations.filter((m) => Object.keys(m.afterProps).length > 0);
    if (valid.length === 0) return;
    this.record({
      label,
      timestamp: Date.now(),
      entries: valid.map((m) => ({
        elementId: m.elementId,
        beforeProps: { ...m.beforeProps },
        afterProps: { ...m.afterProps },
      })),
    });
  }

  /** Execute undo against `doc` and return forward CRDT operations to broadcast */
  public undo(doc: CRDTDocument): CRDTOperation[] {
    const tx = this.undoStack.pop();
    if (!tx) return [];

    const ops: CRDTOperation[] = [];
    // Apply entries in reverse order
    for (let i = tx.entries.length - 1; i >= 0; i -= 1) {
      const entry = tx.entries[i];
      if (entry.beforeDeleted !== undefined) {
        const delOp = doc.setElementDeleted(entry.elementId, entry.beforeDeleted);
        if (delOp) ops.push(delOp);
      }
      if (entry.beforeProps && Object.keys(entry.beforeProps).length > 0) {
        const propOp = doc.updateElementProps(entry.elementId, entry.beforeProps);
        if (propOp) ops.push(propOp);
      }
    }

    this.redoStack.push(tx);
    return ops;
  }

  /** Execute redo against `doc` and return forward CRDT operations to broadcast */
  public redo(doc: CRDTDocument): CRDTOperation[] {
    const tx = this.redoStack.pop();
    if (!tx) return [];

    const ops: CRDTOperation[] = [];
    for (const entry of tx.entries) {
      if (entry.afterDeleted !== undefined) {
        const delOp = doc.setElementDeleted(entry.elementId, entry.afterDeleted);
        if (delOp) ops.push(delOp);
      }
      if (entry.afterProps && Object.keys(entry.afterProps).length > 0) {
        const propOp = doc.updateElementProps(entry.elementId, entry.afterProps);
        if (propOp) ops.push(propOp);
      }
    }

    this.undoStack.push(tx);
    return ops;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
