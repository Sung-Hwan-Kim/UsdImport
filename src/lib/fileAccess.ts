/**
 * Saving files from the browser: the File System Access API where available
 * (Chromium), otherwise a download.
 */

export interface FileType {
  description: string;
  accept: Record<string, string[]>;
}

interface FileAccessWindow {
  showOpenFilePicker?(options: { multiple?: boolean; types?: FileType[] }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options: { suggestedName?: string; types?: FileType[] }): Promise<FileSystemFileHandle>;
}

export function fileAccess(): FileAccessWindow {
  return typeof window === "undefined" ? {} : (window as unknown as FileAccessWindow);
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export function download(name: string, data: BlobPart, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function writeFile(handle: FileSystemFileHandle, data: FileSystemWriteChunkType): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

/**
 * Ask where to save and write the data there; without the API, download it.
 * Resolves with the chosen file name, or null when the user cancelled.
 */
export async function saveAs(
  suggestedName: string,
  data: Uint8Array | string,
  types: FileType[],
  mime: string,
): Promise<{ name: string; downloaded: boolean } | null> {
  const picker = fileAccess().showSaveFilePicker;
  if (!picker) {
    download(suggestedName, data as BlobPart, mime);
    return { name: suggestedName, downloaded: true };
  }
  try {
    const handle = await picker.call(window, { suggestedName, types });
    await writeFile(handle, data as FileSystemWriteChunkType);
    return { name: handle.name, downloaded: false };
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}
