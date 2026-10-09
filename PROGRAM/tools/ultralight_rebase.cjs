'use strict';
// Ultralight Stage A/B — derive the rebased preservation inventory from the CURRENT
// modern tree (not from the handoff's 0.3.60 baseline), and record the byte baseline.
//
// Why this exists: the handoff package (`reference/Librarian-System_ULTRALIGHT_HANDOFF_v1.1_20260917`)
// ships `design/evidence/FEATURE_PRESERVATION.json` pinned to `0.3.60-WIP-CHECKPOINT-R01`
// (LIBRA 2.3.125). `00_START_HERE.md` requires: "If the user supplies a newer modern
// checkpoint after this package was made, compare it first and explicitly rebase the
// preservation inventory before implementation." The live tree is newer (0.3.62 /
// LIBRA 2.3.130), so the inventory must be rebased before any slimming edit.
//
// This script is READ-ONLY with respect to production code: it reads the plugin
// sources, the feature inventory, the support matrix and the handoff inventory, and
// writes only under `docs/ultralight/`.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..', '..');
const handoff = path.join(repoRoot, 'reference', 'Librarian-System_ULTRALIGHT_HANDOFF_v1.1_20260917');
const outDir = path.join(root, 'docs', 'ultralight');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(root, file).split(path.sep).join('/');

const OWNER_FILES = Object.freeze({
  libra: 'plugins/LIBRA.js',
  hayaku: 'plugins/HAYAKU_Locator_Continuity.js',
  flashback: 'plugins/Flashback_Memory.js',
  lia: 'plugins/LIA_Persona_Linker.js',
  retrace: 'plugins/RETRACE.js'
});
// The ultralight target set is exactly the three the design names.
const TARGET_OWNERS = Object.freeze(['hayaku', 'flashback', 'libra']);
const HARD_CAP = 1_000_000;
const INTERNAL_TARGET = 950_000;

const pluginHeader = file => {
  const head = fs.readFileSync(file).subarray(0, 512).toString('utf8');
  const version = head.match(/^\/\/@version\s+(\d+\.\d+\.\d+)\s*$/m);
  const name = head.match(/^\/\/@display-name\s+(.+)$/m);
  return { version: version ? version[1] : '', displayName: name ? name[1].trim() : '' };
};

// --- Stage A: rebase the preservation inventory ------------------------------
const currentInventory = readJson(path.join(root, 'docs/storage-mode-audit/feature_inventory.json'));
const supportMatrix = readJson(path.join(root, 'docs/storage-mode-audit/support_matrix.json'));
const handoffInventory = readJson(path.join(handoff, 'design/evidence/FEATURE_PRESERVATION.json'));

const handoffById = new Map(handoffInventory.features.map(f => [f.featureId, f]));
const currentIds = new Set(currentInventory.features.map(f => f.featureId));
const handoffOnly = handoffInventory.features.map(f => f.featureId).filter(id => !currentIds.has(id));
const currentOnly = currentInventory.features.map(f => f.featureId).filter(id => !handoffById.has(id));

// A status is only as strong as the current tree's own record: the inventory's
// mirrors of the support matrix are the rebased truth.
const rebased = currentInventory.features.map(feature => {
  const prior = handoffById.get(feature.featureId) || null;
  return {
    owner: feature.owner,
    featureId: feature.featureId,
    userFeature: feature.userFeature,
    entryPoints: feature.entryPoints || [],
    storageSchemas: feature.storageSchemas || [],
    storageKeys: feature.storageKeys || [],
    storageClass: feature.storageClass || '',
    localOnlyConfig: feature.localOnlyConfig === true,
    branchSensitive: feature.branchSensitive === true,
    sourceEditSensitive: feature.sourceEditSensitive === true,
    // Rebased: taken from the CURRENT tree, not from the handoff baseline.
    pluginOnlyStatus: feature.pluginOnlyStatus,
    mirrorStatus: feature.mirrorStatus,
    serverOnlyStatus: feature.serverOnlyStatus,
    tests: feature.tests || [],
    expectedSemanticResult: feature.expectedSemanticResult || '',
    // Preservation is unconditional for every inventoried modern feature.
    preservationDecision: prior?.preservationDecision || 'PRESERVE_USER_OBSERVABLE_BEHAVIOR',
    slimAcceptanceStatus: 'NOT_IMPLEMENTED_NOT_TESTED',
    rebase: {
      handoffEntryPresent: !!prior,
      handoffRecordedPluginOnly: prior?.pluginOnlyStatus || null,
      handoffRecordedMirror: prior?.mirrorStatus || null,
      handoffRecordedServerOnly: prior?.serverOnlyStatus || null,
      statusChangedByRebase: !!prior && (
        prior.pluginOnlyStatus !== feature.pluginOnlyStatus
        || prior.mirrorStatus !== feature.mirrorStatus
        || prior.serverOnlyStatus !== feature.serverOnlyStatus
      )
    }
  };
});

