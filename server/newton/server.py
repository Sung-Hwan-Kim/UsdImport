"""Local NVIDIA Newton physics server for the USD web viewer.

The browser uploads the stage's USD files over a WebSocket; this server
composes them with OpenUSD, builds a Newton model from the UsdPhysics schema,
steps it in real time and streams rigid body poses back.

    python server/newton/server.py --device cuda:0

Protocol (JSON text messages + binary frames), see server/newton/README.md.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import tempfile
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath

import numpy as np
import warp as wp
from pxr import Gf, Usd, UsdGeom, UsdPhysics
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

import newton

MAX_UPLOAD_BYTES = 1 << 30
# Mouse spring as accelerations (1/s^2, 1/s), independent of body mass and stage units.
DRAG_STIFFNESS = 400.0
DRAG_DAMPING = 40.0


@wp.kernel
def apply_drag(
    body_q: wp.array(dtype=wp.transform),
    body_qd: wp.array(dtype=wp.spatial_vector),
    body_com: wp.array(dtype=wp.vec3),
    body_mass: wp.array(dtype=float),
    drag_body: wp.array(dtype=int),
    drag_points: wp.array(dtype=wp.vec3),
    stiffness: float,
    damping: float,
    body_f: wp.array(dtype=wp.spatial_vector),
):
    """Spring-damper pulling the grab point (drag_points[0], body frame) to drag_points[1] (world)."""
    i = drag_body[0]
    if i < 0:
        return
    tf = body_q[i]
    point = wp.transform_point(tf, drag_points[0])
    com = wp.transform_point(tf, body_com[i])
    qd = body_qd[i]
    # body_qd: linear velocity of the COM, then angular velocity, both in world frame.
    velocity = wp.spatial_top(qd) + wp.cross(wp.spatial_bottom(qd), point - com)
    force = body_mass[i] * (stiffness * (drag_points[1] - point) - damping * velocity)
    # body_f: force at the COM, then torque, both in world frame.
    body_f[i] = body_f[i] + wp.spatial_vector(force, wp.cross(point - com, force))


def _has_rigid_body(prim: Usd.Prim) -> bool:
    while prim and prim.IsValid() and not prim.IsPseudoRoot():
        if prim.HasAPI(UsdPhysics.RigidBodyAPI):
            return True
        prim = prim.GetParent()
    return False


def anchor_static_joints(stage: Usd.Stage) -> list[tuple[str, str]]:
    """Re-express joint sides that target static prims as world anchors.

    UsdPhysics lets `physics:body0/1` point at a static collider; localPos/Rot
    are then relative to that prim. Newton's importer treats such a side as the
    world but keeps the prim-relative frame, so move it into world space (on the
    session layer, leaving the uploaded files untouched).

    Returns (static prim path, jointed body path) pairs for collision filtering.
    """
    cache = UsdGeom.XformCache()
    stage.SetEditTarget(stage.GetSessionLayer())
    pairs: list[tuple[str, str]] = []
    for prim in stage.Traverse():
        if not prim.IsA(UsdPhysics.Joint):
            continue
        joint = UsdPhysics.Joint(prim)
        sides = [
            (joint.GetBody0Rel(), joint.GetLocalPos0Attr(), joint.GetLocalRot0Attr()),
            (joint.GetBody1Rel(), joint.GetLocalPos1Attr(), joint.GetLocalRot1Attr()),
        ]
        targets = [rel.GetTargets() for rel, _, _ in sides]
        for k, (rel, pos_attr, rot_attr) in enumerate(sides):
            if not targets[k]:
                continue
            target = stage.GetPrimAtPath(targets[k][0])
            if not target or _has_rigid_body(target):
                continue
            world = cache.GetLocalToWorldTransform(target)
            pos = Gf.Vec3d(pos_attr.Get() if pos_attr.HasAuthoredValue() else Gf.Vec3f(0.0))
            rot = rot_attr.Get() if rot_attr.HasAuthoredValue() else Gf.Quatf(1.0)
            q = world.RemoveScaleShear().ExtractRotationQuat()
            target_rot = Gf.Quatf(float(q.GetReal()), Gf.Vec3f(q.GetImaginary()))
            pos_attr.Set(Gf.Vec3f(world.Transform(pos)))
            rot_attr.Set((target_rot * rot).GetNormalized())
            rel.SetTargets([])
            other = targets[1 - k]
            if other:
                pairs.append((str(target.GetPath()), str(other[0])))
    return pairs


class Simulation:
    """A Newton model built from one USD stage, stepped one rendered frame at a time."""

    def __init__(self, stage_path: Path, device: str, solver: str, substeps: int, fps: float):
        self.device = wp.get_device(device)
        stage = Usd.Stage.Open(str(stage_path))
        if not stage:
            raise RuntimeError(f"USD 스테이지를 열 수 없습니다: {stage_path.name}")
        self.up_axis = "Z" if UsdGeom.GetStageUpAxis(stage) == UsdGeom.Tokens.z else "Y"
        self.meters_per_unit = float(UsdGeom.GetStageMetersPerUnit(stage))

        # Keep the stage's own frame and units so poses map straight back onto
        # the prims: same up axis (no rotation), Earth gravity in stage units
        # when the stage has no PhysicsScene (add_usd overrides it otherwise).
        up = newton.Axis.Z if self.up_axis == "Z" else newton.Axis.Y
        g = 9.81 / self.meters_per_unit
        gravity = (0.0, 0.0, -g) if self.up_axis == "Z" else (0.0, -g, 0.0)
        builder = newton.ModelBuilder(up_axis=up, gravity=gravity)
        anchored = anchor_static_joints(stage)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = builder.add_usd(stage, load_visual_shapes=False, apply_up_axis_from_stage=False)
        self.warnings = sorted({str(w.message) for w in caught})

        # A joint pair never collides in UsdPhysics; keep that for static anchors too.
        shape_map: dict[str, int] = result.get("path_shape_map", {})
        body_map: dict[str, int] = result.get("path_body_map", {})
        for static_path, body_path in anchored:
            body = body_map.get(body_path)
            if body is None:
                continue
            static_shapes = [s for p, s in shape_map.items() if p == static_path or p.startswith(static_path + "/")]
            body_shapes = [s for s, b in enumerate(builder.shape_body) if b == body]
            for a in static_shapes:
                for b in body_shapes:
                    builder.add_shape_collision_filter_pair(a, b)

        # UsdPhysics joints outside a PhysicsArticulationRootAPI are not part of
        # any articulation. XPBD solves joints as maximal-coordinate constraints,
        # so only the reduced-coordinate solvers need that validation.
        with wp.ScopedDevice(self.device):
            self.model = builder.finalize(device=self.device, skip_validation_joints=solver != "mujoco")
        if self.model.body_count == 0:
            raise RuntimeError("시뮬레이션할 리지드 바디가 없습니다.")

        self.bodies = list(self.model.body_label)
        self.solver_name = solver
        if solver == "mujoco":
            self.solver = newton.solvers.SolverMuJoCo(self.model)
        else:
            self.solver = newton.solvers.SolverXPBD(self.model, iterations=8, enable_restitution=True)

        # Captured CUDA graphs ping-pong state_0/state_1, so keep the substep count even.
        self.substeps = max(2, substeps + (substeps % 2))
        self.frame_dt = 1.0 / fps
        self.sim_dt = self.frame_dt / self.substeps
        self.sim_time = 0.0

        with wp.ScopedDevice(self.device):
            self.state_0 = self.model.state()
            self.state_1 = self.model.state()
            self.control = self.model.control()
            newton.eval_fk(self.model, self.model.joint_q, self.model.joint_qd, self.state_0)
            self.initial = self.model.state()
            self.initial.assign(self.state_0)
            self.pipeline = newton.CollisionPipeline(self.model)
            self.contacts = self.pipeline.contacts()
            self.drag_body = wp.array([-1], dtype=int)
            self.drag_points = wp.zeros(2, dtype=wp.vec3)

            self.graph = None
            if self.device.is_cuda:
                with wp.ScopedCapture() as capture:
                    self._simulate()
                self.graph = capture.graph

    def _simulate(self) -> None:
        for _ in range(self.substeps):
            self.state_0.clear_forces()
            wp.launch(
                apply_drag,
                dim=1,
                inputs=[
                    self.state_0.body_q,
                    self.state_0.body_qd,
                    self.model.body_com,
                    self.model.body_mass,
                    self.drag_body,
                    self.drag_points,
                    DRAG_STIFFNESS,
                    DRAG_DAMPING,
                ],
                outputs=[self.state_0.body_f],
                device=self.device,
            )
            self.pipeline.collide(self.state_0, self.contacts)
            self.solver.step(self.state_0, self.state_1, self.control, self.contacts, self.sim_dt)
            self.state_0, self.state_1 = self.state_1, self.state_0

    def step(self) -> None:
        with wp.ScopedDevice(self.device):
            if self.graph is not None:
                wp.capture_launch(self.graph)
            else:
                self._simulate()
        self.sim_time += self.frame_dt

    def reset(self) -> None:
        with wp.ScopedDevice(self.device):
            self.state_0.assign(self.initial)
            self.state_1.assign(self.initial)
            self.drag_body.fill_(-1)
        self.sim_time = 0.0

    def set_drag(self, body: int, local: list[float], target: list[float]) -> None:
        if not 0 <= body < len(self.bodies):
            return
        self.drag_points.assign(np.array([local, target], dtype=np.float32))
        self.drag_body.assign(np.array([body], dtype=np.int32))

    def clear_drag(self) -> None:
        self.drag_body.fill_(-1)

    def frame(self) -> bytes:
        """[simTime, bodyCount, bodyCount x (px, py, pz, qx, qy, qz, qw)] as little-endian float32."""
        poses = self.state_0.body_q.numpy().astype("<f4", copy=False).reshape(-1)
        header = np.array([self.sim_time, len(self.bodies)], dtype="<f4")
        return header.tobytes() + poses.tobytes()

    def ready_message(self) -> dict:
        return {
            "type": "ready",
            "bodies": self.bodies,
            "device": str(self.device),
            "solver": self.solver_name,
            "dt": self.frame_dt,
            "substeps": self.substeps,
            "upAxis": self.up_axis,
            "metersPerUnit": self.meters_per_unit,
            "joints": int(self.model.joint_count),
            "shapes": int(self.model.shape_count),
            "warnings": self.warnings,
        }


def safe_relative_path(raw: str) -> PurePosixPath:
    """Reject absolute paths and `..` so uploads stay inside the session's temp folder."""
    path = PurePosixPath(raw.replace("\\", "/"))
    if path.is_absolute() or not path.parts or any(part in ("..", "") for part in path.parts) or ":" in path.parts[0]:
        raise ValueError(f"허용되지 않는 파일 경로입니다: {raw}")
    return path


