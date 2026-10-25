"""Generate sample USD files for the web viewer.

Requires Pixar's USD Python bindings and Pillow:
    pip install usd-core pillow
    python scripts/generate_samples.py public/samples
"""

import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter
from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdPhysics, UsdShade, UsdSkel, UsdUtils, Vt

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "public/samples")


# ---------------------------------------------------------------- textures


def write_checker(path, size=256, cells=8, a=(235, 235, 235), b=(60, 64, 72)):
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    step = size // cells
    for y in range(cells):
        for x in range(cells):
            draw.rectangle([x * step, y * step, (x + 1) * step - 1, (y + 1) * step - 1], fill=a if (x + y) % 2 == 0 else b)
    img.save(path)


def write_wood(path, size=256, seed=7):
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size))
    px = img.load()
    phases = [rng.uniform(0, math.tau) for _ in range(4)]
    for y in range(size):
        for x in range(size):
            u, v = x / size, y / size
            ring = math.sin((u * 18 + 0.6 * math.sin(v * 6 + phases[0]) + 0.25 * math.sin(v * 23 + phases[1])) * math.pi)
            t = 0.5 + 0.5 * ring
            t = t ** 2.2
            r = int(150 + 60 * t)
            g = int(95 + 45 * t)
            b = int(55 + 25 * t)
            px[x, y] = (r, g, b)
    img.filter(ImageFilter.GaussianBlur(0.6)).save(path)


def write_stripes(path, size=256):
    img = Image.new("RGB", (size, size), (238, 232, 220))
    draw = ImageDraw.Draw(img)
    for i in range(0, size, 32):
        draw.rectangle([0, i, size, i + 10], fill=(32, 78, 140))
        draw.rectangle([0, i + 14, size, i + 16], fill=(196, 120, 52))
    img.save(path)


def write_tiles(path, size=256, n=4):
    img = Image.new("RGB", (size, size), (70, 70, 74))
    draw = ImageDraw.Draw(img)
    step = size // n
    rng = random.Random(3)
    for y in range(n):
        for x in range(n):
            c = 200 + rng.randint(-14, 14)
            draw.rectangle([x * step + 2, y * step + 2, (x + 1) * step - 3, (y + 1) * step - 3], fill=(c, c - 6, c - 14))
    img.save(path)


# ---------------------------------------------------------------- helpers


def make_material(stage, path, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5, texture=None, opacity=1.0, emissive=None):
    mat = UsdShade.Material.Define(stage, path)
    shader = UsdShade.Shader.Define(stage, path + "/PreviewSurface")
    shader.CreateIdAttr("UsdPreviewSurface")
    shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(metallic)
    shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(roughness)
    if opacity < 1.0:
        shader.CreateInput("opacity", Sdf.ValueTypeNames.Float).Set(opacity)
    if emissive:
        shader.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*emissive))
    if texture:
        reader = UsdShade.Shader.Define(stage, path + "/STReader")
        reader.CreateIdAttr("UsdPrimvarReader_float2")
        reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
        tex = UsdShade.Shader.Define(stage, path + "/DiffuseTexture")
        tex.CreateIdAttr("UsdUVTexture")
        tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(texture)
        tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), "result")
        tex.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("repeat")
        tex.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("repeat")
        tex.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB")
        tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
        shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), "rgb")
    else:
        shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color))
    mat.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
    return mat


def bind(prim, mat):
    UsdShade.MaterialBindingAPI.Apply(prim.GetPrim() if hasattr(prim, "GetPrim") else prim).Bind(mat)


def quad_plane(stage, path, size, uv_repeat, up="Y"):
    mesh = UsdGeom.Mesh.Define(stage, path)
    h = size / 2
    if up == "Y":
        pts = [(-h, 0, h), (h, 0, h), (h, 0, -h), (-h, 0, -h)]
        n = (0, 1, 0)
    else:
        pts = [(-h, -h, 0), (h, -h, 0), (h, h, 0), (-h, h, 0)]
        n = (0, 0, 1)
    mesh.CreatePointsAttr(pts)
    mesh.CreateFaceVertexCountsAttr([4])
    mesh.CreateFaceVertexIndicesAttr([0, 1, 2, 3])
    mesh.CreateNormalsAttr([n] * 4)
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    mesh.CreateExtentAttr([(-h, 0, -h), (h, 0, h)] if up == "Y" else [(-h, -h, 0), (h, h, 0)])
    st = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex)
    st.Set([(0, 0), (uv_repeat, 0), (uv_repeat, uv_repeat), (0, uv_repeat)])
    mesh.CreateSubdivisionSchemeAttr("none")
    return mesh


def lathe(stage, path, profile, segments=48, up="Y", uv_v_scale=1.0):
    """Surface of revolution. profile = list of strips; each strip is a list of (radius, height)."""
    mesh = UsdGeom.Mesh.Define(stage, path)
    points, normals, st, counts, indices = [], [], [], [], []
    ring_rows = []  # (row_index_start, strip_id)
    v_acc = 0.0
    for strip in profile:
        rows = []
        for i, (r, h) in enumerate(strip):
            prev = strip[max(i - 1, 0)]
            nxt = strip[min(i + 1, len(strip) - 1)]
            dr, dh = nxt[0] - prev[0], nxt[1] - prev[1]
            ln = math.hypot(dr, dh) or 1.0
            nr, nh = dh / ln, -dr / ln
            if i > 0:
                v_acc += math.hypot(r - strip[i - 1][0], h - strip[i - 1][1]) * uv_v_scale
            start = len(points)
            for j in range(segments + 1):
                a = 2 * math.pi * j / segments
                c, s = math.cos(a), math.sin(a)
                if up == "Y":
                    points.append((r * c, h, -r * s))
                    normals.append((nr * c, nh, -nr * s))
                else:
                    points.append((r * c, r * s, h))
                    normals.append((nr * c, nr * s, nh))
                st.append((j / segments, v_acc))
            rows.append(start)
        ring_rows.append(rows)
    face_rows = []
    for rows in ring_rows:
        for k in range(len(rows) - 1):
            row_faces = []
            for j in range(segments):
                a0, a1 = rows[k] + j, rows[k] + j + 1
                b0, b1 = rows[k + 1] + j, rows[k + 1] + j + 1
                row_faces.append(len(counts))
                counts.append(4)
                indices.extend([a0, a1, b1, b0])
            face_rows.append(row_faces)
    mesh.CreatePointsAttr(points)
    mesh.CreateNormalsAttr(normals)
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    mesh.CreateFaceVertexCountsAttr(counts)
    mesh.CreateFaceVertexIndicesAttr(indices)
    mesh.CreateSubdivisionSchemeAttr("none")
    mesh.CreateExtentAttr(UsdGeom.PointBased.ComputeExtent(Vt.Vec3fArray(points)))
    UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex).Set(st)
    return mesh, face_rows


