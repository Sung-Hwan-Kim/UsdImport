import { USDAParser } from "three/examples/jsm/loaders/usd/USDAParser.js";
import type { USDLayerData, USDSpec } from "three/examples/jsm/loaders/usd/USDCParser.js";
import { CrateParser } from "./crateParser";
import { isUrl, joinPath, relativePath } from "./paths";

export type { USDLayerData, USDSpec };

export const SpecType = { Attribute: 1, Prim: 6, Relationship: 8, Variant: 10, VariantSet: 11 } as const;
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
  const variants: VariantName[] = [];
  const data = new USDAParser().parseData(normalizeUsdaText(text, variants));
  postProcessUsda(data, variants);
  Object.assign(data.specsByPath["/"].fields, pickHeaderFields(header.metadata));
  return { path, format: "usda", byteLength: bytes.byteLength, data, subLayers: header.subLayers, metadata: header.metadata };
}

// ---------------------------------------------------------------- USDA text

const OVER_MARK = "__viewerOver";
const CLASS_MARK = "__viewerClass";
const INACTIVE_ATTR = "__viewerInactive";
const VARIANT_MARK = "__viewerVariant";

/** A variant set and variant name, by the index in its marker prim's name. */
type VariantName = [set: string, variant: string];

/** `rel x` or `type x.connect =` after a list-op keyword. */
const LISTED_PROPERTY = String.raw`(?:(?:custom|uniform|varying)\s+)*(?:rel\s|[\w[\]]+\s+[\w:.]+\.connect\s*=)`;

/**
 * Rewrites USDA syntax the three parser ignores into forms it reads:
 * plain/append `references` and `apiSchemas`, list-edited `payload`,
 * relationships and connections, `over` and `class` prims, variant sets and
 * `active = false`. The markers are resolved again in postProcessUsda().
 */
function normalizeUsdaText(text: string, variants: VariantName[]): string {
  return markVariantSets(dropValuelessPropertyMetadata(text), variants)
    .replace(/^(\s*)(?:add\s+|append\s+)?references(\s*=)/gm, "$1prepend references$2")
    .replace(/^(\s*)(?:add\s+|append\s+)?apiSchemas(\s*=)/gm, "$1prepend apiSchemas$2")
    .replace(/^(\s*)(?:prepend|append|add)\s+payload(\s*=)/gm, "$1payload$2")
    .replace(new RegExp(String.raw`^(\s*)(?:prepend|append|add)\s+(?=${LISTED_PROPERTY})`, "gm"), "$1")
    .replace(new RegExp(String.raw`^\s*(?:delete|reorder)\s+${LISTED_PROPERTY}.*$`, "gm"), "")
    // Variant set names come from the variantSet blocks; three would read this as an attribute.
    .replace(/^\s*(?:(?:prepend|append|add|delete|reorder)\s+)?variantSets\s*=.*$/gm, "")
    .replace(/^(\s*)over\s+(?:(\w+)\s+)?"/gm, (_m, ws: string, type?: string) => `${ws}def ${type ?? ""}${OVER_MARK} "`)
    .replace(/^(\s*)class\s+(?:(\w+)\s+)?"/gm, (_m, ws: string, type?: string) => `${ws}def ${type ?? ""}${CLASS_MARK} "`)
    .replace(/^(\s*)active\s*=\s*false\s*$/gm, `$1bool ${INACTIVE_ATTR} = 1`)
    // `custom` marks attributes outside any schema; three would take it for the type name.
    .replace(/^(\s*)custom\s+(?=\S)/gm, "$1");
}

/** Open quote and brace state while scanning USDA lines. */
interface ScanState {
  quote: string;
  /** One entry per open `{`: the variant set it opens, else null. */
  braces: (string | null)[];
}

/** Track the braces of a line outside strings, `<paths>` and `@assets@`. */
function scanBraces(line: string, state: ScanState): void {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (state.quote) {
      if (ch === "\\") i++;
      else if (line.startsWith(state.quote, i)) {
        i += state.quote.length - 1;
        state.quote = "";
      }
    } else if (ch === '"' || ch === "'") {
      state.quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      i += state.quote.length - 1;
    } else if (ch === "<" || ch === "@") {
      const end = line.indexOf(ch === "<" ? ">" : "@", i + 1);
      if (end > i) i = end;
    } else if (ch === "{") {
      state.braces.push(null);
    } else if (ch === "}") {
      state.braces.pop();
    }
  }
  // Only triple-quoted strings span lines.
  if (state.quote.length === 1) state.quote = "";
}

