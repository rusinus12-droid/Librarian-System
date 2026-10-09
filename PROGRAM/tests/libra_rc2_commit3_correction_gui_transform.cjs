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

  rep('world_manager_correction_gui_state',
`    worldManagerSelectedWorldId: '',
    worldManagerSelectedArcId: '',
    libraSidebarSection: 'home',`,
`    worldManagerSelectedWorldId: '',
    worldManagerSelectedArcId: '',
    worldManagerSelectedThreadId: '',
    worldManagerSelectedLockId: '',
    worldManagerEditDraft: null,
    worldManagerEditError: '',
    worldManagerSaving: false,
    libraSidebarSection: 'home',`);

  replaceRange('world_manager_correction_editors',
    '  const worldManagerRowIdentity =',
    '  const buildSharedHomeOverviewPanel = () => {',
`  const worldManagerRowIdentity = (domain, row, index) => {
    if (row?.id) return String(row.id);
    if (domain === 'relationships') return [row?.subjectId || row?.subjectName, row?.targetId || row?.targetName, row?.dimension, index].join('::');
    return String(domain) + ':' + String(index);
  };

  const worldManagerCorrectionId = row => text(row?.correctionProvenance?.correctionId || '');
  const worldManagerCorrectionBadge = row => worldManagerCorrectionId(row)
    ? libraStatusBadge('사용자 교정', 'warn')
    : libraStatusBadge('AI 분석', 'good');
  const worldManagerDraftKey = (domain, row) => String(domain) + '::' + String(row?.id || 'new');
  const worldManagerListText = value => guiAsArray(value).map(item => text(item)).filter(Boolean).join('\\n');
  const worldManagerParseList = value => String(value || '').split(/[\\n,]/).map(item => item.trim()).filter(Boolean);
  const worldManagerParseState = (value, label) => {
    let parsed;
    try { parsed = JSON.parse(String(value || '{}')); }
    catch (_) { throw new Error(String(label || '상태') + ' JSON 형식이 올바르지 않습니다.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(String(label || '상태') + '는 JSON 객체여야 합니다.');
    return parsed;
  };
  const worldManagerInput = (value, onInput, options = {}) => guiEl('input', {
    class: 'sga-input', type: options.type || 'text', value: value ?? '', disabled: options.disabled === true,
    placeholder: options.placeholder || '', onInput: event => onInput(event.target.value)
  });
  const worldManagerTextarea = (value, onInput, options = {}) => guiEl('textarea', {
    class: 'sga-textarea ' + (options.tall ? 'tall' : 'preview'), value: value ?? '', disabled: options.disabled === true,
    placeholder: options.placeholder || '', onInput: event => onInput(event.target.value)
  });
  const worldManagerSelect = (value, items, onInput) => {
    const node=guiEl('select',{class:'sga-select',value:String(value ?? ''),onChange:event=>onInput(event.target.value),onInput:event=>onInput(event.target.value)},optionNodes(items,String(value ?? '')));
    try { node.value=String(value ?? ''); } catch (_) {}
    return node;
  };

  const openWorldManagerCorrectionEditor = (domain, row, view) => {
    const common={
      key:worldManagerDraftKey(domain,row),domain,recordId:text(row?.id||''),anchorTurn:Number(view?.throughTurn||0),
      basisFingerprint:text(view?.basis?.sourceFingerprint||''),supersedes:worldManagerCorrectionId(row),values:{}
    };
    if (domain==='characters') common.values={name:text(row?.name||''),aliases:worldManagerListText(row?.aliases),state:JSON.stringify(guiAsObject(row?.state),null,2)};
    else if (domain==='relationships') common.values={subjectId:text(row?.subjectId||''),targetId:text(row?.targetId||''),subjectName:text(row?.subjectName||''),targetName:text(row?.targetName||''),dimension:text(row?.dimension||'other'),state:text(row?.state||'')};
    else if (domain==='world') common.values={name:text(row?.name||''),kind:text(row?.kind||'other'),aliases:worldManagerListText(row?.aliases),state:JSON.stringify(guiAsObject(row?.state),null,2)};
    else if (domain==='narrative_arc') common.values={title:text(row?.title||''),status:text(row?.status||'active'),phase:text(row?.phase||'developing'),summary:text(row?.summary||''),centralPressure:text(row?.centralPressure||''),participants:worldManagerListText(row?.participants),worldRefs:worldManagerListText(row?.worldRefs)};
    else if (domain==='narrative_thread') common.values={arcId:text(row?.arcId||''),type:text(row?.type||'other'),status:text(row?.status||'open'),summary:text(row?.summary||''),participants:worldManagerListText(row?.participants)};
    else if (domain==='narrative_lock') common.values={status:text(row?.status||'active'),summary:text(row?.summary||'')};
    Gui.worldManagerEditDraft=common; Gui.worldManagerEditError=''; queueGuiNavigationRender();
  };

  const worldManagerCorrectionRequest = draft => {
    const base={anchorTurn:Number(draft.anchorTurn||0),basisFingerprint:text(draft.basisFingerprint||''),supersedes:text(draft.supersedes||'')};
    const values=guiAsObject(draft.values);
    if (draft.domain==='characters') {
      if (!text(values.name)) throw new Error('인물 이름을 입력해 주세요.');
      return {method:'profile',options:{...base,target:{domain:'characters',mode:'profile_patch'},patch:{characters:[{id:draft.recordId,name:text(values.name),aliases:worldManagerParseList(values.aliases),state:worldManagerParseState(values.state,'인물 상태')}]}}};
    }
    if (draft.domain==='relationships') return {method:'profile',options:{...base,target:{domain:'relationships',mode:'profile_patch'},patch:{relationships:[{id:draft.recordId,subjectId:text(values.subjectId),targetId:text(values.targetId),subjectName:text(values.subjectName),targetName:text(values.targetName),dimension:text(values.dimension||'other'),state:text(values.state)}]}}};
    if (draft.domain==='world') {
      if (!text(values.name)) throw new Error('세계 항목 이름을 입력해 주세요.');
      return {method:'profile',options:{...base,target:{domain:'world',mode:'profile_patch'},patch:{world:[{id:draft.recordId,kind:text(values.kind||'other'),name:text(values.name),aliases:worldManagerParseList(values.aliases),state:worldManagerParseState(values.state,'세계 상태')}]}}};
    }
    if (draft.domain==='narrative_arc') {
      if (!text(values.title)) throw new Error('Arc 제목을 입력해 주세요.');
      return {method:'narrative',options:base,patch:{schema:'libra.narrative_patch.v1',source:'user_correction',arcs:[{op:'upsert',id:draft.recordId,title:text(values.title),status:text(values.status||'active'),phase:text(values.phase||'developing'),summary:text(values.summary),centralPressure:text(values.centralPressure),participants:worldManagerParseList(values.participants),worldRefs:worldManagerParseList(values.worldRefs)}]}};
    }
    if (draft.domain==='narrative_thread') {
      if (!text(values.summary)) throw new Error('Thread 내용을 입력해 주세요.');
      return {method:'narrative',options:base,patch:{schema:'libra.narrative_patch.v1',source:'user_correction',threads:[{op:values.status==='resolved'?'resolve':'upsert',id:draft.recordId,arcId:text(values.arcId),type:text(values.type||'other'),status:text(values.status||'open'),summary:text(values.summary),participants:worldManagerParseList(values.participants)}]}};
    }
    if (draft.domain==='narrative_lock') {
      if (!text(values.summary)) throw new Error('Lock 내용을 입력해 주세요.');
      return {method:'narrative',options:base,patch:{schema:'libra.narrative_patch.v1',source:'user_correction',locks:[{op:values.status==='released'?'release':'upsert',id:draft.recordId,status:text(values.status||'active'),summary:text(values.summary)}]}};
    }
    throw new Error('지원하지 않는 교정 대상입니다.');
  };

  const worldManagerHeadHasCorrection = (headValue, draft, correctionId) => {
    const head=guiAsObject(headValue); const idValue=text(correctionId||'');
    const has=rows=>guiAsArray(rows).some(row=>text(row?.correctionProvenance?.correctionId||'')===idValue && (!draft.recordId || text(row?.id||'')===text(draft.recordId)));
    if (draft.domain==='characters') return has(head.characters);
    if (draft.domain==='relationships') return has(head.relationships);
    if (draft.domain==='world') return has(head.world);
    const keyName=draft.domain==='narrative_arc'?'arcs':draft.domain==='narrative_thread'?'threads':'locks';
    return has(head?.narrative?.[keyName]);
  };

  const saveWorldManagerCorrectionDraft = async () => {
    if (Gui.worldManagerSaving || !Gui.worldManagerEditDraft) return;
    const draft=cloneJson(Gui.worldManagerEditDraft); Gui.worldManagerSaving=true; Gui.worldManagerEditError='';
    let success='';
    try {
      const request=worldManagerCorrectionRequest(draft); const api=globalThis.__LIBRA__;
      if (!api) throw new Error('LIBRA 공개 API가 준비되지 않았습니다.');
      const result=request.method==='narrative'
        ? await api.addWorldManagerNarrativeCorrection(request.patch,request.options)
        : await api.addWorldManagerCorrection(request.options);
      const correctionId=text(result?.correctionId||result?.correction?.correctionId||'');
      if (!result?.ok || !correctionId || !result?.replay?.ok || !guiAsArray(result?.replay?.appliedCorrections).includes(correctionId)) throw new Error('Correction replay 완료 영수증을 확인하지 못했습니다.');
      if (!worldManagerHeadHasCorrection(result.head||result.currentHead,draft,correctionId)) throw new Error('새 Current Head에서 사용자 교정 provenance를 확인하지 못했습니다.');
      const snapshot=await refreshGuiSnapshot(false);
      if (!worldManagerHeadHasCorrection(snapshot?.continuityState,draft,correctionId)) throw new Error('새 Current Head readback이 교정 결과와 일치하지 않습니다.');
      Gui.worldManagerEditDraft=null; Gui.worldManagerEditError=''; success='교정을 저장하고 Current Head replay/readback을 확인했습니다.';
    } catch(error) {
      Gui.worldManagerEditError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error);
    } finally {
      Gui.worldManagerSaving=false; await renderSettingsGui();
      if (success) guiSetStatus(success,false);
      else if (Gui.worldManagerEditError) guiSetStatus(Gui.worldManagerEditError,true,true);
    }
  };

  const buildWorldManagerCorrectionEditor = (domain, row, view) => {
    const keyValue=worldManagerDraftKey(domain,row); const draft=Gui.worldManagerEditDraft?.key===keyValue?Gui.worldManagerEditDraft:null;
    if (!draft) return guiEl('div',{class:'sga-actions',dataset:{worldCorrectionAction:domain}},[
      worldManagerCorrectionBadge(row),
      guiEl('button',{class:'sga-btn',type:'button',text:worldManagerCorrectionId(row)?'교정 수정':'수정',disabled:!view?.head,onClick:()=>openWorldManagerCorrectionEditor(domain,row,view)})
    ]);
    const values=draft.values; const set=(name,value)=>{values[name]=value;}; const fields=[];
    if (domain==='characters') fields.push(
      fieldNode('이름',worldManagerInput(values.name,value=>set('name',value))),
      fieldNode('별칭',worldManagerTextarea(values.aliases,value=>set('aliases',value)), '쉼표 또는 줄바꿈으로 구분합니다.'),
      fieldNode('상태 JSON',worldManagerTextarea(values.state,value=>set('state',value),{tall:true}), 'Current Head를 직접 쓰지 않고 Correction payload로 저장합니다.')
    );
    else if (domain==='relationships') fields.push(
      fieldNode('관계 주체',worldManagerInput(values.subjectName||values.subjectId,()=>{},{disabled:true})),
      fieldNode('관계 대상',worldManagerInput(values.targetName||values.targetId,()=>{},{disabled:true})),
      fieldNode('차원',worldManagerSelect(values.dimension,['trust','affection','fear','obligation','hostility','distance','cooperation','other'].map(value=>[value,value]),value=>set('dimension',value))),
      fieldNode('현재 관계',worldManagerTextarea(values.state,value=>set('state',value),{tall:true}))
    );
    else if (domain==='world') fields.push(
      fieldNode('이름',worldManagerInput(values.name,value=>set('name',value))),
      fieldNode('종류',worldManagerSelect(values.kind,['location','object','organization','rule','environment','condition','other'].map(value=>[value,value]),value=>set('kind',value))),
      fieldNode('별칭',worldManagerTextarea(values.aliases,value=>set('aliases',value))),
      fieldNode('상태 JSON',worldManagerTextarea(values.state,value=>set('state',value),{tall:true}))
    );
    else if (domain==='narrative_arc') fields.push(
      fieldNode('Arc 제목',worldManagerInput(values.title,value=>set('title',value))),
      fieldNode('상태',worldManagerSelect(values.status,['active','dormant','resolved','superseded'].map(value=>[value,value]),value=>set('status',value))),
      fieldNode('단계',worldManagerSelect(values.phase,['emerging','developing','escalating','turning','aftermath','resolved'].map(value=>[value,value]),value=>set('phase',value))),
      fieldNode('현재 맥락',worldManagerTextarea(values.summary,value=>set('summary',value),{tall:true})),
      fieldNode('중심 압력',worldManagerTextarea(values.centralPressure,value=>set('centralPressure',value))),
      fieldNode('참여 인물',worldManagerTextarea(values.participants,value=>set('participants',value))),
      fieldNode('세계 참조',worldManagerTextarea(values.worldRefs,value=>set('worldRefs',value)))
    );
    else if (domain==='narrative_thread') fields.push(
      fieldNode('연결 Arc ID',worldManagerInput(values.arcId,value=>set('arcId',value))),
      fieldNode('유형',worldManagerSelect(values.type,['conflict','question','promise','goal','mystery','obligation','consequence','setup','other'].map(value=>[value,value]),value=>set('type',value))),
      fieldNode('상태',worldManagerSelect(values.status,['open','resolved','transformed','superseded'].map(value=>[value,value]),value=>set('status',value))),
      fieldNode('내용',worldManagerTextarea(values.summary,value=>set('summary',value),{tall:true})),
      fieldNode('참여 인물',worldManagerTextarea(values.participants,value=>set('participants',value)))
    );
    else if (domain==='narrative_lock') fields.push(
      fieldNode('상태',worldManagerSelect(values.status,[['active','active'],['released','released']],value=>set('status',value))),
      fieldNode('Lock',worldManagerTextarea(values.summary,value=>set('summary',value),{tall:true}))
    );
    return guiEl('section',{class:'sga-card wide',dataset:{worldCorrectionEditor:domain,draftKey:keyValue}},[
      guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3',{text:'사용자 교정'}),guiEl('div',{class:'sga-note',text:'Correction Journal append → replay → Current Head readback이 모두 확인된 뒤에만 완료됩니다.'})]),libraStatusBadge('T'+String(draft.anchorTurn),'warn')]),
      guiEl('div',{class:'sga-form-grid'},fields),
      Gui.worldManagerEditError?guiEl('div',{class:'sga-callout danger',text:Gui.worldManagerEditError}):null,
      guiEl('div',{class:'sga-actions'},[
        guiEl('button',{class:'sga-btn good',type:'button',text:Gui.worldManagerSaving?'저장·Replay 확인 중…':'교정 저장',disabled:Gui.worldManagerSaving,onClick:()=>void saveWorldManagerCorrectionDraft()}),
        guiEl('button',{class:'sga-btn ghost',type:'button',text:'취소',disabled:Gui.worldManagerSaving,onClick:()=>{Gui.worldManagerEditDraft=null;Gui.worldManagerEditError='';queueGuiNavigationRender();}})
      ])
    ]);
  };

  const buildWorldManagerRecordBrowser = ({ domain, rows, selectionKey, titleFor, subtitleFor, detailFor, editorDomain = domain, view }) => {
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
          class: 'sga-card libra-memory-card' + (identities[index] === selectedId ? ' selected' : ''), type: 'button',
          dataset: { selected: String(identities[index] === selectedId), worldRecordId: identities[index], corrected: String(!!worldManagerCorrectionId(row)) },
          'aria-pressed': String(identities[index] === selectedId),
          onClick: () => { Gui[selectionKey] = identities[index]; queueGuiNavigationRender(); }
        }, [guiEl('strong', { text: titleFor(row, index) }), guiEl('small', { class: 'sga-note', text: subtitleFor(row, index) }), worldManagerCorrectionId(row) ? guiEl('small',{class:'sga-note',text:'사용자 교정'}) : null])))
      ]),
      guiEl('section', { class: 'sga-card libra-memory-detail-panel', dataset: { worldRecordDetail: selectedId } }, [
        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3', { text: titleFor(selected, selectedIndex) }),guiEl('div', { class: 'sga-note', text: subtitleFor(selected, selectedIndex) })]),worldManagerCorrectionBadge(selected)]),
        guiEl('pre', { class: 'sga-live-result-code', dataset:{currentHeadReadModel:'true'}, text: JSON.stringify(detailFor(selected, selectedIndex), null, 2) }),
        buildWorldManagerCorrectionEditor(editorDomain,selected,view)
      ])
    ]);
  };

  const buildWorldManagerCharactersPanel = () => {
    const view = worldManagerSnapshotView();
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'characters', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'characters', '인물', view.characters.length),
      buildWorldManagerRecordBrowser({
        domain: 'characters', rows: view.characters, selectionKey: 'worldManagerSelectedCharacterId', view,
        titleFor: row => text(row?.name || row?.id || '이름 없는 인물'),
        subtitleFor: row => guiAsArray(row?.aliases).length ? '별칭 · ' + guiAsArray(row.aliases).join(', ') : 'ID · ' + text(row?.id || '-'),
        detailFor: row => ({ id: row?.id || '', name: row?.name || '', aliases: guiAsArray(row?.aliases), state: guiAsObject(row?.state), correctionProvenance:row?.correctionProvenance||null, evidence: row?.evidence || null })
      })
    ]);
  };

  const buildWorldManagerRelationshipsPanel = () => {
    const view = worldManagerSnapshotView();
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'relationships', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'relationships', '관계', view.relationships.length),
      buildWorldManagerRecordBrowser({
        domain: 'relationships', rows: view.relationships, selectionKey: 'worldManagerSelectedRelationshipId', view,
        titleFor: row => text(row?.subjectName || row?.subjectId || '?') + ' → ' + text(row?.targetName || row?.targetId || '?'),
        subtitleFor: row => text(row?.dimension || 'other') + ' · ' + text(row?.state || '(값 없음)'),
        detailFor: row => ({ id:row?.id||'',subjectId: row?.subjectId || '', targetId: row?.targetId || '', dimension: row?.dimension || 'other', state: row?.state || '', certainty: row?.certainty || 'confirmed', correctionProvenance:row?.correctionProvenance||null, evidence: row?.evidence || null })
      })
    ]);
  };

  const buildWorldManagerWorldPanel = () => {
    const view = worldManagerSnapshotView();
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'world', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'world', '세계', view.world.length),
      buildWorldManagerRecordBrowser({
        domain: 'world', rows: view.world, selectionKey: 'worldManagerSelectedWorldId', view,
        titleFor: row => text(row?.name || row?.id || '이름 없는 세계 항목'),
        subtitleFor: row => text(row?.kind || 'other') + ' · ' + text(row?.id || '-'),
        detailFor: row => ({ id: row?.id || '', name: row?.name || '', kind: row?.kind || 'other', aliases:guiAsArray(row?.aliases),state: guiAsObject(row?.state), correctionProvenance:row?.correctionProvenance||null,evidence: row?.evidence || null })
      })
    ]);
  };

  const buildWorldManagerNarrativeCurrentPanel = () => {
    const view = worldManagerSnapshotView();
    const narrative = view.narrative;
    const arcs = guiAsArray(narrative.arcs);
    const threads = guiAsArray(narrative.threads).slice().sort((a,b)=>(a?.status==='open'?-1:1)-(b?.status==='open'?-1:1));
    const locks = guiAsArray(narrative.locks).slice().sort((a,b)=>(a?.status==='active'?-1:1)-(b?.status==='active'?-1:1));
    const motifs = guiAsArray(narrative.motifs);
    const turningPoints = guiAsArray(narrative.turningPoints);
    return guiEl('div', { class: 'sga-flow-section', dataset: { worldManagerDomain: 'narrative', snapshotOnly: 'true' } }, [
      buildWorldManagerSnapshotNotice(view, 'narrative', '내러티브', arcs.length + threads.length),
      guiEl('section', { class: 'sga-card wide', dataset: { narrativeCurrentHead: 'true', readOnly: 'true' } }, [
        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3', { text: '현재까지 실제로 성립한 이야기' }),guiEl('div', { text: text(narrative.summary || '현재 내러티브 요약 없음') })]),worldManagerCorrectionBadge(narrative)]),
        narrative.momentum ? guiEl('div', { class: 'sga-callout', text: '현재 압력 / 모멘텀 · ' + text(narrative.momentum) }) : null,
        guiEl('div', { class: 'sga-summary-table' }, [
          guiEl('span', { text: '활성 Arc' }), guiEl('strong', { text: String(arcs.filter(item => item?.status === 'active').length) }),
          guiEl('span', { text: '열린 Thread' }), guiEl('strong', { text: String(threads.filter(item => item?.status === 'open').length) }),
          guiEl('span', { text: '활성 Lock' }), guiEl('strong', { text: String(locks.filter(item => item?.status !== 'released').length) }),
          guiEl('span', { text: '갱신 Turn' }), guiEl('strong', { text: 'T' + String(Number(narrative.updatedThroughTurn || view.throughTurn || 0)) })
        ])
      ]),
      guiEl('h3',{text:'Arc'}),
      buildWorldManagerRecordBrowser({domain:'narrative_arcs',editorDomain:'narrative_arc',rows:arcs,selectionKey:'worldManagerSelectedArcId',view,titleFor:row=>text(row?.title||row?.summary||row?.id||'이름 없는 Arc'),subtitleFor:row=>text(row?.status||'active')+' · '+text(row?.phase||'developing'),detailFor:row=>row||{}}),
      guiEl('h3',{text:'Thread'}),
      buildWorldManagerRecordBrowser({domain:'narrative_threads',editorDomain:'narrative_thread',rows:threads,selectionKey:'worldManagerSelectedThreadId',view,titleFor:row=>text(row?.summary||row?.id||'이름 없는 Thread'),subtitleFor:row=>text(row?.type||'other')+' · '+text(row?.status||'open'),detailFor:row=>row||{}}),
      guiEl('h3',{text:'Lock'}),
      buildWorldManagerRecordBrowser({domain:'narrative_locks',editorDomain:'narrative_lock',rows:locks,selectionKey:'worldManagerSelectedLockId',view,titleFor:row=>text(row?.summary||row?.id||'이름 없는 Lock'),subtitleFor:row=>text(row?.status||'active'),detailFor:row=>row||{}}),
      guiLazyDetails({ class: 'sga-card wide', open: false }, guiEl('summary', {}, [guiEl('strong', { text: 'Motif · Turning Point' }), guiEl('span', { text: String(motifs.length + turningPoints.length) })]), () => guiEl('pre', { class: 'sga-live-result-code', text: JSON.stringify({ motifs, turningPoints }, null, 2) }))
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

`);

  rep('public_narrative_rebuild_fail_closed',
`    async rebuildWorldManagerNarrative(options = {}) {
      const rebuilt = await LibraMemoryCore.rebuildCurrentStateForWorldline(options);
      return safeClone(rebuilt?.head?.narrative || rebuilt?.narrative || __libraNarrativeEmptyState());
    },`,
`    async rebuildWorldManagerNarrative(options = {}) {
      const rebuilt = await LibraMemoryCore.rebuildCurrentStateForWorldline(options);
      if (!rebuilt?.ok) { const error=new Error(rebuilt?.error||'world_manager_narrative_replay_failed'); error.code=rebuilt?.code||'STATE_REPLAY_FAILED'; throw error; }
      return safeClone(rebuilt.head?.narrative || __libraNarrativeEmptyState());
    },`);

  return { source, labels };
};
