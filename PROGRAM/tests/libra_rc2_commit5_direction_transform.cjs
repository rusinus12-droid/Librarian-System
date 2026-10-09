'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  rep('narrative_direction_gui_state',
`    worldManagerCanonicalMemoryFocus: null,`,
`    worldManagerCanonicalMemoryFocus: null,
    narrativeDirectionDraft: null,
    narrativeDirectionDraftKey: '',
    narrativeDirectionLoading: false,
    narrativeDirectionSaving: false,
    narrativeDirectionError: '',
    narrativeDirectionLoadSerial: 0,`);

  rep('narrative_current_direction_action',
`      guiEl('h3',{text:'Arc'}),`,
`      guiEl('div',{class:'sga-actions'},[guiEl('button',{class:'sga-btn primary',type:'button',text:'앞으로의 서사 방향 설정',onClick:()=>{Gui.narrativeHubSection='direction';queueGuiNavigationRender();}})]),
      guiEl('h3',{text:'Arc'}),`);

  rep('shared_narrative_direction_panel',
`  const buildWorldManagerNarrativePanel = () => {`,
`  const narrativeDirectionScopeKey = () => text(LibraMemoryCore.peekSnapshot()?.scope?.scopeKey||'');
  const narrativeDirectionPersistedShape = value => {
    const row=guiAsObject(value);
    return {
      schema:text(row.schema||''),scopeKey:text(row.scopeKey||''),revision:Number(row.revision||0),goal:text(row.goal||''),
      completionConditions:guiAsArray(row.completionConditions).map(text),doNotForce:guiAsArray(row.doNotForce).map(text),softPreferences:guiAsArray(row.softPreferences).map(text),
      locked:row.locked===true,source:text(row.source||''),updatedAt:Number(row.updatedAt||0)
    };
  };
  const narrativeDirectionSemanticallyEqual = (left,right) => JSON.stringify(narrativeDirectionPersistedShape(left))===JSON.stringify(narrativeDirectionPersistedShape(right));
  const narrativeDirectionDraftFromRecord = record => {
    const row=narrativeDirectionPersistedShape(record);
    return {...row,completionConditions:row.completionConditions.join('\\n'),doNotForce:row.doNotForce.join('\\n'),softPreferences:row.softPreferences.join('\\n'),dirty:false};
  };
  const narrativeDirectionDraftList = value => String(value||'').split(/[\\n,]/).map(item=>item.trim()).filter(Boolean).slice(0,32);
  const loadNarrativeDirectionDraft = async () => {
    const scopeKey=narrativeDirectionScopeKey();
    if (!scopeKey) { Gui.narrativeDirectionError='현재 채팅 scope를 확인하지 못했습니다.'; queueGuiNavigationRender(); return; }
    if (Gui.narrativeDirectionDraftKey===scopeKey&&Gui.narrativeDirectionDraft) return;
    const serial=Number(Gui.narrativeDirectionLoadSerial||0)+1; Gui.narrativeDirectionLoadSerial=serial; Gui.narrativeDirectionLoading=true; Gui.narrativeDirectionError='';
    try {
      const api=globalThis.__LIBRA__; if (!api?.getPlannerNarrativeDirection) throw new Error('Narrative Direction API가 준비되지 않았습니다.');
      const record=await api.getPlannerNarrativeDirection({scopeKey});
      if (Gui.narrativeDirectionLoadSerial!==serial||narrativeDirectionScopeKey()!==scopeKey) return;
      if (text(record?.scopeKey||'')!==scopeKey) throw new Error('Narrative Direction scope readback이 현재 채팅과 일치하지 않습니다.');
      Gui.narrativeDirectionDraft=narrativeDirectionDraftFromRecord(record); Gui.narrativeDirectionDraftKey=scopeKey;
    } catch(error) { if (Gui.narrativeDirectionLoadSerial===serial) Gui.narrativeDirectionError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error); }
    finally { if (Gui.narrativeDirectionLoadSerial===serial) { Gui.narrativeDirectionLoading=false; queueGuiNavigationRender(); } }
  };
  const saveNarrativeDirectionDraft = async () => {
    if (Gui.narrativeDirectionSaving||!Gui.narrativeDirectionDraft) return;
    const scopeKey=narrativeDirectionScopeKey(); const draft=Gui.narrativeDirectionDraft;
    if (!scopeKey||Gui.narrativeDirectionDraftKey!==scopeKey||text(draft.scopeKey||'')!==scopeKey) { Gui.narrativeDirectionError='Narrative Direction 편집 scope가 현재 채팅과 일치하지 않습니다.'; queueGuiNavigationRender(); return; }
    Gui.narrativeDirectionSaving=true; Gui.narrativeDirectionError='';
    try {
      const api=globalThis.__LIBRA__; if (!api?.setPlannerNarrativeDirection||!api?.getPlannerNarrativeDirection) throw new Error('Narrative Direction API가 준비되지 않았습니다.');
      const payload={goal:text(draft.goal||'').trim(),completionConditions:narrativeDirectionDraftList(draft.completionConditions),doNotForce:narrativeDirectionDraftList(draft.doNotForce),softPreferences:narrativeDirectionDraftList(draft.softPreferences),locked:draft.locked===true};
      const receipt=await api.setPlannerNarrativeDirection(payload,{scopeKey});
      const readback=await api.getPlannerNarrativeDirection({scopeKey});
      if (!narrativeDirectionSemanticallyEqual(receipt,readback)||text(readback?.scopeKey||'')!==scopeKey) throw new Error('Narrative Direction 저장 readback mismatch');
      Gui.narrativeDirectionDraft=narrativeDirectionDraftFromRecord(readback); Gui.narrativeDirectionDraftKey=scopeKey; Gui.narrativeDirectionError='';
      guiSetStatus('앞으로의 서사 방향 저장과 물리 readback을 확인했습니다.',false);
    } catch(error) { Gui.narrativeDirectionError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error); if (Gui.narrativeDirectionDraft) Gui.narrativeDirectionDraft.dirty=true; guiSetStatus(Gui.narrativeDirectionError,true,true); }
    finally { Gui.narrativeDirectionSaving=false; await renderSettingsGui(); }
  };
  const clearNarrativeDirectionDraft = async () => {
    if (Gui.narrativeDirectionSaving) return;
    const scopeKey=narrativeDirectionScopeKey();
    if (!scopeKey||Gui.narrativeDirectionDraftKey!==scopeKey) { Gui.narrativeDirectionError='Narrative Direction 편집 scope가 현재 채팅과 일치하지 않습니다.'; queueGuiNavigationRender(); return; }
    if (typeof confirm==='function'&&!confirm('앞으로의 서사 방향을 초기화할까요? 현재 Narrative 사실은 변경되지 않습니다.')) return;
    Gui.narrativeDirectionSaving=true; Gui.narrativeDirectionError='';
    try {
      const api=globalThis.__LIBRA__; if (!api?.clearPlannerNarrativeDirection||!api?.getPlannerNarrativeDirection) throw new Error('Narrative Direction API가 준비되지 않았습니다.');
      const receipt=await api.clearPlannerNarrativeDirection({scopeKey});
      const readback=await api.getPlannerNarrativeDirection({scopeKey});
      if (!narrativeDirectionSemanticallyEqual(receipt,readback)||text(readback?.scopeKey||'')!==scopeKey) throw new Error('Narrative Direction 초기화 readback mismatch');
      Gui.narrativeDirectionDraft=narrativeDirectionDraftFromRecord(readback); Gui.narrativeDirectionDraftKey=scopeKey; Gui.narrativeDirectionError='';
      guiSetStatus('앞으로의 서사 방향 초기화와 물리 readback을 확인했습니다.',false);
    } catch(error) { Gui.narrativeDirectionError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error); guiSetStatus(Gui.narrativeDirectionError,true,true); }
    finally { Gui.narrativeDirectionSaving=false; await renderSettingsGui(); }
  };
  const buildNarrativeDirectionPanel = () => {
    const scopeKey=narrativeDirectionScopeKey(); const draft=Gui.narrativeDirectionDraftKey===scopeKey?Gui.narrativeDirectionDraft:null;
    if (!draft&&!Gui.narrativeDirectionLoading) Promise.resolve().then(()=>loadNarrativeDirectionDraft());
    const setDraft=(name,value)=>{if(!Gui.narrativeDirectionDraft)return;Gui.narrativeDirectionDraft[name]=value;Gui.narrativeDirectionDraft.dirty=true;};
    return guiEl('div',{class:'sga-flow-section',dataset:{narrativeDirection:'shared'}},[
      guiEl('div',{class:'sga-callout'},[guiEl('strong',{text:'앞으로의 방향'}),guiEl('div',{text:'이 페이지는 앞으로 원하는 방향을 지정합니다.'}),guiEl('div',{text:'현재까지 실제로 일어난 내용은 내러티브 > 현재 내러티브에서 관리합니다.'})]),
      Gui.narrativeDirectionError?guiEl('div',{class:'sga-callout danger',text:Gui.narrativeDirectionError}):null,
      draft?guiEl('section',{class:'sga-card wide'},[
        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3',{text:'사용자 서사 방향'}),guiEl('div',{class:'sga-note',text:'현재 사실과 분리된 scope별 사용자 권위입니다.'})]),libraStatusBadge(draft.locked?'잠금':'편집 가능',draft.locked?'warn':'good')]),
        guiEl('div',{class:'sga-form-grid'},[
          fieldNode('원하는 서사 방향',inputNode(draft.goal,value=>setDraft('goal',value))),
          fieldNode('완료 조건',guiEl('textarea',{class:'sga-textarea preview',value:draft.completionConditions,onInput:event=>setDraft('completionConditions',event.target.value)}),'줄바꿈 또는 쉼표로 구분합니다.'),
          fieldNode('피해야 할 강제 전개',guiEl('textarea',{class:'sga-textarea preview',value:draft.doNotForce,onInput:event=>setDraft('doNotForce',event.target.value)})),
          fieldNode('Soft Preferences',guiEl('textarea',{class:'sga-textarea preview',value:draft.softPreferences,onInput:event=>setDraft('softPreferences',event.target.value)})),
          checkboxNode(draft.locked,'잠금',value=>setDraft('locked',value))
        ]),
        guiEl('div',{class:'sga-actions'},[
          guiEl('button',{class:'sga-btn good',type:'button',text:Gui.narrativeDirectionSaving?'저장 확인 중…':'방향 저장',disabled:Gui.narrativeDirectionSaving,onClick:()=>void saveNarrativeDirectionDraft()}),
          guiEl('button',{class:'sga-btn danger',type:'button',text:'방향 초기화',disabled:Gui.narrativeDirectionSaving,onClick:()=>void clearNarrativeDirectionDraft()})
        ])
      ]):guiEl('div',{class:'sga-card wide sga-note',text:Gui.narrativeDirectionLoading?'앞으로의 방향을 읽는 중입니다.':'앞으로의 방향을 불러오지 못했습니다.'})
    ]);
  };

  const buildWorldManagerNarrativePanel = () => {`);

  rep('connect_shared_narrative_direction_panel',
`    const pending = Gui.narrativeHubSection === 'direction'
      ? guiEl('div', { class: 'sga-callout', dataset: { narrativeDirectionPending: 'true' }, text: '앞으로의 방향은 Current Head와 분리된 사용자 권위입니다. 다음 구현 단계에서 기존 Planner Direction 저장값의 readback과 함께 연결합니다.' })`,
`    const pending = Gui.narrativeHubSection === 'direction'
      ? buildNarrativeDirectionPanel()`);

  rep('public_direction_api_on_frozen_surface',
`    async getWorldManagerCorrections() { const context=await LibraMemoryCore.resolveContext(); return safeClone(await LibraMemoryCore.loadStateCorrectionJournal(context.scope)); },`,
`    async getPlannerNarrativeDirection(options = {}) { return safeClone(await getPlannerNarrativeDirection(options)); },
    async setPlannerNarrativeDirection(value = {}, options = {}) { return safeClone(await setPlannerNarrativeDirection(value, options)); },
    async clearPlannerNarrativeDirection(options = {}) { return safeClone(await clearPlannerNarrativeDirection(options)); },
    async getWorldManagerCorrections() { const context=await LibraMemoryCore.resolveContext(); return safeClone(await LibraMemoryCore.loadStateCorrectionJournal(context.scope)); },`);

  rep('direction_core_semantic_readback_helper',
`async function getPlannerNarrativeDirection(options = {}) {`,
`function __libraCompletionDirectionSemanticallyEqual(left, right) {
    const shape = value => {
        const row=__libraCompletionNormalizeDirection(value, value?.scopeKey || 'default');
        return JSON.stringify({schema:row.schema,scopeKey:row.scopeKey,revision:row.revision,goal:row.goal,completionConditions:row.completionConditions,doNotForce:row.doNotForce,softPreferences:row.softPreferences,locked:row.locked,source:row.source,updatedAt:row.updatedAt});
    };
    return shape(left)===shape(right);
}

async function getPlannerNarrativeDirection(options = {}) {`);
  rep('direction_core_exact_readback',
`    if (!await __libraCompletionStorageWrite(key, next)) throw new Error('planner narrative direction storage write failed');
    return next;`,
`    if (!await __libraCompletionStorageWrite(key, next)) throw new Error('planner narrative direction storage write failed');
    const readback=await getPlannerNarrativeDirection({scopeKey});
    if (!__libraCompletionDirectionSemanticallyEqual(next,readback)) throw new Error('planner narrative direction storage readback mismatch');
    return readback;`);

  return { source, labels };
};
