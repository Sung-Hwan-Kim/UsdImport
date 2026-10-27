import {
  SpecType,
  cloneSpecs,
  isUnder,
  mapAssetStrings,
  mergeWeaker,
  parentPathOf,
  primPartOf,
  pruneUndefinedPrims,
  type USDLayerData,
  type USDSpec,
} from "./layers";
import { dirname, isUrl, joinPath, relativePath } from "./paths";

// Composition arcs (references, payloads, variants) flattened into one layer,
// as UsdStage::Flatten does. three's composer resolves each reference by
// composing the referenced layer into its own object tree, so opinions on
// referenced prims (`over`s authored by the referencing layer, arcs inside
// variants, relationships into the referenced asset) never met the prims they
// were about. Composing the specs first gives it a single layer to build.

type Specs = Record<string, USDSpec>;
type Selections = Record<string, string>;

/** Where a prim brought in by a reference or payload comes from. */
export interface PrimOrigin {
  layer: string;
  path: string;
}

export interface ArcSources {
  /** Every loaded layer with its sublayers merged, by layer path; nothing pruned. */
  stacks: Map<string, USDLayerData>;
  /** The layer path an asset path authored in `fromLayer` names, loaded or not; null to skip it. */
  resolve(fromLayer: string, assetPath: string): string | null;
  missing: Set<string>;
  warnings: Set<string>;
}

export interface FlatStage {
  data: USDLayerData;
  /** The prim each composed prim came from, for prims brought in by references or payloads. */
  origins: Map<string, PrimOrigin>;
  /** Reference and payload arcs composed. */
  arcs: number;
}

/** A reference or payload: an asset path and prim path, or a prim in the same layer when `asset` is null. */
interface Arc {
  asset: string | null;
  prim: string;
}

const ARC = /@([^@]*)@(?:<([^>]*)>)?|<([^>]+)>/g;

/** Remove and return the prim's references then payloads, strongest first. */
function takeArcs(fields: Record<string, unknown>): Arc[] {
  const arcs: Arc[] = [];
  for (const key of ["references", "payload"]) {
    const value = fields[key];
    if (value === undefined) continue;
    delete fields[key];
    const text = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string").join(", ");
    for (const m of text.matchAll(ARC)) {
      if (m[3] !== undefined) arcs.push({ asset: null, prim: m[3] });
      else if (m[1]) arcs.push({ asset: m[1], prim: m[2] ?? "" });
    }
  }
  return arcs;
}

/** The path one level up: a property's prim, a variant's prim, a prim's parent. */
function parentOf(key: string): string {
  const prim = primPartOf(key);
  return prim !== key ? prim : parentPathOf(key);
}

/** Specs with an index of the keys directly below each path, kept current as opinions merge in. */
class Namespace {
  readonly origins = new Map<string, PrimOrigin>();
  private readonly below = new Map<string, Set<string>>();

  constructor(readonly specs: Specs) {
    for (const key in specs) this.link(key);
  }

  private link(key: string): void {
    if (key === "/") return;
    const parent = parentOf(key);
    let keys = this.below.get(parent);
    if (!keys) this.below.set(parent, (keys = new Set()));
    keys.add(key);
  }

  /** Merge opinions weaker than every one already here. */
  merge(weak: Specs): void {
    for (const key in weak) if (!(key in this.specs)) this.link(key);
    mergeWeaker(this.specs, weak);
  }

  /** `root` and every key below it, parents first, in authoring order. */
  subtree(root: string): string[] {
    const out: string[] = [];
    const pending = [root];
    while (pending.length) {
      const key = pending.pop()!;
      if (!(key in this.specs)) continue;
      out.push(key);
      const keys = this.below.get(key);
      if (keys) pending.push(...[...keys].reverse());
    }
    return out;
  }

  remove(root: string): void {
    for (const key of this.subtree(root)) delete this.specs[key];
    this.below.get(parentOf(root))?.delete(root);
  }

  /** Keys directly below `path` that are variant set or variant specs. */
  variantKeys(path: string): string[] {
    const prefix = path === "/" ? "/{" : `${path}/{`;
    return [...(this.below.get(path) ?? [])].filter((k) => k.startsWith(prefix));
  }

  childPrims(path: string): string[] {
    return [...(this.below.get(path) ?? [])].filter((k) => this.specs[k]?.specType === SpecType.Prim);
  }
}

function defaultPrimPath(specs: Specs): string | null {
  const name = specs["/"]?.fields.defaultPrim;
  if (typeof name !== "string" || !name) return null;
  return name.startsWith("/") ? name : `/${name}`;
}

/**
 * Copy the specs of `target` and below to `dest`. Relationship targets and
 * connections inside `target` move along; USD ignores ones a reference points
 * outside its target (an internal reference keeps them).
 */
function copySubtree(
  src: Namespace,
  target: string,
  dest: string,
  options: { external: boolean; rebase?: (p: string) => string; origins?: Map<string, PrimOrigin>; layer?: string },
): Specs {
  const out: Specs = {};
  for (const key of src.subtree(target)) {
    const spec = src.specs[key];
    let fields: Record<string, unknown> = { ...spec.fields };
    for (const name of ["targetPaths", "connectionPaths"]) {
      const paths = fields[name];
      if (!Array.isArray(paths)) continue;
      fields[name] = paths.flatMap((p) => {
        if (typeof p !== "string") return [p];
        if (isUnder(p, target)) return [dest + p.slice(target.length)];
        return options.external ? [] : [p];
      });
    }
    if (options.rebase) fields = mapAssetStrings(fields, options.rebase) as Record<string, unknown>;
    const path = dest + key.slice(target.length);
    out[path] = { specType: key === target ? SpecType.Prim : spec.specType, fields };
    if (options.origins && options.layer && spec.specType === SpecType.Prim && !options.origins.has(path)) {
      options.origins.set(path, src.origins.get(key) ?? { layer: options.layer, path: key });
    }
  }
  return out;
}

