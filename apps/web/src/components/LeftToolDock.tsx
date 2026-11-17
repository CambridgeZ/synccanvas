import type {
  LayerOrderAction,
  MaterializedElement,
  ToolType,
} from '@whiteboard/shared';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpRight,
  ArrowUpToLine,
  Circle,
  Eraser,
  Hand,
  Minus,
  MousePointer2,
  Palette,
  Pencil,
  Square,
  Trash2,
  Type,
} from 'lucide-react';
import React, { useState } from 'react';
import type { DrawingStyleState } from '../engine/WhiteboardEngine';

const STROKE_SWATCHES = [
  '#1e293b', // Slate 800
  '#ef4444', // Red
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#a855f7', // Purple
  '#ec4899', // Pink
];

const FILL_SWATCHES = [
  'transparent',
  '#fee2e2',
  '#fef3c7',
  '#d1fae5',
  '#dbeafe',
  '#e0e7ff',
  '#f3e8ff',
  '#10b981',
  '#3b82f6',
  '#ef4444',
];

const WIDTH_PRESETS = [2, 4, 7, 12];
const FONT_SIZE_PRESETS = [16, 22, 30, 42];

interface ToolItem {
  id: ToolType;
  label: string;
  shortcut: string;
  icon: React.FC<{ className?: string }>;
}

const TOOLS: ToolItem[] = [
  { id: 'select', label: '选择与变换', shortcut: 'V', icon: MousePointer2 },
  { id: 'hand', label: '抓手平移画布', shortcut: 'H', icon: Hand },
  { id: 'pencil', label: '自由画笔', shortcut: 'P', icon: Pencil },
  { id: 'rect', label: '矩形', shortcut: 'R', icon: Square },
  { id: 'ellipse', label: '圆形 / 椭圆', shortcut: 'O', icon: Circle },
  { id: 'line', label: '直线', shortcut: 'L', icon: Minus },
  { id: 'arrow', label: '单向箭头', shortcut: 'A', icon: ArrowUpRight },
  { id: 'text', label: '文字批注', shortcut: 'T', icon: Type },
  { id: 'eraser', label: '橡皮擦删除', shortcut: 'E', icon: Eraser },
];

interface LeftToolDockProps {
  activeTool: ToolType;
  style: DrawingStyleState;
  selectedElements: MaterializedElement[];
  onSelectTool: (tool: ToolType) => void;
  onChangeStyle: (patch: Partial<DrawingStyleState>) => void;
  onReorderLayer: (elementId: string, action: LayerOrderAction) => void;
  onDeleteSelected: () => void;
}

