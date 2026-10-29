'use strict';
// 2026-10-29: the model wrote the packet with bare markers (as instructed) and the host
// never called the display handler, so the packet stayed visible. afterRequest now
// restores the hidden HTML-comment form while keeping the markers the scanner reads.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const start=source.indexOf('  const concealBarePacketMarkers = value => {'),end=source.indexOf('  const stripHayakuDisplayArtifacts = value => {',start);
assert(start>0&&end>start,'real conceal helper');
const conceal=vm.runInNewContext(`const PACKET_START='HAYAKU_STATE_PACKET_START';${source.slice(start,end)};concealBarePacketMarkers`);
const packet='HAYAKU_STATE_PACKET_START\n{"meta":{"schema":"hayaku_packet_v1"},"entity":{}}\nHAYAKU_STATE_PACKET_END';

test('a complete bare packet becomes an HTML comment with both markers intact',()=>{
 const out=conceal(`본문입니다.\n\n${packet}`);
 assert.equal(out,`본문입니다.\n\n<!-- ${packet} -->`);
 assert.ok(out.indexOf('HAYAKU_STATE_PACKET_START')<out.indexOf('HAYAKU_STATE_PACKET_END'));
});
test('already hidden, incomplete, comment-breaking and packet-free content is unchanged',()=>{
 for(const value of [`<!-- ${packet} -->`,'본문 HAYAKU_STATE_PACKET_START {"a":1}',
   packet.replace('{"meta"','{"note":"-->","meta"'),'평범한 본문',42])assert.equal(conceal(value),value);
});
test('the afterRequest return path applies it after the in-band repair',()=>{
 assert.match(source,/const repairedContent = concealBarePacketMarkers\(await repairCurrentPacketInsideAfterRequest\(content, requestType\)\);/);
});
