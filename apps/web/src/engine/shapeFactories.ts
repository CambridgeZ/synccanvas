import type {
  ElementPropKey,
  ElementProps,
  ElementType,
  MaterializedElement,
} from '@whiteboard/shared';
import {
  Ellipse,
  FabricObject,
  IText,
  Line,
  Path,
  Point,
  Rect,
  util,
} from 'fabric';

export type CollabFabricObject = FabricObject & {
  elementId: string;
  elementType: ElementType;
};

export const SELECTION_HANDLE_STYLE = {
  originX: 'left' as const,
  originY: 'top' as const,
  strokeUniform: true,
  borderColor: '#4f46e5',
  cornerColor: '#ffffff',
  cornerStrokeColor: '#4f46e5',
  cornerStyle: 'circle' as const,
  cornerSize: 9,
  transparentCorners: false,
  borderScaleFactor: 1.5,
  padding: 4,
};

/**
 * Generates an SVG path string for a directional single-headed arrow in local coordinates.
 */
export function buildArrowSvgPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeWidth = 3,
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const headLen = Math.min(Math.max(14, strokeWidth * 4.2), Math.max(10, len * 0.45));
  const angle = Math.atan2(dy, dx);
  const spread = Math.PI / 6.2;

  const hx1 = x2 - headLen * Math.cos(angle - spread);
  const hy1 = y2 - headLen * Math.sin(angle - spread);
  const hx2 = x2 - headLen * Math.cos(angle + spread);
  const hy2 = y2 - headLen * Math.sin(angle + spread);

  const fmt = (n: number) => Number(n.toFixed(2));
  return `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)} M ${fmt(hx1)} ${fmt(hy1)} L ${fmt(x2)} ${fmt(y2)} L ${fmt(hx2)} ${fmt(hy2)}`;
}

export function attachCollabMeta<T extends FabricObject>(
  obj: T,
  elementId: string,
  elementType: ElementType,
): T & CollabFabricObject {
  const tagged = obj as T & CollabFabricObject;
  tagged.elementId = elementId;
  tagged.elementType = elementType;
  return tagged;
}

export function createFabricObjectFromElement(el: MaterializedElement): CollabFabricObject {
  const common = {
    ...SELECTION_HANDLE_STYLE,
    left: el.left,
    top: el.top,
    scaleX: el.scaleX,
    scaleY: el.scaleY,
    angle: el.angle,
    stroke: el.stroke,
    strokeWidth: el.strokeWidth,
    fill: el.fill,
    opacity: el.opacity,
  };

  if (el.type === 'rect') {
    const rect = new Rect({
      ...common,
      width: Math.max(2, el.width),
      height: Math.max(2, el.height),
      rx: 4,
      ry: 4,
    });
    return attachCollabMeta(rect, el.id, 'rect');
  }

  if (el.type === 'ellipse') {
    const ellipse = new Ellipse({
      ...common,
      rx: Math.max(2, el.width / 2),
      ry: Math.max(2, el.height / 2),
    });
    return attachCollabMeta(ellipse, el.id, 'ellipse');
  }

  if (el.type === 'line') {
    const x1 = el.x1 ?? 0;
    const y1 = el.y1 ?? 0;
    const x2 = el.x2 ?? el.width;
    const y2 = el.y2 ?? el.height;
    const line = new Line([x1, y1, x2, y2], {
      ...common,
      fill: 'transparent',
      strokeLineCap: 'round',
    });
    line.set({ left: el.left, top: el.top });
    return attachCollabMeta(line, el.id, 'line');
  }

  if (el.type === 'arrow') {
    const x1 = el.x1 ?? 0;
    const y1 = el.y1 ?? 0;
    const x2 = el.x2 ?? el.width;
    const y2 = el.y2 ?? el.height;
    const svg = el.pathData || buildArrowSvgPath(x1, y1, x2, y2, el.strokeWidth);
    const arrow = new Path(svg, {
      ...common,
      fill: 'transparent',
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
    });
    arrow.set({ left: el.left, top: el.top });
    return attachCollabMeta(arrow, el.id, 'arrow');
  }

  if (el.type === 'path') {
    let parsedPath: string | Array<Array<string | number>> = 'M 0 0 L 1 1';
    if (el.pathData) {
      if (el.pathData.trim().startsWith('[')) {
        try {
          parsedPath = JSON.parse(el.pathData);
        } catch {
          parsedPath = el.pathData;
        }
      } else {
        parsedPath = el.pathData;
      }
    }
    const pathObj = new Path(parsedPath as string, {
      ...common,
      fill: 'transparent',
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
    });
    pathObj.set({ left: el.left, top: el.top });
    return attachCollabMeta(pathObj, el.id, 'path');
  }

  // 'text'
  const textObj = new IText(el.text ?? '双击输入文字', {
    ...SELECTION_HANDLE_STYLE,
    left: el.left,
    top: el.top,
    scaleX: el.scaleX,
    scaleY: el.scaleY,
    angle: el.angle,
    fill: el.stroke || '#0f172a',
    stroke: 'transparent',
    strokeWidth: 0,
    opacity: el.opacity,
    fontSize: el.fontSize ?? 22,
    fontFamily:
      el.fontFamily ??
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    fontWeight: 500,
  });
  return attachCollabMeta(textObj, el.id, 'text');
}

