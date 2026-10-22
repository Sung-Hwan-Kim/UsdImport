import { USDCParser, type CrateValueRep } from "three/examples/jsm/loaders/usd/USDCParser.js";

// Crate value types three's parser leaves unread (crateDataTypes.h).
const TokenListOp = 32;
const StringListOp = 33;
const ReferenceListOp = 35;
const Payload = 47;
const LayerOffsetVector = 49;
const StringVector = 50;
const PayloadListOp = 55;

// Vectors whose components are all small integers are inlined as int8s; three
// only decodes the float/int variants. Type enum -> component count.
const INLINED_INT8_VECTORS: Record<number, number> = {
  19: 2, // Vec2d
  23: 3, // Vec3d
  25: 3, // Vec3h
  27: 4, // Vec4d
  29: 4, // Vec4h
};

// SdfListOp header bits.
const HAS_EXPLICIT = 1 << 1;
const HAS_ADDED = 1 << 2;
const HAS_DELETED = 1 << 3;
const HAS_ORDERED = 1 << 4;
const HAS_PREPENDED = 1 << 5;
const HAS_APPENDED = 1 << 6;

interface AssetArc {
  assetPath: string;
  primPath: string;
}

function encodeArc(arc: AssetArc): string {
  return `@${arc.assetPath}@${arc.primPath ? `<${arc.primPath}>` : ""}`;
}

/**
 * USDCParser plus the composition-arc value types it skips: references,
 * payloads, subLayers and token list ops. Arcs are emitted in the same
 * "@path@<prim>" string form the USDA parser produces, which is what
 * USDComposer understands.
 */
export class CrateParser extends USDCParser {
  /**
   * The PATHS section stores the path-table size, then the number of encoded
   * paths. They differ when the table holds paths that are not in the spec tree
   * (e.g. variant sets, relationship targets); three decodes with the first
   * count and misaligns everything. Make both counts equal while three reads.
   */
  protected override _readPaths(): void {
    const section = this.sections.PATHS;
    const { major, minor } = this.version;
    if (!section || (major === 0 && minor < 4)) return super._readPaths();
    const view = new DataView(this.buffer);
    const total = view.getBigUint64(section.start, true);
    const encoded = view.getBigUint64(section.start + 8, true);
    if (total === encoded) return super._readPaths();
    view.setBigUint64(section.start, encoded, true);
    try {
      super._readPaths();
    } finally {
      view.setBigUint64(section.start, total, true);
    }
    while (this.paths.length < Number(total)) this.paths.push("");
  }

  protected override _readInlinedValue(valueRep: CrateValueRep): unknown {
    const count = INLINED_INT8_VECTORS[valueRep.typeEnum];
    if (!count) return super._readInlinedValue(valueRep);
    const bits = valueRep.getInlinedValue();
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push((((bits >>> (8 * i)) & 0xff) << 24) >> 24);
    return out;
  }

  protected override _readScalarValue(type: number): unknown {
    switch (type) {
      case ReferenceListOp: {
        const arcs = this.readListOp(() => this.readReference()).filter((a) => a.assetPath);
        return arcs.length ? [arcs.map(encodeArc).join(", ")] : null;
      }
      case PayloadListOp: {
        const arcs = this.readListOp(() => this.readPayload()).filter((a) => a.assetPath);
        return arcs.length ? encodeArc(arcs[0]) : null;
      }
      case Payload: {
        const arc = this.readPayload();
        return arc.assetPath ? encodeArc(arc) : null;
      }
      case StringVector:
        return this.readVector(() => this.readString());
      case LayerOffsetVector:
        return this.readVector(() => [this.reader.readFloat64(), this.reader.readFloat64()]);
      case TokenListOp:
        return this.readListOp(() => this.tokens[this.reader.readUint32()] ?? "");
      case StringListOp:
        return this.readListOp(() => this.readString());
      default:
        return super._readScalarValue(type);
    }
  }

  private readString(): string {
    const index = this.reader.readUint32();
    return this.tokens[this.strings[index]] ?? "";
  }

  private readVector<T>(readItem: () => T): T[] {
    const count = this.reader.readUint64();
    const out: T[] = [];
    for (let i = 0; i < count; i++) out.push(readItem());
    return out;
  }

  /** Flattens a single-layer list op into its effective item order. */
  private readListOp<T>(readItem: () => T): T[] {
    const flags = this.reader.readUint8();
    const explicit = flags & HAS_EXPLICIT ? this.readVector(readItem) : null;
    const added = flags & HAS_ADDED ? this.readVector(readItem) : [];
    const prepended = flags & HAS_PREPENDED ? this.readVector(readItem) : [];
    const appended = flags & HAS_APPENDED ? this.readVector(readItem) : [];
    if (flags & HAS_DELETED) this.readVector(readItem);
    if (flags & HAS_ORDERED) this.readVector(readItem);
    return explicit ?? [...prepended, ...added, ...appended];
  }

  private readReference(): AssetArc {
    const assetPath = this.readString();
    const primPath = this.paths[this.reader.readUint32()] ?? "";
    this.reader.readFloat64(); // layer offset
    this.reader.readFloat64(); // layer scale
    this.skipDictionary(); // customData
    return { assetPath, primPath };
  }

  private readPayload(): AssetArc {
    const assetPath = this.readString();
    const primPath = this.paths[this.reader.readUint32()] ?? "";
    const { major, minor } = this.version;
    if (major > 0 || minor >= 8) {
      this.reader.readFloat64();
      this.reader.readFloat64();
    }
    return { assetPath, primPath };
  }

  private skipDictionary(): void {
    const count = this.reader.readUint64();
    for (let i = 0; i < count; i++) {
      this.reader.readUint32(); // key
      // Values are written recursively: int64 forward offset to the ValueRep,
      // and the next entry starts right after that ValueRep.
      const start = this.reader.tell();
      const offset = this.reader.readInt64();
      this.reader.seek(start + offset + 8);
    }
  }
}
