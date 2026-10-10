# HAYAKU 3.0.43 · 전달본 채택 시 저널 보완

Memory Suite 0.3.18 / Book UX V5.15 전달본을 검토하면서 HAYAKU 3.0.42의 지연 저장 확인 저널에서 추가 결함을 확인했다. LIBRA 2.3.25, Flashback 1.0.26, LIA 0.26.62, RE:TRACE 1.9.66 및 Book UX 변경은 전달본을 그대로 유지한다. System 버전은 0.3.18이며 HAYAKU만 3.0.43으로 올렸다. MEMORY_SUITE_V515_INTEGRITY_PATCH.md는 원래 전달본의 이력을 설명한다.

저널의 첫 읽기가 거절되거나 시간 초과이면 이를 빈 저널로 캐시하여 다음 upsert가 이전 미확정 항목을 덮어썼다. 또한 항목 제거의 저장 또는 readback 실패 뒤에도 제거된 캐시를 사용하여 다음 추가에서 기존 항목이 사라질 수 있었다.

수정 후 확인되지 않은 읽기는 HAYAKU_STORAGE_RECONCILIATION_JOURNAL_READ_UNCONFIRMED로 중단하며 저장을 호출하지 않는다. 저널 쓰기는 정확한 물리 readback이 확인된 경우에만 캐시로 채택한다. 실패하거나 확인되지 않으면 캐시를 무효화하여 다음 변경 전에 실제 저널을 다시 읽는다. 원장·패킷·LLM 호출 경로와 저널 schema는 변경하지 않는다.

hayaku_storage_reconciliation_journal_fault_test.cjs는 실제 소스의 저널 함수를 사용해 첫/강제 읽기 거절 및 시간 초과, 쓰기 거절, no-op 쓰기, readback 거절 및 시간 초과 이후 기존 물리 항목 보존과 재조회를 검증한다. 외부 RisuAI 또는 LLM 실서비스 시험이 아니다.
