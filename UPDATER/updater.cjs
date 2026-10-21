'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
// Recovery must load without PROGRAM: release/archive modules are lazy-loaded
// only after the pending journal has been resolved.
const { withUpdateLock } = require('./core/lock.cjs');
const { assertRuntime, validateRoot, detectPlatform } = require('./runtime.cjs');
const { applyProgramOnly, recoverInterruptedProgramOnly } = require('./core/program-only.cjs');
const { applyMigrationRequired, recoverInterruptedMigrationRequired } = require('./core/migration-required.cjs');
const { readJournal, isTerminal } = require('./core/journal.cjs');

const CODE_ROOT = path.resolve(__dirname, '..');
const ROOT = CODE_ROOT;
const MAX_RELEASE_BYTES = 2 * 1024 ** 3;

function currentVersion(rootDir = ROOT) {
  return fs.readFileSync(path.join(path.resolve(rootDir), 'PROGRAM', 'VERSION.txt'), 'utf8').trim().replace(/^v/i, '');
}

function platform() { return detectPlatform(); }

function makeLogger(rootDir = ROOT) {
  const logDir = path.join(path.resolve(rootDir), 'UPDATER', 'logs');
  return function logLineForRoot(message) {
    const text = String(message);
    const line = `[${new Date().toISOString()}] ${text}`;
    console.log(text);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'latest.log'), `${line}\n`);
  };
}
const logLine = makeLogger(ROOT);

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    check: false,
    apply: false,
    recover: false,
    releaseZip: null,
    expectedSha256: null,
    targetRoot: null,
    installUpdater: false,
    userUpdate: false,
    localUpdate: false,
    zipPrompt: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--check') result.check = true;
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--recover') result.recover = true;
    else if (arg === '--install-updater') result.installUpdater = true;
    else if (arg === '--user-update') result.userUpdate = true;
    else if (arg === '--local-update') result.localUpdate = true;
    else if (arg === '--target-root') {
      const value = argv[++index];
      if (!value || String(value).startsWith('--')) throw new Error('target_root_value_required');
      result.targetRoot = path.resolve(value);
    } else if (arg === '--release-zip') {
      const value = argv[++index];
      if (!value || String(value).startsWith('--')) throw new Error('release_zip_value_required');
      result.releaseZip = path.resolve(value);
    } else if (arg === '--expected-sha256') {
      const value = String(argv[++index] || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('expected_sha256_invalid');
      result.expectedSha256 = value;
    } else throw new Error(`unknown_updater_argument:${arg}`);
  }
  return result;
}

