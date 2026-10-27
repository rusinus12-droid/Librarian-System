'use strict';
// Exact plugin source, real DOM events, synthetic storage/provider. No RisuAI or
// external provider requests. Optional HTML snapshots use this same renderer.
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { create, until, pause } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const messages = [1, 2].flatMap(i => [
  { role: 'user', chatId: `u${i}`, data: `Where is parcel ${i}?` },
  { role: 'assistant', chatId: `a${i}`, data: `Parcel ${i} remains in the eastern cabinet beside the marble clock.` }
]);
const job = f => f.doc.querySelector('#flashbackMaintenanceJob');
const diagnostic = f => [...f.doc.querySelectorAll('.overlay.is-open .dialog')].find(node => !node.closest('#flashbackMaintenanceJob'));
const snapshot = (f, name) => { if (process.env.FLASHBACK_JOB_SNAPSHOTS) { fs.mkdirSync(process.env.FLASHBACK_JOB_SNAPSHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.FLASHBACK_JOB_SNAPSHOTS, name + '.html'), f.dom.serialize()); } };
async function setup() {
  const f = await create('Flashback', 'Full', { initialChat: messages, separateLocalStorage: true,
    pluginPath: process.env.FLASHBACK_GUI_SOURCE, args: { embedding_key: 'synthetic-key' } });
  await f.api.saveSettings({ ...await f.api.loadSettings(), embeddingProvider: 'openai_compat', embeddingModel: 'job-fixture',
    embeddingUrl: 'https://provider.invalid/v1', embeddingDimensions: 3, embeddingEnabled: true, embeddingAutoProcess: false,
    embeddingMaxRetries: 0, embeddingBatchSize: 1, episodeIndexEnabled: false, autoEpisodeIndex: false, autoColdStart: false });
  await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true, deferEmbedding: true, skipEpisodeRebuild: true });
  await f.open(); await f.click('[data-go="care"]'); await pause(150);
  return f;
}
function holdInspection(f, reject = false) {
  const original = f.host.pluginStorage.getItem.bind(f.host.pluginStorage), entered = deferred(), release = deferred();
  let armed = true;
  f.host.pluginStorage.getItem = async key => {
    if (armed && job(f) && String(key).endsWith(':manifest:v2')) {
      armed = false; entered.resolve(); await release.promise;
      if (reject) throw Error('SYNTHETIC_INSPECTION_READ_FAILURE');
    }
    return original(key);
  };
  return { entered, release, restore() { f.host.pluginStorage.getItem = original; } };
}
async function inspect(f) {
  f.doc.querySelector('#maintenanceInspectBtn').click();
  return until(() => diagnostic(f), 'diagnostic after live inspection');
}

test('registered inspection shows a live popup, minimizes/reopens, then displays the diagnosis without provider work', async () => {
  const f = await setup(), hold = holdInspection(f);
  try {
    const before = JSON.stringify((await f.api._test.loadScopeRecords((await f.api.resolveCurrentScope(false)).scopeKey)).records);
    f.doc.querySelector('#maintenanceInspectBtn').click();await hold.entered.promise;
    assert(job(f));assert.equal(job(f).hidden, false);assert.match(job(f).textContent, /기억 상태 점검/);
    assert.equal(job(f).querySelector('[data-job-meter]').hidden, true, 'unknown total has no fabricated percentage');
    assert.equal(job(f).querySelector('[data-job-requests]').textContent, '0건');
    assert.equal(job(f).querySelector('#maintenanceJobMinimizeBtn').disabled, false);
    job(f).querySelector('#maintenanceJobMinimizeBtn').click();assert.equal(job(f).hidden, true);
    const chip = f.doc.querySelector('#maintenanceJobChip');assert.equal(chip.hidden, false);assert.equal(chip.disabled, false);
    await pause(1050);chip.click();assert.equal(job(f).hidden, false);assert.match(job(f).querySelector('[data-job-clock]').textContent, /경과 1초/);
    f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(job(f).hidden, true);assert.equal(f.calls.hide, 0, 'Escape minimizes the task, keeping the GUI open');
    chip.click();snapshot(f, 'synthetic-inspection-running');
    hold.release.resolve();await until(() => diagnostic(f), 'inspection diagnosis');
    assert.equal(job(f).hidden, true);assert.match(diagnostic(f).textContent, /기억 유지보수 진단/);
    diagnostic(f).querySelector('button').click();await pause(60);
    chip.click();assert.equal(job(f).querySelector('[data-job-result]').hidden, false);
    job(f).querySelector('#maintenanceJobDoneBtn').click();assert.equal(job(f), null);
    assert.equal(JSON.stringify((await f.api._test.loadScopeRecords((await f.api.resolveCurrentScope(false)).scopeKey)).records), before);
    assert.equal(f.wire.length, 0);assert.deepEqual(f.errors, []);
  } finally { hold.release.resolve();await f.close(); }
});

