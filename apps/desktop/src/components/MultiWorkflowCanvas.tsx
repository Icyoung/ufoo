import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsOutSimple,
  CornersOut,
  FlowArrow,
  LinkBreak,
  LockSimple,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  X,
} from "@phosphor-icons/react";
import type {
  MultiPaneFrame,
  WorkflowEdge,
  WorkflowGroupSummary,
  WorkflowNodeGeometry,
  WorkflowPulse,
  WorkflowSnapshot,
  WorkerSummary,
} from "../types";
import { BrandIcon, buildProjectUcodeColorMap } from "./BrandIcon";
import { TranscriptStream } from "./TranscriptStream";

const DEFAULT_NODE_WIDTH = 336;
const DEFAULT_NODE_HEIGHT = 276;
const MIN_NODE_WIDTH = 240;
const MAX_NODE_WIDTH = 840;
const MIN_NODE_HEIGHT = 180;
const MAX_NODE_HEIGHT = 760;
const H_GAP = 104;
const V_GAP = 44;

interface Point {
  x: number;
  y: number;
}

interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type ResizeDirection = "e" | "w" | "s" | "se" | "sw";

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(val)));
}

interface MultiWorkflowCanvasProps {
  workers: WorkerSummary[];
  workerColorMap?: Record<string, string>;
  paneFrames: Record<string, MultiPaneFrame>;
  workflow: WorkflowSnapshot;
  pulses: WorkflowPulse[];
  selectedTargetId: string;
  onSelectWorker: (worker: WorkerSummary) => void;
  onMaximizeWorker: (worker: WorkerSummary) => void;
  onOpenFile: (path: string) => void;
  onClearWorker: (worker: WorkerSummary) => void;
  onConnectEdge: (from: string, to: string) => Promise<void>;
  onDisconnectEdge: (edge: WorkflowEdge) => Promise<void>;
  onDisbandGroup: () => Promise<void>;
  onRenameGroup: (name: string) => Promise<void>;
  onSavePositions: (positions: Record<string, WorkflowNodeGeometry>) => void;
}

function computeTopologicalLayout(
  workers: WorkerSummary[],
  edges: WorkflowEdge[],
  groups: WorkflowGroupSummary[],
  sizeMap: Record<string, { w: number; h: number }> = {}
): Record<string, NodeRect> {
  const sizeOf = (id: string) => ({
    w: sizeMap[id]?.w ?? DEFAULT_NODE_WIDTH,
    h: sizeMap[id]?.h ?? DEFAULT_NODE_HEIGHT,
  });
  const workerIds = workers.map((w) => w.id);
  const idSet = new Set(workerIds);
  const activeEdges = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to);
  const positions: Record<string, NodeRect> = {};

  const placed = new Set<string>();
  let cursorY = 72;

  // 1. Lay out each group in left-to-right DAG columns respecting custom card sizes
  for (const group of groups) {
    const members = group.member_ids.filter((id) => idSet.has(id) && !placed.has(id));
    if (members.length === 0) continue;
    const memberSet = new Set(members);
    const groupEdges = activeEdges.filter((e) => memberSet.has(e.from) && memberSet.has(e.to));

    const indeg = new Map<string, number>(members.map((id) => [id, 0]));
    const adj = new Map<string, string[]>(members.map((id) => [id, []]));
    for (const e of groupEdges) {
      adj.get(e.from)?.push(e.to);
      indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    }

    const layer = new Map<string, number>();
    const queue = members.filter((id) => (indeg.get(id) || 0) === 0);
    if (queue.length === 0) queue.push(members[0]);
    for (const id of queue) layer.set(id, 0);

    const visited = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const curLayer = layer.get(cur) || 0;
      for (const next of adj.get(cur) || []) {
        if (visited.has(next)) continue;
        const proposed = Math.max(layer.get(next) || 0, curLayer + 1);
        layer.set(next, proposed);
        queue.push(next);
      }
    }
    for (const id of members) {
      if (!layer.has(id)) layer.set(id, 0);
    }

    const byCol = new Map<number, string[]>();
    for (const id of members) {
      const col = layer.get(id) || 0;
      if (!byCol.has(col)) byCol.set(col, []);
      byCol.get(col)!.push(id);
    }

    const sortedCols = [...byCol.entries()].sort((a, b) => a[0] - b[0]);
    const colHeights = sortedCols.map(([, colMembers]) =>
      colMembers.reduce((sum, id, idx) => sum + sizeOf(id).h + (idx > 0 ? V_GAP : 0), 0)
    );
    const groupSpanY = Math.max(...colHeights, DEFAULT_NODE_HEIGHT);

    let cursorX = 64;
    sortedCols.forEach(([, colMembers], colIdx) => {
      const colH = colHeights[colIdx];
      let y = cursorY + Math.round((groupSpanY - colH) / 2);
      let maxColW = DEFAULT_NODE_WIDTH;
      for (const id of colMembers) {
        const sz = sizeOf(id);
        maxColW = Math.max(maxColW, sz.w);
        positions[id] = { x: cursorX, y, w: sz.w, h: sz.h };
        placed.add(id);
        y += sz.h + V_GAP;
      }
      cursorX += maxColW + H_GAP;
    });
    cursorY += groupSpanY + 72;
  }

  // 2. Lay out ungrouped standalone workers in balanced 2-column rows (centering any partial final row)
  const loose = workerIds.filter((id) => !placed.has(id));
  const rowCountTotal = Math.ceil(loose.length / 2);
  let maxRowW = 0;
  const rows: string[][] = [];
  for (let r = 0; r < rowCountTotal; r += 1) {
    const rowItems = loose.slice(r * 2, r * 2 + 2);
    rows.push(rowItems);
    const rowW = rowItems.reduce((sum, id, idx) => sum + sizeOf(id).w + (idx > 0 ? H_GAP : 0), 0);
    maxRowW = Math.max(maxRowW, rowW);
  }
  for (const rowItems of rows) {
    const rowW = rowItems.reduce((sum, id, idx) => sum + sizeOf(id).w + (idx > 0 ? H_GAP : 0), 0);
    let x = 64 + Math.round((maxRowW - rowW) / 2);
    let maxRowH = DEFAULT_NODE_HEIGHT;
    for (const id of rowItems) {
      const sz = sizeOf(id);
      maxRowH = Math.max(maxRowH, sz.h);
      positions[id] = { x, y: cursorY, w: sz.w, h: sz.h };
      x += sz.w + H_GAP;
    }
    cursorY += maxRowH + V_GAP;
  }

  return positions;
}