def torus(stage, path, R=0.6, r=0.2, seg_u=64, seg_v=24):
    mesh = UsdGeom.Mesh.Define(stage, path)
    pts, nrm, st, counts, idx = [], [], [], [], []
    for i in range(seg_u + 1):
        u = 2 * math.pi * i / seg_u
        for j in range(seg_v + 1):
            v = 2 * math.pi * j / seg_v
            cx, cz = math.cos(u), math.sin(u)
            nx, ny, nz = math.cos(v) * cx, math.sin(v), math.cos(v) * cz
            pts.append(((R + r * math.cos(v)) * cx, r * math.sin(v), (R + r * math.cos(v)) * cz))
            nrm.append((nx, ny, nz))
            st.append((i / seg_u, j / seg_v))
    w = seg_v + 1
    for i in range(seg_u):
        for j in range(seg_v):
            a, b = i * w + j, (i + 1) * w + j
            counts.append(4)
            idx.extend([a, a + 1, b + 1, b])
    mesh.CreatePointsAttr(pts)
    mesh.CreateNormalsAttr(nrm)
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    mesh.CreateFaceVertexCountsAttr(counts)
    mesh.CreateFaceVertexIndicesAttr(idx)
    mesh.CreateSubdivisionSchemeAttr("none")
    UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex).Set(st)
    return mesh


def set_stage_meta(stage, up="Y", mpu=1.0, default_prim=None, start=None, end=None, fps=24):
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y if up == "Y" else UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, mpu)
    if default_prim:
        stage.SetDefaultPrim(stage.GetPrimAtPath(default_prim))
    if start is not None:
        stage.SetStartTimeCode(start)
        stage.SetEndTimeCode(end)
        stage.SetTimeCodesPerSecond(fps)
        stage.SetFramesPerSecond(fps)


# ---------------------------------------------------------------- samples


def sample_primitives():
    """ASCII .usda: UsdGeom primitives, PreviewSurface materials, textures, light, animation."""
    path = os.path.join(OUT, "primitives.usda")
    stage = Usd.Stage.CreateNew(path)
    world = UsdGeom.Xform.Define(stage, "/World")
    stage.GetRootLayer().documentation = "UsdGeom primitive showcase for the web viewer"

    looks = "/World/Looks"
    red = make_material(stage, looks + "/RedPlastic", (0.80, 0.08, 0.06), 0.0, 0.35)
    gold = make_material(stage, looks + "/Gold", (1.0, 0.77, 0.34), 1.0, 0.25)
    blue = make_material(stage, looks + "/BlueGlass", (0.15, 0.45, 0.95), 0.0, 0.05, opacity=0.45)
    green = make_material(stage, looks + "/GreenRubber", (0.20, 0.62, 0.30), 0.0, 0.85)
    white = make_material(stage, looks + "/Porcelain", (0.92, 0.92, 0.90), 0.0, 0.2)
    glow = make_material(stage, looks + "/Glow", (0.1, 0.1, 0.1), 0.0, 0.5, emissive=(1.0, 0.45, 0.1))
    floor_mat = make_material(stage, looks + "/Checker", texture="./textures/checker.png", roughness=0.8)

    floor = quad_plane(stage, "/World/Floor", 12, 6)
    bind(floor, floor_mat)

    shapes = UsdGeom.Xform.Define(stage, "/World/Shapes")
    cube = UsdGeom.Cube.Define(stage, "/World/Shapes/Cube")
    cube.CreateSizeAttr(1.0)
    cube.AddTranslateOp().Set((-3.0, 0.5, 0.0))
    cube.AddRotateYOp().Set(20.0)
    bind(cube, red)

    sphere = UsdGeom.Sphere.Define(stage, "/World/Shapes/Sphere")
    sphere.CreateRadiusAttr(0.6)
    sphere.AddTranslateOp().Set((-1.5, 0.6, 0.0))
    bind(sphere, gold)

    cyl = UsdGeom.Cylinder.Define(stage, "/World/Shapes/Cylinder")
    cyl.CreateRadiusAttr(0.5)
    cyl.CreateHeightAttr(1.2)
    cyl.CreateAxisAttr("Y")
    cyl.AddTranslateOp().Set((0.0, 0.6, 0.0))
    bind(cyl, blue)

    cone = UsdGeom.Cone.Define(stage, "/World/Shapes/Cone")
    cone.CreateRadiusAttr(0.5)
    cone.CreateHeightAttr(1.2)
    cone.CreateAxisAttr("Y")
    cone.AddTranslateOp().Set((1.5, 0.6, 0.0))
    bind(cone, green)

    cap = UsdGeom.Capsule.Define(stage, "/World/Shapes/Capsule")
    cap.CreateRadiusAttr(0.35)
    cap.CreateHeightAttr(0.8)
    cap.CreateAxisAttr("Y")
    cap.AddTranslateOp().Set((3.0, 0.75, 0.0))
    bind(cap, white)

    spinner = UsdGeom.Xform.Define(stage, "/World/Spinner")
    spinner.AddTranslateOp().Set((0.0, 1.9, -2.0))
    rot = spinner.AddRotateXYZOp()
    for f, v in [(0, (0, 0, 0)), (60, (180, 90, 0)), (120, (360, 180, 0))]:
        rot.Set(Gf.Vec3f(*v), f)
    ring = torus(stage, "/World/Spinner/Torus")
    bind(ring, gold)
    core = UsdGeom.Sphere.Define(stage, "/World/Spinner/Core")
    core.CreateRadiusAttr(0.25)
    bind(core, glow)

    sun = UsdLux.DistantLight.Define(stage, "/World/Sun")
    sun.CreateIntensityAttr(2.0)
    sun.CreateAngleAttr(1.0)
    sun.AddRotateXYZOp().Set((-50.0, 30.0, 0.0))

    set_stage_meta(stage, "Y", 1.0, "/World", 0, 120, 24)
    stage.GetRootLayer().Save()
    return path


