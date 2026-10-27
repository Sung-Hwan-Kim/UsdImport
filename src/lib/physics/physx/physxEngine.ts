import { Quaternion, Vector3 } from "three";
import type { LoadedStage } from "../../usd/loadStage";
import type { EngineLoadResult, PhysicsEngine } from "../engine";
import {
  axisRotation,
  collisionFilter,
  driveTargetsAt,
  hasAnimatedDrives,
  relativePose,
  type ArticulationInfo,
  type BodyInfo,
  type ColliderInfo,
  type Dof,
  type JointDrive,
  type JointInfo,
  type PhysicsDescription,
  type Pose,
} from "../schema";
import {
  PX_MAX_F32,
  actorOrWorld,
  copyToHeap,
  freeHeap,
  loadPhysX,
  pxTransform,
  pxVec3,
  rigidBodyExt,
  setBoundedData,
  setFilterShader,
  type PhysX,
  type PhysXRuntime,
  type Px,
} from "./px";

const DEFAULT_DENSITY = 1000; // kg/m³
// PhysxSchema defaults for bodies without authored iteration counts, as in Isaac Sim.
const DEFAULT_POSITION_ITERATIONS = 16;
const DEFAULT_VELOCITY_ITERATIONS = 1;
// Mouse spring, as an acceleration drive so light and heavy bodies follow alike.
const DRAG_STIFFNESS = 400;
const DRAG_DAMPING = 40;

interface Releasable {
  release(): void;
}

function finite(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
}

/** An iteration count within the scene's bounds. */
function clampCount(n: number, [lo, hi]: [number, number]): number {
  return Math.min(Math.max(Math.round(n), lo), hi);
}

function unbreakable(j: JointInfo): boolean {
  return !finite(j.breakForce) && !finite(j.breakTorque);
}

/**
 * Whether a PhysX articulation joint can stand for a UsdPhysics joint:
 * fixed, revolute, prismatic, spherical, or a generic joint whose free DOFs
 * are all rotations or a single translation. Breakable joints stay maximal.
 */
function articulationJointKind(j: JointInfo): "fixed" | "revolute" | "prismatic" | "spherical" | null {
  if (!unbreakable(j)) return null;
  if (j.type === "fixed" || j.type === "revolute" || j.type === "prismatic" || j.type === "spherical") return j.type;
  if (j.type !== "generic") return null;
  const free = (dof: Dof) => {
    const lim = j.dofLimits?.[dof];
    return !lim || lim.low <= lim.high;
  };
  const trans = (["transX", "transY", "transZ"] as const).filter(free);
  const rot = (["rotX", "rotY", "rotZ"] as const).filter(free);
  if (!trans.length) return rot.length ? "spherical" : "fixed";
  return trans.length === 1 && !rot.length ? "prismatic" : null;
}

/** An articulation joint built from a UsdPhysics joint; `sign` is -1 when body1 is the parent link. */
interface ArticulatedJoint {
  joint: PhysX.PxArticulationJointReducedCoordinate;
  info: JointInfo;
  sign: number;
  /** Drive name (JointInfo.drives key) -> articulation axis. */
  axes: [keyof JointInfo["drives"], number][];
}

/** Smallest feature size of a shape, used to scale contact offsets for tiny objects. */
function shapeSize(c: ColliderInfo): number {
  if (c.halfExtents) return 2 * Math.min(c.halfExtents.x, c.halfExtents.y, c.halfExtents.z);
  if (c.radius) return 2 * c.radius;
  if (c.points && c.points.length >= 3) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < c.points.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], c.points[i + k]);
        max[k] = Math.max(max[k], c.points[i + k]);
      }
    }
    return Math.max(1e-4, Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  }
  return 0.1;
}

interface D6Targets {
  /** Drive pose of frame1 in frame0, and drive velocities. */
  position: Vector3;
  rotation: Quaternion;
  linear: Vector3;
  angular: Vector3;
}

const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

/** The D6 drive targets of a joint's drives at `time` (s from the start), or null without drives. */
function d6DriveTargets(j: JointInfo, time: number): D6Targets | null {
  const targets: D6Targets = { position: new Vector3(), rotation: new Quaternion(), linear: new Vector3(), angular: new Vector3() };
  switch (j.type) {
    case "revolute": {
      if (!j.drives.angular) return null;
      const { position, velocity } = driveTargetsAt(j.drives.angular, time);
      targets.rotation.setFromAxisAngle(X_AXIS, position);
      targets.angular.set(velocity, 0, 0);
      return targets;
    }
    case "prismatic": {
      if (!j.drives.linear) return null;
      const { position, velocity } = driveTargetsAt(j.drives.linear, time);
      targets.position.set(position, 0, 0);
      targets.linear.set(velocity, 0, 0);
      return targets;
    }
    case "generic": {
      const euler = new Vector3();
      let any = false;
      for (const dof of ["transX", "transY", "transZ", "rotX", "rotY", "rotZ"] as const) {
        const dr = j.drives[dof];
        if (!dr) continue;
        any = true;
        const { position, velocity } = driveTargetsAt(dr, time);
        const i = dof.endsWith("X") ? 0 : dof.endsWith("Y") ? 1 : 2;
        if (dof.startsWith("trans")) {
          targets.position.setComponent(i, position);
          targets.linear.setComponent(i, velocity);
        } else {
          euler.setComponent(i, position);
          targets.angular.setComponent(i, velocity);
        }
      }
      if (!any) return null;
      targets.rotation
        .setFromAxisAngle(X_AXIS, euler.x)
        .multiply(new Quaternion().setFromAxisAngle(Y_AXIS, euler.y))
        .multiply(new Quaternion().setFromAxisAngle(Z_AXIS, euler.z));
      return targets;
    }
    default:
      return null;
  }
}

