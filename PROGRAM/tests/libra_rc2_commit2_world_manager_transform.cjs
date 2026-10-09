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

  rep('world_manager_selection_state',
`    libraDraftSection: 'mode',
    gradiaDraftSection: 'quick',
    libraSidebarSection: 'home',`,
`    libraDraftSection: 'mode',
    gradiaDraftSection: 'quick',
    worldManagerSelectedCharacterId: '',
    worldManagerSelectedRelationshipId: '',
    worldManagerSelectedWorldId: '',
    worldManagerSelectedArcId: '',
    libraSidebarSection: 'home',`);

  replaceRange('shared_memory_sections',
    '  const buildLibraMemoryHubPanel = () => {',
    '  const buildLibraPromptHubPanel = () =>',
`  const buildLibraMemoryHubPanel = () => {
    Gui.memoryHubSection = normalizeHubChoice(Gui.memoryHubSection, SHARED_MEMORY_HUB_SECTIONS, 'memories');
    const definitions = [
      Object.freeze({ id: 'memories', label: '정본 메모리' }),
      Object.freeze({ id: 'recall', label: '이번 턴 리콜' }),
      Object.freeze({ id: 'runs', label: '실행 기록' })
    ];
    const panel = Gui.memoryHubSection === 'recall' ? buildLibraRecallPanel()
      : Gui.memoryHubSection === 'runs' ? buildLibraRunsPanel()
        : buildLibraMemoriesPanel();
    return guiEl('div', { class: 'sga-flow-section', dataset: { sharedMemory: 'true' } }, [
      buildLibraHubTabs(definitions, Gui.memoryHubSection, sectionId => { Gui.memoryHubSection = sectionId; }, '공통 기억 내부 페이지'), panel
    ]);
  };

`);

  const worldManagerOverlay = `  const worldManagerSnapshotView = () => {
    const snapshot = LibraMemoryCore.peekSnapshot() || {};
    const head = snapshot.continuityState && typeof snapshot.continuityState === 'object' ? snapshot.continuityState : null;
    return {
      snapshot,
      head,
      throughTurn: Number(head?.throughTurn || 0),
      characters: guiAsArray(head?.characters),
      relationships: guiAsArray(head?.relationships),
      world: guiAsArray(head?.world),
      narrative: guiAsObject(head?.narrative),
      domainStatus: guiAsObject(head?.domainStatus),
      basis: guiAsObject(head?.basis)
    };
  };

  const worldManagerDomainCopy = (view, domain, label) => {
    const row = guiAsObject(view.domainStatus?.[domain]);
    const status = row.status === 'ready' ? '최신' : row.status === 'not_updated' ? '마지막 확인값' : row.status === 'partial' ? '부분 상태' : '생성 대기';
    const turn = Number(row.throughTurn || view.throughTurn || 0);
    return { label, status, turn, reason: text(row.reason || ''), ready: row.status === 'ready' };
  };

  const buildWorldManagerSnapshotNotice = (view, domain, label, count) => {
    const copy = worldManagerDomainCopy(view, domain, label);
    if (!view.head) return guiEl('div', { class: 'sga-callout', dataset: { snapshotOnly: 'true', worldDomain: domain } }, [
      guiEl('strong', { text: \`아직 \${label} Current Head가 없습니다.\` }),
      guiEl('div', { text: '다음 5턴 정본 분석이 완료되면 이 화면에 표시됩니다.' })
    ]);
    return guiEl('div', { class: \`sga-callout\${copy.ready ? '' : ' warn'}\`, dataset: { snapshotOnly: 'true', worldDomain: domain } }, [
      guiEl('strong', { text: \`\${label} · \${copy.status} · \${Number(count || 0)}개\` }),
      guiEl('div', { text: \`정본 기준 T\${copy.turn || view.throughTurn} · \${libraFormatTime(view.head.updatedAt)}\` }),
      copy.reason ? guiEl('div', { class: 'sga-note', text: copy.reason }) : null,
      guiEl('div', { class: 'sga-note', text: '이 첫 화면은 현재 snapshot만 읽습니다. History와 Correction Journal은 사용자가 해당 기능을 열기 전에는 조회하지 않습니다.' })
    ]);
  };

  const worldManagerRowIdentity = (domain, row, index) => {
    if (row?.id) return String(row.id);
    if (domain === 'relationships') return [row?.subjectId || row?.subjectName, row?.targetId || row?.targetName, row?.dimension, index].join('::');
    return \`\${domain}:\${index}\`;
  };

  const buildWorldManagerRecordBrowser = ({ domain, rows, selectionKey, titleFor, subtitleFor, detailFor }) => {
    const normalized = guiAsArray(rows);
    if (!normalized.length) return guiEl('section', { class: 'sga-card wide', dataset: { worldDomainList: domain, snapshotOnly: 'true' } }, [guiEl('div', { class: 'sga-note', text: '현재 기록 없음' })]);
    const identities = normalized.map((row, index) => worldManagerRowIdentity(domain, row, index));
    let selectedId = String(Gui[selectionKey] || '');
    if (!identities.includes(selectedId)) selectedId = identities[0];
    Gui[selectionKey] = selectedId;
    const selectedIndex = Math.max(0, identities.indexOf(selectedId));
    const selected = normalized[selectedIndex];
    return guiEl('div', { class: 'libra-memory-layout', dataset: { worldDomainBrowser: domain, snapshotOnly: 'true' } }, [
      guiEl('section', { class: 'sga-card libra-memory-list-panel' }, [
        guiEl('div', { class: 'sga-list-items' }, normalized.map((row, index) => guiEl('button', {
          class: \`sga-card libra-memory-card\${identities[index] === selectedId ? ' selected' : ''}\`, type: 'button',
          dataset: { selected: String(identities[index] === selectedId), worldRecordId: identities[index] },
          'aria-pressed': String(identities[index] === selectedId),
          onClick: () => { Gui[selectionKey] = identities[index]; queueGuiNavigationRender(); }
        }, [guiEl('strong', { text: titleFor(row, index) }), guiEl('small', { class: 'sga-note', text: subtitleFor(row, index) })])))
      ]),
      guiEl('section', { class: 'sga-card libra-memory-detail-panel', dataset: { worldRecordDetail: selectedId, readOnly: 'true' } }, [
        guiEl('h3', { text: titleFor(selected, selectedIndex) }),
        guiEl('div', { class: 'sga-note', text: subtitleFor(selected, selectedIndex) }),
        guiEl('pre', { class: 'sga-live-result-code', text: JSON.stringify(detailFor(selected, selectedIndex), null, 2) })
      ])
    ]);
  };

  const buildWorldManagerCharactersPanel = () => {
    const view = worldManagerSnapshotView();
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'characters', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'characters', '인물', view.characters.length),
      buildWorldManagerRecordBrowser({
        domain: 'characters', rows: view.characters, selectionKey: 'worldManagerSelectedCharacterId',
        titleFor: row => text(row?.name || row?.id || '이름 없는 인물'),
        subtitleFor: row => guiAsArray(row?.aliases).length ? \`별칭 · \${guiAsArray(row.aliases).join(', ')}\` : \`ID · \${text(row?.id || '-')}\`,
        detailFor: row => ({ id: row?.id || '', name: row?.name || '', aliases: guiAsArray(row?.aliases), state: guiAsObject(row?.state), evidence: row?.evidence || null })
      })
    ]);
  };

  const buildWorldManagerRelationshipsPanel = () => {
    const view = worldManagerSnapshotView();
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'relationships', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'relationships', '관계', view.relationships.length),
      buildWorldManagerRecordBrowser({
        domain: 'relationships', rows: view.relationships, selectionKey: 'worldManagerSelectedRelationshipId',
        titleFor: row => \`\${text(row?.subjectName || row?.subjectId || '?')} → \${text(row?.targetName || row?.targetId || '?')}\`,
        subtitleFor: row => \`\${text(row?.dimension || 'other')} · \${text(row?.state || '(값 없음)')}\`,
        detailFor: row => ({ subjectId: row?.subjectId || '', targetId: row?.targetId || '', dimension: row?.dimension || 'other', state: row?.state || '', certainty: row?.certainty || 'confirmed', evidence: row?.evidence || null })
      })
    ]);
  };

  const buildWorldManagerWorldPanel = () => {
    const view = worldManagerSnapshotView();
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'world', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'world', '세계', view.world.length),
      buildWorldManagerRecordBrowser({
        domain: 'world', rows: view.world, selectionKey: 'worldManagerSelectedWorldId',
        titleFor: row => text(row?.name || row?.id || '이름 없는 세계 항목'),
        subtitleFor: row => \`\${text(row?.kind || 'other')} · \${text(row?.id || '-')}\`,
        detailFor: row => ({ id: row?.id || '', name: row?.name || '', kind: row?.kind || 'other', state: guiAsObject(row?.state), evidence: row?.evidence || null })
      })
    ]);
  };

  const buildWorldManagerNarrativeCurrentPanel = () => {
    const view = worldManagerSnapshotView();
    const narrative = view.narrative;
    const arcs = guiAsArray(narrative.arcs);
    const threads = guiAsArray(narrative.threads);
    const locks = guiAsArray(narrative.locks);
    const motifs = guiAsArray(narrative.motifs);
    const turningPoints = guiAsArray(narrative.turningPoints);
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'narrative', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'narrative', '내러티브', arcs.length + threads.length),
      guiEl('section', { class: 'sga-card wide', dataset: { narrativeCurrentHead: 'true', readOnly: 'true' } }, [
        guiEl('h3', { text: '현재까지 실제로 성립한 이야기' }),
        guiEl('div', { text: text(narrative.summary || '현재 내러티브 요약 없음') }),
        narrative.momentum ? guiEl('div', { class: 'sga-callout', text: \`현재 압력 / 모멘텀 · \${text(narrative.momentum)}\` }) : null,
        guiEl('div', { class: 'sga-summary-table' }, [
          guiEl('span', { text: '활성 Arc' }), guiEl('strong', { text: String(arcs.filter(item => item?.status === 'active').length) }),
          guiEl('span', { text: '열린 Thread' }), guiEl('strong', { text: String(threads.filter(item => item?.status === 'open').length) }),
          guiEl('span', { text: '활성 Lock' }), guiEl('strong', { text: String(locks.filter(item => item?.status !== 'released').length) }),
          guiEl('span', { text: '갱신 Turn' }), guiEl('strong', { text: \`T\${Number(narrative.updatedThroughTurn || view.throughTurn || 0)}\` })
        ])
      ]),
      buildWorldManagerRecordBrowser({
        domain: 'narrative_arcs', rows: arcs, selectionKey: 'worldManagerSelectedArcId',
        titleFor: row => text(row?.title || row?.summary || row?.id || '이름 없는 Arc'),
        subtitleFor: row => \`\${text(row?.status || 'active')} · \${text(row?.phase || 'developing')}\`,
        detailFor: row => row || {}
      }),
      guiLazyDetails({ class: 'sga-card wide', open: false }, guiEl('summary', {}, [guiEl('strong', { text: 'Thread · Lock · Motif · Turning Point' }), guiEl('span', { text: String(threads.length + locks.length + motifs.length + turningPoints.length) })]), () => guiEl('pre', { class: 'sga-live-result-code', text: JSON.stringify({ threads, locks, motifs, turningPoints }, null, 2) }))
    ]);
  };

  const buildWorldManagerNarrativePanel = () => {
    Gui.narrativeHubSection = ['current', 'direction', 'history'].includes(Gui.narrativeHubSection) ? Gui.narrativeHubSection : 'current';
    const definitions = [{ id: 'current', label: '현재 내러티브' }, { id: 'direction', label: '앞으로의 방향' }, { id: 'history', label: '기록 · 교정' }];
    const pending = Gui.narrativeHubSection === 'direction'
      ? guiEl('div', { class: 'sga-callout', dataset: { narrativeDirectionPending: 'true' }, text: '앞으로의 방향은 Current Head와 분리된 사용자 권위입니다. 다음 구현 단계에서 기존 Planner Direction 저장값의 readback과 함께 연결합니다.' })
      : Gui.narrativeHubSection === 'history'
        ? guiEl('div', { class: 'sga-callout', dataset: { narrativeHistoryPending: 'true' }, text: 'History와 Correction Journal은 명시적으로 이 화면을 연 뒤에만 페이지 단위로 조회하도록 다음 구현 단계에서 연결합니다.' })
        : buildWorldManagerNarrativeCurrentPanel();
    return guiEl('div', { class: 'sga-flow-section' }, [buildLibraHubTabs(definitions, Gui.narrativeHubSection, value => { Gui.narrativeHubSection = value; }, '내러티브 내부 페이지'), pending]);
  };

  const buildSharedHomeOverviewPanel = () => {
    const view = worldManagerSnapshotView();
    const manifest = guiAsObject(view.snapshot.manifest);
    const family = activeGuiResponseFamily();
    const runtime = gradiaGuiRuntime();
    const memoryCount = Number(view.snapshot.totals?.memories ?? guiAsArray(view.snapshot.memories).length);
    const draftSummary = family === 'gradia'
      ? \`\${gradiaWritingModeCopy(runtime.gradiaWritingMode).label} · \${INTERNAL_DRAFT_LANGUAGE_DEFS[normalizeInternalDraftLanguage(runtime.internalDraftLanguage)]?.label || '한국어'} · \${simpleLengthLabelForRuntime(runtime)}\`
      : \`\${LIBRA_RESPONSE_MODE_UI[normalizeResponseInjectionMode(runtime.injectionMode)]?.label || 'Classic'}\`;
    const domainCards = [
      ['characters', '인물', view.characters.length], ['relationships', '관계', view.relationships.length],
      ['world', '세계', view.world.length], ['narrative', '내러티브', guiAsArray(view.narrative.arcs).length + guiAsArray(view.narrative.threads).length]
    ];
    return guiEl('div', { class: 'sga-flow-section shared-home-overview', dataset: { snapshotOnly: 'true' } }, [
      guiEl('section', { class: 'sga-card wide' }, [
        guiEl('div', { class: 'sga-agent-head' }, [guiEl('div', {}, [guiEl('h3', { text: '기억 → 현재 세계 → 초안' }), guiEl('div', { class: 'sga-note', text: 'LIBRA와 GRADIA가 같은 정본·리콜·월드 매니저를 보고, 공통 리콜 이후의 초안 작업공간만 달라집니다.' })]), libraStatusBadge(view.head ? '공통 Current Head' : '생성 대기', view.head ? 'good' : 'warn')]),
        guiEl('div', { class: 'sga-summary-table' }, [
          guiEl('span', { text: '정본 메모리' }), guiEl('strong', { text: String(memoryCount) }),
          guiEl('span', { text: '정본화 Turn' }), guiEl('strong', { text: \`T\${Number(manifest.frontiers?.committedTurn || 0)}\` }),
          guiEl('span', { text: '월드 매니저 기준' }), guiEl('strong', { text: view.head ? \`T\${view.throughTurn}\` : '대기' }),
          guiEl('span', { text: '초안 엔진' }), guiEl('strong', { text: family === 'gradia' ? 'GRADIA' : 'LIBRA' })
        ])
      ]),
      guiEl('section', { class: 'sga-card wide' }, [
        guiEl('h3', { text: '현재 세계' }),
        guiEl('div', { class: 'libra-home-pipeline-grid' }, domainCards.map(([id, label, count]) => guiEl('button', { class: 'libra-home-stage-card', type: 'button', onClick: () => sharedNavigate(id) }, [guiEl('strong', { text: label }), guiEl('span', { class: 'sga-metric', text: String(count) }), guiEl('small', { class: 'sga-note', text: worldManagerDomainCopy(view, id, label).status })])))
      ]),
      guiEl('section', { class: 'sga-card wide', dataset: { draftSummary: family, readOnly: 'true' } }, [
        guiEl('div', { class: 'sga-agent-head' }, [guiEl('div', {}, [guiEl('h3', { text: \`\${family === 'gradia' ? 'GRADIA' : 'LIBRA'} 초안 작업공간\` }), guiEl('div', { class: 'sga-note', text: draftSummary })]), libraStatusBadge('읽기 전용 요약', 'good')]),
        guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn primary', text: '초안 작업공간 열기', onClick: () => { Gui.pipelineHubSection = 'draft'; sharedNavigate('pipeline'); } })])
      ]),
      view.snapshot.error ? guiEl('div', { class: 'sga-callout danger', text: view.snapshot.error }) : null
    ]);
  };

  const buildSharedHeaderStatusPanel = () => {
    const view = worldManagerSnapshotView();
    const manifest = guiAsObject(view.snapshot.manifest);
    const family = activeGuiResponseFamily();
    const runtime = gradiaGuiRuntime();
    const work = Runtime.pipelineWorkStatus || {};
    const items = [
      ['정본 기억', String(Number(view.snapshot.totals?.memories ?? guiAsArray(view.snapshot.memories).length)), \`T\${Number(manifest.frontiers?.committedTurn || 0)}까지\`],
      ['월드 매니저', view.head ? \`T\${view.throughTurn}\` : '대기', view.head ? \`인물 \${view.characters.length} · 관계 \${view.relationships.length} · 세계 \${view.world.length}\` : '첫 정본 분석 뒤 생성'],
      ['초안 엔진', family === 'gradia' ? 'GRADIA' : 'LIBRA', family === 'gradia' ? gradiaWritingModeCopy(runtime.gradiaWritingMode).label : (LIBRA_RESPONSE_MODE_UI[normalizeResponseInjectionMode(runtime.injectionMode)]?.label || 'Classic')],
      ['현재 작업', work.busy ? '실행 중' : Runtime.inFlight ? '기억 분석 중' : '대기', work.currentStage ? pipelineWorkStageLabel(work.currentStage) : '진행 중인 작업 없음']
    ];
    return guiEl('section', { class: 'libra-header-status shared-header-status', 'aria-label': '공통 기억과 현재 초안 상태' }, items.map(([label, value, detail]) => guiEl('div', { class: 'libra-header-status-cell' }, [guiEl('span', { text: label }), guiEl('strong', { text: value }), guiEl('small', { text: detail })])));
  };

`;

  rep('world_manager_snapshot_overlay',
    '  const buildSharedPipelineShellPanel = () => {',
    `${worldManagerOverlay}  const buildSharedPipelineShellPanel = () => {`);

  rep('shared_home_snapshot_route',
`    return page('홈', '공통 기억과 월드 매니저에서 선택한 초안 엔진으로 이어집니다.', family === 'gradia' ? buildGradiaHomePanel() : buildLibraHomePanel());`,
`    return page('홈', '공통 기억과 월드 매니저에서 선택한 초안 엔진으로 이어집니다.', buildSharedHomeOverviewPanel());`);
  rep('characters_snapshot_route',
`    if (section === 'characters') return page('인물', '월드 매니저의 현재 인물 상태입니다.', buildLibraContinuityStatePanel());`,
`    if (section === 'characters') return page('인물', '정본에서 재생된 인물 Current Head를 두 모드에서 함께 확인합니다.', buildWorldManagerCharactersPanel());`);
  rep('relationships_snapshot_route',
`    if (section === 'relationships') return page('관계', '월드 매니저의 현재 관계 상태입니다.', buildLibraContinuityStatePanel());`,
`    if (section === 'relationships') return page('관계', 'A → B 방향별 현재 관계를 두 모드에서 함께 확인합니다.', buildWorldManagerRelationshipsPanel());`);
  rep('world_snapshot_route',
`    if (section === 'world') return page('세계', '월드 매니저의 현재 세계 상태입니다.', buildLibraContinuityStatePanel());`,
`    if (section === 'world') return page('세계', '장소·조직·사물·규칙 등 현재 세계 상태를 두 모드에서 함께 확인합니다.', buildWorldManagerWorldPanel());`);
  rep('narrative_snapshot_route',
`    if (section === 'narrative') return page('내러티브', '현재 이야기 상태와 향후 방향을 관리합니다.', buildLibraStoryArcPanel());`,
`    if (section === 'narrative') return page('내러티브', '현재까지 실제로 성립한 이야기와 향후 사용자 방향을 권위별로 분리합니다.', buildWorldManagerNarrativePanel());`);

  replaceRange('shared_memory_insight_rail',
    '  const buildInsightRail = () => {',
    '  const renderActiveTab = () =>',
`  const buildInsightRail = () => {
    const view = worldManagerSnapshotView();
    const manifest = guiAsObject(view.snapshot.manifest);
    const lastRecall = LibraMemoryCore.getLastRecall();
    const delivery = guiAsObject(lastRecall?.delivery);
    const family = activeGuiResponseFamily();
    const runtime = gradiaGuiRuntime();
    const lastDraft = family === 'gradia' ? LibraMemoryCore.getLastSga() : null;
    return guiEl('aside', { class: 'sga-insight-rail shared-insight-rail' }, [
      guiEl('section', { class: 'sga-rail-card' }, [
        guiEl('h3', { text: '공통 기억' }),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '관찰된 턴' }), guiEl('strong', { text: String(manifest.frontiers?.observedTurn || 0) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '정본화된 턴' }), guiEl('strong', { text: String(manifest.frontiers?.committedTurn || 0) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '정본 메모리' }), guiEl('strong', { text: String(view.snapshot.totals?.memories ?? guiAsArray(view.snapshot.memories).length) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: 'Current Head' }), guiEl('strong', { text: view.head ? \`T\${view.throughTurn}\` : '-' })])
      ]),
      guiEl('section', { class: 'sga-rail-card' }, [
        guiEl('h3', { text: '최근 리콜' }),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '선택' }), guiEl('strong', { text: String(delivery.selectedMemories ?? guiAsArray(lastRecall?.memories).length) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '초안 전달' }), guiEl('strong', { text: String(delivery.processorMemories || delivery.injectedMemories || 0) })]),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '질의 유형' }), guiEl('strong', { text: text(lastRecall?.query?.queryType || '-') })])
      ]),
      guiEl('section', { class: 'sga-rail-card', dataset: { draftFamily: family } }, [
        guiEl('h3', { text: \`\${family === 'gradia' ? 'GRADIA' : 'LIBRA'} 초안\` }),
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '모드' }), guiEl('strong', { text: family === 'gradia' ? gradiaWritingModeCopy(runtime.gradiaWritingMode).label : (LIBRA_RESPONSE_MODE_UI[normalizeResponseInjectionMode(runtime.injectionMode)]?.label || 'Classic') })]),
        family === 'gradia' ? guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '목표' }), guiEl('strong', { text: simpleLengthLabelForRuntime(runtime) })]) : null,
        family === 'gradia' ? guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '최근 초안' }), guiEl('strong', { text: lastDraft?.draft ? \`\${Number(lastDraft.draftChars || String(lastDraft.draft).length).toLocaleString('ko-KR')}자\` : '-' })]) : null,
        guiEl('div', { class: 'sga-rail-stat' }, [guiEl('span', { text: '변경' }), guiEl('strong', { text: Gui.dirty ? '저장 필요' : '저장됨' })])
      ].filter(Boolean))
    ]);
  };

`);

  rep('shared_header_status_region',
`      const node = responseFamily === 'gradia' ? buildGradiaHeaderStatusPanel() : buildLibraHeaderStatusPanel();`,
`      const node = buildSharedHeaderStatusPanel();`);

  return { source, labels };
};
