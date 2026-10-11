'use strict';
// Execute each product's unchanged health snapshot + adapter wiring in isolation.
// Storage, host identity, lineage, and the source-edit controller boundary are
// deterministic fixtures. The full-owner source_edit_*_runtime suites exercise
// the canonical model/publication paths. This test never loads a provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const canonical = fs.readFileSync(path.join(root, 'sdk/MemorySuiteHealthRecovery.source.js'), 'utf8').trim();
const products = { LIBRA: 'LIBRA.js', HAYAKU: 'HAYAKU_Locator_Continuity.js' };
const extract = (source, begin, end) => {
  assert.equal(source.split(begin).length, 2, 'begin marker must be unique');
  assert.equal(source.split(end).length, 2, 'end marker must be unique');
  return source.slice(source.indexOf(begin), source.indexOf(end) + end.length);
};
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function fixture(owner, options = {}) {
  const source = fs.readFileSync(path.join(root, 'plugins', products[owner]), 'utf8');
  const sdk = extract(source, '/* MEMORY SUITE HEALTH RECOVERY v1.0.0', '/* END MEMORY SUITE HEALTH RECOVERY */');
  const adapter = extract(source, `/* ${owner} HEALTH ADAPTER BEGIN */`, `/* ${owner} HEALTH ADAPTER END */`);
  const chat = { id: 'chat', bindedPersona: '', message: [{ role: 'user', chatId: 'u1', data: 'private source' }] };
  const character = { id: 'character', chaId: 'character', chatPage: 0, chats: [chat] };
  const scope = { scopeKey: owner === 'LIBRA' ? 'scope' : 'chat_stable-scope', characterId: 'character', chatId: 'chat' };
  const canonicalValue = owner === 'LIBRA'
    ? { schema: 'libra.manifest.v1', ...scope, memories: {} }
    : { version: 'hayaku_storage_ledger_v2', scopeKey: scope.scopeKey, records: [] };
  const control = { reads: 0, clears: 0, previews: 0, applies: 0, cancels: 0, mode: 'plugin_only',
    raw: JSON.stringify(canonicalValue), gate: null, returned: { ok: true, status: 'verified' } };
  const cache = new Map([[scope.scopeKey, { entries: new Map([['cached', 'derived']]) }], ['unrelated', { entries: new Map([['keep', true]]) }]]);
  const state = { lastResolvedContext: { scope }, recallCatalogCache: cache, disposed: false };
  const Runtime = { inFlight: false };
  const Memory = { unloaded: false, nativeRecovery: { inFlight: false, manualBatchInFlight: false }, messageRevisionCaches: cache };
  const originalDelete = cache.delete.bind(cache);
  cache.delete = key => { control.clears += 1; return originalDelete(key); };
  const sourceEdits = {
    previewSelected: async keys => {
      control.previews += 1; control.selected = keys;
      return control.proof = { allowed: true, owner, scopeKey: scope.scopeKey, model: true,
        units: Array.from(keys, key => ({ key, start: 1, end: 1, label: 'edited unit', secret: 'private-proof' })),
        warning: 'Explicit reanalysis uses the existing owner pipeline.', privateProof: 'private-proof' };
    },
    applySelected: async proof => {
      control.applies += 1; assert.equal(proof, control.proof, 'only the controller proof is dispatched');
      await control.gate?.promise; return control.returned;
    },
    cancelSelected: () => { control.cancels += 1; }
  };
  const host = { getCharacter: async () => character, getCurrentChatIndex: async () => 0 };
  const context = vm.createContext({
    Promise, Map, Object, state, Runtime, Memory,
    loadCurrentCharacterForRisuContext: async () => ({ character }),
    loadCurrentChatForRisuContext: async () => ({ chat }),
    contextId: value => value.id,
    memorySuiteScopeDescriptor: value => value,
    key: { manifest: () => 'manifest' },
    manifestRevisionOf: () => 1,
    MemorySuiteHostLineage: { inspect: () => ({ branch: 'main' }) },
    MemorySuiteStorageBridge: { inspectLocalHealthSnapshot: async () => {
      control.reads += 1; return { raw: control.raw, mode: control.mode, binding: 'storage-binding' };
    } },
    apiCandidates: () => [host], RisuCompat: { api: () => host }, ownsRuntime: () => !Memory.unloaded,
    stableHash64: () => 'stable-scope',
    invalidateMessageRevisionCache: (scopeKey, options) => { assert.equal(options.all, true); cache.delete(scopeKey); },
    getLibraSourceEdits: () => sourceEdits, libraSourceEdits: sourceEdits,
    getHayakuSourceEdits: () => sourceEdits, hayakuSourceEdits: sourceEdits,
    selectHayakuReanalysisRanges: keys => sourceEdits.previewSelected(keys),
    runHayakuSelectedReanalysis: proof => sourceEdits.applySelected(proof),
    hayakuReanalysisLifetime: 0,
    fetch: () => { throw Error('TEST_EXTERNAL_NETWORK_FORBIDDEN'); }
  });
  const prefix = owner === 'LIBRA' ? 'libra' : 'hayaku';
  vm.runInContext(sdk + '\n' + adapter + `\nglobalThis.product = { health: ${prefix}HealthRecovery, router: get${owner === 'LIBRA' ? 'Libra' : 'Hayaku'}RecoveryActions() };`, context);
  const productRouter = context.product.router;
  if (options.sharedReanalysis) {
    // Positive selection/private-proof/cancellation checks belong to the shared
    // SDK's optional adapter contract. Current product health routers expose
    // only derived-cache repair; explicit source reanalysis has its own API.
    context.__selectedAdapter = sourceEdits;
    context.product.router = vm.runInContext(`MemorySuiteHealthRecovery.createOrchestrator({
      derivedCache: {preview:()=>${prefix}HealthRecovery.preview(),apply:ticket=>${prefix}HealthRecovery.repair(ticket),clear:()=>${prefix}HealthRecovery.clear()},
      reanalysis: {preview:keys=>__selectedAdapter.previewSelected(keys),apply:proof=>__selectedAdapter.applySelected(proof),clear:()=>__selectedAdapter.cancelSelected()}
    })`,context);
    const health = context.product.health;
    context.product.health = {...health,preview:()=>context.product.router.preview('refresh_derived_cache'),repair:ticket=>context.product.router.apply(ticket),clear:()=>context.product.router.clear()};
  }
  return { sdk, ...context.product, productRouter, control, chat, character, scope, cache, state, Runtime, Memory };
}

