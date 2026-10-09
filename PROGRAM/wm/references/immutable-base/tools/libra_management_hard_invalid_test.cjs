'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'src/parts', name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `source seam exists: ${start}`);
  return source.slice(from, to);
}
const guardSource = read('02g-analysis-contracts-result-guard.js');
const guard = guardSource.slice(guardSource.indexOf('    const AnalysisResultGuard ='));
const quarantine = section(read('09b-archive-integrity.js'), '    const QuarantineManager =', '\n    try {');
function loadManager() {
  const context = vm.createContext({
    safeClone: clone,
    truncateForLLM: (text, limit) => String(text).slice(0, limit),
    normalizeLegacyMemoryTurnAnchor: value => Number(value) || 0,
    recordRuntimeDebug() {},
    LibraLoreConsolidator: { unpack: value => value },
    CanonicalPacketContract: { inspect: () => ({ valid: true }) }
  });
  vm.runInContext(`${guard}\n${quarantine}\nglobalThis.manager = QuarantineManager;`, context);
  return context.manager;
}
const flags = ['schemaInvalid', 'schema_invalid', 'wrongJsonShape', 'wrong_json_shape', 'invalid', 'partial', 'truncated'];
const checks = [];
async function check(name, run) {
  try { await run(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); process.exitCode = 1; }
}
(async () => {
  for (const branch of ['full', 'slim', 'minimal']) {
    for (const flag of flags) {
      await check(`${branch} compaction preserves and rejects ${flag}`, () => {
        const manager = loadManager(), lore = [];
        const result = { success: true, entities: [{ name: 'Fixture' }], [flag]: true };
        if (branch === 'slim') result.canonicalPacket = { padding: 'x'.repeat(81000) };
        if (branch === 'minimal') result.entityExtraction = { padding: 'x'.repeat(81000) };
        const appended = manager.append(lore, result, { domain: 'entity', scopeKey: 'scope-a' });
        const stored = JSON.parse(lore[0].content).entries[0];
        if (branch === 'slim') assert(!('canonicalPacket' in stored.payload), 'slim branch exercised');
        if (branch === 'minimal') assert(!('entityExtraction' in stored.payload), 'minimal branch exercised');
        assert.equal(stored.payload[flag], true, 'hard-invalid flag must survive serialization');
        const restored = loadManager().prepareAcceptedPayload(clone(lore), appended.entry.id);
        assert.equal(restored.ok, false, 'hard-invalid payload must not become trusted manual');
        assert.equal(restored.reason, 'guard_blocked');
      });
    }
  }
  for (const flag of flags) {
    await check(`old stored payload rejects ${flag}`, () => {
      const manager = loadManager(), lore = [];
      manager.append(lore, { success: true, entities: [{ name: 'Fixture' }] });
      const data = JSON.parse(lore[0].content); data.entries[0].payload[flag] = true;
      lore[0].content = JSON.stringify(data);
      assert.equal(manager.prepareAcceptedPayload(lore, data.entries[0].id).ok, false);
    });
  }
  for (const reason of ['schema_invalid', 'partial_or_invalid_result', 'canonical_packet_invalid:missing_core_axes']) {
    await check(`old compacted payload preserves guard rejection ${reason}`, () => {
      const manager = loadManager(), lore = [];
      const { entry } = manager.append(lore, { success: true, entities: [{ name: 'Fixture' }] }, { guard: { allowed: false, reason } });
      assert.equal(manager.prepareAcceptedPayload(lore, entry.id).ok, false, 'historic hard-invalid guard cannot be overridden after flags were lost');
    });
  }
  await check('valid payload still prepares and status actions preserve payload', () => {
    const manager = loadManager(), lore = [];
    const { entry } = manager.append(lore, { success: true, entities: [{ name: 'Fixture' }] });
    assert.equal(manager.prepareAcceptedPayload(lore, entry.id).ok, true);
    for (const status of ['ignored', 'resolved']) {
      assert.equal(manager.markStatus(lore, entry.id, status).changed, true);
      assert.equal(manager.getEntry(lore, entry.id).payload.entities[0].name, 'Fixture');
    }
    assert.equal(manager.markStatus(lore, 'missing', 'accepted').changed, false);
  });
  const coreSource = section(read('15-gui-and-exports.js'), 'const ManagementReviewCore =', '\nconst LMAI_GUI =');
  for (const applied of [[], ['entity:Fixture']]) {
    await check(`synchronous acceptance ${applied.length ? 'prepares applied payload' : 'rejects zero applied payload'}`, () => {
      const effects = [];
      const frame = callback => callback();
      const context = vm.createContext({
        safeClone: clone, getActiveManagedRuntimeScopeKey: () => 'scope', getChatRuntimeScopeKey: () => 'scope',
        QuarantineManager: { withTemporaryState: frame, list: () => [], prepareAcceptedPayload: () => ({ ok: true, entry: { id: 'q' }, payload: { entities: [{ name: 'Fixture' }] } }), markStatus: () => { effects.push('accepted'); return { changed: true }; } },
        IntegrityScanner: { withTemporaryState: frame, listFindings: () => [] },
        TimeEngine: { withTemporaryState: frame, loadState() {} }, EntityCandidateCore: { withTemporaryState: frame },
        LibraLoreConsolidator: { withRawManagementRead: frame },
        EntityManager: { withTemporaryState: frame, rebuildCache() {}, saveToLorebookSync() { effects.push('save-entity'); } },
        HierarchicalWorldManager: { withTemporaryState: frame, loadWorldGraph() {}, saveWorldGraphUnsafe() { effects.push('save-world'); } },
        EntityAwareProcessor: { applyExtractionsSync() { return { applied, blocked: false }; } },
        MemoryEngine: { CONFIG: {} }, recordSuppressedRuntimeError() {}
      });
      vm.runInContext(`${read('14z-health-recovery-policy.js')}\n${coreSource}\nglobalThis.prepare = ManagementReviewCore.prepare;`, context);
      const run = () => context.prepare([], {action:'quarantine-accept',id:'q',context:{runtimeScopeKey:'scope',char:{id:'c'},chat:{id:'chat'}}});
      if (applied.length) {
        assert.equal(run().changed, true);
        assert.deepEqual(effects, ['save-entity', 'save-world', 'accepted']);
      } else {
        assert.throws(run, /no_changes_applied/);
        assert.deepEqual(effects, [], 'no acceptance or prepared persistence payload after zero application');
      }
    });
  }
  console.log(JSON.stringify({ ok: checks.every(row => row.ok), passed: checks.filter(row => row.ok).length, failed: checks.filter(row => !row.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