function buildBezierPath(
  from: Point,
  to: Point,
  bowOffset = 0
): { d: string; mid: Point } {
  const dx = Math.abs(to.x - from.x);
  const forward = to.x >= from.x;
  const ctrlDist = forward ? Math.max(68, Math.min(220, dx * 0.45)) : Math.max(120, Math.min(260, dx * 0.35 + 90));
  const c1x = from.x + ctrlDist;
  const c1y = from.y + bowOffset;
  const c2x = to.x - ctrlDist;
  const c2y = to.y + bowOffset;
  const d = `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`;
  // Cubic bezier midpoint at t = 0.5
  const mid = {
    x: 0.125 * from.x + 0.375 * c1x + 0.375 * c2x + 0.125 * to.x,
    y: 0.125 * from.y + 0.375 * c1y + 0.375 * c2y + 0.125 * to.y,
  };
  return { d, mid };
}

export function MultiWorkflowCanvas({
  workers,
  workerColorMap,
  paneFrames,
  workflow,
  pulses,
  selectedTargetId,
  onSelectWorker,
  onMaximizeWorker,
  onOpenFile,
  onClearWorker,
  onConnectEdge,
  onDisconnectEdge,
  onDisbandGroup,
  onRenameGroup,
  onSavePositions,
}: MultiWorkflowCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [scale, setScale] = useState(0.88);
  const [localRects, setLocalRects] = useState<Record<string, NodeRect>>({});
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string>("");
  const [hoveredTargetNodeId, setHoveredTargetNodeId] = useState<string>("");
  const [editingGroupId, setEditingGroupId] = useState<string>("");
  const [groupNameDraft, setGroupNameDraft] = useState<string>("");
  const renameDoneRef = useRef(false);

  const startGroupRename = (group: WorkflowGroupSummary) => {
    if (group.origin === "template") return;
    renameDoneRef.current = false;
    setEditingGroupId(group.group_id);
    setGroupNameDraft(group.name);
  };

  const commitGroupRename = (originalName: string) => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    const trimmed = groupNameDraft.trim();
    setEditingGroupId("");
    if (trimmed && trimmed !== originalName) {
      void onRenameGroup(trimmed);
    }
  };

  const cancelGroupRename = () => {
    renameDoneRef.current = true;
    setEditingGroupId("");
  };

  // Active interaction refs
  const panDragRef = useRef<{ startX: number; startY: number; origPan: Point } | null>(null);
  const nodeDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origRect: NodeRect;
    moved: boolean;
  } | null>(null);
  const nodeResizeRef = useRef<{
    id: string;
    dir: ResizeDirection;
    startX: number;
    startY: number;
    origRect: NodeRect;
    moved: boolean;
  } | null>(null);

  const [wireDrag, setWireDrag] = useState<{
    anchorId: string;
    anchorPort: "out" | "in";
    cursorWorld: Point;
  } | null>(null);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (pulses.length === 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [pulses.length]);

  const templateOwnedIds = useMemo(() => {
    const owned = new Set<string>();
    for (const g of workflow.groups) {
      if (g.origin === "template") {
        for (const id of g.member_ids) owned.add(id);
      }
    }
    return owned;
  }, [workflow.groups]);

  const workerBrandMap = useMemo(() => {
    const map: Record<string, string> = { ufoo: "ufoo", "ufoo-agent": "ufoo" };
    for (const w of workers) {
      if (w.id) map[w.id] = w.type;
      if (w.label) {
        map[w.label] = w.type;
        map[w.label.toLowerCase()] = w.type;
      }
      if (w.group_member_id) {
        map[w.group_member_id] = w.type;
        map[w.group_member_id.toLowerCase()] = w.type;
      }
    }
    return map;
  }, [workers]);

  const resolvedWorkerColorMap = useMemo(
    () => workerColorMap || buildProjectUcodeColorMap("", workers),
    [workerColorMap, workers]
  );

  // Resolved per-node sizes from live localRects or persisted workflow.positions
  const currentSizes = useMemo(() => {
    const map: Record<string, { w: number; h: number }> = {};
    for (const w of workers) {
      const local = localRects[w.id];
      const saved = workflow.positions?.[w.id];
      map[w.id] = {
        w: clamp(local?.w ?? saved?.w ?? DEFAULT_NODE_WIDTH, MIN_NODE_WIDTH, MAX_NODE_WIDTH),
        h: clamp(local?.h ?? saved?.h ?? DEFAULT_NODE_HEIGHT, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT),
      };
    }
    return map;
  }, [workers, localRects, workflow.positions]);

  const autoRects = useMemo(
    () => computeTopologicalLayout(workers, workflow.edges, workflow.groups, currentSizes),
    [workers, workflow.edges, workflow.groups, currentSizes]
  );

  // Merge auto layout <- persisted workflow.positions <- live localRects
  const nodeRects = useMemo(() => {
    const merged: Record<string, NodeRect> = {};
    for (const w of workers) {
      const local = localRects[w.id];
      const saved = workflow.positions?.[w.id];
      const auto = autoRects[w.id] || {
        x: 64,
        y: 72,
        w: DEFAULT_NODE_WIDTH,
        h: DEFAULT_NODE_HEIGHT,
      };
      merged[w.id] = {
        x: local?.x ?? saved?.x ?? auto.x,
        y: local?.y ?? saved?.y ?? auto.y,
        w: clamp(local?.w ?? saved?.w ?? auto.w, MIN_NODE_WIDTH, MAX_NODE_WIDTH),
        h: clamp(local?.h ?? saved?.h ?? auto.h, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT),
      };
    }
    return merged;
  }, [workers, localRects, workflow.positions, autoRects]);

  // Clear localRects when switching project root
  useEffect(() => {
    setLocalRects({});
  }, [workflow.project_root]);

  const screenToWorld = (clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - pan.x) / scale,
      y: (clientY - rect.top - pan.y) / scale,
    };
  };

  const fitView = (rectsOverride?: Record<string, NodeRect>) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const rectMap = rectsOverride || nodeRects;
    const ids = workers.map((w) => w.id);
    if (!rect || rect.width < 40 || rect.height < 40 || ids.length === 0) {
      setPan({ x: 0, y: 0 });
      setScale(0.9);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const nr = rectMap[id];
      if (!nr) continue;
      minX = Math.min(minX, nr.x - 32);
      minY = Math.min(minY, nr.y - 48);
      maxX = Math.max(maxX, nr.x + nr.w + 32);
      maxY = Math.max(maxY, nr.y + nr.h + 32);
    }
    if (!Number.isFinite(minX)) return;
    const contentW = Math.max(DEFAULT_NODE_WIDTH, maxX - minX);
    const contentH = Math.max(DEFAULT_NODE_HEIGHT, maxY - minY);
    const sidePad = 36;
    const topPad = 48;
    const bottomPad = 48;
    const availW = Math.max(160, rect.width - sidePad * 2);
    const availH = Math.max(160, rect.height - topPad - bottomPad);
    const nextScale = Math.max(0.48, Math.min(0.98, Math.min(availW / contentW, availH / contentH)));
    const nextPanX = sidePad + (availW - contentW * nextScale) / 2 - minX * nextScale;
    const nextPanY = topPad + (availH - contentH * nextScale) / 2 - minY * nextScale;
    setScale(Number(nextScale.toFixed(3)));
    setPan({ x: Math.round(nextPanX), y: Math.round(nextPanY) });
  };

  // Auto-fit on mount, project switch, or worker list changes (until user manually pans/zooms)
  const userAdjustedViewRef = useRef(false);
  const lastFitKeyRef = useRef<string>("");
  useEffect(() => {
    userAdjustedViewRef.current = false;
    lastFitKeyRef.current = "";
  }, [workflow.project_root]);

  useLayoutEffect(() => {
    const workerSig = workers.map((w) => w.id).join(",");
    const fitKey = `${workflow.project_root}:${workerSig}`;
    if (workers.length > 0 && !userAdjustedViewRef.current && lastFitKeyRef.current !== fitKey) {
      lastFitKeyRef.current = fitKey;
      fitView();
    }
  }, [workflow.project_root, workers]);

  const handleAutoArrange = () => {
    userAdjustedViewRef.current = false;
    const fresh = computeTopologicalLayout(workers, workflow.edges, workflow.groups, currentSizes);
    setLocalRects(fresh);
    onSavePositions(fresh);
    fitView(fresh);
  };

  const startNodeResize = (
    e: React.PointerEvent,
    worker: WorkerSummary,
    dir: ResizeDirection,
    rect: NodeRect
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectWorker(worker);
    nodeResizeRef.current = {
      id: worker.id,
      dir,
      startX: e.clientX,
      startY: e.clientY,
      origRect: { ...rect },
      moved: false,
    };
  };

  const resetNodeSize = (workerId: string, rect: NodeRect) => {
    const next: NodeRect = {
      x: rect.x,
      y: rect.y,
      w: DEFAULT_NODE_WIDTH,
      h: DEFAULT_NODE_HEIGHT,
    };
    setLocalRects((prev) => ({ ...prev, [workerId]: next }));
    onSavePositions({ [workerId]: next });
  };

  // Global pointer move / up listeners for panning, node drag, node resize, and wire drag
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (panDragRef.current) {
        const dx = e.clientX - panDragRef.current.startX;
        const dy = e.clientY - panDragRef.current.startY;
        setPan({
          x: panDragRef.current.origPan.x + dx,
          y: panDragRef.current.origPan.y + dy,
        });
        return;
      }
      if (nodeResizeRef.current) {
        const r = nodeResizeRef.current;
        const dx = (e.clientX - r.startX) / scale;
        const dy = (e.clientY - r.startY) / scale;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) r.moved = true;

        let nextX = r.origRect.x;
        let nextW = r.origRect.w;
        let nextH = r.origRect.h;

        if (r.dir === "e" || r.dir === "se") {
          nextW = clamp(r.origRect.w + dx, MIN_NODE_WIDTH, MAX_NODE_WIDTH);
        } else if (r.dir === "w" || r.dir === "sw") {
          nextW = clamp(r.origRect.w - dx, MIN_NODE_WIDTH, MAX_NODE_WIDTH);
          nextX = r.origRect.x + (r.origRect.w - nextW);
        }
        if (r.dir === "s" || r.dir === "se" || r.dir === "sw") {
          nextH = clamp(r.origRect.h + dy, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT);
        }

        setLocalRects((prev) => ({
          ...prev,
          [r.id]: {
            x: Math.round(nextX),
            y: r.origRect.y,
            w: nextW,
            h: nextH,
          },
        }));
        return;
      }
      if (nodeDragRef.current) {
        const drag = nodeDragRef.current;
        const dx = (e.clientX - drag.startX) / scale;
        const dy = (e.clientY - drag.startY) / scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
        setLocalRects((prev) => ({
          ...prev,
          [drag.id]: {
            x: Math.round(drag.origRect.x + dx),
            y: Math.round(drag.origRect.y + dy),
            w: drag.origRect.w,
            h: drag.origRect.h,
          },
        }));
        return;
      }
      if (wireDrag) {
        setWireDrag((prev) => (prev ? { ...prev, cursorWorld: screenToWorld(e.clientX, e.clientY) } : null));
      }
    };

    const onPointerUp = () => {
      if (panDragRef.current) {
        panDragRef.current = null;
      }
      if (nodeResizeRef.current) {
        const r = nodeResizeRef.current;
        nodeResizeRef.current = null;
        if (r.moved) {
          setLocalRects((current) => {
            const nr = current[r.id];
            if (nr) onSavePositions({ [r.id]: nr });
            return current;
          });
        }
      }
      if (nodeDragRef.current) {
        const drag = nodeDragRef.current;
        nodeDragRef.current = null;
        if (drag.moved) {
          setLocalRects((current) => {
            const nr = current[drag.id];
            if (nr) onSavePositions({ [drag.id]: nr });
            return current;
          });
        }
      }
      if (wireDrag) {
        const targetId = hoveredTargetNodeId;
        const drag = wireDrag;
        setWireDrag(null);
        setHoveredTargetNodeId("");
        if (targetId && targetId !== drag.anchorId && !templateOwnedIds.has(targetId)) {
          if (drag.anchorPort === "out") {
            void onConnectEdge(drag.anchorId, targetId);
          } else {
            void onConnectEdge(targetId, drag.anchorId);
          }
        }
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [scale, pan, wireDrag, hoveredTargetNodeId, templateOwnedIds, onConnectEdge, onSavePositions]);

  const handleCanvasWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!e.ctrlKey && !e.metaKey && target?.closest("[data-node-scroll='true']")) {
      return;
    }
    userAdjustedViewRef.current = true;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.09 : 0.92;
      const nextScale = Math.max(0.42, Math.min(1.45, scale * factor));
      const worldX = (mouseX - pan.x) / scale;
      const worldY = (mouseY - pan.y) / scale;
      setScale(Number(nextScale.toFixed(3)));
      setPan({
        x: Math.round(mouseX - worldX * nextScale),
        y: Math.round(mouseY - worldY * nextScale),
      });
    } else {
      // Smooth two-finger trackpad pan on empty canvas
      setPan((prev) => ({
        x: Math.round(prev.x - e.deltaX),
        y: Math.round(prev.y - e.deltaY),
      }));
    }
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-workflow-node='true'], [data-workflow-ui='true']")) return;
    e.preventDefault();
    userAdjustedViewRef.current = true;
    panDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origPan: { ...pan },
    };
  };

  const startPortDrag = (
    e: React.PointerEvent,
    agentId: string,
    port: "out" | "in"
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (templateOwnedIds.has(agentId)) return;
    const nr = nodeRects[agentId];
    if (!nr) return;
    setWireDrag({
      anchorId: agentId,
      anchorPort: port,
      cursorWorld: {
        x: port === "out" ? nr.x + nr.w : nr.x,
        y: nr.y + Math.round(nr.h / 2),
      },
    });
  };

  // Compute group bounding boxes dynamically from member node rects
  const groupBoxes = useMemo(() => {
    return workflow.groups
      .map((group) => {
        const rects = group.member_ids
          .map((id) => nodeRects[id])
          .filter((nr): nr is NodeRect => Boolean(nr));
        if (rects.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const nr of rects) {
          minX = Math.min(minX, nr.x);
          minY = Math.min(minY, nr.y);
          maxX = Math.max(maxX, nr.x + nr.w);
          maxY = Math.max(maxY, nr.y + nr.h);
        }
        return {
          group,
          x: minX - 24,
          y: minY - 42,
          width: maxX - minX + 48,
          height: maxY - minY + 66,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [workflow.groups, nodeRects]);

  // Visible active edges + reverse pair lookup for clean opposing Bezier bows
  const visibleEdges = useMemo(() => {
    const idSet = new Set(workers.map((w) => w.id));
    return workflow.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to);
  }, [workers, workflow.edges]);

  const edgePairSet = useMemo(
    () => new Set(visibleEdges.map((e) => `${e.from}->${e.to}`)),
    [visibleEdges]
  );

  const activePulses = useMemo(
    () => pulses.filter((p) => nowTick - p.ts < 1400),
    [pulses, nowTick]
  );

  const connectedInSet = useMemo(() => new Set(visibleEdges.map((e) => e.to)), [visibleEdges]);
  const connectedOutSet = useMemo(() => new Set(visibleEdges.map((e) => e.from)), [visibleEdges]);

  const standaloneCount = workers.filter((w) => !templateOwnedIds.has(w.id)).length;
  const dotSpacing = Math.max(14, Math.round(24 * scale));

  // Preview wire coordinates while user is dragging from a port
  const previewPath = useMemo(() => {
    if (!wireDrag) return null;
    const anchor = nodeRects[wireDrag.anchorId];
    if (!anchor) return null;
    const anchorPt: Point = {
      x: wireDrag.anchorPort === "out" ? anchor.x + anchor.w : anchor.x,
      y: anchor.y + Math.round(anchor.h / 2),
    };
    let endPt = wireDrag.cursorWorld;
    if (hoveredTargetNodeId && hoveredTargetNodeId !== wireDrag.anchorId) {
      const targetRect = nodeRects[hoveredTargetNodeId];
      if (targetRect) {
        endPt = {
          x: wireDrag.anchorPort === "out" ? targetRect.x : targetRect.x + targetRect.w,
          y: targetRect.y + Math.round(targetRect.h / 2),
        };
      }
    }
    return wireDrag.anchorPort === "out"
      ? buildBezierPath(anchorPt, endPt)
      : buildBezierPath(endPt, anchorPt);
  }, [wireDrag, nodeRects, hoveredTargetNodeId]);

  return (
    <div
      ref={viewportRef}
      onWheel={handleCanvasWheel}
      onPointerDown={handleCanvasPointerDown}
      className="relative flex-1 min-h-0 overflow-hidden bg-[#0b0b0d] select-none cursor-grab active:cursor-grabbing"
      style={{
        backgroundImage: "radial-gradient(rgba(255,255,255,0.085) 1px, transparent 1px)",
        backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
        backgroundPosition: `${pan.x % dotSpacing}px ${pan.y % dotSpacing}px`,
      }}
    >
      {/* Transformed World Plane */}
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
        }}
      >
        {/* Layer 1: ComfyUI Group Backdrop Boxes */}
        {groupBoxes.map(({ group, x, y, width, height }) => {
          const isTemplate = group.origin === "template";
          return (
            <div
              key={group.group_id}
              style={{ left: x, top: y, width, height }}
              className={`pointer-events-none absolute rounded-2xl border transition-colors ${
                isTemplate
                  ? "border-white/[0.11] bg-white/[0.018]"
                  : "border-emerald-400/20 bg-emerald-400/[0.022]"
              }`}
            >
              <div
                data-workflow-ui="true"
                className="pointer-events-auto flex items-center justify-between px-3.5 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isTemplate ? (
                    <LockSimple size={11} className="shrink-0 text-zinc-500" />
                  ) : (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                  )}
                  {!isTemplate && editingGroupId === group.group_id ? (
                    <input
                      type="text"
                      autoFocus
                      maxLength={48}
                      value={groupNameDraft}
                      onChange={(e) => setGroupNameDraft(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => commitGroupRename(group.name)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitGroupRename(group.name);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelGroupRename();
                        }
                      }}
                      className="min-w-[110px] max-w-[240px] rounded-md border border-emerald-400/45 bg-[#15151a] px-1.5 py-0.5 text-[11.5px] font-medium text-zinc-100 focus:outline-none select-text"
                    />
                  ) : (
                    <span
                      onDoubleClick={(e) => {
                        if (isTemplate) return;
                        e.stopPropagation();
                        startGroupRename(group);
                      }}
                      title={isTemplate ? group.name : "Double-click to rename temporary group"}
                      className={`text-[11.5px] font-medium text-zinc-300 truncate ${
                        isTemplate
                          ? ""
                          : "cursor-text rounded px-1 -mx-1 hover:bg-white/[0.06] hover:text-white transition-colors"
                      }`}
                    >
                      {group.name}
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-zinc-500 shrink-0">
                    {group.member_ids.length} agents
                  </span>
                </div>
                {!isTemplate && (
                  <button
                    type="button"
                    onClick={() => void onDisbandGroup()}
                    title="Dissolve temporary group and remove all links"
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
                  >
                    <LinkBreak size={11} />
                    <span>Ungroup</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Layer 2: Directed Bezier Workflow Wires + Live Message Flow Pulses */}
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width="1"
          height="1"
        >
          <defs>
            <marker
              id="wf-arrow-tpl"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="rgba(161, 161, 170, 0.72)" />
            </marker>
            <marker
              id="wf-arrow-adhoc"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="rgba(110, 231, 183, 0.85)" />
            </marker>
            <marker
              id="wf-arrow-preview"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="rgba(244, 244, 245, 0.9)" />
            </marker>
          </defs>

          {visibleEdges.map((edge) => {
            const fromNode = nodeRects[edge.from];
            const toNode = nodeRects[edge.to];
            if (!fromNode || !toNode) return null;
            const hasReverse = edgePairSet.has(`${edge.to}->${edge.from}`);
            const bow = hasReverse ? (edge.from < edge.to ? -32 : 32) : 0;
            const startPt = { x: fromNode.x + fromNode.w, y: fromNode.y + Math.round(fromNode.h / 2) };
            const endPt = { x: toNode.x, y: toNode.y + Math.round(toNode.h / 2) };
            const { d, mid } = buildBezierPath(startPt, endPt, bow);
            const hovered = hoveredEdgeId === edge.id;
            const matchingPulses = activePulses.filter(
              (p) => p.edge_id === edge.id || (p.from === edge.from && p.to === edge.to)
            );
            const isAdhoc = edge.origin === "adhoc";

            return (
              <g
                key={edge.id}
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId((prev) => (prev === edge.id ? "" : prev))}
              >
                {/* Wide transparent hit area for easy hovering / clicking */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="18"
                  className="pointer-events-auto cursor-pointer"
                />

                {/* Base Bezier wire */}
                <path
                  d={d}
                  fill="none"
                  stroke={
                    matchingPulses.length > 0
                      ? "rgba(244, 244, 245, 0.9)"
                      : isAdhoc
                      ? hovered
                        ? "rgba(110, 231, 183, 0.95)"
                        : "rgba(110, 231, 183, 0.45)"
                      : hovered
                      ? "rgba(212, 212, 216, 0.8)"
                      : "rgba(161, 161, 170, 0.42)"
                  }
                  strokeWidth={hovered || matchingPulses.length > 0 ? 2.4 : 1.75}
                  markerEnd={isAdhoc ? "url(#wf-arrow-adhoc)" : "url(#wf-arrow-tpl)"}
                />

                {/* Animated directional flow dash for active auto-forward edges */}
                {isAdhoc && (
                  <path
                    d={d}
                    fill="none"
                    stroke="rgba(167, 243, 208, 0.55)"
                    strokeWidth="1.5"
                    strokeDasharray="4 20"
                    className="animate-workflow-flow"
                  />
                )}

                {/* Luminous live message pulse particles */}
                {matchingPulses.map((pulse) => (
                  <g key={pulse.id}>
                    <circle r="7" fill="rgba(110, 231, 183, 0.25)">
                      <animateMotion dur="0.95s" repeatCount="1" fill="freeze" path={d} />
                    </circle>
                    <circle r="3.5" fill="#f4f4f5">
                      <animateMotion dur="0.95s" repeatCount="1" fill="freeze" path={d} />
                    </circle>
                  </g>
                ))}

                {/* Midpoint label (template edge kind) or disconnect button (ad-hoc edge) */}
                {isAdhoc && hovered ? (
                  <foreignObject
                    x={mid.x - 13}
                    y={mid.y - 13}
                    width="26"
                    height="26"
                    className="pointer-events-auto overflow-visible"
                  >
                    <button
                      type="button"
                      data-workflow-ui="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDisconnectEdge(edge);
                      }}
                      title="Disconnect link"
                      aria-label="Disconnect link"
                      className="flex h-6 w-6 items-center justify-center rounded-full border border-white/[0.16] bg-[#18181c] text-zinc-200 hover:border-rose-400/50 hover:bg-rose-500/20 hover:text-rose-200 shadow-lg transition-colors cursor-pointer"
                    >
                      <X size={11} weight="bold" />
                    </button>
                  </foreignObject>
                ) : (
                  (hovered || !isAdhoc) &&
                  edge.kind && (
                    <foreignObject
                      x={mid.x - 42}
                      y={mid.y - 11}
                      width="84"
                      height="22"
                      className="pointer-events-none overflow-visible"
                    >
                      <div className="flex justify-center">
                        <span className="rounded-full border border-white/[0.08] bg-[#121216]/95 px-2 py-0.5 font-mono text-[9.5px] text-zinc-400">
                          {edge.kind}
                        </span>
                      </div>
                    </foreignObject>
                  )
                )}
              </g>
            );
          })}

          {/* Live drag-to-connect Bezier preview */}
          {previewPath && (
            <path
              d={previewPath.d}
              fill="none"
              stroke="rgba(244, 244, 245, 0.85)"
              strokeWidth="2"
              strokeDasharray="6 5"
              markerEnd="url(#wf-arrow-preview)"
            />
          )}
        </svg>

        {/* Layer 3: Draggable & Resizable ComfyUI Worker Nodes */}
        {workers.map((worker) => {
          const rect = nodeRects[worker.id] || {
            x: 64,
            y: 72,
            w: DEFAULT_NODE_WIDTH,
            h: DEFAULT_NODE_HEIGHT,
          };
          const portY = Math.round(rect.h / 2);
          const frame = paneFrames[worker.id];
          const isSelected = selectedTargetId === worker.id;
          const isTemplate = templateOwnedIds.has(worker.id);
          const isBusy = Boolean(frame?.busy || worker.activity_state === "working");
          const isValidDropTarget = Boolean(
            wireDrag && wireDrag.anchorId !== worker.id && !isTemplate
          );
          const isHoveredTarget = isValidDropTarget && hoveredTargetNodeId === worker.id;
          const hasIn = connectedInSet.has(worker.id);
          const hasOut = connectedOutSet.has(worker.id);
          const isConnected = hasIn || hasOut || isTemplate;
          const isDragInTarget = Boolean(isValidDropTarget && wireDrag?.anchorPort === "out");
          const isDragOutTarget = Boolean(isValidDropTarget && wireDrag?.anchorPort === "in");
          const isInAnchor = wireDrag?.anchorId === worker.id && wireDrag.anchorPort === "in";
          const isOutAnchor = wireDrag?.anchorId === worker.id && wireDrag.anchorPort === "out";

          return (
            <div
              key={worker.id}
              data-workflow-node="true"
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.w,
                height: rect.h,
              }}
              onPointerEnter={() => {
                if (isValidDropTarget) setHoveredTargetNodeId(worker.id);
              }}
              onPointerLeave={() => {
                if (hoveredTargetNodeId === worker.id) setHoveredTargetNodeId("");
              }}
              className={`group/node absolute flex flex-col rounded-2xl border transition-[background-color,border-color,opacity,box-shadow] duration-150 ${
                isHoveredTarget
                  ? "bg-[#111114] border-emerald-400/70 ring-1 ring-emerald-400/35 shadow-[0_12px_32px_rgba(0,0,0,0.42)]"
                  : isSelected
                  ? "bg-[#111114]/95 border-white/[0.24] shadow-[0_12px_32px_rgba(0,0,0,0.4)]"
                  : isConnected
                  ? "bg-[#111114] border-white/[0.12] hover:border-white/[0.18] shadow-[0_12px_32px_rgba(0,0,0,0.38)]"
                  : "bg-[#111114]/65 border-white/[0.06] hover:bg-[#111114]/92 hover:border-white/[0.14] shadow-[0_8px_24px_rgba(0,0,0,0.22)]"
              } ${wireDrag && !isValidDropTarget && wireDrag.anchorId !== worker.id ? "opacity-50" : ""}`}
            >
              {/* Left Input Port (IN) — vertically centered on card edge */}
              <button
                type="button"
                data-workflow-ui="true"
                onPointerDown={(e) => startPortDrag(e, worker.id, "in")}
                onPointerEnter={() => {
                  if (isValidDropTarget) setHoveredTargetNodeId(worker.id);
                }}
                title={
                  isTemplate
                    ? "Workflow input (managed by template group)"
                    : "Input port — drop a wire here to receive forwarded output"
                }
                aria-label={`${worker.label} input port`}
                style={{ top: portY - 12 }}
                className={`group/port absolute -left-3 z-20 flex h-6 w-6 items-center justify-center rounded-full ${
                  isTemplate ? "cursor-default" : "cursor-crosshair"
                }`}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full border-[1.5px] transition-all duration-150 ${
                    isInAnchor
                      ? "opacity-100 scale-125 border-zinc-100 bg-zinc-100"
                      : isHoveredTarget && isDragInTarget
                      ? "opacity-100 scale-125 border-emerald-300 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]"
                      : hasIn
                      ? isTemplate
                        ? "opacity-100 border-zinc-300/80 bg-zinc-400"
                        : "opacity-100 border-emerald-300 bg-emerald-400"
                      : isDragInTarget
                      ? "opacity-75 border-emerald-300/80 bg-[#111114]"
                      : isTemplate
                      ? "opacity-20 border-zinc-500 bg-[#111114]/60"
                      : "opacity-20 border-white/45 bg-[#111114]/70 group-hover/node:opacity-65 group-hover/port:!opacity-100 group-hover/port:scale-125 group-hover/port:border-zinc-100"
                  }`}
                />
              </button>

              {/* Right Output Port (OUT) — vertically centered on card edge */}
              <button
                type="button"
                data-workflow-ui="true"
                onPointerDown={(e) => startPortDrag(e, worker.id, "out")}
                onPointerEnter={() => {
                  if (isValidDropTarget) setHoveredTargetNodeId(worker.id);
                }}
                title={
                  isTemplate
                    ? "Workflow output (managed by template group)"
                    : "Output port — drag to another agent to connect message flow"
                }
                aria-label={`${worker.label} output port`}
                style={{ top: portY - 12 }}
                className={`group/port absolute -right-3 z-20 flex h-6 w-6 items-center justify-center rounded-full ${
                  isTemplate ? "cursor-default" : "cursor-crosshair"
                }`}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full border-[1.5px] transition-all duration-150 ${
                    isOutAnchor
                      ? "opacity-100 scale-125 border-zinc-100 bg-zinc-100"
                      : isHoveredTarget && isDragOutTarget
                      ? "opacity-100 scale-125 border-emerald-300 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]"
                      : hasOut
                      ? isTemplate
                        ? "opacity-100 border-zinc-300/80 bg-zinc-400"
                        : "opacity-100 border-emerald-300 bg-emerald-400"
                      : isDragOutTarget
                      ? "opacity-75 border-emerald-300/80 bg-[#111114]"
                      : isTemplate
                      ? "opacity-20 border-zinc-500 bg-[#111114]/60"
                      : "opacity-20 border-white/45 bg-[#111114]/70 group-hover/node:opacity-65 group-hover/port:!opacity-100 group-hover/port:scale-125 group-hover/port:border-zinc-100"
                  }`}
                />
              </button>

              {/* Draggable Node Header */}
              <div
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  if ((e.target as HTMLElement)?.closest("button")) return;
                  e.stopPropagation();
                  onSelectWorker(worker);
                  nodeDragRef.current = {
                    id: worker.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    origRect: { ...rect },
                    moved: false,
                  };
                }}
                className="flex h-9 shrink-0 items-center justify-between gap-2 rounded-t-2xl border-b border-white/[0.06] bg-white/[0.025] px-3 cursor-grab active:cursor-grabbing"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <BrandIcon brand={worker.type} color={resolvedWorkerColorMap[worker.id]} size={14} />
                  <span className="font-mono text-[12px] font-medium text-zinc-100 truncate">
                    {worker.label}
                  </span>
                  {isBusy ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 animate-pulse" />
                  ) : (
                    <span className="text-[10.5px] text-zinc-500 truncate">
                      {frame?.status || worker.activity_state || "ready"}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {frame?.usage && (
                    <span className="font-mono text-[10px] text-zinc-500">{frame.usage}</span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMaximizeWorker(worker);
                    }}
                    title="Open in Single-Worker View"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
                  >
                    <ArrowsOutSimple size={12} />
                  </button>
                </div>
              </div>

              {/* Live Conversation Body */}
              <div
                data-node-scroll="true"
                onClick={() => onSelectWorker(worker)}
                className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-b-2xl"
              >
                <TranscriptStream
                  entries={frame?.entries || []}
                  planLines={frame?.plan || []}
                  busy={isBusy}
                  statusText={frame?.status || worker.activity_detail || ""}
                  changedFiles={frame?.changed_files || []}
                  defaultSpeaker={worker.label}
                  defaultSpeakerBrand={worker.type}
                  defaultSpeakerColor={resolvedWorkerColorMap[worker.id]}
                  workerBrandMap={workerBrandMap}
                  workerColorMap={resolvedWorkerColorMap}
                  onOpenFile={onOpenFile}
                  onClearConversation={worker.internal ? () => onClearWorker(worker) : undefined}
                  compact
                  emptyHint="What do you want to do now?"
                />
              </div>

              {/* Subtle Edge & Corner Resize Handles (below port z-20 so ports stay easy to grab) */}
              <div
                data-workflow-ui="true"
                onPointerDown={(e) => startNodeResize(e, worker, "w", rect)}
                className="absolute -left-1 top-3 bottom-3 z-10 w-2 cursor-ew-resize"
              />
              <div
                data-workflow-ui="true"
                onPointerDown={(e) => startNodeResize(e, worker, "e", rect)}
                className="absolute -right-1 top-3 bottom-3 z-10 w-2 cursor-ew-resize"
              />
              <div
                data-workflow-ui="true"
                onPointerDown={(e) => startNodeResize(e, worker, "s", rect)}
                className="absolute -bottom-1 left-3 right-3 z-10 h-2 cursor-ns-resize"
              />
              <div
                data-workflow-ui="true"
                onPointerDown={(e) => startNodeResize(e, worker, "sw", rect)}
                className="absolute -bottom-1 -left-1 z-20 h-4 w-4 cursor-nesw-resize"
              />
              <div
                data-workflow-ui="true"
                onPointerDown={(e) => startNodeResize(e, worker, "se", rect)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  resetNodeSize(worker.id, rect);
                }}
                title="Drag to resize · Double-click to reset size"
                className="group/resize absolute -bottom-1 -right-1 z-20 flex h-5 w-5 items-end justify-end p-1.5 cursor-nwse-resize"
              >
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="none"
                  className="text-zinc-400 opacity-20 transition-opacity duration-150 group-hover/node:opacity-55 group-hover/resize:!opacity-100"
                >
                  <path
                    d="M7 2.5L2.5 7M7 5.5L5.5 7"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>
          );
        })}
      </div>

      {/* Subtle First-Use Hint when 2+ standalone workers have no wires yet */}
      {standaloneCount >= 2 && visibleEdges.length === 0 && (
        <div
          data-workflow-ui="true"
          className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-white/[0.08] bg-[#141418]/90 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur-md"
        >
          Drag from a node’s right port to connect agents into a temp group
        </div>
      )}

      {/* Floating Bottom-Left Canvas Controls */}
      <div
        data-workflow-ui="true"
        className="absolute bottom-3 left-3 z-30 flex items-center gap-0.5 rounded-xl border border-white/[0.09] bg-[#141418]/90 p-1 text-zinc-400 shadow-lg backdrop-blur-md"
      >
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(0.42, Number((s - 0.1).toFixed(2))))}
          title="Zoom out"
          aria-label="Zoom out"
          className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-white/[0.08] hover:text-zinc-100 transition-colors cursor-pointer"
        >
          <MagnifyingGlassMinus size={13} />
        </button>
        <button
          type="button"
          onClick={() => setScale(1)}
          title="Reset zoom (100%)"
          className="min-w-[40px] rounded-lg px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(1.45, Number((s + 0.1).toFixed(2))))}
          title="Zoom in"
          aria-label="Zoom in"
          className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-white/[0.08] hover:text-zinc-100 transition-colors cursor-pointer"
        >
          <MagnifyingGlassPlus size={13} />
        </button>
        <div className="mx-0.5 h-3.5 w-px bg-white/[0.08]" />
        <button
          type="button"
          onClick={() => fitView()}
          title="Fit nodes to view"
          aria-label="Fit nodes to view"
          className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-white/[0.08] hover:text-zinc-100 transition-colors cursor-pointer"
        >
          <CornersOut size={13} />
        </button>
        <button
          type="button"
          onClick={handleAutoArrange}
          title="Auto arrange workflow"
          aria-label="Auto arrange workflow"
          className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-white/[0.08] hover:text-zinc-100 transition-colors cursor-pointer"
        >
          <FlowArrow size={13} />
        </button>
      </div>
    </div>
  );
}
