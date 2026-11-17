import type {
  CollaboratorPresence,
  EphemeralCursorPayload,
  EphemeralStrokePayload,
  MaterializedElement,
  ToolType,
} from '@whiteboard/shared';

interface RemoteCursorState {
  clientId: string;
  name: string;
  color: string;
  targetX: number;
  targetY: number;
  renderX: number;
  renderY: number;
  activeTool: ToolType;
  updatedAt: number;
}

interface RemoteActiveStroke {
  strokeId: string;
  clientId: string;
  name: string;
  userColor: string;
  strokeColor: string;
  strokeWidth: number;
  points: Array<[number, number]>;
  updatedAt: number;
  endedAt: number | null;
}

interface RemoteSelectionHighlight {
  clientId: string;
  name: string;
  color: string;
  selectedIds: string[];
}

const CURSOR_TTL_MS = 20_000;
const STROKE_TTL_MS = 8_000;
const ENDED_STROKE_GRACE_MS = 180;

/**
 * Layer 2: Dedicated 60fps Ephemeral Collaboration Overlay Canvas (`pointer-events: none`)
 *
 * - Renders remote live freehand brush trajectories using midpoint quadratic Bézier smoothing
 *   in world coordinates without touching or dirtying the main Fabric.js scene tree.
 * - Renders remote named collaborator mouse cursors with exponential lerp smoothing in constant
 *   crisp screen-space dimensions regardless of canvas zoom level (10% - 500%).
 * - Automatically suspends its `requestAnimationFrame` loop when idle for 0% background CPU usage.
 */
