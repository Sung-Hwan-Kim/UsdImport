"""Exercise the Newton server without a browser.

    python server/newton/test_client.py public/samples/physics_playground.usda --base public --seconds 1

Uploads the stage (plus any --extra dependency files, paths relative to --base)
through the real protocol, plays it for a while and prints body positions.
"""

from __future__ import annotations

import argparse
import json
import struct
import time
from pathlib import Path

import numpy as np
from websockets.sync.client import connect


def read_frame(data: bytes) -> tuple[float, np.ndarray]:
    t, n = struct.unpack_from("<2f", data)
    poses = np.frombuffer(data, dtype="<f4", offset=8, count=int(n) * 7).reshape(-1, 7)
    return t, poses


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", type=Path)
    parser.add_argument("--base", type=Path, default=Path("."), help="virtual root the paths are relative to")
    parser.add_argument("--extra", type=Path, nargs="*", default=[], help="dependency files (layers) to upload too")
    parser.add_argument("--url", default="ws://127.0.0.1:8765")
    parser.add_argument("--seconds", type=float, default=1.0)
    parser.add_argument("--show", type=int, default=6, help="bodies to print")
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
              f"joints={ready['joints']} shapes={ready['shapes']}")
        for w in ready.get("warnings", []):
            print("  warning:", w)

        _, initial = read_frame(ws.recv())
        ws.send(json.dumps({"type": "play"}))
        t, poses = 0.0, initial
        wall = time.perf_counter()
        while t < args.seconds:
            msg = ws.recv()
            if isinstance(msg, bytes):
                t, poses = read_frame(msg)
        ws.send(json.dumps({"type": "pause"}))
        print(f"simulated {t:.3f}s in {time.perf_counter() - wall:.2f}s wall time")

        for i, path in enumerate(ready["bodies"][: args.show]):
            p0, p1 = initial[i, :3], poses[i, :3]
            print(f"  {path:40s} {np.round(p0, 3)} -> {np.round(p1, 3)}  moved {np.linalg.norm(p1 - p0):.3f}")

        ws.send(json.dumps({"type": "reset"}))
        # Frames sent before the pause may still be in flight; wait for the reset one.
        while True:
            msg = ws.recv()
            if isinstance(msg, bytes):
                t, poses = read_frame(msg)
                if t == 0.0:
                    break
        print(f"after reset: t={t:.3f}, max deviation from initial {np.abs(poses - initial).max():.2e}")


if __name__ == "__main__":
    main()
