/* MEMORY SUITE SOURCE INPUT CONTROLS v1 BEGIN */
// Owner input-rule controls and explicit review UI. Reanalysis stays in owner callbacks.
function mountMemorySuiteSourceInputControls(container, config) {
    const {owner,policy}=config,loadPreferences=()=>policy.ready(),sourceRules=()=>policy.sourceRules(),setSourceRules=rules=>policy.setSourceRules(rules);
    const disposed=()=>config.isDisposed?.()===true;
    const preferences={get sourceRules(){return memorySuiteSourceRules(owner);}};
    if(!container?.ownerDocument||container.querySelector('[data-source-input-controls]'))return;
    const doc=container.ownerDocument,box=doc.createElement('section');
    box.dataset.sourceInputControls=owner;box.className='ms-source-settings';container.prepend(box);
    const make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    const style=make('style');style.textContent=`
.ms-source-settings{display:grid;gap:12px;width:100%;min-width:0;color:inherit;font:inherit;font-size:var(--fs-body,13px);line-height:1.55}
.ms-source-settings *{box-sizing:border-box}.ms-source-settings p,.ms-source-settings h3{margin:0}.ms-source-settings h3{font-size:15px}.ms-source-settings label{display:grid;gap:5px;font-size:12.5px}.ms-source-settings small{opacity:.8}
.ms-source-settings button,.ms-source-settings input,.ms-source-settings textarea,.ms-source-settings select{font:inherit;font-size:13px;color:inherit;border:1px solid var(--border2,#8887);border-radius:var(--r-sm,8px);background:var(--input-bg,var(--surface,transparent));min-width:0;min-height:38px;padding:7px 10px}.ms-source-settings textarea{width:100%;resize:vertical;line-height:1.5}.ms-source-settings button{cursor:pointer;padding:7px 14px;font-weight:650;background:var(--surface,transparent)}.ms-source-settings button:hover:not(:disabled){background:var(--surface3,#8881)}.ms-source-settings button:disabled{opacity:.5;cursor:default}.ms-source-settings :is(button,input,textarea,select):focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:1px}
.ms-source-settings [hidden]{display:none!important}.ms-source-settings .ms-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.ms-source-settings .ms-input-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--border,#8884);border-radius:var(--r-md,11px);background:var(--surface2,transparent)}.ms-source-settings .ms-input-toolbar .ms-input-apply{margin-right:auto;min-width:88px}
.ms-source-settings .ms-input-apply{background:var(--accent,#79522d);color:var(--on-accent,#fff);border-color:var(--accent,#79522d)}.ms-source-settings .ms-input-apply:hover:not(:disabled){background:var(--accent-hover,var(--accent,#79522d))}
.ms-source-settings .ms-input-status:empty{display:none}.ms-source-settings .ms-input-status{font-weight:650}.ms-source-settings .ms-input-hint{font-size:12px;color:var(--text2,inherit)}
.ms-source-settings .ms-input-head,.ms-source-settings .ms-input-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(128px,160px) 110px 62px;gap:8px;align-items:center}
.ms-source-settings .ms-input-head{padding:0 11px;font-size:11.5px;font-weight:700;color:var(--text3,inherit)}
.ms-source-settings .ms-input-list{display:grid;gap:6px}.ms-source-settings .ms-input-row{padding:8px 10px;border:1px solid var(--border,#8884);border-radius:var(--r-md,11px);background:var(--surface,transparent)}
.ms-source-settings .ms-input-row textarea{min-height:38px;height:38px;white-space:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;resize:none}.ms-source-settings .ms-input-row select{width:100%}.ms-source-settings .ms-input-row [data-rule-delete]{padding:7px 8px}
.ms-source-settings .ms-input-fields{display:grid;gap:4px;min-width:0}.ms-source-settings .ms-custom-toggle{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;cursor:pointer}.ms-source-settings .ms-custom-toggle input{margin:0;min-height:0;width:16px;height:16px;accent-color:var(--accent,currentColor)}.ms-source-settings .ms-custom-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ms-source-settings .ms-input-chip{justify-self:start;padding:0 8px;border:1px solid var(--border2,#8886);border-radius:99px;font-size:11px;opacity:1;color:var(--text2,inherit)}
.ms-source-settings .ms-input-preview{border-top:1px solid var(--border,#8885);padding-top:12px;display:grid;gap:8px}.ms-source-settings .ms-input-preview>button{justify-self:start}.ms-source-settings pre{font:12.5px/1.6 var(--font-mono,ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--border,#8885);border-radius:var(--r-sm,8px);background:var(--surface2,transparent);padding:12px;max-height:360px;overflow:auto;margin:0}.ms-source-settings .ms-input-warning{border-left:3px solid var(--warn,#b9802e);padding-left:10px}.ms-source-settings details{font-size:12.5px}.ms-source-settings summary{cursor:pointer}
@media(max-width:600px){.ms-source-settings .ms-input-head{display:none}.ms-source-settings .ms-input-row{grid-template-columns:minmax(0,1fr) auto auto}.ms-source-settings .ms-input-fields{grid-column:1/-1}.ms-source-settings .ms-custom-fields{grid-template-columns:1fr}.ms-source-settings .ms-input-toolbar{display:grid;grid-template-columns:1fr 1fr}.ms-source-settings .ms-input-toolbar button{white-space:nowrap;padding:7px 8px}.ms-source-settings .ms-input-toolbar .ms-input-apply{margin-right:0}}
`;
    const toolbar=make('div'),apply=make('button','적용'),add=make('button','태그 추가'),undo=make('button','삭제 되돌리기'),defaults=make('button','기본 규칙 복원'),status=make('p');
    toolbar.className='ms-input-toolbar';apply.className='ms-input-apply';apply.dataset.sourceInputApply='';
    for(const button of [apply,add,undo,defaults]){button.type='button';button.disabled=true;}
    add.dataset.sourceInputAdd='';undo.dataset.sourceInputUndo='';defaults.dataset.sourceInputDefaults='';toolbar.append(apply,add,undo,defaults);
    status.dataset.sourceInputStatus='';status.className='ms-input-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const hint=make('p','저장된 태그 규칙을 확인·편집합니다. 적용을 눌러야 저장되며 기본 규칙 복원도 초안만 바꿉니다. 알 수 없는 외부 태그는 그대로 두고, 기존 기억은 유지됩니다. 바꾸려면 원하는 구간을 직접 재분석하세요.');hint.className='ms-input-hint';
    const head=make('div');head.className='ms-input-head';head.setAttribute('aria-hidden','true');head.append(make('span','태그 이름 · XML 예시 · 표식'),make('span','처리 방법'),make('span','직접 구분자'),make('span'));
    const list=make('div');list.dataset.sourceInputList='';list.className='ms-input-list';
    box.append(style,toolbar,status,hint,head,list);
    const previewArea=make('section'),previewButton=make('button','현재 채팅 미리보기'),previewStatus=make('p'),warning=make('p'),output=make('pre');
    previewArea.className='ms-input-preview';previewButton.type='button';previewButton.dataset.sourceInputPreview='';previewButton.disabled=true;
    previewStatus.dataset.sourceInputPreviewStatus='';previewStatus.setAttribute('role','status');previewStatus.setAttribute('aria-live','polite');
    warning.dataset.sourceInputWarning='';warning.className='ms-input-warning';warning.setAttribute('role','alert');warning.hidden=true;
    output.dataset.sourceInputOutput='';output.hidden=true;output.setAttribute('aria-label','실제 분석 입력 미리보기');
    previewArea.append(previewButton,make('small','현재 채팅에서 불러온 메시지를 기준으로 실제 분석 입력을 보여 줍니다. AI를 호출하지 않으며 미리보기 본문을 저장하거나 로그에 남기지 않습니다.'),previewStatus,warning,output);box.append(previewArea);
    const help=make('details'),summary=make('summary','규칙 사용 방법');help.append(summary,make('p','태그 이름(예: original), 여는 태그 또는 XML 예시를 붙여 넣으세요. 표준 태그는 닫는 태그를 자동으로 찾습니다. 일반 표식은 직접 구분자를 켜고 여는 표식과 닫는 표식을 입력하세요. 내용 전체 제외 → 태그와 내용 제거, 태그만 제거 → 안의 내용 유지, 이 안만 분석 → 바깥 내용 제외입니다. 적용 순서는 이 안만 분석, 내용 전체 제외, 태그만 제거입니다. 선택 영역이 비어 있거나 불완전·중복이면 전체 본문을 사용하며 미리보기에 경고합니다. Suite 자체 운용 표식은 내부에서 처리합니다.'));box.append(help);
    const controlLabels={'html-comment':'HTML 주석','lbdata':'LBDATA 제어 블록','inlay':'삽화 호출'};
    const actionNames={ignoredTags:'내용 전체 제외',unwrapTags:'태그만 제거',sourceTags:'이 안만 분석'};
    let rows=[],removed=[],loaded=false,applying=false,initial='',legacy=false,sample=null,previewVersion=0,readingSample=false;
    const isEmpty=row=>row.custom.checked?!row.open.value.trim()&&!row.close.value.trim():!row.value.value.trim();
    function inferTag(input) {
      const value=input.trim();
      if(/^[a-z][a-z0-9:_-]{0,63}$/i.test(value))return value.toLowerCase();
      const tag=/^<([a-z][a-z0-9:_-]{0,63})(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/i.exec(value);
      if(tag){const rest=value.slice(tag[0].length);if(!rest.trim()||new RegExp('</'+tag[1]+'\\s*>$','i').test(rest))return tag[1].toLowerCase();}
      throw Error('태그 이름 또는 짝이 맞는 XML 예시를 입력하세요. 일반 표식은 직접 구분자를 켜 주세요.');
    }
    function readDraft() {
      const draft={version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]};
      for(const row of rows){
        if(isEmpty(row))continue;
        const key=row.action.value;
        if(row.custom.checked){
          const entry={open:row.open.value,close:row.close.value};
          const form=row.control&&memorySuiteSourceRuleForm('@'+row.control);
          if(form&&key==='ignoredTags'&&entry.open===form.open&&entry.close===form.close)draft.controls.push(row.control);
          else draft[key].push(entry);
        }else draft[key].push(inferTag(row.value.value));
      }
      return memorySuiteNormalizeSourceRules(draft);
    }
    const fingerprint=rules=>JSON.stringify(memorySuiteNormalizeSourceRules(rules));
    function setEnabled() {
      for(const row of rows){for(const node of row.element.querySelectorAll('input,textarea,select,button'))node.disabled=!loaded||applying;row.remove.disabled=!loaded||applying||isEmpty(row);}
      let dirty=true;try{dirty=fingerprint(readDraft())!==initial;}catch{}
      apply.disabled=!loaded||applying||!dirty;
      add.disabled=defaults.disabled=!loaded||applying;undo.disabled=!loaded||applying||!removed.length;
      previewButton.disabled=!loaded||applying||readingSample||typeof config.readSample!=='function';
    }
    async function showPreview() {
      if(!sample)return;
      const version=++previewVersion;
      warning.hidden=true;warning.textContent='';output.textContent='';output.hidden=true;
      try{
        const rules=readDraft();let projected;
        if(legacy&&fingerprint(rules)===initial){
          if(typeof config.projectLegacySample!=='function'){previewStatus.textContent='기본 분석 입력을 미리 볼 수 없습니다.';return;}
          projected={text:await config.projectLegacySample(sample),warnings:[]};
        }else projected=memorySuiteProjectSourceRules(memorySuiteStripInternalSource(sample.text),rules);
        if(disposed()||version!==previewVersion)return;
        output.textContent=String(projected.text??'').replace(/\r\n/g,'\n').trim();output.hidden=false;
        warning.textContent=projected.warnings.join(' ');warning.hidden=!projected.warnings.length;
        previewStatus.textContent=(sample.label?sample.label+' · ':'')+(output.textContent?'불러온 메시지의 분석 입력':'분석할 내용이 없습니다.')+(fingerprint(rules)!==initial?' · 아직 적용하지 않은 규칙':'');
      }catch(e){if(disposed()||version!==previewVersion)return;warning.textContent=String(e.message||e);warning.hidden=false;previewStatus.textContent='규칙을 확인한 뒤 다시 미리 보세요.';}
    }
    function changed() {
      if(!loaded||applying)return;
      if(!rows.some(isEmpty))addRow();
      status.textContent='변경한 규칙을 적용해 주세요.';setEnabled();void showPreview();
    }
    function addRow(value=null,key='ignoredTags',control=null) {
      const hidden=text=>{const span=make('span',text);span.className='ms-sr-only';return span;};
      const element=make('div'),fields=make('div'),tagLabel=make('label'),valueInput=make('textarea'),customLabel=make('label'),custom=make('input'),customFields=make('div'),open=make('input'),close=make('input'),actionLabel=make('label'),action=make('select'),remove=make('button','삭제');
      element.dataset.sourceInputRow='';element.className='ms-input-row';fields.className='ms-input-fields';tagLabel.dataset.ruleTagLabel='';
      valueInput.dataset.ruleValue='';valueInput.rows=1;valueInput.placeholder='예: decoration 또는 <decoration>예시</decoration>';tagLabel.append(hidden('태그 이름 또는 XML 예시'),valueInput);
      custom.type='checkbox';custom.dataset.ruleCustom='';customLabel.className='ms-custom-toggle';customLabel.append(custom,make('span','직접 구분자'));
      customFields.className='ms-custom-fields';open.dataset.ruleOpen='';close.dataset.ruleClose='';open.type=close.type='text';open.maxLength=close.maxLength=256;open.placeholder='여는 표식 예: [START]';close.placeholder='닫는 표식 예: [END]';
      const openLabel=make('label'),closeLabel=make('label');openLabel.append(hidden('여는 표식'),open);closeLabel.append(hidden('닫는 표식'),close);customFields.append(openLabel,closeLabel);
      for(const [optionValue,label]of Object.entries(actionNames)){const option=make('option',label);option.value=optionValue;action.append(option);}action.value=key;action.dataset.ruleAction='';actionLabel.append(hidden('처리 방법'),action);
      remove.type='button';remove.dataset.ruleDelete='';remove.setAttribute('aria-label','이 규칙 삭제');
      if(value&&typeof value==='object'){custom.checked=true;open.value=value.open;close.value=value.close;}else if(value)valueInput.value=value;
      const row={element,value:valueInput,custom,open,close,action,remove,control};rows.push(row);
      const syncMode=()=>{tagLabel.hidden=custom.checked;customFields.hidden=!custom.checked;};syncMode();
      custom.onchange=()=>{
        if(custom.checked&&!open.value&&!close.value&&valueInput.value.trim()){
          try{const name=inferTag(valueInput.value);open.value='<'+name+'>';close.value='</'+name+'>';}catch{open.value=valueInput.value;}
        }
        if(!custom.checked&&(open.value||close.value))valueInput.value=open.value||close.value;
        syncMode();changed();
      };valueInput.oninput=open.oninput=close.oninput=changed;action.onchange=changed;
      remove.onclick=()=>{if(!loaded||applying||isEmpty(row))return;removed.push({row,index:rows.indexOf(row)});if(removed.length>128)removed.shift();rows=rows.filter(item=>item!==row);element.remove();changed();};
      fields.append(tagLabel,customFields);if(control){const chip=make('small',controlLabels[control]||'저장된 기본 규칙');chip.className='ms-input-chip';fields.append(chip);}
      element.append(fields,actionLabel,customLabel,remove);list.append(element);return row;
    }
    function fill(rules=sourceRules(),resetInitial=true) {
      rows=[];removed=[];list.replaceChildren();
      for(const key of Object.keys(actionNames))for(const entry of rules[key])addRow(entry,key);
      for(const control of rules.controls)addRow(memorySuiteSourceRuleForm('@'+control),'ignoredTags',control);
      addRow();if(resetInitial){initial=fingerprint(rules);legacy=!preferences.sourceRules;}setEnabled();
    }
    add.onclick=()=>{if(!loaded||applying||disposed())return;const row=rows.find(isEmpty)||addRow();row.element.scrollIntoView?.({block:'nearest'});row.value.focus();};
    undo.onclick=()=>{if(!loaded||applying||disposed())return;const entry=removed.pop();if(!entry)return;const index=Math.min(entry.index,rows.length);list.insertBefore(entry.row.element,rows[index]?.element||null);rows.splice(index,0,entry.row);changed();status.textContent='삭제한 규칙을 되돌렸습니다. 적용 전입니다.';};
    defaults.onclick=()=>{if(!loaded||applying||disposed())return;fill({...memorySuiteDefaultSourceRules(owner),ignoredTags:[...memorySuiteSourceIgnoredTags(),'thoughts']},false);changed();status.textContent='기본 규칙을 복원한 초안입니다. 적용을 눌러야 저장됩니다.';};
    apply.onclick=async()=>{
      if(!loaded||applying||disposed())return;
      let rules;try{rules=readDraft();if(fingerprint(rules)===initial)return;}catch(e){status.textContent='적용 실패: '+String(e.message||e);return;}
      applying=true;status.textContent='적용 중…';setEnabled();
      try{await setSourceRules(rules);if(disposed())return;fill();status.textContent='규칙을 적용했습니다. 기존 기억은 유지됩니다.';await showPreview();}
      catch(e){if(!disposed())status.textContent='적용 실패: '+String(e.message||e);}
      finally{applying=false;if(!disposed())setEnabled();}
    };
    previewButton.onclick=async()=>{
      if(!loaded||readingSample||disposed()||typeof config.readSample!=='function')return;
      readingSample=true;sample=null;const version=++previewVersion;output.textContent='';output.hidden=true;warning.textContent='';warning.hidden=true;previewStatus.textContent='현재 채팅을 읽는 중…';setEnabled();
      try{
        const result=await config.readSample();if(disposed()||version!==previewVersion)return;
        if(result==null){previewStatus.textContent='현재 채팅에 미리 볼 메시지가 없습니다.';return;}
        if(typeof result!=='string'&&typeof result.text!=='string')throw Error('SOURCE_SAMPLE_INVALID');
        sample=typeof result==='string'?{text:result}:result;await showPreview();
      }catch{if(!disposed()&&version===previewVersion)previewStatus.textContent='현재 채팅을 읽지 못했습니다. 잠시 뒤 다시 미리 보세요.';}
      finally{readingSample=false;if(!disposed())setEnabled();}
    };
    status.textContent='저장된 규칙을 읽는 중…';
    loadPreferences().then(()=>{if(disposed())return;loaded=true;fill();status.textContent='';if(typeof config.readSample!=='function')previewStatus.textContent='현재 채팅 미리보기를 사용할 수 없습니다.';}).catch(()=>{if(!disposed())status.textContent='저장된 규칙을 읽지 못했습니다. 설정을 다시 열어 주세요.';});
  }

