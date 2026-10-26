import type PhysX from "physx-js-webidl";
import type { Quaternion, Vector3 } from "three";

// physx-js-webidl's typings disagree with its runtime in a few places
// (HEAPF32/_free abort, Ext helpers live on .prototype, init takes options).
// Everything that needs a cast is kept in this file.

export type Px = Awaited<ReturnType<typeof PhysX>>;
export type { PhysX };

interface PxHeap {
  HEAPU8: Uint8Array;
  _webidl_malloc(size: number): number;
  _webidl_free(ptr: number): void;
}

interface PxPointers {
  getPointer(obj: object): number;
  wrapPointer(ptr: number, type: unknown): object;
}

interface RigidBodyExt {
  updateMassAndInertia(body: PhysX.PxRigidBody, density: number, massLocalPose?: PhysX.PxVec3): boolean;
  setMassAndUpdateInertia(body: PhysX.PxRigidBody, mass: number, massLocalPose?: PhysX.PxVec3): boolean;
}

export interface PhysXRuntime {
  px: Px;
  physics: PhysX.PxPhysics;
  tolerances: PhysX.PxTolerancesScale;
  cooking: PhysX.PxCookingParams;
  version: string;
}

/** Largest finite float32, PhysX's "unlimited". */
export const PX_MAX_F32 = 3.4028234663852886e38;

let runtime: Promise<PhysXRuntime> | null = null;

/**
 * Load the wasm (served from /physx/, copied there by scripts/copy-physx-wasm.mjs)
 * and create the process-wide foundation and physics objects once.
 */
export function loadPhysX(): Promise<PhysXRuntime> {
  runtime ??= (async () => {
    const { default: init } = await import("physx-js-webidl");
    const options = { locateFile: (file: string) => `/physx/${file}` };
    const px = await init(options as unknown as BufferSource);
    const v = px.PHYSICS_VERSION;
    const foundation = px.CreateFoundation(v, new px.PxDefaultAllocator(), new px.PxDefaultErrorCallback());
    const tolerances = new px.PxTolerancesScale();
    const physics = px.CreatePhysics(v, foundation, tolerances);
    px.InitExtensions(physics);
    const cooking = new px.PxCookingParams(tolerances);
    const version = `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}`;
    return { px, physics, tolerances, cooking, version };
  })();
  runtime.catch(() => {
    runtime = null;
  });
  return runtime;
}

export function rigidBodyExt(px: Px): RigidBodyExt {
  return px.PxRigidBodyExt.prototype as unknown as RigidBodyExt;
}

/** Copy a typed array into wasm memory; free with `freeHeap`. */
export function copyToHeap(px: Px, data: Float32Array | Uint32Array): number {
  const heap = px as unknown as PxHeap;
  const ptr = heap._webidl_malloc(data.byteLength);
  // Read HEAPU8 after the allocation: the heap may have grown and been replaced.
  new Uint8Array(heap.HEAPU8.buffer, ptr, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return ptr;
}

export function freeHeap(px: Px, ptr: number): void {
  (px as unknown as PxHeap)._webidl_free(ptr);
}

/** Joint creation accepts a null actor (world attachment) at runtime. */
export function actorOrWorld(actor: PhysX.PxRigidActor | null): PhysX.PxRigidActor {
  return actor as PhysX.PxRigidActor;
}

/**
 * Install a JS simulation filter on a scene description. `collide` gets each new
 * broad-phase pair's filter data word3 and returns false to drop the pair; kept
 * pairs get eCONTACT_DEFAULT plus both shapes' word2 pair flags, as the binding's
 * DefaultFilterShader does. The returned implementation must outlive the scene;
 * destroy it afterwards.
 */
export function setFilterShader(px: Px, sceneDesc: PhysX.PxSceneDesc, collide: (word3a: number, word3b: number) => boolean): PhysX.PassThroughFilterShaderImpl {
  const shader = new px.PassThroughFilterShaderImpl();
  // The pair flags live on the C++ base class, which the Impl wrapper does not expose.
  const pointers = px as unknown as PxPointers;
  const base = pointers.wrapPointer(pointers.getPointer(shader), px.PassThroughFilterShader) as PhysX.PassThroughFilterShader;
  const kill = px.PxFilterFlagEnum.eKILL;
  const contact = px.PxPairFlagEnum.eCONTACT_DEFAULT;
  shader.filterShader = (_a0, _w00, _w01, w02, w03, _a1, _w10, _w11, w12, w13) => {
    if (!collide(w03, w13)) return kill;
    base.outputPairFlags = contact | w02 | w12;
    return 0; // eDEFAULT
  };
  px.setupPassThroughFilterShader(sceneDesc, shader as unknown as PhysX.PassThroughFilterShader);
  return shader;
}

export function setBoundedData(bounded: PhysX.PxBoundedData, count: number, stride: number, ptr: number): void {
  bounded.count = count;
  bounded.stride = stride;
  bounded.data = ptr;
}

/** Build a PxTransform; the caller destroys it (`px.destroy`). */
export function pxTransform(px: Px, position: Vector3, quaternion: Quaternion): PhysX.PxTransform {
  const p = new px.PxVec3(position.x, position.y, position.z);
  const q = new px.PxQuat(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  const t = new px.PxTransform(p, q);
  px.destroy(p);
  px.destroy(q);
  return t;
}

export function pxVec3(px: Px, v: Vector3): PhysX.PxVec3 {
  return new px.PxVec3(v.x, v.y, v.z);
}
