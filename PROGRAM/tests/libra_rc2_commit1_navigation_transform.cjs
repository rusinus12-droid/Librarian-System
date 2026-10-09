'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };
  const replaceRange = (label, start, end, replacement) => {
    const from = source.indexOf(start);
    if (from < 0) throw new Error(`${label}:start_missing`);
    if (source.indexOf(start, from + start.length) >= 0) throw new Error(`${label}:start_not_unique`);
    const to = source.indexOf(end, from + start.length);
    if (to < 0) throw new Error(`${label}:end_missing`);
    source = `${source.slice(0, from)}${replacement}${source.slice(to)}`;
    labels.push(label);
  };

  rep('shared_navigation_state',
`    activeTab: 'flow',
    sidebarSection: 'home',
    libraSidebarSection: 'home',`,
`    activeTab: 'flow',
    sidebarSection: 'home',
    sharedSidebarSection: 'home',
    sharedNavigationMigrated: false,
    pipelineHubSection: 'memory_pipeline',
    customHubSection: 'memory',
    convenienceHubSection: 'input_writer',
    narrativeHubSection: 'current',
    libraDraftSection: 'mode',
    gradiaDraftSection: 'quick',
    libraSidebarSection: 'home',`);

  rep('settings_state_split',
`    connectionHubSection: 'providers',
    settingsHubSection: 'memory_settings',
    promptInjectionSection: 'sga',`,
`    connectionHubSection: 'providers',
    settingsHubSection: 'general',
    generalSettingsSection: 'memory_settings',
    promptInjectionSection: 'sga',`);

  rep('shared_navigation_registry',
`  const LIBRA_SETTINGS_HUB_SECTIONS = Object.freeze(['memory_settings', 'transfer', 'debug']);

  const normalizeHubChoice`,
`  const LIBRA_SETTINGS_HUB_SECTIONS = Object.freeze(['memory_settings', 'transfer', 'debug']);
  const SHARED_SIDEBAR_PAGE_REGISTRY = Object.freeze([
    Object.freeze({ id: 'home', label: '홈', icon: '⌂' }),
    Object.freeze({ id: 'memory', label: '기억', icon: '◫' }),
    Object.freeze({ id: 'characters', label: '인물', icon: '♙' }),
    Object.freeze({ id: 'relationships', label: '관계', icon: '⇄' }),
    Object.freeze({ id: 'world', label: '세계', icon: '◎' }),
    Object.freeze({ id: 'narrative', label: '내러티브', icon: '⌁' }),
    Object.freeze({ id: 'pipeline', label: '파이프라인', icon: '◆' }),
    Object.freeze({ id: 'custom', label: '커스텀', icon: '✎' }),
    Object.freeze({ id: 'convenience', label: '편의 기능', icon: '◇' }),
    Object.freeze({ id: 'settings', label: '설정', icon: '⚙' })
  ]);
  const SHARED_SIDEBAR_SECTIONS = Object.freeze(SHARED_SIDEBAR_PAGE_REGISTRY.map(page => page.id));
  const SHARED_MEMORY_HUB_SECTIONS = Object.freeze(['memories', 'recall', 'runs']);
  const SHARED_PIPELINE_HUB_SECTIONS = Object.freeze(['memory_pipeline', 'draft']);
  const SHARED_SETTINGS_HUB_SECTIONS = Object.freeze(['references', 'connections', 'server', 'recovery', 'general']);
  const GRADIA_DRAFT_SECTIONS = Object.freeze(['quick', 'stages', 'skills', 'output', 'results']);
  const LIBRA_DRAFT_SECTIONS = Object.freeze(['mode', 'results']);

  const normalizeHubChoice`);

  const sharedNavigation = `  const resolveSharedNavigationTarget = sectionValue => {
    const requested = String(sectionValue || 'home').trim() || 'home';
    if (SHARED_SIDEBAR_SECTIONS.includes(requested)) return { pageId: requested };
    if (requested === 'overview') return { pageId: 'home' };
    if (requested === 'memories') return { pageId: 'memory', memoryHubSection: 'memories' };
    if (['recall', 'prompt_injection', 'planner', 'sga'].includes(requested)) {
      return { pageId: 'memory', memoryHubSection: 'recall', promptInjectionSection: requested === 'prompt_injection' ? 'sga' : requested };
    }
    if (requested === 'runs' || requested === 'execution_results') return { pageId: 'memory', memoryHubSection: 'runs' };
    if (requested === 'continuity_state' || requested === 'world_manager') return { pageId: 'home' };
    if (requested === 'memory_pipeline') return { pageId: 'pipeline', pipelineHubSection: 'memory_pipeline' };
    if (requested.startsWith('agent_')) {
      const stageId = requested.slice('agent_'.length);
      if (LIBRA_MEMORY_PIPELINE_STAGES.includes(stageId)) return { pageId: 'pipeline', pipelineHubSection: 'memory_pipeline', memoryPipelineStage: stageId };
      if (GRADIA_STAGE_ALIAS_MAP?.[stageId]) return { pageId: 'pipeline', pipelineHubSection: 'draft', gradiaDraftSection: 'stages', selectedPrompt: GRADIA_STAGE_ALIAS_MAP[stageId] };
    }
    if (requested === 'gradia_quick') return { pageId: 'pipeline', pipelineHubSection: 'draft', gradiaDraftSection: 'quick' };
    if (requested === 'gradia_results' || requested === 'results') return { pageId: 'pipeline', pipelineHubSection: 'draft', gradiaDraftSection: 'results' };
    if (requested === 'gradia_pipeline') return { pageId: 'pipeline', pipelineHubSection: 'draft', gradiaDraftSection: 'stages' };
    if (requested === 'gradia_skills') return { pageId: 'pipeline', pipelineHubSection: 'draft', gradiaDraftSection: 'skills' };
    if (requested === 'gradia_options' || ['runtime', 'information_transfer', 'response_improvement', 'main'].includes(requested)) return { pageId: 'pipeline', pipelineHubSection: 'draft', gradiaDraftSection: 'output' };
    if (requested === 'gradia_input' || requested === 'input_writer' || requested === 'input_assist' || requested === 'agent_input_assist') return { pageId: 'convenience' };
    if (requested === 'prompt' || requested === 'prompt_studio' || requested === 'gradia_prompt_settings') return { pageId: 'custom', customHubSection: 'settings' };
    if (requested === 'prompt_studio_ooc' || requested === 'user_intent_ooc' || requested === 'gradia_prompt_ooc') return { pageId: 'custom', customHubSection: 'ooc' };
    if (requested === 'gradia_prompt_results') return { pageId: 'custom', customHubSection: 'injection' };
    if (requested === 'story_arc' || requested === 'story_arc_current') return { pageId: 'narrative', narrativeHubSection: 'current' };
    if (requested === 'story_arc_direction') return { pageId: 'narrative', narrativeHubSection: 'direction' };
    if (requested === 'story_arc_advanced') return { pageId: 'narrative', narrativeHubSection: 'history' };
    if (requested === 'references' || ['modules', 'character_lore_exclusions', 'response_materials'].includes(requested)) {
      return { pageId: 'settings', settingsHubSection: 'references', referenceHubSection: LIBRA_REFERENCE_HUB_SECTIONS.includes(requested) ? requested : undefined };
    }
    if (requested === 'connections' || ['providers', 'embedding'].includes(requested)) {
      return { pageId: 'settings', settingsHubSection: 'connections', connectionHubSection: LIBRA_CONNECTION_HUB_SECTIONS.includes(requested) ? requested : undefined };
    }
    if (requested === 'server') return { pageId: 'settings', settingsHubSection: 'server' };
    if (requested === 'recovery' || requested === 'memory_restore') return { pageId: 'settings', settingsHubSection: 'recovery' };
    if (requested === 'debug' || requested === 'transfer' || requested === 'memory_settings') return { pageId: 'settings', settingsHubSection: 'general', generalSettingsSection: requested };
    return { pageId: 'home' };
  };

  const applySharedNavigationTarget = targetValue => {
    const target = targetValue && typeof targetValue === 'object' ? targetValue : { pageId: 'home' };
    const pageId = SHARED_SIDEBAR_SECTIONS.includes(target.pageId) ? target.pageId : 'home';
    Gui.sharedSidebarSection = pageId;
    Gui.sidebarSection = pageId;
    Gui.activeTab = 'flow';
    if (target.memoryHubSection) Gui.memoryHubSection = normalizeHubChoice(target.memoryHubSection, SHARED_MEMORY_HUB_SECTIONS, 'memories');
    if (target.memoryPipelineStage) Gui.memoryPipelineStage = normalizeHubChoice(target.memoryPipelineStage, LIBRA_MEMORY_PIPELINE_STAGES, 'ariadne');
    if (target.pipelineHubSection) Gui.pipelineHubSection = normalizeHubChoice(target.pipelineHubSection, SHARED_PIPELINE_HUB_SECTIONS, 'memory_pipeline');
    if (target.customHubSection) Gui.customHubSection = target.customHubSection;
    if (target.narrativeHubSection) Gui.narrativeHubSection = target.narrativeHubSection;
    if (target.gradiaDraftSection) Gui.gradiaDraftSection = normalizeHubChoice(target.gradiaDraftSection, GRADIA_DRAFT_SECTIONS, 'quick');
    if (target.libraDraftSection) Gui.libraDraftSection = normalizeHubChoice(target.libraDraftSection, LIBRA_DRAFT_SECTIONS, 'mode');
    if (target.promptInjectionSection) Gui.promptInjectionSection = normalizePromptInjectionSection(target.promptInjectionSection);
    if (target.referenceHubSection) Gui.referenceHubSection = normalizeHubChoice(target.referenceHubSection, LIBRA_REFERENCE_HUB_SECTIONS, 'modules');
    if (target.connectionHubSection) Gui.connectionHubSection = normalizeHubChoice(target.connectionHubSection, LIBRA_CONNECTION_HUB_SECTIONS, 'providers');
    if (target.settingsHubSection) Gui.settingsHubSection = normalizeHubChoice(target.settingsHubSection, SHARED_SETTINGS_HUB_SECTIONS, 'general');
    if (target.generalSettingsSection) Gui.generalSettingsSection = normalizeHubChoice(target.generalSettingsSection, LIBRA_SETTINGS_HUB_SECTIONS, 'memory_settings');
    if (target.selectedPrompt) Gui.selectedPrompt = target.selectedPrompt;
  };

  const migrateLegacyGuiNavigationState = () => {
    if (Gui.sharedNavigationMigrated === true) {
      Gui.sharedSidebarSection = SHARED_SIDEBAR_SECTIONS.includes(Gui.sharedSidebarSection) ? Gui.sharedSidebarSection : 'home';
      Gui.sidebarSection = Gui.sharedSidebarSection;
      return Gui.sharedSidebarSection;
    }
    let requested = String(Gui.sidebarSection || '').trim();
    if (!requested || requested === 'home') requested = activeGuiResponseFamily() === 'gradia' ? String(Gui.gradiaPageId || Gui.gradiaSidebarSection || 'home') : String(Gui.libraSidebarSection || 'home');
    if (requested === 'memory' && Gui.memoryHubSection === 'continuity_state') requested = 'continuity_state';
    else if (requested === 'memory' && Gui.memoryHubSection === 'pipeline') requested = 'memory_pipeline';
    applySharedNavigationTarget(resolveSharedNavigationTarget(requested));
    Gui.sharedNavigationMigrated = true;
    return Gui.sharedSidebarSection;
  };

  const sharedNavigate = sectionValue => {
    const target = resolveSharedNavigationTarget(sectionValue);
    applySharedNavigationTarget(target);
    if (target.referenceHubSection === 'modules' || (target.settingsHubSection === 'references' && Gui.referenceHubSection === 'modules')) void refreshModuleLoreCatalog(false);
    if (target.referenceHubSection === 'character_lore_exclusions') void refreshCharacterLoreCatalog(false);
    queueGuiNavigationRender();
  };

`;

  replaceRange('shared_navigation_authority',
    '  const GUI_FAMILY_HUB_STATE_KEYS = Object.freeze([',
    '  const guiFamilyHubDefaults = family =>',
    `${sharedNavigation}  const GUI_FAMILY_HUB_STATE_KEYS = Object.freeze([\n    'promptHubSection', 'promptInjectionSection', 'promptStudioDomain', 'promptStudioStage',\n    'promptStudioProfileName', 'promptStudioDraft', 'promptStudioDraftKey', 'promptStudioPreviewText',\n    'promptStudioImportText', 'promptStudioExportText', 'promptStudioExportScope', 'promptStudioOocTargetId',\n    'selectedPrompt', 'selectedResultStage'\n  ]);\n\n`);

  rep('family_restore_shared_settings',
`    Gui.settingsHubSection = normalizeHubChoice(Gui.settingsHubSection, LIBRA_SETTINGS_HUB_SECTIONS, family === 'gradia' ? 'debug' : 'memory_settings');`,
`    Gui.settingsHubSection = normalizeHubChoice(Gui.settingsHubSection, SHARED_SETTINGS_HUB_SECTIONS, 'general');
    Gui.generalSettingsSection = normalizeHubChoice(Gui.generalSettingsSection, LIBRA_SETTINGS_HUB_SECTIONS, 'memory_settings');`);

  replaceRange('libra_navigation_adapter',
    '  const libraGuiNavigate = (section, _tab = \'flow\') => {',
    '  const libraFormatTime = value =>',
`  const libraGuiNavigate = (section, _tab = 'flow') => {
    sharedNavigate(section);
  };

`);

  replaceRange('gradia_navigation_adapter',
    '  const gradiaGuiNavigate = pageId => {',
    '  const setGradiaWritingModeFromHome = mode =>',
`  const gradiaGuiNavigate = pageId => {
    sharedNavigate(pageId);
  };

`);

  replaceRange('shared_mobile_navigation',
    '  const MOBILE_NAV_ITEMS = Object.freeze([',
    '  const buildPromptInjectionPanel = () =>',
`  const MOBILE_NAV_ITEMS = Object.freeze(SHARED_SIDEBAR_PAGE_REGISTRY.map(page => Object.freeze({
    value: \`flow|\${page.id}\`, section: page.id, tab: 'flow', label: page.label, icon: page.icon
  })));

  const navigateMobileGui = async value => {
    const target = MOBILE_NAV_ITEMS.find(item => item.value === value) || MOBILE_NAV_ITEMS[0];
    sharedNavigate(target.section);
  };

  const buildMobileNavigation = () => {
    migrateLegacyGuiNavigationState();
    const activeValue = \`flow|\${Gui.sharedSidebarSection || 'home'}\`;
    const activeItem = MOBILE_NAV_ITEMS.find(item => item.value === activeValue) || MOBILE_NAV_ITEMS[0];
    return guiEl('nav', { class: 'sga-mobile-nav shared-mobile-nav', 'aria-label': 'LIBRA와 GRADIA 공통 모바일 화면 이동' }, [
      guiEl('div', { class: 'sga-mobile-nav-head' }, [
        guiEl('div', {}, [guiEl('small', { text: '현재 화면' }), guiEl('strong', { text: \`\${activeItem.icon} \${activeItem.label}\` })]),
        guiEl('span', { class: \`sga-badge \${Runtime.inFlight ? 'warn' : 'good'}\`, dataset: { runtimePipeline: 'true' }, text: Runtime.inFlight ? '실행 중' : '대기 중' })
      ]),
      guiEl('div', { class: 'sga-mobile-quick-nav' }, MOBILE_NAV_ITEMS.slice(0, 4).map(item => guiEl('button', {
        class: \`sga-mobile-quick-btn\${activeItem.section === item.section ? ' active' : ''}\`, type: 'button', onClick: () => { void navigateMobileGui(item.value); }
      }, [guiEl('span', { text: item.icon }), guiEl('small', { text: item.label })]))),
      guiEl('label', { class: 'sga-mobile-nav-select-wrap' }, [
        guiEl('span', { text: '전체 메뉴' }),
        guiEl('select', { class: 'sga-select sga-mobile-nav-select', value: activeItem.value, onChange: event => { void navigateMobileGui(event.target.value); } }, optionNodes(MOBILE_NAV_ITEMS.map(item => [item.value, \`\${item.icon}  \${item.label}\`]), activeItem.value))
      ])
    ]);
  };

`);

  replaceRange('unread_result_shared_route',
    '  const routeUnreadGradiaResult = () => {',
    '  const acknowledgeRenderedGradiaResult = () =>',
`  const routeUnreadGradiaResult = () => {
    if (!Gui.state || typeof Gui.state !== 'object') return false;
    const pending = unreadGradiaResultPending();
    if (activeGuiResponseFamily() !== 'gradia' || !pending) return false;
    if (Number(Runtime.lastInputWriter?.pipelineRequestId || 0) === Number(pending.requestId || 0)) Gui.selectedResultStage = 'input_writer';
    Gui.sharedSidebarSection = 'pipeline';
    Gui.sidebarSection = 'pipeline';
    Gui.pipelineHubSection = 'draft';
    Gui.gradiaDraftSection = 'results';
    return true;
  };

`);

  replaceRange('family_switch_preserves_shared_page',
    '  const activateResponseFamilyFromHeader = async nextFamily => {',
    '  const buildResponseFamilyHeaderSwitch = () =>',
`  const activateResponseFamilyFromHeader = async nextFamily => {
    const runtime = gradiaGuiRuntime();
    const normalized = normalizeResponseFamily(nextFamily, runtime.injectionMode);
    if (runtime.responseFamily === normalized) return;
    migrateLegacyGuiNavigationState();
    captureGuiFamilyHubState(runtime.responseFamily);
    runtime.responseFamily = normalized;
    Object.assign(runtime, resolveResponseModeState(runtime));
    Gui.activeTab = 'flow';
    restoreGuiFamilyHubState(normalized);
    if (normalized === 'gradia') routeUnreadGradiaResult();
    Gui.sharedSidebarSection = SHARED_SIDEBAR_SECTIONS.includes(Gui.sharedSidebarSection) ? Gui.sharedSidebarSection : 'home';
    Gui.sidebarSection = Gui.sharedSidebarSection;
    markGuiDirty();
    await renderSettingsGui();
    guiSetStatus(\`\${normalized === 'gradia' ? 'GRADIA' : PUBLIC_DISPLAY_NAME} GUI로 전환했습니다. 공통 화면 위치는 유지됩니다.\`);
  };

`);

  replaceRange('general_settings_state_adapter',
    '  const buildLibraSettingsHubPanel = () => {',
    '  const gradiaGuiRuntime = () =>',
`  const buildLibraSettingsHubPanel = () => {
    Gui.generalSettingsSection = normalizeHubChoice(Gui.generalSettingsSection, LIBRA_SETTINGS_HUB_SECTIONS, 'memory_settings');
    const definitions = [
      Object.freeze({ id: 'memory_settings', label: '성능' }),
      Object.freeze({ id: 'transfer', label: '데이터 이동' }),
      Object.freeze({ id: 'debug', label: '진단' })
    ];
    const panel = Gui.generalSettingsSection === 'transfer' ? buildTransferTab()
      : Gui.generalSettingsSection === 'debug' ? buildDebugTab()
        : buildLibraMemorySettingsPanel();
    return guiEl('div', { class: 'sga-flow-section' }, [
      buildLibraHubTabs(definitions, Gui.generalSettingsSection, sectionId => { Gui.generalSettingsSection = sectionId; }, '설정과 진단 내부 페이지'), panel
    ]);
  };

`);

  const sharedRouter = `  const buildSharedPipelineShellPanel = () => {
    Gui.pipelineHubSection = normalizeHubChoice(Gui.pipelineHubSection, SHARED_PIPELINE_HUB_SECTIONS, 'memory_pipeline');
    const definitions = [Object.freeze({ id: 'memory_pipeline', label: '기억 생성' }), Object.freeze({ id: 'draft', label: '초안 작성' })];
    let panel;
    if (Gui.pipelineHubSection === 'memory_pipeline') panel = buildAgentsTab(Gui.memoryPipelineStage);
    else if (activeGuiResponseFamily() === 'gradia') {
      Gui.gradiaDraftSection = normalizeHubChoice(Gui.gradiaDraftSection, GRADIA_DRAFT_SECTIONS, 'quick');
      const draftTabs = [
        { id: 'quick', label: '빠른 설정' }, { id: 'stages', label: '단계' }, { id: 'skills', label: '스킬' },
        { id: 'output', label: '출력' }, { id: 'results', label: '결과' }
      ];
      const child = Gui.gradiaDraftSection === 'stages' ? buildGradiaPipelinePanel()
        : Gui.gradiaDraftSection === 'skills' ? buildGradiaSkillSettings()
          : Gui.gradiaDraftSection === 'output' ? buildGradiaOutputPanel()
            : Gui.gradiaDraftSection === 'results' ? buildGradiaResultsPanel()
              : buildGradiaDraftSettingsPanel();
      panel = guiEl('div', { class: 'sga-flow-section', dataset: { draftFamily: 'gradia' } }, [buildLibraHubTabs(draftTabs, Gui.gradiaDraftSection, value => { Gui.gradiaDraftSection = value; }, 'GRADIA 초안 작업공간'), child]);
    } else {
      panel = guiEl('div', { class: 'sga-flow-section', dataset: { draftFamily: 'libra' } }, [buildLibraResponseModeSettingsPanel()]);
    }
    return guiEl('div', { class: 'sga-flow-section' }, [buildLibraHubTabs(definitions, Gui.pipelineHubSection, value => { Gui.pipelineHubSection = value; }, '파이프라인 내부 페이지'), panel]);
  };

  const buildSharedSettingsShellPanel = () => {
    Gui.settingsHubSection = normalizeHubChoice(Gui.settingsHubSection, SHARED_SETTINGS_HUB_SECTIONS, 'general');
    const definitions = [
      { id: 'references', label: '참고 자료' }, { id: 'connections', label: 'AI · 임베딩 연결' },
      { id: 'server', label: '서버 · 저장 방식' }, { id: 'recovery', label: '복구' }, { id: 'general', label: '일반 · 진단' }
    ];
    const panel = Gui.settingsHubSection === 'references' ? buildLibraReferenceHubPanel()
      : Gui.settingsHubSection === 'connections' ? buildLibraConnectionHubPanel()
        : Gui.settingsHubSection === 'server' ? buildLibraServerConnectionPanel()
          : Gui.settingsHubSection === 'recovery' ? buildLibraRecoveryPanel()
            : buildLibraSettingsHubPanel();
    return guiEl('div', { class: 'sga-flow-section' }, [buildLibraHubTabs(definitions, Gui.settingsHubSection, value => { Gui.settingsHubSection = value; }, '설정 내부 페이지'), panel]);
  };

  const buildSharedExecutionFlowTab = () => {
    migrateLegacyGuiNavigationState();
    const section = Gui.sharedSidebarSection;
    const family = activeGuiResponseFamily();
    const page = (title, description, child) => guiEl('div', { class: 'sga-flow-page shared-flow-page', dataset: { sharedPage: section } }, [
      guiEl('div', { class: 'sga-section-title sga-flow-page-title' }, [guiEl('h2', { text: title }), guiEl('p', { text: description })]), child
    ]);
    if (section === 'memory') return page('기억', '두 초안 엔진이 함께 사용하는 정본 기억과 실행 근거입니다.', buildLibraMemoryHubPanel());
    if (section === 'characters') return page('인물', '월드 매니저의 현재 인물 상태입니다.', buildLibraContinuityStatePanel());
    if (section === 'relationships') return page('관계', '월드 매니저의 현재 관계 상태입니다.', buildLibraContinuityStatePanel());
    if (section === 'world') return page('세계', '월드 매니저의 현재 세계 상태입니다.', buildLibraContinuityStatePanel());
    if (section === 'narrative') return page('내러티브', '현재 이야기 상태와 향후 방향을 관리합니다.', buildLibraStoryArcPanel());
    if (section === 'pipeline') return page('파이프라인', '기억 생성은 공통이며 초안 작성 작업공간만 현재 엔진에 맞춰 바뀝니다.', buildSharedPipelineShellPanel());
    if (section === 'custom') return page('커스텀', '기억과 현재 초안 엔진의 커스텀 프롬프트입니다.', family === 'gradia' ? buildGradiaPromptHubPanel() : buildLibraPromptHubPanel());
    if (section === 'convenience') return page('편의 기능', '초안 파이프라인과 별개인 입력 작성 보조 기능입니다.', buildInputAssistSettingsPanel({ family }));
    if (section === 'settings') return page('설정', '참고 자료, 연결, 저장 방식, 복구와 진단을 한곳에서 관리합니다.', buildSharedSettingsShellPanel());
    return page('홈', '공통 기억과 월드 매니저에서 선택한 초안 엔진으로 이어집니다.', family === 'gradia' ? buildGradiaHomePanel() : buildLibraHomePanel());
  };

  const buildExecutionFlowTab = () => buildSharedExecutionFlowTab();

  const buildProvidersTab = () => buildLibraProviderPanel();

  const buildSidebar = () => {
    migrateLegacyGuiNavigationState();
    const active = Gui.sharedSidebarSection;
    const snapshot = LibraMemoryCore.peekSnapshot();
    const lastRun = snapshot.runs?.[0];
    const item = page => guiEl('button', {
      class: 'sga-side-item', type: 'button', dataset: { active: String(active === page.id), sharedPage: page.id },
      'aria-current': active === page.id ? 'page' : null, onClick: () => sharedNavigate(page.id)
    }, [guiEl('span', { class: 'sga-side-icon', text: page.icon }), guiEl('span', { class: 'sga-side-label', text: page.label })]);
    return guiEl('aside', { class: 'sga-sidebar shared-sidebar', 'aria-label': 'LIBRA와 GRADIA 공통 메뉴' }, [
      guiEl('nav', { class: 'sga-side-nav' }, SHARED_SIDEBAR_PAGE_REGISTRY.map(item)),
      guiEl('div', { class: 'sga-side-bottom' }, [
        guiEl('div', { class: 'sga-side-status-row' }, [guiEl('span', { text: '초안 엔진' }), guiEl('strong', { text: activeGuiResponseFamily() === 'gradia' ? 'GRADIA' : 'LIBRA' })]),
        guiEl('div', { class: 'sga-side-status-row' }, [guiEl('span', { text: '기억 엔진' }), guiEl('strong', { class: 'sga-live-dot', text: Runtime.inFlight ? '실행 중' : '활성' })]),
        guiEl('div', { class: 'sga-side-status-row' }, [guiEl('span', { text: '마지막 실행' }), guiEl('strong', { text: lastRun ? libraFormatTime(lastRun.finishedAt || lastRun.startedAt) : '기록 없음' })]),
        guiEl('div', { class: 'sga-side-status-row' }, [guiEl('span', { text: '버전' }), guiEl('strong', { text: PLUGIN_VERSION })])
      ])
    ]);
  };

`;

  replaceRange('shared_desktop_shell',
    '  const buildExecutionFlowTab = () => {',
    '  const buildInsightRail = () =>',
    sharedRouter);

  replaceRange('render_family_switch_adapter',
    '    const selectResponseFamilyFromHeader = async nextFamily => {',
    '    const app = guiEl(',
`    const selectResponseFamilyFromHeader = async nextFamily => {
      await activateResponseFamilyFromHeader(nextFamily);
    };
`);

  return { source, labels };
};
