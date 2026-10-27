import {
  AnimationClip,
  DoubleSide,
  Matrix4,
  MeshPhysicalMaterial,
  SRGBColorSpace,
  type DirectionalLight,
  type Light,
  type Material,
  type Mesh,
  type Object3D,
  type SpotLight,
  type Texture,
} from "three";
import { USDComposer } from "three/examples/jsm/loaders/usd/USDComposer.js";
import type { USDSpec } from "three/examples/jsm/loaders/usd/USDCParser.js";
import type { PrimOrigin } from "./arcs";
import { normalizePath } from "./paths";
import {
  evaluateXformOps,
  numbersOf,
  setFromXform,
  xformOpinionsOf,
  xformTracks,
  type XformOpinions,
  type XformSamples,
} from "./xformOps";

/** Where an Object3D came from, stored on `object.userData.usd`. */
export interface PrimTag {
  /** The root layer, whose composed specs (see arcs.ts) hold the prim's opinions. */
  layer: string;
  /** Prim path on the stage. */
  path: string;
  typeName: string;
  purpose?: string;
  /** The prim a reference or payload brought in, in its own layer. */
  source?: PrimOrigin;
}

export function getPrimTag(obj: Object3D): PrimTag | undefined {
  return obj.userData.usd as PrimTag | undefined;
}

export interface ComposeContext {
  resolveAsset(path: string): string | null;
  /** Prims brought in by references or payloads, and where from. */
  origins: Map<string, PrimOrigin>;
  /** Objects whose composed xformOps are time-sampled. */
  animatedXforms: Map<Object3D, { xform: XformOpinions; frame: number }>;
  missing: Set<string>;
  warnings: Set<string>;
}

function isAttached(obj: Object3D, root: Object3D): boolean {
  for (let cur: Object3D | null = obj; cur; cur = cur.parent) if (cur === root) return true;
  return false;
}

/** Brighter than any light authored for Storm-style viewers (UsdLux intensity ~1–10). */
const RTX_LIGHT_THRESHOLD = 100;
/** About what RTX's default camera exposure makes of UsdLux intensities. */
const RTX_EXPOSURE = 1 / 1000;

/**
 * Omniverse / Isaac Sim author UsdLux intensities for RTX, whose default
 * camera exposure scales them down about a thousandfold (a DistantLight of
 * 1000–3000 is ordinary daylight there). three uses intensities as they are,
 * which washed such stages out to white; scale them as RTX would. Stages lit
 * like Storm (usdview) stay as authored.
 */
export function adaptLightUnits(root: Object3D, warnings: Set<string>): void {
  const lights: Light[] = [];
  root.traverse((obj) => {
    if ((obj as Light).isLight) lights.push(obj as Light);
  });
  const brightest = lights.reduce((max, light) => Math.max(max, light.intensity), 0);
  if (brightest <= RTX_LIGHT_THRESHOLD) return;
  for (const light of lights) light.intensity *= RTX_EXPOSURE;
  warnings.add(`라이트 세기(최대 ${+brightest.toPrecision(4)})가 Omniverse(RTX) 기준이라 RTX 기본 노출처럼 1/1000로 줄여 표시합니다.`);
}

/**
 * One clip playing every time-sampled xform under `root`. three's own clip
 * only covers a few op names on Xform/Scope/Mesh prims and binds tracks by
 * prim name, so same-named prims (or several references to one animated
 * asset) all drove the first match; these tracks bind by object uuid.
 * Call it after applyResetXformStacks, whose re-basing the tracks repeat.
 */
export function transformAnimation(root: Object3D, ctx: ComposeContext): AnimationClip | null {
  root.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const tracks = [];
  for (const [obj, { xform, frame }] of ctx.animatedXforms) {
    if (!isAttached(obj, root)) continue;
    const parentInverse =
      obj.userData.resetXformStack && obj.parent ? new Matrix4().multiplyMatrices(rootInverse, obj.parent.matrixWorld).invert() : undefined;
    tracks.push(...xformTracks(obj.uuid, xform, frame, parentInverse));
  }
  return tracks.length ? new AnimationClip("TransformAnimation", -1, tracks) : null;
}

