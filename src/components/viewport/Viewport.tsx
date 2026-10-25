"use client";

import { GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import { NeutralToneMapping } from "three";
import { publishRenderInfo } from "@/lib/renderInfo";
import { HELPER_LAYER } from "@/lib/scene";
import { useViewer } from "@/lib/store";
import CameraRig from "./CameraRig";
import ColliderOverlay from "./ColliderOverlay";
import Helpers from "./Helpers";
import Lighting from "./Lighting";
import PhysicsRunner from "./PhysicsRunner";
import StageModel from "./StageModel";

function RendererSettings() {
  const get = useThree((s) => s.get);
  const exposure = useViewer((s) => s.settings.exposure);

  useLayoutEffect(() => {
    const { gl, camera } = get();
    camera.layers.enable(HELPER_LAYER);
    gl.toneMappingExposure = exposure;
  }, [get, exposure]);

  // Assigned every frame because R3F may reconfigure the renderer on prop changes.
  useFrame(({ gl }) => {
    if (gl.toneMapping !== NeutralToneMapping) gl.toneMapping = NeutralToneMapping;
  });
  return null;
}

/** Samples gl.info across a frame (the gizmo issues a second render call). */
function RenderStatsProbe() {
  const get = useThree((s) => s.get);
  const acc = useRef({ frames: 0, time: 0, calls: 0, triangles: 0 });

  useLayoutEffect(() => {
    const { gl } = get();
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [get]);

  useFrame(({ gl }, delta) => {
    const a = acc.current;
    a.frames++;
    a.time += delta;
    a.calls = gl.info.render.calls;
    a.triangles = gl.info.render.triangles;
    gl.info.reset();
    if (a.time >= 0.5) {
      publishRenderInfo({
        fps: a.frames / a.time,
        frameMs: (a.time / a.frames) * 1000,
        calls: a.calls,
        triangles: a.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
      });
      a.frames = 0;
      a.time = 0;
    }
  }, -1);
  return null;
}

export default function Viewport() {
  const stage = useViewer((s) => s.stage);
  const showStats = useViewer((s) => s.settings.stats);
  const select = useViewer((s) => s.select);
  const setCanvas = useViewer((s) => s.setCanvas);

  return (
    <Canvas
      className="!absolute inset-0"
      dpr={[1, 2]}
      shadows="percentage"
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ position: [4, 3, 6], fov: 40, near: 0.01, far: 1000 }}
      onCreated={({ gl }) => setCanvas(gl.domElement)}
      onPointerMissed={(e) => {
        if (e.type === "click") select(null);
      }}
    >
      <RendererSettings />
      <Lighting />
      {stage && <StageModel key={stage.id} stage={stage} />}
      {stage?.metadata.hasPhysics && <PhysicsRunner key={`physics-${stage.id}`} stage={stage} />}
      {stage?.metadata.hasPhysics && <ColliderOverlay key={`colliders-${stage.id}`} stage={stage} />}
      <Helpers />
      <CameraRig />
      {stage && (
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport axisColors={["#ff5c6c", "#5fd36f", "#5b9dff"]} labelColor="#0b0d11" />
        </GizmoHelper>
      )}
      {showStats && <RenderStatsProbe />}
    </Canvas>
  );
}
