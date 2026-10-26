"use client";

import { AlertTriangle, Atom, Boxes, ChevronDown, Pause, Play, RotateCcw, Square, StepForward } from "lucide-react";
import type { EngineKind } from "@/lib/physics/engine";
import { useViewer } from "@/lib/store";
import { cn, IconButton, MenuItem, Popover } from "./ui";

const SPEEDS = [0.25, 0.5, 1, 2];

const ENGINES: { value: EngineKind; label: string; hint: string }[] = [
  { value: "physx", label: "PhysX", hint: "브라우저 WASM · CPU" },
  { value: "newton", label: "Newton", hint: "로컬 Python 서버 · GPU" },
];

function EngineMenu() {
  const engine = useViewer((s) => s.settings.physicsEngine);
  const newtonUrl = useViewer((s) => s.settings.newtonUrl);
  const status = useViewer((s) => s.physics.status);
  const setSetting = useViewer((s) => s.setSetting);
  const physicsCommand = useViewer((s) => s.physicsCommand);
  const current = ENGINES.find((e) => e.value === engine) ?? ENGINES[0];

  const choose = (value: EngineKind) => {
    if (value === engine) return;
    // A loaded simulation belongs to the old engine; drop it and restore the stage.
    if (status !== "off") physicsCommand("stop");
    setSetting("physicsEngine", value);
  };

  return (
    <Popover
      side="top"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          title="물리 엔진"
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors",
            open ? "bg-accent-soft text-accent" : "text-fg hover:bg-hover",
          )}
        >
          <Atom className="size-4 text-accent" strokeWidth={1.75} />
          {current.label}
          <ChevronDown className="size-3 text-faint" />
        </button>
      )}
    >
      <div className="w-72">
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">물리 엔진</div>
        {ENGINES.map((e) => (
          <MenuItem key={e.value} active={e.value === engine} hint={e.hint} onClick={() => choose(e.value)}>
            {e.label}
          </MenuItem>
        ))}
        {engine === "newton" && (
          <label className="mt-1 block border-t border-line px-2.5 pt-2 pb-1.5">
            <span className="mb-1 block text-[11.5px] text-muted">Newton 서버 주소</span>
            <input
              value={newtonUrl}
              onChange={(e) => setSetting("newtonUrl", e.target.value)}
              spellCheck={false}
              className="h-8 w-full rounded-md border border-line-strong bg-bg px-2 font-mono text-[12px] text-fg outline-none focus:border-accent"
            />
            <span className="mt-1.5 block text-[11px] leading-relaxed text-faint">
              서버 설치·실행 방법은 <span className="font-mono">server/newton/README.md</span>를 참고하세요.
            </span>
          </label>
        )}
      </div>
    </Popover>
  );
}

function StatusText() {
  const physics = useViewer((s) => s.physics);
  const engine = useViewer((s) => s.settings.physicsEngine);
  const { status, description } = physics;

  if (status === "loading") {
    return (
      <span className="flex min-w-0 items-center gap-2 text-muted">
        <span className="inline-block size-3 shrink-0 animate-spin-slow rounded-full border-2 border-line-strong border-t-accent" />
        <span className="truncate">{engine === "newton" ? "Newton 서버에 연결하는 중…" : "PhysX 불러오는 중…"}</span>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-danger" title={physics.message ?? ""}>
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="truncate">{physics.message}</span>
      </span>
    );
  }
  if (status === "off" || !description) {
    return <span className="truncate text-faint">P 또는 ▶ 로 시작 · 시작 후 바디를 마우스로 끌어 잡기</span>;
  }
  const colliders = description.staticColliders.length + description.bodies.reduce((n, b) => n + b.colliders.length, 0);
  const cloths = description.deformables.filter((d) => d.kind === "surface").length;
  return (
    <span
      className="truncate text-muted"
      title={`${physics.label ?? ""}\n동적 바디나 천을 마우스로 끌어 잡을 수 있습니다 (일시정지 중이면 재생이 이어집니다)`}
    >
      <span className="text-fg">{physics.label}</span> · 바디 {description.bodies.length} · 콜라이더 {colliders} · 조인트{" "}
      {description.joints.length}
      {cloths > 0 && ` · 천 ${cloths}`}
    </span>
  );
}

function Warnings() {
  const warnings = useViewer((s) => s.physics.warnings);
  if (!warnings.length) return null;
  return (
    <Popover
      side="top"
      align="right"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          title="시뮬레이션 경고"
          className={cn("flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-warn", open ? "bg-warn/15" : "hover:bg-hover")}
        >
          <AlertTriangle className="size-3.5" />
          {warnings.length}
        </button>
      )}
    >
      <div className="max-h-64 w-80 space-y-1.5 overflow-y-auto p-1.5 text-[12px] leading-relaxed text-muted">
        {warnings.map((w) => (
          <div key={w} className="break-all">
            {w}
          </div>
        ))}
      </div>
    </Popover>
  );
}

/** Play/pause/step/reset for UsdPhysics simulation; shown for stages with physics. */
export default function PhysicsBar({ raised }: { raised: boolean }) {
  const status = useViewer((s) => s.physics.status);
  const time = useViewer((s) => s.physics.time);
  const speed = useViewer((s) => s.physics.speed);
  const showColliders = useViewer((s) => s.settings.showColliders);
  const setSetting = useViewer((s) => s.setSetting);
  const setPhysics = useViewer((s) => s.setPhysics);
  const physicsCommand = useViewer((s) => s.physicsCommand);
  const running = status === "running";
  const loading = status === "loading";
  const loaded = running || status === "paused";

  return (
    <div
      className={cn(
        "absolute left-1/2 z-10 flex w-[min(680px,calc(100%-180px))] -translate-x-1/2 items-center gap-1 rounded-lg border border-line bg-panel/90 py-1 pr-1.5 pl-1 shadow-xl shadow-black/30 backdrop-blur-md max-sm:w-[calc(100%-24px)]",
        raised ? "bottom-[3.75rem]" : "bottom-3",
      )}
    >
      <EngineMenu />
      <div className="mx-0.5 h-5 w-px bg-line" />
      <IconButton
        icon={running ? Pause : Play}
        label={running ? "물리 일시정지" : "물리 재생"}
        shortcut="P"
        disabled={loading}
        active={running}
        onClick={() => physicsCommand(running ? "pause" : "play")}
      />
      <IconButton icon={StepForward} label="한 프레임 진행" disabled={loading || running} onClick={() => physicsCommand("step")} />
      <IconButton icon={RotateCcw} label="처음 상태로" shortcut="Shift+R" disabled={!loaded} onClick={() => physicsCommand("reset")} />
      <IconButton
        icon={Square}
        label="물리 끄기 (원래 장면으로)"
        disabled={status === "off" || loading}
        onClick={() => physicsCommand("stop")}
        className="max-sm:hidden"
      />
      <div className="mx-1.5 flex min-w-0 flex-1 text-[11.5px]">
        <StatusText />
      </div>
      <span className="w-[62px] shrink-0 text-right font-mono text-[11px] text-fg tabular-nums">{time.toFixed(2)}s</span>
      <select
        value={speed}
        onChange={(e) => setPhysics({ speed: Number(e.target.value) })}
        aria-label="시뮬레이션 속도"
        className="h-7 shrink-0 rounded-md border border-line bg-raised px-1 font-mono text-[11px] text-fg outline-none"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <Warnings />
      <IconButton
        icon={Boxes}
        label="콜라이더 표시"
        active={showColliders}
        onClick={() => setSetting("showColliders", !showColliders)}
        className="size-7"
      />
    </div>
  );
}
