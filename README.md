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
| `Space` | 애니메이션 재생/정지 (물리 스테이지에서는 물리 시뮬레이션과 함께 재생/정지) |
| `P` / `Shift+R` | 물리 재생·일시정지 / 리셋 |
| `E` | Isaac Sim 스크립트 에디터 열기/닫기 |
| `Ctrl+S` | 스테이지 저장 (USDA · USDC · USD) |
| `↑↓←→` | 계층 트리 탐색 |

## 물리 시뮬레이션

`PhysicsRigidBodyAPI` · `PhysicsCollisionAPI` 등 UsdPhysics가 작성된 스테이지를 열면 아래쪽에 물리 바가 나타납니다.

- **재생 · 한 프레임 진행 · 리셋 · 끄기**, 속도 조절, 콜라이더 와이어프레임 표시
- 시뮬레이션을 시작한 뒤 **동적 바디나 천을 마우스 왼쪽 버튼으로 끌면** 스프링으로 잡아당깁니다. 잡을 수 있는 바디 위에서는 커서가 손 모양으로 바뀌고,
  일시정지 중에 끌면 재생이 이어집니다 (빈 곳·정적 물체 드래그는 카메라 회전, 클릭은 선택)
- **애니메이션과 함께 재생 (Isaac Sim의 Play처럼)**: 물리 스테이지는 열어도 자동 재생하지 않으며, 애니메이션 바의 재생 버튼과
  `Space`가 물리 시뮬레이션을 시작·일시정지합니다(애니메이션만 따로 돌리면 키네마틱 부분만 움직이므로). 시뮬레이션은 스테이지의
  `startTimeCode`에서 시작하고, 켜져 있는 동안 애니메이션 타임라인이 시뮬레이션 시간을 따릅니다(타임라인 스크럽은 잠기고
  "처음으로"는 물리 리셋).
  애니메이션되는 키네마틱 바디는 매 스텝 그 시점의 자세를 목표로 움직이고, 시간 샘플이 있는 조인트 드라이브 목표
  (`drive:*:physics:targetPosition` / `targetVelocity`)는 매 스텝 보간해 적용합니다 — 예: 6축 드라이브 조인트로 월드에 매단 로봇 손이
  궤적을 따라 움직임
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

## 저장

상단 바의 저장 버튼이나 `Ctrl+S`로 열려 있는 스테이지의 **루트 레이어**를 USDA(텍스트) · USDC(바이너리) · USD(바이너리)로 저장합니다.

- **반영되는 변경 사항**: 물리 재생 결과 포즈(리지드 바디, `xformOp:transform` 하나로 기록), 천 모양(`points`), 뷰어에서 숨기거나 다시 표시한 프림(`visibility`).
  참조나 서브레이어에서 온 프림은 루트 레이어에 `over`로 기록합니다
- **구조 유지**: 참조 · 서브레이어 · 배리언트 · 메타데이터 등 원본 내용은 그대로 두고, 참조 경로도 원본 기준 상대 경로 그대로 저장합니다(원본과 같은 폴더에 저장하세요)
- **변환 방식**: 기본은 브라우저에서 직접 변환합니다. 뷰어 표시용 파서와 별도로, USDA/USDC를 손실 없이 읽고 쓰는 구현(`src/lib/usd/sdf/`)을 씁니다.
  로컬 Newton 서버(`npm run newton`)가 켜져 있으면 OpenUSD로 저장하는 쪽을 기본으로 고릅니다
- 두 방식의 결과는 같으며, 테스트 코퍼스(모든 값 형식 · 리스트 연산 · 참조 · 배리언트 · 타임샘플)와 샘플 전체를 OpenUSD로 다시 읽어 원본과 같음을 확인했습니다
- 제한: USDZ 패키지는 저장하지 않습니다. 브라우저 변환은 스플라인 · 배열 편집(ArrayEdit) 같은 최신 값 형식을 만나면 저장을 멈추고 알려 줍니다(OpenUSD 서버로는 저장 가능)

## Isaac Sim 스크립트 에디터

상단 바의 `</>` 버튼이나 `E`로 뷰포트 아래에 Python 에디터(CodeMirror 6)를 엽니다. 위쪽 경계를 끌어 높이를 바꾸거나 최대화할 수 있습니다.

- **열기**: 에디터의 열기 버튼, 또는 `.py` 파일을 화면에 끌어다 놓기(USD 파일과 함께 놓아도 각각 처리됩니다). 여러 파일을 탭으로 엽니다
- **저장**: `Ctrl+S`. Chrome · Edge에서는 연 파일에 바로 덮어쓰고, 새 스크립트는 저장 위치를 묻습니다. 그 밖의 브라우저는 다운로드로 저장합니다.
  편집 중인 내용은 브라우저에 자동 보관되어 새로고침해도 남습니다
- **템플릿**: Standalone 앱, Hello World(큐브 떨어뜨리기), Script Editor 스니펫, 선택한 프림을 리지드 바디로, World 기반(Isaac Sim 4.5–5.x).
  열려 있는 스테이지 파일 이름과 선택한 프림 경로를 채워 넣습니다
- **자동완성**: Isaac Sim 6.x의 `isaacsim.core.experimental`(stage · prim · xform 유틸, objects, prims, materials), `SimulationApp`,
  `SimulationManager`, `omni.usd` · `omni.timeline`, `pxr`(Usd · UsdGeom · UsdPhysics · Gf · Sdf)와 이전 버전 이름. `import x as y`로 붙인 별칭도 따라갑니다
- **문법 검사**: Python 문법 오류를 줄에 표시하고 상태 표시줄에 개수를 보여 줍니다
- **프림 경로 삽입**: 뷰어에서 선택한 프림의 경로를 커서 위치에 넣습니다