/** PhysX 5 (WASM) running in the browser, stepped by the viewer. */
export class PhysXEngine implements PhysicsEngine {
  readonly kind = "physx" as const;
  readonly remote = false;

  private rt!: PhysXRuntime;
  private px!: Px;
  private description!: PhysicsDescription;
  private scene: PhysX.PxScene | null = null;
  private actors: PhysX.PxRigidBody[] = [];
  /** Bodies posed from the stage: kinematic ones, and welded ones outside an articulation. */
  private held: boolean[] = [];
  private articulations: PhysX.PxArticulationReducedCoordinate[] = [];
  private links = new Set<PhysX.PxRigidBody>();
  private articulatedJoints: ArticulatedJoint[] = [];
  private statics: PhysX.PxRigidStatic[] = [];
  private staticByCollider = new Map<ColliderInfo, PhysX.PxRigidStatic>();
  /** Collider ids carried in each shape's filter data (word3) for the filter shader. */
  private colliderIds = new Map<ColliderInfo, number>();
  private filterShader: PhysX.PassThroughFilterShaderImpl | null = null;
  private joints: Releasable[] = [];
  /** D6 joints whose drive targets are time-sampled; re-targeted before every step. */
  private animatedDrives: { joint: PhysX.PxD6Joint; info: JointInfo }[] = [];
  private meshes: Releasable[] = [];
  private materials = new Map<string, PhysX.PxMaterial>();
  private poses = new Float32Array(0);
  private simTime = 0;
  private dt = 1 / 60;
  private warnings: string[] = [];
  private drag: { anchor: PhysX.PxRigidDynamic; joint: PhysX.PxD6Joint } | null = null;

  async load(_stage: LoadedStage, description: PhysicsDescription): Promise<EngineLoadResult> {
    this.rt = await loadPhysX();
    this.px = this.rt.px;
    this.description = description;
    if (description.stepsPerSecond) this.dt = 1 / description.stepsPerSecond;
    this.build();
    const cloths = description.deformables.filter((d) => d.kind === "surface").length;
    if (cloths) this.warnings.push(`천 ${cloths}개는 Newton 엔진에서만 시뮬레이션되며 PhysX에서는 움직이지 않습니다.`);
    return {
      bodies: description.bodies.map((b) => b.object),
      kinematic: this.held,
      cloths: [],
      frame: "world",
      dt: this.dt,
      label: `PhysX ${this.rt.version} · WASM`,
      warnings: [...description.warnings, ...this.warnings],
    };
  }

  // ---------------------------------------------------------------- build

  private build(): void {
    const { px, rt } = this;
    const d = this.description;
    const sceneDesc = new px.PxSceneDesc(rt.tolerances);
    const gravity = pxVec3(px, d.gravity);
    sceneDesc.gravity = gravity;
    sceneDesc.cpuDispatcher = px.DefaultCpuDispatcherCreate(0);
    const settings = d.physxScene;
    sceneDesc.solverType = settings.solver === "TGS" ? px.PxSolverTypeEnum.eTGS : px.PxSolverTypeEnum.ePGS;
    if (settings.stabilization) sceneDesc.flags.raise(px.PxSceneFlagEnum.eENABLE_STABILIZATION);
    if (settings.ccd) sceneDesc.flags.raise(px.PxSceneFlagEnum.eENABLE_CCD);
    const colliders = [...d.staticColliders, ...d.bodies.flatMap((b) => b.colliders)];
    this.colliderIds = new Map(colliders.map((c, i) => [c, i]));
    const collides = collisionFilter(d);
    if (collides) {
      // CollisionGroups and FilteredPairsAPI decide per collider pair.
      this.filterShader = setFilterShader(px, sceneDesc, (a, b) => !colliders[a] || !colliders[b] || collides(colliders[a], colliders[b]));
    } else {
      sceneDesc.filterShader = px.DefaultFilterShader();
    }
    this.scene = rt.physics.createScene(sceneDesc);
    px.destroy(gravity);
    px.destroy(sceneDesc);

    for (const collider of d.staticColliders) {
      const pose = pxTransform(px, collider.localPose.position, collider.localPose.quaternion);
      const actor = rt.physics.createRigidStatic(pose);
      px.destroy(pose);
      // Static colliders carry their world pose on the actor; the shape sits at its origin.
      this.attachShape(actor, collider, true);
      this.scene.addActor(actor);
      this.statics.push(actor);
      this.staticByCollider.set(collider, actor);
    }

    const { links, joints: articulated } = this.buildArticulations();
    this.held = d.bodies.map((b) => b.kind === "kinematic" || (!!b.welded && !links.has(b)));
    this.actors = d.bodies.map((body) => links.get(body) ?? this.createBody(body, this.held[body.index]));
    for (const joint of d.joints) {
      if (articulated.has(joint)) continue;
      try {
        this.createJoint(joint);
      } catch (e) {
        this.warnings.push(`${joint.path}: 조인트 생성 실패 (${e instanceof Error ? e.message : String(e)})`);
      }
    }

    this.poses = new Float32Array(d.bodies.length * 7);
    this.readBack();
  }

