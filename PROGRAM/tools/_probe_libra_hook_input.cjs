'use strict';
// Why does the REAL beforeRequest hook skip with `no_safe_current_user_input`?
//
// The plugin records its own verdict in Runtime.lastMemoryRecallViewer / state.lastRecallInputResolution,
// so this reads the plugin's diagnostic instead of guessing at message shapes. The goal is to find a
// message list that the REAL hook accepts, so the SGA pipeline can be driven end to end rather than
// through an injected accessor.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

const instrument = source => {
  const anchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', anchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  // Two injections: the accessors live in the core IIFE, but harness.api is the separate public
  // surface — exposing only the core leaves them unreachable from tests (measured repeatedly).
  return source
    .replace(anchor,
      '      _peekInputResolution: () => clone(state.lastRecallInputResolution || null),\n' +
      '      _peekRecallViewer: () => clone(Runtime.lastMemoryRecallViewer || null),\n' +
      '      _peekInjectionMeta: () => clone(Runtime.lastMemoryInjectionMeta || null),\n' +
      '      _peekResolve: messages => clone(resolveSgaCurrentTurn(messages)),\n' +
      anchor)
    .replace(publicAnchor,
      '    _peekInputResolution() { return LibraMemoryCore._peekInputResolution(); },\n' +
      '    _peekRecallViewer() { return LibraMemoryCore._peekRecallViewer(); },\n' +
      '    _peekInjectionMeta() { return LibraMemoryCore._peekInjectionMeta(); },\n' +
      '    _peekResolve(messages) { return LibraMemoryCore._peekResolve(messages); },\n' +
      publicAnchor);
};

const run = async (label, messagesFactory) => {
  const f = await fixture({ transformSource: instrument });
  try {
    await f.run();
    const api = f.r.api;
    const settings = await api.getLibraMemorySettings();
    await api.saveLibraMemorySettings({ ...settings, responseFamily: 'gradia' });

    const messages = messagesFactory(f);
    const direct = api._peekResolve(messages);

    const before = f.control.hooks.beforeRequest;
    let hookError = '';
    try { await before(messages, 'model'); } catch (error) { hookError = `${error?.name}: ${String(error?.message || error).slice(0, 200)}`; }

    return {
      label,
      resolveSgaCurrentTurn: direct,
      inputResolution: api._peekInputResolution(),
      recallViewer: api._peekRecallViewer(),
      injectionMeta: api._peekInjectionMeta(),
      hookError
    };
  } finally {
    await f.r.cleanup();
  }
};

(async () => {
  const out = {};

  // The fixture already carries a 5 U+A chat in chat.messages; try the shapes RisuAI can produce.
  out.chatRows = await run('chat rows + Current Input wrapper', f => [
    ...(f.chat.messages || []).map(m => ({ role: m.role, content: String(m.data || '') })),
    { role: 'user', content: `<Current Input>\n${liveInput}\n</Current Input>` }
  ]);

  out.plainLastUser = await run('chat rows + plain last user', f => [
    ...(f.chat.messages || []).map(m => ({ role: m.role, content: String(m.data || '') })),
    { role: 'user', content: liveInput }
  ]);

  out.currentMessageTag = await run('chat rows + current_message tag', f => [
    ...(f.chat.messages || []).map(m => ({ role: m.role, content: String(m.data || '') })),
    { role: 'user', content: `<current_message>\n${liveInput}\n</current_message>` }
  ]);

  fs.writeFileSync('/tmp/libra_hook_probe.json', JSON.stringify(out, null, 1));
  for (const [key, value] of Object.entries(out)) {
    const rv = value.recallViewer || {};
    console.log(`${key}:`);
    console.log(`  resolve.text=${JSON.stringify(String(value.resolveSgaCurrentTurn?.text || '').slice(0, 60))} requestIndex=${value.resolveSgaCurrentTurn?.requestIndex}`);
    console.log(`  inputSource=${rv.inputSource || '-'} skipReason=${rv.skipReason || '-'} queryText=${JSON.stringify(String(rv.queryText || '').slice(0, 40))}`);
    console.log(`  injected=${value.injectionMeta?.injected ?? '-'} chars=${value.injectionMeta?.chars ?? '-'} hookError=${value.hookError || '-'}`);
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
