import { floatToHalf } from "./crateReader";
import {
  SdfLayer,
  SpecType,
  UnsupportedUsdError,
  childPrimPath,
  componentType,
  emptyListOp,
  propertyPath,
  tupleSize,
  variantPath,
  type Dictionary,
  type LayerOffset,
  type ListOp,
  type Payload,
  type Reference,
  type SdfSpec,
  type SdfValue,
  type TimeSamples,
} from "./data";

// ---------------------------------------------------------------- lexer

type TokenKind = "ident" | "number" | "string" | "asset" | "path" | "punct" | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
}

const PUNCT = new Set(["(", ")", "{", "}", "[", "]", "=", ",", ";", ":", "."]);

function unescape(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\" || i === body.length - 1) {
      out += c;
      continue;
    }
    const n = body[++i];
    switch (n) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "x": {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1))?.[0] ?? "";
        out += String.fromCharCode(parseInt(hex || "0", 16));
        i += hex.length;
        break;
      }
      default:
        if (n >= "0" && n <= "7") {
          const oct = /^[0-7]{1,3}/.exec(body.slice(i))![0];
          out += String.fromCharCode(parseInt(oct, 8));
          i += oct.length - 1;
        } else out += n;
    }
  }
  // Escapes produce bytes; the text is UTF-8.
  return /[\x80-\xff]/.test(out) && !/[^\x00-\xff]/.test(out) ? decodeLatin1Utf8(out) : out;
}

function decodeLatin1Utf8(s: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  const push = (kind: TokenKind, value: string) => tokens.push({ kind, text: value, line });
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      line += text.slice(i, stop).split("\n").length - 1;
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < n && !text.startsWith(quote, j)) j += text[j] === "\\" ? 2 : 1;
      const body = text.slice(i + quote.length, j);
      push("string", unescape(body));
      line += body.split("\n").length - 1;
      i = j + quote.length;
      continue;
    }
    if (c === "@") {
      if (text.startsWith("@@@", i)) {
        let j = i + 3;
        while (j < n && !(text.startsWith("@@@", j) && text[j - 1] !== "\\")) j++;
        push("asset", text.slice(i + 3, j).replace(/\\@@@/g, "@@@"));
        i = j + 3;
      } else {
        const j = text.indexOf("@", i + 1);
        push("asset", text.slice(i + 1, j));
        i = j + 1;
      }
      continue;
    }
    if (c === "<") {
      const j = text.indexOf(">", i + 1);
      push("path", text.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(i, i + 64));
    if (num && (c !== "+" && c !== "-" ? true : /[\d.]/.test(text[i + 1]))) {
      push("number", num[0]);
      i += num[0].length;
      continue;
    }
    const ident = /^[-+]?[A-Za-z_][A-Za-z0-9_]*(?:::?[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i, i + 512));
    if (ident) {
      push("ident", ident[0]);
      i += ident[0].length;
      continue;
    }
    if (PUNCT.has(c)) {
      push("punct", c);
      i++;
      continue;
    }
    throw new Error(`USDA ${line}행: 알 수 없는 문자 '${c}'`);
  }
  tokens.push({ kind: "eof", text: "", line });
  return tokens;
}

// ---------------------------------------------------------------- value syntax

type Node =
  | { k: "number"; text: string }
  | { k: "string"; value: string }
  | { k: "ident"; name: string }
  | { k: "asset"; path: string }
  | { k: "path"; path: string }
  | { k: "tuple"; items: Node[] }
  | { k: "list"; items: Node[] };

