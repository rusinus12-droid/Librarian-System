'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  rep('world_manager_history_gui_state',
`    worldManagerEditDraft: null,
    worldManagerEditError: '',
    worldManagerSaving: false,`,
`    worldManagerEditDraft: null,
    worldManagerEditError: '',
    worldManagerSaving: false,
    worldManagerDomainSections: { characters: 'current', relationships: 'current', world: 'current' },
    worldManagerHistoryDomain: 'all',
    worldManagerCorrectionFilter: 'active',
    worldManagerHistoryCursor: '',
    worldManagerCorrectionCursor: '',
    worldManagerHistoryTab: 'history',
    worldManagerHistoryItems: [],
    worldManagerCorrectionItems: [],
    worldManagerHistoryDetails: {},
    worldManagerHistoryLoaded: false,
    worldManagerCorrectionsLoaded: false,
    worldManagerHistoryLoading: false,
    worldManagerCorrectionsLoading: false,
    worldManagerHistoryHasMore: false,
    worldManagerCorrectionHasMore: false,
    worldManagerHistoryError: '',
    worldManagerCorrectionError: '',
    worldManagerCorrectionMutationId: '',
    worldManagerCanonicalMemoryFocus: null,`);

  rep('canonical_memory_history_focus_source',
`    const memories = snapshot.memories || [];
    const total = Number(snapshot.totals?.memories ?? memories.length);`,
`    const worldManagerCanonicalMemoryFocus = Gui.worldManagerCanonicalMemoryFocus && typeof Gui.worldManagerCanonicalMemoryFocus === 'object' ? Gui.worldManagerCanonicalMemoryFocus : null;
    const memories = (snapshot.memories || []).slice();
    if (worldManagerCanonicalMemoryFocus?.memory && !memories.some(row => String(row?.memoryId || '') === String(worldManagerCanonicalMemoryFocus.memoryId || '') && Number(row?.revision || 0) === Number(worldManagerCanonicalMemoryFocus.revision || 0))) memories.push(worldManagerCanonicalMemoryFocus.memory);
    const total = Math.max(Number(snapshot.totals?.memories ?? memories.length), memories.length);`);
  rep('canonical_memory_history_focus_order',
`    const ordered = memories.slice().reverse();
    const visible = ordered.slice(0, guiListLimit('memories'));`,
`    const ordered = memories.slice().reverse();
    if (worldManagerCanonicalMemoryFocus) ordered.sort((left,right) => {
      const leftFocused=String(left?.memoryId||'')===String(worldManagerCanonicalMemoryFocus.memoryId||'')&&Number(left?.revision||0)===Number(worldManagerCanonicalMemoryFocus.revision||0);
      const rightFocused=String(right?.memoryId||'')===String(worldManagerCanonicalMemoryFocus.memoryId||'')&&Number(right?.revision||0)===Number(worldManagerCanonicalMemoryFocus.revision||0);
      return Number(rightFocused)-Number(leftFocused);
    });
    const visible = ordered.slice(0, guiListLimit('memories'));`);
  rep('canonical_memory_history_focus_card',
`      return guiLazyDetails({ class: 'sga-card wide' }, guiEl('summary', {}, [`,
`      const worldManagerFocused = !!worldManagerCanonicalMemoryFocus && String(memory?.memoryId||'')===String(worldManagerCanonicalMemoryFocus.memoryId||'') && Number(memory?.revision||0)===Number(worldManagerCanonicalMemoryFocus.revision||0);
      return guiLazyDetails({ class: 'sga-card wide', open: worldManagerFocused, dataset: { canonicalMemoryId: memory.memoryId || '', canonicalRevision: String(Number(memory.revision || 0)), worldManagerFocus: String(worldManagerFocused) } }, guiEl('summary', {}, [`);

  rep('rename_character_current_builder', '  const buildWorldManagerCharactersPanel = () => {', '  const buildWorldManagerCharactersCurrentPanel = () => {');
  rep('rename_relationship_current_builder', '  const buildWorldManagerRelationshipsPanel = () => {', '  const buildWorldManagerRelationshipsCurrentPanel = () => {');
  rep('rename_world_current_builder', '  const buildWorldManagerWorldPanel = () => {', '  const buildWorldManagerWorldCurrentPanel = () => {');

  rep('insert_world_manager_history_gui',
`  const buildWorldManagerNarrativeCurrentPanel = () => {`,
`  const resetWorldManagerPagedView = domain => {
    Gui.worldManagerHistoryDomain=domain;
    Gui.worldManagerHistoryCursor=''; Gui.worldManagerCorrectionCursor='';
    Gui.worldManagerHistoryItems=[]; Gui.worldManagerCorrectionItems=[]; Gui.worldManagerHistoryDetails={};
    Gui.worldManagerHistoryLoaded=false; Gui.worldManagerCorrectionsLoaded=false;
    Gui.worldManagerHistoryLoading=false; Gui.worldManagerCorrectionsLoading=false;
    Gui.worldManagerHistoryHasMore=false; Gui.worldManagerCorrectionHasMore=false;
    Gui.worldManagerHistoryError=''; Gui.worldManagerCorrectionError='';
  };
  const ensureWorldManagerPagedDomain = domainValue => {
    const domain=['characters','relationships','world','narrative'].includes(String(domainValue||''))?String(domainValue):'narrative';
    if (Gui.worldManagerHistoryDomain!==domain) resetWorldManagerPagedView(domain);
    return domain;
  };
  const loadWorldManagerHistoryPage = async (append=false) => {
    if (Gui.worldManagerHistoryLoading) return;
    const domain=ensureWorldManagerPagedDomain(Gui.worldManagerHistoryDomain); const cursor=append?String(Gui.worldManagerHistoryCursor||''):'';
    Gui.worldManagerHistoryLoading=true; Gui.worldManagerHistoryError='';
    try {
      const api=globalThis.__LIBRA__; if (!api?.listWorldManagerHistory) throw new Error('World Manager History API가 준비되지 않았습니다.');
      const page=await api.listWorldManagerHistory({domain,limit:20,cursor});
      if (Gui.worldManagerHistoryDomain!==domain) return;
      const next=guiAsArray(page?.items);
      Gui.worldManagerHistoryItems=append?[...guiAsArray(Gui.worldManagerHistoryItems),...next]:next;
      Gui.worldManagerHistoryCursor=text(page?.nextCursor||''); Gui.worldManagerHistoryHasMore=page?.hasMore===true; Gui.worldManagerHistoryLoaded=true;
    } catch(error) { Gui.worldManagerHistoryError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error); }
    finally { Gui.worldManagerHistoryLoading=false; queueGuiNavigationRender(); }
  };
  const loadWorldManagerCorrectionsPage = async (append=false) => {
    if (Gui.worldManagerCorrectionsLoading) return;
    const domain=ensureWorldManagerPagedDomain(Gui.worldManagerHistoryDomain); const status=String(Gui.worldManagerCorrectionFilter||'active'); const cursor=append?String(Gui.worldManagerCorrectionCursor||''):'';
    Gui.worldManagerCorrectionsLoading=true; Gui.worldManagerCorrectionError='';
    try {
      const api=globalThis.__LIBRA__; if (!api?.listWorldManagerCorrections) throw new Error('World Manager Correction API가 준비되지 않았습니다.');
      const page=await api.listWorldManagerCorrections({domain,status,limit:20,cursor});
      if (Gui.worldManagerHistoryDomain!==domain||String(Gui.worldManagerCorrectionFilter||'active')!==status) return;
      const next=guiAsArray(page?.items);
      Gui.worldManagerCorrectionItems=append?[...guiAsArray(Gui.worldManagerCorrectionItems),...next]:next;
      Gui.worldManagerCorrectionCursor=text(page?.nextCursor||''); Gui.worldManagerCorrectionHasMore=page?.hasMore===true; Gui.worldManagerCorrectionsLoaded=true;
    } catch(error) { Gui.worldManagerCorrectionError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error); }
    finally { Gui.worldManagerCorrectionsLoading=false; queueGuiNavigationRender(); }
  };
  const worldManagerHistoryDetailKey = item => text(item?.memoryId||'')+':r'+String(Number(item?.revision||0));
  const loadWorldManagerHistoryDetail = async item => {
    const cacheKey=worldManagerHistoryDetailKey(item); if (!cacheKey||Gui.worldManagerHistoryDetails?.[cacheKey]?.detail) return;
    Gui.worldManagerHistoryDetails={...guiAsObject(Gui.worldManagerHistoryDetails),[cacheKey]:{loading:true,error:'',detail:null}}; queueGuiNavigationRender();
    try {
      const api=globalThis.__LIBRA__; if (!api?.getWorldManagerHistoryDetail) throw new Error('World Manager History detail API가 준비되지 않았습니다.');
      const detail=await api.getWorldManagerHistoryDetail({memoryId:text(item?.memoryId||''),revision:Number(item?.revision||0)});
      Gui.worldManagerHistoryDetails={...guiAsObject(Gui.worldManagerHistoryDetails),[cacheKey]:{loading:false,error:'',detail}};
    } catch(error) {
      Gui.worldManagerHistoryDetails={...guiAsObject(Gui.worldManagerHistoryDetails),[cacheKey]:{loading:false,error:(error?.code?String(error.code)+' · ':'')+String(error?.message||error),detail:null}};
    } finally { queueGuiNavigationRender(); }
  };
  const worldManagerHeadContainsCorrection = (headValue,correctionId) => {
    const head=guiAsObject(headValue); const wanted=text(correctionId||''); if (!wanted) return false;
    const has=rows=>guiAsArray(rows).some(row=>text(row?.correctionProvenance?.correctionId||'')===wanted);
    return has(head.characters)||has(head.relationships)||has(head.world)||text(head?.narrative?.correctionProvenance?.correctionId||'')===wanted
      ||['arcs','threads','locks','motifs','turningPoints'].some(keyName=>has(head?.narrative?.[keyName]));
  };
  const setWorldManagerCorrectionLifecycle = async (correction,status) => {
    const correctionId=text(correction?.correctionId||''); if (!correctionId||Gui.worldManagerCorrectionMutationId) return;
    if (status==='deleted'&&typeof confirm==='function'&&!confirm('이 사용자 교정을 삭제 상태로 전환할까요? 정본 기억과 Delta는 변경되지 않습니다.')) return;
    Gui.worldManagerCorrectionMutationId=correctionId; Gui.worldManagerCorrectionError='';
    try {
      const api=globalThis.__LIBRA__; if (!api?.setWorldManagerCorrectionStatus) throw new Error('Correction lifecycle API가 준비되지 않았습니다.');
      const result=await api.setWorldManagerCorrectionStatus(correctionId,status); const durable=result?.correction||result;
      if (!result?.ok||text(durable?.correctionId||'')!==correctionId||text(durable?.status||'')!==text(status)||!result?.replay?.ok) throw new Error('Correction 상태 변경 영수증을 확인하지 못했습니다.');
      const shouldApply=status==='active'; const replayApplied=guiAsArray(result?.replay?.appliedCorrections).includes(correctionId);
      if (replayApplied!==shouldApply||worldManagerHeadContainsCorrection(result?.head||result?.currentHead,correctionId)!==shouldApply) throw new Error('Correction replay Head 영수증이 상태와 일치하지 않습니다.');
      const snapshot=await refreshGuiSnapshot(false);
      if (worldManagerHeadContainsCorrection(snapshot?.continuityState,correctionId)!==shouldApply) throw new Error('새 Current Head readback이 Correction 상태와 일치하지 않습니다.');
      const filter=String(Gui.worldManagerCorrectionFilter||'active');
      Gui.worldManagerCorrectionItems=filter==='all'||filter===status
        ? guiAsArray(Gui.worldManagerCorrectionItems).map(row=>text(row?.correctionId||'')===correctionId?durable:row)
        : guiAsArray(Gui.worldManagerCorrectionItems).filter(row=>text(row?.correctionId||'')!==correctionId);
      Gui.worldManagerCorrectionCursor=''; Gui.worldManagerCorrectionHasMore=false; Gui.worldManagerCorrectionError='';
      guiSetStatus('Correction 상태를 변경하고 Current Head replay/readback을 확인했습니다.',false);
    } catch(error) { Gui.worldManagerCorrectionError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error); guiSetStatus(Gui.worldManagerCorrectionError,true,true); }
    finally { Gui.worldManagerCorrectionMutationId=''; queueGuiNavigationRender(); }
  };
  const openWorldManagerReplacementCorrection = correction => {
    try {
      const view=worldManagerSnapshotView(); const target=text(correction?.target?.domain||'head'); const after=guiAsObject(correction?.after); let editorDomain=target; let row=null;
      if (['characters','relationships','world'].includes(target)) {
        const patchRow=guiAsArray(after[target])[0]||{}; const rows=guiAsArray(view[target]);
        row=rows.find(item=>text(item?.id||'')===text(patchRow?.id||''))||patchRow;
      } else if (target==='narrative') {
        const patch=guiAsObject(after.narrative); const choices=[['arcs','narrative_arc'],['threads','narrative_thread'],['locks','narrative_lock']];
        for (const [keyName,kind] of choices) { const patchRow=guiAsArray(patch[keyName])[0]; if (!patchRow) continue; editorDomain=kind; row=guiAsArray(view.narrative?.[keyName]).find(item=>text(item?.id||'')===text(patchRow?.id||''))||patchRow; break; }
      }
      if (!row||!view.head||!['characters','relationships','world','narrative_arc','narrative_thread','narrative_lock'].includes(editorDomain)) throw new Error('현재 Head에서 대체 수정 대상을 찾지 못했습니다.');
      openWorldManagerCorrectionEditor(editorDomain,row,view); Gui.worldManagerEditDraft.supersedes=text(correction?.correctionId||'');
      sharedNavigate(target==='narrative'?'narrative':target);
    } catch(error) { Gui.worldManagerCorrectionError=String(error?.message||error); queueGuiNavigationRender(); }
  };
  const jumpToWorldManagerCanonicalMemory = async item => {
    try {
      const identity={memoryId:text(item?.memoryId||''),revision:Number(item?.revision||0)}; const api=globalThis.__LIBRA__;
      if (!api?.getCanonicalMemoryDetail) throw new Error('Canonical Memory detail API가 준비되지 않았습니다.');
      const memory=await api.getCanonicalMemoryDetail(identity);
      if (text(memory?.memoryId||'')!==identity.memoryId||Number(memory?.revision||0)!==identity.revision) throw new Error('Canonical Memory readback identity가 일치하지 않습니다.');
      Gui.worldManagerCanonicalMemoryFocus={...identity,memory}; Gui.memoryHubSection='memories'; sharedNavigate('memory');
    } catch(error) { Gui.worldManagerHistoryError=(error?.code?String(error.code)+' · ':'')+String(error?.message||error); queueGuiNavigationRender(); }
  };
  const worldManagerCorrectionStatusCopy = status => ({
    active:['적용 중','good'],suspended:['재검토 필요','warn'],dormant_after_rollback:['롤백 뒤 휴면','warn'],superseded:['대체됨',''],deleted:['삭제됨','danger']
  }[String(status||'')]||[String(status||'알 수 없음'),'']);
  const buildWorldManagerHistoryCorrectionsPanel = domainValue => {
    const domain=ensureWorldManagerPagedDomain(domainValue); Gui.worldManagerHistoryTab=['history','corrections'].includes(Gui.worldManagerHistoryTab)?Gui.worldManagerHistoryTab:'history';
    const tabs=[{id:'history',label:'변화 기록'},{id:'corrections',label:'사용자 교정'}];
    if (Gui.worldManagerHistoryTab==='history'&&!Gui.worldManagerHistoryLoaded&&!Gui.worldManagerHistoryLoading) queueMicrotask(()=>void loadWorldManagerHistoryPage(false));
    if (Gui.worldManagerHistoryTab==='corrections'&&!Gui.worldManagerCorrectionsLoaded&&!Gui.worldManagerCorrectionsLoading) queueMicrotask(()=>void loadWorldManagerCorrectionsPage(false));
    let body;
    if (Gui.worldManagerHistoryTab==='history') {
      const cards=guiAsArray(Gui.worldManagerHistoryItems).map(item=>{
        const detailState=guiAsObject(Gui.worldManagerHistoryDetails?.[worldManagerHistoryDetailKey(item)]); const detail=detailState.detail;
        const domains=guiAsObject(item?.domains); const selected=guiAsObject(domains[domain]);
        return guiEl('section',{class:'sga-card wide',dataset:{worldHistoryMemory:item?.memoryId||''}},[
          guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3',{text:'TURN '+String(Number(item?.turnRange?.start||0))+'~'+String(Number(item?.turnRange?.end||0))}),guiEl('div',{class:'sga-note',text:'revision '+String(Number(item?.revision||0))+' · '+text(item?.status||'committed')})]),libraStatusBadge(text(selected.status||item?.deltaStatus||'기록'),'good')]),
          item?.narrativeSummary?guiEl('div',{text:text(item.narrativeSummary)}):null,
          guiEl('div',{class:'sga-note',text:'변경 '+String(Number(selected.count??selected.changed??0))+' · '+libraFormatTime(item?.updatedAt)}),
          detailState.error?guiEl('div',{class:'sga-callout danger',text:detailState.error}):null,
          detail?guiEl('pre',{class:'sga-live-result-code',text:JSON.stringify(detail?.delta||detail?.patch||detail,null,2)}):null,
          guiEl('div',{class:'sga-actions'},[
            guiEl('button',{class:'sga-btn',type:'button',text:detailState.loading?'상세 읽는 중…':'변화 상세',disabled:detailState.loading===true,dataset:{worldHistoryDetailAction:'true'},onClick:()=>void loadWorldManagerHistoryDetail(item)}),
            detail?guiEl('button',{class:'sga-btn primary',type:'button',text:'정본 메모리 보기',dataset:{worldHistoryCanonicalJump:'true'},onClick:()=>void jumpToWorldManagerCanonicalMemory(item)}):null
          ])
        ]);
      });
      body=guiEl('div',{class:'sga-list-items'},[
        Gui.worldManagerHistoryError?guiEl('div',{class:'sga-callout danger',text:Gui.worldManagerHistoryError}):null,
        ...(cards.length?cards:[guiEl('div',{class:'sga-card wide sga-note',text:Gui.worldManagerHistoryLoading?'변화 기록을 읽는 중입니다.':'아직 기록된 상태 변화가 없습니다.'})]),
        Gui.worldManagerHistoryHasMore?guiEl('button',{class:'sga-btn',type:'button',text:'변화 기록 더 보기',disabled:Gui.worldManagerHistoryLoading,onClick:()=>void loadWorldManagerHistoryPage(true)}):null
      ]);
    } else {
      const statusOptions=[['active','적용 중'],['all','전체'],['suspended','재검토 필요'],['dormant_after_rollback','롤백 뒤 휴면'],['superseded','대체됨'],['deleted','삭제됨']];
      const cards=guiAsArray(Gui.worldManagerCorrectionItems).map(row=>{ const copy=worldManagerCorrectionStatusCopy(row?.status); const busy=Gui.worldManagerCorrectionMutationId===text(row?.correctionId||''); return guiEl('section',{class:'sga-card wide',dataset:{worldCorrectionId:row?.correctionId||''}},[
        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3',{text:'T'+String(Number(row?.anchor?.throughTurn||0))+' · '+text(row?.target?.domain||'head')}),guiEl('div',{class:'sga-note',text:text(row?.worldlineId||'main')+' · '+libraFormatTime(row?.createdAt)})]),libraStatusBadge(copy[0],copy[1])]),
        guiEl('div',{class:'sga-note',text:'basis · '+text(row?.basisFingerprint||'-')}),guiEl('pre',{class:'sga-live-result-code',text:JSON.stringify(row?.after||{},null,2)}),
        guiEl('div',{class:'sga-actions'},[
          !['active','superseded','deleted'].includes(row?.status)?guiEl('button',{class:'sga-btn good',type:'button',text:'다시 활성화',disabled:busy,dataset:{worldCorrectionStatus:'active'},onClick:()=>void setWorldManagerCorrectionLifecycle(row,'active')}):null,
          row?.status==='active'?guiEl('button',{class:'sga-btn',type:'button',text:'일시 중지',disabled:busy,dataset:{worldCorrectionStatus:'suspended'},onClick:()=>void setWorldManagerCorrectionLifecycle(row,'suspended')}):null,
          !['superseded','deleted'].includes(row?.status)?guiEl('button',{class:'sga-btn danger',type:'button',text:'삭제',disabled:busy,dataset:{worldCorrectionStatus:'deleted'},onClick:()=>void setWorldManagerCorrectionLifecycle(row,'deleted')}):null,
          !['superseded','deleted'].includes(row?.status)?guiEl('button',{class:'sga-btn primary',type:'button',text:'대체 수정',disabled:busy,dataset:{worldCorrectionReplaceAction:'true'},onClick:()=>openWorldManagerReplacementCorrection(row)}):null
        ])
      ]); });
      body=guiEl('div',{class:'sga-flow-section'},[
        guiEl('label',{class:'sga-field'},[guiEl('span',{text:'교정 상태'}),worldManagerSelect(Gui.worldManagerCorrectionFilter,statusOptions,value=>{Gui.worldManagerCorrectionFilter=value;Gui.worldManagerCorrectionCursor='';Gui.worldManagerCorrectionItems=[];Gui.worldManagerCorrectionsLoaded=false;Gui.worldManagerCorrectionHasMore=false;Gui.worldManagerCorrectionError='';queueGuiNavigationRender();})]),
        Gui.worldManagerCorrectionError?guiEl('div',{class:'sga-callout danger',text:Gui.worldManagerCorrectionError}):null,
        guiEl('div',{class:'sga-list-items'},cards.length?cards:[guiEl('div',{class:'sga-card wide sga-note',text:Gui.worldManagerCorrectionsLoading?'사용자 교정을 읽는 중입니다.':'사용자가 수정한 월드 매니저 항목이 없습니다.'})]),
        Gui.worldManagerCorrectionHasMore?guiEl('button',{class:'sga-btn',type:'button',text:'사용자 교정 더 보기',disabled:Gui.worldManagerCorrectionsLoading,onClick:()=>void loadWorldManagerCorrectionsPage(true)}):null
      ]);
    }
    return guiEl('div',{class:'sga-flow-section',dataset:{worldManagerHistoryDomain:domain}},[buildLibraHubTabs(tabs,Gui.worldManagerHistoryTab,value=>{Gui.worldManagerHistoryTab=value;},'기록과 교정'),body]);
  };
  const buildWorldManagerDomainShell = (domain,currentBuilder) => {
    Gui.worldManagerDomainSections=guiAsObject(Gui.worldManagerDomainSections); const selected=['current','history'].includes(Gui.worldManagerDomainSections[domain])?Gui.worldManagerDomainSections[domain]:'current'; Gui.worldManagerDomainSections[domain]=selected;
    const tabs=[{id:'current',label:'현재 상태'},{id:'history',label:'기록 · 교정'}];
    return guiEl('div',{class:'sga-flow-section'},[buildLibraHubTabs(tabs,selected,value=>{Gui.worldManagerDomainSections[domain]=value;},domain+' 화면'),selected==='history'?buildWorldManagerHistoryCorrectionsPanel(domain):currentBuilder()]);
  };
  const buildWorldManagerCharactersPanel = () => buildWorldManagerDomainShell('characters',buildWorldManagerCharactersCurrentPanel);
  const buildWorldManagerRelationshipsPanel = () => buildWorldManagerDomainShell('relationships',buildWorldManagerRelationshipsCurrentPanel);
  const buildWorldManagerWorldPanel = () => buildWorldManagerDomainShell('world',buildWorldManagerWorldCurrentPanel);

  const buildWorldManagerNarrativeCurrentPanel = () => {`);

  rep('connect_narrative_history_panel',
`      : Gui.narrativeHubSection === 'history'
        ? guiEl('div', { class: 'sga-callout', dataset: { narrativeHistoryPending: 'true' }, text: 'History와 Correction Journal은 명시적으로 이 화면을 연 뒤에만 페이지 단위로 조회하도록 다음 구현 단계에서 연결합니다.' })
        : buildWorldManagerNarrativeCurrentPanel();`,
`      : Gui.narrativeHubSection === 'history'
        ? buildWorldManagerHistoryCorrectionsPanel('narrative')
        : buildWorldManagerNarrativeCurrentPanel();`);

  return { source, labels };
};