function memorySuiteReanalysisGridCss(){return `
.ms-reanalysis-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));grid-auto-flow:row dense;gap:10px;min-width:0}
.ms-reanalysis-turn--compact{display:flex;flex-direction:column;gap:5px;aspect-ratio:1/1;min-width:0;min-height:0;padding:12px;border:1px solid var(--border,#8885);border-radius:var(--r-md,12px);background:var(--surface,transparent);overflow:hidden;overflow-wrap:anywhere;cursor:pointer;transition:border-color .16s,box-shadow .16s,background .16s}
.ms-reanalysis-turn--compact:hover{border-color:var(--border2,#8889)}
.ms-reanalysis-turn--compact:has(>label input:checked){border-color:var(--accent,#79522d);box-shadow:inset 0 0 0 1px var(--accent,#79522d);background:var(--accent-soft,var(--surface,transparent))}
.ms-reanalysis-turn--compact:has(>label input:disabled){cursor:default;opacity:.75}
.ms-reanalysis-turn--compact>label{display:flex;align-items:flex-start;gap:8px;min-width:0;cursor:pointer}
.ms-reanalysis-turn--compact>label input{flex:none;width:17px;height:17px;margin:1px 0 0;accent-color:var(--accent,#79522d)}
.ms-reanalysis-turn--compact>label strong{min-width:0;font-size:14px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.ms-reanalysis-turn--compact .ms-turn-meta{margin:0;font-size:11.5px;line-height:1.45;color:var(--text3,inherit);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.ms-reanalysis-turn--compact .ms-turn-eyebrow{font-size:11px;font-weight:700;color:var(--text3,inherit);letter-spacing:.02em}
.ms-reanalysis-turn--compact .ms-turn-summary{flex:0 1 auto;min-height:0;margin:0;font-size:12.5px;line-height:1.55;color:var(--text2,inherit);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5}
.ms-reanalysis-turn--compact>details{margin-top:auto;font-size:12px}
.ms-reanalysis-turn--compact>details>summary{cursor:pointer;color:var(--text2,inherit);font-weight:650}
.ms-reanalysis-turn--compact pre{margin:8px 0 0;padding:10px 12px;max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--border,#8885);border-radius:var(--r-sm,8px);background:var(--surface2,transparent);font:12px/1.6 var(--font-mono,ui-monospace,monospace)}
.ms-reanalysis-turn--compact.is-open{grid-column:1/-1;aspect-ratio:auto;cursor:default}
.ms-reanalysis-turn--compact.is-open .ms-turn-summary{display:block;white-space:pre-wrap}
@media(max-width:600px){.ms-reanalysis-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ms-reanalysis-turn--compact{padding:10px}.ms-reanalysis-turn--compact .ms-turn-summary{-webkit-line-clamp:4}}
`;}
// One card per turn keeps checkboxes aligned and allows source inspection without dispatch.
function appendMemorySuiteReanalysisRange(list,range,config) {
  const doc=list.ownerDocument,make=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const row=make('section'),label=make('label'),input=make('input'),details=make('details'),summary=make('summary','원문 보기'),output=make('pre');
  input.type='checkbox';input.value=range.key;input.setAttribute('aria-label',range.label+' 재분석 선택');input.onchange=config.changed;
  if(config.compact){
    // Square cards: many turns per screen; opening the source widens the card to a full row.
    const host=list.getRootNode?.()?.head||list.getRootNode?.();
    if(host?.querySelector&&!host.querySelector('style[data-ms-reanalysis-grid]')){const style=make('style');style.dataset.msReanalysisGrid='';style.textContent=memorySuiteReanalysisGridCss();host.append(style);}
    row.className='ms-reanalysis-turn ms-reanalysis-turn--compact';
    const title=make('strong',range.label);title.title=range.label;label.append(input,title);row.append(label);
    if(range.description){const description=make('p',range.description);description.className='ms-turn-meta';description.title=range.description;row.append(description);}
    if(range.summary){const eyebrow=make('small','저장된 내용'),excerpt=make('p',range.summary);eyebrow.className='ms-turn-eyebrow';excerpt.className='ms-turn-summary';excerpt.title=range.summary;row.append(eyebrow,excerpt);}
    row.onclick=event=>{if(!event.target.closest?.('label,details,button,a')&&!input.disabled)input.click();};
  }else{
    row.className='ms-reanalysis-turn';row.style.cssText='display:grid;gap:8px;padding:14px;border:1px solid #8885;border-radius:12px;min-width:0';
    label.style.cssText='display:flex;align-items:center;gap:10px';
    label.append(input,make('strong',range.label));row.append(label);
    if(range.description){const description=make('p',range.description);description.style.cssText='margin:0;white-space:pre-wrap;overflow-wrap:anywhere';row.append(description);}
    if(range.summary){const excerpt=make('p','저장된 내용 · '+range.summary);excerpt.style.cssText='margin:0;white-space:pre-wrap;overflow-wrap:anywhere';row.append(excerpt);}
    output.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto';
  }
  details.append(summary,output);row.append(details);list.append(row);
  let serial=0;
  details.ontoggle=async()=>{
    if(config.compact)row.classList.toggle('is-open',details.open);
    if(!details.open){serial++;return;}
    const token=++serial;output.textContent='원문을 읽는 중…';
    try{const sample=await config.read();if(!row.isConnected||!config.current()||token!==serial)return;
      output.textContent='사용자 원문\n'+memorySuiteStripInternalSource(sample.user)+'\n\nAI 응답 원문\n'+memorySuiteStripInternalSource(sample.assistant);
    }catch(error){if(row.isConnected&&config.current()&&token===serial)output.textContent='원문 조회 실패: '+String(error?.message||error);}
  };
}

