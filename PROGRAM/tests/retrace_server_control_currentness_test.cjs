'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../plugins/RETRACE.js'), 'utf8');
const hostStart = source.indexOf('  const serverControlHostIdentity =');
const readsetStart = hostStart >= 0 ? hostStart : source.indexOf('  const serverControlReadset =');
const start = readsetStart >= 0 ? readsetStart : source.indexOf('  const refreshServerControl =');
const end = source.indexOf('  const handleServerControl =', start);
assert.ok(start >= 0 && end > start, 'production refresh boundary exists');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const item = { promise, resolve: value => { item.settled = true; resolve(value); }, reject: error => { item.settled = true; reject(error); }, settled: false };
  return item;
}
function fixture() {
  const Runtime = { root: {}, visible: true, serverControl: {} };
  const settings = { url: 'http://localhost:47630', mode: 'plugin_only', scopeId: 'scope-1' };
  const identity = { characterId: 'character-1', chatId: 'chat-1', personaId: 'persona-1' };
  const binding = { generation: 1, dataInstanceId: 'instance-1', url: settings.url, current: true };
  const epochs = { hayaku: 0 };
  const authority = deferred();
  let holdAuthority = false, authorityEntered = false;
  let contextUnavailable = false;
  let nativeState = 'present';
  let selectedProfile = 'selected-profile';
  const host = {
    async getCurrentCharacterIndex(){if(nativeState==='read-failure')throw Error('fixture_context_read_failure');return nativeState==='invalid-index'?undefined:nativeState==='absent'?null:0;},
    async getCurrentChatIndex(){return nativeState==='no-chat'?-1:0;},
    async getCharacterFromIndex(){return nativeState==='missing-character'?undefined:nativeState==='malformed'?{}:{id:identity.characterId};},
    async getChatFromIndex(){return nativeState==='missing-chat'?undefined:{id:identity.chatId,personaId:identity.personaId};},
    async getDatabase(){if(nativeState==='database-failure')throw Error('fixture_database_read_failure');return {selectedPersona:selectedProfile};},
    async getCharacter(){if(nativeState==='read-failure')throw Error('fixture_context_read_failure');return nativeState==='absent'?null:nativeState==='malformed'?{}:{id:identity.characterId};},
    async getChat(){return nativeState==='no-chat'?null:{id:identity.chatId,personaId:identity.personaId};}
  };
  const batches = [];
  let rendered = 0;
  const bridge = { managerConnection: async () => ({ resetEpochs: structuredClone(epochs) }),
    getConnectionSettings: async () => structuredClone(settings), serverBinding: () => structuredClone(binding), managerControl(action) {
    if (action === 'status' && batches.at(-1)?.history?.settled) { authorityEntered = true; return holdAuthority ? authority.promise : Promise.resolve({ resetEpochs: structuredClone(epochs), dataInstanceId: binding.dataInstanceId }); }
    if (action === 'status') batches.push({});
    const item = deferred();
    batches.at(-1)[action] = item;
    return item.promise;
  } };
  const refresh = new Function('Runtime', 'MemorySuiteStorageBridge', 'renderServerControl', 'getCurrentContext', 'contextIdentity', 'liveApi', 'identityValue',
    source.slice(start, end) + '\nreturn refreshServerControl;')(Runtime, bridge, () => { rendered++; }, async () => { if(contextUnavailable)throw Error('no current character');return structuredClone(identity); },
    value => value?.character || value?.chat ? {characterId:value.character?.id||'',chatId:value.chat?.id||'',personaId:value.chat?.personaId||''} : value,
    names => !names || names.every(name=>typeof host[name]==='function') ? host : null, value=>String(value??''));
  const started = async count => { for (let i=0;i<50 && batches.length<count;i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(batches.length,count); };
  const finish = (batch, label, failure = false) => {
    for (const action of ['status', 'backups', 'history']) {
      if (failure) batch[action].reject(new Error(label));
      else batch[action].resolve(action === 'status' ? { version: label, resetEpochs: structuredClone(epochs), dataInstanceId: binding.dataInstanceId } : [{ id: label }]);
    }
  };
  return { Runtime, batches, refresh, finish, settings, identity, binding, epochs, authority, started,
    holdAuthority() { holdAuthority = true; }, nativeState(value){nativeState=value;contextUnavailable=value==='absent'||value==='no-chat';if(contextUnavailable)settings.scopeId='global:retrace';},
    directHost(){delete host.getCurrentCharacterIndex;delete host.getCurrentChatIndex;delete host.getCharacterFromIndex;delete host.getChatFromIndex;},
    selectedProfile(value){selectedProfile=value;},
    authorityEntered: () => authorityEntered, rendered: () => rendered };
}

(async () => {
  for (const failure of [false, true]) {
    const f = fixture();
    const old = f.refresh().catch(error => error);
    await f.started(1);
    const fresh = f.refresh();
    await f.started(2);
    f.finish(f.batches[1], 'post-restore');
    await fresh;
    const renderCount = f.rendered();
    f.finish(f.batches[0], 'pre-restore', failure);
    const oldResult = await old;
    assert.equal(f.Runtime.serverControl.status?.version, 'post-restore',
      `${failure ? 'old failure' : 'old success'} cannot replace the current post-restore status`);
    assert.equal(f.Runtime.serverControl.history[0].id, 'post-restore');
    assert.equal(f.Runtime.serverControl.loading, false);
    assert.equal(f.rendered(), renderCount, 'stale completion does not render');
    assert.ok(!(oldResult instanceof Error), 'stale failures do not surface in the current tab');
  }
  for (const reason of ['closed', 'remounted']) {
    const f = fixture();
    const pending = f.refresh();
    await f.started(1);
    if (reason === 'closed') f.Runtime.visible = false;
    else f.Runtime.root = {};
    const renderCount = f.rendered();
    f.finish(f.batches[0], 'old-root');
    await pending;
    assert.equal(f.Runtime.serverControl.status, undefined, `${reason} GUI does not accept a late result`);
    assert.equal(f.rendered(), renderCount, `${reason} GUI is not rendered by the late result`);
  }
  const f = fixture();
  f.Runtime.serverControl.status = { version: 'obsolete' };
  const currentFailure = f.refresh();
  await f.started(1);
  f.finish(f.batches[0], 'offline', true);
  await assert.rejects(currentFailure, /status: offline/);
  assert.equal(f.Runtime.serverControl.status, undefined, 'current failed refresh clears old status');
  assert.equal(f.Runtime.serverControl.loading, false);
  for (const [name, change] of [
    ['mode', f => { f.settings.mode = 'server_only'; }], ['URL', f => { f.settings.url = 'http://localhost:47631'; }],
    ['scope', f => { f.settings.scopeId = 'scope-2'; }], ['persona', f => { f.identity.personaId = 'persona-2'; }],
    ['character', f => { f.identity.characterId = 'character-2'; }], ['chat', f => { f.identity.chatId = 'chat-2'; }],
    ['binding generation', f => { f.binding.generation++; }], ['physical DATA', f => { f.binding.dataInstanceId = 'instance-2'; }],
    ['reset epoch', f => { f.epochs.hayaku++; }]
  ]) {
    const f = fixture();
    const pending = f.refresh();
    await f.started(1);
    f.batches[0].status.resolve({ version: 'old-binding', resetEpochs: structuredClone(f.epochs), dataInstanceId: f.binding.dataInstanceId });
    f.batches[0].backups.resolve([{ id: 'old-backup' }]);
    await new Promise(resolve => setImmediate(resolve));
    change(f);
    f.batches[0].history.resolve([{ id: 'old-history' }]);
    await assert.rejects(pending, {code:'server_control_context_changed'}, name + ' changed while only part of the old readset had arrived');
    assert.equal(f.Runtime.serverControl.status, undefined, name + ' never publishes the old fulfilled status');
    assert.equal(f.Runtime.serverControl.backups, undefined);
    assert.equal(f.Runtime.serverControl.history, undefined);
    assert.equal(f.Runtime.serverControl.loading, false);
  }
  const delayed = fixture();
  delayed.holdAuthority();
  const pending = delayed.refresh();
  await delayed.started(1);
  delayed.finish(delayed.batches[0], 'old-profile');
  for (let i=0;i<50 && !delayed.authorityEntered();i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(delayed.authorityEntered(), true);
  delayed.identity.personaId = 'new-profile-during-authority-read';
  delayed.authority.resolve({ resetEpochs: {hayaku:0}, dataInstanceId:'instance-1' });
  await assert.rejects(pending, {code:'server_control_context_changed'}, 'context is checked after the final awaited HTTP authority read');
  assert.equal(delayed.Runtime.serverControl.status, undefined);
  const mixed = fixture();
  const mixedPending = mixed.refresh();
  await mixed.started(1);
  mixed.batches[0].status.resolve({version:'old-server',resetEpochs:{hayaku:0},dataInstanceId:'instance-1'});
  mixed.batches[0].backups.resolve([{id:'old-backup'}]);
  mixed.settings.url = 'http://localhost:47631';
  mixed.batches[0].history.reject(Object.assign(new Error('MEMORY_SUITE_RESET_RECONNECT_REQUIRED'),{status:409,payload:{error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'}}));
  await assert.rejects(mixedPending, {code:'server_control_context_changed'}, 'fulfilled old status plus reset-refused pending history is never published after URL drift');
  assert.equal(mixed.Runtime.serverControl.status,undefined);
  assert.equal(mixed.Runtime.serverControl.backups,undefined);
  assert.equal(mixed.Runtime.serverControl.history,undefined);
  const hidden = fixture();
  hidden.Runtime.visible = false;
  const hiddenPending = hidden.refresh();
  for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(hidden.batches.length,0,'a physical operation finishing after close does not start a new hidden control query');
  assert.equal(await hiddenPending,null);
  assert.equal(hidden.rendered(),0);
  for(const direct of [false,true])for(const state of ['absent','no-chat']){
    const absent=fixture();absent.nativeState(state);
    if(direct)absent.directHost();
    const pending=absent.refresh().catch(error=>error);
    for(let i=0;i<50&&absent.batches.length<1;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(absent.batches.length,1,'explicit '+state+' still permits global control reads');
    absent.finish(absent.batches[0],'global-current');
    assert.ok(!(await pending instanceof Error));
    assert.equal(absent.Runtime.serverControl.status.version,'global-current');
  }
  for(const direct of [false,true])for(const state of ['read-failure','malformed','database-failure',...(!direct?['invalid-index','missing-character','missing-chat']:[])]){
    const invalid=fixture();if(direct)invalid.directHost();invalid.nativeState(state);
    invalid.Runtime.serverControl.status={version:'obsolete'};
    const pending=invalid.refresh();
    await assert.rejects(pending,state.endsWith('failure')?/fixture_.*read_failure/:{code:'server_control_context_unreadable'});
    assert.equal(invalid.batches.length,0,'read failures and malformed selection are never treated as absence');
    assert.equal(invalid.Runtime.serverControl.status,undefined);
    assert.equal(invalid.Runtime.serverControl.loading,false);
  }
  for(const [before,after] of [['absent','present'],['present','absent'],['no-chat','present'],['present','no-chat']]){
    const changed=fixture();changed.nativeState(before);changed.settings.scopeId='global:retrace';
    const pending=changed.refresh();await changed.started(1);
    changed.nativeState(after);changed.settings.scopeId='global:retrace';
    changed.finish(changed.batches[0],'old-selection');
    await assert.rejects(pending,{code:'server_control_context_changed'});
    assert.equal(changed.Runtime.serverControl.status,undefined,'absence transitions invalidate a pending readset');
  }
  const profile=fixture();profile.nativeState('absent');
  const profilePending=profile.refresh();await profile.started(1);
  profile.selectedProfile('replacement-global-profile');profile.finish(profile.batches[0],'old-profile');
  await assert.rejects(profilePending,{code:'server_control_context_changed'});
  const unreadable=fixture();const unreadablePending=unreadable.refresh();await unreadable.started(1);
  unreadable.nativeState('read-failure');unreadable.finish(unreadable.batches[0],'old-readable');
  await assert.rejects(unreadablePending,/fixture_context_read_failure/);
  assert.equal(unreadable.Runtime.serverControl.status,undefined,'a failed after-read clears the old fulfilled readset');
  for(const restored of [false,true]){
    const refused=fixture();refused.Runtime.serverControl.plan={planId:'obsolete-preview'};
    const statusError=Object.assign(new Error('fixture_status_refused'),{status:400,payload:{error:'fixture_status_refused'}});
    const pending=refused.refresh();await refused.started(1);
    refused.batches[0].status.reject(statusError);refused.batches[0].backups.resolve([{id:'old-backup'}]);
    if(restored)refused.epochs.hayaku++;
    refused.batches[0].history.resolve([{id:'old-history'}]);
    const failure=await pending.catch(error=>error);
    assert.equal(failure.message,'status: fixture_status_refused');
    assert.equal(refused.Runtime.serverControl.status,undefined);
    assert.equal(refused.Runtime.serverControl.backups,undefined,'without original status the dependent backup observation cannot be certified');
    assert.equal(refused.Runtime.serverControl.history,undefined,'without original status the dependent history observation cannot be certified');
    assert.equal(refused.Runtime.serverControl.plan,null,'an uncertified batch invalidates its restore preview');
    assert.equal(failure.cause,statusError,'the precise original refusal remains available as the cause');
  }
  const partial=fixture();const partialPending=partial.refresh();await partial.started(1);
  partial.batches[0].status.resolve({version:'current',resetEpochs:{hayaku:0},dataInstanceId:'instance-1'});
  partial.batches[0].backups.reject(new Error('fixture_backups_refused'));partial.batches[0].history.resolve([{id:'current-history'}]);
  await assert.rejects(partialPending,/backups: fixture_backups_refused/);
  assert.equal(partial.Runtime.serverControl.status.version,'current','certified stable partial status/history behavior is preserved');
  assert.equal(partial.Runtime.serverControl.history[0].id,'current-history');assert.equal(partial.Runtime.serverControl.backups,undefined);
  console.log('retrace_server_control_currentness_test: PASS (39 cases, including uncertified partial-batch refusal and certified partial success)');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
