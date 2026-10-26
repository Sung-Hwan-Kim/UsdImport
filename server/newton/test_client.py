"""Exercise the Newton server without a browser.

    python server/newton/test_client.py public/samples/physics_playground.usda --base public --seconds 1

Uploads the stage (plus any --extra dependency files, paths relative to --base)
through the real protocol, plays it for a while and prints body positions and
cloth extents. --grab pulls the first cloth's first particle upward meanwhile.
"""

from __future__ import annotations

import argparse
import json
import struct
import time
from pathlib import Path

import numpy as np
from websockets.sync.client import connect


def read_frame(data: bytes) -> tuple[float, np.ndarray, np.ndarray]:
    t, n, m = struct.unpack_from("<3f", data)
    poses = np.frombuffer(data, dtype="<f4", offset=12, count=int(n) * 7).reshape(-1, 7)
    particles = np.frombuffer(data, dtype="<f4", offset=12 + int(n) * 28, count=int(m) * 3).reshape(-1, 3)
    return t, poses, particles


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", type=Path)
    parser.add_argument("--base", type=Path, default=Path("."), help="virtual root the paths are relative to")
    parser.add_argument("--extra", type=Path, nargs="*", default=[], help="dependency files (layers) to upload too")
    parser.add_argument("--url", default="ws://127.0.0.1:8765")
    parser.add_argument("--seconds", type=float, default=1.0)
    parser.add_argument("--show", type=int, default=6, help="bodies to print")
    parser.add_argument("--grab", action="store_true", help="hold the first cloth particle 0.5 units above its start")
    args = parser.parse_args()

    files = [args.stage, *args.extra]
    virtual = [f.resolve().relative_to(args.base.resolve()).as_posix() for f in files]
    blobs = [f.read_bytes() for f in files]

    with connect(args.url, max_size=1 << 30) as ws:
        ws.send(json.dumps({
            "type": "load",
            "root": virtual[0],
            "files": [{"path": p, "size": len(b)} for p, b in zip(virtual, blobs)],
            "solver": "xpbd",
            "substeps": 8,
            "fps": 60,
        }))
        for blob in blobs:
            ws.send(blob)

        started = time.perf_counter()
        ready = None
        while ready is None:
            msg = ws.recv()
            if isinstance(msg, str):
                parsed = json.loads(msg)
                if parsed["type"] == "error":
                    raise SystemExit(f"server error: {parsed['message']}")
                if parsed["type"] == "ready":
                    ready = parsed
        print(f"ready in {time.perf_counter() - started:.1f}s: device={ready['device']} solver={ready['solver']} "
              f"upAxis={ready['upAxis']} metersPerUnit={ready['metersPerUnit']} bodies={len(ready['bodies'])} "
              f"joints={ready['joints']} shapes={ready['shapes']} particles={ready.get('particles', 0)}")
        for c in ready.get("cloths", []):
            print(f"  cloth {c['path']}: particles {c['start']}..{c['start'] + c['count']}")
        for w in ready.get("warnings", []):
            print("  warning:", w)

        _, initial, initial_particles = read_frame(ws.recv())
        cloths = ready.get("cloths", [])
        grab = cloths[0]["start"] if args.grab and cloths else None
        if grab is not None:
            target = initial_particles[grab] + np.array([0.0, 0.5, 0.0] if ready["upAxis"] == "Y" else [0.0, 0.0, 0.5])
            ws.send(json.dumps({"type": "drag_particle", "particle": grab, "target": target.tolist()}))
        ws.send(json.dumps({"type": "play"}))
        t, poses, particles = 0.0, initial, initial_particles
        wall = time.perf_counter()
        while t < args.seconds:
            msg = ws.recv()
            if isinstance(msg, bytes):
                t, poses, particles = read_frame(msg)
        ws.send(json.dumps({"type": "pause"}))
        if grab is not None:
            print(f"  held particle {grab}: {np.round(particles[grab], 3)} (target {np.round(target, 3)})")
            ws.send(json.dumps({"type": "drag_end"}))
        print(f"simulated {t:.3f}s in {time.perf_counter() - wall:.2f}s wall time")

        for i, path in enumerate(ready["bodies"][: args.show]):
            p0, p1 = initial[i, :3], poses[i, :3]
            print(f"  {path:40s} {np.round(p0, 3)} -> {np.round(p1, 3)}  moved {np.linalg.norm(p1 - p0):.3f}")
        for c in cloths:
            a, b = c["start"], c["start"] + c["count"]
            lo, hi = particles[a:b].min(axis=0), particles[a:b].max(axis=0)
            print(f"  {c['path']:40s} bounds {np.round(lo, 3)} .. {np.round(hi, 3)}  finite={np.isfinite(particles[a:b]).all()}")

        ws.send(json.dumps({"type": "reset"}))
        # Frames sent before the pause may still be in flight; wait for the reset one.
        while True:
            msg = ws.recv()
            if isinstance(msg, bytes):
                t, poses, particles = read_frame(msg)
                if t == 0.0:
                    break
        deviation = max(np.abs(poses - initial).max(initial=0.0), np.abs(particles - initial_particles).max(initial=0.0))
        print(f"after reset: t={t:.3f}, max deviation from initial {deviation:.2e}")


if __name__ == "__main__":
    main()
