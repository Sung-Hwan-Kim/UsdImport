import { Euler, Matrix4, Quaternion, type Object3D } from "three";

/** A prim's composed xformOp opinions: the op order and the op values. */
export interface XformOpinions {
  /** `xformOpOrder`, or undefined when no layer authored one. */
  order: string[] | undefined;
  /** `xformOp:*` attribute values by full name (e.g. `xformOp:scale:pivot`). */
  values: Record<string, unknown>;
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

export function xformOpinionsOf(data: Record<string, unknown>): XformOpinions {
  const order = data.xformOpOrder;
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    if (name.startsWith("xformOp:") && value !== undefined && value !== null) values[name] = value;
  }
  return { order: Array.isArray(order) ? order.map(String) : undefined, values };
}

/** Compose `stronger` over `weaker` per attribute, as USD does across a reference. */
export function mergeXformOpinions(stronger: XformOpinions, weaker: XformOpinions): XformOpinions {
  return { order: stronger.order ?? weaker.order, values: { ...weaker.values, ...stronger.values } };
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
 * Prims flagged with `userData.resetXformStack` keep their local transform as
 * their transform in the stage, ignoring their ancestors' (the stage root's
 * unit and up-axis conversion still applies).
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
    delete obj.userData.resetXformStack;
    if (!obj.parent) continue;
    parentInStage.multiplyMatrices(rootInverse, obj.parent.matrixWorld).invert();
    local.compose(obj.position, obj.quaternion, obj.scale).premultiply(parentInStage);
    local.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrixWorld(true);
  }
}
