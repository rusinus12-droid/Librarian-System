'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createZipFromDirectory, readZipEntries, verifyZipAgainstDirectory } = require('./zip_writer.cjs');
const { PLUGINS, syncReleaseGuides, syncRepositoryReadme, readReleaseMetadata, renderGuide, GUIDES } = require('./release_metadata.cjs');
const { writeUpdateManifest, expectedAssetName, expectedSourceAssetName, readReleasePolicy } = require('./release_asset_contract.cjs');
const { compareVersions, nextPatchVersion, validateTargetVersion, applyReleaseVersion } = require('./release_version.cjs');
const { assertPristineDistributionData } = require('./runtime_release_validation.cjs');

const PRODUCT_NAME = 'Librarian System';
const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const DEFAULT_OUTPUT_BASE = path.resolve(packageRoot, '..', 'RELEASES');
const REQUIRED_ROOT_FILE = '0_설치_안내.txt';
const ACTIVE_NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra', 'lia', 'retrace']);
const REQUIRED_PLUGIN_IDS = new Set(Object.values(PLUGINS).map(([, , id]) => id));
const RELEASE_SMOKE_TESTS = Object.freeze([
  'plugin_catalog_separation_test.cjs',
  'sdk_wm_separation_test.cjs',
  'retrace_wm_separation_test.cjs',
  'retrace_owner_contract_retention_test.cjs',
  'gradia_plugin_integration_test.cjs',
  'gradia_suite_test.cjs',
  'program_data_layout_test.cjs',
  'cross_platform_launcher_test.cjs',
  'launcher_safety_regression_test.cjs',
  'windows_bootstrap_contract_test.cjs',
  'distribution_builder_test.cjs',
  'distribution_runtime_dependency_closure_test.cjs',
  'release_metadata_test.cjs',
  'release_builder_version_input_test.cjs',
  'release_builder_profiles_test.cjs',
  'build_support_cache_runtime_test.cjs',
  'execution_task_profiles_test.cjs',
  'regression_entrypoints_runtime_test.cjs',
  'sync_read_context_composition_test.cjs',
  'browser_resolver_cache_test.cjs',
  'portable_transfer_client_contract_test.cjs',
  'portable_transfer_finalization_test.cjs',
  'retrace_portable_finalization_gui_test.cjs',
  'global_owner_discovery_adapters_test.cjs',
  'flashback_bucketed_v1_storage_test.cjs',
  'flashback_missing_vector_restore_test.cjs',
  'storage_global_migration_debug_export_test.cjs',
  'storage_job_diagnostics_clipboard_test.cjs',
  'storage_mode_confirmation_runtime_test.cjs',
  'owner_scope_management_runtime_test.cjs',
  'storage_global_allchat_panel_test.cjs',
  'storage_global_allchat_faults_test.cjs',
  'storage_expired_global_rollback_test.cjs',
  'storage_global_rollback_progress_test.cjs',
  'storage_restored_server_cancellation_test.cjs',
  'storage_global_destination_readback_test.cjs',
  'storage_job_user_cancellation_test.cjs',
  'storage_global_owner_public_gui_test.cjs',
  'storage_transition_gui_recovery_test.cjs',
  'manifest_minified_declaration_binding_test.cjs',
  'libra_canonical_reasoning_off_length_runtime_test.cjs',
  'libra_recovery_result_gui_runtime_test.cjs',
  'libra_micro_state_reader_gui_runtime_test.cjs',
  // The synthetic action marker uses a `.jsonl.fixture` suffix so it remains shippable
  // while ordinary JSONL data stays excluded by the sensitive-file filter.
  'libra_main_memory_acceptance_reporter_test.cjs',
  'updater_release_asset_selection_test.cjs',
  'hayaku_recovery_vault_shards_runtime_test.cjs',
  'hayaku_vault_migration_policy_test.cjs',
  'hayaku_vault_portable_graph_test.cjs',
  'hayaku_recovery_storage_error_surface_test.cjs',
  'flashback_scope_discovery_runtime_test.cjs',
  'flashback_scope_management_runtime_test.cjs',
  'flashback_scope_management_server_test.cjs',
  'flashback_scope_observer_retry_test.cjs',
  'flashback_scope_panels_contract_test.cjs',
  'librarian_system_brand_contract_test.cjs',
  'distribution_metadata_coherence_test.cjs',
  'release_asset_contract_test.cjs',
  'remote_update_program_only_apply_test.cjs',
  'remote_update_crash_recovery_test.cjs',
  'remote_update_recovery_boundaries_test.cjs',
  'remote_update_commit_boundary_test.cjs',
  'remote_update_standalone_recovery_test.cjs',
  'remote_update_launchers_contract_test.cjs',
  'updater_user_experience_test.cjs',
  // Native branch/worldline is a release invariant across all memory owners.
  'native_branch_host_lineage_test.cjs',
  'native_branch_flashback_runtime_test.cjs',
  'flashback_worldline_workspace_v129_runtime_test.cjs',
  'native_branch_hayaku_runtime_test.cjs',
  'hayaku_native_repair_worldline_race_test.cjs',
  'native_branch_lia_runtime_test.cjs',
  'native_branch_libra_runtime_test.cjs',
  'native_branch_libra_t7_continue_test.cjs',
  'native_branch_libra_precanonical_fork_test.cjs',
  'native_branch_libra_worldline_meta_test.cjs',
  'native_branch_libra_worldline_legacy_migration_test.cjs',
  'native_branch_libra_worldline_conflict_test.cjs',
  'libra_portable_multiverse_derived_rollback_p1_test.cjs',
  'libra_world_manager_worldline_transaction_rc2_test.cjs',
  'libra_host_worldline_gui_contract_test.cjs',
  // The reading desk must EXECUTE, not merely contain the right strings: string-presence checks
  // cannot see a runtime ReferenceError, and that gap let a crash ship.
  'libra_book_lineage_panel_execution_test.cjs',
  // §32.2/§32.3: the reading space and the status button are a product requirement, and a header
  // that reverts to the stacked layout is exactly the regression this locks.
  'libra_book_reading_space_contract_test.cjs',
  'libra_final_delivery_view_runtime_test.cjs',
  // §34: one home per setting, one screen for diagnostics — the duplicate call and the four stacked
  // panels are both covered.
  'libra_settings_diagnostics_consolidation_test.cjs',
  // Lens memory and immutable successor archives are a release invariant.
  'libra_custom_memory_lens_runtime_test.cjs',
  'libra_custom_memory_lens_pipeline_runtime_test.cjs',
  'libra_custom_memory_lens_server_runtime_test.cjs',
  'libra_lens_story_time_runtime_test.cjs',
  'libra_lens_story_people_runtime_test.cjs',
  'libra_lens_story_identity_runtime_test.cjs',
  'libra_lens_semantic_recall_runtime_test.cjs',
  'libra_lens_name_boundary_runtime_test.cjs',
  'libra_lens_merge_regressions_runtime_test.cjs',
  'libra_lens_vector_pages_server_runtime_test.cjs',
  'libra_lens_handoff_runtime_test.cjs',
  'libra_lens_archive_bounds_test.cjs',
  'libra_lens_handoff_server_test.cjs',
  'retrace_lens_handoff_public_test.cjs',
  'retrace_peer_runtime_compatibility_test.cjs',
  // Librarian Mobile GPU Contract v1 — a backdrop-filter blur makes the compositor re-filter what is
  // already painted behind the element, which mobile WebView pays for in shared system RAM. The gate
  // scans all five plugin GUIs (CSS declarations and JS style writes) and proves its own extractor
  // and classifier on every run before judging the plugins.
  'mobile_gpu_effect_contract_test.cjs',
  'native_branch_retrace_gui_scope_test.cjs',
  'native_branch_server_metadata_test.cjs',
  'native_branch_storage_mode_inheritance_test.cjs',
  'native_branch_0357_storage_migration_test.cjs',
  'native_branch_storage_binding_server_test.cjs',
  'native_branch_storage_modes_matrix_test.cjs',
  'native_branch_storage_design_contract_test.cjs',
  // 0.3.60 storage-mode feature parity (R01/R02/R03 + version provenance).
  'native_branch_flashback_legacy_child_migration_test.cjs',
  'native_branch_server_only_local_quarantine_test.cjs',
  'native_branch_capability_lifecycle_test.cjs',
  'plugin_version_byte_provenance_test.cjs',
  'plugin_version_provenance_contract_test.cjs',
  // 0.3.60 storage-mode feature parity audit (Tasks 7, 12, 13-17).
  'storage_modes_test.cjs',
  'storage_mode_feature_harness_contract_test.cjs',
  'storage_mode_feature_inventory_contract_test.cjs',
  'storage_mode_owner_parity_audit_test.cjs',
  'storage_mode_special_parity_gates_test.cjs',
  'storage_mode_support_matrix_contract_test.cjs',
  'remote_update_operation_lock_test.cjs',
  'remote_update_offline_guard_test.cjs',
  'remote_update_verify_mode_isolation_test.cjs',
  'remote_update_sigkill_recovery_test.cjs',
  'offline_migration_aux_restore_test.cjs',
  'offline_migration_aux_crash_recovery_test.cjs',
  'remote_update_migration_data_next_test.cjs',
  'remote_update_migration_required_apply_test.cjs',
  'remote_update_migration_required_recovery_test.cjs',
  'remote_update_migration_dispatch_test.cjs',
  'remote_update_migration_sigkill_recovery_test.cjs',
  'remote_update_updater_bootstrap_test.cjs',
  'remote_update_updater_external_target_test.cjs',
  'remote_update_real_server_runtime_test.cjs'
]);
const PRIVATE_DATA_PATTERN = /(?:^|\/)(?:runtime-token\.txt|compute-(?:signing|pairing)-key\.txt|scope-catalog(?:\.[^/]*)?\.json|[^/]+\.(?:sqlite(?:-(?:wal|shm))?|db|jsonl|log))(?:$|\/)/i;
// Accepted synthetic source fixtures only; never a general SQLite/private-data exception.
const SOURCE_FIXTURE_PINS = Object.freeze({
  "tests/fixtures/authority-preserved/logical-reader-fixtures/wal-only-authority/source.sqlite": {
    "sha256": "3d09bfa7cc857b75e485c292535b3edb3cdc24ffb4b45be47869b80f7e3f95b0",
    "bytes": 16384
  },
  "tests/fixtures/authority-preserved/logical-reader-fixtures/wal-only-authority/source.sqlite-shm": {
    "sha256": "02ffaa72024ddf140f87ecee9bcf631b1f558c454f15b0300f4691bb5309017a",
    "bytes": 32768
  },
  "tests/fixtures/authority-preserved/logical-reader-fixtures/wal-only-authority/source.sqlite-wal": {
    "sha256": "97e64eef20e7509fcbd72f639cd7c2d5febacde5dd59bcde227b177958de44e0",
    "bytes": 12392
  },
  "tests/fixtures/authority-preserved/logical-reader-fixtures/hot-journal-readonly/source.sqlite": {
    "sha256": "bce2d7984767bf62a352c60c962f2e9fe4475c9a842a54095898e0a67fd22d4e",
    "bytes": 942080
  },
  "tests/fixtures/authority-preserved/logical-reader-fixtures/hot-journal-readonly/source.sqlite-journal": {
    "sha256": "d4e767e770fb4922056067b6bb54797278e5d3baff1fa53f37ddaf816345ae1e",
    "bytes": 1131016
  }
});
function verifySourceFixtureBytes(programRoot) {
  for (const [relative, pin] of Object.entries(SOURCE_FIXTURE_PINS)) {
    const file = path.join(programRoot, ...relative.split('/'));
    let stat; try { stat = fs.lstatSync(file); } catch (_) { throw new Error('distribution_source_fixture_missing:'+relative); }
    if (!stat.isFile() || stat.size !== pin.bytes || sha256File(file) !== pin.sha256) throw new Error('distribution_source_fixture_mismatch:'+relative);
  }
  return { files: Object.keys(SOURCE_FIXTURE_PINS).length };
}
const PROGRAM_DENY_SEGMENTS = new Set(['.git', 'node_modules', '__pycache__', 'backups', 'logs', 'releases']);
const PROGRAM_ALLOWED_TOP_LEVEL_DIRECTORIES = new Set([
  '_runtime', '관리도구', 'build-support', 'docs', 'plugins', 'sdk', 'server', 'tests', 'tools'
]);
const PROGRAM_ALLOWED_TOP_LEVEL_FILES = new Set([
  '_common.cmd',
  '_find_node.bat',
  '_server_foreground.cmd',
  '1_서버_실행.bat',
  '1_서버_실행.sh',
  '2_서버_종료.bat',
  '2_서버_종료.sh',
  '배포본_만들기.bat',
  '배포본_만들기.sh',
  '개발본_만들기.bat',
  '개발본_만들기.sh',
  '전체_릴리즈_만들기.bat',
  '전체_릴리즈_만들기.sh',
  '서버_백그라운드_실행.bat',
  '서버_백그라운드_실행.sh',
  '서버_상태_확인.bat',
  '서버_상태_확인.sh',
  '안드로이드_Termux_준비.sh',
  '안드로이드_설치.sh',
  '기존_DATA_이관_ZIP_만들기.bat',
  '기존_DATA_이관_ZIP_만들기.sh',
  '처음_읽어주세요.txt',
  'DATA_폴더_열기.bat',
  'macOS_서버_실행.command',
  'memory-suite.sh',
  'PACKAGE_CONTENTS.txt',
  'program-manifest.json',
  'RisuAI_플러그인_폴더_열기.bat',
  'run_regression_batch.py',
  'VERSION.txt',
  'release-policy.json'
]);
const PROGRAM_SENSITIVE_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|runtime-token\.txt|compute-(?:signing|pairing)-key\.txt|scope-catalog(?:\.[^/]*)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|pfx|p12|sqlite(?:-(?:wal|shm))?|db|jsonl|log|zip|7z|tar|tgz|gz))(?:$|\/)/i;
const REQUIRED_ROOT_UPDATE_LAUNCHERS = Object.freeze(['업데이트.bat', '업데이트.command', '업데이트.sh']);
const REQUIRED_UPDATER_FILES = new Set([
  'updater.cjs', 'update_check.cjs', 'update_common.cjs', 'release_archive.cjs',
  'core/journal.cjs', 'core/checkpoint.cjs', 'core/program-only.cjs', 'core/data-identity.cjs', 'core/migration-required.cjs', 'core/updater-bootstrap.cjs', 'core/file-picker.cjs',
  'runtime.cjs', 'launch.sh', '_find_node.bat', 'core/lock.cjs',
  'logs/README.txt',
  'platform/windows.cjs', 'platform/macos.cjs', 'platform/linux.cjs', 'platform/android.cjs'
]);
const UPDATER_SENSITIVE_PATH_PATTERN = /(?:^|\/)(?:update-state\.json|latest\.log|[^/]+\.(?:log|tmp|bak|old|sqlite|db|zip))(?:$|\/)/i;

