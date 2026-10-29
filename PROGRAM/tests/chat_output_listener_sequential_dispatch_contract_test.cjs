'use strict';
// RisuAI runs every plugin's chat-output listener with `await` in one loop. A
// listener that awaits host work starves later plugins; owners must also not
// wait for the next request to notice a starved listener.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..','plugins',name),'utf8');

test('GRADIA registers a synchronous output listener and detaches its host lookup',()=>{
 const source=read('GRADIA.js');
 assert.match(source,/const recordCommittedOutput = event => \{ void recordCommittedOutputReceipt\(event\)\.catch\(\(\) => \{\}\); \};/);
 assert.match(source,/addRisuChatListener\('output', recordCommittedOutput\)/);
 assert.match(source,/if \(!eventOwnsChat && Number\.isInteger\(event\.characterIndex\)/,'one-on-one events skip the full-character host snapshot');
});

test('LIBRA and HAYAKU fail over a starved chat-output listener on a timer after afterRequest',()=>{
 const libra=read('LIBRA.js'),hayaku=read('HAYAKU_Locator_Continuity.js');
 assert.match(libra,/const CHAT_OUTPUT_HEALTH_GRACE_MS = \d+;/);
 assert.match(libra,/failover\('chat_output_silent_after_request', clone\(pendingHealth\)\)/);
 assert.match(hayaku,/failoverSilentChatOutputBackend\(clone\(pendingHealth, \{\}\)\)\.catch\(\(\) => false\);/);
});

test('Flashback binds output events and v2 resolution by the request user message id',()=>{
 const source=read('Flashback_Memory.js');
 assert.match(source,/const idBound = !!boundId && text\(eventPair\.userMessageIdHash \|\| ''\) === boundId;/);
 assert.match(source,/return \(idBound \|\| !wanted \|\| wanted === eventUserHash\)/);
 assert.match(source,/const idBound=!awaiting&&!!pending\.requestUserMessageIdHash&&pair\.userMessageIdHash===pending\.requestUserMessageIdHash;/);
});

test('Flashback keyword recall covers stored records whose vectors await re-embedding',()=>{
 const source=read('Flashback_Memory.js');
 assert.match(source,/lexicalFallback = \{ status: 'vectors_pending'/);
 assert.match(source,/if \(!compatibility\.comparable && !keywordOnly\) continue;/);
});

test('Flashback request-local recall reads use their own budget, separate from cache residency',()=>{
 const source=read('Flashback_Memory.js');
 assert.match(source,/const RECALL_SHARD_CACHE_MAX_BYTES = 16 \* 1024 \* 1024;/);
 assert.match(source,/const RECALL_REQUEST_READ_MAX_BYTES = 64 \* 1024 \* 1024;/);
 assert.match(source,/if \(readSet\.bytes \+ bytes > RECALL_REQUEST_READ_MAX_BYTES\)/);
 assert.match(source,/reserveBytes > RECALL_REQUEST_READ_MAX_BYTES\) throw uncachedProjectionBudgetError\('decode'\)/);
 assert.match(source,/if \(estimatedBytes > RECALL_SHARD_CACHE_MAX_BYTES\) \{/,'cache residency keeps its own cap');
});

test('Flashback returns never-sent embedding attempts to pending instead of uncertain',()=>{
 const source=read('Flashback_Memory.js');
 // Never-sent is proven by the ledger: no request was added and none is pending.
 assert.match(source,/const neverSent = \(\/before wire submission\/\.test\(text\(error\?\.message \|\| ''\)\) \|\| reason === 'FLASHBACK_DEADLINE'\)\n\s*&& Number\(operationLedger\?\.snapshot\(\)\.requestCount \|\| 0\) === initialRequests\n\s*&& !Number\(operationLedger\?\.snapshot\(\)\.pendingRequests \|\| 0\);/);
 assert.match(source,/deferred \? \{ \.\.\.work, status: 'pending'/);
});

test('LIBRA branch reconcile stays a hard gate with a cold-start sized step limit',()=>{
 const source=read('LIBRA.js'),i=source.indexOf("'before_branch_reconcile',");
 assert.ok(i>0);assert.match(source.slice(i,i+800),/\n\s*6000 \+ RECALL_TIMEOUT_EXTENSION_MS\n\s*\);/);
 assert.match(source,/const RECALL_TIMEOUT_EXTENSION_MS = 10000;/);
});

test('Flashback maintenance never reads an incomplete inspection or missing chunks as healthy',()=>{
 const source=read('Flashback_Memory.js');
 assert.match(source,/const isHealthy = presentation\.tone === 'ok';/);
 assert.match(source,/if \(incomplete\) return \{ label: '점검 미완료', tone: 'warn'/,'an incomplete inspection is never the ok tone');
 assert.match(source,/const directExact = direct && direct\.complete !== false/);
 assert.match(source,/group\.complete !== false && sameMaintenanceTurnText\(/);
 assert.match(source,/const embeddingQueue = configuredModelEmbedding\(admission\.settings\)/,'server sync also drains pending embedding');
 assert.match(source,/uncapturedTurns, headTurnNodeId:/,'uncaptured live turns are reported beside the stored ledger');
 assert.match(source,/\.\.\.uncapturedTurns\.map\(pairIndex => \(\{ pairIndex, memory: 'none', uncaptured: true \}\)\)/,'and drawn on the route');
 assert.match(source,/\.legend i\.w\{border-color:var\(--warn\);border-radius:2px;transform:rotate\(45deg\)\}/,'only the marker rotates');
 const server=fs.readFileSync(path.join(__dirname,'..','server','core','flashback-scope-health.cjs'),'utf8');
 assert.match(server,/MAX_VALUE_BYTES = 8 \* 1024 \*\* 2, MAX_TOTAL_BYTES = 32 \* 1024 \*\* 2/);
});

test('Flashback fails over a starved listener on a timer and defers append-only worldline commits past recall',()=>{
 const source=read('Flashback_Memory.js');
 assert.match(source,/const FLASHBACK_CHAT_OUTPUT_HEALTH_GRACE_MS = 30000;/);
 assert.match(source,/void failoverSilentFlashbackChatOutputBackend\(\{ \.\.\.pendingHealth, trigger: 'after_request_timer' \}\)/);
 assert.match(source,/deferAppendOnlyWrite: true,/);
 assert.match(source,/options\.deferAppendOnlyWrite === true && allowRetirement && !newlyRetired\.length\n\s*&& !quarantinedResponses\.length && !restoredKeys\.size && !retiredLifecycleChanges/);
 assert.match(source,/if \(worldlineSync\?\.deferredWrite === true\) \{/);
});