/**
 * USDComposer with fixes the viewer needs, composing the stage flattened by
 * flattenStage() (so no references, payloads or variants are left):
 * - tags every object with its prim path and origin (inspector, visibility, purpose)
 * - evaluates xformOps as USD does, and draws unbound prims, subsets and
 *   double-sided meshes as USD would
 * - missing textures are recorded instead of fetched from the page URL
 */
export class ViewerComposer extends USDComposer {
  private readonly tagged = new WeakSet<Object3D>();
  /** Time-sampled xformOps of each `_getAttributes` result. */
  private readonly xformSamples = new WeakMap<Record<string, unknown>, Record<string, XformSamples>>();

  constructor(
    private readonly ctx: ComposeContext,
    private readonly layerPath: string,
  ) {
    super();
  }

  protected override _buildHierarchy(parent: Object3D, parentPath: string): void {
    const start = parent.children.length;
    super._buildHierarchy(parent, parentPath);
    // Nested calls (e.g. Skeleton children re-parented onto `parent`) tag first.
    for (let i = start; i < parent.children.length; i++) {
      const child = parent.children[i];
      if (!this.tagged.has(child)) this.tag(child, parentPath);
    }
  }

  private tag(obj: Object3D, parentPath: string): void {
    this.tagged.add(obj);
    if (!obj.name) return;
    const path = parentPath === "/" ? `/${obj.name}` : `${parentPath}/${obj.name}`;
    const spec = this.specsByPath[path];
    if (!spec) return;
    const tag: PrimTag = { layer: this.layerPath, path, typeName: String(spec.fields.typeName ?? "") };
    const origin = this.ctx.origins.get(path);
    if (origin) tag.source = origin;

    const visibility = this.attributeValue(path, "visibility");
    const purpose = this.attributeValue(path, "purpose");
    if (typeof purpose === "string" && purpose !== "default") tag.purpose = purpose;
    if (visibility === "invisible" || purpose === "guide") obj.visible = false;
    if ((obj as Light).isLight) this.fixLight(obj as Light, path);
    obj.userData.usd = tag;
  }

  /** UsdLux lights emit along local -Z and scale by 2^exposure; three ignores both. */
  private fixLight(light: Light, path: string): void {
    const exposure = this.attributeValue(path, "inputs:exposure");
    if (typeof exposure === "number") light.intensity *= 2 ** exposure;
    if ((light as DirectionalLight).isDirectionalLight || (light as SpotLight).isSpotLight) {
      const aimed = light as DirectionalLight | SpotLight;
      aimed.target.position.set(0, 0, -1);
      aimed.target.userData.internal = true;
      aimed.add(aimed.target);
    }
  }

  private attributeValue(primPath: string, name: string): unknown {
    return this.specsByPath[`${primPath}.${name}`]?.fields.default;
  }

  /**
   * three evaluates only a fixed set of unsuffixed op names and applies ops
   * even without xformOpOrder. Evaluate the order as USD does instead.
   */
  override applyTransform(obj: Object3D, fields: Record<string, unknown>, attrs: Record<string, unknown> = {}): void {
    const xform = xformOpinionsOf({ ...fields, ...attrs }, this.xformSamples.get(attrs));
    const evaluated = evaluateXformOps(xform);
    for (const op of evaluated.unsupported) this.ctx.warnings.add(`지원하지 않는 xformOp를 건너뛰었습니다: ${op}`);
    setFromXform(obj, evaluated);
    if (evaluated.resetsXformStack) obj.userData.resetXformStack = true;
    if (Object.keys(xform.samples).length) this.ctx.animatedXforms.set(obj, { xform, frame: 1 / this.fps });
    else this.ctx.animatedXforms.delete(obj);
  }

  /** Transform animation is built for the whole stage instead (see transformAnimation). */
  protected override _buildTransformAnimations(): [] {
    return [];
  }

  /**
   * Remember the time samples of xformOps next to the values three resolves
   * (default, else the sample at 0 or the first one). A later path overrides
   * an earlier one per attribute, as three's variant overrides do.
   */
  protected override _collectAttributesFromPath(path: string, attrs: Record<string, unknown>): void {
    super._collectAttributesFromPath(path, attrs);
    const attributes = this.attributesByPrimPath.get(path);
    if (!attributes) return;
    for (const [name, spec] of attributes) {
      if (!name.startsWith("xformOp:")) continue;
      const timeSamples = spec.fields.timeSamples as { times?: number[]; values?: unknown[] } | undefined;
      const sampled = !!timeSamples?.times?.length && !!timeSamples.values;
      if (!sampled && spec.fields.default === undefined) continue;
      let samples = this.xformSamples.get(attrs);
      if (sampled) {
        if (!samples) this.xformSamples.set(attrs, (samples = {}));
        samples[name] = { times: timeSamples.times!.map((t) => t / this.fps), values: timeSamples.values! };
      } else if (samples) {
        delete samples[name];
      }
    }
  }

