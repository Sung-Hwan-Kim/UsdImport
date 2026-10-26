"""Run a Script Editor snippet from the viewer in a headless Isaac Sim.

Started by server.py with Isaac Sim's Python (python.bat / python.sh):

    python.bat isaac_snippet.py <script.py> <stage or ""> <result.json> <new stage path>

Opens the viewer's stage the way Isaac Sim's Script Editor would see it, runs
the snippet as __main__, and saves the root layer when the snippet changed it
(or, with no stage open, exports the new stage) for the server to send back.
"""

from __future__ import annotations

import json
import runpy
import sys
import traceback

script, stage_path, result_path, new_stage_path = sys.argv[1:5]


def print_script_error() -> None:
    """The traceback from the script's own frames on, as Isaac Sim's Script Editor shows it."""
    error = traceback.TracebackException(*sys.exc_info())
    frames = [f for f in error.stack if f.filename != __file__]
    start = next((i for i, f in enumerate(frames) if f.filename == script), len(frames))
    error.stack = traceback.StackSummary.from_list(frames[start:])
    # Kit re-logs sys.stderr with its own prefixes; the process's stderr stays plain.
    print("".join(error.format()), end="", file=sys.__stderr__ or sys.stderr)


from isaacsim import SimulationApp  # noqa: E402

app = SimulationApp({"headless": True, "open_usd": stage_path or None, "extra_args": ["--/log/outputStreamLevel=Error"]})

import omni.usd  # noqa: E402
from pxr import Sdf  # noqa: E402

# The server shows output from here on; Kit's start-up log is only shown on failure.
print("\x1e[usd-viewer] script", flush=True)

stage = omni.usd.get_context().get_stage()
layer = stage.GetRootLayer()
# Kit authors its viewport into the root layer when it opens a stage: a render
# product under /Render and overs on its OmniverseKit_* cameras. A save hands
# back only what the script did.
original: set[Sdf.Path] = set()
if stage_path:
    Sdf.Layer.OpenAsAnonymous(stage_path).Traverse("/", original.add)
added_on_open: list[Sdf.Path] = []


def note_added(path: Sdf.Path) -> None:
    if not path.IsPrimPath() or path in original or any(path.HasPrefix(p) for p in added_on_open):
        return
    if path.HasPrefix("/Render") or path.GetPrefixes()[0].name.startswith("OmniverseKit_"):
        added_on_open.append(path)


layer.Traverse("/", note_added)
before = layer.ExportToString()

code = 0
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as e:
    code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
except BaseException:
    print_script_error()
    code = 1
app.update()
sys.stdout.flush()

# The Script Editor applies changes as they are made, so keep them even after an error.
if layer.ExportToString() != before:
    removal = Sdf.BatchNamespaceEdit()
    for path in sorted(added_on_open, key=lambda p: p.pathElementCount, reverse=True):
        if layer.GetPrimAtPath(path):
            removal.Add(Sdf.NamespaceEdit.Remove(path))
    layer.Apply(removal)
    if not stage_path:
        layer.Export(new_stage_path)
    elif stage_path.lower().endswith(".usdz"):
        print("USDZ 패키지는 저장할 수 없어 변경 사항을 뷰어에 반영하지 않습니다.", file=sys.stderr)
    else:
        layer.Save()

with open(result_path, "w", encoding="utf-8") as f:
    json.dump({"code": code}, f)
app.close()
