"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { AnimationMixer, LoopRepeat, Sphere, Vector3, type DirectionalLight, type Mesh } from "three";
import { applyShading, computeBounds, fitDirectionalShadow, isShownInHierarchy } from "@/lib/scene";
import { useViewer } from "@/lib/store";
import type { LoadedStage } from "@/lib/usd/loadStage";

export default function StageModel({ stage }: { stage: LoadedStage }) {
  const upAxis = useViewer((s) => s.settings.upAxis);
  const shading = useViewer((s) => s.settings.shading);
  const sceneLights = useViewer((s) => s.settings.sceneLights);
  const shadows = useViewer((s) => s.settings.shadows);
  const select = useViewer((s) => s.select);
  const requestFocus = useViewer((s) => s.requestFocus);
  const setBounds = useViewer((s) => s.setBounds);
  const bounds = useViewer((s) => s.bounds);
  const axisInitialized = useRef(false);

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
    if (axisInitialized.current) requestFocus("stage", true);
    axisInitialized.current = true;
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
  const mixer = useMemo(() => (stage.animations.length ? new AnimationMixer(stage.scene) : null), [stage]);
  useEffect(() => {
    if (!mixer) return;
    for (const clip of stage.animations) mixer.clipAction(clip).setLoop(LoopRepeat, Infinity).play();
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(stage.scene);
    };
  }, [mixer, stage]);

  const lastTime = useRef(-1);
  useFrame((_, delta) => {
    if (!mixer) return;
    const { animation, setAnimation } = useViewer.getState();
    let t = animation.time;
    if (animation.playing && animation.duration > 0) {
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
      mixer.setTime(t);
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
