"use client";

import { Grid } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useCallback, useMemo } from "react";
import { Box3, Box3Helper, Color, DoubleSide, type Object3D } from "three";
import { computeBounds, gridSpacing, HELPER_LAYER } from "@/lib/scene";
import { useViewer } from "@/lib/store";

const SELECTION_COLOR = new Color("#5b9dff");

/** Ref callback that moves an object (and its children) onto the helper layer. */
function useHelperLayer() {
  return useCallback((obj: Object3D | null) => {
    obj?.traverse((o) => o.layers.set(HELPER_LAYER));
  }, []);
}

function SelectionBox() {
  const selected = useViewer((s) => s.selected);
  const helperLayer = useHelperLayer();
  const helper = useMemo(() => {
    const h = new Box3Helper(new Box3(), SELECTION_COLOR);
    const material = h.material as { depthTest: boolean; transparent: boolean; opacity: number };
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.9;
    h.renderOrder = 999;
    return h;
  }, []);

  useFrame(() => {
    if (selected) computeBounds(selected, helper.box);
  });

  if (!selected || selected.userData.usd?.typeName === "Stage") return null;
  return <primitive ref={helperLayer} object={helper} />;
}

export default function Helpers() {
  const bounds = useViewer((s) => s.bounds);
  const grid = useViewer((s) => s.settings.grid);
  const axes = useViewer((s) => s.settings.axes);
  const helperLayer = useHelperLayer();

  const r = bounds?.radius ?? 1;
  const floorY = bounds?.floorY ?? 0;
  const { cell, section } = gridSpacing(r);

  return (
    <>
      {grid && (
        <Grid
          ref={helperLayer}
          position={[0, floorY - r * 1e-3, 0]}
          infiniteGrid
          cellSize={cell}
          sectionSize={section}
          cellThickness={0.6}
          sectionThickness={1.1}
          cellColor="#2b313d"
          sectionColor="#3d4759"
          fadeDistance={r * 30}
          fadeStrength={1.4}
          side={DoubleSide}
        />
      )}
      {axes && <axesHelper ref={helperLayer} args={[r * 1.25]} />}
      <SelectionBox />
    </>
  );
}
