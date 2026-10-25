'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const {extract,literal}=require('../helpers/libra_approved_gui_contract.cjs');
const source=fs.readFileSync(path.join(__dirname,'../../plugins/LIBRA.js'),'utf8');
const code=source.slice(source.indexOf('  const closeCanonicalRangeDrawer ='),source.indexOf('  const buildBookMemoryModelSummary ='));
const dependencies=['optionNodes','libraStatusBadge','canonicalReaderBinding','canonicalReaderBindingKey','bindApprovedOverlayKeyboard'].map(name=>extract(source,name)).join('\n');
function fixture(options={}){
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),document=dom.window.document,root=document.querySelector('main'),Gui={visible:true,root,app:root,openSerial:1},calls=[];
  const inventory={scopeKey:'scope-a',topology:'topology-a',ranges:Array.from({length:10},(_,i)=>({key:String(i+1),start:i+1,end:i+1,label:'T'+(i+1),identity:'identity-'+(i+1),batchStart:i<5?1:6,batchEnd:i<5?5:10,summary:'저장된 기억'}))};
  const guiEl=(tag,attrs={},children=[])=>{const el=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='text')el.textContent=v;else if(k==='class')el.className=v;else if(k==='dataset')Object.assign(el.dataset,v);else if(k.startsWith('on'))el.addEventListener(k.slice(2).toLowerCase(),v);else if(k in el)el[k]=v;else el.setAttribute(k,v);}for(const child of children.flat())if(child)el.append(child);return el;};
  const core=options.core||{peekSnapshot:()=>({scope:{scopeKey:options.scope?.()||'scope-a'},manifest:{memories:{1:{status:'committed'}}}}),
    listReanalysisRanges:async()=>options.inventory?options.inventory():inventory,
    reanalyzeSelectedRanges:async input=>{calls.push(JSON.parse(JSON.stringify(input)));return options.run?options.run(input):{ok:true};},mountSourceInputControls:()=>{}};
  const context=vm.createContext({document,Gui,guiEl,MutationObserver:dom.window.MutationObserver,queueMicrotask,text:value=>String(value??''),LIBRA_APPROVED_RANGE_DIALOG_HTML:literal(source,'LIBRA_APPROVED_RANGE_DIALOG_HTML'),LENS_RUN_MAX_TURNS:literal(source,'LENS_RUN_MAX_TURNS'),LibraMemoryCore:core,
    guiSetStatus:message=>calls.push({status:message}),runCanonicalGuiCommand:async(_message,fn)=>fn(),libraMemoryFailureDiagnostic:error=>({title:'error',message:String(error)})});
  if(!options.core){
    const sdk=['MemorySuiteSourceInput.libra.source.js','MemorySuiteSourceInputControls.source.js'].map(file=>fs.readFileSync(path.join(__dirname,'../../sdk',file),'utf8')).join('\n');vm.runInContext(sdk,context);
    core.appendReanalysisRange=(...args)=>context.appendMemorySuiteReanalysisRange(...args);
  }
  vm.runInContext(dependencies+'\n'+code+'\nglobalThis.show=showCanonicalRangeDrawer;globalThis.showSource=showLibraSourceReanalysisDrawer;',context);
  const select=(turn,checked=true)=>{const input=root.querySelector('[data-reanalysis-ranges] input[value="'+turn+'"]');if(!input)throw Error('Turn not available');input.checked=checked;input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  return {dom,document,Gui,root,calls,select,show:options=>options?context.showSource(options):context.show('source_edit'),showGeneration:()=>context.show('missing'),close:()=>{Gui.canonicalRangeDrawerClose?.();dom.window.close();}};
}
module.exports={fixture,source};
