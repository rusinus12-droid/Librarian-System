'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const expose=source=>source.replace('const clearStructuredSettings =',
  'globalThis.__quickSaveTest = () => ({Gui, ensureGuiState, saveGuiState, syncGuiSaveControls, markGuiDirty, buildBookQuickSettingsDrawer, bookOpenQuickSettings, revertGuiStateFromStorage}); const clearStructuredSettings =');
const flat=node=>[node,...node.children.flatMap(flat)];
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.listeners={};this.className='';this.textContent='';this.value='';this.attributes={};this.classList={toggle:(key,on)=>{const parts=new Set(this.className.split(' ').filter(Boolean));if(on)parts.add(key);else parts.delete(key);this.className=[...parts].join(' ');},add:key=>this.classList.toggle(key,true),remove:key=>this.classList.toggle(key,false),contains:key=>this.className.split(' ').includes(key)};}
  appendChild(node){node.parentElement=this;this.children.push(node);return node;}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='inert')this.inert=true;}
  getAttribute(key){return this.attributes[key]??null;}
  querySelectorAll(selector){return flat(this).slice(1).filter(node=>{const m=/^\[data-([\w-]+)\]$/.exec(selector);return m?Object.hasOwn(node.dataset,m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())):selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tagName.toLowerCase()===selector;});}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  contains(node){return flat(this).includes(node);}
  async fire(name,value){if(value!==undefined)this.value=value;const e={target:this,currentTarget:this,preventDefault(){},stopPropagation(){}};let result;for(const fn of this.listeners[name]||[])result=await fn(e);return result;}
}
(async()=>{
 const r=await createLibraVmHarness({}, {}, {transformSource:expose});
 const tests=[];
 try{
  const t=r.context.__quickSaveTest();await t.ensureGuiState();
  r.context.document={createElement:tag=>new Element(tag),createElementNS:(_namespace,tag)=>new Element(tag),createTextNode:value=>Object.assign(new Element('#text'),{textContent:value}),activeElement:null,getElementById:()=>null};
  t.Gui.bookQuickOpen=true;t.Gui.bookQuickSection='ai';
  const app=new Element('div');app.appendChild(t.buildBookQuickSettingsDrawer());
  const tabs=flat(app).filter(node=>node.tagName==='BUTTON'&&node.getAttribute('role')==='tab');
  assert.equal(t.Gui.bookQuickSection,'response');
  assert.deepEqual(tabs.map(node=>node.textContent),['응답','기억']);
  assert.equal(tabs.length,2);
  assert.ok(flat(app).some(node=>node.className.split(' ').includes('overlay')));
  assert.ok(flat(app).some(node=>node.className.split(' ').includes('drawer__head')));
  assert.ok(flat(app).some(node=>node.className.split(' ').includes('drawer__foot')));
  assert.equal(flat(app).some(node=>node.className.split(' ').includes('libra-book-drawer')),false);
  assert.equal(flat(app).some(node=>node.dataset?.bookTechnicalQuick),false);
  assert.equal(flat(app).some(node=>['AI 연결','임베딩','서버'].includes(node.textContent)),false);
  tests.push('Quick Settings exposes only Classic response and memory-agent controls');
  t.bookOpenQuickSettings('embedding');
  assert.equal(t.Gui.bookQuickOpen,true);assert.equal(t.Gui.bookQuickSection,'response');
  t.bookOpenQuickSettings('server');
  assert.equal(t.Gui.bookQuickSection,'response');
  tests.push('legacy connection selections fall back to the response tab without opening duplicate panels');
  console.log(JSON.stringify({test:'libra_book_quick_save_runtime',passed:tests.length,tests,boundary:'Full plugin and DOM navigation mocks; connection panels remain in sidebar Settings; no RisuAI or provider calls'}));
 }finally{await r.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