스크립트 실행은 Isaac Sim에서 합니다(Standalone은 `python.sh` / `python.bat`, 스니펫은 Window › Script Editor).

## 지원 기능

- USDA(ASCII), USDC(Crate 바이너리), USD(둘 중 하나), USDZ(패키지)
- 합성(Composition): `references`(defaultPrim / 프림 지정, 같은 파일 안의 `</Path>` 내부 참조 포함), `payload`, `subLayers`(스택 병합, `over` 오버라이드), USDC `variantSets`
- `active = false`, `visibility = invisible`, `purpose = guide`, 그리고 `over`나 `class`로만 존재하는 프림은 USD와 같이 렌더링에서 제외
- UsdGeom Mesh / Cube / Sphere / Cylinder / Cone / Capsule, GeomSubset 멀티 머티리얼
- UsdPreviewSurface / OpenPBR 머티리얼과 텍스처(PNG/JPG/WebP/AVIF), 머티리얼이 없는 프림의 `displayColor`·`displayOpacity`(Cube·Sphere 등 포함)
- UsdLux 라이트 — Omniverse/Isaac Sim처럼 세기가 RTX 기준(가장 밝은 라이트가 100 초과)이면 RTX 기본 노출처럼 1/1000로 줄여 표시
- UsdSkel 스키닝, SkelAnimation, 트랜스폼 time sample 애니메이션 — 모든 프림 타입(Cube·Sphere 등 포함)과 모든 xformOp에서,
  각 키에서 op 스택 전체를 평가(회전·피벗은 키를 촘촘히), 같은 이름의 프림이나 같은 에셋을 여러 번 참조해도 프림마다 따로 재생,
  클립 끝을 지나면 마지막 값을 유지
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
src/lib/usd/sdf/  저장용 무손실 USD 레이어 모델: USDA 읽기/쓰기, USDC(Crate) 읽기/쓰기, 압축, 편집 적용
src/lib/scripts/  스크립트 에디터: CodeMirror 설정, Isaac Sim API 자동완성 카탈로그, 템플릿, 파일 열기/저장
src/components/   뷰어 UI(계층, 인스펙터, 툴바, 애니메이션 바, 물리 바, 스크립트 에디터)와 R3F 뷰포트(PhysicsRunner, ColliderOverlay)
server/newton/    Newton 물리 서버 (Python, WebSocket)
scripts/generate_samples.py   public/samples 생성 스크립트 (`pip install usd-core pillow` 필요)
```

파싱은 three.js의 `USDAParser` / `USDCParser` / `USDComposer`(three r186)를 기반으로 하며, 부족한 부분은 서브클래스로 보완했습니다.

- Crate: `ReferenceListOp` · `Payload(ListOp)` · `StringVector`(subLayers) · `TokenListOp` 디코딩,
  인라인된 `Vec3d`/`Vec3h` 값, 경로 개수와 인코딩된 경로 개수가 다른 경로 테이블 처리
- 합성: subLayer 스택, defaultPrim/프림 지정 references, 중첩 참조의 텍스처·애니메이션 전달,
  GeomSubset에 속하지 않은 면, 바인딩되지 않은 메시, UsdLux 라이트의 방향과 exposure
- 내부 참조: three는 에셋 경로 없는 `</Path>` 참조를 무시하므로, 레이어 스택을 합칠 때 대상 프림의 스펙을 참조하는 프림 아래로
  복사해 약한 의견으로 합성합니다(대상 안을 가리키는 관계·연결 경로도 옮김). 대상은 보통 그려지지 않는 `class` 프림 아래에
  있어서 정리 전에 합성하며, USDA의 `class` 블록도 읽도록 보완했습니다
- 머티리얼: three는 `displayColor`를 Mesh 프림에만 적용하므로, 바인딩되지 않은 모든 지오메트리의 기본 머티리얼에 직접 반영
- 애니메이션: three의 트랜스폼 클립은 일부 op 이름만, Xform/Scope/Mesh 프림만 다루고 트랙을 프림 이름으로 묶어
  같은 이름의 프림이 모두 첫 번째 프림을 움직였으므로, 스테이지 전체의 트랜스폼 클립을 직접 만들어 오브젝트 uuid로 묶음

이 확장들은 three의 내부(`_`로 시작하는) 메서드를 오버라이드하므로 `three` 버전을 정확히 고정해 두었습니다.
업그레이드하기 전에 `src/lib/usd/crateParser.ts`와 `composer.ts`를 확인하세요.

## 알려진 제한 사항

- 표시: USDA의 `variantSet` 블록, `inherits` / `specializes`, 같은 파일 안의 내부 payload는 지원하지 않습니다
  (저장은 이것들을 모두 그대로 유지합니다)
- DomeLight(HDR 환경 조명), PointInstancer, BasisCurves / Points, UDIM, EXR/TIFF 텍스처는 지원하지 않습니다
- 큰 파일은 메인 스레드에서 파싱하므로 로딩 중 UI가 잠깐 멈출 수 있습니다
- 물리: 아티큘레이션(ArticulationRootAPI)은 일반 조인트로 시뮬레이션합니다. convexDecomposition은 PhysX에서 단일 볼록 껍질로 근사하며,
  동적 바디의 삼각형 메시 콜라이더도 볼록 껍질로 대체합니다. 충돌 그룹 · FilteredPairsAPI는 아직 반영하지 않습니다
- Deformable: 천만 지원합니다(Newton). 볼륨(TetMesh) · 커브 Deformable, 리지드 바디에 붙인 천 Attachment, 예전 Omniverse의
  `PhysxDeformableBodyAPI` · `PhysxParticleClothAPI`는 지원하지 않습니다
