'use strict';
const path = require('node:path'), assert = require('node:assert/strict'), fs = require('node:fs');
process.env.WM_AUDIT_ROOT = path.resolve(__dirname, '..');
const {make} = require('../../fixes/wm-post-response-fixes/capture-boundary-probe.cjs');
(async () => {
 const r = await make(), origin = await r.before(), counts = {reads: 0, writes: 0, readBytes: 0, writeBytes: 0};
 const get = r.storage.getItem, set = r.storage.setItem;
 r.storage.getItem = async(...a) => {const v=await get(...a); counts.reads++; counts.readBytes += v == null ? 0 : Buffer.byteLength(String(v)); return v;};
 r.storage.setItem = async(k,v) => {counts.writes++; counts.writeBytes += Buffer.byteLength(String(v)); return await set(k,v);};
 for(let i=0; i<10; i++) assert((await r.audit.ledger.appendObserved({origin, recordId: 'cost-'+i, assistantText: 'Raw cost fixture '+i+'.'})).ok);
 assert.equal(r.state.calls.length,0);
 if(process.env.WM_LOCK_OUT) fs.writeFileSync(process.env.WM_LOCK_OUT,JSON.stringify(counts,null,2)+'\n');
 console.log(JSON.stringify(counts));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