def sample_vases():
    """Binary .usdc: Z-up, centimeters, lathe meshes with normals/UVs, GeomSubsets."""
    path = os.path.join(OUT, "vases_zup_cm.usdc")
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.Xform.Define(stage, "/Vases")
    looks = "/Vases/Looks"
    celadon = make_material(stage, looks + "/Celadon", (0.55, 0.75, 0.66), 0.0, 0.18)
    terracotta = make_material(stage, looks + "/Terracotta", (0.70, 0.33, 0.20), 0.0, 0.9)
    striped = make_material(stage, looks + "/Striped", texture="./textures/stripes.png", roughness=0.3)
    gold = make_material(stage, looks + "/GoldRim", (1.0, 0.78, 0.36), 1.0, 0.2)
    black = make_material(stage, looks + "/BlackGlaze", (0.03, 0.03, 0.035), 0.0, 0.08)

    base = quad_plane(stage, "/Vases/Plinth", 90, 1, up="Z")
    bind(base, make_material(stage, looks + "/Plinth", (0.85, 0.84, 0.80), 0.0, 0.7))

    def profile_vase(h, belly, neck, lip):
        body = []
        steps = 28
        for i in range(steps + 1):
            t = i / steps
            r = belly * math.sin(math.pi * min(t * 1.15, 1.0)) ** 0.8 + neck * t
            r = max(r, neck if t > 0.85 else 0.6 * belly * (1 - t) + neck)
            body.append((r, h * t))
        body[0] = (belly * 0.55, 0.0)
        bottom = [(0.0, 0.0), (belly * 0.55, 0.0)]
        rim = [(body[-1][0], h), (lip, h + 0.6), (lip - 0.6, h + 0.6)]
        return [bottom, body, rim]

    specs = [
        ("Amphora", (-30, 0), 34, 9.0, 3.2, 4.6, celadon),
        ("Jar", (0, 8), 22, 10.5, 6.5, 7.4, terracotta),
        ("Bottle", (28, -2), 30, 7.0, 1.6, 2.4, striped),
        ("Bowl", (6, -24), 9, 13.0, 12.5, 13.5, black),
    ]
    for name, (x, y), h, belly, neck, lip, mat in specs:
        xf = UsdGeom.Xform.Define(stage, f"/Vases/{name}")
        xf.AddTranslateOp().Set((x, y, 0.0))
        mesh, face_rows = lathe(stage, f"/Vases/{name}/Geom", profile_vase(h, belly, neck, lip), up="Z", uv_v_scale=1 / 12)
        bind(mesh, mat)
        # Gold rim as a GeomSubset on the last two face rows.
        rim_faces = [f for row in face_rows[-2:] for f in row]
        subset = UsdGeom.Subset.CreateGeomSubset(mesh, "Rim", UsdGeom.Tokens.face, Vt.IntArray(rim_faces), "materialBind")
        bind(subset, gold)
        UsdShade.MaterialBindingAPI(mesh.GetPrim()).SetMaterialBindSubsetsFamilyType(UsdGeom.Tokens.nonOverlapping)

    set_stage_meta(stage, "Z", 0.01, "/Vases")
    stage.GetRootLayer().Save()
    return path


def asset_stool():
    path = os.path.join(OUT, "props", "stool.usda")
    stage = Usd.Stage.CreateNew(path)
    root = UsdGeom.Xform.Define(stage, "/Stool")
    Usd.ModelAPI(root).SetKind("component")
    wood = make_material(stage, "/Stool/Looks/Oak", texture="./textures/wood.png", roughness=0.55)
    metal = make_material(stage, "/Stool/Looks/BrushedSteel", (0.75, 0.76, 0.78), 1.0, 0.35)
    seat, _ = lathe(stage, "/Stool/Seat", [[(0.0, 0.0), (0.19, 0.0)], [(0.19, 0.0), (0.2, 0.02), (0.19, 0.045)], [(0.19, 0.045), (0.0, 0.05)]], up="Y")
    seat.AddTranslateOp().Set((0, 0.45, 0))
    bind(seat, wood)
    legs = UsdGeom.Xform.Define(stage, "/Stool/Legs")
    for i, (x, z) in enumerate([(0.12, 0.12), (-0.12, 0.12), (-0.12, -0.12), (0.12, -0.12)]):
        leg = UsdGeom.Cylinder.Define(stage, f"/Stool/Legs/Leg{i + 1}")
        leg.CreateRadiusAttr(0.018)
        leg.CreateHeightAttr(0.45)
        leg.CreateAxisAttr("Y")
        leg.AddTranslateOp().Set((x, 0.225, z))
        bind(leg, metal)
    ring = UsdGeom.Xform.Define(stage, "/Stool/Legs/FootRing")
    ring.AddTranslateOp().Set((0, 0.16, 0))
    ring.AddScaleOp().Set((0.29, 0.06, 0.29))
    t = torus(stage, "/Stool/Legs/FootRing/Ring", R=0.6, r=0.05)
    bind(t, metal)
    set_stage_meta(stage, "Y", 1.0, "/Stool")
    stage.GetRootLayer().Save()


def asset_table():
    path = os.path.join(OUT, "props", "table.usda")
    stage = Usd.Stage.CreateNew(path)
    root = UsdGeom.Xform.Define(stage, "/Table")
    Usd.ModelAPI(root).SetKind("component")
    wood = make_material(stage, "/Table/Looks/Walnut", texture="./textures/wood.png", roughness=0.4)
    paint = make_material(stage, "/Table/Looks/MattBlack", (0.05, 0.05, 0.05), 0.0, 0.7)
    top = UsdGeom.Cube.Define(stage, "/Table/Top")
    top.CreateSizeAttr(1.0)
    top.AddTranslateOp().Set((0, 0.74, 0))
    top.AddScaleOp().Set((1.6, 0.04, 0.9))
    bind(top, wood)
    for i, (x, z) in enumerate([(0.72, 0.38), (-0.72, 0.38), (-0.72, -0.38), (0.72, -0.38)]):
        leg = UsdGeom.Cube.Define(stage, f"/Table/Leg{i + 1}")
        leg.CreateSizeAttr(1.0)
        leg.AddTranslateOp().Set((x, 0.36, z))
        leg.AddScaleOp().Set((0.05, 0.72, 0.05))
        bind(leg, paint)
    set_stage_meta(stage, "Y", 1.0, "/Table")
    stage.GetRootLayer().Save()