  private material(c: ColliderInfo): PhysX.PxMaterial {
    const m = c.material;
    const key = `${m.staticFriction}|${m.dynamicFriction}|${m.restitution}|${m.frictionCombine}|${m.restitutionCombine}`;
    let mat = this.materials.get(key);
    if (!mat) {
      mat = this.rt.physics.createMaterial(m.staticFriction, m.dynamicFriction, m.restitution);
      const Combine = this.px.PxCombineModeEnum;
      const mode = { average: Combine.eAVERAGE, min: Combine.eMIN, multiply: Combine.eMULTIPLY, max: Combine.eMAX };
      if (m.frictionCombine) mat.setFrictionCombineMode(mode[m.frictionCombine]);
      if (m.restitutionCombine) mat.setRestitutionCombineMode(mode[m.restitutionCombine]);
      this.materials.set(key, mat);
    }
    return mat;
  }

  private geometry(c: ColliderInfo): PhysX.PxGeometry | null {
    const { px, rt } = this;
    switch (c.shape) {
      case "box":
        return new px.PxBoxGeometry(c.halfExtents!.x, c.halfExtents!.y, c.halfExtents!.z);
      case "sphere":
        return new px.PxSphereGeometry(c.radius!);
      case "capsule":
        return new px.PxCapsuleGeometry(c.radius!, Math.max(c.halfHeight!, 1e-4));
      case "convex": {
        if (!c.points || c.points.length < 12) return null;
        const desc = new px.PxConvexMeshDesc();
        const ptr = copyToHeap(px, c.points);
        setBoundedData(desc.points, c.points.length / 3, 12, ptr);
        let flags = px.PxConvexFlagEnum.eCOMPUTE_CONVEX as number;
        if (c.points.length / 3 > 2000) flags |= px.PxConvexFlagEnum.eQUANTIZE_INPUT;
        const convexFlags = new px.PxConvexFlags(flags);
        desc.flags = convexFlags;
        const mesh = px.CreateConvexMesh(rt.cooking, desc);
        freeHeap(px, ptr);
        px.destroy(convexFlags);
        px.destroy(desc);
        if (!mesh) return null;
        this.meshes.push(mesh);
        return new px.PxConvexMeshGeometry(mesh);
      }
      case "triangleMesh": {
        if (!c.points || !c.indices || c.indices.length < 3) return null;
        const desc = new px.PxTriangleMeshDesc();
        const pts = copyToHeap(px, c.points);
        const tris = copyToHeap(px, c.indices);
        setBoundedData(desc.points, c.points.length / 3, 12, pts);
        setBoundedData(desc.triangles, c.indices.length / 3, 12, tris);
        const mesh = px.CreateTriangleMesh(rt.cooking, desc);
        freeHeap(px, pts);
        freeHeap(px, tris);
        px.destroy(desc);
        if (!mesh) return null;
        this.meshes.push(mesh);
        return new px.PxTriangleMeshGeometry(mesh);
      }
    }
  }

  private attachShape(actor: PhysX.PxRigidActor, c: ColliderInfo, isStatic: boolean): void {
    const { px, rt } = this;
    const geometry = this.geometry(c);
    if (!geometry) {
      this.warnings.push(`${c.path}: 충돌 형상을 만들 수 없어 건너뜁니다.`);
      return;
    }
    const flags = new px.PxShapeFlags(px.PxShapeFlagEnum.eSIMULATION_SHAPE | px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE);
    const shape = rt.physics.createShape(geometry, this.material(c), true, flags);
    px.destroy(flags);
    px.destroy(geometry);
    // The binding's DefaultFilterShader collides a pair only when
    // (word0 of one) & (word1 of the other) != 0; zeroed filter data never collides.
    // word2 holds extra pair flags (swept CCD), word3 the collider id for setFilterShader.
    const ccd = this.description.physxScene.ccd && c.body?.kind === "dynamic" && c.body.physx.ccd;
    const filter = new px.PxFilterData(1, 0xffffffff, ccd ? px.PxPairFlagEnum.eDETECT_CCD_CONTACT : 0, this.colliderIds.get(c) ?? 0xffffffff);
    shape.setSimulationFilterData(filter);
    px.destroy(filter);

    const rotation = isStatic ? new Quaternion() : c.localPose.quaternion.clone();
    const position = isStatic ? new Vector3() : c.localPose.position;
    if (c.shape === "capsule" && c.axis) rotation.multiply(axisRotation(c.axis));
    const local = pxTransform(px, position, rotation);
    shape.setLocalPose(local);
    px.destroy(local);
    // Default contact offsets (2 cm) swallow centimetre-scale objects.
    const contact = c.contactOffset ?? Math.min(0.02, Math.max(0.001, shapeSize(c) * 0.2));
    shape.setContactOffset(contact);
    shape.setRestOffset(Math.min(c.restOffset ?? 0, contact * 0.99));
    actor.attachShape(shape);
    shape.release();
  }

  private createBody(body: BodyInfo, held: boolean): PhysX.PxRigidDynamic {
    const { px, rt } = this;
    const pose = pxTransform(px, body.pose.position, body.pose.quaternion);
    const actor = rt.physics.createRigidDynamic(pose);
    px.destroy(pose);
    this.setUpBody(actor, body);
    if (held) {
      actor.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    } else {
      const v = pxVec3(px, body.linearVelocity);
      const w = pxVec3(px, body.angularVelocity);
      actor.setLinearVelocity(v);
      actor.setAngularVelocity(w);
      px.destroy(v);
      px.destroy(w);
      const settings = this.description.physxScene;
      const p = body.physx;
      actor.setSolverIterationCounts(
        clampCount(p.positionIterations ?? DEFAULT_POSITION_ITERATIONS, settings.positionIterations),
        clampCount(p.velocityIterations ?? DEFAULT_VELOCITY_ITERATIONS, settings.velocityIterations),
      );
      if (p.sleepThreshold !== undefined) actor.setSleepThreshold(p.sleepThreshold);
      if (p.stabilizationThreshold !== undefined) actor.setStabilizationThreshold(p.stabilizationThreshold);
      this.applyDynamics(actor, body);
    }
    this.scene!.addActor(actor);
    return actor;
  }

