const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const read = name => fs.readFileSync(path.join(root, 'src', 'parts', name), 'utf8');
const gui = read('15-gui-and-exports.js');
const session = read('15a-gui-session-data.js');
const content = read('15b-gui-content-world-dlc.js');
const settings = read('15c-gui-settings-config.js');
const events = read('15d-gui-events-finalize.js');
const userDlc = read('09a-world-additional-user-dlc.js');
const providers = read('06-api-providers-llm.js');
const memoryApi = read('10j-memory-public-lore-schema-api.js');
const init = read('14-main-initialization.js');
const prototype = fs.readFileSync(path.join(root, 'ux-prototype', 'libra-gui-ux-prototype.html'), 'utf8');

const assertions = [];
const check = (name, ok, detail = null) => {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
};

// 내비게이션 계약: 목업의 사이드바(그룹 라벨 + 항목)를 원본 언어로 구현한다.
// 종전 상단 가로탭 4개는 라이트 레이어의 셸이었고, 그 레이어를 걷어냈다.
check('sidebar_navigation_groups_and_paths',
  ['개요', '데이터', '추가 요소', '시스템'].every(label => gui.includes(`class="side-label">${label}<`))
  && ['home', 'memory', 'entity', 'relations', 'narrative', 'world', 'worldline', 'wa-auto', 'udlc', 'settings']
    .every(path => gui.includes(`data-tab="${path}"`))
  && gui.includes('id="nav-mc"') && gui.includes('id="nav-ec"') && gui.includes('id="nav-rc"'));
check('home_dashboard_is_real_runtime_view', gui.includes('id="tab-home"') && content.includes('const renderHome = () =>'));
check('approved_prototype_is_production_visual_source',
  prototype.includes('libra-ux-prototype')
  && gui.includes('Production port of ux-prototype/libra-gui-ux-prototype.html'));
// 셸 계약: 라이트/전면 레이어를 걷어내고 원본 레이어의 셸(좌측 아이콘 레일)을 쓴다.
check('prototype_shell_header_and_left_rail_are_ported',
  gui.includes('.gui-wrap{position:relative;width:100%;max-width:1160px')
  && gui.includes('.tabs{grid-column:1;grid-row:2;display:flex;flex-direction:column')
  && gui.includes('.tb.on::before{content:\'\';position:absolute;left:0;')
  && gui.includes('class="hdr-brand"')
  // 헤더 브랜드 배지(L)는 제거했다 — 제목과 부제만 둔다.
  && gui.includes(`<div class="brand"><h1>LIBRA World Manager <span class="ver">v${currentVersion}</span></h1>`)
  && gui.includes('id="libra-global-status"'));
// 선택 상태 계약: 사이드바가 곧 내비게이션이므로 항목이 on/aria-selected 를 함께 받는다.
check('prototype_sidebar_selected_state_is_ported',
  gui.includes('.side-link.on{background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 18%')
  && gui.includes('class="side-link" type="button" role="tab" aria-selected="false"')
  && content.includes("button.setAttribute('aria-selected', selected ? 'true' : 'false')"));
check('prototype_home_sync_and_recent_changes_are_live',
  gui.includes('id="btn-home-sync"')
  && gui.includes('id="home-recent-list"')
  && content.includes("syncButton.dataset.syncAction")
  && events.includes("#btn-home-sync"));
check('home_recent_changes_are_natural_language_summaries',
  content.includes('const buildHomeRecentCandidate = (entry) =>')
  && content.includes('const homeRecentMemoryCopy = (record = {}, meta = {}) =>')
  && content.includes('const homeRecentEntityCopy = (record = {}, meta = {}, entry = {}) =>')
  && content.includes('const homeRecentRelationCopy = (record = {}) =>')
  && content.includes(".replace(/^(?:Scene result|Scene summary|Summary|Result)")
  && !content.includes('raw.slice(0, 74)')
  && !content.includes('raw.slice(0, 116)'));
check('prototype_flat_world_page_replaces_numbered_accordion',
  Boolean(require('./libra_behavior_contract_helpers.cjs').verifyFlatWorldLayout({source:session})));
check('prototype_single_settings_page_integrates_profiles_and_work_mode',
  gui.includes('data-settings-section="llm-profiles"')
  && session.includes("section?.dataset?.settingsSection === 'llm-profiles'")
  // 설정 셸 도입 후에도 프로필 요약·작동 방식이 같은 페이지에 통합되는지를 본다.
  && session.includes('settingsContent.append(profileSummary, workMode, ...accordions)')
  // heading 은 셸 재설계에서 사라질 수 있으므로 null 을 걸러 넣는다.
  && session.includes('tab.replaceChildren(...[heading, settingsShell].filter(Boolean))')
  && session.includes("profileSummary.className = 'settings-overview prototype-settings-summary'")
  && session.includes("workHead.innerHTML = '<h3>작동 방식</h3>"));
check('old_provider_gui_and_hidden_bridges_are_absent',
  !gui.includes('id="tab-provider"')
  && !gui.includes('data-provider-legacy')
  && !gui.includes('id="slp"')
  && !gui.includes('id="saxp"')
  && !session.includes('legacyProviderSections')
  && !settings.includes('overlay.querySelector("#slp")')
  && !events.includes("bindSlider('#slt'"));
check('prototype_unified_additional_composer_is_live',
  gui.includes('data-additional-tab="create"')
  && gui.includes('id="udlc-unified-request"')
  && gui.includes('id="udlc-unified-target"')
  && gui.includes('id="btn-analyze-user-dlc-unified"')
  && content.includes('activateAdditionalPrimaryPane')
  && content.includes("unifiedTarget.innerHTML")
  && events.includes("#btn-analyze-user-dlc-unified"));
