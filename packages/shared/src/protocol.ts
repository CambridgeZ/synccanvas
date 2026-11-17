import type { CRDTOperation, CRDTSnapshot, ElementProps, ToolType } from './types';

export interface CollaboratorProfile {
  clientId: string;
  name: string;
  color: string;
}

export interface CollaboratorPresence extends CollaboratorProfile {
  socketId: string;
  activeTool: ToolType;
  cursor: { x: number; y: number } | null;
  selectedIds: string[];
  joinedAt: number;
  lastActiveAt: number;
}

/** High-frequency cursor telemetry (Ephemeral channel - zero DB persistence) */
export interface EphemeralCursorPayload {
  roomId: string;
  clientId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  activeTool: ToolType;
}

/** High-frequency freehand brush streaming (Ephemeral channel - zero DB persistence) */
export interface EphemeralStrokePayload {
  roomId: string;
  strokeId: string;
  clientId: string;
  name: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  /** World-space [x, y] coordinate pairs appended or full active stroke points */
  points: Array<[number, number]>;
  phase: 'start' | 'move' | 'end';
}

/** Live object drag/scale/rotate preview before mouse-up commit */
export interface EphemeralTransformPayload {
  roomId: string;
  clientId: string;
  name: string;
  color: string;
  transforms: Array<{
    elementId: string;
    props: Partial<ElementProps>;
  }>;
  phase: 'active' | 'end';
}

export interface SyncJoinPayload {
  roomId: string;
  user: CollaboratorProfile;
  activeTool: ToolType;
  lastKnownServerSeq: number;
  /** Offline operations buffered while client was disconnected */
  pendingOps: CRDTOperation[];
}

export interface SyncStatePayload {
  roomId: string;
  mode: 'snapshot' | 'delta';
  snapshot?: CRDTSnapshot;
  missedOps?: CRDTOperation[];
  ackedOpIds: string[];
  serverSeq: number;
  compactedSeq: number;
  lastSnapshotAt: number | null;
  members: CollaboratorPresence[];
}

export interface CrdtOpsSubmitPayload {
  roomId: string;
  ops: CRDTOperation[];
}

export interface CrdtOpsBroadcastPayload {
  roomId: string;
  ops: CRDTOperation[];
  serverSeq: number;
}

export interface CrdtOpsAckPayload {
  roomId: string;
  ackedOpIds: string[];
  serverSeq: number;
}

export interface PresenceUpdatePayload {
  roomId: string;
  activeTool?: ToolType;
  selectedIds?: string[];
}

export interface PresenceStatePayload {
  roomId: string;
  members: CollaboratorPresence[];
}

export interface SnapshotSavedPayload {
  roomId: string;
  snapshotSeq: number;
  savedAt: number;
  elementCount: number;
}

export interface DiagPingPayload {
  sentAt: number;
}

export interface DiagPongPayload {
  sentAt: number;
  serverTime: number;
  roomServerSeq: number;
  lastSnapshotAt: number | null;
}

export interface RoomSummaryDTO {
  roomId: string;
  onlineCount: number;
  elementCount: number;
  latestSeq: number;
  lastSnapshotAt: number | null;
  updatedAt: number;
}

export interface ClientToServerEvents {
  'sync:join': (payload: SyncJoinPayload) => void;
  'crdt:ops': (payload: CrdtOpsSubmitPayload) => void;
  'ephemeral:cursor': (payload: EphemeralCursorPayload) => void;
  'ephemeral:stroke': (payload: EphemeralStrokePayload) => void;
  'ephemeral:transform': (payload: EphemeralTransformPayload) => void;
  'presence:update': (payload: PresenceUpdatePayload) => void;
  'snapshot:trigger': (payload: { roomId: string }) => void;
  'diag:ping': (payload: DiagPingPayload) => void;
}

export interface ServerToClientEvents {
  'sync:state': (payload: SyncStatePayload) => void;
  'crdt:ops': (payload: CrdtOpsBroadcastPayload) => void;
  'crdt:ack': (payload: CrdtOpsAckPayload) => void;
  'ephemeral:cursor': (payload: EphemeralCursorPayload) => void;
  'ephemeral:stroke': (payload: EphemeralStrokePayload) => void;
  'ephemeral:transform': (payload: EphemeralTransformPayload) => void;
  'presence:state': (payload: PresenceStatePayload) => void;
  'snapshot:saved': (payload: SnapshotSavedPayload) => void;
  'diag:pong': (payload: DiagPongPayload) => void;
}
