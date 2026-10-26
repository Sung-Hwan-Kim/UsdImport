"""Running scripts from the viewer's script editor, for server.py.

Two ways to run a script:

- "pxr": this server's own Python with OpenUSD, in a second or so. Isaac Sim
  modules are not available; omni.usd.get_context().get_stage() is the stage.
- "isaac": Isaac Sim's Python (python.bat / python.sh). A standalone script
  (one that creates a SimulationApp) runs as is; anything else is a Script
  Editor snippet, run in a headless Isaac Sim on the viewer's stage.

Either way the script runs in a child process whose output is streamed back,
and a stage the script changed is sent back for the viewer to reload.
"""

from __future__ import annotations

import asyncio
import codecs
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlsplit

RUNNERS = Path(__file__).with_name("runners")
LAUNCHER = "python.bat" if os.name == "nt" else "python.sh"
# A script that creates its own SimulationApp is a standalone app, not a Script Editor snippet.
STANDALONE = re.compile(r"\bSimulationApp\s*\(")
# isaac_snippet.py prints this once Isaac Sim has started; Kit's start-up log before it is held back.
SCRIPT_MARK = "\x1e[usd-viewer] script"
HELD_LINES = 400
LOOPBACK = {"localhost", "127.0.0.1", "::1"}
NEW_STAGE_NAME = "script_stage.usda"


def origin_allowed(origin: str | None, allowed: list[str]) -> bool:
    """Only pages served from this machine (or --allow-origin) may run code here.

    Browsers always send Origin and let any web page open a WebSocket to
    localhost, so this is what keeps other sites from running scripts. A client
    without an Origin is a local program, which could run code anyway.
    """
    if origin is None or origin in allowed:
        return True
    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and (parts.hostname or "") in LOOPBACK


def find_isaac_sim(explicit: str | None) -> Path | None:
    """Isaac Sim's install folder: --isaac-sim, ISAAC_SIM_PATH, or a search of the usual places."""
    for raw in (explicit, os.environ.get("ISAAC_SIM_PATH"), os.environ.get("ISAACSIM_PATH")):
        if raw and (Path(raw) / LAUNCHER).is_file():
            return Path(raw)
    if explicit:
        return None
    home = Path.home()
    roots = [home, home / ".local" / "share" / "ov" / "pkg", Path(os.environ.get("LOCALAPPDATA", home)) / "ov" / "pkg"]
    if os.name == "nt":
        roots += [Path(f"{drive}:\\") for drive in "CDEFG" if Path(f"{drive}:\\").exists()]
    else:
        roots += [Path("/"), Path("/opt")]
    skip = {"windows", "$recycle.bin", "system volume information", "programdata", "proc", "sys", "dev"}
    found: list[Path] = []

    def scan(folder: Path, depth: int) -> None:
        try:
            entries = [e for e in os.scandir(folder) if e.is_dir(follow_symlinks=False)]
        except OSError:
            return
        for entry in entries:
            name = entry.name.lower()
            if name.startswith(("isaac-sim", "isaacsim", "isaac_sim")) and (Path(entry.path) / LAUNCHER).is_file():
                found.append(Path(entry.path))
            elif depth > 1 and not name.startswith((".", "$")) and name not in skip:
                scan(Path(entry.path), depth - 1)

    for root in roots:
        scan(root, 2)
    # Newest version first (folder names carry it, e.g. isaac-sim-standalone-6.0.1-...).
    return max(found, key=lambda p: p.name) if found else None