// 가독성 계약: 운영 라벨은 --readable 별칭이 아니라 셸 토큰(--sans)을 쓴다.
check('korean_operational_cards_use_readable_font_and_sizes',
  gui.includes("--sans:      var(--risu-font-family, -apple-system, 'Malgun Gothic'")
  && gui.includes('.card .acts .wa-inject-toggle')
  && gui.includes('.udlc-target-title{font-family:var(--sans);font-size:var(--fs-label)')
  && gui.includes('.udlc-kv b{font-family:var(--sans);font-size:var(--fs-label)')
  && gui.includes('.entity-band .fld label,.card.rel .fld label'));
check('separate_world_codex_and_active_overview_tabs_are_removed',
  !gui.includes('data-additional-tab="active"')
  && !gui.includes('id="additional-active-overview"')
  && !gui.includes('별도 월드 코덱스')
  && !content.includes("['별도 월드 코덱스'"));
check('relation_recent_changes_are_naturalized_and_empty_objects_render_blank',
  content.includes('const formatGuiRelationRecentChanges =')
  && content.includes("push('겉으로 드러난 변화'")
  && content.includes("push('내면의 변화'")
  && content.includes('formatGuiRelationRecentChanges(dynamics.recentChanges || [])'));
check('entity_blocklist_covers_user_dlc_targets_and_prompt_paths',
  userDlc.includes('const isTargetBlocked =')
  && userDlc.includes('.filter(item => !isTargetBlocked(item))')
  && userDlc.includes('EntityManager?.isBlockedEntityName?.(displayName, lorebook)')
  && content.includes('UserDlcCore.isTargetBlocked?.(item, targetLore)')
  && session.includes("flushPendingGlobalSettingsAutoSave('entity-blocklist-preflight')"));
check('full_data_subnavigation_present', ['memory', 'entity', 'narrative', 'world'].every(tab => gui.includes(`data-view-tab="${tab}"`)));
check('debug_toggle_and_live_status_present', gui.includes('id="sdebug"') && gui.includes('id="sdebug-status"') && content.includes('syncDebugRecordStatus'));
check('debug_toggle_is_saved_to_runtime_config', settings.includes('debug: overlay.querySelector("#sdebug")?.checked === true'));
check('world_additional_only_exposes_max_auto_injection_setting',
  gui.indexOf('id="swamax"') > gui.indexOf('id="tab-world-additional"')
  && gui.indexOf('id="swamax"') < gui.indexOf('id="tab-settings"')
  && ['id="swam"', 'id="swaimp"', 'id="swaauto"', 'id="swacforce"', 'id="swacustom"'].every(token => !gui.includes(token)));
check('retired_direct_instruction_controls_are_removed',
  ['id="swcanonforce"', 'id="swcanoncustom"', 'id="btn-save-world-additional-settings"'].every(token => !gui.includes(token))
  && !events.includes("#btn-save-world-additional-settings"));
check('manual_world_additional_injection_is_presented_as_guaranteed',
  gui.includes('투입 ON’으로 지정한 요소는 이 수를 넘어도 반드시 프롬프트에 포함')
  && content.includes("const buttonLabel = conflictBlocked ? '충돌 차단'"));
check('global_settings_are_automatically_persisted',
  gui.includes('id="settings-auto-save-status"')
  && gui.includes('aria-label="월드 에디셔널 적용 설정" data-global-settings')
  && events.includes('const persistGlobalSettingsFromUI =')
  && events.includes("target.closest('#tab-settings, [data-global-settings]')")
  && events.includes("scheduleGlobalSettingsAutoSave('settings-input', 600)")
  && events.includes("scheduleGlobalSettingsAutoSave('settings-change', 0)")
  && events.includes('settingsAutoSaveQueue = task.catch(() => {})'));
check('global_settings_auto_save_flushes_and_manual_save_reuses_pipeline',
  events.includes("flushPendingGlobalSettingsAutoSave('settings-overlay-close')")
  && events.includes("persistGlobalSettingsFromUI({ reason: 'settings-save', notify: true })")
  && events.includes('const settleGlobalSettingsAutoSaveBeforeReplace = async () =>')
  && events.includes("scheduleGlobalSettingsAutoSave('vertex-json-file', 0)")
  && session.includes('전역 설정에 자동 저장됩니다.'));
check('safe_cache_reset_is_separate_from_data_deletion',
  gui.includes('id="lmai-cache-reset"')
  && gui.includes('id="lmai-data-reset"')
  && events.includes("MemoryEngine.clearDerivedCaches?.()")
  && events.includes("querySelector('#lmai-data-reset')"));
check('derived_cache_api_preserves_source_lore', memoryApi.includes('clearDerivedCaches: () =>') && !memoryApi.includes('purgeLibraManagedLoreForActiveChat'));
check('plugin_compatibility_status_removed', !gui.includes('id="libra-interop-status"') && !content.includes('LIBRA_MemoryInteropCore'));
check('visible_llm_profile_supports_vertex_json',
  gui.includes('data-vertex-json-slot="preset"')
  && session.includes("provider: '#sllmpp', url: '#sllmpu', key: '#sllmpk', model: '#sllmpm'"));
check('account_model_discovery_supports_ollama_nanogpt_and_gemini',
  providers.includes("ollama_cloud: Object.freeze({ label: 'Ollama Cloud'")
  && providers.includes("nanogpt: Object.freeze({ label: 'NanoGPT'")
  && providers.includes("gemini: Object.freeze({ label: 'Gemini AI Studio'"));
check('voyage_is_new_embedding_default', init.includes("'voyage-4-large'") && gui.includes('VoyageAI · LIBRA 권장'));
console.log(JSON.stringify({ ok: true, assertions }, null, 2));
