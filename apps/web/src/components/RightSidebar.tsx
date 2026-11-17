import type {
  CollaboratorPresence,
  ElementType,
  LayerOrderAction,
  MaterializedElement,
  ToolType,
} from '@whiteboard/shared';
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Database,
  Layers,
  LocateFixed,
  PanelRightClose,
  PanelRightOpen,
  Trash2,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import React, { useState } from 'react';
import type { DiagnosticsSnapshot } from '../sync/CollaborationClient';

type SidebarTab = 'members' | 'layers' | 'diagnostics';

const TOOL_LABELS: Record<ToolType, string> = {
  select: '选择变换',
  hand: '抓手浏览',
  pencil: '画笔绘制中',
  rect: '绘制矩形',
  ellipse: '绘制圆/椭圆',
  line: '绘制直线',
  arrow: '绘制箭头',
  text: '编辑文字',
  eraser: '橡皮擦除',
};

const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  rect: '矩形',
  ellipse: '圆形/椭圆',
  line: '直线',
  arrow: '单向箭头',
  path: '自由画笔轨迹',
  text: '文字批注',
};

function formatTimeHMS(ts: number | null): string {
  if (!ts) return '尚未落盘';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

interface RightSidebarProps {
  members: CollaboratorPresence[];
  localClientId: string;
  elements: MaterializedElement[];
  selectedIds: Set<string>;
  lamportClock: number;
  diagnostics: DiagnosticsSnapshot;
  onSelectElement: (elementId: string) => void;
  onReorderLayer: (elementId: string, action: LayerOrderAction) => void;
  onDeleteElement: (elementId: string) => void;
  onJumpToMemberCursor: (x: number, y: number) => void;
  onToggleSimulatedOffline: (offline: boolean) => void;
  onTriggerManualSnapshot: () => void;
}

export const RightSidebar: React.FC<RightSidebarProps> = ({
  members,
  localClientId,
  elements,
  selectedIds,
  lamportClock,
  diagnostics,
  onSelectElement,
  onReorderLayer,
  onDeleteElement,
  onJumpToMemberCursor,
  onToggleSimulatedOffline,
  onTriggerManualSnapshot,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>('members');

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="absolute right-4 top-4 z-20 p-2.5 rounded-xl bg-white/95 backdrop-blur border border-slate-200 shadow-md text-slate-700 hover:text-indigo-600 cursor-pointer transition"
        title="展开右侧协作与图层边栏"
      >
        <PanelRightOpen className="w-4.5 h-4.5" />
      </button>
    );
  }

  // Display top-most layer first in Layer panel
  const topDownElements = [...elements].reverse();

  return (
    <aside
      aria-label="右侧协作面板"
      className="w-80 h-full bg-white border-l border-slate-200 flex flex-col z-20 shrink-0"
    >
      {/* Tab Bar Header */}
      <div className="h-12 px-2 border-b border-slate-200 flex items-center justify-between gap-1 shrink-0">
        <div className="flex items-center gap-1 flex-1">
          <button
            data-testid="tab-members"
            type="button"
            onClick={() => setActiveTab('members')}
            className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
              activeTab === 'members'
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>成员</span>
            <span
              data-testid="online-member-count"
              className="px-1.5 py-0.2 rounded-full bg-indigo-100 text-indigo-700 text-[10px]"
            >
              {members.length}
            </span>
          </button>

          <button
            data-testid="tab-layers"
            type="button"
            onClick={() => setActiveTab('layers')}
            className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
              activeTab === 'layers'
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>图层</span>
            <span
              data-testid="layer-count"
              className="px-1.5 py-0.2 rounded-full bg-slate-200/80 text-slate-700 text-[10px]"
            >
              {elements.length}
            </span>
          </button>

          <button
            data-testid="tab-diagnostics"
            type="button"
            onClick={() => setActiveTab('diagnostics')}
            className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition cursor-pointer ${
              activeTab === 'diagnostics'
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>诊断</span>
            {diagnostics.simulatedOffline && (
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          title="收起边栏"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-3.5">
        {/* TAB 1: ONLINE COLLABORATORS */}
        {activeTab === 'members' && (
          <div className="space-y-2.5">
            <div className="text-xs text-slate-500 flex items-center justify-between px-0.5">
              <span>房间在线协作者</span>
              <span className="text-[11px] text-emerald-600 font-medium">实时光标已开启</span>
            </div>

            {members.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                正在同步房间成员列表...
              </div>
            ) : (
              members.map((m) => {
                const isSelf = m.clientId === localClientId;
                return (
                  <div
                    key={m.clientId}
                    data-testid={`member-card-${m.clientId}`}
                    className={`p-3 rounded-xl border transition flex items-center justify-between gap-2 ${
                      isSelf
                        ? 'bg-indigo-50/40 border-indigo-200'
                        : 'bg-slate-50/70 border-slate-200/80 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div
                        style={{ backgroundColor: m.color }}
                        className="w-8 h-8 rounded-full text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-xs"
                      >
                        {m.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-slate-900 truncate">
                            {m.name}
                          </span>
                          {isSelf && (
                            <span className="px-1.5 py-0.2 rounded bg-indigo-600 text-white text-[10px] font-semibold">
                              我
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                          <span>{TOOL_LABELS[m.activeTool] ?? m.activeTool}</span>
                          {m.cursor && (
                            <span className="font-mono text-[10px] text-slate-400">
                              ({Math.round(m.cursor.x)}, {Math.round(m.cursor.y)})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {!isSelf && m.cursor && (
                      <button
                        type="button"
                        onClick={() => onJumpToMemberCursor(m.cursor!.x, m.cursor!.y)}
                        className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition cursor-pointer shrink-0"
                        title="跳转至该成员当前光标位置"
                      >
                        <LocateFixed className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* TAB 2: MULTI-LAYER STACK */}
        {activeTab === 'layers' && (
          <div className="space-y-2">
            <div className="text-xs text-slate-500 flex items-center justify-between px-0.5">
              <span>画布矢量图层栈（上方为顶层）</span>
              <span className="font-mono text-[11px] text-slate-400">Fractional zIndex</span>
            </div>

            {topDownElements.length === 0 ? (
              <div className="py-10 px-4 text-center border border-dashed border-slate-200 rounded-xl text-xs text-slate-400">
                画布暂无图形，使用左侧工具栏绘制自由曲线、矩形、圆形、箭头或文字。
              </div>
            ) : (
              topDownElements.map((el) => {
                const isSelected = selectedIds.has(el.id);
                const label =
                  el.type === 'text' && el.text
                    ? `文字: "${el.text.slice(0, 10)}"`
                    : ELEMENT_TYPE_LABELS[el.type];

                return (
                  <div
                    key={el.id}
                    data-testid={`layer-item-${el.id}`}
                    onClick={() => onSelectElement(el.id)}
                    className={`p-2.5 rounded-xl border transition flex items-center justify-between gap-2 cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-50/70 border-indigo-400 shadow-xs'
                        : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        style={{
                          backgroundColor:
                            el.fill && el.fill !== 'transparent' ? el.fill : el.stroke,
                        }}
                        className="w-3 h-3 rounded-xs border border-slate-300 shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-slate-800 truncate">{label}</div>
                        <div className="text-[10px] font-mono text-slate-400">
                          z:{Number(el.zIndex.toFixed(2))} · #{el.id.slice(-5)}
                        </div>
                      </div>
                    </div>

                    <div
                      className="flex items-center gap-0.5 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => onReorderLayer(el.id, 'front')}
                        className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-slate-800 cursor-pointer"
                        title="置顶"
                      >
                        <ArrowUpToLine className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onReorderLayer(el.id, 'forward')}
                        className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-slate-800 cursor-pointer"
                        title="上移一层"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onReorderLayer(el.id, 'backward')}
                        className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-slate-800 cursor-pointer"
                        title="下移一层"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onReorderLayer(el.id, 'back')}
                        className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-slate-800 cursor-pointer"
                        title="置底"
                      >
                        <ArrowDownToLine className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteElement(el.id)}
                        className="p-1 rounded hover:bg-rose-100 text-slate-400 hover:text-rose-600 cursor-pointer"
                        title="删除图层"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* TAB 3: CRDT DIAGNOSTICS & OFFLINE SIMULATION LAB */}
        {activeTab === 'diagnostics' && (
          <div className="space-y-4">
            {/* Offline Simulation Sandbox Card */}
            <div
              className={`p-3.5 rounded-xl border transition ${
                diagnostics.simulatedOffline
                  ? 'bg-amber-50 border-amber-300'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                  {diagnostics.simulatedOffline ? (
                    <WifiOff className="w-4 h-4 text-amber-600" />
                  ) : (
                    <Wifi className="w-4 h-4 text-emerald-600" />
                  )}
                  断线重连与冲突合并实验室
                </span>
                <span
                  data-testid="outbox-count"
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                    diagnostics.pendingOutboxCount > 0
                      ? 'bg-amber-600 text-white'
                      : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  Outbox: {diagnostics.pendingOutboxCount}
                </span>
              </div>
              <p className="text-[11px] text-slate-600 leading-relaxed mb-3">
                {diagnostics.simulatedOffline
                  ? '当前处于模拟离线态：你的绘制与拖拽均缓存在本地 Outbox 中，点击下方恢复联网即可与服务端最新状态执行属性级 CRDT 无损合并。'
                  : '点击模拟断网可在本地离线作画或拖动图形，同时在另一窗口修改同一图形颜色，再恢复联网验证自动合并。'}
              </p>

              <button
                data-testid="toggle-offline-btn"
                type="button"
                onClick={() => onToggleSimulatedOffline(!diagnostics.simulatedOffline)}
                className={`w-full py-2 px-3 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  diagnostics.simulatedOffline
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                    : 'bg-amber-500 hover:bg-amber-600 text-white shadow-xs'
                }`}
              >
                {diagnostics.simulatedOffline
                  ? '恢复联网并合并离线状态 (Reconnect & Merge)'
                  : '模拟本地断网离线编辑 (Simulate Offline)'}
              </button>
            </div>

            {/* Live Metrics Grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[10px] text-slate-500">WebSocket 心跳 RTT</div>
                <div className="text-sm font-mono font-bold text-slate-900 mt-0.5">
                  {diagnostics.rttMs !== null ? `${diagnostics.rttMs} ms` : '离线'}
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[10px] text-slate-500">Lamport 逻辑时钟</div>
                <div
                  data-testid="lamport-clock"
                  className="text-sm font-mono font-bold text-indigo-700 mt-0.5"
                >
                  L = {lamportClock}
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[10px] text-slate-500">服务端权威 Seq</div>
                <div className="text-sm font-mono font-bold text-slate-900 mt-0.5">
                  #{diagnostics.serverSeq}
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
                <div className="text-[10px] text-slate-500">高频包速率 (TX/RX)</div>
                <div className="text-sm font-mono font-bold text-slate-900 mt-0.5">
                  {diagnostics.txPerSec}↑ / {diagnostics.rxPerSec}↓ /s
                </div>
              </div>
            </div>

            {/* SQLite Snapshot Persistence Card */}
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-indigo-600" />
                  SQLite WAL 快照持久化
                </span>
                <span
                  data-testid="last-snapshot-time"
                  className="text-[11px] font-mono text-slate-500"
                >
                  {formatTimeHMS(diagnostics.lastSnapshotAt)}
                </span>
              </div>
              <button
                data-testid="manual-snapshot-btn"
                type="button"
                disabled={diagnostics.simulatedOffline}
                onClick={onTriggerManualSnapshot}
                className="w-full py-1.5 px-3 rounded-lg bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-semibold disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition"
              >
                立即打快照落盘至 SQLite
              </button>
            </div>

            {/* Recent CRDT Operation Stream */}
            <div>
              <div className="text-[11px] font-semibold text-slate-500 mb-1.5">
                实时 CRDT 寄存器变更日志 (最新 {diagnostics.recentLogs.length} 条)
              </div>
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
                {diagnostics.recentLogs.length === 0 ? (
                  <div className="text-[11px] text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-lg">
                    在画布绘制或移动图形以观察 LWW-CRDT 操作流
                  </div>
                ) : (
                  diagnostics.recentLogs.map((log) => (
                    <div
                      key={log.id}
                      className="p-2 rounded-lg bg-slate-900 text-slate-100 font-mono text-[10px] leading-snug"
                    >
                      <div className="flex items-center justify-between text-[9.5px] text-slate-400">
                        <span
                          className={
                            log.direction === 'LOCAL'
                              ? 'text-indigo-400 font-bold'
                              : 'text-emerald-400 font-bold'
                          }
                        >
                          [{log.direction}] L={log.lamport}
                        </span>
                        <span>#{log.elementId}</span>
                      </div>
                      <div className="text-slate-200 mt-0.5 truncate">{log.summary}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
