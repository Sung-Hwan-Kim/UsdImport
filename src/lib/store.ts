import type { Object3D } from "three";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { filesFromInput, labelForFiles, rankRootCandidates } from "./files";
import type { Shading } from "./scene";
import { disposeStage, loadStage, type LoadedStage } from "./usd/loadStage";
import { FileSource, sourceFromUrl, type AssetSource, type LocalFile } from "./usd/sources";

export type EnvironmentPreset =
  | "room"
  | "studio"
  | "city"
  | "sunset"
  | "dawn"
  | "warehouse"
  | "forest"
  | "apartment"
  | "lobby"
  | "night"
  | "park"
  | "none";

export type UpAxisMode = "auto" | "Y" | "Z";

export interface ViewSettings {
  shading: Shading;
  environment: EnvironmentPreset;
  environmentIntensity: number;
  environmentBackground: boolean;
  exposure: number;
  grid: boolean;
  axes: boolean;
  shadows: boolean;
  sceneLights: boolean;
  autoRotate: boolean;
  upAxis: UpAxisMode;
  stats: boolean;
}

export interface StageBounds {
  center: [number, number, number];
  size: [number, number, number];
  radius: number;
  floorY: number;
}

export interface AnimationState {
  playing: boolean;
  time: number;
  duration: number;
  speed: number;
  loop: boolean;
}

interface Session {
  source: AssetSource;
  rootPath: string;
  candidates: string[];
}

interface ViewerState {
  loading: boolean;
  progress: string;
  error: string | null;
  stage: LoadedStage | null;
  session: Session | null;
  bounds: StageBounds | null;
  selected: Object3D | null;
  /** Bumped whenever object visibility changes outside React. */
  revision: number;
  focus: { target: "stage" | "selection"; reset: boolean; nonce: number };
  settings: ViewSettings;
  animation: AnimationState;
  panels: { hierarchy: boolean; inspector: boolean };
  canvas: HTMLCanvasElement | null;

  openSource(source: AssetSource, rootPath: string, candidates?: string[]): Promise<void>;
  openFiles(files: LocalFile[]): Promise<void>;
  openFileList(list: FileList): Promise<void>;
  openUrl(url: string): Promise<void>;
  switchRoot(rootPath: string): Promise<void>;
  select(obj: Object3D | null): void;
  requestFocus(target: "stage" | "selection", reset?: boolean): void;
  setSetting<K extends keyof ViewSettings>(key: K, value: ViewSettings[K]): void;
  setBounds(bounds: StageBounds | null): void;
  setVisible(obj: Object3D, visible: boolean): void;
  showAll(): void;
  setAnimation(patch: Partial<AnimationState>): void;
  togglePanel(panel: "hierarchy" | "inspector"): void;
  setCanvas(canvas: HTMLCanvasElement | null): void;
  clearError(): void;
}

const DEFAULT_SETTINGS: ViewSettings = {
  shading: "pbr",
  environment: "room",
  environmentIntensity: 0.6,
  environmentBackground: false,
  exposure: 1,
  grid: true,
  axes: false,
  shadows: true,
  sceneLights: true,
  autoRotate: false,
  upAxis: "auto",
  stats: false,
};

let loadToken = 0;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useViewer = create<ViewerState>()(
  persist(
    (set, get) => ({
      loading: false,
      progress: "",
      error: null,
      stage: null,
      session: null,
      bounds: null,
      selected: null,
      revision: 0,
      focus: { target: "stage", reset: true, nonce: 0 },
      settings: DEFAULT_SETTINGS,
      animation: { playing: false, time: 0, duration: 0, speed: 1, loop: true },
      panels: { hierarchy: true, inspector: true },
      canvas: null,

      async openSource(source, rootPath, candidates = [rootPath]) {
        const token = ++loadToken;
        set({ loading: true, progress: "불러오는 중…", error: null });
        try {
          const stage = await loadStage(source, rootPath, {
            onProgress: (progress) => token === loadToken && set({ progress }),
          });
          if (token !== loadToken) {
            disposeStage(stage);
            return;
          }
          const previous = get().stage;
          const duration = stage.animations.reduce((max, clip) => Math.max(max, clip.duration), 0);
          set((s) => ({
            stage,
            loading: false,
            progress: "",
            selected: null,
            bounds: null,
            session: { source, rootPath, candidates },
            animation: { ...s.animation, playing: duration > 0, time: 0, duration },
            focus: { target: "stage", reset: true, nonce: s.focus.nonce + 1 },
          }));
          // Free GPU resources once the old scene has left the render tree.
          if (previous) setTimeout(() => disposeStage(previous), 500);
        } catch (e) {
          if (token !== loadToken) return;
          console.error(e);
          set({ loading: false, progress: "", error: errorMessage(e) });
        }
      },

      async openFiles(files) {
        const candidates = rankRootCandidates(files.map((f) => f.path));
        if (!candidates.length) {
          set({ error: "USD 파일(.usd, .usda, .usdc, .usdz)이 없습니다." });
          return;
        }
        const source = new FileSource(files, labelForFiles(files));
        await get().openSource(source, candidates[0], candidates);
      },

      async openFileList(list) {
        await get().openFiles(filesFromInput(list));
      },

      async openUrl(url) {
        try {
          const { source, rootPath } = sourceFromUrl(url);
          await get().openSource(source, rootPath);
        } catch (e) {
          set({ error: errorMessage(e) });
        }
      },

      async switchRoot(rootPath) {
        const session = get().session;
        if (session) await get().openSource(session.source, rootPath, session.candidates);
      },

      select(obj) {
        set({ selected: obj });
      },

      requestFocus(target, reset = false) {
        set((s) => ({ focus: { target, reset, nonce: s.focus.nonce + 1 } }));
      },

      setSetting(key, value) {
        set((s) => ({ settings: { ...s.settings, [key]: value } }));
      },

      setBounds(bounds) {
        set({ bounds });
      },

      setVisible(obj, visible) {
        obj.visible = visible;
        set((s) => ({ revision: s.revision + 1 }));
      },

      showAll() {
        get().stage?.scene.traverse((o) => {
          if (!(o as { isLight?: boolean }).isLight) o.visible = true;
        });
        set((s) => ({ revision: s.revision + 1 }));
      },

      setAnimation(patch) {
        set((s) => ({ animation: { ...s.animation, ...patch } }));
      },

      togglePanel(panel) {
        set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } }));
      },

      setCanvas(canvas) {
        set({ canvas });
      },

      clearError() {
        set({ error: null });
      },
    }),
    {
      name: "usd-viewer-settings",
      version: 1,
      // Older persisted settings are dropped in favour of the current defaults.
      migrate: () => ({}),
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ settings: s.settings, panels: s.panels }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<ViewerState, "settings" | "panels">>;
        return {
          ...current,
          settings: { ...current.settings, ...p.settings },
          panels: { ...current.panels, ...p.panels },
        };
      },
    },
  ),
);
