"""Local NVIDIA Newton physics server for the USD web viewer.

The browser uploads the stage's USD files over a WebSocket; this server
composes them with OpenUSD, builds a Newton model from the UsdPhysics schema
(plus surface deformables, i.e. cloth), steps it in real time and streams rigid
body poses and cloth particle positions back.

    python server/newton/server.py --device cuda:0

Protocol (JSON text messages + binary frames), see server/newton/README.md.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import shutil
import tempfile
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath

import numpy as np
import warp as wp
from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics, Vt
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

import newton

from scripts import ScriptRun, find_isaac_sim, origin_allowed

MAX_UPLOAD_BYTES = 1 << 30
# Mouse spring as accelerations (1/s^2, 1/s), independent of body mass and stage units.
DRAG_STIFFNESS = 400.0
DRAG_DAMPING = 40.0
# Cloth contact (VBD). Stiffness/damping are in kg/s^2 and kg/s, which do not depend
# on the length unit; distances are given in meters and converted to stage units.
CLOTH_CONTACT_KE = 1.0e4
CLOTH_CONTACT_KD = 1.0e1
CLOTH_CONTACT_MU = 0.5
CLOTH_CONTACT_GAP = 0.01
CLOTH_SELF_CONTACT_MARGIN = 0.01
CLOTH_SELF_CONTACT_GAP = 0.005
# Mouse spring on cloth as accelerations (1/s^2, 1/s), applied to every particle
# within CLOTH_DRAG_RADIUS (m) of the grabbed one.
CLOTH_DRAG_STIFFNESS = 6.0e4
CLOTH_DRAG_DAMPING = 250.0
CLOTH_DRAG_RADIUS = 0.05
MAX_GRABBED_PARTICLES = 64
# Linear air drag on cloth (1/s). Without it a swinging cloth barely loses energy.
CLOTH_AIR_DRAG = 1.5
# Dynamic bodies that start interpenetrating deeper than this (m) ignore each other
# until they separate; XPBD would push them apart violently.
INITIAL_OVERLAP = 0.005
# A drive force limit at or above this is treated as none (UsdPhysics' default is FLT_MAX).
UNLIMITED_FORCE = 1.0e30


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


@wp.kernel
def pull_particles(
    grabbed: wp.array(dtype=int),
    grabbed_count: wp.array(dtype=int),
    offsets: wp.array(dtype=wp.vec3),
    target: wp.array(dtype=wp.vec3),
    stiffness: float,
    damping: float,
    particle_q: wp.array(dtype=wp.vec3),
    particle_qd: wp.array(dtype=wp.vec3),
    particle_mass: wp.array(dtype=float),
    particle_f: wp.array(dtype=wp.vec3),
):
    """Spring-damper pulling a grabbed cloth patch so each point keeps its offset from the target.

    A force (not a teleport) keeps VBD's own contact history consistent; it is
    integrated explicitly, so stiffness * dt^2 must stay well below 1.
    """
    tid = wp.tid()
    if tid >= grabbed_count[0]:
        return
    i = grabbed[tid]
    goal = target[0] + offsets[tid]
    particle_f[i] = particle_f[i] + particle_mass[i] * (stiffness * (goal - particle_q[i]) - damping * particle_qd[i])


@wp.kernel
def pose_kinematic(
    bodies: wp.array(dtype=int),
    start: wp.array(dtype=wp.transform),
    end: wp.array(dtype=wp.transform),
    velocity: wp.array(dtype=wp.spatial_vector),
    alpha: float,
    body_q: wp.array(dtype=wp.transform),
    body_qd: wp.array(dtype=wp.spatial_vector),
):
    """Move animated kinematic bodies `alpha` of the way through this frame (solvers pass them through unchanged)."""
    i = wp.tid()
    b = bodies[i]
    p = wp.lerp(wp.transform_get_translation(start[i]), wp.transform_get_translation(end[i]), alpha)
    q = wp.quat_slerp(wp.transform_get_rotation(start[i]), wp.transform_get_rotation(end[i]), alpha)
    body_q[b] = wp.transform(p, q)
    body_qd[b] = velocity[i]


@wp.kernel
def air_drag(
    drag: float,
    particle_qd: wp.array(dtype=wp.vec3),
    particle_mass: wp.array(dtype=float),
    particle_f: wp.array(dtype=wp.vec3),
):
    i = wp.tid()
    particle_f[i] = particle_f[i] - particle_mass[i] * drag * particle_qd[i]


@wp.func
def joint_coordinate(X_wp: wp.transform, X_wc: wp.transform, angular: int, dim: int) -> float:
    """The coordinate SolverXPBD drives along one joint frame axis (as in its solve_body_joints)."""
    if angular == 0:
        return wp.transform_get_translation(wp.transform_inverse(X_wp) * X_wc)[dim]
    q_p = wp.transform_get_rotation(X_wp)
    q_c = wp.transform_get_rotation(X_wc)
    if wp.dot(q_p, q_c) < 0.0:
        q_c = -q_c
    rel_q = wp.quat_inverse(q_p) * q_c
    # Twist about the frame's x axis, then the swing's y/z components scaled to angles.
    # A half-turn swing has no twist component; keep it finite (the solver itself is singular there).
    qtwist = wp.quat_identity()
    if rel_q[0] * rel_q[0] + rel_q[3] * rel_q[3] > 1.0e-12:
        qtwist = wp.normalize(wp.quat(rel_q[0], 0.0, 0.0, rel_q[3]))
    if dim == 0:
        return 2.0 * wp.asin(wp.clamp(qtwist[0], -1.0, 1.0))
    qswing = rel_q * wp.quat_inverse(qtwist)
    e = qswing[dim]
    if qswing[3] * qswing[3] + 1.0e-4 < 1.0:
        e *= 2.0 * wp.acos(wp.clamp(qswing[3], -1.0, 1.0)) / wp.sqrt(1.0 - qswing[3] * qswing[3])
    return e


@wp.kernel
def limit_drive_force(
    body_q: wp.array(dtype=wp.transform),
    body_qd: wp.array(dtype=wp.spatial_vector),
    body_com: wp.array(dtype=wp.vec3),
    joint_parent: wp.array(dtype=int),
    joint_child: wp.array(dtype=int),
    joint_X_p: wp.array(dtype=wp.transform),
    joint_X_c: wp.array(dtype=wp.transform),
    dof_joint: wp.array(dtype=int),
    dof_angular: wp.array(dtype=int),
    dof_dim: wp.array(dtype=int),
    dof_sign: wp.array(dtype=float),
    dof_target: wp.array(dtype=int),
    dof_axis: wp.array(dtype=int),
    dof_reach: wp.array(dtype=float),
    dof_goal: wp.array(dtype=float),
    dof_goal_velocity: wp.array(dtype=float),
    joint_target_ke: wp.array(dtype=float),
    joint_target_kd: wp.array(dtype=float),
    gain: float,
    joint_target_q: wp.array(dtype=float),
    joint_target_qd: wp.array(dtype=float),
):
    """Hold a drive to its force limit, which SolverXPBD ignores (joint_effort_limit).

    PhysX clamps a drive's spring plus damping force, so a target that jumps
    (an animated hand teleported between poses) pulls with at most maxForce.
    A linear drive over its limit gets a target that much ahead of the body
    and its current velocity as target velocity (no damping). XPBD reapplies a
    drive's correction every iteration, so the offset is divided by `gain`
    (iterations x relaxation) for a PhysX-like acceleration; harder pulls swing
    a light body around its anchor and flip it. An angular drive only keeps its
    target within maxForce/stiffness and keeps its damping, since its coordinate
    wraps at half turns. Runs every substep before the solver.
    """
    i = wp.tid()
    j = dof_joint[i]
    X_wp = joint_X_p[j]
    p = joint_parent[j]
    com_p = wp.vec3(0.0)
    qd_p = wp.spatial_vector()
    if p >= 0:
        X_wp = body_q[p] * X_wp
        com_p = wp.transform_point(body_q[p], body_com[p])
        qd_p = body_qd[p]
    c = joint_child[j]
    X_wc = body_q[c] * joint_X_c[j]
    dim = dof_dim[i]
    sign = dof_sign[i]
    q = sign * joint_coordinate(X_wp, X_wc, dof_angular[i], dim)
    reach = dof_reach[i]
    error = dof_goal[i] - q
    if dof_angular[i] == 1:
        joint_target_q[dof_target[i]] = q + wp.clamp(error, -reach, reach)
        return
    d = dof_axis[i]
    axis = wp.quat_rotate(wp.transform_get_rotation(X_wp), wp.vec3(float(dim == 0), float(dim == 1), float(dim == 2)))
    qd_c = body_qd[c]
    r_c = wp.transform_get_translation(X_wc) - wp.transform_point(body_q[c], body_com[c])
    r_p = wp.transform_get_translation(X_wp) - com_p
    v_c = wp.spatial_top(qd_c) + wp.cross(wp.spatial_bottom(qd_c), r_c)
    v_p = wp.spatial_top(qd_p) + wp.cross(wp.spatial_bottom(qd_p), r_p)
    v = sign * wp.dot(v_c - v_p, axis)
    force_over_ke = error + joint_target_kd[d] / joint_target_ke[d] * (dof_goal_velocity[i] - v)
    if wp.abs(force_over_ke) <= reach:
        joint_target_q[dof_target[i]] = dof_goal[i]
        joint_target_qd[d] = dof_goal_velocity[i]
    else:
        joint_target_q[dof_target[i]] = q + wp.sign(force_over_ke) * reach / gain
        joint_target_qd[d] = v


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


GENERIC_JOINT_DOFS = ("transX", "transY", "transZ", "rotX", "rotY", "rotZ")


def breakable_joint_count(stage: Usd.Stage) -> int:
    """Joints with a finite physics:breakForce or breakTorque; Newton 1.7 cannot break joints."""
    count = 0
    for prim in stage.Traverse():
        if not prim.IsA(UsdPhysics.Joint):
            continue
        joint = UsdPhysics.Joint(prim)
        limits = (joint.GetBreakForceAttr().Get(), joint.GetBreakTorqueAttr().Get())
        # 3.4e38 (FLT_MAX) is the authored spelling of "unbreakable".
        count += any(v is not None and math.isfinite(v) and v < UNLIMITED_FORCE for v in limits)
    return count


def free_unlimited_generic_axes(stage: Usd.Stage) -> None:
    """Give generic joints an unbounded limit on every DOF without a LimitAPI.

    In UsdPhysics such a DOF is free (Isaac Sim drives it, e.g. a body moved
    along time-sampled drive targets). Newton 1.7 only adds D6 axes for DOFs
    with a limit, so it would weld these joints instead.
    """
    stage.SetEditTarget(stage.GetSessionLayer())
    for prim in stage.Traverse():
        if prim.GetTypeName() != "PhysicsJoint":
            continue
        for dof in GENERIC_JOINT_DOFS:
            if prim.HasAPI(UsdPhysics.LimitAPI, dof):
                continue
            limit = UsdPhysics.LimitAPI.Apply(prim, dof)
            limit.CreateLowAttr(-math.inf)
            limit.CreateHighAttr(math.inf)


def restore_world_joint_frames(stage: Usd.Stage, builder: newton.ModelBuilder, joint_map: dict[str, int]) -> list[int]:
    """Put back the authored world-side frame of joints between a body and the world.

    UsdPhysics (and PhysX) read localPos/localRot of a side without a body as
    world coordinates. Newton 1.7 rebuilds that frame from the child body's
    pose instead, so a joint anchored elsewhere, e.g. at the origin with
    absolute drive targets, starts with its targets offset by the body's
    position. Returns the joints whose frame was restored.
    """
    owners: dict[int, list[str]] = {}
    for path, j in joint_map.items():
        owners.setdefault(j, []).append(path)
    restored = []
    for j, paths in owners.items():
        # Stacked joints merged into one keep Newton's frame: their axes are relative to it.
        if builder.joint_parent[j] != -1 or len(paths) != 1:
            continue
        joint = UsdPhysics.Joint(stage.GetPrimAtPath(paths[0]))
        if not joint:
            continue
        sides = [
            (joint.GetBody0Rel(), joint.GetLocalPos0Attr(), joint.GetLocalRot0Attr()),
            (joint.GetBody1Rel(), joint.GetLocalPos1Attr(), joint.GetLocalRot1Attr()),
        ]
        world = [side for side in sides if side[0].GetTargets() in ([], [Sdf.Path.absoluteRootPath])]
        if len(world) != 1:
            continue
        _, pos_attr, rot_attr = world[0]
        pos = pos_attr.Get() if pos_attr.HasAuthoredValue() else Gf.Vec3f(0.0)
        rot = rot_attr.Get() if rot_attr.HasAuthoredValue() else Gf.Quatf(1.0)
        im = rot.GetImaginary()
        builder.joint_X_p[j] = wp.transform(wp.vec3(*pos), wp.quat(im[0], im[1], im[2], rot.GetReal()))
        restored.append(j)
    return restored


def disable_unpowered_drives(builder: newton.ModelBuilder) -> None:
    """Switch off drives whose force limit is zero; PhysX applies no force for them, XPBD ignores the limit."""
    for d, limit in enumerate(builder.joint_effort_limit):
        if limit <= 0.0:
            builder.joint_target_ke[d] = 0.0
            builder.joint_target_kd[d] = 0.0


def match_joint_coordinates(model: newton.Model, joints: list[int]) -> None:
    """Recompute joint_q of articulated joints from the imported body poses (after their frames changed)."""
    if not joints or not model.articulation_count:
        return
    articulation = model.joint_articulation.numpy()
    joints = [j for j in joints if articulation[j] >= 0]
    if not joints:
        return
    q = wp.clone(model.joint_q)
    qd = wp.clone(model.joint_qd)
    newton.eval_ik(model, model, q, qd)
    starts = model.joint_q_start.numpy()
    joint_q, solved = model.joint_q.numpy(), q.numpy()
    for j in joints:
        joint_q[starts[j] : starts[j + 1]] = solved[starts[j] : starts[j + 1]]
    model.joint_q.assign(joint_q)


def force_limited_dofs(model: newton.Model) -> list[tuple[int, int, int, float, int, int, float]]:
    """Drive axes with a finite force limit, as (joint, angular, dim, sign, target index, axis index, maxForce / stiffness).

    dim/sign locate the axis in the joint frame; axes that are not one of its
    basis vectors are left unlimited.
    """
    kinds = model.joint_type.numpy()
    dims = model.joint_dof_dim.numpy()
    qd_starts = model.joint_qd_start.numpy()
    target_starts = model.joint_target_q_start.numpy()
    axes = model.joint_axis.numpy()
    ke = model.joint_target_ke.numpy()
    limits = model.joint_effort_limit.numpy()
    driven = (int(newton.JointType.REVOLUTE), int(newton.JointType.PRISMATIC), int(newton.JointType.D6))
    rows = []
    for j in range(model.joint_count):
        if kinds[j] not in driven:
            continue
        lin, ang = dims[j]
        for k in range(lin + ang):
            d = int(qd_starts[j]) + k
            if ke[d] <= 0.0 or not 0.0 < limits[d] < UNLIMITED_FORCE:
                continue
            dim = int(np.argmax(np.abs(axes[d])))
            if abs(axes[d][dim]) < 0.999:
                continue
            rows.append((j, int(k >= lin), dim, float(np.sign(axes[d][dim])), int(target_starts[j]) + k, d, float(limits[d] / ke[d])))
    return rows


class StableXPBD(newton.solvers.SolverXPBD):
    """SolverXPBD with two PhysX-like changes that keep densely jointed, light stages stable.

    - Joint corrections are averaged per body beyond two joints. XPBD sums every
      joint's correction (Jacobi), which overshoots on a body held by many joints
      (a paper box grid has 4 to 24 per tile) and diverges. Contacts are already
      averaged this way; bodies with one or two joints are unchanged.
    - No gyroscopic term, PhysX's default. Newton integrates it explicitly, which
      grows a thin body's wobble without bound once it spins about its long axis.

    Both hook SolverXPBD internals of Newton 1.7 (pinned in requirements.txt).
    """

    def __init__(self, model: newton.Model, **kwargs):
        super().__init__(model, **kwargs)
        count = np.zeros(model.body_count)
        kinds, enabled = model.joint_type.numpy(), model.joint_enabled.numpy()
        for p, c, kind, on in zip(model.joint_parent.numpy(), model.joint_child.numpy(), kinds, enabled):
            if on and kind != int(newton.JointType.FREE):
                count[[b for b in (p, c) if b >= 0]] += 1
        # apply_body_deltas divides a body's correction by its weight; 0 means 1.
        self.joint_weight = wp.array(np.where(count > 2, count / 2, 0.0), dtype=float, device=model.device)
        self.no_inertia = wp.zeros_like(model.body_inertia)

    def _without_gyroscopic(self, fn, *args):
        # These kernels use the inertia (not its inverse) only for the gyroscopic term.
        model = self.model
        inertia, model.body_inertia = model.body_inertia, self.no_inertia
        try:
            return fn(*args)
        finally:
            model.body_inertia = inertia

    def integrate_bodies(self, model, state_in, state_out, dt, angular_damping=0.0):
        return self._without_gyroscopic(super().integrate_bodies, model, state_in, state_out, dt, angular_damping)

    def _apply_body_deltas(self, model, state_in, state_out, body_deltas, dt, rigid_contact_inv_weight=None):
        # Contacts always pass their weights (rigid_contact_con_weighting); joints pass none.
        if rigid_contact_inv_weight is None:
            rigid_contact_inv_weight = self.joint_weight
        return self._without_gyroscopic(
            super()._apply_body_deltas, model, state_in, state_out, body_deltas, dt, rigid_contact_inv_weight
        )


def _sampled(attr: Usd.Attribute) -> tuple[np.ndarray, np.ndarray] | None:
    """An attribute's time samples as (time codes, values), when it has more than a default."""
    if not attr or attr.GetNumTimeSamples() == 0:
        return None
    times = np.array(attr.GetTimeSamples(), dtype=np.float64)
    values = np.array([float(attr.Get(t)) for t in times], dtype=np.float64)
    return times, values


