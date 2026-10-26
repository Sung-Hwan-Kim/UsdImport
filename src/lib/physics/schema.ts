import { Box3, MathUtils, Matrix3, Matrix4, Quaternion, Sphere, Vector3, type Mesh, type Object3D, type SkinnedMesh } from "three";
import { getPrimTag, type PrimTag } from "../usd/composer";
import { apiSchemasOf, type USDSpec } from "../usd/layers";
import type { LoadedStage } from "../usd/loadStage";
import { stagePathOf } from "../scene";

// Everything here is expressed in the viewer's world frame: metres, Y-up. The
// composer already folds metersPerUnit and the up axis into the stage root
// transform, so world matrices give simulation-ready values.

export type BodyKind = "dynamic" | "kinematic";
export type ShapeKind = "box" | "sphere" | "capsule" | "convex" | "triangleMesh";
export type Axis = "X" | "Y" | "Z";
export type JointType = "revolute" | "prismatic" | "spherical" | "fixed" | "distance" | "generic";

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
}

export interface PhysicsMaterialInfo {
  path: string | null;
  staticFriction: number;
  dynamicFriction: number;
  restitution: number;
  /** kg/m³ */
  density?: number;
}

export interface ColliderInfo {
  object: Object3D;
  path: string;
  /** Owning rigid body, or null for a static collider. */
  body: BodyInfo | null;
  shape: ShapeKind;
  approximation: string;
  /** Shape frame relative to the owning body (or to the world when static). */
  localPose: Pose;
  /** Box half extents (m). */
  halfExtents?: Vector3;
  /** Sphere/capsule radius (m). */
  radius?: number;
  /** Capsule half height along `axis`, excluding the caps (m). */
  halfHeight?: number;
  axis?: Axis;
  /** Convex/triangle mesh vertices in the shape frame, world scale baked in (m). */
  points?: Float32Array;
  indices?: Uint32Array;
  material: PhysicsMaterialInfo;
}

export interface BodyInfo {
  index: number;
  object: Object3D;
  path: string;
  kind: BodyKind;
  /** World pose of the body frame at load time. */
  pose: Pose;
  /** Explicit mass (kg). */
  mass?: number;
  /** kg/m³ */
  density?: number;
  /** Centre of mass in the body frame (m). */
  centerOfMass?: Vector3;
  /** World-space m/s and rad/s. */
  linearVelocity: Vector3;
  angularVelocity: Vector3;
  colliders: ColliderInfo[];
}

/** A time-sampled scalar, times in seconds from the stage's start time code. */
export interface ScalarSamples {
  times: number[];
  values: number[];
}

export interface JointDrive {
  type: "force" | "acceleration";
  /** rad or m (at the start, when time-sampled) */
  targetPosition: number;
  /** rad/s or m/s (at the start, when time-sampled) */
  targetVelocity: number;
  /** Time-sampled targets, in the same units; Isaac Sim moves drives along them while it plays. */
  targetPositionSamples?: ScalarSamples;
  targetVelocitySamples?: ScalarSamples;
  stiffness: number;
  damping: number;
  maxForce: number;
}

/** Degree of freedom names used by UsdPhysics LimitAPI/DriveAPI instances. */
export type Dof = "transX" | "transY" | "transZ" | "rotX" | "rotY" | "rotZ";

export interface JointInfo {
  object: Object3D;
  path: string;
  type: JointType;
  /** null = attached to the world or to a static collider. */
  body0: BodyInfo | null;
  body1: BodyInfo | null;
  /** Static collider a side is attached to (so the pair does not collide), when it has no body. */
  static0: ColliderInfo | null;
  static1: ColliderInfo | null;
  /** Joint frame in body0's frame (world frame when body0 is null). X is the joint axis. */
  frame0: Pose;
  frame1: Pose;
  axis: Axis;
  /** Revolute (rad) / prismatic (m) limits. */
  lower?: number;
  upper?: number;
  /** Spherical cone limits (rad). */
  cone0?: number;
  cone1?: number;
  /** Distance joint limits (m). */
  minDistance?: number;
  maxDistance?: number;
  /** Generic joint limits per DOF; low > high means locked. */
  dofLimits?: Partial<Record<Dof, { low: number; high: number }>>;
  /** "angular"/"linear" for revolute/prismatic, DOF names for generic joints. */
  drives: Partial<Record<"angular" | "linear" | Dof, JointDrive>>;
  collisionEnabled: boolean;
  breakForce: number;
  breakTorque: number;
}