function parseArgs(argv = process.argv.slice(2)) {
  const result = { outputDir: null, version: null, profile: 'release', qualification: process.env.LIBRARIAN_PACKAGE_QUALIFICATION || 'publication_gate' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--output-dir') {
      const value = argv[++index];
      if (!value || String(value).startsWith('--')) throw new Error('distribution_output_dir_value_required');
      result.outputDir = path.resolve(value);
    } else if (arg === '--profile') {
      const value = String(argv[++index] || '');
      if (!['release','source','all'].includes(value)) throw new Error(`distribution_profile_invalid:${value}`);
      result.profile = value;
    } else if (arg === '--version') {
      const value = argv[++index];
      if (!value || String(value).startsWith('--')) throw new Error('distribution_version_value_required');
      result.version = String(value);
    } else if (arg === '--offline' || arg === '--offline-candidate') {
      result.qualification = 'offline_candidate';
    } else if (arg === '--qualification') {
      const value = String(argv[++index] || '');
      if (!['publication_gate', 'offline_candidate'].includes(value)) throw new Error(`distribution_qualification_invalid:${value}`);
      result.qualification = value;
    } else throw new Error(`unknown_distribution_builder_argument:${arg}`);
  }
  return result;
}

function isWithin(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(rootDir, skipDependencies = false) {
  const root = path.resolve(rootDir);
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // Installed source toolchains are excluded before walking their .bin
      // symlinks. Packaged trees and UPDATER keep the strict symlink check.
      if (skipDependencies && entry.name.toLowerCase() === 'node_modules') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`distribution_symbolic_link_is_not_allowed:${fullPath}`);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) rows.push(fullPath);
      else throw new Error(`distribution_unsupported_file_type:${fullPath}`);
    }
  };
  walk(root);
  return rows.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right), 'en'));
}

