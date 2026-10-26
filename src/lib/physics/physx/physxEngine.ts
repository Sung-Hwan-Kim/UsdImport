import { Quaternion, Vector3 } from "three";
import type { LoadedStage } from "../../usd/loadStage";
import type { EngineLoadResult, PhysicsEngine } from "../engine";
import {
  axisRotation,
  driveTargetsAt,
  hasAnimatedDrives,
  relativePose,
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
  type PhysX,
  type PhysXRuntime,
  type Px,
} from "./px";

const DEFAULT_DENSITY = 1000; // kg/m³
// Mouse spring, as an acceleration drive so light and heavy bodies follow alike.
const DRAG_STIFFNESS = 400;
const DRAG_DAMPING = 40;

interface Releasable {
  release(): void;
}

function finite(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
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
  private actors: PhysX.PxRigidDynamic[] = [];
  private statics: PhysX.PxRigidStatic[] = [];
  private staticByCollider = new Map<ColliderInfo, PhysX.PxRigidStatic>();
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
      kinematic: description.bodies.map((b) => b.kind === "kinematic"),
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
    sceneDesc.filterShader = px.DefaultFilterShader();
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

    this.actors = d.bodies.map((body) => this.createBody(body));
    for (const joint of d.joints) {
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
    const key = `${m.staticFriction}|${m.dynamicFriction}|${m.restitution}`;
    let mat = this.materials.get(key);
    if (!mat) {
      mat = this.rt.physics.createMaterial(m.staticFriction, m.dynamicFriction, m.restitution);
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
    const filter = new px.PxFilterData(1, 0xffffffff, 0, 0);
    shape.setSimulationFilterData(filter);
    px.destroy(filter);

    const rotation = isStatic ? new Quaternion() : c.localPose.quaternion.clone();
    const position = isStatic ? new Vector3() : c.localPose.position;
    if (c.shape === "capsule" && c.axis) rotation.multiply(axisRotation(c.axis));
    const local = pxTransform(px, position, rotation);
    shape.setLocalPose(local);
    px.destroy(local);
    // Default contact offsets (2 cm) swallow centimetre-scale objects.
    const contact = Math.min(0.02, Math.max(0.001, shapeSize(c) * 0.2));
    shape.setContactOffset(contact);
    shape.setRestOffset(0);
    actor.attachShape(shape);
    shape.release();
  }

  private createBody(body: BodyInfo): PhysX.PxRigidDynamic {
    const { px, rt } = this;
    const pose = pxTransform(px, body.pose.position, body.pose.quaternion);
    const actor = rt.physics.createRigidDynamic(pose);
    px.destroy(pose);
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

    if (body.kind === "kinematic") {
      actor.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    } else {
      const v = pxVec3(px, body.linearVelocity);
      const w = pxVec3(px, body.angularVelocity);
      actor.setLinearVelocity(v);
      actor.setAngularVelocity(w);
      px.destroy(v);
      px.destroy(w);
      actor.setSolverIterationCounts(8, 2);
    }
    this.scene!.addActor(actor);
    return actor;
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
    const noSpring = () => new px.PxSpring(0, 0);

    const angularPair = (lower: number | undefined, upper: number | undefined) => {
      const lo = finite(lower) ? lower : -Math.PI * 2 + 1e-3;
      const hi = finite(upper) ? upper : Math.PI * 2 - 1e-3;
      const limit = new px.PxJointAngularLimitPair(Math.max(lo, -Math.PI * 2 + 1e-3), Math.min(hi, Math.PI * 2 - 1e-3));
      d6.setTwistLimit(limit);
      px.destroy(limit);
    };
    const linearPair = (axis: number, lower: number | undefined, upper: number | undefined) => {
      const spring = noSpring();
      const limit = new px.PxJointLinearLimitPair(finite(lower) ? lower : -PX_MAX_F32, finite(upper) ? upper : PX_MAX_F32, spring);
      d6.setLinearLimit(axis, limit);
      px.destroy(limit);
      px.destroy(spring);
    };
    const cone = (y: number, z: number) => {
      const limit = new px.PxJointLimitCone(Math.min(y, Math.PI - 1e-3), Math.min(z, Math.PI - 1e-3));
      d6.setSwingLimit(limit);
      px.destroy(limit);
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
        if (limited) angularPair(j.lower, j.upper);
        if (j.drives.angular) drive(DriveAxis.eTWIST, j.drives.angular);
        break;
      }
      case "prismatic": {
        const limited = finite(j.lower) || finite(j.upper);
        d6.setMotion(Axis.eX, limited ? Motion.eLIMITED : Motion.eFREE);
        if (limited) linearPair(Axis.eX, j.lower, j.upper);
        if (j.drives.linear) drive(DriveAxis.eX, j.drives.linear);
        break;
      }
      case "spherical": {
        d6.setMotion(Axis.eTWIST, Motion.eFREE);
        const limited = finite(j.cone0) || finite(j.cone1);
        d6.setMotion(Axis.eSWING1, limited ? Motion.eLIMITED : Motion.eFREE);
        d6.setMotion(Axis.eSWING2, limited ? Motion.eLIMITED : Motion.eFREE);
        // cone0 swings toward the second axis (about Z), cone1 toward the third (about Y).
        if (limited) cone(j.cone1 ?? Math.PI, j.cone0 ?? Math.PI);
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
          if (lim && lim.low <= lim.high) linearPair(map[dof], lim.low, lim.high);
        }
        const twist = j.dofLimits?.rotX;
        if (twist && twist.low <= twist.high) angularPair(twist.low, twist.high);
        const swingY = j.dofLimits?.rotY;
        const swingZ = j.dofLimits?.rotZ;
        if ((swingY && swingY.low <= swingY.high) || (swingZ && swingZ.low <= swingZ.high)) {
          cone(swingY ? Math.max(Math.abs(swingY.low), Math.abs(swingY.high)) : Math.PI, swingZ ? Math.max(Math.abs(swingZ.low), Math.abs(swingZ.high)) : Math.PI);
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
    if (!actor) return;
    const t = pxTransform(this.px, position, quaternion);
    actor.setKinematicTarget(t);
    this.px.destroy(t);
  }

  // ---------------------------------------------------------------- mouse drag

  beginDrag(index: number, local: Vector3, target: Vector3): void {
    this.endDrag();
    const actor = this.actors[index];
    if (!actor || this.description.bodies[index]?.kind !== "dynamic" || !this.scene) return;
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
    actor.wakeUp();
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
    for (const joint of this.joints.splice(0)) joint.release();
    for (const actor of this.actors.splice(0)) actor.release();
    for (const actor of this.statics.splice(0)) actor.release();
    this.staticByCollider.clear();
    this.scene?.release();
    this.scene = null;
    for (const mesh of this.meshes.splice(0)) mesh.release();
    for (const m of this.materials.values()) m.release();
    this.materials.clear();
  }

  dispose(): void {
    if (this.scene) this.teardown();
  }
}
