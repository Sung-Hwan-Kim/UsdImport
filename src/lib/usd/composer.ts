import {
  AnimationClip,
  DoubleSide,
  Group,
  Matrix4,
  MeshPhysicalMaterial,
  SRGBColorSpace,
  type DirectionalLight,
  type Light,
  type LoadingManager,
  type Material,
  type Mesh,
  type Object3D,
  type SpotLight,
  type Texture,
} from "three";
import { USDComposer } from "three/examples/jsm/loaders/usd/USDComposer.js";
import type { USDLayerData, USDSpec } from "three/examples/jsm/loaders/usd/USDCParser.js";
import { dirname, normalizePath } from "./paths";
import {
  evaluateXformOps,
  mergeXformOpinions,
  numbersOf,
  setFromXform,
  xformOpinionsOf,
  xformTracks,
  type XformOpinions,
  type XformSamples,
} from "./xformOps";

/** Where an Object3D came from, stored on `object.userData.usd`. */
export interface PrimTag {
  /** Virtual path of the layer (stack) holding the spec. */
  layer: string;
  /** Prim path inside that layer. */
  path: string;
  /**
   * Which composition of the layer built the object: 0 for the root stage, a
   * new id per resolved reference. Relationship targets (e.g. a joint's
   * `physics:body0`) resolve within the same instance.
   */
  instance: number;
  typeName: string;
  purpose?: string;
  /**
   * The referenced prim this object also stands for: a referenced mesh merged
   * into its referencing prim, or a reference target dissolved into it.
   */
  source?: PrimTag;
}

export function getPrimTag(obj: Object3D): PrimTag | undefined {
  return obj.userData.usd as PrimTag | undefined;
}

/** State shared by the root composer and every nested reference composer. */
export interface ComposeContext {
  resolveAsset(path: string): string | null;
  textureCaches: Map<string, Record<string, Texture>>;
  texturePromises: Promise<void>[];
  animations: AnimationClip[];
  /** Objects whose composed xformOps are time-sampled; the last composition of an object wins. */
  animatedXforms: Map<Object3D, { xform: XformOpinions; frame: number }>;
  missing: Set<string>;
  warnings: Set<string>;
  referenceCount: number;
  /** Composer instances created so far (the root composer is instance 0). */
  instanceCount: number;
}

/** The xform opinions each object's transform was built from, for prims that reference it. */
const builtXforms = new WeakMap<Object3D, XformOpinions>();

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

function isContainer(obj: Object3D): boolean {
  return obj.type === "Object3D" || obj.type === "Group";
}

function findByPrimPath(root: Object3D, primPath: string): Object3D | null {
  let node: Object3D | undefined = root;
  for (const name of primPath.split("/").filter(Boolean)) {
    node = node.children.find((c) => c.name === name);
    if (!node) return null;
  }
  return node === root ? null : node;
}

/**
 * USDComposer with fixes the viewer needs:
 * - tags every object with its layer + prim path (inspector, visibility, purpose)
 * - references honour defaultPrim and map the target prim onto the referencing prim
 * - nested references share texture caches and report textures/animations upward
 * - missing layers/textures are recorded instead of fetched from the page URL
 */
export class ViewerComposer extends USDComposer {
  private readonly tagged = new WeakSet<Object3D>();
  private referencingSpec: USDSpec | null = null;
  private readonly dissolvedTargets = new Map<USDSpec, PrimTag>();
  /** Reference targets' xform opinions, keyed by the referencing prim's fields. */
  private readonly referencedXforms = new Map<Record<string, unknown>, XformOpinions>();
  /** Time-sampled xformOps of each `_getAttributes` result. */
  private readonly xformSamples = new WeakMap<Record<string, unknown>, Record<string, XformSamples>>();
  private readonly instance: number;

  constructor(
    private readonly ctx: ComposeContext,
    private readonly layerPath: string,
    private readonly chain: string[],
    manager: LoadingManager | null = null,
  ) {
    super(manager);
    this.instance = ctx.instanceCount++;
    let cache = ctx.textureCaches.get(layerPath);
    if (!cache) {
      cache = {};
      ctx.textureCaches.set(layerPath, cache);
    }
    this.textureCache = cache;
  }

