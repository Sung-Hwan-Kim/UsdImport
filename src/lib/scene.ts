import {
  Box3,
  MeshBasicMaterial,
  MeshNormalMaterial,
  MeshStandardMaterial,
  Vector3,
  type DirectionalLight,
  type Material,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
} from "three";
import { getPrimTag } from "./usd/composer";

/** Layer used for viewport helpers so they never cast shadows or get picked. */
export const HELPER_LAYER = 1;

export type NodeKind = "stage" | "xform" | "scope" | "mesh" | "skinned" | "bone" | "light" | "camera" | "joint" | "physicsScene";

export function nodeKind(obj: Object3D): NodeKind {
  const tag = getPrimTag(obj);
  if (tag?.typeName === "Stage") return "stage";
  if (tag?.typeName === "PhysicsScene") return "physicsScene";
  if (tag?.typeName.startsWith("Physics") && tag.typeName.endsWith("Joint")) return "joint";
  if ((obj as SkinnedMesh).isSkinnedMesh) return "skinned";
  if ((obj as Mesh).isMesh) return "mesh";
  if ((obj as { isBone?: boolean }).isBone) return "bone";
  if ((obj as { isLight?: boolean }).isLight) return "light";
  if ((obj as { isCamera?: boolean }).isCamera) return "camera";
  if (tag && (tag.typeName === "Scope" || tag.typeName === "")) return "scope";
  return "xform";
}

export function displayName(obj: Object3D): string {
  return obj.name || `<${obj.type}>`;
}

/** USD type to show next to a node: the authored typeName, else the three.js type. */
export function usdTypeOf(obj: Object3D): string {
  const tag = getPrimTag(obj);
  if (tag?.typeName) return tag.typeName;
  if (tag) return "Scope";
  return obj.type;
}

/** Stage-namespace path, rebuilt from object names up to the stage root. */
export function stagePathOf(obj: Object3D): string {
  const names: string[] = [];
  let cur: Object3D | null = obj;
  while (cur && getPrimTag(cur)?.typeName !== "Stage") {
    names.unshift(cur.name || cur.type);
    cur = cur.parent;
  }
  return `/${names.join("/")}`;
}

export function isShownInHierarchy(obj: Object3D): boolean {
  let cur: Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

const tmpBox = new Box3();

/** World-space bounds of visible meshes (skinning aware); falls back to all objects. */
export function computeBounds(root: Object3D, target = new Box3()): Box3 {
  target.makeEmpty();
  root.updateWorldMatrix(true, true);
  root.traverseVisible((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    let box: Box3 | null;
    if ((obj as SkinnedMesh).isSkinnedMesh) {
      (obj as SkinnedMesh).computeBoundingBox();
      box = (obj as SkinnedMesh).boundingBox;
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box = mesh.geometry.boundingBox;
    }
    if (!box || box.isEmpty()) return;
    target.union(tmpBox.copy(box).applyMatrix4(mesh.matrixWorld));
  });
  if (target.isEmpty()) target.setFromObject(root);
  return target;
}

export type Shading = "pbr" | "clay" | "normals" | "wireframe";

let overrides: Record<Exclude<Shading, "pbr">, Material> | null = null;

function overrideMaterial(mode: Exclude<Shading, "pbr">): Material {
  overrides ??= {
    clay: new MeshStandardMaterial({ color: 0xc9c6c0, roughness: 0.62, metalness: 0 }),
    normals: new MeshNormalMaterial(),
    wireframe: new MeshBasicMaterial({ color: 0x9bbcff, wireframe: true, transparent: true, opacity: 0.85 }),
  };
  return overrides[mode];
}

/** Swap every mesh to a debug material, keeping the authored one in userData. */
export function applyShading(root: Object3D, mode: Shading): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.originalMaterial === undefined) mesh.userData.originalMaterial = mesh.material;
    mesh.material = mode === "pbr" ? mesh.userData.originalMaterial : overrideMaterial(mode);
  });
}

export function authoredMaterials(mesh: Mesh): Material[] {
  const m = (mesh.userData.originalMaterial ?? mesh.material) as Material | Material[];
  return Array.isArray(m) ? m : [m];
}

/**
 * Fit a directional light's shadow frustum around the stage, wherever the light
 * itself sits (USD distant lights usually only carry a rotation).
 */
export function fitDirectionalShadow(light: DirectionalLight, center: Vector3, radius: number): void {
  light.updateWorldMatrix(true, true);
  const pos = new Vector3().setFromMatrixPosition(light.matrixWorld);
  const dir = new Vector3().setFromMatrixPosition(light.target.matrixWorld).sub(pos).normalize();
  const rel = center.clone().sub(pos);
  const along = rel.dot(dir);
  const extent = rel.addScaledVector(dir, -along).length() + radius * 1.15;
  const cam = light.shadow.camera;
  cam.left = -extent;
  cam.right = extent;
  cam.top = extent;
  cam.bottom = -extent;
  cam.near = along - radius * 1.5;
  cam.far = along + radius * 1.5;
  cam.updateProjectionMatrix();
  light.shadow.bias = -0.0002;
  light.shadow.normalBias = radius * 0.003;
  light.shadow.radius = 5;
  if (light.shadow.mapSize.x < 2048) {
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }
  light.shadow.needsUpdate = true;
}

/** 10^n grid spacing suited to a scene of the given radius. */
export function gridSpacing(radius: number): { cell: number; section: number } {
  const section = Math.pow(10, Math.floor(Math.log10(Math.max(radius, 1e-6))));
  return { cell: section / 10, section };
}