def sample_assembly():
    """Crate-encoded .usd: references to ASCII assets in a sub folder."""
    asset_stool()
    asset_table()
    path = os.path.join(OUT, "kitchen_assembly.usd")
    stage = Usd.Stage.CreateNew(path)
    scene = UsdGeom.Xform.Define(stage, "/Scene")
    Usd.ModelAPI(scene).SetKind("assembly")
    floor = quad_plane(stage, "/Scene/Floor", 5, 5)
    bind(floor, make_material(stage, "/Scene/Looks/Tiles", texture="./textures/tiles.png", roughness=0.6))

    table = stage.DefinePrim("/Scene/Table", "Xform")
    table.GetReferences().AddReference("./props/table.usda")

    placements = [(0.45, 0.62, 0), (-0.45, 0.62, 15), (0.45, -0.62, -10), (-0.45, -0.62, 200), (1.15, 0.0, 95)]
    for i, (x, z, ry) in enumerate(placements):
        stool = stage.DefinePrim(f"/Scene/Stool_{i + 1:02d}", "Xform")
        stool.GetReferences().AddReference("./props/stool.usda")
        xf = UsdGeom.Xformable(stool)
        xf.AddTranslateOp().Set((x, 0, z))
        xf.AddRotateYOp().Set(float(ry))

    set_stage_meta(stage, "Y", 1.0, "/Scene")
    stage.GetRootLayer().Save()
    return path


def sample_sublayers():
    """ASCII root layer that sublayers a set layer from another folder and overrides it."""
    set_path = os.path.join(OUT, "layers", "set.usda")
    stage = Usd.Stage.CreateNew(set_path)
    UsdGeom.Xform.Define(stage, "/World")
    red = make_material(stage, "/World/Looks/Red", (0.85, 0.1, 0.08), 0.0, 0.3)
    blue = make_material(stage, "/World/Looks/Blue", (0.1, 0.3, 0.9), 0.0, 0.3)
    make_material(stage, "/World/Looks/Green", (0.15, 0.7, 0.25), 0.0, 0.3)
    ground = quad_plane(stage, "/World/Ground", 6, 3)
    bind(ground, make_material(stage, "/World/Looks/Checker", texture="../textures/checker.png", roughness=0.8))
    ball = UsdGeom.Sphere.Define(stage, "/World/Ball")
    ball.CreateRadiusAttr(0.5)
    ball.AddTranslateOp().Set((-1.0, 0.5, 0.0))
    bind(ball, red)
    box = UsdGeom.Cube.Define(stage, "/World/Box")
    box.CreateSizeAttr(0.8)
    box.AddTranslateOp().Set((1.0, 0.4, 0.0))
    bind(box, blue)
    set_stage_meta(stage, "Y", 1.0, "/World")
    stage.GetRootLayer().Save()

    shot_path = os.path.join(OUT, "sublayers_shot.usda")
    shot = Usd.Stage.CreateNew(shot_path)
    shot.GetRootLayer().subLayerPaths.append("./layers/set.usda")
    ball_over = shot.OverridePrim("/World/Ball")
    ball_over.GetAttribute("xformOp:translate").Set(Gf.Vec3d(-1.0, 1.2, 0.6))
    UsdShade.MaterialBindingAPI.Apply(ball_over).Bind(UsdShade.Material(shot.GetPrimAtPath("/World/Looks/Green")))
    cone = UsdGeom.Cone.Define(shot, "/World/AddedInShot")
    cone.CreateRadiusAttr(0.35)
    cone.CreateHeightAttr(0.9)
    cone.CreateAxisAttr("Y")
    cone.AddTranslateOp().Set((0.0, 0.45, -1.2))
    UsdShade.MaterialBindingAPI.Apply(cone.GetPrim()).Bind(UsdShade.Material(shot.GetPrimAtPath("/World/Looks/Red")))
    set_stage_meta(shot, "Y", 1.0, "/World")
    shot.GetRootLayer().Save()
    return shot_path


def sample_skinned():
    """ASCII .usda: UsdSkel tube driven by a SkelAnimation."""
    path = os.path.join(OUT, "skinned_tentacle.usda")
    stage = Usd.Stage.CreateNew(path)
    root = UsdSkel.Root.Define(stage, "/Tentacle")
    skel = UsdSkel.Skeleton.Define(stage, "/Tentacle/Skel")
    n_joints = 5
    seg = 0.6
    joints, names = [], []
    for i in range(n_joints):
        names.append(f"J{i}")
        joints.append("/".join(names))
    skel.CreateJointsAttr(joints)
    bind_xf = [Gf.Matrix4d().SetTranslate(Gf.Vec3d(0, i * seg, 0)) for i in range(n_joints)]
    rest_xf = [Gf.Matrix4d().SetTranslate(Gf.Vec3d(0, 0 if i == 0 else seg, 0)) for i in range(n_joints)]
    skel.CreateBindTransformsAttr(bind_xf)
    skel.CreateRestTransformsAttr(rest_xf)

    anim = UsdSkel.Animation.Define(stage, "/Tentacle/Skel/Wave")
    anim.CreateJointsAttr(joints)
    anim.CreateTranslationsAttr([Gf.Vec3f(0, 0 if i == 0 else seg, 0) for i in range(n_joints)])
    anim.CreateScalesAttr([Gf.Vec3h(1, 1, 1)] * n_joints)
    rot_attr = anim.CreateRotationsAttr()
    for f in range(0, 97, 4):
        rots = []
        for i in range(n_joints):
            ang = 0 if i == 0 else 22 * math.sin(f / 96 * 2 * math.pi + i * 0.7)
            q = Gf.Rotation(Gf.Vec3d(0, 0, 1), ang).GetQuat()
            rots.append(Gf.Quatf(q.GetReal(), Gf.Vec3f(q.GetImaginary())))
        rot_attr.Set(rots, f)
    UsdSkel.BindingAPI.Apply(skel.GetPrim()).CreateAnimationSourceRel().SetTargets([anim.GetPath()])

    # Tapered tube along +Y.
    rings, sides = 24, 20
    height = seg * (n_joints - 1) + 0.3
    mesh = UsdGeom.Mesh.Define(stage, "/Tentacle/Tube")
    pts, nrm, counts, idx, jidx, jw = [], [], [], [], [], []
    for r in range(rings + 1):
        y = height * r / rings
        rad = 0.28 * (1 - 0.8 * r / rings) + 0.02
        f = y / seg
        j0 = min(int(f), n_joints - 1)
        j1 = min(j0 + 1, n_joints - 1)
        w1 = min(max(f - j0, 0.0), 1.0) if j1 != j0 else 0.0
        for s in range(sides):
            a = 2 * math.pi * s / sides
            pts.append((rad * math.cos(a), y, rad * math.sin(a)))
            nrm.append((math.cos(a), 0.15, math.sin(a)))
            jidx.extend([j0, j1])
            jw.extend([1 - w1, w1])
    for r in range(rings):
        for s in range(sides):
            a = r * sides + s
            b = r * sides + (s + 1) % sides
            counts.append(4)
            idx.extend([a, (r + 1) * sides + s, (r + 1) * sides + (s + 1) % sides, b])
    mesh.CreatePointsAttr(pts)
    mesh.CreateNormalsAttr(nrm)
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    mesh.CreateFaceVertexCountsAttr(counts)
    mesh.CreateFaceVertexIndicesAttr(idx)
    mesh.CreateSubdivisionSchemeAttr("none")
    binding = UsdSkel.BindingAPI.Apply(mesh.GetPrim())
    binding.CreateSkeletonRel().SetTargets([skel.GetPath()])
    binding.CreateJointIndicesPrimvar(False, 2).Set(jidx)
    binding.CreateJointWeightsPrimvar(False, 2).Set(jw)
    binding.CreateGeomBindTransformAttr(Gf.Matrix4d(1))
    bind(mesh, make_material(stage, "/Tentacle/Looks/Coral", (0.95, 0.42, 0.38), 0.0, 0.45))

    set_stage_meta(stage, "Y", 1.0, "/Tentacle", 0, 96, 24)
    stage.GetRootLayer().Save()
    return path


