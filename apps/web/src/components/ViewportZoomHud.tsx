import { Maximize2, Minus, Plus } from 'lucide-react';
import React from 'react';

interface ViewportZoomHudProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFitContent: () => void;
}

export const ViewportZoomHud: React.FC<ViewportZoomHudProps> = ({
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFitContent,
}) => {
  const pct = Math.round(zoom * 100);

  return (
    <div className="absolute left-4 bottom-4 z-20 flex items-center gap-2">
      <div className="bg-white/95 backdrop-blur rounded-xl border border-slate-200/90 shadow-md p-1 flex items-center gap-0.5">
        <button
          data-testid="zoom-out-btn"
          type="button"
          onClick={onZoomOut}
          className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition cursor-pointer"
          title="缩小视口"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>

        <button
          data-testid="zoom-reset-btn"
          type="button"
          onClick={onResetZoom}
          className="px-2 py-1 rounded-lg text-xs font-mono font-semibold text-slate-700 hover:bg-slate-100 transition cursor-pointer min-w-13 text-center"
          title="点击重置 100% 视口"
        >
          {pct}%
        </button>

        <button
          data-testid="zoom-in-btn"
          type="button"
          onClick={onZoomIn}
          className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition cursor-pointer"
          title="放大视口"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>

        <div className="h-4 w-px bg-slate-200 mx-0.5" />

        <button
          data-testid="zoom-fit-btn"
          type="button"
          onClick={onFitContent}
          className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition cursor-pointer"
          title="适应全部画布内容"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <span className="hidden xl:inline-block px-2.5 py-1.5 rounded-lg bg-white/80 backdrop-blur border border-slate-200/70 text-[11px] text-slate-500">
        滚轮缩放 · 按住空格拖拽平移
      </span>
    </div>
  );
};
