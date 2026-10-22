"use client";

import { AlertTriangle, Crosshair, Eye, EyeOff, FileBox, Info } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import {
  Box3,
  Euler,
  MathUtils,
  Vector3,
  type Camera,
  type Color,
  type Light,
  type Material,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type SkinnedMesh,
  type Texture,
} from "three";
import { formatCount, formatMs, formatNumber, formatValue } from "@/lib/format";
import { authoredMaterials, computeBounds, displayName, nodeKind, stagePathOf, usdTypeOf } from "@/lib/scene";
import { useViewer } from "@/lib/store";
import { getPrimTag, type PrimTag } from "@/lib/usd/composer";
import { SpecType, type USDSpec } from "@/lib/usd/layers";
import { geometryCounts, texturesOf, type LoadedStage } from "@/lib/usd/loadStage";
import { basename, formatBytes } from "@/lib/usd/paths";
import { KIND_COLOR, KIND_ICON } from "./HierarchyPanel";
import { Badge, cn, Field, IconButton, Section } from "./ui";

const FORMAT_LABEL: Record<LoadedStage["rootFormat"], string> = {
  usda: "USDA · ASCII",
  usdc: "USDC · Crate 바이너리",
  usdz: "USDZ · 패키지",
};

const MAP_LABELS: Record<string, string> = {
  map: "Base Color",
  normalMap: "Normal",
  roughnessMap: "Roughness",
  metalnessMap: "Metallic",
  emissiveMap: "Emissive",
  aoMap: "Occlusion",
  alphaMap: "Opacity",
  clearcoatMap: "Clearcoat",
  clearcoatRoughnessMap: "Clearcoat Rough.",
  specularColorMap: "Specular",
  specularIntensityMap: "Specular Int.",
  displacementMap: "Displacement",
  bumpMap: "Bump",
  transmissionMap: "Transmission",
  sheenColorMap: "Sheen",
  iridescenceMap: "Iridescence",
};

// ---------------------------------------------------------------- stage

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-bg/60 px-2.5 py-2 ring-1 ring-line">
      <div className="font-mono text-[14px] leading-none text-fg tabular-nums">{value}</div>
      <div className="mt-1 text-[10.5px] text-muted">{label}</div>
    </div>
  );
}