def sample_composition():
    """Binary .usdc: variants, payloads, explicit-prim references, inactive/invisible/over-only prims."""
    lib = Usd.Stage.CreateNew(os.path.join(OUT, "parts", "hardware.usdc"))
    UsdGeom.Xform.Define(lib, "/Gear")
    gear, _ = lathe(lib, "/Gear/Body", [[(0.0, 0.0), (0.5, 0.0)], [(0.5, 0.0), (0.5, 0.15)], [(0.5, 0.15), (0.0, 0.15)]], segments=12)
    bind(gear, make_material(lib, "/Gear/Looks/Brass", (0.85, 0.62, 0.25), 1.0, 0.3))
    UsdGeom.Xform.Define(lib, "/Bolt")
    head = UsdGeom.Cylinder.Define(lib, "/Bolt/Head")
    head.CreateRadiusAttr(0.18)
    head.CreateHeightAttr(0.12)
    head.CreateAxisAttr("Y")
    head.AddTranslateOp().Set((0, 0.5, 0))
    shaft = UsdGeom.Cylinder.Define(lib, "/Bolt/Shaft")
    shaft.CreateRadiusAttr(0.07)
    shaft.CreateHeightAttr(0.5)
    shaft.CreateAxisAttr("Y")
    shaft.AddTranslateOp().Set((0, 0.25, 0))
    steel = make_material(lib, "/Bolt/Looks/Steel", (0.7, 0.72, 0.75), 1.0, 0.25)
    bind(head, steel)
    bind(shaft, steel)
    set_stage_meta(lib, "Y", 1.0, "/Gear")
    lib.GetRootLayer().Save()

    path = os.path.join(OUT, "composition_arcs.usdc")
    st = Usd.Stage.CreateNew(path)
    UsdGeom.Xform.Define(st, "/World")
    looks = "/World/Looks"
    colors = {"Red": (0.85, 0.15, 0.12), "Teal": (0.1, 0.6, 0.6), "Violet": (0.5, 0.3, 0.85)}
    mats = {k: make_material(st, f"{looks}/{k}", c, 0.0, 0.35) for k, c in colors.items()}

    # Payload to the library's defaultPrim, and a reference to an explicit non-default prim.
    gear_prim = st.DefinePrim("/World/GearPayload", "Xform")
    gear_prim.GetPayloads().AddPayload("./parts/hardware.usdc")
    UsdGeom.Xformable(gear_prim).AddTranslateOp().Set((-1.2, 0, 0))
    bolt_prim = st.DefinePrim("/World/BoltReference", "Xform")
    bolt_prim.GetReferences().AddReference("./parts/hardware.usdc", "/Bolt")
    UsdGeom.Xformable(bolt_prim).AddTranslateOp().Set((0, 0, 0))

    # Variant set: the viewer composes the authored selection ("ball").
    shape = UsdGeom.Xform.Define(st, "/World/Shape")
    shape.AddTranslateOp().Set((1.2, 0.4, 0))
    vset = shape.GetPrim().GetVariantSets().AddVariantSet("shape")
    for name in ("box", "ball", "cone"):
        vset.AddVariant(name)
        vset.SetVariantSelection(name)
        with vset.GetVariantEditContext():
            geo = {"box": UsdGeom.Cube, "ball": UsdGeom.Sphere, "cone": UsdGeom.Cone}[name].Define(st, "/World/Shape/Geo")
            if name == "box":
                geo.CreateSizeAttr(0.8)
            elif name == "ball":
                geo.CreateRadiusAttr(0.4)
            else:
                geo.CreateRadiusAttr(0.4)
                geo.CreateHeightAttr(0.8)
                geo.CreateAxisAttr("Y")
            bind(geo, mats[{"box": "Red", "ball": "Teal", "cone": "Violet"}[name]])
    vset.SetVariantSelection("ball")

    # Prims a USD renderer would not draw.
    inactive = UsdGeom.Sphere.Define(st, "/World/Inactive")
    inactive.GetPrim().SetActive(False)
    invisible = UsdGeom.Cube.Define(st, "/World/Invisible")
    invisible.AddTranslateOp().Set((0, 0.5, 1.2))
    invisible.MakeInvisible()
    guide = UsdGeom.Cube.Define(st, "/World/GuideBox")
    guide.CreatePurposeAttr("guide")
    st.CreateClassPrim("/_Template")
    st.OverridePrim("/World/OverOnly")

    floor = quad_plane(st, "/World/Floor", 4, 4)
    bind(floor, make_material(st, f"{looks}/Checker", texture="./textures/checker.png", roughness=0.8))
    set_stage_meta(st, "Y", 1.0, "/World")
    st.GetRootLayer().Save()
    return path


# ---------------------------------------------------------------- physics


def physics_scene(stage, path, direction, magnitude):
    scene = UsdPhysics.Scene.Define(stage, path)
    scene.CreateGravityDirectionAttr(Gf.Vec3f(*direction))
    scene.CreateGravityMagnitudeAttr(magnitude)
    return scene


