"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { physicsDescriptionFor, type BodyInfo, type ColliderInfo, type PhysicsDescription, type Pose } from "@/lib/physics/schema";
import { HELPER_LAYER } from "@/lib/scene";
import { useViewer } from "@/lib/store";
import type { LoadedStage } from "@/lib/usd/loadStage";

const material = (color: string) =>
  new MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55, depthTest: false });

const MATERIALS = {
  dynamic: material("#4fd18b"),
  kinematic: material("#f2b84b"),
  static: material("#8b94a4"),
  joint: new MeshBasicMaterial({ color: "#ff9f5a", transparent: true, opacity: 0.9, depthTest: false }),
};

interface Helper {
  mesh: Mesh;
  body: BodyInfo | null;
  /** Shape frame relative to the body (world frame when static). */
  local: Pose;
}

function colliderGeometry(c: ColliderInfo): BufferGeometry | null {
  switch (c.shape) {
    case "box":
      return new BoxGeometry(c.halfExtents!.x * 2, c.halfExtents!.y * 2, c.halfExtents!.z * 2);
    case "sphere":
      return new SphereGeometry(c.radius!, 16, 10);
    case "capsule": {
      // three's capsule runs along Y; turn it onto the collider's axis.
      const g = new CapsuleGeometry(c.radius!, c.halfHeight! * 2, 4, 12);
      if (c.axis === "X") g.rotateZ(-Math.PI / 2);
      else if (c.axis === "Z") g.rotateX(Math.PI / 2);
      return g;
    }
    case "convex": {
      if (!c.points || c.points.length < 12) return null;
      const pts: Vector3[] = [];
      for (let i = 0; i < c.points.length; i += 3) pts.push(new Vector3(c.points[i], c.points[i + 1], c.points[i + 2]));
      try {
        return new ConvexGeometry(pts);
      } catch {
        return null;
      }
    }
    case "triangleMesh": {
      if (!c.points || !c.indices) return null;
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(c.points, 3));
      g.setIndex(new BufferAttribute(c.indices, 1));
      return g;
    }
  }
}

function buildHelpers(d: PhysicsDescription): Helper[] {
  const helpers: Helper[] = [];
  const add = (geometry: BufferGeometry | null, mat: MeshBasicMaterial, body: BodyInfo | null, local: Pose) => {
    if (!geometry) return;
    const mesh = new Mesh(geometry, mat);
    mesh.matrixAutoUpdate = false;
    mesh.layers.set(HELPER_LAYER);
    mesh.renderOrder = 998;
    helpers.push({ mesh, body, local });
  };
  for (const c of d.staticColliders) add(colliderGeometry(c), MATERIALS.static, null, c.localPose);
  for (const b of d.bodies) {
    for (const c of b.colliders) add(colliderGeometry(c), b.kind === "dynamic" ? MATERIALS.dynamic : MATERIALS.kinematic, b, c.localPose);
  }
  for (const j of d.joints) {
    const size = 0.035;
    add(new OctahedronGeometry(size), MATERIALS.joint, j.body0, j.frame0);
  }
  return helpers;
}

const bodyMatrix = new Matrix4();
const localMatrix = new Matrix4();
const position = new Vector3();
const quaternion = new Quaternion();
const scale = new Vector3();
const ONE = new Vector3(1, 1, 1);

function syncHelpers(helpers: Helper[]): void {
  for (const h of helpers) {
    localMatrix.compose(h.local.position, h.local.quaternion, ONE);
    if (h.body) {
      // Bodies are rigid in the simulation: follow the body frame without its scale.
      h.body.object.matrixWorld.decompose(position, quaternion, scale);
      bodyMatrix.compose(position, quaternion, ONE);
      h.mesh.matrix.multiplyMatrices(bodyMatrix, localMatrix);
    } else {
      h.mesh.matrix.copy(localMatrix);
    }
    h.mesh.matrixWorldNeedsUpdate = true;
  }
}

/** Wireframe view of what the simulation collides with, following the bodies. */
export default function ColliderOverlay({ stage }: { stage: LoadedStage }) {
  const show = useViewer((s) => s.settings.showColliders);
  const stored = useViewer((s) => s.physics.description);
  const description = useMemo(() => (show ? (stored ?? physicsDescriptionFor(stage)) : null), [show, stored, stage]);
  const helpers = useMemo(() => (description ? buildHelpers(description) : []), [description]);

  useEffect(
    () => () => {
      for (const h of helpers) h.mesh.geometry.dispose();
    },
    [helpers],
  );

  useFrame(() => syncHelpers(helpers));

  if (!helpers.length) return null;
  return (
    <group>
      {helpers.map((h) => (
        <primitive key={h.mesh.uuid} object={h.mesh} />
      ))}
    </group>
  );
}
