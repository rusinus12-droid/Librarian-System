'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const pages=require('../tools/libra_memory_graph_pages.cjs')({fingerprint:s=>crypto.createHash('sha256').update(s).digest('hex')});
const factory=require('../tools/libra_memory_graph_resources.cjs');
const make=limits=>factory({measure:pages.measure,encodedSize:pages.encodedSize,stageCost:pages.stageCost,limits});
const idle=pool=>{const s=pool.inspect();assert.equal(s.ioBytes,0);assert.equal(s.decodeBytes,0);assert.equal(s.reads,0);};
const gate=()=>{let release;const promise=new Promise(r=>release=r);return{promise,release};};

test('raw UTF-8 payload, repeated reads and durable access have separate cumulative counters',async()=>{
 const pool=make(),q=pool.open();const text='가🙂';
 await q.read(async()=>text);await q.read(async()=>text);await q.read(async()=>({value:text}),{kind:'durable',select:r=>r.value});
 const s=q.inspect();assert.equal(s.sourceBytes,Buffer.byteLength(text)*2);assert.equal(s.durableBytes,Buffer.byteLength(text));
 assert.equal(s.reads,3);assert.equal(s.byteBounded,false);idle(pool);
});
test('oversized source is refused before parsing and a swallowed budget failure stays latched',async()=>{
 const pool=make(),q=pool.open({maxValueBytes:8});let parsed=false;
 await assert.rejects(()=>q.read(async()=>'가'.repeat(10),{consume:()=>{parsed=true;}}),/VALUE_BYTE_BUDGET/);
 assert.equal(parsed,false);assert.throws(q.check,/VALUE_BYTE_BUDGET/);await assert.rejects(()=>q.read(async()=>'x'),/VALUE_BYTE_BUDGET/);idle(pool);
 assert.equal(await pool.open().read(async()=>'healthy'),'healthy');idle(pool);
});
test('source and read-count quotas refuse an additional physical load',async()=>{
 const pool=make(),q=pool.open({maxSourceBytes:4,maxValueBytes:4});let calls=0;
 await q.read(async()=>{calls++;return'abcd';});await assert.rejects(()=>q.read(async()=>{calls++;return'e';}),/SOURCE_BYTE_BUDGET/);assert.equal(calls,1);
 const count=pool.open({maxReads:1});await count.read(async()=>null);await assert.rejects(()=>count.read(async()=>{calls++;}),/READ_COUNT_BUDGET/);assert.equal(calls,1);idle(pool);
});
test('dense encoded JSON reserves decode workspace before JSON.parse',async()=>{
 const pool=make(),q=pool.open({maxDecodeBytes:100000});const text=JSON.stringify(Array(2000).fill(0));let parsed=false;
 await assert.rejects(()=>q.read(async()=>text,{consume:raw=>{parsed=true;return JSON.parse(raw);}}),/DECODE_WORKSPACE_BUDGET/);
 assert.equal(parsed,false);idle(pool);
});
test('overlapping requests share I/O admission and releasing a late load restores the pool',async()=>{
 const pool=make({ioBytes:8,reads:1}),a=pool.open({maxValueBytes:8}),b=pool.open({maxValueBytes:8}),g=gate();
 const pending=a.read(async()=>{await g.promise;return'ok';});let calls=0;
 await assert.rejects(()=>b.read(async()=>{calls++;return'no';}),/IO_BACKPRESSURE/);assert.equal(calls,0);assert.equal(pool.inspect().ioBytes,8);
 g.release();assert.equal(await pending,'ok');idle(pool);assert.equal(await pool.open({maxValueBytes:8}).read(async()=>'new'),'new');idle(pool);
});
test('in-flight cumulative quota cannot be double-spent within one request',async()=>{
 const pool=make(),q=pool.open({maxSourceBytes:4,maxValueBytes:4}),g=gate();
 const pending=q.read(async()=>{await g.promise;return'abcd';});const rejected=assert.rejects(()=>q.read(async()=>'efgh'),/SOURCE_BYTE_BUDGET/);
 await rejected;g.release();await assert.rejects(()=>pending,/SOURCE_BYTE_BUDGET/);idle(pool);
});
test('cancellation drops late values and returns every I/O reservation',async()=>{
 const pool=make(),g=gate();let canceled=false,consumed=false;const q=pool.open({},()=>{if(canceled)throw Error('canceled');});
 const pending=q.read(async()=>{await g.promise;return'late';},{consume:()=>{consumed=true;}});canceled=true;g.release();
 await assert.rejects(()=>pending,/canceled/);assert.equal(consumed,false);idle(pool);
});
test('concurrent decode stages share a byte pool and are released on callback failure',async()=>{
 const pool=make({decodeBytes:130000}),a=pool.open(),b=pool.open(),g=gate();
 const pending=a.withValue('[]',async()=>{await g.promise;throw Error('decode_failed');});
 await assert.rejects(()=>b.withValue('[]',()=>[]),/DECODE_BACKPRESSURE/);
 g.release();await assert.rejects(()=>pending,/decode_failed/);idle(pool);
});

