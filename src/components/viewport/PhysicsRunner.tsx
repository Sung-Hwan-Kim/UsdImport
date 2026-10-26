"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Matrix4, Plane, Quaternion, Raycaster, Vector2, Vector3, type Object3D } from "three";
import { createClothState, nearestClothPoint, restoreCloth, updateCloth, type ClothState } from "@/lib/physics/cloth";
import type { EngineKind, EngineLoadResult, PhysicsEngine } from "@/lib/physics/engine";
import { NewtonEngine } from "@/lib/physics/newton/newtonEngine";
import { PhysXEngine } from "@/lib/physics/physx/physxEngine";
import { authoredAttribute, extractPhysics } from "@/lib/physics/schema";
import { isShownInHierarchy } from "@/lib/scene";
import { useViewer, type PhysicsCommand } from "@/lib/store";
import type { LoadedStage } from "@/lib/usd/loadStage";

// Catch up at most this many fixed steps per rendered frame, then drop time.
const MAX_STEPS_PER_FRAME = 8;

interface Session {
  engine: PhysicsEngine;
  result: EngineLoadResult;
  /** Body local transforms before simulation, restored on reset/stop. */
  snapshot: { position: Vector3; quaternion: Quaternion; scale: Vector3 }[];
  /** Each body's scale in the pose frame (simulated poses carry none). */
  scales: Vector3[];
  /** Body indices, parents before children. */
  order: number[];
  bodyIndex: Map<Object3D, number>;
  cloths: ClothState[];
  clothByObject: Map<Object3D, ClothState>;
  accumulator: number;
}

function createEngine(kind: EngineKind): PhysicsEngine {
  if (kind === "physx") return new PhysXEngine();
  const { session, settings, setPhysics } = useViewer.getState();
  if (!session) throw new Error("Newton 서버로 보낼 스테이지 소스가 없습니다.");
  // Errors after loading (server crash, dropped connection) surface on the physics bar.
  return new NewtonEngine(settings.newtonUrl, session, (message) => setPhysics({ status: "error", message }));
}

