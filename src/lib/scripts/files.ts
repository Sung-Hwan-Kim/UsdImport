import { download, fileAccess, isAbort, writeFile, type FileType } from "../fileAccess";
import { useScripts } from "./store";

const PYTHON: FileType[] = [{ description: "Python 스크립트", accept: { "text/x-python": [".py"] } }];

/** Where each open script was read from or last saved to, for saving in place (this session only). */
const handles = new Map<string, FileSystemFileHandle>();

export const isScriptFile = (name: string) => /\.pyw?$/i.test(name);

export function hasFileHandle(id: string): boolean {
  return handles.has(id);
}

/** Open text files as scripts, reusing an open tab with the same name and saved content. */
export async function openScriptFiles(files: { file: File; handle?: FileSystemFileHandle }[]): Promise<void> {
  const { docs, addDoc, setActive, setOpen } = useScripts.getState();
  for (const { file, handle } of files) {
    const content = await file.text();
    const existing = docs.find((d) => d.name === file.name && d.saved === content);
    const id = existing?.id ?? addDoc(file.name, content);
    if (existing) setActive(existing.id);
    if (handle) handles.set(id, handle);
  }
  setOpen(true);
}

/** Pick .py files (call from a user gesture). */
export async function pickScripts(): Promise<void> {
  const picker = fileAccess().showOpenFilePicker;
  if (picker) {
    try {
      const picked = await picker.call(window, { multiple: true, types: PYTHON });
      await openScriptFiles(await Promise.all(picked.map(async (handle) => ({ file: await handle.getFile(), handle }))));
    } catch (e) {
      if (!isAbort(e)) throw e;
    }
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".py,.pyw,text/x-python";
  input.addEventListener("change", () => {
    if (input.files?.length) void openScriptFiles(Array.from(input.files).map((file) => ({ file })));
  });
  input.click();
}

/**
 * Save a script: in place when it came from (or was saved to) a file this
 * session, otherwise through a save dialog, or as a download where the
 * browser has no file access.
 */
export async function saveScript(id: string, { as = false }: { as?: boolean } = {}): Promise<"saved" | "downloaded" | "cancelled"> {
  const doc = useScripts.getState().docs.find((d) => d.id === id);
  if (!doc) return "cancelled";
  const content = doc.content;
  try {
    let handle = as ? undefined : handles.get(id);
    if (!handle) {
      const picker = fileAccess().showSaveFilePicker;
      if (!picker) {
        download(doc.name, content, "text/x-python");
        useScripts.getState().markSaved(id, content);
        return "downloaded";
      }
      handle = await picker.call(window, { suggestedName: doc.name, types: PYTHON });
      handles.set(id, handle);
    }
    await writeFile(handle, content);
    useScripts.getState().markSaved(id, content, handle.name);
    return "saved";
  } catch (e) {
    if (isAbort(e)) return "cancelled";
    throw e;
  }
}

export function forgetHandle(id: string): void {
  handles.delete(id);
}
