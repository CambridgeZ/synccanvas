import {
  CRDTDocument,
  UndoManager,
  type CRDTOperation,
  type CRDTSnapshot,
  type ElementPropKey,
  type ElementProps,
  type EphemeralTransformPayload,
  type LayerOrderAction,
  type MaterializedElement,
} from '@whiteboard/shared';
import { ActiveSelection, type Canvas, type FabricObject, IText } from 'fabric';
import {
  applyElementPropsToFabricObject,
  type CollabFabricObject,
  createFabricObjectFromElement,
  extractWorldElementProps,
} from './shapeFactories';

export interface BridgeCallbacks {
  onLocalDurableOps: (ops: CRDTOperation[], label: string) => void;
  onLocalEphemeralTransform: (
    transforms: Array<{ elementId: string; props: Partial<ElementProps> }>,
    phase: 'active' | 'end',
  ) => void;
  onSelectionChanged: (selectedElements: MaterializedElement[]) => void;
  onElementsChanged: (visibleElements: MaterializedElement[]) => void;
}

const GEOMETRY_LOCK_KEYS: ElementPropKey[] = ['left', 'top', 'scaleX', 'scaleY', 'angle'];
const TEXT_LOCK_KEYS: ElementPropKey[] = ['text', 'width', 'height'];

/**
 * Bidirectional Imperative Bridge between Fabric.js v6 and CRDTDocument
 *
 * Defenses:
 * 1. `isApplyingRemote` re-entrancy guard eliminates echo broadcast loops.
 * 2. `activeGestureLocks` allows orthogonal remote property updates (e.g. fill color)
 *    to hot-apply mid-drag without snapping the object away from the user's cursor.
 * 3. Deterministic `(zIndex, id)` render-stack ordering via `canvas.moveObjectTo`.
 */
export class FabricCRDTBridge {
  public readonly canvas: Canvas;
  public readonly doc: CRDTDocument;
  public readonly undoManager: UndoManager;
  private readonly callbacks: BridgeCallbacks;

  private readonly objectMap: Map<string, CollabFabricObject> = new Map();
  private readonly activeGestureLocks: Map<string, Set<ElementPropKey>> = new Map();
  private readonly gestureStartSnapshots: Map<string, Partial<ElementProps>> = new Map();

  private isApplyingRemote = false;
  private lastTransformEmitAt = 0;

  constructor(
    canvas: Canvas,
    doc: CRDTDocument,
    undoManager: UndoManager,
    callbacks: BridgeCallbacks,
  ) {
    this.canvas = canvas;
    this.doc = doc;
    this.undoManager = undoManager;
    this.callbacks = callbacks;
    this.bindFabricListeners();
  }

  public getFabricObject(elementId: string): CollabFabricObject | undefined {
    return this.objectMap.get(elementId);
  }

  public registerCreatedObject(obj: CollabFabricObject): void {
    this.objectMap.set(obj.elementId, obj);
    this.syncLayerStackOrder();
    this.notifyElementsChanged();
  }

  public mountLocalElement(elementId: string): void {
    this.isApplyingRemote = true;
    try {
      this.reconcileSingleElement(elementId);
      this.syncLayerStackOrder();
      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }
    this.notifyElementsChanged();
  }

  /** Apply remote CRDT operations onto CRDTDocument and patch Fabric objects */
  public applyRemoteOps(ops: ReadonlyArray<CRDTOperation>): void {
    if (ops.length === 0) return;

    this.isApplyingRemote = true;
    try {
      let zIndexTouched = false;
      const touchedIds = new Set<string>();

      for (const op of ops) {
        const res = this.doc.applyOp(op);
        if (res.changed) {
          touchedIds.add(res.elementId);
          if (res.changedProps.includes('zIndex') || res.created || res.deletedChanged) {
            zIndexTouched = true;
          }
        }
      }

      for (const id of touchedIds) {
        this.reconcileSingleElement(id);
      }

      if (zIndexTouched) {
        this.syncLayerStackOrder();
      }

      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }

    this.notifyElementsChanged();
    this.notifySelectionChanged();
  }

