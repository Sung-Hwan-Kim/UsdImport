import { Matrix4, Vector3, type BufferAttribute, type Mesh } from "three";
import type { ClothBinding } from "./engine";

/** A cloth mesh driven by simulated particles (one per USD mesh point). */
export interface ClothState {
  binding: ClothBinding;
  mesh: Mesh;
  /** USD point index of each (non-indexed) geometry vertex. */
  pointOf: Uint32Array;
  /** Pose frame -> mesh local space. */
  toLocal: Matrix4;
  rest: { position: Float32Array; normal: Float32Array | null };
  /** Scratch: particle positions and smooth normals in local space, per USD point. */
  points: Float32Array;
  normals: Float32Array;
}

const key = (x: number, y: number, z: number) => `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`;

/**
 * Bind a cloth mesh to its particles. three expands USD points into one vertex
 * per triangle corner, copying positions verbatim, so each vertex is matched
 * back to its point by position. `frameToWorld` maps the pose frame to world.
 */
export function createClothState(binding: ClothBinding, usdPoints: ArrayLike<number>, frameToWorld: Matrix4): ClothState | string {
  const mesh = binding.object as Mesh;
  const position = mesh.geometry.getAttribute("position") as BufferAttribute | undefined;
  if (!position || mesh.geometry.index) return "인덱스 지오메트리는 지원하지 않습니다";
  if (usdPoints.length / 3 !== binding.count) return `점 개수(${usdPoints.length / 3})가 파티클 개수(${binding.count})와 다릅니다`;

  const byPosition = new Map<string, number>();
  for (let p = binding.count - 1; p >= 0; p--) byPosition.set(key(usdPoints[p * 3], usdPoints[p * 3 + 1], usdPoints[p * 3 + 2]), p);
  const pointOf = new Uint32Array(position.count);
  for (let v = 0; v < position.count; v++) {
    const p = byPosition.get(key(position.getX(v), position.getY(v), position.getZ(v)));
    if (p === undefined) return "메시 정점을 USD 점과 대응시키지 못했습니다";
    pointOf[v] = p;
  }

  const normal = mesh.geometry.getAttribute("normal") as BufferAttribute | undefined;
  mesh.updateWorldMatrix(true, false);
  return {
    binding,
    mesh,
    pointOf,
    toLocal: mesh.matrixWorld.clone().invert().multiply(frameToWorld),
    rest: { position: (position.array as Float32Array).slice(), normal: normal ? (normal.array as Float32Array).slice() : null },
    points: new Float32Array(binding.count * 3),
    normals: new Float32Array(binding.count * 3),
  };
}

const p = new Vector3();
const a = new Vector3();
const b = new Vector3();
const c = new Vector3();

function addTo(out: Float32Array, i: number, v: Vector3): void {
  out[i] += v.x;
  out[i + 1] += v.y;
  out[i + 2] += v.z;
}

/** Write particle positions (pose frame) into the mesh, with smooth normals. */
export function updateCloth(cloth: ClothState, particles: Float32Array): void {
  const { binding, points, normals, pointOf, toLocal } = cloth;
  if (particles.length < (binding.start + binding.count) * 3) return;
  for (let i = 0; i < binding.count; i++) {
    const o = (binding.start + i) * 3;
    p.set(particles[o], particles[o + 1], particles[o + 2]).applyMatrix4(toLocal);
    points[i * 3] = p.x;
    points[i * 3 + 1] = p.y;
    points[i * 3 + 2] = p.z;
  }

  // Area-weighted face normals summed per point.
  normals.fill(0);
  for (let v = 0; v + 2 < pointOf.length; v += 3) {
    const i0 = pointOf[v] * 3;
    const i1 = pointOf[v + 1] * 3;
    const i2 = pointOf[v + 2] * 3;
    a.fromArray(points, i0);
    b.fromArray(points, i1).sub(a);
    c.fromArray(points, i2).sub(a);
    b.cross(c);
    addTo(normals, i0, b);
    addTo(normals, i1, b);
    addTo(normals, i2, b);
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }

  const geometry = cloth.mesh.geometry;
  const position = geometry.getAttribute("position") as BufferAttribute;
  const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
  const pos = position.array as Float32Array;
  const nrm = normal?.array as Float32Array | undefined;
  for (let v = 0; v < pointOf.length; v++) {
    const i = pointOf[v] * 3;
    pos[v * 3] = points[i];
    pos[v * 3 + 1] = points[i + 1];
    pos[v * 3 + 2] = points[i + 2];
    if (nrm) {
      nrm[v * 3] = normals[i];
      nrm[v * 3 + 1] = normals[i + 1];
      nrm[v * 3 + 2] = normals[i + 2];
    }
  }
  position.needsUpdate = true;
  if (normal) normal.needsUpdate = true;
  // Recomputed on demand by frustum culling and raycasting.
  geometry.boundingSphere = null;
  geometry.boundingBox = null;
}

export function restoreCloth(cloth: ClothState): void {
  const geometry = cloth.mesh.geometry;
  const position = geometry.getAttribute("position") as BufferAttribute;
  (position.array as Float32Array).set(cloth.rest.position);
  position.needsUpdate = true;
  const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
  if (normal && cloth.rest.normal) {
    (normal.array as Float32Array).set(cloth.rest.normal);
    normal.needsUpdate = true;
  }
  geometry.boundingSphere = null;
  geometry.boundingBox = null;
}

/** The USD point of a hit triangle (non-indexed vertices `face`) nearest to a world point. */
export function nearestClothPoint(cloth: ClothState, face: { a: number; b: number; c: number }, world: Vector3): number {
  const position = cloth.mesh.geometry.getAttribute("position") as BufferAttribute;
  let best = face.a;
  let bestDistance = Infinity;
  for (const v of [face.a, face.b, face.c]) {
    const d = p.fromBufferAttribute(position, v).applyMatrix4(cloth.mesh.matrixWorld).distanceToSquared(world);
    if (d < bestDistance) {
      bestDistance = d;
      best = v;
    }
  }
  return cloth.pointOf[best];
}