function shouldCopySourceProgram(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const parts = normalized.toLowerCase().split('/');
  const topLevel = normalized.split('/')[0];
  const isTopLevelFile = !normalized.includes('/');
  if (isTopLevelFile ? !PROGRAM_ALLOWED_TOP_LEVEL_FILES.has(topLevel) : !PROGRAM_ALLOWED_TOP_LEVEL_DIRECTORIES.has(topLevel)) return false;
  if (parts[0] === 'plugins' && !Object.values(PLUGINS).some(([file]) => normalized === 'plugins/' + file)) return false;
  if (/^(?:sdk\/Wm[^/]+|server\/wm(?:\/|$))/.test(normalized)) return false;
  if (parts[0] === '_runtime') return normalized === '_runtime/README.txt';
  if (parts.some(part => PROGRAM_DENY_SEGMENTS.has(part))) return false;
  if (Object.hasOwn(SOURCE_FIXTURE_PINS, normalized)) return true;
  if (PROGRAM_SENSITIVE_PATH_PATTERN.test(normalized)) return false;
  if (/(?:^|\/)(?:full_test|test_report|npm-debug|yarn-error)[^/]*$/i.test(normalized)) return false;
  if (/\.(?:tmp|temp|bak|old|log|pyc|sqlite(?:-(?:wal|shm))?|db)$/i.test(normalized)) return false;
  return true;
}


const RUNTIME_PROGRAM_TOP_FILES = new Set([
  '_common.cmd','_find_node.bat','_server_foreground.cmd',
  '1_서버_실행.bat','1_서버_실행.sh','2_서버_종료.bat','2_서버_종료.sh',
  '서버_백그라운드_실행.bat','서버_백그라운드_실행.sh','서버_상태_확인.bat','서버_상태_확인.sh',
  'macOS_서버_실행.command','memory-suite.sh','안드로이드_Termux_준비.sh','안드로이드_설치.sh',
  '기존_DATA_이관_ZIP_만들기.bat','기존_DATA_이관_ZIP_만들기.sh',
  'DATA_폴더_열기.bat','RisuAI_플러그인_폴더_열기.bat','처음_읽어주세요.txt','PACKAGE_CONTENTS.txt',
  'VERSION.txt','program-manifest.json','release-policy.json'
]);
const RUNTIME_TOOL_FILES = new Set([
  'check_node.cjs','config_env.cjs','install_runtime.ps1','platform_launcher.cjs','portable_export_stopped.cjs',
  'prepare_data.cjs','release_asset_contract.cjs','release_metadata.cjs','runtime_release_validation.cjs','termux_install.py','zip_writer.cjs'
]);
const RUNTIME_SDK_FILES = new Set([
  // The search kernel stays in sdk/ only as a test oracle; nothing at runtime loads it.
  'MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js','MemorySuiteComputeClient.source.js','MemorySuiteExecutionContract.source.js'
]);
const RUNTIME_DOC_FILES = new Set([
  'ANDROID_INSTALL_HELPER.md','STORAGE_MODE_TRANSITION_CONTRACT.md','UPDATER_0.3.51_BOOTSTRAP.md','사용설명서.md','데이터_구조와_마이그레이션.md','보안과_복구.md'
]);
function shouldCopyRuntimeProgram(relativePath) {
  const normalized=relativePath.split(path.sep).join('/');
  if (PROGRAM_SENSITIVE_PATH_PATTERN.test(normalized)) return false;
  const [top,...rest]=normalized.split('/');
  if (!rest.length) return RUNTIME_PROGRAM_TOP_FILES.has(top);
  const leaf=rest.join('/');
  if (top==='plugins') return Object.values(PLUGINS).some(([file]) => leaf===file);
  if (top==='server') return !leaf.startsWith('wm/');
  if (top==='관리도구') return !['전체_자동시험.bat','전체_자동시험.sh'].includes(leaf);
  if (top==='_runtime') return leaf==='README.txt';
  if (top==='tools') return RUNTIME_TOOL_FILES.has(leaf);
  if (top==='sdk') return RUNTIME_SDK_FILES.has(leaf);
  if (top==='docs') return RUNTIME_DOC_FILES.has(leaf);
  return false;
}
const shouldCopyProgram = shouldCopySourceProgram;

function shouldCopyUpdater(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (UPDATER_SENSITIVE_PATH_PATTERN.test(normalized)) return false;
  return REQUIRED_UPDATER_FILES.has(normalized);
}

function assertUpdaterSourceClean(updaterRoot) {
  const root = path.resolve(updaterRoot);
  const actual = listFiles(root).map(file => path.relative(root, file).split(path.sep).join('/'));
  for (const relative of actual) {
    if (UPDATER_SENSITIVE_PATH_PATTERN.test(relative)) throw new Error(`distribution_updater_sensitive_file_detected:${relative}`);
    if (!REQUIRED_UPDATER_FILES.has(relative)) throw new Error(`distribution_updater_file_not_allowlisted:${relative}`);
  }
  for (const required of REQUIRED_UPDATER_FILES) if (!actual.includes(required)) throw new Error(`distribution_updater_file_missing:${required}`);
  return { files: actual.length };
}