// Source text stays in the mounted view. Only user-confirmed tag rules are saved.
function memorySuiteExtractSelectedSourceTags(body,start,end) {
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>body.length)return [];
  const names=[...new Set([...body.matchAll(/<\/?([a-z][a-z0-9:_-]*)(?=[\s/>])/gi)].map(m=>m[1].toLowerCase()))];
  const candidates=[];
  for(const name of names){
    if(memorySuiteIsInternalSourceRule(name))continue;
    const parsed=memorySuiteSourceTagRanges(body,[name]);
    if(parsed.invalid)continue;
    for(const range of parsed.ranges)if((range.start>=start&&range.end<=end)||(range.start<=start&&range.end>=end))
      candidates.push({entry:name,start:range.start,end:range.end});
  }
  // Literal module delimiters are editable too; never infer a rule from ordinary prose.
  const literals=[{open:'<!--',close:'-->'},...[...body.matchAll(/\[([^\]\r\n]{1,100}) START\]/g)].map(m=>({open:m[0],close:'['+m[1]+' END]'}))];
  for(const entry of literals){const parsed=memorySuiteLiteralRanges(body,[entry]);if(parsed.invalid)continue;
    for(const range of parsed.ranges)if((range.start>=start&&range.end<=end)||(range.start<=start&&range.end>=end))candidates.push({entry,start:range.start,end:range.end});}
  const inside=candidates.filter(r=>r.start>=start&&r.end<=end);
  const chosen=inside.length?inside:candidates.sort((a,b)=>(a.end-a.start)-(b.end-b.start)).slice(0,1);
  return [...new Map(chosen.map(r=>[JSON.stringify(r.entry),r.entry])).values()].slice(0,128);
}

