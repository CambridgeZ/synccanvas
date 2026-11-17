import {
  CRDTDocument,
  UndoManager,
  type CollaboratorPresence,
  type CollaboratorProfile,
  type LayerOrderAction,
  type MaterializedElement,
  type ToolType,
} from '@whiteboard/shared';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type DrawingStyleState, WhiteboardEngine } from '../engine/WhiteboardEngine';
import {
  CollaborationClient,
  type DiagnosticsSnapshot,
} from '../sync/CollaborationClient';
import { LeftToolDock } from './LeftToolDock';
import { RightSidebar } from './RightSidebar';
import { TopHeaderBar } from './TopHeaderBar';
import { ViewportZoomHud } from './ViewportZoomHud';

interface WhiteboardWorkspaceProps {
  roomId: string;
  user: CollaboratorProfile;
  onLeaveRoom: () => void;
}

export const WhiteboardWorkspace: React.FC<WhiteboardWorkspaceProps> = ({
  roomId,
  user,
  onLeaveRoom,
}) => {
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fabricCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ephemeralCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const engineRef = useRef<WhiteboardEngine | null>(null);
  const clientRef = useRef<CollaborationClient | null>(null);

  const [activeTool, setActiveTool] = useState<ToolType>('pencil');
  const [style, setStyle] = useState<DrawingStyleState>({
    stroke: '#1e293b',
    fill: 'transparent',
    strokeWidth: 4,
    opacity: 1,
  });
  const [zoom, setZoom] = useState(1);
  const [elements, setElements] = useState<MaterializedElement[]>([]);
  const [selectedElements, setSelectedElements] = useState<MaterializedElement[]>([]);
  const [members, setMembers] = useState<CollaboratorPresence[]>([]);
  const [lamportClock, setLamportClock] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot>({
    status: 'connecting',
    simulatedOffline: false,
    rttMs: null,
    serverSeq: 0,
    pendingOutboxCount: 0,
    txPerSec: 0,
    rxPerSec: 0,
    lastSnapshotAt: null,
    recentLogs: [],
  });

  const selectedIdSet = useMemo(
    () => new Set(selectedElements.map((el) => el.id)),
    [selectedElements],
  );

  // Initialize Three-Layer Canvas Engine + Socket.io CRDT Collaboration Client
  useEffect(() => {
    const container = stageContainerRef.current;
    const gridEl = gridCanvasRef.current;
    const fabricEl = fabricCanvasRef.current;
    const ephemeralEl = ephemeralCanvasRef.current;
    if (!container || !gridEl || !fabricEl || !ephemeralEl) return;

    const doc = new CRDTDocument(roomId, user.clientId);
    const undoManager = new UndoManager(100);

    const syncHistoryFlags = () => {
      setCanUndo(undoManager.canUndo);
      setCanRedo(undoManager.canRedo);
      setLamportClock(doc.lamport);
    };

    let collabClient: CollaborationClient | null = null;

    const engine = new WhiteboardEngine(
      container,
      gridEl,
      fabricEl,
      ephemeralEl,
      doc,
      undoManager,
      {
        onLocalDurableOps: (ops, label) => {
          syncHistoryFlags();
          collabClient?.sendDurableOps(ops, label);
        },
        onLocalCursorMove: (worldX, worldY, tool) => {
          collabClient?.sendEphemeralCursor(worldX, worldY, tool);
        },
        onLocalStrokeStream: (strokeId, points, strokeColor, strokeWidth, phase) => {
          collabClient?.sendEphemeralStroke(strokeId, points, strokeColor, strokeWidth, phase);
        },
        onLocalEphemeralTransform: (transforms, phase) => {
          collabClient?.sendEphemeralTransform(transforms, phase);
        },
        onZoomChanged: (nextZoom) => {
          setZoom(nextZoom);
        },
        onToolAutoSwitch: (nextTool) => {
          setActiveTool(nextTool);
          collabClient?.sendPresenceUpdate(nextTool);
        },
        onSelectionChanged: (sel) => {
          setSelectedElements(sel);
          collabClient?.sendPresenceUpdate(
            undefined,
            sel.map((s) => s.id),
          );
        },
        onElementsChanged: (visible) => {
          setElements(visible);
          engine.ephemeral.syncElementsSnapshot(visible);
          syncHistoryFlags();
        },
      },
    );

    engine.setDrawingStyle({ strokeWidth: 4 });

    collabClient = new CollaborationClient(roomId, user, {
      onRemoteSnapshot: (snapshot) => {
        engine.bridge.applyRemoteSnapshot(snapshot);
        syncHistoryFlags();
      },
      onRemoteOps: (ops) => {
        engine.bridge.applyRemoteOps(ops);
        for (const op of ops) {
          if (op.elementType === 'path') {
            engine.ephemeral.clearEndedStrokesForClient(op.clientId);
          }
        }
        syncHistoryFlags();
      },
      onRemoteCursor: (payload) => {
        if (payload.clientId === user.clientId) return;
        engine.ephemeral.ingestCursor(payload);
      },
      onRemoteStroke: (payload) => {
        if (payload.clientId === user.clientId) return;
        engine.ephemeral.ingestStroke(payload);
      },
      onRemoteTransform: (payload) => {
        if (payload.clientId === user.clientId) return;
        engine.bridge.applyRemoteEphemeralTransform(payload);
      },
      onPresenceChanged: (nextMembers) => {
        setMembers(nextMembers);
        const remoteOnly = nextMembers.filter((m) => m.clientId !== user.clientId);
        engine.ephemeral.syncRemotePresence(remoteOnly);
      },
      onDiagnosticsChanged: (diag) => {
        setDiagnostics(diag);
      },
    });

    engineRef.current = engine;
    clientRef.current = collabClient;
    collabClient.connect();

    // Expose lightweight debug handle on window for automated E2E inspection
    (window as unknown as Record<string, unknown>).__WB_DEBUG__ = {
      getVisibleElements: () => doc.getVisibleElements(),
      getLamport: () => doc.lamport,
      getRoomId: () => roomId,
      getClientId: () => user.clientId,
    };

    return () => {
      collabClient?.dispose();
      engine.dispose();
      engineRef.current = null;
      clientRef.current = null;
    };
  }, [roomId, user]);

  // Global Studio Keyboard Shortcuts
  useEffect(() => {
    const isTypingInDomInput = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || target.isContentEditable;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      if (isTypingInDomInput(e.target) || engine.isEditingText) return;

      // Space temporary Hand Pan override
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        engine.setSpacePanOverride(true);
        return;
      }

      // Undo / Redo: Cmd/Ctrl + Z, Cmd/Ctrl + Shift + Z, Cmd/Ctrl + Y
      if (e.metaKey || e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            engine.bridge.performRedo();
          } else {
            engine.bridge.performUndo();
          }
          return;
        }
        if (k === 'y') {
          e.preventDefault();
          engine.bridge.performRedo();
          return;
        }
        return;
      }

      // Delete / Backspace -> Delete selected shapes
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selectedIds = engine.bridge.getSelectedElementIds();
        if (selectedIds.length > 0) {
          e.preventDefault();
          engine.bridge.deleteElements(selectedIds, true);
        }
        return;
      }

      const shortcutMap: Record<string, ToolType> = {
        v: 'select',
        h: 'hand',
        p: 'pencil',
        r: 'rect',
        o: 'ellipse',
        l: 'line',
        a: 'arrow',
        t: 'text',
        e: 'eraser',
      };
      const mappedTool = shortcutMap[e.key.toLowerCase()];
      if (mappedTool) {
        e.preventDefault();
        engine.setTool(mappedTool);
        setActiveTool(mappedTool);
        clientRef.current?.sendPresenceUpdate(mappedTool);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        engineRef.current?.setSpacePanOverride(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const handleSelectTool = (tool: ToolType) => {
    setActiveTool(tool);
    engineRef.current?.setTool(tool);
    clientRef.current?.sendPresenceUpdate(tool);
  };

  const handleChangeStyle = (patch: Partial<DrawingStyleState>) => {
    setStyle((prev) => ({ ...prev, ...patch }));
    engineRef.current?.setDrawingStyle(patch);
  };

  const handleReorderLayer = (elementId: string, action: LayerOrderAction) => {
    engineRef.current?.bridge.reorderElementLayer(elementId, action);
  };

  const handleDeleteSelected = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const ids = engine.bridge.getSelectedElementIds();
    engine.bridge.deleteElements(ids, true);
  };

  const handleSelectFromLayerPanel = (elementId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setTool('select');
    setActiveTool('select');
    engine.bridge.selectElementById(elementId);
    clientRef.current?.sendPresenceUpdate('select', [elementId]);
  };

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden bg-slate-100">
      {/* Top Workspace Header */}
      <TopHeaderBar
        roomId={roomId}
        status={diagnostics.status}
        rttMs={diagnostics.rttMs}
        pendingOutboxCount={diagnostics.pendingOutboxCount}
        members={members}
        localClientId={user.clientId}
        canUndo={canUndo}
        canRedo={canRedo}
        hasElements={elements.length > 0}
        onUndo={() => engineRef.current?.bridge.performUndo()}
        onRedo={() => engineRef.current?.bridge.performRedo()}
        onClearAll={() => engineRef.current?.bridge.clearAllVisible()}
        onExportPng={() => engineRef.current?.exportHighDpiPng(roomId)}
        onLeaveRoom={onLeaveRoom}
      />

      {/* Main Three-Column Workspace Body */}
      <div className="flex-1 flex min-h-0 relative overflow-hidden">
        {/* Center Infinite Canvas Stage + Left Floating Tool Dock + Bottom-Left Zoom HUD */}
        <div
          ref={stageContainerRef}
          data-testid="whiteboard-canvas-stage"
          className="whiteboard-stage flex-1 relative h-full overflow-hidden"
        >
          {/* Layer 0: Adaptive Infinite World Grid */}
          <canvas
            ref={gridCanvasRef}
            className="absolute inset-0 z-0 pointer-events-none"
          />

          {/* Layer 1: Fabric.js v6 Interactive Vector Canvas */}
          <div className="absolute inset-0 z-10">
            <canvas ref={fabricCanvasRef} />
          </div>

          {/* Layer 2: 60fps Remote Live Brush Trajectories & Named Cursors */}
          <canvas
            ref={ephemeralCanvasRef}
            className="absolute inset-0 z-20 pointer-events-none"
          />

          {/* Left Brush & Shape Toolbar */}
          <LeftToolDock
            activeTool={activeTool}
            style={style}
            selectedElements={selectedElements}
            onSelectTool={handleSelectTool}
            onChangeStyle={handleChangeStyle}
            onReorderLayer={handleReorderLayer}
            onDeleteSelected={handleDeleteSelected}
          />

          {/* Bottom-Left Infinite Zoom & Pan HUD */}
          <ViewportZoomHud
            zoom={zoom}
            onZoomIn={() => engineRef.current?.zoomIn()}
            onZoomOut={() => engineRef.current?.zoomOut()}
            onResetZoom={() => engineRef.current?.resetViewport()}
            onFitContent={() => engineRef.current?.fitToContent()}
          />
        </div>

        {/* Right Online Members, Layers & CRDT Diagnostics Sidebar */}
        <RightSidebar
          members={members}
          localClientId={user.clientId}
          elements={elements}
          selectedIds={selectedIdSet}
          lamportClock={lamportClock}
          diagnostics={diagnostics}
          onSelectElement={handleSelectFromLayerPanel}
          onReorderLayer={handleReorderLayer}
          onDeleteElement={(id) => engineRef.current?.bridge.deleteElements([id], true)}
          onJumpToMemberCursor={(x, y) => engineRef.current?.panToWorldPoint(x, y)}
          onToggleSimulatedOffline={(offline) =>
            clientRef.current?.setSimulatedOffline(offline)
          }
          onTriggerManualSnapshot={() => clientRef.current?.triggerManualSnapshot()}
        />
      </div>
    </div>
  );
};
