# LIB 플러그인 역할과 저장소 설계 결정

## 현재 RUN 통합 상태 · 2026-10-08

현재 통합 실행 후보는 RUN/LIB이며 WM을 포함한 7개 플러그인 구성을 사용합니다. 아래 2026-10-07의 여섯 플러그인 기반·WM 분리 설명과 검증 표는 그 시점의 설계와 이력입니다. 원본 projects/LIB, 이전 동결 checkpoint와 백업은 변경하지 않습니다.

- LIBRA 현재 실행: Librarian의 완료된 5 U+A 기억 분석, Classic 원문 근거 전달
- 이번 cleanup: Planner·SGA·LIBRA 내장 GRADIA 응답 선택 인자, 미사용 family-switch/draft GUI 보조 코드, 잘못된 현재 실행 광고 제거
- 유지: Classic 메모리 동작, 구형 중복 주입 marker, memory-only Prompt Studio 가져오기 차단, planner-narrative-direction 저장 key와 API, 별도 GRADIA의 읽기 전용 LIB 연결, 구형 사용자 저장 바이트
- schema/transfer metadata의 Planner·SGA 명칭은 옛 자료의 복원·호환 descriptor입니다. 현재 사용 가능한 응답 경로나 활성 분석기 광고가 아닙니다. 이번 exact patch 통합에서 그 descriptor를 삭제하거나 과거 자료를 이관하지 않습니다.
- 승인된 같은 소스 입력의 Full/Min 결과를 별도 프로필로 재사용합니다. 다른 6개 플러그인과 WM 생성물을 재빌드하지 않습니다. B1 이후 WM 소스와 기존 생성물의 차이는 현재 상태로 보존합니다.
- 한정 source/metadata/default-Classic 검증과 전체 제품 출시 자격은 별개입니다. 실호스트·전체 회귀·후속 WM 통합과 배포 gate는 완료로 표시하지 않습니다.

기준: 2026-10-07 14:55 UTC / 23:55 KST. 이 문서는 최근 사용자 결정을 정리한 현재 설계 정본입니다. 승인된 방향, 구현 중인 후보, 기본 검증을 마친 범위, 아직 확인하지 못한 범위를 구분합니다. 문서 갱신 자체는 제품 코드 적용이나 출시 승인을 뜻하지 않습니다.

## 1 결정과 구현 상태

| 항목 | 승인된 방향 | 진행 중 또는 미적용 | 완료 확인 범위 | 미확인 또는 후속 검증 |
|---|---|---|---|---|
| LIB와 GRADIA 구조 | 한 LIB 프로젝트의 여섯 번째 플러그인으로 관리 | 최신 LIB 공통 정책 r2 미적용 | 6-plugin 통합과 아래 기본 검증 | r2 독립 검토는 실행 차단, 통합 전체 출시 미승인 |
| 핵심 기억 플러그인 | 세 핵심 owner의 기존 저장 모드 유지 | 최신 공통 정책 r2는 미적용 | 활성 writer 3개·legacy namespace 5개 적용 | 실환경·전체 저장소 자격 검증 |
| LIA 저장 | 로컬 저장·호스트 Persona·asset·인계 유지 | 실제 사용자 legacy 복구는 미실행 | local_only·명시적 비변경 검사/검증 후 복구 경로 적용 | 실제 호스트·장시간 안정화 |
| LIA 읽기 비용 | 요청/UI 단위 현재 context 재사용 | 실제 호스트 지연 미측정 | 같은 fake-host fixture 12→4, 46→7, 추가 picker 5→0 | 실환경 성능으로 일반화하지 않음 |
| RETRACE 역할 | 다음 세션 인계·서버 관리실 유지 | 광범위 권한 qualification 후속 | manager_only·자체 writer/proxy/자동 이관 퇴역 적용, 혼합 8조합 | 실환경·전체 안정화 |
| GRADIA 설정 백업 | 기존 자체 설정 백업 개선 | 원자적 외부 raw CAS 보장 없음 | 비밀값 제외·전체 검증 후 GUI 변경·실패 복원·이름/본문 보존 | 실제 호스트 저장 불확실성 |
| GRADIA 창작 지침 | 활성 OOC·전역 customPrompt 유지 | 구형 사용자 기록은 보존 | Writer/Arc/Archive/session-transfer 코드/API 제거, OOC 기본 확인 | 실제 호스트·공급자 |
| WM 기능 우선 | 기존 승인된 공통 프리셋·빠른 선택·정제 로그 우선 | Task5 별도 미검토 후보 | 공통 AI r2의 한정 승인 | 성능 조사·최적화 보류, 기존 실패 유지 |

