# MemorySuite 0.3.32 / LIBRA 2.3.39 — 6차 구현 범위

2026-09-07 KST. 기준은 5차 합본 0.3.31 / LIBRA 2.3.38이다.
이 문서는 구현한 계약과 지원 한계를 설명한다. 최종 배포 hash, 전체 실행 결과와 최초 실패 기록은 외부 `MEMORY_SUITE_IMPLEMENTATION_06_REPORT_KO.md` 및 evidence ZIP에 둔다.

## 책임과 유지 조건

승인된 특정 5 U+A source evidence → 마지막 유효 finalArtifact → 구간당 활성 정본 하나 → 읽기/리콜/현재 Head 계약을 보존한다.
상태/identity 교정은 원문·정본을 덮지 않으며 기존 Correction Journal을 사용한다. 새 관계/서사/상태 역사 DB를 만들지 않는다.
기본 legacy, 사용자 Provider/프로필, 수동 cold start, 원문 수정의 비교·선택·명시 동의, 실패 시 기존 데이터 보존을 유지한다.
정상 통합 분석에 Observer나 별도 세계 LLM을 추가하지 않는다. 상태 재생·인물 분리·보관 정리의 추가 모델 호출은 0회다.

## 1. 인물 분리

월드 매니저 인물 상세에서 ‘인물 분리’와 ‘분리할 사실과 근거 확인’을 사용한다.
원래 하나로 잘못 해석된 person을 2–8명으로 분리한다. 이름과 별칭을 지정하고 모든 사실의 개별 역할을 직접 배정한 다음 저장한다.
동일 사실의 주체, 관계 상대, 소유자/소지자 같은 값 참조도 각각 선택한다. 근거와 시점을 보여 주고 역할은 24개씩 페이지로 표시한다.
미선택·중복 배정·빈 자녀·이름 충돌·오래된 preview는 저장할 수 없다. 임시 entity ID와 생성한 자녀 참조도 충돌하지 않는다.

`previewWorldManagerIdentitySplit({sourceId})`는 승인 원문 기반 replay에서 occurrenceId, origin, artifact digest, factId, path, 인용을 반환한다.
`splitWorldManagerIdentity({sourceId,previewDigest,targets,assignments})`가 그 검토를 다시 확인하고 기존 교정 저널을 통해 Head·Registry·typed 관계/세계/서사 참조를 함께 적용한다.
승인된 원본 artifact 자체는 바꾸지 않는다. 분리는 현재 anchor의 사용자 해석 교정이며 이전 정본의 사건 문장을 수정하는 기능이 아니다.
사용자가 저널에서 중지하면 원래 해석을 재생하고, 다시 활성화하면 검증된 분리를 재적용한다. 근거가 바뀌면 중지/보류한다.
이전의 모호한 결합 이름은 새 인물로 다시 만들지 않고 disambiguation 필요 상태로 남긴다. 다음 분석은 명확한 새 이름/별칭을 Registry와 결속한다.

지원 제한: 현재 활성 person, 검증 가능한 all-v4 역사, 최대 1,500개 역할. legacy 미해석 구간, 근거 없는 identity, 분배 후 새 충돌/미해결 참조, 불명확한 선행 교정은 임의 승인하지 않는다.
장소/조직 분할이나 텍스트의 이름 전역 치환 도구가 아니다. source/parent와 ancestor는 바꾸지 않는다. 분기점 이후 분리 교정은 이전 prefix에 상속하지 않는다.

## 2. 과거 v3 기억 선택 전환

기억 설정의 ‘과거 기억 선택 전환’에서 대상 구간을 명시 선택한다. 각 항목의 저장된 5 U+A 증거 전체를 확인할 수 있다.
`previewLegacyMemoryRebuild`, `getLegacyMemoryRebuildEvidence`, `rebuildSelectedLegacyMemories`는 scope/preview digest/선택 keys를 결속한다.
현재 대화의 승인된 원문 evidence가 온전하고 현재 원문과 비교가 맞는 구간만 활성화한다. 수정된 원문은 기존 source-edit review를 먼저 거쳐야 한다.
한 실행의 선택은 1–32구간이다. 모델 비용이 있는 재분석이며 기존 Ariadne/선택 ito·원문 승인·검증된 정본 활성화 경로를 쓴다.

예: T1–5와 T11–15만 v4로 바꾸고 T6–10 v3는 그대로 둘 수 있다. 이는 명시 선택 전환 표시가 있는 체인에서만 허용한다.
구형 빈 구간을 자동 분석하지 않으며 unknownIntervals/미해석 이력과 partial 최신성으로 표시한다. 이후 구간을 해석했다고 중간 구간의 상태를 안다고 표시하지 않는다.
남은 T6–10을 나중에 선택하면 그 한 구간만 재분석한다. 구형 정본 revision은 남고 새 활성 참조만 검증 후 교체한다.
실패한 구간은 기존 활성 정본을 보존한다. 선택되지 않은 본문이나 이전 벡터를 새 사실의 벡터로 가장하지 않는다. 전환된 정본의 embedding만 기존 파생 작업으로 처리한다.

상속 archive의 legacy를 target에서 직접 재작성하지 않는다. 원본 세션에서 전환하거나 적합한 별도 source-evidence 이전 작업이 필요하다.
임의 v4/v3 혼합 writer를 일반 개방한 것이 아니다. 모든 과거를 자동 모델 호출로 바꾸거나 v3 prose를 로컬 정규식으로 v4로 가장하지 않는다.

## 3. 보관 자료 수명과 보수적 수동 정리

