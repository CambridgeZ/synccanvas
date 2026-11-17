import type { CRDTOperation } from '@whiteboard/shared';

export class OfflineOutbox {
  private readonly outboxKey: string;
  private readonly seqKey: string;
  private queue: Map<string, CRDTOperation> = new Map();
  private lastServerSeq = 0;

  constructor(roomId: string, clientId: string) {
    this.outboxKey = `wb_outbox_v1_${roomId}_${clientId}`;
    this.seqKey = `wb_seq_v1_${roomId}_${clientId}`;
    this.hydrateFromSession();
  }

  public get size(): number {
    return this.queue.size;
  }

  public get lastKnownServerSeq(): number {
    return this.lastServerSeq;
  }

  public updateServerSeq(seq: number): void {
    if (seq > this.lastServerSeq) {
      this.lastServerSeq = seq;
      try {
        sessionStorage.setItem(this.seqKey, String(seq));
      } catch {
        // ignore storage quota errors
      }
    }
  }

  public enqueue(ops: ReadonlyArray<CRDTOperation>): void {
    if (ops.length === 0) return;
    for (const op of ops) {
      this.queue.set(op.opId, op);
    }
    this.persistToSession();
  }

  public acknowledge(ackedIds: ReadonlyArray<string>): void {
    if (ackedIds.length === 0) return;
    let changed = false;
    for (const id of ackedIds) {
      if (this.queue.delete(id)) {
        changed = true;
      }
    }
    if (changed) {
      this.persistToSession();
    }
  }

  public getAll(): CRDTOperation[] {
    return [...this.queue.values()];
  }

  private hydrateFromSession(): void {
    try {
      const rawOps = sessionStorage.getItem(this.outboxKey);
      if (rawOps) {
        const parsed = JSON.parse(rawOps) as CRDTOperation[];
        if (Array.isArray(parsed)) {
          for (const op of parsed) {
            if (op?.opId) this.queue.set(op.opId, op);
          }
        }
      }
      const rawSeq = sessionStorage.getItem(this.seqKey);
      if (rawSeq) {
        const num = Number(rawSeq);
        if (Number.isFinite(num) && num > 0) {
          this.lastServerSeq = num;
        }
      }
    } catch {
      // ignore corrupted session entries
    }
  }

  private persistToSession(): void {
    try {
      sessionStorage.setItem(this.outboxKey, JSON.stringify([...this.queue.values()]));
    } catch {
      // ignore storage quota errors
    }
  }
}