function copyRootUpdateLaunchers(sourceRoot, stagedRoot) {
  const rows = [];
  for (const name of REQUIRED_ROOT_UPDATE_LAUNCHERS) {
    const source = path.join(sourceRoot, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`distribution_update_launcher_missing:${name}`);
    const target = path.join(stagedRoot, name);
    const digest = sha256File(source);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    if (sha256File(target) !== digest || sha256File(source) !== digest) throw new Error(`distribution_update_launcher_changed:${name}`);
    rows.push({ path: name, sha256: digest });
  }
  return rows;
}

function assertRootUpdateLaunchers(stagedRoot) {
  for (const name of REQUIRED_ROOT_UPDATE_LAUNCHERS) {
    const filePath = path.join(stagedRoot, name);
    if (!fs.existsSync(filePath)) throw new Error(`distribution_update_launcher_missing:${name}`);
    if (/\.(?:sh|command)$/i.test(name)) {
      const bytes = fs.readFileSync(filePath);
      const source = bytes.toString('utf8');
      if (!source.startsWith('#!')) throw new Error(`distribution_update_launcher_shebang_missing:${name}`);
      if (/\r\n/.test(source)) throw new Error(`distribution_update_launcher_must_use_lf:${name}`);
    }
    if (/\.(?:bat|cmd)$/i.test(name)) {
      // cmd.exe 라벨 탐색과 한국어 코드페이지 표시를 위해 Windows 실행 파일은 CRLF만 허용한다.
      const source = fs.readFileSync(filePath).toString('binary');
      if ((source.match(/\n/g) || []).length !== (source.match(/\r\n/g) || []).length) throw new Error(`distribution_update_launcher_must_use_crlf:${name}`);
    }
  }
  return { launchers: REQUIRED_ROOT_UPDATE_LAUNCHERS.length };
}

function copyTreeAllowlisted(sourceDir, destinationDir, predicate, skipDependencies = false) {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  let copied = 0;
  let bytes = 0;
  const sourceFiles = [];
  for (const filePath of listFiles(source, skipDependencies)) {
    const relative = path.relative(source, filePath);
    if (!predicate(relative, filePath)) continue;
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const digest = sha256File(filePath);
    fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
    if (sha256File(target) !== digest || sha256File(filePath) !== digest) throw new Error(`distribution_source_changed:${relative}`);
    sourceFiles.push({ path: relative.split(path.sep).join('/'), sha256: digest });
    const size = fs.statSync(target).size;
    copied += 1;
    bytes += size;
  }
  return { copied, bytes, sourceFiles };
}

function assertTreeSourceUnchanged(sourceDir, sourceFiles, predicate, label = 'source', skipDependencies = false) {
  const current = listFiles(sourceDir, skipDependencies).filter(file => predicate(path.relative(sourceDir, file), file))
    .map(file => ({ path: path.relative(sourceDir, file).split(path.sep).join('/'), sha256: sha256File(file) }));
  if (JSON.stringify(current) !== JSON.stringify(sourceFiles)) throw new Error(`distribution_${label}_changed_during_build`);
}

function assertSourceUnchanged(sourceDir, sourceFiles) {
  return assertTreeSourceUnchanged(sourceDir, sourceFiles, shouldCopyProgram, 'source', true);
}

function runNodeProcess(args = [], cwd = programDir, options = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs || 180000,
    stdio: options.inherit ? 'inherit' : 'pipe',
    env: { ...process.env, ...(options.env || {}) }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`distribution_command_failed:${String(args[0] || 'node')}:${result.status}\n${[result.stdout,result.stderr].filter(Boolean).join('\n').trim()}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// Release artifact build (dev/release split).
//
// The readable PROGRAM/plugins/*.js stay exactly as they are: they are the development and
// debugging build, and the 164 contract tests in tests/ read their SOURCE TEXT. The
// minified artifacts built here are what a user actually installs.
//
// Design §11.2 asks for two builds from one code standard; this is where the second build
// is wired in. The transform is `tools/build_plugins.cjs --profile release`, which:
//   - re-assembles every host directive (//@name, //@arg ×N, //@allowed-ipc, //@update-url)
//     at the top of the artifact (a build that kept only the first 512 bytes silently
//     deleted the plugin's whole settings UI);
//   - minifies with the conservative option set from design §11.3;
//   - refuses to write output that fails `node --check`.
// The artifacts are then verified by tests/ultralight_release_runtime_test.cjs, which
// LOADS each one in a real host boundary instead of grepping its text.
function buildReleaseArtifacts(outDir) {
  // Minifying six plugins takes about 80 s on an idle 4-core host and more than the default
  // 180 s when the host is busy (e.g. a full regression run beside it); it is a build step, not a
  // hang, so it gets a build-sized limit.
  runNode(path.join(programDir, 'tools', 'build_plugins.cjs'),
    ['--profile', 'release', '--out', outDir], programDir, { timeoutMs: 600000 });
  const runtimeTest = path.join(programDir, 'tests', 'ultralight_release_runtime_test.cjs');
  runNodeProcess([runtimeTest], programDir, { timeoutMs: 240000, env: { ULTRALIGHT_ARTIFACT_DIR: outDir } });
  return { outDir, verified: true };
}

function runNode(scriptPath, args = [], cwd = programDir, options = {}) {
  return runNodeProcess([scriptPath, ...args], cwd, options);
}

function assertCanonicalPlugins(stagedRoot) {
  const canonicalDir = path.join(stagedRoot, 'PROGRAM', 'plugins');
  const canonical = listFiles(canonicalDir).filter(filePath => /\.js$/i.test(filePath));
  if (canonical.length !== REQUIRED_PLUGIN_IDS.size) {
    throw new Error(`distribution_plugin_count_invalid:canonical=${canonical.length}`);
  }
  const seen = new Set();
  for (const filePath of canonical) {
    const source = fs.readFileSync(filePath, 'utf8');
    const pluginId = source.match(/^\/\/@name\s+(.+)$/m)?.[1]?.trim();
    if (!pluginId) throw new Error(`distribution_plugin_id_missing:${filePath}`);
    if (seen.has(pluginId)) throw new Error(`distribution_plugin_id_duplicate:${pluginId}`);
    if (!REQUIRED_PLUGIN_IDS.has(pluginId)) throw new Error(`distribution_plugin_id_unexpected:${pluginId}`);
    seen.add(pluginId);
  }
  for (const required of REQUIRED_PLUGIN_IDS) {
    if (!seen.has(required)) throw new Error(`distribution_plugin_id_required:${required}`);
  }
  return { files: canonical.length };
}

function createCleanData(stagedRoot) {
  const stagedProgram = path.join(stagedRoot, 'PROGRAM');
  const stagedData = path.join(stagedRoot, 'DATA');
  runNode(path.join(stagedProgram, 'tools', 'prepare_data.cjs'), [
    '--program-dir', stagedProgram,
    '--data-dir', stagedData,
    '--fresh-distribution'
  ], stagedProgram);
  const keepDirectories = [
    'backups/auto',
    'backups/manual',
    'backups/pre-migration',
    'backups/deleted-scopes',
    'backups/recovery-quarantine',
    'logs',
    'migrations',
    ...ACTIVE_NAMESPACES.map(namespace => `stores/${namespace}`)
  ];
  for (const relative of keepDirectories) {
    const directory = path.join(stagedData, ...relative.split('/'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '.keep.txt'), 'This directory is intentionally empty in a clean Librarian System distribution.\n', { encoding: 'utf8', flag: 'wx' });
  }
  fs.writeFileSync(path.join(stagedData, '이_DATA_폴더를_통째로_백업하세요.txt'), [
    'Librarian System DATA',
    '',
    '이 폴더는 사용자 기억, 백업, 로그와 자동 생성되는 로컬 인증 자료를 보관합니다.',
    '백업할 때는 서버를 먼저 종료한 뒤 DATA 폴더 전체를 복사하세요.',
    '이 깨끗한 배포본에는 데이터베이스, 토큰, scope catalog, 로그 또는 기존 백업이 포함되어 있지 않습니다.',
    ''
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });
  return stagedData;
}


function assertCrossPlatformScripts(programRoot) {
  const scripts = listFiles(programRoot).filter(filePath => /\.(?:sh|command)$/i.test(filePath));
  if (!scripts.length) throw new Error('distribution_cross_platform_scripts_missing');
  for (const filePath of scripts) {
    const bytes = fs.readFileSync(filePath);
    const source = bytes.toString('utf8');
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error(`distribution_shell_script_has_utf8_bom:${filePath}`);
    }
    if (!source.startsWith('#!')) throw new Error(`distribution_shell_script_shebang_missing:${filePath}`);
    if (/\r\n/.test(source)) throw new Error(`distribution_shell_script_must_use_lf:${filePath}`);
  }
  return { scripts: scripts.length };
}

function verifyChecksumFile(stagedRoot) {
  const root = path.resolve(stagedRoot);
  const checksumPath = path.join(root, 'SHA256SUMS.txt');
  const rows = fs.readFileSync(checksumPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const expectedFiles = listFiles(root).filter(filePath => path.resolve(filePath) !== path.resolve(checksumPath));
  const seen = new Set();
  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64})  \.\/(.+)$/);
    if (!match) throw new Error(`distribution_checksum_row_invalid:${row.slice(0, 160)}`);
    const relative = match[2].replace(/\\/g, '/');
    if (relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`distribution_checksum_path_unsafe:${relative}`);
    }
    if (seen.has(relative)) throw new Error(`distribution_checksum_duplicate_path:${relative}`);
    seen.add(relative);
    const filePath = path.resolve(root, ...relative.split('/'));
    if (!isWithin(root, filePath) || !fs.existsSync(filePath)) throw new Error(`distribution_checksum_file_missing:${relative}`);
    if (sha256File(filePath) !== match[1]) throw new Error(`distribution_checksum_digest_mismatch:${relative}`);
  }
  if (rows.length !== expectedFiles.length) {
    throw new Error(`distribution_checksum_file_count_mismatch:${rows.length}!=${expectedFiles.length}`);
  }
  return { files: rows.length };
}

function assertArchivePrivacy(entries, topLevelName) {
  const prefix = `${topLevelName}/`;
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) throw new Error(`distribution_archive_root_invalid:${entry.name}`);
    const relative = entry.name.slice(prefix.length);
    if (PRIVATE_DATA_PATTERN.test(`/${relative.replace(/^DATA\//i, '')}`) && /^DATA\//i.test(relative)) {
      throw new Error(`distribution_archive_private_data_detected:${entry.name}`);
    }
    if (/^PROGRAM\/_runtime\/(?!README\.txt$)/i.test(relative)) {
      throw new Error(`distribution_archive_embedded_runtime_detected:${entry.name}`);
    }
    if (/^UPDATER\/logs\/(?!README\.txt$)/i.test(relative) || /^UPDATER\/update-state\.json$/i.test(relative)) {
      throw new Error(`distribution_archive_updater_runtime_detected:${entry.name}`);
    }
    if (/^(?:\.update|PROGRAM\.next|DATA\.next|PROGRAM\.rollback|DATA\.rollback)(?:\/|$)/i.test(relative)) {
      throw new Error(`distribution_archive_update_worktree_detected:${entry.name}`);
    }
    if (/\.(?:sh|command)$/i.test(relative) && (entry.mode & 0o111) === 0) {
      throw new Error(`distribution_archive_script_not_executable:${entry.name}`);
    }
  }
}