/** Value types of registered metadata fields, as OpenUSD's schemas declare them. */
const FIELD_TYPES: Record<string, string> = {
  // layer
  defaultPrim: "token",
  upAxis: "token",
  metersPerUnit: "double",
  kilogramsPerUnit: "double",
  startTimeCode: "double",
  endTimeCode: "double",
  timeCodesPerSecond: "double",
  framesPerSecond: "double",
  framePrecision: "int",
  customLayerData: "dictionary",
  owner: "string",
  sessionOwner: "string",
  hasOwnedSubLayers: "bool",
  colorConfiguration: "asset",
  colorManagementSystem: "token",
  expressionVariables: "dictionary",
  renderSettingsPrimPath: "string",
  // prims and properties
  documentation: "string",
  comment: "string",
  kind: "token",
  active: "bool",
  hidden: "bool",
  instanceable: "bool",
  customData: "dictionary",
  assetInfo: "dictionary",
  displayName: "string",
  displayGroup: "string",
  displayGroupOrder: "string[]",
  permission: "permission",
  prefix: "string",
  suffix: "string",
  prefixSubstitutions: "dictionary",
  suffixSubstitutions: "dictionary",
  symmetricPeer: "string",
  symmetryArguments: "dictionary",
  symmetryFunction: "token",
  clips: "dictionary",
  sdrMetadata: "dictionary",
  apiSchemas: "tokenListOp",
  references: "referenceListOp",
  payload: "payloadListOp",
  inheritPaths: "pathListOp",
  specializes: "pathListOp",
  variantSetNames: "stringListOp",
  clipSets: "stringListOp",
  // attributes and relationships
  interpolation: "token",
  elementSize: "int",
  colorSpace: "token",
  allowedTokens: "token[]",
  displayUnit: "token",
  connectability: "token",
  renderType: "token",
  outputName: "token",
  bindMaterialAs: "token",
  unauthoredValuesIndex: "int",
  limits: "dictionary",
  arraySizeConstraint: "int64",
  noLoadHint: "bool",
};

/** USDA keyword -> field name, where they differ. */
const FIELD_NAMES: Record<string, string> = { doc: "documentation", inherits: "inheritPaths", variantSets: "variantSetNames", variants: "variantSelection" };

const ROLE = /^(point|normal|vector|color|texCoord)([234])([dfh])$/;
const PRECISION: Record<string, string> = { d: "double", f: "float", h: "half" };

/** The value type an attribute type name stores ("color3f[]" -> "float3[]"). */
export function valueTypeOf(typeName: string): string {
  const array = typeName.endsWith("[]");
  const base = array ? typeName.slice(0, -2) : typeName;
  const role = ROLE.exec(base);
  let value = role ? `${PRECISION[role[3]]}${role[2]}` : base;
  if (base === "frame4d") value = "matrix4d";
  return array ? `${value}[]` : value;
}

const LIST_OPS = new Set(["add", "append", "delete", "prepend", "reorder"]);
const SPECIFIERS = new Set(["def", "over", "class"]);

/** Read USDA text into a lossless SdfLayer. */
export function readUsda(text: string): SdfLayer {
  return new UsdaReader(text).read();
}

class UsdaReader {
  private readonly tokens: Token[];
  private pos = 0;
  private readonly layer = new SdfLayer();

  constructor(text: string) {
    const header = /^#usda\s+\d+(\.\d+)*/.exec(text);
    if (!header) throw new Error("usda 헤더(#usda 1.0)가 없습니다.");
    this.tokens = lex(text.slice(header[0].length));
  }

  // ------------------------------------------------------------ token helpers

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private is(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return (t.kind === "punct" || t.kind === "ident") && t.text === text;
  }
  private accept(text: string): boolean {
    if (!this.is(text)) return false;
    this.pos++;
    return true;
  }
  private expect(text: string): void {
    if (!this.accept(text)) this.fail(`'${text}'가 와야 합니다`);
  }
  private fail(message: string): never {
    const t = this.peek();
    throw new Error(`USDA ${t.line}행 (${t.text || t.kind}): ${message}`);
  }
  private ident(): string {
    const t = this.next();
    if (t.kind !== "ident") this.fail("이름이 와야 합니다");
    return t.text;
  }
  private string(): string {
    const t = this.next();
    if (t.kind !== "string") this.fail("문자열이 와야 합니다");
    return t.text;
  }
  private separators(): void {
    while (this.accept(";")) {
      /* empty */
    }
  }

  // ------------------------------------------------------------ layer

