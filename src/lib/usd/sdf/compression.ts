/**
 * Compression used by usdc files: LZ4 blocks wrapped by TfFastCompression,
 * and Usd_IntegerCompression (delta + variable-width codes, then LZ4).
 */

// ---------------------------------------------------------------- LZ4 block

function lz4DecompressBlock(input: Uint8Array, start: number, end: number, output: Uint8Array): number {
  let ip = start;
  let op = 0;
  while (ip < end) {
    const token = input[ip++];
    let literals = token >> 4;
    if (literals === 15) {
      let b: number;
      do {
        b = input[ip++];
        literals += b;
      } while (b === 255 && ip < end);
    }
    output.set(input.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;
    if (ip >= end) break;
    const offset = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    let length = (token & 15) + 4;
    if (length === 19) {
      let b: number;
      do {
        b = input[ip++];
        length += b;
      } while (b === 255 && ip < end);
    }
    if (offset === 0 || offset > op) throw new Error("Corrupt LZ4 data");
    for (let i = 0; i < length; i++, op++) output[op] = output[op - offset];
  }
  return op;
}

const MIN_MATCH = 4;
const LAST_LITERALS = 5;
const MF_LIMIT = 12;
const HASH_BITS = 16;

function writeLength(out: number[], length: number): void {
  while (length >= 255) {
    out.push(255);
    length -= 255;
  }
  out.push(length);
}

/** Greedy LZ4 block compressor (valid for any LZ4 decoder). */
function lz4CompressBlock(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const table = new Int32Array(1 << HASH_BITS).fill(-1);
  const n = input.length;
  const hash = (i: number) =>
    (Math.imul(input[i] | (input[i + 1] << 8) | (input[i + 2] << 16) | (input[i + 3] << 24), 2654435761) >>> (32 - HASH_BITS)) & ((1 << HASH_BITS) - 1);
  let anchor = 0;
  let i = 0;
  const matchLimit = n - MF_LIMIT;
  while (i < matchLimit) {
    const h = hash(i);
    const candidate = table[h];
    table[h] = i;
    if (
      candidate >= 0 &&
      i - candidate <= 0xffff &&
      input[candidate] === input[i] &&
      input[candidate + 1] === input[i + 1] &&
      input[candidate + 2] === input[i + 2] &&
      input[candidate + 3] === input[i + 3]
    ) {
      let length = MIN_MATCH;
      const maxLength = n - LAST_LITERALS - i;
      while (length < maxLength && input[candidate + length] === input[i + length]) length++;
      const literals = i - anchor;
      const matchCode = length - MIN_MATCH;
      out.push((Math.min(literals, 15) << 4) | Math.min(matchCode, 15));
      if (literals >= 15) writeLength(out, literals - 15);
      for (let k = anchor; k < i; k++) out.push(input[k]);
      const offset = i - candidate;
      out.push(offset & 255, offset >> 8);
      if (matchCode >= 15) writeLength(out, matchCode - 15);
      i += length;
      anchor = i;
      continue;
    }
    i++;
  }
  const literals = n - anchor;
  out.push(Math.min(literals, 15) << 4);
  if (literals >= 15) writeLength(out, literals - 15);
  for (let k = anchor; k < n; k++) out.push(input[k]);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- TfFastCompression

/** TfFastCompression: a chunk-count byte (0 = one chunk), then LZ4 data. */
export function decompress(input: Uint8Array, maxSize: number): Uint8Array {
  const output = new Uint8Array(maxSize);
  const chunks = input[0];
  if (chunks === 0) {
    const size = lz4DecompressBlock(input, 1, input.length, output);
    return output.subarray(0, size);
  }
  let header = 1;
  const sizes: number[] = [];
  for (let i = 0; i < chunks; i++, header += 4) {
    sizes.push((input[header] | (input[header + 1] << 8) | (input[header + 2] << 16) | (input[header + 3] << 24)) >>> 0);
  }
  let ip = header;
  let op = 0;
  for (const size of sizes) {
    const part = output.subarray(op);
    op += lz4DecompressBlock(input, ip, ip + size, part);
    ip += size;
  }
  return output.subarray(0, op);
}

export function compress(input: Uint8Array): Uint8Array {
  const block = lz4CompressBlock(input);
  const out = new Uint8Array(block.length + 1);
  out[0] = 0;
  out.set(block, 1);
  return out;
}

// ---------------------------------------------------------------- integer coding

/**
 * Usd_IntegerCompression layout (before LZ4): the most common delta, then
 * 2-bit codes per value (0 = common delta, 1/2/3 = int8/16/32 delta, or
 * int16/32/64 for 64-bit values), then the deltas themselves.
 */
function encodedSize(count: number, wide: boolean): number {
  return (wide ? 8 : 4) + ((count * 2 + 7) >> 3) + count * (wide ? 8 : 4);
}

export function decodeInts(compressed: Uint8Array, count: number, wide = false): number[] {
  if (count === 0) return [];
  const data = decompress(compressed, encodedSize(count, wide));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const common = wide ? Number(view.getBigInt64(0, true)) : view.getInt32(0, true);
  let codes = wide ? 8 : 4;
  let vints = codes + ((count * 2 + 7) >> 3);
  const out = new Array<number>(count);
  let prev = 0;
  for (let i = 0; i < count; ) {
    const byte = data[codes++];
    for (let j = 0; j < 4 && i < count; j++, i++) {
      const code = (byte >> (j * 2)) & 3;
      let delta: number;
      if (code === 0) delta = common;
      else if (code === 1) {
        delta = wide ? view.getInt16(vints, true) : view.getInt8(vints);
        vints += wide ? 2 : 1;
      } else if (code === 2) {
        delta = wide ? view.getInt32(vints, true) : view.getInt16(vints, true);
        vints += wide ? 4 : 2;
      } else {
        delta = wide ? Number(view.getBigInt64(vints, true)) : view.getInt32(vints, true);
        vints += wide ? 8 : 4;
      }
      prev += delta;
      out[i] = prev;
    }
  }
  return out;
}

export function encodeInts(values: ArrayLike<number>, wide = false): Uint8Array {
  const count = values.length;
  const deltas = new Array<number>(count);
  const frequency = new Map<number, number>();
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const d = values[i] - prev;
    prev = values[i];
    deltas[i] = d;
    frequency.set(d, (frequency.get(d) ?? 0) + 1);
  }
  let common = 0;
  let best = -1;
  for (const [d, f] of frequency) {
    if (f > best) {
      best = f;
      common = d;
    }
  }
  const buffer = new Uint8Array(encodedSize(count, wide));
  const view = new DataView(buffer.buffer);
  if (wide) view.setBigInt64(0, BigInt(common), true);
  else view.setInt32(0, common, true);
  const codes = wide ? 8 : 4;
  let vints = codes + ((count * 2 + 7) >> 3);
  const [small, mid] = wide ? [32767, 2147483647] : [127, 32767];
  for (let i = 0; i < count; i++) {
    const d = deltas[i];
    let code: number;
    if (d === common) code = 0;
    else if (d >= -small - 1 && d <= small) {
      code = 1;
      if (wide) view.setInt16(vints, d, true);
      else view.setInt8(vints, d);
      vints += wide ? 2 : 1;
    } else if (d >= -mid - 1 && d <= mid) {
      code = 2;
      if (wide) view.setInt32(vints, d, true);
      else view.setInt16(vints, d, true);
      vints += wide ? 4 : 2;
    } else {
      code = 3;
      if (wide) view.setBigInt64(vints, BigInt(d), true);
      else view.setInt32(vints, d, true);
      vints += wide ? 8 : 4;
    }
    buffer[codes + (i >> 2)] |= code << ((i & 3) * 2);
  }
  return compress(buffer.subarray(0, vints));
}
