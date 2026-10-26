/**
 * A curated slice of the Isaac Sim Python API (6.x, with the 4.5–5.x and
 * pre-4.5 names that existing scripts still use) for editor completion.
 * Signatures follow docs.isaacsim.omniverse.nvidia.com; this is a guide for
 * typing, not a full reference.
 */

export type ApiKind = "module" | "class" | "function" | "constant";

export interface ApiMember {
  name: string;
  kind: ApiKind;
  /** Short signature or value shown next to the name. */
  detail?: string;
  /** One-line description (Korean). */
  info?: string;
}

export interface ApiModule {
  path: string;
  info: string;
  members: ApiMember[];
  /** Kept for older scripts; replaced in newer Isaac Sim releases. */
  legacy?: string;
}

const fn = (name: string, detail: string, info?: string): ApiMember => ({ name, kind: "function", detail, info });
const cls = (name: string, detail: string, info?: string): ApiMember => ({ name, kind: "class", detail, info });
const mod = (name: string, info?: string): ApiMember => ({ name, kind: "module", info });

export const ISAAC_MODULES: ApiModule[] = [
  {
    path: "isaacsim",
    info: "Isaac Sim 루트 패키지",
    members: [cls("SimulationApp", '(launch_config={"headless": False})', "Kit 앱을 띄웁니다. 다른 Isaac Sim import보다 먼저 만들어야 합니다")],
  },
  {
    path: "isaacsim.simulation_app",
    info: "Standalone 앱 실행",
    members: [cls("SimulationApp", '(launch_config={"headless": False})', "Kit 앱을 띄웁니다. update()로 한 프레임, close()로 종료")],
  },
  {
    path: "isaacsim.core.experimental.utils.stage",
    info: "스테이지 유틸 (Isaac Sim 6.x)",
    members: [
      fn("add_reference_to_stage", "(usd_path, path, *, prim_type='Xform', variants=None) -> Usd.Prim", "USD 파일을 path 프림으로 참조합니다"),
      fn("open_stage", "(usd_path) -> tuple[bool, Usd.Stage | None]", "USD 파일을 현재 스테이지로 엽니다"),
      fn("open_stage_async", "(usd_path) -> tuple[bool, Usd.Stage | None]"),
      fn("create_new_stage", "(*, template=None) -> Usd.Stage", "빈 스테이지를 만듭니다"),
      fn("save_stage", "(usd_path) -> bool"),
      fn("close_stage", "() -> bool"),
      fn("get_current_stage", "(*, backend=None) -> Usd.Stage", "현재 열린 스테이지"),
      fn("define_prim", "(path, type_name='Xform') -> Usd.Prim"),
      fn("delete_prim", "(prim) -> bool"),
      fn("move_prim", "(target, destination) -> tuple[bool, str]"),
      fn("generate_next_free_path", "(path=None, *, prepend_default_prim=True) -> str"),
      fn("get_stage_units", "() -> tuple[float, float]", "(metersPerUnit, kilogramsPerUnit)"),
      fn("set_stage_units", "(*, meters_per_unit=None, kilograms_per_unit=None)"),
      fn("get_stage_up_axis", "() -> 'Y' | 'Z'"),
      fn("set_stage_up_axis", "(up_axis)"),
      fn("get_stage_time_code", "() -> tuple[float, float, float]"),
      fn("set_stage_time_code", "(*, start_time_code=None, end_time_code=None, time_codes_per_second=None)"),
      fn("is_stage_loading", "() -> bool"),
      fn("use_stage", "(stage)", "with 블록 안에서 다른 스테이지를 현재 스테이지로 씁니다"),
    ],
  },
  {
    path: "isaacsim.core.experimental.utils.prim",
    info: "프림 유틸 (Isaac Sim 6.x)",
    members: [
      fn("get_prim_at_path", "(path) -> Usd.Prim"),
      fn("get_prim_path", "(prim) -> str"),
      fn("is_prim_valid", "(prim) -> bool"),
      fn("has_api", "(prim, api, *, instance_name=None, test='all') -> bool"),
      fn("ensure_api", "(prim, api, *args, **kwargs)", "API 스키마가 없으면 적용합니다"),
      fn("find_matching_prim_paths", "(path, *, traverse=False) -> list[str]", "정규식 경로와 일치하는 프림 경로"),
      fn("get_prim_attribute_names", "(prim) -> list[str]"),
      fn("get_prim_attribute_value", "(prim, attribute_name)"),
      fn("set_prim_attribute_value", "(prim, attribute_name, value)"),
      fn("create_prim_attribute", "(prim, *, name, type_name, exist_ok=True)"),
      fn("get_prim_variants", "(prim) -> list[tuple]"),
      fn("set_prim_variants", "(prim, *, variants)"),
      fn("join_prim_paths", "(*paths) -> str"),
    ],
  },
  {
    path: "isaacsim.core.experimental.utils.xform",
    info: "트랜스폼 읽기/쓰기 (Isaac Sim 6.x)",
    members: [
      fn("get_world_pose", "(prim, *, device=None) -> (position, orientation)"),
      fn("set_world_pose", "(prim, *, position=None, orientation=None)"),
      fn("get_local_pose", "(prim, *, device=None) -> (translation, orientation)"),
      fn("set_local_pose", "(prim, *, translation=None, orientation=None)"),
      fn("get_relative_transform", "(source_prim, target_prim) -> np.ndarray"),
    ],
  },
  {
    path: "isaacsim.core.experimental.utils.transform",
    info: "회전·변환 계산 (Isaac Sim 6.x)",
    members: [
      fn("euler_angles_to_quaternion", "(euler_angles, *, degrees=False, extrinsic=True)"),
      fn("quaternion_to_euler_angles", "(quaternion, *, degrees=False, extrinsic=True)"),
      fn("quaternion_multiplication", "(first_quaternion, second_quaternion)"),
      fn("quaternion_to_rotation_matrix", "(quaternion)"),
      fn("rotation_matrix_to_quaternion", "(rotation_matrix)"),
      fn("rotate_vectors_by_quaternion", "(vectors, orientation)"),
      fn("look_at_quaternion", "(eye, target, up=None)"),
    ],
  },
  {
    path: "isaacsim.core.experimental.utils.app",
    info: "앱·타임라인 제어 (Isaac Sim 6.x)",
    members: [
      fn("play", "(*, commit=True)"),
      fn("pause", "(*, commit=True)"),
      fn("stop", "(*, commit=True)"),
      fn("is_playing", "() -> bool"),
      fn("is_stopped", "() -> bool"),
      fn("update_app", "(*, steps=1, callback=None)", "앱을 steps 프레임 진행합니다"),
      fn("enable_extension", "(name, *, enabled=True) -> bool"),
    ],
  },
  {
    path: "isaacsim.core.experimental.objects",
    info: "기본 형상·라이트·카메라 (Isaac Sim 6.x)",
    members: [
      cls("Cube", "(paths, *, positions=None, sizes=None, scales=None, ...)"),
      cls("Sphere", "(paths, *, positions=None, radii=None, ...)"),
      cls("Capsule", "(paths, *, positions=None, radii=None, heights=None, axes=None, ...)"),
      cls("Cylinder", "(paths, *, positions=None, radii=None, heights=None, axes=None, ...)"),
      cls("Cone", "(paths, *, positions=None, radii=None, heights=None, axes=None, ...)"),
      cls("Plane", "(paths, ...)"),
      cls("Mesh", "(paths, ...)"),
      cls("GroundPlane", "(paths, ...)", "바닥 평면 (충돌 포함)"),
      cls("Camera", "(paths, *, positions=None, orientations=None, ...)"),
      cls("DistantLight", "(paths, ...)"),
      cls("DomeLight", "(paths, ...)"),
      cls("SphereLight", "(paths, ...)"),
      cls("RectLight", "(paths, ...)"),
      cls("DiskLight", "(paths, ...)"),
      cls("CylinderLight", "(paths, ...)"),
    ],
  },
  {
    path: "isaacsim.core.experimental.prims",
    info: "프림 래퍼 — 정규식 경로로 여러 프림을 한 번에 (Isaac Sim 6.x)",
    members: [
      cls("Prim", "(paths)"),
      cls("XformPrim", "(paths, *, positions=None, orientations=None, ...)", "포즈·스케일·가시성·머티리얼"),
      cls("GeomPrim", "(paths, *, apply_collision_apis=False)", "형상과 충돌 속성"),
      cls("RigidPrim", "(paths, ...)", "질량·속도·힘·접촉"),
      cls("DeformablePrim", "(paths, ...)", "Deformable 스키마가 적용된 프림"),
      cls("Articulation", "(paths, ...)", "관절 위치·속도·힘 제어, 야코비안"),
    ],
  },
  {
    path: "isaacsim.core.experimental.materials",
    info: "비주얼·물리 머티리얼 (Isaac Sim 6.x)",
    members: [
      cls("PreviewSurfaceMaterial", "(paths)", "set_input_values('diffuseColor', [r, g, b])"),
      cls("OmniPbrMaterial", "(paths)"),
      cls("OmniGlassMaterial", "(paths)"),
      cls("RigidBodyMaterial", "(paths, ...)", "마찰·반발"),
      cls("SurfaceDeformableMaterial", "(paths, ...)", "천 물성"),
      cls("VolumeDeformableMaterial", "(paths, ...)"),
    ],
  },
  {
    path: "isaacsim.core.simulation_manager",
    info: "물리 시뮬레이션 관리",
    members: [
      cls("SimulationManager", "", "is_simulating(), register_callback(fn, event), set_physics_dt(dt) …"),
      cls("IsaacEvents", "", "POST_PHYSICS_STEP 등 콜백 이벤트"),
    ],
  },
  {
    path: "isaacsim.storage.native",
    info: "에셋 저장소",
    members: [fn("get_assets_root_path", "() -> str", "Isaac Sim 에셋 루트 (Nucleus/S3) 경로")],
  },
  {
    path: "omni.usd",
    info: "Kit의 USD 컨텍스트",
    members: [
      fn("get_context", "() -> UsdContext", "get_stage(), open_stage(path), new_stage(), save_stage()"),
      fn("get_stage_next_free_path", "(stage, path, prepend_default_prim)"),
    ],
  },
  {
    path: "omni.timeline",
    info: "타임라인 (재생/정지)",
    members: [fn("get_timeline_interface", "()", "play(), pause(), stop(), get_current_time()")],
  },
  { path: "omni.kit.commands", info: "Kit 명령 (Undo 가능)", members: [fn("execute", "(command_name, **kwargs)")] },
  { path: "omni.kit.app", info: "Kit 앱", members: [fn("get_app", "()", "next_update_async() 등")] },
  {
    path: "pxr",
    info: "OpenUSD Python 바인딩",
    members: ["Usd", "UsdGeom", "UsdPhysics", "UsdShade", "UsdLux", "Gf", "Sdf", "Vt", "PhysxSchema"].map((m) => mod(m)),
  },
  {
    path: "pxr.Usd",
    info: "스테이지·프림",
    members: [cls("Stage", "", "Open(path), CreateNew(path), GetPrimAtPath(path), Traverse()"), cls("Prim", ""), cls("TimeCode", ""), cls("PrimRange", "")],
  },
  {
    path: "pxr.UsdGeom",
    info: "지오메트리·트랜스폼",
    members: [
      cls("Xform", "", "Define(stage, path)"),
      cls("Xformable", "(prim)", "AddTranslateOp(), AddRotateXYZOp(), AddScaleOp()"),
      cls("Mesh", ""),
      cls("Cube", ""),
      cls("Sphere", ""),
      cls("Cylinder", ""),
      cls("Capsule", ""),
      cls("Cone", ""),
      cls("XformCache", "(time)"),
      cls("Tokens", ""),
      fn("GetStageUpAxis", "(stage)"),
      fn("SetStageUpAxis", "(stage, axis)"),
      fn("GetStageMetersPerUnit", "(stage)"),
      fn("SetStageMetersPerUnit", "(stage, metersPerUnit)"),
    ],
  },
  {
    path: "pxr.UsdPhysics",
    info: "UsdPhysics 스키마",
    members: [
      cls("Scene", "", "Define(stage, path)"),
      cls("RigidBodyAPI", "", "Apply(prim)"),
      cls("CollisionAPI", "", "Apply(prim)"),
      cls("MeshCollisionAPI", "", "Apply(prim).CreateApproximationAttr('convexHull')"),
      cls("MassAPI", "", "Apply(prim).CreateMassAttr(kg)"),
      cls("MaterialAPI", "", "Apply(material_prim)"),
      cls("ArticulationRootAPI", ""),
      cls("Joint", ""),
      cls("RevoluteJoint", "", "Define(stage, path)"),
      cls("PrismaticJoint", ""),
      cls("SphericalJoint", ""),
      cls("FixedJoint", ""),
      cls("DistanceJoint", ""),
      cls("DriveAPI", "", "Apply(prim, 'angular' | 'linear')"),
      cls("LimitAPI", ""),
    ],
  },
  {
    path: "pxr.Gf",
    info: "수학 타입",
    members: ["Vec2f", "Vec3f", "Vec3d", "Vec4f", "Quatf", "Quatd", "Matrix4d", "Rotation", "Range3d"].map((m) => cls(m, "")),
  },
  { path: "pxr.Sdf", info: "레이어·경로", members: [cls("Path", "(path)"), cls("Layer", ""), cls("ValueTypeNames", "")] },
  {
    path: "isaacsim.core.api",
    info: "World 기반 코어 API",
    legacy: "Isaac Sim 4.5–5.x (6.0부터 deprecated)",
    members: [cls("World", "(stage_units_in_meters=1.0)", "scene.add(...), reset(), step(render=True)"), cls("SimulationContext", "")],
  },
  {
    path: "isaacsim.core.api.objects",
    info: "World용 기본 형상",
    legacy: "Isaac Sim 4.5–5.x",
    members: ["DynamicCuboid", "FixedCuboid", "VisualCuboid", "DynamicSphere", "FixedSphere", "GroundPlane"].map((m) => cls(m, "(prim_path, name, position=None, ...)")),
  },
  {
    path: "isaacsim.core.utils.stage",
    info: "스테이지 유틸",
    legacy: "Isaac Sim 4.5–5.x",
    members: [fn("add_reference_to_stage", "(usd_path, prim_path)"), fn("open_stage", "(usd_path)"), fn("get_current_stage", "()")],
  },
  {
    path: "omni.isaac.kit",
    info: "Standalone 앱 실행",
    legacy: "Isaac Sim 4.2 이하",
    members: [cls("SimulationApp", '(launch_config={"headless": False})')],
  },
  {
    path: "omni.isaac.core",
    info: "World 기반 코어 API",
    legacy: "Isaac Sim 4.2 이하",
    members: [cls("World", "(stage_units_in_meters=1.0)")],
  },
];

export const MODULE_BY_PATH = new Map(ISAAC_MODULES.map((m) => [m.path, m]));
