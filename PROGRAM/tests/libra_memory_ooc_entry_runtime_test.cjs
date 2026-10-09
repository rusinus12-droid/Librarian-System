'use strict';
const assert=require('node:assert/strict');
const {createOocGui}=require('./fixtures/libra_memory_ooc_gui_fixture.cjs');
(async()=>{
 const h=await createOocGui();
 try {
  await h.open();await h.memory();
  assert.equal(h.ooc(),null,'OOC is lazy before explicit opening');
  const ooc=await h.expandOoc();
  assert.equal(h.document.querySelectorAll('#prompt-studio-ooc-builder').length,1,'one OOC control is mounted');
  assert(h.button('OOC 보내기',ooc));
  const targets=h.api.debugPromptStudioOocTargets({}).filter(t=>t.domain==='memory');
  assert.deepEqual(ooc.querySelector('select').querySelectorAll('option').map(n=>n.value),Array.from(targets,t=>t.id),'public target selector contains only memory/librarian sections');
  assert.equal(h.promptWrites().length,0);assert.equal(h.modelCalls.length,0);assert.equal(h.networkCalls.length,0);
  const prior=ooc;
  await h.button('대화 시작',h.ooc()).emit('click');
  assert.equal(prior.isConnected,false,'local refresh detaches the old view');
  assert.equal(h.document.querySelectorAll('#prompt-studio-ooc-builder').length,1);
  const open=h.disclosure('대화로 기억 지침 만들기 · OOC');open.open=false;await h.pause(10);open.open=true;await h.pause(10);
  assert.equal(h.document.querySelectorAll('#prompt-studio-ooc-builder').length,1,'repeated disclosure toggles never duplicate the renderer');
  await h.api.closeSettingsGui();await h.open();await h.memory();await h.expandOoc();
  assert(h.ooc().textContent.includes('OOC · 시작 안내'),'completed conversation survives same-scope close and reopen');
  assert.equal(h.modelCalls.length,0);assert.equal(h.promptWrites().length,0);
  console.log(JSON.stringify({status:'PASS',registeredEntry:'libra-v1-settings-menu',cases:['lazy memory OOC entry','memory-only targets','opening has no save/model/network'],host:'synthetic DOM; unchanged complete product bytes; not native RisuAI'}));
 }finally{await h.cleanup();}
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
