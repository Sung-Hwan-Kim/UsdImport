"use client";

import { Pause, Play, Repeat, SkipBack } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { useViewer } from "@/lib/store";
import { IconButton } from "./ui";

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export default function AnimationBar() {
  const animation = useViewer((s) => s.animation);
  const setAnimation = useViewer((s) => s.setAnimation);
  const fps = useViewer((s) => s.stage?.metadata.timeCodesPerSecond ?? 24);
  const clips = useViewer((s) => s.stage?.animations ?? []);
  const { playing, time, duration, speed, loop } = animation;

  return (
    <div className="absolute bottom-3 left-1/2 z-10 flex w-[min(640px,calc(100%-180px))] -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-panel/90 py-1 pr-2 pl-1 shadow-xl shadow-black/30 backdrop-blur-md max-sm:w-[calc(100%-24px)]">
      <IconButton
        icon={playing ? Pause : Play}
        label={playing ? "일시정지" : "재생"}
        shortcut="Space"
        onClick={() => setAnimation({ playing: !playing, time: !playing && time >= duration ? 0 : time })}
      />
      <IconButton icon={SkipBack} label="처음으로" onClick={() => setAnimation({ time: 0 })} className="max-sm:hidden" />
      <input
        type="range"
        className="slider min-w-0 flex-1"
        min={0}
        max={duration}
        step={0.001}
        value={time}
        aria-label="타임라인"
        onChange={(e) => setAnimation({ time: Number(e.target.value), playing: false })}
      />
      <span className="w-[92px] shrink-0 text-right font-mono text-[11px] text-fg tabular-nums">
        {time.toFixed(2)} / {duration.toFixed(2)}s
      </span>
      <span
        className="hidden w-[64px] shrink-0 font-mono text-[11px] text-faint tabular-nums md:inline"
        title={`${clips.length}개 클립: ${clips.map((c) => c.name).join(", ")}`}
      >
        F {formatNumber(time * fps, 0)}
      </span>
      <select
        value={speed}
        onChange={(e) => setAnimation({ speed: Number(e.target.value) })}
        aria-label="재생 속도"
        className="h-7 shrink-0 rounded-md border border-line bg-raised px-1 font-mono text-[11px] text-fg outline-none"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <IconButton icon={Repeat} label="반복" active={loop} onClick={() => setAnimation({ loop: !loop })} className="size-7" />
    </div>
  );
}
