import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@whiteboard/shared';
import type { Server, Socket } from 'socket.io';
import type { RoomManager } from '../rooms/roomManager';

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  roomManager: RoomManager,
): void {
  io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
    let activeRoomId: string | null = null;

    socket.on('sync:join', (payload) => {
      if (activeRoomId && activeRoomId !== payload.roomId) {
        socket.leave(activeRoomId);
        const updates = roomManager.removeSocket(socket.id);
        for (const u of updates) {
          io.to(u.roomId).emit('presence:state', { roomId: u.roomId, members: u.members });
        }
      }

      const result = roomManager.handleJoinAndSync(socket.id, payload);
      activeRoomId = result.roomId;
      socket.join(result.roomId);

      // 1. Send authoritative delta or snapshot + acks back to joining/reconnecting client
      socket.emit('sync:state', result.syncState);

      // 2. If client brought offline operations, broadcast newly accepted ops to all other peers
      if (result.acceptedOfflineOps.length > 0) {
        socket.to(result.roomId).emit('crdt:ops', {
          roomId: result.roomId,
          ops: result.acceptedOfflineOps,
          serverSeq: result.syncState.serverSeq,
        });
      }

      // 3. Broadcast updated collaborator presence list to everyone in the room
      io.to(result.roomId).emit('presence:state', {
        roomId: result.roomId,
        members: result.syncState.members,
      });

      if (result.snapshotSaved) {
        io.to(result.roomId).emit('snapshot:saved', result.snapshotSaved);
      }
    });

    socket.on('crdt:ops', (payload) => {
      const targetRoomId = payload.roomId || activeRoomId;
      if (!targetRoomId || !Array.isArray(payload.ops) || payload.ops.length === 0) return;

      const res = roomManager.submitOperations(targetRoomId, payload.ops);

      // Confirm persistence to sender so sender flushes its OfflineOutbox
      socket.emit('crdt:ack', {
        roomId: targetRoomId,
        ackedOpIds: res.ackedOpIds,
        serverSeq: res.serverSeq,
      });

      // Broadcast newly accepted durable ops to room peers
      if (res.accepted.length > 0) {
        socket.to(targetRoomId).emit('crdt:ops', {
          roomId: targetRoomId,
          ops: res.accepted,
          serverSeq: res.serverSeq,
        });
      }

      if (res.snapshotSaved) {
        io.to(targetRoomId).emit('snapshot:saved', res.snapshotSaved);
      }
    });

    // High-frequency Ephemeral Fast-Relay Channels (Zero DB I/O)
    socket.on('ephemeral:cursor', (payload) => {
      const targetRoomId = payload.roomId || activeRoomId;
      if (!targetRoomId) return;
      roomManager.updateCursorPresence(socket.id, payload);
      socket.to(targetRoomId).emit('ephemeral:cursor', payload);
    });

    socket.on('ephemeral:stroke', (payload) => {
      const targetRoomId = payload.roomId || activeRoomId;
      if (!targetRoomId) return;
      socket.to(targetRoomId).emit('ephemeral:stroke', payload);
    });

    socket.on('ephemeral:transform', (payload) => {
      const targetRoomId = payload.roomId || activeRoomId;
      if (!targetRoomId) return;
      socket.to(targetRoomId).emit('ephemeral:transform', payload);
    });

    socket.on('presence:update', (payload) => {
      const targetRoomId = payload.roomId || activeRoomId;
      if (!targetRoomId) return;
      const members = roomManager.updateMemberPresence(socket.id, {
        ...payload,
        roomId: targetRoomId,
      });
      if (members) {
        io.to(targetRoomId).emit('presence:state', {
          roomId: targetRoomId,
          members,
        });
      }
    });

    socket.on('snapshot:trigger', ({ roomId }) => {
      const targetRoomId = roomId || activeRoomId;
      if (!targetRoomId) return;
      const saved = roomManager.flushSnapshot(targetRoomId);
      if (saved) {
        io.to(targetRoomId).emit('snapshot:saved', saved);
      }
    });

    socket.on('diag:ping', ({ sentAt }) => {
      roomManager.touchHeartbeat(socket.id, activeRoomId);
      const diag = activeRoomId ? roomManager.getRoomDiagnostics(activeRoomId) : null;
      socket.emit('diag:pong', {
        sentAt,
        serverTime: Date.now(),
        roomServerSeq: diag ? diag.latestSeq : 0,
        lastSnapshotAt: diag ? diag.lastSnapshotAt : null,
      });
    });

    socket.on('disconnect', () => {
      const updates = roomManager.removeSocket(socket.id);
      for (const u of updates) {
        io.to(u.roomId).emit('presence:state', {
          roomId: u.roomId,
          members: u.members,
        });
      }
    });
  });
}
