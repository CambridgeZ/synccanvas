export type ElementType = 'rect' | 'ellipse' | 'line' | 'arrow' | 'path' | 'text';

export type ToolType =
  | 'select'
  | 'hand'
  | 'pencil'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'eraser';

export interface LWWRegister<T = unknown> {
  value: T;
  lamport: number;
  clientId: string;
}

export interface ElementProps {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
  opacity: number;
  zIndex: number;
  // Relative endpoints for line & arrow (relative to element left/top)
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  // Serialized Fabric Path command array JSON or SVG path string
  pathData?: string;
  // Text properties
  text?: string;
  fontSize?: number;
  fontFamily?: string;
}

export type ElementPropKey = keyof ElementProps;

export type ElementPropRegisters = {
  [K in ElementPropKey]?: LWWRegister<ElementProps[K]>;
};

export interface CRDTElementRecord {
  id: string;
  type: ElementType;
  createdBy: string;
  createdAt: number;
  _deleted: LWWRegister<boolean>;
  props: ElementPropRegisters;
}

/** Materialized flat element ready for Fabric.js rendering & UI layer lists */
export interface MaterializedElement extends ElementProps {
  id: string;
  type: ElementType;
  createdBy: string;
  createdAt: number;
  deleted: boolean;
}

/**
 * Atomic CRDT Operation:
 * Can create a new element, update any subset of properties at (lamport, clientId),
 * or toggle the `_deleted` tombstone register (delete / undelete).
 */
export interface CRDTOperation {
  opId: string;
  roomId: string;
  elementId: string;
  elementType?: ElementType;
  createdBy?: string;
  createdAt?: number;
  clientId: string;
  lamport: number;
  props?: Partial<ElementProps>;
  deleted?: boolean;
  serverSeq?: number;
}

export interface CRDTSnapshot {
  roomId: string;
  lamport: number;
  elements: Record<string, CRDTElementRecord>;
}

export interface ApplyResult {
  changed: boolean;
  elementId: string;
  changedProps: ElementPropKey[];
  deletedChanged: boolean;
  created: boolean;
}
