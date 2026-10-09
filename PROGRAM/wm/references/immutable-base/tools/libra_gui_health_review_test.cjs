const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fullDistPath = path.join(root, 'dist', 'LIBRA World Manager Full.js');
const compactDistPath = path.join(root, 'dist', 'LIBRA World Manager.js');
const full = fs.readFileSync(fullDistPath, 'utf8');
const compact = fs.readFileSync(compactDistPath, 'utf8');
const sourceGui = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^15(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(root, 'src', 'parts', name), 'utf8'))
  .join('');
const scanner = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^09(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(root, 'src', 'parts', name), 'utf8'))
  .join('\n');
const dashboard = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^02(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(root, 'src', 'parts', name), 'utf8'))
  .join('');
const coldStart = fs.readdirSync(path.join(root, 'src', 'parts'))
  .filter(name => /^04(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(root, 'src', 'parts', name), 'utf8'))
  .join('');

const assertions = [];
const assert = (name, ok, detail = null) => {
  assertions.push({ name, ok: !!ok, detail });
  if (!ok) process.exitCode = 1;
};

const hasEverywhere = (needle) => full.includes(needle) && compact.includes(needle);
const snapshotSyncBody = sourceGui.match(/const syncGuiSnapshotsFromRuntime = \(verifiedLore = null\) => \{([\s\S]*?)\n\s*\};/)?.[1] || '';

assert('gui_health_summary_container_built', hasEverywhere('id="health-summary"'));
assert('gui_quarantine_panel_built', hasEverywhere('id="health-quarantine-list"'));
assert('gui_conflict_panel_built', hasEverywhere('id="health-conflict-list"'));
assert('gui_integrity_panel_built', hasEverywhere('id="health-integrity-list"'));
assert('gui_scan_button_bound', sourceGui.includes("btn-health-scan") && sourceGui.includes('IntegrityScanner.scanBatch') && sourceGui.includes("runHealthReviewAction('scan')"));
assert('gui_quarantine_actions_bound', sourceGui.includes("data-health-action=\"${action}-resolve\"") && sourceGui.includes("data-health-action=\"${action}-accept\"") && sourceGui.includes('QuarantineManager.markStatus'));
assert('gui_quarantine_accept_merge_bound', sourceGui.includes('acceptQuarantineEntryFromGui') && sourceGui.includes('EntityAwareProcessor.applyExtractionsSync') && sourceGui.includes('QuarantineManager.prepareAcceptedPayload') && sourceGui.includes('ManagementReviewCore.commit'));
assert('gui_integrity_actions_bound', sourceGui.includes('IntegrityScanner.markFindingStatus'));
assert('gui_full_data_refresh_pipeline_centralized', sourceGui.includes('const renderAllGuiDataViews = () => {')
  && (sourceGui.match(/renderEnts\(\);\s*renderNarrative\(\);\s*renderWorld\(\);\s*renderWorldAdditional\(\);\s*filterMems\(\);/g) || []).length === 1);
