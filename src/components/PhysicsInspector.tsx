"use client";

import { useMemo } from "react";
import { MathUtils, type Object3D } from "three";
import { formatNumber } from "@/lib/format";
import {
  physicsDescriptionFor,
  type BodyInfo,
  type ColliderInfo,
  type JointDrive,
  type JointInfo,
  type PhysicsDescription,
} from "@/lib/physics/schema";
import { useViewer } from "@/lib/store";
import { getPrimTag } from "@/lib/usd/composer";
import type { LoadedStage } from "@/lib/usd/loadStage";
import { Badge, Field, Section } from "./ui";

const JOINT_LABEL: Record<JointInfo["type"], string> = {
  revolute: "회전 (Revolute)",
  prismatic: "직선 (Prismatic)",
  spherical: "구형 (Spherical)",
  fixed: "고정 (Fixed)",
  distance: "거리 (Distance)",
  generic: "일반 (D6)",
};

const n = (v: number, digits = 3) => formatNumber(v, digits);
const deg = (rad: number) => `${n(rad * MathUtils.RAD2DEG, 1)}°`;

function shapeLabel(c: ColliderInfo): string {
  switch (c.shape) {
    case "box": {
      const h = c.halfExtents!;
      return `박스 ${n(h.x * 2)} × ${n(h.y * 2)} × ${n(h.z * 2)} m`;
    }
    case "sphere":
      return `구 반지름 ${n(c.radius!)} m`;
    case "capsule":
      return `캡슐 반지름 ${n(c.radius!)} · 길이 ${n(c.halfHeight! * 2)} m (${c.axis}축)`;
    case "convex":
      return `볼록 껍질 (점 ${((c.points?.length ?? 0) / 3).toLocaleString()}개)`;
    case "triangleMesh":
      return `삼각형 메시 (${((c.indices?.length ?? 0) / 3).toLocaleString()}개)`;
  }
}

function BodyFields({ body }: { body: BodyInfo }) {
  const massLabel = body.mass
    ? `${n(body.mass)} kg`
    : body.density
      ? `밀도 ${n(body.density, 1)} kg/m³`
      : body.colliders.find((c) => c.material.density)
        ? `재질 밀도 ${n(body.colliders.find((c) => c.material.density)!.material.density!, 1)} kg/m³`
        : "기본 밀도 1000 kg/m³";
  return (
    <>
      <Field label="리지드 바디">
        <Badge tone={body.kind === "dynamic" ? "ok" : "warn"}>{body.kind === "dynamic" ? "동적" : "키네마틱"}</Badge>
      </Field>
      <Field label="질량">{massLabel}</Field>
      {body.linearVelocity.lengthSq() > 0 && <Field label="초기 속도">{n(body.linearVelocity.length())} m/s</Field>}
      {body.angularVelocity.lengthSq() > 0 && <Field label="초기 각속도">{deg(body.angularVelocity.length())}/s</Field>}
      <Field label="콜라이더">{body.colliders.length}개</Field>
    </>
  );
}

function ColliderFields({ collider }: { collider: ColliderInfo }) {
  const m = collider.material;
  return (
    <>
      <Field label="콜라이더">{shapeLabel(collider)}</Field>
      {collider.approximation !== "none" && <Field label="근사">{collider.approximation}</Field>}
      <Field label="소속" mono>
        {collider.body ? collider.body.path : "정적 (static)"}
      </Field>
      <Field label="물리 머티리얼" mono>
        {m.path ?? "기본값"}
      </Field>
      <Field label="마찰">
        정지 {n(m.staticFriction, 2)} · 운동 {n(m.dynamicFriction, 2)}
      </Field>
      <Field label="반발">{n(m.restitution, 2)}</Field>
    </>
  );
}

function driveLabel(dr: JointDrive, angular: boolean): string {
  const pos = angular ? deg(dr.targetPosition) : `${n(dr.targetPosition)} m`;
  const vel = angular ? `${deg(dr.targetVelocity)}/s` : `${n(dr.targetVelocity)} m/s`;
  return `목표 ${pos} · ${vel} · k ${n(dr.stiffness, 1)} · c ${n(dr.damping, 1)}`;
}

