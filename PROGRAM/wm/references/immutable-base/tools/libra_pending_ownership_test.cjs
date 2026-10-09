'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');
const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
const fixtureModule = new Module(fixturePath, module); fixtureModule.filename = fixturePath;
fixtureModule.paths = Module._nodeModulePaths(__dirname);
fixtureModule._compile(fs.readFileSync(fixturePath, 'utf8')
  .replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')")
  .replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,PendingTurnManager,DurableTurnLedger,TurnRecordLedger,TokenizerEngine,RuntimeStateLease};'), fixturePath);
const { loadGui } = fixtureModule.exports;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const clone = x => JSON.parse(JSON.stringify(x));
async function fixture(file, options = {}) {
  process.env.LIBRA_GUI_TEST_DIST = path.join(__dirname, '../dist', file);
  const f = await loadGui({nativeInitialization: true, ...options});
  f.clock = {now: Date.now(), timers: new Map(), sequence: 100000};
  const NativeDate = f.w.Date;
  f.w.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [f.clock.now])); } static now() { return f.clock.now; } };
  f.w.setTimeout = (fn, ms) => {const id = ++f.clock.sequence; f.clock.timers.set(id, {fn, at: f.clock.now + Math.max(0, ms)}); return id;};
  f.w.clearTimeout = id => f.clock.timers.delete(id);
  f.advance = async ms => {
    f.clock.now += ms;
    for (let i = 0; i < 20; i++) {
      const ready = [...f.clock.timers].filter(([, t]) => t.at <= f.clock.now);
      for (const [id, t] of ready) { f.clock.timers.delete(id); Promise.resolve(t.fn()).catch(error => {f.error = error;}); }
      await flush(); if (f.error) throw f.error;
      if (![...f.clock.timers.values()].some(t => t.at <= f.clock.now)) break;
    }
  };
  f.add = async (n, opts = {}) => {
    const user = `Mira asks about the northern crossing at turn ${n}.`;
    const text = opts.text || `Mira reaches gate ${n} and finds a silver key marked ${n}.`;
    const chat = f.control.chat;
    chat.message.push({role: 'user', data: user, m_id: 'queue-u-' + n, time: f.clock.now}); chat.msgs = chat.message;
    await f.callbacks.beforeRequest([{role: 'user', content: user}], 'model');
    const origins = f.api.MemoryState.afterRequestOriginsByType.get('model') || [];
    const origin = origins.shift(); assert(origin);
    const fallback = f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.get(chat.id);
    if (fallback?.owner) fallback.owner.cancelled = true;
    if (fallback?.timer) f.w.clearTimeout(fallback.timer);
    f.api.MemoryState.afterRequestMissingRecoveryTimersByChatId.delete(chat.id);
    const handle = await f.api.DurableTurnLedger.appendObserved({origin, recordId: origin.requestId, assistantText: text}); assert.equal(handle.ok, true);
    if (opts.host !== false) chat.message.push({role: 'assistant', data: text, m_id: 'queue-a-' + n, time: f.clock.now});
    const payload = {aiHash: f.api.TokenizerEngine.simpleHash(text), sourceHash: f.api.TokenizerEngine.simpleHash(text), aiResponse: text, aiResponseRaw: text,
      userMsgForMemory: user, userMsgForNarrative: user, sourceCapture: origin.sourceCapture,
      originMessageCount: origin.messageCount, messageCount: origin.messageCount, requestSequence: origin.requestSequence,
      predictedTurn: f.api.MemoryEngine.getCurrentTurn() + 1, allowMemoryCapture: true, allowNarrativeProcessing: false,
      targetContext: {...origin, durableLedgerRecordId: handle.recordId, durableLedgerRecordKey: handle.recordKey}};
    const headBefore = f.api.PendingTurnManager.getPending(chat);
    const headBeforeJson = headBefore && JSON.stringify(headBefore);
    const pending = f.api.PendingTurnManager.registerPending(chat, payload); assert(pending);
    return {origin, handle, payload, pending, text, headBeforeJson};
  };
  f.rows = () => readLedgerReceipts(f.store);
  f.commit = pending => f.api.PendingTurnManager.commitPendingNow(f.control.char, f.control.chat, 'pending-ownership-test', {pending, force: true, suppressFinalizeRetry: true});
  return f;
}
const checks = [];
async function check(file, name, fn) {
  if (process.env.WM_PENDING_FILTER && !new RegExp(process.env.WM_PENDING_FILTER).test(name)) return;
  let f;
  try { f = await fixture(file); const detail = await fn(f); checks.push({file, name, ok: true, detail}); console.log('PASS ' + file + ': ' + name); }
  catch (error) { checks.push({file, name, ok: false, error: error.stack}); console.error('FAIL ' + file + ': ' + name + ': ' + error.message); }
  finally { f?.close(); }
}
async function main() {
  for (const file of (process.env.WM_PENDING_VARIANT === 'min' ? ['LIBRA World Manager.js'] : ['LIBRA World Manager Full.js'])) {
    await check(file, 'distinct registrations retain the oldest owner without serializing tail', async f => {
      const a = await f.add(1), before = JSON.stringify(a.pending), b = await f.add(2);
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat), a.pending, 'later pending must not overwrite earlier owner');
      assert.equal(JSON.stringify(a.pending), b.headBeforeJson, 'queue metadata is not serialized into pending payload');
      assert.equal(f.rows().length, 2, 'both actual immutable raw receipts persisted');
      assert.notEqual(a.pending, b.pending);
    });
    await check(file, 'same receipt callback preserves owner reference age and stability', async f => {
      const a = await f.add(1); a.pending.stableMatches = 1; f.clock.now += 100;
      const repeat = f.api.PendingTurnManager.registerPending(f.control.chat, clone(a.payload));
      assert.equal(repeat, a.pending, 'duplicate must keep exact owner'); assert.equal(repeat.stableMatches, 1);
      assert.equal(repeat.createdAt, a.pending.createdAt);
    });
    await check(file, 'queued owner cannot commit ahead of the head and all map in order', async f => {
      const a = await f.add(1), b = await f.add(2), c = await f.add(3);
      const premature = await f.commit(c.pending); assert.equal(premature.status, 'waiting');
      assert.equal(f.rows().filter(r => r.status === 'committed').length, 0, 'no turn may leap the head');
      for (const [i, item] of [a,b,c].entries()) {
        const result = await f.commit(item.pending); assert.equal(result.status, 'finalized'); assert.equal(result.turn, i + 1);
      }
      const rows = f.rows(); assert.equal(rows.filter(r => r.status === 'committed').length, 3);
      assert.deepEqual(rows.map(r => r.turn), [1,2,3]);
      const records = f.api.TurnRecordLedger.loadState(f.api.MemoryEngine.getLorebook(f.control.char,f.control.chat),f.control.chat,f.control.char).records;
      assert.deepEqual(Array.from(records, r => [r.turn, r.liveMessageIds[0]]), [[1,'queue-a-1'],[2,'queue-a-2'],[3,'queue-a-3']]);
    });
    await check(file, 'identical response bytes with distinct native IDs retain distinct turns', async f => {
      const text = 'Mira keeps the same old key.';
      const a = await f.add(1, {text}), b = await f.add(2, {text});
      assert.equal((await f.commit(a.pending)).turn, 1);
      assert.equal((await f.commit(b.pending)).turn, 2);
      assert.deepEqual(f.rows().map(r=>r.turn), [1,2]);
    });
    await check(file, 'capacity64 includes head and receipt65 is durably blocked without replacement', async f => {
      const entries = [];
      for (let n = 1; n <= 65; n++) entries.push(await f.add(n));
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat), entries[0].pending);
      assert.equal(entries.filter(x=>f.api.PendingTurnManager.hasPendingReceipt({recordKey:x.handle.recordKey})).length, 64);
      const result = await f.commit(entries[64].pending);
      assert.equal(result.status, 'waiting'); assert.equal(result.reason, 'pending_queue_capacity');
      const receipt = (await f.api.DurableTurnLedger.readRecord(entries[64].handle)).record;
      assert.equal(receipt.deferredReason, 'pending_queue_capacity'); assert.equal(receipt.status, 'observed');
      assert.equal(f.rows().length, 65); assert.equal(receipt.assistantText, entries[64].text);
      return {raw:65, owned:64, overflow:receipt.deferredReason};
    });
    await check(file, 'incompatible unanchored head is parked only after anchored successor proof', async f => {
      const a = await f.add(1, {host:false}), b = await f.add(2);
      const original = f.store.get(a.handle.recordKey);
      const parked = await f.commit(a.pending);
      assert.equal(parked.status, 'blocked'); assert.equal(parked.reason, 'blocked_host_source_changed');
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat), b.pending);
      const receipt = (await f.api.DurableTurnLedger.readRecord(a.handle)).record;
      assert.equal(receipt.status, 'observed'); assert.equal(receipt.analysisStatus, 'blocked_host_source_changed');
      assert.equal(f.store.get(a.handle.recordKey), original);
      assert.equal((await f.commit(b.pending)).turn, 1);
    });
    await check(file, 'same-slot replacement cannot steal newer exact host source through transformed fallback', async f => {
      const a = await f.add(1), text = 'Mira chooses a different road and leaves the key behind.';
      const handle = await f.api.DurableTurnLedger.appendObserved({origin:a.origin,recordId:a.origin.requestId,assistantText:text}); assert(handle.ok);
      f.control.chat.message[1].data = text;
      const pending = f.api.PendingTurnManager.registerPending(f.control.chat, {...a.payload, aiHash:f.api.TokenizerEngine.simpleHash(text),sourceHash:f.api.TokenizerEngine.simpleHash(text),aiResponse:text,aiResponseRaw:text,targetContext:{...a.payload.targetContext,durableLedgerRecordId:handle.recordId,durableLedgerRecordKey:handle.recordKey}});
      const result = await f.commit(a.pending);
      assert.equal(result.status,'blocked'); assert.equal(result.reason,'blocked_host_source_changed');
      assert.equal((await f.api.DurableTurnLedger.readRecord(a.handle)).record.status,'observed');
      assert.equal((await f.commit(pending)).status,'finalized');
      const rows=f.rows();assert.equal(rows.filter(r=>r.status==='committed').length,1);assert.equal(rows.find(r=>r.status==='committed').assistantText,text);
    });
    await check(file, 'fresh runtime recovers queued raw receipts without any serialized FIFO', async f => {
      const entries=[];for(let n=1;n<=5;n++)entries.push(await f.add(n));
      const originals=new Map(entries.map(x=>[x.handle.recordKey,f.store.get(x.handle.recordKey)]));
      const character=clone(f.control.char),store=new Map(f.store);f.close();
      const fresh=await fixture(file,{store,character});
      try {
        await fresh.callbacks.beforeRequest([{role:'user',content:'Mira observes the old northern path.'}],'model');
        for(let i=0;i<80;i++){await fresh.advance(500);if(fresh.rows().filter(r=>r.status==='committed').length===5)break;}
        assert.equal(fresh.rows().filter(r=>r.status==='committed').length,5);
        assert.deepEqual(fresh.rows().map(r=>r.turn),[1,2,3,4,5]);
        for(const[k,v]of originals)assert.equal(store.get(k),v,'restart preserves raw bytes');
        return {raw:fresh.rows().length,committed:5};
      } finally {fresh.close();}
    });

    await check(file, 'fresh live registration cannot jump durable older raw from a previous runtime', async f => {
      const old=await f.add(1);const character=clone(f.control.char),store=new Map(f.store);f.close();
      const fresh=await fixture(file,{store,character});
      try {
        const newest=await fresh.add(2);const result=await fresh.commit(newest.pending);
        assert.equal(result.status,'waiting');assert.equal(fresh.rows().filter(r=>r.status==='committed').length,0);
        for(let i=0;i<60;i++){await fresh.advance(500);if(fresh.rows().filter(r=>r.status==='committed').length===2)break;}
        assert.deepEqual(fresh.rows().map(r=>r.turn),[1,2]);
      } finally {fresh.close();}
    });
    await check(file, 'older raw read failure blocks newer canonical mutation', async f => {
      const a=await f.add(1), b=await f.add(2);f.api.PendingTurnManager.dropPending(f.control.chat,a.pending);
      const read=f.w.risuai.pluginStorage.getItem;f.w.risuai.pluginStorage.getItem=async key=>{if(key===a.handle.recordKey)throw new Error('synthetic older raw read failure');return read(key);};
      const result=await f.commit(b.pending);assert.equal(result.status,'waiting');assert.equal(result.reason,'pending_order_read_unverified');
      assert.equal(f.rows().filter(r=>r.status==='committed').length,0);
    });

    await check(file, 'old completed receipt callback cannot rewind turn or alter its verified lifecycle', async f => {
      const a=await f.add(1);assert.equal((await f.commit(a.pending)).status,'finalized');
      const b=await f.add(2);assert.equal((await f.commit(b.pending)).status,'finalized');
      const before=f.store.get(a.handle.recordKey+'::status'), canonical=f.store.get(f.key);
      const repeated=f.api.PendingTurnManager.registerPending(f.control.chat,clone(a.payload));assert(repeated);
      const result=await f.commit(repeated);assert.equal(result.status,'already-committed');
      assert.equal(f.api.MemoryEngine.getCurrentTurn(),2);assert.equal(f.store.get(f.key),canonical);
      assert.equal(f.store.get(a.handle.recordKey+'::status'),before);
    });

    await check(file, 'overflow raw resumes after owned predecessors drain', async f => {
      const entries=[];for(let n=1;n<=65;n++)entries.push(await f.add(n));
      await f.commit(entries[64].pending);
      const raw=f.store.get(entries[64].handle.recordKey);
      for(const item of entries.slice(0,64))assert.equal((await f.commit(item.pending)).status,'finalized');
      for(let i=0;i<60;i++){await f.advance(500);if(f.rows().filter(r=>r.status==='committed').length===65)break;}
      assert.equal(f.rows().filter(r=>r.status==='committed').length,65);
      assert.deepEqual(f.rows().map(r=>r.turn),Array.from({length:65},(_,i)=>i+1));
      assert.equal(f.store.get(entries[64].handle.recordKey),raw);
      return {raw:65,committed:65,lastTurn:65};
    });
    await check(file, 'stale retry callback cannot remove promoted owner timer', async f => {
      const a=await f.add(1), b=await f.add(2);
      f.api.PendingTurnManager.schedulePendingFinalizeRetry(f.control.char,f.control.chat,'afterRequest-test',250);
      const entry=f.api.MemoryState.pendingFinalizeRetryTimersByScope.get(a.origin.scopeKey), callback=f.clock.timers.get(entry.timer)?.fn;assert(callback);
      await f.commit(a.pending);
      const next=f.api.MemoryState.pendingFinalizeRetryTimersByScope.get(b.origin.scopeKey);assert(next);const writes=f.calls.writes.length;
      await callback();await flush();
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat),b.pending);
      assert.equal(f.api.MemoryState.pendingFinalizeRetryTimersByScope.get(b.origin.scopeKey),next);
      assert.equal(f.calls.writes.length,writes);
    });
    await check(file, 'age alone retains head and newly anchored successor wakes exhausted head', async f => {
      const a=await f.add(1,{host:false});f.clock.now+=200000;
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat),a.pending);
      a.pending.finalizeRetryAttempts=12;a.pending.finalizeRetryStartedAt=f.clock.now-40000;
      const b=await f.add(2);await f.commit(b.pending);
      for(let i=0;i<20;i++)await f.advance(500);
      assert.equal((await f.api.DurableTurnLedger.readRecord(a.handle)).record.analysisStatus,'blocked_host_source_changed');
      assert.equal((await f.api.DurableTurnLedger.readRecord(b.handle)).record.status,'committed');
    });
    for(const mode of ['read-failure','streaming'])await check(file, `incompatible head is never parked on ${mode}`, async f => {
      const a=await f.add(1,{host:false}),b=await f.add(2);
      if(mode==='read-failure')f.control.failReads=true;else f.control.chat.isStreaming=true;
      const result=await f.commit(a.pending);assert.notEqual(result.status,'blocked');assert.notEqual(result.status,'finalized');
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat),a.pending);
      assert.notEqual((await f.api.DurableTurnLedger.readRecord(a.handle)).record.analysisStatus,'blocked_host_source_changed');
      assert.equal(f.rows().filter(r=>r.status==='committed').length,0);
    });
    for(const mode of ['runtime-reset','scope-change','unload'])await check(file, `${mode} clears live ownership while fresh runtime resumes immutable queued raw`, async f => {
      const a=await f.add(1),b=await f.add(2), originals=new Map([a,b].map(x=>[x.handle.recordKey,f.store.get(x.handle.recordKey)]));
      const character=clone(f.control.char);
      if(mode==='runtime-reset')f.api.MemoryState.reset();
      if(mode==='scope-change'){f.control.chat.bindedPersona='persona-b';let settled=false;const transition=f.callbacks.beforeRequest([{role:'user',content:'A separate persona watches.'}],'model').finally(()=>{settled=true;});for(let i=0;i<100&&!settled;i++)await f.advance(100);assert(settled,'persona transition settles under driven fake clock');await transition;}
      if(mode==='unload')for(const fn of f.callbacks.unload||[])await fn();
      assert.equal(f.api.PendingTurnManager.hasPendingReceipt({recordKey:a.handle.recordKey}),false);
      assert.equal(f.api.PendingTurnManager.hasPendingReceipt({recordKey:b.handle.recordKey}),false);
      const store=new Map(f.store);f.close();const fresh=await fixture(file,{store,character});
      try{await fresh.callbacks.beforeRequest([{role:'user',content:'Mira returns to the same preserved conversation.'}],'model');
        for(let i=0;i<60;i++){await fresh.advance(500);if(fresh.rows().filter(r=>r.status==='committed').length===2)break;}
        assert.equal(fresh.rows().filter(r=>r.status==='committed').length,2);
        for(const[k,v]of originals)assert.equal(store.get(k),v);
      }finally{fresh.close();}
    });
    await check(file, 'verified data reset keeps old raw but never replays it into new generation', async f => {
      const a=await f.add(1),b=await f.add(2),originals=new Map([a,b].map(x=>[x.handle.recordKey,f.store.get(x.handle.recordKey)]));
      const result=await f.api.LibraDataStorage.resetVerified(a.origin.canonicalScope,{expectedGeneration:0,isCurrent:async()=>true});assert(result.ok);
      f.api.MemoryState.reset();const character=clone(f.control.char),store=new Map(f.store);f.close();const fresh=await fixture(file,{store,character});
      try{await fresh.callbacks.beforeRequest([{role:'user',content:'Mira begins after reset.'}],'model');for(let i=0;i<20;i++)await fresh.advance(500);
        assert.equal(fresh.rows().filter(r=>r.status==='committed').length,0);
        for(const[k,v]of originals)assert.equal(store.get(k),v);
        assert.equal(JSON.parse(store.get(fresh.key)).resetGeneration,1);
      }finally{fresh.close();}
    });
    await check(file, 'bounded multipage order cursor survives a new live append and large raw prefix', async f => {
      const initial=await f.add(1);await f.api.DurableTurnLedger.markStatus(initial.handle,{status:'committed',analysisStatus:'done'});f.api.PendingTurnManager.dropPending(f.control.chat,initial.pending);
      for(let n=2;n<=300;n++){
        const text=n<=4?'large retained raw '+String(n)+'x'.repeat(600000):'old committed raw '+n;
        const h=await f.api.DurableTurnLedger.appendObserved({origin:initial.origin,recordId:'prefix-'+n,assistantText:text});assert(h.ok);assert((await f.api.DurableTurnLedger.markStatus(h,{status:'committed',analysisStatus:'done'})).ok);
      }
      const next=await f.add(301);let reads=0;const read=f.w.risuai.pluginStorage.getItem;f.w.risuai.pluginStorage.getItem=async key=>{if(key.includes('::record::')&&!key.endsWith('::status')&&!key.endsWith('::publication'))reads++;return read(key);};
      if(global.gc)global.gc();const heap=process.memoryUsage().heapUsed;
      const first=await f.commit(next.pending);assert.equal(first.status,'waiting');assert.equal(first.reason,'pending_order_scan_incomplete');assert(reads<=280,'one pass remains within256 receipts plus own/chunk storage reads');
      const last=await f.add(302);reads=0;const done=await f.commit(next.pending);assert.equal(done.status,'finalized');assert.equal(done.turn,1);assert(reads<100,'new live append must not rewind the256-record verified prefix');
      assert.equal((await f.commit(last.pending)).turn,2);
      if(global.gc){global.gc();assert(process.memoryUsage().heapUsed-heap<128*1024*1024,'existing128MiB settled-growth ceiling');}
      return {prefix:300,largeRawReceipts:3,largeRawChars:600000,continuedReads:reads,gc:!!global.gc};
    });

    for(const mode of ['verified-park','uncertain-park','uncertain-resume'])await check(file, `parking late ACK ${mode} retains restored head until verified lifecycle resume`, async f => {
      const a=await f.add(1,{host:false}),b=await f.add(2),write=f.w.risuai.pluginStorage.setItem;
      let entered=false,release,statusWrites=0;const gate=new Promise(resolve=>{release=resolve;});
      f.w.risuai.pluginStorage.setItem=async(k,v)=>{
        if(k===a.handle.recordKey+'::status'){
          statusWrites++;if(!entered){entered=true;await gate;}
          const result=await write(k,v);
          if((mode==='uncertain-park'&&statusWrites===1)||(mode==='uncertain-resume'&&statusWrites===2))return false;
          return result;
        }
        return write(k,v);
      };
      const work=f.commit(a.pending);await flush();assert(entered);
      f.control.chat.message[1]={role:'assistant',data:a.text,m_id:'queue-a-1',time:f.clock.now};
      release();const result=await work;
      assert.equal(result.status,'waiting','changed host evidence may not retire the owner');
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat),a.pending);
      assert.equal(f.rows().filter(r=>r.status==='committed').length,0);
      if(mode==='uncertain-park')assert.equal(statusWrites,1,'uncertain park ACK cannot authorize compensating lifecycle write');
      f.w.risuai.pluginStorage.setItem=write;
      let resumed;for(let i=0;i<3;i++){resumed=await f.commit(a.pending);if(resumed.status==='finalized')break;}
      assert.equal(resumed.status,'finalized');assert.equal(resumed.turn,1);
      assert.equal((await f.api.DurableTurnLedger.readRecord(a.handle)).record.status,'committed');
      return {initial:result.status,resumed:resumed.status,turn:resumed.turn,mode};
    });

    for(const wake of ['commit-only','host-hook'])await check(file, `active queued maintenance is not redundantly replayed by ${wake}`, async f => {
      const a=await f.add(1);a.pending.allowNarrativeProcessing=true;
      assert.equal((await f.commit(a.pending)).status,'finalized');
      const start=f.calls.writes.length;
      if(wake==='host-hook')await f.callbacks.beforeRequest([{role:'user',content:'Mira considers the same preserved key.'}],'model');
      await f.advance(100);await f.advance(50);
      const patches=f.calls.writes.slice(start).filter(x=>x.key===a.handle.recordKey+'::status').map(x=>JSON.parse(x.value).patch);
      assert.equal(patches.some(p=>p.analysisStatus==='replaying'),false,'live maintenance owns this receipt until it settles');
      const entries=Array.from(f.api.MemoryState.turnMaintenanceSchedulesByChatId.values());
      for(const entry of entries)for(const record of entry.pendingRecords||[])assert.equal(record.coalescedCount,1,'no duplicate maintenance projection');
    });

    await check(file, 'replay failures stop after one bounded sweep and one new host hook resumes backlog', async f => {
      const entries=[];for(let n=1;n<=9;n++)entries.push(await f.add(n));
      for(const entry of entries)f.api.PendingTurnManager.dropPending(f.control.chat,entry.pending);
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat),null);
      const originals=new Map(entries.map(e=>[e.handle.recordKey,f.store.get(e.handle.recordKey)]));
      const start=f.calls.writes.length;f.control.failReads=true;
      const admissions=()=>f.calls.writes.slice(start).filter(x=>x.key.endsWith('::status')).map(x=>JSON.parse(x.value)).filter(x=>x.patch.analysisStatus==='replaying');
      for(let i=0;i<16;i++)await f.advance(100);
      const bounded=admissions().length;assert(bounded>0 && bounded<=8,'one host wake admits at most eight receipts; got '+bounded);
      for(let i=0;i<16;i++)await f.advance(100);
      assert.equal(admissions().length,bounded,'failed replay workers may not self-schedule another sweep');
      assert.equal(f.calls.writes.slice(start).filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);
      assert.equal(f.rows().filter(r=>r.status==='committed').length,0);
      for(const[k,v]of originals)assert.equal(f.store.get(k),v);
      f.control.failReads=false;
      await f.callbacks.beforeRequest([{role:'user',content:'Mira resumes the preserved nine replies.'}],'model');
      for(let i=0;i<180;i++){await f.advance(500);if(f.rows().filter(r=>r.status==='committed').length===9)break;}
      const committed=f.rows().filter(r=>r.status==='committed');assert.equal(committed.length,9,'one later host hook must resume all durable backlog');
      assert.deepEqual(committed.map(r=>r.turn),[1,2,3,4,5,6,7,8,9]);
      for(const[k,v]of originals)assert.equal(f.store.get(k),v);
      const records=f.api.TurnRecordLedger.loadState(f.api.MemoryEngine.getLorebook(f.control.char,f.control.chat),f.control.chat,f.control.char).records;
      assert.deepEqual(Array.from(records,r=>[r.turn,r.liveMessageIds[0]]),entries.map((e,i)=>[i+1,'queue-a-'+(i+1)]));
      return {failedSweepAdmissions:bounded,noHookObservationMs:3200,resumedByNewHostHooks:1,committed:9,rawUnchanged:true};
    });

    await check(file, 'completed duplicate after host edit leaves FIFO without certifying current source', async f => {
      const a=await f.add(1);assert.equal((await f.commit(a.pending)).status,'finalized');
      const b=await f.add(2);assert.equal((await f.commit(b.pending)).status,'finalized');
      f.control.chat.message[1].data='The host has edited the old source after completion.';
      const status=f.store.get(a.handle.recordKey+'::status'),canonical=f.store.get(f.key);
      const duplicate=f.api.PendingTurnManager.registerPending(f.control.chat,clone(a.payload));assert(duplicate);const c=await f.add(3);
      const result=await f.commit(duplicate);assert.equal(result.status,'already-committed');
      assert.equal(f.api.MemoryEngine.getCurrentTurn(),2);assert.equal(f.store.get(f.key),canonical);
      assert.equal(f.store.get(a.handle.recordKey+'::status'),status);assert.equal(f.api.PendingTurnManager.getPending(f.control.chat),c.pending);
      assert.equal((await f.commit(c.pending)).turn,3);
    });
    await check(file, 'already parked duplicate stays off live FIFO after source restoration and successor commit', async f => {
      const a=await f.add(1,{host:false}),b=await f.add(2);assert.equal((await f.commit(a.pending)).status,'blocked');assert.equal((await f.commit(b.pending)).turn,1);
      f.control.chat.message[1]={role:'assistant',data:a.text,m_id:'queue-a-1',time:f.clock.now};
      const status=f.store.get(a.handle.recordKey+'::status'),canonical=f.store.get(f.key);
      const duplicate=f.api.PendingTurnManager.registerPending(f.control.chat,clone(a.payload));assert(duplicate);const c=await f.add(3);
      const result=await f.commit(duplicate);assert.equal(result.status,'blocked');
      assert.equal(f.api.PendingTurnManager.getPending(f.control.chat),c.pending);
      assert.equal(f.store.get(a.handle.recordKey+'::status'),status);assert.equal(f.store.get(f.key),canonical);assert.equal(f.api.MemoryEngine.getCurrentTurn(),1);
      assert.equal((await f.commit(c.pending)).turn,2);assert.equal(f.rows().filter(r=>r.status==='committed').length,2);
    });

  }
  const summary = {passed: checks.filter(c=>c.ok).length, failed: checks.filter(c=>!c.ok).length, realModelCalls: 0, checks};
  const out = path.join(__dirname,'../verification/pending-ownership'); fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,(process.env.WM_PENDING_PHASE || 'results')+'.json'), JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2)); process.exitCode = summary.failed ? 1 : 0;
}
if(require.main === module) main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports = {fixture, flush};
