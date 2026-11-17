import type { CollaboratorProfile, RoomSummaryDTO } from '@whiteboard/shared';
import {
  ArrowRight,
  Database,
  GitMerge,
  Layers,
  RefreshCw,
  Shuffle,
  Sparkles,
  Users,
  Wifi,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

export const COLLABORATOR_COLORS = [
  '#4f46e5', // Indigo
  '#e11d48', // Rose
  '#059669', // Emerald
  '#d97706', // Amber
  '#0284c7', // Sky
  '#7c3aed', // Violet
  '#ea580c', // Orange
  '#0d9488', // Teal
];

const PRESET_ROOMS = ['design-review', 'arch-brainstorm', 'crdt-lab'];

function generateRandomRoomCode(): string {
  const adjectives = ['swift', 'pixel', 'lunar', 'vivid', 'hyper', 'prism'];
  const nouns = ['board', 'canvas', 'studio', 'space', 'sketch', 'matrix'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${num}`;
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return '尚未生成快照';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return '刚刚落盘';
  if (diffSec < 60) return `${diffSec} 秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

interface RoomLobbyProps {
  initialRoomId: string;
  profile: CollaboratorProfile;
  onJoinRoom: (roomId: string, updatedProfile: CollaboratorProfile) => void;
}

export const RoomLobby: React.FC<RoomLobbyProps> = ({
  initialRoomId,
  profile,
  onJoinRoom,
}) => {
  const [roomId, setRoomId] = useState(initialRoomId || 'design-review');
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState(profile.color);
  const [rooms, setRooms] = useState<RoomSummaryDTO[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);

  const fetchRooms = useCallback(async () => {
    setLoadingRooms(true);
    try {
      const resp = await fetch('/api/rooms');
      if (resp.ok) {
        const data = (await resp.json()) as { rooms: RoomSummaryDTO[] };
        setRooms(data.rooms ?? []);
      }
    } catch {
      // backend may still be starting
    } finally {
      setLoadingRooms(false);
    }
  }, []);

  useEffect(() => {
    void fetchRooms();
    const timer = setInterval(() => void fetchRooms(), 5000);
    return () => clearInterval(timer);
  }, [fetchRooms]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanRoom = roomId.trim().replace(/\s+/g, '-') || 'design-review';
    const cleanName = name.trim() || '协作者';
    onJoinRoom(cleanRoom, {
      clientId: profile.clientId,
      name: cleanName,
      color,
    });
  };

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-gradient-to-br from-slate-50 via-indigo-50/40 to-slate-100 flex flex-col justify-between p-6 md:p-10">
      {/* Top Brand Header */}
      <header className="max-w-6xl w-full mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-600/20">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900">
              SyncCanvas 实时协同白板
            </h1>
            <p className="text-xs text-slate-500">
              Fabric.js v6 三层渲染引擎 · Socket.io 双通道广播 · 属性级 LWW-CRDT 冲突收敛
            </p>
          </div>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-white border border-slate-200 text-slate-600 shadow-xs">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          WebSocket & SQLite WAL 引擎就绪
        </span>
      </header>

      {/* Main Split Grid */}
      <main className="max-w-6xl w-full mx-auto my-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Room Entry Form Card */}
        <section className="lg:col-span-7 bg-white rounded-2xl border border-slate-200/90 shadow-xl shadow-slate-200/50 p-7 md:p-8">
          <div className="mb-6">
            <span className="inline-block px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-700 text-xs font-semibold mb-2">
              房间大厅 · Room Lobby
            </span>
            <h2 className="text-2xl font-bold text-slate-900">加入或创建协同画布房间</h2>
            <p className="text-sm text-slate-500 mt-1">
              输入相同房间号即可多人毫秒级同步笔迹、查看实时命名光标，支持断线离线绘制后自动合并。
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Room ID */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-semibold text-slate-700">
                  房间号 (Room ID)
                </label>
                <button
                  type="button"
                  onClick={() => setRoomId(generateRandomRoomCode())}
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 cursor-pointer"
                >
                  <Shuffle className="w-3.5 h-3.5" />
                  随机生成房间号
                </button>
              </div>
              <input
                data-testid="lobby-room-input"
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="例如: design-review"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-300 bg-slate-50/50 text-slate-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                required
              />
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="text-xs text-slate-400">快捷房间：</span>
                {PRESET_ROOMS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setRoomId(preset)}
                    className={`px-2.5 py-0.5 rounded-md text-xs font-mono border transition cursor-pointer ${
                      roomId === preset
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-semibold'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    #{preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Nickname */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                你的协同昵称（显示在远程光标旁）
              </label>
              <input
                data-testid="lobby-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={24}
                placeholder="输入昵称，例如: Alice / 架构师小王"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-300 bg-slate-50/50 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                required
              />
            </div>

            {/* Cursor Color Swatches */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                专属光标与身份配色
              </label>
              <div className="flex flex-wrap items-center gap-2.5">
                {COLLABORATOR_COLORS.map((swatch) => {
                  const active = color === swatch;
                  return (
                    <button
                      key={swatch}
                      type="button"
                      onClick={() => setColor(swatch)}
                      style={{ backgroundColor: swatch }}
                      className={`w-8 h-8 rounded-full transition-transform cursor-pointer ${
                        active
                          ? 'ring-3 ring-offset-2 ring-slate-900 scale-110'
                          : 'opacity-80 hover:opacity-100 hover:scale-105'
                      }`}
                      title={swatch}
                    />
                  );
                })}
              </div>
            </div>

            <button
              data-testid="lobby-join-btn"
              type="submit"
              className="w-full py-3 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-sm shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2 transition cursor-pointer"
            >
              进入协同白板工作区
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </section>

        {/* Right: Active & Persisted Rooms Directory */}
        <section className="lg:col-span-5 bg-white/90 backdrop-blur rounded-2xl border border-slate-200/90 shadow-lg shadow-slate-200/40 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Database className="w-4 h-4 text-indigo-600" />
                活跃与已落盘快照房间
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                点击任意房间可直接进入并从 SQLite 恢复矢量画布
              </p>
            </div>
            <button
              type="button"
              onClick={() => void fetchRooms()}
              className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition cursor-pointer"
              title="刷新房间列表"
            >
              <RefreshCw className={`w-4 h-4 ${loadingRooms ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {rooms.length === 0 ? (
            <div className="py-12 px-4 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/60">
              <p className="text-sm font-medium text-slate-600">暂无历史房间记录</p>
              <p className="text-xs text-slate-400 mt-1">
                在左侧输入任意房间号进入绘制，系统将自动打快照持久化至 SQLite
              </p>
            </div>
          ) : (
            <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
              {rooms.map((r) => (
                <button
                  key={r.roomId}
                  type="button"
                  onClick={() =>
                    onJoinRoom(r.roomId, {
                      clientId: profile.clientId,
                      name: name.trim() || '协作者',
                      color,
                    })
                  }
                  className="w-full text-left p-3.5 rounded-xl border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/30 transition group flex items-center justify-between cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-sm text-slate-900 truncate group-hover:text-indigo-700">
                        #{r.roomId}
                      </span>
                      {r.onlineCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <Users className="w-3 h-3" />
                          {r.onlineCount} 在线
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                      <span>{r.elementCount} 个矢量图元</span>
                      <span>·</span>
                      <span>Seq #{r.latestSeq}</span>
                      <span>·</span>
                      <span>快照: {formatRelativeTime(r.lastSnapshotAt)}</span>
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 group-hover:translate-x-0.5 transition shrink-0" />
                </button>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Bottom Engineering Architecture Strip */}
      <footer className="max-w-6xl w-full mx-auto grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
        <div className="bg-white/80 rounded-xl border border-slate-200/80 p-4 flex items-start gap-3">
          <Layers className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-bold text-slate-800">Fabric.js v6 三层视口同步渲染</div>
            <p className="text-xs text-slate-500 mt-0.5">
              主矢量场景与 60fps 远程画笔/光标瞬态 Canvas 物理隔离，拖拽缩放零重绘卡顿。
            </p>
          </div>
        </div>
        <div className="bg-white/80 rounded-xl border border-slate-200/80 p-4 flex items-start gap-3">
          <Wifi className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-bold text-slate-800">WebSocket 双通道与 RTT 心跳保活</div>
            <p className="text-xs text-slate-500 mt-0.5">
              高频光标/笔迹采用免 I/O 房间快转，状态变更走幂等 ACK 通道与 2s 周期延迟监控。
            </p>
          </div>
        </div>
        <div className="bg-white/80 rounded-xl border border-slate-200/80 p-4 flex items-start gap-3">
          <GitMerge className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-bold text-slate-800">自研属性级 LWW-CRDT 与快照恢复</div>
            <p className="text-xs text-slate-500 mt-0.5">
              Lamport 时钟 + 属性寄存器正交合并，支持一键模拟断网绘制与 SQLite 落盘恢复。
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};