‘완료 확인’은 그 셀에 적힌 범위에만 적용합니다. 새 후보가 존재하거나 일부 기본 검사를 통과해도 주 작업본 적용·독립 승인·전체 제품 완료로 확대하지 않습니다.

## 2 하나의 LIB 프로젝트에서 여섯 플러그인 관리

현재 주 작업본은 `/workspace/scratch/d09f18a13aaa/projects/LIB`입니다. GRADIA는 별도 형제 제품 트리로 개발하지 않고 `PROGRAM/plugins/GRADIA.js`로 함께 관리합니다.

- 플러그인: `PROGRAM/plugins/`의 LIBRA, HAYAKU, Flashback, LIA, RE:TRACE, GRADIA
- 공통 SDK와 GRADIA helper: `PROGRAM/sdk/`
- GRADIA 테스트와 fixture: `PROGRAM/tests/gradia/`
- fixture의 외부 소스 라이선스: `PROGRAM/tests/gradia/fixtures/vendor/risuai/LICENSE`
- 통합 설계·출처·미적용 r2 자료: `PROGRAM/docs/gradia/`
- 현재 역할·저장소 결정: 이 문서 `PROGRAM/docs/PLUGIN-ROLE-AND-STORAGE-DESIGN-20261007.md`
- Full/Min, 실행 증거와 출처: `.development/build/`, `.development/evidence/`, `.development/provenance/`

기존 원본·동결 checkpoint·백업은 보존합니다. WM은 이 LIB 프로젝트에 포함하지 않습니다. 최신 공통 정책 r2를 반영할 때는 누적 delta와 전문화된 SDK 경계를 확인하며, 플러그인 전체 덮어쓰기로 GRADIA 어댑터 변경을 없애지 않습니다.

기본 통합 증거는 [현재 상태](../../.development/STATUS.json)에 있습니다.

| 검사 | 확인한 결과 |
|---|---|
| 등록·metadata·경로 | 5/5 |
| GRADIA 설정/OOC/퇴역 보존 | 최종 source·Full 11/11, Min 10+source-only 1 skip |
| Full/Min 생성·구문·공개 API·directive | 각각 여섯 플러그인 |
| package/layout/manifest 최종 계약 | STATUS.json에 최종 결과 기록 |
| reader/native/draft | 29/29·42/42, 마지막 설정 이름 처리 변경 전 한정 결과 |

이 결과는 `composed-r1`에 승인된 LIA/RETRACE 역할 delta와 GRADIA 설정·퇴역 변경을 합친 기반입니다. 초기 265건은 이전 통합 시점 기록입니다. 최신 공통 정책 r2의 독립 실행 검토는 차단됐고 주 작업본에는 적용하지 않았습니다. 실제 서버 binding, RisuAI·Windows·공급자 실환경, 성능·용량, 전체 release gate와 배포는 별도 미완료 범위입니다.

## 3 저장 owner와 관리 권한을 구분

핵심 기억 저장 owner는 **LIBRA·HAYAKU·Flashback 세 개를 유지**하는 것이 승인된 목표입니다. 이 세 플러그인의 서버 저장, plugin_only/server_only를 포함한 기존 모드와 이관 기능은 제거하지 않습니다.