export const LeftToolDock: React.FC<LeftToolDockProps> = ({
  activeTool,
  style,
  selectedElements,
  onSelectTool,
  onChangeStyle,
  onReorderLayer,
  onDeleteSelected,
}) => {
  const [stylePanelOpen, setStylePanelOpen] = useState(true);

  const primarySelected = selectedElements[0] ?? null;
  const displayStroke = primarySelected ? primarySelected.stroke : style.stroke;
  const displayFill = primarySelected ? primarySelected.fill : style.fill;
  const displayWidth = primarySelected ? primarySelected.strokeWidth : style.strokeWidth;
  const displayFontSize =
    primarySelected?.fontSize ?? style.fontSize ?? 22;
  const showFontSizeControls =
    activeTool === 'text' || selectedElements.some((el) => el.type === 'text');

  return (
    <aside
      aria-label="左侧画笔工具栏"
      className="absolute left-4 top-4 z-20 flex items-start gap-3 pointer-events-none"
    >
      {/* Primary Vertical Tool Dock */}
      <div className="pointer-events-auto bg-white/95 backdrop-blur rounded-2xl border border-slate-200/90 shadow-lg shadow-slate-900/5 p-1.5 flex flex-col gap-1">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const isActive = activeTool === tool.id;
          return (
            <button
              key={tool.id}
              data-testid={`tool-${tool.id}`}
              type="button"
              onClick={() => onSelectTool(tool.id)}
              className={`relative w-10 h-10 rounded-xl flex items-center justify-center transition cursor-pointer group ${
                isActive
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
              title={`${tool.label} (${tool.shortcut})`}
            >
              <Icon className="w-4.5 h-4.5" />
              <span
                className={`absolute bottom-0.5 right-1 text-[9px] font-mono ${
                  isActive ? 'text-indigo-200' : 'text-slate-400'
                }`}
              >
                {tool.shortcut}
              </span>
            </button>
          );
        })}

        <div className="h-px bg-slate-200 my-0.5 mx-1" />

        <button
          data-testid="toggle-style-popover-btn"
          type="button"
          onClick={() => setStylePanelOpen((v) => !v)}
          className={`w-10 h-10 rounded-xl flex items-center justify-center transition cursor-pointer ${
            stylePanelOpen
              ? 'bg-slate-100 text-indigo-600'
              : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
          }`}
          title="展开/收起画笔颜色与图层属性面板"
        >
          <Palette className="w-4.5 h-4.5" />
        </button>
      </div>

      {/* Companion Style & Selection Inspector Card */}
      {stylePanelOpen && (
        <div className="pointer-events-auto w-56 bg-white/95 backdrop-blur rounded-2xl border border-slate-200/90 shadow-lg shadow-slate-900/5 p-3.5 space-y-3.5">
          {/* Stroke Color */}
          <div>
            <div className="text-[11px] font-semibold text-slate-500 mb-1.5 flex items-center justify-between">
              <span>描边 / 画笔颜色</span>
              <span className="font-mono text-[10px] text-slate-400">{displayStroke}</span>
            </div>
            <div className="grid grid-cols-8 gap-1.5">
              {STROKE_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  data-testid={`stroke-color-${hex}`}
                  type="button"
                  onClick={() => onChangeStyle({ stroke: hex })}
                  style={{ backgroundColor: hex }}
                  className={`w-5 h-5 rounded-full cursor-pointer transition-transform ${
                    displayStroke === hex
                      ? 'ring-2 ring-offset-1 ring-indigo-600 scale-110'
                      : 'hover:scale-110'
                  }`}
                  title={`描边颜色 ${hex}`}
                />
              ))}
            </div>
          </div>

          {/* Fill Color */}
          <div>
            <div className="text-[11px] font-semibold text-slate-500 mb-1.5 flex items-center justify-between">
              <span>图形填充色</span>
              <span className="font-mono text-[10px] text-slate-400">
                {displayFill === 'transparent' ? '无填充' : displayFill}
              </span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {FILL_SWATCHES.map((hex) => {
                const isTransparent = hex === 'transparent';
                const active = displayFill === hex;
                return (
                  <button
                    key={hex}
                    data-testid={`fill-color-${hex}`}
                    type="button"
                    onClick={() => onChangeStyle({ fill: hex })}
                    style={isTransparent ? undefined : { backgroundColor: hex }}
                    className={`h-6 rounded-md border cursor-pointer transition flex items-center justify-center text-[10px] ${
                      isTransparent
                        ? 'bg-slate-50 border-slate-300 text-slate-400'
                        : 'border-slate-200'
                    } ${active ? 'ring-2 ring-indigo-600 ring-offset-1' : 'hover:opacity-90'}`}
                    title={isTransparent ? '透明无填充' : `填充 ${hex}`}
                  >
                    {isTransparent ? '∅' : ''}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Stroke Width */}
          <div>
            <div className="text-[11px] font-semibold text-slate-500 mb-1.5">
              线条粗细 ({displayWidth}px)
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {WIDTH_PRESETS.map((w) => (
                <button
                  key={w}
                  data-testid={`stroke-width-${w}`}
                  type="button"
                  onClick={() => onChangeStyle({ strokeWidth: w })}
                  className={`h-7 rounded-lg border text-xs font-medium flex items-center justify-center cursor-pointer transition ${
                    displayWidth === w
                      ? 'bg-indigo-50 border-indigo-400 text-indigo-700 font-semibold'
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {w}px
                </button>
              ))}
            </div>
          </div>

          {/* Font Size (when Text tool active or Text element selected) */}
          {showFontSizeControls && (
            <div>
              <div className="text-[11px] font-semibold text-slate-500 mb-1.5">
                文字字号 ({displayFontSize}px)
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {FONT_SIZE_PRESETS.map((sz) => (
                  <button
                    key={sz}
                    data-testid={`font-size-${sz}`}
                    type="button"
                    onClick={() => onChangeStyle({ fontSize: sz })}
                    className={`h-7 rounded-lg border text-xs font-medium flex items-center justify-center cursor-pointer transition ${
                      displayFontSize === sz
                        ? 'bg-indigo-50 border-indigo-400 text-indigo-700 font-semibold'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {sz}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Selected Element Quick Actions (Layer Ordering + Delete) */}
          {selectedElements.length > 0 && (
            <div className="pt-2.5 border-t border-slate-200 space-y-2">
              <div className="text-[11px] font-semibold text-indigo-700 flex items-center justify-between">
                <span>已选中 {selectedElements.length} 个图元</span>
              </div>

              {selectedElements.length === 1 && primarySelected && (
                <div className="grid grid-cols-4 gap-1">
                  <button
                    data-testid="selection-layer-front"
                    type="button"
                    onClick={() => onReorderLayer(primarySelected.id, 'front')}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center cursor-pointer"
                    title="置顶图层"
                  >
                    <ArrowUpToLine className="w-3.5 h-3.5" />
                  </button>
                  <button
                    data-testid="selection-layer-forward"
                    type="button"
                    onClick={() => onReorderLayer(primarySelected.id, 'forward')}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center cursor-pointer"
                    title="上移一层"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    data-testid="selection-layer-backward"
                    type="button"
                    onClick={() => onReorderLayer(primarySelected.id, 'backward')}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center cursor-pointer"
                    title="下移一层"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    data-testid="selection-layer-back"
                    type="button"
                    onClick={() => onReorderLayer(primarySelected.id, 'back')}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center cursor-pointer"
                    title="置底图层"
                  >
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <button
                data-testid="delete-selected-btn"
                type="button"
                onClick={onDeleteSelected}
                className="w-full py-1.5 px-2.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                删除选中图元 (Del)
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
};