def physics_material(stage, path, static_friction, dynamic_friction, restitution, density=None):
    mat = UsdShade.Material.Define(stage, path)
    api = UsdPhysics.MaterialAPI.Apply(mat.GetPrim())
    api.CreateStaticFrictionAttr(static_friction)
    api.CreateDynamicFrictionAttr(dynamic_friction)
    api.CreateRestitutionAttr(restitution)
    if density is not None:
        api.CreateDensityAttr(density)
    return mat


def bind_physics(prim, mat):
    prim = prim.GetPrim() if hasattr(prim, "GetPrim") else prim
    UsdShade.MaterialBindingAPI.Apply(prim).Bind(mat, UsdShade.Tokens.weakerThanDescendants, "physics")


def rigid(prim, mass=None, density=None, velocity=None, angular=None):
    prim = prim.GetPrim() if hasattr(prim, "GetPrim") else prim
    body = UsdPhysics.RigidBodyAPI.Apply(prim)
    if velocity:
        body.CreateVelocityAttr(Gf.Vec3f(*velocity))
    if angular:
        body.CreateAngularVelocityAttr(Gf.Vec3f(*angular))
    UsdPhysics.CollisionAPI.Apply(prim)
    if mass is not None or density is not None:
        api = UsdPhysics.MassAPI.Apply(prim)
        if mass is not None:
            api.CreateMassAttr(mass)
        if density is not None:
            api.CreateDensityAttr(density)
    return prim


def collider(prim, approximation=None):
    prim = prim.GetPrim() if hasattr(prim, "GetPrim") else prim
    UsdPhysics.CollisionAPI.Apply(prim)
    if approximation:
        UsdPhysics.MeshCollisionAPI.Apply(prim).CreateApproximationAttr(approximation)
    return prim


def box(stage, path, size, pos, mat=None, rot_y=None):
    cube = UsdGeom.Cube.Define(stage, path)
    cube.CreateSizeAttr(1.0)
    cube.AddTranslateOp().Set(Gf.Vec3d(*pos))
    if rot_y is not None:
        cube.AddRotateYOp().Set(rot_y)
    cube.AddScaleOp().Set(Gf.Vec3f(*size))
    if mat:
        bind(cube, mat)
    return cube


def sphere(stage, path, radius, pos, mat=None):
    s = UsdGeom.Sphere.Define(stage, path)
    s.CreateRadiusAttr(radius)
    s.AddTranslateOp().Set(Gf.Vec3d(*pos))
    if mat:
        bind(s, mat)
    return s


def joint_frames(joint, anchor, body0_pos, body1_pos, scale0=1.0, scale1=1.0):
    """Joint frames at a world anchor for unrotated bodies (body0_pos None = world).

    localPos is expressed in the body's local space, so it is divided by the body's (uniform) scale.
    """
    a = Gf.Vec3f(*anchor)
    joint.CreateLocalPos0Attr(a if body0_pos is None else (a - Gf.Vec3f(*body0_pos)) / scale0)
    joint.CreateLocalPos1Attr((a - Gf.Vec3f(*body1_pos)) / scale1)
    joint.CreateLocalRot0Attr(Gf.Quatf(1, 0, 0, 0))
    joint.CreateLocalRot1Attr(Gf.Quatf(1, 0, 0, 0))


def sample_physics_playground():
    """ASCII .usda: rigid bodies, static colliders, physics materials, convex hull mesh, initial velocity."""
    path = os.path.join(OUT, "physics_playground.usda")
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.Xform.Define(stage, "/World")
    physics_scene(stage, "/World/PhysicsScene", (0, -1, 0), 9.81)
    looks = "/World/Looks"
    concrete = make_material(stage, looks + "/Concrete", (0.55, 0.56, 0.58), 0.0, 0.85)
    crate = make_material(stage, looks + "/Crate", texture="./props/textures/wood.png", roughness=0.6)
    rubber = make_material(stage, looks + "/RedRubber", (0.85, 0.12, 0.1), 0.0, 0.5)
    ice = make_material(stage, looks + "/Ice", (0.7, 0.85, 0.95), 0.0, 0.08)
    steel = make_material(stage, looks + "/Steel", (0.75, 0.76, 0.78), 1.0, 0.3)
    teal = make_material(stage, looks + "/Teal", (0.1, 0.6, 0.6), 0.0, 0.35)

    bouncy = physics_material(stage, "/World/PhysicsMaterials/Bouncy", 0.6, 0.5, 0.85)
    slippery = physics_material(stage, "/World/PhysicsMaterials/Slippery", 0.03, 0.02, 0.0)
    wood = physics_material(stage, "/World/PhysicsMaterials/Wood", 0.6, 0.5, 0.1, density=600)

    ground = box(stage, "/World/Ground", (14, 0.2, 10), (0, -0.1, 0), concrete)
    collider(ground)

    # Box pyramid.
    stack = UsdGeom.Xform.Define(stage, "/World/Stack")
    s = 0.5
    n = 0
    for row in range(4):
        for i in range(4 - row):
            x = -4.0 + (i - (3 - row) / 2) * (s + 0.01)
            b = box(stage, f"/World/Stack/Crate_{n:02d}", (s, s, s), (x, s / 2 + row * (s + 0.002), -1.0), crate)
            rigid(b)
            bind_physics(b, wood)
            n += 1

    # Bouncy balls dropped from different heights.
    for i, h in enumerate((2.0, 3.0, 4.0)):
        ball = sphere(stage, f"/World/Ball_{i + 1}", 0.25, (-1.0 + i * 0.8, h, 1.5), rubber)
        rigid(ball, mass=0.5)
        bind_physics(ball, bouncy)

    # Low-friction ramp with a block sliding down.
    ramp = box(stage, "/World/Ramp", (4, 0.15, 1.5), (2.5, 1.0, -1.5), ice)
    ramp.AddRotateZOp().Set(-20.0)  # appended after scale: rotates the scaled box in its parent frame
    ramp.SetXformOpOrder([ramp.GetOrderedXformOps()[0], ramp.GetOrderedXformOps()[2], ramp.GetOrderedXformOps()[1]])
    collider(ramp)
    bind_physics(ramp, slippery)
    tilt = math.radians(-20.0)
    along, normal = (math.cos(tilt), math.sin(tilt)), (-math.sin(tilt), math.cos(tilt))
    block_pos = (2.5 - 1.5 * along[0] + 0.23 * normal[0], 1.0 - 1.5 * along[1] + 0.23 * normal[1], -1.5)
    slider = box(stage, "/World/IceBlock", (0.4, 0.3, 0.4), block_pos, ice)
    slider.AddRotateZOp().Set(-20.0)
    slider.SetXformOpOrder([slider.GetOrderedXformOps()[0], slider.GetOrderedXformOps()[2], slider.GetOrderedXformOps()[1]])
    rigid(slider, mass=1.0)
    bind_physics(slider, slippery)

    # Convex-hull mesh (a vase) tipping over, and a thrown capsule.
    vase, _ = lathe(stage, "/World/Vase", [[(0.0, 0.0), (0.18, 0.0)], [(0.18, 0.0), (0.3, 0.35), (0.22, 0.7), (0.12, 0.9), (0.15, 1.0)]], segments=24)
    # Lifted so the tilted base starts just above the ground instead of inside it.
    vase.AddTranslateOp().Set(Gf.Vec3d(3.0, 0.06, 1.5))
    vase.AddRotateZOp().Set(12.0)
    bind(vase, teal)
    rigid(vase, mass=2.0)
    collider(vase, "convexHull")

    cap = UsdGeom.Capsule.Define(stage, "/World/ThrownCapsule")
    cap.CreateRadiusAttr(0.15)
    cap.CreateHeightAttr(0.5)
    cap.CreateAxisAttr("X")
    cap.AddTranslateOp().Set(Gf.Vec3d(-5.5, 1.0, 1.5))
    bind(cap, steel)
    rigid(cap, mass=1.0, velocity=(4.0, 5.0, 0.0), angular=(0.0, 0.0, 360.0))

    set_stage_meta(stage, "Y", 1.0, "/World")
    stage.GetRootLayer().Save()
    return path


