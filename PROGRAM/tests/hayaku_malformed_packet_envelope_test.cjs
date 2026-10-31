'use strict';
// 2026-10-31: the model wrote the packet JSON without markers inside a memory-suite
// wrapper (<LIBRA_CLASSIC_RECALL>), so it was neither accepted nor hidden. The envelope
// is now restored before inspection and display, and memory-suite tags are never
// chosen as the preset's output wrapper.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const start = source.indexOf('  const MEMORY_SUITE_ECHO_WRAPPER_RE ='), end = source.indexOf('  const stripHayakuDisplayArtifacts = value => {', start);
assert(start > 0 && end > start, 'real restore helper');
const restore = vm.runInNewContext(`const PACKET_START='HAYAKU_STATE_PACKET_START';const PACKET_END='HAYAKU_STATE_PACKET_END';
const MEMORY_SUITE_WRAPPER_TAG_RE=/^(?:LIBRA|HAYAKU|FLASHBACK|GRADIA|RETRACE|LIA|LBDATA)(?:[_.:-][A-Za-z0-9_.:-]*)?$/i;
${source.slice(start, end)};restoreMalformedPacketEnvelope`);
const lineage = { request_nonce: 'n1', logical_turn_id: 't1' };
const json = '{"meta":{"schema":"hayaku_packet_v1","packet_type":"current_snapshot","summary_memory":{"summary":"The archive door is open."}},"entity":{},"world":{},"narrative":{},"planner":{},"importance":{"overall":0.2,"reason":[]}}';
const parseEnvelope = out => {
  const m = /<!-- HAYAKU_STATE_PACKET_START\n([\s\S]*?)\nHAYAKU_STATE_PACKET_END -->/.exec(out);
  assert.ok(m, 'canonical envelope present');
  return JSON.parse(m[1]);
};

test('markerless packet inside a LIBRA wrapper is rewrapped, wrapper removed, lineage filled', () => {
  const out = restore(`Visible prose.\n\n<LIBRA_CLASSIC_RECALL>\n${json}\n</LIBRA_CLASSIC_RECALL>`, lineage);
  assert.ok(!out.includes('LIBRA_CLASSIC_RECALL'));
  assert.ok(out.startsWith('Visible prose.'));
  assert.deepEqual(parseEnvelope(out).meta.lineage, lineage);
});
test('a single start marker without end marker is repaired', () => {
  const out = restore(`Prose.\nHAYAKU_STATE_PACKET_START\n${json}`, null);
  assert.equal(parseEnvelope(out).meta.schema, 'hayaku_packet_v1');
  assert.equal(out.split('HAYAKU_STATE_PACKET_START').length, 2);
});
test('markers on one comment line around JSON are kept as is', () => {
  const ok = `Prose.\n\n<!-- HAYAKU_STATE_PACKET_START\n${json}\nHAYAKU_STATE_PACKET_END -->`;
  assert.equal(restore(ok, lineage), ok);
});
test('existing lineage is not overwritten', () => {
  const other = json.replace('"packet_type":"current_snapshot"', '"packet_type":"current_snapshot","lineage":{"request_nonce":"other"}');
  assert.equal(parseEnvelope(restore(`P.\n${other}`, lineage)).meta.lineage.request_nonce, 'other');
});
test('empty memory-suite echo wrappers are removed; unrelated JSON and non-suite wrappers stay', () => {
  assert.equal(restore('Prose.\n\n<LIBRA_CLASSIC_RECALL>\n \n</LIBRA_CLASSIC_RECALL>'), 'Prose.\n\n');
  const plain = 'Data {"meta":{"schema":"other"}}';
  assert.equal(restore(plain), plain);
  const out = restore(`<Answer>Prose.\n${json}\n</Answer>`);
  assert.ok(out.startsWith('<Answer>') && out.trimEnd().endsWith('</Answer>'));
  parseEnvelope(out);
});
test('broken JSON is left untouched', () => {
  const broken = 'P.\n{"meta":{"schema":"hayaku_packet_v1",}}';
  assert.equal(restore(broken), broken);
});
test('memory-suite tags are excluded from output wrapper detection and wired into repair/display', () => {
  assert.match(source, /MEMORY_SUITE_WRAPPER_TAG_RE\.test\(tag\)/);
  assert.match(source, /source = restoreMalformedPacketEnvelope\(source, pending \?/);
  assert.match(source, /value = restoreMalformedPacketEnvelope\(value\);/);
});
