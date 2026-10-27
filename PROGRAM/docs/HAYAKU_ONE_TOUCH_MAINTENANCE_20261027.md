# HAYAKU 상태 점검 및 자동 복구

## 구현 결과

`HAYAKU_Locator_Continuity.js`의 구간 점검·복구 화면에 **상태 점검 및 자동 복구** 버튼을 연결했다. `plugin_only`와 `server_only`에서 같은 제어기를 사용한다. 저장 위치 이전 중인 상태와 기존 `mirror` 상태는 이전을 완료한 뒤 실행하도록 보류한다.

버튼 한 번으로 읽기 검사와 기존 패킷의 결속 복구를 진행한다. 기억 생성이 필요할 때만 같은 작업창에서 대상 턴·기본 호출·최대 호출을 확인하고 계속한다. 이 확인은 실제 Provider 비용이 발생하는 분석에만 적용된다. 별도의 수동 턴 선택이나 콜드스타트 화면 이동은 필요 없다.

| 연결 | 실제 동작 | 확인되는 결과 |
|---|---|---|
| GUI/API → 현재 범위 | 채팅 ID, 페르소나, 분기 근거, 원문, 저장 모드와 authority fence 확인 | 다른 채팅·경로의 실행 계획 사용 거부 |
| 읽기 검사 → 정본 | 현재 경로의 원장, raw 참조, 공유 아카이브, 복구 Vault 인덱스·샤드를 직접 읽고 재조회 | 읽기 실패나 손상을 빈 기록으로 판정하지 않음 |
| 원문 → 패킷 검사 | 기존 canonical topology와 exact completed-turn coverage 사용 | 완료된 U+A 중 패킷 누락·현재 턴 결속·사용자 제외를 구분 |
| 패킷 → 결속 복구 | 기존 topology reconciliation에 강제 결속 검증을 연결 | 토폴로지 hash가 같아도 손상된 슬롯 head 복구, 모델 0회 |
| 빈 기록 → 콜드스타트 | 기존 native cold-start 엔진과 체크포인트 재사용 | 완료 턴별 기록, 검증된 결과를 원장에 채택 |
| 사용 중 누락 → 복구 | exact missing rows를 기존 selected-missing batch에 전달 | 이미 저장된 턴을 재생성하지 않고 누락만 분석 |
| 저장 → 최종 판정 | 같은 경로의 자료를 새로 읽어 coverage와 결속 재검증 | 미완료·부분 성공·검증 불명은 완료로 표시하지 않음 |
| 작업 → 화면 | 기존 HAYAKU native job 팝업 재사용 | 단계·대상·경과 시간·실제 모델 호출·결과, 최소화·재열기·중단 |

기존 캐시 전용 adapter/API의 좁은 계약은 유지했다. UI에서는 고급 메시지 캐시 도구로 분리했다. 공통 SDK·서버 프로토콜 변경은 없다.

## 보존과 실행 범위

- 채팅 원문과 기존 패킷 본문을 새 분석 결과로 임의 교체하지 않는다. 사용자가 제외한 턴도 자동 복원하지 않는다.
- 저장된 턴의 원문 수정은 기존 명시적 재분석 경로를 유지한다. 수동 점검이 자동 재분석 동의를 대신하지 않는다.
- 검사 단계는 copy adoption, debt enrollment, migration을 실행하지 않는다. 공유 아카이브의 hydrated cache만 보고 정상으로 확정하지 않는다.
- 실제 복구 중에도 owner 읽기를 검사에서 확인한 경로에 묶는다. 서버에 없는 행을 보관된 로컬 자료로 암묵적으로 채우지 않는다.
- 원문·페르소나·설정·저장 자료의 변경, 저장 모드의 ABA 변경, 활성 복구 lease, 중복 실행은 분석 전 거부한다. 기존 엔진의 분석·채택 시 원문 확인과 저장 readback도 유지한다.
- 저장 실패·취소·분석 실패는 남은 대상을 보존해 다음 수동 실행에서 확인할 수 있게 한다. 새로운 백그라운드 유료 자동 실행이나 무한 재시도는 추가하지 않았다.

## API

```js
await HAYAKU.recovery.maintenance.inspect();
await HAYAKU.recovery.maintenance.run();
// 모델 분석을 명시적으로 허용한 호출자만 사용:
await HAYAKU.recovery.maintenance.run({allowModel: true});
```