현재 통합본에 활성 writer 세 개와 legacy namespace 다섯 개의 구분을 적용했습니다. LIA는 `legacy_reader`이며 `lia`만 읽고 쓰기 권한은 없습니다. RETRACE는 `manager_only`로 관리·legacy 읽기를 유지하며 자체 일반 쓰기 권한은 없습니다. 새 LIA/RETRACE live DB를 만들지 않고 과거 DATA·백업 호환 슬롯은 보존합니다.

GRADIA는 제한된 읽기 전용 경로를 사용합니다. 통합만을 이유로 새 서버 writer, DATA namespace, 자격 증명을 추가하지 않습니다.

## 4 LIA 로컬 중심 저장과 인계 보존

사용자 13:12 UTC 결정은 LIA의 **서버 모드를 퇴역시키되 LIA 기능과 자체 로컬 저장을 유지**하는 것입니다. 로컬은 여기서 LIB 서버와 구분되는 기존 pluginStorage·기기 저장소를 뜻합니다. RisuAI 자체 동기화를 끈다는 뜻이 아닙니다.

- LIA 자체 설정·보관함·바인딩 관련 상태는 승인된 로컬 경로로 유지합니다.
- 실제 Persona 객체·채팅 바인딩·원본 이미지 asset은 기존 RisuAI 호스트 저장소와 API를 유지합니다.
- RETRACE의 LIA Persona 다음 세션 인계와 필요한 증명은 유지합니다. 서버 저장 참여 제외를 Persona 인계 제외로 구현하지 않습니다.
- 기존 서버 자료를 자동 삭제하거나 비우지 않습니다. 서버 모드 퇴역만으로 기존 서버 데이터가 없어지지 않습니다.
- legacy 서버 복구는 사용자가 명시적으로 요청한 경로에서만 수행합니다. 서버 읽기는 비변경 방식으로 하고, 복구할 전체 내용을 검증한 뒤 로컬에 씁니다.
- 로컬 충돌을 조용히 덮어쓰거나 일부만 읽은 내용을 성공한 복구로 처리하지 않습니다. 검증 실패·충돌은 분명하게 알립니다.

기존 구현의 정확한 데이터별 경로는 [LIA 저장 모드 감사](../../../../docs/LIA-STORAGE-MODE-MATRIX-20261007.md)에 있습니다. 이 감사는 퇴역 전 소스를 설명하므로 앞으로의 로컬 전용 설계를 이미 구현한 증거로 읽지 않습니다.

정확한 감사 위치:
`/workspace/scratch/d09f18a13aaa/docs/LIA-STORAGE-MODE-MATRIX-20261007.md`

### 반복 읽기 개선 범위

사용자 13:29 UTC 승인에 따라 요청 또는 UI 동작 안에서 이미 읽은 최신 context를 재사용하여 바인딩·감정 이미지 경로의 중복 읽기를 줄입니다. 서로 다른 채팅까지 오래된 context를 공유하지 않으며, 저장 직전 충돌 검사와 저장 후 readback을 없애지 않습니다.

[LIA 읽기 감사 원문](/workspace/shared/lia-local-retirement-20261007T1322Z/LIB/PROGRAM/docs/LIA-CHAT-READ-AUDIT-20261007.md)의 작은 오프라인 fake-host fixture 기준:

| 기존 경로 | 호스트 API 호출 수 | 해석 범위 |
|---|---|---|
| 감정 이미지 사용·비어 있지 않은 catalog의 적격 응답 | 12 | 해당 fixture의 한 응답 |
| managed binding·비어 있지 않은 catalog의 getContext | 46 | 해당 fixture의 한 UI context 읽기 |
| 별도 module picker context | 5 | 위 46과 구분한 추가 단계 |
| 예열된 첨부 비활성 경로 | 0 | cold-start까지 일반화하지 않음 |
| 예열된 빈 catalog 경로 | 0 | 비어 있지 않은 catalog까지 일반화하지 않음 |