function safeRemoveTemporary(temporaryRoot, outputDir) {
  const resolved = path.resolve(temporaryRoot);
  const expectedParent = path.resolve(outputDir);
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('.librarian-build-')) {
    throw new Error(`distribution_refused_to_remove_unowned_temporary:${resolved}`);
  }
  // Windows releases file handles asynchronously, so a staged test that just
  // exited can still hold the tree for a moment. Retry instead of failing a
  // finished build on temporary-directory hygiene.
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

function snapshotAllowlistedTree(rootDir, predicate, skipDependencies = false) {
  const root=path.resolve(rootDir);
  return listFiles(root,skipDependencies).filter(file=>predicate(path.relative(root,file),file))
    .map(file=>({path:path.relative(root,file).split(path.sep).join('/'),sha256:sha256File(file)}));
}

function runReleaseSmokeFromSource() {
  const programSnapshot=snapshotAllowlistedTree(programDir,shouldCopySourceProgram,true);
  const updaterRoot=path.join(packageRoot,'UPDATER');
  const updaterSnapshot=snapshotAllowlistedTree(updaterRoot,shouldCopyUpdater);
  runNode(path.join(programDir,'tools','check_sdk_sync.cjs'),[],programDir);
  for (const file of ['sync_execution_contract.cjs', 'sync_libra_read_context.cjs',
    'sync_flashback_consent_profile.cjs', 'sync_hayaku_consent_profile.cjs']) {
    runNode(path.join(programDir, 'tools', file), ['--check'], programDir);
  }
  runNode(path.join(programDir, 'tools', 'sync_gradia_ranked_evidence.cjs'), [], programDir);
  const smokeEnv = {};
  const { ensureBuildSupportDependencies } = require('./ensure_build_support.cjs');
  const support = ensureBuildSupportDependencies({ programDir });
  if (!support?.modulesDir) throw new Error('distribution_build_support_unavailable');
  smokeEnv.GRADIA_TOOLCHAIN_ROOT = support.modulesDir;
  smokeEnv.NODE_PATH = process.env.NODE_PATH || support.modulesDir;
  const smoke=runNodeProcess(['--test','--test-concurrency=4',...RELEASE_SMOKE_TESTS.map(name=>path.join(programDir,'tests',name))],programDir,{timeoutMs:600000,env:smokeEnv});
  assertTreeSourceUnchanged(programDir,programSnapshot,shouldCopySourceProgram,'program_source_after_smoke',true);
  assertTreeSourceUnchanged(updaterRoot,updaterSnapshot,shouldCopyUpdater,'updater_source_after_smoke');
  return smoke;
}

function preflightSourceReleaseGuides(sourcePackageRoot = packageRoot) {
  const sourceRoot = path.resolve(sourcePackageRoot);
  const metadata = readReleaseMetadata(path.join(sourceRoot, 'PROGRAM'));
  // renderGuide validates each generated inventory without writing its returned string. This must
  // run before release smoke so malformed source metadata fails before any staging or artifact work.
  for (const relative of GUIDES) {
    const absolute = path.join(sourceRoot, ...relative.split('/'));
    renderGuide(fs.readFileSync(absolute, 'utf8'), metadata);
  }
  return metadata;
}

function captureManifestDeclarationBindings() {
  const files=Object.values(PLUGINS).map(([file])=>file);
  return Object.freeze(Object.fromEntries(files.map(file=>{
    const relative=`plugins/${file}`,absolute=path.join(programDir,'plugins',file);
    if(!fs.lstatSync(absolute).isFile())throw new Error(`distribution_declaration_source_invalid:${relative}`);
    return [relative,sha256File(absolute)];
  })));
}