  /** three ignores `doubleSided`; open surfaces such as cloth need their back faces drawn. */
  protected override _buildMesh(path: string, spec: USDSpec): Mesh {
    const mesh = super._buildMesh(path, spec);
    if (this.attributeValue(path, "doubleSided") === true) {
      const twoSided = (material: Material) => {
        if (material.side === DoubleSide) return material;
        const copy = material.clone();
        copy.side = DoubleSide;
        return copy;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(twoSided) : twoSided(mesh.material);
    }
    return mesh;
  }

  /**
   * three falls back to the first material under /<root>/Looks for unbound
   * meshes; USD renders unbound geometry with the default material instead.
   */
  protected override _buildMaterial(meshPath: string, fields: Record<string, unknown>): Material {
    if (this._getMaterialPath(meshPath, fields)) return super._buildMaterial(meshPath, fields);
    const prefix = `${meshPath}/`;
    for (const path in this.specsByPath) {
      if (path.startsWith(prefix) && path.endsWith(".material:binding")) return super._buildMaterial(meshPath, fields);
    }
    return this.fallbackMaterial(meshPath);
  }

  /**
   * The default material takes the prim's displayColor / displayOpacity, as
   * USD's fallback surface does. three applies them to Mesh prims only (and
   * only over a white material), so Cube, Sphere, Capsule… stayed white.
   */
  private fallbackMaterial(path: string): Material {
    const material = new MeshPhysicalMaterial({ roughness: 0.7 });
    const attrs = this._getAttributes(path);
    // Varying colors are not drawn per vertex; the first one stands for the prim, as in three.
    const color = numbersOf(attrs["primvars:displayColor"])?.slice(0, 3);
    if (color?.length === 3 && color.every(Number.isFinite)) material.color.setRGB(color[0], color[1], color[2], SRGBColorSpace);
    const opacity = numbersOf(attrs["primvars:displayOpacity"])?.[0];
    if (opacity !== undefined && Number.isFinite(opacity) && opacity < 1) {
      material.opacity = Math.max(0, opacity);
      material.transparent = true;
    }
    return material;
  }

  protected override _applyMaterial(material: Material, materialPath: string): void {
    super._applyMaterial(material, materialPath);
    material.name = materialPath.slice(materialPath.lastIndexOf("/") + 1);
    material.userData.usdPath = materialPath;
  }

  /**
   * three only draws faces that belong to a subset; in USD the remaining faces
   * keep the mesh's own binding, so add them as one more subset.
   */
  protected override _getGeomSubsets(meshPath: string) {
    const subsets = super._getGeomSubsets(meshPath);
    if (!subsets.length) return subsets;
    const counts = this._getAttributes(meshPath).faceVertexCounts as ArrayLike<number> | undefined;
    if (!counts?.length) return subsets;
    const covered = new Uint8Array(counts.length);
    for (const subset of subsets) {
      for (let i = 0; i < subset.indices.length; i++) {
        const face = subset.indices[i];
        if (face >= 0 && face < covered.length) covered[face] = 1;
      }
    }
    const rest: number[] = [];
    for (let face = 0; face < covered.length; face++) if (!covered[face]) rest.push(face);
    if (rest.length) subsets.push({ name: "", indices: rest, materialPath: null });
    return subsets;
  }

  protected override _loadTexture(filePath: string, textureAttrs: unknown, transformAttrs: unknown): Texture | null {
    const clean = filePath.replace(/^@|@$/g, "");
    const key = this.ctx.resolveAsset(this._resolveFilePath(clean)) ?? this.ctx.resolveAsset(clean);
    if (!key) {
      this.ctx.missing.add(normalizePath(this._resolveFilePath(clean)));
      return null;
    }
    return super._loadTexture(key, textureAttrs, transformAttrs);
  }
}
