/** Starting points for Isaac Sim scripts, filled in from what the viewer has open. */

export interface TemplateContext {
  /** Opened stage's file name, e.g. "robot.usd". */
  stageName?: string;
  /** Selected prim's path in the stage. */
  primPath?: string;
}

export interface ScriptTemplate {
  id: string;
  title: string;
  hint: string;
  fileName: string;
  build(ctx: TemplateContext): string;
}

const stagePath = (ctx: TemplateContext) => `/path/to/${ctx.stageName ?? "scene.usd"}`;

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "empty",
    title: "빈 스크립트",
    hint: "",
    fileName: "script.py",
    build: () => "",
  },
  {
    id: "standalone",
    title: "Standalone 앱",
    hint: "Isaac Sim 6.x",
    fileName: "standalone.py",
    build: (ctx) => `"""Standalone Isaac Sim app: open a USD stage and run its physics.

Run it from the viewer's script editor (Ctrl+Enter, Isaac Sim), or with
Isaac Sim's Python, e.g.
    ./python.sh standalone.py          (Linux)
    python.bat standalone.py           (Windows)
"""

import os

from isaacsim import SimulationApp

# SimulationApp must start before any other Isaac Sim import.
simulation_app = SimulationApp({"headless": False})

import isaacsim.core.experimental.utils.stage as stage_utils
import omni.timeline
from isaacsim.core.simulation_manager import SimulationManager

# Run from the viewer, USD_VIEWER_STAGE is a copy of the stage open there.
USD_PATH = os.environ.get("USD_VIEWER_STAGE") or "${stagePath(ctx)}"  # TODO: absolute path to the stage

ok, stage = stage_utils.open_stage(USD_PATH)
if not ok:
    raise RuntimeError(f"Could not open {USD_PATH}")

# Let the stage finish loading before playing.
while stage_utils.is_stage_loading():
    simulation_app.update()

omni.timeline.get_timeline_interface().play()
simulation_app.update()

for frame in range(600):
    if SimulationManager.is_simulating():
        pass  # read or drive prims here
    simulation_app.update()

simulation_app.close()
`,
  },
  {
    id: "hello-world",
    title: "Hello World (큐브 떨어뜨리기)",
    hint: "Isaac Sim 6.x",
    fileName: "hello_world.py",
    build: () => `from isaacsim import SimulationApp

simulation_app = SimulationApp({"headless": False})

import isaacsim.core.experimental.utils.stage as stage_utils
import numpy as np
import omni.timeline
from isaacsim.core.experimental.materials import PreviewSurfaceMaterial
from isaacsim.core.experimental.objects import Cube
from isaacsim.core.experimental.prims import GeomPrim, RigidPrim
from isaacsim.core.simulation_manager import SimulationManager
from isaacsim.storage.native import get_assets_root_path

stage_utils.add_reference_to_stage(
    usd_path=get_assets_root_path() + "/Isaac/Environments/Grid/default_environment.usd",
    path="/World/ground",
)

material = PreviewSurfaceMaterial("/World/Materials/blue")
material.set_input_values("diffuseColor", [0.0, 0.0, 1.0])

cube = Cube(paths="/World/fancy_cube", positions=np.array([[0.0, 0.0, 1.0]]), sizes=[1.0], scales=np.array([[0.5, 0.5, 0.5]]))
GeomPrim(paths=cube.paths, apply_collision_apis=True)
rigid = RigidPrim(paths=cube.paths)
cube.apply_visual_materials(material)

omni.timeline.get_timeline_interface().play()
simulation_app.update()

for i in range(200):
    if SimulationManager.is_simulating():
        positions, orientations = rigid.get_world_poses()
        print("cube position:", positions.numpy()[0])
    simulation_app.update()

simulation_app.close()
`,
  },
  {
    id: "script-editor",
    title: "Script Editor 스니펫",
    hint: "Window › Script Editor",
    fileName: "inspect_stage.py",
    build: (ctx) => `# Run from the viewer (Ctrl+Enter), or paste into Isaac Sim's Script Editor (Window > Script Editor).
# Lists the open stage's rigid bodies and colliders.

import omni.usd
from pxr import Usd, UsdPhysics

stage = omni.usd.get_context().get_stage()
print("stage:", stage.GetRootLayer().identifier)

for prim in stage.Traverse():
    if prim.HasAPI(UsdPhysics.RigidBodyAPI):
        print("rigid body:", prim.GetPath())
    elif prim.HasAPI(UsdPhysics.CollisionAPI):
        print("collider:  ", prim.GetPath())
${ctx.primPath ? `\nprim = stage.GetPrimAtPath("${ctx.primPath}")\nprint("selected:", prim.GetPath(), prim.GetTypeName(), prim.GetAppliedSchemas())\n` : ""}`,
  },
  {
    id: "make-rigid",
    title: "선택한 프림을 리지드 바디로",
    hint: "pxr.UsdPhysics",
    fileName: "make_rigid.py",
    build: (ctx) => `# Script Editor: give a prim a rigid body, a collider and a mass.

import omni.usd
from pxr import UsdPhysics

PRIM_PATH = "${ctx.primPath ?? "/World/MyPrim"}"

stage = omni.usd.get_context().get_stage()
prim = stage.GetPrimAtPath(PRIM_PATH)
if not prim.IsValid():
    raise RuntimeError(f"No prim at {PRIM_PATH}")

UsdPhysics.RigidBodyAPI.Apply(prim)
UsdPhysics.CollisionAPI.Apply(prim)
UsdPhysics.MassAPI.Apply(prim).CreateMassAttr(1.0)  # kg

if not any(p.IsA(UsdPhysics.Scene) for p in stage.Traverse()):
    UsdPhysics.Scene.Define(stage, "/World/PhysicsScene")
print("rigid body:", PRIM_PATH)
`,
  },
  {
    id: "legacy-world",
    title: "World 기반 스크립트",
    hint: "Isaac Sim 4.5–5.x",
    fileName: "world_legacy.py",
    build: (ctx) => `import os

from isaacsim import SimulationApp

simulation_app = SimulationApp({"headless": False})

from isaacsim.core.api import World
from isaacsim.core.utils.stage import add_reference_to_stage

world = World(stage_units_in_meters=1.0)
world.scene.add_default_ground_plane()
# Run from the viewer, USD_VIEWER_STAGE is a copy of the stage open there.
add_reference_to_stage(usd_path=os.environ.get("USD_VIEWER_STAGE") or "${stagePath(ctx)}", prim_path="/World/Asset")  # TODO: absolute path
world.reset()

for i in range(600):
    world.step(render=True)

simulation_app.close()
`,
  },
];
