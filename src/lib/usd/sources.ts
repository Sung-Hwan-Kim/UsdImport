import { basename, normalizePath } from "./paths";

/**
 * Forgiving path lookup: exact, then case-insensitive, then a unique basename
 * match (handles absolute paths baked in by DCC tools).
 */
export class PathIndex {
  private readonly exact = new Set<string>();
  private readonly lower = new Map<string, string>();
  private readonly byName = new Map<string, string[]>();

  add(rawPath: string): string | null {
    const path = normalizePath(rawPath);
    if (!path || this.exact.has(path)) return null;
    this.exact.add(path);
    this.lower.set(path.toLowerCase(), path);
    const name = basename(path).toLowerCase();
    this.byName.set(name, [...(this.byName.get(name) ?? []), path]);
    return path;
  }

  resolve(rawPath: string): string | null {
    const path = normalizePath(rawPath);
    if (this.exact.has(path)) return path;
    const ci = this.lower.get(path.toLowerCase());
    if (ci) return ci;
    const candidates = this.byName.get(basename(path).toLowerCase());
    return candidates && candidates.length === 1 ? candidates[0] : null;
  }

  paths(): string[] {
    return [...this.exact];
  }
}

/** Somewhere the loader can read layers and textures from, addressed by virtual path. */
export interface AssetSource {
  readonly label: string;
  /** Canonical path for a requested path, or null when it is known not to exist. */
  resolve(path: string): string | null;
  read(path: string): Promise<Uint8Array | null>;
  /** Every known path, when the source can enumerate them. */
  list(): string[];
}

abstract class IndexedSource<T> implements AssetSource {
  protected readonly entries = new Map<string, T>();
  private readonly index = new PathIndex();

  constructor(
    readonly label: string,
    items: Iterable<[string, T]>,
  ) {
    for (const [rawPath, item] of items) {
      const path = this.index.add(rawPath);
      if (path) this.entries.set(path, item);
    }
  }

  resolve(path: string): string | null {
    return this.index.resolve(path);
  }

  list(): string[] {
    return this.index.paths();
  }

  abstract read(path: string): Promise<Uint8Array | null>;
}

export interface LocalFile {
  path: string;
  file: File;
}

export class FileSource extends IndexedSource<File> {
  constructor(files: LocalFile[], label: string) {
    super(
      label,
      files.map((f) => [f.path, f.file]),
    );
  }

  async read(path: string): Promise<Uint8Array | null> {
    const key = this.resolve(path);
    if (!key) return null;
    return new Uint8Array(await this.entries.get(key)!.arrayBuffer());
  }
}

export class MemorySource extends IndexedSource<Uint8Array> {
  constructor(files: Record<string, Uint8Array>, label: string) {
    super(label, Object.entries(files));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const key = this.resolve(path);
    return key ? this.entries.get(key)! : null;
  }
}

/** Reads relative to the origin of a base URL; paths are URL pathnames. */
export class HttpSource implements AssetSource {
  constructor(
    private readonly origin: string,
    readonly label: string,
  ) {}

  resolve(path: string): string | null {
    return normalizePath(path) || null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const encoded = normalizePath(path).split("/").map(encodeURIComponent).join("/");
    try {
      const res = await fetch(new URL(`/${encoded}`, this.origin));
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  list(): string[] {
    return [];
  }
}

/** Split an absolute or page-relative URL into an HttpSource plus the root path inside it. */
export function sourceFromUrl(url: string): { source: HttpSource; rootPath: string } {
  const u = new URL(url, window.location.href);
  const rootPath = normalizePath(decodeURIComponent(u.pathname));
  return { source: new HttpSource(u.origin, u.host), rootPath };
}
