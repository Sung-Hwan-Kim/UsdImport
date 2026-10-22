export function formatNumber(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  const fixed = n.toFixed(digits).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return n.toLocaleString("en-US");
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function isNumberArray(v: ArrayLike<unknown>): v is ArrayLike<number> {
  return v.length > 0 && typeof v[0] === "number";
}

/** Scalars per element for a USD value type, e.g. point3f[] -> 3, matrix4d -> 16. */
function componentsOf(typeName: string): number {
  const base = typeName.replace("[]", "");
  const matrix = /^matrix([234])d/.exec(base);
  if (matrix) return Number(matrix[1]) ** 2;
  if (base.startsWith("quat")) return 4;
  const vec = /([234])[dfhi]$/.exec(base);
  return vec ? Number(vec[1]) : 1;
}

const tuple = (arr: ArrayLike<number>, start: number, n: number) =>
  `(${Array.from({ length: n }, (_, i) => formatNumber(arr[start + i], 3)).join(", ")})`;

/** Compact one-line rendering of a USD field value for the inspector. */
export function formatValue(v: unknown, typeName = ""): string {
  if (v === undefined) return "—";
  if (v === null) return "None";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v === "" ? '""' : v.length > 160 ? `${v.slice(0, 157)}…` : v;
  if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    const arr = v as unknown as ArrayLike<unknown>;
    if (arr.length === 0) return "[]";
    // Vector arrays arrive flattened; report and preview whole elements.
    const n = componentsOf(typeName);
    if (typeName.endsWith("[]") && n > 1 && isNumberArray(arr) && arr.length % n === 0) {
      const count = arr.length / n;
      if (count <= 2) return `[${Array.from({ length: count }, (_, i) => tuple(arr, i * n, n)).join(", ")}]`;
      return `[${count.toLocaleString("en-US")}]`;
    }
    if (isNumberArray(arr) && arr.length <= 4) return `(${Array.from(arr, (x) => formatNumber(x, 3)).join(", ")})`;
    if (isNumberArray(arr) && arr.length === 16) return `matrix4 (${Array.from(arr).slice(12, 15).map((x) => formatNumber(x, 3)).join(", ")} …)`;
    if (arr.length <= 3 && Array.from(arr).every((x) => typeof x === "string")) return `[${Array.from(arr).join(", ")}]`;
    return `[${arr.length.toLocaleString("en-US")}]`;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.times)) {
      const times = o.times as number[];
      return `${times.length} 샘플 · t ${formatNumber(times[0] ?? 0)}–${formatNumber(times[times.length - 1] ?? 0)}`;
    }
    const json = JSON.stringify(v);
    return json.length > 160 ? `${json.slice(0, 157)}…` : json;
  }
  return String(v);
}
