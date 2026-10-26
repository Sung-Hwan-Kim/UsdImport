/**
 * A lossless in-memory USD layer, shaped like OpenUSD's SdfData: specs keyed
 * by path, each a bag of named fields holding typed values. The usda and
 * usdc readers/writers in this folder translate files to and from it, so a
 * layer can be saved again (or in the other format) without dropping data.
 */

/** SdfSpecType, numbered as in crate files. */
export const SpecType = {
  Unknown: 0,
  Attribute: 1,
  Connection: 2,
  Expression: 3,
  Mapper: 4,
  MapperArg: 5,
  Prim: 6,
  PseudoRoot: 7,
  Relationship: 8,
  RelationshipTarget: 9,
  Variant: 10,
  VariantSet: 11,
} as const;
export type SpecType = (typeof SpecType)[keyof typeof SpecType];

/**
 * A typed value. `type` is an Sdf value type name for attribute-style values
 * ("float3", "token[]", "matrix4d", ...) or one of the field value kinds below.
 *
 * Representation:
 * - bool: boolean; int64/uint64: bigint; other numbers: number
 * - half and half vectors: raw IEEE half bits (so values survive unchanged)
 * - vectors/matrices/quats: flat number[] (quats in memory order x, y, z, w;
 *   matrices row-major)
 * - arrays: typed arrays for numbers (flattened tuples), string[] otherwise
 * - string/token/asset: string
 */
export interface SdfValue {
  type: string;
  value: unknown;
}

export type Specifier = "def" | "over" | "class";
export type Variability = "varying" | "uniform";
export type Permission = "public" | "private";

export interface LayerOffset {
  offset: number;
  scale: number;
}

export interface Reference {
  assetPath: string;
  primPath: string;
  layerOffset: LayerOffset;
  customData: Dictionary;
}

export interface Payload {
  assetPath: string;
  primPath: string;
  layerOffset: LayerOffset;
}

export type Dictionary = Map<string, SdfValue>;

/** SdfListOp: either explicit, or a set of edits to a weaker opinion. */
export interface ListOp<T> {
  explicit: boolean;
  explicitItems: T[];
  addedItems: T[];
  prependedItems: T[];
  appendedItems: T[];
  deletedItems: T[];
  orderedItems: T[];
}

export type TimeSamples = [number, SdfValue][];

export function emptyListOp<T>(): ListOp<T> {
  return { explicit: false, explicitItems: [], addedItems: [], prependedItems: [], appendedItems: [], deletedItems: [], orderedItems: [] };
}

export interface SdfSpec {
  type: SpecType;
  fields: Map<string, SdfValue>;
}

export class SdfLayer {
  /** In file order; "/" is the pseudo-root holding layer metadata. */
  readonly specs = new Map<string, SdfSpec>();

  constructor() {
    this.specs.set("/", { type: SpecType.PseudoRoot, fields: new Map() });
  }

  get root(): SdfSpec {
    return this.specs.get("/")!;
  }

  spec(path: string): SdfSpec | undefined {
    return this.specs.get(path);
  }

  field(path: string, name: string): SdfValue | undefined {
    return this.specs.get(path)?.fields.get(name);
  }
}

/** Errors for content this implementation cannot carry through losslessly. */
export class UnsupportedUsdError extends Error {}

// ---------------------------------------------------------------- paths

/** The parent of a prim, property or variant path ("/" for top-level prims). */
export function parentPath(path: string): string {
  if (path === "/") return "";
  const dot = propertySeparator(path);
  if (dot >= 0) return path.slice(0, dot);
  if (path.endsWith("}")) return path.slice(0, path.lastIndexOf("{"));
  const slash = path.lastIndexOf("/");
  const brace = path.lastIndexOf("}");
  if (brace > slash) return path.slice(0, brace + 1);
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** Index of the "." that starts the property part of a path, or -1. */
export function propertySeparator(path: string): number {
  let depth = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "." && depth === 0) return i;
  }
  return -1;
}

/** Last element name of a path: prim name, property name or "{set=variant}". */
export function pathName(path: string): string {
  const dot = propertySeparator(path);
  if (dot >= 0) return path.slice(dot + 1);
  if (path.endsWith("}")) return path.slice(path.lastIndexOf("{"));
  const slash = path.lastIndexOf("/");
  const brace = path.lastIndexOf("}");
  return path.slice(Math.max(slash, brace) + 1);
}

export function childPrimPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : parent.endsWith("}") ? `${parent}${name}` : `${parent}/${name}`;
}

export function propertyPath(prim: string, name: string): string {
  return `${prim}.${name}`;
}

/** "/A{set=}" for a variant set, "/A{set=v}" for one of its variants. */
export function variantPath(prim: string, set: string, variant: string): string {
  return `${prim}{${set}=${variant}}`;
}

/** Value element count per tuple for an Sdf scalar type name (without "[]"). */
export function tupleSize(type: string): number {
  const base = type.replace(/\[\]$/, "");
  if (base === "matrix2d") return 4;
  if (base === "matrix3d") return 9;
  if (base === "matrix4d") return 16;
  if (base.startsWith("quat")) return 4;
  const m = VECTOR.exec(base);
  return m ? Number(m[2]) : 1;
}

/** Vector type names: "float3", "half2", "int4" (but not "int64"). */
const VECTOR = /^(double|float|half|int)([234])$/;

/** The scalar component kind of a value type name ("float3[]" -> "float"). */
export function componentType(type: string): string {
  const base = type.replace(/\[\]$/, "");
  if (base.startsWith("matrix")) return "double";
  if (base.startsWith("quat")) return { quatd: "double", quatf: "float", quath: "half" }[base] ?? "double";
  return VECTOR.exec(base)?.[1] ?? base;
}