function depthOf(obj: Object3D): number {
  let d = 0;
  for (let cur = obj.parent; cur; cur = cur.parent) d++;
  return d;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const tmpMatrix = new Matrix4();
const tmpInverse = new Matrix4();
const tmpPosition = new Vector3();
const tmpQuaternion = new Quaternion();
const tmpScale = new Vector3();

/**
 * Drives the active physics engine for one stage: loads it on the first Play,
 * steps local engines on a fixed timestep, and writes body poses back onto
 * the stage's objects. Commands arrive through `useViewer().physics.command`.
 */
export default function PhysicsRunner({ stage }: { stage: LoadedStage }) {
  const command = useViewer((s) => s.physics.command);
  const speed = useViewer((s) => s.physics.speed);
  const upAxis = useViewer((s) => s.settings.upAxis);
  const get = useThree((s) => s.get);
  const session = useRef<Session | null>(null);
  const starting = useRef<Promise<Session | null> | null>(null);
  // Commands issued before this runner mounted belong to an earlier stage.
  const handled = useRef(command.nonce);
  const disposed = useRef(false);

  /** Pose-frame matrix of an object: world, or relative to the stage root. */
  const frameMatrix = (s: Session, obj: Object3D, out: Matrix4) => {
    out.copy(obj.matrixWorld);
    if (s.result.frame === "stage") out.premultiply(tmpInverse.copy(stage.scene.matrixWorld).invert());
    return out;
  };

  const applyPoses = (s: Session) => {
    const particles = s.cloths.length ? s.engine.readParticles() : null;
    if (particles) for (const cloth of s.cloths) updateCloth(cloth, particles);
    const poses = s.engine.readPoses();
    if (!poses) return;
    stage.scene.updateMatrixWorld();
    for (const i of s.order) {
      if (s.result.kinematic[i]) continue;
      const obj = s.result.bodies[i];
      const o = i * 7;
      tmpPosition.set(poses[o], poses[o + 1], poses[o + 2]);
      tmpQuaternion.set(poses[o + 3], poses[o + 4], poses[o + 5], poses[o + 6]);
      tmpMatrix.compose(tmpPosition, tmpQuaternion, s.scales[i]);
      if (s.result.frame === "stage") tmpMatrix.premultiply(stage.scene.matrixWorld);
      if (obj.parent) tmpMatrix.premultiply(tmpInverse.copy(obj.parent.matrixWorld).invert());
      tmpMatrix.decompose(obj.position, obj.quaternion, obj.scale);
      obj.updateMatrixWorld(true);
    }
  };

  const feedKinematic = (s: Session) => {
    for (let i = 0; i < s.result.bodies.length; i++) {
      if (!s.result.kinematic[i]) continue;
      frameMatrix(s, s.result.bodies[i], tmpMatrix).decompose(tmpPosition, tmpQuaternion, tmpScale);
      s.engine.setKinematicPose(i, tmpPosition, tmpQuaternion);
    }
  };

  const restore = (s: Session) => {
    for (const cloth of s.cloths) restoreCloth(cloth);
    s.result.bodies.forEach((obj, i) => {
      const t = s.snapshot[i];
      obj.position.copy(t.position);
      obj.quaternion.copy(t.quaternion);
      obj.scale.copy(t.scale);
    });
    stage.scene.updateMatrixWorld(true);
  };

  const teardown = () => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    s.engine.dispose();
    restore(s);
  };

  const start = (): Promise<Session | null> => {
    if (starting.current) return starting.current;
    const { settings, setPhysics } = useViewer.getState();
    setPhysics({ status: "loading", message: null, warnings: [] });
    const promise = (async () => {
      try {
        stage.scene.updateMatrixWorld(true);
        const description = extractPhysics(stage);
        const hasCloth = description.deformables.some((d) => d.kind === "surface");
        if (!description.bodies.length && !(hasCloth && settings.physicsEngine === "newton")) {
          throw new Error(
            hasCloth ? "천만 있는 스테이지는 Newton 엔진에서 재생할 수 있습니다." : "시뮬레이션할 리지드 바디(PhysicsRigidBodyAPI)가 없습니다.",
          );
        }
        const engine = createEngine(settings.physicsEngine);
        const result = await engine.load(stage, description);
        if (disposed.current) {
          engine.dispose();
          return null;
        }
        const s: Session = {
          engine,
          result,
          snapshot: result.bodies.map((o) => ({ position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() })),
          scales: [],
          order: result.bodies.map((_, i) => i).sort((a, b) => depthOf(result.bodies[a]) - depthOf(result.bodies[b])),
          bodyIndex: new Map(result.bodies.map((o, i) => [o, i])),
          cloths: [],
          clothByObject: new Map(),
          accumulator: 0,
        };
        const frameToWorld = result.frame === "stage" ? stage.scene.matrixWorld : new Matrix4();
        for (const binding of result.cloths) {
          const points = authoredAttribute(stage, binding.object, "points") as ArrayLike<number> | undefined;
          const cloth = points ? createClothState(binding, points, frameToWorld) : "USD 점(points)이 없습니다";
          if (typeof cloth === "string") {
            result.warnings.push(`${binding.object.name}: 천을 표시할 수 없습니다 — ${cloth}.`);
            continue;
          }
          s.cloths.push(cloth);
          s.clothByObject.set(cloth.mesh, cloth);
        }
        s.scales = result.bodies.map((o) => {
          frameMatrix(s, o, tmpMatrix).decompose(tmpPosition, tmpQuaternion, tmpScale);
          return tmpScale.clone();
        });
        engine.setSpeed(useViewer.getState().physics.speed);
        session.current = s;
        if (result.warnings.length) console.warn("[physics]", result.warnings);
        setPhysics({ status: "paused", label: result.label, warnings: result.warnings, description, time: 0 });
        return s;
      } catch (e) {
        console.error(e);
        setPhysics({ status: "error", message: errorMessage(e) });
        return null;
      } finally {
        starting.current = null;
      }
    })();
    starting.current = promise;
    return promise;
  };

  const run = async (type: PhysicsCommand) => {
    const { setPhysics } = useViewer.getState();
    switch (type) {
      case "play": {
        const s = session.current ?? (await start());
        if (!s) return;
        s.engine.setRunning(true);
        setPhysics({ status: "running" });
        break;
      }
      case "pause": {
        const s = session.current;
        if (!s) return;
        s.engine.setRunning(false);
        setPhysics({ status: "paused" });
        break;
      }
      case "step": {
        const s = session.current ?? (await start());
        if (!s) return;
        s.engine.setRunning(false);
        if (s.engine.remote) s.engine.stepFrame();
        else {
          feedKinematic(s);
          s.engine.advance();
        }
        applyPoses(s);
        setPhysics({ status: "paused", time: s.engine.time() });
        break;
      }
      case "reset": {
        const s = session.current;
        if (!s) return;
        s.engine.setRunning(false);
        restore(s);
        await s.engine.reset();
        s.accumulator = 0;
        setPhysics({ status: "paused", time: 0 });
        break;
      }
      case "stop":
        teardown();
        setPhysics({ status: "off", time: 0, label: null, description: null });
        break;
    }
  };

  useEffect(() => {
    if (command.nonce === handled.current) return;
    handled.current = command.nonce;
    void run(command.type);
    // run() reads everything else through refs and the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  useEffect(() => {
    session.current?.engine.setSpeed(speed);
  }, [speed]);

  // Changing the up axis re-poses the stage; start the simulation over.
  const firstAxis = useRef(true);
  useEffect(() => {
    if (firstAxis.current) {
      firstAxis.current = false;
      return;
    }
    if (!session.current) return;
    teardown();
    useViewer.getState().setPhysics({ status: "off", time: 0, label: null, description: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upAxis]);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mouse grab: once a simulation is loaded, a left-drag that starts on a dynamic
  // body pulls it with a spring toward a point on a camera-facing plane, and one
  // on a cloth holds its nearest particle at that point (a paused simulation
  // resumes). Listeners sit in the capture phase on the element camera controls
  // and R3F listen on, so neither sees a press that lands on a body or cloth.
  useEffect(() => {
    const { gl, events } = get();
    const canvas = gl.domElement;
    const source = (events.connected as HTMLElement | undefined) ?? canvas;
    const raycaster = new Raycaster();
    const plane = new Plane();
    const ndc = new Vector2();
    // A press on a body becomes a grab only once the pointer moves; a plain click selects.
    const GRAB_THRESHOLD = 4;
    let press: {
      pointerId: number;
      x: number;
      y: number;
      object: Object3D;
      grabbing: boolean;
      /** A rigid body: grab point in its frame, start target in the pose frame. */
      body?: { index: number; local: Vector3; target: Vector3 };
      /** A cloth particle: its offset from the point under the pointer (pose frame). */
      particle?: { index: number; offset: Vector3; start: Vector3 };
    } | null = null;
    let swallowClick = false;
    let hover: PointerEvent | null = null;
    let hoverFrame = 0;

    const setControls = (enabled: boolean) => {
      const controls = get().controls as { enabled?: boolean } | null;
      if (controls) controls.enabled = enabled;
    };
    const castRay = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, get().camera);
    };
    const toFrame = (s: Session, world: Vector3) =>
      s.result.frame === "stage" ? world.clone().applyMatrix4(tmpInverse.copy(stage.scene.matrixWorld).invert()) : world.clone();
    /** The dynamic body or simulated cloth under the pointer, if a simulation is loaded. */
    const pick = (e: PointerEvent) => {
      const s = session.current;
      const status = useViewer.getState().physics.status;
      if (!s || (status !== "running" && status !== "paused")) return null;
      castRay(e);
      const hit = raycaster.intersectObject(stage.scene, true).find((h) => isShownInHierarchy(h.object));
      if (!hit) return null;
      const cloth = s.clothByObject.get(hit.object);
      if (cloth) return hit.face ? { s, hit, cloth } : null;
      let index = -1;
      for (let cur: Object3D | null = hit.object; cur && index < 0; cur = cur.parent) index = s.bodyIndex.get(cur) ?? -1;
      if (index < 0 || s.result.kinematic[index]) return null;
      return { s, hit, body: index };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const picked = pick(e);
      if (!picked) return;
      const { s, hit } = picked;

      e.stopImmediatePropagation();
      e.preventDefault();
      const grabPoint = toFrame(s, hit.point);
      let body: NonNullable<typeof press>["body"];
      let particle: NonNullable<typeof press>["particle"];
      if (picked.cloth) {
        const index = picked.cloth.binding.start + nearestClothPoint(picked.cloth, hit.face!, hit.point);
        const particles = s.engine.readParticles();
        const start = particles ? new Vector3().fromArray(particles, index * 3) : grabPoint.clone();
        particle = { index, start, offset: start.clone().sub(grabPoint) };
      } else {
        const index = picked.body!;
        frameMatrix(s, s.result.bodies[index], tmpMatrix).decompose(tmpPosition, tmpQuaternion, tmpScale);
        const local = grabPoint.clone().sub(tmpPosition).applyQuaternion(tmpQuaternion.invert());
        body = { index, local, target: grabPoint };
      }
      plane.setFromNormalAndCoplanarPoint(get().camera.getWorldDirection(new Vector3()).negate(), hit.point);
      setControls(false);
      try {
        source.setPointerCapture(e.pointerId);
      } catch {
        // Not an active pointer (e.g. synthetic events); moves still arrive while over the canvas.
      }
      press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, object: hit.object, grabbing: false, body, particle };
    };
    const onMove = (e: PointerEvent) => {
      const s = session.current;
      if (!press || !s) return;
      if (!press.grabbing) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < GRAB_THRESHOLD) return;
        press.grabbing = true;
        if (press.body) s.engine.beginDrag(press.body.index, press.body.local, press.body.target);
        if (press.particle) s.engine.dragParticle(press.particle.index, press.particle.start);
        canvas.style.cursor = "grabbing";
        const { physics, physicsCommand } = useViewer.getState();
        if (physics.status === "paused") physicsCommand("play");
      }
      castRay(e);
      const point = raycaster.ray.intersectPlane(plane, new Vector3());
      if (!point) return;
      if (press.particle) s.engine.dragParticle(press.particle.index, toFrame(s, point).add(press.particle.offset));
      else s.engine.updateDrag(toFrame(s, point));
    };
    const onUp = () => {
      if (!press) return;
      if (press.grabbing) session.current?.engine.endDrag();
      else useViewer.getState().select(press.object);
      setControls(true);
      if (source.hasPointerCapture(press.pointerId)) source.releasePointerCapture(press.pointerId);
      canvas.style.cursor = "";
      press = null;
      // The click that follows this pointerup was handled here; keep R3F from re-selecting.
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopImmediatePropagation();
    };
    // Show an open hand over grabbable bodies, at most one raycast per frame.
    const onHover = (e: PointerEvent) => {
      if (press || e.buttons) return;
      hover = e;
      hoverFrame ||= requestAnimationFrame(() => {
        hoverFrame = 0;
        if (hover && !press) canvas.style.cursor = pick(hover) ? "grab" : "";
      });
    };
    const onLeave = () => {
      hover = null;
      if (!press) canvas.style.cursor = "";
    };

    source.addEventListener("pointerdown", onDown, { capture: true });
    source.addEventListener("pointermove", onMove);
    source.addEventListener("pointermove", onHover);
    source.addEventListener("pointerleave", onLeave);
    source.addEventListener("pointerup", onUp);
    source.addEventListener("pointercancel", onUp);
    source.addEventListener("click", onClick, { capture: true });
    return () => {
      onUp();
      cancelAnimationFrame(hoverFrame);
      canvas.style.cursor = "";
      source.removeEventListener("pointerdown", onDown, { capture: true });
      source.removeEventListener("pointermove", onMove);
      source.removeEventListener("pointermove", onHover);
      source.removeEventListener("pointerleave", onLeave);
      source.removeEventListener("pointerup", onUp);
      source.removeEventListener("pointercancel", onUp);
      source.removeEventListener("click", onClick, { capture: true });
    };
    // frameMatrix reads only refs and the stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get, stage]);

  // Runs after StageModel's animation update, so simulated bodies win.
  useFrame((_, delta) => {
    const s = session.current;
    if (!s) return;
    const physics = useViewer.getState().physics;
    if (physics.status === "running" && !s.engine.remote) {
      s.accumulator += Math.min(delta, 0.1) * physics.speed;
      let steps = 0;
      while (s.accumulator >= s.result.dt && steps < MAX_STEPS_PER_FRAME) {
        feedKinematic(s);
        s.engine.advance();
        s.accumulator -= s.result.dt;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) s.accumulator = 0;
    }
    applyPoses(s);
    const time = s.engine.time();
    if (physics.status === "running" && time !== physics.time) useViewer.getState().setPhysics({ time });
  });

  return null;
}