export class EphemeralRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private vpt: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  private cursors: Map<string, RemoteCursorState> = new Map();
  private strokes: Map<string, RemoteActiveStroke> = new Map();
  private remoteSelections: RemoteSelectionHighlight[] = [];
  private elementLookup: Map<string, MaterializedElement> = new Map();
  private rafId: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context for EphemeralRenderer');
    }
    this.ctx = ctx;
  }

  public resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.floor(width * dpr));
    this.canvas.height = Math.max(1, Math.floor(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.renderFrame();
  }

  public setViewportTransform(vpt: number[]): void {
    this.vpt = [
      vpt[0] ?? 1,
      vpt[1] ?? 0,
      vpt[2] ?? 0,
      vpt[3] ?? 1,
      vpt[4] ?? 0,
      vpt[5] ?? 0,
    ];
    this.wakeLoop();
  }

  public ingestCursor(payload: EphemeralCursorPayload): void {
    const now = Date.now();
    const existing = this.cursors.get(payload.clientId);
    if (existing) {
      existing.name = payload.name;
      existing.color = payload.color;
      existing.targetX = payload.x;
      existing.targetY = payload.y;
      existing.activeTool = payload.activeTool;
      existing.updatedAt = now;
    } else {
      this.cursors.set(payload.clientId, {
        clientId: payload.clientId,
        name: payload.name,
        color: payload.color,
        targetX: payload.x,
        targetY: payload.y,
        renderX: payload.x,
        renderY: payload.y,
        activeTool: payload.activeTool,
        updatedAt: now,
      });
    }
    this.wakeLoop();
  }

  public ingestStroke(payload: EphemeralStrokePayload): void {
    const now = Date.now();
    if (payload.phase === 'end') {
      const existing = this.strokes.get(payload.strokeId);
      if (existing) {
        existing.endedAt = now;
        existing.updatedAt = now;
      }
      this.wakeLoop();
      return;
    }

    if (payload.phase === 'start' || !this.strokes.has(payload.strokeId)) {
      this.strokes.set(payload.strokeId, {
        strokeId: payload.strokeId,
        clientId: payload.clientId,
        name: payload.name,
        userColor: payload.color,
        strokeColor: payload.strokeColor,
        strokeWidth: payload.strokeWidth,
        points: [...payload.points],
        updatedAt: now,
        endedAt: null,
      });
    } else {
      const active = this.strokes.get(payload.strokeId)!;
      active.points.push(...payload.points);
      active.updatedAt = now;
    }

    // Also update cursor position right to the live brush tip for silky sync
    if (payload.points.length > 0) {
      const tip = payload.points[payload.points.length - 1];
      this.ingestCursor({
        roomId: payload.roomId,
        clientId: payload.clientId,
        name: payload.name,
        color: payload.color,
        x: tip[0],
        y: tip[1],
        activeTool: 'pencil',
      });
    }

    this.wakeLoop();
  }

  /** Immediately clear grace-held strokes once durable CRDT path arrives from that peer */
  public clearEndedStrokesForClient(clientId: string): void {
    let removed = false;
    for (const [id, s] of this.strokes.entries()) {
      if (s.clientId === clientId && s.endedAt !== null) {
        this.strokes.delete(id);
        removed = true;
      }
    }
    if (removed) {
      this.wakeLoop();
    }
  }

  public syncRemotePresence(
    remoteMembers: ReadonlyArray<CollaboratorPresence>,
  ): void {
    const onlineIds = new Set(remoteMembers.map((m) => m.clientId));
    for (const clientId of this.cursors.keys()) {
      if (!onlineIds.has(clientId)) {
        this.cursors.delete(clientId);
      }
    }
    this.remoteSelections = remoteMembers
      .filter((m) => m.selectedIds && m.selectedIds.length > 0)
      .map((m) => ({
        clientId: m.clientId,
        name: m.name,
        color: m.color,
        selectedIds: m.selectedIds,
      }));
    this.wakeLoop();
  }

  public syncElementsSnapshot(elements: ReadonlyArray<MaterializedElement>): void {
    this.elementLookup = new Map(elements.map((e) => [e.id, e]));
    if (this.remoteSelections.length > 0) {
      this.wakeLoop();
    }
  }

  public clearAll(): void {
    this.cursors.clear();
    this.strokes.clear();
    this.renderFrame();
  }

  public dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private wakeLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = null;
      const needsNextFrame = this.renderFrame();
      if (needsNextFrame) {
        this.rafId = requestAnimationFrame(tick);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private renderFrame(): boolean {
    const { ctx, width, height } = this;
    if (width <= 0 || height <= 0) return false;

    const dpr = window.devicePixelRatio || 1;
    const zoom = this.vpt[0];
    const panX = this.vpt[4];
    const panY = this.vpt[5];
    const now = Date.now();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    let stillAnimating = false;

    // 0. Render collaborator selection halos & badges
    if (this.remoteSelections.length > 0) {
      for (const sel of this.remoteSelections) {
        for (const elId of sel.selectedIds) {
          const el = this.elementLookup.get(elId);
          if (!el || el.deleted) continue;
          const sx = el.left * zoom + panX;
          const sy = el.top * zoom + panY;
          const sw = Math.max(12, el.width * Math.abs(el.scaleX) * zoom);
          const sh = Math.max(12, el.height * Math.abs(el.scaleY) * zoom);
          this.drawRemoteSelectionHalo(sx, sy, sw, sh, sel.name, sel.color);
        }
      }
    }

    // 1. Render remote live freehand strokes in world coordinates
    if (this.strokes.size > 0) {
      ctx.save();
      ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, panX * dpr, panY * dpr);

      for (const [id, stroke] of this.strokes.entries()) {
        if (
          now - stroke.updatedAt > STROKE_TTL_MS ||
          (stroke.endedAt !== null && now - stroke.endedAt > ENDED_STROKE_GRACE_MS)
        ) {
          this.strokes.delete(id);
          continue;
        }
        stillAnimating = true;
        this.drawSmoothStroke(stroke);
      }
      ctx.restore();
    }

    // 2. Render remote collaborator cursors in crisp constant screen space
    for (const [clientId, cur] of this.cursors.entries()) {
      const age = now - cur.updatedAt;
      if (age > CURSOR_TTL_MS) {
        this.cursors.delete(clientId);
        continue;
      }

      const dx = cur.targetX - cur.renderX;
      const dy = cur.targetY - cur.renderY;
      if (Math.abs(dx) > 0.15 || Math.abs(dy) > 0.15) {
        cur.renderX += dx * 0.38;
        cur.renderY += dy * 0.38;
        stillAnimating = true;
      } else {
        cur.renderX = cur.targetX;
        cur.renderY = cur.targetY;
      }

      const screenX = cur.renderX * zoom + panX;
      const screenY = cur.renderY * zoom + panY;

      // Fade smoothly in final 3 seconds before TTL
      const fadeAlpha = age > CURSOR_TTL_MS - 3000 ? (CURSOR_TTL_MS - age) / 3000 : 1;
      if (age > CURSOR_TTL_MS - 3000) {
        stillAnimating = true;
      }

      this.drawCollaboratorCursor(screenX, screenY, cur.name, cur.color, cur.activeTool, fadeAlpha);
    }

    ctx.restore();
    return stillAnimating;
  }

  private drawSmoothStroke(stroke: RemoteActiveStroke): void {
    const { ctx } = this;
    const pts = stroke.points;
    if (pts.length === 0) return;

    ctx.save();
    ctx.strokeStyle = stroke.strokeColor;
    ctx.fillStyle = stroke.strokeColor;
    ctx.lineWidth = stroke.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], stroke.strokeWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i += 1) {
      const midX = (pts[i][0] + pts[i + 1][0]) / 2;
      const midY = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], midX, midY);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();

    ctx.restore();
  }

  private drawCollaboratorCursor(
    x: number,
    y: number,
    name: string,
    color: string,
    tool: ToolType,
    alpha: number,
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(x, y);

    // Crisp pointer arrow with white halo
    ctx.shadowColor = 'rgba(15, 23, 42, 0.22)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 16.5);
    ctx.lineTo(4.6, 12.6);
    ctx.lineTo(8.5, 19.2);
    ctx.lineTo(11.1, 17.8);
    ctx.lineTo(7.2, 11.2);
    ctx.lineTo(12.8, 11.2);
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Name pill badge
    ctx.shadowBlur = 3;
    const toolBadge = tool === 'pencil' ? ' ✎' : tool === 'eraser' ? ' ⌫' : '';
    const label = `${name}${toolBadge}`;
    ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const textWidth = ctx.measureText(label).width;
    const padX = 8;
    const pillW = textWidth + padX * 2;
    const pillH = 21;
    const pillX = 11;
    const pillY = 14;

    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 10);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pillX + padX, pillY + pillH / 2 + 0.5);

    ctx.restore();
  }

  private drawRemoteSelectionHalo(
    x: number,
    y: number,
    w: number,
    h: number,
    name: string,
    color: string,
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);
    ctx.setLineDash([]);

    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const tag = `${name} 编辑中`;
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - 4, y - 22, tw + 10, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, x + 1, y - 13.5);
    ctx.restore();
  }
}
