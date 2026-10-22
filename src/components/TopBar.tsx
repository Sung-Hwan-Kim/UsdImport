"use client";

import { Camera, CircleHelp, FileUp, FolderOpen, Layers, PanelLeft, PanelRight } from "lucide-react";
import { pickLocalFiles } from "@/lib/files";
import { formatCount } from "@/lib/format";
import { SAMPLES, sampleUrl } from "@/lib/samples";
import { useViewer } from "@/lib/store";
import Logo from "./Logo";
import { Badge, Button, IconButton, Kbd, Popover } from "./ui";

export function saveScreenshot() {
  const { canvas, stage } = useViewer.getState();
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${stage?.name.replace(/\.[^.]+$/, "") ?? "usd-viewer"}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
}

export function SamplesMenu({ align = "right" }: { align?: "left" | "right" }) {
  const openUrl = useViewer((s) => s.openUrl);
  return (
    <Popover
      align={align}
      trigger={({ toggle, open }) => (
        <Button icon={Layers} variant="ghost" onClick={toggle} className={open ? "bg-hover text-fg" : ""}>
          샘플
        </Button>
      )}
    >
      {(close) => (
        <div className="w-80">
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">샘플 스테이지</div>
          {SAMPLES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                close();
                openUrl(sampleUrl(s));
              }}
              className="flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-fg">{s.title}</div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{s.description}</div>
              </div>
              <Badge tone="accent">{s.format}</Badge>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

const SHORTCUTS: [string, string][] = [
  ["F", "선택 항목(또는 전체) 포커스"],
  ["A", "전체 보기 · 카메라 리셋"],
  ["H / Alt+H", "선택 숨기기 / 모두 표시"],
  ["Esc", "선택 해제"],
  ["1 – 4", "PBR · Clay · Normals · Wireframe"],
  ["G / L / R", "그리드 · USD 라이트 · 자동 회전"],
  ["Space", "애니메이션 재생/정지"],
  ["↑ ↓ ← →", "계층 트리 탐색"],
];

function HelpMenu() {
  return (
    <Popover align="right" trigger={({ toggle, open }) => <IconButton icon={CircleHelp} label="도움말" active={open} onClick={toggle} />}>
      <div className="w-80 p-1.5">
        <div className="pb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">단축키</div>
        <div className="space-y-1.5">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="text-fg/90">{d}</span>
              <span className="flex shrink-0 gap-1">
                {k.split(" / ").map((p) => (
                  <Kbd key={p}>{p}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-line pt-2.5 text-[12px] leading-relaxed text-muted">
          마우스: 왼쪽 드래그 회전 · 오른쪽 드래그 이동 · 휠 줌 · 더블클릭 포커스.
          <br />
          지원: USDA/USDC/USDZ, references·payload·subLayers·variants, PreviewSurface 머티리얼, 텍스처, GeomSubset, UsdSkel, 트랜스폼
          애니메이션, UsdLux 라이트.
        </div>
      </div>
    </Popover>
  );
}

export default function TopBar() {
  const stage = useViewer((s) => s.stage);
  const panels = useViewer((s) => s.panels);
  const togglePanel = useViewer((s) => s.togglePanel);
  const openFiles = useViewer((s) => s.openFiles);

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2">
      <IconButton icon={PanelLeft} label="계층 패널" active={panels.hierarchy} onClick={() => togglePanel("hierarchy")} />
      <div className="flex items-center gap-2 pr-1 pl-1.5 text-accent">
        <Logo />
        <span className="text-[14px] font-semibold tracking-tight whitespace-nowrap text-fg max-[380px]:hidden">USD Viewer</span>
      </div>
      {stage && (
        <div className="ml-2 hidden min-w-0 items-center gap-2 border-l border-line pl-3 md:flex">
          <span className="truncate text-[13px] text-fg" title={stage.rootPath}>
            {stage.name}
          </span>
          <Badge tone="accent">{stage.rootFormat.toUpperCase()}</Badge>
          <span className="hidden font-mono text-[11.5px] whitespace-nowrap text-faint xl:inline">
            {formatCount(stage.stats.meshes)} meshes · {formatCount(stage.stats.triangles)} tris
          </span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <SamplesMenu />
        <Button icon={FolderOpen} onClick={() => pickLocalFiles(true).then(openFiles)} className="max-sm:hidden">
          폴더 열기
        </Button>
        <Button icon={FileUp} variant="primary" onClick={() => pickLocalFiles(false).then(openFiles)}>
          <span className="hidden sm:inline">파일 열기</span>
        </Button>
        <div className="mx-1 h-5 w-px bg-line" />
        <IconButton icon={Camera} label="스크린샷 저장 (PNG)" onClick={saveScreenshot} disabled={!stage} />
        <HelpMenu />
        <IconButton icon={PanelRight} label="속성 패널" active={panels.inspector} onClick={() => togglePanel("inspector")} />
      </div>
    </header>
  );
}
