'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

assert.match(source, /const loadContinuityStateForResponse = async/);
assert.match(source, /pruneContinuityStateHeadToRefs\(stored, refs, scope\)/);
assert.match(source, /canonical_frontier_newer_than_state_head/);
assert.match(source, /last_known_non_authoritative/);
// Planner provider authority ordering was retired with embedded response drafting.
// Classic retains current canonical validation and refuses direct derived-state prose.
const beforeRequest = sliceBetween('const beforeRequest = async', 'const afterRequest = async');
assert.match(beforeRequest, /authority\.compiler\.validatePacket/);
assert.doesNotMatch(beforeRequest, /buildClassicCanonicalProvenanceRescue/);
assert.doesNotMatch(beforeRequest, /narrativeForRoute\s*=\s*await __libraCompletionGetNarrative/);
assert.doesNotMatch(beforeRequest, /runTurnPlanner\(|callSgaProvider\(/);

assert.match(source, /const UNIFIED_CLASSIC_HEADER/);
assert.doesNotMatch(source, /const renderClassicBlock\s*=/);

const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
(async()=>{
 const f=await fixture();
 try {
  assert.equal((await f.run()).completed,1);
  const ref=f.getManifest().memories['1'];
  const canonicalBefore=f.r.values.get(ref.key);
  const headRecord=f.getRecords('libra.continuity_state.v2')[0];
  const headBefore=f.r.values.get(headRecord.key);
  const calls=f.control.calls.length;
  const packet=await actualClassicPacket(f,'민아 지호 신뢰 은빛 열쇠',f.getManifest().scopeKey);
  assert.ok(packet.actualClassic.deliveredRows.some(row=>row.memoryId===ref.memoryId&&row.revision===ref.revision));
  assert.doesNotMatch(packet.actualClassic.block,/CURRENT STATE HEAD|continuity_state_prompt/);
  assert.equal(f.control.calls.length,calls,'Classic request performs no extra response provider dispatch');
  assert.equal(f.r.values.get(ref.key),canonicalBefore,'Classic must not mutate Canonical Memory');
  assert.equal(f.r.values.get(headRecord.key),headBefore,'Classic must not mutate State Head');
 } finally {await f.r.cleanup();}
 process.stdout.write('libra_classic_planner_authority_contract_test: PASS\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