  read(): SdfLayer {
    const root = this.layer.root;
    if (this.is("(")) this.metadataBlock(root, "layer");
    const children: string[] = [];
    while (this.peek().kind !== "eof") {
      if (this.accept("reorder")) {
        if (this.ident() !== "rootPrims") this.fail("reorder rootPrims가 와야 합니다");
        this.expect("=");
        root.fields.set("primOrder", { type: "tokenVector", value: this.stringList() });
        continue;
      }
      children.push(this.prim("/"));
    }
    if (children.length) root.fields.set("primChildren", { type: "tokenVector", value: children });
    return this.layer;
  }

  private spec(path: string, type: SpecType): SdfSpec {
    let spec = this.layer.specs.get(path);
    if (!spec) {
      spec = { type, fields: new Map() };
      this.layer.specs.set(path, spec);
    }
    return spec;
  }

  // ------------------------------------------------------------ metadata

  private metadataBlock(spec: SdfSpec, kind: "layer" | "prim" | "property" | "attribute"): void {
    this.expect("(");
    while (!this.accept(")")) {
      this.separators();
      if (this.accept(")")) break;
      const t = this.peek();
      if (t.kind === "string") {
        this.next();
        spec.fields.set("comment", { type: "string", value: t.text });
        continue;
      }
      let op = "";
      if (t.kind === "ident" && LIST_OPS.has(t.text) && this.peek(1).kind === "ident" && this.is("=", 2)) op = this.ident();
      const keyword = this.ident();
      this.expect("=");
      if (kind === "layer" && keyword === "subLayers") {
        this.subLayers(spec);
        continue;
      }
      if (keyword === "relocates") {
        spec.fields.set("relocates", { type: "relocates", value: this.relocates() });
        continue;
      }
      if (keyword === "variants") {
        spec.fields.set("variantSelection", { type: "variantSelectionMap", value: this.variantSelection() });
        continue;
      }
      const field = FIELD_NAMES[keyword] ?? keyword;
      const type = FIELD_TYPES[field];
      if (type?.endsWith("ListOp") || op) {
        this.listOpField(spec, field, type ?? "tokenListOp", op);
        continue;
      }
      spec.fields.set(field, this.metadataValue(field, type));
    }
  }

  private metadataValue(field: string, type: string | undefined): SdfValue {
    if (type === "dictionary") return { type, value: this.dictionary() };
    if (type === "permission") return { type, value: this.ident() };
    if (type) return this.typedValue(type, this.node());
    // Unregistered metadata: infer the type from the syntax.
    if (this.is("{")) return { type: "dictionary", value: this.dictionary() };
    const node = this.node();
    switch (node.k) {
      case "string":
        return { type: "string", value: node.value };
      case "asset":
        return { type: "asset", value: node.path };
      case "number":
        return /[.eE]/.test(node.text) ? { type: "double", value: Number(node.text) } : { type: "int", value: Number(node.text) };
      case "ident":
        if (node.name === "true" || node.name === "false") return { type: "bool", value: node.name === "true" };
        return { type: "token", value: node.name };
      default:
        throw new UnsupportedUsdError(`등록되지 않은 메타데이터 '${field}'의 값 형식을 알 수 없습니다.`);
    }
  }

  private subLayers(spec: SdfSpec): void {
    const paths: string[] = [];
    const offsets: LayerOffset[] = [];
    this.expect("[");
    while (!this.accept("]")) {
      const t = this.next();
      if (t.kind !== "asset") this.fail("서브레이어 에셋 경로가 와야 합니다");
      paths.push(t.text);
      offsets.push(this.is("(") ? this.layerOffsetBlock().layerOffset : { offset: 0, scale: 1 });
      this.accept(",");
    }
    spec.fields.set("subLayers", { type: "stringVector", value: paths });
    spec.fields.set("subLayerOffsets", { type: "layerOffsetVector", value: offsets });
  }

