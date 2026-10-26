import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface ScriptDoc {
  id: string;
  name: string;
  content: string;
  /** Content as last opened or saved; differs from `content` while there are unsaved edits. */
  saved: string;
}

interface ScriptState {
  docs: ScriptDoc[];
  activeId: string | null;
  open: boolean;
  maximized: boolean;
  /** Editor dock height in px. */
  height: number;

  addDoc(name: string, content: string, saved?: string): string;
  closeDoc(id: string): void;
  setActive(id: string): void;
  setContent(id: string, content: string): void;
  markSaved(id: string, content: string, name?: string): void;
  setOpen(open: boolean): void;
  setMaximized(maximized: boolean): void;
  setHeight(height: number): void;
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
    }),
    {
      name: "usd-viewer-scripts",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (s) => ({ docs: s.docs, activeId: s.activeId, open: s.open, height: s.height }),
    },
  ),
);

export const isDirty = (doc: ScriptDoc) => doc.content !== doc.saved;
