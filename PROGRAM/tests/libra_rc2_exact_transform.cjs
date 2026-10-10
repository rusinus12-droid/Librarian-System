'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [targetArg, specArg] = process.argv.slice(2);
if (!targetArg || !specArg) throw new Error('usage: node libra_rc2_exact_transform.cjs <target> <spec.json>');

const target = path.resolve(targetArg);
const specPath = path.resolve(specArg);
let source = fs.readFileSync(target, 'utf8');
new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target));

const replaceExactlyOnce = (input, find, replace, label = 'transform') => {
  const first = input.indexOf(find);
  const second = first < 0 ? -1 : input.indexOf(find, first + find.length);
  if (first < 0) throw new Error(`${label}:find_missing`);
  if (second >= 0) throw new Error(`${label}:find_not_unique`);
  return `${input.slice(0, first)}${replace}${input.slice(first + find.length)}`;
};

let operationLabels = [];
if (/\.cjs$/i.test(specPath)) {
  const transform = require(specPath);
  if (typeof transform !== 'function') throw new Error('transform_module_must_export_function');
  const result = transform(source, { replaceExactlyOnce, target, specPath });
  if (!result || typeof result.source !== 'string') throw new Error('transform_module_result_invalid');
  source = result.source;
  operationLabels = Array.isArray(result.labels) ? result.labels.map(String) : ['module_transform'];
} else {
  const operations = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (!Array.isArray(operations) || !operations.length) throw new Error('transform_spec_empty');

  for (const [index, operation] of operations.entries()) {
    const label = String(operation?.label || `operation_${index + 1}`);
    const find = String(operation?.find ?? '');
    const replace = String(operation?.replace ?? '');
    if (!find) throw new Error(`${label}:find_empty`);
    source = replaceExactlyOnce(source, find, replace, label);
    operationLabels.push(label);
  }
}

const temporary = `${target}.rc2-transform-${process.pid}.tmp`;
fs.writeFileSync(temporary, source, 'utf8');
const readback = fs.readFileSync(temporary, 'utf8');
if (readback !== source) {
  fs.rmSync(temporary, { force: true });
  throw new Error('transform_readback_mismatch');
}
new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(temporary));
fs.renameSync(temporary, target);
process.stdout.write(JSON.stringify({ ok: true, operations: operationLabels, bytes: Buffer.byteLength(source) }) + '\n');
