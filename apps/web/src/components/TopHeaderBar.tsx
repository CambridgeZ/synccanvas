import type { CollaboratorPresence } from '@whiteboard/shared';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  LogOut,
  Redo2,
  Trash2,
  Undo2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import React, { useState } from 'react';
import type { ConnectionStatus } from '../sync/CollaborationClient';

interface TopHeaderBarProps {
  roomId: string;
  status: ConnectionStatus;
  rttMs: number | null;
  pendingOutboxCount: number;
  members: CollaboratorPresence[];
  localClientId: string;
  canUndo: boolean;
  canRedo: boolean;
  hasElements: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClearAll: () => void;
  onExportPng: () => void;
  onLeaveRoom: () => void;
}

export const TopHeaderBar: React.FC<TopHeaderBarProps> = ({
  roomId,
  status,
  rttMs,
  pendingOutboxCount,
  members,
  localClientId,
  canUndo,
  canRedo,
  hasElements,
  onUndo,
  onRedo,
  onClearAll,
  onExportPng,
  onLeaveRoom,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyInvite = async () => {
    const url = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleOpenPeerWindow = () => {
    const peerUrl = `${window.location.origin}/?room=${encodeURIComponent(roomId)}&peer=${Date.now().toString(36).slice(-4)}`;
    window.open(peerUrl, '_blank', 'noopener,noreferrer');
  };

  const renderStatusBadge = () => {
    if (status === 'simulated_offline') {
      return (
        <div
          data-testid="connection-status-pill"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-300"
        >
          <WifiOff className="w-3.5 h-3.5 text-amber-600" />
          <span>模拟断网中</span>
          {pendingOutboxCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-amber-600 text-white text-[11px]">
              待同步 {pendingOutboxCount}
            </span>
          )}
        </div>
      );
    }

    if (status === 'online') {
      return (
        <div
          data-testid="connection-status-pill"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-800 border border-emerald-200"
        >
          <Wifi className="w-3.5 h-3.5 text-emerald-600" />
          <span>实时同步</span>
          {rttMs !== null && <span className="font-mono text-emerald-700">· {rttMs}ms</span>}
        </div>
      );
    }

    return (
      <div
        data-testid="connection-status-pill"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200"
      >
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
        <span>重连合并中...</span>
      </div>
    );
  };

  return (
    <header className="h-14 w-full bg-white/95 backdrop-blur border-b border-slate-200 px-4 flex items-center justify-between z-30 shrink-0">
      {/* Left: Back to Lobby + Room Badge + Quick Multi-Tab Launcher */}
      <div className="flex items-center gap-2.5 min-w-0">
        <button
          data-testid="back-to-lobby-btn"
          type="button"
          onClick={onLeaveRoom}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition cursor-pointer"
          title="返回房间大厅"
        >
          <LogOut className="w-3.5 h-3.5 rotate-180" />
          <span className="hidden sm:inline">大厅</span>
        </button>

        <div className="h-4 w-px bg-slate-200" />

        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200/80">
          <span className="text-xs text-slate-400 font-mono">#</span>
          <span
            data-testid="active-room-id"
            className="text-xs font-mono font-semibold text-slate-800 max-w-40 truncate"
          >
            {roomId}
          </span>
          <button
            type="button"
            onClick={() => void handleCopyInvite()}
            className="ml-1 text-slate-400 hover:text-indigo-600 transition cursor-pointer"
            title="复制房间邀请链接"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        <button
          data-testid="open-peer-tab-btn"
          type="button"
          onClick={handleOpenPeerWindow}
          className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200/80 transition cursor-pointer"
          title="在新标签页以新身份进入当前房间，快速测试多人实时协同"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          新开协同窗口
        </button>

        {renderStatusBadge()}
      </div>

      {/* Right: Undo / Redo / Clear / Export + Avatar Stack */}
      <div className="flex items-center gap-2">
        <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200/80">
          <button
            data-testid="undo-btn"
            type="button"
            disabled={!canUndo}
            onClick={onUndo}
            className="p-1.5 rounded-md text-slate-700 hover:bg-white hover:shadow-xs disabled:opacity-35 disabled:hover:bg-transparent transition cursor-pointer disabled:cursor-not-allowed"
            title="撤销本人操作 (Cmd/Ctrl + Z)"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            data-testid="redo-btn"
            type="button"
            disabled={!canRedo}
            onClick={onRedo}
            className="p-1.5 rounded-md text-slate-700 hover:bg-white hover:shadow-xs disabled:opacity-35 disabled:hover:bg-transparent transition cursor-pointer disabled:cursor-not-allowed"
            title="重做本人操作 (Cmd/Ctrl + Shift + Z)"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>

        <button
          data-testid="clear-canvas-btn"
          type="button"
          disabled={!hasElements}
          onClick={onClearAll}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-35 transition cursor-pointer disabled:cursor-not-allowed"
          title="清空画布（支持一键撤销恢复）"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">清空</span>
        </button>

        <button
          data-testid="export-png-btn"
          type="button"
          onClick={onExportPng}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white shadow-xs transition cursor-pointer"
          title="导出 2x 高清 PNG 图片"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">导出 PNG</span>
        </button>

        {/* Compact Online Avatar Stack */}
        <div className="hidden sm:flex items-center -space-x-1.5 ml-1 pl-2 border-l border-slate-200">
          {members.slice(0, 5).map((m) => (
            <div
              key={m.clientId}
              style={{ backgroundColor: m.color }}
              className="w-7 h-7 rounded-full ring-2 ring-white text-white text-[11px] font-bold flex items-center justify-center shadow-xs"
              title={`${m.name}${m.clientId === localClientId ? ' (我)' : ''}`}
            >
              {m.name.slice(0, 1).toUpperCase()}
            </div>
          ))}
          {members.length > 5 && (
            <div className="w-7 h-7 rounded-full ring-2 ring-white bg-slate-700 text-white text-[10px] font-semibold flex items-center justify-center">
              +{members.length - 5}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
