import { USDAParser } from "three/examples/jsm/loaders/usd/USDAParser.js";
import type { USDLayerData, USDSpec } from "three/examples/jsm/loaders/usd/USDCParser.js";
import { CrateParser } from "./crateParser";
import { isUrl, joinPath, relativePath } from "./paths";

export type { USDLayerData, USDSpec };

export const SpecType = { Attribute: 1, Prim: 6, Relationship: 8 } as const;
const Specifier = { Def: 0, Over: 1, Class: 2 } as const;

export type FileKind = "usda" | "usdc" | "usdz" | "unknown";
export type LayerFormat = "usda" | "usdc";

export interface ParsedLayer {
  path: string;
  format: LayerFormat;
  byteLength: number;
  data: USDLayerData;
  /** subLayer asset paths exactly as authored (relative to this layer). */
  subLayers: string[];
  /** Layer metadata (upAxis, timeCodes, doc, ...). */
  metadata: Record<string, unknown>;
}

const CRATE_MAGIC = [0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43]; // PXR-USDC

export function detectKind(bytes: Uint8Array): FileKind {
  if (bytes.length >= 8 && CRATE_MAGIC.every((b, i) => bytes[i] === b)) return "usdc";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "usdz";
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^﻿/, "").trimStart();
  return head.startsWith("#usda") ? "usda" : "unknown";
}

export function parseLayer(path: string, bytes: Uint8Array): ParsedLayer {
  const kind = detectKind(bytes);
  if (kind === "usdc") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const data = new CrateParser().parseData(buffer);
    const root = data.specsByPath["/"]?.fields ?? {};
    const subLayers = Array.isArray(root.subLayers) ? (root.subLayers as unknown[]).filter((s): s is string => typeof s === "string") : [];
    return { path, format: "usdc", byteLength: bytes.byteLength, data, subLayers, metadata: { ...root } };
  }
  if (kind === "usdz") throw new Error("USDZ 패키지는 다른 레이어 안에서 참조할 수 없습니다.");

  const text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
  if (kind === "unknown" && !/^\s*(def|over|class)\s/m.test(text)) {
    throw new Error("USD 파일 형식을 인식할 수 없습니다 (#usda 헤더 또는 PXR-USDC 시그니처 없음).");
  }
  const header = readUsdaHeader(text);
  const data = new USDAParser().parseData(normalizeUsdaText(text));
  postProcessUsda(data);
  Object.assign(data.specsByPath["/"].fields, pickHeaderFields(header.metadata));
  return { path, format: "usda", byteLength: bytes.byteLength, data, subLayers: header.subLayers, metadata: header.metadata };
}

// ---------------------------------------------------------------- USDA text

const OVER_MARK = "__viewerOver";
const INACTIVE_ATTR = "__viewerInactive";

/**
 * Rewrites USDA syntax the three parser ignores into forms it reads:
 * plain/append `references` and `apiSchemas`, list-edited `payload`, `over`
 * prims and `active = false`. The markers are resolved again in postProcessUsda().
 */
