import type { AnimationClip, Group, Material, Mesh, Object3D, SkinnedMesh, Texture } from "three";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { ViewerComposer, type ComposeContext, type PrimTag } from "./composer";
import {
  SpecType,
  collectAssetPaths,
  detectKind,
  flattenLayerStack,
  parseLayer,
  type LayerFormat,
  type ParsedLayer,
  type USDLayerData,
} from "./layers";
import { basename, dirname, isImageFile, isLayerFile, isUnsupportedImage, isUrl, joinPath, normalizePath } from "./paths";
import { MemorySource, PathIndex, type AssetSource } from "./sources";

export type LayerRole = "root" | "sublayer" | "reference";

export interface LayerInfo {
  path: string;
  format: LayerFormat;
  byteLength: number;
  role: LayerRole;
  /** Flattened layer stack, as handed to the composer. */
  data: USDLayerData;
  metadata: Record<string, unknown>;
}

export interface StageMetadata {
  upAxis: "Y" | "Z";
  upAxisAuthored: boolean;
  metersPerUnit?: number;
  defaultPrim?: string;
  startTimeCode?: number;
  endTimeCode?: number;
  timeCodesPerSecond: number;
  documentation?: string;
}

export interface StageStats {
  prims: number;
  objects: number;
  meshes: number;
  skinnedMeshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
  lights: number;
  cameras: number;
  references: number;
}

export interface LoadedStage {
  id: number;
  name: string;
  rootPath: string;
  rootFormat: LayerFormat | "usdz";
  sourceLabel: string;
  scene: Group;
  animations: AnimationClip[];
  layers: Map<string, LayerInfo>;
  textures: { path: string; byteLength: number }[];
  missing: string[];
  warnings: string[];
  metadata: StageMetadata;
  stats: StageStats;
  timings: { parse: number; compose: number; textures: number; total: number };
}

export interface LoadOptions {
  onProgress?: (message: string) => void;
}

let nextStageId = 1;

/** Let React paint progress before the next synchronous parse step. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Asset map handed to the composer: lookups go through the forgiving PathIndex. */
function createAssetMap(entries: Record<string, unknown>, index: PathIndex): Record<string, unknown> {
  return new Proxy(entries, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
      const key = index.resolve(prop);
      return key ? target[key] : undefined;
    },
  });
}

