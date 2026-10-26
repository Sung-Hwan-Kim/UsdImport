import { decodeInts, decompress } from "./compression";
import {
  SdfLayer,
  SpecType,
  UnsupportedUsdError,
  emptyListOp,
  type Dictionary,
  type LayerOffset,
  type ListOp,
  type Payload,
  type Reference,
  type SdfValue,
  type TimeSamples,
  componentType,
  tupleSize,
} from "./data";

/** Crate TypeEnum -> Sdf value type name (arrays get "[]"). */
export const CRATE_TYPES: Record<number, string> = {
  1: "bool",
  2: "uchar",
  3: "int",
  4: "uint",
  5: "int64",
  6: "uint64",
  7: "half",
  8: "float",
  9: "double",
  10: "string",
  11: "token",
  12: "asset",
  13: "matrix2d",
  14: "matrix3d",
  15: "matrix4d",
  16: "quatd",
  17: "quatf",
  18: "quath",
  19: "double2",
  20: "float2",
  21: "half2",
  22: "int2",
  23: "double3",
  24: "float3",
  25: "half3",
  26: "int3",
  27: "double4",
  28: "float4",
  29: "half4",
  30: "int4",
  31: "dictionary",
  32: "tokenListOp",
  33: "stringListOp",
  34: "pathListOp",
  35: "referenceListOp",
  36: "intListOp",
  37: "int64ListOp",
  38: "uintListOp",
  39: "uint64ListOp",
  40: "pathVector",
  41: "tokenVector",
  42: "specifier",
  43: "permission",
  44: "variability",
  45: "variantSelectionMap",
  46: "timeSamples",
  47: "payload",
  48: "doubleVector",
  49: "layerOffsetVector",
  50: "stringVector",
  51: "valueBlock",
  52: "value",
  53: "unregisteredValue",
  54: "unregisteredValueListOp",
  55: "payloadListOp",
  56: "timecode",
  57: "pathExpression",
  58: "relocates",
};

const UNSUPPORTED_TYPES: Record<number, string> = { 54: "UnregisteredValueListOp", 59: "spline", 60: "AnimationBlock" };

const SPECIFIERS = ["def", "over", "class"] as const;
const PERMISSIONS = ["public", "private"] as const;
const VARIABILITIES = ["varying", "uniform"] as const;

const textDecoder = new TextDecoder();

class Rep {
  constructor(readonly bits: bigint) {}
  get isArray() {
    return (this.bits & (1n << 63n)) !== 0n;
  }
  get isInlined() {
    return (this.bits & (1n << 62n)) !== 0n;
  }
  get isCompressed() {
    return (this.bits & (1n << 61n)) !== 0n;
  }
  get isArrayEdit() {
    return (this.bits & (1n << 60n)) !== 0n;
  }
  get type() {
    return Number((this.bits >> 48n) & 0xffn);
  }
  get payload() {
    return Number(this.bits & 0xffffffffffffn);
  }
}

/** Read a usdc (crate) file into a lossless SdfLayer. */
export function readCrate(bytes: Uint8Array): SdfLayer {
  return new CrateReader(bytes).read();
}

class CrateReader {
  private readonly view: DataView;
  private pos = 0;
  private version = [0, 0, 0];
  private sections = new Map<string, { start: number; size: number }>();
  private tokens: string[] = [];
  private strings: number[] = [];
  private fields: { token: number; rep: Rep }[] = [];
  private fieldSets: number[] = [];
  private paths: string[] = [];
  private specs: { path: number; fieldSet: number; type: number }[] = [];

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private atLeast(major: number, minor: number, patch = 0): boolean {
    const [a, b, c] = this.version;
    return a !== major ? a > major : b !== minor ? b > minor : c >= patch;
  }

  // ------------------------------------------------------------ primitives