assert('gui_repair_routes_to_world_correction', sourceGui.includes("data-health-action=\"repair-field\"") && sourceGui.includes("world-user-correction"));
assert('gui_card_hint_selector_is_valid', sourceGui.includes('.card-hint{') && !sourceGui.includes('.card-.hint{'));
assert('gui_close_supports_escape_and_backdrop', sourceGui.includes("event?.key !== 'Escape'") && sourceGui.includes("event.target === bodyWrap") && sourceGui.includes("removeEventListener('keydown', onGuiKeydown)"));
assert('scanner_finding_review_status_api', scanner.includes('markFindingStatus') && scanner.includes("status: ['open', 'reviewed', 'ignored', 'resolved', 'accepted']"));
assert('quarantine_accept_payload_api', scanner.includes('prepareAcceptedPayload') && scanner.includes('buildStoredPayload') && scanner.includes('__libraAcceptedFromQuarantine'));
// 팝업(lra-health 클래스)은 삭제되었다. 건강 요약은 이제 대시보드 상태로
// 기록되고 헤더 표시가 그것을 반영한다.
assert('dashboard_health_summary_recorded', dashboard.includes('healthSummary') && dashboard.includes('updateHealthSummary'));
assert('cold_start_confirmation_is_manager_level', coldStart.includes('requestColdStartApproval') && coldStart.includes('Utils.confirmEx') && coldStart.includes("reason: 'user_cancelled'"));
assert('cold_start_confirmation_shows_cost_scope', coldStart.includes('분석 대상 메시지') && coldStart.includes('현재 LIBRA 데이터 항목') && coldStart.includes('예상 LLM 호출'));
assert('periodic_cold_start_requires_confirmation', coldStart.includes("trigger === 'periodic'") && coldStart.includes('주기적 정본 보강 조건이 충족되었습니다.'));
assert('gui_uses_manager_confirmation_gate', sourceGui.includes("trigger: 'manual_gui'") && !sourceGui.includes('if (!confirm("현재 채팅방의 과거 내역을 분석하여 메모리를 재구축하시겠습니까?"))'));
assert('gui_narrative_inner_tabs_built', ['storylines', 'author', 'director'].every(name => hasEverywhere(`data-narrative-tab="${name}"`) && hasEverywhere(`data-narrative-pane="${name}"`)));
assert('gui_story_author_and_director_views_built', hasEverywhere('id="story-author-view"') && hasEverywhere('id="director-view"'));
assert('gui_narrative_inner_tabs_bound', sourceGui.includes('activateNarrativePane') && sourceGui.includes("button.dataset.narrativeTab") && sourceGui.includes("aria-selected"));
assert('gui_narrative_inspector_helpers_exported', sourceGui.includes('buildNarrativeInspectorSnapshot,') && sourceGui.includes('renderNarrativeInspectorHtml'));
assert('gui_planners_render_before_empty_storyline_return', sourceGui.indexOf('renderNarrativeOrchestration();') < sourceGui.indexOf("if (!storylines.length)"));
assert('gui_runtime_sync_rebuilds_effective_lore', snapshotSyncBody.includes('effectiveGuiLore =') && snapshotSyncBody.includes("_MEM = effectiveGuiLore.filter") && snapshotSyncBody.includes('buildNarrativeInspectorSnapshot(effectiveGuiLore'));
assert('gui_world_empty_state_clears_global_features', sourceGui.includes("emptyGlobalFeatures.innerHTML = '<span style=\"color:var(--text2)\">전역 세계 특성 없음</span>'"));
assert('gui_user_dlc_nested_tabs_built', hasEverywhere('data-wa-tab="user-dlc"') && ['world', 'entity'].every(name => hasEverywhere(`data-udlc-tab="${name}"`) && hasEverywhere(`data-udlc-pane="${name}"`)));
assert('gui_user_dlc_world_natural_language_editor_built', hasEverywhere('id="udlc-world-request"') && hasEverywhere('id="btn-analyze-user-dlc-world"') && hasEverywhere('data-udlc-world-example=') && sourceGui.includes('runUserDlcWorldAnalysisFromGui'));
assert('gui_user_dlc_character_only_target_hooks_built', hasEverywhere('id="user-dlc-entity-target-list"') && !hasEverywhere('id="user-dlc-relation-target-list"') && sourceGui.includes('UserDlcCore.listEntityTargets') && sourceGui.includes('UserDlcCore.listRelationTargets'));
assert('gui_user_dlc_target_lists_rebuild_from_effective_lore', sourceGui.includes('refreshUserDlcTargetLists') && sourceGui.includes('EntityManager.rebuildCache(targetLore)') && sourceGui.includes('listEntityTargets?.(targetLore)') && sourceGui.includes('listRelationTargets?.(targetLore)'));
assert('gui_user_dlc_target_lists_refresh_on_analysis_tab', sourceGui.includes("if (selected === 'entity') refreshUserDlcTargetLists") && hasEverywhere('id="btn-refresh-user-dlc-targets"') && sourceGui.includes('announce: true'));
assert('gui_user_dlc_character_selection_survives_refresh', sourceGui.includes('selectedEntityIds.has(String(item.id))'));
assert('gui_user_dlc_relations_are_automatic_context', sourceGui.includes('buildUserDlcRelatedRelationRecords') && sourceGui.includes('relationContextRecords') && sourceGui.includes('자동 참조 관계'));
assert('gui_user_dlc_entity_natural_language_analysis_built', hasEverywhere('id="udlc-entity-request"') && hasEverywhere('id="btn-analyze-user-dlc-entity"') && hasEverywhere('data-udlc-entity-example=') && sourceGui.includes('runUserDlcEntityAnalysisFromGui'));
assert('gui_user_dlc_world_hides_engineering_fields', ['udlc-world-kind', 'udlc-world-title', 'udlc-world-analysis-prompt', 'btn-register-user-dlc-world'].every(id => !hasEverywhere(`id="${id}"`)) && sourceGui.includes("const kind = 'auto'") && sourceGui.includes("const analysisPrompt = ''"));
assert('gui_user_dlc_entity_hides_prompt_and_tracker_schema_fields', ['udlc-entity-prompt', 'udlc-analysis-label', 'udlc-analysis-content', 'udlc-tracker-label', 'udlc-tracker-values', 'udlc-tracker-update-mode', 'udlc-tracker-instruction', 'btn-register-user-dlc-tracker'].every(id => !hasEverywhere(`id="${id}"`)));
assert('gui_user_dlc_adaptive_items_ingested', sourceGui.includes('payload.adaptiveItems') && sourceGui.includes('ingestAdaptiveItems') && scanner.includes('registerEntityTracker') && scanner.includes('scenarioBands') && scanner.includes('currentSnapshot'));
assert('gui_user_dlc_custom_tracker_state_history_rendered', hasEverywhere('id="user-dlc-tracker-results"') && sourceGui.includes('renderUserDlcTrackerCard') && sourceGui.includes('현재 결과') && sourceGui.includes('근거와 변경 이력'));
assert('gui_user_dlc_sexual_history_quick_action_and_rows_rendered', hasEverywhere('>성경험 이력</button>') && sourceGui.includes("sexual_history: '성경험 이력'") && ['섹스 횟수', '처녀 여부(첫 성경험 기준)', '자위 횟수', '임신 횟수', '출산 횟수', '경험 인수', '질내사정 횟수', '펠라치오 횟수', '애널 섹스 횟수', '첫 섹스 상대'].every(label => sourceGui.includes(label)));
assert('gui_user_dlc_sexual_history_is_continuous_and_deduplicated', sourceGui.includes("['relationship_model', 'reproductive_health', 'health_risk', 'sexual_history']") && sourceGui.includes('같은 사건을 다시 언급하거나 재분석해도 횟수를 중복 가산하지 않습니다.'));
assert('gui_user_dlc_contraceptive_world_quick_action_and_profile_rows_rendered', hasEverywhere('>피임 도구</button>') && sourceGui.includes("contraceptive: '피임 도구'") && ['피임 방식', '사용법', '효과 시작', '유효 기간', '신뢰도 단계', '실패 조건', '부작용·제약', '입수 경로', '가역성', '보호 범위'].every(label => sourceGui.includes(label)));
assert('gui_user_dlc_fantasy_world_quick_packages_and_kind_labels_rendered', ['던전 패키지', '마법 체계', '스킬·초능력'].every(label => hasEverywhere(`>${label}</button>`)) && ["dungeon: '던전'", "monster: '몬스터'", "drop_item: '드랍 아이템'", "experience_system: '경험치 체계'", "monster_gate: '몬스터 게이트'", "magic: '마법'", "sorcery: '요술'", "magic_array: '마법진'", "magic_wand: '마법 지팡이'", "magic_circle: '마법 서클'", "skill: '스킬'", "superpower: '초능력'"].every(fragment => sourceGui.includes(fragment)));
assert('gui_user_dlc_fantasy_profile_rows_rendered', ['체계 분류', '등급·티어', '희귀도', '권장 레벨·범위', '획득 방법', '발동·사용법', '비용·소모 자원', '성장 규칙', '보상·경험치 규칙', '드랍 목록', '진입 조건', '출현 조건', '중복 보상 방지', '연결 요소'].every(label => sourceGui.includes(label)));
assert('gui_user_dlc_custom_tracker_controls_built', sourceGui.includes('data-udlc-tracker-enabled-id') && sourceGui.includes('toggleUserDlcTrackerEnabledFromGui') && sourceGui.includes("renderWorldAdditionalInjectionButton('dlc-tracker'") && sourceGui.includes('setTrackerEnabled'));
assert('gui_user_dlc_tracker_membership_reanalysis_controls_built', hasEverywhere('id="user-dlc-retarget-banner"') && hasEverywhere('id="btn-cancel-user-dlc-retarget"') && sourceGui.includes('data-udlc-retarget-id') && sourceGui.includes('beginUserDlcTrackerRetargetFromGui') && sourceGui.includes('reconcileTrackerTargets') && sourceGui.includes('대상 제외 · 보관'));
assert('gui_user_dlc_dedicated_llm_profile_selector_built', hasEverywhere('id="sllm-user-dlc-profile"') && sourceGui.includes('data-llm-routes="userDlcWorldAnalysis,userDlcEntityAnalysis,userDlcTrackerAnalysis"') && ['userDlcWorldAnalysis', 'userDlcEntityAnalysis', 'userDlcTrackerAnalysis'].every(key => sourceGui.includes(`['${key}'`)));
assert('gui_user_dlc_analysis_starts_use_on', sourceGui.includes('useEnabled: true') && sourceGui.includes('추가하고 사용') && sourceGui.includes('추가하고 사용을 켰습니다'));
assert('gui_user_dlc_world_auto_classification_supports_categories', ['tool', 'contraceptive', 'dungeon', 'monster', 'drop_item', 'experience_system', 'monster_gate', 'magic', 'sorcery', 'magic_array', 'magic_wand', 'magic_circle', 'skill', 'superpower', 'trap', 'crisis', 'hazard', 'mechanism', 'lore', 'location', 'faction', 'rule', 'history', 'artifact', 'custom'].every(kind => scanner.includes(kind)) && scanner.includes('Infer the most suitable kind, title, mechanics'));
assert('gui_user_dlc_displays_revision_and_current_projection', sourceGui.includes('rev.${esc(item.revision || 1)}') && sourceGui.includes('적응 근거') && sourceGui.includes('현재 관계') && sourceGui.includes('현재 가능성') && sourceGui.includes('예상 반응'));
assert('gui_user_dlc_displays_conflict_block_and_mandatory_status', sourceGui.includes('LIBRA DB 충돌 · 투입 차단') && sourceGui.includes('호환 시 강제 적용') && sourceGui.includes("const buttonLabel = conflictBlocked ? '충돌 차단'"));
assert('gui_world_additional_merge_action_built', hasEverywhere('id="btn-merge-world-additional"') && sourceGui.includes('mergeWorldAdditionalDuplicatesFromGui') && sourceGui.includes('mergeDuplicateDirectives') && sourceGui.includes('mergeDuplicateItems'));
assert('gui_world_additional_delete_actions_built', ['directive', 'dlc-world', 'dlc-target', 'dlc-tracker'].every(kind => sourceGui.includes(`data-wa-delete-kind="${kind}"`)) && !sourceGui.includes('data-wa-delete-kind="codex"') && sourceGui.includes('deleteWorldAdditionalItemFromGui'));
assert('gui_world_additional_delete_is_confirmed', sourceGui.includes('삭제 후에는 다음 요청부터 주입되지 않습니다.') && sourceGui.includes("closest?.('[data-wa-delete-kind]')"));
assert('gui_world_additional_injection_toggle_is_visual', sourceGui.includes('.wa-inject-toggle.is-on') && sourceGui.includes('box-shadow:0 0 12px') && sourceGui.includes('aria-pressed'));
assert('gui_world_additional_injection_toggle_covers_all_items', ['directive', 'dlc-world', 'dlc-target', 'dlc-tracker'].every(kind => sourceGui.includes(`renderWorldAdditionalInjectionButton('${kind}'`)) && !sourceGui.includes("renderWorldAdditionalInjectionButton('codex'"));
assert('gui_world_additional_injection_toggle_is_persisted', sourceGui.includes('toggleWorldAdditionalInjectionFromGui') && sourceGui.includes("closest?.('[data-wa-inject-kind]')") && sourceGui.includes('setInjectionState'));
assert('gui_world_additional_injection_status_is_explicit', sourceGui.includes("${userDlc ? '사용' : '투입'} ON · 다음 요청부터 실제 프롬프트에 반영됩니다") && sourceGui.includes("${userDlc ? '사용' : '투입'} OFF · 다음 요청부터 제외됩니다"));
assert('gui_save_targets_chat_local_lore_only', sourceGui.includes('targetChat.localLore = newLore;') && !sourceGui.includes('else if (Array.isArray(targetChar?.lorebook)) targetChar.globalLore = newLore;'));
assert('gui_save_reloads_world_additional_with_resolved_target_scope', sourceGui.includes('const targetScopeKey = getChatRuntimeScopeKey(targetChat, targetChar);') && sourceGui.includes('scopeKey: targetScopeKey') && sourceGui.includes('chatId: targetChatId'));
assert('gui_save_callback_receives_persisted_target_context', sourceGui.includes('cb({ targetChar, targetChat, lore: persistedLore, scopeKey: targetScopeKey, chatId: targetChatId })'));

console.log(JSON.stringify({
  ok: assertions.every(item => item.ok),
  assertions
}, null, 2));
