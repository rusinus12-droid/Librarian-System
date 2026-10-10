'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  rep('gui_persisted_state_revert',
`  const ensureGuiState = async (force = false) => {
    if (!Gui.state || force) {
      const settings = await loadSettings();
      applyGuiSettingsState(settings);
    }
    return Gui.state;
  };

  const primeGuiStateFromRuntimeCache = () => {`,
`  const ensureGuiState = async (force = false) => {
    if (!Gui.state || force) {
      const settings = await loadSettings();
      applyGuiSettingsState(settings);
    }
    return Gui.state;
  };

  const revertGuiStateFromStorage = async () => {
    Runtime.settings = null;
    Runtime.settingsLoadedAt = 0;
    const settings = await loadSettings();
    applyGuiSettingsState(settings, { keepDirty: false });
    clearRequestReuseCache();
    await renderSettingsGui();
    guiSetStatus('저장된 초안·GUI 설정으로 되돌렸습니다.', false, true);
    return true;
  };

  const primeGuiStateFromRuntimeCache = () => {`);

  rep('gradia_quick_writing_mode',
`  return guiEl('div', { class: 'sga-flow-section' }, [
    runtime.gradiaWritingMode === 'author' ? guiEl('section', { class: 'sga-card wide' }, [`,
`  return guiEl('div', { class: 'sga-flow-section' }, [
    guiEl('section', { class: 'sga-card wide', dataset: { gradiaQuickSetting: 'writing_mode' } }, [
      guiEl('h3', { text: '작성 모드' }),
      guiEl('div', { class: 'sga-simple-choice-grid two' }, GRADIA_WRITING_MODE_ORDER.map(mode => {
        const def = gradiaWritingModeCopy(mode);
        return simpleChoiceCard({
          active: runtime.gradiaWritingMode === mode,
          title: mode === 'rp' ? 'RP' : '소설',
          description: def.description,
          meta: mode === 'rp' ? '유저 행동 불가침' : '전체 캐스트 작가',
          badge: runtime.gradiaWritingMode === mode ? '사용 중' : def.badge,
          onClick: () => setGradiaWritingModeFromHome(mode)
        });
      }))
    ]),
    runtime.gradiaWritingMode === 'author' ? guiEl('section', { class: 'sga-card wide', dataset: { gradiaQuickSetting: 'novel_draft_mode' } }, [`);

  rep('gradia_quick_length_label',
`      guiEl('h3', { text: '초안 길이' }),`,
`      guiEl('h3', { text: '초안 분량' }),
      guiEl('div', { class: 'sga-note', text: '기존 초안 길이 preset 또는 사용자 지정 최소·최대 글자 수를 사용합니다.' }),`);

  rep('gradia_quick_revert_action',
`    guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn good', text: Gui.dirty ? '빠른 설정 저장' : '저장됨', disabled: !Gui.dirty, onClick: saveGuiState })])`,
`    guiEl('div', { class: 'sga-actions' }, [
      guiEl('button', { class: 'sga-btn', text: '저장값으로 되돌리기', disabled: !Gui.dirty, onClick: () => void revertGuiStateFromStorage() }),
      guiEl('button', { class: 'sga-btn good', text: Gui.dirty ? '빠른 설정 저장' : '저장됨', disabled: !Gui.dirty, onClick: saveGuiState })
    ])`);

  rep('shared_home_draft_summary_builders',
`  const buildSharedHomeOverviewPanel = () => {`,
`  const buildGradiaDraftSummaryCard = () => {
    const runtime = gradiaGuiRuntime();
    const lastDraft = LibraMemoryCore.getLastSga?.() || null;
    const pipelineMode = typeof normalizeMultiPipelineMode === 'function' ? normalizeMultiPipelineMode(runtime.multiPipelineMode) : (runtime.multiPipelineMode === 'heavyweight' ? 'heavyweight' : 'lightweight');
    const pipelineLabel = pipelineMode === 'heavyweight' ? '중량' : '경량';
    const summary = \`${'${gradiaWritingModeCopy(runtime.gradiaWritingMode).label}'} · ${'${INTERNAL_DRAFT_LANGUAGE_DEFS[normalizeInternalDraftLanguage(runtime.internalDraftLanguage)]?.label || \'한국어\'}'} · ${'${simpleLengthLabelForRuntime(runtime)}'} · ${'${pipelineLabel}'}\`;
    const result = lastDraft?.draft
      ? \`최근 초안 ${'${Number(lastDraft.draftChars || String(lastDraft.draft).length).toLocaleString(\'ko-KR\')}'}자\`
      : '최근 초안 없음';
    return guiEl('section', { class: 'sga-card wide', dataset: { draftSummary: 'gradia', readOnly: 'true' } }, [
      guiEl('div', { class: 'sga-agent-head' }, [guiEl('div', {}, [guiEl('h3', { text: 'GRADIA 초안 작업공간' }), guiEl('div', { class: 'sga-note', text: summary }), guiEl('small', { class: 'sga-note', text: result })]), libraStatusBadge('읽기 전용 요약', 'good')]),
      guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn primary', text: '초안 설정 열기', onClick: () => { Gui.pipelineHubSection = 'draft'; Gui.gradiaDraftSection = 'quick'; sharedNavigate('pipeline'); } })])
    ]);
  };

  const buildLibraDraftSummaryCard = () => {
    const runtime = gradiaGuiRuntime();
    const mode = normalizeLibraResponseMode(runtime.libraResponseMode, runtime.injectionMode);
    const lastPlanner = LibraMemoryCore.getLastPlanner?.() || null;
    const summary = LIBRA_RESPONSE_MODE_UI[mode]?.label || 'Classic';
    const result = mode === 'classic'
      ? 'Classic은 별도 초안을 생성하지 않고 정본 리콜을 직접 제공합니다.'
      : lastPlanner?.ok === true ? '최근 Planner 제공 결과 있음' : lastPlanner ? '최근 Planner 실행 점검 필요' : '최근 Planner 결과 없음';
    return guiEl('section', { class: 'sga-card wide', dataset: { draftSummary: 'libra', readOnly: 'true' } }, [
      guiEl('div', { class: 'sga-agent-head' }, [guiEl('div', {}, [guiEl('h3', { text: 'LIBRA 초안 작업공간' }), guiEl('div', { class: 'sga-note', text: summary }), guiEl('small', { class: 'sga-note', text: result })]), libraStatusBadge('읽기 전용 요약', 'good')]),
      guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn primary', text: '초안 작업공간 열기', onClick: () => { Gui.pipelineHubSection = 'draft'; Gui.libraDraftSection = 'mode'; sharedNavigate('pipeline'); } })])
    ]);
  };

  const buildActiveDraftSummaryCard = family => family === 'gradia' ? buildGradiaDraftSummaryCard() : buildLibraDraftSummaryCard();

  const buildSharedHomeOverviewPanel = () => {`);

  rep('shared_home_remove_inline_summary',
`    const family = activeGuiResponseFamily();
    const runtime = gradiaGuiRuntime();
    const memoryCount = Number(view.snapshot.totals?.memories ?? guiAsArray(view.snapshot.memories).length);
    const draftSummary = family === 'gradia'
      ? \`${'${gradiaWritingModeCopy(runtime.gradiaWritingMode).label}'} · ${'${INTERNAL_DRAFT_LANGUAGE_DEFS[normalizeInternalDraftLanguage(runtime.internalDraftLanguage)]?.label || \'한국어\'}'} · ${'${simpleLengthLabelForRuntime(runtime)}'}\`
      : \`${'${LIBRA_RESPONSE_MODE_UI[normalizeResponseInjectionMode(runtime.injectionMode)]?.label || \'Classic\'}'}\`;`,
`    const family = activeGuiResponseFamily();
    const memoryCount = Number(view.snapshot.totals?.memories ?? guiAsArray(view.snapshot.memories).length);`);

  rep('shared_home_use_draft_summary_builder',
`      guiEl('section', { class: 'sga-card wide', dataset: { draftSummary: family, readOnly: 'true' } }, [
        guiEl('div', { class: 'sga-agent-head' }, [guiEl('div', {}, [guiEl('h3', { text: \`${'${family === \'gradia\' ? \'GRADIA\' : \'LIBRA\'}'} 초안 작업공간\` }), guiEl('div', { class: 'sga-note', text: draftSummary })]), libraStatusBadge('읽기 전용 요약', 'good')]),
        guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn primary', text: '초안 작업공간 열기', onClick: () => { Gui.pipelineHubSection = 'draft'; sharedNavigate('pipeline'); } })])
      ]),`,
`      buildActiveDraftSummaryCard(family),`);

  rep('shared_pipeline_wrappers',
`  const buildSharedPipelineShellPanel = () => {
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
  };`,
`  const buildMemoryPipelinePanel = () => buildAgentsTab(Gui.memoryPipelineStage);

  const buildLibraDraftWorkspacePanel = () => {
    Gui.libraDraftSection = normalizeHubChoice(Gui.libraDraftSection, LIBRA_DRAFT_SECTIONS, 'mode');
    const definitions = [{ id: 'mode', label: 'Classic · Planner' }, { id: 'results', label: '제공 결과' }];
    const panel = Gui.libraDraftSection === 'results'
      ? buildLibraResponseResultPanel({ compactView: false })
      : buildLibraResponseModeSettingsPanel();
    return guiEl('div', { class: 'sga-flow-section', dataset: { draftFamily: 'libra' } }, [
      buildLibraHubTabs(definitions, Gui.libraDraftSection, value => { Gui.libraDraftSection = value; }, 'LIBRA 초안 작업공간'),
      panel
    ]);
  };

  const buildGradiaDraftWorkspacePanel = () => {
    Gui.gradiaDraftSection = normalizeHubChoice(Gui.gradiaDraftSection, GRADIA_DRAFT_SECTIONS, 'quick');
    const definitions = [
      { id: 'quick', label: '빠른 설정' }, { id: 'stages', label: '단계' }, { id: 'skills', label: '스킬' },
      { id: 'output', label: '출력' }, { id: 'results', label: '결과' }
    ];
    const panel = Gui.gradiaDraftSection === 'stages' ? buildGradiaPipelinePanel()
      : Gui.gradiaDraftSection === 'skills' ? buildGradiaSkillSettings()
        : Gui.gradiaDraftSection === 'output' ? buildGradiaOutputPanel()
          : Gui.gradiaDraftSection === 'results' ? buildGradiaResultsPanel()
            : buildGradiaDraftSettingsPanel();
    return guiEl('div', { class: 'sga-flow-section', dataset: { draftFamily: 'gradia' } }, [
      buildLibraHubTabs(definitions, Gui.gradiaDraftSection, value => { Gui.gradiaDraftSection = value; }, 'GRADIA 초안 작업공간'),
      panel
    ]);
  };

  const buildDraftWorkspacePanel = family => family === 'gradia' ? buildGradiaDraftWorkspacePanel() : buildLibraDraftWorkspacePanel();

  const buildSharedPipelineShellPanel = () => {
    Gui.pipelineHubSection = normalizeHubChoice(Gui.pipelineHubSection, SHARED_PIPELINE_HUB_SECTIONS, 'memory_pipeline');
    const definitions = [Object.freeze({ id: 'memory_pipeline', label: '기억 생성' }), Object.freeze({ id: 'draft', label: '초안 작성' })];
    const panel = Gui.pipelineHubSection === 'memory_pipeline'
      ? buildMemoryPipelinePanel()
      : buildDraftWorkspacePanel(activeGuiResponseFamily());
    return guiEl('div', { class: 'sga-flow-section' }, [
      buildLibraHubTabs(definitions, Gui.pipelineHubSection, value => { Gui.pipelineHubSection = value; }, '파이프라인 내부 페이지'),
      panel
    ]);
  };

  const buildSharedPipelineHubPanel = () => buildSharedPipelineShellPanel();`);

  rep('shared_trace_layer_split',
`      guiEl('section', { class: 'sga-rail-card' }, [
        guiEl('h3', { text: '최근 리콜' }),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '선택' }), guiEl('strong', { text: String(delivery.selectedMemories ?? guiAsArray(lastRecall?.memories).length) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '초안 전달' }), guiEl('strong', { text: String(delivery.processorMemories || delivery.injectedMemories || 0) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '질의 유형' }), guiEl('strong', { text: text(lastRecall?.query?.queryType || '-') })])
      ]),
      guiEl('section', { class: 'sga-rail-card', dataset: { draftFamily: family } }, [
        guiEl('h3', { text: \`${'${family === \'gradia\' ? \'GRADIA\' : \'LIBRA\'}'} 초안\` }),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '모드' }), guiEl('strong', { text: family === 'gradia' ? gradiaWritingModeCopy(runtime.gradiaWritingMode).label : (LIBRA_RESPONSE_MODE_UI[normalizeResponseInjectionMode(runtime.injectionMode)]?.label || 'Classic') })]),`,
`      guiEl('section', { class: 'sga-rail-card', dataset: { traceLayer: 'recall' } }, [
        guiEl('h3', { text: '공통 리콜' }),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '선택' }), guiEl('strong', { text: String(delivery.selectedMemories ?? guiAsArray(lastRecall?.memories).length) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '질의 유형' }), guiEl('strong', { text: text(lastRecall?.query?.queryType || '-') })])
      ]),
      guiEl('section', { class: 'sga-rail-card', dataset: { draftFamily: family, traceLayer: 'delivery_draft' } }, [
        guiEl('h3', { text: \`${'${family === \'gradia\' ? \'GRADIA\' : \'LIBRA\'}'} 전달 · 초안\` }),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '모드' }), guiEl('strong', { text: family === 'gradia' ? gradiaWritingModeCopy(runtime.gradiaWritingMode).label : (LIBRA_RESPONSE_MODE_UI[normalizeResponseInjectionMode(runtime.injectionMode)]?.label || 'Classic') })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '리콜 제공' }), guiEl('strong', { text: String(delivery.processorMemories || delivery.injectedMemories || 0) })]),`);

  rep('topbar_revert_action',
`        guiEl('span', { class: 'sga-dirty', dataset: { dirty: String(Gui.dirty), dirtyBadge: 'true' }, text: Gui.dirty ? '저장되지 않은 변경' : '저장됨' }),
        guiEl('button', { class: 'sga-btn good', text: '설정 저장', onClick: async () => {`,
`        guiEl('span', { class: 'sga-dirty', dataset: { dirty: String(Gui.dirty), dirtyBadge: 'true' }, text: Gui.dirty ? '저장되지 않은 변경' : '저장됨' }),
        guiEl('button', { class: 'sga-btn', text: 'GUI 변경 되돌리기', disabled: !Gui.dirty, onClick: async () => {
          if (typeof confirm === 'function' && !confirm('저장하지 않은 초안·GUI 설정 변경을 마지막 저장값으로 되돌릴까요?')) return;
          try {
            guiSetStatus('저장값을 다시 읽고 있습니다…', false, true);
            await revertGuiStateFromStorage();
          } catch (error) {
            guiSetStatus(error.message || String(error), true, true);
          }
        } }),
        guiEl('button', { class: 'sga-btn good', text: '설정 저장', onClick: async () => {`);

  return { source, labels };
};