export type DeformableKind = "surface" | "volume" | "curves";

/** Deformable simulation geometry (AOUSD deformable proposal); cloth is a "surface" deformable. */
export interface DeformableInfo {
  object: Object3D;
  path: string;
  kind: DeformableKind;
  /** Simulation thickness (m), when authored as a constant. */
  thickness?: number;
  material: { path: string | null; density?: number; youngsModulus?: number; poissonsRatio?: number };
}

export interface PhysicsDescription {
  /** m/s² in world space */
  gravity: Vector3;
  /** Simulation rate from the PhysicsScene, when authored. */
  stepsPerSecond?: number;
  bodies: BodyInfo[];
  staticColliders: ColliderInfo[];
  joints: JointInfo[];
  deformables: DeformableInfo[];
  warnings: string[];
  /** Lookup for the inspector. */
  byObject: Map<Object3D, { body?: BodyInfo; collider?: ColliderInfo; joint?: JointInfo; deformable?: DeformableInfo }>;
}

const DEFAULT_MATERIAL: PhysicsMaterialInfo = { path: null, staticFriction: 0.5, dynamicFriction: 0.5, restitution: 0 };
const JOINT_TYPES: Record<string, JointType> = {
  PhysicsRevoluteJoint: "revolute",
  PhysicsPrismaticJoint: "prismatic",
  PhysicsSphericalJoint: "spherical",
  PhysicsFixedJoint: "fixed",
  PhysicsDistanceJoint: "distance",
  PhysicsJoint: "generic",
};
const DOFS: Dof[] = ["transX", "transY", "transZ", "rotX", "rotY", "rotZ"];
const DEFORMABLE_SIM_APIS: Record<string, DeformableKind> = {
  PhysicsSurfaceDeformableSimAPI: "surface",
  PhysicsVolumeDeformableSimAPI: "volume",
  PhysicsCurvesDeformableSimAPI: "curves",
};

// ---------------------------------------------------------------- spec access

/** Reads authored opinions for an object, following `tag.source` for referenced prims. */
class SpecReader {
  constructor(private readonly stage: LoadedStage) {}

  private specs(tag: PrimTag): Record<string, USDSpec> | undefined {
    return this.stage.layers.get(tag.layer)?.data.specsByPath;
  }

  private tags(obj: Object3D): PrimTag[] {
    const tag = getPrimTag(obj);
    if (!tag) return [];
    return tag.source ? [tag, tag.source] : [tag];
  }

  apis(obj: Object3D): string[] {
    return this.tags(obj).flatMap((t) => apiSchemasOf(this.specs(t)?.[t.path]));
  }

  hasApi(obj: Object3D, name: string): boolean {
    return this.apis(obj).includes(name);
  }

  /** First authored value of an attribute (default, else first time sample). */
  attr(obj: Object3D, name: string): unknown {
    for (const t of this.tags(obj)) {
      const f = this.specs(t)?.[`${t.path}.${name}`]?.fields;
      if (!f) continue;
      if (f.default !== undefined) return f.default;
      const samples = f.timeSamples as { values?: unknown[] } | undefined;
      if (samples?.values?.length) return samples.values[0];
    }
    return undefined;
  }

  /** Time samples of the strongest opinion with a value, when it has samples (they win over its default at a time). */
  samples(obj: Object3D, name: string): { times: number[]; values: unknown[] } | null {
    for (const t of this.tags(obj)) {
      const f = this.specs(t)?.[`${t.path}.${name}`]?.fields;
      if (!f) continue;
      const samples = f.timeSamples as { times?: number[]; values?: unknown[] } | undefined;
      if (samples?.times?.length && samples.values?.length) return { times: samples.times, values: samples.values };
      if (f.default !== undefined) return null;
    }
    return null;
  }

