import { Object3D, type Mesh, type Vector3 } from "three";
import { stagePathOf } from "../../scene";
import type { LoadedStage } from "../../usd/loadStage";
import type { AssetSource } from "../../usd/sources";
import type { ClothBinding, EngineLoadResult, PhysicsEngine } from "../engine";

const CONNECT_TIMEOUT_MS = 5000;
// The first load compiles Warp kernels, which can take a while.
const READY_TIMEOUT_MS = 180_000;

interface ReadyMessage {
  type: "ready";
  bodies: string[];
  /** Cloth meshes and their particle ranges. */
  cloths?: { path: string; start: number; count: number }[];
  device: string;
  solver: string;
  dt: number;
  substeps: number;
  upAxis: "Y" | "Z";
  metersPerUnit: number;
  joints: number;
  shapes: number;
  warnings?: string[];
}

type ServerMessage = ReadyMessage | { type: "status"; state: "playing" | "paused" } | { type: "error"; message: string };

export interface NewtonSessionSource {
  source: AssetSource;
  /** Root path as opened by the viewer (a .usdz is sent as-is). */
  rootPath: string;
}

/**
 * Client for the local Newton server (server/newton/server.py). The USD files
 * are uploaded over WebSocket, the server composes them with OpenUSD, steps
 * Newton on its own clock and streams body poses in the stage frame.
 */
export class NewtonEngine implements PhysicsEngine {
  readonly kind = "newton" as const;
  readonly remote = true;

  private ws: WebSocket | null = null;
  private poses: Float32Array | null = null;
  private particles: Float32Array | null = null;
  private simTime = 0;
  private drag: { index: number; local: [number, number, number] } | null = null;
  private particleDrag = false;
  private closedByClient = false;

  constructor(
    private readonly url: string,
    private readonly origin: NewtonSessionSource,
    private readonly onError: (message: string) => void,
  ) {}