/**
 * three's parser cannot read `variantSet "name" = { "variant" (...) { ... } }`
 * blocks. Turn each variant into a marked child prim (`def "__viewerVariant3"`)
 * that it does read, with the variant's metadata (payload, references) and
 * contents; postProcessUsda() moves them to `/prim/{set=variant}` specs the
 * way crate files store them.
 */
function markVariantSets(text: string, variants: VariantName[]): string {
  if (!/^[ \t]*variantSet[ \t]/m.test(text)) return text;
  const state: ScanState = { quote: "", braces: [] };
  const out: string[] = [];
  let metadataOpen = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    const indent = line.slice(0, line.length - line.trimStart().length);
    if (!state.quote) {
      const set = state.braces.at(-1) ?? null;
      const header = /^variantSet\s+"([^"]+)"\s*=\s*\{$/.exec(t);
      if (header) {
        state.braces.push(header[1]);
        continue;
      }
      if (set !== null) {
        if (t === "}") {
          state.braces.pop();
          continue;
        }
        const variant = /^"([^"]*)"\s*([({])\s*(\})?$/.exec(t);
        if (variant) {
          const def = `${indent}def "${VARIANT_MARK}${variants.push([set, variant[1]]) - 1}"`;
          if (variant[2] === "(") {
            out.push(`${def} (`);
            metadataOpen = true;
          } else {
            out.push(def, `${indent}{`);
            if (variant[3]) out.push(`${indent}}`);
            else state.braces.push(null);
          }
          continue;
        }
      }
      // The variant's metadata closes on the line that opens its body: `) {`.
      if (metadataOpen && /^\)\s*\{\s*(\})?$/.test(t)) {
        out.push(`${indent})`, `${indent}{`);
        if (t.endsWith("}")) out.push(`${indent}}`);
        else state.braces.push(null);
        metadataOpen = false;
        continue;
      }
    }
    scanBraces(line, state);
    out.push(line);
  }
  return out.join("\n");
}

