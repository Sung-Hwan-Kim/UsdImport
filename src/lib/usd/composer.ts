import {
  Group,
  MeshPhysicalMaterial,
  type AnimationClip,
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
  missing: Set<string>;
  warnings: Set<string>;
  referenceCount: number;
  /** Composer instances created so far (the root composer is instance 0). */
  instanceCount: number;
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
    // directly under it, and the referencing prim's own transform is stronger.
    target.removeFromParent();
    const wrapper = new Group();
    const ownTransform = this.referencingPrimHasTransform();
    if (isContainer(target) && (ownTransform || !this._hasNonIdentityTransform(target))) {
      while (target.children.length) wrapper.add(target.children[0]);
      // The target dissolves into the referencing prim; remember it so its
      // opinions (e.g. an asset root's RigidBodyAPI) stay reachable.
      const targetTag = getPrimTag(target);
      if (targetTag && this.referencingSpec) this.dissolvedTargets.set(this.referencingSpec, targetTag);
    } else {
      if (ownTransform) {
        target.position.set(0, 0, 0);
        target.quaternion.identity();
        target.scale.set(1, 1, 1);
      }
      wrapper.add(target);
    }
    return wrapper;
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
    return new MeshPhysicalMaterial({ roughness: 0.7 });
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
