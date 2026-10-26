"""Run a script from the viewer's script editor with OpenUSD (pxr) alone.

Started by server.py with its own Python:

    python pxr_runner.py <script.py> <stage or ""> <result.json> <new stage path>

`omni.usd.get_context().get_stage()` returns the viewer's stage, as in Isaac
Sim's Script Editor; other Isaac Sim / Kit modules are not available. A stage
the script changed is saved in place (or, with no stage open, exported to the
new stage path) for the server to send back.
"""

from __future__ import annotations

import importlib.abc
import json
import runpy
import sys
import traceback
import types

from pxr import Usd

script, stage_path, result_path, new_stage_path = sys.argv[1:5]


def print_script_error() -> None:
    """The traceback from the script's own frames on, as Isaac Sim's Script Editor shows it."""
    error = traceback.TracebackException(*sys.exc_info())
    frames = [f for f in error.stack if f.filename != __file__]
    start = next((i for i, f in enumerate(frames) if f.filename == script), len(frames))
    error.stack = traceback.StackSummary.from_list(frames[start:])
    # Kit re-logs sys.stderr with its own prefixes; the process's stderr stays plain.
    print("".join(error.format()), end="", file=sys.__stderr__ or sys.stderr)


class UsdContext:
    """The part of omni.usd.UsdContext a pxr-only script can use."""

    def __init__(self) -> None:
        self.stage = Usd.Stage.Open(stage_path) if stage_path else Usd.Stage.CreateInMemory("script_stage.usda")

    def get_stage(self) -> Usd.Stage:
        return self.stage

    def get_stage_url(self) -> str:
        return self.stage.GetRootLayer().identifier

    def open_stage(self, path: str, *_args, **_kwargs) -> bool:
        stage = Usd.Stage.Open(path)
        if stage:
            self.stage = stage
        return bool(stage)

    def new_stage(self, *_args, **_kwargs) -> bool:
        self.stage = Usd.Stage.CreateInMemory("script_stage.usda")
        return True

    def save_stage(self, *_args, **_kwargs) -> bool:
        return self.stage.GetRootLayer().Save()


context = UsdContext()
omni = types.ModuleType("omni")
omni.__path__ = []
omni_usd = types.ModuleType("omni.usd")
omni_usd.UsdContext = UsdContext
omni_usd.get_context = lambda name="": context
omni.usd = omni_usd
sys.modules["omni"] = omni
sys.modules["omni.usd"] = omni_usd


class IsaacSimOnly(importlib.abc.MetaPathFinder):
    """Explain, instead of a bare ModuleNotFoundError, why Isaac Sim modules are missing."""

    PACKAGES = ("isaacsim", "omni", "carb")

    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in self.PACKAGES:
            raise ModuleNotFoundError(
                f"pxr 실행에는 '{fullname}' 모듈이 없습니다. 스크립트 에디터의 실행 방식을 Isaac Sim으로 바꾸세요.", name=fullname
            )
        return None


sys.meta_path.insert(0, IsaacSimOnly())

opened = context.stage
code = 0
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as e:
    code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
except BaseException:
    print_script_error()
    code = 1
sys.stdout.flush()

# The Script Editor applies changes as they are made, so keep them even after an error.
layer = opened.GetRootLayer()
if stage_path and layer.dirty:
    if stage_path.lower().endswith(".usdz"):
        print("USDZ 패키지는 저장할 수 없어 변경 사항을 뷰어에 반영하지 않습니다.", file=sys.stderr)
    else:
        layer.Save()
elif not stage_path and context.stage.GetPseudoRoot().GetChildren():
    context.stage.GetRootLayer().Export(new_stage_path)

with open(result_path, "w", encoding="utf-8") as f:
    json.dump({"code": code}, f)
sys.exit(code)