46과 5는 그 fixture에서 합계 51이지만 모든 UI 클릭의 고정 비용은 아닙니다. 실제 호스트 IPC 직렬화·기기 메모리·체감 지연은 측정하지 않았고, 이 수치를 성능 개선 결과로 표시하지 않습니다. 현재 일반 Live Persona 자동 추적은 이미 비활성 경로이며, 독립 감정 이미지 afterRequest hook은 남아 있습니다.

정확한 최신 감사 위치:
`/workspace/shared/lia-local-retirement-20261007T1322Z/LIB/PROGRAM/docs/LIA-CHAT-READ-AUDIT-20261007.md`

## 5 RETRACE는 다음 세션 인계와 서버 관리실 담당

RETRACE는 기존 LIB 5-plugin 구성의 다음 세션 인계와 서버 관리실을 유지합니다. 구형 backup catalog·viewer·writer·삭제 API와 그 전용 코드를 퇴역시킵니다. 기존 사용자 백업 바이트의 삭제를 뜻하지 않습니다.

격리 후보의 승인된 31개 소유 파일을 주 작업본에 적용했습니다. `.development/retrace-lia-ownership-merge.json`에 원본/결과 해시를 기록했습니다. 혼합 저장 모드 8조합·target preparation 32건과 실제 4-owner GUI 인계 기본 검사를 확인했으며 전체 검증 승인은 아닙니다. 초기의 보호 없는 검사에서 알려지지 않은 updater GET 시도가 기록된 이력도 지우지 않습니다. 이후 검사는 고정 network guard·source audit와 알려진 updater GET의 로컬 대체를 사용한 한정 결과로 구분합니다.

사용자 13:14~13:15 UTC 결정에 따른 자체 저장 역할:

- 서버 관리 접근은 유지합니다. 관리자가 다른 owner의 상태를 보고 명시적 관리 작업을 하는 권한과 RETRACE 자체 일반 writer 권한을 구분합니다.
- RETRACE 자체 일반 서버 쓰기, scoped proxy, 자동 업로드·자동 이관을 퇴역시킵니다.
- 인계나 기존 데이터 호환성에 필요한 legacy 읽기는 비변경 방식으로 보존합니다.
- 기존 서버 DATA를 지우지 않습니다. 기존 namespace를 목록에서 알아보는 기능과 새 일반 쓰기를 허용하는 기능은 분리합니다.
- 로컬 host의 인계 저널 등 필요한 상태는 보존합니다. 서버 저장 퇴역이 모든 로컬 상태 제거를 뜻하지 않습니다.

설계 근거: [표면 제거 계획](/workspace/shared/lib-retrace-retirement-20261007T1257Z/reports/retirement-plan.md), [자체 서버 저장 역할 변경 계획](/workspace/shared/lib-retrace-retirement-20261007T1257Z/reports/own-storage-retirement-plan.md).

### 혼합 저장 모드에서도 다음 세션 인계

사용자 13:18 UTC 결정에 따라 LIBRA·HAYAKU·Flashback이 서로 다른 저장 모드를 사용하고 LIA가 로컬 전용이어도 인계가 동작해야 합니다.

1. 인계 admission·읽기·쓰기·readback은 owner별 유효 모드와 대상 scope를 따릅니다.
2. 대상의 저장 모드를 한 전역 값으로 강제하지 않습니다. 서버 owner 검사는 세 핵심 owner를 대상으로 하고, LIA의 로컬 Persona 인계 증명은 별도로 유지합니다.
3. 어느 owner에서든 필요한 저장이나 readback이 실패하면 해당 실패를 명시합니다. 부분 성공을 전체 성공으로 포장하지 않습니다.
4. 원본 보존과 현재성·충돌 방어를 유지합니다. 다음 세션으로 넘긴다는 이유로 원본을 지우지 않습니다.

GRADIA는 이 다음 세션 인계의 새 대상으로 추가하지 않습니다.

## 6 GRADIA 설정 백업과 활성 창작 지침

### 기존 자체 설정 백업을 개선

