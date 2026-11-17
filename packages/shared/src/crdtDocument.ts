import { isIncomingNewer, LamportClock } from './clock';
import { compareElementOrder, computeLayerZIndex, computeNextTopZIndex, type LayerOrderAction } from './fractionalZIndex';
import type {
  ApplyResult,
  CRDTElementRecord,
  CRDTOperation,
  CRDTSnapshot,
  ElementPropKey,
  ElementProps,
  ElementType,
  LWWRegister,
  MaterializedElement,
} from './types';

const DEFAULT_ELEMENT_PROPS: ElementProps = {
  left: 0,
  top: 0,
  width: 100,
  height: 100,
  scaleX: 1,
  scaleY: 1,
  angle: 0,
  stroke: '#1e293b',
  strokeWidth: 3,
  fill: 'transparent',
  opacity: 1,
  zIndex: 1,
};

function makeId(prefix = 'op'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneRegister<T>(reg: LWWRegister<T>): LWWRegister<T> {
  return {
    value: reg.value,
    lamport: reg.lamport,
    clientId: reg.clientId,
  };
}

function cloneRecord(record: CRDTElementRecord): CRDTElementRecord {
  const propsCopy: CRDTElementRecord['props'] = {};
  for (const key of Object.keys(record.props) as ElementPropKey[]) {
    const reg = record.props[key] as LWWRegister<unknown> | undefined;
    if (reg !== undefined) {
      (propsCopy as Record<string, LWWRegister<unknown>>)[key] = cloneRegister(reg);
    }
  }
  return {
    id: record.id,
    type: record.type,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    _deleted: cloneRegister(record._deleted),
    props: propsCopy,
  };
}

function shouldAdoptMetadata(
  current: Pick<CRDTElementRecord, 'createdAt' | 'createdBy' | 'type'>,
  incoming: { type?: ElementType; createdBy?: string; createdAt?: number },
): boolean {
  if (!incoming.type && !incoming.createdBy && incoming.createdAt === undefined) {
    return false;
  }
  // Placeholder stub had createdAt === 0; real creation metadata always wins over stub
  if (current.createdAt === 0 && (incoming.createdAt ?? 0) > 0) {
    return true;
  }
  if (incoming.createdAt !== undefined && incoming.createdAt > 0 && current.createdAt > 0) {
    if (incoming.createdAt !== current.createdAt) {
      return incoming.createdAt < current.createdAt;
    }
    const incBy = incoming.createdBy ?? '';
    return incBy < current.createdBy;
  }
  return false;
}

/**
 * Property-level Hybrid State/Op LWW-CRDT Document
 *
 * Guarantees Strong Eventual Consistency (SEC):
 * - Commutative: applyOp(a); applyOp(b) === applyOp(b); applyOp(a)
 * - Associative: merge(merge(A, B), C) === merge(A, merge(B, C))
 * - Idempotent: applyOp(a); applyOp(a) === applyOp(a)
 */
export class CRDTDocument {
  public readonly roomId: string;
  public readonly clock: LamportClock;
  private elements: Map<string, CRDTElementRecord> = new Map();

  constructor(roomId: string, clientId: string, initialLamport = 0) {
    this.roomId = roomId;
    this.clock = new LamportClock(clientId, initialLamport);
  }

  public get clientId(): string {
    return this.clock.clientId;
  }

  public get lamport(): number {
    return this.clock.value;
  }

  /** Build local operation to create a brand-new whiteboard element and apply immediately */
  public createElement(
    type: ElementType,
    initialProps: Partial<ElementProps>,
    customId?: string,
    createdBy?: string,
  ): CRDTOperation {
    const id = customId ?? makeId('el');
    const lamport = this.clock.tick();
    const visible = this.getVisibleElements();
    const zIndex = initialProps.zIndex ?? computeNextTopZIndex(visible);

    const fullProps: Partial<ElementProps> = {
      ...DEFAULT_ELEMENT_PROPS,
      ...initialProps,
      zIndex,
    };

    const op: CRDTOperation = {
      opId: makeId('op'),
      roomId: this.roomId,
      elementId: id,
      elementType: type,
      createdBy: createdBy ?? this.clientId,
      createdAt: Date.now(),
      clientId: this.clientId,
      lamport,
      props: fullProps,
      deleted: false,
    };

    this.applyOp(op);
    return op;
  }

  /** Build local operation to update a subset of properties on an existing element */
  public updateElementProps(
    elementId: string,
    patch: Partial<ElementProps>,
  ): CRDTOperation | null {
    const keys = Object.keys(patch) as ElementPropKey[];
    if (keys.length === 0) return null;

    const existing = this.getMaterializedElement(elementId);
    const minimalPatch: Partial<ElementProps> = {};
    let hasActualDiff = false;

    for (const key of keys) {
      const nextVal = patch[key];
      if (nextVal === undefined) continue;
      if (!existing || existing[key] !== nextVal) {
        (minimalPatch as Record<string, unknown>)[key] = nextVal;
        hasActualDiff = true;
      }
    }

    if (!hasActualDiff) return null;

    const record = this.elements.get(elementId);
    const lamport = this.clock.tick();
    const op: CRDTOperation = {
      opId: makeId('op'),
      roomId: this.roomId,
      elementId,
      elementType: record?.type,
      clientId: this.clientId,
      lamport,
      props: minimalPatch,
    };

    this.applyOp(op);
    return op;
  }

  /** Build local operation to tombstone-delete or undelete an element */
  public setElementDeleted(elementId: string, deleted = true): CRDTOperation | null {
    const record = this.elements.get(elementId);
    if (!record) return null;
    if (record._deleted.value === deleted) return null;

    const lamport = this.clock.tick();
    const op: CRDTOperation = {
      opId: makeId('op'),
      roomId: this.roomId,
      elementId,
      elementType: record.type,
      clientId: this.clientId,
      lamport,
      deleted,
    };

    this.applyOp(op);
    return op;
  }

  /** Build local operation to reorder an element's layer zIndex */
  public reorderElementLayer(elementId: string, action: LayerOrderAction): CRDTOperation | null {
    const visible = this.getVisibleElements();
    const targetZ = computeLayerZIndex(visible, elementId, action);
    if (targetZ === null) return null;
    return this.updateElementProps(elementId, { zIndex: targetZ });
  }

  /** Build batch of delete operations to clear all currently visible elements */
  public clearAllVisible(): CRDTOperation[] {
    const ops: CRDTOperation[] = [];
    for (const el of this.getVisibleElements()) {
      const op = this.setElementDeleted(el.id, true);
      if (op) ops.push(op);
    }
    return ops;
  }

  /**
   * Apply any local or remote CRDTOperation idempotently & commutatively.
   */
  public applyOp(op: CRDTOperation): ApplyResult {
    if (op.clientId !== this.clientId) {
      this.clock.witness(op.lamport);
    } else {
      this.clock.syncFloor(op.lamport);
    }

    let record = this.elements.get(op.elementId);
    let created = false;
    let changed = false;
    let deletedChanged = false;
    const changedProps: ElementPropKey[] = [];

    if (!record) {
      record = {
        id: op.elementId,
        type: op.elementType ?? 'rect',
        createdBy: op.createdBy ?? op.clientId,
        createdAt: op.createdAt ?? 0,
        // Baseline tombstone at (0, '') so out-of-order ops arriving before create converge cleanly
        _deleted: {
          value: false,
          lamport: 0,
          clientId: '',
        },
        props: {},
      };
      this.elements.set(op.elementId, record);
      created = true;
      changed = true;
    } else if (
      shouldAdoptMetadata(record, {
        type: op.elementType,
        createdBy: op.createdBy,
        createdAt: op.createdAt,
      })
    ) {
      if (op.elementType) record.type = op.elementType;
      if (op.createdBy) record.createdBy = op.createdBy;
      if (op.createdAt !== undefined) record.createdAt = op.createdAt;
      changed = true;
    }

    if (op.deleted !== undefined) {
      const curDel = record._deleted;
      if (isIncomingNewer(op.lamport, op.clientId, curDel.lamport, curDel.clientId)) {
        const prevVal = curDel.value;
        record._deleted = {
          value: op.deleted,
          lamport: op.lamport,
          clientId: op.clientId,
        };
        if (prevVal !== op.deleted || created) {
          deletedChanged = true;
        }
        changed = true;
      }
    }

    if (op.props) {
      for (const key of Object.keys(op.props) as ElementPropKey[]) {
        const incomingVal = op.props[key];
        if (incomingVal === undefined) continue;
        const curReg = record.props[key];
        if (
          !curReg ||
          isIncomingNewer(op.lamport, op.clientId, curReg.lamport, curReg.clientId)
        ) {
          const prevVal = curReg?.value;
          (record.props as Record<string, LWWRegister<unknown>>)[key] = {
            value: incomingVal,
            lamport: op.lamport,
            clientId: op.clientId,
          };
          if (prevVal !== incomingVal) {
            changedProps.push(key);
          }
          changed = true;
        }
      }
    }

    return {
      changed,
      elementId: op.elementId,
      changedProps,
      deletedChanged,
      created,
    };
  }

  public applyOps(ops: ReadonlyArray<CRDTOperation>): ApplyResult[] {
    return ops.map((op) => this.applyOp(op));
  }

  /**
   * State-based CRDT Lattice Join:
   * Merges an entire CRDTSnapshot register-by-register with full commutativity & idempotency.
   * Returns IDs of all elements whose state changed.
   */
  public mergeSnapshot(snapshot: CRDTSnapshot): string[] {
    this.clock.syncFloor(snapshot.lamport);
    const affectedIds: string[] = [];

    for (const [id, remoteRec] of Object.entries(snapshot.elements)) {
      const localRec = this.elements.get(id);
      if (!localRec) {
        this.elements.set(id, cloneRecord(remoteRec));
        affectedIds.push(id);
        continue;
      }

      let recChanged = false;

      if (shouldAdoptMetadata(localRec, remoteRec)) {
        localRec.type = remoteRec.type;
        localRec.createdBy = remoteRec.createdBy;
        localRec.createdAt = remoteRec.createdAt;
        recChanged = true;
      }

      if (
        isIncomingNewer(
          remoteRec._deleted.lamport,
          remoteRec._deleted.clientId,
          localRec._deleted.lamport,
          localRec._deleted.clientId,
        )
      ) {
        localRec._deleted = cloneRegister(remoteRec._deleted);
        recChanged = true;
      }

      for (const key of Object.keys(remoteRec.props) as ElementPropKey[]) {
        const remReg = remoteRec.props[key] as LWWRegister<unknown> | undefined;
        if (!remReg) continue;
        const locReg = localRec.props[key] as LWWRegister<unknown> | undefined;
        if (
          !locReg ||
          isIncomingNewer(remReg.lamport, remReg.clientId, locReg.lamport, locReg.clientId)
        ) {
          (localRec.props as Record<string, LWWRegister<unknown>>)[key] = cloneRegister(remReg);
          recChanged = true;
        }
      }

      if (recChanged) {
        affectedIds.push(id);
      }
    }

    return affectedIds;
  }

  public getRecord(elementId: string): CRDTElementRecord | undefined {
    return this.elements.get(elementId);
  }

  public getMaterializedElement(elementId: string): MaterializedElement | undefined {
    const rec = this.elements.get(elementId);
    if (!rec) return undefined;
    return this.materializeRecord(rec);
  }

  /** Returns all non-deleted elements sorted deterministically by (zIndex, id) */
  public getVisibleElements(): MaterializedElement[] {
    const list: MaterializedElement[] = [];
    for (const rec of this.elements.values()) {
      if (!rec._deleted.value) {
        list.push(this.materializeRecord(rec));
      }
    }
    list.sort(compareElementOrder);
    return list;
  }

  public get totalRecordCount(): number {
    return this.elements.size;
  }

  public get visibleElementCount(): number {
    let count = 0;
    for (const rec of this.elements.values()) {
      if (!rec._deleted.value) count += 1;
    }
    return count;
  }

  public toSnapshot(): CRDTSnapshot {
    const out: Record<string, CRDTElementRecord> = {};
    // Sort keys deterministically for stable JSON snapshots & deep equality assertions
    const sortedIds = [...this.elements.keys()].sort();
    for (const id of sortedIds) {
      const rec = this.elements.get(id)!;
      out[id] = cloneRecord(rec);
    }
    return {
      roomId: this.roomId,
      lamport: this.lamport,
      elements: out,
    };
  }

  public static fromSnapshot(snapshot: CRDTSnapshot, clientId: string): CRDTDocument {
    const doc = new CRDTDocument(snapshot.roomId, clientId, snapshot.lamport);
    doc.mergeSnapshot(snapshot);
    return doc;
  }

  private materializeRecord(rec: CRDTElementRecord): MaterializedElement {
    const flat: MaterializedElement = {
      ...DEFAULT_ELEMENT_PROPS,
      id: rec.id,
      type: rec.type,
      createdBy: rec.createdBy,
      createdAt: rec.createdAt,
      deleted: rec._deleted.value,
    };

    for (const key of Object.keys(rec.props) as ElementPropKey[]) {
      const reg = rec.props[key];
      if (reg !== undefined && reg.value !== undefined) {
        (flat as unknown as Record<string, unknown>)[key] = reg.value;
      }
    }

    return flat;
  }
}