// --- Stage B: byte baseline --------------------------------------------------
const baseline = {};
for (const [owner, file] of Object.entries(OWNER_FILES)) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) continue;
  const bytes = fs.statSync(abs).size;
  baseline[owner] = {
    file,
    bytes,
    sha256: sha256(abs),
    ...pluginHeader(abs),
    isTarget: TARGET_OWNERS.includes(owner),
    hardCapExceededBy: Math.max(0, bytes - HARD_CAP),
    reductionNeededToHardCap: Math.max(0, bytes - HARD_CAP),
    reductionPercentToHardCap: Number(((Math.max(0, bytes - HARD_CAP) / bytes) * 100).toFixed(2))
  };
}

const packageVersion = fs.readFileSync(path.join(root, 'VERSION.txt'), 'utf8').trim();
const generatedAt = new Date().toISOString();

const inventoryOut = {
  schema: 'librarian.ultralight.preservation.rebased.v1',
  generatedAt,
  packageVersion,
  rebasedFrom: {
    handoffInventory: rel(path.join(handoff, 'design/evidence/FEATURE_PRESERVATION.json')),
    handoffBaseline: handoffInventory.reference_baseline,
    handoffCounts: handoffInventory.counts,
    handoffNotice: handoffInventory.notice
  },
  rebaseNotes: [
    'Authority is the CURRENT modern tree, per 00_START_HERE.md ("compare it first and explicitly rebase the preservation inventory before implementation").',
    'Statuses are copied from the current feature_inventory.json / support_matrix.json; no status is upgraded on assumption.',
    'Handoff entries absent from the current tree are listed in handoffOnlyFeatureIds and must be adjudicated before implementation.',
    'Current entries with no handoff counterpart are listed in currentOnlyFeatureIds; they are NEWER than the design review and are preserved.',
    'Retired/compatibility entries do not authorize feature revival.'
  ],
  counts: {
    total: rebased.length,
    handoffTotal: handoffInventory.features.length,
    handoffOnly: handoffOnly.length,
    currentOnly: currentOnly.length,
    statusChangedByRebase: rebased.filter(r => r.rebase.statusChangedByRebase).length,
    targetOwners: TARGET_OWNERS.length
  },
  handoffOnlyFeatureIds: handoffOnly,
  currentOnlyFeatureIds: currentOnly,
  features: rebased
};

const baselineOut = {
  schema: 'librarian.ultralight.size.baseline.v1',
  generatedAt,
  packageVersion,
  targetOwners: TARGET_OWNERS,
  hardCap: HARD_CAP,
  internalTarget: INTERNAL_TARGET,
  measurementRule: [
    'Uncompressed installed JS bytes only (fs.statSync().size).',
    'ZIP, gzip, .length and line counts are never a substitute.',
    'Header, code, embedded prompts, embedded SDKs and GUI HTML/CSS/JS are all included.'
  ],
  plugins: baseline,
  totals: {
    targetSetBytes: TARGET_OWNERS.reduce((sum, o) => sum + (baseline[o]?.bytes || 0), 0),
    targetSetBytesOverHardCap: TARGET_OWNERS.reduce((sum, o) => sum + (baseline[o]?.reductionNeededToHardCap || 0), 0),
    allPluginsBytes: Object.values(baseline).reduce((sum, p) => sum + p.bytes, 0)
  }
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'preservation_inventory_rebased.json'), `${JSON.stringify(inventoryOut, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'size_baseline.json'), `${JSON.stringify(baselineOut, null, 2)}\n`);

console.log(JSON.stringify({
  rebasedInventory: rel(path.join(outDir, 'preservation_inventory_rebased.json')),
  sizeBaseline: rel(path.join(outDir, 'size_baseline.json')),
  counts: inventoryOut.counts,
  sizes: Object.fromEntries(Object.entries(baseline).map(([o, p]) => [o, p.bytes])),
  targetSetBytes: baselineOut.totals.targetSetBytes
}, null, 1));