  num(obj: Object3D, name: string, fallback: number): number {
    const v = this.attr(obj, name);
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  }

  bool(obj: Object3D, name: string, fallback: boolean): boolean {
    const v = this.attr(obj, name);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return /^(1|true)$/i.test(v);
    return fallback;
  }

  vec3(obj: Object3D, name: string): Vector3 | null {
    const v = this.attr(obj, name) as ArrayLike<number> | undefined;
    return v && v.length >= 3 ? new Vector3(v[0], v[1], v[2]) : null;
  }

  /** Quaternions are stored (x, y, z, w) by both parsers. */
  quat(obj: Object3D, name: string): Quaternion | null {
    const v = this.attr(obj, name) as ArrayLike<number> | undefined;
    return v && v.length >= 4 ? new Quaternion(v[0], v[1], v[2], v[3]).normalize() : null;
  }

  token(obj: Object3D, name: string): string | undefined {
    const v = this.attr(obj, name);
    return typeof v === "string" ? v : undefined;
  }

  /** Relationship targets, with the tag whose namespace they live in. */
  rel(obj: Object3D, name: string): { tag: PrimTag; targets: string[] } | null {
    for (const t of this.tags(obj)) {
      const f = this.specs(t)?.[`${t.path}.${name}`]?.fields;
      const targets = f?.targetPaths as string[] | undefined;
      if (targets?.length) return { tag: t, targets: targets.map((p) => p.replace(/^<|>$/g, "")) };
    }
    return null;
  }

  /** Attribute value on an arbitrary prim path in a tag's layer (e.g. a bound material). */
  attrAt(tag: PrimTag, primPath: string, name: string): unknown {
    return this.specs(tag)?.[`${primPath}.${name}`]?.fields.default;
  }

  apisAt(tag: PrimTag, primPath: string): string[] {
    return apiSchemasOf(this.specs(tag)?.[primPath]);
  }
}

// ---------------------------------------------------------------- helpers

/** A sampled value at `time`, interpolated linearly and held past the first and last samples, as USD does. */
export function sampleScalar({ times, values }: ScalarSamples, time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (time <= times[lo]) return values[lo];
  if (time >= times[hi]) return values[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  return values[lo] + ((values[hi] - values[lo]) * (time - times[lo])) / (times[hi] - times[lo]);
}

/** A drive's position and velocity targets at `time` (seconds from the stage's start). */
export function driveTargetsAt(drive: JointDrive, time: number): { position: number; velocity: number } {
  return {
    position: drive.targetPositionSamples ? sampleScalar(drive.targetPositionSamples, time) : drive.targetPosition,
    velocity: drive.targetVelocitySamples ? sampleScalar(drive.targetVelocitySamples, time) : drive.targetVelocity,
  };
}

/** Whether any of a joint's drive targets change over time. */
export function hasAnimatedDrives(joint: JointInfo): boolean {
  return Object.values(joint.drives).some((d) => d?.targetPositionSamples || d?.targetVelocitySamples);
}

function worldPose(obj: Object3D): Pose & { scale: Vector3 } {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  obj.matrixWorld.decompose(position, quaternion, scale);
  return { position, quaternion, scale: new Vector3(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) };
}

/** `child` expressed in `parent`'s frame (both rigid). */
export function relativePose(parent: Pose, child: Pose): Pose {
  const inv = parent.quaternion.clone().invert();
  return {
    position: child.position.clone().sub(parent.position).applyQuaternion(inv),
    quaternion: inv.multiply(child.quaternion),
  };
}

/** Rotation taking +X to the given axis (joint and capsule axes are X in PhysX). */
export function axisRotation(axis: Axis): Quaternion {
  if (axis === "Y") return new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  if (axis === "Z") return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
  return new Quaternion();
}

function asAxis(value: string | undefined, fallback: Axis): Axis {
  return value === "X" || value === "Y" || value === "Z" ? value : fallback;
}

/** Unique, scaled vertices of a mesh in its own frame. */
function meshPoints(mesh: Mesh, scale: Vector3): Float32Array {
  const pos = mesh.geometry.getAttribute("position");
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * scale.x;
    const y = pos.getY(i) * scale.y;
    const z = pos.getZ(i) * scale.z;
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x, y, z);
  }
  return new Float32Array(out);
}

