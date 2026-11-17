import http from 'node:http';
import type { ClientToServerEvents, ServerToClientEvents } from '@whiteboard/shared';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { SERVER_CONFIG } from './config';
import { RoomManager } from './rooms/roomManager';
import { registerSocketHandlers } from './socket/registerHandlers';
import { SqliteWhiteboardStore } from './storage/sqliteStore';

const app = express();
app.use(cors({ origin: SERVER_CONFIG.corsOrigins, credentials: true }));
app.use(express.json({ limit: '5mb' }));

const httpServer = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: SERVER_CONFIG.corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // WebSocket heartbeat keepalive configuration
  pingInterval: 10_000,
  pingTimeout: 8_000,
  maxHttpBufferSize: 5e6,
});

const store = new SqliteWhiteboardStore(SERVER_CONFIG.dbPath);
const roomManager = new RoomManager(store, {
  snapshotOpThreshold: SERVER_CONFIG.snapshotOpThreshold,
  snapshotIntervalMs: SERVER_CONFIG.snapshotIntervalMs,
  compactionRetainOps: SERVER_CONFIG.compactionRetainOps,
  onAutoSnapshotSaved: (saved) => {
    io.to(saved.roomId).emit('snapshot:saved', saved);
  },
});

roomManager.startPeriodicSnapshotWorker();
registerSocketHandlers(io, roomManager);

// REST Endpoints for Room Lobby & Diagnostics
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    timestamp: Date.now(),
  });
});

app.get('/api/rooms', (_req, res) => {
  res.json({
    rooms: roomManager.listRoomSummaries(),
  });
});

app.get('/api/rooms/:roomId/diagnostics', (req, res) => {
  res.json(roomManager.getRoomDiagnostics(req.params.roomId));
});

app.post('/api/rooms/:roomId/snapshot', (req, res) => {
  const saved = roomManager.flushSnapshot(req.params.roomId);
  if (saved) {
    io.to(saved.roomId).emit('snapshot:saved', saved);
  }
  res.json({ ok: true, snapshot: saved });
});

httpServer.listen(SERVER_CONFIG.port, () => {
  console.log(
    `[Whiteboard Server] Listening on http://localhost:${SERVER_CONFIG.port} (SQLite WAL: ${SERVER_CONFIG.dbPath})`,
  );
});

let shuttingDown = false;
function gracefulShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Whiteboard Server] Received ${signal}, flushing CRDT room snapshots to SQLite...`);
  try {
    const flushed = roomManager.flushAllDirtySnapshots();
    roomManager.dispose();
    store.close();
    console.log(`[Whiteboard Server] Flushed ${flushed} dirty room(s). Exiting cleanly.`);
  } catch (err) {
    console.error('[Whiteboard Server] Error during snapshot flush:', err);
  } finally {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
