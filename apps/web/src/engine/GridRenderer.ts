/**
 * Layer 0: Viewport-synchronized Adaptive Infinite Grid Canvas
 *
 * Syncs directly with Fabric.js `viewportTransform = [zoom, 0, 0, zoom, panX, panY]`.
 * Automatically fades fine grid lines when zoomed far out (< 45%) to avoid visual moiré.
 */
export class GridRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private vpt: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context for GridRenderer');
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
    this.render();
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
    this.render();
  }

  public render(): void {
    const { width, height, ctx } = this;
    if (width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const zoom = this.vpt[0];
    const panX = this.vpt[4];
    const panY = this.vpt[5];

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Warm studio paper backdrop
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);

    const minorStep = 24 * zoom;
    const majorStep = 120 * zoom;

    // Draw minor sub-grid when zoom >= 0.4
    if (zoom >= 0.4 && minorStep >= 8) {
      const alpha = Math.min(1, (zoom - 0.35) / 0.35) * 0.55;
      ctx.strokeStyle = `rgba(226, 232, 240, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 1;
      this.drawGridLines(minorStep, panX, panY, width, height);
    }

    // Draw major 5x grid
    if (majorStep >= 12) {
      ctx.strokeStyle = 'rgba(203, 213, 225, 0.72)';
      ctx.lineWidth = 1;
      this.drawGridLines(majorStep, panX, panY, width, height);
    }

    // Subtle origin crosshair at world (0, 0)
    if (panX >= -2 && panX <= width + 2) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(panX, 0);
      ctx.lineTo(panX, height);
      ctx.stroke();
    }
    if (panY >= -2 && panY <= height + 2) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, panY);
      ctx.lineTo(width, panY);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawGridLines(
    step: number,
    panX: number,
    panY: number,
    width: number,
    height: number,
  ): void {
    const { ctx } = this;
    const offsetX = ((panX % step) + step) % step;
    const offsetY = ((panY % step) + step) % step;

    ctx.beginPath();
    for (let x = offsetX; x <= width; x += step) {
      const snappedX = Math.round(x) + 0.5;
      ctx.moveTo(snappedX, 0);
      ctx.lineTo(snappedX, height);
    }
    for (let y = offsetY; y <= height; y += step) {
      const snappedY = Math.round(y) + 0.5;
      ctx.moveTo(0, snappedY);
      ctx.lineTo(width, snappedY);
    }
    ctx.stroke();
  }
}
