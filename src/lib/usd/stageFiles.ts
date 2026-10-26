import type { LoadedStage } from "./loadStage";
import type { AssetSource } from "./sources";

export interface StageFiles {
  /** Path of the root layer among `entries` (the package itself for a .usdz). */
  root: string;
  entries: { path: string; bytes: Uint8Array }[];
}

/** The files a stage was composed from, read back from the viewer's source. */
export async function collectStageFiles(stage: LoadedStage, source: AssetSource, rootPath: string): Promise<StageFiles> {
  const paths = stage.rootFormat === "usdz" ? [rootPath] : [...stage.layers.keys()];
  const entries: { path: string; bytes: Uint8Array }[] = [];
  for (const path of paths) {
    const bytes = await source.read(path);
    if (bytes) entries.push({ path, bytes });
  }
  if (!entries.length) throw new Error("스테이지 파일을 읽지 못했습니다.");
  return { root: stage.rootFormat === "usdz" ? rootPath : stage.rootPath, entries };
}
