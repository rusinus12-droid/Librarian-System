'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const [sourceArg, outputArg, ...moduleArgs] = process.argv.slice(2);
if (!sourceArg || !outputArg || !moduleArgs.length) {
  throw new Error('usage: node libra_safe_transform_candidate.cjs <source> <output> <transform.cjs> [...]');
}

const sourcePath = path.resolve(sourceArg);
const outputPath = path.resolve(outputArg);
const sourceBytes = fs.readFileSync(sourcePath);
let source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();

const replaceExactlyOnce = (input, find, replace, label = 'transform') => {
  const first = input.indexOf(find);
  const second = first < 0 ? -1 : input.indexOf(find, first + find.length);
  if (first < 0) throw new Error(`${label}:find_missing`);
  if (second >= 0) throw new Error(`${label}:find_not_unique`);
  return `${input.slice(0, first)}${replace}${input.slice(first + find.length)}`;
};

const labels = [];
for (const moduleArg of moduleArgs) {
  const modulePath = path.resolve(moduleArg);
  delete require.cache[require.resolve(modulePath)];
  const transform = require(modulePath);
  if (typeof transform !== 'function') throw new Error(`transform_module_invalid:${modulePath}`);
  const result = transform(source, { replaceExactlyOnce, sourcePath, outputPath, modulePath });
  if (!result || typeof result.source !== 'string') throw new Error(`transform_result_invalid:${modulePath}`);
  source = result.source;
  labels.push(...(Array.isArray(result.labels) ? result.labels.map(String) : [path.basename(modulePath)]));
}

const temporary = `${outputPath}.candidate-${process.pid}.tmp.js`;
fs.writeFileSync(temporary, source, 'utf8');
const temporaryBytes = fs.readFileSync(temporary);
new TextDecoder('utf-8', { fatal: true }).decode(temporaryBytes);
if (sha256(temporaryBytes) !== sha256(Buffer.from(source, 'utf8'))) {
  fs.rmSync(temporary, { force: true });
  throw new Error('candidate_raw_readback_mismatch');
}
const syntax = spawnSync(process.execPath, ['--check', temporary], { encoding: 'utf8', windowsHide: true });
if (syntax.status !== 0) {
  fs.rmSync(temporary, { force: true });
  throw new Error(`candidate_syntax_failed:\n${syntax.stdout || ''}${syntax.stderr || ''}`);
}
fs.renameSync(temporary, outputPath);
const outputBytes = fs.readFileSync(outputPath);
if (!outputBytes.equals(temporaryBytes)) throw new Error('candidate_output_readback_mismatch');
process.stdout.write(JSON.stringify({
  ok: true,
  source: sourcePath,
  sourceHash: sha256(sourceBytes),
  output: outputPath,
  outputHash: sha256(outputBytes),
  bytes: outputBytes.length,
  operations: labels
}) + '\n');
