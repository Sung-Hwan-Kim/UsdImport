"use client";

import {
  Atom,
  Axis3d,
  Bone,
  Box,
  ChevronRight,
  ChevronsDownUp,
  Eye,
  EyeOff,
  Folder,
  Layers,
  Lightbulb,
  Link2,
  PersonStanding,
  Search,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Object3D } from "three";
import { displayName, nodeKind, usdTypeOf, type NodeKind } from "@/lib/scene";
import { useViewer } from "@/lib/store";
import { cn, IconButton } from "./ui";

const ROW_HEIGHT = 26;
const OVERSCAN = 10;

export const KIND_ICON: Record<NodeKind, LucideIcon> = {
  stage: Layers,
  xform: Axis3d,
  scope: Folder,
  mesh: Box,
  skinned: PersonStanding,
  bone: Bone,
  light: Lightbulb,
  camera: Video,
  joint: Link2,
  physicsScene: Atom,
};

export const KIND_COLOR: Record<NodeKind, string> = {
  stage: "text-fg",
  xform: "text-muted",
  scope: "text-faint",
  mesh: "text-accent",
  skinned: "text-[#c69cff]",
  bone: "text-faint",
  light: "text-warn",
  camera: "text-ok",
  joint: "text-[#ff9f5a]",
  physicsScene: "text-accent",
};