  /** Shapes and mass, for an actor or an articulation link. */
  private setUpBody(actor: PhysX.PxRigidBody, body: BodyInfo): void {
    const { px } = this;
    for (const c of body.colliders) this.attachShape(actor, c, false);

    const ext = rigidBodyExt(px);
    const com = body.centerOfMass ? pxVec3(px, body.centerOfMass) : undefined;
    if (!body.colliders.length) {
      const mass = body.mass ?? 1;
      actor.setMass(mass);
      const inertia = new px.PxVec3(mass * 0.1, mass * 0.1, mass * 0.1);
      actor.setMassSpaceInertiaTensor(inertia);
      px.destroy(inertia);
    } else if (body.mass) {
      ext.setMassAndUpdateInertia(actor, body.mass, com);
    } else {
      const density = body.density ?? body.colliders.find((c) => c.material.density)?.material.density ?? DEFAULT_DENSITY;
      ext.updateMassAndInertia(actor, density, com);
    }
    if (com) px.destroy(com);
    // An authored inertia replaces the one PhysX derived from the shapes (Isaac Sim uses it as authored).
    if (body.inertia && body.mass) {
      // Keep the centre of mass PhysX derived from the shapes when none is authored.
      const derived = actor.getCMassLocalPose().p;
      const center = body.centerOfMass ?? new Vector3(derived.x, derived.y, derived.z);
      const frame = pxTransform(px, center, body.inertia.principalAxes);
      actor.setCMassLocalPose(frame);
      px.destroy(frame);
      const diagonal = pxVec3(px, body.inertia.diagonal);
      actor.setMassSpaceInertiaTensor(diagonal);
      px.destroy(diagonal);
    }
  }

