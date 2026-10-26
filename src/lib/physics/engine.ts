import type { Object3D, Quaternion, Vector3 } from "three";
import type { LoadedStage } from "../usd/loadStage";
import type { PhysicsDescription } from "./schema";

export type EngineKind = "physx" | "newton";

/**
 * Space poses are reported in. "world" is the viewer's world (metres, Y-up);
 * "stage" is the USD stage's own frame and units, below the stage root transform.
 */
export type PoseFrame = "world" | "stage";

/** A simulated cloth mesh: one particle per USD mesh point, in point order. */
export interface ClothBinding {
  object: Object3D;
  /** First particle and particle count in `readParticles()`. */
  start: number;
  count: number;
}

export interface EngineLoadResult {
  /** Simulated bodies, in the order poses are reported. */
  bodies: Object3D[];
  /** Kinematic bodies follow their animated pose instead of the simulation. */
  kinematic: boolean[];
  cloths: ClothBinding[];
  frame: PoseFrame;
  /** Fixed simulation step in seconds. */
  dt: number;
  /** Short description for the UI, e.g. "PhysX 5.11 · CPU". */
  label: string;
  warnings: string[];
}

export interface EngineEvents {
  /** Remote engines report connection/simulation state changes here. */
  onStatus?(state: "playing" | "paused"): void;
  onError?(message: string): void;
}

/**
 * A physics backend. Local engines are stepped by the viewer's fixed-timestep
 * loop (`advance`); remote engines run on their own clock and stream poses.
 */
export interface PhysicsEngine {
  readonly kind: EngineKind;
  readonly remote: boolean;
  load(stage: LoadedStage, description: PhysicsDescription): Promise<EngineLoadResult>;
  /** Local engines: advance one fixed step. */
  advance(): void;
  /** Remote engines: start or stop the server clock. */
  setRunning(running: boolean): void;
  /** Remote engines: advance one frame while paused. */
  stepFrame(): void;
  setSpeed(speed: number): void;
  /** Back to the initial state, paused. */
  reset(): Promise<void>;
  /** Latest poses, 7 floats per body (px, py, pz, qx, qy, qz, qw) in the load result's frame. */
  readPoses(): Float32Array | null;
  /** Latest cloth particle positions, 3 floats each, in the load result's frame. */
  readParticles(): Float32Array | null;
  /** Simulated time in seconds. */
  time(): number;
  setKinematicPose(index: number, position: Vector3, quaternion: Quaternion): void;
  /** `local` is the grab point in the body frame, `target` a point in the pose frame. */
  beginDrag(index: number, local: Vector3, target: Vector3): void;
  updateDrag(target: Vector3): void;
  /** Hold a cloth particle at `target` (pose frame) until `endDrag`. */
  dragParticle(index: number, target: Vector3): void;
  endDrag(): void;
  dispose(): void;
}