function StageInspector({ stage }: { stage: LoadedStage }) {
  const session = useViewer((s) => s.session);
  const switchRoot = useViewer((s) => s.switchRoot);
  const { metadata: m, stats } = stage;
  const rootLayer = stage.layers.get(stage.rootPath);
  const totalBytes = [...stage.layers.values()].reduce((sum, l) => sum + l.byteLength, 0);

  return (
    <>
      <div className="border-b border-line px-3 py-3">
        <div className="flex items-start gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <FileBox className="size-[18px]" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-fg" title={stage.rootPath}>
              {stage.name}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-muted">
              {FORMAT_LABEL[stage.rootFormat]} · {formatBytes(rootLayer?.byteLength ?? 0)}
            </div>
          </div>
        </div>
        {session && session.candidates.length > 1 && (
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] text-muted">루트 레이어</span>
            <select
              value={session.rootPath}
              onChange={(e) => switchRoot(e.target.value)}
              className="h-8 w-full rounded-md border border-line-strong bg-raised px-2 font-mono text-[11.5px] text-fg outline-none focus:border-accent"
            >
              {session.candidates.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
        {m.documentation && <p className="mt-3 text-[12px] leading-relaxed text-muted">{m.documentation}</p>}
      </div>

      {(stage.missing.length > 0 || stage.warnings.length > 0) && (
        <Section title="경고" count={stage.missing.length + stage.warnings.length}>
          <div className="space-y-1.5">
            {stage.missing.map((p) => (
              <div key={p} className="flex gap-2 text-[12px] text-warn">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-all">
                  누락된 에셋 <span className="font-mono text-[11.5px]">{p}</span>
                </span>
              </div>
            ))}
            {stage.warnings.map((w) => (
              <div key={w} className="flex gap-2 text-[12px] text-muted">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-all">{w}</span>
              </div>
            ))}
            {stage.missing.length > 0 && (
              <p className="pt-1 text-[11.5px] leading-relaxed text-faint">
                참조된 레이어와 텍스처를 함께 불러오려면 파일이 들어있는 폴더 전체를 드롭하거나 “폴더 열기”를 사용하세요.
              </p>
            )}
          </div>
        </Section>
      )}

      <Section title="스테이지">
        <Field label="Up Axis">
          {m.upAxis}
          {!m.upAxisAuthored && <span className="text-faint"> (기본값)</span>}
        </Field>
        <Field label="Meters/Unit">
          {m.metersPerUnit !== undefined ? (
            <>
              {formatNumber(m.metersPerUnit)}
              {m.metersPerUnit === 0.01 && <span className="text-faint"> (cm)</span>}
              {m.metersPerUnit === 1 && <span className="text-faint"> (m)</span>}
            </>
          ) : (
            <span className="text-faint">미지정</span>
          )}
        </Field>
        <Field label="Default Prim" mono>
          {m.defaultPrim ? `/${m.defaultPrim}` : <span className="text-faint">—</span>}
        </Field>
        {(m.startTimeCode !== undefined || stage.animations.length > 0) && (
          <Field label="Time Codes">
            {m.startTimeCode !== undefined ? `${formatNumber(m.startTimeCode)} – ${formatNumber(m.endTimeCode ?? m.startTimeCode)}` : "—"}
            <span className="text-faint"> @ {formatNumber(m.timeCodesPerSecond)} fps</span>
          </Field>
        )}
        <Field label="소스">{stage.sourceLabel}</Field>
      </Section>

      <Section title="통계">
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="프림" value={formatCount(stats.prims)} />
          <Stat label="메시" value={formatCount(stats.meshes)} />
          <Stat label="삼각형" value={formatCount(stats.triangles)} />
          <Stat label="정점" value={formatCount(stats.vertices)} />
          <Stat label="머티리얼" value={formatCount(stats.materials)} />
          <Stat label="텍스처" value={formatCount(stats.textures)} />
          <Stat label="참조" value={formatCount(stats.references)} />
          <Stat label="라이트" value={formatCount(stats.lights)} />
          <Stat label="애니메이션" value={formatCount(stage.animations.length)} />
        </div>
      </Section>

      <Section title="레이어" count={stage.layers.size}>
        <ul className="space-y-1">
          {[...stage.layers.values()].map((layer) => (
            <li key={layer.path} className="flex items-center gap-2 text-[12px]">
              <Badge tone={layer.role === "root" ? "accent" : "neutral"} className="w-[62px] justify-center">
                {layer.role === "root" ? "ROOT" : layer.role === "sublayer" ? "SUBLAYER" : "REF"}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={layer.path}>
                {layer.path}
              </span>
              <span className="shrink-0 text-[11px] text-faint">{layer.format.toUpperCase()}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 text-[11px] text-faint">합계 {formatBytes(totalBytes)}</div>
      </Section>

      {stage.textures.length > 0 && (
        <Section title="텍스처 파일" count={stage.textures.length} defaultOpen={stage.textures.length <= 8}>
          <ul className="space-y-1">
            {stage.textures.map((t) => (
              <li key={t.path} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={t.path}>
                  {t.path}
                </span>
                <span className="shrink-0 text-[11px] text-faint">{formatBytes(t.byteLength)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="로딩 시간" defaultOpen={false}>
        <Field label="읽기 + 파싱">{formatMs(stage.timings.parse)}</Field>
        <Field label="씬 합성">{formatMs(stage.timings.compose)}</Field>
        <Field label="텍스처">{formatMs(stage.timings.textures)}</Field>
        <Field label="전체">{formatMs(stage.timings.total)}</Field>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- object

function Vec({ v, digits = 3 }: { v: [number, number, number]; digits?: number }) {
  return (
    <span className="grid grid-cols-3 gap-1">
      {v.map((x, i) => (
        <span key={i} className="truncate rounded bg-bg/60 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums ring-1 ring-line">
          <span className={cn("float-left", ["text-[#ff7d8a]", "text-[#6ee07c]", "text-accent"][i])}>{"XYZ"[i]}</span>
          {formatNumber(x, digits)}
        </span>
      ))}
    </span>
  );
}

function TransformSection({ obj }: { obj: Object3D }) {
  const rot = new Euler().copy(obj.rotation);
  const size = computeBounds(obj, new Box3()).getSize(new Vector3());
  return (
    <Section title="트랜스폼 (로컬)">
      <div className="space-y-1.5">
        <Field label="위치">
          <Vec v={obj.position.toArray() as [number, number, number]} />
        </Field>
        <Field label="회전 (°)">
          <Vec v={[MathUtils.radToDeg(rot.x), MathUtils.radToDeg(rot.y), MathUtils.radToDeg(rot.z)]} digits={2} />
        </Field>
        <Field label="스케일">
          <Vec v={obj.scale.toArray() as [number, number, number]} />
        </Field>
        <Field label="월드 크기 (m)">
          <Vec v={size.toArray() as [number, number, number]} />
        </Field>
      </div>
    </Section>
  );
}

function GeometrySection({ mesh }: { mesh: Mesh }) {
  const { vertices, triangles } = geometryCounts(mesh);
  const g = mesh.geometry;
  const skinned = (mesh as SkinnedMesh).isSkinnedMesh ? (mesh as SkinnedMesh) : null;
  return (
    <Section title="지오메트리">
      <Field label="정점">{vertices.toLocaleString()}</Field>
      <Field label="삼각형">{triangles.toLocaleString()}</Field>
      <Field label="어트리뷰트" mono>
        {Object.keys(g.attributes).join(", ")}
      </Field>
      {g.groups.length > 0 && <Field label="서브셋 그룹">{g.groups.length}</Field>}
      {skinned && <Field label="스켈레톤">본 {skinned.skeleton?.bones.length ?? 0}개</Field>}
    </Section>
  );
}

function TextureThumb({ slot, texture }: { slot: string; texture: Texture }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const image = texture.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx || !image || !image.width) return;
    try {
      ctx.drawImage(image, 0, 0, ctx.canvas.width, ctx.canvas.height);
    } catch {
      // Image not decodable into a 2D canvas (e.g. compressed); leave blank.
    }
  }, [image]);
  return (
    <div className="w-[58px]" title={image?.width ? `${MAP_LABELS[slot] ?? slot} · ${image.width}×${image.height}` : slot}>
      <canvas ref={ref} width={64} height={64} className="size-[58px] rounded bg-bg ring-1 ring-line-strong" />
      <div className="mt-0.5 truncate text-[10px] text-muted">{MAP_LABELS[slot] ?? slot}</div>
    </div>
  );
}

function Swatch({ color }: { color: Color }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px]">
      <span className="size-3.5 rounded-sm ring-1 ring-white/15" style={{ background: `#${color.getHexString()}` }} />#
      {color.getHexString()}
    </span>
  );
}

function MaterialCard({ material }: { material: Material }) {
  const m = material as Material & {
    color?: Color;
    emissive?: Color;
    emissiveIntensity?: number;
    metalness?: number;
    roughness?: number;
    ior?: number;
    clearcoat?: number;
  };
  const maps = texturesOf(material);
  const emissive = m.emissive && m.emissive.getHex() !== 0 ? m.emissive : null;
  return (
    <div className="rounded-md bg-bg/50 p-2.5 ring-1 ring-line">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{material.name || "(이름 없음)"}</span>
        <Badge>{material.type.replace("Material", "")}</Badge>
      </div>
      {m.color && (
        <Field label="Base Color">
          <Swatch color={m.color} />
        </Field>
      )}
      {m.metalness !== undefined && <Field label="Metallic">{formatNumber(m.metalness, 3)}</Field>}
      {m.roughness !== undefined && <Field label="Roughness">{formatNumber(m.roughness, 3)}</Field>}
      {(material.transparent || material.opacity < 1) && <Field label="Opacity">{formatNumber(material.opacity, 3)}</Field>}
      {emissive && (
        <Field label="Emissive">
          <Swatch color={emissive} />
        </Field>
      )}
      {m.clearcoat ? <Field label="Clearcoat">{formatNumber(m.clearcoat, 3)}</Field> : null}
      {material.side === 2 && <Field label="Double Sided">true</Field>}
      {maps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {maps.map(([slot, t]) => (
            <TextureThumb key={slot} slot={slot} texture={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function MaterialSection({ mesh }: { mesh: Mesh }) {
  const materials = authoredMaterials(mesh);
  return (
    <Section title="머티리얼" count={materials.length}>
      <div className="space-y-2">
        {materials.map((m) => (
          <MaterialCard key={m.uuid} material={m} />
        ))}
      </div>
    </Section>
  );
}

function LightSection({ light }: { light: Light }) {
  return (
    <Section title="라이트">
      <Field label="종류">{light.type}</Field>
      <Field label="색상">
        <Swatch color={light.color} />
      </Field>
      <Field label="강도">{formatNumber(light.intensity, 3)}</Field>
    </Section>
  );
}

function CameraSection({ camera }: { camera: Camera }) {
  const persp = (camera as PerspectiveCamera).isPerspectiveCamera ? (camera as PerspectiveCamera) : null;
  return (
    <Section title="카메라">
      <Field label="종류">{camera.type}</Field>
      {persp && <Field label="FOV">{formatNumber(persp.fov, 2)}°</Field>}
      {persp && (
        <Field label="클리핑">
          {formatNumber(persp.near, 3)} – {formatNumber(persp.far, 1)}
        </Field>
      )}
    </Section>
  );
}

const HIDDEN_PRIM_FIELDS = new Set(["typeName", "specifier", "primChildren", "properties"]);

function UsdSpecSection({ stage, tag }: { stage: LoadedStage; tag: PrimTag }) {
  const specs = stage.layers.get(tag.layer)?.data.specsByPath;
  const { metadata, properties } = useMemo(() => {
    const prim = specs?.[tag.path];
    const metadata = prim
      ? Object.entries(prim.fields).filter(([k, v]) => !HIDDEN_PRIM_FIELDS.has(k) && v !== null && v !== undefined)
      : [];
    const properties: [string, USDSpec][] = [];
    if (specs) {
      const prefix = `${tag.path}.`;
      for (const path in specs) {
        if (path.startsWith(prefix) && !path.includes("/", prefix.length)) properties.push([path.slice(prefix.length), specs[path]]);
      }
      properties.sort(([a], [b]) => a.localeCompare(b));
    }
    return { metadata, properties };
  }, [specs, tag]);

  if (!specs) return null;
  return (
    <Section title="USD 프로퍼티" count={properties.length}>
      <div className="mb-2 space-y-0.5 rounded-md bg-bg/50 p-2 ring-1 ring-line">
        <Field label="레이어" mono>
          {tag.layer}
        </Field>
        <Field label="스펙 경로" mono>
          {tag.path}
        </Field>
        {tag.purpose && <Field label="purpose">{tag.purpose}</Field>}
        {metadata.map(([k, v]) => (
          <Field key={k} label={k} mono>
            {formatValue(v)}
          </Field>
        ))}
      </div>
      {properties.length === 0 ? (
        <p className="text-[12px] text-faint">이 스펙에 작성된 프로퍼티가 없습니다.</p>
      ) : (
        <div className="divide-y divide-line/60">
          {properties.slice(0, 400).map(([name, spec]) => {
            const f = spec.fields;
            const isRel = spec.specType === SpecType.Relationship;
            const links = (f.connectionPaths ?? f.targetPaths) as string[] | undefined;
            const value = links?.length
              ? `→ ${links.join(", ")}`
              : f.timeSamples
                ? formatValue(f.timeSamples)
                : formatValue(f.default, String(f.typeName ?? ""));
            return (
              <div key={name} className="py-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg" title={name}>
                    {name}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-faint">
                    {isRel ? "rel" : String(f.typeName ?? "")}
                    {typeof f.interpolation === "string" ? ` · ${f.interpolation}` : ""}
                  </span>
                </div>
                <div className={cn("mt-0.5 font-mono text-[11px] break-all", links?.length ? "text-accent" : "text-muted")}>{value}</div>
              </div>
            );
          })}
          {properties.length > 400 && <p className="pt-2 text-[11px] text-faint">… 외 {properties.length - 400}개</p>}
        </div>
      )}
    </Section>
  );
}

function ObjectInspector({ obj, stage }: { obj: Object3D; stage: LoadedStage }) {
  const setVisible = useViewer((s) => s.setVisible);
  const requestFocus = useViewer((s) => s.requestFocus);
  useViewer((s) => s.revision);
  useViewer((s) => s.animation.playing && s.animation.time); // live transforms while playing

  const kind = nodeKind(obj);
  const Icon = KIND_ICON[kind];
  const tag = getPrimTag(obj);
  const mesh = (obj as Mesh).isMesh ? (obj as Mesh) : null;
  const light = (obj as Light).isLight ? (obj as Light) : null;
  const camera = (obj as Camera).isCamera ? (obj as Camera) : null;

  return (
    <>
      <div className="border-b border-line px-3 py-3">
        <div className="flex items-start gap-2.5">
          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-md bg-hover", KIND_COLOR[kind])}>
            <Icon className="size-[18px]" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-fg" title={displayName(obj)}>
              {displayName(obj)}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Badge tone="accent">{usdTypeOf(obj)}</Badge>
              {obj.type !== usdTypeOf(obj) && <Badge>{obj.type}</Badge>}
              {!obj.visible && <Badge tone="warn">hidden</Badge>}
            </div>
          </div>
          <IconButton icon={Crosshair} label="포커스" shortcut="F" onClick={() => requestFocus("selection")} />
          <IconButton icon={obj.visible ? Eye : EyeOff} label={obj.visible ? "숨기기" : "표시"} shortcut="H" onClick={() => setVisible(obj, !obj.visible)} />
        </div>
        <div className="mt-2.5 rounded-md bg-bg/60 px-2 py-1.5 font-mono text-[11px] break-all text-muted ring-1 ring-line" title="스테이지 경로">
          {stagePathOf(obj)}
        </div>
        {tag?.source && (
          <div className="mt-1.5 text-[11px] text-faint">
            참조 원본 <span className="font-mono text-muted">{basename(tag.source.layer)}</span>
            <span className="font-mono">{tag.source.path}</span>
          </div>
        )}
      </div>
      <TransformSection obj={obj} />
      {mesh && <GeometrySection mesh={mesh} />}
      {mesh && <MaterialSection mesh={mesh} />}
      {light && <LightSection light={light} />}
      {camera && <CameraSection camera={camera} />}
      {tag && tag.typeName !== "Stage" && <UsdSpecSection stage={stage} tag={tag} />}
    </>
  );
}

export default function InspectorPanel() {
  const stage = useViewer((s) => s.stage);
  const selected = useViewer((s) => s.selected);
  const select = useViewer((s) => s.select);
  const showObject = stage && selected && getPrimTag(selected)?.typeName !== "Stage";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {showObject ? (
          <>
            <button type="button" onClick={() => select(null)} className="hover:text-fg">
              스테이지
            </button>
            <span className="text-faint">/</span>
            <span className="text-fg">속성</span>
          </>
        ) : (
          "스테이지 정보"
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-line">
        {!stage ? (
          <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-faint">로드된 스테이지가 없습니다.</p>
        ) : showObject ? (
          <ObjectInspector key={selected.uuid} obj={selected} stage={stage} />
        ) : (
          <StageInspector stage={stage} />
        )}
      </div>
    </div>
  );
}