  /** PhysxRigidBodyAPI settings of a simulated body. */
  private applyDynamics(actor: PhysX.PxRigidBody, body: BodyInfo): void {
    const { px } = this;
    const p = body.physx;
    if (p.linearDamping !== undefined) actor.setLinearDamping(p.linearDamping);
    if (p.angularDamping !== undefined) actor.setAngularDamping(p.angularDamping);
    if (p.maxLinearVelocity !== undefined) actor.setMaxLinearVelocity(p.maxLinearVelocity);
    if (p.maxAngularVelocity !== undefined) actor.setMaxAngularVelocity(p.maxAngularVelocity);
    if (p.maxDepenetrationVelocity !== undefined) actor.setMaxDepenetrationVelocity(p.maxDepenetrationVelocity);
    if (p.ccd && this.description.physxScene.ccd) actor.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eENABLE_CCD, true);
    if (p.speculativeCcd) actor.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eENABLE_SPECULATIVE_CCD, true);
  }

  // ---------------------------------------------------------------- articulations

  /**
   * Bodies under an ArticulationRootAPI become a PhysX articulation, solved in
   * reduced coordinates as Isaac Sim does; as maximal joints a long robot arm
   * sags under gravity because its drives never converge. A member held by an
   * unbreakable fixed joint to the world (or a welded body) is a fixed base.
   * Joints an articulation cannot express, and those closing loops, stay
   * maximal joints between the links.
   */
  private buildArticulations(): { links: Map<BodyInfo, PhysX.PxArticulationLink>; joints: Set<JointInfo> } {
    const links = new Map<BodyInfo, PhysX.PxArticulationLink>();
    const used = new Set<JointInfo>();
    for (const info of this.description.articulations) {
      try {
        this.buildArticulation(info, links, used);
      } catch (e) {
        this.warnings.push(`${info.path}: 아티큘레이션 생성 실패, 일반 조인트로 시뮬레이션합니다 (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return { links, joints: used };
  }

  private buildArticulation(info: ArticulationInfo, links: Map<BodyInfo, PhysX.PxArticulationLink>, used: Set<JointInfo>): void {
    const { px, rt } = this;
    const d = this.description;
    const members = new Set(info.bodies.filter((b) => b.kind === "dynamic" && !links.has(b)));
    if (!members.size) return;
    const still = (b: BodyInfo | null) => !b || (!members.has(b) && !!b.welded);
    const anchor = d.joints.find(
      (j) => j.type === "fixed" && unbreakable(j) && ((j.body1 && members.has(j.body1) && still(j.body0)) || (j.body0 && members.has(j.body0) && still(j.body1))),
    );
    const root = anchor ? (anchor.body1 && members.has(anchor.body1) ? anchor.body1 : anchor.body0!) : [...members][0];
    const edges = d.joints.filter(
      (j) => j.body0 && j.body1 && j.body0 !== j.body1 && members.has(j.body0) && members.has(j.body1) && !j.excludeFromArticulation && articulationJointKind(j),
    );

    const art = rt.physics.createArticulationReducedCoordinate();
    const created: [BodyInfo, PhysX.PxArticulationLink][] = [];
    const addLink = (body: BodyInfo, parent: PhysX.PxArticulationLink | null) => {
      const pose = pxTransform(px, body.pose.position, body.pose.quaternion);
      const link = art.createLink(parent as PhysX.PxArticulationLink, pose);
      px.destroy(pose);
      this.setUpBody(link, body);
      this.applyDynamics(link, body);
      created.push([body, link]);
      return link;
    };
    const tree = new Map<BodyInfo, PhysX.PxArticulationLink>([[root, addLink(root, null)]]);
    const joints: ArticulatedJoint[] = [];
    for (const queue = [root]; queue.length; ) {
      const parent = queue.shift()!;
      for (const j of edges) {
        if (used.has(j) || (j.body0 !== parent && j.body1 !== parent)) continue;
        const sign = j.body0 === parent ? 1 : -1;
        const child = sign > 0 ? j.body1! : j.body0!;
        if (tree.has(child)) continue; // closes a loop: stays a maximal joint
        const link = addLink(child, tree.get(parent)!);
        tree.set(child, link);
        used.add(j);
        joints.push(this.configureArticulationJoint(link.getInboundJoint(), j, sign, tree.get(parent)!, link));
        queue.push(child);
      }
    }

    const Flag = px.PxArticulationFlagEnum;
    if (anchor) art.setArticulationFlag(Flag.eFIX_BASE, true);
    if (!info.selfCollision) art.setArticulationFlag(Flag.eDISABLE_SELF_COLLISION, true);
    const settings = d.physxScene;
    art.setSolverIterationCounts(clampCount(info.positionIterations, settings.positionIterations), clampCount(info.velocityIterations, settings.velocityIterations));
    this.scene!.addArticulation(art);
    this.articulations.push(art);
    for (const [body, link] of created) {
      links.set(body, link);
      this.links.add(link);
    }
    for (const j of joints) if (hasAnimatedDrives(j.info)) this.articulatedJoints.push(j);
  }

  /** Joint type, frames, limits, drives and starting position of an articulation link's inbound joint. */
  private configureArticulationJoint(
    joint: PhysX.PxArticulationJointReducedCoordinate,
    j: JointInfo,
    sign: number,
    parentLink: PhysX.PxArticulationLink,
    childLink: PhysX.PxArticulationLink,
  ): ArticulatedJoint {
    const { px } = this;
    const Type = px.PxArticulationJointTypeEnum;
    const Axis = px.PxArticulationAxisEnum;
    const Motion = px.PxArticulationMotionEnum;
    const parentFrame = sign > 0 ? j.frame0 : j.frame1;
    const childFrame = sign > 0 ? j.frame1 : j.frame0;
    const pp = pxTransform(px, parentFrame.position, parentFrame.quaternion);
    const cp = pxTransform(px, childFrame.position, childFrame.quaternion);
    joint.setParentPose(pp);
    joint.setChildPose(cp);
    px.destroy(pp);
    px.destroy(cp);

    // The child joint frame in the parent joint frame at load time gives the starting joint position.
    const frameOf = (link: PhysX.PxArticulationLink, f: Pose) => {
      const t = link.getGlobalPose();
      const q = new Quaternion(t.q.x, t.q.y, t.q.z, t.q.w);
      const p = new Vector3(t.p.x, t.p.y, t.p.z);
      return { position: f.position.clone().applyQuaternion(q).add(p), quaternion: q.multiply(f.quaternion) };
    };
    const pf = frameOf(parentLink, parentFrame);
    const cf = frameOf(childLink, childFrame);
    const inverse = pf.quaternion.clone().invert();
    const relRotation = inverse.clone().multiply(cf.quaternion);
    const relPosition = cf.position.clone().sub(pf.position).applyQuaternion(inverse);

    // Reversed (body1 is the parent): the joint coordinate flips sign.
    const range = (lower: number | undefined, upper: number | undefined) => (sign > 0 ? [lower, upper] : [upper === undefined ? undefined : -upper, lower === undefined ? undefined : -lower]);
    const limit = (axis: number, lower: number | undefined, upper: number | undefined, angular: boolean) => {
      const [lo, hi] = range(lower, upper);
      if (!finite(lo) && !finite(hi)) {
        joint.setMotion(axis, Motion.eFREE);
        return;
      }
      const bound = angular ? Math.PI * 2 - 1e-3 : PX_MAX_F32;
      const l = new px.PxArticulationLimit(finite(lo) ? Math.max(lo, -bound) : -bound, finite(hi) ? Math.min(hi, bound) : bound);
      joint.setMotion(axis, Motion.eLIMITED);
      joint.setLimitParams(axis, l);
      px.destroy(l);
    };
    const axes: ArticulatedJoint["axes"] = [];
    const drive = (name: keyof JointInfo["drives"], axis: number) => {
      const dr = j.drives[name];
      if (!dr) return;
      const envelope = new px.PxPerformanceEnvelope(finite(dr.maxForce) ? dr.maxForce : PX_MAX_F32, PX_MAX_F32, 0, 0);
      const DriveType = px.PxArticulationDriveTypeEnum;
      const pd = new px.PxArticulationDrive(dr.stiffness, dr.damping, envelope, dr.type === "acceleration" ? DriveType.eACCELERATION : DriveType.eFORCE);
      joint.setDriveParams(axis, pd);
      px.destroy(pd);
      px.destroy(envelope);
      axes.push([name, axis]);
    };
    const twistAngle = () => 2 * Math.atan2(relRotation.x, relRotation.w);

    switch (articulationJointKind(j)) {
      case "fixed":
        joint.setJointType(Type.eFIX);
        break;
      case "revolute": {
        const limited = finite(j.lower) || finite(j.upper);
        joint.setJointType(limited ? Type.eREVOLUTE : Type.eREVOLUTE_UNWRAPPED);
        limit(Axis.eTWIST, j.lower, j.upper, true);
        drive("angular", Axis.eTWIST);
        joint.setJointPosition(Axis.eTWIST, twistAngle());
        break;
      }
      case "prismatic": {
        joint.setJointType(Type.ePRISMATIC);
        if (j.type === "prismatic") {
          limit(Axis.eX, j.lower, j.upper, false);
          drive("linear", Axis.eX);
          joint.setJointPosition(Axis.eX, relPosition.x);
        } else {
          const dof = (["transX", "transY", "transZ"] as const).find((n) => !j.dofLimits?.[n] || j.dofLimits[n]!.low <= j.dofLimits[n]!.high)!;
          const axis = dof === "transX" ? Axis.eX : dof === "transY" ? Axis.eY : Axis.eZ;
          limit(axis, j.dofLimits?.[dof]?.low, j.dofLimits?.[dof]?.high, false);
          drive(dof, axis);
          joint.setJointPosition(axis, relPosition.getComponent(dof === "transX" ? 0 : dof === "transY" ? 1 : 2));
        }
        break;
      }
      case "spherical": {
        joint.setJointType(Type.eSPHERICAL);
        if (j.type === "spherical") {
          joint.setMotion(Axis.eTWIST, Motion.eFREE);
          // cone0 swings toward the second axis (about Z), cone1 toward the third (about Y).
          limit(Axis.eSWING1, finite(j.cone1) ? -j.cone1 : undefined, j.cone1, true);
          limit(Axis.eSWING2, finite(j.cone0) ? -j.cone0 : undefined, j.cone0, true);
        } else {
          const map = [
            ["rotX", Axis.eTWIST],
            ["rotY", Axis.eSWING1],
            ["rotZ", Axis.eSWING2],
          ] as const;
          for (const [dof, axis] of map) {
            const lim = j.dofLimits?.[dof];
            if (lim && lim.low > lim.high) joint.setMotion(axis, Motion.eLOCKED);
            else limit(axis, lim?.low, lim?.high, true);
            drive(dof, axis);
          }
        }
        break;
      }
    }
    for (const [name, axis] of axes) {
      const { position, velocity } = driveTargetsAt(j.drives[name]!, 0);
      joint.setDriveTarget(axis, sign * position);
      joint.setDriveVelocity(axis, sign * velocity);
    }
    // PhysxJointAPI defaults (no friction, no armature, unbounded speed), not PhysX's own
    // (friction 0.05, which holds a loaded robot joint still, and 100 rad/s).
    joint.setFrictionCoefficient(j.physx.friction);
    joint.setMaxJointVelocity(finite(j.physx.maxVelocity) ? j.physx.maxVelocity : 1e7);
    if (j.physx.armature > 0) for (const axis of [Axis.eTWIST, Axis.eSWING1, Axis.eSWING2, Axis.eX, Axis.eY, Axis.eZ]) joint.setArmature(axis, j.physx.armature);
    return { joint, info: j, sign, axes };
  }

  // ---------------------------------------------------------------- joints

  private createJoint(j: JointInfo): void {
    const { px, rt } = this;
    // A side without a body attaches to its static collider's actor when there is one,
    // so PhysX skips collisions between the jointed pair; its frame is then actor-local.
    const side = (body: BodyInfo | null, staticCollider: ColliderInfo | null, frame: Pose) => {
      if (body) return { actor: this.actors[body.index] as PhysX.PxRigidActor, frame };
      const actor = staticCollider ? this.staticByCollider.get(staticCollider) : undefined;
      if (!actor || !staticCollider) return { actor: null, frame };
      return { actor: actor as PhysX.PxRigidActor, frame: relativePose(staticCollider.localPose, frame) };
    };
    const s0 = side(j.body0, j.static0, j.frame0);
    const s1 = side(j.body1, j.static1, j.frame1);
    const a0 = s0.actor;
    const a1 = s1.actor;
    const f0 = pxTransform(px, s0.frame.position, s0.frame.quaternion);
    const f1 = pxTransform(px, s1.frame.position, s1.frame.quaternion);
    let joint: PhysX.PxJoint;

    if (j.type === "distance") {
      const dj = px.DistanceJointCreate(rt.physics, actorOrWorld(a0), f0, actorOrWorld(a1), f1);
      if (finite(j.minDistance)) {
        dj.setMinDistance(j.minDistance);
        dj.setDistanceJointFlag(px.PxDistanceJointFlagEnum.eMIN_DISTANCE_ENABLED, true);
      }
      if (finite(j.maxDistance)) {
        dj.setMaxDistance(j.maxDistance);
        dj.setDistanceJointFlag(px.PxDistanceJointFlagEnum.eMAX_DISTANCE_ENABLED, true);
      }
      joint = dj;
    } else {
      // Every other UsdPhysics joint is a D6 joint with the right axes freed.
      const d6 = px.D6JointCreate(rt.physics, actorOrWorld(a0), f0, actorOrWorld(a1), f1);
      this.configureD6(d6, j);
      const targets = d6DriveTargets(j, 0);
      if (targets) this.setDriveTargets(d6, targets);
      if (targets && hasAnimatedDrives(j)) this.animatedDrives.push({ joint: d6, info: j });
      joint = d6;
    }
    px.destroy(f0);
    px.destroy(f1);

    if (j.collisionEnabled) joint.setConstraintFlag(px.PxConstraintFlagEnum.eCOLLISION_ENABLED, true);
    if (finite(j.breakForce) || finite(j.breakTorque)) {
      joint.setBreakForce(finite(j.breakForce) ? j.breakForce : PX_MAX_F32, finite(j.breakTorque) ? j.breakTorque : PX_MAX_F32);
    }
    this.joints.push(joint);
  }

  private configureD6(d6: PhysX.PxD6Joint, j: JointInfo): void {
    const { px } = this;
    const Axis = px.PxD6AxisEnum;
    const Motion = px.PxD6MotionEnum;
    const DriveAxis = px.PxD6DriveEnum;
    d6.setAngularDriveConfig(px.PxD6AngularDriveConfigEnum.eSWING_TWIST);
    // Soft limits (physxLimit stiffness/damping) are limits with a spring.
    type SpringName = keyof JointInfo["limitSprings"];
    const springOf = (name: SpringName) => new px.PxSpring(j.limitSprings[name]?.stiffness ?? 0, j.limitSprings[name]?.damping ?? 0);

    const angularPair = (lower: number | undefined, upper: number | undefined, springName: SpringName) => {
      const lo = finite(lower) ? lower : -Math.PI * 2 + 1e-3;
      const hi = finite(upper) ? upper : Math.PI * 2 - 1e-3;
      const spring = springOf(springName);
      const limit = new px.PxJointAngularLimitPair(Math.max(lo, -Math.PI * 2 + 1e-3), Math.min(hi, Math.PI * 2 - 1e-3), spring);
      d6.setTwistLimit(limit);
      px.destroy(limit);
      px.destroy(spring);
    };
    const linearPair = (axis: number, lower: number | undefined, upper: number | undefined, springName: SpringName) => {
      const spring = springOf(springName);
      const limit = new px.PxJointLinearLimitPair(finite(lower) ? lower : -PX_MAX_F32, finite(upper) ? upper : PX_MAX_F32, spring);
      d6.setLinearLimit(axis, limit);
      px.destroy(limit);
      px.destroy(spring);
    };
    const cone = (y: number, z: number, springName: SpringName) => {
      const spring = springOf(springName);
      const limit = new px.PxJointLimitCone(Math.min(y, Math.PI - 1e-3), Math.min(z, Math.PI - 1e-3), spring);
      d6.setSwingLimit(limit);
      px.destroy(limit);
      px.destroy(spring);
    };
    const drive = (axis: number, dr: JointDrive) => {
      const pd = new px.PxD6JointDrive(dr.stiffness, dr.damping, finite(dr.maxForce) ? dr.maxForce : PX_MAX_F32, dr.type === "acceleration");
      d6.setDrive(axis, pd);
      px.destroy(pd);
    };

    // Drive targets are set by the caller (d6DriveTargets), here only the drives.
    switch (j.type) {
      case "revolute": {
        const limited = finite(j.lower) || finite(j.upper);
        d6.setMotion(Axis.eTWIST, limited ? Motion.eLIMITED : Motion.eFREE);
        if (limited) angularPair(j.lower, j.upper, "angular");
        if (j.drives.angular) drive(DriveAxis.eTWIST, j.drives.angular);
        break;
      }
      case "prismatic": {
        const limited = finite(j.lower) || finite(j.upper);
        d6.setMotion(Axis.eX, limited ? Motion.eLIMITED : Motion.eFREE);
        if (limited) linearPair(Axis.eX, j.lower, j.upper, "linear");
        if (j.drives.linear) drive(DriveAxis.eX, j.drives.linear);
        break;
      }
      case "spherical": {
        d6.setMotion(Axis.eTWIST, Motion.eFREE);
        const limited = finite(j.cone0) || finite(j.cone1);
        d6.setMotion(Axis.eSWING1, limited ? Motion.eLIMITED : Motion.eFREE);
        d6.setMotion(Axis.eSWING2, limited ? Motion.eLIMITED : Motion.eFREE);
        // cone0 swings toward the second axis (about Z), cone1 toward the third (about Y).
        if (limited) cone(j.cone1 ?? Math.PI, j.cone0 ?? Math.PI, "angular");
        break;
      }
      case "fixed":
        break; // a D6 joint is fully locked by default
      case "generic": {
        const map: Record<Dof, number> = {
          transX: Axis.eX,
          transY: Axis.eY,
          transZ: Axis.eZ,
          rotX: Axis.eTWIST,
          rotY: Axis.eSWING1,
          rotZ: Axis.eSWING2,
        };
        for (const dof of Object.keys(map) as Dof[]) {
          const lim = j.dofLimits?.[dof];
          if (!lim) d6.setMotion(map[dof], Motion.eFREE);
          else if (lim.low > lim.high) d6.setMotion(map[dof], Motion.eLOCKED);
          else d6.setMotion(map[dof], Number.isFinite(lim.low) || Number.isFinite(lim.high) ? Motion.eLIMITED : Motion.eFREE);
        }
        for (const dof of ["transX", "transY", "transZ"] as const) {
          const lim = j.dofLimits?.[dof];
          if (lim && lim.low <= lim.high) linearPair(map[dof], lim.low, lim.high, dof);
        }
        const twist = j.dofLimits?.rotX;
        if (twist && twist.low <= twist.high) angularPair(twist.low, twist.high, "rotX");
        const swingY = j.dofLimits?.rotY;
        const swingZ = j.dofLimits?.rotZ;
        if ((swingY && swingY.low <= swingY.high) || (swingZ && swingZ.low <= swingZ.high)) {
          cone(
            swingY ? Math.max(Math.abs(swingY.low), Math.abs(swingY.high)) : Math.PI,
            swingZ ? Math.max(Math.abs(swingZ.low), Math.abs(swingZ.high)) : Math.PI,
            j.limitSprings.rotY ? "rotY" : "rotZ",
          );
        }
        const driveAxis: Record<Dof, number> = {
          transX: DriveAxis.eX,
          transY: DriveAxis.eY,
          transZ: DriveAxis.eZ,
          rotX: DriveAxis.eTWIST,
          rotY: DriveAxis.eSWING1,
          rotZ: DriveAxis.eSWING2,
        };
        for (const dof of Object.keys(driveAxis) as Dof[]) {
          const dr = j.drives[dof];
          if (dr) drive(driveAxis[dof], dr);
        }
        break;
      }
    }
  }

  private setDriveTargets(d6: PhysX.PxD6Joint, { position, rotation, linear, angular }: D6Targets): void {
    const { px } = this;
    const t = pxTransform(px, position, rotation);
    d6.setDrivePosition(t);
    px.destroy(t);
    const v = pxVec3(px, linear);
    const w = pxVec3(px, angular);
    d6.setDriveVelocity(v, w);
    px.destroy(v);
    px.destroy(w);
  }

  // ---------------------------------------------------------------- stepping

  advance(): void {
    if (!this.scene) return;
    // Time-sampled drive targets for the end of this step, as kinematic targets are.
    for (const { joint, info } of this.animatedDrives) {
      const targets = d6DriveTargets(info, this.simTime + this.dt);
      if (targets) this.setDriveTargets(joint, targets);
    }
    for (const { joint, info, sign, axes } of this.articulatedJoints) {
      for (const [name, axis] of axes) {
        const { position, velocity } = driveTargetsAt(info.drives[name]!, this.simTime + this.dt);
        joint.setDriveTarget(axis, sign * position);
        joint.setDriveVelocity(axis, sign * velocity);
      }
    }
    this.scene.simulate(this.dt);
    this.scene.fetchResults(true);
    this.simTime += this.dt;
    this.readBack();
  }

  private readBack(): void {
    for (let i = 0; i < this.actors.length; i++) {
      // getGlobalPose() returns a shared temporary: copy it out immediately.
      const t = this.actors[i].getGlobalPose();
      const o = i * 7;
      this.poses[o] = t.p.x;
      this.poses[o + 1] = t.p.y;
      this.poses[o + 2] = t.p.z;
      this.poses[o + 3] = t.q.x;
      this.poses[o + 4] = t.q.y;
      this.poses[o + 5] = t.q.z;
      this.poses[o + 6] = t.q.w;
    }
  }

  setRunning(): void {}

  stepFrame(): void {
    this.advance();
  }

  setSpeed(): void {}

  readPoses(): Float32Array | null {
    return this.poses;
  }

  readParticles(): Float32Array | null {
    return null;
  }

  time(): number {
    return this.simTime;
  }

  async reset(): Promise<void> {
    this.teardown();
    this.simTime = 0;
    this.build();
  }

  setKinematicPose(index: number, position: Vector3, quaternion: Quaternion): void {
    const actor = this.actors[index];
    if (!actor || !this.held[index]) return;
    const t = pxTransform(this.px, position, quaternion);
    (actor as PhysX.PxRigidDynamic).setKinematicTarget(t);
    this.px.destroy(t);
  }

  // ---------------------------------------------------------------- mouse drag

  beginDrag(index: number, local: Vector3, target: Vector3): void {
    this.endDrag();
    const actor = this.actors[index];
    if (!actor || this.held[index] || !this.scene) return;
    const { px, rt } = this;
    const pose = pxTransform(px, target, new Quaternion());
    const anchor = rt.physics.createRigidDynamic(pose);
    px.destroy(pose);
    anchor.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    this.scene.addActor(anchor);

    const f0 = pxTransform(px, new Vector3(), new Quaternion());
    const f1 = pxTransform(px, local, new Quaternion());
    const joint = px.D6JointCreate(rt.physics, anchor, f0, actor, f1);
    px.destroy(f0);
    px.destroy(f1);
    const Axis = px.PxD6AxisEnum;
    for (const axis of [Axis.eX, Axis.eY, Axis.eZ, Axis.eTWIST, Axis.eSWING1, Axis.eSWING2]) joint.setMotion(axis, px.PxD6MotionEnum.eFREE);
    const drive = new px.PxD6JointDrive(DRAG_STIFFNESS, DRAG_DAMPING, PX_MAX_F32, true);
    for (const axis of [px.PxD6DriveEnum.eX, px.PxD6DriveEnum.eY, px.PxD6DriveEnum.eZ]) joint.setDrive(axis, drive);
    px.destroy(drive);
    if (this.links.has(actor)) (actor as PhysX.PxArticulationLink).getArticulation().wakeUp();
    else (actor as PhysX.PxRigidDynamic).wakeUp();
    this.drag = { anchor, joint };
  }

  updateDrag(target: Vector3): void {
    if (!this.drag) return;
    const t = pxTransform(this.px, target, new Quaternion());
    this.drag.anchor.setKinematicTarget(t);
    this.px.destroy(t);
  }

  dragParticle(): void {
    // PhysX (WASM) has no deformables.
  }

  endDrag(): void {
    if (!this.drag || !this.scene) return;
    this.drag.joint.release();
    this.scene.removeActor(this.drag.anchor);
    this.drag.anchor.release();
    this.drag = null;
  }

  // ---------------------------------------------------------------- teardown

  /** Release in dependency order: joints, actors, scene, then shared meshes and materials. */
  private teardown(): void {
    this.endDrag();
    this.animatedDrives = [];
    this.articulatedJoints = [];
    for (const joint of this.joints.splice(0)) joint.release();
    for (const actor of this.actors.splice(0)) if (!this.links.has(actor)) actor.release();
    for (const art of this.articulations.splice(0)) art.release();
    this.links.clear();
    for (const actor of this.statics.splice(0)) actor.release();
    this.staticByCollider.clear();
    this.scene?.release();
    this.scene = null;
    if (this.filterShader) this.px.destroy(this.filterShader);
    this.filterShader = null;
    for (const mesh of this.meshes.splice(0)) mesh.release();
    for (const m of this.materials.values()) m.release();
    this.materials.clear();
  }

  dispose(): void {
    if (this.scene) this.teardown();
  }
}
