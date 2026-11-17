import {
  CRDTDocument,
  UndoManager,
  type CRDTOperation,
  type ElementProps,
  type ElementType,
  type MaterializedElement,
  type ToolType,
} from '@whiteboard/shared';
import {
  Canvas,
  Ellipse,
  type FabricObject,
  IText,
  Line,
  Path,
  PencilBrush,
  Point,
  Rect,
} from 'fabric';
import { EphemeralRenderer } from './EphemeralRenderer';
import { FabricCRDTBridge } from './FabricCRDTBridge';
import { GridRenderer } from './GridRenderer';
import {
  attachCollabMeta,
  buildArrowSvgPath,
  type CollabFabricObject,
  SELECTION_HANDLE_STYLE,
} from './shapeFactories';

export interface DrawingStyleState {
  stroke: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
  fontSize?: number;
}

export interface WhiteboardEngineCallbacks {
  onLocalDurableOps: (ops: CRDTOperation[], label: string) => void;
  onLocalCursorMove: (worldX: number, worldY: number, tool: ToolType) => void;
  onLocalStrokeStream: (
    strokeId: string,
    points: Array<[number, number]>,
    strokeColor: string,
    strokeWidth: number,
    phase: 'start' | 'move' | 'end',
  ) => void;
  onLocalEphemeralTransform: (
    transforms: Array<{ elementId: string; props: Partial<ElementProps> }>,
    phase: 'active' | 'end',
  ) => void;
  onZoomChanged: (zoom: number) => void;
  onToolAutoSwitch: (tool: ToolType) => void;
  onSelectionChanged: (selectedElements: MaterializedElement[]) => void;
  onElementsChanged: (visibleElements: MaterializedElement[]) => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5.0;

/**
 * Core Whiteboard Canvas Controller (Three-Layer Stack)
 * - Layer 0: GridRenderer (Adaptive infinite world grid)
 * - Layer 1: Fabric.js v6 Interactive Canvas (Durable vector scene)
 * - Layer 2: EphemeralRenderer (60fps remote brush streams & named collaborator cursors)
 */
export class WhiteboardEngine {
  public readonly canvas: Canvas;
  public readonly grid: GridRenderer;
  public readonly ephemeral: EphemeralRenderer;
  public readonly bridge: FabricCRDTBridge;
  public readonly doc: CRDTDocument;
  public readonly undoManager: UndoManager;

  private readonly container: HTMLElement;
  private readonly callbacks: WhiteboardEngineCallbacks;
  private resizeObserver: ResizeObserver;

  private activeTool: ToolType = 'pencil';
  private spacePressed = false;
  private style: DrawingStyleState = {
    stroke: '#1e293b',
    fill: 'transparent',
    strokeWidth: 3,
    opacity: 1,
  };

  // Interactive gesture states
  private isPanning = false;
  private panLastClient = { x: 0, y: 0 };

  // Shape rubber-band draft state
  private draftShape: FabricObject | null = null;
  private draftStartWorld = { x: 0, y: 0 };

  // Freehand live stroke streaming state
  private activeStrokeId: string | null = null;
  private strokePointBuffer: Array<[number, number]> = [];
  private lastStrokeFlushAt = 0;

  // Eraser sweep state
  private isErasingSweep = false;
  private erasedIdsInSweep: Set<string> = new Set();

  private lastCursorEmitAt = 0;

