import {
  SpecType,
  UnsupportedUsdError,
  childPrimPath,
  componentType,
  propertyPath,
  tupleSize,
  variantPath,
  type Dictionary,
  type LayerOffset,
  type ListOp,
  type Payload,
  type Reference,
  type SdfLayer,
  type SdfSpec,
  type SdfValue,
  type TimeSamples,
} from "./data";
import { IDENTIFIER, assetLiteral, formatDouble, formatFloat, formatHalf, quote } from "./format";

/** Fields that shape the file rather than appear as metadata. */
const STRUCTURAL = new Set([
  "specifier",
  "typeName",
  "primChildren",
  "properties",
  "variantSetChildren",
  "variantChildren",
  "targetChildren",
  "connectionChildren",
  "default",
  "timeSamples",
  "variability",
  "custom",
  "targetPaths",
  "connectionPaths",
  "subLayers",
  "subLayerOffsets",
  "primOrder",
  "propertyOrder",
]);

/** Metadata whose USDA keyword differs from the field name. */
export const KEYWORDS: Record<string, string> = {
  documentation: "doc",
  variantSelection: "variants",
  variantSetNames: "variantSets",
  inheritPaths: "inherits",
};

const INDENT = "    ";

/** Write a layer as USDA text. */
export function writeUsda(layer: SdfLayer): string {
  return new UsdaWriter(layer).write();
}

class UsdaWriter {
  private out: string[] = [];

  constructor(private readonly layer: SdfLayer) {}

  write(): string {
    for (const [path, spec] of this.layer.specs) {
      if ((spec.type === SpecType.Connection || spec.type === SpecType.RelationshipTarget) && spec.fields.size) {
        throw new UnsupportedUsdError(`${path}: 관계 대상에 붙은 속성(relational attribute)은 지원하지 않습니다.`);
      }
      if (spec.type === SpecType.Expression || spec.type === SpecType.Mapper || spec.type === SpecType.MapperArg) {
        throw new UnsupportedUsdError(`${path}: 지원하지 않는 스펙 종류입니다.`);
      }
    }
    this.out.push("#usda 1.0");
    const root = this.layer.root;
    const meta = this.layerMetadata(root);
    if (meta.length) {
      this.out.push("(");
      for (const line of meta) this.out.push(INDENT + line);
      this.out.push(")");
    }
    for (const name of this.children(root, "/")) {
      this.out.push("");
      this.writePrim(childPrimPath("/", name), "");
    }
    const reorder = root.fields.get("primOrder");
    if (reorder) this.out.push("", `reorder rootPrims = ${this.tokenList(reorder.value as string[])}`);
    this.out.push("");
    return this.out.join("\n");
  }

  // ------------------------------------------------------------ structure

  private children(spec: SdfSpec, path: string): string[] {
    const listed = spec.fields.get("primChildren")?.value as string[] | undefined;
    if (listed) return listed;
    return [...this.layer.specs.keys()].filter((p) => p !== path && isDirectChild(path, p)).map((p) => p.slice(path === "/" ? 1 : path.length + 1));
  }

  private layerMetadata(root: SdfSpec): string[] {
    const lines: string[] = [];
    const comment = root.fields.get("comment");
    if (comment) lines.push(quote(comment.value as string));
    const doc = root.fields.get("documentation");
    if (doc) lines.push(`doc = ${quote(doc.value as string)}`);
    for (const [name, value] of root.fields) {
      if (STRUCTURAL.has(name) || name === "documentation" || name === "comment") continue;
      if (name === "relocates") lines.push(...this.block("relocates = ", this.relocates(value.value as [string, string][])));
      else lines.push(...this.metadataLines(name, value));
    }
    const subLayers = root.fields.get("subLayers")?.value as string[] | undefined;
    if (subLayers) {
      const offsets = (root.fields.get("subLayerOffsets")?.value as LayerOffset[] | undefined) ?? [];
      const items = subLayers.map((s, i) => `${assetLiteral(s)}${this.layerOffset(offsets[i])}`);
      lines.push(...this.block("subLayers = ", this.bracketed(items)));
    }
    return lines;
  }

