/* MEMORY SUITE SOURCE INPUT CONTROLS v1 BEGIN */
// View-only extension of the existing owner input policy. No model or raw-source write.
function mountMemorySuiteSourceInputControls(container, config) {
    const {owner,policy}=config,loadPreferences=()=>policy.ready(),sourceRules=()=>policy.sourceRules(),setSourceRules=rules=>policy.setSourceRules(rules);
    const disposed=()=>config.isDisposed?.()===true;
    const preferences={get sourceRules(){return memorySuiteSourceRules(owner);}};
    if(!container?.ownerDocument||container.querySelector('[data-source-input-controls]'))return;
    const doc=container.ownerDocument,box=doc.createElement('section');
    box.dataset.sourceInputControls=owner;box.className='ms-source-settings';container.prepend(box);
    const make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    const style=make('style');style.textContent=`
.ms-source-settings{font:14px/1.6 system-ui,-apple-system,'Malgun Gothic',sans-serif;display:grid;gap:14px;width:100%;max-width:960px;margin:0 auto 24px;color:inherit}
.ms-source-settings *{box-sizing:border-box}.ms-source-settings p,.ms-source-settings h3{margin:0}.ms-source-settings h3{font-size:18px}.ms-source-settings label{display:grid;gap:5px;font-size:13px}.ms-source-settings small{opacity:.8}
.ms-source-settings button,.ms-source-settings input,.ms-source-settings textarea,.ms-source-settings select{font:inherit;color:inherit;border:1px solid #8887;border-radius:9px;background:transparent;min-width:0;padding:8px 10px}.ms-source-settings textarea{width:100%;resize:vertical;min-height:42px}.ms-source-settings button{cursor:pointer;min-height:40px}.ms-source-settings button:disabled{opacity:.5;cursor:default}.ms-source-settings :is(button,input,textarea,select):focus-visible{outline:2px solid currentColor;outline-offset:2px}
.ms-source-settings .ms-input-list{display:grid;gap:10px}.ms-source-settings .ms-input-row{border:1px solid #8885;border-radius:12px;padding:14px;display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,230px) auto;gap:10px;align-items:start}.ms-source-settings .ms-input-fields{display:grid;gap:8px}.ms-source-settings .ms-custom-toggle{display:flex;align-items:center;gap:8px}.ms-source-settings .ms-custom-toggle input{margin:0}.ms-source-settings .ms-custom-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ms-source-settings [hidden]{display:none!important}
.ms-source-settings .ms-input-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ms-source-settings .ms-input-apply{background:#79522d;color:white;border-color:#79522d;font-weight:700}.ms-source-settings .ms-input-status{min-height:24px}.ms-source-settings .ms-input-preview{border-top:1px solid #8885;padding-top:14px;display:grid;gap:10px}.ms-source-settings pre{font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #8885;border-radius:10px;padding:14px;max-height:360px;overflow:auto;margin:0}.ms-source-settings .ms-input-warning{border-left:3px solid #b9802e;padding-left:10px}.ms-source-settings details{font-size:13px}.ms-source-settings summary{cursor:pointer}
@media(max-width:600px){.ms-source-settings .ms-input-row{grid-template-columns:minmax(0,1fr) auto}.ms-source-settings .ms-input-fields{grid-column:1/-1}.ms-source-settings .ms-custom-fields{grid-template-columns:1fr}.ms-source-settings .ms-input-actions button{flex:1}}
`;
    box.append(style,make('h3','분석할 내용'),make('p','설정 없이 바로 사용할 수 있습니다. 알 수 없는 외부 태그와 내용은 그대로 둡니다. 필요한 경우에만 아래 규칙을 바꾸세요.'));
    const list=make('div');list.dataset.sourceInputList='';list.className='ms-input-list';box.append(list);
    const actions=make('div'),apply=make('button','적용'),status=make('p');actions.className='ms-input-actions';apply.type='button';apply.className='ms-input-apply';apply.dataset.sourceInputApply='';apply.disabled=true;
    status.dataset.sourceInputStatus='';status.className='ms-input-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const toolbar=make('div'),add=make('button','태그 추가'),undo=make('button','삭제 되돌리기'),defaults=make('button','기본 규칙 복원');toolbar.className='ms-input-actions';
    for(const button of [add,undo,defaults]){button.type='button';button.disabled=true;}
    add.dataset.sourceInputAdd='';undo.dataset.sourceInputUndo='';defaults.dataset.sourceInputDefaults='';toolbar.append(add,undo,defaults);box.insertBefore(toolbar,list);
    actions.append(apply);box.append(actions,status,make('p','규칙은 적용을 눌러야 저장됩니다. 기본 규칙 복원도 초안만 바꿉니다. 기존 기억은 그대로 유지되며, 바꾸려면 원하는 구간을 직접 재분석하세요.'));
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
      const element=make('div'),fields=make('div'),tagLabel=make('label','태그 이름 또는 XML 예시'),valueInput=make('textarea'),customLabel=make('label'),custom=make('input'),customFields=make('div'),open=make('input'),close=make('input'),actionLabel=make('label','처리 방법'),action=make('select'),remove=make('button','삭제');
      element.dataset.sourceInputRow='';element.className='ms-input-row';fields.className='ms-input-fields';tagLabel.dataset.ruleTagLabel='';
      valueInput.dataset.ruleValue='';valueInput.rows=1;valueInput.placeholder='예: decoration 또는 <decoration>예시</decoration>';tagLabel.append(valueInput);
      custom.type='checkbox';custom.dataset.ruleCustom='';customLabel.className='ms-custom-toggle';customLabel.append(custom,make('span','직접 구분자'));
      customFields.className='ms-custom-fields';open.dataset.ruleOpen='';close.dataset.ruleClose='';open.type=close.type='text';open.maxLength=close.maxLength=256;
      const openLabel=make('label','여는 표식'),closeLabel=make('label','닫는 표식');openLabel.append(open);closeLabel.append(close);customFields.append(openLabel,closeLabel);
      for(const [optionValue,label]of Object.entries(actionNames)){const option=make('option',label);option.value=optionValue;action.append(option);}action.value=key;action.dataset.ruleAction='';actionLabel.append(action);
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
      fields.append(tagLabel,customLabel,customFields);if(control)fields.append(make('small',controlLabels[control]||'저장된 기본 규칙'));
      element.append(fields,actionLabel,remove);list.append(element);return row;
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
/* MEMORY SUITE SOURCE INPUT CONTROLS v1 END */
