import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface ScriptDoc {
  id: string;
  name: string;
  content: string;
  /** Content as last opened or saved; differs from `content` while there are unsaved edits. */
  saved: string;
}

/** Where a script runs: OpenUSD alone on the local server, or Isaac Sim. */
export type RunMode = "pxr" | "isaac";
export type RunChoice = "auto" | RunMode;
export type OutputStream = "stdout" | "stderr" | "info";

export interface OutputChunk {
  stream: OutputStream;
  text: string;
}

export interface ScriptRun {
  docId: string;
  name: string;
  mode: RunMode;
  /** How the server runs it: "pxr", "isaac-snippet" or "isaac-standalone". */
  runner?: string;
  startedAt: number;
}

/** Output kept for the panel; older text is dropped past this many characters. */
const MAX_OUTPUT = 200_000;

interface ScriptState {
  docs: ScriptDoc[];
  activeId: string | null;
  open: boolean;
  maximized: boolean;
  /** Editor dock height in px. */
  height: number;
  runChoice: RunChoice;
  run: ScriptRun | null;
  output: OutputChunk[];
  outputOpen: boolean;

  addDoc(name: string, content: string, saved?: string): string;
  closeDoc(id: string): void;
  setActive(id: string): void;
  setContent(id: string, content: string): void;
  markSaved(id: string, content: string, name?: string): void;
  setOpen(open: boolean): void;
  setMaximized(maximized: boolean): void;
  setHeight(height: number): void;
  setRunChoice(choice: RunChoice): void;
  /** A new run starts with an empty output panel. */
  startRun(run: Omit<ScriptRun, "startedAt">): void;
  updateRun(patch: Partial<ScriptRun>): void;
  endRun(): void;
  appendOutput(stream: OutputStream, text: string): void;
  clearOutput(): void;
  setOutputOpen(open: boolean): void;
}

let nextId = Date.now();

/** Open Isaac Sim scripts. Drafts persist in this browser so a reload loses nothing. */
export const useScripts = create<ScriptState>()(
  persist(
    (set) => ({
      docs: [],
      activeId: null,
      open: false,
      maximized: false,
      height: 320,
      runChoice: "auto",
      run: null,
      output: [],
      outputOpen: false,

      addDoc(name, content, saved = content) {
        const id = `script-${nextId++}`;
        set((s) => ({ docs: [...s.docs, { id, name, content, saved }], activeId: id, open: true }));
        return id;
      },
      closeDoc(id) {
        set((s) => {
          const index = s.docs.findIndex((d) => d.id === id);
          const docs = s.docs.filter((d) => d.id !== id);
          const activeId = s.activeId === id ? (docs[Math.min(index, docs.length - 1)]?.id ?? null) : s.activeId;
          return { docs, activeId };
        });
      },
      setActive(id) {
        set({ activeId: id });
      },
      setContent(id, content) {
        set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, content } : d)) }));
      },
      markSaved(id, content, name) {
        set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, content, saved: content, name: name ?? d.name } : d)) }));
      },
      setOpen(open) {
        set({ open });
      },
      setMaximized(maximized) {
        set({ maximized });
      },
      setHeight(height) {
        set({ height });
      },
      setRunChoice(runChoice) {
        set({ runChoice });
      },
      startRun(run) {
        set({ run: { ...run, startedAt: Date.now() }, output: [], outputOpen: true });
      },
      updateRun(patch) {
        set((s) => (s.run ? { run: { ...s.run, ...patch } } : {}));
      },
      endRun() {
        set({ run: null });
      },
      appendOutput(stream, text) {
        set((s) => {
          const output = s.output.slice();
          const last = output[output.length - 1];
          if (last?.stream === stream) output[output.length - 1] = { stream, text: last.text + text };
          else output.push({ stream, text });
          let size = output.reduce((n, c) => n + c.text.length, 0);
          while (size > MAX_OUTPUT && output.length > 1) size -= output.shift()!.text.length;
          if (size > MAX_OUTPUT) output[0] = { ...output[0], text: output[0].text.slice(size - MAX_OUTPUT) };
          return { output };
        });
      },
      clearOutput() {
        set({ output: [] });
      },
      setOutputOpen(outputOpen) {
        set({ outputOpen });
      },
    }),
    {
      name: "usd-viewer-scripts",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (s) => ({ docs: s.docs, activeId: s.activeId, open: s.open, height: s.height, runChoice: s.runChoice }),
    },
  ),
);

export const isDirty = (doc: ScriptDoc) => doc.content !== doc.saved;
