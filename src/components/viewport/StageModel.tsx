"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Sphere, Vector3, type DirectionalLight, type Mesh } from "three";
import { applyShading, computeBounds, fitDirectionalShadow, isShownInHierarchy } from "@/lib/scene";
import { useViewer } from "@/lib/store";
import type { LoadedStage } from "@/lib/usd/loadStage";
import { poseStageAt, releaseStageAnimation, simulationDrivesTimeline } from "@/lib/usd/stageAnimation";

export default function StageModel({ stage }: { stage: LoadedStage }) {
  const upAxis = useViewer((s) => s.settings.upAxis);
  const shading = useViewer((s) => s.settings.shading);
  const sceneLights = useViewer((s) => s.settings.sceneLights);
  const shadows = useViewer((s) => s.settings.shadows);
  const select = useViewer((s) => s.select);
  const requestFocus = useViewer((s) => s.requestFocus);
  const setBounds = useViewer((s) => s.setBounds);
  const bounds = useViewer((s) => s.bounds);
  const framedAxis = useRef<string | null>(null);

  // Up-axis: the composer already rotates Z-up stages; allow overriding it.
  useLayoutEffect(() => {
    const axis = upAxis === "auto" ? stage.metadata.upAxis : upAxis;
    stage.scene.rotation.set(axis === "Z" ? -Math.PI / 2 : 0, 0, 0);
    const box = computeBounds(stage.scene);
    const sphere = box.getBoundingSphere(new Sphere());
    const size = box.getSize(sphere.center.clone());
    setBounds({
      center: sphere.center.toArray(),
      size: size.toArray(),
      radius: Math.max(sphere.radius, 1e-4),
      floorY: box.min.y,
    });
    // Reframe when the axis setting changes, not when the effect re-runs (StrictMode, a reload keeping the view).
    if (framedAxis.current !== null && framedAxis.current !== upAxis) requestFocus("stage", true);
    framedAxis.current = upAxis;
  }, [stage, upAxis, setBounds, requestFocus]);

  useLayoutEffect(() => applyShading(stage.scene, shading), [stage, shading]);

  useLayoutEffect(() => {
    stage.scene.traverse((obj) => {
      if ((obj as { isLight?: boolean }).isLight) obj.visible = sceneLights;
    });
  }, [stage, sceneLights]);

  // Authored distant lights cast shadows too (UsdLux ShadowAPI defaults to on).
  useLayoutEffect(() => {
    const center = bounds ? new Vector3(...bounds.center) : null;
    stage.scene.traverse((obj) => {
      if ((obj as Mesh).isMesh) {
        obj.castShadow = shadows;
        obj.receiveShadow = shadows;
      }
      const light = obj as DirectionalLight;
      if (light.isDirectionalLight) {
        light.castShadow = shadows && !!center;
        if (light.castShadow && center && bounds) fitDirectionalShadow(light, center, bounds.radius);
      }
    });
  }, [stage, shadows, bounds]);

  // All clips share one stage timeline, like USD time codes.
  const lastTime = useRef(-1);
  useEffect(() => {
    lastTime.current = -1;
    return () => releaseStageAnimation(stage);
  }, [stage]);

  useFrame((_, delta) => {
    if (!stage.animations.length) return;
    const { animation, physics, setAnimation } = useViewer.getState();
    let t = animation.time;
    // A loaded simulation moves the timeline itself (PhysicsRunner).
    if (animation.playing && animation.duration > 0 && !simulationDrivesTimeline(physics.status)) {
      t += Math.min(delta, 0.1) * animation.speed;
      if (t >= animation.duration) {
        if (animation.loop) {
          t %= animation.duration;
        } else {
          t = animation.duration;
          setAnimation({ playing: false });
        }
      }
      setAnimation({ time: t });
    }
    if (t !== lastTime.current) {
      poseStageAt(stage, t);
      lastTime.current = t;
    }
  });

  const pick = (e: ThreeEvent<MouseEvent>) => e.intersections.find((hit) => isShownInHierarchy(hit.object))?.object ?? null;

  return (
    <primitive
      object={stage.scene}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (e.delta > 4) return; // orbit drag, not a click
        e.stopPropagation();
        select(pick(e));
      }}
      onDoubleClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        const hit = pick(e);
        if (!hit) return;
        select(hit);
        requestFocus("selection");
      }}
    />
  );
}