test('retained admission is shared, latched, and restored by idempotent release',()=>{
 const pool=make({retainedBytes:100}),a=pool.open({maxRetainedBytes:80}),b=pool.open();
 const lease=a.reserveRetained(70,'graph');assert.equal(a.inspect().retainedByCategory.graph,70);
 assert.throws(()=>b.reserveRetained(31,'authority'),/RETAINED_BACKPRESSURE/);
 assert.throws(b.check,/RETAINED_BACKPRESSURE/);lease.release();lease.release();a.close();b.close();
 assert.equal(pool.inspect().retainedBytes,0);assert.equal(pool.inspect().sessions,0);
 const c=pool.open({maxRetainedBytes:10});assert.throws(()=>c.reserveRetained(11),/RETAINED_BYTE_BUDGET/);c.close();
 const d=pool.open();d.reserveRetained(100);d.close();assert.equal(pool.inspect().retainedBytes,0);
});
test('expiration and invalidation revoke authority once and preserve active-operation reservations until unwind',()=>{
 let expire,revoked=0;const pool=factory({measure:pages.measure,encodedSize:pages.encodedSize,stageCost:pages.stageCost,
  schedule:callback=>{expire=callback;return 1;},cancel:()=>{}});
 const q=pool.open(),operation=q.begin();q.reserveRetained(1234,'graph');q.onClose(()=>revoked++);
 expire();assert.equal(revoked,1);assert.throws(q.check,/CLOSED/);assert.equal(pool.inspect().retainedBytes,1234);
 assert.equal(pool.inspect().sessions,1);pool.closeAll();q.close();assert.equal(revoked,1);
 operation.release();operation.release();assert.equal(pool.inspect().retainedBytes,0);assert.equal(pool.inspect().sessions,0);
});
test('overlapping validation scopes release their own estimates without releasing the retained authority',()=>{
 const pool=make(),q=pool.open();q.reserveRetained(100,'authority');const a=q.scope(),b=q.scope();
 a.reserveRetained(200,'validation');b.reserveRetained(300,'validation');assert.equal(pool.inspect().retainedBytes,600);
 a.close();assert.equal(pool.inspect().retainedBytes,400);assert.throws(()=>a.retain({}),/SCOPE_CLOSED/);
 q.close();assert.equal(pool.inspect().retainedBytes,400);b.close();assert.equal(pool.inspect().retainedBytes,0);
});
test('session limits reject before work and closing a session permits a fresh operation',()=>{
 const pool=make({sessions:1}),q=pool.open();assert.throws(()=>pool.open(),/SESSION_BACKPRESSURE/);
 q.close();const next=pool.open();next.close();assert.equal(pool.inspect().sessions,0);
});
test('retained estimates measure UTF-16 and structure before allocation callbacks',()=>{
 const pool=make(),q=pool.open({maxRetainedBytes:10});let allocated=false;
 assert.throws(()=>{q.retain({values:Array(100).fill('가🙂')},'graph');allocated=true;},/RETAINED_/);
 assert.equal(allocated,false);q.close();assert.equal(pool.inspect().retainedBytes,0);
});