GRADIA의 기존 내보내기·가져오기는 runtime, provider presets, agent slots, promptOverrides를 다룹니다. 같은 전역 설정은 새 채팅에서도 사용되므로 이를 이어가기 위해 RETRACE에 새 인계 등록을 만들 필요가 없습니다.

승인된 개선은 다음과 같습니다.

- 백업에서 credential 필드·인증 header·URL 인증 정보를 제외합니다. secret 같은 단어가 포함된 정상 프리셋 이름과 사용자 프롬프트 텍스트는 유지합니다.
- 가져올 전체 구조와 참조를 검증한 뒤 GUI 상태를 변경합니다. 앞부분을 먼저 덮어쓴 다음 오류를 내는 부분 적용을 피합니다.
- 저장 실패 시 이전 설정과 복구 가능한 상태를 보존하고 실패를 표시합니다.
- GRADIA 자체 전역 설정 백업 범위에서 구현합니다. 새 서버 writer나 RETRACE 인계 owner는 만들지 않습니다.

현재 구현과 검사는 [기능 구현 결과](gradia/FEATURE-IMPLEMENTATION-20261007.md)에 정리했습니다. 소스 확인점은 [GRADIA.js](../plugins/GRADIA.js)의 `cleanSettingsBackup`, `exportConfiguration`, `applyImportedConfiguration`, `saveImportedGuiState`입니다.

### 활성 OOC와 퇴역 코드의 경계

현재 창작 지침 OOC는 AI와 대화하고 대상 기본 단계를 선택하여 그 단계의 전역 `customPrompt`를 생성·편집하는 활성 기능입니다. 이 지침은 실제 기본 단계 실행에서 사용됩니다. 기존 API의 `replace`라는 명칭은 사용자 창작 지침을 나타내며 내장 프롬프트 구조 전체 교체를 뜻하지 않습니다.

구형 Writer·Story Arc·Narrative Archive·session-transfer 코드와 API 제거를 완료했습니다. 37개 공개 API와 관련 320개 선언을 없앴고 자동 인계 채택/RETRACE 등록을 제거했습니다. 기존 사용자 저장 기록은 지우지 않으며, 이전 수동 창작 지침의 한정 복구 읽기만 현재 전역 promptOverrides 보존을 위해 남겼습니다. 활성 OOC 대화·지침 정리·저장을 실제 공개 API 기본 검사로 확인했습니다.

## 7 작업 우선순위와 남은 검증

- 사용자 13:05 UTC: LIB는 기능 구현을 먼저 진행하고 추가 안정화·버그 정리·성능 작업은 후속으로 둡니다. 각 기능의 기본 검사는 수행하고 알려진 실패를 기록합니다.
- 사용자 13:02 UTC: WM 성능 원인 조사·최적화는 보류합니다. 승인된 공통 프리셋·빠른 선택·정제 로그 기능을 우선합니다.
- WM 현재 기능 후보: `/workspace/scratch/d09f18a13aaa/wm-common-ai-presets-task5-20261007T1323Z`. 미검토 작업본입니다.
- WM 승인된 기준: `/workspace/scratch/d09f18a13aaa/wm-common-ai-review-fix-r2-20261007T1153Z/checkpoints/WM-Common-AI-Review-Fix-r2-20261007T120523Z`.
- WM original97 Full의 latency·settled-heap 두 실패는 남아 있습니다. 기능 검사 통과를 성능 통과나 실패 면제로 바꾸지 않습니다.

역할·저장 경로 적용과 한정 기능 검사를 마쳤습니다. 실제 서버 binding·호스트·플랫폼·공급자·성능·전체 릴리즈 검증은 별도로 남습니다. 사용자 지정 종료는 2026-10-07 17:00 UTC / 2026-10-08 02:00 KST이며 이후 명시적 요청 전 개발을 재개하지 않습니다.

13:38 최초 설계 문서는 읽기 전용 정리였고, 이 14:55 갱신은 이후 승인된 구현과 작성자 기본 실행 결과를 반영합니다. 원본·동결본·실제 사용자 DATA는 수정하지 않았습니다.