  constructor(
    container: HTMLElement,
    gridCanvasEl: HTMLCanvasElement,
    fabricCanvasEl: HTMLCanvasElement,
    ephemeralCanvasEl: HTMLCanvasElement,
    doc: CRDTDocument,
    undoManager: UndoManager,
    callbacks: WhiteboardEngineCallbacks,
  ) {
    this.container = container;
    this.doc = doc;
    this.undoManager = undoManager;
    this.callbacks = callbacks;

    const rect = container.getBoundingClientRect();
    const initW = Math.max(300, Math.floor(rect.width));
    const initH = Math.max(300, Math.floor(rect.height));

    this.grid = new GridRenderer(gridCanvasEl);
    this.ephemeral = new EphemeralRenderer(ephemeralCanvasEl);

    this.canvas = new Canvas(fabricCanvasEl, {
      width: initW,
      height: initH,
      selection: true,
      preserveObjectStacking: true,
      stopContextMenu: true,
      fireMiddleClick: true,
      renderOnAddRemove: true,
    });

    const brush = new PencilBrush(this.canvas);
    brush.color = this.style.stroke;
    brush.width = this.style.strokeWidth;
    brush.decimate = 1.6;
    this.canvas.freeDrawingBrush = brush;

    this.bridge = new FabricCRDTBridge(this.canvas, this.doc, this.undoManager, {
      onLocalDurableOps: callbacks.onLocalDurableOps,
      onLocalEphemeralTransform: callbacks.onLocalEphemeralTransform,
      onSelectionChanged: callbacks.onSelectionChanged,
      onElementsChanged: callbacks.onElementsChanged,
    });

    this.grid.resize(initW, initH);
    this.ephemeral.resize(initW, initH);

    this.bindViewportAndDrawingEvents();
    this.applyToolCursorAndMode();

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(200, Math.floor(entry.contentRect.width));
        const h = Math.max(200, Math.floor(entry.contentRect.height));
        this.canvas.setDimensions({ width: w, height: h });
        this.grid.resize(w, h);
        this.ephemeral.resize(w, h);
      }
    });
    this.resizeObserver.observe(container);
  }

  public get isEditingText(): boolean {
    const active = this.canvas.getActiveObject();
    return Boolean(active instanceof IText && active.isEditing);
  }

  public setTool(tool: ToolType): void {
    if (this.activeTool === tool) return;
    if (this.isEditingText) {
      (this.canvas.getActiveObject() as IText).exitEditing();
    }
    this.activeTool = tool;
    this.applyToolCursorAndMode();
  }

  public getTool(): ToolType {
    return this.activeTool;
  }

  public setSpacePanOverride(pressed: boolean): void {
    if (this.spacePressed === pressed) return;
    this.spacePressed = pressed;
    this.applyToolCursorAndMode();
  }

  public setDrawingStyle(patch: Partial<DrawingStyleState>): void {
    this.style = { ...this.style, ...patch };
    if (this.canvas.freeDrawingBrush) {
      this.canvas.freeDrawingBrush.color = this.style.stroke;
      this.canvas.freeDrawingBrush.width = this.style.strokeWidth;
    }

    // If user currently has elements selected in 'select' mode, apply style live!
    const selectedIds = this.bridge.getSelectedElementIds();
    if (selectedIds.length > 0) {
      this.bridge.updateElementsStyle(selectedIds, patch, 'style');
    }
  }

  public getDrawingStyle(): DrawingStyleState {
    return { ...this.style };
  }

  public getZoom(): number {
    return this.canvas.getZoom();
  }

  public zoomTo(targetZoom: number, focalScreenPoint?: Point): void {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
    const center =
      focalScreenPoint ??
      new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2);
    this.canvas.zoomToPoint(center, clamped);
    this.syncViewportLayers();
    this.callbacks.onZoomChanged(clamped);
  }

  public zoomIn(): void {
    this.zoomTo(this.getZoom() * 1.2);
  }

  public zoomOut(): void {
    this.zoomTo(this.getZoom() / 1.2);
  }

  public resetViewport(): void {
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    this.syncViewportLayers();
    this.callbacks.onZoomChanged(1);
  }

  public panToWorldPoint(worldX: number, worldY: number): void {
    const zoom = this.getZoom();
    const panX = this.canvas.getWidth() / 2 - worldX * zoom;
    const panY = this.canvas.getHeight() / 2 - worldY * zoom;
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, panX, panY]);
    this.syncViewportLayers();
  }

  public fitToContent(): void {
    const visible = this.doc.getVisibleElements();
    if (visible.length === 0) {
      this.resetViewport();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const el of visible) {
      const w = (el.width || 80) * Math.abs(el.scaleX || 1);
      const h = (el.height || 80) * Math.abs(el.scaleY || 1);
      minX = Math.min(minX, el.left);
      minY = Math.min(minY, el.top);
      maxX = Math.max(maxX, el.left + w);
      maxY = Math.max(maxY, el.top + h);
    }

    const contentW = Math.max(120, maxX - minX);
    const contentH = Math.max(120, maxY - minY);
    const pad = 96;
    const viewW = Math.max(200, this.canvas.getWidth() - pad * 2);
    const viewH = Math.max(200, this.canvas.getHeight() - pad * 2);
    const zoom = Math.min(1.5, Math.max(MIN_ZOOM, Math.min(viewW / contentW, viewH / contentH)));

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const panX = this.canvas.getWidth() / 2 - centerX * zoom;
    const panY = this.canvas.getHeight() / 2 - centerY * zoom;

    this.canvas.setViewportTransform([zoom, 0, 0, zoom, panX, panY]);
    this.syncViewportLayers();
    this.callbacks.onZoomChanged(zoom);
  }

  /** Export crisp 2x Retina PNG with clean white canvas backdrop */
  public exportHighDpiPng(roomId: string): void {
    this.canvas.discardActiveObject();
    const prevBg = this.canvas.backgroundColor;
    this.canvas.backgroundColor = '#ffffff';
    this.canvas.renderAll();

    const dataUrl = this.canvas.toDataURL({
      format: 'png',
      quality: 1,
      multiplier: 2,
    });

    this.canvas.backgroundColor = prevBg;
    this.canvas.renderAll();

    const link = document.createElement('a');
    link.download = `whiteboard-${roomId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  public dispose(): void {
    this.resizeObserver.disconnect();
    this.ephemeral.dispose();
    void this.canvas.dispose();
  }

  private get effectiveTool(): ToolType {
    return this.spacePressed ? 'hand' : this.activeTool;
  }

  private applyToolCursorAndMode(): void {
    const tool = this.effectiveTool;
    const isSelect = tool === 'select';
    const isPencil = tool === 'pencil';

    this.canvas.isDrawingMode = isPencil;
    this.canvas.selection = isSelect;
    this.canvas.skipTargetFind = !isSelect && tool !== 'eraser' && tool !== 'text';

    if (isPencil && this.canvas.freeDrawingBrush) {
      this.canvas.freeDrawingBrush.color = this.style.stroke;
      this.canvas.freeDrawingBrush.width = this.style.strokeWidth;
    }

    if (!isSelect) {
      this.canvas.discardActiveObject();
    }

    const cursorMap: Record<ToolType, string> = {
      select: 'default',
      hand: this.isPanning ? 'grabbing' : 'grab',
      pencil: 'crosshair',
      rect: 'crosshair',
      ellipse: 'crosshair',
      line: 'crosshair',
      arrow: 'crosshair',
      text: 'text',
      eraser: 'cell',
    };

    const cursor = cursorMap[tool];
    this.canvas.defaultCursor = cursor;
    this.canvas.hoverCursor = isSelect ? 'move' : tool === 'eraser' ? 'pointer' : cursor;

    for (const obj of this.canvas.getObjects()) {
      obj.selectable = isSelect;
      obj.evented = isSelect || tool === 'eraser' || tool === 'text';
    }

    this.canvas.requestRenderAll();
  }

  private syncViewportLayers(): void {
    const vpt = this.canvas.viewportTransform;
    this.grid.setViewportTransform(vpt);
    this.ephemeral.setViewportTransform(vpt);
    this.canvas.requestRenderAll();
  }

  private bindViewportAndDrawingEvents(): void {
    // 1. Cursor-centered smooth mouse wheel / trackpad zoom
    this.canvas.on('mouse:wheel', (opt) => {
      const e = opt.e;
      e.preventDefault();
      e.stopPropagation();

      const delta = e.deltaY;
      let zoom = this.canvas.getZoom();
      zoom *= 0.999 ** delta;
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

      this.canvas.zoomToPoint(new Point(e.offsetX, e.offsetY), zoom);
      this.syncViewportLayers();
      this.callbacks.onZoomChanged(zoom);
    });

    // 2. Unified pointer down handler (Pan / Shape Draft / Text / Eraser / Pencil Stream Start)
    this.canvas.on('mouse:down', (opt) => {
      const nativeEvt = opt.e as MouseEvent;
      const worldPt = this.canvas.getScenePoint(opt.e);
      const tool = this.effectiveTool;

      // Middle-mouse button or Hand tool -> Start infinite viewport panning
      if (nativeEvt.button === 1 || tool === 'hand') {
        this.isPanning = true;
        this.panLastClient = { x: nativeEvt.clientX, y: nativeEvt.clientY };
        this.canvas.defaultCursor = 'grabbing';
        return;
      }

      if (tool === 'pencil') {
        const strokeId = `stk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        this.activeStrokeId = strokeId;
        const pt: [number, number] = [
          Math.round(worldPt.x * 10) / 10,
          Math.round(worldPt.y * 10) / 10,
        ];
        this.strokePointBuffer = [];
        this.lastStrokeFlushAt = performance.now();
        this.callbacks.onLocalStrokeStream(
          strokeId,
          [pt],
          this.style.stroke,
          this.style.strokeWidth,
          'start',
        );
        return;
      }

      if (tool === 'eraser') {
        this.isErasingSweep = true;
        this.erasedIdsInSweep.clear();
        const target = opt.target as CollabFabricObject | undefined;
        if (target?.elementId) {
          this.erasedIdsInSweep.add(target.elementId);
          this.bridge.deleteElements([target.elementId], false);
        }
        return;
      }

      if (tool === 'text') {
        if (opt.target && opt.target instanceof IText) {
          this.setTool('select');
          this.callbacks.onToolAutoSwitch('select');
          this.canvas.setActiveObject(opt.target);
          opt.target.enterEditing();
          return;
        }
        this.createInteractiveTextAt(worldPt.x, worldPt.y);
        return;
      }

      if (tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow') {
        this.draftStartWorld = { x: worldPt.x, y: worldPt.y };
        this.draftShape = this.createDraftPreviewObject(tool, worldPt.x, worldPt.y);
        if (this.draftShape) {
          this.canvas.add(this.draftShape);
          this.canvas.requestRenderAll();
        }
      }
    });

    // 3. Unified pointer move handler
    this.canvas.on('mouse:move', (opt) => {
      const nativeEvt = opt.e as MouseEvent;
      const worldPt = this.canvas.getScenePoint(opt.e);
      const now = performance.now();

      // Emit throttled named cursor telemetry (~45Hz)
      if (now - this.lastCursorEmitAt >= 22) {
        this.lastCursorEmitAt = now;
        this.callbacks.onLocalCursorMove(
          Math.round(worldPt.x * 10) / 10,
          Math.round(worldPt.y * 10) / 10,
          this.effectiveTool,
        );
      }

      if (this.isPanning) {
        const vpt = this.canvas.viewportTransform;
        vpt[4] += nativeEvt.clientX - this.panLastClient.x;
        vpt[5] += nativeEvt.clientY - this.panLastClient.y;
        this.panLastClient = { x: nativeEvt.clientX, y: nativeEvt.clientY };
        this.syncViewportLayers();
        return;
      }

      if (this.activeStrokeId && this.effectiveTool === 'pencil') {
        this.strokePointBuffer.push([
          Math.round(worldPt.x * 10) / 10,
          Math.round(worldPt.y * 10) / 10,
        ]);
        if (now - this.lastStrokeFlushAt >= 20 && this.strokePointBuffer.length > 0) {
          this.lastStrokeFlushAt = now;
          const batch = this.strokePointBuffer.splice(0);
          this.callbacks.onLocalStrokeStream(
            this.activeStrokeId,
            batch,
            this.style.stroke,
            this.style.strokeWidth,
            'move',
          );
        }
        return;
      }

      if (this.isErasingSweep && this.effectiveTool === 'eraser') {
        const target = opt.target as CollabFabricObject | undefined;
        if (target?.elementId && !this.erasedIdsInSweep.has(target.elementId)) {
          this.erasedIdsInSweep.add(target.elementId);
          this.bridge.deleteElements([target.elementId], false);
        }
        return;
      }

      if (this.draftShape) {
        this.updateDraftPreviewObject(this.effectiveTool, worldPt.x, worldPt.y);
      }
    });

    // 4. Unified pointer up handler
    this.canvas.on('mouse:up', (opt) => {
      if (this.isPanning) {
        this.isPanning = false;
        this.applyToolCursorAndMode();
        return;
      }

      if (this.activeStrokeId) {
        const finishedStrokeId = this.activeStrokeId;
        this.activeStrokeId = null;
        if (this.strokePointBuffer.length > 0) {
          this.callbacks.onLocalStrokeStream(
            finishedStrokeId,
            this.strokePointBuffer.splice(0),
            this.style.stroke,
            this.style.strokeWidth,
            'move',
          );
        }
        this.callbacks.onLocalStrokeStream(
          finishedStrokeId,
          [],
          this.style.stroke,
          this.style.strokeWidth,
          'end',
        );
      }

      if (this.isErasingSweep) {
        this.isErasingSweep = false;
        if (this.erasedIdsInSweep.size > 0) {
          this.undoManager.recordDelete([...this.erasedIdsInSweep]);
          this.erasedIdsInSweep.clear();
        }
        return;
      }

      if (this.draftShape) {
        const worldPt = this.canvas.getScenePoint(opt.e);
        this.commitDraftShape(this.effectiveTool, worldPt.x, worldPt.y);
      }
    });

    // 5. Commit freehand PencilBrush Path into durable CRDTDocument with ('left', 'top') normalization
    this.canvas.on('path:created', (e) => {
      const rawPath = e.path as Path | undefined;
      if (!rawPath) return;

      // Normalize origin from Fabric v6 default ('center', 'center') to ('left', 'top') without shifting!
      const topLeft = rawPath.getPointByOrigin('left', 'top');
      rawPath.set({
        ...SELECTION_HANDLE_STYLE,
        originX: 'left',
        originY: 'top',
        left: topLeft.x,
        top: topLeft.y,
        selectable: false,
        evented: false,
      });
      rawPath.setCoords();

      const serializedPath = JSON.stringify(rawPath.path);
      const round2 = (n: number) => Math.round(n * 100) / 100;

      const op = this.doc.createElement('path', {
        left: round2(topLeft.x),
        top: round2(topLeft.y),
        width: round2(rawPath.width ?? 10),
        height: round2(rawPath.height ?? 10),
        scaleX: 1,
        scaleY: 1,
        angle: 0,
        stroke: this.style.stroke,
        strokeWidth: this.style.strokeWidth,
        fill: 'transparent',
        opacity: this.style.opacity,
        pathData: serializedPath,
      });

      const tagged = attachCollabMeta(rawPath, op.elementId, 'path');
      this.bridge.registerCreatedObject(tagged);
      this.undoManager.recordCreate(op.elementId, op.props!);
      this.callbacks.onLocalDurableOps([op], 'pencil');
    });
  }

  private createDraftPreviewObject(tool: ToolType, x: number, y: number): FabricObject | null {
    const common = {
      ...SELECTION_HANDLE_STYLE,
      left: x,
      top: y,
      stroke: this.style.stroke,
      strokeWidth: this.style.strokeWidth,
      fill: this.style.fill,
      opacity: this.style.opacity,
      selectable: false,
      evented: false,
    };

    if (tool === 'rect') {
      return new Rect({ ...common, width: 1, height: 1, rx: 4, ry: 4 });
    }
    if (tool === 'ellipse') {
      return new Ellipse({ ...common, rx: 1, ry: 1 });
    }
    if (tool === 'line') {
      return new Line([x, y, x + 1, y + 1], { ...common, fill: 'transparent' });
    }
    if (tool === 'arrow') {
      return new Path(buildArrowSvgPath(0, 0, 1, 1, this.style.strokeWidth), {
        ...common,
        fill: 'transparent',
      });
    }
    return null;
  }

  private updateDraftPreviewObject(tool: ToolType, curX: number, curY: number): void {
    if (!this.draftShape) return;
    const sx = this.draftStartWorld.x;
    const sy = this.draftStartWorld.y;
    const left = Math.min(sx, curX);
    const top = Math.min(sy, curY);
    const w = Math.max(2, Math.abs(curX - sx));
    const h = Math.max(2, Math.abs(curY - sy));

    if (tool === 'rect' && this.draftShape instanceof Rect) {
      this.draftShape.set({ left, top, width: w, height: h });
    } else if (tool === 'ellipse' && this.draftShape instanceof Ellipse) {
      this.draftShape.set({ left, top, rx: w / 2, ry: h / 2 });
    } else if (tool === 'line' && this.draftShape instanceof Line) {
      this.draftShape.set({ x1: sx, y1: sy, x2: curX, y2: curY });
    } else if (tool === 'arrow') {
      this.canvas.remove(this.draftShape);
      const svg = buildArrowSvgPath(sx - left, sy - top, curX - left, curY - top, this.style.strokeWidth);
      this.draftShape = new Path(svg, {
        ...SELECTION_HANDLE_STYLE,
        left,
        top,
        stroke: this.style.stroke,
        strokeWidth: this.style.strokeWidth,
        fill: 'transparent',
        opacity: this.style.opacity,
        selectable: false,
        evented: false,
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
      });
      this.canvas.add(this.draftShape);
    }

    this.canvas.requestRenderAll();
  }

  private commitDraftShape(tool: ToolType, endX: number, endY: number): void {
    if (!this.draftShape) return;
    this.canvas.remove(this.draftShape);
    this.draftShape = null;

    const sx = this.draftStartWorld.x;
    const sy = this.draftStartWorld.y;
    const dist = Math.hypot(endX - sx, endY - sy);

    // Ignore accidental tiny micro-clicks (< 4px); give sensible default size if clicked directly
    const finalEndX = dist < 5 ? sx + 140 : endX;
    const finalEndY = dist < 5 ? sy + (tool === 'line' || tool === 'arrow' ? 0 : 96) : endY;

    const left = Math.min(sx, finalEndX);
    const top = Math.min(sy, finalEndY);
    const width = Math.max(2, Math.abs(finalEndX - sx));
    const height = Math.max(2, Math.abs(finalEndY - sy));
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const shapeType = tool as Extract<ElementType, 'rect' | 'ellipse' | 'line' | 'arrow'>;
    const baseProps: Partial<ElementProps> = {
      left: round2(left),
      top: round2(top),
      width: round2(width),
      height: round2(height),
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      stroke: this.style.stroke,
      strokeWidth: this.style.strokeWidth,
      fill: shapeType === 'line' || shapeType === 'arrow' ? 'transparent' : this.style.fill,
      opacity: this.style.opacity,
    };

    if (shapeType === 'line' || shapeType === 'arrow') {
      const lx1 = round2(sx - left);
      const ly1 = round2(sy - top);
      const lx2 = round2(finalEndX - left);
      const ly2 = round2(finalEndY - top);
      baseProps.x1 = lx1;
      baseProps.y1 = ly1;
      baseProps.x2 = lx2;
      baseProps.y2 = ly2;
      if (shapeType === 'arrow') {
        baseProps.pathData = buildArrowSvgPath(lx1, ly1, lx2, ly2, this.style.strokeWidth);
      }
    }

    const op = this.doc.createElement(shapeType, baseProps);
    // Mount into Fabric canvas via bridge
    this.bridge.mountLocalElement(op.elementId);
    this.undoManager.recordCreate(op.elementId, op.props!);
    this.callbacks.onLocalDurableOps([op], shapeType);

    // Auto-switch to 'select' and highlight newly drawn shape for effortless immediate resize/drag!
    this.activeTool = 'select';
    this.applyToolCursorAndMode();
    this.bridge.selectElementById(op.elementId);
    this.callbacks.onToolAutoSwitch('select');
  }

  private createInteractiveTextAt(worldX: number, worldY: number): void {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const op = this.doc.createElement('text', {
      left: round2(worldX),
      top: round2(worldY - 12),
      width: 160,
      height: 30,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      stroke: this.style.stroke,
      strokeWidth: 0,
      fill: 'transparent',
      opacity: this.style.opacity,
      text: '输入批注文字',
      fontSize: this.style.fontSize ?? 22,
    });

    this.bridge.mountLocalElement(op.elementId);
    this.undoManager.recordCreate(op.elementId, op.props!);
    this.callbacks.onLocalDurableOps([op], 'text');

    this.activeTool = 'select';
    this.applyToolCursorAndMode();
    this.callbacks.onToolAutoSwitch('select');

    const createdObj = this.bridge.getFabricObject(op.elementId);
    if (createdObj && createdObj instanceof IText) {
      this.canvas.setActiveObject(createdObj);
      createdObj.enterEditing();
      createdObj.selectAll();
      this.canvas.requestRenderAll();
    }
  }
}