function meshTriangles(mesh: Mesh, scale: Vector3): { points: Float32Array; indices: Uint32Array } {
  const pos = mesh.geometry.getAttribute("position");
  const points = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    points[i * 3] = pos.getX(i) * scale.x;
    points[i * 3 + 1] = pos.getY(i) * scale.y;
    points[i * 3 + 2] = pos.getZ(i) * scale.z;
  }
  const index = mesh.geometry.index;
  const indices = index ? Uint32Array.from(index.array as ArrayLike<number>) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { points, indices };
}

// ---------------------------------------------------------------- extraction

export function extractPhysics(stage: LoadedStage): PhysicsDescription {
  const reader = new SpecReader(stage);
  const warnings: string[] = [];
  const root = stage.scene;
  root.updateWorldMatrix(true, true);
  const unitScale = root.scale.x || 1; // metres per stage unit, as applied by the composer
  const rootRotation = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(root.matrixWorld));
  const { startTimeCode = 0, timeCodesPerSecond } = stage.metadata;
  /** Time samples of a scalar attribute in simulation time (s from the start) and simulation units. */
  const scalarSamples = (obj: Object3D, name: string, scale: number): ScalarSamples | undefined => {
    const samples = reader.samples(obj, name);
    if (!samples) return undefined;
    const times: number[] = [];
    const values: number[] = [];
    samples.times.forEach((t, i) => {
      const v = Number(samples.values[i]);
      if (!Number.isFinite(t) || !Number.isFinite(v)) return;
      times.push((t - startTimeCode) / timeCodesPerSecond);
      values.push(v * scale);
    });
    return times.length ? { times, values } : undefined;
  };

  // Index objects for relationship targets: per composition instance, and by stage path.
  const byInstance = new Map<string, Object3D>();
  const byStagePath = new Map<string, Object3D>();
  root.traverse((obj) => {
    const tag = getPrimTag(obj);
    if (!tag || obj.userData.internal) return;
    byInstance.set(`${tag.instance}|${tag.path}`, obj);
    if (tag.source) byInstance.set(`${tag.source.instance}|${tag.source.path}`, obj);
    byStagePath.set(stagePathOf(obj), obj);
  });
  const resolveTarget = (tag: PrimTag, path: string) => byInstance.get(`${tag.instance}|${path}`) ?? byStagePath.get(path) ?? null;

  // ---- rigid bodies
  const bodies: BodyInfo[] = [];
  const bodyByObject = new Map<Object3D, BodyInfo>();
  const byObject: PhysicsDescription["byObject"] = new Map();
  const entry = (obj: Object3D) => {
    let e = byObject.get(obj);
    if (!e) byObject.set(obj, (e = {}));
    return e;
  };

  root.traverse((obj) => {
    if (obj === root || !reader.hasApi(obj, "PhysicsRigidBodyAPI")) return;
    if (!reader.bool(obj, "physics:rigidBodyEnabled", true)) return;
    const pose = worldPose(obj);
    const parentMatrix = obj.parent ? obj.parent.matrixWorld : new Matrix4();
    const parentRotation = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(parentMatrix));
    // UsdPhysics velocities are expressed in the prim's parent space (units/s, deg/s).
    const v = reader.vec3(obj, "physics:velocity") ?? new Vector3();
    const w = reader.vec3(obj, "physics:angularVelocity") ?? new Vector3();
    const body: BodyInfo = {
      index: bodies.length,
      object: obj,
      path: stagePathOf(obj),
      kind: reader.bool(obj, "physics:kinematicEnabled", false) ? "kinematic" : "dynamic",
      pose: { position: pose.position, quaternion: pose.quaternion },
      // The parent's linear part converts both direction and stage units.
      linearVelocity: v.applyMatrix3(new Matrix3().setFromMatrix4(parentMatrix)),
      angularVelocity: w.applyQuaternion(parentRotation).multiplyScalar(MathUtils.DEG2RAD),
      colliders: [],
    };
    if (reader.hasApi(obj, "PhysicsMassAPI")) {
      const mass = reader.num(obj, "physics:mass", 0);
      if (mass > 0) body.mass = mass;
      const density = reader.num(obj, "physics:density", 0);
      if (density > 0) body.density = density / unitScale ** 3;
      const com = reader.vec3(obj, "physics:centerOfMass");
      if (com && com.lengthSq() < 1e30) body.centerOfMass = com.multiply(pose.scale);
    }
    bodies.push(body);
    bodyByObject.set(obj, body);
    entry(obj).body = body;
  });

  const owningBody = (obj: Object3D): BodyInfo | null => {
    for (let cur: Object3D | null = obj; cur && cur !== root; cur = cur.parent) {
      const body = bodyByObject.get(cur);
      if (body) return body;
    }
    return null;
  };

  // ---- physics materials (material:binding:physics, inherited down the hierarchy)
  const materialFor = (obj: Object3D): PhysicsMaterialInfo => {
    for (let cur: Object3D | null = obj; cur && cur !== root; cur = cur.parent) {
      const binding = reader.rel(cur, "material:binding:physics");
      if (!binding) continue;
      const path = binding.targets[0];
      if (!reader.apisAt(binding.tag, path).includes("PhysicsMaterialAPI")) return DEFAULT_MATERIAL;
      const num = (name: string, fallback: number) => {
        const v = reader.attrAt(binding.tag, path, name);
        return typeof v === "number" ? v : fallback;
      };
      const density = num("physics:density", 0);
      return {
        path,
        staticFriction: num("physics:staticFriction", 0),
        dynamicFriction: num("physics:dynamicFriction", 0),
        restitution: num("physics:restitution", 0),
        density: density > 0 ? density / unitScale ** 3 : undefined,
      };
    }
    return DEFAULT_MATERIAL;
  };

  // ---- deformables: simulated by Newton only; their geometry is never a rigid collider
  const deformables: DeformableInfo[] = [];
  root.traverse((obj) => {
    if (obj === root) return;
    const kind = reader.apis(obj).map((api) => DEFORMABLE_SIM_APIS[api]).find(Boolean);
    if (!kind) return;
    if (kind !== "surface") warnings.push(`${stagePathOf(obj)}: ${kind === "volume" ? "볼륨" : "커브"} Deformable은 아직 지원하지 않습니다.`);
    const thicknesses = reader.attr(obj, "physics:thicknesses") as ArrayLike<number> | undefined;
    const deformable: DeformableInfo = { object: obj, path: stagePathOf(obj), kind, material: { path: null } };
    if (thicknesses?.length && reader.token(obj, "physics:thicknesses:elementType") !== "point") {
      deformable.thickness = thicknesses[0] * unitScale;
    }
    for (let cur: Object3D | null = obj; cur && cur !== root; cur = cur.parent) {
      const binding = reader.rel(cur, "material:binding:physics");
      if (!binding) continue;
      const path = binding.targets[0];
      const num = (name: string) => {
        const v = reader.attrAt(binding.tag, path, name);
        return typeof v === "number" ? v : undefined;
      };
      const density = num("physics:density");
      deformable.material = {
        path,
        density: density === undefined ? undefined : density / unitScale ** 3,
        youngsModulus: num("physics:youngsModulus"),
        poissonsRatio: num("physics:poissonsRatio"),
      };
      break;
    }
    deformables.push(deformable);
    entry(obj).deformable = deformable;
  });
  const deformablePart = (obj: Object3D) => {
    for (let cur: Object3D | null = obj; cur && cur !== root; cur = cur.parent) {
      if (byObject.get(cur)?.deformable || reader.hasApi(cur, "PhysicsDeformableBodyAPI")) return true;
    }
    return false;
  };

  // ---- colliders
  const staticColliders: ColliderInfo[] = [];
  root.traverse((obj) => {
    if (obj === root || !reader.hasApi(obj, "PhysicsCollisionAPI") || deformablePart(obj)) return;
    if (!reader.bool(obj, "physics:collisionEnabled", true)) return;
    const mesh = obj as Mesh;
    if (!mesh.isMesh) {
      warnings.push(`${stagePathOf(obj)}: 지오메트리가 없는 CollisionAPI는 건너뜁니다.`);
      return;
    }
    if ((obj as SkinnedMesh).isSkinnedMesh) {
      warnings.push(`${stagePathOf(obj)}: 스키닝 메시 콜라이더는 지원하지 않습니다.`);
      return;
    }
    const body = owningBody(obj);
    const pose = worldPose(obj);
    const typeName = getPrimTag(obj)?.source?.typeName || getPrimTag(obj)?.typeName || "Mesh";
    const authored = reader.token(obj, "physics:approximation") ?? "none";
    const collider: ColliderInfo = {
      object: obj,
      path: stagePathOf(obj),
      body,
      shape: "convex",
      approximation: authored,
      localPose: body ? relativePose(body.pose, pose) : { position: pose.position, quaternion: pose.quaternion },
      material: materialFor(obj),
    };
    const s = pose.scale;
    const uniform = Math.abs(s.x - s.y) < 1e-6 * s.x && Math.abs(s.x - s.z) < 1e-6 * s.x;
    const geometry = mesh.geometry;

    if (typeName === "Cube" || authored === "boundingCube") {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox ?? new Box3();
      collider.shape = "box";
      collider.halfExtents = box.getSize(new Vector3()).multiply(s).multiplyScalar(0.5);
      offsetShape(collider, box.getCenter(new Vector3()).multiply(s));
    } else if ((typeName === "Sphere" && uniform) || authored === "boundingSphere") {
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere ?? new Sphere();
      collider.shape = "sphere";
      collider.radius = sphere.radius * Math.max(s.x, s.y, s.z);
      offsetShape(collider, sphere.center.clone().multiply(s));
    } else if (typeName === "Capsule") {
      const axis = asAxis(reader.token(obj, "axis"), "Z");
      const along = s[axis.toLowerCase() as "x" | "y" | "z"];
      const across = axis === "X" ? Math.max(s.y, s.z) : axis === "Y" ? Math.max(s.x, s.z) : Math.max(s.x, s.y);
      collider.shape = "capsule";
      collider.axis = axis;
      collider.radius = reader.num(obj, "radius", 0.5) * across;
      collider.halfHeight = (reader.num(obj, "height", 1) / 2) * along;
    } else if (authored === "none" && !body) {
      const tri = meshTriangles(mesh, s);
      collider.shape = "triangleMesh";
      collider.points = tri.points;
      collider.indices = tri.indices;
    } else {
      if (authored === "none") warnings.push(`${collider.path}: 동적 바디의 삼각형 메시는 볼록 껍질로 대체합니다.`);
      else if (authored === "convexDecomposition") warnings.push(`${collider.path}: convexDecomposition은 단일 볼록 껍질로 근사합니다.`);
      collider.shape = "convex";
      collider.points = meshPoints(mesh, s);
    }

    if (body) body.colliders.push(collider);
    else staticColliders.push(collider);
    entry(obj).collider = collider;
  });

  for (const body of bodies) {
    if (body.kind === "dynamic" && !body.colliders.length && body.mass === undefined) {
      warnings.push(`${body.path}: 콜라이더와 질량이 없어 1kg으로 가정합니다.`);
      body.mass = 1;
    }
  }

  // ---- joints
  const joints: JointInfo[] = [];
  root.traverse((obj) => {
    const tag = getPrimTag(obj);
    const type = tag ? JOINT_TYPES[tag.typeName] : undefined;
    if (!tag || !type) return;
    if (!reader.bool(obj, "physics:jointEnabled", true)) return;
    const path = stagePathOf(obj);

    // A joint frame is authored in the target prim's space; the simulation
    // needs it in the owning body's frame (or the world for static targets).
    const side = (n: 0 | 1): { body: BodyInfo | null; staticCollider: ColliderInfo | null; frame: Pose } | null => {
      const local = reader.vec3(obj, `physics:localPos${n}`) ?? new Vector3();
      const rot = reader.quat(obj, `physics:localRot${n}`) ?? new Quaternion();
      const rel = reader.rel(obj, `physics:body${n}`);
      let anchorMatrix = root.matrixWorld;
      let anchorRotation = rootRotation;
      let body: BodyInfo | null = null;
      let staticCollider: ColliderInfo | null = null;
      if (rel) {
        const target = resolveTarget(rel.tag, rel.targets[0]);
        if (!target) {
          warnings.push(`${path}: body${n} 대상 ${rel.targets[0]}을(를) 찾을 수 없습니다.`);
          return null;
        }
        anchorMatrix = target.matrixWorld;
        anchorRotation = worldPose(target).quaternion;
        body = owningBody(target);
        if (!body) staticCollider = byObject.get(target)?.collider ?? null;
      }
      const world: Pose = {
        position: local.applyMatrix4(anchorMatrix),
        quaternion: anchorRotation.clone().multiply(rot),
      };
      return { body, staticCollider, frame: body ? relativePose(body.pose, world) : world };
    };
    const a = side(0);
    const b = side(1);
    if (!a || !b) return;
    if (!a.body && !b.body) {
      warnings.push(`${path}: 두 대상 모두 정적이라 조인트를 건너뜁니다.`);
      return;
    }

    const axis = asAxis(reader.token(obj, "physics:axis"), "X");
    const align = axisRotation(type === "revolute" || type === "prismatic" || type === "spherical" ? axis : "X");
    a.frame.quaternion.multiply(align);
    b.frame.quaternion.multiply(align);

    const deg = (name: string) => {
      const v = reader.num(obj, name, Number.NaN);
      return Number.isFinite(v) ? v * MathUtils.DEG2RAD : undefined;
    };
    const len = (name: string) => {
      const v = reader.num(obj, name, Number.NaN);
      return Number.isFinite(v) ? v * unitScale : undefined;
    };
    const joint: JointInfo = {
      object: obj,
      path,
      type,
      body0: a.body,
      body1: b.body,
      static0: a.staticCollider,
      static1: b.staticCollider,
      frame0: a.frame,
      frame1: b.frame,
      axis,
      drives: {},
      collisionEnabled: reader.bool(obj, "physics:collisionEnabled", false),
      breakForce: reader.num(obj, "physics:breakForce", Number.POSITIVE_INFINITY) * unitScale,
      breakTorque: reader.num(obj, "physics:breakTorque", Number.POSITIVE_INFINITY) * unitScale ** 2,
    };
    if (type === "revolute") {
      joint.lower = deg("physics:lowerLimit");
      joint.upper = deg("physics:upperLimit");
    } else if (type === "prismatic") {
      joint.lower = len("physics:lowerLimit");
      joint.upper = len("physics:upperLimit");
    } else if (type === "spherical") {
      const c0 = reader.num(obj, "physics:coneAngle0Limit", -1);
      const c1 = reader.num(obj, "physics:coneAngle1Limit", -1);
      if (c0 >= 0) joint.cone0 = c0 * MathUtils.DEG2RAD;
      if (c1 >= 0) joint.cone1 = c1 * MathUtils.DEG2RAD;
    } else if (type === "distance") {
      const min = reader.num(obj, "physics:minDistance", -1);
      const max = reader.num(obj, "physics:maxDistance", -1);
      if (min >= 0) joint.minDistance = min * unitScale;
      if (max >= 0) joint.maxDistance = max * unitScale;
    } else if (type === "generic") {
      joint.dofLimits = {};
      for (const dof of DOFS) {
        const low = reader.num(obj, `limit:${dof}:physics:low`, Number.NaN);
        const high = reader.num(obj, `limit:${dof}:physics:high`, Number.NaN);
        if (!Number.isFinite(low) && !Number.isFinite(high)) continue;
        const k = dof.startsWith("rot") ? MathUtils.DEG2RAD : unitScale;
        joint.dofLimits[dof] = { low: (Number.isFinite(low) ? low : -Infinity) * k, high: (Number.isFinite(high) ? high : Infinity) * k };
      }
    }

    // DriveAPI: angular quantities are per degree in USD, per radian in PhysX.
    const driveNames: ("angular" | "linear" | Dof)[] =
      type === "revolute" ? ["angular"] : type === "prismatic" ? ["linear"] : type === "generic" ? DOFS : [];
    for (const name of driveNames) {
      if (!reader.hasApi(obj, `PhysicsDriveAPI:${name}`)) continue;
      const angular = name === "angular" || name.startsWith("rot");
      const p = `drive:${name}:physics:`;
      const toRad = angular ? MathUtils.DEG2RAD : unitScale;
      const perRad = angular ? MathUtils.RAD2DEG : 1;
      const drive: JointDrive = {
        type: reader.token(obj, `${p}type`) === "acceleration" ? "acceleration" : "force",
        targetPosition: reader.num(obj, `${p}targetPosition`, 0) * toRad,
        targetVelocity: reader.num(obj, `${p}targetVelocity`, 0) * toRad,
        targetPositionSamples: scalarSamples(obj, `${p}targetPosition`, toRad),
        targetVelocitySamples: scalarSamples(obj, `${p}targetVelocity`, toRad),
        stiffness: reader.num(obj, `${p}stiffness`, 0) * perRad,
        damping: reader.num(obj, `${p}damping`, 0) * perRad,
        maxForce: reader.num(obj, `${p}maxForce`, Number.POSITIVE_INFINITY) * (angular ? unitScale ** 2 : unitScale),
      };
      // Simulation starts at the start time code, where the samples (not the default) hold.
      const start = driveTargetsAt(drive, 0);
      drive.targetPosition = start.position;
      drive.targetVelocity = start.velocity;
      joint.drives[name] = drive;
    }

    joints.push(joint);
    entry(obj).joint = joint;
  });

  // ---- scene
  let gravity = new Vector3(0, -9.81, 0);
  let stepsPerSecond: number | undefined;
  root.traverse((obj) => {
    if (getPrimTag(obj)?.typeName !== "PhysicsScene") return;
    const dir = reader.vec3(obj, "physics:gravityDirection");
    const magnitude = reader.num(obj, "physics:gravityMagnitude", Number.NEGATIVE_INFINITY);
    // Unauthored direction means "down the stage up axis"; unauthored magnitude means Earth gravity.
    const worldDir = dir && dir.lengthSq() > 0 ? dir.normalize().applyQuaternion(rootRotation) : new Vector3(0, -1, 0);
    const worldMagnitude = Number.isFinite(magnitude) && magnitude >= 0 ? magnitude * unitScale : 9.81;
    gravity = worldDir.multiplyScalar(worldMagnitude);
    const rate = reader.num(obj, "physxScene:timeStepsPerSecond", 0);
    if (rate > 0) stepsPerSecond = rate;
  });

  return { gravity, stepsPerSecond, bodies, staticColliders, joints, deformables, warnings, byObject };
}

/** An attribute's authored value on an object's prim (default, else first time sample). */
export function authoredAttribute(stage: LoadedStage, obj: Object3D, name: string): unknown {
  return new SpecReader(stage).attr(obj, name);
}

const descriptions = new WeakMap<LoadedStage, PhysicsDescription>();

/**
 * Description of the stage at its authored pose, extracted once per stage.
 * The simulation extracts its own copy when it starts; this one is for display.
 */
export function physicsDescriptionFor(stage: LoadedStage): PhysicsDescription {
  let d = descriptions.get(stage);
  if (!d) {
    d = extractPhysics(stage);
    descriptions.set(stage, d);
  }
  return d;
}

/** Move a collider's shape frame by an offset expressed in the collider's own frame. */
function offsetShape(collider: ColliderInfo, offset: Vector3): void {
  if (offset.lengthSq() === 0) return;
  collider.localPose.position.add(offset.applyQuaternion(collider.localPose.quaternion));
}