def animated_drive_targets(stage: Usd.Stage, builder: newton.ModelBuilder, model: newton.Model, joint_map: dict[str, int]) -> list[dict]:
    """Time-sampled drive targets, each mapped onto its slot in Control.joint_target_q/qd.

    Newton imports targets once; Isaac Sim moves drives along their samples
    while it plays, so these are re-sampled every frame.
    """
    target_q_start = model.joint_target_q_start.numpy()
    tracks = []
    for path, j in joint_map.items():
        prim = stage.GetPrimAtPath(path)
        if not prim:
            continue
        joint_type = builder.joint_type[j]
        lin, ang = builder.joint_dof_dim[j]
        qd_start = builder.joint_qd_start[j]
        names = []
        for k in range(lin + ang):
            if joint_type == newton.JointType.REVOLUTE:
                names.append("angular")
            elif joint_type == newton.JointType.PRISMATIC:
                names.append("linear")
            elif joint_type == newton.JointType.D6:
                axis = np.abs(np.array(builder.joint_axis[qd_start + k], dtype=float))
                names.append(("trans" if k < lin else "rot") + "XYZ"[int(np.argmax(axis))])
            else:
                names.append(None)
        for k, name in enumerate(names):
            if name is None:
                continue
            scale = math.radians(1.0) if name == "angular" or name.startswith("rot") else 1.0
            for field, kind, index in (
                ("targetPosition", "q", int(target_q_start[j]) + k),
                ("targetVelocity", "qd", qd_start + k),
            ):
                samples = _sampled(prim.GetAttribute(f"drive:{name}:physics:{field}"))
                if samples is not None:
                    tracks.append({"kind": kind, "index": index, "times": samples[0], "values": samples[1] * scale})
    return tracks