function refreshStagedMetadata(stagedRoot, declarationBindings, qualification, transformBindings = null) {
  const stagedProgram=path.join(stagedRoot,'PROGRAM');
  if(JSON.stringify(captureManifestDeclarationBindings())!==JSON.stringify(declarationBindings))throw new Error('distribution_declaration_source_changed');
  runNode(path.join(programDir,'tools','update_manifest.cjs'),[],programDir,{env:{
    LIBRARIAN_PROGRAM_ROOT:stagedProgram,
    LIBRARIAN_PACKAGE_QUALIFICATION:qualification,
    LIBRARIAN_MANIFEST_DECLARATION_ROOT:programDir,
    LIBRARIAN_MANIFEST_DECLARATION_BINDINGS:JSON.stringify(declarationBindings),
    LIBRARIAN_MANIFEST_TRANSFORM_BINDINGS:transformBindings ? JSON.stringify(transformBindings) : ''
  }});
  const releasePolicy=readReleasePolicy(stagedProgram);
  const updateManifest=writeUpdateManifest(stagedRoot,{qualification});
  runNode(path.join(programDir,'tools','update_checksums.cjs'),['--distribution'],programDir,{env:{LIBRARIAN_PACKAGE_ROOT:stagedRoot}});
  return {releasePolicy,updateManifest,checksumCheck:verifyChecksumFile(stagedRoot)};
}