test('diagnosis action shows actual provider wait, vector save counts and final recovery result in the same popup', async () => {
  const f = await setup(), entered = deferred(), release = deferred();let calls = 0, corpusCalls = 0;
  f.host.nativeFetch = async (_url, init) => {
    calls++;const input = JSON.parse(init.body).input;
    if (input.some(text => text.includes('Parcel'))) { corpusCalls++;entered.resolve();await release.promise; }
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 });
  };
  try {
    const scope = await f.api.resolveCurrentScope(false), before = (await f.api._test.loadScopeRecords(scope.scopeKey)).records.map(r => [r.id, r.text, r.sourceHash]);
    const modal = await inspect(f);[...modal.querySelectorAll('button')].at(-1).click();await entered.promise;
    assert.match(job(f).querySelector('#fb-maintenance-job-message').textContent, /임베딩 요청.*응답/);
    assert.match(job(f).querySelector('[data-job-pending]').textContent, /[1-9]\d*건/);
    assert.equal(job(f).querySelector('#maintenanceJobCancelBtn').disabled, false);
    const atWait = calls;job(f).querySelector('#maintenanceJobMinimizeBtn').click();f.doc.querySelector('#maintenanceJobChip').click();
    assert.equal(calls, atWait, 'view actions never submit another request');snapshot(f, 'synthetic-recovery-running');
    release.resolve();await until(() => job(f)?.querySelector('[data-job-result]')?.hidden === false, 'verified recovery result', 12000);
    assert.match(job(f).querySelector('[data-job-state]').textContent, /완료/);assert.doesNotMatch(job(f).querySelector('[data-job-state]').textContent, /실패|중지/);
    assert.equal(job(f).querySelector('[data-job-ready]').textContent, '2개');
    const rows = (await f.api._test.loadScopeRecords(scope.scopeKey)).records;
    assert.deepEqual(rows.map(r => [r.id, r.text, r.sourceHash]), before);assert(rows.every(r => r.embeddingReceipt?.status === 'ready'));
    assert.equal(corpusCalls, 2);assert.equal(diagnostic(f), undefined, 'no competing completion modal');snapshot(f, 'synthetic-recovery-completed');
    assert.deepEqual(f.errors, []);
  } finally { release.resolve();await f.close(); }
});

test('inspection read failure remains visible and a later inspection can start without a stuck task', async () => {
  const f = await setup(), hold = holdInspection(f, true);
  try {
    f.doc.querySelector('#maintenanceInspectBtn').click();await hold.entered.promise;hold.release.resolve();
    await until(() => job(f)?.querySelector('[data-job-state]')?.textContent === '작업 실패', 'failed task');
    assert.equal(job(f).querySelector('[data-job-result]').hidden, false);assert.match(job(f).querySelector('[data-job-result]').textContent, /정상 여부는 미검증/);
    assert.equal(diagnostic(f), undefined);snapshot(f, 'synthetic-inspection-failed');
    job(f).querySelector('#maintenanceJobDoneBtn').click();hold.restore();await until(() => !f.doc.querySelector('#maintenanceInspectBtn').disabled, 'inspection reenabled');
    await inspect(f);diagnostic(f).querySelector('button').click();assert.equal(f.wire.length, 0);assert.deepEqual(f.errors, []);
  } finally { hold.release.resolve();await f.close(); }
});