  private u8() {
    return this.view.getUint8(this.pos++);
  }
  private i8() {
    return this.view.getInt8(this.pos++);
  }
  private u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  private i16() {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  private u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  private i32() {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  private u64() {
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  private i64() {
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  private count() {
    return Number(this.u64());
  }
  private f32() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  private f64() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  private bytesAt(length: number) {
    const b = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return b;
  }
  private compressedInts(count: number, wide = false): number[] {
    const size = this.count();
    return decodeInts(this.bytesAt(size), count, wide);
  }

  private token(i: number) {
    return this.tokens[i] ?? "";
  }
  private string(i: number) {
    return this.tokens[this.strings[i]] ?? "";
  }
  private path(i: number) {
    return this.paths[i] ?? "";
  }

  // ------------------------------------------------------------ structure

  read(): SdfLayer {
    if (textDecoder.decode(this.bytes.subarray(0, 8)) !== "PXR-USDC") throw new Error("usdc 파일이 아닙니다.");
    this.version = [this.bytes[8], this.bytes[9], this.bytes[10]];
    if (!this.atLeast(0, 4)) throw new UnsupportedUsdError(`오래된 usdc 버전(${this.version.join(".")})은 저장을 지원하지 않습니다.`);
    this.pos = Number(this.view.getBigInt64(16, true));
    const numSections = this.count();
    for (let i = 0; i < numSections; i++) {
      const name = textDecoder.decode(this.bytesAt(16)).replace(/\0.*$/s, "");
      const start = Number(this.i64());
      const size = Number(this.i64());
      this.sections.set(name, { start, size });
    }
    this.readTokens();
    this.readStrings();
    this.readFields();
    this.readFieldSets();
    this.readPaths();
    this.readSpecs();

    const layer = new SdfLayer();
    layer.specs.clear();
    for (const spec of this.specs) {
      const fields = new Map<string, SdfValue>();
      for (let i = spec.fieldSet; i < this.fieldSets.length && this.fieldSets[i] !== -1 && this.fieldSets[i] !== 0xffffffff; i++) {
        const field = this.fields[this.fieldSets[i]];
        fields.set(this.token(field.token), this.unpack(field.rep));
      }
      layer.specs.set(this.path(spec.path), { type: spec.type as SpecType, fields });
    }
    if (!layer.specs.has("/")) layer.specs.set("/", { type: SpecType.PseudoRoot, fields: new Map() });
    return layer;
  }

  private seekSection(name: string): boolean {
    const section = this.sections.get(name);
    if (!section) return false;
    this.pos = section.start;
    return true;
  }

  private readTokens() {
    if (!this.seekSection("TOKENS")) return;
    const count = this.count();
    const uncompressed = this.count();
    const compressed = this.count();
    const data = decompress(this.bytesAt(compressed), uncompressed);
    let start = 0;
    for (let i = 0; i < count; i++) {
      let end = start;
      while (end < data.length && data[end] !== 0) end++;
      this.tokens.push(textDecoder.decode(data.subarray(start, end)));
      start = end + 1;
    }
  }

  private readStrings() {
    if (!this.seekSection("STRINGS")) return;
    const count = this.count();
    for (let i = 0; i < count; i++) this.strings.push(this.u32());
  }

  private readFields() {
    if (!this.seekSection("FIELDS")) return;
    const count = this.count();
    const tokens = this.compressedInts(count);
    const repsSize = this.count();
    const reps = decompress(this.bytesAt(repsSize), count * 8);
    const view = new DataView(reps.buffer, reps.byteOffset, reps.byteLength);
    for (let i = 0; i < count; i++) this.fields.push({ token: tokens[i], rep: new Rep(view.getBigUint64(i * 8, true)) });
  }

  private readFieldSets() {
    if (!this.seekSection("FIELDSETS")) return;
    const count = this.count();
    this.fieldSets = this.compressedInts(count).map((v) => v >>> 0);
  }

  private readPaths() {
    if (!this.seekSection("PATHS")) return;
    const count = this.count();
    this.paths = new Array<string>(count).fill("");
    const encoded = this.count();
    const pathIndexes = this.compressedInts(encoded);
    const elementTokens = this.compressedInts(encoded);
    const jumps = this.compressedInts(encoded);
    const build = (start: number, parent: string) => {
      let i = start;
      let parentPath = parent;
      while (i < encoded) {
        const index = i++;
        let path: string;
        if (!parentPath) {
          path = "/";
          parentPath = "/";
        } else {
          const element = this.token(Math.abs(elementTokens[index]));
          if (elementTokens[index] < 0) path = `${parentPath}.${element}`;
          else if (element.startsWith("{") || element.startsWith("[")) path = `${parentPath}${element}`;
          else if (parentPath === "/") path = `/${element}`;
          else path = parentPath.endsWith("}") ? `${parentPath}${element}` : `${parentPath}/${element}`;
        }
        this.paths[pathIndexes[index]] = path;
        const jump = jumps[index];
        const hasChild = jump > 0 || jump === -1;
        const hasSibling = jump >= 0;
        if (hasChild) {
          if (hasSibling) build(index + jump, parentPath);
          parentPath = path;
        } else if (!hasSibling) break;
      }
    };
    build(0, "");
  }

  private readSpecs() {
    if (!this.seekSection("SPECS")) return;
    const count = this.count();
    const paths = this.compressedInts(count);
    const fieldSets = this.compressedInts(count);
    const types = this.compressedInts(count);
    for (let i = 0; i < count; i++) this.specs.push({ path: paths[i], fieldSet: fieldSets[i], type: types[i] });
  }

  // ------------------------------------------------------------ values

  private unpack(rep: Rep): SdfValue {
    const code = rep.type;
    if (UNSUPPORTED_TYPES[code]) throw new UnsupportedUsdError(`지원하지 않는 USD 값 형식입니다: ${UNSUPPORTED_TYPES[code]}`);
    if (rep.isArrayEdit) throw new UnsupportedUsdError("배열 편집(ArrayEdit) 값은 지원하지 않습니다.");
    const name = CRATE_TYPES[code];
    if (!name) throw new UnsupportedUsdError(`알 수 없는 usdc 값 형식(${code})입니다.`);
    if (code === 46) return { type: "timeSamples", value: this.atOffset(rep.payload, () => this.readTimeSamples()) };
    if (rep.isArray) {
      const type = `${name}[]`;
      if (rep.isInlined || rep.payload === 0) return { type, value: emptyArray(name) };
      return { type, value: this.atOffset(rep.payload, () => this.readArray(name, rep.isCompressed)) };
    }
    if (rep.isInlined) return { type: name, value: this.inlined(code, rep.payload) };
    return { type: name, value: this.atOffset(rep.payload, () => this.readScalar(code)) };
  }

  private atOffset<T>(offset: number, fn: () => T): T {
    const saved = this.pos;
    this.pos = offset;
    try {
      return fn();
    } finally {
      this.pos = saved;
    }
  }

  private inlined(code: number, payload: number): unknown {
    const bits = payload >>> 0;
    const scratch = new DataView(new ArrayBuffer(4));
    scratch.setUint32(0, bits, true);
    const int8s = (n: number) => Array.from({ length: n }, (_, i) => scratch.getInt8(i));
    switch (code) {
      case 1:
        return bits !== 0;
      case 2:
        return bits & 0xff;
      case 3:
        return scratch.getInt32(0, true);
      case 4:
        return bits;
      case 5:
        return BigInt(scratch.getInt32(0, true));
      case 6:
        return BigInt(bits);
      case 7:
        return bits & 0xffff;
      case 8:
      case 9:
      case 56:
        return scratch.getFloat32(0, true);
      case 10:
        return this.string(bits);
      case 11:
      case 12:
        return this.token(bits);
      case 42:
        return SPECIFIERS[bits] ?? "def";
      case 43:
        return PERMISSIONS[bits] ?? "public";
      case 44:
        return VARIABILITIES[bits] ?? "varying";
      case 19:
      case 20:
      case 22:
        return int8s(2);
      case 23:
      case 24:
      case 26:
        return int8s(3);
      case 27:
      case 28:
      case 30:
        return int8s(4);
      case 21:
        return [scratch.getUint16(0, true), scratch.getUint16(2, true)];
      case 25:
      case 29:
        return int8s(code === 25 ? 3 : 4).map(halfFromInt);
      case 13:
      case 14:
      case 15: {
        const n = code - 11;
        const diag = int8s(n);
        const m = new Array<number>(n * n).fill(0);
        for (let i = 0; i < n; i++) m[i * n + i] = diag[i];
        return m;
      }
      case 31:
        return new Map();
      case 51:
        return null;
      default:
        throw new UnsupportedUsdError(`인라인 값 형식(${CRATE_TYPES[code]})을 읽을 수 없습니다.`);
    }
  }

  private scalarComponent(component: string): number | bigint {
    switch (component) {
      case "double":
        return this.f64();
      case "float":
        return this.f32();
      case "half":
        return this.u16();
      case "int":
        return this.i32();
      case "uint":
        return this.u32();
      case "int64":
        return this.i64();
      case "uint64":
        return this.u64();
      case "uchar":
        return this.u8();
      case "bool":
        return this.u8();
      default:
        throw new Error(component);
    }
  }

  private readScalar(code: number): unknown {
    const name = CRATE_TYPES[code];
    switch (code) {
      case 1:
        return this.u8() !== 0;
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
      case 8:
      case 9:
      case 56:
        return this.scalarComponent(code === 56 ? "double" : name);
      case 10:
        return this.string(this.u32());
      case 11:
      case 12:
        return this.token(this.u32());
      case 31:
        return this.readDictionary();
      case 32:
        return this.readListOp(() => this.token(this.u32()));
      case 33:
        return this.readListOp(() => this.string(this.u32()));
      case 34:
        return this.readListOp(() => this.path(this.u32()));
      case 35:
        return this.readListOp(() => this.readReference());
      case 36:
        return this.readListOp(() => this.i32());
      case 37:
        return this.readListOp(() => this.i64());
      case 38:
        return this.readListOp(() => this.u32());
      case 39:
        return this.readListOp(() => this.u64());
      case 55:
        return this.readListOp(() => this.readPayload());
      case 40:
        return this.vector(() => this.path(this.u32()));
      case 41:
        return this.vector(() => this.token(this.u32()));
      case 50:
        return this.vector(() => this.string(this.u32()));
      case 48:
        return this.vector(() => this.f64());
      case 49:
        return this.vector(() => this.readLayerOffset());
      case 45: {
        const map = new Map<string, string>();
        const n = this.count();
        for (let i = 0; i < n; i++) map.set(this.string(this.u32()), this.string(this.u32()));
        return map;
      }
      case 47:
        return this.readPayload();
      case 52:
      case 53:
        return this.readValue();
      case 57:
        return this.string(this.u32());
      case 58: {
        const n = this.count();
        const pairs: [string, string][] = [];
        for (let i = 0; i < n; i++) pairs.push([this.path(this.u32()), this.path(this.u32())]);
        return pairs;
      }
      default: {
        const component = name.startsWith("matrix") || name.startsWith("quat") || /\d$/.test(name) ? componentOf(name) : null;
        if (!component) throw new UnsupportedUsdError(`usdc 값 형식(${name})을 읽을 수 없습니다.`);
        return Array.from({ length: sizeOf(name) }, () => this.scalarComponent(component) as number);
      }
    }
  }

  private vector<T>(item: () => T): T[] {
    const n = this.count();
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(item());
    return out;
  }

  private readLayerOffset(): LayerOffset {
    return { offset: this.f64(), scale: this.f64() };
  }

  private readReference(): Reference {
    return { assetPath: this.string(this.u32()), primPath: this.path(this.u32()), layerOffset: this.readLayerOffset(), customData: this.readDictionary() };
  }

  private readPayload(): Payload {
    const assetPath = this.string(this.u32());
    const primPath = this.path(this.u32());
    const layerOffset = this.atLeast(0, 8) ? this.readLayerOffset() : { offset: 0, scale: 1 };
    return { assetPath, primPath, layerOffset };
  }

  private readListOp<T>(item: () => T): ListOp<T> {
    const header = this.u8();
    const op = emptyListOp<T>();
    op.explicit = (header & 1) !== 0;
    const list = () => this.vector(item);
    if (header & 2) op.explicitItems = list();
    if (header & 4) op.addedItems = list();
    if (header & 32) op.prependedItems = list();
    if (header & 64) op.appendedItems = list();
    if (header & 8) op.deletedItems = list();
    if (header & 16) op.orderedItems = list();
    return op;
  }

  /** A VtValue nested in a container: an int64 forward offset to its ValueRep. */
  private readValue(): SdfValue {
    const start = this.pos;
    const offset = Number(this.i64());
    this.pos = start + offset;
    const rep = new Rep(this.u64());
    return this.unpack(rep);
  }

  private readDictionary(): Dictionary {
    const dict: Dictionary = new Map();
    const n = this.count();
    for (let i = 0; i < n; i++) {
      const key = this.string(this.u32());
      dict.set(key, this.readValue());
    }
    return dict;
  }

  private readTimeSamples(): TimeSamples {
    const times = this.readValue();
    const valuesStart = this.pos;
    const valuesOffset = Number(this.i64());
    this.pos = valuesStart + valuesOffset;
    const n = this.count();
    const reps: Rep[] = [];
    for (let i = 0; i < n; i++) reps.push(new Rep(this.u64()));
    const timeValues = Array.from(times.value as ArrayLike<number>);
    return reps.map((rep, i) => [timeValues[i], this.unpack(rep)] as [number, SdfValue]);
  }

  private readArray(name: string, compressed: boolean): unknown {
    if (!this.atLeast(0, 5)) this.u32(); // rank, dropped in 0.5.0
    const n = this.atLeast(0, 7) ? this.count() : this.u32();
    if (compressed) return this.readCompressedArray(name, n);
    switch (name) {
      // Asset paths are written as strings in arrays, but as tokens when inlined.
      case "string":
      case "asset":
        return Array.from({ length: n }, () => this.string(this.u32()));
      case "token":
        return Array.from({ length: n }, () => this.token(this.u32()));
      case "pathExpression":
        return Array.from({ length: n }, () => this.string(this.u32()));
    }
    const component = componentOf(name);
    if (!component) throw new UnsupportedUsdError(`usdc 배열 형식(${name}[])을 읽을 수 없습니다.`);
    const total = n * sizeOf(name);
    const Ctor = ARRAY_TYPES[component];
    const bytes = BYTES[component];
    // Copy out: the source may not be aligned for a typed-array view.
    const raw = this.bytesAt(total * bytes).slice();
    return new Ctor(raw.buffer, 0, total);
  }

  private readCompressedArray(name: string, n: number): unknown {
    const component = componentOf(name);
    if (component === "int" || component === "uint" || component === "int64" || component === "uint64") {
      const wide = component === "int64" || component === "uint64";
      const values = this.compressedInts(n, wide);
      if (component === "int") return Int32Array.from(values);
      if (component === "uint") return Uint32Array.from(values.map((v) => v >>> 0));
      if (component === "int64") return BigInt64Array.from(values.map((v) => BigInt(v)));
      return BigUint64Array.from(values.map((v) => BigInt.asUintN(64, BigInt(v))));
    }
    if (component === "half" || component === "float" || component === "double") {
      const code = String.fromCharCode(this.u8());
      const Ctor = ARRAY_TYPES[component];
      if (code === "i") {
        const ints = this.compressedInts(n);
        if (component === "half") return Uint16Array.from(ints.map(halfFromInt));
        return Ctor === Float32Array ? Float32Array.from(ints) : Float64Array.from(ints);
      }
      if (code === "t") {
        const lutSize = this.u32();
        const lut: number[] = [];
        for (let i = 0; i < lutSize; i++) lut.push(this.scalarComponent(component) as number);
        const indexes = this.compressedInts(n);
        const values = indexes.map((i) => lut[i]);
        return component === "half" ? Uint16Array.from(values) : component === "float" ? Float32Array.from(values) : Float64Array.from(values);
      }
      throw new Error(`압축된 실수 배열 코드(${code})를 읽을 수 없습니다.`);
    }
    throw new UnsupportedUsdError(`압축된 배열 형식(${name}[])을 읽을 수 없습니다.`);
  }
}

// ---------------------------------------------------------------- helpers

type ArrayCtor = new (buffer: ArrayBuffer, offset: number, length: number) => ArrayLike<number | bigint>;

const ARRAY_TYPES: Record<string, ArrayCtor> = {
  double: Float64Array,
  float: Float32Array,
  half: Uint16Array,
  int: Int32Array,
  uint: Uint32Array,
  int64: BigInt64Array,
  uint64: BigUint64Array,
  uchar: Uint8Array,
  bool: Uint8Array,
};
const BYTES: Record<string, number> = { double: 8, float: 4, half: 2, int: 4, uint: 4, int64: 8, uint64: 8, uchar: 1, bool: 1 };

export function componentOf(name: string): string | null {
  if (name.startsWith("matrix")) return "double";
  if (name === "quatd") return "double";
  if (name === "quatf") return "float";
  if (name === "quath") return "half";
  if (name === "timecode") return "double";
  const base = componentType(name);
  return base in BYTES ? base : null;
}

export const sizeOf = tupleSize;

function emptyArray(name: string): unknown {
  const component = componentOf(name);
  if (!component) return [];
  const Ctor = ARRAY_TYPES[component];
  return new Ctor(new ArrayBuffer(0), 0, 0);
}

/** Half bits for a small integer (inlined half vectors store int8 components). */
export function halfFromInt(v: number): number {
  return floatToHalf(v);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function floatToHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (((x >> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let half = mant >> shift;
    if ((mant >> (shift - 1)) & 1 && ((mant & ((1 << (shift - 1)) - 1)) || half & 1)) half++;
    return sign | half;
  }
  let half = sign | (exp << 10) | (mant >> 13);
  if (mant & 0x1000 && (mant & 0xfff || half & 1)) half++;
  return half;
}

export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}