function buildDistribution(options = {}) {
  const profile=options.profile || 'release';
  if (!['release','source'].includes(profile)) throw new Error(`distribution_profile_invalid:${profile}`);
  const isSource=profile==='source';
  const qualification=options.qualification||'publication_gate';
  if(!['publication_gate','offline_candidate'].includes(qualification))throw Error('distribution_qualification_invalid:'+qualification);
  const offline=qualification==='offline_candidate';
  const version=fs.readFileSync(path.join(programDir,'VERSION.txt'),'utf8').trim();
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error(`distribution_program_version_invalid:${version}`);
  const outputDir=path.resolve(options.outputDir || path.join(DEFAULT_OUTPUT_BASE,`v${version}`));
  if(isWithin(packageRoot,outputDir))throw new Error(`distribution_output_must_be_outside_source_package:${outputDir}`);
  fs.mkdirSync(outputDir,{recursive:true});
  const canonicalPackageRoot=fs.realpathSync.native(packageRoot),canonicalOutputDir=fs.realpathSync.native(outputDir);
  if(isWithin(canonicalPackageRoot,canonicalOutputDir))throw new Error(`distribution_output_must_be_outside_source_package:${canonicalOutputDir}`);
  const buildId=new Date().toISOString().replace(/[-:.]/g,'')+'-'+crypto.randomBytes(4).toString('hex');
  const artifactBase=`Librarian-System-${version}${isSource?'-Source':''}${offline?'-Offline-Candidate':''}`;
  const topLevelName=artifactBase;
  const archivePath=path.join(outputDir,offline?artifactBase+'.zip':isSource?expectedSourceAssetName(version):expectedAssetName(version));
  const reportPath=path.join(outputDir,`${artifactBase}.build-report.json`);
  const releaseInfoPath=path.join(outputDir,isSource?`${artifactBase}.PACKAGE_INFO.txt`:`${artifactBase}.GITHUB_RELEASE_INFO.txt`);
  const failureReportPath=path.join(outputDir,`${artifactBase}.failed-${buildId}.json`);
  if([archivePath,reportPath,releaseInfoPath].some(fs.existsSync))throw new Error(`distribution_artifact_already_exists:${artifactBase}`);
  const temporaryRoot=fs.mkdtempSync(path.join(outputDir,'.librarian-build-')),stagedRoot=path.join(temporaryRoot,topLevelName);
  let success=false,phase='source_preflight';
  try{
    preflightSourceReleaseGuides(packageRoot);
    if (isSource) { verifySourceFixtureBytes(programDir); }
    if (!offline) {
      phase='build_support';
      const { ensureBuildSupportDependencies } = require('./ensure_build_support.cjs');
      ensureBuildSupportDependencies({ programDir, installIfMissing: true, onProgress: message => process.stdout.write(message+'\n') });
    }
    const declarationBindings=captureManifestDeclarationBindings();
    phase='release_smoke';
    // Candidate packaging verifies source, syntax, SDK sync, inventory, bytes and privacy.
    // It never claims the full publication gate. The default path retains that gate unchanged.
    const smoke=offline?runNode(path.join(programDir,'tools/check_sdk_sync.cjs'),[],programDir):runReleaseSmokeFromSource();
    phase='stage';fs.mkdirSync(stagedRoot);
    const programPredicate=isSource?shouldCopySourceProgram:shouldCopyRuntimeProgram;
    const stagingPredicate=isSource?programPredicate:relative=>programPredicate(relative)&&!relative.split(path.sep).join('/').startsWith('plugins/');
    const copiedProgram=copyTreeAllowlisted(programDir,path.join(stagedRoot,'PROGRAM'),stagingPredicate,true);
    // Pin the bytes actually copied, not only their earlier source observation.
    if(isSource){verifySourceFixtureBytes(path.join(stagedRoot,'PROGRAM'));}
    const sourceUpdater=path.join(packageRoot,'UPDATER');assertUpdaterSourceClean(sourceUpdater);
    const copiedUpdater=copyTreeAllowlisted(sourceUpdater,path.join(stagedRoot,'UPDATER'),shouldCopyUpdater);
    const copiedLaunchers=copyRootUpdateLaunchers(packageRoot,stagedRoot);
    const guideSource=path.join(packageRoot,REQUIRED_ROOT_FILE),guideHash=sha256File(guideSource);
    fs.copyFileSync(guideSource,path.join(stagedRoot,REQUIRED_ROOT_FILE),fs.constants.COPYFILE_EXCL);
    if(sha256File(path.join(stagedRoot,REQUIRED_ROOT_FILE))!==guideHash)throw new Error('distribution_source_guide_changed');
    // Dev/release split: replace the readable plugins with their minified artifacts in the
    // release profile only. The SOURCE profile keeps the readable build, because that
    // artifact is the developer package. The swap happens on the STAGED tree, so the
    // readable source is never modified (assertTreeSourceUnchanged still holds below).
    let pluginArtifacts=null,transformBindings=null;
    if(!isSource){
      phase='release_plugins';
      const artifactDir=path.join(temporaryRoot,'release-plugins');
      buildReleaseArtifacts(artifactDir);
      const emitted=JSON.parse(fs.readFileSync(path.join(artifactDir,'ultralight-build-report.json')));
      transformBindings={schema:'librarian.plugin-transform-bindings.v1',profile:'release',plugins:{}};
      const stagedPluginDir=path.join(stagedRoot,'PROGRAM','plugins');
      fs.mkdirSync(stagedPluginDir,{recursive:true});
      let replaced=0,sourceBytes=0,releaseBytes=0;
      for(const [filename] of Object.values(PLUGINS)){
        const file=path.join(stagedPluginDir,filename);
        const artifact=path.join(artifactDir,path.basename(file));
        if(!fs.existsSync(artifact))throw new Error(`distribution_release_artifact_missing:${path.basename(file)}`);
        const relative=`plugins/${filename}`,row=emitted.rows?.find(item=>item.file===relative);
        if(emitted.profile!=='release'||!row?.wrote||row.variant!=='Min'||row.minified!==true
          ||row.sourceSha256!==declarationBindings[relative]||row.artifactSha256!==sha256File(artifact)) {
          throw new Error(`distribution_release_transform_binding_invalid:${filename}`);
        }
        transformBindings.plugins[relative]={sourceSha256:row.sourceSha256,artifactSha256:row.artifactSha256};
        sourceBytes+=fs.statSync(path.join(programDir,'plugins',filename)).size;releaseBytes+=fs.statSync(artifact).size;
        fs.copyFileSync(artifact,file);replaced+=1;
      }
      if(replaced!==REQUIRED_PLUGIN_IDS.size)throw new Error(`distribution_release_artifact_count:${replaced}`);
      pluginArtifacts={profile:'release',replaced,sourceBytes,releaseBytes,reductionPercent:Number((100*(sourceBytes-releaseBytes)/sourceBytes).toFixed(1))};
    } else {
      phase='source_plugins';
      const artifactDir=path.join(temporaryRoot,'source-plugins');
      const sourceBuild=runNode(path.join(stagedRoot,'PROGRAM/tools/build_plugins.cjs'),['--profile','source','--out',artifactDir],path.join(stagedRoot,'PROGRAM'));
      const buildReport=JSON.parse(fs.readFileSync(path.join(artifactDir,'ultralight-build-report.json')));
      const stagedPluginDir=path.join(stagedRoot,'PROGRAM/plugins');
      for(const row of buildReport.rows)fs.copyFileSync(path.join(artifactDir,path.basename(row.file)),path.join(stagedPluginDir,path.basename(row.file)));
      if(buildReport.rows.length!==REQUIRED_PLUGIN_IDS.size||buildReport.rows.some(row=>!row.wrote||row.variant!=='Full'))throw Error('distribution_source_artifact_count');
      pluginArtifacts={profile:'source',replaced:buildReport.rows.length,note:'all six Full artifacts built from staged source'};
    }
    phase='metadata';const releaseMetadata=syncReleaseGuides(stagedRoot);
    const stagedData=createCleanData(stagedRoot),dataCheck=assertPristineDistributionData(stagedData);
    const scriptCheck=assertCrossPlatformScripts(path.join(stagedRoot,'PROGRAM')),updaterScriptCheck=assertRootUpdateLaunchers(stagedRoot);
    assertUpdaterSourceClean(path.join(stagedRoot,'UPDATER'));const pluginCheck=assertCanonicalPlugins(stagedRoot);
    const stagedProgram=path.join(stagedRoot,'PROGRAM');
    phase='sdk_and_syntax';
    const syntaxTargets=['server/server.cjs','tools/platform_launcher.cjs','tools/zip_writer.cjs','tools/runtime_release_validation.cjs'];
    if(isSource)syntaxTargets.push('tools/build_distribution.cjs','tools/release_builder_ui.cjs','tools/release_version.cjs','tools/ensure_build_support.cjs');
    for(const relative of syntaxTargets){const file=path.join(stagedProgram,...relative.split('/'));if(fs.existsSync(file))runNodeProcess(['--check',file],stagedProgram);}
    for(const file of listFiles(path.join(stagedProgram,'plugins')).filter(file=>/\.js$/i.test(file)))runNodeProcess(['--check',file],stagedProgram);
    for(const file of listFiles(path.join(stagedRoot,'UPDATER')).filter(file=>/\.cjs$/i.test(file)))runNodeProcess(['--check',file],stagedProgram);
    phase='manifest_and_checksums';const {releasePolicy,updateManifest,checksumCheck}=refreshStagedMetadata(stagedRoot,declarationBindings,qualification,transformBindings);
    if(updateManifest.assetName!==expectedAssetName(version)||updateManifest.updatePolicy!==releasePolicy.updatePolicy)throw new Error('distribution_update_manifest_contract_mismatch');
    assertPristineDistributionData(stagedData);verifyChecksumFile(stagedRoot);
    if(isSource){verifySourceFixtureBytes(stagedProgram);}
    phase='archive';const zip=createZipFromDirectory(stagedRoot,archivePath,{rootName:topLevelName});
    const verification=verifyZipAgainstDirectory(archivePath,stagedRoot,{rootName:topLevelName}),entries=readZipEntries(archivePath);
    assertArchivePrivacy(entries,topLevelName);
    let runtimeDependencyClosure=null;
    if(!isSource){
      phase='extracted_runtime_dependencies';
      const check=runNode(path.join(programDir,'tools/verify_runtime_archive.cjs'),[archivePath,path.join(temporaryRoot,'verified-runtime')],temporaryRoot,{env:{NODE_PATH:''}});
      runtimeDependencyClosure=JSON.parse(check.stdout.trim());
    }
    assertTreeSourceUnchanged(programDir,copiedProgram.sourceFiles,stagingPredicate,isSource?'source_program':'runtime_program',true);
    assertTreeSourceUnchanged(sourceUpdater,copiedUpdater.sourceFiles,shouldCopyUpdater,'updater_source');
    for(const row of copiedLaunchers)if(sha256File(path.join(packageRoot,row.path))!==row.sha256)throw new Error(`distribution_update_launcher_changed_during_build:${row.path}`);
    if(sha256File(guideSource)!==guideHash)throw new Error('distribution_source_guide_changed');
    if(JSON.stringify(readReleaseMetadata(stagedProgram))!==JSON.stringify(releaseMetadata))throw new Error('distribution_staged_plugins_changed');
    const report={schema:'librarian-system.distribution-build-report.v1',productName:PRODUCT_NAME,packageVersion:version,profile,
      qualification,...(offline?{fullReleaseGatePassed:false}:{}),publicationSmokePassed:!offline,updaterEligible:!isSource&&!offline,pluginVersions:Object.fromEntries(Object.entries(releaseMetadata.plugins).map(([owner,row])=>[owner,row.version])),
      pluginSha256:Object.fromEntries(Object.entries(releaseMetadata.plugins).map(([owner,row])=>[owner,row.sha256])),sourceUnchangedVerified:true,
      guidesGeneratedFromSource:true,generatedAt:new Date().toISOString(),buildId,artifact:path.basename(archivePath),releaseTag:`v${version}`,
      releaseAssetContract:isSource?null:'librarian.update-manifest.v1',officialUpdaterAsset:expectedAssetName(version),sourceAsset:expectedSourceAssetName(version),
      updatePolicy:updateManifest.updatePolicy,minimumSourceVersion:updateManifest.minimumSourceVersion,updateManifestSha256:sha256File(path.join(stagedRoot,'update-manifest.json')),
      archiveSha256:verification.archiveSha256,archiveBytes:zip.bytes,archiveFiles:verification.files,embeddedRuntime:false,sourceDataReadOrCopied:false,
      cleanDataFiles:dataCheck.files,crossPlatformScripts:scriptCheck.scripts,updateLaunchers:updaterScriptCheck.launchers,copiedUpdaterFiles:copiedUpdater.copied,
      copiedProgramFiles:copiedProgram.copied,packagedPluginFiles:pluginCheck.files,pluginInstallPath:'PROGRAM/plugins',topLevelPluginsFolder:false,
      pluginBuild:pluginArtifacts,runtimeDependencyClosure,
      ...(offline?{status:'offline_candidate',publicationReady:false,fullReleaseGate:'NOT_RUN',actualHostQualification:'NOT_RUN'}:{}),
      checksumFilesVerified:checksumCheck.files,unixExecutePermissionsVerified:true,utf8EntryNamesVerified:true,privateDataPatternsRejected:true,
      testsRun:true,testProfile:offline?'offline_candidate_contents':'release_smoke',releaseSmokeTests:offline?[]:[...RELEASE_SMOKE_TESTS],releaseSmokeOutput:smoke.stdout,fullRegressionRunByBuilder:false,
      fullRegressionRequiredBeforePublication:true};
    fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',flag:'wx'});
    const info=isSource?[
      `Package: Librarian System developer source v${version}`,...(offline?['Qualification: offline_candidate; publication gate NOT_RUN']:[]),`Artifact: ${path.basename(archivePath)}`,'Updater target: NO',`Official updater asset: ${expectedAssetName(version)}`,
      `SHA-256: ${verification.archiveSha256}`,'']:[
      ...(offline?['Qualification: offline_candidate; publication gate NOT_RUN; updater eligible NO']:[]),
      'Repository: https://github.com/rusinus12-droid/Librarian-System',`Tag: v${version}`,`Release title: Librarian System v${version}`,
      `Upload asset: ${path.basename(archivePath)}`,`SHA-256: ${verification.archiveSha256}`,`Update policy: ${updateManifest.updatePolicy}`,''];
    fs.writeFileSync(releaseInfoPath,info.join('\n'),{encoding:'utf8',flag:'wx'});success=true;
    return {archivePath,reportPath,releaseInfoPath,report};
  }catch(error){fs.writeFileSync(failureReportPath,JSON.stringify({schema:'librarian-system.distribution-build-failure.v1',packageVersion:version,profile,phase,error:String(error?.stack||error),generatedAt:new Date().toISOString(),artifactProduced:false},null,2)+'\n',{flag:'wx'});throw error;}
  finally{
    let cleanupError=null;try{if(fs.existsSync(temporaryRoot))safeRemoveTemporary(temporaryRoot,outputDir);}catch(error){cleanupError=error;}
    if(!success||cleanupError){for(const file of [archivePath,reportPath,releaseInfoPath])try{fs.rmSync(file,{force:true});}catch(_){} if(success&&cleanupError)throw cleanupError;}
  }
}


