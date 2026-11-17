import type {
  ClientToServerEvents,
  CollaboratorPresence,
  CollaboratorProfile,
  CRDTOperation,
  CRDTSnapshot,
  ElementProps,
  EphemeralCursorPayload,
  EphemeralStrokePayload,
  EphemeralTransformPayload,
  ServerToClientEvents,
  ToolType,
} from '@whiteboard/shared';
import { io, type Socket } from 'socket.io-client';
import { OfflineOutbox } from './offlineOutbox';

export type ConnectionStatus =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'simulated_offline'
  | 'disconnected';

export interface CrdtOpLogItem {
  id: string;
  direction: 'LOCAL' | 'REMOTE';
  lamport: number;
  clientId: string;
  elementId: string;
  summary: string;
  timestamp: number;
}

export interface DiagnosticsSnapshot {
  status: ConnectionStatus;
  simulatedOffline: boolean;
  rttMs: number | null;
  serverSeq: number;
  pendingOutboxCount: number;
  txPerSec: number;
  rxPerSec: number;
  lastSnapshotAt: number | null;
  recentLogs: CrdtOpLogItem[];
}

export interface CollaborationClientCallbacks {
  onRemoteSnapshot: (snapshot: CRDTSnapshot) => void;
  onRemoteOps: (ops: CRDTOperation[]) => void;
  onRemoteCursor: (payload: EphemeralCursorPayload) => void;
  onRemoteStroke: (payload: EphemeralStrokePayload) => void;
  onRemoteTransform: (payload: EphemeralTransformPayload) => void;
  onPresenceChanged: (members: CollaboratorPresence[]) => void;
  onDiagnosticsChanged: (diag: DiagnosticsSnapshot) => void;
}

export class CollaborationClient {
  public readonly roomId: string;
  public readonly user: CollaboratorProfile;
  private readonly outbox: OfflineOutbox;
  private readonly callbacks: CollaborationClientCallbacks;
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;

  private activeTool: ToolType = 'pencil';
  private status: ConnectionStatus = 'connecting';
  private simulatedOffline = false;
  private rttMs: number | null = null;
  private lastSnapshotAt: number | null = null;

