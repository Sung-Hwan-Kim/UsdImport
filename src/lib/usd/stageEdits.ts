import { stagePathOf } from "../scene";
import { getPrimTag } from "./composer";
import type { LoadedStage } from "./loadStage";
import type { PrimEdit } from "./sdf/edits";

let simulationEdits: (() => PrimEdit[]) | null = null;

/** The physics runner reports the running simulation's state through this. */
export function setSimulationEditsProvider(provider: (() => PrimEdit[]) | null): void {
  simulationEdits = provider;
}

export interface StageEdits {
  edits: PrimEdit[];
  poses: number;
  visibility: number;
  cloths: number;
}

/** Everything the viewer changed since the stage loaded, as edits to author when saving. */
export function collectStageEdits(stage: LoadedStage): StageEdits {
  const byPath = new Map<string, PrimEdit>();
  const merge = (edit: PrimEdit) => byPath.set(edit.path, { ...byPath.get(edit.path), ...edit });
  let visibility = 0;
  stage.scene.traverse((obj) => {
    if (obj === stage.scene || obj.userData.internal || !getPrimTag(obj)) return;
    if (obj.userData.loadedVisible === undefined || obj.visible === obj.userData.loadedVisible) return;
    merge({ path: stagePathOf(obj), visibility: obj.visible ? "inherited" : "invisible" });
    visibility++;
  });
  let poses = 0;
  let cloths = 0;
  for (const edit of simulationEdits?.() ?? []) {
    merge(edit);
    if (edit.matrix) poses++;
    if (edit.points) cloths++;
  }
  return { edits: [...byPath.values()], poses, visibility, cloths };
}