interface Row {
  obj: Object3D;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Scene children minus viewer-internal helpers (e.g. light targets). */
function childrenOf(obj: Object3D): Object3D[] {
  return obj.children.filter((c) => !c.userData.internal);
}

function buildRows(root: Object3D, expanded: Set<number>, query: string): Row[] {
  const rows: Row[] = [];
  if (!query) {
    const walk = (obj: Object3D, depth: number) => {
      const open = expanded.has(obj.id);
      const children = childrenOf(obj);
      rows.push({ obj, depth, hasChildren: children.length > 0, expanded: open });
      if (open) for (const child of children) walk(child, depth + 1);
    };
    walk(root, 0);
    return rows;
  }
  // Filtering: keep matches plus their ancestors, fully expanded.
  const q = query.toLowerCase();
  const keep = new Set<Object3D>();
  root.traverse((obj) => {
    if (obj.userData.internal || !obj.name.toLowerCase().includes(q)) return;
    let cur: Object3D | null = obj;
    while (cur && !keep.has(cur)) {
      keep.add(cur);
      if (cur === root) break;
      cur = cur.parent;
    }
  });
  const walk = (obj: Object3D, depth: number) => {
    if (!keep.has(obj)) return;
    rows.push({ obj, depth, hasChildren: obj.children.some((c) => keep.has(c)), expanded: true });
    for (const child of obj.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
}

function defaultExpanded(root: Object3D): Set<number> {
  const set = new Set<number>([root.id]);
  for (const child of childrenOf(root)) if (child.children.length <= 64) set.add(child.id);
  return set;
}

/** `expanded` plus every ancestor of `obj` (same Set when nothing changes). */
function withAncestors(expanded: Set<number>, obj: Object3D, root: Object3D): Set<number> {
  let next = expanded;
  let cur = obj.parent;
  while (cur) {
    if (!next.has(cur.id)) {
      if (next === expanded) next = new Set(expanded);
      next.add(cur.id);
    }
    if (cur === root) break;
    cur = cur.parent;
  }
  return next;
}

function TreeRow({
  row,
  style,
  selected,
  query,
  onToggle,
}: {
  row: Row;
  style: CSSProperties;
  selected: boolean;
  query: string;
  onToggle: (obj: Object3D) => void;
}) {
  const select = useViewer((s) => s.select);
  const requestFocus = useViewer((s) => s.requestFocus);
  const setVisible = useViewer((s) => s.setVisible);
  const { obj, depth, hasChildren, expanded } = row;
  const kind = nodeKind(obj);
  const Icon = KIND_ICON[kind];
  const name = displayName(obj);
  const type = usdTypeOf(obj);
  const hidden = !obj.visible;

  let label: React.ReactNode = name;
  if (query) {
    const i = name.toLowerCase().indexOf(query.toLowerCase());
    if (i >= 0) {
      label = (
        <>
          {name.slice(0, i)}
          <mark className="rounded-sm bg-accent/30 text-fg">{name.slice(i, i + query.length)}</mark>
          {name.slice(i + query.length)}
        </>
      );
    }
  }

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      style={{ ...style, paddingLeft: 6 + depth * 14 }}
      onClick={() => select(obj)}
      onDoubleClick={() => {
        select(obj);
        requestFocus("selection");
      }}
      className={cn(
        "group flex cursor-default items-center gap-1 pr-1.5 text-[12.5px] select-none",
        selected ? "bg-accent-soft text-fg" : "text-fg/90 hover:bg-hover",
        hidden && "opacity-45",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={expanded ? "접기" : "펼치기"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(obj);
        }}
        className={cn("flex size-4 shrink-0 items-center justify-center text-faint hover:text-fg", !hasChildren && "invisible")}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
      </button>
      <Icon className={cn("size-3.5 shrink-0", KIND_COLOR[kind])} strokeWidth={1.75} />
      <span className="ml-1 min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-faint group-hover:hidden">{type}</span>
      <button
        type="button"
        tabIndex={-1}
        title={hidden ? "표시" : "숨기기"}
        onClick={(e) => {
          e.stopPropagation();
          setVisible(obj, hidden);
        }}
        className={cn(
          "size-5 shrink-0 items-center justify-center rounded text-muted hover:text-fg",
          hidden ? "flex" : "hidden group-hover:flex",
        )}
      >
        {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}

function Tree({ root }: { root: Object3D }) {
  const selected = useViewer((s) => s.selected);
  const select = useViewer((s) => s.select);
  const requestFocus = useViewer((s) => s.requestFocus);
  const showAll = useViewer((s) => s.showAll);
  useViewer((s) => s.revision); // re-render on visibility changes

  const [expanded, setExpanded] = useState(() => defaultExpanded(root));
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<Object3D | null>(null);

  const rows = useMemo(() => buildRows(root, expanded, query.trim()), [root, expanded, query]);
  const objectCount = useMemo(() => {
    let n = 0;
    root.traverse((obj) => {
      if (!obj.userData.internal) n++;
    });
    return n;
  }, [root]);

  const toggle = (obj: Object3D) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(obj.id)) next.delete(obj.id);
      else next.add(obj.id);
      return next;
    });

  // Reveal a new selection by expanding its ancestors (state adjusted during
  // render rather than in an effect), then scroll it into view once.
  const [revealed, setRevealed] = useState<Object3D | null>(null);
  if (selected && selected !== revealed) {
    setRevealed(selected);
    const next = withAncestors(expanded, selected, root);
    if (next !== expanded) setExpanded(next);
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !selected || scrolledFor.current === selected) return;
    const index = rows.findIndex((r) => r.obj === selected);
    if (index < 0) return;
    scrolledFor.current = selected;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
  }, [rows, selected]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = rows.findIndex((r) => r.obj === selected);
    const row = rows[index];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        scrolledFor.current = null;
        select(next.obj);
      }
    } else if (e.key === "ArrowRight" && row?.hasChildren && !row.expanded) {
      e.preventDefault();
      toggle(row.obj);
    } else if (e.key === "ArrowLeft" && row) {
      e.preventDefault();
      if (row.expanded && row.hasChildren) toggle(row.obj);
      else if (row.obj !== root && row.obj.parent) {
        scrolledFor.current = null;
        select(row.obj.parent);
      }
    } else if (e.key === "Enter" && row) {
      e.preventDefault();
      requestFocus("selection");
    }
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  return (
    <>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-bg/70 px-2 ring-1 ring-line focus-within:ring-accent/60">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="프림 검색"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} className="text-faint hover:text-fg" aria-label="검색 지우기">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <IconButton icon={Eye} label="모두 표시" shortcut="Alt+H" onClick={showAll} className="size-7" />
        <IconButton icon={ChevronsDownUp} label="모두 접기" onClick={() => setExpanded(new Set([root.id]))} className="size-7" />
      </div>
      <div
        ref={scrollRef}
        role="tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="scroll-thin relative min-h-0 flex-1 overflow-y-auto py-1 outline-none"
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {rows.slice(start, end).map((row, i) => (
            <TreeRow
              key={row.obj.id}
              row={row}
              query={query.trim()}
              selected={row.obj === selected}
              onToggle={toggle}
              style={{ position: "absolute", top: (start + i) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}
            />
          ))}
        </div>
        {query && rows.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-faint">일치하는 프림이 없습니다</p>}
      </div>
      <div className="border-t border-line px-3 py-1.5 font-mono text-[10.5px] text-faint">
        {query ? `${rows.length.toLocaleString()} / ` : ""}
        {objectCount.toLocaleString()} 노드
      </div>
    </>
  );
}

export default function HierarchyPanel() {
  const stage = useViewer((s) => s.stage);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center px-3 text-[11px] font-semibold tracking-wide text-muted uppercase">계층 구조</div>
      {stage ? (
        <Tree key={stage.id} root={stage.scene} />
      ) : (
        <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-faint">스테이지를 열면 프림 계층이 여기에 표시됩니다.</p>
      )}
    </div>
  );
}
