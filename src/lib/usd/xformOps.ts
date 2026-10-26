import {
  Euler,
  Matrix4,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type KeyframeTrack,
} from "three";

/** One attribute's time samples, with times in seconds. */
export interface XformSamples {
  times: number[];
  values: unknown[];
}

/** A prim's composed xformOp opinions: the op order and the op values. */
export interface XformOpinions {
  /** `xformOpOrder`, or undefined when no layer authored one. */
  order: string[] | undefined;
  /** `xformOp:*` attribute values by full name (e.g. `xformOp:scale:pivot`). */
  values: Record<string, unknown>;
  /** Time samples of the `xformOp:*` attributes whose strongest opinion has them. */
  samples: Record<string, XformSamples>;
}

export interface EvaluatedXform {
  matrix: Matrix4;
  /** `!resetXformStack!`: the prim ignores its ancestors' transforms. */
  resetsXformStack: boolean;
  /** The values of the one scale op, if there is exactly one (to keep its signs). */
  scale: [number, number, number] | null;
  /** Ops in the order this viewer cannot evaluate. */
  unsupported: string[];
}

const RESET_XFORM_STACK = "!resetXformStack!";
const INVERT = "!invert!";
const DEG = Math.PI / 180;

export function xformOpinionsOf(data: Record<string, unknown>, samples: Record<string, XformSamples> = {}): XformOpinions {
  const order = data.xformOpOrder;
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    if (name.startsWith("xformOp:") && value !== undefined && value !== null) values[name] = value;
  }
  return { order: Array.isArray(order) ? order.map(String) : undefined, values, samples: { ...samples } };
}

/**
 * Compose `stronger` over `weaker` per attribute, as USD does across a
 * reference: the strongest opinion brings its default and its samples alike.
 */
export function mergeXformOpinions(stronger: XformOpinions, weaker: XformOpinions): XformOpinions {
  const samples = { ...weaker.samples };
  for (const name of Object.keys(stronger.values)) delete samples[name];
  return {
    order: stronger.order ?? weaker.order,
    values: { ...weaker.values, ...stronger.values },
    samples: { ...samples, ...stronger.samples },
  };
}

function numbersOf(value: unknown): number[] | null {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flat(2).map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  return null;
}

/** The matrix of one op, or null when the op type is unknown or its value is malformed. */
function opMatrix(type: string, v: number[], out: Matrix4): Matrix4 | null {
  switch (type) {
    case "translate":
      return v.length >= 3 ? out.makeTranslation(v[0], v[1], v[2]) : null;
    case "translateX":
      return out.makeTranslation(v[0], 0, 0);
    case "translateY":
      return out.makeTranslation(0, v[0], 0);
    case "translateZ":
      return out.makeTranslation(0, 0, v[0]);
    case "scale":
      return v.length >= 3 ? out.makeScale(v[0], v[1], v[2]) : null;
    case "scaleX":
      return out.makeScale(v[0], 1, 1);
    case "scaleY":
      return out.makeScale(1, v[0], 1);
    case "scaleZ":
      return out.makeScale(1, 1, v[0]);
    case "rotateX":
      return out.makeRotationX(v[0] * DEG);
    case "rotateY":
      return out.makeRotationY(v[0] * DEG);
    case "rotateZ":
      return out.makeRotationZ(v[0] * DEG);
    case "orient":
      // Parsed quaternions are (x, y, z, w).
      return v.length >= 4 ? out.makeRotationFromQuaternion(new Quaternion(v[0], v[1], v[2], v[3]).normalize()) : null;
    case "transform":
      // USD matrices are row-major with row vectors: transpose into three's convention.
      return v.length >= 16 ? out.fromArray(v) : null;
  }
  // rotateXYZ etc.: values are always (x, y, z) degrees; the name gives the order
  // the rotations apply in, which is the reverse of three's Euler order string.
  const order = /^rotate([XYZ]{3})$/.exec(type)?.[1];
  if (!order || new Set(order).size !== 3 || v.length < 3) return null;
  const euler = new Euler(v[0] * DEG, v[1] * DEG, v[2] * DEG, [...order].reverse().join("") as Euler["order"]);
  return out.makeRotationFromEuler(euler);
}

/**
 * Evaluate the ops named in xformOpOrder, as UsdGeomXformable does: the first
 * op is outermost, suffixed ops (`xformOp:scale:pivot`) are ops like any other,
 * `!invert!` inverts an op, and ops left out of the order (or with no order at
 * all) do not apply.
 */