  /** `(offset = 1; scale = 2; customData = {...})` after a reference, payload or sublayer. */
  private layerOffsetBlock(): { layerOffset: LayerOffset; customData: Dictionary } {
    const result = { layerOffset: { offset: 0, scale: 1 }, customData: new Map() as Dictionary };
    this.expect("(");
    while (!this.accept(")")) {
      this.separators();
      if (this.accept(")")) break;
      const key = this.ident();
      this.expect("=");
      if (key === "offset") result.layerOffset.offset = this.number();
      else if (key === "scale") result.layerOffset.scale = this.number();
      else if (key === "customData") result.customData = this.dictionary();
      else this.fail(`알 수 없는 항목 '${key}'`);
    }
    return result;
  }

  private number(): number {
    const node = this.node();
    return scalarNumber(node);
  }

  private listOpField(spec: SdfSpec, field: string, type: string, op: string): void {
    const item = this.listItemReader(type);
    const items = this.accept("None") ? null : this.is("[") ? this.listOf(item) : [item()];
    const existing = spec.fields.get(field);
    const listOp = (existing?.type === type ? existing.value : emptyListOp()) as ListOp<unknown>;
    applyListOp(listOp, op, items);
    spec.fields.set(field, { type, value: listOp });
  }

  private listOf<T>(item: () => T): T[] {
    const out: T[] = [];
    this.expect("[");
    while (!this.accept("]")) {
      out.push(item());
      this.accept(",");
    }
    return out;
  }

  private listItemReader(type: string): () => unknown {
    switch (type) {
      case "tokenListOp":
      case "stringListOp":
        return () => this.string();
      case "pathListOp":
        return () => this.pathToken();
      case "referenceListOp":
        return () => this.reference();
      case "payloadListOp":
        return () => this.payloadItem();
      case "intListOp":
      case "uintListOp":
        return () => this.number();
      case "int64ListOp":
      case "uint64ListOp":
        return () => BigInt((this.next() as Token).text);
      default:
        return () => this.string();
    }
  }

  private pathToken(): string {
    const t = this.next();
    if (t.kind !== "path") this.fail("경로(<...>)가 와야 합니다");
    return t.text;
  }

  private reference(): Reference {
    let assetPath = "";
    let primPath = "";
    if (this.peek().kind === "asset") assetPath = this.next().text;
    if (this.peek().kind === "path") primPath = this.next().text;
    const extra = this.is("(") ? this.layerOffsetBlock() : { layerOffset: { offset: 0, scale: 1 }, customData: new Map() as Dictionary };
    return { assetPath, primPath, layerOffset: extra.layerOffset, customData: extra.customData };
  }

  private payloadItem(): Payload {
    const r = this.reference();
    return { assetPath: r.assetPath, primPath: r.primPath, layerOffset: r.layerOffset };
  }

  private relocates(): [string, string][] {
    const pairs: [string, string][] = [];
    this.expect("{");
    while (!this.accept("}")) {
      const from = this.pathToken();
      this.expect(":");
      const to = this.pathToken();
      pairs.push([from, to]);
      this.accept(",");
    }
    return pairs;
  }

  private variantSelection(): Map<string, string> {
    const map = new Map<string, string>();
    this.expect("{");
    while (!this.accept("}")) {
      this.separators();
      if (this.accept("}")) break;
      this.ident(); // "string"
      const key = this.peek().kind === "string" ? this.string() : this.ident();
      this.expect("=");
      map.set(key, this.string());
    }
    return map;
  }

  private dictionary(): Dictionary {
    const dict: Dictionary = new Map();
    this.expect("{");
    while (!this.accept("}")) {
      this.separators();
      if (this.accept("}")) break;
      let type = this.ident();
      if (this.accept("[")) {
        this.expect("]");
        type += "[]";
      }
      const key = this.peek().kind === "string" ? this.string() : this.ident();
      this.expect("=");
      if (type === "dictionary") dict.set(key, { type, value: this.dictionary() });
      else dict.set(key, this.typedValue(valueTypeOf(type), this.node()));
    }
    return dict;
  }

  private stringList(): string[] {
    return this.listOf(() => this.string());
  }

  // ------------------------------------------------------------ generic values

