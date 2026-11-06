'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  assertPristineDistributionData,
  buildRelease,
  parseArgs,
  restoreVersionTransactionFiles,
  shouldCopyProgram,
  shouldCopySourceProgram,
  snapshotVersionTransactionFiles,
  verifyChecksumFile
} = require('../tools/build_distribution.cjs');
const {
  createZipFromDirectory,
  readZipEntries,
  verifyZipAgainstDirectory
} = require('../tools/zip_writer.cjs');

const programDir = path.resolve(__dirname, '..');
const prepareData = path.join(programDir, 'tools', 'prepare_data.cjs');

function runPrepare(dataDir, ...extra) {
  return spawnSync(process.execPath, [prepareData, '--program-dir', programDir, '--data-dir', dataDir, ...extra], {
    encoding: 'utf8'
  });
}

function copyProgramFixture(source, target, base = source) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (['.git', 'node_modules', '__pycache__', 'backups', 'logs', 'releases'].includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const relative = path.relative(base, from);
    if (entry.isDirectory()) copyProgramFixture(from, target, base);
    else if (entry.isFile() && shouldCopySourceProgram(relative)) {
      const to = path.join(target, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-distribution-builder-'));
  try {
    const cleanData = path.join(tempRoot, 'clean DATA');
    const prepared = runPrepare(cleanData, '--fresh-distribution');
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    const receipt = JSON.parse(prepared.stdout);
    assert.equal(receipt.freshDistribution, true);
    assert.equal(receipt.legacyDataMigrated, false);
    assert.equal(fs.existsSync(path.join(cleanData, 'runtime-token.txt')), false);
    assert.equal(fs.existsSync(path.join(cleanData, 'config', 'compute-signing-key.txt')), false);

    fs.writeFileSync(path.join(cleanData, 'private.sqlite'), 'never ship', 'utf8');
    assert.throws(() => assertPristineDistributionData(cleanData), /distribution_private_data_detected/);
    fs.rmSync(path.join(cleanData, 'private.sqlite'));

    const occupiedData = path.join(tempRoot, 'occupied DATA');
    fs.mkdirSync(occupiedData);
    fs.writeFileSync(path.join(occupiedData, 'sentinel.txt'), 'private source sentinel', 'utf8');
    const refused = runPrepare(occupiedData, '--fresh-distribution');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /fresh_distribution_data_dir_must_be_empty/);
    assert.equal(fs.readFileSync(path.join(occupiedData, 'sentinel.txt'), 'utf8'), 'private source sentinel');

    const missingDataDirValue = spawnSync(process.execPath, [prepareData, '--data-dir'], {
      cwd: tempRoot,
      encoding: 'utf8'
    });
    assert.notEqual(missingDataDirValue.status, 0);
    assert.match(missingDataDirValue.stderr, /prepare_data_data_dir_value_required/);
    assert.equal(fs.existsSync(path.join(tempRoot, 'config')), false, 'missing --data-dir must not fall back to cwd');

    assert.equal(shouldCopyProgram('_runtime/README.txt'), true);
    assert.equal(shouldCopyProgram('_runtime/node.exe'), false);
    assert.equal(shouldCopyProgram('server/server.cjs'), true);
    assert.equal(shouldCopyProgram('logs/server.log'), false);
    assert.equal(shouldCopySourceProgram('docs/evidence/private.json'), false, 'generated observations must not enter Source archives');
    assert.equal(shouldCopySourceProgram('checkpoints/private.json'), false, 'generated checkpoints must not enter Source archives');
    assert.equal(shouldCopyProgram('tools/private.pem'), false);
    assert.equal(shouldCopyProgram('tools/.env.production'), false);
    assert.equal(shouldCopyProgram('unexpected-top-level.txt'), false);
    assert.throws(() => parseArgs(['--skip-tests']), /unknown_distribution_builder_argument/,
      'the user-facing builder must never produce an untested release artifact');
    assert.throws(() => parseArgs(['--output-dir', '--skip-tests']), /distribution_output_dir_value_required/);
    assert.equal(parseArgs(['--check']).check, true);

    // Release smoke runs this file beside readers of the real source tree.
    // Mutation/rollback controls must use a complete isolated repository, not
    // truncate live server/plugin/manifest files while another test copies them.
    const sourceRoot = path.resolve(programDir, '..');
    const packageRoot = path.join(tempRoot, 'isolated-repository');
    copyProgramFixture(programDir, path.join(packageRoot, 'PROGRAM'));
    for (const row of snapshotVersionTransactionFiles(sourceRoot)) {
      if (row.relative.startsWith('PROGRAM/')) continue;
      const to = path.join(packageRoot, row.relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(row.absolute, to);
    }
    const isolatedBuilder = require(path.join(packageRoot, 'PROGRAM/tools/build_distribution.cjs'));
    const beforeCheckSnapshot = snapshotVersionTransactionFiles(packageRoot);
    assert.ok(beforeCheckSnapshot.length >= 10, 'snapshotVersionTransactionFiles captures all release metadata files');
    const manifestSnapshot = beforeCheckSnapshot.find(f => f.relative === 'PROGRAM/program-manifest.json');
    assert.ok(manifestSnapshot, 'program-manifest.json is captured in version transaction files');
    const originalManifestBytes = fs.readFileSync(manifestSnapshot.absolute);

    // A no-op rollback must perform no writes or chmods: writeFileSync first
    // truncates, allowing a concurrent ZIP reader to capture an empty CJS module.
    const originalWrite = fs.writeFileSync, originalChmod = fs.chmodSync;
    const protectedPaths = new Set(beforeCheckSnapshot.map(row => row.absolute));
    const touched = [];
    try {
      fs.writeFileSync = function(file, ...args) { if (protectedPaths.has(String(file))) touched.push(String(file)); return originalWrite.call(this, file, ...args); };
      fs.chmodSync = function(file, ...args) { if (protectedPaths.has(String(file))) touched.push(String(file)); return originalChmod.call(this, file, ...args); };
      restoreVersionTransactionFiles(beforeCheckSnapshot);
    } finally { fs.writeFileSync = originalWrite; fs.chmodSync = originalChmod; }
    assert.deepEqual(touched, [], 'unchanged rollback must not expose transient empty source bytes to parallel archive readers');

    try {
      fs.writeFileSync(manifestSnapshot.absolute, JSON.stringify({ ...JSON.parse(originalManifestBytes.toString('utf8')), generatedAt: 'simulated-mutation' }));
      assert.notDeepEqual(fs.readFileSync(manifestSnapshot.absolute), originalManifestBytes);
      restoreVersionTransactionFiles(beforeCheckSnapshot);
      assert.deepEqual(fs.readFileSync(manifestSnapshot.absolute), originalManifestBytes, 'transaction restores exact bytes');
    } finally {
      restoreVersionTransactionFiles(beforeCheckSnapshot);
    }

    const blockingOutputDir = path.join(tempRoot, 'blocking-output-file');
    fs.writeFileSync(blockingOutputDir, 'block');
    assert.throws(() => {
      isolatedBuilder.buildRelease({ check: true, outputDir: blockingOutputDir });
    }, error => error.code === 'EEXIST' || error.code === 'ENOTDIR', 'the real builder reaches the deliberately blocked output path');
    assert.deepEqual(fs.readFileSync(manifestSnapshot.absolute), originalManifestBytes, 'buildRelease error path restores snapshot when check: true');

    const checksumRoot = path.join(tempRoot, 'checksum root');
    fs.mkdirSync(checksumRoot);
    const checksumPayload = path.join(checksumRoot, 'payload.txt');
    fs.writeFileSync(checksumPayload, 'before tests\n', 'utf8');
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(checksumPayload)).digest('hex');
    fs.writeFileSync(path.join(checksumRoot, 'SHA256SUMS.txt'), `${checksum}  ./payload.txt\n`, 'utf8');
    assert.equal(verifyChecksumFile(checksumRoot).files, 1);
    fs.writeFileSync(checksumPayload, 'mutated by test\n', 'utf8');
    assert.throws(() => verifyChecksumFile(checksumRoot), /distribution_checksum_digest_mismatch/);

    const payload = path.join(tempRoot, 'payload');
    fs.mkdirSync(path.join(payload, '한글 폴더'), { recursive: true });
    fs.writeFileSync(path.join(payload, '한글 폴더', '실행.sh'), '#!/usr/bin/env sh\nprintf ok\n', 'utf8');
    fs.writeFileSync(path.join(payload, 'README.txt'), 'Librarian System\n', 'utf8');
    const archive = path.join(tempRoot, 'distribution.zip');
    createZipFromDirectory(payload, archive, { rootName: 'Librarian-System-test' });
    const verified = verifyZipAgainstDirectory(archive, payload, { rootName: 'Librarian-System-test' });
    assert.equal(verified.ok, true);
    const entries = readZipEntries(archive);
    const shell = entries.find(entry => entry.name.endsWith('/실행.sh'));
    assert.ok(shell);
    assert.equal((shell.flags & 0x0800) !== 0, true, 'ZIP entry names use the UTF-8 flag');
    assert.equal((shell.mode & 0o111) !== 0, true, 'POSIX shell scripts retain execute permission metadata');

    const tamperedLocalName = fs.readFileSync(archive);
    tamperedLocalName[30] ^= 0x01;
    const tamperedArchive = path.join(tempRoot, 'tampered-local-name.zip');
    fs.writeFileSync(tamperedArchive, tamperedLocalName);
    assert.throws(() => readZipEntries(tamperedArchive), /zip_local_name_mismatch/);

    const trailingGarbageArchive = path.join(tempRoot, 'trailing-garbage.zip');
    fs.writeFileSync(trailingGarbageArchive, Buffer.concat([fs.readFileSync(archive), Buffer.from('garbage')]));
    assert.throws(() => readZipEntries(trailingGarbageArchive), /zip_end_of_central_directory_not_found/);

    process.stdout.write('distribution_builder_test: PASS\n');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  process.stderr.write(`distribution_builder_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
}
