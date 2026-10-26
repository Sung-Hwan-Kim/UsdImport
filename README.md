# USD Viewer

`.usd` · `.usda` · `.usdc` · `.usdz` 파일을 브라우저에서 보는 웹 뷰어입니다. **Next.js 16 + React Three Fiber**로 만들었습니다.
모든 처리는 브라우저 안에서 이뤄지며, 파일은 서버로 업로드되지 않습니다(선택적인 로컬 Newton 서버를 쓸 때만 그 서버로 전송).
UsdPhysics가 작성된 스테이지는 **PhysX**(브라우저 WASM) 또는 **NVIDIA Newton**(로컬 GPU 서버)으로 시뮬레이션을 재생할 수 있습니다.
천(Surface Deformable)은 Newton으로 시뮬레이션합니다.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
```

## 사용법

- **파일 열기**: 드래그 앤 드롭, "파일 열기" / "폴더 열기" 버튼, 또는 샘플 스테이지
- **다른 레이어나 텍스처를 참조하는 스테이지**: 폴더째 드롭하면 references · payload · subLayers · 텍스처를 함께 해석합니다
  (상대 경로 → 대소문자 무시 → 파일 이름만으로 일치 순서로 찾습니다)
- **URL 파라미터**: `?sample=kitchen`, `?url=https://.../scene.usdz` (서버가 CORS를 허용해야 합니다)
- USD 파일 여러 개를 함께 드롭하면 루트 레이어를 자동으로 추정하며, 오른쪽 패널의 "루트 레이어" 선택에서 바꿀 수 있습니다

| 단축키 | 동작 |
|---|---|
| `F` / `A` | 선택 항목 포커스 / 전체 보기 |
| `H` / `Alt+H` | 선택 항목 숨기기 / 모두 표시 |
| `1`–`4` | PBR · Clay · Normal · Wireframe |
| `G` `L` `R` | 그리드 · USD 라이트 · 자동 회전 |
| `Space` | 애니메이션 재생/정지 |
| `P` / `Shift+R` | 물리 재생·일시정지 / 리셋 |
| `↑↓←→` | 계층 트리 탐색 |

## 물리 시뮬레이션

`PhysicsRigidBodyAPI` · `PhysicsCollisionAPI` 등 UsdPhysics가 작성된 스테이지를 열면 아래쪽에 물리 바가 나타납니다.

- **재생 · 한 프레임 진행 · 리셋 · 끄기**, 속도 조절, 콜라이더 와이어프레임 표시
- 시뮬레이션을 시작한 뒤 **동적 바디나 천을 마우스 왼쪽 버튼으로 끌면** 스프링으로 잡아당깁니다. 잡을 수 있는 바디 위에서는 커서가 손 모양으로 바뀌고,
  일시정지 중에 끌면 재생이 이어집니다 (빈 곳·정적 물체 드래그는 카메라 회전, 클릭은 선택)
- 인스펙터의 "물리" 섹션: 바디 종류·질량·초기 속도, 콜라이더 형상·물리 머티리얼, 조인트 종류·대상·제한·드라이브, 중력
- 지원 범위: 리지드 바디(dynamic/kinematic), 콜라이더(Cube/Sphere/Capsule 기본 형상, 볼록 껍질, 정적 삼각형 메시),
  물리 머티리얼(마찰·반발·밀도), MassAPI, 초기 선·각속도, 조인트(revolute · prismatic · spherical · fixed · distance · 일반 D6)와
  LimitAPI · DriveAPI, PhysicsScene 중력, `upAxis` · `metersPerUnit` 변환
- **천 (Newton 전용)**: AOUSD Deformable 제안 스키마 — `PhysicsSurfaceDeformableSimAPI`를 적용한 Mesh(점 하나가 파티클 하나),
  `PhysicsSurfaceDeformableMaterialAPI`(밀도 · 영률 · 푸아송 비), `physics:thicknesses`, 정적 대상에 붙인 `PhysicsAttachment`(고정점).
  리지드 바디와 서로 충돌하며, PhysX를 고르면 천은 움직이지 않는 채로 남습니다

| 엔진 | 실행 위치 | 준비 |
|---|---|---|
| **PhysX 5.11** (`physx-js-webidl`) | 브라우저 WASM, CPU | 없음 (`npm install` 시 wasm이 `public/physx/`로 복사됨) |
| **Newton 1.7** (NVIDIA Warp) | 로컬 Python 서버, GPU | `npm run newton:setup` 후 `npm run newton` — [server/newton/README.md](server/newton/README.md) |

엔진은 물리 바 왼쪽의 메뉴에서 바꿉니다. 물리 샘플: **Physics Playground**(USDA), **Physics Joints**(USDC), **Dominoes (Z-up, cm)**(USD),
**Physics Cloth**(USDA, Newton — 식탁보 · 봉에 고정된 커튼 · 공).

## 지원 기능