class Connection:
    """One browser client: receives the stage, then plays it back on request."""

    def __init__(self, ws: ServerConnection, device: str, executor: ThreadPoolExecutor):
        self.ws = ws
        self.device = device
        # Warp work stays on one thread so CUDA graphs and streams are not shared across threads.
        self.executor = executor
        self.loop = asyncio.get_running_loop()
        self.sim: Simulation | None = None
        self.playing = False
        self.speed = 1.0
        self.upload: dict | None = None
        self.workdir = Path(tempfile.mkdtemp(prefix="usd-newton-"))

    async def run_sim(self, fn, *args):
        return await self.loop.run_in_executor(self.executor, fn, *args)

    async def send_json(self, message: dict) -> None:
        await self.ws.send(json.dumps(message, ensure_ascii=False))

    async def send_frame(self) -> None:
        if self.sim is not None:
            await self.ws.send(await self.run_sim(self.sim.frame))

    async def set_playing(self, playing: bool) -> None:
        self.playing = playing
        await self.send_json({"type": "status", "state": "playing" if playing else "paused"})

    async def serve(self) -> None:
        ticker = asyncio.create_task(self.tick())
        try:
            async for message in self.ws:
                try:
                    await self.handle(message)
                except Exception as e:  # report and keep the connection alive
                    traceback.print_exc()
                    self.upload = None
                    await self.send_json({"type": "error", "message": str(e) or e.__class__.__name__})
        except ConnectionClosed:
            pass
        finally:
            ticker.cancel()
            shutil.rmtree(self.workdir, ignore_errors=True)

    async def handle(self, message: str | bytes) -> None:
        if isinstance(message, (bytes, bytearray, memoryview)):
            await self.receive_file(bytes(message))
            return
        msg = json.loads(message)
        kind = msg.get("type")
        if kind == "load":
            await self.begin_upload(msg)
        elif kind == "play":
            await self.set_playing(self.sim is not None)
        elif kind == "pause":
            await self.set_playing(False)
        elif kind == "step" and self.sim is not None:
            await self.set_playing(False)
            await self.run_sim(self.sim.step)
            await self.send_frame()
        elif kind == "reset" and self.sim is not None:
            await self.set_playing(False)
            await self.run_sim(self.sim.reset)
            await self.send_frame()
        elif kind == "speed":
            self.speed = min(8.0, max(0.05, float(msg.get("value", 1.0))))
        elif kind == "drag" and self.sim is not None:
            await self.run_sim(self.sim.set_drag, int(msg["body"]), list(msg["local"]), list(msg["target"]))
        elif kind == "drag_end" and self.sim is not None:
            await self.run_sim(self.sim.clear_drag)

    async def begin_upload(self, msg: dict) -> None:
        self.playing = False
        self.sim = None
        shutil.rmtree(self.workdir, ignore_errors=True)
        self.workdir.mkdir(parents=True)
        files = [(safe_relative_path(f["path"]), int(f["size"])) for f in msg.get("files", [])]
        if not files:
            raise ValueError("업로드할 파일이 없습니다.")
        if sum(size for _, size in files) > MAX_UPLOAD_BYTES:
            raise ValueError("업로드 크기 제한(1GB)을 넘었습니다.")
        self.upload = {
            "root": safe_relative_path(msg["root"]),
            "files": files,
            "received": 0,
            "solver": msg.get("solver", "xpbd"),
            "substeps": int(msg.get("substeps", 8)),
            "fps": float(msg.get("fps", 60)),
        }

    async def receive_file(self, data: bytes) -> None:
        upload = self.upload
        if upload is None:
            raise ValueError("load 메시지 없이 파일 데이터를 받았습니다.")
        path, size = upload["files"][upload["received"]]
        if len(data) != size:
            raise ValueError(f"{path}: 크기가 맞지 않습니다 ({len(data)} != {size}).")
        target = self.workdir / Path(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        upload["received"] += 1
        if upload["received"] < len(upload["files"]):
            return
        self.upload = None
        root = self.workdir / Path(*upload["root"].parts)
        print(f"[newton] loading {upload['root']} ({len(upload['files'])} files) on {self.device} with {upload['solver']}")
        self.sim = await self.run_sim(Simulation, root, self.device, upload["solver"], upload["substeps"], upload["fps"])
        print(f"[newton] ready: {len(self.sim.bodies)} bodies, {self.sim.model.joint_count} joints")
        await self.send_json(self.sim.ready_message())
        await self.send_frame()

    async def tick(self) -> None:
        """Advance in real time x speed while playing, sending one frame per simulated frame."""
        deadline = self.loop.time()
        while True:
            sim = self.sim
            if sim is None or not self.playing:
                deadline = self.loop.time()
                await asyncio.sleep(0.02)
                continue
            await self.run_sim(sim.step)
            await self.send_frame()
            deadline += sim.frame_dt / self.speed
            delay = deadline - self.loop.time()
            if delay < -0.25:  # fell too far behind; don't try to catch up
                deadline = self.loop.time()
            await asyncio.sleep(max(0.0, delay))


async def main() -> None:
    parser = argparse.ArgumentParser(description="Newton physics server for the USD web viewer")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: localhost only)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--device", default=None, help="Warp device, e.g. cuda:0 or cpu (default: CUDA if available)")
    args = parser.parse_args()

    wp.init()
    device = args.device or ("cuda:0" if wp.is_cuda_available() else "cpu")
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="newton")

    async def handler(ws: ServerConnection) -> None:
        print(f"[newton] client connected from {ws.remote_address}")
        await Connection(ws, device, executor).serve()
        print("[newton] client disconnected")

    async with serve(handler, args.host, args.port, max_size=MAX_UPLOAD_BYTES) as server:
        print(f"[newton] Newton {newton.__version__} on {device}, listening on ws://{args.host}:{args.port}")
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