  /** Merge authoritative snapshot (initial join or reconnect) and reconcile Fabric scene */
  public applyRemoteSnapshot(snapshot: CRDTSnapshot): void {
    this.isApplyingRemote = true;
    try {
      const affectedIds = this.doc.mergeSnapshot(snapshot);
      // Reconcile all affected elements + ensure any missing visible elements are mounted
      const allIds = new Set<string>([
        ...affectedIds,
        ...this.doc.getVisibleElements().map((e) => e.id),
      ]);
      for (const id of allIds) {
        this.reconcileSingleElement(id);
      }
      this.syncLayerStackOrder();
      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }

    this.notifyElementsChanged();
    this.notifySelectionChanged();
  }

  /** Apply smooth ~30fps live drag/resize preview from a collaborator */
  public applyRemoteEphemeralTransform(payload: EphemeralTransformPayload): void {
    this.isApplyingRemote = true;
    try {
      for (const item of payload.transforms) {
        if (this.activeGestureLocks.has(item.elementId)) continue;

        if (payload.phase === 'end') {
          this.reconcileSingleElement(item.elementId);
          continue;
        }

        const obj = this.objectMap.get(item.elementId);
        if (!obj) continue;
        const p = item.props;
        if (p.left !== undefined) obj.set('left', p.left);
        if (p.top !== undefined) obj.set('top', p.top);
        if (p.scaleX !== undefined) obj.set('scaleX', p.scaleX);
        if (p.scaleY !== undefined) obj.set('scaleY', p.scaleY);
        if (p.angle !== undefined) obj.set('angle', p.angle);
        obj.setCoords();
      }
      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }
  }

  /** Update style properties on currently selected elements (or a specific list of IDs) */
  public updateElementsStyle(
    elementIds: ReadonlyArray<string>,
    stylePatch: Partial<ElementProps>,
    label = 'style',
  ): void {
    if (elementIds.length === 0) return;

    const ops: CRDTOperation[] = [];
    const undoMutations: Array<{
      elementId: string;
      beforeProps: Partial<ElementProps>;
      afterProps: Partial<ElementProps>;
    }> = [];

    this.isApplyingRemote = true;
    try {
      for (const id of elementIds) {
        const beforeEl = this.doc.getMaterializedElement(id);
        if (!beforeEl || beforeEl.deleted) continue;

        const beforeProps: Partial<ElementProps> = {};
        for (const k of Object.keys(stylePatch) as ElementPropKey[]) {
          (beforeProps as Record<string, unknown>)[k] = beforeEl[k];
        }

        const op = this.doc.updateElementProps(id, stylePatch);
        if (op && op.props) {
          ops.push(op);
          undoMutations.push({
            elementId: id,
            beforeProps,
            afterProps: op.props,
          });
          this.reconcileSingleElement(id);
        }
      }
      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }

    if (ops.length > 0) {
      this.undoManager.recordUpdate(undoMutations, label);
      this.callbacks.onLocalDurableOps(ops, label);
      this.notifyElementsChanged();
      this.notifySelectionChanged();
    }
  }

  /** Delete specified elements (or currently selected elements) via CRDT tombstones */
  public deleteElements(elementIds: ReadonlyArray<string>, recordUndo = true): CRDTOperation[] {
    if (elementIds.length === 0) return [];
    const ops: CRDTOperation[] = [];
    const deletedIds: string[] = [];

    this.isApplyingRemote = true;
    try {
      for (const id of elementIds) {
        const op = this.doc.setElementDeleted(id, true);
        if (op) {
          ops.push(op);
          deletedIds.push(id);
          this.reconcileSingleElement(id);
        }
      }
      this.canvas.discardActiveObject();
      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }

    if (ops.length > 0) {
      if (recordUndo) {
        this.undoManager.recordDelete(deletedIds);
      }
      this.callbacks.onLocalDurableOps(ops, 'delete');
      this.notifyElementsChanged();
      this.notifySelectionChanged();
    }

    return ops;
  }

