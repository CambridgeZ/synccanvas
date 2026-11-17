import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_CONFIG = {
  port: Number(process.env.PORT ?? 3001),
  dbPath: process.env.DB_PATH ?? path.resolve(__dirname, '../data/whiteboard.sqlite'),
  snapshotOpThreshold: Number(process.env.SNAPSHOT_OP_THRESHOLD ?? 100),
  snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 15_000),
  compactionRetainOps: Number(process.env.COMPACTION_RETAIN_OPS ?? 200),
  corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
};
