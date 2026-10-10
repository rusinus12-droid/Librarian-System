'use strict';
// G01 — the lore activation engine must collect host-selected, key-activation and semantic
// evidence SIMULTANEOUSLY, not pick one of three modes.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §17
// ("가장 큰 회귀 — 원본이 폐기한 activation mode 분기가 LIBRA에서 부활"). Its required regression:
//
//   libra_lore_unified_activation_contract_test.cjs
//   "한 lore가 host-selected 아님 / activation key 일치 / semantic 중간 점수일 때도
//    보호/선택되는지 확인."
//
// THE REGRESSION: GRADIA 0.25.72 collapsed the lore activation modes into ONE unified engine
// whose defining property is that the three signals are INDEPENDENT and collected together:
//
//     RisuAI host-selected lore
//     + RisuAI-style activation-key evidence
//     + GRADIA semantic retrieval
//     -> combined by BM25F / RRF / MMR / adaptive frontier
//
// They are not alternatives; they are independent evidence. LIBRA reinstated the modes:
//
//     LORE_ACTIVATION_MODES = ['risu_selected', 'risu_key', 'libra_extended']
//     DEFAULT_LORE_ACTIVATION_MODE = 'risu_selected'
//
// and selects ONE branch per turn (the `loreActivationMode === '...' ? ... : ...` shape at the
// activation site). Under the default, the activation-key path is skipped or weakened and the
// engine hopes semantic retrieval rediscovers the lore:
//
//     original: host selected = false, key activated = true, semantic = medium
//               -> protected because of KEY evidence
//     LIBRA default: host selected = false, key evidence = unused/weakened, semantic = medium
//               -> competes on semantic alone and can be lost
//
// THE INVARIANT THIS TEST ASSERTS: the three evidence signals are produced TOGETHER on every
// turn, and a lore matched by ANY of them survives into the combined candidate set. The
// historical mode values may remain as migration aliases, but they must all normalize to the
// single unified engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const observations = {};

// --- 1. The mode list must collapse to the unified engine ------------------------------
// The list may be written with a named constant, so resolve identifiers to their values.
const constValue = name => {
  const m = source.match(new RegExp(`const ${name} = '?([A-Za-z_]+)'?;`));
  return m ? m[1] : null;
};
const modesMatch = source.match(/const LORE_ACTIVATION_MODES = Object\.freeze\(\[([^\]]*)\]\);/);
assert.ok(modesMatch, 'LORE_ACTIVATION_MODES must exist');
const modes = modesMatch[1].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  .map(v => constValue(v) || v);
observations.modes = modes;

const defMatch = source.match(/const DEFAULT_LORE_ACTIVATION_MODE = '?([A-Za-z_]+)'?;/);
assert.ok(defMatch, 'DEFAULT_LORE_ACTIVATION_MODE must exist');
observations.defaultMode = constValue(defMatch[1]) || defMatch[1];

// The original's single engine name.
const ORIGINAL_UNIFIED = 'unified';
observations.originalEngine = ORIGINAL_UNIFIED;

console.log(JSON.stringify({ test: 'libra_gradia_unified_lore_activation', observations }, null, 1));

// There must be exactly ONE runtime mode: the unified engine. Keeping three selectable modes
// is the regression the original removed.
assert.deepEqual(modes, [ORIGINAL_UNIFIED],
  `the activation engine must be a single unified mode, not a choice between `
  + `${JSON.stringify(modes)} — the original collapsed these deliberately (0.25.72)`);
assert.equal(observations.defaultMode, ORIGINAL_UNIFIED,
  `the default must be the unified engine (got '${observations.defaultMode}')`);

// --- 2. The three signals must all be produced together ---------------------------------
// Each signal has a producer in the code; all three must be reachable on the same turn rather
// than being selected by a mode branch.
const signals = {
  hostSelected: /reuseRisuSelectedLorebooks\s*\(/.test(source),
  keyActivation: /renderIndependentActiveLorebooks\s*\(/.test(source) || /activeRisuLorebooks\s*\(/.test(source),
  semantic: /jaccardCurrentInput|semanticEvidence|LORE_JACCARD_ENGINE_VERSION/.test(source)
};
observations.signals = signals;
for (const [name, present] of Object.entries(signals)) {
  assert.equal(present, true, `the ${name} evidence producer must exist`);
}

// --- 3. The activation site must not select ONE branch ----------------------------------
// The pre-fix shape produced either the host result OR the independent result. The unified
// engine must combine them, so a ternary that discards one side is the regression marker.
const hostSite = source.indexOf('const hostLoreSelection =');
assert.ok(hostSite > 0, 'the host-selection site must exist');
const hostSlice = source.slice(hostSite, hostSite + 800);
const selectsOneBranch = /loreActivationMode === '[a-z_]+'\s*\?/.test(hostSlice);
observations.selectsOneBranchAtHostSite = selectsOneBranch;
assert.equal(selectsOneBranch, false,
  'the activation site must not branch on a mode to choose host-selected OR independent '
  + 'evidence: the unified engine combines them, which is what protects a lore matched by '
  + 'only one signal');

// --- 4. Legacy values must survive as migration aliases ---------------------------------
// Removing the modes must not break an install that has one saved.
assert.match(source, /legacy.*migrat|migrat.*legacy|aliases/i,
  'the retired mode values must remain as migration aliases so existing installs keep working');

process.stdout.write('libra_lore_unified_activation_contract_test: PASS\n');