  /** Reorder layer zIndex ('front' | 'back' | 'forward' | 'backward') */
  public reorderElementLayer(elementId: string, action: LayerOrderAction): void {
    const before = this.doc.getMaterializedElement(elementId);
    if (!before || before.deleted) return;

    const op = this.doc.reorderElementLayer(elementId, action);
    if (!op || !op.props) return;

    this.isApplyingRemote = true;
    try {
      this.syncLayerStackOrder();
      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }

    this.undoManager.recordUpdate(
      [
        {
          elementId,
          beforeProps: { zIndex: before.zIndex },
          afterProps: { zIndex: op.props.zIndex },
        },
      ],
      `layer:${action}`,
    );
    this.callbacks.onLocalDurableOps([op], `layer:${action}`);
    this.notifyElementsChanged();
  }

  /** Clear all visible shapes on the canvas (with 1-step Undo support!) */
  public clearAllVisible(): void {
    const visibleIds = this.doc.getVisibleElements().map((e) => e.id);
    if (visibleIds.length === 0) return;
    this.deleteElements(visibleIds, true);
  }

  public performUndo(): void {
    const ops = this.undoManager.undo(this.doc);
    if (ops.length === 0) return;
    this.reconcileEditedOpsLocally(ops);
    this.callbacks.onLocalDurableOps(ops, 'undo');
  }

  public performRedo(): void {
    const ops = this.undoManager.redo(this.doc);
    if (ops.length === 0) return;
    this.reconcileEditedOpsLocally(ops);
    this.callbacks.onLocalDurableOps(ops, 'redo');
  }

  public selectElementById(elementId: string): void {
    const obj = this.objectMap.get(elementId);
    if (!obj) return;
    this.canvas.setActiveObject(obj);
    this.canvas.requestRenderAll();
    this.notifySelectionChanged();
  }

  public getSelectedElementIds(): string[] {
    return this.extractTargetCollabObjects(this.canvas.getActiveObject()).map(
      (o) => o.elementId,
    );
  }

  private reconcileEditedOpsLocally(ops: ReadonlyArray<CRDTOperation>): void {
    this.isApplyingRemote = true;
    try {
      for (const op of ops) {
        this.reconcileSingleElement(op.elementId);
      }
      this.syncLayerStackOrder();
      this.canvas.requestRenderAll();
    } finally {
      this.isApplyingRemote = false;
    }
    this.notifyElementsChanged();
    this.notifySelectionChanged();
  }

  private reconcileSingleElement(elementId: string): void {
    const el = this.doc.getMaterializedElement(elementId);
    const existingObj = this.objectMap.get(elementId);

    if (!el || el.deleted) {
      if (existingObj) {
        this.safelyDetachFromSelection(existingObj);
        this.canvas.remove(existingObj);
        this.objectMap.delete(elementId);
        this.activeGestureLocks.delete(elementId);
        this.gestureStartSnapshots.delete(elementId);
      }
      return;
    }

    if (!existingObj) {
      const createdObj = createFabricObjectFromElement(el);
      const isSelectMode = Boolean(this.canvas.selection);
      createdObj.selectable = isSelectMode;
      createdObj.evented = isSelectMode || !this.canvas.skipTargetFind;
      this.objectMap.set(elementId, createdObj);
      this.canvas.add(createdObj);
      return;
    }

    const lockedProps = this.activeGestureLocks.get(elementId);

    // Guard against setting world (left, top) onto an object currently nested inside an ActiveSelection
    // where Fabric interprets (left, top) relative to the group's center!
    if (existingObj.group instanceof ActiveSelection) {
      const currentWorld = extractWorldElementProps(existingObj);
      const geomDiffer =
        Math.abs((currentWorld.left ?? 0) - el.left) > 0.5 ||
        Math.abs((currentWorld.top ?? 0) - el.top) > 0.5 ||
        Math.abs((currentWorld.scaleX ?? 1) - el.scaleX) > 0.005 ||
        Math.abs((currentWorld.scaleY ?? 1) - el.scaleY) > 0.005 ||
        Math.abs((currentWorld.angle ?? 0) - el.angle) > 0.5;

      if (!geomDiffer) {
        // Geometry already matches world state; only apply non-geometric style props in-place
        const groupLocks = new Set<ElementPropKey>([
          ...(lockedProps ?? []),
          ...GEOMETRY_LOCK_KEYS,
        ]);
        applyElementPropsToFabricObject(existingObj, el, groupLocks);
        return;
      }

      // Remote peer moved an item inside our multi-selection: cleanly ungroup, apply world coords, re-select
      const groupMembers = existingObj.group
        .getObjects()
        .filter((o): o is CollabFabricObject => Boolean((o as CollabFabricObject).elementId));
      this.canvas.discardActiveObject();
      applyElementPropsToFabricObject(existingObj, el, lockedProps);
      if (groupMembers.length > 1 && this.canvas.selection) {
        const rebuilt = new ActiveSelection(groupMembers, { canvas: this.canvas });
        this.canvas.setActiveObject(rebuilt);
      }
      return;
    }

    applyElementPropsToFabricObject(existingObj, el, lockedProps);
  }