  private node(): Node {
    const t = this.next();
    switch (t.kind) {
      case "number":
        return { k: "number", text: t.text };
      case "string":
        return { k: "string", value: t.text };
      case "ident":
        return { k: "ident", name: t.text };
      case "asset":
        return { k: "asset", path: t.text };
      case "path":
        return { k: "path", path: t.text };
      case "punct":
        if (t.text === "(" || t.text === "[") {
          const close = t.text === "(" ? ")" : "]";
          const items: Node[] = [];
          while (!this.accept(close)) {
            items.push(this.node());
            this.accept(",");
          }
          return t.text === "(" ? { k: "tuple", items } : { k: "list", items };
        }
    }
    this.pos--;
    this.fail("값이 와야 합니다");
  }

  private typedValue(type: string, node: Node): SdfValue {
    if (node.k === "ident" && node.name === "None") return { type: "valueBlock", value: null };
    if (type.endsWith("[]")) {
      if (node.k !== "list") this.fail(`${type} 배열 값이 와야 합니다`);
      return { type, value: arrayValue(type.slice(0, -2), node.items) };
    }
    return { type, value: scalarValue(type, node) };
  }

  // ------------------------------------------------------------ prims

  /** A prim statement under `parent`; returns the prim's name. */
  private prim(parent: string): string {
    const specifier = this.ident();
    if (!SPECIFIERS.has(specifier)) this.fail("def, over 또는 class가 와야 합니다");
    let typeName: string | null = null;
    if (this.peek().kind === "ident") typeName = this.ident();
    const name = this.string();
    const path = childPrimPath(parent, name);
    const spec = this.spec(path, SpecType.Prim);
    spec.fields.set("specifier", { type: "specifier", value: specifier });
    if (typeName) spec.fields.set("typeName", { type: "token", value: typeName });
    if (this.is("(")) this.metadataBlock(spec, "prim");
    this.body(spec, path);
    return name;
  }

  private body(spec: SdfSpec, path: string): void {
    this.expect("{");
    const children: string[] = [];
    const properties: string[] = [];
    const variantSets: string[] = [];
    while (!this.accept("}")) {
      this.separators();
      if (this.accept("}")) break;
      const t = this.peek();
      if (t.kind === "ident" && SPECIFIERS.has(t.text) && this.peek(1).kind !== "punct") {
        children.push(this.prim(path));
      } else if (this.is("reorder") && (this.is("nameChildren", 1) || this.is("properties", 1)) && this.is("=", 2)) {
        this.next();
        const what = this.ident();
        this.expect("=");
        spec.fields.set(what === "nameChildren" ? "primOrder" : "propertyOrder", { type: "tokenVector", value: this.stringList() });
      } else if (this.is("variantSet")) {
        this.next();
        const set = this.string();
        this.expect("=");
        this.variantSet(path, set);
        if (!variantSets.includes(set)) variantSets.push(set);
      } else {
        const name = this.property(path);
        if (!properties.includes(name)) properties.push(name);
      }
    }
    if (properties.length) spec.fields.set("properties", { type: "tokenVector", value: properties });
    if (children.length) spec.fields.set("primChildren", { type: "tokenVector", value: children });
    if (variantSets.length) spec.fields.set("variantSetChildren", { type: "tokenVector", value: variantSets });
  }

  private variantSet(prim: string, set: string): void {
    const setSpec = this.spec(variantPath(prim, set, ""), SpecType.VariantSet);
    const variants = (setSpec.fields.get("variantChildren")?.value as string[] | undefined) ?? [];
    this.expect("{");
    while (!this.accept("}")) {
      const name = this.string();
      const path = variantPath(prim, set, name);
      const spec = this.spec(path, SpecType.Variant);
      if (this.is("(")) this.metadataBlock(spec, "prim");
      this.body(spec, path);
      if (!variants.includes(name)) variants.push(name);
    }
    setSpec.fields.set("variantChildren", { type: "tokenVector", value: variants });
  }

  // ------------------------------------------------------------ properties

