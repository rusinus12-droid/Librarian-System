'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  rep('ooc_family_domain_policy',
`    const allowedDomains = gradiaView ? GRADIA_PROMPT_DOMAINS : PROMPT_STUDIO_OOC_DOMAIN_IDS;`,
`    const allowedDomains = Array.isArray(options.allowedDomains) && options.allowedDomains.length
      ? options.allowedDomains.filter(domain => PROMPT_STUDIO_OOC_DOMAIN_IDS.includes(domain))
      : gradiaView ? ['memory', 'sga'] : ['memory', 'planner'];`);

  rep('ooc_selected_domain_policy',
`      const preferredDomain = GRADIA_PROMPT_DOMAINS.includes(Gui.promptStudioDomain) ? Gui.promptStudioDomain : allowedDomains[0];`,
`      const preferredDomain = allowedDomains.includes(Gui.promptStudioDomain) ? Gui.promptStudioDomain : allowedDomains[0];`);

  rep('prompt_studio_family_domain_policy',
`    const allowedDomains = gradiaView ? GRADIA_PROMPT_DOMAINS : ['memory', 'planner', 'sga', 'input_writer'];`,
`    const allowedDomains = Array.isArray(options.allowedDomains) && options.allowedDomains.length
      ? options.allowedDomains.filter(domain => PROMPT_STUDIO_OOC_DOMAIN_IDS.includes(domain))
      : gradiaView ? ['memory', 'sga'] : ['memory', 'planner'];`);

  rep('prompt_studio_allowed_fallback',
`    if (!allowedDomains.includes(domain)) domain = gradiaView ? 'sga' : 'memory';`,
`    if (!allowedDomains.includes(domain)) domain = allowedDomains[0] || 'memory';`);

  rep('prompt_studio_filtered_all_export',
`          gradiaView ? null : guiEl('button', { class: 'sga-btn', type: 'button', text: '전체 프리셋 JSON', onClick: () => { Gui.promptStudioExportScope = 'all'; Gui.promptStudioExportText = JSON.stringify(promptStudioExportPayload('all'), null, 2); renderSettingsGui(); } }),`,
`          allowedDomains.length < PROMPT_STUDIO_OOC_DOMAIN_IDS.length ? null : guiEl('button', { class: 'sga-btn', type: 'button', text: '전체 프리셋 JSON', onClick: () => { Gui.promptStudioExportScope = 'all'; Gui.promptStudioExportText = JSON.stringify(promptStudioExportPayload('all'), null, 2); renderSettingsGui(); } }),`);

  rep('prompt_studio_filtered_file_export',
`          guiEl('button', { class: 'sga-btn', type: 'button', text: 'JSON 파일 저장', onClick: () => { const scope = gradiaView ? 'selected' : Gui.promptStudioExportScope === 'all' ? 'all' : 'selected'; const payload = promptStudioExportPayload(scope); Gui.promptStudioExportText = JSON.stringify(payload, null, 2); downloadJson(\`\${familyLabel}_prompt_profiles_\${scope}_\${new Date().toISOString().replace(/[:.]/g, '-')}.json\`, payload); } }),`,
`          guiEl('button', { class: 'sga-btn', type: 'button', text: 'JSON 파일 저장', onClick: () => { const scope = allowedDomains.length === PROMPT_STUDIO_OOC_DOMAIN_IDS.length && Gui.promptStudioExportScope === 'all' ? 'all' : 'selected'; const payload = promptStudioExportPayload(scope); Gui.promptStudioExportText = JSON.stringify(payload, null, 2); downloadJson(\`\${familyLabel}_prompt_profiles_\${scope}_\${new Date().toISOString().replace(/[:.]/g, '-')}.json\`, payload); } }),`);

  rep('prompt_studio_filtered_import',
`        guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn good', type: 'button', text: '붙여넣은 JSON 가져오기', onClick: async () => { try { await importPromptStudioJson(gradiaView ? { allowedDomains: GRADIA_PROMPT_DOMAINS } : {}); } catch (error) { guiSetStatus(error?.message || String(error), true, true); } } })])`,
`        guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn good', type: 'button', text: '붙여넣은 JSON 가져오기', onClick: async () => { try { await importPromptStudioJson({ allowedDomains }); } catch (error) { guiSetStatus(error?.message || String(error), true, true); } } })])`);

  rep('prompt_studio_filtered_import_copy',
`        fieldNode('붙여넣을 JSON', inputNode(Gui.promptStudioImportText || '', value => { Gui.promptStudioImportText = value; }, { tag: 'textarea', class: 'stage-prompt', placeholder: gradiaView ? 'SGA / Input Writer 프롬프트 프리셋 JSON을 붙여넣으세요.' : 'Memory / Planner / SGA / Input Writer 프롬프트 프리셋 JSON을 붙여넣으세요.' })),`,
`        fieldNode('붙여넣을 JSON', inputNode(Gui.promptStudioImportText || '', value => { Gui.promptStudioImportText = value; }, { tag: 'textarea', class: 'stage-prompt', placeholder: '현재 화면에서 허용된 프롬프트 프리셋 JSON을 붙여넣으세요.' })),`);

  rep('shared_custom_convenience_sections',
`  const SHARED_SETTINGS_HUB_SECTIONS = Object.freeze(['references', 'connections', 'server', 'recovery', 'general']);`,
`  const SHARED_SETTINGS_HUB_SECTIONS = Object.freeze(['references', 'connections', 'server', 'recovery', 'general']);
  const SHARED_CUSTOM_HUB_SECTIONS = Object.freeze(['memory', 'active_draft', 'ooc', 'injection']);
  const SHARED_CONVENIENCE_HUB_SECTIONS = Object.freeze(['input_writer']);`);

  rep('shared_legacy_input_route',
`    if (requested === 'gradia_input' || requested === 'input_writer' || requested === 'input_assist' || requested === 'agent_input_assist') return { pageId: 'convenience' };`,
`    if (requested === 'gradia_input' || requested === 'input_writer' || requested === 'input_assist' || requested === 'agent_input_assist') return { pageId: 'convenience', convenienceHubSection: 'input_writer' };`);

  rep('shared_legacy_prompt_route',
`    if (requested === 'prompt' || requested === 'prompt_studio' || requested === 'gradia_prompt_settings') return { pageId: 'custom', customHubSection: 'settings' };`,
`    if (requested === 'prompt' || requested === 'prompt_studio' || requested === 'gradia_prompt_settings') return { pageId: 'custom', customHubSection: 'active_draft' };`);

  rep('shared_custom_navigation_apply',
`    if (target.customHubSection) Gui.customHubSection = target.customHubSection;
    if (target.narrativeHubSection) Gui.narrativeHubSection = target.narrativeHubSection;`,
`    if (target.customHubSection) Gui.customHubSection = normalizeHubChoice(target.customHubSection, SHARED_CUSTOM_HUB_SECTIONS, 'memory');
    if (target.convenienceHubSection) Gui.convenienceHubSection = normalizeHubChoice(target.convenienceHubSection, SHARED_CONVENIENCE_HUB_SECTIONS, 'input_writer');
    if (target.narrativeHubSection) Gui.narrativeHubSection = target.narrativeHubSection;`);

  rep('input_writer_prompt_stays_in_convenience',
`          guiEl('button', { class: 'sga-btn', type: 'button', text: 'Input Writer 프롬프트 설정', onClick: () => { Gui.promptStudioDomain = 'input_writer'; Gui.promptStudioProfileName = promptStudioActiveName(promptStudioProfiles(), 'input_writer'); Gui.promptStudioStage = normalizeChoice(runtime.inputWriterMode || DEFAULT_INPUT_WRITER_MODE, INPUT_WRITER_PROMPT_PROFILE_MODE_IDS, DEFAULT_INPUT_WRITER_MODE); Gui.promptStudioDraftKey = ''; libraGuiNavigate('prompt_studio'); } }),`,
`          guiEl('button', { class: 'sga-btn', type: 'button', text: 'Input Writer 프롬프트 설정', onClick: () => { Gui.convenienceHubSection = 'input_writer'; Gui.promptStudioDomain = 'input_writer'; Gui.promptStudioProfileName = promptStudioActiveName(promptStudioProfiles(), 'input_writer'); Gui.promptStudioStage = normalizeChoice(runtime.inputWriterMode || DEFAULT_INPUT_WRITER_MODE, INPUT_WRITER_PROMPT_PROFILE_MODE_IDS, DEFAULT_INPUT_WRITER_MODE); Gui.promptStudioDraftKey = ''; Gui.inputWriterPromptEditorOpen = true; queueGuiNavigationRender(); } }),`);

  rep('input_writer_inline_prompt_editor',
`        last.selectedInput ? guiEl('pre', { class: 'sga-live-result-code', text: last.selectedInput }) : null
      ]) : null
    ]);
  };

  const buildAgentsTab = (stageIdFilter = '') => {`,
`        last.selectedInput ? guiEl('pre', { class: 'sga-live-result-code', text: last.selectedInput }) : null
      ]) : null,
      Gui.inputWriterPromptEditorOpen ? guiEl('section', { class: 'sga-flow-section', dataset: { conveniencePrompt: 'input_writer' } }, [
        guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn', type: 'button', text: '프롬프트 편집 닫기', onClick: () => { Gui.inputWriterPromptEditorOpen = false; queueGuiNavigationRender(); } })]),
        buildLibraPromptStudioPanel({ family: gradiaView ? 'gradia' : 'libra', allowedDomains: ['input_writer'] })
      ]) : null
    ]);
  };

  const buildAgentsTab = (stageIdFilter = '') => {`);

  rep('shared_custom_shell',
`  const buildSharedSettingsShellPanel = () => {`,
`  const setSharedCustomPromptDomain = domain => {
    if (Gui.promptStudioDomain === domain) return;
    Gui.promptStudioDomain = domain;
    Gui.promptStudioProfileName = promptStudioActiveName(promptStudioProfiles(), domain);
    Gui.promptStudioStage = domain === 'sga' ? SGA_SHADOW_STAGE_ID : domain === 'memory' ? 'ariadne' : Gui.promptStudioStage;
    Gui.promptStudioDraftKey = '';
    Gui.easyPromptDraftKey = '';
  };

  const buildSharedCustomShellPanel = () => {
    const family = activeGuiResponseFamily();
    const draftDomain = family === 'gradia' ? 'sga' : 'planner';
    Gui.customHubSection = normalizeHubChoice(Gui.customHubSection, SHARED_CUSTOM_HUB_SECTIONS, 'memory');
    const definitions = [
      { id: 'memory', label: '기억 프롬프트' },
      { id: 'active_draft', label: family === 'gradia' ? 'GRADIA 초안 프롬프트' : 'Planner 프롬프트' },
      { id: 'ooc', label: 'OOC Builder' },
      { id: 'injection', label: '이번 턴 적용 결과' }
    ];
    let panel;
    if (Gui.customHubSection === 'memory') {
      setSharedCustomPromptDomain('memory');
      panel = buildLibraPromptStudioPanel({ family, allowedDomains: ['memory'] });
    } else if (Gui.customHubSection === 'active_draft') {
      setSharedCustomPromptDomain(draftDomain);
      panel = buildLibraPromptStudioPanel({ family, allowedDomains: [draftDomain] });
    } else if (Gui.customHubSection === 'ooc') {
      panel = renderPromptStudioOocBuilder({ family });
    } else {
      Gui.promptInjectionSection = family === 'gradia' ? 'sga' : 'planner';
      panel = family === 'gradia' ? buildLibraSgaPanel({ compact: false }) : buildPromptInjectionPanel();
    }
    return guiEl('div', { class: 'sga-flow-section', dataset: { sharedCustom: Gui.customHubSection, draftFamily: family } }, [
      buildLibraHubTabs(definitions, Gui.customHubSection, value => { Gui.customHubSection = value; }, '커스텀 내부 페이지'),
      panel
    ]);
  };

  const buildSharedSettingsShellPanel = () => {`);

  rep('shared_custom_router',
`    if (section === 'custom') return page('커스텀', '기억과 현재 초안 엔진의 커스텀 프롬프트입니다.', family === 'gradia' ? buildGradiaPromptHubPanel() : buildLibraPromptHubPanel());`,
`    if (section === 'custom') return page('커스텀', '공통 기억 프롬프트와 현재 초안 엔진 프롬프트를 권위별로 분리합니다.', buildSharedCustomShellPanel());`);

  return { source, labels };
};
