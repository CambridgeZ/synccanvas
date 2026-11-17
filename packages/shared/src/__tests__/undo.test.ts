import { describe, expect, it } from 'vitest';
import { CRDTDocument, UndoManager } from '../index';

describe('Collaborative Per-User UndoManager', () => {
  it('undoes and redoes only local user actions while preserving collaborator edits', () => {
    const docA = new CRDTDocument('room-undo', 'user-A');
    const docB = new CRDTDocument('room-undo', 'user-B');
    const undoA = new UndoManager();

    // 1. User A creates Rect-1 at (100, 100) with red fill
    const opCreateRect = docA.createElement(
      'rect',
      { left: 100, top: 100, fill: '#ef4444' },
      'rect-1',
    );
    undoA.recordCreate('rect-1', opCreateRect.props!);
    docB.applyOp(opCreateRect);

    // 2. User A moves Rect-1 from (100, 100) -> (300, 250)
    const beforeMove = { left: 100, top: 100 };
    const afterMove = { left: 300, top: 250 };
    const opMoveA = docA.updateElementProps('rect-1', afterMove)!;
    undoA.recordUpdate([
      { elementId: 'rect-1', beforeProps: beforeMove, afterProps: afterMove },
    ]);
    docB.applyOp(opMoveA);

    // 3. Meanwhile User B creates Ellipse-B AND changes Rect-1's fill to emerald '#10b981'
    const opCreateEllipseB = docB.createElement(
      'ellipse',
      { left: 500, top: 200, fill: '#3b82f6' },
      'ellipse-b',
    );
    const opColorB = docB.updateElementProps('rect-1', { fill: '#10b981' })!;
    docA.applyOp(opCreateEllipseB);
    docA.applyOp(opColorB);

    // 4. User A presses Cmd+Z to undo their move of Rect-1
    const undoOps1 = undoA.undo(docA);
    docB.applyOps(undoOps1);

    // Rect-1 returns to (100, 100), STILL keeps User B's green fill '#10b981', and Ellipse-B is untouched!
    expect(docA.getMaterializedElement('rect-1')!.left).toBe(100);
    expect(docA.getMaterializedElement('rect-1')!.top).toBe(100);
    expect(docA.getMaterializedElement('rect-1')!.fill).toBe('#10b981');
    expect(docB.getMaterializedElement('rect-1')).toEqual(docA.getMaterializedElement('rect-1'));
    expect(docA.getVisibleElements().map((e) => e.id)).toContain('ellipse-b');

    // 5. User A presses Cmd+Shift+Z to redo their move
    const redoOps = undoA.redo(docA);
    docB.applyOps(redoOps);
    expect(docB.getMaterializedElement('rect-1')!.left).toBe(300);
    expect(docB.getMaterializedElement('rect-1')!.fill).toBe('#10b981');
  });
});
