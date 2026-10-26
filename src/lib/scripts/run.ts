import type { Object3D } from "three";
import { stagePathOf } from "../scene";
import { useViewer } from "../store";
import { MemorySource, OverlaySource } from "../usd/sources";
import { collectStageFiles } from "../usd/stageFiles";
import { useScripts, type RunMode } from "./store";

// Scripts run on the local server (server/newton/server.py, `npm run newton`),
// with OpenUSD alone ("pxr") or Isaac Sim; see server/newton/scripts.py.

/** Isaac Sim's own app, or Kit / Isaac Sim modules other than omni.usd, need Isaac Sim. */
const NEEDS_ISAAC_SIM = /\bSimulationApp\b|^\s*(?:from|import)\s+(?:isaacsim|carb|omni\.(?!usd\b))/m;

export function detectRunMode(code: string): RunMode {
  return NEEDS_ISAAC_SIM.test(code) ? "isaac" : "pxr";
}

export const RUN_MODE_LABEL: Record<RunMode, string> = { pxr: "pxr", isaac: "Isaac Sim" };

type ServerMessage =
  | { type: "run_started"; runner: "pxr" | "isaac-snippet" | "isaac-standalone" }
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "stage"; name: string; new: boolean }
  | { type: "run_done"; code: number | null; stopped: boolean; seconds: number }
  | { type: "error"; message: string };

const RUNNER_NOTE: Record<string, string> = {
  "isaac-snippet": "Isaac Sim을 헤드리스로 시작합니다. 처음에는 30초 넘게 걸릴 수 있습니다.",
  "isaac-standalone": "Standalone 스크립트를 Isaac Sim의 Python으로 그대로 실행합니다. 뷰어의 스테이지 경로는 환경 변수 USD_VIEWER_STAGE에 있습니다.",
};

// An older server ignores "run" messages; stop waiting for it after this long.
const START_TIMEOUT_MS = 20_000;

let socket: WebSocket | null = null;

function findByStagePath(root: Object3D, path: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((o) => {
    if (!found && stagePathOf(o) === path) found = o;
  });
  return found;
}

function info(text: string): void {
  useScripts.getState().appendOutput("info", `${text}\n`);
}

/** Open the stage a script handed back, keeping the view and the selection. */
async function openResult(name: string, bytes: Uint8Array, isNew: boolean, session: ReturnType<typeof useViewer.getState>["session"]): Promise<void> {
  const viewer = useViewer.getState();
  if (isNew) {
    await viewer.openSource(new MemorySource({ [name]: bytes }, name), name);
    info(`스크립트가 만든 새 스테이지(${name})를 열었습니다.`);
    return;
  }
  if (!session || viewer.session !== session) {
    info("실행하는 동안 다른 스테이지를 열어서, 스크립트의 변경 사항은 반영하지 않았습니다.");
    return;
  }
  const selected = viewer.selected ? stagePathOf(viewer.selected) : null;
  await viewer.openSource(new OverlaySource(session.source, { [session.rootPath]: bytes }), session.rootPath, session.candidates, { keepView: true });
  const { stage, select } = useViewer.getState();
  const match = selected && stage ? findByStagePath(stage.scene, selected) : null;
  if (match) select(match);
  info("스크립트가 바꾼 스테이지를 다시 불러왔습니다. 파일로 남기려면 스테이지 저장을 쓰세요.");
}

/** Run a script tab on the local server; output and the result land in the scripts store. */
export async function runScript(docId: string): Promise<void> {
  const scripts = useScripts.getState();
  const doc = scripts.docs.find((d) => d.id === docId);
  if (!doc || scripts.run) return;
  const mode = scripts.runChoice === "auto" ? detectRunMode(doc.content) : scripts.runChoice;
  const { stage, session, settings } = useViewer.getState();
  const url = settings.newtonUrl;
  scripts.startRun({ docId, name: doc.name, mode });
  info(`▶ ${doc.name} — ${RUN_MODE_LABEL[mode]}로 실행 · ${stage ? stage.name : "새 스테이지"}`);

  let files: Awaited<ReturnType<typeof collectStageFiles>> | null = null;
  try {
    if (stage && session) files = await collectStageFiles(stage, session.source, session.rootPath);
  } catch (e) {
    scripts.appendOutput("stderr", `스테이지 파일을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}\n`);
    scripts.endRun();
    return;
  }

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  socket = ws;
  let pending: { name: string; new: boolean } | null = null;
  let done = false;
  let started = false;
  let startTimer = 0;
  // Stage results reload in order, before the run is reported done.
  let reload = Promise.resolve();

  function finish(error?: string, summary?: string) {
    window.clearTimeout(startTimer);
    if (error) useScripts.getState().appendOutput("stderr", `${error}\n`);
    if (summary) info(summary);
    useScripts.getState().endRun();
    if (socket === ws) socket = null;
  }

  ws.onerror = () => {
    if (done) return;
    done = true;
    finish(`로컬 서버(${url})에 연결할 수 없습니다. 터미널에서 \`npm run newton\`으로 서버를 실행하세요.`);
  };
  ws.onclose = () => {
    if (done) return;
    done = true;
    finish("서버와의 연결이 끊어졌습니다.");
  };
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "run",
        mode,
        name: doc.name,
        script: doc.content,
        root: files?.root ?? null,
        files: files?.entries.map((f) => ({ path: f.path, size: f.bytes.byteLength })) ?? [],
      }),
    );
    for (const f of files?.entries ?? []) ws.send(f.bytes as Uint8Array<ArrayBuffer>);
    startTimer = window.setTimeout(() => {
      if (done || started) return;
      done = true;
      ws.close();
      finish("서버가 스크립트 실행 요청에 응답하지 않습니다. 이 기능보다 오래된 서버라면 `npm run newton`을 다시 시작하세요.");
    }, START_TIMEOUT_MS);
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") {
      const result = pending;
      pending = null;
      if (!result) return;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      reload = reload.then(() => openResult(result.name, bytes, result.new, session)).catch((e) => finish(`스테이지를 다시 불러오지 못했습니다: ${e}`));
      return;
    }
    const msg = JSON.parse(event.data) as ServerMessage;
    const store = useScripts.getState();
    switch (msg.type) {
      case "run_started":
        started = true;
        store.updateRun({ runner: msg.runner });
        if (RUNNER_NOTE[msg.runner]) info(RUNNER_NOTE[msg.runner]);
        break;
      case "output":
        store.appendOutput(msg.stream, msg.text);
        break;
      case "stage":
        pending = { name: msg.name, new: msg.new };
        break;
      case "run_done":
        done = true;
        ws.close();
        void reload.then(() =>
          finish(undefined, msg.stopped ? "■ 중지했습니다." : `■ 끝 — 종료 코드 ${msg.code ?? "?"} · ${msg.seconds.toFixed(1)}초`),
        );
        break;
      case "error":
        done = true;
        ws.close();
        // A server from before script running rejects the stage upload that follows the ignored request.
        finish(started ? `서버: ${msg.message}` : `서버: ${msg.message}\n이 기능보다 오래된 서버라면 \`npm run newton\`을 다시 시작하세요.`);
        break;
    }
  };
}

/** Ask the server to stop the running script (and the Isaac Sim it started). */
export function stopScript(): void {
  const ws = socket;
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
  } else {
    // Still connecting: nothing runs yet.
    ws.close();
  }
}