  private txCounterWindow = 0;
  private rxCounterWindow = 0;
  private txPerSec = 0;
  private rxPerSec = 0;
  private recentLogs: CrdtOpLogItem[] = [];

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private rateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    roomId: string,
    user: CollaboratorProfile,
    callbacks: CollaborationClientCallbacks,
  ) {
    this.roomId = roomId;
    this.user = user;
    this.callbacks = callbacks;
    this.outbox = new OfflineOutbox(roomId, user.clientId);

    this.socket = io('/', {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 600,
      reconnectionDelayMax: 3000,
    });

    this.bindSocketEvents();
  }

  public connect(): void {
    this.simulatedOffline = false;
    this.status = 'connecting';
    this.emitDiagnostics();
    this.socket.connect();

    this.pingTimer = setInterval(() => {
      if (this.socket.connected && !this.simulatedOffline) {
        this.txCounterWindow += 1;
        this.socket.emit('diag:ping', { sentAt: Date.now() });
      }
    }, 2000);

    this.rateTimer = setInterval(() => {
      this.txPerSec = this.txCounterWindow;
      this.rxPerSec = this.rxCounterWindow;
      this.txCounterWindow = 0;
      this.rxCounterWindow = 0;
      this.emitDiagnostics();
    }, 1000);
  }

  /**
   * Toggle Simulated Network Disconnect for live CRDT Offline-Merge Showcase:
   * - When enabled: cleanly disconnects WebSocket and buffers all local CRDT ops in OfflineOutbox.
   * - When disabled: reconnects and triggers atomic `sync:join` merge with server's latest state.
   */
  public setSimulatedOffline(offline: boolean): void {
    if (this.simulatedOffline === offline) return;
    this.simulatedOffline = offline;

    if (offline) {
      this.socket.io.opts.reconnection = false;
      this.socket.disconnect();
      this.status = 'simulated_offline';
      this.rttMs = null;
      this.emitDiagnostics();
    } else {
      this.socket.io.opts.reconnection = true;
      this.status = 'reconnecting';
      this.emitDiagnostics();
      this.socket.connect();
    }
  }

  public sendDurableOps(ops: ReadonlyArray<CRDTOperation>, label = 'op'): void {
    if (ops.length === 0) return;

    // Always buffer into durable OfflineOutbox first until server sends `crdt:ack`
    this.outbox.enqueue(ops);
    for (const op of ops) {
      this.appendLog('LOCAL', op, label);
    }

    if (this.socket.connected && !this.simulatedOffline) {
      this.txCounterWindow += 1;
      this.socket.emit('crdt:ops', {
        roomId: this.roomId,
        ops: [...ops],
      });
    }

    this.emitDiagnostics();
  }

  public sendEphemeralCursor(x: number, y: number, tool: ToolType): void {
    this.activeTool = tool;
    if (!this.socket.connected || this.simulatedOffline) return;
    this.txCounterWindow += 1;
    this.socket.emit('ephemeral:cursor', {
      roomId: this.roomId,
      clientId: this.user.clientId,
      name: this.user.name,
      color: this.user.color,
      x,
      y,
      activeTool: tool,
    });
  }

  public sendEphemeralStroke(
    strokeId: string,
    points: Array<[number, number]>,
    strokeColor: string,
    strokeWidth: number,
    phase: 'start' | 'move' | 'end',
  ): void {
    if (!this.socket.connected || this.simulatedOffline) return;
    this.txCounterWindow += 1;
    this.socket.emit('ephemeral:stroke', {
      roomId: this.roomId,
      strokeId,
      clientId: this.user.clientId,
      name: this.user.name,
      color: this.user.color,
      strokeColor,
      strokeWidth,
      points,
      phase,
    });
  }

  public sendEphemeralTransform(
    transforms: Array<{ elementId: string; props: Partial<ElementProps> }>,
    phase: 'active' | 'end',
  ): void {
    if (!this.socket.connected || this.simulatedOffline) return;
    this.txCounterWindow += 1;
    this.socket.emit('ephemeral:transform', {
      roomId: this.roomId,
      clientId: this.user.clientId,
      name: this.user.name,
      color: this.user.color,
      transforms,
      phase,
    });
  }

  public sendPresenceUpdate(activeTool?: ToolType, selectedIds?: string[]): void {
    if (activeTool) this.activeTool = activeTool;
    if (!this.socket.connected || this.simulatedOffline) return;
    this.txCounterWindow += 1;
    this.socket.emit('presence:update', {
      roomId: this.roomId,
      activeTool,
      selectedIds,
    });
  }

  public triggerManualSnapshot(): void {
    if (!this.socket.connected || this.simulatedOffline) return;
    this.txCounterWindow += 1;
    this.socket.emit('snapshot:trigger', { roomId: this.roomId });
  }

  public dispose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.rateTimer) clearInterval(this.rateTimer);
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }

  private bindSocketEvents(): void {
    this.socket.on('connect', () => {
      if (this.simulatedOffline) {
        this.socket.disconnect();
        return;
      }

      const pendingOps = this.outbox.getAll();
      this.txCounterWindow += 1;
      this.socket.emit('sync:join', {
        roomId: this.roomId,
        user: this.user,
        activeTool: this.activeTool,
        lastKnownServerSeq: this.outbox.lastKnownServerSeq,
        pendingOps,
      });

      // Kick off immediate RTT probe on connect
      this.socket.emit('diag:ping', { sentAt: Date.now() });
    });

    this.socket.on('disconnect', () => {
      if (this.simulatedOffline) {
        this.status = 'simulated_offline';
      } else {
        this.status = 'reconnecting';
      }
      this.rttMs = null;
      this.emitDiagnostics();
    });

    this.socket.on('sync:state', (payload) => {
      this.rxCounterWindow += 1;
      this.status = 'online';

      if (payload.ackedOpIds.length > 0) {
        this.outbox.acknowledge(payload.ackedOpIds);
      }
      this.outbox.updateServerSeq(payload.serverSeq);
      this.lastSnapshotAt = payload.lastSnapshotAt;

      if (payload.mode === 'snapshot' && payload.snapshot) {
        this.callbacks.onRemoteSnapshot(payload.snapshot);
      } else if (payload.mode === 'delta' && payload.missedOps) {
        for (const op of payload.missedOps) {
          this.appendLog('REMOTE', op, 'sync-delta');
        }
        this.callbacks.onRemoteOps(payload.missedOps);
      }

      this.callbacks.onPresenceChanged(payload.members);
      this.emitDiagnostics();
    });

    this.socket.on('crdt:ops', (payload) => {
      this.rxCounterWindow += 1;
      this.outbox.updateServerSeq(payload.serverSeq);
      for (const op of payload.ops) {
        this.appendLog('REMOTE', op);
      }
      this.callbacks.onRemoteOps(payload.ops);
      this.emitDiagnostics();
    });

    this.socket.on('crdt:ack', (payload) => {
      this.rxCounterWindow += 1;
      this.outbox.acknowledge(payload.ackedOpIds);
      this.outbox.updateServerSeq(payload.serverSeq);
      this.emitDiagnostics();
    });

    this.socket.on('ephemeral:cursor', (payload) => {
      this.rxCounterWindow += 1;
      this.callbacks.onRemoteCursor(payload);
    });

    this.socket.on('ephemeral:stroke', (payload) => {
      this.rxCounterWindow += 1;
      this.callbacks.onRemoteStroke(payload);
    });

    this.socket.on('ephemeral:transform', (payload) => {
      this.rxCounterWindow += 1;
      this.callbacks.onRemoteTransform(payload);
    });

    this.socket.on('presence:state', (payload) => {
      this.rxCounterWindow += 1;
      this.callbacks.onPresenceChanged(payload.members);
    });

    this.socket.on('snapshot:saved', (payload) => {
      this.rxCounterWindow += 1;
      this.lastSnapshotAt = payload.savedAt;
      this.emitDiagnostics();
    });

    this.socket.on('diag:pong', (payload) => {
      this.rxCounterWindow += 1;
      this.rttMs = Math.max(1, Date.now() - payload.sentAt);
      this.outbox.updateServerSeq(payload.roomServerSeq);
      if (payload.lastSnapshotAt !== null) {
        this.lastSnapshotAt = payload.lastSnapshotAt;
      }
      this.emitDiagnostics();
    });
  }

  private appendLog(direction: 'LOCAL' | 'REMOTE', op: CRDTOperation, hint?: string): void {
    let summary = '';
    if (op.deleted === true) {
      summary = 'Tombstone 删除 (_deleted=true)';
    } else if (op.deleted === false && op.createdAt) {
      summary = `创建 ${op.elementType ?? 'shape'}`;
    } else if (op.deleted === false) {
      summary = '恢复图形 (_deleted=false)';
    } else if (op.props) {
      const keys = Object.keys(op.props).slice(0, 4).join(', ');
      summary = `更新 [${keys}]${hint ? ` (${hint})` : ''}`;
    } else {
      summary = hint ?? '变更';
    }

    this.recentLogs = [
      {
        id: `${op.opId}_${direction}`,
        direction,
        lamport: op.lamport,
        clientId: op.clientId,
        elementId: op.elementId.slice(0, 10),
        summary,
        timestamp: Date.now(),
      },
      ...this.recentLogs,
    ].slice(0, 20);
  }

  private emitDiagnostics(): void {
    this.callbacks.onDiagnosticsChanged({
      status: this.status,
      simulatedOffline: this.simulatedOffline,
      rttMs: this.rttMs,
      serverSeq: this.outbox.lastKnownServerSeq,
      pendingOutboxCount: this.outbox.size,
      txPerSec: this.txPerSec,
      rxPerSec: this.rxPerSec,
      lastSnapshotAt: this.lastSnapshotAt,
      recentLogs: this.recentLogs,
    });
  }
}