  /** The server parses the USD itself, so the viewer's PhysicsDescription is not needed. */
  async load(stage: LoadedStage): Promise<EngineLoadResult> {
    const files = await this.collectFiles(stage);
    const ws = await this.connect();

    const ready = new Promise<ReadyMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Newton 서버가 응답하지 않습니다 (로드 시간 초과).")), READY_TIMEOUT_MS);
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          this.acceptFrame(event.data as ArrayBuffer);
          return;
        }
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === "ready") {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          reject(new Error(`Newton: ${msg.message}`));
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error("Newton 서버와의 연결이 끊어졌습니다."));
      };
    });

    ws.send(
      JSON.stringify({
        type: "load",
        root: files.root,
        files: files.entries.map((f) => ({ path: f.path, size: f.bytes.byteLength })),
        solver: "xpbd",
        substeps: 8,
        fps: 60,
      }),
    );
    for (const f of files.entries) ws.send(f.bytes as Uint8Array<ArrayBuffer>);

    const msg = await ready;
    this.listen(ws);

    // Newton labels bodies with composed-stage prim paths; match them to the viewer's objects.
    const byPath = new Map<string, Object3D>();
    stage.scene.traverse((obj) => {
      if (obj !== stage.scene && !obj.userData.internal) byPath.set(stagePathOf(obj), obj);
    });
    const warnings: string[] = (msg.warnings ?? []).map((w) => `Newton: ${w}`);
    const bodies = msg.bodies.map((path) => {
      const obj = byPath.get(path);
      if (obj) return obj;
      warnings.push(`${path}: 뷰어에서 해당 프림을 찾지 못해 표시하지 않습니다.`);
      return new Object3D();
    });
    const cloths: ClothBinding[] = [];
    for (const { path, start, count } of msg.cloths ?? []) {
      const obj = byPath.get(path);
      if ((obj as Mesh | undefined)?.isMesh) cloths.push({ object: obj!, start, count });
      else warnings.push(`${path}: 뷰어에서 천 메시를 찾지 못해 표시하지 않습니다.`);
    }

    return {
      bodies,
      kinematic: bodies.map(() => false),
      cloths,
      frame: "stage",
      dt: msg.dt,
      label: `Newton · ${msg.device} · ${msg.solver.toUpperCase()}`,
      warnings,
    };
  }

  /** The files the stage was composed from, read back from the viewer's source. */
  private async collectFiles(stage: LoadedStage): Promise<{ root: string; entries: { path: string; bytes: Uint8Array }[] }> {
    const { source, rootPath } = this.origin;
    const paths = stage.rootFormat === "usdz" ? [rootPath] : [...stage.layers.keys()];
    const entries: { path: string; bytes: Uint8Array }[] = [];
    for (const path of paths) {
      const bytes = await source.read(path);
      if (bytes) entries.push({ path, bytes });
    }
    if (!entries.length) throw new Error("Newton 서버로 보낼 USD 파일을 읽지 못했습니다.");
    return { root: stage.rootFormat === "usdz" ? rootPath : stage.rootPath, entries };
  }

  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch {
        reject(new Error(`잘못된 Newton 서버 주소입니다: ${this.url}`));
        return;
      }
      ws.binaryType = "arraybuffer";
      const fail = () => reject(new Error(`Newton 서버(${this.url})에 연결할 수 없습니다. server/newton/README.md를 참고해 서버를 실행하세요.`));
      const timer = setTimeout(() => {
        ws.close();
        fail();
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        fail();
      };
    });
  }

  private listen(ws: WebSocket): void {
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        this.acceptFrame(event.data as ArrayBuffer);
        return;
      }
      const msg = JSON.parse(event.data) as ServerMessage;
      if (msg.type === "error") this.onError(`Newton: ${msg.message}`);
    };
    ws.onclose = () => {
      if (!this.closedByClient) this.onError("Newton 서버와의 연결이 끊어졌습니다.");
    };
  }

  /**
   * Frame layout: [simTime, bodyCount, particleCount,
   * bodyCount × (px, py, pz, qx, qy, qz, qw), particleCount × (x, y, z)].
   */
  private acceptFrame(buffer: ArrayBuffer): void {
    const data = new Float32Array(buffer);
    if (data.length < 3) return;
    const poseEnd = 3 + data[1] * 7;
    this.simTime = data[0];
    this.poses = data.subarray(3, poseEnd);
    this.particles = data.subarray(poseEnd, poseEnd + data[2] * 3);
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  advance(): void {}

  setRunning(running: boolean): void {
    this.send({ type: running ? "play" : "pause" });
  }

  stepFrame(): void {
    this.send({ type: "step" });
  }

  setSpeed(speed: number): void {
    this.send({ type: "speed", value: speed });
  }

  async reset(): Promise<void> {
    this.send({ type: "reset" });
  }

  readPoses(): Float32Array | null {
    return this.poses;
  }

  readParticles(): Float32Array | null {
    return this.particles;
  }

  time(): number {
    return this.simTime;
  }

  setKinematicPose(): void {
    // Newton drives kinematic bodies itself.
  }

  beginDrag(index: number, local: Vector3, target: Vector3): void {
    this.drag = { index, local: [local.x, local.y, local.z] };
    this.send({ type: "drag", body: index, local: this.drag.local, target: [target.x, target.y, target.z] });
  }

  updateDrag(target: Vector3): void {
    if (!this.drag) return;
    this.send({ type: "drag", body: this.drag.index, local: this.drag.local, target: [target.x, target.y, target.z] });
  }

  dragParticle(index: number, target: Vector3): void {
    this.particleDrag = true;
    this.send({ type: "drag_particle", particle: index, target: [target.x, target.y, target.z] });
  }

  endDrag(): void {
    if (!this.drag && !this.particleDrag) return;
    this.drag = null;
    this.particleDrag = false;
    this.send({ type: "drag_end" });
  }

  dispose(): void {
    this.closedByClient = true;
    this.ws?.close();
    this.ws = null;
  }
}
