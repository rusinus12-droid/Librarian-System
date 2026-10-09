'use strict';
// Measure the HAYAKU packet-authoring contract as the MODEL actually receives it.
//
// Task 4 asks whether the normal-turn packet instruction is writable by a small model and whether
// it can be omitted by accident. Both are properties of the assembled text, not of any single
// literal, so this loads the real plugin through the harness and reads the contract out of it.
//
// Reports, per profile (full / compact / critical):
//   * characters and estimated tokens of the contract block
//   * the schema envelope the contract demands (the 6 top-level objects and their key fields)
//   * how many distinct authoring rules the model must satisfy
//   * whether the contract states that a partial packet is acceptable (the anti-omission clause)
//   * whether the packet end marker and the side-write reminder are present (the completion seal)
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { fixture } = require(path.join(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));
  const rows = [];

  // The HAYAKU plugin is loaded by its own fixture; fall back to reading the artifact if the
  // harness does not expose the contract builders.
  let api = null;
  try {
    const f = await fixture({});
    api = f?.r?.api || f?.api || null;
  } catch (_) { /* handled below */ }

  const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');

  // The contract is built by pure functions over settings. Locate them and run them in a VM slice
  // so the measurement is of the REAL assembled text.
  const vm = require('node:vm');
  const start = source.indexOf('const packetRegularAuthoringRules =');
  const endMarker = 'const buildPacketRegularStaticContract =';
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0) {
    console.log(JSON.stringify({ error: 'authoring-rule block not found' }));
    return;
  }
  // Include the builder itself.
  const builderEnd = source.indexOf('const compactPacketExampleForSettings', end);
  const slice = source.slice(start, builderEnd);

  const sandbox = {
    // The helpers the block closes over. Values are the real ones where they are literals; the
    // rest are stubs only so the text assembles — every stub returns an empty string, so the
    // measured size is a LOWER BOUND, never an inflated one.
    ADULT_CONTINUITY_MEMORY_GUIDANCE: '',
    PACKET_CORE_WRITE_START: '[HAYAKU PACKET CONTRACT]',
    PACKET_CORE_WRITE_END: '[/HAYAKU PACKET CONTRACT]',
    PACKET_START: 'HAYAKU_STATE_PACKET_START',
    PACKET_END: 'HAYAKU_STATE_PACKET_END',
    HAYAKU_PACKET_SCHEMA_V2: { schema: 'hayaku.packet.v2', revision: '2' },
    packetCoreWriteSuppressed: () => false,
    packetStaticContractSettings: settings => settings || {},
    packetSchemaV2WriteInstruction: () => '<<SCHEMA INSTRUCTION — resolved separately>>',
    packetMemoryLanguageInstruction: () => '<<LANGUAGE INSTRUCTION>>',
    buildContinuityEvidenceUseInstruction: () => '<<EVIDENCE USE INSTRUCTION>>',
    packetCompletedFormatExample: () => ({}),
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${slice}\nglobalThis.__RULES__ = packetRegularAuthoringRules; globalThis.__BUILD__ = buildPacketRegularStaticContract;`, sandbox, { filename: 'hayaku-contract-slice.js' });

  const build = sandbox.__BUILD__;
  if (typeof build !== 'function') { console.log(JSON.stringify({ error: 'builder not evaluated' })); return; }

  for (const [profile, options] of [['full', {}], ['compact', { compact: true }], ['critical', { critical: true }]]) {
    const assembled = build({ memoryLanguage: 'ko' }, options);
    rows.push({
      profile,
      chars: assembled.length,
      estimatedTokens: Math.ceil(assembled.length / 4),
      mentionsPartialOk: /supported summary alone is a complete packet/i.test(assembled),
      mentionsNeverInvent: /never invent/i.test(assembled),
      mentionsEndMarker: assembled.includes('HAYAKU_STATE_PACKET_END'),
      mentionsJsonOnly: /JSON uses ASCII double-quote/i.test(assembled),
      ruleCount: assembled.split('\n').filter(line => line.trim() && !line.startsWith('<') && !line.startsWith('[')).length
    });
  }

  // The schema instruction the contract injects at author time (separately defined).
  const schemaInstructionStart = source.indexOf('packetSchemaV2WriteInstruction =');
  const schemaInstructionText = schemaInstructionStart >= 0
    ? source.slice(schemaInstructionStart, schemaInstructionStart + 2600) : '';
  const topLevelObjects = ['meta', 'entity', 'world', 'narrative', 'planner', 'importance']
    .filter(name => schemaInstructionText.includes(name));

  // The side-write seal appended to the visible-response instruction.
  const sealLine = source.match(/const buildPacketTerminalCompletionSeal[\s\S]{0,600}?\n  \};/);

  console.log(JSON.stringify({
    test: 'hayaku_packet_contract_measurement',
    profiles: rows,
    schemaEnvelope: {
      revisionLiteral: 'hayaku.packet.v2',
      topLevelObjectsNamed: topLevelObjects,
      topLevelObjectCount: topLevelObjects.length
    },
    completionSeal: {
      present: Boolean(sealLine),
      mentionsExactlyOne: /exactly one current_snapshot/i.test(sealLine ? sealLine[0] : ''),
      excerpt: sealLine ? sealLine[0].split('\n').slice(1, 4).map(l => l.trim()).join(' | ').slice(0, 320) : ''
    },
    harnessLoaded: Boolean(api)
  }, null, 1));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