def sample_physics_joints():
    """Binary .usdc: revolute chain, motor drive, prismatic limits+drive, spherical cone, fixed, distance joints."""
    path = os.path.join(OUT, "physics_joints.usdc")
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.Xform.Define(stage, "/World")
    physics_scene(stage, "/World/PhysicsScene", (0, -1, 0), 9.81)
    looks = "/World/Looks"
    dark = make_material(stage, looks + "/Dark", (0.12, 0.13, 0.15), 0.0, 0.6)
    orange = make_material(stage, looks + "/Orange", (0.95, 0.45, 0.1), 0.0, 0.4)
    blue = make_material(stage, looks + "/Blue", (0.15, 0.4, 0.9), 0.0, 0.35)
    green = make_material(stage, looks + "/Green", (0.2, 0.7, 0.35), 0.0, 0.4)
    gold = make_material(stage, looks + "/Gold", (1.0, 0.77, 0.34), 1.0, 0.25)
    floor = make_material(stage, looks + "/Floor", (0.5, 0.52, 0.55), 0.0, 0.9)

    ground = box(stage, "/World/Ground", (14, 0.2, 8), (0, -0.1, 0), floor)
    collider(ground)
    joints = UsdGeom.Scope.Define(stage, "/World/Joints")

    # Revolute pendulum chain hanging from a static anchor, starting horizontal.
    anchor = (-4.5, 4.0, 0.0)
    a = box(stage, "/World/Chain/Anchor", (0.25, 0.25, 0.25), anchor, dark)
    collider(a)
    prev_path, prev_pos = "/World/Chain/Anchor", anchor
    link_len = 0.8
    for i in range(4):
        center = (anchor[0] + link_len * (i + 0.5), anchor[1], anchor[2])
        cap = UsdGeom.Capsule.Define(stage, f"/World/Chain/Link_{i + 1}")
        cap.CreateRadiusAttr(0.09)
        cap.CreateHeightAttr(link_len - 0.2)
        cap.CreateAxisAttr("X")
        cap.AddTranslateOp().Set(Gf.Vec3d(*center))
        bind(cap, orange)
        rigid(cap, mass=0.5)
        j = UsdPhysics.RevoluteJoint.Define(stage, f"/World/Joints/ChainHinge_{i + 1}")
        j.CreateBody0Rel().SetTargets([prev_path])
        j.CreateBody1Rel().SetTargets([cap.GetPath()])
        j.CreateAxisAttr("Z")
        joint_frames(j, (anchor[0] + link_len * i, anchor[1], anchor[2]), prev_pos, center)
        prev_path, prev_pos = cap.GetPath(), center

    # Motor: a paddle driven at constant angular velocity about X, anchored to the world.
    pivot = (-1.0, 1.4, 0.0)
    paddle = box(stage, "/World/Motor/Paddle", (0.12, 1.8, 0.25), pivot, blue)
    rigid(paddle, mass=2.0)
    m = UsdPhysics.RevoluteJoint.Define(stage, "/World/Joints/MotorHinge")
    m.CreateBody1Rel().SetTargets([paddle.GetPath()])
    m.CreateAxisAttr("X")
    joint_frames(m, pivot, None, pivot)
    drive = UsdPhysics.DriveAPI.Apply(m.GetPrim(), "angular")
    drive.CreateTypeAttr("force")
    drive.CreateTargetVelocityAttr(120.0)
    drive.CreateStiffnessAttr(0.0)
    drive.CreateDampingAttr(1000.0)
    drive.CreateMaxForceAttr(1.0e6)

    # Prismatic slider along X with limits and a position drive.
    rail_y = 0.6
    UsdGeom.Xform.Define(stage, "/World/Slider")
    rail = box(stage, "/World/Slider/Rail", (2.4, 0.05, 0.05), (1.5, rail_y, 0.0), dark)
    cart = box(stage, "/World/Slider/Cart", (0.4, 0.3, 0.3), (0.5, rail_y, 0.0), green)
    rigid(cart, mass=1.0)
    p = UsdPhysics.PrismaticJoint.Define(stage, "/World/Joints/SliderTrack")
    p.CreateBody1Rel().SetTargets([cart.GetPath()])
    p.CreateAxisAttr("X")
    p.CreateLowerLimitAttr(-0.2)
    p.CreateUpperLimitAttr(1.8)
    joint_frames(p, (0.5, rail_y, 0.0), None, (0.5, rail_y, 0.0))
    pdrive = UsdPhysics.DriveAPI.Apply(p.GetPrim(), "linear")
    pdrive.CreateTypeAttr("force")
    pdrive.CreateTargetPositionAttr(1.5)
    pdrive.CreateStiffnessAttr(40.0)
    pdrive.CreateDampingAttr(4.0)
    del rail

    # Spherical joint with a cone limit, given a sideways push.
    s_anchor = (3.5, 3.5, 0.0)
    bob = sphere(stage, "/World/Spherical/Bob", 0.25, (3.5, 2.0, 0.0), gold)
    rigid(bob, mass=1.0, velocity=(0.0, 0.0, 3.0))
    sj = UsdPhysics.SphericalJoint.Define(stage, "/World/Joints/BallSocket")
    sj.CreateBody1Rel().SetTargets([bob.GetPath()])
    sj.CreateAxisAttr("Y")
    sj.CreateConeAngle0LimitAttr(40.0)
    sj.CreateConeAngle1LimitAttr(40.0)
    joint_frames(sj, s_anchor, None, (3.5, 2.0, 0.0))
    box(stage, "/World/Spherical/Mount", (0.2, 0.2, 0.2), s_anchor, dark)

    # Fixed joint: two welded crates falling as one.
    w1 = box(stage, "/World/Welded/CrateA", (0.5, 0.5, 0.5), (-2.0, 2.5, 2.0), orange)
    w2 = box(stage, "/World/Welded/CrateB", (0.5, 0.5, 0.5), (-1.55, 2.95, 2.0), blue)
    rigid(w1, mass=1.0, angular=(0.0, 0.0, 90.0))
    rigid(w2, mass=1.0)
    f = UsdPhysics.FixedJoint.Define(stage, "/World/Joints/Weld")
    f.CreateBody0Rel().SetTargets([w1.GetPath()])
    f.CreateBody1Rel().SetTargets([w2.GetPath()])
    joint_frames(f, (-1.775, 2.725, 2.0), (-2.0, 2.5, 2.0), (-1.55, 2.95, 2.0), 0.5, 0.5)

    # Distance joint: a weight on a 1.4 m rope, released sideways.
    rope_anchor = (1.5, 3.8, 2.0)
    weight = sphere(stage, "/World/Rope/Weight", 0.2, (2.5, 3.8, 2.0), green)
    rigid(weight, mass=1.0)
    d = UsdPhysics.DistanceJoint.Define(stage, "/World/Joints/Rope")
    d.CreateBody1Rel().SetTargets([weight.GetPath()])
    d.CreateMinDistanceAttr(0.0)
    d.CreateMaxDistanceAttr(1.4)
    d.CreateLocalPos0Attr(Gf.Vec3f(*rope_anchor))
    d.CreateLocalPos1Attr(Gf.Vec3f(0, 0, 0))
    box(stage, "/World/Rope/Hook", (0.15, 0.15, 0.15), rope_anchor, dark)
    del joints

    set_stage_meta(stage, "Y", 1.0, "/World")
    stage.GetRootLayer().Save()
    return path