- USDA(ASCII), USDC(Crate 바이너리), USD(둘 중 하나), USDZ(패키지)
- 합성(Composition): `references`(defaultPrim / 프림 지정), `payload`, `subLayers`(스택 병합, `over` 오버라이드), USDC `variantSets`
- `active = false`, `visibility = invisible`, `purpose = guide`, 그리고 `over`나 `class`로만 존재하는 프림은 USD와 같이 렌더링에서 제외
- UsdGeom Mesh / Cube / Sphere / Cylinder / Cone / Capsule, GeomSubset 멀티 머티리얼
- UsdPreviewSurface / OpenPBR 머티리얼과 텍스처(PNG/JPG/WebP/AVIF), UsdLux 라이트
- UsdSkel 스키닝, SkelAnimation, 트랜스폼 time sample 애니메이션
- 트랜스폼: `xformOpOrder`를 USD 규칙대로 평가 — 접미사 op(`xformOp:scale:pivot` 등), 모든 회전 순서(`rotateZYX` 등), `!invert!`, Maya 피벗, `!resetXformStack!`, half 정밀도 값, 참조 대상과 참조하는 프림의 xform 값 합성
- `upAxis`(Z-up → Y-up)와 `metersPerUnit` 자동 변환
- 인스펙터: 트랜스폼, 지오메트리, 머티리얼(텍스처 썸네일 포함), 각 스펙의 USD 원본 프로퍼티

## 구조

```
src/lib/usd/
  loadStage.ts    로딩 파이프라인: 읽기 → 의존성 BFS → 레이어 스택 병합 → 합성 → 텍스처
  layers.ts       형식 감지, USDA 전처리, 의존성 추출, subLayer 병합 및 프림 정리
  crateParser.ts  USDCParser 확장 (three가 처리하지 못하는 Crate 값 타입과 버그)
  composer.ts     USDComposer 확장 (프림 태깅, 참조 의미론, 서브셋, 라이트)
  sources.ts      로컬 파일 / 메모리 내 USDZ / HTTP 에셋 소스
src/lib/physics/
  schema.ts       UsdPhysics → 시뮬레이션 기술(바디·콜라이더·머티리얼·조인트·중력, 미터·Y-up 기준)
  engine.ts       엔진 공통 인터페이스
  physx/          PhysX WASM 백엔드 (타입 래퍼 px.ts, physxEngine.ts)
  newton/         Newton 서버 클라이언트 (WebSocket)
src/components/   뷰어 UI(계층, 인스펙터, 툴바, 애니메이션 바, 물리 바)와 R3F 뷰포트(PhysicsRunner, ColliderOverlay)
server/newton/    Newton 물리 서버 (Python, WebSocket)
scripts/generate_samples.py   public/samples 생성 스크립트 (`pip install usd-core pillow` 필요)
```

파싱은 three.js의 `USDAParser` / `USDCParser` / `USDComposer`(three r186)를 기반으로 하며, 부족한 부분은 서브클래스로 보완했습니다.

- Crate: `ReferenceListOp` · `Payload(ListOp)` · `StringVector`(subLayers) · `TokenListOp` 디코딩,
  인라인된 `Vec3d`/`Vec3h` 값, 경로 개수와 인코딩된 경로 개수가 다른 경로 테이블 처리
- 합성: subLayer 스택, defaultPrim/프림 지정 references, 중첩 참조의 텍스처·애니메이션 전달,
  GeomSubset에 속하지 않은 면, 바인딩되지 않은 메시, UsdLux 라이트의 방향과 exposure

이 확장들은 three의 내부(`_`로 시작하는) 메서드를 오버라이드하므로 `three` 버전을 정확히 고정해 두었습니다.
업그레이드하기 전에 `src/lib/usd/crateParser.ts`와 `composer.ts`를 확인하세요.

## 알려진 제한 사항

- USDA의 `variantSet` 블록, `inherits` / `specializes`, 내부 참조(에셋 없는 `</Path>`)는 지원하지 않습니다
- DomeLight(HDR 환경 조명), PointInstancer, BasisCurves / Points, UDIM, EXR/TIFF 텍스처는 지원하지 않습니다
- 큰 파일은 메인 스레드에서 파싱하므로 로딩 중 UI가 잠깐 멈출 수 있습니다
- 물리: 아티큘레이션(ArticulationRootAPI)은 일반 조인트로 시뮬레이션합니다. convexDecomposition은 PhysX에서 단일 볼록 껍질로 근사하며,
  동적 바디의 삼각형 메시 콜라이더도 볼록 껍질로 대체합니다. 충돌 그룹 · FilteredPairsAPI는 아직 반영하지 않습니다
- Deformable: 천만 지원합니다(Newton). 볼륨(TetMesh) · 커브 Deformable, 리지드 바디에 붙인 천 Attachment, 예전 Omniverse의
  `PhysxDeformableBodyAPI` · `PhysxParticleClothAPI`는 지원하지 않습니다
