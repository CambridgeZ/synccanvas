# SyncCanvas

> **Real-time Multi-user Collaborative Whiteboard** — 基于 **React 19 + Fabric.js v6 + Socket.io + 属性级混合 LWW-CRDT + SQLite WAL** 构建的低延迟多人实时协同白板引擎。

[![License: MIT](https://img.shields.io/badge/License-MIT-4f46e5.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg)](https://www.typescriptlang.org/)
[![Fabric.js](https://img.shields.io/badge/Fabric.js-v6-f59e0b.svg)](http://fabricjs.com/)
[![Socket.io](https://img.shields.io/badge/Socket.io-v4.8-010101.svg)](https://socket.io/)

---

## 核心特性 (Features)

- **毫秒级实时画笔与命名光标同步**：拖拽画笔时以 ~50fps 增量流式广播轨迹点，远端采用二次贝塞尔中点插值 (`quadraticCurveTo`) 平滑渲染绘制过程，并实时呈现恒定屏幕尺寸的彩色命名鼠标指针与队友选区高亮框。
- **丰富的矢量图元与多图层交互**：支持自由画笔、矩形、圆形/椭圆、直线、单向矢量箭头、内联可编辑文字、橡皮擦；支持单选与多选框 (`ActiveSelection`) 的拖拽、放大、缩小、旋转、删除，以及基于分数索引 (`Fractional zIndex`) 的置顶、置底、上移、下移图层管理。
- **无限画布缩放平移与高清导出**：支持以光标为中心的鼠标滚轮无级缩放 (`10%–500%`)、抓手工具或按住 `Space` 键无限平移、自适应双级无限网格，以及 `2x` 高清 Retina PNG 一键导出。
- **自研属性级混合 LWW-CRDT 冲突消解**：前后端同构运行基于 `(lamport, clientId)` 严格全序集的属性级寄存器模型 —— 用户 A 拖拽图形坐标 `(left, top)` 的同时用户 B 修改同一图形颜色 `fill` 或尺寸 `(scaleX, scaleY)` 可**正交无损合并**；内置 Tombstone 墓碑机制与**仅撤销本人操作**的协同 `Undo / Redo`。
- **断线离线编辑与重连自动合并**：内置 `OfflineOutbox`（内存 + `sessionStorage` 双写）与可视化**「断线重连与冲突合并实验室」**面板，支持一键模拟本地断网离线作画、恢复联网后与服务端状态自动无损收敛。
- **SQLite WAL 快照压缩与增量恢复**：基于 Node.js 原生内置 `node:sqlite`（零 C++ 编译依赖），支持脏操作水位（100 ops）、后台定时巡检（15s）、手动一键触发与进程优雅退出（`SIGINT`/`SIGTERM`）四重快照落盘及滑动窗口日志截断。

---

## 系统架构 (Architecture)

```text
+-----------------------------------------------------------------------------------+
|                        Browser Client (apps/web : 5173)                           |
|                                                                                   |
|  +-----------------------+     +-----------------------------------------------+  |
|  | Studio Workspace UI   |     | Three-Layer Viewport-Synced Canvas Stack      |  |
|  | - Room Lobby          |     | [Layer 2] Ephemeral 2D Canvas Overlay (z-20)  |  |
|  | - Left Tool & Style   |     |   -> 60fps Remote Cursors + Live Brush Stroke |  |
|  | - Right Members /     |     | [Layer 1] Fabric.js v6 Interactive Canvas     |  |
|  |   Layers / CRDT Lab   |     |   -> Durable Vector Shapes + ActiveSelection  |  |
|  +-----------+-----------+     | [Layer 0] Adaptive Infinite Grid Canvas (z-0) |  |
|              |                 +-----------------------+-----------------------+  |
|              v                                         ^ Reconcile / Diff Patch   |
|  +-----------------------------------------------------+-----------------------+  |
|  | FabricCRDTBridge (isApplyingRemote Echo Guard + Active Gesture Prop Locks)  |  |
|  +--------------------+------------------------------------+-------------------+  |
|                       | Local Mutation                     ^ Remote Merge         |
|                       v                                    |                      |
|  +---------------------------------------------------------+-------------------+  |
|  | @whiteboard/shared : CRDTDocument (Property LWW-Map + LamportClock)         |  |
|  | + Collaborative Per-User UndoManager + OfflineOutbox                        |  |
|  +--------------------+------------------------------------+-------------------+  |
+-----------------------|------------------------------------|----------------------+
                        | Durable (sync:join / crdt:ops)     | Ephemeral (cursor/stroke/transform)
                        v                                    v
+-----------------------------------------------------------------------------------+
|                     Collaboration Server (apps/server : 3001)                     |
|                                                                                   |
|  +-----------------------------------+   +-------------------------------------+  |
|  | Socket.io Room Engine             |   | Ephemeral Fast-Relay Router         |  |
|  | - Presence & RTT Heartbeat        |   | - Zero DB I/O room broadcast        |  |
|  | - Offline Outbox Deduplication    |   +-------------------------------------+  |
|  +-----------------+-----------------+                                            |
|                    v                                                              |
|  +-----------------------------------------------------------------------------+  |
|  | Authoritative Room CRDTDocument (RAM) <-> SQLite WAL Snapshot & Op-Log      |  |
|  +-----------------------------------------------------------------------------+  |
```

---

## 快速开始 (Quick Start)

> **环境要求**：Node.js `>= 22.5.0`（使用了 Node 原生内置 `node:sqlite` 模块，无需安装外部数据库或 Docker）与 `npm >= 10`。

```bash
# 1. 克隆仓库并安装依赖
git clone https://github.com/CambridgeZ/synccanvas.git
cd synccanvas
npm install

# 2. 一键同时启动协同后端 (http://localhost:3001) 与前端工作台 (http://localhost:5173)
npm run dev
```

打开浏览器访问 `http://localhost:5173`，输入房间号进入画布后，可点击顶栏 **「新开协同窗口」** 一键弹出第二个独立身份标签页，立即体验多人实时画笔同步、远程光标与断网冲突合并。

### 测试与构建命令

```bash
# 运行 CRDT 收敛性单测、多人局部撤销单测与 SQLite 快照恢复集成测试
npm test

# 全工作区 TypeScript 严格类型检查
npm run typecheck

# 构建生产静态产物
npm run build
```

---

## 快捷键一览 (Keyboard Shortcuts)

| 快捷键 | 功能说明 |
| :--- | :--- |
| `V` | 选择、框选、拖拽、缩放与旋转工具 |
| `H` / 按住 `Space` | 抓手工具 / 临时拖拽平移无限画布 |
| `P` | 自由画笔工具（实时流式同步笔迹） |
| `R` / `O` | 绘制矩形 / 圆形与椭圆 |
| `L` / `A` | 绘制直线 / 单向矢量箭头 |
| `T` | 插入文字批注（双击已有文字可内联编辑） |
| `E` | 橡皮擦工具（点击或划过图形连续擦除） |
| `Delete` / `Backspace` | 删除当前选中的一个或多个图形 |
| `Cmd/Ctrl + Z` | 协同局部撤销（仅回退本人操作，不影响队友成果） |
| `Cmd/Ctrl + Shift + Z` | 协同局部重做 |
| 鼠标滚轮 | 以鼠标指针为中心平滑缩放画布 (`10% – 500%`) |

---

## Monorepo 目录结构

```text
synccanvas/
├── packages/
│   └── shared/          # 前后端共享同构核心：Lamport 时钟、属性级 CRDT、分数索引、局部 Undo、Socket 协议类型
├── apps/
│   ├── server/          # Express + Socket.io 房间广播引擎 + node:sqlite WAL 快照与增量日志存储
│   └── web/             # React 19 + Vite 6 + Tailwind v4 + Fabric.js v6 三层渲染引擎与协同诊断工作台
└── scripts/
    └── dev.mjs          # 前后端并发开发守护进程脚本
```

---

## License

Released under the [MIT License](./LICENSE).