def sample_physics_dominoes():
    """Crate-encoded .usd, Z-up and centimetres: dominoes along an arc knocked over by a rolling ball."""
    path = os.path.join(OUT, "physics_dominoes_zup_cm.usd")
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.Xform.Define(stage, "/Dominoes")
    physics_scene(stage, "/Dominoes/PhysicsScene", (0, 0, -1), 981.0)
    looks = "/Dominoes/Looks"
    ivory = make_material(stage, looks + "/Ivory", (0.93, 0.9, 0.82), 0.0, 0.3)
    ebony = make_material(stage, looks + "/Ebony", (0.08, 0.08, 0.09), 0.0, 0.25)
    table = make_material(stage, looks + "/Table", texture="./props/textures/wood.png", roughness=0.5)
    steel = make_material(stage, looks + "/Steel", (0.8, 0.8, 0.82), 1.0, 0.2)
    felt = physics_material(stage, "/Dominoes/PhysicsMaterials/Felt", 0.5, 0.4, 0.05)

    top = UsdGeom.Cube.Define(stage, "/Dominoes/Table")
    top.CreateSizeAttr(1.0)
    top.AddTranslateOp().Set(Gf.Vec3d(0, 0, -2.5))
    top.AddScaleOp().Set(Gf.Vec3f(320, 200, 5))
    bind(top, table)
    collider(top)
    bind_physics(top, felt)

    count, radius = 22, 90.0
    for i in range(count):
        ang = math.radians(-70 + 140 * i / (count - 1))
        x, y = radius * math.sin(ang), radius * (1 - math.cos(ang)) - 40
        d = UsdGeom.Cube.Define(stage, f"/Dominoes/Domino_{i:02d}")
        d.CreateSizeAttr(1.0)
        d.AddTranslateOp().Set(Gf.Vec3d(x, y, 8.0))
        d.AddRotateZOp().Set(math.degrees(ang))
        d.AddScaleOp().Set(Gf.Vec3f(1.6, 8.0, 16.0))
        bind(d, ivory if i % 2 == 0 else ebony)
        rigid(d, mass=0.06)
        bind_physics(d, felt)

    # Roll the ball along the arc's tangent into the first domino.
    first = math.radians(-70)
    tx, ty = math.cos(first), math.sin(first)
    x0, y0 = radius * math.sin(first), radius * (1 - math.cos(first)) - 40
    ball = sphere(stage, "/Dominoes/Ball", 4.0, (x0 - 25 * tx, y0 - 25 * ty, 4.0), steel)
    rigid(ball, mass=0.4, velocity=(160.0 * tx, 160.0 * ty, 0.0))

    set_stage_meta(stage, "Z", 0.01, "/Dominoes")
    stage.GetRootLayer().Save()
    return path


def main():
    os.makedirs(os.path.join(OUT, "textures"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "props", "textures"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "layers"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "parts"), exist_ok=True)
    write_checker(os.path.join(OUT, "textures", "checker.png"))
    write_stripes(os.path.join(OUT, "textures", "stripes.png"))
    write_tiles(os.path.join(OUT, "textures", "tiles.png"))
    write_wood(os.path.join(OUT, "props", "textures", "wood.png"))

    outputs = [
        sample_primitives(),
        sample_vases(),
        sample_assembly(),
        sample_sublayers(),
        sample_skinned(),
        sample_composition(),
        sample_physics_playground(),
        sample_physics_joints(),
        sample_physics_dominoes(),
    ]

    usdz = os.path.join(OUT, "kitchen_packaged.usdz")
    UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(os.path.join(OUT, "kitchen_assembly.usd")), usdz)
    outputs.append(usdz)

    for p in outputs:
        print(f"{os.path.relpath(p, OUT):32s} {os.path.getsize(p):>9,d} bytes")


if __name__ == "__main__":
    main()
