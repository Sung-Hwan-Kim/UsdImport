# Newton 물리 서버

웹 뷰어의 **Newton** 엔진 백엔드입니다. 브라우저가 스테이지의 USD 파일을 WebSocket으로 보내면, 이 서버가
OpenUSD로 합성하고 [NVIDIA Newton](https://github.com/newton-physics/newton)(Warp 기반)으로 시뮬레이션한 뒤
리지드 바디 포즈와 천 파티클 위치를 실시간으로 돌려보냅니다. `127.0.0.1`에만 바인딩되며, 업로드된 파일은 세션별 임시 폴더에 저장되었다가 연결이 끊기면 삭제됩니다.

## 요구 사항

- Python 3.11 – 3.13
- NVIDIA GPU + R580 이상 드라이버 (CUDA). GPU가 없으면 `--device cpu`로 실행할 수 있지만 느립니다.

## 설치 · 실행

프로젝트 루트에서:

```bash
npm run newton:setup   # .venv-newton 생성 + newton[importers]==1.7.0, websockets 설치
npm run newton         # ws://127.0.0.1:8765 에서 대기 (기본: CUDA가 있으면 cuda:0)
npm run newton -- --device cpu --port 8800
```

직접 실행할 수도 있습니다: `.venv-newton/Scripts/python server/newton/server.py --device cuda:0` (Linux/macOS는 `.venv-newton/bin/python`).

뷰어의 물리 바에서 엔진을 **Newton**으로 바꾸고 재생(▶ 또는 `P`)하면 연결됩니다. 서버 주소는 엔진 메뉴에서 바꿀 수 있습니다.
처음 로드할 때는 Warp 커널 컴파일로 수십 초가 걸리고, 이후에는 캐시되어 1초 이내에 준비됩니다.

브라우저 없이 확인하려면:

```bash
.venv-newton/Scripts/python server/newton/test_client.py public/samples/physics_joints.usdc --base public --seconds 2
```

## 동작 방식

- `ModelBuilder(up_axis=스테이지 upAxis)` + `add_usd()` — 스테이지의 축과 **단위를 그대로** 유지하므로, 포즈는 스테이지 좌표계(스테이지 단위)로 전송되고 뷰어가 스테이지 루트 변환을 곱해 표시합니다.
- 솔버는 `SolverXPBD`(8 iterations, 반발 활성화)이며, 한 프레임(1/60초)을 8 서브스텝으로 나눕니다. CUDA에서는 CUDA 그래프로 캡처해 재생합니다.
- 천이 있으면 `add_usd(return_deformable_results=True)`로 천을 가져오고(메시 점 하나가 파티클 하나), 솔버를 `SolverVBD`
  (천은 VBD, 리지드 바디는 AVBD로 서로 결합, 셀프 충돌 활성화, 10 서브스텝)로 바꿉니다. 매 프레임 셀프 충돌 BVH를 다시 만들고,
  천에는 선형 공기 저항을 더합니다(없으면 흔들림이 거의 줄지 않음).
- Newton 1.7은 천에 붙인 `PhysicsAttachment`를 읽기만 하고 적용하지 않으므로, 정적 xform(또는 월드)을 대상으로 한 Attachment는
  서버가 해당 파티클을 고정(질량 0, 비활성)합니다. 리지드 바디를 대상으로 한 천 Attachment는 경고 후 건너뜁니다.
- 마우스 드래그는 잡은 지점에 스프링-댐퍼 힘(질량 비례)을 Warp 커널로 `body_f`에 더합니다. 천은 잡은 파티클 주변 5cm의
  파티클들에 같은 방식의 힘을 `particle_f`로 더합니다(파티클을 직접 옮기면 VBD의 접촉 기록과 어긋나 불안정해집니다).
- Newton 1.7 임포터 보완: `physics:body0/1`이 RigidBodyAPI 없는 정적 프림을 가리키는 조인트는 그 프레임을 월드 좌표로 옮기고(세션 레이어에서, 원본 파일은 수정하지 않음), 연결된 바디와 그 정적 형상 사이 충돌을 끕니다. 아티큘레이션에 속하지 않은 조인트도 XPBD에서는 제약으로 풀 수 있으므로 해당 검증만 건너뜁니다.

## 스테이지 저장

뷰어의 저장 대화상자에서 "OpenUSD 서버"를 고르면 이 서버가 저장을 맡습니다. 업로드된 루트 레이어를 `Sdf.Layer`로 열어
변경 사항(`edits`: 프림 경로별 `matrix`(행 우선 4×4) · `resetXformStack` · `visibility` · `points`)을 기록하고, 원본 옆에
`Export`해 결과 파일을 돌려줍니다. 브라우저 구현(`src/lib/usd/sdf/edits.ts`)과 같은 방식으로 기록합니다.

## 프로토콜

WebSocket, JSON 텍스트 메시지 + 바이너리 프레임.

| 방향 | 메시지 |
|---|---|
| 클라이언트 → 서버 | `{"type":"load","root","files":[{"path","size"}],"solver":"xpbd","substeps":8,"fps":60}` 다음에 `files` 순서대로 파일당 바이너리 메시지 1개 |
| | `{"type":"save","root","files":[…],"format":"usda"\|"usdc"\|"usd","edits":[…]}` 다음에 파일 바이너리 — 뷰어의 변경 사항을 루트 레이어에 기록해 OpenUSD로 내보낸 파일을 바이너리 메시지 하나로 돌려줌 |
| | `{"type":"play"}`, `{"type":"pause"}`, `{"type":"step"}`, `{"type":"reset"}`, `{"type":"speed","value":1}` |
| | `{"type":"drag","body":<index>,"local":[x,y,z],"target":[x,y,z]}` (local은 바디 좌표계, target은 스테이지 좌표계), `{"type":"drag_particle","particle":<index>,"target":[x,y,z]}`, `{"type":"drag_end"}` |
| 서버 → 클라이언트 | `{"type":"ready","bodies":[프림 경로…],"cloths":[{"path","start","count"}…],"particles","device","solver","dt","substeps","upAxis","metersPerUnit","joints","shapes","warnings"}` |
| | 프레임(바이너리, little-endian float32): `[simTime, bodyCount, particleCount, bodyCount × (px, py, pz, qx, qy, qz, qw), particleCount × (x, y, z)]` — 재생 중 프레임마다, 그리고 load / step / reset 직후 |
| | `{"type":"status","state":"playing"|"paused"}`, `{"type":"error","message"}` |

## 제한 사항

- Newton은 `metersPerUnit ≠ 1` 스테이지를 공식 지원하지 않는다고 경고합니다. 리지드 바디는 스테이지 단위 그대로 일관되게 시뮬레이션되지만, 접촉 마진 같은 미터 기준 기본값은 스케일이 맞지 않을 수 있습니다.
- `load` 메시지에 `"solver":"mujoco"`를 보내면 `SolverMuJoCo`를 쓰지만, 이 경우 모든 조인트가 아티큘레이션에 속해야 합니다(뷰어는 항상 XPBD를 요청).
- 키네마틱 바디의 애니메이션 추종, 볼륨(TetMesh) · 커브 Deformable은 다루지 않습니다.
- 천 시뮬레이션은 셀프 충돌 때문에 리지드 바디만 있을 때보다 무겁습니다(샘플 기준 실시간의 약 85% 속도).
