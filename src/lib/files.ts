import { basename, extensionOf, isLayerFile } from "./usd/paths";
import type { LocalFile } from "./usd/sources";

function readEntry(entry: FileSystemEntry, prefix: string, out: LocalFile[]): Promise<void> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(
        (file) => {
          out.push({ path: prefix + entry.name, file });
          resolve();
        },
        () => resolve(),
      );
    });
  }
  if (!entry.isDirectory) return Promise.resolve();
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const dir = `${prefix}${entry.name}/`;
  return new Promise((resolve) => {
    const pending: Promise<void>[] = [];
    // readEntries returns results in batches until it yields an empty one.
    const next = () =>
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            Promise.all(pending).then(() => resolve());
            return;
          }
          for (const child of batch) pending.push(readEntry(child, dir, out));
          next();
        },
        () => Promise.all(pending).then(() => resolve()),
      );
    next();
  });
}

/** Must be called synchronously from the drop handler (items expire after the event). */
export function filesFromDataTransfer(dt: DataTransfer): Promise<LocalFile[]> {
  const entries = Array.from(dt.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) {
    return Promise.resolve(Array.from(dt.files).map((file) => ({ path: file.name, file })));
  }
  const out: LocalFile[] = [];
  return Promise.all(entries.map((e) => readEntry(e, "", out))).then(() => out);
}

export function filesFromInput(list: FileList): LocalFile[] {
  return Array.from(list).map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

const ACCEPT = ".usd,.usda,.usdc,.usdz,.png,.jpg,.jpeg,.webp,.avif,.gif,.bmp";

/** Open the native picker (call from a user gesture); resolves only when files are chosen. */
export function pickLocalFiles(directory: boolean): Promise<LocalFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (directory) input.webkitdirectory = true;
    else input.accept = ACCEPT;
    input.addEventListener("change", () => {
      if (input.files?.length) resolve(filesFromInput(input.files));
    });
    input.click();
  });
}

const ROOT_HINT = /(^|[_\-.])(root|main|scene|stage|shot|assembly|set|world)([_\-.]|$)/i;
const PART_HINT = /(^|[_\-.])(geo|geom|mesh|mtl|mat|material|look|looks|payload|proxy|layer|sublayer|anim|skel|rig|lod\d*)([_\-.]|$)/i;

/** Order USD files by how likely each is to be the stage the user wants to open. */
export function rankRootCandidates(paths: string[]): string[] {
  const score = (p: string) => {
    const depth = p.split("/").length - 1;
    const name = basename(p).replace(/\.[^.]+$/, "");
    const ext = extensionOf(p);
    let s = depth * 10;
    if (ext === "usdz") s -= 3;
    if (ROOT_HINT.test(name)) s -= 4;
    if (PART_HINT.test(name)) s += 4;
    return s;
  };
  return paths.filter(isLayerFile).sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/** Label for a drop: the common top folder, or the file name for a single file. */
export function labelForFiles(files: LocalFile[]): string {
  if (files.length === 1) return files[0].path;
  const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (tops.size === 1) {
    const [top] = tops;
    if (top) return `${top}/`;
  }
  return `파일 ${files.length}개`;
}