function normalizeUsdaText(text: string): string {
  return text
    .replace(/^(\s*)(?:add\s+|append\s+)?references(\s*=)/gm, "$1prepend references$2")
    .replace(/^(\s*)(?:add\s+|append\s+)?apiSchemas(\s*=)/gm, "$1prepend apiSchemas$2")
    .replace(/^(\s*)(?:prepend|append|add)\s+payload(\s*=)/gm, "$1payload$2")
    .replace(/^(\s*)over\s+(?:(\w+)\s+)?"/gm, (_m, ws: string, type?: string) => `${ws}def ${type ?? ""}${OVER_MARK} "`)
    .replace(/^(\s*)active\s*=\s*false\s*$/gm, `$1bool ${INACTIVE_ATTR} = 1`)
    // `custom` marks attributes outside any schema; three would take it for the type name.
    .replace(/^(\s*)custom\s+(?=\S)/gm, "$1");
}

function postProcessUsda(data: USDLayerData): void {
  const specs = data.specsByPath;
  for (const path in specs) {
    const spec = specs[path];
    if (spec.specType === SpecType.Prim && path !== "/") {
      // Sdf's fallback specifier is `over`, so record `def` explicitly like crate files do.
      const typeName = spec.fields.typeName;
      if (typeof typeName === "string" && typeName.endsWith(OVER_MARK)) {
        spec.fields.typeName = typeName.slice(0, -OVER_MARK.length);
        spec.fields.specifier = Specifier.Over;
      } else {
        spec.fields.specifier = Specifier.Def;
      }
    } else if (path.endsWith(`.${INACTIVE_ATTR}`)) {
      const prim = specs[path.slice(0, -INACTIVE_ATTR.length - 1)];
      if (prim) prim.fields.active = false;
      delete specs[path];
    } else if (path.endsWith(".apiSchemas")) {
      // `prepend apiSchemas = [...]` is metadata, but three parses it as an attribute.
      const prim = specs[path.slice(0, -".apiSchemas".length)];
      if (prim) prim.fields.apiSchemas = tokenList(spec.fields.default);
      delete specs[path];
    } else if (spec.fields.typeName === "bool" && typeof spec.fields.default === "string") {
      spec.fields.default = /^(1|true)$/i.test(spec.fields.default.trim());
    }
  }
}

function tokenList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  return [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

/** Applied API schema names of a prim spec (`PhysicsRigidBodyAPI`, ...). */
export function apiSchemasOf(spec: USDSpec | undefined): string[] {
  const value = spec?.fields.apiSchemas;
  return Array.isArray(value) ? value.map(String) : [];
}

function readUsdaHeader(text: string): { subLayers: string[]; metadata: Record<string, unknown> } {
  const match = /^\s*#usda[^\n]*\n\s*\(([\s\S]*?)\n\)/.exec(text);
  if (!match) return { subLayers: [], metadata: {} };
  const block = match[1];
  const metadata: Record<string, unknown> = {};

  const subMatch = /subLayers\s*=\s*\[([\s\S]*?)\]/.exec(block);
  const subLayers = subMatch ? [...subMatch[1].matchAll(/@([^@]+)@/g)].map((m) => m[1]) : [];
  if (subLayers.length) metadata.subLayers = subLayers;

  // The layer doc is either a bare leading string or `doc = "..."`.
  const doc =
    /^\s*(?:"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)")/.exec(block) ??
    /(?:^|\n)\s*doc\s*=\s*(?:"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)")/.exec(block);
  if (doc) metadata.documentation = (doc[1] ?? doc[2] ?? "").trim();

  for (const m of block.matchAll(/^\s*(\w+)\s*=\s*([^\n[{]+?)\s*$/gm)) {
    const raw = m[2].trim();
    const num = Number(raw);
    metadata[m[1]] = raw.startsWith('"') ? raw.replace(/^"|"$/g, "") : Number.isFinite(num) ? num : raw;
  }
  return { subLayers, metadata };
}

function pickHeaderFields(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["startTimeCode", "endTimeCode", "timeCodesPerSecond", "framesPerSecond", "documentation"]) {
    if (meta[key] !== undefined) out[key] = meta[key];
  }
  return out;
}

// ---------------------------------------------------------------- dependencies

const ASSET_LIKE = /\.(usda?|usdc|usdz|png|jpe?g|webp|avif|gif|bmp|tga|tiff?|exr|hdr|ktx2?|dds|tx)$/i;

function collectStrings(value: unknown, visit: (s: string) => void, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    visit(value);
  } else if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "number") return;
    for (const item of value) collectStrings(item, visit, depth + 1);
  } else if (typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const key in value as Record<string, unknown>) collectStrings((value as Record<string, unknown>)[key], visit, depth + 1);
  }
}

function assetPathsInString(s: string): string[] {
  if (s.length > 4096) return [];
  if (s.includes("@")) return [...s.matchAll(/@([^@\n]+)@/g)].map((m) => m[1].trim());
  const t = s.trim();
  return !t.includes("\n") && ASSET_LIKE.test(t) ? [t] : [];
}

/** Every external asset a layer points at (sublayers, references, payloads, textures), as authored. */
export function collectAssetPaths(layer: ParsedLayer): string[] {
  const out = new Set<string>(layer.subLayers);
  for (const path in layer.data.specsByPath) {
    collectStrings(layer.data.specsByPath[path].fields, (s) => {
      for (const p of assetPathsInString(s)) out.add(p);
    });
  }
  return [...out];
}

function mapAssetStrings(value: unknown, fn: (p: string) => string, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") {
    if (value.includes("@")) return value.replace(/@([^@\n]+)@/g, (_m, p: string) => `@${fn(p)}@`);
    return ASSET_LIKE.test(value.trim()) ? fn(value.trim()) : value;
  }
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "number") return value;
    return value.map((v) => mapAssetStrings(v, fn, depth + 1));
  }
  if (typeof value === "object" && !ArrayBuffer.isView(value)) {
    const out: Record<string, unknown> = {};
    for (const key in value as Record<string, unknown>) out[key] = mapAssetStrings((value as Record<string, unknown>)[key], fn, depth + 1);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- layer stacks

// The strongest layer with any value opinion wins, default or timeSamples alike.
const VALUE_FIELDS = new Set(["default", "timeSamples"]);

/** Merge `weak` opinions into `strong` (both specsByPath maps); strong wins per field. */
function mergeWeaker(strong: Record<string, USDSpec>, weak: Record<string, USDSpec>): void {
  for (const path in weak) {
    const w = weak[path];
    const s = strong[path];
    if (!s) {
      strong[path] = { specType: w.specType, fields: { ...w.fields } };
      continue;
    }
    const sf = s.fields;
    const hasValue = "default" in sf || "timeSamples" in sf;
    for (const key in w.fields) {
      const wv = w.fields[key];
      if (key === "primChildren" && Array.isArray(wv)) {
        const own = Array.isArray(sf.primChildren) ? (sf.primChildren as string[]) : [];
        sf.primChildren = [...own, ...(wv as string[]).filter((c) => !own.includes(c))];
      } else if (key === "typeName") {
        if (!sf.typeName) sf.typeName = wv;
      } else if (key === "specifier") {
        // A def anywhere in the stack defines the prim.
        if (wv === Specifier.Def) sf.specifier = Specifier.Def;
      } else if (VALUE_FIELDS.has(key) && hasValue) {
        continue;
      } else if (!(key in sf)) {
        sf[key] = wv;
      }
    }
  }
}

function cloneSpecs(specs: Record<string, USDSpec>, rebase?: (p: string) => string): Record<string, USDSpec> {
  const out: Record<string, USDSpec> = {};
  for (const path in specs) {
    const spec = specs[path];
    out[path] = {
      specType: spec.specType,
      fields: rebase ? (mapAssetStrings(spec.fields, rebase) as Record<string, unknown>) : { ...spec.fields },
    };
  }
  return out;
}

function parentPathOf(path: string): string {
  if (path.endsWith("}")) return path.slice(0, path.lastIndexOf("{")).replace(/\/$/, "") || "/";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("}"));
  if (cut <= 0) return "/";
  return path.slice(0, cut + (path[cut] === "}" ? 1 : 0));
}

function primPartOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const dot = path.indexOf(".", Math.max(lastSlash, path.lastIndexOf("}")));
  return dot >= 0 ? path.slice(0, dot) : path;
}

/** Drop prims USD would not draw: inactive, or never `def`ined (over/class only). */
function pruneUndefinedPrims(specs: Record<string, USDSpec>): number {
  const dead = new Set<string>();
  for (const path in specs) {
    const spec = specs[path];
    if (path === "/" || spec.specType !== SpecType.Prim) continue;
    const f = spec.fields;
    // A missing specifier is Sdf's fallback, `over`.
    const specifier = f.specifier ?? Specifier.Over;
    if (f.active === false) dead.add(path);
    else if (!path.includes("{") && specifier !== Specifier.Def) dead.add(path);
  }
  if (!dead.size) return 0;
  let removed = 0;
  for (const path in specs) {
    let cur = primPartOf(path);
    while (cur && cur !== "/") {
      if (dead.has(cur)) {
        delete specs[path];
        removed++;
        break;
      }
      cur = parentPathOf(cur);
    }
  }
  return removed;
}

export interface StackResult {
  data: USDLayerData;
  /** Sublayers that took part, strongest first (excluding the layer itself). */
  sublayers: string[];
}

/**
 * Flatten a layer with its (recursive) subLayers into one specsByPath map so
 * the composer sees a single layer. Asset paths authored in sublayers living
 * in other folders are rebased onto the stack's root folder.
 */
export function flattenLayerStack(
  rootPath: string,
  layers: Map<string, ParsedLayer>,
  resolve: (fromLayer: string, assetPath: string) => string | null,
): StackResult {
  const rootDir = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/")) : "";
  const used: string[] = [];

  const flatten = (layerPath: string, chain: Set<string>): Record<string, USDSpec> => {
    const layer = layers.get(layerPath)!;
    const dir = layerPath.includes("/") ? layerPath.slice(0, layerPath.lastIndexOf("/")) : "";
    const rebase =
      dir === rootDir
        ? undefined
        : (p: string) => (isUrl(p) || p.startsWith("/") ? p : relativePath(rootDir, joinPath(dir, p)));
    const result = cloneSpecs(layer.data.specsByPath, rebase);
    for (const sub of layer.subLayers) {
      const subPath = resolve(layerPath, sub);
      if (!subPath || chain.has(subPath) || !layers.has(subPath)) continue;
      used.push(subPath);
      mergeWeaker(result, flatten(subPath, new Set([...chain, subPath])));
    }
    return result;
  };

  const specs = flatten(rootPath, new Set([rootPath]));
  if (specs["/"]) delete specs["/"].fields.subLayers;
  pruneUndefinedPrims(specs);
  return { data: { specsByPath: specs }, sublayers: used };
}