  override compose(
    data: USDLayerData,
    assets: Record<string, unknown> = {},
    variantSelections: Record<string, string> = {},
    basePath = "",
  ): Group {
    const group = super.compose(data, assets, variantSelections, basePath);
    this.ctx.texturePromises.push(...this.texturePromises);
    return group;
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
    const path = this.childPath(parentPath, obj.name);
    if (!path) return;
    const spec = this.specsByPath[path];
    const previous = getPrimTag(obj);
    const tag: PrimTag = {
      layer: this.layerPath,
      path,
      instance: this.instance,
      typeName: String(spec?.fields.typeName ?? ""),
    };
    if (previous && previous.layer !== this.layerPath) tag.source = previous;
    else if (spec && this.dissolvedTargets.has(spec)) tag.source = this.dissolvedTargets.get(spec);

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

  private childPath(parentPath: string, name: string): string | null {
    if (!name) return null;
    const direct = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    if (this.specsByPath[direct]) return direct;
    for (const variantPath of this._getVariantPaths(parentPath)) {
      const p = `${variantPath}/${name}`;
      if (this.specsByPath[p]) return p;
    }
    return null;
  }

  private attributeValue(primPath: string, name: string): unknown {
    return this.specsByPath[`${primPath}.${name}`]?.fields.default;
  }

  /**
   * three evaluates only a fixed set of unsuffixed op names and applies ops
   * even without xformOpOrder. Evaluate the order as USD does instead, with a
   * referencing prim's opinions composed over its reference targets'.
   */
  override applyTransform(obj: Object3D, fields: Record<string, unknown>, attrs: Record<string, unknown> = {}): void {
    const own = xformOpinionsOf({ ...fields, ...attrs }, this.xformSamples.get(attrs));
    const referenced = this.referencedXforms.get(fields);
    const xform = referenced ? mergeXformOpinions(own, referenced) : own;
    builtXforms.set(obj, xform);
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

  protected override _getReferences(spec: USDSpec): string[] {
    // Remember which prim is referencing so _resolveReference can see its opinions.
    this.referencingSpec = spec;
    return super._getReferences(spec);
  }

  private referencingPrimHasTransform(): boolean {
    const f = this.referencingSpec?.fields;
    if (!f) return false;
    if (Array.isArray(f.xformOpOrder) && f.xformOpOrder.length > 0) return true;
    return Array.isArray(f.properties) && (f.properties as unknown[]).includes("xformOpOrder");
  }

  protected override _resolveReference(refValue: string, localVariants: Record<string, string> = {}): Group | null {
    const match = refValue?.match(/@([^@]+)@(?:<([^>]+)>)?/);
    if (!match) return null;
    const [, filePath, primPath] = match;

    const requested = normalizePath(this._resolveFilePath(filePath));
    const key = this.ctx.resolveAsset(requested);
    const data = key ? (this.assets[key] as USDLayerData | undefined) : undefined;
    if (!key || !data?.specsByPath) {
      this.ctx.missing.add(requested);
      return null;
    }
    if (this.chain.includes(key)) {
      this.ctx.warnings.add(`순환 참조를 건너뛰었습니다: ${key}`);
      return null;
    }

    const nested = new ViewerComposer(this.ctx, key, [...this.chain, key], this.manager);
    const variants = { ...localVariants, ...this.externalVariantSelections };
    const composed = nested.compose(data, this.assets, variants, dirname(key));
    this.ctx.animations.push(...composed.animations);
    this.ctx.referenceCount++;

    const targetPath = primPath || String(data.specsByPath["/"]?.fields.defaultPrim ?? "");
    const target = targetPath ? findByPrimPath(composed, targetPath) : null;
    if (!target) {
      if (primPath) this.ctx.warnings.add(`참조 대상 프림을 찾을 수 없습니다: ${filePath}<${primPath}>`);
      return composed;
    }

    // In USD the target prim *becomes* the referencing prim: its children land
    // directly under it, and its xform opinions compose under the referencing
    // prim's per attribute, so the referencing prim carries the transform.
    target.removeFromParent();
    const targetXform = builtXforms.get(target);
    const fields = this.referencingSpec?.fields;
    if (targetXform && fields) {
      // Earlier references in the list are stronger.
      const stronger = this.referencedXforms.get(fields);
      this.referencedXforms.set(fields, stronger ? mergeXformOpinions(stronger, targetXform) : targetXform);
    }
    if (targetXform || this.referencingPrimHasTransform()) {
      target.position.set(0, 0, 0);
      target.quaternion.identity();
      target.scale.set(1, 1, 1);
    }
    const wrapper = new Group();
    if (isContainer(target) && !this._hasNonIdentityTransform(target)) {
      while (target.children.length) wrapper.add(target.children[0]);
      // The target dissolves into the referencing prim; remember it so its
      // opinions (e.g. an asset root's RigidBodyAPI) stay reachable.
      const targetTag = getPrimTag(target);
      if (targetTag && this.referencingSpec) this.dissolvedTargets.set(this.referencingSpec, targetTag);
    } else {
      wrapper.add(target);
    }
    return wrapper;
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

  /** Only merge a referenced mesh into its prim when nothing else would be lost. */
  protected override _findSingleMesh(group: Object3D): Mesh | null {
    if (group.children.length !== 1) return null;
    let node = group.children[0];
    if (!(node as Mesh).isMesh) {
      if (this._hasNonIdentityTransform(node) || node.children.length !== 1) return null;
      node = node.children[0];
    }
    const mesh = node as Mesh;
    if (!mesh.isMesh || mesh.children.length > 0 || this._hasNonIdentityTransform(mesh)) return null;
    mesh.removeFromParent();
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