export function evaluateXformOps(xform: XformOpinions): EvaluatedXform {
  const result: EvaluatedXform = { matrix: new Matrix4(), resetsXformStack: false, scale: null, unsupported: [] };
  const order = xform.order ?? [];
  const reset = order.lastIndexOf(RESET_XFORM_STACK);
  result.resetsXformStack = reset >= 0;
  const op = new Matrix4();
  let scaleOps = 0;
  for (const entry of order.slice(reset + 1)) {
    const inverted = entry.startsWith(INVERT);
    const name = inverted ? entry.slice(INVERT.length) : entry;
    const type = name.split(":")[1] ?? "";
    // An op with no value contributes nothing, as in USD.
    const value = numbersOf(xform.values[name]);
    if (!value) continue;
    if (!opMatrix(type, value, op)) {
      result.unsupported.push(entry);
      continue;
    }
    if (inverted) op.invert();
    result.matrix.multiply(op);
    if (type.startsWith("scale")) {
      scaleOps++;
      result.scale = type === "scale" && !inverted ? [value[0], value[1], value[2]] : null;
    }
  }
  if (scaleOps !== 1) result.scale = null;
  return result;
}

const rotation = new Matrix4();

/**
 * Set an object's position/quaternion/scale from an evaluated xform.
 * decompose() folds negative scales into the rotation; when the authored scale
 * explains the matrix (a rotation times that scale) keep its signs instead, so
 * scale animation and the inspector see the authored values.
 */
export function setFromXform(obj: Object3D, { matrix, scale }: EvaluatedXform): void {
  matrix.decompose(obj.position, obj.quaternion, obj.scale);
  if (!scale || !scale.some((s) => s < 0) || scale.some((s) => s === 0)) return;
  const e = matrix.elements;
  const r = rotation.elements;
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) r[col * 4 + row] = e[col * 4 + row] / scale[col];
  const dot = (a: number, b: number) => r[a * 4] * r[b * 4] + r[a * 4 + 1] * r[b * 4 + 1] + r[a * 4 + 2] * r[b * 4 + 2];
  const orthonormal =
    Math.abs(dot(0, 0) - 1) < 1e-4 && Math.abs(dot(1, 1) - 1) < 1e-4 && Math.abs(dot(2, 2) - 1) < 1e-4 &&
    Math.abs(dot(0, 1)) < 1e-4 && Math.abs(dot(0, 2)) < 1e-4 && Math.abs(dot(1, 2)) < 1e-4;
  if (!orthonormal || rotation.determinant() <= 0) return;
  obj.quaternion.setFromRotationMatrix(rotation);
  obj.scale.set(scale[0], scale[1], scale[2]);
}

/**
 * At most this many degrees between keys while a rotate op spins: keys only
 * hold orientations, and a spin may swing a translation around (pivots).
 */
const MAX_ROTATION_STEP = 2;
/** How often an interval may be halved where interpolating the keys strays from the ops. */
const MAX_REFINE_DEPTH = 6;
const POSITION_TOLERANCE = 1e-4;
/** 1 - |cos(θ/2)| for θ ≈ 0.05°. */
const ROTATION_TOLERANCE = 1e-7;

interface SampledOp {
  name: string;
  type: string;
  samples: XformSamples;
}