const VERSION_TRANSACTION_RELATIVE_FILES = Object.freeze([
  'PROGRAM/VERSION.txt',
  'PROGRAM/server/server.cjs',
  'PROGRAM/release-policy.json',
  'PROGRAM/server/portable/logical_migration.cjs',
  'PROGRAM/server/portable/transfer_manager.cjs',
  'PROGRAM/tools/portable_export_stopped.cjs',
  '0_설치_안내.txt',
  'PROGRAM/처음_읽어주세요.txt',
  'PROGRAM/PACKAGE_CONTENTS.txt',
  'README.md',
  'PROGRAM/program-manifest.json',
  'PROGRAM/docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json',
  'update-manifest.json',
  'SHA256SUMS.txt'
]);

function snapshotVersionTransactionFiles(root = packageRoot) {
  const base = path.resolve(root);
  return VERSION_TRANSACTION_RELATIVE_FILES.filter(relative => fs.existsSync(path.join(base, ...relative.split('/')))).map(relative => {
    const absolute = path.join(base, ...relative.split('/'));
    return { relative, absolute, bytes: fs.readFileSync(absolute), mode: fs.statSync(absolute).mode };
  });
}

function restoreVersionTransactionFiles(snapshot) {
  for (const row of snapshot) {
    fs.writeFileSync(row.absolute, row.bytes);
    try { fs.chmodSync(row.absolute, row.mode); } catch (_) {}
  }
}

function refreshSourceReleaseMetadata(qualification) {
  syncReleaseGuides(packageRoot);
  syncRepositoryReadme(packageRoot);
  if (fs.existsSync(path.join(packageRoot, 'update-manifest.json'))) {
    writeUpdateManifest(packageRoot, { qualification, overwrite: true });
  }
  runNode(path.join(programDir, 'tools', 'update_manifest.cjs'), [], programDir, {
    env: { LIBRARIAN_PACKAGE_QUALIFICATION: qualification }
  });
  runNode(path.join(programDir, 'tools', 'update_checksums.cjs'), [], programDir);
}

function removeBuildOutputs(result) {
  if (!result) return;
  for (const file of [result.archivePath, result.reportPath, result.releaseInfoPath]) {
    try { if (file) fs.rmSync(file, { force: true }); } catch (_) {}
  }
}

function buildRelease(options = {}) {
  const profile = options.profile || 'release';
  if (!['release', 'source', 'all'].includes(profile)) throw new Error(`distribution_profile_invalid:${profile}`);
  const qualification = options.qualification || process.env.LIBRARIAN_PACKAGE_QUALIFICATION || 'publication_gate';
  if (!['publication_gate', 'offline_candidate'].includes(qualification)) throw new Error(`distribution_qualification_invalid:${qualification}`);
  const currentVersion = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim();
  const snapshot = options.version ? snapshotVersionTransactionFiles(packageRoot) : null;
  const completed = [];
  try {
    let versionChange = null;
    if (options.version) {
      const targetVersion = validateTargetVersion(currentVersion, options.version);
      versionChange = applyReleaseVersion(packageRoot, targetVersion);
      refreshSourceReleaseMetadata(qualification);
      const metadata = readReleaseMetadata(programDir);
      if (metadata.packageVersion !== targetVersion) throw new Error('distribution_version_refresh_mismatch');
    }
    const profiles = profile === 'all' ? ['release', 'source'] : [profile];
    const results = {};
    for (const selected of profiles) {
      const result = buildDistribution({ outputDir: options.outputDir, profile: selected, qualification });
      result.versionChange = versionChange;
      results[selected] = result;
      completed.push(result);
    }
    return profile === 'all' ? { profile: 'all', results, versionChange } : results[profile];
  } catch (error) {
    for (const result of completed) removeBuildOutputs(result);
    if (snapshot) restoreVersionTransactionFiles(snapshot);
    throw error;
  }
}


function buildOfflineCandidate(options = {}) {
  if (options.version) throw Error('offline_candidate_version_change_not_supported');
  return buildRelease({ ...options, qualification: 'offline_candidate' });
}
function main() {
  const result = buildRelease(parseArgs());
  process.stdout.write(`[LIBRARIAN SYSTEM] Distribution ready\n`);
  const rows = result.profile === 'all' ? Object.values(result.results) : [result];
  for (const row of rows) {
    process.stdout.write(`Profile: ${row.report.profile}\n`);
    process.stdout.write(`ZIP: ${row.archivePath}\n`);
    process.stdout.write(`SHA256: ${row.report.archiveSha256}\n`);
    process.stdout.write(`Report: ${row.reportPath}\n`);
    process.stdout.write(`Info: ${row.releaseInfoPath}\n`);
  }
}


if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`[LIBRARIAN SYSTEM DISTRIBUTION BUILDER] ${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildOfflineCandidate,
  parseArgs,
  shouldCopyProgram,
  shouldCopySourceProgram,
  verifySourceFixtureBytes,
  shouldCopyRuntimeProgram,
  shouldCopyUpdater,
  assertUpdaterSourceClean,
  assertRootUpdateLaunchers,
  assertPristineDistributionData,
  assertCrossPlatformScripts,
  verifyChecksumFile,
  assertArchivePrivacy,
  preflightSourceReleaseGuides,
  assertTreeSourceUnchanged,
  assertSourceUnchanged,
  buildDistribution,
  buildRelease,
  compareVersions,
  nextPatchVersion,
  validateTargetVersion,
  applyReleaseVersion
};
