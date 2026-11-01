'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildDistribution } = require('../tools/build_distribution.cjs');
const { readZipEntries } = require('../tools/zip_writer.cjs');
const { prepareReleaseCandidate } = require('../../UPDATER/release_archive.cjs');
const { expectedAssetName } = require('../tools/release_asset_contract.cjs');
const { assertPristineDistributionData } = require('../tools/runtime_release_validation.cjs');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const STAGING_PACKAGING_TOOLS = new Set([
  'prepare_data.cjs',
  'update_manifest.cjs',
  'update_checksums.cjs',
  'build_plugins.cjs',
  'verify_runtime_archive.cjs'
]);

function isInsideDir(targetPath, rootDir) {
  if (typeof targetPath !== 'string' && !Buffer.isBuffer(targetPath) && !(targetPath instanceof URL)) return false;
  const resolvedTarget = path.resolve(targetPath instanceof URL ? targetPath : String(targetPath));
  const resolvedRoot = path.resolve(rootDir);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createChildFsGuardPreload(tempDir, sourceDataRoot, logFile) {
  const preloadPath = path.join(tempDir, 'child-source-data-guard.cjs');
  const script = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sourceDataRoot = ${JSON.stringify(path.resolve(sourceDataRoot))};
const logFile = ${JSON.stringify(path.resolve(logFile))};
const origAppend = fs.appendFileSync.bind(fs);
function isInside(targetPath) {
  if (typeof targetPath !== 'string' && !Buffer.isBuffer(targetPath) && !(targetPath instanceof URL)) return false;
  const resolved = path.resolve(targetPath instanceof URL ? targetPath : String(targetPath));
  const rel = path.relative(sourceDataRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
for (const method of ['readFileSync','writeFileSync','appendFileSync','copyFileSync','readdirSync','openSync','rmSync','unlinkSync','renameSync','mkdirSync']) {
  if (typeof fs[method] !== 'function') continue;
  const orig = fs[method].bind(fs);
  fs[method] = function (...args) {
    for (const arg of args.slice(0, 2)) {
      if (isInside(arg)) {
        origAppend(logFile, JSON.stringify({ pid: process.pid, argv: process.argv.slice(1, 3), method, path: String(arg) }) + '\\n');
      }
    }
    return orig(...args);
  };
}
`;
  fs.writeFileSync(preloadPath, script, 'utf8');
  return preloadPath;
}

async function withStagingPackagingDataGuard(sourceDataRoot, tempDir, fn) {
  const trackedMethods = [
    'readFileSync', 'writeFileSync', 'appendFileSync', 'copyFileSync',
    'readdirSync', 'openSync', 'rmSync', 'unlinkSync', 'renameSync', 'mkdirSync'
  ];
  const originals = new Map();
  const inProcessAccesses = [];
  const childLogFile = path.join(tempDir, 'staging-child-data-access.jsonl');
  fs.writeFileSync(childLogFile, '', 'utf8');
  const preloadPath = createChildFsGuardPreload(tempDir, sourceDataRoot, childLogFile);
  const origSpawnSync = cp.spawnSync;

  for (const method of trackedMethods) {
    if (typeof fs[method] !== 'function') continue;
    originals.set(method, fs[method]);
    fs[method] = function (...args) {
      for (const arg of args.slice(0, 2)) {
        if (isInsideDir(arg, sourceDataRoot)) {
          inProcessAccesses.push({ method, path: String(arg) });
        }
      }
      return originals.get(method).apply(this, args);
    };
  }

  cp.spawnSync = function (command, args = [], options = {}) {
    const scriptArg = Array.isArray(args) ? args.find(arg => typeof arg === 'string' && /\.(?:cjs|js)$/i.test(arg)) : '';
    const toolName = scriptArg ? path.basename(scriptArg) : '';
    if (STAGING_PACKAGING_TOOLS.has(toolName)) {
      for (const arg of args) {
        if (typeof arg === 'string' && isInsideDir(arg, sourceDataRoot)) {
          inProcessAccesses.push({ method: `spawnSync:${toolName}:arg`, path: arg });
        }
      }
      const env = { ...(options?.env || process.env) };
      if (env.LIBRARIAN_PACKAGE_ROOT && isInsideDir(path.join(env.LIBRARIAN_PACKAGE_ROOT, 'DATA'), sourceDataRoot)) {
        inProcessAccesses.push({ method: `spawnSync:${toolName}:env`, path: env.LIBRARIAN_PACKAGE_ROOT });
      }
      return origSpawnSync.call(this, command, ['--require', preloadPath, ...args], { ...options, env });
    }
    return origSpawnSync.call(this, command, args, options);
  };

  try {
    const value = await fn();
    const childAccesses = fs.readFileSync(childLogFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    return { value, inProcessAccesses, childAccesses };
  } finally {
    cp.spawnSync = origSpawnSync;
    for (const [method, orig] of originals.entries()) {
      fs[method] = orig;
    }
  }
}

async function main() {
  const version = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim();
  const dataRoot = path.join(packageRoot, 'DATA');
  const dataLayout = path.join(dataRoot, 'data-layout.json');
  const hadSourceDataLayout = fs.existsSync(dataLayout);
  const beforeDataLayout = hadSourceDataLayout ? sha(dataLayout) : null;
  const beforeProgramVersion = fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-release-updater-contract-'));
  try {
    const output = path.join(temp, 'release');
    const {
      value: result,
      inProcessAccesses: buildInProcessAccesses,
      childAccesses: buildStagingChildAccesses
    } = await withStagingPackagingDataGuard(
      dataRoot,
      temp,
      () => buildDistribution({ outputDir: output })
    );
    assert.deepEqual(buildInProcessAccesses, [], 'in-process buildDistribution staging/packaging must not access source/user DATA');
    assert.deepEqual(buildStagingChildAccesses, [], 'staging/packaging child tools must not access source/user DATA');
    assert.equal(result.report.sourceDataReadOrCopied, false, 'distribution report must confirm source DATA was not read or copied');
    assert.equal(path.basename(result.archivePath), expectedAssetName(version));
    assert.equal(result.report.artifact, expectedAssetName(version));
    assert.equal(result.report.releaseTag, `v${version}`);
    assert.equal(result.report.releaseAssetContract, 'librarian.update-manifest.v1');
    const entries = readZipEntries(result.archivePath).map(entry => entry.name);
    const prefix = `Librarian-System-${version}/`;
    for (const required of [
      'update-manifest.json',
      'SHA256SUMS.txt',
      'UPDATER/updater.cjs',
      '업데이트.bat',
      '업데이트.command',
      '업데이트.sh',
      'PROGRAM/VERSION.txt',
      'DATA/data-layout.json'
    ]) assert.ok(entries.includes(prefix + required), `release ZIP missing ${required}`);

    const candidateWork = path.join(temp, 'candidate-work');
    const {
      value: receipt,
      inProcessAccesses: candidateInProcessAccesses,
      childAccesses: candidateChildAccesses
    } = await withStagingPackagingDataGuard(
      dataRoot,
      temp,
      () => prepareReleaseCandidate({
        archivePath: result.archivePath,
        workRoot: candidateWork,
        targetVersion: version,
        currentVersion: version,
        expectedArchiveSha256: result.report.archiveSha256
      })
    );
    assert.deepEqual(candidateInProcessAccesses, [], 'in-process prepareReleaseCandidate must not access source/user DATA');
    assert.deepEqual(candidateChildAccesses, [], 'prepareReleaseCandidate child tools must not access source/user DATA');
    assert.equal(receipt.targetVersion, version);
    assert.equal(receipt.asset, expectedAssetName(version));
    assert.equal(fs.readFileSync(path.join(candidateWork, 'PROGRAM.next', 'VERSION.txt'), 'utf8').trim(), version);
    const candidateDataDir = path.join(receipt.candidateRoot, 'DATA');
    assertPristineDistributionData(candidateDataDir);
    const candidateLayout = JSON.parse(fs.readFileSync(path.join(candidateDataDir, 'data-layout.json'), 'utf8'));
    assert.equal(candidateLayout.lastProgramVersion, version, 'release DATA/data-layout.json must be freshly generated for the release version');
    assert.equal(Object.hasOwn(candidateLayout, 'lastOpenedAt'), false, 'release DATA/data-layout.json must not include runtime open timestamps');

    const shippedFiles = entries.filter(name => !name.endsWith('/')).length;
    assert.equal(receipt.verifiedFiles, shippedFiles - 1,
      'internal checksum must cover every shipped file except SHA256SUMS.txt itself');
    assert.ok(receipt.verifiedFiles > 100, 'release must ship a substantial file set, not a truncated archive');
    const internalManifest = JSON.parse(fs.readFileSync(path.join(receipt.candidateRoot, 'update-manifest.json'), 'utf8'));
    assert.equal(internalManifest.assetName, expectedAssetName(version));
    assert.equal(internalManifest.repository, 'rusinus12-droid/Librarian-System');
    await assert.rejects(
      () => prepareReleaseCandidate({ archivePath: result.archivePath, workRoot: path.join(temp, 'bad-digest'), targetVersion: version, currentVersion: version, expectedArchiveSha256: '0'.repeat(64) }),
      /outer_sha256_mismatch/
    );
    assert.equal(fs.existsSync(dataLayout), hadSourceDataLayout, 'release build must not create or delete source/user DATA/data-layout.json');
    if (hadSourceDataLayout) {
      assert.equal(sha(dataLayout), beforeDataLayout, 'release build and candidate preparation must not mutate active DATA/data-layout.json');
    }
    assert.equal(fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8'), beforeProgramVersion, 'release build must not mutate active PROGRAM version');
    console.log('remote_update_release_zip_runtime_test: PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

main().catch(error => {
  console.error('remote_update_release_zip_runtime_test: FAIL');
  console.error(error.stack || error);
  process.exitCode = 1;
});
