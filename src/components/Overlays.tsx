"use client";

import { AlertTriangle, FileUp, FolderOpen, Upload, X } from "lucide-react";
import { useState } from "react";
import { pickLocalFiles } from "@/lib/files";
import { formatCount, formatNumber } from "@/lib/format";
import { useRenderInfo } from "@/lib/renderInfo";
import { SAMPLES, sampleUrl } from "@/lib/samples";
import { useViewer } from "@/lib/store";
import { isLayerFile } from "@/lib/usd/paths";
import Logo from "./Logo";
import { Badge, Button } from "./ui";

export function EmptyState() {
  const openFiles = useViewer((s) => s.openFiles);
  const openUrl = useViewer((s) => s.openUrl);
  return (
    <div className="scroll-thin absolute inset-0 z-10 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-[680px] animate-fade-in">
          <div className="rounded-2xl border border-dashed border-line-strong bg-panel/40 px-6 py-9 text-center backdrop-blur-sm">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <Logo className="size-7" />
            </div>
            <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-fg">USD 파일을 여기에 드롭하세요</h1>
            <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">
              <span className="font-mono text-[12.5px] text-fg/80">.usd · .usda · .usdc · .usdz</span> 를 지원합니다. 다른 레이어나 텍스처를
              참조하는 스테이지는 폴더째 드롭하면 함께 해석됩니다.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button icon={FileUp} variant="primary" onClick={() => pickLocalFiles(false).then(openFiles)}>
                파일 열기
              </Button>
              <Button icon={FolderOpen} onClick={() => pickLocalFiles(true).then(openFiles)}>
                폴더 열기
              </Button>
            </div>
          </div>

          <div className="mt-8">
            <div className="mb-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase">샘플 스테이지</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {SAMPLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => openUrl(sampleUrl(s))}
                  className="group rounded-lg border border-line bg-panel/70 p-3 text-left transition-colors hover:border-accent/50 hover:bg-raised"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">{s.title}</span>
                    <Badge tone="accent">{s.format}</Badge>
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-snug text-muted">{s.description}</p>
                  <p className="mt-2 truncate font-mono text-[10.5px] text-faint group-hover:text-muted">{s.file}</p>
                </button>
              ))}
            </div>
          </div>
          <p className="mt-6 text-center text-[11.5px] text-faint">파일은 브라우저 안에서만 처리되며 어디에도 업로드되지 않습니다.</p>
        </div>
      </div>
    </div>
  );
}

export function LoadingOverlay() {
  const progress = useViewer((s) => s.progress);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/55 backdrop-blur-[2px]">
      <div className="flex max-w-[80%] animate-fade-in items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 shadow-2xl">
        <span className="inline-block size-4 shrink-0 animate-spin-slow rounded-full border-2 border-line-strong border-t-accent" />
        <span className="truncate text-[13px] text-fg">{progress || "불러오는 중…"}</span>
      </div>
    </div>
  );
}

export function ErrorToast() {
  const error = useViewer((s) => s.error);
  const clearError = useViewer((s) => s.clearError);
  if (!error) return null;
  return (
    <div
      role="alert"
      className="absolute bottom-3 left-3 z-30 flex max-w-[min(480px,calc(100%-24px))] animate-fade-in items-start gap-2.5 rounded-lg border border-danger/40 bg-panel px-3.5 py-3 shadow-2xl"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">스테이지를 열 수 없습니다</div>
        <div className="mt-0.5 text-[12px] break-words text-muted">{error}</div>
      </div>
      <button type="button" onClick={clearError} className="text-faint hover:text-fg" aria-label="닫기">
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * A root opened on its own cannot reach the layers it references: browsers
 * only hand over the files that were picked. Say so where it shows, since the
 * stage then draws little or nothing.
 */
export function MissingLayersNotice() {
  const stage = useViewer((s) => s.stage);
  const openFiles = useViewer((s) => s.openFiles);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Shallow paths first: a root's own references before deeper (often variant) payloads.
  const layers = (stage?.missing.filter(isLayerFile) ?? []).sort((a, b) => a.split("/").length - b.split("/").length);
  if (!stage || !layers.length || dismissed === stage.id) return null;
  return (
    <div
      role="status"
      className="absolute top-16 left-3 z-10 flex max-w-[min(440px,calc(100%-24px))] animate-fade-in items-start gap-2.5 rounded-lg border border-warn/40 bg-panel/95 px-3.5 py-3 shadow-2xl backdrop-blur"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">참조한 레이어 {layers.length}개를 찾지 못했습니다</div>
        <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted" title={layers.join("\n")}>
          {layers[0]}
          {layers.length > 1 && <span className="font-sans"> 외 {layers.length - 1}개</span>}
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          브라우저는 직접 고른 파일만 읽을 수 있습니다. 이 파일이 들어 있는 폴더를 열거나 폴더째 끌어다 놓으세요.
        </p>
        <Button icon={FolderOpen} className="mt-2.5" onClick={() => pickLocalFiles(true).then(openFiles)}>
          폴더 열기
        </Button>
      </div>
      <button type="button" onClick={() => setDismissed(stage.id)} className="text-faint hover:text-fg" aria-label="닫기">
        <X className="size-4" />
      </button>
    </div>
  );
}

export function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6 backdrop-blur-sm">
      <div className="flex h-full w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-accent-soft">
        <Upload className="size-10 text-accent" strokeWidth={1.5} />
        <div className="mt-3 text-[17px] font-semibold text-fg">드롭하여 열기</div>
        <div className="mt-1 text-[13px] text-muted">USD 파일, 텍스처 또는 폴더 전체</div>
      </div>
    </div>
  );
}

export function RenderStatsOverlay() {
  const info = useRenderInfo();
  const rows: [string, string][] = [
    ["FPS", formatNumber(info.fps, 0)],
    ["Frame", `${info.frameMs.toFixed(1)} ms`],
    ["Draw calls", formatCount(info.calls)],
    ["Triangles", formatCount(info.triangles)],
    ["Geometries", formatCount(info.geometries)],
    ["Textures", formatCount(info.textures)],
  ];
  return (
    <div className="pointer-events-none absolute top-16 right-3 z-10 w-40 rounded-md border border-line bg-panel/85 px-2.5 py-2 font-mono text-[11px] backdrop-blur">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between leading-5">
          <span className="text-faint">{k}</span>
          <span className="text-fg tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}