  private safelyDetachFromSelection(target: CollabFabricObject): void {
    const active = this.canvas.getActiveObject();
    if (!active) return;
    if (active === target) {
      if (target instanceof IText && target.isEditing) {
        target.exitEditing();
      }
      this.canvas.discardActiveObject();
    } else if (active instanceof ActiveSelection) {
      if (active.getObjects().includes(target)) {
        active.remove(target);
        if (active.size() === 0) {
          this.canvas.discardActiveObject();
        }
      }
    }
  }

  private syncLayerStackOrder(): void {
    const sortedVisible = this.doc.getVisibleElements();
    sortedVisible.forEach((el, targetIndex) => {
      const obj = this.objectMap.get(el.id);
      if (obj) {
        this.canvas.moveObjectTo(obj, targetIndex);
      }
    });
  }

  private extractTargetCollabObjects(target?: FabricObject | null): CollabFabricObject[] {
    if (!target) return [];
    if (target instanceof ActiveSelection) {
      return target
        .getObjects()
        .filter((o): o is CollabFabricObject => Boolean((o as CollabFabricObject).elementId));
    }
    if ((target as CollabFabricObject).elementId) {
      return [target as CollabFabricObject];
    }
    return [];
  }

  private captureGestureStartIfNeeded(targets: CollabFabricObject[]): void {
    for (const obj of targets) {
      if (!this.activeGestureLocks.has(obj.elementId)) {
        this.activeGestureLocks.set(obj.elementId, new Set(GEOMETRY_LOCK_KEYS));
        const mat = this.doc.getMaterializedElement(obj.elementId);
        if (mat) {
          this.gestureStartSnapshots.set(obj.elementId, {
            left: mat.left,
            top: mat.top,
            scaleX: mat.scaleX,
            scaleY: mat.scaleY,
            angle: mat.angle,
          });
        }
      }
    }
  }