  /** A property statement on `prim`; returns the property name. */
  private property(prim: string): string {
    let op = "";
    if (this.peek().kind === "ident" && LIST_OPS.has(this.peek().text)) op = this.ident();
    let custom = false;
    let variability = "";
    for (;;) {
      if (this.accept("custom")) custom = true;
      else if (this.is("uniform") || this.is("config") || this.is("varying")) variability = this.ident();
      else break;
    }
    if (this.accept("rel")) return this.relationship(prim, op, custom, variability);

    let typeName = this.ident();
    if (this.accept("[")) {
      this.expect("]");
      typeName += "[]";
    }
    const name = this.ident();
    const path = propertyPath(prim, name);
    const spec = this.spec(path, SpecType.Attribute);
    spec.fields.set("typeName", { type: "token", value: typeName });
    if (custom) spec.fields.set("custom", { type: "bool", value: true });
    if (variability === "uniform" || variability === "config") spec.fields.set("variability", { type: "variability", value: "uniform" });
    const valueType = valueTypeOf(typeName);

    if (this.accept(".")) {
      const suffix = this.ident();
      this.expect("=");
      if (suffix === "connect") {
        const items = this.accept("None") ? null : this.is("[") ? this.listOf(() => this.pathToken()) : [this.pathToken()];
        const existing = spec.fields.get("connectionPaths")?.value as ListOp<string> | undefined;
        const listOp = existing ?? emptyListOp<string>();
        applyListOp(listOp, op, items);
        spec.fields.set("connectionPaths", { type: "pathListOp", value: listOp });
      } else if (suffix === "timeSamples") {
        spec.fields.set("timeSamples", { type: "timeSamples", value: this.timeSamples(valueType) });
      } else {
        throw new UnsupportedUsdError(`${path}.${suffix}: 지원하지 않는 속성 구문입니다.`);
      }
    } else if (this.accept("=")) {
      spec.fields.set("default", this.typedValue(valueType, this.node()));
    }
    if (this.is("(")) this.metadataBlock(spec, "attribute");
    return name;
  }

  private relationship(prim: string, op: string, custom: boolean, variability: string): string {
    const name = this.ident();
    const path = propertyPath(prim, name);
    const spec = this.spec(path, SpecType.Relationship);
    if (custom) spec.fields.set("custom", { type: "bool", value: true });
    spec.fields.set("variability", { type: "variability", value: variability === "varying" ? "varying" : "uniform" });
    if (this.accept(".")) throw new UnsupportedUsdError(`${path}: 지원하지 않는 관계 구문입니다.`);
    if (this.accept("=")) {
      const items = this.accept("None") ? null : this.is("[") ? this.listOf(() => this.pathToken()) : [this.pathToken()];
      const existing = spec.fields.get("targetPaths")?.value as ListOp<string> | undefined;
      const listOp = existing ?? emptyListOp<string>();
      applyListOp(listOp, op, items);
      spec.fields.set("targetPaths", { type: "pathListOp", value: listOp });
    }
    if (this.is("(")) this.metadataBlock(spec, "property");
    return name;
  }

  private timeSamples(valueType: string): TimeSamples {
    const samples: TimeSamples = [];
    this.expect("{");
    while (!this.accept("}")) {
      const time = this.number();
      this.expect(":");
      samples.push([time, this.typedValue(valueType, this.node())]);
      this.accept(",");
    }
    return samples;
  }
}

// ---------------------------------------------------------------- conversions

/** Apply one `op key = items` statement to a list op (`None` = explicit empty). */
function applyListOp<T>(listOp: ListOp<T>, op: string, items: T[] | null): void {
  const list = items ?? [];
  switch (op) {
    case "":
      listOp.explicit = true;
      listOp.explicitItems = list;
      break;
    case "add":
      listOp.addedItems = list;
      break;
    case "prepend":
      listOp.prependedItems = list;
      break;
    case "append":
      listOp.appendedItems = list;
      break;
    case "delete":
      listOp.deletedItems = list;
      break;
    case "reorder":
      listOp.orderedItems = list;
      break;
  }
}

