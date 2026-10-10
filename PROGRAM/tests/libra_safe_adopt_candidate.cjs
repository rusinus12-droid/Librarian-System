'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [targetArg, candidateArg, expectedTarget, expectedCandidate, backupArg] = process.argv.slice(2);
if (!targetArg || !candidateArg || !expectedTarget || !expectedCandidate || !backupArg) {
  throw new Error('usage: node libra_safe_adopt_candidate.cjs <target> <candidate> <target-sha256> <candidate-sha256> <backup>');
}

const target = path.resolve(targetArg);
const candidate = path.resolve(candidateArg);
const backup = path.resolve(backupArg);
const expectedTargetHash = expectedTarget.toUpperCase();
const expectedCandidateHash = expectedCandidate.toUpperCase();
const hash = value => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();

assert.equal(path.basename(target), 'LIBRA.js', 'target must be the canonical LIBRA.js');
assert.equal(path.dirname(candidate), path.dirname(target), 'candidate must be beside the canonical source');
assert.notEqual(candidate, target, 'candidate and target must differ');

const before = fs.readFileSync(target);
const candidateBytes = fs.readFileSync(candidate);
assert.equal(hash(before), expectedTargetHash, 'canonical source changed before adoption');
assert.equal(hash(candidateBytes), expectedCandidateHash, 'candidate hash mismatch');

const syntax = spawnSync(process.execPath, ['--check', candidate], { encoding: 'utf8', windowsHide: true });
assert.equal(syntax.status, 0, `candidate syntax failed:\n${syntax.stdout || ''}${syntax.stderr || ''}`);

fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
assert.equal(hash(fs.readFileSync(backup)), expectedTargetHash, 'backup readback mismatch');

const temporary = `${target}.adopt-${process.pid}.tmp`;
let descriptor = null;
try {
  descriptor = fs.openSync(temporary, 'wx');
  fs.writeFileSync(descriptor, candidateBytes);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = null;
  assert.equal(hash(fs.readFileSync(temporary)), expectedCandidateHash, 'temporary readback mismatch');
  assert.equal(hash(fs.readFileSync(target)), expectedTargetHash, 'canonical source changed during adoption');
  fs.renameSync(temporary, target);
  assert.equal(hash(fs.readFileSync(target)), expectedCandidateHash, 'adopted source readback mismatch');
} finally {
  if (descriptor !== null) fs.closeSync(descriptor);
  try { fs.rmSync(temporary, { force: true }); } catch (_) {}
}

process.stdout.write(JSON.stringify({ ok: true, target, before: expectedTargetHash, after: expectedCandidateHash, backup }) + '\n');
