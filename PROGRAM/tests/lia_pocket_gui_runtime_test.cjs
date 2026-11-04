'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createFixture} = require('./fixtures/lia_native_runtime_fixture.cjs');
const source = fs.readFileSync(path.join(__dirname,'../plugins/LIA_Persona_Linker.js'),'utf8');

const expose = s => s.replace('      getScopePersonaCatalog:', `
      mockupMarkup: () => LIA_MOCKUP_APP_HTML,
      mockupContext: async () => readLiaViewContext(await getLiveRuntimeContext()),
      mockupMine: ctx => {
        const slots=new Map(['#pocket','#mine-list','.scope span:last-child','.brand__ver'].map(key=>[key,{setAttribute(){}}]));
        const app={querySelector:key=>slots.get(key)||null};
        const state=renderMockupMine(ctx,app);
        return {state,pocket:slots.get('#pocket').innerHTML,list:slots.get('#mine-list').innerHTML};
      },
      getScopePersonaCatalog:`);

(async () => {
  const fixture = await createFixture('official', {transformSource:expose});
  try {
    const markup=fixture.runtime.mockupMarkup();
    const routes=['mine','make','shelf','settings','edit','update'];
    for(const route of routes)assert.match(markup,new RegExp(`data-page="${route}"`),`canonical route ${route}`);
    assert.equal((markup.match(/\bid="([^"]+)"/g)||[]).length,new Set((markup.match(/\bid="([^"]+)"/g)||[])).size,'canonical shell has unique ids');
    for(const id of ['random-cand-go','lia-max-chars','lia-rich-profile','ed-lang','btn-persona-blueprint','btn-persona-json','sheet-bind','sheet-persona','sheet-del-vault','sheet-del-persona'])assert(markup.includes(`id="${id}"`),id);
    assert.doesNotMatch(markup,/data-page="assets"|id="asset-lock-fields"|id="btn-confirm-visual-lock"/,'retired image workspace stays absent');
    assert.doesNotMatch(markup,/lia-app-layout|lia-pocket-nav|lia-header/,'legacy view structure is absent');
    assert.doesNotMatch(markup,/data-persona-apply=/,'persona row has no automatic bind hook');

    const ctx=await fixture.runtime.mockupContext();
    ctx.chat=fixture.liveChat;
    const beforeBinding=fixture.liveChat.bindedPersona;
    const beforeStorage=JSON.stringify([...fixture.values]);
    const rendered=fixture.runtime.mockupMine(ctx);
    assert.match(rendered.pocket,/Fixture Chat|기본 Persona|Persona/,'mine route renders a product-derived current Persona state');
    assert.doesNotMatch(rendered.list,/data-persona-apply=/,'opening the manager does not apply a binding');
    assert.match(rendered.list,/data-lia-persona-manage=/,'Persona management is a separate explicit destination');
    assert.equal(fixture.liveChat.bindedPersona,beforeBinding,'rendering does not mutate current chat binding');
    assert.equal(JSON.stringify([...fixture.values]),beforeStorage,'rendering does not write local binding state');

    const malicious={...ctx,db:{...ctx.db,personas:[{id:'malicious',name:'<script>bad</script>',note:'<img src=x onerror=bad>'}],selectedPersona:0},chat:{...ctx.chat,bindedPersona:''}};
    const escaped=fixture.runtime.mockupMine(malicious);
    assert.doesNotMatch(escaped.list,/<script>bad/);
    assert.match(escaped.list,/&lt;img/);

    console.log('lia_pocket_gui_runtime_test: PASS (7 canonical routes, product-derived mine state, no render-time writes)');
  } finally {await fixture.dispose();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