function scalarNumber(node: Node): number {
  if (node.k === "number") return Number(node.text);
  if (node.k === "ident") {
    const n = node.name.replace(/^\+/, "");
    if (n === "inf") return Infinity;
    if (n === "-inf") return -Infinity;
    if (n === "nan" || n === "-nan") return NaN;
    if (n === "true") return 1;
    if (n === "false") return 0;
  }
  throw new Error("숫자가 와야 합니다");
}

function component(kind: string, node: Node): number | bigint | boolean {
  switch (kind) {
    case "bool":
      return scalarNumber(node) !== 0;
    case "int64":
    case "uint64":
      if (node.k === "number" && /^[-+]?\d+$/.test(node.text)) return BigInt(node.text);
      return BigInt(Math.trunc(scalarNumber(node)));
    case "float":
      return Math.fround(scalarNumber(node));
    case "half":
      return floatToHalf(scalarNumber(node));
    default:
      return scalarNumber(node);
  }
}

function flattenTuple(node: Node, out: Node[]): void {
  if (node.k === "tuple") for (const item of node.items) flattenTuple(item, out);
  else out.push(node);
}

/** Components in storage order; quaternions are (real, i, j, k) in text. */
function tupleComponents(type: string, node: Node): Node[] {
  const flat: Node[] = [];
  flattenTuple(node, flat);
  if (type.startsWith("quat") && flat.length === 4) return [flat[1], flat[2], flat[3], flat[0]];
  return flat;
}

function scalarValue(type: string, node: Node): unknown {
  switch (type) {
    case "string":
    case "token":
    case "pathExpression":
      if (node.k === "string") return node.value;
      if (node.k === "ident") return node.name;
      break;
    case "asset":
      if (node.k === "asset") return node.path;
      if (node.k === "string") return node.value;
      break;
    case "specifier":
    case "permission":
    case "variability":
      if (node.k === "ident") return node.name;
      break;
    case "tokenVector":
    case "stringVector":
      if (node.k === "list") return node.items.map((n) => (n.k === "string" ? n.value : n.k === "ident" ? n.name : ""));
      break;
    case "timecode":
      return scalarNumber(node);
    default: {
      const n = tupleSize(type);
      const kind = componentType(type);
      if (n === 1) return component(kind, node);
      const parts = tupleComponents(type, node);
      if (parts.length !== n) throw new Error(`${type} 값의 성분 수가 맞지 않습니다`);
      return parts.map((p) => component(kind, p));
    }
  }
  throw new Error(`${type} 값으로 읽을 수 없습니다`);
}

function arrayValue(base: string, items: Node[]): unknown {
  switch (base) {
    case "string":
    case "token":
    case "pathExpression":
      return items.map((n) => scalarValue(base, n) as string);
    case "asset":
      return items.map((n) => scalarValue("asset", n) as string);
  }
  const n = tupleSize(base);
  const kind = base === "timecode" ? "double" : componentType(base);
  const values: (number | bigint | boolean)[] = [];
  for (const item of items) {
    if (n === 1) values.push(component(kind, item));
    else {
      const parts = tupleComponents(base, item);
      if (parts.length !== n) throw new Error(`${base}[] 원소의 성분 수가 맞지 않습니다`);
      for (const p of parts) values.push(component(kind, p));
    }
  }
  switch (kind) {
    case "double":
      return Float64Array.from(values as number[]);
    case "float":
      return Float32Array.from(values as number[]);
    case "half":
      return Uint16Array.from(values as number[]);
    case "int":
      return Int32Array.from(values as number[]);
    case "uint":
      return Uint32Array.from(values as number[]);
    case "int64":
      return BigInt64Array.from(values as bigint[]);
    case "uint64":
      return BigUint64Array.from(values as bigint[]);
    case "uchar":
      return Uint8Array.from(values as number[]);
    case "bool":
      return Uint8Array.from(values.map((v) => (v ? 1 : 0)));
  }
  throw new UnsupportedUsdError(`${base}[] 배열은 지원하지 않습니다.`);
}