  private writePrim(path: string, indent: string): void {
    const spec = this.layer.specs.get(path);
    if (!spec) return;
    const specifier = (spec.fields.get("specifier")?.value as string | undefined) ?? "over";
    const typeName = spec.fields.get("typeName")?.value as string | undefined;
    const name = path.slice(path.lastIndexOf(path.endsWith("}") ? "{" : "/") + 1).replace(/^.*}/, "");
    const header = `${specifier}${typeName ? ` ${typeName}` : ""} ${quote(name)}`;
    this.writeHeaderAndBody(header, spec, path, indent);
  }

  /** `header (metadata) { body }` for prims and variants. */
  private writeHeaderAndBody(header: string, spec: SdfSpec, path: string, indent: string): void {
    const meta = this.primMetadata(spec);
    if (meta.length) {
      this.out.push(`${indent}${header} (`);
      for (const line of meta) this.out.push(indent + INDENT + line);
      this.out.push(`${indent})`);
    } else {
      this.out.push(indent + header);
    }
    this.out.push(`${indent}{`);
    this.writeBody(spec, path, indent + INDENT);
    this.out.push(`${indent}}`);
  }

  private primMetadata(spec: SdfSpec): string[] {
    const lines: string[] = [];
    const comment = spec.fields.get("comment");
    if (comment) lines.push(quote(comment.value as string));
    const doc = spec.fields.get("documentation");
    if (doc) lines.push(`doc = ${quote(doc.value as string)}`);
    for (const [name, value] of spec.fields) {
      if (STRUCTURAL.has(name) || name === "documentation" || name === "comment") continue;
      lines.push(...this.metadataLines(name, value));
    }
    return lines;
  }

  private writeBody(spec: SdfSpec, path: string, indent: string): void {
    let first = true;
    const gap = () => {
      if (!first) this.out.push("");
      first = false;
    };
    const properties = (spec.fields.get("properties")?.value as string[] | undefined) ?? this.propertyNames(path);
    for (const name of properties) {
      const prop = this.layer.specs.get(propertyPath(path, name));
      if (!prop) continue;
      gap();
      this.writeProperty(prop, name, indent);
    }
    const propertyOrder = spec.fields.get("propertyOrder");
    if (propertyOrder) {
      gap();
      this.out.push(`${indent}reorder properties = ${this.tokenList(propertyOrder.value as string[])}`);
    }
    for (const name of this.children(spec, path)) {
      gap();
      this.writePrim(childPrimPath(path, name), indent);
    }
    const primOrder = spec.fields.get("primOrder");
    if (primOrder) {
      gap();
      this.out.push(`${indent}reorder nameChildren = ${this.tokenList(primOrder.value as string[])}`);
    }
    const sets = (spec.fields.get("variantSetChildren")?.value as string[] | undefined) ?? [];
    for (const set of sets) {
      gap();
      this.writeVariantSet(path, set, indent);
    }
  }

  private propertyNames(path: string): string[] {
    const prefix = `${path}.`;
    return [...this.layer.specs.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("[")).map((p) => p.slice(prefix.length));
  }

  private writeVariantSet(path: string, set: string, indent: string): void {
    const setSpec = this.layer.specs.get(variantPath(path, set, ""));
    const variants = (setSpec?.fields.get("variantChildren")?.value as string[] | undefined) ?? [];
    this.out.push(`${indent}variantSet ${quote(set)} = {`);
    for (const variant of variants) {
      const vPath = variantPath(path, set, variant);
      const vSpec = this.layer.specs.get(vPath);
      if (!vSpec) continue;
      this.writeHeaderAndBody(quote(variant), vSpec, vPath, indent + INDENT);
    }
    this.out.push(`${indent}}`);
  }

  // ------------------------------------------------------------ properties

  private writeProperty(spec: SdfSpec, name: string, indent: string): void {
    const custom = spec.fields.get("custom")?.value === true ? "custom " : "";
    const meta: string[] = [];
    const comment = spec.fields.get("comment");
    if (comment) meta.push(quote(comment.value as string));
    const doc = spec.fields.get("documentation");
    if (doc) meta.push(`doc = ${quote(doc.value as string)}`);
    for (const [field, value] of spec.fields) {
      if (STRUCTURAL.has(field) || field === "documentation" || field === "comment") continue;
      meta.push(...this.metadataLines(field, value));
    }
    const metaText = (line: string) => {
      if (!meta.length) {
        this.out.push(indent + line);
        return;
      }
      this.out.push(`${indent}${line} (`);
      for (const m of meta) this.out.push(indent + INDENT + m);
      this.out.push(`${indent})`);
    };

    if (spec.type === SpecType.Relationship) {
      const varying = spec.fields.get("variability")?.value === "varying" ? "varying " : "";
      const decl = `${custom}${varying}rel ${name}`;
      const targets = spec.fields.get("targetPaths")?.value as ListOp<string> | undefined;
      if (targets) {
        const edits = this.listOpLines(targets, (p) => `<${p}>`);
        const explicit = edits.find((e) => !e.op);
        // The declaration carries the metadata, together with explicit targets if any.
        metaText(explicit ? `${decl} = ${explicit.text}` : decl);
        for (const e of edits) if (e.op) this.out.push(`${indent}${e.op} ${decl} = ${e.text}`);
      } else {
        metaText(decl);
      }
      return;
    }

    const typeName = (spec.fields.get("typeName")?.value as string | undefined) ?? "";
    const uniform = spec.fields.get("variability")?.value === "uniform" ? "uniform " : "";
    const decl = `${custom}${uniform}${typeName} ${name}`;
    const def = spec.fields.get("default");
    metaText(def ? `${decl} = ${this.value(def)}` : decl);
    const samples = spec.fields.get("timeSamples");
    if (samples) {
      const entries = (samples.value as TimeSamples).map(([t, v]) => `${formatDouble(t)}: ${this.value(v)},`);
      this.out.push(`${indent}${decl}.timeSamples = {`);
      for (const e of entries) this.out.push(indent + INDENT + e);
      this.out.push(`${indent}}`);
    }
    const connections = spec.fields.get("connectionPaths")?.value as ListOp<string> | undefined;
    if (connections) {
      for (const e of this.listOpLines(connections, (p) => `<${p}>`)) {
        this.out.push(`${indent}${e.op ? `${e.op} ` : ""}${decl}.connect = ${e.text}`);
      }
    }
  }

  // ------------------------------------------------------------ metadata

  private metadataLines(name: string, value: SdfValue): string[] {
    const keyword = KEYWORDS[name] ?? name;
    switch (value.type) {
      case "tokenListOp":
      case "stringListOp":
        return this.listOpLines(value.value as ListOp<string>, quote, value.type === "tokenListOp").map((e) => `${e.op ? `${e.op} ` : ""}${keyword} = ${e.text}`);
      case "pathListOp":
        return this.listOpLines(value.value as ListOp<string>, (p) => `<${p}>`).map((e) => `${e.op ? `${e.op} ` : ""}${keyword} = ${e.text}`);
      case "referenceListOp":
        return this.listOpLines(value.value as ListOp<Reference>, (r) => this.reference(r)).map((e) => `${e.op ? `${e.op} ` : ""}${keyword} = ${e.text}`);
      case "payloadListOp":
        return this.listOpLines(value.value as ListOp<Payload>, (p) => this.payload(p)).map((e) => `${e.op ? `${e.op} ` : ""}${keyword} = ${e.text}`);
      case "intListOp":
      case "int64ListOp":
      case "uintListOp":
      case "uint64ListOp":
        return this.listOpLines(value.value as ListOp<number | bigint>, String).map((e) => `${e.op ? `${e.op} ` : ""}${keyword} = ${e.text}`);
      case "payload":
        return [`${keyword} = ${this.payload(value.value as Payload)}`];
      case "variantSelectionMap": {
        const entries = [...(value.value as Map<string, string>)].map(([k, v]) => `string ${this.key(k)} = ${quote(v)}`);
        return this.block(`${keyword} = `, this.braced(entries));
      }
      case "dictionary":
        return this.block(`${keyword} = `, this.dictionary(value.value as Dictionary));
      case "specifier":
      case "permission":
      case "variability":
        return [`${keyword} = ${value.value as string}`];
      case "bool":
        return [`${keyword} = ${value.value ? "true" : "false"}`];
      case "tokenVector":
      case "stringVector":
        return [`${keyword} = ${this.tokenList(value.value as string[])}`];
      case "relocates":
        return this.block(`${keyword} = `, this.relocates(value.value as [string, string][]));
      case "unregisteredValue":
      case "value":
        return this.metadataLines(name, value.value as SdfValue);
      default:
        return this.block(`${keyword} = `, [this.value(value)]);
    }
  }

  /** Lines for `prefix<first line>` followed by the rest of a multi-line value. */
  private block(prefix: string, lines: string[]): string[] {
    return lines.map((l, i) => (i === 0 ? prefix + l : l));
  }

  private braced(entries: string[]): string[] {
    if (!entries.length) return ["{", "}"];
    return ["{", ...entries.map((e) => INDENT + e), "}"];
  }

  private bracketed(items: string[]): string[] {
    if (!items.length) return ["[]"];
    return ["[", ...items.map((it, i) => `${INDENT}${it}${i < items.length - 1 ? "," : ""}`), "]"];
  }

  private dictionary(dict: Dictionary): string[] {
    const entries: string[] = [];
    for (const [key, value] of dict) {
      if (value.type === "dictionary") {
        const nested = this.dictionary(value.value as Dictionary);
        entries.push(`dictionary ${this.key(key)} = ${nested[0]}`, ...nested.slice(1));
      } else {
        const inner = value.type === "value" || value.type === "unregisteredValue" ? (value.value as SdfValue) : value;
        entries.push(`${dictionaryTypeName(inner)} ${this.key(key)} = ${this.value(inner)}`);
      }
    }
    return this.braced(entries.flatMap((e) => e.split("\n")));
  }

  /** A dictionary on one line, entries separated by semicolons. */
  private inlineDictionary(dict: Dictionary): string {
    const entries = [...dict].map(([key, value]) =>
      value.type === "dictionary"
        ? `dictionary ${this.key(key)} = ${this.inlineDictionary(value.value as Dictionary)}`
        : `${dictionaryTypeName(value)} ${this.key(key)} = ${this.value(value)}`,
    );
    return `{ ${entries.join("; ")} }`;
  }

  private key(k: string): string {
    return IDENTIFIER.test(k) && !k.includes(":") ? k : quote(k);
  }

  private relocates(pairs: [string, string][]): string[] {
    return this.braced(pairs.map(([a, b], i) => `<${a}>: <${b}>${i < pairs.length - 1 ? "," : ""}`));
  }

  private tokenList(items: string[]): string {
    return `[${items.map(quote).join(", ")}]`;
  }

  /**
   * One line per list op edit. Like OpenUSD, a single item is written bare
   * (simpler parsers expect `rel x = </a>`), except where the grammar wants
   * brackets (token lists such as apiSchemas).
   */
  private listOpLines<T>(op: ListOp<T>, item: (v: T) => string, bracketed = false): { op: string; text: string }[] {
    const list = (items: T[]) => (items.length === 1 && !bracketed ? item(items[0]) : `[${items.map(item).join(", ")}]`);
    if (op.explicit) return [{ op: "", text: op.explicitItems.length ? list(op.explicitItems) : "None" }];
    const lines: { op: string; text: string }[] = [];
    if (op.deletedItems.length) lines.push({ op: "delete", text: list(op.deletedItems) });
    if (op.addedItems.length) lines.push({ op: "add", text: list(op.addedItems) });
    if (op.prependedItems.length) lines.push({ op: "prepend", text: list(op.prependedItems) });
    if (op.appendedItems.length) lines.push({ op: "append", text: list(op.appendedItems) });
    if (op.orderedItems.length) lines.push({ op: "reorder", text: list(op.orderedItems) });
    return lines;
  }

  private layerOffset(o: LayerOffset | undefined): string {
    if (!o || (o.offset === 0 && o.scale === 1)) return "";
    const parts: string[] = [];
    if (o.offset !== 0) parts.push(`offset = ${formatDouble(o.offset)}`);
    if (o.scale !== 1) parts.push(`scale = ${formatDouble(o.scale)}`);
    return ` (${parts.join("; ")})`;
  }

  private reference(r: Reference): string {
    let text = `${r.assetPath ? assetLiteral(r.assetPath) : ""}${r.primPath ? `<${r.primPath}>` : ""}`;
    const parts: string[] = [];
    if (r.layerOffset.offset !== 0) parts.push(`offset = ${formatDouble(r.layerOffset.offset)}`);
    if (r.layerOffset.scale !== 1) parts.push(`scale = ${formatDouble(r.layerOffset.scale)}`);
    if (r.customData.size) parts.push(`customData = ${this.inlineDictionary(r.customData)}`);
    if (parts.length) text += ` (${parts.join("; ")})`;
    return text;
  }

  private payload(p: Payload): string {
    return `${p.assetPath ? assetLiteral(p.assetPath) : ""}${p.primPath ? `<${p.primPath}>` : ""}${this.layerOffset(p.layerOffset)}`;
  }

  // ------------------------------------------------------------ values

  value(v: SdfValue): string {
    const type = v.type;
    switch (type) {
      case "valueBlock":
        return "None";
      case "value":
      case "unregisteredValue":
        return this.value(v.value as SdfValue);
      case "dictionary":
        return this.dictionary(v.value as Dictionary).join("\n");
      case "string":
      case "token":
      case "pathExpression":
        return quote(v.value as string);
      case "asset":
        return assetLiteral(v.value as string);
      case "tokenVector":
      case "stringVector":
        return this.tokenList(v.value as string[]);
      case "pathVector":
        return `[${(v.value as string[]).map((p) => `<${p}>`).join(", ")}]`;
      case "doubleVector":
        return `[${(v.value as number[]).map(formatDouble).join(", ")}]`;
      case "specifier":
      case "permission":
      case "variability":
        return v.value as string;
    }
    if (type.endsWith("[]")) {
      const base = type.slice(0, -2);
      if (base === "string" || base === "token" || base === "pathExpression") return `[${(v.value as string[]).map(quote).join(", ")}]`;
      if (base === "asset") return `[${(v.value as string[]).map(assetLiteral).join(", ")}]`;
      const values = v.value as ArrayLike<number | bigint>;
      const n = tupleSize(base);
      const parts: string[] = [];
      for (let i = 0; i < values.length; i += n) parts.push(this.tuple(base, values, i));
      return `[${parts.join(", ")}]`;
    }
    if (typeof v.value === "number" || typeof v.value === "bigint" || typeof v.value === "boolean") {
      return this.component(componentType(type), v.value);
    }
    if (Array.isArray(v.value)) return this.tuple(type, v.value as number[], 0);
    throw new UnsupportedUsdError(`USDA로 쓸 수 없는 값 형식입니다: ${type}`);
  }

  private component(kind: string, x: number | bigint | boolean): string {
    switch (kind) {
      case "bool":
        return x ? "1" : "0";
      case "float":
        return formatFloat(Number(x));
      case "double":
      case "timecode":
        return formatDouble(Number(x));
      case "half":
        return formatHalf(Number(x));
      default:
        return String(x);
    }
  }

  private tuple(type: string, values: ArrayLike<number | bigint>, offset: number): string {
    const kind = componentType(type);
    const n = tupleSize(type);
    if (n === 1) return this.component(kind, values[offset]);
    const c = (i: number) => this.component(kind, values[offset + i]);
    if (type.startsWith("matrix")) {
      const dim = Math.sqrt(n);
      const rows: string[] = [];
      for (let r = 0; r < dim; r++) rows.push(`(${Array.from({ length: dim }, (_, k) => c(r * dim + k)).join(", ")})`);
      return `( ${rows.join(", ")} )`;
    }
    // Quaternions are (real, i, j, k) in text, (i, j, k, real) in memory.
    if (type.startsWith("quat")) return `(${c(3)}, ${c(0)}, ${c(1)}, ${c(2)})`;
    return `(${Array.from({ length: n }, (_, i) => c(i)).join(", ")})`;
  }
}

function isDirectChild(parent: string, path: string): boolean {
  if (path.includes(".") || path.endsWith("}")) return false;
  const rest = parent === "/" ? path.slice(1) : path.startsWith(`${parent}/`) ? path.slice(parent.length + 1) : null;
  return !!rest && !rest.includes("/") && !rest.includes("{");
}

/** Type name for a dictionary entry: the value's own Sdf type name. */
function dictionaryTypeName(v: SdfValue): string {
  switch (v.type) {
    case "tokenVector":
      return "token[]";
    case "stringVector":
      return "string[]";
    case "doubleVector":
      return "double[]";
    case "pathVector":
      return "string[]";
    default:
      return v.type;
  }
}
