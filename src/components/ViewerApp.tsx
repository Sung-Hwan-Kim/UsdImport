"use client";

import { useEffect, useRef, useState } from "react";
import { filesFromDataTransfer } from "@/lib/files";
import { SAMPLES, sampleUrl } from "@/lib/samples";
import type { Shading } from "@/lib/scene";
import { useViewer } from "@/lib/store";
import AnimationBar from "./AnimationBar";
import HierarchyPanel from "./HierarchyPanel";
import InspectorPanel from "./InspectorPanel";
import { DropOverlay, EmptyState, ErrorToast, LoadingOverlay, RenderStatsOverlay } from "./Overlays";
import TopBar from "./TopBar";
import { cn } from "./ui";
import Viewport from "./viewport/Viewport";
import ViewportToolbar from "./ViewportToolbar";

const SHADING_KEYS: Record<string, Shading> = { Digit1: "pbr", Digit2: "clay", Digit3: "normals", Digit4: "wireframe" };

function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      filesFromDataTransfer(e.dataTransfer).then((files) => {
        if (files.length) useViewer.getState().openFiles(files);
      });
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  return dragging;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.ctrlKey || e.metaKey) return;
      const s = useViewer.getState();
      const toggle = (key: "grid" | "sceneLights" | "autoRotate") => s.setSetting(key, !s.settings[key]);
      if (SHADING_KEYS[e.code]) {
        s.setSetting("shading", SHADING_KEYS[e.code]);
        return;
      }
      switch (e.code) {
        case "KeyF":
          s.requestFocus(s.selected ? "selection" : "stage", !s.selected);
          break;
        case "KeyA":
        case "Home":
          s.requestFocus("stage", true);
          break;
        case "Escape":
          s.select(null);
          break;
        case "KeyH":
          if (e.altKey) s.showAll();
          else if (s.selected) s.setVisible(s.selected, !s.selected.visible);
          break;
        case "KeyG":
          toggle("grid");
          break;
        case "KeyL":
          toggle("sceneLights");
          break;
        case "KeyR":
          toggle("autoRotate");
          break;
        case "Space":
          if (s.animation.duration > 0) {
            e.preventDefault();
            const { playing, time, duration } = s.animation;
            s.setAnimation({ playing: !playing, time: !playing && time >= duration ? 0 : time });
          }
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** ?url=<usd file url> or ?sample=<id> opens a stage on load. */
function useInitialStage() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url");
    const sample = SAMPLES.find((s) => s.id === params.get("sample"));
    if (url) useViewer.getState().openUrl(url);
    else if (sample) useViewer.getState().openUrl(sampleUrl(sample));
  }, []);
}

export default function ViewerApp() {
  const stage = useViewer((s) => s.stage);
  const loading = useViewer((s) => s.loading);
  const panels = useViewer((s) => s.panels);
  const showStats = useViewer((s) => s.settings.stats);
  const hasAnimation = useViewer((s) => s.animation.duration > 0);
  const dragging = useFileDrop();
  useShortcuts();
  useInitialStage();

  // Side panels start closed on narrow screens, where they overlay the viewport.
  useEffect(() => {
    if (window.innerWidth < 1024) useViewer.setState({ panels: { hierarchy: false, inspector: false } });
  }, []);

  const asideClass = "flex min-h-0 shrink-0 flex-col bg-panel max-lg:absolute max-lg:inset-y-0 max-lg:z-30 max-lg:shadow-2xl max-lg:shadow-black/60";

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        {panels.hierarchy && (
          <aside className={cn(asideClass, "w-72 border-r border-line max-lg:left-0")}>
            <HierarchyPanel />
          </aside>
        )}
        <main className="viewport-bg relative min-w-0 flex-1 overflow-hidden">
          <Viewport />
          {stage && <ViewportToolbar />}
          {!stage && !loading && <EmptyState />}
          {stage && hasAnimation && <AnimationBar />}
          {showStats && stage && <RenderStatsOverlay />}
          {loading && <LoadingOverlay />}
          <ErrorToast />
        </main>
        {panels.inspector && (
          <aside className={cn(asideClass, "w-80 border-l border-line max-lg:right-0")}>
            <InspectorPanel />
          </aside>
        )}
      </div>
      {dragging && <DropOverlay />}
    </div>
  );
}
