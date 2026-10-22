import { useSyncExternalStore } from "react";

export interface RenderInfo {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

let current: RenderInfo = { fps: 0, frameMs: 0, calls: 0, triangles: 0, geometries: 0, textures: 0 };
const listeners = new Set<() => void>();

export function publishRenderInfo(info: RenderInfo): void {
  current = info;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Render statistics sampled inside the Canvas, readable from DOM overlays. */
export function useRenderInfo(): RenderInfo {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