class Flattener {
  arcs = 0;
  private readonly composed = new Map<string, Namespace>();

  constructor(private readonly sources: ArcSources) {}

  /** A layer stack with its arcs and variants composed, for the given variant selections. */
  layer(key: string, selections: Selections, chain: string[]): Namespace | null {
    const memoKey = `${key}\n${JSON.stringify(Object.entries(selections).sort())}`;
    const cached = this.composed.get(memoKey);
    if (cached) return cached;
    const stack = this.sources.stacks.get(key);
    if (!stack) return null;
    const ns = new Namespace(cloneSpecs(stack.specsByPath));
    for (const child of ns.childPrims("/")) this.prim(ns, child, key, selections, chain);
    this.composed.set(memoKey, ns);
    return ns;
  }

  private prim(ns: Namespace, path: string, key: string, selections: Selections, chain: string[]): void {
    // Arcs can bring variant sets, and variants arcs; settle both before the children.
    for (let pass = 0; pass < 8; pass++) {
      const arcs = this.applyVariants(ns, path, selections);
      arcs.push(...takeArcs(ns.specs[path].fields));
      if (!arcs.length) break;
      this.applyArcs(ns, path, arcs, key, selections, chain);
    }
    for (const child of ns.childPrims(path)) this.prim(ns, child, key, selections, chain);
  }

  /**
   * Merge the selected variants into the prim, weaker than its own opinions,
   * and drop its variant specs. Returns the arcs the variants author, which
   * are stronger than the prim's own references.
   */
  private applyVariants(ns: Namespace, path: string, selections: Selections): Arc[] {
    const fields = ns.specs[path].fields;
    const sets = (fields.variantSetChildren as string[] | undefined) ?? [];
    const variantKeys = ns.variantKeys(path);
    if (!sets.length && !variantKeys.length) return [];
    delete fields.variantSetChildren;
    delete fields.variantSetNames;
    const authored = fields.variantSelection as Selections | undefined;
    const weak: Specs = {};
    const arcs: Arc[] = [];
    for (const set of sets) {
      // No selection selects nothing, as in USD.
      const name = selections[set] ?? authored?.[set];
      const variantPath = `${path}/{${set}=${name}}`;
      if (!name || !(variantPath in ns.specs)) continue;
      for (const key of ns.subtree(variantPath)) {
        const spec = ns.specs[key];
        const fields = { ...spec.fields };
        if (key === variantPath) arcs.push(...takeArcs(fields));
        weak[path + key.slice(variantPath.length)] = { specType: key === variantPath ? SpecType.Prim : spec.specType, fields };
      }
    }
    for (const key of variantKeys) ns.remove(key);
    ns.merge(weak);
    return arcs;
  }

  /** Merge each arc's target in, each weaker than the opinions before it. */
  private applyArcs(ns: Namespace, path: string, arcs: Arc[], key: string, selections: Selections, chain: string[]): void {
    // Variant selections authored here reach into the referenced layers (by set name, as three does).
    const passed = { ...(ns.specs[path].fields.variantSelection as Selections | undefined), ...selections };
    for (const arc of arcs) {
      if (arc.asset === null) {
        // An internal reference to a prim around or inside this one composes nothing.
        if (ns.specs[arc.prim]?.specType !== SpecType.Prim || isUnder(path, arc.prim) || isUnder(arc.prim, path)) continue;
        ns.merge(copySubtree(ns, arc.prim, path, { external: false }));
        continue;
      }
      const dep = this.sources.resolve(key, arc.asset);
      if (!dep) continue;
      if (!this.sources.stacks.has(dep)) {
        this.sources.missing.add(dep);
        continue;
      }
      if (chain.includes(dep)) {
        this.sources.warnings.add(`순환 참조를 건너뛰었습니다: ${dep}`);
        continue;
      }
      const src = this.layer(dep, passed, [...chain, dep])!;
      const target = arc.prim || defaultPrimPath(src.specs);
      if (!target || src.specs[target]?.specType !== SpecType.Prim) {
        this.sources.warnings.add(
          arc.prim ? `참조 대상 프림을 찾을 수 없습니다: ${arc.asset}<${arc.prim}>` : `참조한 레이어에 기본 프림(defaultPrim)이 없습니다: ${arc.asset}`,
        );
        continue;
      }
      const from = dirname(dep);
      const to = dirname(key);
      const rebase = from === to ? undefined : (p: string) => (isUrl(p) || p.startsWith("/") ? p : relativePath(to, joinPath(from, p)));
      ns.merge(copySubtree(src, target, path, { external: true, rebase, origins: ns.origins, layer: dep }));
      this.arcs++;
    }
  }
}

/**
 * Compose the root layer's references, payloads and variant selections into
 * a single layer, then drop the prims USD would not draw (never defined, or
 * inactive). Referenced layers are composed once per variant selection and
 * copied per reference, so assets that reference one shared layer from every
 * part stay linear.
 */
export function flattenStage(rootPath: string, sources: ArcSources): FlatStage {
  const flattener = new Flattener(sources);
  const ns = flattener.layer(rootPath, {}, [rootPath]);
  if (!ns) throw new Error(`레이어를 찾을 수 없습니다: ${rootPath}`);
  pruneUndefinedPrims(ns.specs);
  return { data: { specsByPath: ns.specs }, origins: ns.origins, arcs: flattener.arcs };
}