export async function loadStage(source: AssetSource, requestedRoot: string, options: LoadOptions = {}): Promise<LoadedStage> {
  const progress = options.onProgress ?? (() => {});
  const t0 = performance.now();
  const warnings = new Set<string>();
  const missing = new Set<string>();

  let rootPath = source.resolve(requestedRoot) ?? normalizePath(requestedRoot);
  const name = basename(rootPath);
  progress(`${name} 읽는 중…`);
  let rootBytes = await source.read(rootPath);
  if (!rootBytes) throw new Error(`파일을 읽을 수 없습니다: ${rootPath}`);

  let rootFormat: LoadedStage["rootFormat"];
  const kind = detectKind(rootBytes);
  if (kind === "usdz") {
    progress("USDZ 패키지 압축 해제 중…");
    await nextFrame();
    const files = unzipSync(rootBytes);
    const entries = Object.keys(files).filter((p) => !p.endsWith("/"));
    // AOUSD core spec: the first entry of a package is its root layer.
    const first = isLayerFile(entries[0] ?? "") ? entries[0] : entries.find(isLayerFile);
    if (!first) throw new Error("USDZ 패키지에 USD 레이어가 없습니다.");
    source = new MemorySource(files, name);
    rootPath = source.resolve(first) ?? normalizePath(first);
    rootBytes = files[first];
    rootFormat = "usdz";
  } else {
    rootFormat = kind === "usdc" ? "usdc" : "usda";
  }

  const resolveDependency = (fromLayer: string, asset: string): string | null => {
    if (/<udim>/i.test(asset)) {
      warnings.add(`UDIM 텍스처는 지원하지 않습니다: ${asset}`);
      return null;
    }
    if (isUrl(asset)) {
      warnings.add(`외부 URL 에셋은 건너뜁니다: ${asset}`);
      return null;
    }
    const joined = joinPath(dirname(fromLayer), asset);
    return source.resolve(joined) ?? joined;
  };

  // Breadth-first walk over sublayers, references, payloads and textures.
  const layers = new Map<string, ParsedLayer>();
  const images = new Map<string, Uint8Array>();
  const seen = new Set([rootPath]);
  let frontier = [rootPath];
  const tParse = performance.now();
  while (frontier.length) {
    const batch = await Promise.all(
      frontier.map(async (path) => [path, path === rootPath ? rootBytes : await source.read(path)] as const),
    );
    const next: string[] = [];
    for (const [path, bytes] of batch) {
      if (!bytes) {
        missing.add(path);
        continue;
      }
      if (path !== rootPath && !isLayerFile(path)) {
        images.set(path, bytes);
        continue;
      }
      progress(`${basename(path)} 파싱 중…`);
      await nextFrame();
      let layer: ParsedLayer;
      try {
        layer = parseLayer(path, bytes);
      } catch (e) {
        if (path === rootPath) throw e;
        warnings.add(`${path}: ${errorMessage(e)}`);
        continue;
      }
      layers.set(path, layer);
      for (const asset of collectAssetPaths(layer)) {
        const dep = resolveDependency(path, asset);
        if (!dep || seen.has(dep)) continue;
        seen.add(dep);
        if (isLayerFile(dep) || isImageFile(dep)) next.push(dep);
        else if (isUnsupportedImage(dep)) warnings.add(`브라우저에서 표시할 수 없는 텍스처 형식입니다: ${dep}`);
      }
    }
    frontier = next;
  }
  const parseTime = performance.now() - tParse;

  progress("레이어 스택 합성 중…");
  await nextFrame();
  const index = new PathIndex();
  const assets: Record<string, unknown> = {};
  const sublayerPaths = new Set<string>();
  const stacks = new Map<string, USDLayerData>();
  const resolveExisting = (from: string, asset: string) => {
    const dep = resolveDependency(from, asset);
    return dep && layers.has(dep) ? dep : null;
  };
  for (const path of layers.keys()) {
    const stack = flattenLayerStack(path, layers, resolveExisting);
    for (const s of stack.sublayers) sublayerPaths.add(s);
    stacks.set(path, stack.data);
    assets[path] = stack.data;
    index.add(path);
  }
  for (const [path, bytes] of images) {
    assets[path] = bytes;
    index.add(path);
  }

  const layerInfos = new Map<string, LayerInfo>();
  for (const [path, layer] of layers) {
    layerInfos.set(path, {
      path,
      format: layer.format,
      byteLength: layer.byteLength,
      role: path === rootPath ? "root" : sublayerPaths.has(path) ? "sublayer" : "reference",
      data: stacks.get(path)!,
      metadata: layer.metadata,
    });
  }

  progress("씬 그래프 생성 중…");
  await nextFrame();
  const tCompose = performance.now();
  const ctx: ComposeContext = {
    resolveAsset: (p) => index.resolve(p),
    textureCaches: new Map(),
    texturePromises: [],
    animations: [],
    missing,
    warnings,
    referenceCount: 0,
  };
  const rootData = stacks.get(rootPath)!;
  const composer = new ViewerComposer(ctx, rootPath, [rootPath]);
  const scene = composer.compose(rootData, createAssetMap(assets, index), {}, dirname(rootPath));
  scene.name = name;
  scene.animations = [...scene.animations, ...ctx.animations];
  scene.userData.usd = { layer: rootPath, path: "/", typeName: "Stage" } satisfies PrimTag;
  const composeTime = performance.now() - tCompose;

  const tTextures = performance.now();
  if (ctx.texturePromises.length) {
    progress(`텍스처 ${ctx.texturePromises.length}개 디코딩 중…`);
    await Promise.all(ctx.texturePromises);
  }
  const textureTime = performance.now() - tTextures;

  const rootFields = rootData.specsByPath["/"]?.fields ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const metadata: StageMetadata = {
    upAxis: rootFields.upAxis === "Z" ? "Z" : "Y",
    upAxisAuthored: rootFields.upAxis === "Z" || rootFields.upAxis === "Y",
    metersPerUnit: num(rootFields.metersPerUnit),
    defaultPrim: typeof rootFields.defaultPrim === "string" ? rootFields.defaultPrim : undefined,
    startTimeCode: num(rootFields.startTimeCode),
    endTimeCode: num(rootFields.endTimeCode),
    timeCodesPerSecond: num(rootFields.timeCodesPerSecond) ?? num(rootFields.framesPerSecond) ?? 24,
    documentation: typeof rootFields.documentation === "string" && rootFields.documentation ? rootFields.documentation : undefined,
  };

  let prims = 0;
  for (const path in rootData.specsByPath) {
    if (path !== "/" && rootData.specsByPath[path].specType === SpecType.Prim) prims++;
  }

  return {
    id: nextStageId++,
    name,
    rootPath,
    rootFormat,
    sourceLabel: source.label,
    scene,
    animations: scene.animations,
    layers: layerInfos,
    textures: [...images].map(([path, bytes]) => ({ path, byteLength: bytes.byteLength })),
    missing: [...missing].sort(),
    warnings: [...warnings],
    metadata,
    stats: { ...computeStats(scene), prims, references: ctx.referenceCount },
    timings: { parse: parseTime, compose: composeTime, textures: textureTime, total: performance.now() - t0 },
  };
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

export function texturesOf(material: Material): [string, Texture][] {
  const out: [string, Texture][] = [];
  for (const [key, value] of Object.entries(material)) {
    if (value && (value as Texture).isTexture) out.push([key, value as Texture]);
  }
  return out;
}

export function geometryCounts(mesh: Mesh): { vertices: number; triangles: number } {
  const position = mesh.geometry.getAttribute("position");
  if (!position) return { vertices: 0, triangles: 0 };
  const indexCount = mesh.geometry.index ? mesh.geometry.index.count : position.count;
  return { vertices: position.count, triangles: Math.floor(indexCount / 3) };
}

function computeStats(scene: Object3D): Omit<StageStats, "prims" | "references"> {
  let objects = 0;
  let meshes = 0;
  let skinnedMeshes = 0;
  let triangles = 0;
  let vertices = 0;
  let lights = 0;
  let cameras = 0;
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((obj) => {
    objects++;
    if ((obj as Mesh).isMesh) {
      const mesh = obj as Mesh;
      meshes++;
      if ((obj as SkinnedMesh).isSkinnedMesh) skinnedMeshes++;
      const counts = geometryCounts(mesh);
      vertices += counts.vertices;
      triangles += counts.triangles;
      for (const m of materialsOf(mesh)) {
        materials.add(m);
        for (const [, t] of texturesOf(m)) textures.add(t);
      }
    } else if ((obj as { isLight?: boolean }).isLight) {
      lights++;
    } else if ((obj as { isCamera?: boolean }).isCamera) {
      cameras++;
    }
  });
  return {
    objects,
    meshes,
    skinnedMeshes,
    triangles,
    vertices,
    materials: materials.size,
    textures: textures.size,
    lights,
    cameras,
  };
}

export function disposeStage(stage: LoadedStage): void {
  const textures = new Set<Texture>();
  stage.scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of materialsOf(mesh)) {
      for (const [, t] of texturesOf(m)) textures.add(t);
      m.dispose();
    }
    const original = mesh.userData.originalMaterial as Material | Material[] | undefined;
    if (original) for (const m of Array.isArray(original) ? original : [original]) {
      for (const [, t] of texturesOf(m)) textures.add(t);
      m.dispose();
    }
  });
  for (const t of textures) t.dispose();
}