function mountMemorySuiteReanalysisReview(container,config) {
  const doc=container.ownerDocument,make=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const box=make('section');box.className='ms-source-settings';box.dataset.sourceReanalysisReview='';container.replaceChildren(box);
  const style=make('style');style.textContent=`
[data-source-reanalysis-review]{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0;padding:12px;border:1px solid #8885;border-radius:12px}
[data-source-reanalysis-review]>*{min-width:0;overflow-wrap:anywhere}
[data-source-reanalysis-review] label{grid-template-columns:minmax(0,1fr)}
[data-source-reanalysis-review] textarea{width:100%;min-height:180px;resize:vertical;font:13px/1.6 ui-monospace,monospace;white-space:pre}
[data-source-reanalysis-review] pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}
[data-source-reanalysis-review] [data-review-rule]{display:flex;gap:8px;flex-wrap:wrap;align-items:center;border:1px solid #8885;padding:10px;border-radius:10px}
[data-source-reanalysis-review] input{min-width:0;max-width:100%}[data-source-reanalysis-review] button{cursor:pointer;min-height:40px}
[data-source-reanalysis-review] [hidden]{display:none!important}
`;
  const status=make('p');status.dataset.reviewStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  box.append(style,make('h3',config.sample.label+' · 확인 후 재분석'),make('p','원문에서 제외할 부분을 드래그한 뒤 태그를 추출하세요. 추출한 태그를 확인·편집하고 적용 결과를 확인할 수 있습니다. 저장한 태그 규칙은 이 플러그인의 앞으로의 분석에도 적용됩니다. 채팅 원문은 바꾸지 않습니다.'));
  const sources=[];let active=null,busy=false,applied=null,baseline=null;
  const valid=()=>box.isConnected&&config.current();
  const list=make('div'),preview=make('div'),extract=make('button','선택 영역에서 태그 추출'),add=make('button','태그 직접 추가'),apply=make('button','태그 적용'),run=make('button','태그 저장 후 재분석'),cancel=make('button','검토 닫기');
  extract.type=add.type=apply.type=run.type=cancel.type='button';extract.dataset.reviewExtract='';apply.dataset.reviewApply='';run.dataset.reviewRun='';run.disabled=true;
  const saved=make('details'),savedSummary=make('summary'),savedList=make('div');saved.append(savedSummary,savedList);list.dataset.reviewCandidates='';
  const updateSavedCount=()=>{savedSummary.textContent='저장된 태그 규칙 '+savedList.children.length+'개 · 확인·편집';};
  const rules=[];let applyVersion=0,expectedPolicy='';
  const policyKey=()=>JSON.stringify(memorySuiteNormalizeSourceRules(config.policy.sourceRules()));
  const assertPolicy=()=>{if(policyKey()!==expectedPolicy)throw Error('저장된 태그 규칙이 변경되었습니다. 검토를 다시 열어 주세요.');};
  function dirty(){applyVersion++;applied=null;run.disabled=true;preview.replaceChildren();status.textContent='태그를 적용해 분석할 내용을 먼저 확인하세요.';}
  function addRule(entry={open:'',close:''},key='ignoredTags',control=null,target=list){
    const row=make('div'),open=make('input'),close=make('input'),action=make('select'),remove=make('button','삭제');row.dataset.reviewRule='';
    const form=memorySuiteSourceRuleForm(entry);open.value=form.open;close.value=form.close;open.maxLength=close.maxLength=256;
    open.setAttribute('aria-label','여는 태그');close.setAttribute('aria-label','닫는 태그');
    for(const [value,label]of [['ignoredTags','내용 전체 제외'],['unwrapTags','태그만 제거'],['sourceTags','이 안만 분석']]){const option=make('option',label);option.value=value;action.append(option);}action.value=key;action.setAttribute('aria-label','태그 처리 방법');
    remove.type='button';const value={row,open,close,action,control};rules.push(value);
    open.oninput=close.oninput=action.onchange=dirty;remove.onclick=()=>{if(busy)return;rules.splice(rules.indexOf(value),1);row.remove();updateSavedCount();dirty();};row.append(open,close,action,remove);target.append(row);updateSavedCount();return value;
  }
  function read(){const draft={version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]};
    for(const row of rules){if(!row.open.value.trim()&&!row.close.value.trim())continue;const entry={open:row.open.value,close:row.close.value},form=row.control&&memorySuiteSourceRuleForm('@'+row.control);if(form&&row.action.value==='ignoredTags'&&entry.open===form.open&&entry.close===form.close)draft.controls.push(row.control);else draft[row.action.value].push(entry);}
    return memorySuiteNormalizeSourceRules(draft);
  }
  function lock(value){busy=value;for(const n of box.querySelectorAll('input,select,button'))n.disabled=value;run.disabled=value||!applied;}
  for(const [role,label]of [['user','사용자 원문'],['assistant','AI 응답 원문']]){
    const wrap=make('label',label),input=make('textarea');input.readOnly=true;input.value=memorySuiteStripInternalSource(config.sample[role]||'');input.setAttribute('aria-label',label);input.dataset.reviewSource=role;
    const select=()=>{active=input;};input.onselect=input.onmouseup=input.onkeyup=select;wrap.append(input);box.append(wrap);sources.push({role,input});
  }
  const actions=make('div');actions.className='cluster';actions.append(extract,add);box.append(actions,make('h3','앞으로 적용할 태그 규칙'),saved,list,apply,preview,run,cancel,status);
  extract.onclick=()=>{
    if(busy)return;if(!active){status.textContent='원문에서 제외할 영역을 먼저 선택하세요.';return;}const entries=memorySuiteExtractSelectedSourceTags(active.value,active.selectionStart,active.selectionEnd);
    if(!entries.length){status.textContent='선택 영역에서 짝이 맞는 태그를 찾지 못했습니다. 태그를 포함해 선택하거나 직접 추가하세요.';return;}
    let first;
    for(const entry of entries){const form=memorySuiteSourceRuleForm(entry),existing=rules.find(r=>r.open.value===form.open&&r.close.value===form.close);const row=existing||addRule(entry);if(existing&&savedList.contains(existing.row))saved.open=true;first||=row;}
    dirty();status.textContent='추출한 태그를 확인·편집한 뒤 태그 적용을 누르세요.';
    first?.row.scrollIntoView?.({block:'nearest'});
  };
  add.onclick=()=>{if(busy)return;addRule();dirty();rules.at(-1).open.focus();};
  apply.onclick=async()=>{
    if(busy||!baseline||!valid())return;const version=++applyVersion;
    try{
      assertPolicy();const draft=read();preview.replaceChildren();let warned=false;
      const same=JSON.stringify(draft)===JSON.stringify(baseline.rules);
      for(const {role,input}of sources){
        const raw=config.sample[role]||'';
        const result=baseline.legacy&&same?{text:await config.projectLegacySample({text:raw,role}),warnings:[]}:memorySuiteProjectSourceRules(input.value,draft);
        if(!valid()||version!==applyVersion)return;
        if(!String(result.text||'').trim())throw Error('분석할 '+(role==='user'?'사용자 내용':'AI 응답')+'이 비어 있습니다. 제외 규칙을 확인하세요.');
        const output=make('pre',result.text);output.dataset.reviewOutput=role;preview.append(make('h3',role==='user'?'분석할 사용자 내용':'분석할 AI 응답'),output);
        for(const warning of result.warnings){preview.append(make('p',warning));warned=true;}
      }
      applied=JSON.stringify(draft);run.disabled=false;status.textContent=warned?'경고와 실제 분석 입력을 확인하세요. 저장 후 재분석할 수 있습니다.':'적용 결과를 확인했습니다. 태그를 저장한 뒤 재분석할 수 있습니다.';
    }catch(error){dirty();status.textContent='태그 적용 실패: '+String(error?.message||error);}
  };
  run.onclick=async()=>{
    if(busy||!applied||!valid())return;lock(true);config.onBusy?.(true);
    try{
      // Validate before the settings write and again before dispatching. A review
      // cannot silently apply to edited text or to a different chat/selection.
      await config.validate();if(!valid())return;assertPolicy();
      const draft=read();if(JSON.stringify(draft)!==applied)throw Error('태그 적용 결과가 만료되었습니다. 다시 적용하세요.');
      if(JSON.stringify(draft)!==JSON.stringify(baseline.rules)){
        await config.policy.setSourceRules(draft);expectedPolicy=JSON.stringify(draft);
        baseline={rules:draft,legacy:false};
      }
      if(!valid())return;await config.validate();if(!valid())return;
      status.textContent='태그 저장을 확인했습니다. 재분석을 준비합니다.';
      const guard=async()=>{await config.validate();if(policyKey()!==JSON.stringify(draft))throw Error('저장된 태그 규칙이 변경되었습니다. 다시 확인하세요.');};
      await config.onRun(guard);
    }catch(error){if(valid())status.textContent='재분석 중단: '+String(error?.message||error);}
    finally{config.onBusy?.(false);if(valid())lock(false);}
  };
  cancel.onclick=()=>{if(!busy){container.replaceChildren();config.onClose?.();}};
  lock(true);
  config.policy.ready().then(prefs=>{
    if(!valid())return;const draft=config.policy.sourceRules();baseline={rules:memorySuiteNormalizeSourceRules(draft),legacy:!prefs.sourceRules};expectedPolicy=policyKey();
    for(const key of ['ignoredTags','unwrapTags','sourceTags'])for(const entry of draft[key])addRule(entry,key,null,savedList);
    for(const control of draft.controls)addRule(memorySuiteSourceRuleForm('@'+control),'ignoredTags',control,savedList);
    lock(false);status.textContent='제외할 영역을 선택하거나 저장된 규칙을 적용해 원문을 확인하세요.';
  }).catch(error=>{if(valid())status.textContent='규칙 조회 실패: '+String(error?.message||error);});
  return box;
}
/* MEMORY SUITE SOURCE INPUT CONTROLS v1 END */
