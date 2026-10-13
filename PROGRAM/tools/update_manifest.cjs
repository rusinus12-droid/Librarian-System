'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { maskSource } = require('./lib/ultralight_scan.cjs');

const root = path.resolve(process.env.LIBRARIAN_PROGRAM_ROOT || path.resolve(__dirname, '..'));
const manifestPath = path.join(root, 'program-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const readSource = relativePath => fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
const extractVersion = (source, pattern, label) => {
  const match = String(source || '').match(pattern);
  const version = String(match?.[1] || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`manifest_version_missing:${label}`);
  return version;
};
// Readable declarations are authoritative. Release identifiers may be renamed, so
// the builder supplies its readable root and SHA bindings captured before staging.
// Accept complete pairs only when captured bytes, versions, and real staged string
// literals agree. Never infer a fingerprint from a stale value table or comments.
const sourceMasks = new Map();
const masked = source => {
  if (!sourceMasks.has(source)) sourceMasks.set(source, maskSource(source));
  return sourceMasks.get(source);
};
const escapedPattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const extractStringConstant = (source, constantName, label, { optional = false } = {}) => {
  const text = String(source || '');
  const declarations = [...masked(text).matchAll(new RegExp(`\\bconst\\s+${escapedPattern(constantName)}\\s*=`, 'g'))];
  if (declarations.length > 1) throw new Error(`manifest_constant_ambiguous:${label}`);
  if (declarations.length) {
    const declaration = declarations[0];
    const match = text.slice(declaration.index + declaration[0].length).match(/^\s*(['"])([^'"]+)\1\s*;/);
    const value = String(match?.[2] || '').trim();
    if (value) return value;
    throw new Error(`manifest_constant_missing:${label}`);
  }
  if (new RegExp(`\\b(?:let|var)\\s+${escapedPattern(constantName)}\\b`).test(masked(text))) throw new Error(`manifest_constant_missing:${label}`);
  if (optional) return null;
  throw new Error(`manifest_constant_missing:${label}`);
};
const sourceLiterals = new Map();
let literalTokenizer = null;
const hasStringLiteral = (source, value) => {
  // Keep ordinary readable/model-only generation independent of cached build packages.
  if (!source.includes(value)) return false;
  if (!sourceLiterals.has(source)) {
    literalTokenizer ||= require('./build_plugins.cjs').resolveAcorn();
    if (!literalTokenizer?.tokenizer) throw new Error('manifest_declaration_parser_unavailable');
    const literals = new Set();
    try {
      const tokenizer = literalTokenizer.tokenizer(source, { ecmaVersion: 'latest', allowHashBang: true });
      for (let token = tokenizer.getToken(); token.type.label !== 'eof'; token = tokenizer.getToken()) {
        if (token.type.label === 'string') literals.add(token.value);
      }
    } catch (_) { throw new Error('manifest_declaration_literals_invalid'); }
    sourceLiterals.set(source, literals);
  }
  return sourceLiterals.get(source).has(value);
};
const pluginFiles = Object.freeze({
  flashback: 'plugins/Flashback_Memory.js', hayaku: 'plugins/HAYAKU_Locator_Continuity.js',
  libra: 'plugins/LIBRA.js', lia: 'plugins/LIA_Persona_Linker.js', retrace: 'plugins/RETRACE.js', gradia: 'plugins/GRADIA.js'
});
const pluginSources = Object.freeze(Object.fromEntries(Object.entries(pluginFiles).map(([owner, file]) => [owner, readSource(file)])));
const pluginVersions = Object.freeze(Object.fromEntries(Object.entries(pluginSources).map(([owner, source]) => [
  owner,
  extractVersion(source.slice(0, 512), /^\/\/@version\s+(\d+\.\d+\.\d+)\s*$/m, `plugin:${owner}`)
])));
const storageSdkVersion = extractVersion(readSource('sdk/MemorySuiteStorageClient.source.js'), /^\/\* LIBRARIAN SYSTEM STORAGE SDK v(\d+\.\d+\.\d+)/m, 'storage-sdk');
const libraStorageSdkVersion = extractVersion(readSource('sdk/MemorySuiteStorageClient.libra.source.js'), /^\/\* LIBRARIAN SYSTEM STORAGE SDK v(\d+\.\d+\.\d+)/m, 'libra-storage-sdk');
if (storageSdkVersion !== libraStorageSdkVersion) throw new Error('manifest_storage_sdk_variant_version_mismatch');
const computeSdkVersion = extractVersion(readSource('sdk/MemorySuiteComputeClient.source.js'), /^\/\* LIBRARIAN SYSTEM COMPUTE SDK v(\d+\.\d+\.\d+)/m, 'compute-sdk');
const canonicalDeclarations = new Map();
const resolveComputePilot = (owner, operationName, fingerprintName, { optional = false } = {}) => {
  const staged = pluginSources[owner];
  const operation = extractStringConstant(staged, operationName, `${owner}-operation`, { optional: true });
  const fingerprint = extractStringConstant(staged, fingerprintName, `${owner}-fingerprint`, { optional: true });
  if (operation || fingerprint) {
    if (!operation) throw new Error(`manifest_constant_missing:${owner}-operation`);
    if (!fingerprint) throw new Error(`manifest_constant_missing:${owner}-fingerprint`);
    return Object.freeze({ operation, fingerprint });
  }
  const declarationRoot = process.env.LIBRARIAN_MANIFEST_DECLARATION_ROOT;
  // This retired operation is a rejection marker only, never a source of metadata.
  const staleFlashback = optional && hasStringLiteral(staged, 'flashback.hash-embedding-batch.v1');
  if (optional && !staleFlashback) return null;
  if (!declarationRoot) {
    if (optional && !staleFlashback) return null;
    throw new Error(`manifest_declaration_root_required:${owner}`);
  }
  if (!canonicalDeclarations.has(owner)) {
    let bindings;
    try { bindings = JSON.parse(process.env.LIBRARIAN_MANIFEST_DECLARATION_BINDINGS || ''); }
    catch (_) { throw new Error(`manifest_declaration_binding_invalid:${owner}`); }
    const expectedSha = bindings?.[pluginFiles[owner]];
    if (typeof expectedSha !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error(`manifest_declaration_binding_invalid:${owner}`);
    let bytes;
    try {
      const file = path.join(path.resolve(declarationRoot), ...pluginFiles[owner].split('/'));
      if (!fs.lstatSync(file).isFile()) throw new Error('not_regular');
      bytes = fs.readFileSync(file);
    } catch (_) { throw new Error(`manifest_declaration_source_unavailable:${owner}`); }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedSha) throw new Error(`manifest_declaration_source_changed:${owner}`);
    const source = bytes.toString('utf8');
    const version = extractVersion(source.slice(0, 512), /^\/\/@version\s+(\d+\.\d+\.\d+)\s*$/m, `declaration:${owner}`);
    if (version !== pluginVersions[owner]) throw new Error(`manifest_declaration_version_mismatch:${owner}`);
    canonicalDeclarations.set(owner, Object.freeze({
      operation: extractStringConstant(source, operationName, `${owner}-operation`, { optional }),
      fingerprint: extractStringConstant(source, fingerprintName, `${owner}-fingerprint`, { optional })
    }));
  }
  const canonical = canonicalDeclarations.get(owner);
  if (!canonical.operation && !canonical.fingerprint && optional) {
    if (staleFlashback) throw new Error(`manifest_declaration_absence_mismatch:${owner}`);
    return null;
  }
  if (!canonical.operation) throw new Error(`manifest_constant_missing:${owner}-operation`);
  if (!canonical.fingerprint) throw new Error(`manifest_constant_missing:${owner}-fingerprint`);
  if (!hasStringLiteral(staged, canonical.operation)) throw new Error(`manifest_release_literal_missing:${owner}-operation`);
  if (!hasStringLiteral(staged, canonical.fingerprint)) throw new Error(`manifest_release_literal_missing:${owner}-fingerprint`);
  return canonical;
};
const computePilots = Object.freeze({
  flashback: resolveComputePilot('flashback', 'FLASHBACK_HASH_COMPUTE_OPERATION', 'FLASHBACK_HASH_COMPUTE_FINGERPRINT', { optional: true }),
  lia: resolveComputePilot('lia', 'LIA_WORLD_LORE_COMPUTE_OPERATION', 'LIA_WORLD_LORE_COMPUTE_FINGERPRINT'),
  libra: resolveComputePilot('libra', 'LIBRA_RECALL_BM25F_COMPUTE_OPERATION', 'LIBRA_RECALL_BM25F_COMPUTE_FINGERPRINT'),
  hayaku: resolveComputePilot('hayaku', 'HAYAKU_SPARSE_RRF_COMPUTE_OPERATION', 'HAYAKU_SPARSE_RRF_COMPUTE_FINGERPRINT')
});

const MANIFEST_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', 'dist']);
// A linked worktree has `.git` as a FILE (a `gitdir:` pointer), not a directory. The tracked-file filter
// below would normally drop it, but that filter has no opinion when Git is unavailable or when the
// generator runs somewhere `ls-files` returns nothing — then the pointer was recorded in the manifest.
// Exclude the name in both shapes.
const MANIFEST_EXCLUDED_FILES = new Set(['.git']);
// OS metadata (macOS .DS_Store, Windows Thumbs.db/desktop.ini) is written by the file manager into
// any directory a user has browsed. It is gitignored, never tracked, and never copied into a release
// — the artifact builder is an allowlist (shouldCopySourceProgram / shouldCopyUpdater), so it cannot
// reach a release either way. Listing it here made the manifest depend on whether Finder had been
// opened: the file changes identity while a session runs, and program_data_layout_test then failed
// with "Manifest SHA mismatch: .DS_Store" for a reason unrelated to the release. The test already
// filters exactly these names out of its own listings; the manifest must not record them at all.
const MANIFEST_OS_METADATA_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
// macOS and some sync clients write a COPY of a file as "<name> 2.<ext>" (then " 3", and so on) when a
// save collides with an open handle. Those copies are not tracked in Git and are never part of a release
// artifact, and a fresh `git archive HEAD` copy failed program_data_layout_test because the manifest had
// recorded files that only exist in this working tree.
//
// The exclusion is NOT decided by the name alone. A name-only rule also drops a legitimate release asset
// such as `docs/Chapter 2.md` while keeping `docs/Protocol v2.md`, so the manifest would disagree with the
// source distribution's allowlist (reviewer REL-I1). A copy is excluded only when BOTH hold:
//
//   * the name has the copy shape — SPACE + digits immediately before the extension, and
//   * the file it would be a copy OF exists — the " N" removed, and by default byte-identical
//
// The byte check is what makes this safe on a working tree that legitimately contains such a name: an
// authored file with no counterpart is recorded, a genuine collision copy is not. Neither check needs Git,
// because this generator must also run inside a release directory that has no repository.
const MANIFEST_COPY_SUFFIX_PATTERN = / \d+\.[A-Za-z0-9]+$/;
// Some collision copies are edited after they are made, so the bytes differ from the original. Requiring
// identical bytes would then record the stray copy instead. The shape plus a same-named original is the
// deciding pair; set this to false to require byte equality as well.
const MANIFEST_COPY_REQUIRES_IDENTICAL_BYTES = true;
// ── the repository-level check ───────────────────────────────────────────────────────────────────────
// The shape + original rules above still could not see a STALE collision copy: one made days earlier and
// then left behind while its original kept being edited, so the bytes differ and the copy is recorded.
// Two such copies (and one review note dropped inside PROGRAM) reached a COMMITTED manifest, and a fresh
// `git archive HEAD` copy then failed program_data_layout_test with `Manifest file missing: <path>` —
// which blocks the distribution, because the staging tree is built from the repository content and cannot
// contain working-tree-only files. Measured: the committed manifest listed 1,206 entries while a clean
// checkout regenerated 1,203.
//
// The generator cannot decide this alone: it must also run inside a release directory that has no
// repository (contract §2), so it cannot ask Git what is tracked. What it CAN do is ask Git only when it
// is actually inside a repository, which is exactly the case where the answer is meaningful. The check
// disables itself in the two situations where it would be wrong or harmful:
//
//   * no repository (a release directory, or a staged copy outside the work tree) -> `git` fails, skip;
//   * a staged copy INSIDE the work tree -> `ls-files` run from that subdirectory returns nothing
//     (measured: 0 entries), and treating that as "nothing is tracked" would empty the release manifest.
//     An empty result is therefore read as "not the repository root context" and skipped too.
//
// When the check does run and a file is not tracked, the file is left out of the manifest. That is the
// release-relevant answer: an untracked file is not part of the distribution input.
const manifestTrackedFiles = (() => {
  if(process.env.LIBRARIAN_NO_GIT==='1')return null;
  try {
    const run = require('node:child_process').spawnSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    if (run.status !== 0) return null;                       // not a repository: no opinion
    const rows = String(run.stdout || '').split('\0').filter(Boolean);
    if (!rows.length) return null;                           // subdirectory of a repository: no opinion
    return new Set(rows.map(row => row.split('/').join('/')));
  } catch (_) {
    return null;                                             // git unavailable: no opinion
  }
})();
const isManifestUntrackedInRepository = relative => (
  manifestTrackedFiles !== null && !manifestTrackedFiles.has(relative.split(path.sep).join('/'))
);
const isManifestEphemeralFile = name => (
  MANIFEST_OS_METADATA_FILES.has(name)
  || /^\.test-output-/i.test(name)
  || /^FULL_TEST/i.test(name)
  || /\.pyc$/i.test(name)
  || /\.(?:tmp|log)$/i.test(name)
);
// Path-aware: a copy-shaped name is excluded only when its original is actually present.
const isManifestCopyOfExistingFile = full => {
  const name = path.basename(full);
  if (!MANIFEST_COPY_SUFFIX_PATTERN.test(name)) return false;
  const original = path.join(path.dirname(full), name.replace(/ \d+(\.[A-Za-z0-9]+)$/, '$1'));
  let originalStat;
  try { originalStat = fs.statSync(original); } catch (_) { return false; }   // no original: keep it
  if (!originalStat.isFile()) return false;
  if (!MANIFEST_COPY_REQUIRES_IDENTICAL_BYTES) return true;
  try {
    const copyBytes = fs.readFileSync(full);
    const originalBytes = fs.readFileSync(original);
    return copyBytes.equals(originalBytes);
  } catch (_) {
    return false;   // unreadable on either side: keep the file rather than guess
  }
};

const listFiles = current => {
  const rows = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`manifest_symbolic_link_is_not_allowed:${path.relative(root, full)}`);
    if (entry.isDirectory()) {
      if (!MANIFEST_EXCLUDED_DIRECTORIES.has(entry.name)) rows.push(...listFiles(full));
    } else if (entry.isFile()
      && !MANIFEST_EXCLUDED_FILES.has(entry.name)
      && path.resolve(full) !== path.resolve(manifestPath)
      && !isManifestEphemeralFile(entry.name)
      && !isManifestCopyOfExistingFile(full)
      && !isManifestUntrackedInRepository(path.relative(root, full))
      && !path.relative(root,full).split(path.sep).includes('dist')) rows.push(full);
  }
  return rows;
};

if(process.env.LIBRARIAN_PACKAGE_QUALIFICATION==='publication_gate')delete manifest.qualification;
if(process.env.LIBRARIAN_PACKAGE_QUALIFICATION==='offline_candidate')manifest.qualification={
  status:'offline_candidate',implementation:'provisional_feature_first',validation:'not_inferred_from_manifest_generation',
  deepRegression:'DEFERRED',independentReview:'DEFERRED',publicationGate:'NOT_RUN',actualHost:'NOT_RUN',
  actualHostActivation:false,qualifiedActualProfiles:[],allWriterOwnership:false,updaterEligible:false,publicationReady:false
};
manifest.productName = 'Librarian System';
manifest.legacyTechnicalIdentity = 'memory-suite';
const packageVersion = fs.readFileSync(path.join(root, 'VERSION.txt'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) throw new Error(`manifest_program_version_invalid:${packageVersion}`);
manifest.packageVersion = packageVersion;
manifest.generatedAt = new Date().toISOString();
manifest.server = {
  ...manifest.server,
  version: packageVersion,
  protocol: { major: 1, minor: 9 }
};
manifest.storageSdkVersion = storageSdkVersion;
manifest.storageSdkVariants = {
  standard: 'sdk/MemorySuiteStorageClient.source.js',
  libraControlPlanePreroute: 'sdk/MemorySuiteStorageClient.libra.source.js'
};
manifest.storageSdkBindings = require('./lib/sdk_variants.cjs').storageVariantMetadata(root);
manifest.computeProtocol = { major: 1, minor: 2 };
manifest.computeSdkVersion = computeSdkVersion;
manifest.computeSdk = 'sdk/MemorySuiteComputeClient.source.js';
manifest.distribution = {
  artifactPrefix: 'Librarian-System',
  singleCrossPlatformArchive: true,
  embeddedRuntime: false,
  cleanDataRequired: true,
  sourceDataReadOrCopied: false,
  programTopLevelAllowlist: true,
  sensitiveProgramArtifactsRejected: true,
  testsMandatory: true,
  testProfile: 'release_smoke',
  fullRegressionRunByBuilder: false,
  fullRegressionRequiredBeforePublication: true,
  postTestChecksumReverified: true,
  utf8ZipNames: true,
  unixExecutePermissions: ['*.sh', '*.command'],
  windowsRuntimeArchitectures: ['x64', 'arm64'],
  pluginInstallPath: 'PROGRAM/plugins',
  topLevelPluginsFolder: false,
  profiles: {
    release: { asset: `Librarian-System-${packageVersion}.zip`, updaterEligible: true, runtimeAllowlist: true },
    source: { asset: `Librarian-System-${packageVersion}-Source.zip`, updaterEligible: false, fullSafeSource: true }
  }
};
manifest.dataContract.programDistribution = {
  ...(manifest.dataContract.programDistribution || {}),
  risuPluginInstallFolder: 'PROGRAM/plugins',
  topLevelPluginsFolder: false,
  canonicalPluginCount: Object.keys(pluginFiles).length,
  duplicatePluginCopies: false
};
manifest.dataContract.computePlane = {
  schema: 'memory-suite.compute-plane.v1',
  pluginDefaultMode: 'local',
  modes: ['local', 'prefer_server'],
  guiModeControl: false,
  guiModeScope: 'derived_from_current_scope_storage_mode',
  storageComputeIntegratedControl: true,
  guiOwners: ['flashback', 'hayaku', 'libra', 'lia'],
  remoteOnlyMode: false,
  storageModeIndependent: false,
  scopeExecutionPolicySchema: 'memory-suite.scope-execution-policy.v1',
  storageModeToComputeMode: { plugin_only: 'local', mirror: 'prefer_server', server_only: 'prefer_server' },
  legacyShadowNormalization: 'local',
  computeModeArgumentExposed: false,
  localFallbackRequired: true,
  serverDefaultEnabled: true,
  serverDisableFlag: '--no-compute',
  workerCountConfig: 'server-config.json:computeWorkers:0_auto_or_1_to_16',
  authorizationSeparateFromStorage: true,
  automaticBootstrap: true,
  storageBootstrapRequired: false,
  userCredentialInputRequired: false,
  pluginIdentityTrustBoundary: 'loopback_official_plugin_id',
  signingKeyFile: 'DATA/config/compute-signing-key.txt',
  canonicalNamespaceWrites: false,
  jobsPersistence: 'memory_only',
  workerPoolShared: true,
  parallelNamespaces: true,
  lanes: ['interactive', 'background', 'maintenance'],
  fairNamespaceScheduling: true,
  laneAgingThresholdMs: 15000,
  agedDispatchAlternatesWithStrictPriority: true,
  schedulerStatsExposeOldestWaitMs: true,
  arbitraryCodeExecution: false,
  ...(computePilots.flashback ? { flashbackPilot: {
    version: pluginVersions.flashback,
    operation: computePilots.flashback.operation,
    algorithmFingerprint: computePilots.flashback.fingerprint,
    preferServerRequiresVerifiedCandidate: true,
    serverFailureRunsLocalExactlyOnce: true
  } } : {}),
  liaWorldLorePilot: {
    version: pluginVersions.lia,
    operation: computePilots.lia.operation,
    algorithmFingerprint: computePilots.lia.fingerprint,
    execution: 'bounded_interactive_execute_with_local_fallback',
    localDefaultZeroNetwork: true,
    preferServerDelegatesCurrentRequest: true,
    deadlineMs: 1200,
    localReserveMs: 350,
    ownerBindingReadback: ['scopeKey', 'characterId', 'chatId', 'personaId', 'loreInventoryDigest', 'queryDigest']
  },
  libraRecallBm25fPilot: {
    version: pluginVersions.libra,
    operation: computePilots.libra.operation,
    algorithmFingerprint: computePilots.libra.fingerprint,
    execution: 'bounded_interactive_execute_with_local_fallback',
    localDefaultZeroNetwork: true,
    preferServerDelegatesCurrentRequest: true,
    deadlineMs: 1500,
    localReserveMs: 400,
    ownerBindingReadback: ['scopeKey', 'characterId', 'chatId', 'branchDigest', 'manifestSignature', 'queryDigest', 'candidateDigest']
  },
  hayakuSparseRrfPilot: {
    version: pluginVersions.hayaku,
    operation: computePilots.hayaku.operation,
    algorithmFingerprint: computePilots.hayaku.fingerprint,
    execution: 'bounded_interactive_execute_with_local_fallback',
    localDefaultZeroNetwork: true,
    preferServerDelegatesCurrentRequest: true,
    deadlineMs: 900,
    localReserveMs: 200,
    ownerBindingReadback: ['scopeKey', 'characterIdHash', 'chatIdHash', 'chatSnapshotHash', 'cloneFingerprint', 'worldlineRevision', 'headTurnNodeId', 'queryDigest', 'rowDigest']
  }
};
manifest.dataContract.serverConnectionGui.sdk = storageSdkVersion;
// Core3 global controls preserve legacy per-scope source routes only until their
// verified migration. Preserved local/manager/read-only consumer SDKs keep their
// independent byte bindings above; they are not declared active mode writers.
manifest.dataContract.core3GlobalModePolicy = {
  owners: ['flashback','hayaku','libra'], modeSelectionScope: 'plugin-global',
  independentPluginModes: true, perChatModeSelection: false,
  legacySourceRouteRetainedUntilVerified: true, allKnownChatDiscoveryRequired: true,
  incompleteDiscoveryBlocksCompletion: true, sourceCommitAfterVerifiedMigration: true
};
manifest.dataContract.scopeSpecificStorageModesCompatibilityOnly = true;
manifest.dataContract.legacyGlobalModeImportedIntoActiveScopeOnly = false;
manifest.dataContract.legacyGlobalModeArgumentResetToPluginOnly = false;
manifest.dataContract.serverConnectionGui.scopeOnlyModeTransition = false;
manifest.dataContract.serverConnectionGui.globalModeOwners = ['flashback','hayaku','libra'];

manifest.dataContract.storageReadPerformance = {
  protocol: '1.9',
  keyPagination: { capability: 'keys-pagination.v1', defaultLimit: 400, maximumLimit: 1000, cursorNamespaceSpacePrefixBound: true },
  getManyBudget: { capability: 'server-batch-read-budget.v1', defaultBytes: 4194304, maximumBytes: 8388608, minimumBytes: 262144, continuation: true, oversizedSingleValueFallbackToGet: true, oversizedPreflightUsesSqliteValueBytes: true },
  interactiveSingleValueSoftCap: { capability: 'interactive-storage-soft-cap.v1', bodyBytes: 4456448, policy: 'reject_use_owner_shards' },
  legacyUnpagedCompatibility: true,
  sdkAutomaticallyConsumesPages: true,
  sdkLargeMutationPreflight: true
};
manifest.dataContract.guiPerformance = {
  retraceServerScopePageSize: 60,
  retraceServerScopeFullInventoryRetained: true,
  offscreenScopeCardContentVisibility: true,
  portableJsonWorkerOwners: ['flashback', 'hayaku', 'libra'],
  portableJsonWorkerFallback: true,
  portableJsonSerializationTransfer: 'utf8-arraybuffer',
  portableJsonWorkerTimeoutMs: 120000,
  libraLargeResultInlineCharLimit: 48000,
  libraLargeResultPreviewCharLimit: 12000,
  libraLargeResultFullBodyHydration: 'details_toggle_only'
};
manifest.dataContract.pluginOnlyIsolation = {
  currentScopeHardBoundary: true,
  normalProxyNetworkCalls: 0,
  mixedScopeRegistrySafe: true,
  sharedRoutesStayLocal: true,
  modeApplyStaysOffline: true,
  explicitServerActionsStillAvailable: true
};
manifest.dataContract.crossPlatformServer = {
  windows: 'native_batch_launcher',
  macos: 'posix_and_command_launcher',
  linux: 'posix_launcher',
  android: 'termux_launcher',
  requiredNode: '>=22.13.0 with node:sqlite',
  portableDataFolder: true,
  sharedAndroidStorageBlocked: true,
  loopbackOnly: true,
  automaticDataInstanceIdentity: true,
  manualTokenEntry: false,
  readOnlyStatusStopIntegrity: true,
  boundedAdminRequests: true,
  trackedBackgroundChildLifecycle: true
};
manifest.dataContract.launcherAdminIdentityPreflight = {
  stop: true,
  integrity: true,
  bearerSentOnlyAfterServerAndDataIdentityMatch: true,
  manualTokenEntry: false
};
manifest.dataContract.namespaces = ['flashback', 'hayaku', 'libra', 'lia', 'retrace'];
manifest.dataContract.serverConnectionGui.sidePanelOwners = ['flashback', 'hayaku', 'libra', 'lia', 'retrace'];
manifest.dataContract.serverConnectionGui.restoreSuccessRequires = [
  'non_empty_server_snapshot_or_owner_validated_tombstones',
  'space_coverage',
  'local_readback',
  'owner_semantic_validation'
];
manifest.dataContract.serverConnectionGui.restoreTransactionRollback = true;
manifest.dataContract.serverConnectionGui.modeTransitionNoWritePreflight = true;
manifest.dataContract.serverConnectionGui.serverTombstoneAuthoritativeInMirror = true;
manifest.dataContract.serverConnectionGui.ownerValidatorRequired = true;
manifest.dataContract.serverConnectionGui.sharedDependenciesAreExplicit = true;
manifest.dataContract.serverConnectionGui.urlChangeRollbackOnModeFailure = true;
manifest.dataContract.serverConnectionGui.recoveryRequiredGuard = true;
manifest.dataContract.serverConnectionGui.recoveryFailureKeepsServerOnly = true;
manifest.dataContract.serverConnectionGui.scopePinnedActions = true;
manifest.dataContract.serverConnectionGui.scopeMultiSelectDelete = true;
manifest.dataContract.serverConnectionGui.scopeMultiDeleteOwnerProofBeforeAnyPlan = true;
manifest.dataContract.serverConnectionGui.scopeRecoveryPairing = {
  targetMustBeCurrentRisuChat: true,
  stableInventoryReads: 2,
  sameCharacterRequired: true,
  transcriptDigestRecorded: true,
  ownerRestoreAndReadbackRequired: true,
  ownerModeAfter: 'plugin_only',
  sourceServerRecordsMutated: false,
  durableCatalogReadback: true
};
manifest.dataContract.serverConnectionGui.ownerDiscoveryStorageFree = true;
manifest.dataContract.serverConnectionGui.serverManagerExplicitProbeTimeoutMs = 5000;
manifest.dataContract.serverConnectionGui.serverScopeMetadataPrefetchOnly = true;
manifest.dataContract.serverConnectionGui.terminalResultPersistsUntilDismissed = true;
manifest.dataContract.restoreOwnerIntegrity = {
  libraManifestMemoryAndVectorReadback: true,
  hayakuPhysicalArchiveChainReadback: true,
  retraceBackupCatalogTargetChecksum: true
};
manifest.dataContract.retraceOwnerConnectionDashboard = ['flashback', 'hayaku', 'libra', 'lia'];
manifest.dataContract.retraceOwnStorageIsAdvanced = false;
manifest.dataContract.storageModes = ['plugin_only', 'server_only'];
manifest.dataContract.storageModeLifecycle = {schema:'memory-suite.storage-mode-contract.v2', operationalModes:['plugin_only','server_only'], transitionPhase:'mirror', mirrorSelectable:false, legacyMirrorReadable:true, verifiedCutover:true, sourceAuthorityUntilCutover:true};
manifest.dataContract.handoffDestinationPreflight = ['plugin_only', 'server_only'];
manifest.dataContract.handoffSourceImmutableOnStorageFailure = true;
manifest.dataContract.outputListenerCapture = {
  risuaiBaseline: '2026.8.240',
  officialBackend: 'addRisuChatListener(output)',
  hostListenerHeavyWorkAwaited: false,
  logicalTurnRevisionUpsert: true,
  autoContinueSupersession: true,
  postOutputSourceRevalidation: true,
  legacyBackendsMutuallyExclusive: true,
  backendTelemetry: ['backend', 'registered', 'observedRuns', 'lastEventAt', 'fallbackReason', 'revisionCount', 'duplicateDrops', 'staleDrops', 'healthChecks', 'silentFailovers', 'healthPending'],
  plugins: {
    libra: { version: pluginVersions.libra, fiveTurnCommitRevisionGate: true, backendOrder: ['chat_output_v3', 'script_output_legacy', 'after_request_reconcile'] },
    hayaku: { version: pluginVersions.hayaku, deferredAuthoritativeBinding: true, backendOrder: ['chat_output_v3', 'after_request_reconcile', 'script_output_legacy'], nonOwningOutputHooksAreSanitizers: true },
    flashback: { version: pluginVersions.flashback, provisionalRemoteEmbedding: false, backendOrder: ['chat_output_v3', 'script_output_legacy', 'after_request_reconcile'], legacyCandidatesRequireLiveReconcile: true },
    lia: { version: pluginVersions.lia, fiveTurnCommitRevisionGate: true, inFlightRevisionRequeue: true, backendOrder: ['chat_output_v3', 'script_output_legacy', 'after_request_reconcile'] }
  }
};
manifest.dataContract.libraCanonicalCuration = {
  version: pluginVersions.libra,
  activeManifestPointerUnchanged: true,
  canonicalArtifactSchema: 'libra.canonical_artifact.v3',
  canonicalCommitSchema: 'libra.canonical_commit.v1',
  entityRegistrySchema: 'libra.entity_registry.v2',
  entityAdmissionDecisionSchema: 'libra.entity_admission_decision.v1',
  entityAdmissionReceiptSchema: 'libra.entity_admission_receipt.v1',
  stateObservationSchema: 'libra.state_observation.v2',
  currentStateHeadSchema: 'libra.continuity_state.v2',
  stateReceiptSchema: 'libra.state_pipeline_receipt.v1',
  plannerPendingWithoutSafeBoundaryCanonicalPriority: 'all_recalled_canonical_newer_than_state',
  plannerExactBoundaryPriorityPreserved: true,
  portableRollbackStateDerivedWorldlines: 'main_and_all_known_logical_worldlines',
  portableRollbackDerivedReadbackRequired: true,
  stateCorrectionPatchSchema: 'libra.state_correction_patch.v2',
  legacyContinuityAuthority: 'migration_only',
  legacyContinuityEligibleArtifacts: ['libra.canonical_artifact.v2', 'untyped_legacy_memory'],
  legacyContinuityRejectedAuthorities: ['libra.canonical_artifact.v3', 'libra.canonical_manual_authority.v1'],
  currentNarrativeAuthority: 'libra.continuity_state.v2:narrative',
  currentNarrativeSchema: 'libra.narrative_current_state.v2',
  legacyStoryArcSchema: 'libra.story_arc.v1',
  legacyStoryArcStorageAuthority: 'read_only_migration_input',
  legacyStoryArcRuntimeWrites: false,
  legacyStoryArcRuntimeDeletes: false,
  storyArcCompatibilityProjectionSchema: 'libra.story_arc.compatibility_projection.v2',
  storyArcCompatibilityProjectionPersistent: false,
  plannerNarrativeDirectionSchema: 'libra.planner_narrative_direction.v1',
  storyArcDestinationDelegatesToPlannerDirection: true,
  transferCompatibilityProjectionAfterAuthoritativeStateRebuild: true,
  existingCurrentNarrativeWinsLegacyStoryArcMigration: true,
  legacyStoryArcMigrationPreservesSourceRecord: true,
  frozenPublicApiExposesNarrativeCompletion: true,
  ordinaryStateCorrectionOperations: ['set', 'clear'],
  ordinaryStateCorrectionCreatesIdentity: false,
  ordinaryStateCorrectionCas: ['expectedRecordHash', 'expectedFieldHashes'],
  ordinaryStateCorrectionProvenanceSeparatedFromCanonicalEvidence: true,
  oldOrdinaryCorrectionsCompileSafelyAtReplay: true,
  manualCanonicalCorrectionUsesHistoricalAnchorPolicy: true,
  manualStateDispositionSchema: 'libra.canonical_manual_state_disposition.v1',
  manualStateDispositionReceiptSchema: 'libra.manual_state_disposition_receipt.v1',
  sidecars: [
    'libra.canonical_variant_index.v1', 'libra.canonical_job.v1',
    'libra.entity_registry.v2', 'libra.entity_admission_receipt.v1', 'libra.state_observation.v2',
    'libra.state_pipeline_receipt.v1', 'libra.continuity_state.v2',
    'libra.state_correction.v1', 'libra.state_correction_patch.v2',
    'libra.manual_state_disposition_receipt.v1',
    'libra.continuity_delta.v1 (legacy read compatibility)',
    'libra.continuity_override.v1 (legacy read compatibility)'
  ],
  jobKinds: ['cold_start', 'manual_scan', 'failed_retry', 'regenerate', 'edit_rebuild', 'state_rebuild'],
  candidateBeforeAdoption: true,
  candidateStateTracking: false,
  stateTrackingStartsAfterDurableCanonicalReadback: true,
  sourceDigestGate: true,
  artifactDigestGate: true,
  activeWorldlineGate: true,
  userVersionsPreserved: true,
  copyOnWriteEdit: true,
  manualEditReusesStaleCanonicalArtifact: false,
  manualEditRequiresStateDisposition: true,
  manualStateDispositionModes: ['maintained_by_user', 'sparse_correction'],
  manualStateDispositionJobLocalAndCandidateBound: true,
  manualStateDispositionIntentDigestBindings: [
    'jobId', 'candidateId', 'candidateKey', 'memoryId', 'revision', 'sourceDigest',
    'contentHash', 'authorityHash', 'target', 'patch', 'createdAt'
  ],
  manualStateDispositionPostAdoptionTargetBasis: true,
  manualStateDispositionExactAnchorHeads: ['beforeTargetHead', 'throughOriginalTargetHead'],
  manualStateDispositionAnchorReplay: 'durable_sidecars_only_read_only',
  manualStateDispositionAnchorReplayNeverCallsProvider: true,
  manualStateDispositionAnchorReplayNeverCreatesMissingSidecars: true,
  manualStateDispositionAnchorReplayFailClosedInputs: [
    'logical_or_archive_binding', 'artifact_digest', 'entity_admission_receipt',
    'state_pipeline_receipt', 'observation_and_verifier_digests',
    'manual_disposition_receipt', 'legacy_delta'
  ],
  manualStateDispositionAnchorIdentityPolicy: 'unique_name_or_alias_and_exact_id_name_binding',
  manualStateDispositionAnchorCas: ['manifest', 'correction_journal', 'active_worldline', 'candidate', 'canonical_job'],
  manualStateDispositionReceiptStatuses: ['manual_maintained', 'manual_correction_replayed'],
  manualStateDispositionReceiptDigestBindings: [
    'scopeKey', 'worldlineId', 'memoryId', 'revision', 'sourceDigest', 'memoryKey',
    'turnRange', 'intentDigest', 'mode', 'basisVersion', 'basisFingerprint',
    'target', 'correctionId', 'status'
  ],
  activeChainReplayFromChangedTurn: true,
  domainSequentialCatchUp: true,
  domainFailureIsolation: ['character', 'relationship', 'world', 'narrative'],
  stateOnlyLegacyReanalysis: false,
  legacyV2ArtifactReadCompatibility: true,
  legacyDeltaReplayCompatibility: true,
  memoryPipelineEmitsStateMutation: false,
  stateReanalysisFailureBlocksAdoption: false,
  statePipelineFailureRollsBackCanonical: false,
  omissionPreservesExistingFields: true,
  semanticNoopPreservesProvenance: true,
  explicitClearAndCloseRequireVerification: true,
  relationshipEndpointsRequireValidatedPeople: true,
  entityAdmissionIndependentBeforeObservers: true,
  entityAdmissionConnection: 'state_character_verifier',
  entityAdmissionMode: 'person_admission',
  entityAdmissionExactDigestReadback: ['basisDigest', 'candidateDigest', 'evidenceDigest', 'receiptDigest'],
  entityAdmissionApprovedAssertionIdsExact: true,
  entityAdmissionFailurePolicy: 'fail_closed_new_people_preserve_existing_registry',
  correctionOverlayBeforeEveryHeadWrite: true,
  providerAbortSignal: true,
  persistentGuiShell: true,
  regionInvalidation: ['header', 'mobile-navigation', 'sidebar', 'main', 'canonical-job-portal'],
  progressRenderMaxHz: 4,
  jobPortalDoesNotRefreshSnapshot: true
};
manifest.dataContract.libraInferenceBudget = {
  version: pluginVersions.libra,
  canonicalSchema: 'libra.canonical_provider_budget.v2',
  sgaSchema: 'libra.sga_provider_budget.v2',
  providerRetrySchema: 'libra.provider_retry_governor.v1',
  hardLimits: ['physical_calls', 'wall_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens'],
  perStageUsageReceipts: true,
  visibleRepairReserveTokens: 1200,
  repairCallReserve: 1,
  providerCorrectiveRetriesPerLogicalCall: 1,
  nestedProviderRetriesDisabledInsideCanonicalAndSga: true,
  itoUnifiedAuthoritativeRepair: true,
  optionalItoFailurePreservesPriorValidDraft: true,
  conservativeInputEstimateSafetyFactor: 1.15,
  providerNativeUsageSettlement: true,
  reasoningBudgetClampedToRemainingRunBudget: true
};
manifest.dataContract.libraRisuAiAuxiliaryDefault = {
  version: pluginVersions.libra,
  presetName: 'risuai_aux',
  transport: 'risuai.runLLMModel',
  mode: 'otherAx',
  staticModelSpecified: false,
  freshUnconfiguredDefaultOnly: true,
  savedDefaultAndStageOverridesPreserved: true,
  configuredLegacyDirectDefaultPreserved: true,
  allowPluginsDefault: true,
  pluginModelAccessArgument: 'risuai_aux_allow_plugins',
  explicitFalsePreserved: true,
  syntheticTimeoutRetry: false,
  serializedPhysicalCalls: true,
  localStructuredValidationRequired: true
};
manifest.dataContract.libraPortableMemoryRecoveryUi = {
  version: pluginVersions.libra,
  navigation: 'recovery',
  subsection: 'memory_restore',
  dedicatedHost: 'data-portable-backup-host=libra',
  explicitJsonLabels: true,
  sameChatOnly: false,
  restoreModes: ['restore_same_scope', 'import_as_predecessor_archive', 'reconstruct_native_copy'],
  sameCharacterRequiredForCrossChat: true,
  migrationTargetCurrentLayerMustBeEmpty: true,
  copyRequiresContiguousFiveTurnContentMatch: true,
  preRestoreSnapshotAndJournal: true,
  interruptedRestoreStartupRollback: true,
  crossChatImportWriteAheadJournal: true,
  interruptedCrossChatImportStartupRollback: true,
  damagedReceiptOwnedRangeRepair: true,
  semanticMemoryAndVectorReceiptReadback: true,
  sourceProvenanceAndEmbeddingReceiptReadback: true,
  receiptRangeRecomputedFromBackupLineage: true,
  inheritedArchiveReceiptReadbackAndImmutableRepair: true,
  packedVectorHydrationBeforeCopy: true,
  exactRawValueRollback: true,
  malformedReceiptOwnedJsonRepair: true,
  scopedJournalRecoveryValidation: true,
  terminalJournalCleanupWarning: true,
  legacyCopyReceiptContinuityRequired: true,
  arbitraryActionInjection: false,
  floatingFallback: false,
  documentWideUiObserver: false,
  sharedCanonicalOperationGate: true,
  remountPreservesBusyState: true
};
manifest.dataContract.longChatRevisionCache = {
  exactBodyComparison: true,
  sampledFingerprintAuthority: false,
  boundedMemory: true,
  scopeSeparated: true,
  libra: {
    version: pluginVersions.libra,
    unchangedMessageProjectionReuse: true,
    unchangedCompletedPairSnapshotReuse: true,
    changedMessageOnlyRenormalized: true,
    rollbackSuffixPruned: true,
    canonicalStorageFormatUnchanged: true
  },
  flashback: {
    version: pluginVersions.flashback,
    unchangedNormalizedDescriptorReuse: true,
    unchangedLivePairStateReuse: true,
    changedMessageOnlyRenormalized: true,
    rollbackSuffixPruned: true,
    shardVectorArchiveFormatsUnchanged: true
  }
};
manifest.dataContract.libraClassicProvenanceRescue = {
  schema: 'libra.classic_provenance_rescue.v1',
  version: pluginVersions.libra,
  route: 'classic_only',
  source: 'validated_current_state_head_provenance_only',
  maxRescuedCanonicalRefs: 2,
  rawStateHeadInjected: false,
  canonicalMemoryRemainsAuthority: true,
  noNewStorage: true,
  noNewVectors: true,
  newLlmCalls: 0,
  newEmbeddingCalls: 0,
  pastOnlyQueriesFailOpenWithoutRescue: true,
  nonReadyDomainsCannotDriveRescue: true
};
manifest.dataContract.libraProtectedProductTransfer = {
  schema: 'libra.protected_product_transfer.v1',
  classicSharesRecallEvidenceBudget: true,
  plannerCompleteNormalizedPlan: true,
  plannerSecondaryFieldDropping: false,
  sgaCompleteDraft: true,
  sgaDraftAndAnalysisAtomicProduct: true,
  sgaCompleteNormalizedStageAnalysis: true,
  preferredCapMayExpand: true,
  canonicalMemoryUnchanged: true,
  embeddingUnchanged: true,
  peerStorageOwnershipUnchanged: true,
  newProviderCalls: 0
};
manifest.dataContract.apiV3LowRiskAdoption = {
  schema: 'memory-suite.api-v3-low-risk-adoption.v1',
  runtimeInfoDiagnostics: { libra: true, flashback: true, fields: ['apiVersion', 'platform', 'saveMethod'], capabilityAuthority: false },
  stableUiLifecycle: { hayaku: true, lia: true, officialRemoval: 'unregisterUIPart', legacyFallbackRetained: true },
  readInlayAdded: false,
  getFetchLogsAdded: false,
  memorySemanticsChanged: false,
  newProviderCalls: 0
};
manifest.dataContract.committedOutputCapture = {
  schema: 'memory-suite.committed-output-capture.v1',
  officialRisuAiVersion: '2026.8.240+',
  eventSemantics: 'committed_output_revision_not_immutable_turn_complete',
  listenerContract: 'capture_enqueue_return',
  officialOwners: ['libra', 'hayaku', 'flashback', 'lia'],
  logicalTurnRevisionUpsert: true,
  autoContinueSupersession: true,
  postOutputSourceRevalidation: true,
  heavyWorkOutsideListener: true,
  legacyBackendMutuallyExclusive: true,
  legacyBackends: ['script_output_legacy', 'after_request_reconcile'],
  liaFiveTurnCommitGate: true,
  liaInFlightRevisionRequeue: true,
  liaLedgerRollbackPreserved: true,
  unconditionalIdlePolling: false,
  silentRegisteredListenerFailover: true,
  failoverProofPoint: 'next_main_beforeRequest_after_main_afterRequest_without_output_callback',
  timerBasedFinalizationReintroduced: false,
  liaOfficialOnUnload: true
};
manifest.dataContract.memoryLaneRouting = {
  version: 1,
  commonContract: 'coarse_region_selection_then_existing_fine_recall',
  sourceOfTruthUnchanged: true,
  sharedLaneStore: false,
  newLlmCalls: 0,
  newEmbeddingCalls: 0,
  relevanceOverRecency: true,
  boundedRecency: true,
  lowConfidenceExpansion: true,
  failOpenToExistingRecall: true,
  crossPluginIndexSharing: false,
  adapters: {
    libra: { version: 'libra.recall_catalog_block_index.v1', persistence: 'memory_cache', activationMinEntries: 96 },
    hayaku: { globalRouter: 'hayaku_global_packet_routing_catalog_v2', episodeRouter: 'hayaku_hierarchical_episode_memory_v3' },
    flashback: { shardIndexVersion: 4, buildVersion: 'flashback_shard_memory_lane_v1' }
  }
};
manifest.dataContract.ariadneLatestState = {
  version: pluginVersions.libra,
  schema: 'libra.continuity_state.v2',
  canonicalArtifactSchema: 'libra.canonical_artifact.v3',
  commitEnvelopeSchema: 'libra.canonical_commit.v1',
  entityRegistrySchema: 'libra.entity_registry.v2',
  observationSchema: 'libra.state_observation.v2',
  verifierSchema: 'libra.state_verification.v1',
  overwriteOnly: true,
  cumulativeAuthority: 'libra.canonical_memory.v1',
  historyStored: false,
  vectorsStored: false,
  memoryPipelineOwnsStatePatches: false,
  observerDomains: ['character', 'relationship', 'world', 'narrative'],
  entityAdmissionIndependentFromCharacterObservation: true,
  canonicalBasisExactIdentity: [
    'scopeKey', 'worldlineId', 'memoryKey', 'memoryId', 'revision', 'turnRange',
    'sourceDigest', 'artifactDigest', 'activeManifestRef'
  ],
  sharedArchiveReplayIdentity: [
    'physicalStorageKey', 'archiveId', 'canonicalId', 'memoryId', 'revision',
    'turnRange', 'sourceDigest', 'artifactDigest', 'archiveDigest',
    'sourceScope', 'targetScope', 'transferOrImportId'
  ],
  highRiskVerifierConditional: true,
  reviewedAndChangedCursorsSeparated: true,
  fieldAssertionProvenanceRequired: true,
  stateReceiptAuthority: {
    complete: 'target_canonical_chain',
    partial: 'last_known_non_authoritative',
    notRequired: 'not_required'
  },
  incompleteRebuildRestoresPriorHeadAndRegistry: true,
  transferStateAuthority: {
    complete: 'target_canonical_chain',
    pending: 'none_pending',
    notRequired: 'not_required'
  },
  portablePendingExactReceiptReadback: true,
  portablePendingHeadReadbackRequired: false,
  stateCorrectionJournalAppliedBeforeHeadWrite: true,
  liveTailOverlayPersistent: false,
  branchFingerprintFailClosed: true,
  nativeCopyAndHandoffSeedOnlyUntilCanonicalReplay: true,
  serverRestoreOwnerValidated: true
};
manifest.dataContract.libraUnifiedGui = {
  version: pluginVersions.libra,
  pageCount: 12,
  initialPage: 'memory',
  homeDashboard: false,
  legacyHomeRedirectsTo: 'memory',
  persistentStatusRail: false,
  commonPageOrder: [
    'memory', 'characters', 'relationships', 'world', 'narrative', 'pipeline',
    'agents', 'custom', 'ai', 'embedding', 'logs', 'settings'
  ],
  currentHeadPages: ['characters', 'relationships', 'world', 'narrative'],
  memoryViews: ['read', 'context', 'manage'],
  canonicalReaderDefault: true,
  canonicalReaderInitialLimit: 20,
  canonicalReaderLazyDetailHydration: true,
  evidenceDrawer: true,
  pipelineTabs: ['response_generation', 'memory_pipeline', 'state_tracking'],
  agentTabs: ['memory', 'state', 'draft'],
  entityAdmissionCardLocations: ['pipeline.state_tracking', 'agents.state'],
  manualCanonicalEditorRequiresStateDisposition: true,
  manualCanonicalEditorDispositionModes: ['maintained_by_user', 'sparse_correction'],
  manualCanonicalAdoptDisabledUntilIntentReadback: true,
  customTabs: ['memory', 'state', 'current_draft', 'ooc', 'injection'],
  libraGradiaShareMemoryAndState: true,
  modeSpecificDraftWorkspaceOnly: true,
  plannerNarrativeDirectionSeparatedFromCurrentNarrative: true,
  inputWriterConfigurationPage: 'settings',
  inputWriterExecutionSurface: 'risuai_hamburger',
  aiPresetCreateCloneEdit: true,
  embeddingAdvancedSettings: true,
  runLogsSeparatePage: true
};
manifest.dataContract.libraReaderEvidenceAndOperations = {
  version: pluginVersions.libra,
  canonicalReaderPageSchema: 'libra.canonical_reader_page.v1',
  canonicalReaderChapterSchema: 'libra.canonical_reader_chapter.v1',
  evidenceChainSchema: 'libra.evidence_chain.v1',
  executionReceiptPageSchema: 'libra.execution_receipt_page.v1',
  executionReceiptDetailSchema: 'libra.execution_receipt_detail.v1',
  executionKinds: ['memory', 'state', 'draft', 'recall', 'input_writer', 'embedding', 'rebuild'],
  referenceSourceSnapshotSchema: 'libra.reference_source_snapshot.v1',
  providerOperationBudgetSchema: 'libra.provider_operation_budget.v1',
  canonicalToStateBudgetLink: 'parentOperationId_only',
  readerAndEvidenceDurableMutation: false,
  canonicalChapterUsesAdditionalLlm: false,
  providerPresetStableId: true,
  orphanPresetBindingVisible: true
};
manifest.dataContract.recoveryHardening = {
  shutdownBackup: true,
  recoverySafeMode: true,
  recoverySafeModeBlocksPluginIo: true,
  offlineRestore: true,
  recoveryQuarantine: 'backups/recovery-quarantine',
  restoreJournal: 'migrations/restore-transaction.json',
  restoreJournalPhases: ['PREPARED', 'INSTALLED', 'VERIFIED', 'COMMITTED'],
  backupScrub: true,
  restorePlan: true,
  autoBackupMinCooldownMs: 600000,
  autoBackupRetention: { recent: 12, daily: 7, weekly: 4 },
  scopeCatalogPreviousFallback: true,
  scopeDeleteBlockedWhenCatalogDegraded: true,
  durableMetadataFsync: true
};
manifest.dataContract.authorization = {
  schema: 'memory-suite.scoped-capability-auth.v1',
  bootstrapOfficialPluginIdsOnly: true,
  zeroConfigurationBootstrap: true,
  manualBootstrapKeyRequired: false,
  strictBootstrapKeyModeAvailable: false,
  bootstrapPluginIdIsClaimNotCryptographicProof: true,
  loopbackSameUserTrustedBoundary: true,
  masterTokenExposedByBootstrap: false,
  pluginTokenBoundToPluginId: true,
  ownerReadWriteOwnNamespaceOnly: true,
  retracePeerReadOnly: true,
  retraceManagerCrossNamespaceReadOnly: true,
  managerHeaderCannotElevateToken: true,
  adminHeaderCannotElevateToken: true,
  adminRequiresDataRuntimeToken: true
};
manifest.plugins = {
  ...pluginVersions
};
manifest.dataContract.portableMemoryBackup = {
  schema: 'memory-suite.portable-memory-backup.v1',
  strictSameScopeReplace: true,
  libraRestoreModes: ['restore_same_scope', 'import_as_predecessor_archive', 'reconstruct_native_copy'],
  libraCurrentScopeIsolation: true,
  libraMigrationUsesSharedPredecessorArchive: true,
  libraCopyRequiresContiguousFiveTurnContentDigest: true,
  libraCopyRebuildsContinuityAndStoryArc: true,
  libraRestoreCheckpointJournal: true,
  libraCrossChatImportWriteAheadJournal: true,
  libraGeneratedContinuityDeltaRollback: true,
  libraReceiptPhysicalReadbackAndRepair: true,
  libraSemanticMemoryAndVectorReadback: true,
  libraSourceProvenanceAndEmbeddingReadback: true,
  libraReceiptRangeRecomputedFromLineage: true,
  libraInheritedArchiveImmutableRepair: true,
  libraPackedVectorHydration: true,
  libraExactRawValueRollback: true,
  libraMalformedOwnedJsonRepair: true,
  libraScopedJournalRecoveryValidation: true,
  libraTerminalJournalCleanupWarning: true,
  libraEmptyArchiveImportRejected: true,
  libraLocalPayloadAndSharedArchiveGraphBinding: true,
  libraGraphScopeTurnRevisionDigestValidation: true,
  libraExactRestoreRemovesLegacyValueOwnedRecords: true,
  flashbackFormatVersion: 2,
  flashbackRestoreModes: ['same_chat_replace', 'chat_migration_archive', 'chat_copy_rebind'],
  flashbackCrossChatTargetMustBeEmpty: true,
  flashbackMigrationUsesImmutableArchive: true,
  flashbackCopyRequiresExactTranscript: true,
  flashbackCopyRebuildsWorldline: true,
  transactionalRollback: true,
  pluginVersionMetadata: { libra: true, hayaku: true, flashback: true },
  flashbackLocalVectorSidecarsEmbedded: true,
  flashbackReferencedSidecarRequired: true,
  flashbackSidecarDigestReadback: true,
  flashbackSidecarRollback: true
};
manifest.dataContract.flashbackArchiveReembedding = {
  version: pluginVersions.flashback,
  fullMaintenanceIncludesArchive: true,
  automaticMaintenanceIncludesArchive: true,
  progressiveMaintenanceIncludesArchive: true,
  copyOnWriteImmutableSnapshot: true,
  sourceArchiveNeverMutated: true,
  currentScopeArchiveRefAtomicSwap: true,
  durableReadbackRequired: true,
  successCountsCommittedVectorsOnly: true
};
manifest.dataContract.liaSharedServerRestore = {
  version: pluginVersions.lia,
  fixedSharedStores: [
    'dynamicPersonaLorebookGeneratorResultVault',
    'liaPersonaLinkerWorldBlueprintVaultV1',
    'liaPersonaLinkerLivePersonaSyncV1',
    'liaPersonaVisualAssetStoreV1',
    'liaPersonaVisualAssetPresetStoreV1'
  ],
  chunkedVisualAssetPrefix: 'liaPersonaVisualAssetBlobV1::',
  includeInScopeSync: true,
  sharedOnlyRecovery: true,
  emptySnapshotRejectedByOwnerValidator: true,
  authoritativeTombstoneOnlyRecovery: true,
  serverTombstonesApplied: true,
  physicalPluginStorageReadback: true,
  chunkManifestAndByteValidation: true,
  transactionalRollback: true,
  recoveryFailureKeepsServerOnly: true,
  providerSecretsExcluded: true,
  illustrationCredentialsExcluded: true,
  nativePersonaDatabaseExcluded: true
};
manifest.dataContract.hayakuNativeOtherAxRecovery = {
  version: pluginVersions.hayaku,
  schema: 'hayaku.native_recovery.v1',
  normalPathNoLlmWhenCurrentPacketUsable: true,
  normalPathLlmCallsWhenCurrentPacketUsable: 0,
  responsePacketContract: ['current_snapshot'],
  responseInBandRecovery: true,
  afterRequestAutoRepairDefault: true,
  afterRequestMissingPacketPhysicalCalls: 1,
  afterRequestSuccessCommittedToAssistantTranscript: true,
  afterRequestCommitReadbackRequired: true,
  afterRequestFailureReturnsOriginalAssistantText: true,
  legacyRecoverySnapshotReadCompatible: true,
  recoveryJournalPublicName: true,
  legacyRecoveryVaultStorageCompatible: true,
  recoveryJournalAlwaysOn: true,
  recoveryVaultExactEvidence: true,
  backgroundAutoRepairDefault: true,
  backgroundAutoRepairIndependentFromAfterRequest: true,
  backgroundPerEntryConfirmationRequired: true,
  backgroundApprovedPhysicalCalls: 1,
  backgroundTimerRetry: false,
  coldStartManualOnly: true,
  coldStartBatchTurns: [1, 5, 10],
  coldStartBatchEnvelope: 'hayaku.native_cold_start_batch_output.v1',
  coldStartBatchPacketsRemainPerEvidenceUnit: true,
  coldStartBatchInputNeverSlicesEvidenceUnit: true,
  transport: {
    api: 'runLLMModel',
    mode: 'otherAx',
    allowPlugins: true,
    allowPluginsDefault: true,
    pluginModelAccessArgument: 'risuai_aux_allow_plugins',
    explicitFalsePreserved: true,
    serializedPhysicalCalls: true,
    staticModel: false,
    providerOwnedByRisuAi: true,
    providerConfigurationOwnedByHayaku: false
  },
  outputListenerWaitsForRepair: false,
  afterRequestHookWaitsForInBandRepair: true,
  coldStartPrimaryThenStrictRepairAttempts: 1,
  explicitCompleteFormatRepairMaxExtraCalls: 1,
  completeFormatRepairGuiExposed: false,
  backgroundRepairAttempts: 1,
  transportFailureImmediateDuplicateRetry: false,
  failedAnalysisVaultSchema: 'hayaku.failed_analysis.v1',
  failedAnalysisRawResponsePreSlice: false,
  failedAnalysisRawResponsePreserved: true,
  failedAnalysisFullRequestMessagesStored: false,
  failedAnalysisRequestDescriptorStored: true,
  failedAnalysisChunkHashReadback: true,
  failedAnalysisPendingReviewBlocksAutomaticRetry: true,
  failedAnalysisResolutionActions: ['adopt', 'llm', 'manual'],
  failedAnalysisLlmResolutionCalls: 1,
  failedAnalysisManualResolutionCalls: 0,
  rawSourceFallbackPacket: false,
  exactWorldlineTargetRevalidation: true,
  durableLedgerReadbackRequired: true,
  recoveryDebtRetryMetadataRetained: true,
  recoveryDebtAutomaticRetry: false,
  recoveryCoverageSchema: 'hayaku.recovery_coverage.v1',
  exactMissingTurnList: true,
  statusRefreshLlmCalls: 0,
  recoveryTurnStates: ['repairable', 'backoff', 'exhausted', 'leased', 'user_suppressed'],
  recordlessColdStartSeparatedFromPacketDebt: true,
  coldStartCheckpointResume: true,
  coldStartCancellation: true,
  coldStartSystemContextOnly: true,
  coldStartAssistantOnlyHistorical: true,
  coldStartPendingUserNotPromoted: true,
  coldStartPromptContractIdentity: true,
  unifiedRecoveryJobCenter: true,
  recoveryJobKinds: ['background_repair_confirmation', 'background_repair', 'manual_repair', 'cold_start', 'targeted_regeneration'],
  minimizableJobWindow: true,
  headerLiveProgressChip: true,
  softCancellation: true,
  targetedRegeneration: true,
  targetedExistingRecordReplacement: true,
  targetedPerRecordViewerAction: true,
  targetedMultiTurnRangeExpansion: true,
  targetedAtomicReplacementAdoption: true,
  targetedCandidateStaging: true,
  explicitOldNewChoice: true,
  regenerationDecisions: ['keep_original', 'adopt_regenerated', 'later'],
  replacementVariantReselection: true,
  atomicRegenerationGroupReselection: true,
  portableMemoryCardInRecoveryTab: true,
  portableMemoryDedicatedHostOnly: true,
  portableMemoryFloatingFallback: false,
  portableMemoryResponsiveActions: true,
  diagnosticLedgerJsonDistinctFromRestorableBackup: true,
  ledgerViewerTransparentBackdrop: true,
  ledgerViewerBackdropClickThrough: false,
  targetedCheckpointResume: true,
  currentChatColdStartRecordRegeneration: true,
  legacyRetraceCheckpointTakeover: true,
  legacyRetraceAutoRepairTakeover: true,
  exactPerMessageRevisionCache: true,
  unchangedAssistantDiagnosticsReused: true,
  changedAssistantOnlyDiagnostics: true,
  targetedEditRerollInvalidation: true,
  rollbackPrunesRemovedMessages: true,
  exactObserverChangeGate: true,
  sampledFingerprint: false,
  stableHash64Unchanged: true,
  ledgerSchema: 'hayaku_storage_ledger_v2',
  worldlineSchema: 'hayaku_turn_worldline_v2'
};
manifest.dataContract.retraceHayakuNativeOwnerDeference = {
  "version": "1.9.65",
  "nativeCapabilityNegotiation": false,
  "repairOwner": "hayaku",
  "analysisRecoveryUiRemoved": true,
  "analysisExecutionApiRemoved": true,
  "targetedRegenerationUiAndApiRemoved": true,
  "providerSubsystemRemoved": true,
  "providerCredentialPurgeByExactLegacyKeys": true,
  "providerCredentialPurgeBounded": true,
  "providerCredentialPurgeBeforeOptionalRegistration": true,
  "providerCredentialServerDenylistRetained": true,
  "genericOwnerDispatchersExposed": false,
  "ownerIpcFixedActionAllowlists": true,
  "ownerIpcResponsesRequireAuthenticatedSender": true,
  "providerAnalysisExecutorRemoved": true,
  "recoveryPromptExecutorRemoved": true,
  "nativeColdStartOwnedByHayaku": true,
  "nativeColdStartDelegation": false,
  "targetedRegenerationDelegation": false,
  "legacyCheckpointCompatibility": true,
  "legacyCheckpointExecutionOwner": "hayaku",
  "legacyHayakuAnalysisFallback": false,
  "legacyCapsulePassiveReadOnly": true,
  "legacyCapsuleAdoptionOwner": "hayaku",
  "nextSessionHandoffUnchanged": true,
  "sourceImmutableHandoffUnchanged": true,
  "standaloneOwnerViewersRemoved": true,
  "legacyHayakuBackupApiRemoved": true,
  "recordMutationAndNavigationApiRemoved": true,
  "serverControlAndHandoffRetained": true,
  "legacyStoredArtifactsPreserved": true,
  "managerOnlyConnection": true,
  "ownServerStorageRetired": true,
  "perOwnerHandoffStorageModes": true,
  "coreStorageOwners": [
    "flashback",
    "hayaku",
    "libra"
  ],
  "legacyServerNamespaceInventoryPreserved": [
    "flashback",
    "hayaku",
    "libra",
    "lia",
    "retrace"
  ]
};
manifest.dataContract.retraceDynamicOwnerStorageGate = {
  version: '1.9.65',
  participationAware: true,
  missingPeersDoNotBlock: true,
  installedUnverifiablePeersBlock: true,
  commonModeDerivedReadOnly: true,
  changesPeerModes: false,
  storageTransitionBlocksHandoff: true,
  serverOnlyIntegrityRequired: true,
  participantFingerprintPinnedAcrossHandoff: true,
  acceptedHandoffStorageReceipts: ['memory-suite.handoff-storage.v1', 'memory-suite.handoff-storage.v2']
};

manifest.executionContract = {
  version: extractStringConstant(readSource('sdk/MemorySuiteExecutionContract.source.js'), 'VERSION', 'execution contract'), source: 'sdk/MemorySuiteExecutionContract.source.js',
  includedOwners: ['libra', 'flashback', 'hayaku'], suiteWideSharedLock: false,
  generationPhysicalBudget: true, embeddingPhysicalBudget: true,
  unknownUsageIsNull: true, otherAxAppliedBudget: 'host-managed',
  defaultErrorExtraCalls: 0, maxExplicitCompleteFormatExtraCalls: 1,
  automaticTransportOrTruncationResubmit: false, explicitIncreasedCapRecovery: true, validatedStreamingRoutes: ['chat','responses','anthropic','gemini','ollama'],
  probeStartsHistoricalReembedding: false, requiresExplicitHistoricalConsent: true,
  newDefaultMigrationGui: true, sameSpaceRegistryVersion: 1, metadataOnlyOwnerMigration: ['libra','flashback'], realHostValidation: 'NOT_RUN', realProviderValidation: 'NOT_RUN',
  overallDesignAcceptance: 'PARTIAL_IMPLEMENTATION',
  auditPatchReport: 'docs/EMBEDDING_CONTRACT_PATCH_0.3.44.md',
  embeddingCheckpoint: 'owner-local-verified-batch-v1',
  embeddingPhysicalPendingTracked: true,
  implementationReport: 'docs/INTEGRATED_IMPLEMENTATION_10_11.md',
  remainingPlan: 'docs/plan_10_11_remaining.md'
};
// Remove stale metadata for the separated plugin from an older generated manifest.
delete manifest.dataContract.wmCurrentProvisionalStatus;
manifest.dataContract.gradiaThreeOwnerRead = {
  pluginVersion:pluginVersions.gradia,principal:'serial_gradation_agents_for_rp',
  readers:['libra','hayaku','flashback'],writeNamespaces:[],newStorageOwner:false,
  consent:'v1_exact_url_preserves_libra_only; explicit_reconnect_v2_signed_reader_set',
  startupReaderExpansion:false,registeredScopePolicy:'exact_current_server_only',
  evidence:'known_committed_producer_formats; provenance_preserving_deduplication',
  corpusDefaultBytes:4194304,corpusMaximumBytes:33554432,itemLimit:4096,metadataMaximumBytes:1048576,
  rawAllowance:'7 * maxCorpusBytes + 2 MiB; remaining allowance passed before materialization',
  promptMaximumBytes:65536,promptSelection:'whole_item_newest_first_owner_round_robin',
  currentness:'logical_metadata_digest_reset_epochs; not_physical_ABA_certification',
  modelProfile:'existing_G2_OpenAI_chat_completions_gpt-4o-mini-2024-07-18_unchanged',
  strongFullCorpusV2:false,actualHostQualified:false,implementation:'source_and_offline_composed_fixtures',
  contract:'docs/gradia/THREE-OWNER-READ-20261009.md'
};
manifest.dataContract.postGuiBoundedFixes = {
  status:'implemented_bounded_offline_emitted_verified', plugins:['libra','hayaku','flashback','lia','retrace','gradia'],
  preservation:'no_removed_views_or_controls; existing_storage_and_model_boundaries_preserved',
  verification:'explicit_emitted_GUI_reproductions_and_same_source_build',
  visualBrowserQualification:false, actualHostQualification:false, wholeRegressionBeforeCheckpoint:false,
  coreReport:'../../reports/GUI-FIX-LIBRA-MEMORY-TRANSACTION-LABELS-20261009T1104Z.md',
  companionReport:'../../reports/companion-gui-defect-fixes-20261009.md'
};

manifest.files = Object.fromEntries(listFiles(root)
  .map(filePath => {
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    const bytes = fs.readFileSync(filePath);
    return [relative, {
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length
    }];
  })
  .sort((left, right) => left[0].localeCompare(right[0], 'en')));

const tempPath = `${manifestPath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
let fd = null;
try {
  fd = fs.openSync(tempPath, 'wx', 0o600);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = null;
  fs.renameSync(tempPath, manifestPath);
} catch (error) {
  if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
  throw error;
}
process.stdout.write(`program-manifest.json updated: ${Object.keys(manifest.files).length} files\n`);