test('closing the plugin during inspection removes the surface and completion does not reopen a hidden GUI', async () => {
  const f = await setup(), hold = holdInspection(f);
  try {
    f.doc.querySelector('#maintenanceInspectBtn').click();await hold.entered.promise;
    await f.api.closeUi();assert.equal(job(f), null);hold.release.resolve();await pause(200);
    assert.equal(job(f), null);assert.equal(diagnostic(f), undefined);const shown = f.calls.show;
    await f.open();assert.equal(f.calls.show, shown + 1);assert(f.doc.querySelector('#maintenanceJobChip'));
    f.doc.querySelector('#maintenanceJobChip').click();assert.equal(job(f).querySelector('[data-job-result]').hidden, false);
    assert.equal(f.wire.length, 0);assert.deepEqual(f.errors, []);
  } finally { hold.release.resolve();await f.close(); }
});

test('the live stop button cancels the matching recovery without submitting the next source', async () => {
  const f = await setup(), entered = deferred(), release = deferred();let corpusCalls = 0;
  f.host.nativeFetch = async (_url, init) => {
    const input = JSON.parse(init.body).input;
    if(input.some(text => text.includes('Parcel'))){corpusCalls++;entered.resolve();await release.promise;}
    return new Response(JSON.stringify({data:input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});
  };
  try {
    const modal=await inspect(f);[...modal.querySelectorAll('button')].at(-1).click();await entered.promise;
    const stop=job(f).querySelector('#maintenanceJobCancelBtn');assert.equal(stop.disabled,false);stop.click();
    assert.equal(stop.disabled,true);assert.equal(job(f).querySelector('[data-job-cancel-note]').hidden,false);
    assert.match(job(f).querySelector('[data-job-state]').textContent,/중지 요청됨/);snapshot(f,'synthetic-recovery-cancelling');
    release.resolve();await until(()=>job(f)?.querySelector('[data-job-result]')?.hidden===false,'cancelled recovery',12000);
    assert.equal(job(f).querySelector('[data-job-state]').textContent,'중지됨');assert.equal(corpusCalls,1);
    const rows=(await f.api._test.loadScopeRecords((await f.api.resolveCurrentScope(false)).scopeKey)).records;
    assert.equal(rows.length,2);assert(rows.every(row=>row.text.includes('Parcel')));assert.deepEqual(f.errors,[]);
  } finally {release.resolve();await f.close();}
});

test('definitive provider failure is shown as remaining work instead of verified recovery success', async () => {
  const f=await setup();let rejected=0;
  f.host.nativeFetch=async(_url,init)=>{
    const input=JSON.parse(init.body).input;
    if(input.some(text=>text.includes('Parcel 1'))){rejected++;return new Response(JSON.stringify({error:{message:'synthetic provider rejection'}}),{status:400});}
    return new Response(JSON.stringify({data:input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});
  };
  try{
    const modal=await inspect(f);[...modal.querySelectorAll('button')].at(-1).click();
    await until(()=>job(f)?.querySelector('[data-job-result]')?.hidden===false,'recovery pending result',12000);
    assert.equal(job(f).querySelector('[data-job-state]').textContent,'완료 · 확인 필요');assert.equal(rejected,1);
    assert.match(job(f).querySelector('[data-job-result]').textContent,/복구 대기|확인 필요|실패/);snapshot(f,'synthetic-recovery-pending');
    const rows=(await f.api._test.loadScopeRecords((await f.api.resolveCurrentScope(false)).scopeKey)).records;
    assert.equal(rows.length,2);assert(rows.some(row=>row.embeddingWork?.status==='failed'));assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