`inspect()`의 `complete`는 검사 자료의 읽기·대조 완료를 뜻한다. 정상 여부는 `status: 'healthy'`로 판단한다. `mode`, `coveredTurns`, `targetTurns`, `userSuppressedTurns`, `needsBinding`, `bindingChecks`를 함께 제공한다. 검사 실패는 `known:false`, `complete:false`, `status:'unverified'`다.

`run()`은 `before`, `after`, `binding`, `analysis`, `physicalCalls`, `status`를 반환한다. 분석 허용이 없으면 결속 복구 후 `needs_confirmation`으로 종료하며 모델 호출은 하지 않는다. GUI는 `confirmAnalysis` callback을 통해 같은 작업창에서 비용과 대상을 보여준다.

## 실행 증거

최종 HAYAKU 소스: SHA-256 `e58010d9be6eb310a9392fa777224f42f6c575761d213ddbb1ccb283846cd8b3`, 4,153,766 bytes. 버전 번호는 3.3.8을 유지했다.

- 신규 유지보수 회귀 **21/21 PASS**: `hayaku_maintenance_runtime_test.cjs` 12건, `hayaku_maintenance_server_gui_test.cjs` 9건.
- 읽기 순수성, 결속만 복구/정상 재실행 0호출, 누락만 분석, 콜드스타트, 원문·페르소나 변경, 활성 lease, 저장 실패, 취소, 부분 성공, 사용자 제외, 수정된 기존 기억 보존, 손상된 공유 아카이브와 캐시를 검증했다.
- 서버 검증은 실제 서버 request handler와 임시 SQLite를 사용했다. 실제 네트워크 대신 프로세스 내 전달을 사용하고, 모델은 합성 응답이다. SQLite 정본 재조회와 새 플러그인 런타임 재시작 후 정상 상태를 확인했다.
- 서버 정본 부재 시 보관된 유효 로컬 원장을 재승격하지 않는 것, 서버 접속 실패, 모드 ABA 변경을 검증했다.
- 제품 source가 만든 DOM에서 실제 버튼과 팝업을 실행했다. 읽기 전용 버튼, 분석 확인, 최소화·재열기, 확인 도중 화면 닫기까지 검증했다.
- 관련 선별 회귀 **102 PASS**: 일반 실행·복구, exact source coverage, cold-start identity, 기존 패킷 보존, 명시적 취소, 원문 재분석 GUI, 삭제·복원, 기존 health adapter 계약 등의 58개 항목과, 물리적 원장 readset·재분석 저장 회귀 44개 항목이다. 샌드박스 임시 파일 교체 `EPERM` 44건은 일반 권한으로 재실행해 모두 통과했다.
- 기존 `hayaku_native_cold_start_contract_test.cjs:55`는 `failedStatus.failedAnalysis.summaries` 접근에서 실패한다. 같은 테스트를 Git HEAD `ec347a2b98a90de8f0339043277bb3b1bbb54b4c` 원본에 실행해 동일한 실패를 확인했다. 이번 패치의 회귀로 계산하거나 테스트를 약화하지 않았다.
- 로컬 Chromium에서 제품 DOM을 1100×850, 390×844로 렌더링했다. 분석 확인·실행 중·완료의 6개 화면에 수평 넘침이 없고, 단계 표시가 갱신되며 모바일 하단 버튼까지 스크롤로 접근함을 측정·육안 확인했다.

실행 로그, 제품 DOM HTML, PNG와 측정 파일:

`C:\Users\rusin\.codex\visualizations\2026\10\27\01a17bb3-67e8-7962-9d63-57220ede84bf\hayaku-maintenance\`

전체 CJS 릴리즈 회귀는 실행하지 않았다. 실제 RisuAI 재등록·GUI, 실제 Provider·과금·디바이스 성능은 NOT_RUN이다. 위 증거는 그 검증을 대신하지 않는다. 앞선 Flashback 작업의 기존 별도 실패·LIBRA SDK 불일치 역시 전체 릴리즈 통과로 바꾸어 주장하지 않는다.

사용자 DATA와 기존 Flashback 변경은 보존했다. 적용하려면 RisuAI에서 수정된 `PROGRAM/plugins/HAYAKU_Locator_Continuity.js`를 재등록·재로드한다.