기억 설정의 보관 자료 정리에서 `previewMemoryRetention()`을 호출하면 owner 저장키와 실제 참조를 on-demand로 조사한다.
ACTIVE/REFERENCED/PINNED/DORMANT/GC_ELIGIBLE을 구분하며 진행 중 work/transaction/journal 참조는 보호한다.
불명확한 schema도 기본 보호한다. 큰 저장소에서 20,000키/128MiB 검사 한도를 넘거나 읽기/참조 검사에 실패하면 삭제를 허용하지 않는다.
큰 작업은 yield하며 일반 응답·리콜·상태 갱신 경로에 전체 저장소 스캔을 추가하지 않았다.

이번 삭제 허용 대상은 **현재 scope의 생성 시각이 확인되고 7일 이상 지난 미참조 `libra.unified_basis_snapshot.v1` 임시 스냅샷뿐**이다. schema뿐 아니라 실제 `entity-registry:v2:unified-basis:` 키 계열과 필수 필드도 일치해야 하며, 영구 자료가 이 schema로 잘못 표기되어도 삭제하지 않는다.
`collectMemoryRetention({expectedScopeKey,previewDigest,selectedKeys})`는 1–64개의 명시 선택만 처리하고, 각 삭제 직전에 참조·내용·scope를 재확인하며 삭제 후 실제 readback을 한다.
새 참조가 생기거나 실행이 시작되거나 삭제가 실패하면 중지하고 남은 항목을 보존한다. 생성 시각이 없는 옛 pin은 만료로 추정하지 않는다.
**정본·원문 증거·교정·ancestor archive와 dormant branch 자료는 절대 삭제 후보가 아니다.** 전체 archive GC나 자동 저장소 청소 완료본이 아니다.

## 4. 서버 조건부 일괄 쓰기 기반

기존 `server/server.cjs`와 namespace별 SQLite 저장소에 `conditional-batch.v1`, `POST /v1/kv/batch`를 추가했다.
키별 revision/digest/exists/tombstone 조건, 읽기 전용 선행 조건, 변경/제거, 동일 transaction 내부 operation receipt를 처리한다.
동일 owner namespace의 다중 키와 영수증만 하나의 SQLite transaction이다. 읽은 뒤 비교하는 pluginStorage 흉내가 아니다.
실제 HTTP/SQLite, 두 서버 프로세스 동시 쓰기, SQL 중단과 SIGKILL 복구 검사를 제공한다.
자세한 계약: `SERVER_CONDITIONAL_BATCH_06.md`.

중요: 새 서버 API가 존재한다고 LIBRA unified의 모든 writer가 해당 API로 전환된 것은 아니다.
**LIBRA 통합 쓰기는 계속 plugin_only / 단일 owner다. server_only/mirror/여러 iframe·기기 unified writer 차단을 유지한다.**
공통 Storage SDK와 다른 네 플러그인을 불완전한 새 쓰기로 우회시키지 않았다.

## 5. WM 의미 평가 기반과 실호스트 한계

WM-01–16 합성 5턴 corpus와 실제 배포 LIBRA 파이프라인을 쓰는 `tools/evaluate_wm_semantics.cjs`를 제공한다.
기본 `--plan`은 모델 호출 0회다. 명시적 `--live`, 모델/endpoint/API key 환경변수, 총 요청 예산이 있을 때만 실제 외부 모델에 호출한다.
A/B/C는 통합 1회 / 선택 ito / 전체 ito이며 같은 원문·이전 상태·자료 조건을 사용한다. rubric은 모델에게 보내지 않는다.
현재 평가 실행기는 빈 이전 상태·빈 참조 자료 표본을 지원한다. 다양한 과거 상태/커스텀 자료 조합의 실모델 평가를 모두 대체하지 않는다.
정확한 인용·JSON 검증은 의미적 진실성 판정이 아니다. 사람의 누락/과잉/주체/지식/시점 평가가 없으면 semantic pass나 기본 전환 자격을 만들지 않는다.
이번 제품 프롬프트에는 fictional world와 host worldline, unknown/false, 장소/조직, 조건부 예외의 경계를 명시했으나 실측 품질 향상을 주장하지 않는다.

공급된 실제 RisuAI 2026.8.250 소스의 plugin API를 확인하고 의존성 설치를 시도했다. registry.npmjs.org DNS `EAI_AGAIN`으로 설치가 중단되어 실제 앱/iframe/IPC 시험은 수행하지 못했다.
Chromium 검사는 실제 배포 JS·실제 화면을 쓰지만 host/Provider/storage 외부 경계는 합성이다. 외부 모델 A/B/C는 이번 작업에서 실행하지 않았다.
실제 설치/모델 시험 계약은 `HOST_MODEL_VALIDATION_06.md`를 따른다. 기본 legacy를 유지한다.

## 6. 화면과 배포 보존

분리/선택 전환/정리 화면의 검토 입력은 같은 scope의 후처리 화면 갱신에서도 유지한다. 캐시는 최대 세 폼이며 다른 scope 또는 GUI 닫기에서는 폐기한다. 저장 직전의 preview/grant 검증은 계속 수행한다.
관계 선택 목록의 부제를 자연어 정의로 표시한다. raw typed object를 본문처럼 stringify하지 않는다.
기존 BOOK_UX, GRADIA 문장 patch, Provider/Input Writer, source-edit SDK, HAYAKU/Flashback/LIA/RE:TRACE 본체를 보존한다.
기존 DATA는 반드시 유지한다. 새 DATA는 빈 설치 틀이며 기존 DATA에 덮어쓸 수 없다.
