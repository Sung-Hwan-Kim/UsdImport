"use client";

import { Environment } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { PMREMGenerator, type DirectionalLight } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { useViewer, type StageBounds } from "@/lib/store";

const FALLBACK_BOUNDS: StageBounds = { center: [0, 0.5, 0], size: [1, 1, 1], radius: 1, floorY: 0 };

/** Built-in procedural studio environment: no network needed. */
function RoomEnvironmentMap({ intensity, background }: { intensity: number; background: boolean }) {
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const texture = useMemo(() => {
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const map = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    return map;
  }, [gl]);

  useEffect(() => () => texture.dispose(), [texture]);

  useLayoutEffect(() => {
    const { scene } = get();
    scene.environment = texture;
    scene.environmentIntensity = intensity;
    scene.background = background ? texture : null;
    scene.backgroundBlurriness = 0.55;
    return () => {
      scene.environment = null;
      scene.background = null;
    };
  }, [get, texture, intensity, background]);

  return null;
}

/** Remote HDRI presets can fail offline; fall back to the built-in room. */
class EnvironmentBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("환경맵을 불러오지 못해 기본 환경으로 대체합니다.", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function EnvironmentLighting() {
  const environment = useViewer((s) => s.settings.environment);
  const intensity = useViewer((s) => s.settings.environmentIntensity);
  const background = useViewer((s) => s.settings.environmentBackground);

  if (environment === "none") {
    return <hemisphereLight args={["#dfe6f2", "#2a2c30", 0.9 * intensity]} />;
  }
  const room = <RoomEnvironmentMap intensity={intensity} background={background} />;
  if (environment === "room") return room;
  return (
    <EnvironmentBoundary key={environment} fallback={room}>
      <Suspense fallback={null}>
        <Environment
          preset={environment}
          environmentIntensity={intensity}
          background={background}
          backgroundBlurriness={0.55}
        />
      </Suspense>
    </EnvironmentBoundary>
  );
}

/** Viewer key light sized to the stage, used when the stage brings no lights of its own. */
function KeyLight() {
  const bounds = useViewer((s) => s.bounds) ?? FALLBACK_BOUNDS;
  const shadows = useViewer((s) => s.settings.shadows);
  const environment = useViewer((s) => s.settings.environment);
  const light = useRef<DirectionalLight>(null);
  const { center, radius: r } = bounds;

  useLayoutEffect(() => {
    const l = light.current;
    if (!l) return;
    l.target.position.set(center[0], center[1], center[2]);
    l.target.updateMatrixWorld();
    const cam = l.shadow.camera;
    const extent = r * 1.35;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = r * 0.05;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
    l.shadow.normalBias = r * 0.003;
    l.shadow.needsUpdate = true;
  }, [center, r]);

  return (
    <directionalLight
      ref={light}
      position={[center[0] + r * 1.5, center[1] + r * 2.6, center[2] + r * 1.1]}
      intensity={environment === "none" ? 2.6 : 1.8}
      castShadow={shadows}
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
      shadow-bias={-0.0002}
      shadow-radius={5}
    />
  );
}

/** Transparent floor that only shows shadows, just under the stage. */
function ShadowCatcher() {
  const bounds = useViewer((s) => s.bounds) ?? FALLBACK_BOUNDS;
  const { center, radius: r, floorY } = bounds;
  return (
    <mesh receiveShadow rotation-x={-Math.PI / 2} position={[center[0], floorY - r * 2e-3, center[2]]}>
      <planeGeometry args={[r * 10, r * 10]} />
      <shadowMaterial transparent opacity={0.3} depthWrite={false} />
    </mesh>
  );
}

export default function Lighting() {
  const shadows = useViewer((s) => s.settings.shadows);
  const stageLights = useViewer((s) => (s.settings.sceneLights ? (s.stage?.stats.lights ?? 0) : 0));
  return (
    <>
      <EnvironmentLighting />
      {stageLights === 0 && <KeyLight />}
      {shadows && <ShadowCatcher />}
    </>
  );
}