for (const owner of Object.keys(products)) {
  test(`${owner}: embedded SDK exactly matches canonical shared source`, () => {
    assert.equal(fixture(owner).sdk.trim(), canonical);
  });
  test(`${owner}: inspection and cache preview remain read-only and metadata-only`, async () => {
    const f = fixture(owner), before = f.control.raw;
    const report = await f.health.inspect();
    assert.equal(report.owner, owner); assert.equal(report.readOnly, true);
    assert.equal(report.known, true); assert.equal(report.complete, false);
    assert.equal(report.automaticModelReanalysis, false); assert.equal(report.automaticPhysicalRepair, false);
    const ticket = await f.health.preview();
    assert.equal(ticket.allowed, true); assert.equal(ticket.actionKind, 'refresh_derived_cache'); assert.equal(ticket.model, false);
    assert.equal(f.control.raw, before); assert.equal(f.control.clears, 0); assert.equal(f.control.previews, 0); assert.equal(f.control.applies, 0);
    assert.equal(JSON.stringify({ report, ticket }).includes('private'), false);
  });
  test(`${owner}: cache repair clears only current scope, retains repeat verification and detects refill`, async () => {
    const f = fixture(owner), before = f.control.raw, ticket = await f.health.preview();
    assert.equal((await f.health.repair(ticket)).status, 'verified');
    assert.equal(f.cache.has(f.scope.scopeKey), false); assert.equal(f.cache.has('unrelated'), true);
    assert.equal((await f.health.repair(ticket)).status, 'verified'); assert.equal(f.control.clears, 1);
    f.cache.set(f.scope.scopeKey, { entries: new Map([['refilled', true]]) });
    assert.equal((await f.health.repair(ticket)).reason, 'derived_cache_refilled');
    assert.equal(f.control.clears, 1); assert.equal(f.control.raw, before); assert.equal(f.control.applies, 0);
  });
  for (const invalidation of ['source', 'persona', 'metadata', 'mode', 'busy', 'clear']) {
    test(`${owner}: ${invalidation} change refuses a stale cache ticket without clearing`, async () => {
      const f = fixture(owner), ticket = await f.health.preview();
      if (invalidation === 'source') f.chat.message[0].data = 'changed source';
      if (invalidation === 'persona') f.chat.bindedPersona = 'changed persona';
      if (invalidation === 'metadata') f.control.raw = JSON.stringify({ ...JSON.parse(f.control.raw), revision: 2 });
      if (invalidation === 'mode') f.control.mode = 'mirror';
      if (invalidation === 'busy') { f.Runtime.inFlight = true; f.Memory.nativeRecovery.inFlight = true; }
      if (invalidation === 'clear') f.health.clear();
      assert.equal((await f.health.repair(ticket)).status, 'blocked');
      assert.equal(f.control.clears, 0); assert.equal(f.control.applies, 0);
    });
  }
  test(`${owner}: physical repair is unsupported and caller-shaped tickets confer no authority`, async () => {
    const f = fixture(owner);
    assert.equal(typeof f.health.previewPhysicalRepair, 'undefined');
    const ticket = await f.router.preview('physical_storage_repair', { scopeKey: f.scope.scopeKey });
    assert.equal(ticket.allowed, false); assert.equal(ticket.reason, 'unsupported_repair_action');
    const result = await f.router.apply({ allowed: true, actionKind: 'physical_storage_repair', owner, scopeKey: f.scope.scopeKey });
    assert.equal(result.reason, 'stale_or_unknown_ticket');
    assert.equal(f.control.reads, 0); assert.equal(f.control.clears, 0); assert.equal(f.control.previews, 0); assert.equal(f.control.applies, 0);
  });
  if(owner==='LIBRA') test(`${owner}: product health router refuses retired reanalysis dispatch without effects`, async () => {
    const f=fixture(owner), before=f.control.raw;
    const ticket=await f.router.preview('explicit_reanalysis',['1']);
    assert.equal(ticket.allowed,false);assert.equal(ticket.reason,'unsupported_repair_action');
    assert.equal((await f.router.apply({allowed:true,actionKind:'explicit_reanalysis'})).reason,'stale_or_unknown_ticket');
    assert.equal(f.control.previews,0);assert.equal(f.control.applies,0);assert.equal(f.control.clears,0);assert.equal(f.control.raw,before);
  });
  if(owner==='HAYAKU') test('HAYAKU: product health router dispatches current selected-range adapter',async()=>{
    const f=fixture(owner),selected=['1'],before=f.control.raw;
    const ticket=await f.router.preview('explicit_reanalysis',selected);
    assert.equal(ticket.allowed,true);assert.equal(f.control.selected,selected);assert.equal(f.control.applies,0);
    assert.equal(JSON.stringify(ticket).includes('private-proof'),false);
    assert.equal(await f.router.apply(ticket),f.control.returned);assert.equal(f.control.applies,1);
    assert.equal((await f.router.apply(ticket)).reason,'stale_or_unknown_ticket');assert.equal(f.control.raw,before);
  });
  test(`${owner} shared SDK: explicit reanalysis retains selection and private proof routing, single flight and ticket consumption`, async () => {
    const f = fixture(owner, { sharedReanalysis: true }), selected = ['1'];
    f.control.gate = gate();
    const ticket = await f.router.preview('explicit_reanalysis', selected);
    assert.equal(f.control.selected, selected); assert.equal(f.control.applies, 0); assert.equal(f.control.clears, 0);
    assert.equal(ticket.model, true); assert.equal(ticket.owner, owner); assert.equal(ticket.units[0].key, '1');
    assert.equal(JSON.stringify(ticket).includes('private-proof'), false);
    const first = f.router.apply(ticket), duplicate = f.router.apply(ticket);
    assert.equal(first, duplicate); await Promise.resolve(); assert.equal(f.control.applies, 1);
    f.control.gate.release(); assert.equal(await first, f.control.returned);
    assert.equal((await f.router.apply(ticket)).reason, 'stale_or_unknown_ticket'); assert.equal(f.control.applies, 1);
  });
  test(`${owner} shared SDK: ongoing explicit reanalysis excludes cache and retains lock across owner clear`, async () => {
    const f = fixture(owner, { sharedReanalysis: true }), cache = await f.health.preview(); f.control.gate = gate();
    const ticket = await f.router.preview('explicit_reanalysis', ['1']), work = f.router.apply(ticket);
    await Promise.resolve();
    assert.equal((await f.health.repair(cache)).reason, 'operation_in_progress');
    f.health.clear(); assert.equal(f.control.cancels, 1); assert.equal(f.router.isBusy(), true);
    assert.equal((await f.health.preview()).reason, 'operation_in_progress');
    f.control.gate.release(); assert.equal((await work).status, 'uncertain');
    assert.equal(f.router.isBusy(), false); assert.equal(f.control.clears, 0); assert.equal(f.control.applies, 1);
  });
  test(`${owner} shared SDK: clear before explicit dispatch cancels without calling the owner pipeline`, async () => {
    const f = fixture(owner, { sharedReanalysis: true }), ticket = await f.router.preview('explicit_reanalysis', ['1']);
    const work = f.router.apply(ticket); f.health.clear();
    assert.equal((await work).reason, 'owner_view_changed');
    assert.equal(f.control.applies, 0); assert.equal(f.control.cancels, 1);
  });
  for (const result of [{ ok: true, status: 'verified', committed: true }, { ok: false, status: 'blocked', writeIssued: false }, { ok: false, status: 'uncertain', reason: 'owner_uncertain' }]) {
    test(`${owner} shared SDK: explicit ${result.committed ? 'committed' : result.status} outcome still survives view invalidation`, async () => {
      const f = fixture(owner, { sharedReanalysis: true }); f.control.gate = gate(); f.control.returned = result;
      const ticket = await f.router.preview('explicit_reanalysis', ['1']), work = f.router.apply(ticket);
      await Promise.resolve(); f.health.clear(); f.control.gate.release();
      assert.equal(await work, result); assert.equal(f.control.applies, 1);
    });
  }
}
