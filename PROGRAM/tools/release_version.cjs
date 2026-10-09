'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value, code = 'distribution_version_invalid') {
  const text = String(value || '').trim();
  const match = text.match(SEMVER);
  if (!match) throw new Error(`${code}:${text}`);
  return { text, parts: match.slice(1).map(Number) };
}

function compareVersions(left, right) {
  const a = parseVersion(left).parts;
  const b = parseVersion(right).parts;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function nextPatchVersion(currentVersion) {
  const parsed = parseVersion(currentVersion);
  return `${parsed.parts[0]}.${parsed.parts[1]}.${parsed.parts[2] + 1}`;
}

function validateTargetVersion(currentVersion, targetVersion) {
  const current = parseVersion(currentVersion, 'distribution_current_version_invalid').text;
  const target = parseVersion(targetVersion).text;
  if (compareVersions(target, current) <= 0) {
    throw new Error(`distribution_version_must_increase:${current}->${target}`);
  }
  return target;
}

function replaceCount(source, pattern, replacement, expectedCount, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== expectedCount) {
    throw new Error(`distribution_version_target_mismatch:${label}:${matches.length}!=${expectedCount}`);
  }
  return source.replace(pattern, replacement);
}

function applyReleaseVersion(packageRoot, targetVersion) {
  const root = path.resolve(packageRoot);
  const programDir = path.join(root, 'PROGRAM');
  const versionPath = path.join(programDir, 'VERSION.txt');
  const currentVersion = fs.readFileSync(versionPath, 'utf8').trim();
  const target = validateTargetVersion(currentVersion, targetVersion);
  const changedFiles = [];

  const write = (filePath, nextSource) => {
    fs.writeFileSync(filePath, nextSource, 'utf8');
    changedFiles.push(path.relative(root, filePath).split(path.sep).join('/'));
  };

  write(versionPath, `${target}\n`);

  const serverPath = path.join(programDir, 'server', 'server.cjs');
  const serverSource = fs.readFileSync(serverPath, 'utf8');
  write(serverPath, replaceCount(
    serverSource,
    new RegExp(`^const SERVER_VERSION = '${currentVersion.replace(/\./g, '\\.')}';$`, 'gm'),
    `const SERVER_VERSION = '${target}';`,
    1,
    'server/server.cjs'
  ));

  const policyPath = path.join(programDir, 'release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  if (String(policy.version || '') !== currentVersion) throw new Error('distribution_release_policy_version_mismatch');
  policy.version = target;
  write(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

  const logicalPath = path.join(programDir, 'server', 'portable', 'logical_migration.cjs');
  const logicalSource = fs.readFileSync(logicalPath, 'utf8');
  write(logicalPath, replaceCount(
    logicalSource,
    new RegExp(`serverVersion='${currentVersion.replace(/\./g, '\\.')}'`, 'g'),
    `serverVersion='${target}'`,
    3,
    'server/portable/logical_migration.cjs'
  ));

  const transferPath = path.join(programDir, 'server', 'portable', 'transfer_manager.cjs');
  const transferSource = fs.readFileSync(transferPath, 'utf8');
  write(transferPath, replaceCount(
    transferSource,
    new RegExp(`serverVersion='${currentVersion.replace(/\./g, '\\.')}'`, 'g'),
    `serverVersion='${target}'`,
    1,
    'server/portable/transfer_manager.cjs'
  ));

  const exportPath = path.join(programDir, 'tools', 'portable_export_stopped.cjs');
  const exportSource = fs.readFileSync(exportPath, 'utf8');
  write(exportPath, replaceCount(
    exportSource,
    new RegExp(`options\\.version\\|\\|'${currentVersion.replace(/\./g, '\\.')}'`, 'g'),
    `options.version||'${target}'`,
    2,
    'tools/portable_export_stopped.cjs'
  ));

  return { previousVersion: currentVersion, version: target, changedFiles };
}

module.exports = {
  compareVersions,
  nextPatchVersion,
  validateTargetVersion,
  applyReleaseVersion
};
