"use client";

import { Axis3d, Eclipse, Gauge, Grid3x3, Lightbulb, Maximize, Rotate3d, Sun } from "lucide-react";
import type { Shading } from "@/lib/scene";
import { useViewer, type EnvironmentPreset, type UpAxisMode } from "@/lib/store";
import { cn, IconButton, MenuItem, Popover, Segmented, Slider, Switch } from "./ui";

const SHADING: { value: Shading; label: string; title: string }[] = [
  { value: "pbr", label: "PBR", title: "USD 머티리얼 (1)" },
  { value: "clay", label: "Clay", title: "단색 클레이 (2)" },
  { value: "normals", label: "Normal", title: "노멀 시각화 (3)" },
  { value: "wireframe", label: "Wire", title: "와이어프레임 (4)" },
];

const ENVIRONMENTS: { value: EnvironmentPreset; label: string; hint?: string }[] = [
  { value: "room", label: "Studio Room", hint: "내장" },
  { value: "studio", label: "Studio", hint: "HDRI" },
  { value: "city", label: "City", hint: "HDRI" },
  { value: "warehouse", label: "Warehouse", hint: "HDRI" },
  { value: "apartment", label: "Apartment", hint: "HDRI" },
  { value: "sunset", label: "Sunset", hint: "HDRI" },
  { value: "dawn", label: "Dawn", hint: "HDRI" },
  { value: "park", label: "Park", hint: "HDRI" },
  { value: "night", label: "Night", hint: "HDRI" },
  { value: "none", label: "없음 (기본 조명)" },
];

function Divider() {
  return <div className="mx-0.5 h-5 w-px bg-line" />;
}

function EnvironmentMenu() {
  const settings = useViewer((s) => s.settings);
  const setSetting = useViewer((s) => s.setSetting);
  return (
    <Popover align="center" trigger={({ toggle, open }) => <IconButton icon={Sun} label="환경 · 조명" active={open} onClick={toggle} />}>
      <div className="w-64">
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">환경맵</div>
        <div className="max-h-56 overflow-y-auto">
          {ENVIRONMENTS.map((env) => (
            <MenuItem
              key={env.value}
              active={settings.environment === env.value}
              hint={env.hint}
              onClick={() => setSetting("environment", env.value)}
            >
              {env.label}
            </MenuItem>
          ))}
        </div>
        <div className="my-1.5 h-px bg-line" />
        <Slider
          label="환경 강도"
          value={settings.environmentIntensity}
          min={0}
          max={3}
          step={0.05}
          onChange={(v) => setSetting("environmentIntensity", v)}
        />
        <Slider label="노출" value={settings.exposure} min={0.2} max={3} step={0.05} onChange={(v) => setSetting("exposure", v)} />
        <Switch label="환경맵을 배경으로" checked={settings.environmentBackground} onChange={(v) => setSetting("environmentBackground", v)} />
        <Switch label="그림자" checked={settings.shadows} onChange={(v) => setSetting("shadows", v)} />
      </div>
    </Popover>
  );
}

function UpAxisMenu() {
  const upAxis = useViewer((s) => s.settings.upAxis);
  const authored = useViewer((s) => s.stage?.metadata.upAxis ?? "Y");
  const setSetting = useViewer((s) => s.setSetting);
  const options: { value: UpAxisMode; label: string }[] = [
    { value: "auto", label: `자동 (스테이지: ${authored})` },
    { value: "Y", label: "Y-up 강제" },
    { value: "Z", label: "Z-up 강제" },
  ];
  const current = upAxis === "auto" ? authored : upAxis;
  return (
    <Popover
      align="center"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          title="Up 축"
          onClick={toggle}
          className={cn(
            "h-8 rounded-md px-2 font-mono text-[11.5px] whitespace-nowrap transition-colors",
            open || upAxis !== "auto" ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          {current}-up
        </button>
      )}
    >
      {(close) => (
        <div className="w-52">
          {options.map((o) => (
            <MenuItem
              key={o.value}
              active={upAxis === o.value}
              onClick={() => {
                setSetting("upAxis", o.value);
                close();
              }}
            >
              {o.label}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

export default function ViewportToolbar() {
  const settings = useViewer((s) => s.settings);
  const setSetting = useViewer((s) => s.setSetting);
  const requestFocus = useViewer((s) => s.requestFocus);
  const lights = useViewer((s) => s.stage?.stats.lights ?? 0);

  return (
    <div className="absolute top-3 left-1/2 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-lg border border-line bg-panel/85 p-1 shadow-xl shadow-black/30 backdrop-blur-md">
      <Segmented value={settings.shading} options={SHADING} onChange={(v) => setSetting("shading", v)} />
      <Divider />
      <IconButton icon={Grid3x3} label="그리드" shortcut="G" active={settings.grid} onClick={() => setSetting("grid", !settings.grid)} />
      <IconButton
        icon={Axis3d}
        label="원점 축"
        active={settings.axes}
        onClick={() => setSetting("axes", !settings.axes)}
        className="max-sm:hidden"
      />
      <IconButton icon={Eclipse} label="그림자" active={settings.shadows} onClick={() => setSetting("shadows", !settings.shadows)} />
      <IconButton
        icon={Lightbulb}
        label={lights ? `USD 라이트 (${lights})` : "USD 라이트 없음"}
        shortcut="L"
        active={settings.sceneLights && lights > 0}
        disabled={!lights}
        onClick={() => setSetting("sceneLights", !settings.sceneLights)}
      />
      <IconButton
        icon={Rotate3d}
        label="자동 회전"
        shortcut="R"
        active={settings.autoRotate}
        onClick={() => setSetting("autoRotate", !settings.autoRotate)}
      />
      <Divider />
      <EnvironmentMenu />
      <UpAxisMenu />
      <IconButton
        icon={Gauge}
        label="렌더 통계"
        active={settings.stats}
        onClick={() => setSetting("stats", !settings.stats)}
        className="max-sm:hidden"
      />
      <IconButton icon={Maximize} label="전체 보기" shortcut="A" onClick={() => requestFocus("stage", true)} />
    </div>
  );
}