/**
 * Applies full or partial MaterializedElement properties onto an existing FabricObject
 * while respecting locked properties during active user gestures.
 */
export function applyElementPropsToFabricObject(
  obj: CollabFabricObject,
  el: MaterializedElement,
  lockedProps?: ReadonlySet<ElementPropKey>,
): void {
  const canSet = (key: ElementPropKey) => !lockedProps || !lockedProps.has(key);

  if (canSet('left')) obj.set('left', el.left);
  if (canSet('top')) obj.set('top', el.top);
  if (canSet('scaleX')) obj.set('scaleX', el.scaleX);
  if (canSet('scaleY')) obj.set('scaleY', el.scaleY);
  if (canSet('angle')) obj.set('angle', el.angle);
  if (canSet('opacity')) obj.set('opacity', el.opacity);

  if (el.type === 'text' && obj instanceof IText) {
    if (canSet('stroke')) {
      obj.set('fill', el.stroke || '#0f172a');
    }
    if (canSet('fontSize') && el.fontSize !== undefined) {
      obj.set('fontSize', el.fontSize);
    }
    if (canSet('text') && el.text !== undefined && !obj.isEditing && obj.text !== el.text) {
      obj.set('text', el.text);
    }
  } else {
    if (canSet('stroke')) obj.set('stroke', el.stroke);
    if (canSet('strokeWidth')) obj.set('strokeWidth', el.strokeWidth);
    if (
      canSet('fill') &&
      el.type !== 'path' &&
      el.type !== 'line' &&
      el.type !== 'arrow'
    ) {
      obj.set('fill', el.fill);
    }
  }

  if (el.type === 'rect' && obj instanceof Rect) {
    if (canSet('width')) obj.set('width', Math.max(2, el.width));
    if (canSet('height')) obj.set('height', Math.max(2, el.height));
  } else if (el.type === 'ellipse' && obj instanceof Ellipse) {
    if (canSet('width')) obj.set('rx', Math.max(2, el.width / 2));
    if (canSet('height')) obj.set('ry', Math.max(2, el.height / 2));
  }

  obj.setCoords();
}

/**
 * Extracts world-space geometric & style properties from a FabricObject.
 * Correctly decomposes world coordinates even when `obj` is temporarily nested inside
 * a multi-object `ActiveSelection` group!
 */
export function extractWorldElementProps(obj: CollabFabricObject): Partial<ElementProps> {
  let left = obj.left ?? 0;
  let top = obj.top ?? 0;
  let scaleX = obj.scaleX ?? 1;
  let scaleY = obj.scaleY ?? 1;
  let angle = obj.angle ?? 0;

  if (obj.group) {
    const matrix = obj.calcTransformMatrix();
    const dec = util.qrDecompose(matrix);
    scaleX = dec.scaleX;
    scaleY = dec.scaleY;
    angle = dec.angle;

    // Convert decomposed world center (translateX, translateY) back to ('left', 'top') origin
    const prevScaleX = obj.scaleX;
    const prevScaleY = obj.scaleY;
    const prevAngle = obj.angle;
    obj.scaleX = scaleX;
    obj.scaleY = scaleY;
    obj.angle = angle;
    const topLeft = obj.translateToOriginPoint(
      new Point(dec.translateX, dec.translateY),
      'left',
      'top',
    );
    obj.scaleX = prevScaleX;
    obj.scaleY = prevScaleY;
    obj.angle = prevAngle;

    left = topLeft.x;
    top = topLeft.y;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const round4 = (n: number) => Math.round(n * 10000) / 10000;

  const out: Partial<ElementProps> = {
    left: round2(left),
    top: round2(top),
    scaleX: round4(scaleX),
    scaleY: round4(scaleY),
    angle: round2(angle),
  };

  if (obj.elementType === 'text' && obj instanceof IText) {
    out.text = obj.text ?? '';
    out.width = round2(obj.width ?? 100);
    out.height = round2(obj.height ?? 32);
  }

  return out;
}