def _is_time_varying(prim: Usd.Prim) -> bool:
    while prim and not prim.IsPseudoRoot():
        if prim.IsA(UsdGeom.Xformable) and UsdGeom.Xformable(prim).TransformMightBeTimeVarying():
            return True
        prim = prim.GetParent()
    return False


def _body_pose(prim: Usd.Prim, code: float) -> np.ndarray:
    """A prim's stage-frame transform at a time code as (px, py, pz, qx, qy, qz, qw)."""
    m = UsdGeom.XformCache(code).GetLocalToWorldTransform(prim).RemoveScaleShear()
    p = m.ExtractTranslation()
    q = m.ExtractRotationQuat().GetNormalized()
    i = q.GetImaginary()
    return np.array([p[0], p[1], p[2], i[0], i[1], i[2], q.GetReal()], dtype=np.float64)


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])


def _rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    return _quat_mul(_quat_mul(q, np.array([v[0], v[1], v[2], 0.0])), q * np.array([-1.0, -1.0, -1.0, 1.0]))[:3]


def pin_cloth_attachments(stage: Usd.Stage, builder: newton.ModelBuilder, result: dict) -> tuple[set[str], list[str]]:
    """Pin cloth points that a PhysicsAttachment ties to a static xform (or the world).

    Newton 1.7 parses cloth attachments but does not import them yet. A static
    target cannot move, so its attached particles become kinematic (zero mass,
    inactive). Returns the handled attachment paths and warnings for the rest.
    """
    cloth: dict[str, dict] = result.get("path_cloth_map", {})
    handled: set[str] = set()
    problems: list[str] = []
    for path, attrs in result.get("path_attachment_attrs", {}).items():
        sides = [(attrs.get("src0"), attrs.get("type0"), attrs.get("indices0")), (attrs.get("src1"), attrs.get("type1"), attrs.get("indices1"))]
        for k in (0, 1):
            src, kind, indices = sides[k]
            target, target_kind, _ = sides[1 - k]
            if src not in cloth or kind != "point":
                continue
            if target_kind != "xform":
                problems.append(f"{path}: 천 Attachment의 대상 종류 '{target_kind}'는 지원하지 않아 건너뜁니다.")
                break
            target_prim = stage.GetPrimAtPath(target) if target and target != "/" else None
            if target_prim is not None and _has_rigid_body(target_prim):
                problems.append(f"{path}: 리지드 바디에 붙인 천 Attachment는 아직 지원하지 않아 건너뜁니다.")
                break
            start, end = cloth[src]["particle"]
            for i in indices or []:
                p = start + int(i)
                if start <= p < end:
                    builder.particle_mass[p] = 0.0
                    builder.particle_flags[p] = int(builder.particle_flags[p]) & ~int(newton.ParticleFlags.ACTIVE)
            handled.add(path)
            break
    return handled, problems


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
        free_unlimited_generic_axes(stage)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = builder.add_usd(
                stage, load_visual_shapes=False, apply_up_axis_from_stage=False, return_deformable_results=True
            )
        pinned, problems = pin_cloth_attachments(stage, builder, result)
        restored = restore_world_joint_frames(stage, builder, result.get("path_joint_map", {}))
        disable_unpowered_drives(builder)
        # Drop the importer's "attachment not imported" notes for attachments handled above.
        messages = {str(w.message) for w in caught}
        self.warnings = sorted({m for m in messages if not any(m.startswith(p + ":") for p in pinned)} | set(problems))
        breakable = breakable_joint_count(stage)
        if breakable:
            self.warnings.append(
                f"조인트 {breakable}개의 파단 힘(physics:breakForce)은 Newton에서 지원하지 않아 끊어지지 않습니다. 끊기는 동작은 PhysX 엔진으로 확인하세요."
            )
        self.cloths = [
            {"path": path, "start": int(r["particle"][0]), "count": int(r["particle"][1] - r["particle"][0])}
            for path, r in result.get("path_cloth_map", {}).items()
        ]

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

        # Cloth needs VBD (particles) coupled with AVBD (rigid bodies); VBD
        # schedules its parallel solve by graph coloring, computed up front.
        if self.cloths:
            solver = "vbd"
            builder.color(include_bending=True)

        # UsdPhysics joints outside a PhysicsArticulationRootAPI are not part of
        # any articulation. XPBD/VBD solve joints as maximal-coordinate constraints,
        # so only the reduced-coordinate solvers need that validation.
        with wp.ScopedDevice(self.device):
            self.model = builder.finalize(device=self.device, skip_validation_joints=solver != "mujoco")
            match_joint_coordinates(self.model, restored)
        if self.model.body_count == 0 and not self.cloths:
            raise RuntimeError("시뮬레이션할 리지드 바디나 천이 없습니다.")

        self.bodies = list(self.model.body_label)
        self.solver_name = solver

        # Isaac Sim plays the timeline with the simulation: simulation time 0 is
        # the start time code, drive targets follow their samples and animated
        # kinematic bodies their xforms.
        self.stage = stage
        self.start_code = float(stage.GetStartTimeCode())
        self.codes_per_second = float(stage.GetTimeCodesPerSecond()) or 24.0
        self.drive_tracks = animated_drive_targets(stage, builder, self.model, result.get("path_joint_map", {}))
        self.kinematic = [
            (b, stage.GetPrimAtPath(path))
            for path, b in body_map.items()
            if int(builder.body_flags[b]) & int(newton.BodyFlags.KINEMATIC) and _is_time_varying(stage.GetPrimAtPath(path))
        ]
        self.body_com = self.model.body_com.numpy() if self.model.body_count else None
        if solver == "mujoco":
            self.solver = newton.solvers.SolverMuJoCo(self.model)
        elif solver == "vbd":
            unit = self.meters_per_unit
            self.model.soft_contact_ke = CLOTH_CONTACT_KE
            self.model.soft_contact_kd = CLOTH_CONTACT_KD
            self.model.soft_contact_mu = CLOTH_CONTACT_MU
            self.solver = newton.solvers.SolverVBD(
                self.model,
                iterations=10,
                rigid_compliant_alm=True,
                particle_enable_self_contact=True,
                particle_self_contact_margin=CLOTH_SELF_CONTACT_MARGIN / unit,
                particle_self_contact_gap=CLOTH_SELF_CONTACT_GAP / unit,
            )
        else:
            self.solver = StableXPBD(self.model, iterations=8, enable_restitution=True)

        # Captured CUDA graphs ping-pong state_0/state_1, so keep the substep count even.
        if solver == "vbd":
            substeps = max(substeps, 10)
        self.substeps = max(2, substeps + (substeps % 2))
        self.frame_dt = 1.0 / fps
        self.sim_dt = self.frame_dt / self.substeps
        self.sim_time = 0.0

        with wp.ScopedDevice(self.device):
            self.state_0 = self.model.state()
            self.state_1 = self.model.state()
            self.control = self.model.control()
            newton.eval_fk(self.model, self.model.joint_q, self.model.joint_qd, self.state_0)
            # Host copies of the targets; animated entries are rewritten every frame.
            self.target_q = self.control.joint_target_q.numpy() if self.drive_tracks else None
            self.target_qd = self.control.joint_target_qd.numpy() if self.drive_tracks else None
            n = len(self.kinematic)
            self.kinematic_bodies = wp.array([b for b, _ in self.kinematic] or [0], dtype=int)
            self.kinematic_start = wp.zeros(max(n, 1), dtype=wp.transform)
            self.kinematic_end = wp.zeros(max(n, 1), dtype=wp.transform)
            self.kinematic_velocity = wp.zeros(max(n, 1), dtype=wp.spatial_vector)
            if n:
                # Start from the animated pose at the start time code.
                body_q = self.state_0.body_q.numpy()
                for b, prim in self.kinematic:
                    body_q[b] = _body_pose(prim, self.start_code)
                self.state_0.body_q.assign(body_q)
            self.initial = self.model.state()
            self.initial.assign(self.state_0)
            pipeline_options = {"soft_contact_gap": CLOTH_CONTACT_GAP / self.meters_per_unit} if self.cloths else {}
            self.pipeline = newton.CollisionPipeline(self.model, **pipeline_options)
            self.contacts = self.pipeline.contacts()
            # The automatic contact capacity can be too small for many touching shapes
            # (contacts past it are dropped); measure the start and leave headroom.
            self.pipeline.collide(self.state_0, self.contacts)
            needed = int(self.contacts.rigid_contact_count.numpy()[0])
            if needed > self.contacts.rigid_contact_max:
                self.pipeline = newton.CollisionPipeline(self.model, rigid_contact_max=2 * needed, **pipeline_options)
                self.contacts = self.pipeline.contacts()
                self.pipeline.collide(self.state_0, self.contacts)
            self._ignore_initial_overlaps()

            # Drive force limits, which SolverXPBD would ignore (see limit_drive_force).
            limited = force_limited_dofs(self.model) if solver == "xpbd" else []
            self.limited = len(limited)
            if limited:
                joint, angular, dim, sign, target, axis, reach = (list(column) for column in zip(*limited))
                self.limited_inputs = [
                    wp.array(joint, dtype=int),
                    wp.array(angular, dtype=int),
                    wp.array(dim, dtype=int),
                    wp.array(sign, dtype=float),
                    wp.array(target, dtype=int),
                    wp.array(axis, dtype=int),
                    wp.array(reach, dtype=float),
                ]
                # The authored targets; every substep writes the limited ones into the control.
                self.limited_targets = np.array(target)
                self.limited_axes = np.array(axis)
                self.limited_goal = wp.array(self.control.joint_target_q.numpy()[self.limited_targets], dtype=float)
                self.limited_goal_velocity = wp.array(self.control.joint_target_qd.numpy()[self.limited_axes], dtype=float)
            self.drag_body = wp.array([-1], dtype=int)
            self.drag_points = wp.zeros(2, dtype=wp.vec3)
            # The grabbed cloth patch: particles, their offsets from the grabbed one, the target.
            self.grabbed = wp.zeros(MAX_GRABBED_PARTICLES, dtype=int)
            self.grabbed_count = wp.zeros(1, dtype=int)
            self.grabbed_offsets = wp.zeros(MAX_GRABBED_PARTICLES, dtype=wp.vec3)
            self.grab_target = wp.zeros(1, dtype=wp.vec3)
            self.grabbed_particle = -1

            self.graph = None
            if self.device.is_cuda:
                with wp.ScopedCapture() as capture:
                    self._simulate()
                self.graph = capture.graph

    def _simulate(self) -> None:
        if self.cloths:
            # Cloth deforms a lot between frames; a rebuilt self-contact BVH stays efficient.
            self.solver.rebuild_bvh(self.state_0)
        for k in range(self.substeps):
            self.state_0.clear_forces()
            if self.kinematic:
                wp.launch(
                    pose_kinematic,
                    dim=len(self.kinematic),
                    inputs=[
                        self.kinematic_bodies,
                        self.kinematic_start,
                        self.kinematic_end,
                        self.kinematic_velocity,
                        (k + 1) / self.substeps,
                    ],
                    outputs=[self.state_0.body_q, self.state_0.body_qd],
                    device=self.device,
                )
            if self.model.body_count:
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
            if self.model.particle_count:
                wp.launch(
                    air_drag,
                    dim=self.model.particle_count,
                    inputs=[CLOTH_AIR_DRAG, self.state_0.particle_qd, self.model.particle_mass],
                    outputs=[self.state_0.particle_f],
                    device=self.device,
                )
                wp.launch(
                    pull_particles,
                    dim=MAX_GRABBED_PARTICLES,
                    inputs=[
                        self.grabbed,
                        self.grabbed_count,
                        self.grabbed_offsets,
                        self.grab_target,
                        CLOTH_DRAG_STIFFNESS,
                        CLOTH_DRAG_DAMPING,
                        self.state_0.particle_q,
                        self.state_0.particle_qd,
                        self.model.particle_mass,
                    ],
                    outputs=[self.state_0.particle_f],
                    device=self.device,
                )
            if self.limited:
                wp.launch(
                    limit_drive_force,
                    dim=self.limited,
                    inputs=[
                        self.state_0.body_q,
                        self.state_0.body_qd,
                        self.model.body_com,
                        self.model.joint_parent,
                        self.model.joint_child,
                        self.model.joint_X_p,
                        self.model.joint_X_c,
                        *self.limited_inputs,
                        self.limited_goal,
                        self.limited_goal_velocity,
                        self.model.joint_target_ke,
                        self.model.joint_target_kd,
                        self.solver.iterations * self.solver.joint_linear_relaxation,
                    ],
                    outputs=[self.control.joint_target_q, self.control.joint_target_qd],
                    device=self.device,
                )
            self.pipeline.collide(self.state_0, self.contacts)
            self.solver.step(self.state_0, self.state_1, self.control, self.contacts, self.sim_dt)
            self.state_0, self.state_1 = self.state_1, self.state_0

    def _animate(self) -> None:
        """Drive targets for the end of the coming frame, and kinematic poses through it."""
        start = self.start_code + self.sim_time * self.codes_per_second
        end = self.start_code + (self.sim_time + self.frame_dt) * self.codes_per_second
        if self.drive_tracks:
            for track in self.drive_tracks:
                target = self.target_q if track["kind"] == "q" else self.target_qd
                target[track["index"]] = np.interp(end, track["times"], track["values"])
            self.control.joint_target_q.assign(self.target_q)
            self.control.joint_target_qd.assign(self.target_qd)
            if self.limited:
                self.limited_goal.assign(self.target_q[self.limited_targets])
                self.limited_goal_velocity.assign(self.target_qd[self.limited_axes])
        if self.kinematic:
            starts = np.array([_body_pose(prim, start) for _, prim in self.kinematic])
            ends = np.array([_body_pose(prim, end) for _, prim in self.kinematic])
            velocities = np.zeros((len(self.kinematic), 6))
            for i, (b, _) in enumerate(self.kinematic):
                # body_qd: linear velocity of the centre of mass, then angular velocity (world frame).
                com = self.body_com[b]
                com0 = starts[i, :3] + _rotate(starts[i, 3:], com)
                com1 = ends[i, :3] + _rotate(ends[i, 3:], com)
                q0 = starts[i, 3:]
                q1 = ends[i, 3:] if np.dot(starts[i, 3:], ends[i, 3:]) >= 0 else -ends[i, 3:]
                delta = _quat_mul(q1, q0 * np.array([-1.0, -1.0, -1.0, 1.0]))
                angle = 2.0 * math.atan2(np.linalg.norm(delta[:3]), delta[3])
                axis = delta[:3] / (np.linalg.norm(delta[:3]) or 1.0)
                velocities[i, :3] = (com1 - com0) / self.frame_dt
                velocities[i, 3:] = axis * angle / self.frame_dt
            self.kinematic_start.assign(starts.astype(np.float32))
            self.kinematic_end.assign(ends.astype(np.float32))
            self.kinematic_velocity.assign(velocities.astype(np.float32))

    def step(self) -> None:
        self._animate()
        with wp.ScopedDevice(self.device):
            if self.graph is not None:
                wp.capture_launch(self.graph)
            else:
                self._simulate()
        self.sim_time += self.frame_dt
        if self.ignored:
            self._restore_separated_pairs()

    def reset(self) -> None:
        with wp.ScopedDevice(self.device):
            self.clear_drag()
            self.state_0.assign(self.initial)
            self.state_1.assign(self.initial)
        self.sim_time = 0.0
        if self.overlaps:
            # Back at the start the bodies overlap again.
            pairs = self.model.shape_contact_pairs.numpy()
            for indices, original in self.overlaps:
                pairs[indices, 1] = original[:, 0]
            self.model.shape_contact_pairs.assign(pairs)
            self.ignored = list(self.overlaps)

    def _ignore_initial_overlaps(self) -> None:
        """Let dynamic bodies that start deeply interpenetrating pass through each other until they separate.

        PhysX sorts out such a start (two tools parked in one spot) within a few
        steps; XPBD's position correction flings them apart hard enough to flip
        and explode light bodies. A disabled pair stays in the explicit broad
        phase's pair list as (a, a), which it skips as a same-body pair, so the
        captured CUDA graph is unaffected. Needs a collide() on the start state.
        """
        # (indices into model.shape_contact_pairs, their original pairs), per body pair
        self.overlaps: list[tuple[np.ndarray, np.ndarray]] = []
        self.ignored: list[tuple[np.ndarray, np.ndarray]] = []
        if self.pipeline.broad_phase_mode != "explicit" or getattr(self.model, "shape_contact_pairs", None) is None:
            return
        c = self.contacts
        n = min(int(c.rigid_contact_count.numpy()[0]), c.rigid_contact_max)
        shape_body = self.model.shape_body.numpy()
        body0, body1 = shape_body[c.rigid_contact_shape0.numpy()[:n]], shape_body[c.rigid_contact_shape1.numpy()[:n]]
        moving = (self.model.body_inv_mass.numpy() > 0.0) & (self.model.body_flags.numpy() & int(newton.BodyFlags.KINEMATIC) == 0)
        candidates = np.where((body0 >= 0) & (body1 >= 0) & (body0 != body1))[0]
        candidates = candidates[moving[body0[candidates]] & moving[body1[candidates]]]
        if not len(candidates):
            return
        body_q = self.state_0.body_q.numpy().astype(np.float64)
        point0, point1 = c.rigid_contact_point0.numpy(), c.rigid_contact_point1.numpy()
        normal = c.rigid_contact_normal.numpy()
        margin = c.rigid_contact_margin0.numpy() + c.rigid_contact_margin1.numpy()
        overlapping = set()
        for i in candidates:
            a, b = body0[i], body1[i]
            world0 = body_q[a, :3] + _rotate(body_q[a, 3:], point0[i])
            world1 = body_q[b, :3] + _rotate(body_q[b, 3:], point1[i])
            if np.dot(world1 - world0, normal[i]) - margin[i] < -INITIAL_OVERLAP / self.meters_per_unit:
                overlapping.add((min(a, b), max(a, b)))
        if not overlapping:
            return
        pairs = self.model.shape_contact_pairs.numpy()
        bodies = np.sort(shape_body[pairs], axis=1)
        for a, b in sorted(overlapping):
            indices = np.where((bodies[:, 0] == a) & (bodies[:, 1] == b))[0]
            self.overlaps.append((indices, pairs[indices].copy()))
            pairs[indices, 1] = pairs[indices, 0]
            self.warnings.append(f"{self.bodies[a]}, {self.bodies[b]}: 처음부터 깊이 겹쳐 있어 서로 떨어질 때까지 충돌하지 않습니다.")
        self.model.shape_contact_pairs.assign(pairs)
        self.ignored = list(self.overlaps)

    def _restore_separated_pairs(self) -> None:
        """Let ignored body pairs collide again once none of their shapes' bounding boxes overlap."""
        lower = self.pipeline.narrow_phase.shape_aabb_lower.numpy()
        upper = self.pipeline.narrow_phase.shape_aabb_upper.numpy()
        apart, still = [], []
        for indices, original in self.ignored:
            a, b = original[:, 0], original[:, 1]
            touching = np.any(np.all((lower[a] <= upper[b]) & (lower[b] <= upper[a]), axis=1))
            (still if touching else apart).append((indices, original))
        if not apart:
            return
        pairs = self.model.shape_contact_pairs.numpy()
        for indices, original in apart:
            pairs[indices] = original
        self.model.shape_contact_pairs.assign(pairs)
        self.ignored = still

    def set_drag(self, body: int, local: list[float], target: list[float]) -> None:
        if not 0 <= body < len(self.bodies):
            return
        self.drag_points.assign(np.array([local, target], dtype=np.float32))
        self.drag_body.assign(np.array([body], dtype=np.int32))

    def set_particle_drag(self, particle: int, target: list[float]) -> None:
        """Pull the cloth around `particle` toward `target` until clear_drag()."""
        if not 0 <= particle < self.model.particle_count:
            return
        if particle != self.grabbed_particle:
            cloth = next((c for c in self.cloths if c["start"] <= particle < c["start"] + c["count"]), None)
            if cloth is None:
                return
            start, end = cloth["start"], cloth["start"] + cloth["count"]
            q = self.state_0.particle_q.numpy()
            offsets = q[start:end] - q[particle]
            distance = np.linalg.norm(offsets, axis=1)
            near = np.argsort(distance)[:MAX_GRABBED_PARTICLES]
            # Everything within the radius, but at least the grabbed point and its nearest neighbour.
            radius = max(CLOTH_DRAG_RADIUS / self.meters_per_unit, distance[near[1]] if len(near) > 1 else 0.0)
            near = near[distance[near] <= radius]
            grabbed = np.zeros(MAX_GRABBED_PARTICLES, dtype=np.int32)
            grabbed[: len(near)] = near + start
            padded = np.zeros((MAX_GRABBED_PARTICLES, 3), dtype=np.float32)
            padded[: len(near)] = offsets[near]
            self.grabbed.assign(grabbed)
            self.grabbed_offsets.assign(padded)
            self.grabbed_count.assign(np.array([len(near)], dtype=np.int32))
            self.grabbed_particle = particle
        self.grab_target.assign(np.array([target], dtype=np.float32))

    def clear_drag(self) -> None:
        self.drag_body.fill_(-1)
        self.grabbed_count.zero_()
        self.grabbed_particle = -1

    def frame(self) -> bytes:
        """Little-endian float32: [simTime, bodyCount, particleCount,
        bodyCount x (px, py, pz, qx, qy, qz, qw), particleCount x (x, y, z)]."""
        empty = np.zeros(0, "<f4")
        poses = self.state_0.body_q.numpy().astype("<f4", copy=False).reshape(-1) if self.model.body_count else empty
        particles = self.state_0.particle_q.numpy().astype("<f4", copy=False).reshape(-1) if self.model.particle_count else empty
        header = np.array([self.sim_time, len(self.bodies), self.model.particle_count], dtype="<f4")
        return header.tobytes() + poses.tobytes() + particles.tobytes()

    def ready_message(self) -> dict:
        return {
            "type": "ready",
            "bodies": self.bodies,
            "cloths": self.cloths,
            "particles": int(self.model.particle_count),
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


def _set_attribute(prim: Sdf.PrimSpec, name: str, type_name, value, uniform: bool = False) -> None:
    attr = prim.attributes.get(name)
    if attr is None:
        variability = Sdf.VariabilityUniform if uniform else Sdf.VariabilityVarying
        attr = Sdf.AttributeSpec(prim, name, type_name, variability)
    attr.default = value
    # Samples in the same layer would win over the new default.
    if attr.HasInfo("timeSamples"):
        attr.ClearInfo("timeSamples")


def export_layer(root: Path, edits: list[dict], fmt: str) -> bytes:
    """Author the viewer's edits into the root layer and export it with OpenUSD.

    Mirrors the browser's src/lib/usd/sdf/edits.ts: `over` specs where the
    layer has none, a single matrix op for transforms, visibility tokens, and
    mesh points. References and sublayers are left as authored.
    """
    layer = Sdf.Layer.FindOrOpen(str(root))
    if layer is None:
        raise RuntimeError(f"레이어를 열 수 없습니다: {root.name}")
    for edit in edits:
        prim = Sdf.CreatePrimInLayer(layer, edit["path"])
        if edit.get("matrix"):
            _set_attribute(prim, "xformOp:transform", Sdf.ValueTypeNames.Matrix4d, Gf.Matrix4d(*edit["matrix"]))
            order = ["!resetXformStack!", "xformOp:transform"] if edit.get("resetXformStack") else ["xformOp:transform"]
            _set_attribute(prim, "xformOpOrder", Sdf.ValueTypeNames.TokenArray, Vt.TokenArray(order), uniform=True)
        if edit.get("visibility"):
            _set_attribute(prim, "visibility", Sdf.ValueTypeNames.Token, edit["visibility"])
        if edit.get("points"):
            points = np.asarray(edit["points"], dtype=np.float32).reshape(-1, 3)
            _set_attribute(prim, "points", Sdf.ValueTypeNames.Point3fArray, Vt.Vec3fArray.FromNumpy(points))
    # Export next to the original so relative asset paths keep pointing at the same files.
    out = root.with_name(f"{root.stem}.saved.{fmt}")
    if not layer.Export(str(out), args={"format": "usda" if fmt == "usda" else "usdc"}):
        raise RuntimeError("레이어를 내보내지 못했습니다.")
    return out.read_bytes()


def safe_relative_path(raw: str) -> PurePosixPath:
    """Reject absolute paths and `..` so uploads stay inside the session's temp folder."""
    path = PurePosixPath(raw.replace("\\", "/"))
    if path.is_absolute() or not path.parts or any(part in ("..", "") for part in path.parts) or ":" in path.parts[0]:
        raise ValueError(f"허용되지 않는 파일 경로입니다: {raw}")
    return path


class Connection:
    """One browser client: receives the stage, then plays it back, saves it, or runs a script on it."""

    def __init__(self, ws: ServerConnection, device: str, executor: ThreadPoolExecutor, isaac_sim: Path | None, origins: list[str]):
        self.ws = ws
        self.device = device
        self.isaac_sim = isaac_sim
        self.may_run_scripts = origin_allowed(ws.request.headers.get("Origin") if ws.request else None, origins)
        self.script: ScriptRun | None = None
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

    async def send_bytes(self, data: bytes) -> None:
        await self.ws.send(data)

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
            if self.script is not None:
                self.script.stop()
            shutil.rmtree(self.workdir, ignore_errors=True)

    async def handle(self, message: str | bytes) -> None:
        if isinstance(message, (bytes, bytearray, memoryview)):
            await self.receive_file(bytes(message))
            return
        msg = json.loads(message)
        kind = msg.get("type")
        if kind in ("load", "save", "run"):
            await self.begin_upload(msg)
        elif kind == "stop" and self.script is not None:
            self.script.stop()
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
        elif kind == "drag_particle" and self.sim is not None:
            await self.run_sim(self.sim.set_particle_drag, int(msg["particle"]), list(msg["target"]))
        elif kind == "drag_end" and self.sim is not None:
            await self.run_sim(self.sim.clear_drag)

    async def begin_upload(self, msg: dict) -> None:
        run = msg.get("type") == "run"
        if run and not self.may_run_scripts:
            raise ValueError(
                "이 페이지에서는 스크립트를 실행할 수 없습니다. 이 PC에서 연 뷰어만 허용하며, "
                "다른 주소라면 서버를 --allow-origin <주소>로 실행하세요."
            )
        if self.script is not None:
            raise ValueError("이미 스크립트가 실행 중입니다.")
        self.playing = False
        self.sim = None
        shutil.rmtree(self.workdir, ignore_errors=True)
        self.workdir.mkdir(parents=True)
        files = [(safe_relative_path(f["path"]), int(f["size"])) for f in msg.get("files", [])]
        # A script may run without a stage.
        if not files and not run:
            raise ValueError("업로드할 파일이 없습니다.")
        if sum(size for _, size in files) > MAX_UPLOAD_BYTES:
            raise ValueError("업로드 크기 제한(1GB)을 넘었습니다.")
        self.upload = {
            "root": safe_relative_path(msg["root"]) if files else None,
            "files": files,
            "received": 0,
            "solver": msg.get("solver", "xpbd"),
            "substeps": int(msg.get("substeps", 8)),
            "fps": float(msg.get("fps", 60)),
            # "save": author edits into the root layer and send it back instead of simulating.
            "save": {"edits": msg.get("edits", []), "format": msg.get("format", "usda")} if msg.get("type") == "save" else None,
            "run": msg if run else None,
        }
        if not files:
            await self.finish_upload()

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
        await self.finish_upload()

    async def finish_upload(self) -> None:
        upload = self.upload
        self.upload = None
        root = self.workdir / Path(*upload["root"].parts) if upload["root"] else None
        run = upload["run"]
        if run is not None:
            self.script = ScriptRun(
                script=str(run.get("script", "")),
                name=str(run.get("name", "script.py")),
                mode=str(run.get("mode", "pxr")),
                stage=root,
                workdir=self.workdir,
                isaac_sim=self.isaac_sim,
                send_json=self.send_json,
                send_bytes=self.send_bytes,
            )
            print(f"[newton] running {self.script.script_path.name} ({self.script.kind}) on {upload['root'] or 'a new stage'}")
            asyncio.create_task(self.run_script(self.script))
            return
        save = upload["save"]
        if save is not None:
            if save["format"] not in ("usda", "usdc", "usd"):
                raise ValueError(f"지원하지 않는 형식입니다: {save['format']}")
            print(f"[newton] saving {upload['root']} as {save['format']} with {len(save['edits'])} edits")
            await self.ws.send(await self.run_sim(export_layer, root, save["edits"], save["format"]))
            return
        print(f"[newton] loading {upload['root']} ({len(upload['files'])} files) on {self.device} with {upload['solver']}")
        self.sim = await self.run_sim(Simulation, root, self.device, upload["solver"], upload["substeps"], upload["fps"])
        print(
            f"[newton] ready: {len(self.sim.bodies)} bodies, {self.sim.model.joint_count} joints, "
            f"{len(self.sim.cloths)} cloths ({self.sim.model.particle_count} particles)"
        )
        await self.send_json(self.sim.ready_message())
        await self.send_frame()

    async def run_script(self, script: ScriptRun) -> None:
        """Runs beside the message loop, so a stop request gets through while the script runs."""
        try:
            await script.run()
        except ConnectionClosed:
            script.stop()
        except Exception as e:
            traceback.print_exc()
            script.stop()
            try:
                await self.send_json({"type": "error", "message": str(e) or e.__class__.__name__})
            except ConnectionClosed:
                pass
        finally:
            self.script = None

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
    parser.add_argument("--isaac-sim", default=None, help="Isaac Sim folder for running editor scripts (default: ISAAC_SIM_PATH or a search)")
    parser.add_argument(
        "--allow-origin", action="append", default=[], help="extra page origin allowed to run scripts, e.g. https://viewer.example.com"
    )
    args = parser.parse_args()
    isaac_sim = find_isaac_sim(args.isaac_sim)
    if isaac_sim:
        print(f"[newton] Isaac Sim for scripts: {isaac_sim}")
    else:
        print("[newton] Isaac Sim not found: scripts run with pxr only (--isaac-sim <folder> to set it)")

    wp.init()
    device = args.device or ("cuda:0" if wp.is_cuda_available() else "cpu")
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="newton")

    async def handler(ws: ServerConnection) -> None:
        print(f"[newton] client connected from {ws.remote_address}")
        await Connection(ws, device, executor, isaac_sim, args.allow_origin).serve()
        print("[newton] client disconnected")

    async with serve(handler, args.host, args.port, max_size=MAX_UPLOAD_BYTES) as server:
        print(f"[newton] Newton {newton.__version__} on {device}, listening on ws://{args.host}:{args.port}")
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