async function downloadRelease(url, destination, expectedSha256) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Librarian-System-Updater' } });
  if (!response.ok || !response.body) throw new Error(`download_http_${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_RELEASE_BYTES) throw new Error('release_download_too_large');
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_RELEASE_BYTES) return callback(new Error('release_download_too_large'));
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(response.body, meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const digest = hash.digest('hex');
    if (expectedSha256 && digest !== expectedSha256) throw new Error('release_sha256_mismatch');
    await fsp.rm(destination, { force: true });
    await fsp.rename(temporary, destination);
    return { path: destination, bytes, sha256: digest };
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function prepareFromLocalZip({ rootDir = ROOT, zipPath, expectedSha256 = null }) {
  const root = path.resolve(rootDir);
  const { parseAssetVersion, sha256File } = require('./update_common.cjs');
  const { prepareReleaseCandidate } = require('./release_archive.cjs');
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) throw new Error('release_zip_not_found');
  const targetVersion = parseAssetVersion(path.basename(zipPath));
  if (!targetVersion) throw new Error('release_zip_filename_contract_invalid');
  const digest = await sha256File(zipPath);
  if (expectedSha256 && digest !== expectedSha256) throw new Error('release_sha256_mismatch');
  return prepareReleaseCandidate({
    archivePath: zipPath,
    workRoot: path.join(root, '.update'),
    targetVersion,
    currentVersion: currentVersion(root),
    expectedArchiveSha256: expectedSha256 || digest
  });
}

async function recoverInterruptedUpdate({ rootDir = ROOT, logger = logLine } = {}) {
  const root = path.resolve(rootDir);
  const journal = readJournal(path.join(root, 'UPDATER', 'update-state.json'));
  if (!journal || isTerminal(journal)) return { recovered: false, reason: 'no_pending_update', journal };
  if (journal.policy === 'program_only') return recoverInterruptedProgramOnly({ rootDir: root, logger });
  if (journal.policy === 'migration_required') return recoverInterruptedMigrationRequired({ rootDir: root, logger });
  throw new Error(`unsupported_recovery_policy:${journal.policy}`);
}

async function applyReceipt({ rootDir = ROOT, receipt, logger = logLine } = {}) {
  const root = path.resolve(rootDir);
  if (receipt?.updatePolicy === 'program_only') return applyProgramOnly({ rootDir: root, receipt, logger });
  if (receipt?.updatePolicy === 'migration_required') return applyMigrationRequired({ rootDir: root, receipt, logger });
  throw new Error(`apply_policy_not_supported_phase4:${receipt?.updatePolicy || 'missing'}`);
}


function friendlyErrorMessage(error) {
  const code = String(error?.message || error || 'unknown_error');
  if (/^download_http_/.test(code) || code === 'fetch_unavailable' || code === 'AbortError') {
    return '업데이트 파일을 다운로드하지 못했습니다. 인터넷 연결과 GitHub 접속 상태를 확인한 뒤 다시 시도해 주세요.';
  }
  if (code === 'release_sha256_mismatch' || code === 'github_release_asset_digest_mismatch' || code.includes('checksum')) {
    return '업데이트 파일 무결성 검증에 실패했습니다. 손상되었거나 올바른 공식 배포본이 아닐 수 있습니다.';
  }
  if (code === 'prepared_candidate_missing') {
    return '설치할 업데이트가 준비되지 않았습니다. 업데이트 메뉴에서 처음부터 다시 시작해 주세요.';
  }
  if (code === 'release_zip_filename_contract_invalid') {
    return '선택한 파일 이름이 공식 배포 형식(Librarian-System-버전.zip)이 아닙니다. 내려받은 원래 이름으로 되돌린 뒤 다시 선택해 주세요.';
  }
  if (code.startsWith('release_zip_picker_unavailable')) {
    return '이 환경에서는 파일 선택 창을 열 수 없습니다. 메뉴에서 ZIP 경로를 직접 입력하거나 --release-zip 옵션을 사용해 주세요.';
  }
  if (code === 'release_zip_not_found') return '선택한 업데이트 ZIP 파일을 찾지 못했습니다.';
  if (code === 'official_release_asset_missing' || code === 'official_release_asset_url_missing' || code === 'github_release_asset_digest_missing') {
    return '공식 Release에서 필요한 업데이트 파일 또는 검증 정보를 찾지 못했습니다.';
  }
  if (code === 'manual_update_required' || code.startsWith('apply_policy_not_supported')) {
    return '이 버전은 자동 업데이트로 설치할 수 없습니다. 배포 안내를 확인해 주세요.';
  }
  if (code.includes('source_version') || code.includes('minimum_source')) {
    return '현재 설치 버전에서는 바로 업데이트할 수 없습니다. 지원되는 중간 버전부터 업데이트해 주세요.';
  }
  if (code.includes('shared_storage')) return 'Android 공유 저장소에서는 안전한 업데이트를 수행할 수 없습니다. Termux 내부 저장소 설치본을 사용해 주세요.';
  if (code.includes('operation_lock') || code.includes('locked')) return '다른 업데이트 작업이 진행 중입니다. 기존 작업이 끝난 뒤 다시 시도해 주세요.';
  if (code.includes('candidate') && (code.includes('failed') || code.includes('start'))) return '새 버전 검증에 실패하여 기존 버전으로 안전하게 복구했습니다.';
  return `업데이트를 완료하지 못했습니다. 자세한 내용은 UPDATER/logs/latest.log를 확인해 주세요. (${code})`;
}

// Local update: the user picks an already downloaded Release ZIP (explorer
// dialog, or --release-zip). Verification, program_only/migration_required
// dispatch and rollback are the same code paths as the remote update.
async function runLocalUpdate({ rootDir = ROOT, logger = logLine, zipPath = null, expectedSha256 = null, deps = {} } = {}) {
  const root = path.resolve(rootDir);
  const log = logger || makeLogger(root);
  const before = currentVersion(root);
  log('');
  log('=== Librarian System 로컬 업데이트 ===');
  log(`현재 버전: ${before}`);
  let chosen = zipPath;
  if (!chosen) {
    const picker = require('./core/file-picker.cjs');
    log('업데이트 ZIP을 고르는 창을 엽니다. 창이 보이지 않으면 작업 표시줄을 확인해 주세요.');
    const picked = (deps.pickReleaseZip || picker.pickReleaseZip)({ platform: platform() });
    if (picked.cancelled) { log('파일 선택이 취소되어 업데이트하지 않았습니다.'); return { applied: false, cancelled: true }; }
    if (picked.unavailable) throw new Error(`release_zip_picker_unavailable:${picked.reason || 'unknown'}`);
    chosen = picked.path;
  }
  chosen = path.resolve(chosen);
  log(`선택한 파일: ${path.basename(chosen)}`);
  log('[1/3] 내부 파일 및 DATA 안전성 확인');
  const prepareFn = deps.prepareFromLocalZip || prepareFromLocalZip;
  const receipt = await prepareFn({ rootDir: root, zipPath: chosen, expectedSha256 });
  if (receipt.updatePolicy === 'manual_required') throw new Error('manual_update_required');
  log(`[2/3] 업데이트 방식: ${receipt.updatePolicy}`);
  if (receipt.updatePolicy === 'migration_required') log('기존 DATA를 직접 덮어쓰지 않고 새 DATA로 안전하게 이관합니다. 문제가 발생하면 PROGRAM과 DATA를 함께 복구합니다.');
  else log('DATA는 그대로 보존하고 PROGRAM만 안전하게 교체합니다.');
  log('[3/3] 업데이트 적용');
  const result = await (deps.applyReceipt || applyReceipt)({ rootDir: root, receipt, logger: log });
  log('');
  log(`업데이트 완료: ${before} → ${receipt.targetVersion}`);
  log('RisuAI에 설치된 플러그인은 서버 updater가 자동으로 변경하지 않습니다.');
  return { receipt, result, applied: true };
}

async function prepareLatestRelease({ rootDir = ROOT, logger = logLine, deps = {} } = {}) {
  const root = path.resolve(rootDir);
  const log = logger || makeLogger(root);
  const cv = currentVersion(root);
  const common = require('./update_common.cjs');
  const archive = require('./release_archive.cjs');
  const checkLatestFn = deps.checkLatest || common.checkLatest;
  const expectedAssetNameFn = deps.expectedAssetName || common.expectedAssetName;
  const downloadReleaseFn = deps.downloadRelease || downloadRelease;
  const prepareReleaseCandidateFn = deps.prepareReleaseCandidate || archive.prepareReleaseCandidate;

  log('[1/6] 새 버전 확인');
  const latest = await checkLatestFn({ currentVersion: cv });
  if (!latest.available) {
    log(`현재 ${cv} 버전이 최신입니다.`);
    return { latest, receipt: null };
  }
  log(`새 버전: ${latest.latestVersion}`);

  log('[2/6] 공식 배포 파일 확인');
  const asset = latest.officialAsset;
  if (!asset || asset.name !== expectedAssetNameFn(latest.latestVersion)) throw new Error('official_release_asset_missing');
  if (!asset.url) throw new Error('official_release_asset_url_missing');
  if (!asset.sha256) throw new Error('github_release_asset_digest_missing');

  log('[3/6] 업데이트 파일 다운로드');
  const updateDir = path.join(root, '.update');
  const downloadDir = path.join(updateDir, 'download');
  const zipPath = path.join(downloadDir, asset.name);
  const downloaded = await downloadReleaseFn(asset.url, zipPath, asset.sha256);

  log('[4/6] 다운로드 무결성 확인');
  if (downloaded.sha256 !== asset.sha256) throw new Error('github_release_asset_digest_mismatch');

  log('[5/6] 내부 파일 및 DATA 안전성 확인');
  const receipt = await prepareReleaseCandidateFn({
    archivePath: zipPath,
    workRoot: updateDir,
    targetVersion: latest.latestVersion,
    currentVersion: cv,
    expectedArchiveSha256: asset.sha256
  });

  log('[6/6] 업데이트 준비 완료');
  log(`업데이트 방식: ${receipt.updatePolicy}`);
  return { latest, receipt };
}

async function runUserUpdate({ rootDir = ROOT, logger = logLine, deps = {} } = {}) {
  const root = path.resolve(rootDir);
  const log = logger || makeLogger(root);
  const before = currentVersion(root);
  log('');
  log('=== Librarian System 업데이트 ===');
  log(`현재 버전: ${before}`);
  const prepared = await prepareLatestRelease({ rootDir: root, logger: log, deps });
  if (!prepared.receipt) return { ...prepared, applied: false };
  const receipt = prepared.receipt;
  if (receipt.updatePolicy === 'manual_required') throw new Error('manual_update_required');
  if (receipt.updatePolicy === 'migration_required') {
    log('기존 DATA를 직접 덮어쓰지 않고 새 DATA로 안전하게 이관합니다.');
    log('문제가 발생하면 PROGRAM과 DATA를 이전 상태로 함께 복구합니다.');
  } else if (receipt.updatePolicy === 'program_only') {
    log('DATA는 그대로 보존하고 PROGRAM만 안전하게 교체합니다.');
  }
  const applyReceiptFn = deps.applyReceipt || applyReceipt;
  const result = await applyReceiptFn({ rootDir: root, receipt, logger: log });
  log('');
  log(`업데이트 완료: ${before} → ${receipt.targetVersion}`);
  log('기존 DATA 보존 및 업데이트 검증을 완료했습니다.');
  log('RisuAI에 설치된 플러그인은 서버 updater가 자동으로 변경하지 않습니다.');
  log('플러그인 업데이트가 필요한 경우 PROGRAM/plugins의 최신 JS를 RisuAI에서 직접 적용해 주세요.');
  return { ...prepared, result, applied: true };
}

async function runMain({ args = parseArgs(), rootDir = ROOT, logger = null } = {}) {
  const root = path.resolve(rootDir);
  const updateDir = path.join(root, '.update');
  const log = logger || makeLogger(root);
  assertRuntime();
  validateRoot(root);
  if (args.recover) {
    const result = await recoverInterruptedUpdate({ rootDir: root, logger: log });
    log(result.recovered ? '미완료 업데이트 복구 완료' : '복구할 미완료 업데이트가 없습니다.');
    return result;
  }
  // Do not read VERSION or replace candidate staging until recovery is done.
  await recoverInterruptedUpdate({ rootDir: root, logger: log });
  const { checkLatest, expectedAssetName } = require('./update_common.cjs');
  const { prepareReleaseCandidate } = require('./release_archive.cjs');
  const cv = currentVersion(root);
  log(`Platform : ${platform()}`);
  log(`Current  : ${cv}`);

  if (args.userUpdate) return runUserUpdate({ rootDir: root, logger: log });
  if (args.localUpdate) return runLocalUpdate({ rootDir: root, logger: log, zipPath: args.releaseZip, expectedSha256: args.expectedSha256 });

  if (args.releaseZip) {
    log('[LOCAL] 표준 Release ZIP을 검사하고 PROGRAM.next를 준비합니다.');
    const receipt = await prepareFromLocalZip({ rootDir: root, zipPath: args.releaseZip, expectedSha256: args.expectedSha256 });
    log(`Candidate: ${receipt.targetVersion} · ${receipt.updatePolicy}`);
    log('Release ZIP → 내부 manifest/checksum → PROGRAM.next 준비 호환성 검증 완료');
    if (args.apply) {
      const result = await applyReceipt({ rootDir: root, receipt, logger: log });
      return { receipt, result };
    }
    log('실제 교체는 --apply를 명시했을 때만 수행합니다.');
    return { receipt };
  }

  if (args.apply) {
    const receiptPath = path.join(updateDir, 'candidate.json');
    if (!fs.existsSync(receiptPath)) throw new Error('prepared_candidate_missing');
    const receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf8'));
    const result = await applyReceipt({ rootDir: root, receipt, logger: log });
    return { receipt, result };
  }

  log('[1/6] GitHub Release 확인');
  const latest = await checkLatest({ currentVersion: cv });
  if (!latest.available) {
    log('최신 버전입니다.');
    return { latest };
  }
  log(`Latest   : ${latest.latestVersion}`);
  if (args.check) return { latest };

  log('[2/6] 공식 Release ZIP 확인');
  const asset = latest.officialAsset;
  if (!asset || asset.name !== expectedAssetName(latest.latestVersion)) throw new Error('official_release_asset_missing');
  if (!asset.url) throw new Error('official_release_asset_url_missing');
  if (!asset.sha256) throw new Error('github_release_asset_digest_missing');

  log('[3/6] 배포 ZIP 다운로드');
  const downloadDir = path.join(updateDir, 'download');
  const zipPath = path.join(downloadDir, asset.name);
  const downloaded = await downloadRelease(asset.url, zipPath, asset.sha256);

  log('[4/6] GitHub SHA-256 검증');
  if (downloaded.sha256 !== asset.sha256) throw new Error('github_release_asset_digest_mismatch');

  log('[5/6] ZIP 내부 manifest / SHA256SUMS / clean DATA 검증');
  const receipt = await prepareReleaseCandidate({
    archivePath: zipPath,
    workRoot: updateDir,
    targetVersion: latest.latestVersion,
    currentVersion: cv,
    expectedArchiveSha256: asset.sha256
  });

  log('[6/6] PROGRAM.next 후보 준비 완료');
  log(`Update policy: ${receipt.updatePolicy}`);
  if (receipt.updatePolicy === 'program_only') log('program_only 후보는 --apply를 명시하면 안전 체크포인트과 Rollback-First 전환을 수행할 수 있습니다.');
  else if (receipt.updatePolicy === 'migration_required') log('migration_required 후보는 --apply를 명시하면 논리 DATA 이관과 PROGRAM/DATA pair 전환을 수행할 수 있습니다.');
  else log('manual_required 정책은 자동 적용하지 않습니다.');
  return { receipt, latest };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = path.resolve(args.targetRoot || ROOT);
  const logger = makeLogger(root);
  return await withUpdateLock(root, async () => {
    const result = await runMain({ args, rootDir: root, logger });
    if (args.installUpdater && (!args.userUpdate || result.applied === true)) {
      if (root === CODE_ROOT) throw new Error('install_updater_target_must_be_external_root');
      const { installUpdaterIntoTarget } = require('./core/updater-bootstrap.cjs');
      result.updaterInstall = await installUpdaterIntoTarget({ sourceUpdaterDir: __dirname, targetRoot: root, logger });
    }
    return result;
  });
}

if (require.main === module) {
  main().catch(error => {
    const detail = String(error?.message || error);
    const friendly = friendlyErrorMessage(error);
    try {
      logLine(`업데이트 실패: ${friendly}`);
      if (friendly !== detail) logLine(`진단 코드: ${detail}`);
    } catch (_) { console.error(friendly); }
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  platform,
  downloadRelease,
  prepareFromLocalZip,
  recoverInterruptedUpdate,
  applyReceipt,
  friendlyErrorMessage,
  prepareLatestRelease,
  runUserUpdate,
  runLocalUpdate,
  currentVersion,
  makeLogger,
  runMain,
  main
};