interface Pose {
  time: number;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

/** An op's value at `time`, interpolated as USD does: linearly, quaternions by slerp, held past the ends. */
function sampleAt(op: SampledOp, time: number): number[] | null {
  const { times, values } = op.samples;
  let lo = 0;
  let hi = times.length - 1;
  if (time <= times[lo]) return numbersOf(values[lo]);
  if (time >= times[hi]) return numbersOf(values[hi]);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const a = numbersOf(values[lo]);
  const b = numbersOf(values[hi]);
  if (!a || !b || a.length !== b.length) return a;
  const f = (time - times[lo]) / (times[hi] - times[lo]);
  if (op.type === "orient" && a.length >= 4) {
    const q = new Quaternion(a[0], a[1], a[2], a[3]).slerp(new Quaternion(b[0], b[1], b[2], b[3]), f);
    return [q.x, q.y, q.z, q.w];
  }
  return a.map((v, i) => v + (b[i] - v) * f);
}

/** Segments an interval needs so no rotate op turns more than MAX_ROTATION_STEP within one. */
function rotationSteps(ops: SampledOp[], t0: number, t1: number): number {
  let steps = 1;
  for (const op of ops) {
    if (!op.type.startsWith("rotate")) continue;
    const a = sampleAt(op, t0);
    const b = sampleAt(op, t1);
    if (!a || !b) continue;
    for (let i = 0; i < a.length; i++) {
      // three's USDA parser pads vectors with NaN.
      const turn = Math.abs(b[i] - a[i]);
      if (Number.isFinite(turn)) steps = Math.max(steps, Math.ceil(turn / MAX_ROTATION_STEP));
    }
  }
  return Math.min(steps, 360);
}

const midPosition = new Vector3();
const midQuaternion = new Quaternion();

/** Whether interpolating between two keys, as three's tracks do, reproduces `mid`. */
function interpolates(a: Pose, b: Pose, mid: Pose): boolean {
  const tolerance = (v: Vector3) => POSITION_TOLERANCE * Math.max(1, v.length());
  if (midPosition.lerpVectors(a.position, b.position, 0.5).distanceTo(mid.position) > tolerance(mid.position)) return false;
  if (midPosition.lerpVectors(a.scale, b.scale, 0.5).distanceTo(mid.scale) > tolerance(mid.scale)) return false;
  return 1 - Math.abs(midQuaternion.slerpQuaternions(a.quaternion, b.quaternion, 0.5).dot(mid.quaternion)) <= ROTATION_TOLERANCE;
}

/**
 * Keyframe tracks (position, quaternion, scale) that play a prim's
 * time-sampled xformOps, or none when no op in its order is time-sampled.
 * Each key evaluates the whole op stack, so any op type and order animates.
 * Keys sit at every authored sample time, plus where interpolating the keys
 * would stray from the ops (spins, pivots, matrix samples), down to one time
 * code (`frame` seconds) apart. `parentInverse` re-bases each key, as
 * applyResetXformStacks does for the rest pose.
 */
export function xformTracks(node: string, xform: XformOpinions, frame: number, parentInverse?: Matrix4): KeyframeTrack[] {
  const order = xform.order ?? [];
  const names = new Set(order.slice(order.lastIndexOf(RESET_XFORM_STACK) + 1).map((e) => (e.startsWith(INVERT) ? e.slice(INVERT.length) : e)));
  const ops: SampledOp[] = [];
  for (const name of names) {
    const samples = xform.samples[name];
    if (samples?.times.length) ops.push({ name, type: name.split(":")[1] ?? "", samples });
  }
  if (!ops.length) return [];

  const target = new Object3D();
  const poseAt = (time: number): Pose => {
    const values = { ...xform.values };
    for (const op of ops) values[op.name] = sampleAt(op, time);
    const evaluated = evaluateXformOps({ order, values, samples: {} });
    if (parentInverse) {
      evaluated.matrix.premultiply(parentInverse);
      evaluated.scale = null;
    }
    setFromXform(target, evaluated);
    return { time, position: target.position.clone(), quaternion: target.quaternion.clone(), scale: target.scale.clone() };
  };

  const keys: Pose[] = [];
  const refine = (a: Pose, b: Pose, depth: number) => {
    if (depth >= MAX_REFINE_DEPTH || b.time - a.time <= frame * 1.001) return;
    const mid = poseAt((a.time + b.time) / 2);
    if (interpolates(a, b, mid)) return;
    refine(a, mid, depth + 1);
    keys.push(mid);
    refine(mid, b, depth + 1);
  };
  const times = [...new Set(ops.flatMap((op) => op.samples.times))].sort((a, b) => a - b);
  let previous = poseAt(times[0]);
  keys.push(previous);
  for (let i = 1; i < times.length; i++) {
    const [t0, t1] = [times[i - 1], times[i]];
    const steps = rotationSteps(ops, t0, t1);
    for (let s = 1; s <= steps; s++) {
      const next = poseAt(t0 + ((t1 - t0) * s) / steps);
      refine(previous, next, 0);
      keys.push(next);
      previous = next;
    }
  }

  const keyTimes = new Float32Array(keys.length);
  const positions = new Float32Array(keys.length * 3);
  const quaternions = new Float32Array(keys.length * 4);
  const scales = new Float32Array(keys.length * 3);
  keys.forEach((key, i) => {
    // Keep each quaternion in the previous one's hemisphere so keys blend the short way.
    if (i > 0 && key.quaternion.dot(keys[i - 1].quaternion) < 0) key.quaternion.set(-key.quaternion.x, -key.quaternion.y, -key.quaternion.z, -key.quaternion.w);
    keyTimes[i] = key.time;
    key.position.toArray(positions, i * 3);
    key.quaternion.toArray(quaternions, i * 4);
    key.scale.toArray(scales, i * 3);
  });
  return [
    new VectorKeyframeTrack(`${node}.position`, keyTimes, positions),
    new QuaternionKeyframeTrack(`${node}.quaternion`, keyTimes, quaternions),
    new VectorKeyframeTrack(`${node}.scale`, keyTimes, scales),
  ];
}

/**
 * Prims flagged with `userData.resetXformStack` keep their local transform as
 * their transform in the stage, ignoring their ancestors' (the stage root's
 * unit and up-axis conversion still applies). The flag stays, so saving can
 * author such a prim's transform relative to the stage again.
 */
export function applyResetXformStacks(root: Object3D): void {
  const flagged: Object3D[] = [];
  root.traverse((obj) => {
    if (obj.userData.resetXformStack) flagged.push(obj);
  });
  if (!flagged.length) return;
  root.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const local = new Matrix4();
  const parentInStage = new Matrix4();
  // traverse() is pre-order, so flagged ancestors are re-parented first.
  for (const obj of flagged) {
    if (!obj.parent) continue;
    parentInStage.multiplyMatrices(rootInverse, obj.parent.matrixWorld).invert();
    local.compose(obj.position, obj.quaternion, obj.scale).premultiply(parentInStage);
    local.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrixWorld(true);
  }
}
