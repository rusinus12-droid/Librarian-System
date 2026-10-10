'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [candidateArg, targetArg, expectedTargetHashArg] = process.argv.slice(2);
if (!candidateArg || !targetArg || !expectedTargetHashArg) {
  throw new Error('usage: node libra_rc2_guarded_adopt.cjs <candidate> <target> <expected-target-sha256>');
}

const candidate = path.resolve(candidateArg);
const target = path.resolve(targetArg);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
const candidateBytes = fs.readFileSync(candidate);
const targetBytes = fs.readFileSync(target);
const expectedTargetHash = String(expectedTargetHashArg).trim().toUpperCase();
const actualTargetHash = sha256(targetBytes);
if (actualTargetHash !== expectedTargetHash) {
  throw new Error(`guarded_adopt_target_changed:${actualTargetHash}`);
}
new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes);
const candidateHash = sha256(candidateBytes);
const temporary = `${target}.rc2-adopt-${process.pid}.tmp`;
fs.writeFileSync(temporary, candidateBytes);
const temporaryBytes = fs.readFileSync(temporary);
if (sha256(temporaryBytes) !== candidateHash || !temporaryBytes.equals(candidateBytes)) {
  fs.rmSync(temporary, { force: true });
  throw new Error('guarded_adopt_temporary_readback_mismatch');
}
fs.renameSync(temporary, target);
const adoptedBytes = fs.readFileSync(target);
if (sha256(adoptedBytes) !== candidateHash || !adoptedBytes.equals(candidateBytes)) {
  throw new Error('guarded_adopt_target_readback_mismatch');
}
process.stdout.write(JSON.stringify({ ok: true, previousHash: actualTargetHash, adoptedHash: candidateHash, bytes: adoptedBytes.length }) + '\n');
