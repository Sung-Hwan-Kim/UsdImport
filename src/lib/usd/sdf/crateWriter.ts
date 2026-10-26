import { compress, encodeInts } from "./compression";
import { CRATE_TYPES, componentOf, sizeOf } from "./crateReader";
import {
  UnsupportedUsdError,
  parentPath,
  pathName,
  propertySeparator,
  type Dictionary,
  type LayerOffset,
  type ListOp,
  type Payload,
  type Reference,
  type SdfLayer,
  type SdfValue,
  type TimeSamples,
} from "./data";

const TYPE_CODES: Record<string, number> = Object.fromEntries(Object.entries(CRATE_TYPES).map(([code, name]) => [name, Number(code)]));

const ARRAY_BIT = 1n << 63n;
const INLINED_BIT = 1n << 62n;

const SPECIFIERS = ["def", "over", "class"];
const PERMISSIONS = ["public", "private"];
const VARIABILITIES = ["varying", "uniform"];

/** Growable little-endian byte buffer with random-access patching. */
class Sink {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.reserve(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }
  u16(v: number) {
    this.reserve(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }
  u32(v: number) {
    this.reserve(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
  }
  i32(v: number) {
    this.reserve(4);
    this.view.setInt32(this.length, v, true);
    this.length += 4;
  }
  u64(v: number | bigint) {
    this.reserve(8);
    this.view.setBigUint64(this.length, BigInt.asUintN(64, BigInt(v)), true);
    this.length += 8;
  }
  i64(v: number | bigint) {
    this.reserve(8);
    this.view.setBigInt64(this.length, BigInt.asIntN(64, BigInt(v)), true);
    this.length += 8;
  }
  f32(v: number) {
    this.reserve(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
  }
  f64(v: number) {
    this.reserve(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
  }
  bytes(b: Uint8Array) {
    this.reserve(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  align(n: number) {
    while (this.length % n) this.u8(0);
  }
  patchI64(at: number, v: number) {
    this.view.setBigInt64(at, BigInt(v), true);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Write a layer as a usdc (crate) file. */
export function writeCrate(layer: SdfLayer): Uint8Array {
  return new CrateWriter(layer).write();
}

class CrateWriter {
  private readonly sink = new Sink();
  private version: [number, number, number] = [0, 8, 0];
  private readonly tokens = new Map<string, number>();
  private readonly strings = new Map<string, number>();
  private readonly stringTokens: number[] = [];
  private readonly paths = new Map<string, number>();
  private readonly fields = new Map<string, number>();
  private readonly fieldList: { token: number; rep: bigint }[] = [];
  private readonly fieldSets: number[] = [];
  private readonly fieldSetKeys = new Map<string, number>();
  private readonly specs: { path: number; fieldSet: number; type: number }[] = [];

  constructor(private readonly layer: SdfLayer) {
    // Token 0 stays empty so that no property element token is ever 0 (it is negated).
    this.token("");
  }

  write(): Uint8Array {
    this.version = this.requiredVersion();
    this.sink.bytes(new Uint8Array(88)); // bootstrap, filled in at the end
    for (const [path, spec] of this.layer.specs) {
      const pathIndex = this.path(path);
      const fieldIndexes: number[] = [];
      for (const [name, value] of spec.fields) {
        const rep = this.pack(value);
        const token = this.token(name);
        const key = `${token}:${rep}`;
        let index = this.fields.get(key);
        if (index === undefined) {
          index = this.fieldList.length;
          this.fieldList.push({ token, rep });
          this.fields.set(key, index);
        }
        fieldIndexes.push(index);
      }
      const setKey = fieldIndexes.join(",");
      let fieldSet = this.fieldSetKeys.get(setKey);
      if (fieldSet === undefined) {
        fieldSet = this.fieldSets.length;
        this.fieldSets.push(...fieldIndexes, -1);
        this.fieldSetKeys.set(setKey, fieldSet);
      }
      this.specs.push({ path: pathIndex, fieldSet, type: spec.type });
    }

    const sections: [string, number, number][] = [];
    const section = (name: string, write: () => void) => {
      const start = this.sink.length;
      write();
      sections.push([name, start, this.sink.length - start]);
    };
    // Paths first: writing their element names adds tokens.
    const pathData = this.encodePaths();
    section("TOKENS", () => this.writeTokens());
    section("STRINGS", () => {
      this.sink.u64(this.stringTokens.length);
      for (const t of this.stringTokens) this.sink.u32(t);
    });
    section("FIELDS", () => {
      this.sink.u64(this.fieldList.length);
      this.compressedInts(this.fieldList.map((f) => f.token));
      const reps = new Uint8Array(this.fieldList.length * 8);
      const view = new DataView(reps.buffer);
      this.fieldList.forEach((f, i) => view.setBigUint64(i * 8, f.rep, true));
      const packed = compress(reps);
      this.sink.u64(packed.length);
      this.sink.bytes(packed);
    });
    section("FIELDSETS", () => {
      this.sink.u64(this.fieldSets.length);
      this.compressedInts(this.fieldSets);
    });
    section("PATHS", () => {
      this.sink.u64(this.paths.size);
      this.sink.u64(pathData.indexes.length);
      this.compressedInts(pathData.indexes);
      this.compressedInts(pathData.elements);
      this.compressedInts(pathData.jumps);
    });
    section("SPECS", () => {
      this.sink.u64(this.specs.length);
      this.compressedInts(this.specs.map((s) => s.path));
      this.compressedInts(this.specs.map((s) => s.fieldSet));
      this.compressedInts(this.specs.map((s) => s.type));
    });

    const tocOffset = this.sink.length;
    this.sink.u64(sections.length);
    for (const [name, start, size] of sections) {
      const nameBytes = new Uint8Array(16);
      nameBytes.set(new TextEncoder().encode(name));
      this.sink.bytes(nameBytes);
      this.sink.i64(start);
      this.sink.i64(size);
    }

    const out = this.sink.result();
    out.set(new TextEncoder().encode("PXR-USDC"), 0);
    out.set(this.version, 8);
    new DataView(out.buffer).setBigInt64(16, BigInt(tocOffset), true);
    return out;
  }

  /** The oldest crate version that can hold every value in the layer (0.8.0 at least). */
  private requiredVersion(): [number, number, number] {
    let minor = 8;
    const visit = (v: SdfValue): void => {
      if (v.type.startsWith("timecode")) minor = Math.max(minor, 9);
      else if (v.type.startsWith("pathExpression")) minor = Math.max(minor, 10);
      else if (v.type === "relocates") minor = Math.max(minor, 11);
      else if (v.type === "dictionary") for (const x of (v.value as Dictionary).values()) visit(x);
      else if (v.type === "timeSamples") for (const [, x] of v.value as TimeSamples) visit(x);
      else if (v.type === "value" || v.type === "unregisteredValue") visit(v.value as SdfValue);
    };
    for (const spec of this.layer.specs.values()) for (const v of spec.fields.values()) visit(v);
    return [0, minor, 0];
  }

  // ------------------------------------------------------------ tables

  private token(t: string): number {
    let i = this.tokens.get(t);
    if (i === undefined) {
      i = this.tokens.size;
      this.tokens.set(t, i);
    }
    return i;
  }

  private string(s: string): number {
    let i = this.strings.get(s);
    if (i === undefined) {
      i = this.stringTokens.length;
      this.stringTokens.push(this.token(s));
      this.strings.set(s, i);
    }
    return i;
  }

  /** Index of a path; ancestors are added too, so the path tree is complete. */
  private path(p: string): number {
    let i = this.paths.get(p);
    if (i !== undefined) return i;
    if (p && p !== "/") this.path(parentPath(p));
    i = this.paths.size;
    this.paths.set(p, i);
    return i;
  }

  private writeTokens(): void {
    const encoder = new TextEncoder();
    const parts = [...this.tokens.keys()].map((t) => encoder.encode(t));
    const size = parts.reduce((n, p) => n + p.length + 1, 0);
    const raw = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      raw.set(p, o);
      o += p.length + 1;
    }
    const packed = compress(raw);
    this.sink.u64(parts.length);
    this.sink.u64(raw.length);
    this.sink.u64(packed.length);
    this.sink.bytes(packed);
  }

  private compressedInts(values: number[]): void {
    const packed = encodeInts(values);
    this.sink.u64(packed.length);
    this.sink.bytes(packed);
  }

  /**
   * The path tree in depth-first order: each entry's path index, element token
   * (negated for properties) and a jump: -1 = next entry is its first child,
   * 0 = next entry is its sibling, -2 = leaf, n > 0 = has a child next and a
   * sibling n entries ahead.
   */
  private encodePaths(): { indexes: number[]; elements: number[]; jumps: number[] } {
    const children = new Map<string, string[]>();
    for (const p of this.paths.keys()) {
      if (!p || p === "/") continue;
      const parent = parentPath(p);
      const list = children.get(parent);
      if (list) list.push(p);
      else children.set(parent, [p]);
    }
    const indexes: number[] = [];
    const elements: number[] = [];
    const jumps: number[] = [];
    const visit = (p: string, hasSibling: boolean) => {
      const at = indexes.length;
      indexes.push(this.paths.get(p)!);
      if (p === "/") elements.push(0);
      else {
        const isProperty = propertySeparator(p) >= 0 && parentPath(p) === p.slice(0, propertySeparator(p));
        const token = this.token(pathName(p));
        elements.push(isProperty ? -token : token);
      }
      jumps.push(0);
      const kids = children.get(p) ?? [];
      kids.forEach((kid, i) => visit(kid, i < kids.length - 1));
      const hasChild = kids.length > 0;
      jumps[at] = hasChild ? (hasSibling ? indexes.length - at : -1) : hasSibling ? 0 : -2;
    };
    if (this.paths.has("/")) visit("/", false);
    return { indexes, elements, jumps };
  }

  // ------------------------------------------------------------ values

  private rep(type: string, payload: number | bigint, flags: bigint): bigint {
    const code = TYPE_CODES[type];
    if (code === undefined) throw new UnsupportedUsdError(`usdc로 쓸 수 없는 값 형식입니다: ${type}`);
    return flags | (BigInt(code) << 48n) | BigInt.asUintN(48, BigInt(payload));
  }

  private inline(type: string, payload: number): bigint {
    return this.rep(type, payload >>> 0, INLINED_BIT);
  }

  /** Pack a value: inline it, or write its data here and point at it. */
  private pack(v: SdfValue): bigint {
    const type = v.type;
    if (type.endsWith("[]")) return this.packArray(type.slice(0, -2), v.value);
    switch (type) {
      case "bool":
        return this.inline(type, v.value ? 1 : 0);
      case "uchar":
      case "uint":
        return this.inline(type, Number(v.value));
      case "int":
        return this.inline(type, Number(v.value) | 0);
      case "half":
        return this.inline(type, Number(v.value) & 0xffff);
      case "float": {
        const scratch = new DataView(new ArrayBuffer(4));
        scratch.setFloat32(0, v.value as number, true);
        return this.inline(type, scratch.getUint32(0, true));
      }
      case "token":
        return this.inline(type, this.token(v.value as string));
      case "asset":
        return this.inline(type, this.token(v.value as string));
      case "string":
        return this.inline(type, this.string(v.value as string));
      case "specifier":
        return this.inline(type, SPECIFIERS.indexOf(v.value as string));
      case "permission":
        return this.inline(type, PERMISSIONS.indexOf(v.value as string));
      case "variability":
        return this.inline(type, VARIABILITIES.indexOf(v.value as string));
      case "valueBlock":
        return this.inline(type, 0);
      case "half2": {
        const [a, b] = v.value as number[];
        return this.inline(type, ((a & 0xffff) | ((b & 0xffff) << 16)) >>> 0);
      }
      case "dictionary":
        if ((v.value as Dictionary).size === 0) return this.inline(type, 0);
        break;
      case "timeSamples":
        return this.rep(type, this.writeTimeSamples(v.value as TimeSamples), 0n);
    }
    const at = this.sink.length;
    this.writeScalar(type, v.value);
    return this.rep(type, at, 0n);
  }

  private component(kind: string, x: number | bigint | boolean): void {
    const s = this.sink;
    switch (kind) {
      case "double":
        return s.f64(Number(x));
      case "float":
        return s.f32(Number(x));
      case "half":
        return s.u16(Number(x));
      case "int":
        return s.i32(Number(x));
      case "uint":
        return s.u32(Number(x));
      case "int64":
        return s.i64(x as bigint);
      case "uint64":
        return s.u64(x as bigint);
      case "uchar":
        return s.u8(Number(x));
      case "bool":
        return s.u8(x ? 1 : 0);
    }
    throw new UnsupportedUsdError(`usdc로 쓸 수 없는 값 형식입니다: ${kind}`);
  }

  private writeScalar(type: string, value: unknown): void {
    const s = this.sink;
    switch (type) {
      case "int64":
      case "uint64":
      case "double":
      case "timecode":
        return this.component(type === "timecode" ? "double" : type, value as number | bigint);
      case "dictionary":
        return this.writeDictionary(value as Dictionary);
      case "tokenListOp":
        return this.writeListOp(value as ListOp<string>, (t) => s.u32(this.token(t)));
      case "stringListOp":
        return this.writeListOp(value as ListOp<string>, (t) => s.u32(this.string(t)));
      case "pathListOp":
        return this.writeListOp(value as ListOp<string>, (p) => s.u32(this.path(p)));
      case "referenceListOp":
        return this.writeListOp(value as ListOp<Reference>, (r) => this.writeReference(r));
      case "payloadListOp":
        return this.writeListOp(value as ListOp<Payload>, (p) => this.writePayload(p));
      case "intListOp":
        return this.writeListOp(value as ListOp<number>, (x) => s.i32(x));
      case "uintListOp":
        return this.writeListOp(value as ListOp<number>, (x) => s.u32(x));
      case "int64ListOp":
        return this.writeListOp(value as ListOp<bigint>, (x) => s.i64(x));
      case "uint64ListOp":
        return this.writeListOp(value as ListOp<bigint>, (x) => s.u64(x));
      case "tokenVector":
        return this.vector(value as string[], (t) => s.u32(this.token(t)));
      case "stringVector":
        return this.vector(value as string[], (t) => s.u32(this.string(t)));
      case "pathVector":
        return this.vector(value as string[], (p) => s.u32(this.path(p)));
      case "doubleVector":
        return this.vector(value as number[], (x) => s.f64(x));
      case "layerOffsetVector":
        return this.vector(value as LayerOffset[], (o) => this.writeLayerOffset(o));
      case "variantSelectionMap": {
        const map = value as Map<string, string>;
        s.u64(map.size);
        for (const [k, v] of map) {
          s.u32(this.string(k));
          s.u32(this.string(v));
        }
        return;
      }
      case "payload":
        return this.writePayload(value as Payload);
      case "relocates":
        return this.vector(value as [string, string][], ([a, b]) => {
          s.u32(this.path(a));
          s.u32(this.path(b));
        });
      case "pathExpression":
        return s.u32(this.string(value as string));
      case "value":
      case "unregisteredValue":
        return this.writeValue(value as SdfValue);
    }
    const kind = componentOf(type);
    if (!kind) throw new UnsupportedUsdError(`usdc로 쓸 수 없는 값 형식입니다: ${type}`);
    const values = value as (number | bigint)[];
    // Quaternions and matrices are already in memory order.
    for (let i = 0; i < sizeOf(type); i++) this.component(kind, values[i]);
  }

  private vector<T>(items: T[], write: (item: T) => void): void {
    this.sink.u64(items.length);
    for (const item of items) write(item);
  }

  private writeListOp<T>(op: ListOp<T>, write: (item: T) => void): void {
    let header = op.explicit ? 1 : 0;
    if (op.explicitItems.length) header |= 2;
    if (op.addedItems.length) header |= 4;
    if (op.deletedItems.length) header |= 8;
    if (op.orderedItems.length) header |= 16;
    if (op.prependedItems.length) header |= 32;
    if (op.appendedItems.length) header |= 64;
    this.sink.u8(header);
    if (header & 2) this.vector(op.explicitItems, write);
    if (header & 4) this.vector(op.addedItems, write);
    if (header & 32) this.vector(op.prependedItems, write);
    if (header & 64) this.vector(op.appendedItems, write);
    if (header & 8) this.vector(op.deletedItems, write);
    if (header & 16) this.vector(op.orderedItems, write);
  }

  private writeLayerOffset(o: LayerOffset): void {
    this.sink.f64(o.offset);
    this.sink.f64(o.scale);
  }

  private writeReference(r: Reference): void {
    this.sink.u32(this.string(r.assetPath));
    this.sink.u32(this.path(r.primPath));
    this.writeLayerOffset(r.layerOffset);
    this.writeDictionary(r.customData);
  }

  private writePayload(p: Payload): void {
    this.sink.u32(this.string(p.assetPath));
    this.sink.u32(this.path(p.primPath));
    this.writeLayerOffset(p.layerOffset);
  }

  private writeDictionary(dict: Dictionary): void {
    this.sink.u64(dict.size);
    for (const [key, value] of dict) {
      this.sink.u32(this.string(key));
      this.writeValue(value);
    }
  }

  /** A nested VtValue: forward offset, the value's data, then its ValueRep. */
  private writeValue(v: SdfValue): void {
    const at = this.sink.length;
    this.sink.i64(0);
    const rep = this.pack(v);
    this.sink.patchI64(at, this.sink.length - at);
    this.sink.u64(rep);
  }

  private writeTimeSamples(samples: TimeSamples): number {
    const start = this.sink.length;
    this.writeValue({ type: "double[]", value: Float64Array.from(samples.map(([t]) => t)) });
    const valuesAt = this.sink.length;
    this.sink.i64(0);
    const reps = samples.map(([, v]) => this.pack(v));
    this.sink.patchI64(valuesAt, this.sink.length - valuesAt);
    this.sink.u64(reps.length);
    for (const r of reps) this.sink.u64(r);
    return start;
  }

  private packArray(base: string, value: unknown): bigint {
    const items = value as ArrayLike<unknown>;
    if (items.length === 0) return this.rep(base, 0, ARRAY_BIT);
    this.sink.align(8);
    const at = this.sink.length;
    const stringLike = base === "token" || base === "string" || base === "asset" || base === "pathExpression";
    // Numeric arrays are stored flat; the count is in elements (tuples).
    this.sink.u64(stringLike ? items.length : items.length / sizeOf(base));
    switch (base) {
      case "token":
        for (const t of items as string[]) this.sink.u32(this.token(t));
        break;
      case "string":
      case "asset":
      case "pathExpression":
        for (const t of items as string[]) this.sink.u32(this.string(t));
        break;
      default: {
        const kind = componentOf(base);
        if (!kind) throw new UnsupportedUsdError(`usdc로 쓸 수 없는 배열 형식입니다: ${base}[]`);
        const flat = items as ArrayLike<number | bigint>;
        for (let i = 0; i < flat.length; i++) this.component(kind, flat[i]);
      }
    }
    return this.rep(base, at, ARRAY_BIT);
  }
}