  private bindFabricListeners(): void {
    const handleLiveGesture = (target?: FabricObject) => {
      if (this.isApplyingRemote || !target) return;
      const objs = this.extractTargetCollabObjects(target);
      if (objs.length === 0) return;

      this.captureGestureStartIfNeeded(objs);

      const now = performance.now();
      if (now - this.lastTransformEmitAt < 32) return; // ~30fps throttle
      this.lastTransformEmitAt = now;

      const transforms = objs.map((obj) => ({
        elementId: obj.elementId,
        props: extractWorldElementProps(obj),
      }));
      this.callbacks.onLocalEphemeralTransform(transforms, 'active');
    };

    this.canvas.on('object:moving', (e) => handleLiveGesture(e.target));
    this.canvas.on('object:scaling', (e) => handleLiveGesture(e.target));
    this.canvas.on('object:rotating', (e) => handleLiveGesture(e.target));

    this.canvas.on('object:modified', (e) => {
      if (this.isApplyingRemote || !e.target) return;
      const objs = this.extractTargetCollabObjects(e.target);
      if (objs.length === 0) return;

      const ops: CRDTOperation[] = [];
      const undoEntries: Array<{
        elementId: string;
        beforeProps: Partial<ElementProps>;
        afterProps: Partial<ElementProps>;
      }> = [];
      const endTransforms: Array<{ elementId: string; props: Partial<ElementProps> }> = [];

      for (const obj of objs) {
        const nextProps = extractWorldElementProps(obj);
        const startSnap = this.gestureStartSnapshots.get(obj.elementId) ?? {};
        this.activeGestureLocks.delete(obj.elementId);
        this.gestureStartSnapshots.delete(obj.elementId);

        const op = this.doc.updateElementProps(obj.elementId, nextProps);
        if (op && op.props) {
          ops.push(op);
          const beforeDiff: Partial<ElementProps> = {};
          for (const key of Object.keys(op.props) as ElementPropKey[]) {
            if (startSnap[key] !== undefined) {
              (beforeDiff as Record<string, unknown>)[key] = startSnap[key];
            }
          }
          undoEntries.push({
            elementId: obj.elementId,
            beforeProps: beforeDiff,
            afterProps: op.props,
          });
          endTransforms.push({ elementId: obj.elementId, props: op.props });
        }

        // Reconcile against authoritative CRDT state in case remote changes arrived mid-gesture
        this.isApplyingRemote = true;
        try {
          this.reconcileSingleElement(obj.elementId);
        } finally {
          this.isApplyingRemote = false;
        }
      }

      if (endTransforms.length > 0) {
        this.callbacks.onLocalEphemeralTransform(endTransforms, 'end');
      }

      if (ops.length > 0) {
        this.undoManager.recordUpdate(undoEntries, 'transform');
        this.callbacks.onLocalDurableOps(ops, 'transform');
        this.notifyElementsChanged();
        this.notifySelectionChanged();
      }
    });

    // Inline IText editing lifecycle
    this.canvas.on('text:editing:entered', (e) => {
      const obj = e.target as unknown as CollabFabricObject | undefined;
      if (!obj?.elementId) return;
      this.activeGestureLocks.set(obj.elementId, new Set(TEXT_LOCK_KEYS));
      const mat = this.doc.getMaterializedElement(obj.elementId);
      if (mat) {
        this.gestureStartSnapshots.set(obj.elementId, {
          text: mat.text ?? '',
          width: mat.width,
          height: mat.height,
        });
      }
    });

    this.canvas.on('text:editing:exited', (e) => {
      if (this.isApplyingRemote) return;
      const obj = e.target as unknown as (CollabFabricObject & IText) | undefined;
      if (!obj?.elementId) return;

      const startSnap = this.gestureStartSnapshots.get(obj.elementId);
      this.activeGestureLocks.delete(obj.elementId);
      this.gestureStartSnapshots.delete(obj.elementId);

      const cleanText = (obj.text ?? '').trim();
      if (cleanText.length === 0) {
        this.deleteElements([obj.elementId], true);
        return;
      }

      const patch: Partial<ElementProps> = {
        text: obj.text ?? '',
        width: Math.round((obj.width ?? 100) * 100) / 100,
        height: Math.round((obj.height ?? 32) * 100) / 100,
      };
      const op = this.doc.updateElementProps(obj.elementId, patch);
      if (op && op.props) {
        this.undoManager.recordUpdate(
          [
            {
              elementId: obj.elementId,
              beforeProps: {
                text: startSnap?.text ?? '',
                width: startSnap?.width,
                height: startSnap?.height,
              },
              afterProps: op.props,
            },
          ],
          'text',
        );
        this.callbacks.onLocalDurableOps([op], 'text');
        this.notifyElementsChanged();
      }
    });

    const onSelectChange = () => {
      if (this.isApplyingRemote) return;
      this.notifySelectionChanged();
    };
    this.canvas.on('selection:created', onSelectChange);
    this.canvas.on('selection:updated', onSelectChange);
    this.canvas.on('selection:cleared', onSelectChange);
  }

  private notifySelectionChanged(): void {
    const ids = this.getSelectedElementIds();
    const selected: MaterializedElement[] = [];
    for (const id of ids) {
      const mat = this.doc.getMaterializedElement(id);
      if (mat && !mat.deleted) selected.push(mat);
    }
    this.callbacks.onSelectionChanged(selected);
  }

  private notifyElementsChanged(): void {
    this.callbacks.onElementsChanged(this.doc.getVisibleElements());
  }
}
