// Virtual-path helpers. Every asset lives in a flat namespace of forward-slash
// paths relative to a "virtual root" (the dropped folder, the URL origin or the
// inside of a .usdz archive).

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export const LAYER_EXTENSIONS = ["usd", "usda", "usdc", "usdz"] as const;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp"] as const;
export const UNSUPPORTED_IMAGE_EXTENSIONS = ["exr", "hdr", "tga", "tif", "tiff", "ktx", "ktx2", "dds", "tx"] as const;

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

export function isUrl(path: string): boolean {
  // A Windows drive letter ("C:/...") is not a URL scheme.
  return URL_SCHEME.test(path) && !/^[a-z]:[\\/]/i.test(path);
}

/** Collapse `.`/`..`, backslashes and duplicate slashes; never escapes the virtual root. */
export function normalizePath(path: string): string {
  let s = path.trim().replace(/\\/g, "/");
  if (s.startsWith("@") && s.endsWith("@") && s.length > 1) s = s.slice(1, -1);
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

export function joinPath(dir: string, relative: string): string {
  const rel = relative.replace(/\\/g, "/");
  if (rel.startsWith("/")) return normalizePath(rel);
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}

/** Path from `fromDir` to `to`, both virtual paths. */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split("/") : [];
  const target = to.split("/");
  let i = 0;
  while (i < from.length && i < target.length - 1 && from[i] === target[i]) i++;
  const up = from.slice(i).map(() => "..");
  return [...up, ...target.slice(i)].join("/") || ".";
}

export function isLayerFile(path: string): boolean {
  return (LAYER_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

export function isImageFile(path: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

export function isUnsupportedImage(path: string): boolean {
  return (UNSUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
