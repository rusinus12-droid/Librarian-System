'use strict';
// Actual plugins in the supported host: storage faults, restarts, old bindings,
// and an already installed five-turn transcript. Provider calls stay synthetic.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create, until, pause } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const artifact = require('./fixtures/librarian_event_fixture.cjs');
const kind = process.env.LIBRA_GUI_ARTIFACT_KIND || 'Full';
const turns = () => Array.from({length:5}, (_,i) => [
  {role:'user',chatId:`u${i}`,data:`Alice asks question ${i}.`},
  {role:'char',chatId:`a${i}`,data:`Alice opens gate ${i}.`}
]).flat();
const provider = calls => async (url, init={}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({url:String(url),body});
  const response = data => new Response(JSON.stringify(data), {status:200});
  if (String(url).endsWith('/models')) return response({data:[{id:'gpt-5.4-mini'}]});
  if (String(url).endsWith('/embeddings')) return response({data:[].concat(body.input).map((_,index) => ({index,embedding:[1,0,0]}))});
  const content = body.messages?.some(m => /Alice opens gate 0/.test(m.content))
    ? JSON.stringify(artifact('Alice opens gate 0.')) : 'OK';
  return response({choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}});
};
async function connect(f, {embed=true}={}) {
  if (!f.doc.querySelector('[data-libra-quick-dialog]')) await f.open();
  await until(() => f.doc.querySelector('[data-libra-quick-dialog]'), 'quick dialog', 15000);
  const dialog = f.doc.querySelector('[data-libra-quick-dialog]');
  const key = dialog.querySelector('[data-libra-quick-key]');
  key.value = 'sk-proj-synthetic-only';
  key.dispatchEvent(new f.dom.window.Event('input', {bubbles:true}));
  const toggle = dialog.querySelector('input[aria-label="임베딩으로 사용"]');
  toggle.checked = embed;
  toggle.dispatchEvent(new f.dom.window.Event('change', {bubbles:true}));
  [...dialog.querySelectorAll('button')].find(n => n.textContent === '확인하고 연결').click();
  await until(() => f.doc.querySelector('[data-libra-quick-dialog] .note'), 'connect result', 15000);
  return f.doc.querySelector('[data-libra-quick-dialog] .note').textContent;
}
const connectionState = async f => {
  const basis = await f.api.debugReadSettingsPersistenceBasis();
  return {basis:basis.semanticHash,embed:JSON.parse(JSON.stringify(await f.api.getEmbeddingSettings())),
    llmKey:f.args.get('llm_key')||'', embedKey:f.args.get('embedding_key')||''};
};
for (const fault of ['reject_embedding', 'drop_embedding', 'reject_commit']) {
  test(`${kind}: quick connect rolls back every connection field on ${fault}`, async () => {
    let armed = false, commitRejected = false;
    const isNewEmbed = (key,value) => {
      if (key !== 'libra:v1:provider-settings') return false;
      try { return JSON.parse(value).embed?.provider === 'openai'; } catch { return false; }
    };
    const f = await create('LIBRA', kind, {
      separateLocalStorage:true,
      nativeFetch:provider([]),
      failWrites:(key,value) => armed && fault === 'reject_embedding' && isNewEmbed(key,value),
      dropWrites:(key,value) => armed && fault === 'drop_embedding' && isNewEmbed(key,value),
      failRemoves:key => {
        if (armed && fault === 'reject_commit' && key === 'libra:v1:settings-transaction-journal' && !commitRejected) {
          commitRejected = true; return true;
        }
        return false;
      }
    });
    try {
      await f.open();
      await until(() => f.doc.querySelector('[data-libra-quick-dialog]'), 'initialized settings');
      const before = await connectionState(f);
      const guiBefore = f.api.debugGuiSettingsState().state;
      armed = true;
      const result = await connect(f);
      assert.match(result, /settings_transaction_failed/);
      assert.doesNotMatch(result, /rollback_failed/);
      assert.deepEqual(await connectionState(f), before, 'durable configuration, secrets, and argument mirrors restored');
      const guiAfter = f.api.debugGuiSettingsState().state;
      assert.deepEqual(guiAfter.providers, guiBefore.providers, 'failed connection never enters the GUI draft');
      assert.equal(guiAfter.agents.librarian.presetName, guiBefore.agents.librarian.presetName);
      assert.equal(f.values.has('libra:v1:settings-transaction-journal'), false);
      assert.equal(f.errors.length, 0);
    } finally { await f.close(); }
  });
}
test(`${kind}: quick connect replaces a pre-existing Librarian binding and actual model route`, async () => {
  const calls = [];
  const old = {provider:'openai',model:'old-model',key:'old-synthetic',url:'https://old.invalid/v1'};
  const f = await create('LIBRA', kind, {nativeFetch:provider(calls),args:{librarian_preset:'old-ai',provider_presets_json:JSON.stringify({'old-ai':old})}});
  try {
    const basis = await f.api.debugReadSettingsPersistenceBasis();
    await f.api.debugPersistStructuredSettingsState({providers:{'old-ai':old},runtime:{...basis.state.runtime,default_preset:'old-ai'},
      agents:{...basis.state.agents,librarian:{enabled:true,preset:'old-ai'}}});
    const result = await connect(f, {embed:false});
    assert.match(result, /연결 완료.*gpt-5.4-mini/);
    const stored = await f.api.debugReadSettingsPersistenceBasis();
    assert.equal(stored.state.agents.librarian.preset, 'OpenAI 빠른 연결');
    const beforeScan = calls.length;
    const chat = await f.host.getChat(); chat.message = turns(); chat.messages = chat.message;
    await f.api.scanMemoryNow().catch(() => {});
    const generation = calls.slice(beforeScan).filter(c => c.url.endsWith('/chat/completions'));
    assert.ok(generation.length > 0, 'actual memory analysis submitted');
    assert.ok(generation.every(c => c.url === 'https://api.openai.com/v1/chat/completions' && c.body.model === 'gpt-5.4-mini'));
    assert.equal(calls.some(c => c.url.startsWith('https://old.invalid')), false);
    assert.equal(f.errors.length, 0);
  } finally { await f.close(); }
});
test(`${kind}: quick connect commits generation and embedding together`, async () => {
  const f = await create('LIBRA', kind, {separateLocalStorage:true,nativeFetch:provider([])});
  try {
    assert.match(await connect(f), /연결 완료.*기억 분석 AI.*임베딩/);
    const basis = await f.api.debugReadSettingsPersistenceBasis();
    const embed = await f.api.getEmbeddingSettings();
    assert.equal(basis.state.agents.librarian.preset, 'OpenAI 빠른 연결');
    assert.equal(embed.provider, 'openai');
    assert.equal(embed.key, 'sk-proj-synthetic-only');
    assert.equal(f.errors.length, 0);
  } finally { await f.close(); }
});
test(`${kind}: a concurrent embedding edit rejects stale quick-connect settings`, async () => {
  let f, release, listed = false;
  const fetch = provider([]);
  f = await create('LIBRA', kind, {nativeFetch:async (url,init) => {
    if (String(url).endsWith('/models')) {
      listed = true;
      await new Promise(resolve => { release = resolve; });
    }
    return fetch(url,init);
  }});
  try {
    const pending = connect(f);
    await until(() => listed, 'model-list test paused');
    const before = (await f.api.debugReadSettingsPersistenceBasis()).semanticHash;
    await f.api.saveEmbeddingSettings({enabled:false});
    release();
    assert.match(await pending, /embedding_settings_stale_basis/);
    assert.equal((await f.api.getEmbeddingSettings()).enabled, false, 'newer edit remains saved');
    assert.equal((await f.api.debugReadSettingsPersistenceBasis()).semanticHash, before, 'no generation setting was partially saved');
  } finally { release?.(); await f.close(); }
});
test(`${kind}: first-setup dismissal survives plugin restart using device storage`, async () => {
  const f = await create('LIBRA', kind, {separateLocalStorage:true});
  let device;
  try {
    assert.equal(f.context.localStorage, undefined);
    await f.open();
    await until(() => f.doc.querySelector('[data-libra-quick-dialog]'), 'first setup');
    [...f.doc.querySelectorAll('[data-libra-quick-dialog] button')].find(n => n.textContent === '나중에 하기').click();
    await until(() => f.deviceValues.has('libra.firstSetupSeen.v1'), 'device dismissal');
    assert.equal(f.values.has('libra.firstSetupSeen.v1'), false, 'dismissal is device local');
    device = [...f.deviceValues];
  } finally { await f.close(); }
  const next = await create('LIBRA', kind, {separateLocalStorage:true,initialDeviceValues:device});
  try {
    await next.open(); await pause(120);
    assert.equal(next.doc.querySelector('[data-libra-quick-dialog]'), null);
    assert.equal(next.errors.length, 0);
  } finally { await next.close(); }
});
test(`${kind}: an existing five-turn chat offers its missing range without a model call`, async () => {
  const f = await create('LIBRA', kind, {initialChat:turns()});
  try {
    const inventory = await f.api.listCanonicalBatchRanges();
    assert.equal(inventory.ranges.length, 1);
    assert.equal(inventory.ranges[0].status, 'missing');
    await until(() => f.regs.find(r => r.id === 'libra-v1-settings-attention'), 'five-turn missing notification', 8000);
    assert.match(f.regs.find(r => r.id === 'libra-v1-settings-attention').name, /지난 대화 1구간/);
    assert.equal(f.wire.length, 0, 'inspection never creates a model call');
    assert.equal(f.errors.length, 0);
  } finally { await f.close(); }
});