def _file_hash(path: Path | None) -> str | None:
    if path is None or not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ScriptRun:
    """One script in a child process: start it, stream its output, stop it."""

    def __init__(
        self,
        *,
        script: str,
        name: str,
        mode: str,
        stage: Path | None,
        workdir: Path,
        isaac_sim: Path | None,
        send_json: Callable[[dict], Awaitable[None]],
        send_bytes: Callable[[bytes], Awaitable[None]],
    ):
        if mode not in ("pxr", "isaac"):
            raise ValueError(f"알 수 없는 실행 방식입니다: {mode}")
        if mode == "isaac" and isaac_sim is None:
            raise ValueError(
                "Isaac Sim을 찾지 못했습니다. 서버를 `npm run newton -- --isaac-sim <Isaac Sim 폴더>`로 실행하거나 "
                "ISAAC_SIM_PATH 환경 변수를 설정하세요."
            )
        self.mode = mode
        self.stage = stage
        self.send_json = send_json
        self.send_bytes = send_bytes
        self.stopped = False
        self.process: asyncio.subprocess.Process | None = None

        run_dir = workdir / ".viewer-run"
        run_dir.mkdir(parents=True, exist_ok=True)
        safe_name = re.sub(r"[^\w.-]", "_", Path(name).name) or "script.py"
        self.script_path = run_dir / (safe_name if safe_name.endswith(".py") else f"{safe_name}.py")
        self.script_path.write_text(script, encoding="utf-8")
        self.result_path = run_dir / "result.json"
        self.new_stage_path = run_dir / NEW_STAGE_NAME
        for leftover in (self.result_path, self.new_stage_path):
            leftover.unlink(missing_ok=True)

        stage_arg = str(stage) if stage else ""
        runner_args = [str(self.script_path), stage_arg, str(self.result_path), str(self.new_stage_path)]
        if mode == "pxr":
            self.kind = "pxr"
            self.argv = [sys.executable, str(RUNNERS / "pxr_runner.py"), *runner_args]
        elif STANDALONE.search(script):
            self.kind = "isaac-standalone"
            self.argv = [str(isaac_sim / LAUNCHER), str(self.script_path)]
        else:
            self.kind = "isaac-snippet"
            self.argv = [str(isaac_sim / LAUNCHER), str(RUNNERS / "isaac_snippet.py"), *runner_args]
        self.cwd = stage.parent if stage else run_dir
        self.env = {
            **os.environ,
            "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            # Standalone scripts can open the viewer's stage from here.
            "USD_VIEWER_STAGE": stage_arg,
        }
        if mode == "isaac":
            # This server's virtual environment must not leak into Isaac Sim's own Python.
            for key in ("VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH"):
                self.env.pop(key, None)

    async def run(self) -> None:
        stage_hash = _file_hash(self.stage)
        started = time.monotonic()
        kwargs: dict = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        self.process = await asyncio.create_subprocess_exec(
            *self.argv,
            cwd=str(self.cwd),
            env=self.env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **kwargs,
        )
        await self.send_json({"type": "run_started", "runner": self.kind})
        # Kit's start-up log (hundreds of extension lines) is held until the snippet starts.
        held: list[tuple[str, str]] | None = [] if self.kind == "isaac-snippet" else None

        async def pump(stream: asyncio.StreamReader, name: str) -> None:
            nonlocal held
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            pending = ""
            while chunk := await stream.read(8192):
                pending += decoder.decode(chunk)
                if held is not None:
                    *lines, pending = pending.split("\n")
                    for i, line in enumerate(lines):
                        if line.rstrip("\r") == SCRIPT_MARK:
                            held = None
                            pending = "".join(f"{rest}\n" for rest in lines[i + 1 :]) + pending
                            break
                        held.append((name, line + "\n"))
                    if held is not None:
                        del held[:-HELD_LINES]
                if held is None and pending:
                    await self.send_json({"type": "output", "stream": name, "text": pending})
                    pending = ""
            pending += decoder.decode(b"", final=True)
            if pending and held is not None:
                held.append((name, pending))
            elif pending:
                await self.send_json({"type": "output", "stream": name, "text": pending})

        await asyncio.gather(pump(self.process.stdout, "stdout"), pump(self.process.stderr, "stderr"))
        exit_code = await self.process.wait()
        if held:
            # Isaac Sim stopped before the snippet ran: its log says why.
            for name, text in held:
                await self.send_json({"type": "output", "stream": name, "text": text})

        code: int | None = exit_code
        if self.result_path.is_file():
            try:
                code = int(json.loads(self.result_path.read_text(encoding="utf-8")).get("code", exit_code))
            except (ValueError, OSError):
                pass
        elif self.kind != "isaac-standalone":
            # The runner died before the script finished (Kit logs errors and still exits 0).
            code = exit_code or 1
        if not self.stopped:
            if self.stage is not None and _file_hash(self.stage) != stage_hash:
                await self.send_json({"type": "stage", "name": self.stage.name, "new": False})
                await self.send_bytes(self.stage.read_bytes())
            elif self.stage is None and self.new_stage_path.is_file():
                await self.send_json({"type": "stage", "name": NEW_STAGE_NAME, "new": True})
                await self.send_bytes(self.new_stage_path.read_bytes())
        await self.send_json(
            {"type": "run_done", "code": None if self.stopped else code, "stopped": self.stopped, "seconds": round(time.monotonic() - started, 2)}
        )

    def stop(self) -> None:
        """Kill the script and everything it started (python.bat runs Isaac Sim in a child process)."""
        process = self.process
        if process is None or process.returncode is not None:
            return
        self.stopped = True
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True)
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
