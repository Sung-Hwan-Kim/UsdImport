"use client";

import { CameraControls, type CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { MathUtils, Sphere, Vector3, type PerspectiveCamera } from "three";
import { computeBounds } from "@/lib/scene";
import { useViewer } from "@/lib/store";

const VIEW_DIRECTION = new Vector3(0.9, 0.55, 1.25).normalize();

export default function CameraRig() {
  const controls = useRef<CameraControlsImpl>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const focus = useViewer((s) => s.focus);
  const bounds = useViewer((s) => s.bounds);
  const autoRotate = useViewer((s) => s.settings.autoRotate);
  const framed = useRef<number | null>(null);

  // Frame the stage (or selection) whenever a focus request comes in. Initial
  // framing waits for the stage bounds, which StageModel publishes on mount.
  useEffect(() => {
    const c = controls.current;
    const { stage, selected } = useViewer.getState();
    if (!c || !stage || !bounds) return;
    // A reload that keeps the view brings new bounds but no new focus request.
    if (framed.current === focus.nonce) return;
    framed.current = focus.nonce;
    const target = focus.target === "selection" && selected ? selected : stage.scene;
    const sphere = computeBounds(target).getBoundingSphere(new Sphere());
    const r = Math.max(sphere.radius, 1e-4);
    if (focus.target === "stage") {
      c.minDistance = r * 1e-3;
      c.maxDistance = r * 60;
    }
    if (focus.reset) {
      // Fit the bounding sphere inside the narrower of the two field-of-view axes.
      const vFov = MathUtils.degToRad(camera.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const dist = (r / Math.sin(Math.min(vFov, hFov) / 2)) * 1.05;
      const pos = sphere.center.clone().addScaledVector(VIEW_DIRECTION, dist);
      c.setLookAt(pos.x, pos.y, pos.z, sphere.center.x, sphere.center.y, sphere.center.z, false);
    } else {
      c.fitToSphere(sphere, true);
    }
  }, [focus, bounds, camera]);

  // Keep the depth range proportional to the viewing distance so both whole
  // scenes and tiny details render without clipping or z-fighting.
  useFrame((state, delta) => {
    const c = controls.current;
    if (!c) return;
    // currentAction 0 = no pointer interaction in progress.
    if (autoRotate && c.currentAction === 0) c.rotate(delta * 0.35, 0, false);
    const cam = state.camera as PerspectiveCamera;
    const r = bounds?.radius ?? 1;
    const near = Math.max(c.distance / 800, r * 1e-5);
    const far = c.distance + r * 40;
    if (Math.abs(cam.near - near) / near > 0.05 || Math.abs(cam.far - far) / far > 0.05) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  });

  return <CameraControls ref={controls} makeDefault smoothTime={0.18} draggingSmoothTime={0.06} dollyToCursor />;
}
