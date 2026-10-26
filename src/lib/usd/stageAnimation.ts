import { AnimationMixer } from "three";
import type { PhysicsStatus } from "../store";
import type { LoadedStage } from "./loadStage";

// One mixer per stage, shared by the viewport's animation playback and the
// physics runner (which poses kinematic bodies at each simulation step).
const mixers = new WeakMap<LoadedStage, AnimationMixer>();

function mixerOf(stage: LoadedStage): AnimationMixer | null {
  if (!stage.animations.length) return null;
  let mixer = mixers.get(stage);
  if (!mixer) {
    mixer = new AnimationMixer(stage.scene);
    for (const clip of stage.animations) mixer.clipAction(clip).play();
    mixers.set(stage, mixer);
  }
  return mixer;
}

/**
 * Pose every clip at timeline time `t` (seconds, time code / timeCodesPerSecond).
 * Past a clip's end it holds its last pose, as USD holds the last time sample
 * (mixer.setTime would wrap the clip back to its start).
 */
export function poseStageAt(stage: LoadedStage, t: number): void {
  const mixer = mixerOf(stage);
  if (!mixer) return;
  for (const clip of stage.animations) {
    const action = mixer.existingAction(clip);
    if (action) action.time = Math.min(t, clip.duration);
  }
  mixer.update(0);
}

/** Stop the stage's clips and drop its mixer. */
export function releaseStageAnimation(stage: LoadedStage): void {
  const mixer = mixers.get(stage);
  if (!mixer) return;
  mixer.stopAllAction();
  mixer.uncacheRoot(stage.scene);
  mixers.delete(stage);
}

/** Timeline time of the stage's start time code, where simulations begin. */
export function timelineStart(stage: LoadedStage): number {
  return (stage.metadata.startTimeCode ?? 0) / stage.metadata.timeCodesPerSecond;
}

/**
 * While a simulation is loaded its clock drives the timeline, as Isaac Sim's
 * Play does: animated kinematic bodies and time-sampled drive targets follow it.
 */
export function simulationDrivesTimeline(status: PhysicsStatus): boolean {
  return status === "running" || status === "paused";
}
