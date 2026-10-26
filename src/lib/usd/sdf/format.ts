import { floatToHalf, halfToFloat } from "./crateReader";

/** Shortest decimal text that parses back to the same float32. */
export function formatFloat(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (Object.is(v, -0)) return "-0";
  for (let p = 1; p <= 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) === v) return String(s);
  }
  return String(v);
}

export function formatDouble(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}

/** Shortest decimal text for raw half bits that converts back to the same half. */
export function formatHalf(bits: number): string {
  const v = halfToFloat(bits);
  if (Number.isNaN(v) || !Number.isFinite(v) || Object.is(v, -0)) return formatDouble(v);
  for (let p = 1; p <= 6; p++) {
    const s = Number(v.toPrecision(p));
    if (s === v || halfToFloat(floatToHalf(s)) === v) return String(s);
  }
  return String(v);
}

/** A USDA string literal. */
export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = ch.codePointAt(0)!;
        out += code < 0x20 ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
      }
    }
  }
  return `${out}"`;
}

export function assetLiteral(path: string): string {
  return path.includes("@") ? `@@@${path.replace(/@@@/g, "\\@@@")}@@@` : `@${path}@`;
}

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*$/;