function JointFields({ joint }: { joint: JointInfo }) {
  const side = (body: BodyInfo | null, staticCollider: ColliderInfo | null) =>
    body ? body.path : staticCollider ? `${staticCollider.path} (정적)` : "월드";
  let limit: string | null = null;
  if (joint.type === "revolute" && (joint.lower !== undefined || joint.upper !== undefined)) {
    limit = `${joint.lower !== undefined ? deg(joint.lower) : "−∞"} ~ ${joint.upper !== undefined ? deg(joint.upper) : "∞"}`;
  } else if (joint.type === "prismatic" && (joint.lower !== undefined || joint.upper !== undefined)) {
    limit = `${joint.lower !== undefined ? n(joint.lower) : "−∞"} ~ ${joint.upper !== undefined ? n(joint.upper) : "∞"} m`;
  } else if (joint.type === "spherical" && (joint.cone0 !== undefined || joint.cone1 !== undefined)) {
    limit = `원뿔 ${joint.cone0 !== undefined ? deg(joint.cone0) : "–"} / ${joint.cone1 !== undefined ? deg(joint.cone1) : "–"}`;
  } else if (joint.type === "distance") {
    limit = `${joint.minDistance !== undefined ? n(joint.minDistance) : "0"} ~ ${joint.maxDistance !== undefined ? n(joint.maxDistance) : "∞"} m`;
  }
  const drives = Object.entries(joint.drives) as [string, JointDrive][];
  return (
    <>
      <Field label="조인트">{JOINT_LABEL[joint.type]}</Field>
      <Field label="body0" mono>
        {side(joint.body0, joint.static0)}
      </Field>
      <Field label="body1" mono>
        {side(joint.body1, joint.static1)}
      </Field>
      {(joint.type === "revolute" || joint.type === "prismatic" || joint.type === "spherical") && <Field label="축">{joint.axis}</Field>}
      {limit && <Field label="제한">{limit}</Field>}
      {drives.map(([name, dr]) => (
        <Field key={name} label={`드라이브 ${name}`}>
          {driveLabel(dr, name === "angular" || name.startsWith("rot"))}
        </Field>
      ))}
      {joint.collisionEnabled && <Field label="상호 충돌">허용</Field>}
      {Number.isFinite(joint.breakForce) && <Field label="파단 힘">{n(joint.breakForce, 1)} N</Field>}
    </>
  );
}

function SceneFields({ description }: { description: PhysicsDescription }) {
  const g = description.gravity;
  return (
    <>
      <Field label="중력">
        {n(g.length(), 2)} m/s² · ({n(g.x, 2)}, {n(g.y, 2)}, {n(g.z, 2)})
      </Field>
      {description.stepsPerSecond && <Field label="스텝 수">{description.stepsPerSecond} /s</Field>}
      <Field label="구성">
        바디 {description.bodies.length} · 정적 {description.staticColliders.length} · 조인트 {description.joints.length}
      </Field>
    </>
  );
}

/** UsdPhysics opinions for the selected object, interpreted the way the simulation uses them. */
export default function PhysicsInspector({ stage, obj }: { stage: LoadedStage; obj: Object3D }) {
  const stored = useViewer((s) => s.physics.description);
  const description = useMemo(() => stored ?? physicsDescriptionFor(stage), [stored, stage]);
  const info = description.byObject.get(obj);
  const isScene = getPrimTag(obj)?.typeName === "PhysicsScene";
  if (!info && !isScene) return null;
  return (
    <Section title="물리">
      {isScene && <SceneFields description={description} />}
      {info?.body && <BodyFields body={info.body} />}
      {info?.collider && <ColliderFields collider={info.collider} />}
      {info?.joint && <JointFields joint={info.joint} />}
    </Section>
  );
}