/** A property declared without a value, opening its metadata: `token outputs:surface (`. */
const VALUELESS_PROPERTY = /^[ \t]*(?:[\w[\]]+[ \t]+)+[\w:.]+[ \t]*\(/gm;

/**
 * three reads `token outputs:surface (` (metadata but no value, as Omniverse
 * writes material outputs) as a time sample and then takes its `)` for the end
 * of the enclosing prim, shifting every later prim up the hierarchy. Such
 * metadata (displayGroup, doc, ...) means nothing to the viewer, so keep only
 * the declaration.
 */
function dropValuelessPropertyMetadata(text: string): string {
  VALUELESS_PROPERTY.lastIndex = 0;
  if (!VALUELESS_PROPERTY.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    VALUELESS_PROPERTY.lastIndex = 0;
    const match = VALUELESS_PROPERTY.exec(lines[i]);
    const end = match ? closingParenLine(lines, i, match[0].length - 1) : null;
    if (end === null) {
      out.push(lines[i]);
      continue;
    }
    out.push(match![0].slice(0, -1).trimEnd());
    i = end;
  }
  return out.join("\n");
}

/** The line holding the `)` that closes the `(` at lines[line][col], skipping strings. */
function closingParenLine(lines: string[], line: number, col: number): number | null {
  let depth = 0;
  let quote = "";
  for (let i = line; i < lines.length; i++) {
    const s = lines[i];
    for (let j = i === line ? col : 0; j < s.length; j++) {
      const ch = s[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (s.startsWith(quote, j)) {
          j += quote.length - 1;
          quote = "";
        }
      } else if (ch === '"' || ch === "'") {
        quote = s.startsWith(ch.repeat(3), j) ? ch.repeat(3) : ch;
        j += quote.length - 1;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")" && --depth === 0) {
        return i;
      }
    }
    // Only triple-quoted strings span lines.
    if (quote.length === 1) quote = "";
  }
  return null;
}

/**
 * Move the marked variant prims to variant specs (`/prim/{set=variant}`, as
 * crate files store them), with a `/prim/{set=}` spec listing each set's
 * variants and the set on the prim's `variantSetChildren`.
 */
function unmarkVariants(data: USDLayerData, variants: VariantName[]): void {
  if (!variants.length) return;
  const marked = new RegExp(String.raw`/${VARIANT_MARK}(\d+)(?=[/.]|$)`, "g");
  const variantSpec = new RegExp(String.raw`/${VARIANT_MARK}(\d+)$`);
  const original = data.specsByPath;
  const specs: Record<string, USDSpec> = {};
  for (const path in original) {
    const spec = original[path];
    const renamed = path.replace(marked, (_m, i: string) => `/{${variants[+i][0]}=${variants[+i][1]}}`);
    specs[renamed] = spec;
    const own = variantSpec.exec(path);
    if (!own) continue;
    const [set, name] = variants[+own[1]];
    spec.specType = SpecType.Variant;
    delete spec.fields.typeName;
    delete spec.fields.specifier;
    const owner = renamed.slice(0, renamed.lastIndexOf("/{")) || "/";
    const setSpec = (specs[`${owner}/{${set}=}`] ??= { specType: SpecType.VariantSet, fields: { variantChildren: [] } });
    (setSpec.fields.variantChildren as string[]).push(name);
    const ownerFields = original[path.slice(0, own.index) || "/"]?.fields;
    if (!ownerFields) continue;
    if (Array.isArray(ownerFields.primChildren)) {
      ownerFields.primChildren = (ownerFields.primChildren as string[]).filter((c) => c !== `${VARIANT_MARK}${own[1]}`);
    }
    const sets = (ownerFields.variantSetChildren as string[] | undefined) ?? [];
    if (!sets.includes(set)) ownerFields.variantSetChildren = [...sets, set];
  }
  data.specsByPath = specs;
}

function postProcessUsda(data: USDLayerData, variants: VariantName[]): void {
  unmarkVariants(data, variants);
  const specs = data.specsByPath;
  for (const path in specs) {
    const spec = specs[path];
    // three keeps xformOpOrder as a prim field; store it as the attribute it is
    // (as crate files do) so opinions from usda and usdc layers compose per attribute.
    const order = spec.fields.xformOpOrder;
    if (Array.isArray(order)) {
      specs[`${path}.xformOpOrder`] ??= { specType: SpecType.Attribute, fields: { typeName: "token[]", default: order } };
      delete spec.fields.xformOpOrder;
    }
    if (spec.specType === SpecType.Prim && path !== "/") {
      // Sdf's fallback specifier is `over`, so record `def` explicitly like crate files do.
      const typeName = spec.fields.typeName;
      if (typeof typeName === "string" && typeName.endsWith(OVER_MARK)) {
        spec.fields.typeName = typeName.slice(0, -OVER_MARK.length);
        spec.fields.specifier = Specifier.Over;
      } else if (typeof typeName === "string" && typeName.endsWith(CLASS_MARK)) {
        spec.fields.typeName = typeName.slice(0, -CLASS_MARK.length);
        spec.fields.specifier = Specifier.Class;
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

export function mapAssetStrings(value: unknown, fn: (p: string) => string, depth = 0): unknown {
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
export function mergeWeaker(strong: Record<string, USDSpec>, weak: Record<string, USDSpec>): void {
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
      if ((key === "primChildren" || key === "properties" || key === "apiSchemas") && Array.isArray(wv)) {
        // Name lists and applied schemas compose; the stronger layer's order comes first.
        const own = Array.isArray(sf[key]) ? (sf[key] as unknown[]) : [];
        sf[key] = [...own, ...(wv as unknown[]).filter((c) => !own.includes(c))];
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

export function cloneSpecs(specs: Record<string, USDSpec>, rebase?: (p: string) => string): Record<string, USDSpec> {
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

export function parentPathOf(path: string): string {
  if (path.endsWith("}")) return path.slice(0, path.lastIndexOf("{")).replace(/\/$/, "") || "/";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("}"));
  if (cut <= 0) return "/";
  return path.slice(0, cut + (path[cut] === "}" ? 1 : 0));
}

export function primPartOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const dot = path.indexOf(".", Math.max(lastSlash, path.lastIndexOf("}")));
  return dot >= 0 ? path.slice(0, dot) : path;
}

// ---------------------------------------------------------------- internal references

/** A path equal to `root` or inside its namespace (children, properties, variants). */
export function isUnder(path: string, root: string): boolean {
  return path === root || (path.startsWith(root) && "/.{".includes(path[root.length]));
}

const EXTERNAL_ARC = /@[^@]*@(?:<[^>]*>)?/g;

/** A references value's external arcs (`@asset@<prim>`) and internal targets (`</prim>`), strongest first. */
function splitReferences(value: unknown): { external: string[]; internal: string[] } {
  const text = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string").join(", ");
  const external = [...text.matchAll(EXTERNAL_ARC)].map((m) => m[0]);
  const internal = [...text.replace(EXTERNAL_ARC, "").matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  return { external, internal };
}

function retarget(path: string, from: string, to: string): string {
  const bare = path.replace(/^<|>$/g, "");
  if (!isUnder(bare, from)) return path;
  const mapped = to + bare.slice(from.length);
  return path.startsWith("<") ? `<${mapped}>` : mapped;
}

/**
 * Compose internal references (`references = </Path>`, no asset), which three
 * ignores: the target prim's specs are copied under the referencing prim as
 * weaker opinions, with relationship targets and connections inside the
 * target re-targeted, as USD composes them. Runs before pruning, because the
 * targets often live under `class` prims that are not drawn themselves.
 */
function composeInternalReferences(specs: Record<string, USDSpec>): void {
  const hasInternal = (path: string) => splitReferences(specs[path]?.fields.references).internal.length > 0;
  const done = new Set<string>();
  const resolving = new Set<string>();

  const resolve = (path: string) => {
    if (done.has(path) || resolving.has(path)) return;
    const spec = specs[path];
    if (!spec || !hasInternal(path)) {
      done.add(path);
      return;
    }
    resolving.add(path);
    const { external, internal } = splitReferences(spec.fields.references);
    for (const target of internal) {
      // A missing target, or one around or inside the referencing prim, composes nothing.
      if (!specs[target] || isUnder(path, target) || isUnder(target, path)) continue;
      // Compose the target's own internal references first, so what is copied is final.
      for (const p of Object.keys(specs)) if (isUnder(p, target) && specs[p].specType === SpecType.Prim && hasInternal(p)) resolve(p);
      const weak: Record<string, USDSpec> = {};
      for (const p in specs) {
        if (!isUnder(p, target)) continue;
        const fields = { ...specs[p].fields };
        for (const key of ["targetPaths", "connectionPaths"]) {
          const paths = fields[key];
          if (Array.isArray(paths)) fields[key] = paths.map((t) => (typeof t === "string" ? retarget(t, target, path) : t));
        }
        weak[path + p.slice(target.length)] = { specType: specs[p].specType, fields };
      }
      // The target's external arcs come after the referencing prim's own (weaker).
      external.push(...splitReferences(weak[path].fields.references).external);
      delete weak[path].fields.references;
      mergeWeaker(specs, weak);
    }
    if (external.length) spec.fields.references = [external.join(", ")];
    else delete spec.fields.references;
    resolving.delete(path);
    done.add(path);
  };

  for (const path of Object.keys(specs)) if (specs[path]?.specType === SpecType.Prim) resolve(path);
}

/** Drop prims USD would not draw: inactive, or never `def`ined (over/class only). */
export function pruneUndefinedPrims(specs: Record<string, USDSpec>): number {
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
 * Flatten a layer with its (recursive) subLayers into one specsByPath map.
 * Asset paths authored in sublayers living in other folders are rebased onto
 * the stack's root folder. Nothing is pruned: `over`s may be about prims that
 * references bring in, which flattenStage() (arcs.ts) composes.
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
  composeInternalReferences(specs);
  return { data: { specsByPath: specs }, sublayers: used };
}
