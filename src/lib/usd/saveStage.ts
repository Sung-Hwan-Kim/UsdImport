import type { LoadedStage } from "./loadStage";
import { readLayer, writeLayer } from "./sdf";
import { applyEdits, type PrimEdit } from "./sdf/edits";
import type { AssetSource } from "./sources";
import { collectStageFiles } from "./stageFiles";

/** "usd" is written as binary crate, as OpenUSD does for new .usd files. */
export type SaveFormat = "usda" | "usdc" | "usd";

/**
 * The stage's root layer with the edits authored into it, in the given format.
 * The layer is re-read from its file with the lossless Sdf reader (not the
 * viewer's scene), so everything the file holds is kept; references and
 * sublayers stay as they are.
 */
export async function encodeStageInBrowser(stage: LoadedStage, source: AssetSource, format: SaveFormat, edits: PrimEdit[]): Promise<Uint8Array> {
  if (stage.rootFormat === "usdz") throw new Error("USDZ 패키지는 아직 저장할 수 없습니다.");
  const bytes = await source.read(stage.rootPath);
  if (!bytes) throw new Error(`루트 레이어를 읽을 수 없습니다: ${stage.rootPath}`);
  const layer = readLayer(bytes);
  applyEdits(layer, edits);
  return writeLayer(layer, format === "usda" ? "usda" : "usdc");
}

const CONNECT_TIMEOUT_MS = 1500;
const SAVE_TIMEOUT_MS = 60_000;

/** Whether the local OpenUSD (Newton) server answers at `url`. */
export function probeServer(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }
    const done = (ok: boolean) => {
      clearTimeout(timer);
      ws.onopen = ws.onerror = null;
      ws.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
  });
}

/** Same result through OpenUSD itself, on the local server (server/newton/server.py). */
export async function encodeStageOnServer(
  url: string,
  stage: LoadedStage,
  source: AssetSource,
  rootPath: string,
  format: SaveFormat,
  edits: PrimEdit[],
): Promise<Uint8Array> {
  if (stage.rootFormat === "usdz") throw new Error("USDZ 패키지는 아직 저장할 수 없습니다.");
  const files = await collectStageFiles(stage, source, rootPath);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("OpenUSD 서버가 응답하지 않습니다.")), SAVE_TIMEOUT_MS);
    const finish = (result: Uint8Array | Error) => {
      clearTimeout(timer);
      ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    ws.onerror = () => finish(new Error(`OpenUSD 서버(${url})에 연결할 수 없습니다.`));
    ws.onclose = () => finish(new Error("OpenUSD 서버와의 연결이 끊어졌습니다."));
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        finish(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      const msg = JSON.parse(event.data) as { type: string; message?: string };
      if (msg.type === "error") finish(new Error(`OpenUSD 서버: ${msg.message}`));
    };
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "save",
          root: files.root,
          files: files.entries.map((f) => ({ path: f.path, size: f.bytes.byteLength })),
          format,
          edits: edits.map((e) => ({ ...e, points: e.points ? Array.from(e.points) : undefined })),
        }),
      );
      for (const f of files.entries) ws.send(f.bytes as Uint8Array<ArrayBuffer>);
    };
  });
}

/** File name for the saved stage: the original stem with the format's extension. */
export function savedFileName(stage: LoadedStage, format: SaveFormat): string {
  const stem = stage.name.replace(/\.[^.]+$/, "");
  return `${stem}.${format}`;
}
