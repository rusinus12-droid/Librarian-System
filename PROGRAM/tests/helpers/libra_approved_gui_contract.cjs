'use strict';
// Approved mockup identity and source extraction, independent of current output.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let _acorn;
function getAcorn(){
  if(!_acorn){
    try{_acorn=require('acorn');}
    catch(_){
      try{_acorn=require('../../tools/build_plugins.cjs').resolveAcorn();}
      catch(__){}
    }
  }
  if(!_acorn)throw Error('Missing acorn');
  return _acorn;
}
const mockPath=path.resolve(__dirname,'../../docs/gui-redesign/libra.html');
let _original;
function getOriginal(){
  if(!_original){
    const {JSDOM}=require('jsdom');
    _original=new JSDOM(fs.readFileSync(mockPath,'utf8')).window.document;
  }
  return _original;
}
const cache=new Map;
function declarations(source){if(cache.has(source))return cache.get(source);const nodes=new Map;const walk=n=>{if(!n||typeof n!=='object')return;if(n.type==='VariableDeclaration')for(const d of n.declarations)if(d.id.type==='Identifier')nodes.set(d.id.name,{statement:n,value:d.init});if(n.type==='FunctionDeclaration'&&n.id)nodes.set(n.id.name,{statement:n,value:n});for(const key in n)Array.isArray(n[key])?n[key].forEach(walk):walk(n[key]);};walk(getAcorn().parse(source,{ecmaVersion:'latest'}));cache.set(source,nodes);return nodes;}
function extract(source,name){const entry=declarations(source).get(name);assert.ok(entry,`current production declaration ${name} exists`);return source.slice(entry.statement.start,entry.statement.end);}
function literal(source,name){const entry=declarations(source).get(name);assert.ok(entry?.value?.type==='Literal',`${name} must be a literal original asset`);return entry.value.value;}
// The user-approved identity manager replaces the former merge/split prototype.
// Keep all other literal identities fixed, and validate this dialog's contract.
function identityManagerContract(parsed){
  const dialog=parsed.querySelector('[role="dialog"]');assert.ok(dialog,'identity manager is a dialog');assert.equal(dialog.getAttribute('aria-modal'),'true');
  assert.deepEqual([...parsed.querySelectorAll('[data-identity-mode]')].map(node=>node.dataset.identityMode),['merge','split']);
  assert.match(parsed.querySelector('[data-identity-mode="merge"]').textContent,/두 카드/);assert.match(parsed.querySelector('[data-identity-mode="split"]').textContent,/사실.*인물별/);
  assert.ok(parsed.querySelector('#mg-partner-f select#mg-partner'),'merge target picker remains');assert.ok(parsed.querySelector('#mg-split-f[hidden]'),'split form mounts lazily in the shared dialog');
  assert.equal(parsed.querySelector('[data-fill="target"]').textContent,'','target comes from current data');
  assert.ok(parsed.querySelector('.dialog__actions'));assert.match(parsed.querySelector('[data-identity-intro]').textContent,/원문과 정본은 보존/);
  assert.equal(parsed.querySelector('select#mg-split'),null,'retired merge-history picker is absent');assert.equal(parsed.querySelector('[data-toast]'),null,'prototype success toast cannot claim a write');
}
function identity(source){const original=getOriginal();const {JSDOM}=require('jsdom');const css=literal(source,'LIBRA_APPROVED_MOCKUP_STYLE');for(const asset of ['suite.css','themes.css'])assert.ok(css.includes(fs.readFileSync(path.join(path.dirname(mockPath),'assets',asset),'utf8')),`original ${asset} included verbatim`);for(const node of original.querySelectorAll('style'))assert.ok(css.includes(node.textContent),'original LIBRA inline CSS included verbatim');const pairs={RANGE_DIALOG:'#dlg-range',VERSIONS_DRAWER:'#drawer-versions',PROMOTE_DIALOG:'#dlg-promote',DELETE_VERSION_DIALOG:'#dlg-del-version',MARGIN_RESET_DIALOG:'#dlg-margin-reset',RECOVERY_JOB:'#job-recover',STATE_DIALOG:'#dialog-state',MERGE_DIALOG:'#dlg-merge',PENDING_DIALOG:'#dlg-pending',RECOVERY_DIALOG:'#dlg-recover',CORRECTIONS_DIALOG:'#dlg-corr-life',JOB_DIALOG:'#job-memory',PROMPT_DIALOG:'#dlg-prompt',CORRECTION_DIALOG:'#dlg-correct'};for(const [name,selector]of Object.entries(pairs)){const parsed=new JSDOM(literal(source,'LIBRA_APPROVED_'+name+'_HTML')).window.document.querySelector(selector);assert.ok(parsed,`approved ${selector} exists`);if(name==='MERGE_DIALOG')identityManagerContract(parsed);else assert.equal(parsed.outerHTML,original.querySelector(selector).outerHTML,`literal ${selector} preserves original DOM`);}const region=source.slice(source.indexOf('  const inputNode ='),source.indexOf('  const publicApi = Object.freeze'));for(const old of ['normalizeApprovedMockupProductClasses','adaptApprovedMockup','sga-card','sga-grid','libra-book-drawer-backdrop'])assert.ok(!region.includes(old),`retired plugin HTML/class adapter absent: ${old}`);return{css,original};}
module.exports={extract,literal,identity,get original(){return getOriginal();}};

