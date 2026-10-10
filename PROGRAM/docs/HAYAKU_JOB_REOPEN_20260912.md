# HAYAKU 3.0.82 — 최소화 작업창 다시 열기

기존 viewerRenderNativeJob은 hayakuWorkDashboard 노드가 존재하면 작업 재열기 버튼을 숨겼다. 새 관제 GUI에서는 해당 대시보드가 보이지 않는 영역에 남아 있어 최소화 후 재진입 경로가 사라졌다.

대시보드 존재 여부와 무관하게 최소화 상태에서 재열기 버튼을 표시하도록 수정했다. 버튼을 헤더에서 독립시켜 GUI 우측 하단에 배치하고 관제실 색상, 작은 사각 버튼, 진행 수 표시를 적용했다. 최소화 상태에서만 나타나며 열면 숨겨진다. 완료 작업도 기록이 남아 있는 동안 다시 볼 수 있다. 작업이 없으면 버튼과 오버레이 모두 숨긴다. 독립 확인 대화상자와 취소·작업 실행 로직은 변경하지 않았다.

실제 표시 로직과 이벤트 핸들러를 이용한 가상 작업에서 브라우저 스크린샷 및 재열기→재최소화를 확인했다. 실제 AI 작업/RisuAI 호스트 재검증은 수행하지 않았다.

hayaku_minimized_job_reopen_runtime_test 및 관련 테스트 파일 총 6개 통과. SDK 동기화 및 GUI 검사 통과. 미리보기는 작업공간 design_samples/continuity-recall/implemented/hayaku-minimized-job.html, 백업은 _backups/hayaku-job-reopen-20260912/에 있다.
