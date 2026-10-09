#!/usr/bin/env node
'use strict';

// This checker reads evidence. It never performs the proposed integration.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const within = (child, parent) => samePath(child, parent)
  || path.relative(path.resolve(parent), path.resolve(child)).split(path.sep)[0] !== '..'
    && !path.isAbsolute(path.relative(path.resolve(parent), path.resolve(child)));
const childOptions = { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 24 * 1024 * 1024 };

function invoke(executable, args, extra = {}) {
  const result = cp.spawnSync(executable, args, { ...childOptions,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, ...extra });
  if (result.error) throw Error(`${executable} read failed: ${result.error.code || result.error.message}`);
  return result;
}
function repository(location) {
  const root = fs.realpathSync(path.resolve(location));
  const prefix = ['--no-pager', '-C', root, '-c', `safe.directory=${root}`];
  const config = invoke('git', [...prefix, 'config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']);
  if (![0, 1].includes(config.status)) throw Error('Cannot inspect configured Git filters');
  const filters = [...new Set(config.stdout.toString().trim().split(/\r?\n/).filter(Boolean)
    .map(key => key.slice(0, key.lastIndexOf('.'))))];
  const guards = ['-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
  for (const filter of filters) for (const [suffix, value] of [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']])
    guards.push('-c', `${filter}.${suffix}=${value}`);
  function git(args, { filemodeFalse = false, allowFailure = false, rawConfig = false, input } = {}) {
    const flags = rawConfig ? [] : guards;
    const argv = [...prefix, ...flags, ...(filemodeFalse ? ['-c', 'core.filemode=false'] : []), ...args];
    const result = invoke('git', argv, input === undefined ? {} : { input });
    if (!allowFailure && result.status !== 0) throw Error(`Git ${args[0]} read failed (exit ${result.status}): ${result.stderr.toString().trim()}`);
    return result;
  }
  const text = args => git(args).stdout.toString().trim();
  const gitDir = fs.realpathSync(path.resolve(root, text(['rev-parse', '--absolute-git-dir'])));
  const commonDir = fs.realpathSync(path.resolve(root, text(['rev-parse', '--git-common-dir'])));
  return { root, gitDir, commonDir, git, text, readPolicy: { optionalLocks: 0, windowsHide: true,
    hooks: 'disabled per command', fsmonitor: 'disabled per command', configuredFilters: filters.length,
    safeDirectory: 'exact resolved repository per command; no persistent configuration change' } };
}
function fileState(root, relative) {
  const absolute = path.resolve(root, relative);
  if (!within(absolute, root)) throw Error('Git path escapes its repository');
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return { path: relative, kind: 'symlink', sha256: digest(Buffer.from(fs.readlinkSync(absolute))) };
    if (!stat.isFile()) return { path: relative, kind: 'unsupported' };
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(absolute, 'r');
    try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(fd); }
    return { path: relative, kind: 'file', bytes: stat.size, sha256: hash.digest('hex') };
  } catch (error) { if (error.code === 'ENOENT') return { path: relative, kind: 'missing' }; throw error; }
}
function statusEntries(bytes) {
  const rows = bytes.toString().split('\0'), entries = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; if (!row) continue;
    if (row.startsWith('1 ')) { const fields = row.split(' '); entries.push({ type: 'ordinary', xy: fields[1], headMode: fields[3], indexMode: fields[4], diskMode: fields[5], path: fields.slice(8).join(' ') }); }
    else if (row.startsWith('2 ')) { const fields = row.split(' '); entries.push({ type: 'rename', xy: fields[1], path: fields.slice(9).join(' '), originalPath: rows[++i] }); }
    else if (row.startsWith('? ')) entries.push({ type: 'untracked', xy: '??', path: row.slice(2) });
    else if (row.startsWith('u ')) { const fields = row.split(' '); entries.push({ type: 'unmerged', xy: fields[1], path: fields.slice(10).join(' ') }); }
    else throw Error('Unsupported porcelain-v2 status record');
  }
  return entries;
}
function snapshot(repo) {
  const status = repo.git(['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout;
  const entries = statusEntries(status), head = repo.text(['rev-parse', 'HEAD']);
  const optionalHash = file => fs.existsSync(file) ? digest(fs.readFileSync(file)) : null;
  const configurationSHA256 = digest(repo.git(['config', '--null', '--list'], { rawConfig: true }).stdout);
  const dirtyPaths = [...new Set(entries.flatMap(row => [row.path, row.originalPath].filter(Boolean)))].sort();
  return { head, statusSHA256: digest(status), indexSHA256: optionalHash(path.join(repo.gitDir, 'index')),
    configurationSHA256, localConfigSHA256: optionalHash(path.join(repo.commonDir, 'config')),
    worktreeConfigSHA256: optionalHash(path.join(repo.gitDir, 'config.worktree')),
    worktreesSHA256: digest(repo.git(['worktree', 'list', '--porcelain', '-z']).stdout),
    entries, dirtyFiles: dirtyPaths.map(relative => fileState(repo.root, relative)) };
}
function worktrees(repo) {
  const records = []; let row = {};
  for (const field of repo.git(['worktree', 'list', '--porcelain', '-z']).stdout.toString().split('\0')) {
    if (!field) { if (row.worktree) records.push(row); row = {}; continue; }
    const split = field.indexOf(' '); row[split < 0 ? field : field.slice(0, split)] = split < 0 ? true : field.slice(split + 1);
  }
  if (row.worktree) records.push(row); return records;
}
function trackedBytes(repo) {
  const tracked = repo.git(['ls-files', '--stage', '-z']).stdout.toString().split('\0').filter(Boolean).map(row => {
    const split = row.indexOf('\t'), [mode, object, stage] = row.slice(0, split).split(' ');
    return { path: row.slice(split + 1), mode, object, stage: Number(stage) };
  });
  const objects = [...new Set(tracked.filter(row => row.stage === 0).map(row => row.object))], blobs = new Map();
  if (objects.length) {
    const sizes = repo.git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: objects.join('\n') + '\n' }).stdout.toString().trim().split('\n');
    const batches = []; let current = [], bytes = 0;
    for (const line of sizes) {
      const [object, type, sizeText] = line.trim().split(' '), size = Number(sizeText);
      if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) { blobs.set(object, null); continue; }
      if (bytes + size > 16 * 1024 * 1024 && current.length) { batches.push(current); current = []; bytes = 0; }
      current.push(object); bytes += size;
    }
    if (current.length) batches.push(current);
    for (const batch of batches) {
      const output = repo.git(['cat-file', '--batch'], { input: batch.join('\n') + '\n' }).stdout; let offset = 0;
      for (const expected of batch) {
        const end = output.indexOf(10, offset), [object, type, sizeText] = output.subarray(offset, end).toString().split(' '), size = Number(sizeText);
        if (end < 0 || object !== expected || type !== 'blob' || !Number.isSafeInteger(size) || offset + size > output.length) throw Error('Cannot verify Git batch blob framing');
        const start = end + 1, body = output.subarray(start, start + size); if (body.length !== size || output[start + size] !== 10) throw Error('Truncated Git blob evidence');
        blobs.set(object, { bytes: size, sha256: digest(body) }); offset = start + size + 1;
      }
    }
  }
  return tracked.map(row => { const disk = fileState(repo.root, row.path), blob = blobs.get(row.object);
    return { ...row, disk, blob, exact: row.stage === 0 && disk.kind === 'file' && blob != null && disk.bytes === blob.bytes && disk.sha256 === blob.sha256 }; });
}
function physicalIdentity(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error('Source/backup is not an ordinary regular file');
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => typeof stat[key] !== 'bigint')
    || stat.dev <= 0n || stat.ino <= 0n || stat.size < 0n) throw Error('Source/backup physical file identity unavailable');
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
}
function sameEvidence(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function independentPhysicalBackup(sourceFile, backupFile) {
  const files = [sourceFile, backupFile].map(file => path.resolve(file));
  const identities = files.map(file => physicalIdentity(fs.lstatSync(file, { bigint: true })));
  const canonical = files.map(file => fs.realpathSync(file));
  if (samePath(canonical[0], canonical[1])) throw Error('Backup canonical path aliases source');
  if (identities[0].dev === identities[1].dev && identities[0].ino === identities[1].ino) throw Error('Backup physical file aliases source');
  let attributes = null;
  if (process.platform === 'win32') {
    const script = '$ProgressPreference="SilentlyContinue"; $rows=@(); foreach($p in (ConvertFrom-Json $env:LIB_PREFLIGHT_FILE_PATHS)){try{$f=Get-Item -LiteralPath $p -Force -ErrorAction Stop;$rows+=@{path=$p;attributes=[int64]$f.Attributes;reparse=[bool]([int64]$f.Attributes -band 1024)}}catch{$rows+=@{path=$p;error=$_.Exception.Message}}}; ConvertTo-Json -InputObject @($rows) -Compress';
    const result = invoke('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 10000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LIB_PREFLIGHT_FILE_PATHS: JSON.stringify(files) } });
    if (result.status !== 0) throw Error('Read-only Windows file attributes unavailable');
    const records = JSON.parse(result.stdout.toString().replace(/^\uFEFF/, ''));
    if (!Array.isArray(records) || records.length !== files.length || records.some((row, index) => row.error
      || !samePath(row.path, files[index]) || !Number.isSafeInteger(row.attributes) || row.attributes < 0
      || typeof row.reparse !== 'boolean' || row.reparse !== Boolean(row.attributes & 1024))) throw Error('Windows source/backup reparse evidence unavailable');
    if (records.some(row => row.reparse)) throw Error('Source/backup Windows reparse point is not an independent regular file');
    attributes = records.map(row => row.attributes);
  }
  if (!sameEvidence(identities, files.map(file => physicalIdentity(fs.lstatSync(file, { bigint: true }))))
    || files.some((file, index) => !samePath(fs.realpathSync(file), canonical[index]))) throw Error('Source/backup path changed during identity observation');
  return { files, canonical, identities, attributes };
}
function readIndependentBackup(sourceFile, backupFile, expectedSHA256, prior) {
  const before = independentPhysicalBackup(sourceFile, backupFile), descriptors = [];
  if (prior && !sameEvidence(before, prior)) throw Error('Source/backup physical snapshot changed');
  try {
    for (const file of before.files) descriptors.push(fs.openSync(file, 'r'));
    const opened = descriptors.map(fd => physicalIdentity(fs.fstatSync(fd, { bigint: true })));
    if (!sameEvidence(opened, before.identities)) throw Error('Opened source/backup identity differs from path observation');
    const bytes = descriptors.map(fd => fs.readFileSync(fd));
    if (bytes.some(value => digest(value) !== expectedSHA256)) throw Error('Source/backup bytes changed');
    if (!sameEvidence(opened, descriptors.map(fd => physicalIdentity(fs.fstatSync(fd, { bigint: true }))))) throw Error('Opened source/backup changed during bytes read');
    const after = independentPhysicalBackup(sourceFile, backupFile);
    if (!sameEvidence(after, before)) throw Error('Source/backup path changed during bytes read');
    return before;
  } finally { for (const fd of descriptors) fs.closeSync(fd); }
}
function sourceReceipt(input, repo, state, physicalBackups) {
  if (!state.entries.length) return { approved: true, required: false, includedInFrozenSource: false };
  try {
    if (!input || !/^[a-f0-9]{64}$/i.test(input.sha256)) return { approved: false, reason: 'SOURCE_DIRTY_UNAPPROVED' };
    const bytes = fs.readFileSync(input.path); if (digest(bytes) !== input.sha256.toLowerCase()) throw Error('receipt pin changed');
    const receipt = JSON.parse(bytes);
    if (receipt.schema !== 'windows-integration-dirty-source-receipt.v1' || !samePath(receipt.repo, repo.root)
      || ['head', 'statusSHA256', 'indexSHA256', 'configurationSHA256'].some(key => receipt[key] !== state[key])
      || !Array.isArray(receipt.files) || receipt.files.length !== state.dirtyFiles.length) throw Error('source snapshot changed');
    const listed = new Map(receipt.files.map(row => [row.path, row])); if (listed.size !== receipt.files.length) throw Error('duplicate receipt path');
    const verified = [];
    for (const current of state.dirtyFiles) {
      const saved = listed.get(current.path);
      if (!saved || saved.kind !== current.kind || saved.sha256 !== current.sha256 || saved.bytes !== current.bytes) throw Error('source patch changed');
      if (current.kind === 'missing') continue;
      if (current.kind !== 'file' || !saved.backupPath || samePath(saved.backupPath, path.resolve(repo.root, current.path))) throw Error('independent physical backup missing');
      if (saved.backupSHA256 !== current.sha256) throw Error('backup byte pin changed');
      const sourceFile = path.resolve(repo.root, current.path), backupFile = path.resolve(saved.backupPath);
      const evidence = readIndependentBackup(sourceFile, backupFile, current.sha256);
      verified.push({ sourceFile, backupFile, expectedSHA256: current.sha256, evidence });
    }
    physicalBackups.push(...verified);
    return { approved: true, required: true, receiptSHA256: digest(bytes), includedInFrozenSource: false, physicalBackupFiles: state.dirtyFiles.filter(row => row.kind === 'file').length };
  } catch (error) { return { approved: false, reason: 'SOURCE_DIRTY_RECEIPT_MISMATCH', verificationFailure: error.message }; }
}
function osAclObservation(locations) {
  if (process.platform !== 'win32') return { status: 'unknown', reason: 'Windows ACL observation unavailable on this platform', effectiveWrite: 'unknown' };
  const script = '$rows=@(); foreach($p in (ConvertFrom-Json $env:LIB_PREFLIGHT_ACL_PATHS)){try{$a=Get-Acl -LiteralPath $p -ErrorAction Stop;$rows+=@{path=$p;owner=$a.Owner;sddl=$a.Sddl;rules=$a.Access.Count}}catch{$rows+=@{path=$p;error=$_.Exception.Message}}}; ConvertTo-Json -InputObject @($rows) -Compress';
  try {
    const result = invoke('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 10000, env: { ...process.env, LIB_PREFLIGHT_ACL_PATHS: JSON.stringify([...new Set(locations)]) } });
    if (result.status !== 0) throw Error('read-only Get-Acl failed');
    const records = JSON.parse(result.stdout.toString().replace(/^\uFEFF/, ''));
    return { status: records.every(row => row.error) ? 'unknown' : records.some(row => row.error) ? 'partially-observed' : 'observed', effectiveWrite: 'unknown',
      records: records.map(row => ({ path: row.path, owner: row.owner, rules: row.rules, aclSHA256: row.sddl ? digest(Buffer.from(row.sddl)) : null, error: row.error })) };
  } catch (error) { return { status: 'unknown', reason: error.message, effectiveWrite: 'unknown' }; }
}
function permissions(request, repo, acl) {
  const action = request.requestedAction || { id: 'integrate-frozen-refs', kind: 'write', path: repo.commonDir };
  const context = request.permissionContext || {}, result = request.actionResult;
  const scope = (context.approvalRequiredPaths || []).some(parent => within(action.path, parent)) ? 'approval-required'
    : (context.readOnlyPaths || []).some(parent => within(action.path, parent)) ? 'declared-read-only'
      : (context.writeRoots || []).some(parent => within(action.path, parent)) ? 'declared-write-scope' : 'unknown';
  const matched = result && result.id === action.id && result.kind === 'write' && action.kind === 'write'
    && samePath(result.path, action.path) && samePath(action.path, repo.commonDir);
  const reportedAction = result && ['reported-tool-result', 'user-performed-action-result'].includes(result.authority);
  const approval = scope === 'declared-write-scope' || result?.approval?.outcome === 'approved'
    && ['sandbox-auto-review', 'user'].includes(result.approval.authority);
  const writeStatus = matched && result.outcome === 'denied' ? 'denied'
    : matched && reportedAction && approval && result.outcome === 'succeeded' ? 'reported-success-for-this-action-only' : 'unknown';
  return { declaredContext: context, declaredScope: scope, osAcl: acl, requestedAction: action,
    actionResult: result || null, writeStatus, reason: writeStatus === 'unknown'
      ? 'Read-only Git/ACL success cannot prove sandbox approval or a future .git write. No write probe was attempted.' : result.reason || result.outcome,
    resultAuthority: 'caller-supplied exact action receipt; not independently authenticated or reusable for another action' };
}
function checkIntegration(request) {
  const report = { schema: 'windows-integration-preflight.v1', at: new Date().toISOString(), readOnly: true, status: 'BLOCKED', reasons: [] };
  const block = reason => { if (!report.reasons.includes(reason)) report.reasons.push(reason); };
  try {
    if (!request?.source?.repo || !request?.target?.repo || !request.target.ownedWorktree
      || ![request.source.pin, request.target.pin].every(value => /^[a-f0-9]{40}$/i.test(value || ''))
      || ![request.source.ref, request.target.ref, request.target.branch].every(value => typeof value === 'string' && value && !value.startsWith('-'))
      || ![undefined, false, true].includes(request.allowCommandFilemodeFalse)) throw Error('Required exact source/target pins, refs, branch and owned target worktree are invalid');
    const source = repository(request.source.repo), target = repository(request.target.repo), beforeSource = snapshot(source), beforeTarget = snapshot(target);
    report.source = { repo: source.root, ref: request.source.ref, pin: request.source.pin, snapshot: beforeSource, readPolicy: source.readPolicy, frozenFiles: [] };
    report.target = { repo: target.root, ref: request.target.ref, pin: request.target.pin, snapshot: beforeTarget, readPolicy: target.readPolicy };
    const resolvedSource = source.text(['rev-parse', '--verify', '--end-of-options', `${request.source.ref}^{commit}`]);
    const resolvedTarget = target.text(['rev-parse', '--verify', '--end-of-options', `${request.target.ref}^{commit}`]);
    if (resolvedSource !== request.source.pin.toLowerCase()) block('SOURCE_REF_PIN_MISMATCH');
    if (resolvedTarget !== request.target.pin.toLowerCase()) block('TARGET_REF_PIN_MISMATCH');
    if (beforeSource.head !== request.source.pin.toLowerCase()) block('SOURCE_HEAD_PIN_MISMATCH');
    if (beforeTarget.head !== request.target.pin.toLowerCase()) block('TARGET_HEAD_PIN_MISMATCH');
    if (request.target.ref !== request.target.branch && request.target.ref !== `refs/heads/${request.target.branch}`) block('TARGET_BRANCH_REF_MISMATCH');
    const ancestor = source.git(['merge-base', '--is-ancestor', request.target.pin, request.source.pin], { allowFailure: true });
    report.ancestor = { verified: ancestor.status === 0, exitCode: ancestor.status };
    if (ancestor.status !== 0) block(ancestor.status === 1 ? 'TARGET_NOT_ANCESTOR' : 'ANCESTOR_UNAVAILABLE');
    const sourceObject = target.git(['cat-file', '-e', `${request.source.pin}^{commit}`], { allowFailure: true });
    report.target.sourceObjectAvailable = sourceObject.status === 0;
    if (sourceObject.status !== 0) block('TARGET_SOURCE_OBJECT_UNAVAILABLE');
    else {
      const closure = target.git(['rev-list', '--objects', '--missing=print', request.source.pin, `^${request.target.pin}`], { allowFailure: true });
      report.target.incomingObjectsAvailable = closure.status === 0 && !closure.stdout.toString().split('\n').some(row => row.startsWith('?'));
      if (!report.target.incomingObjectsAvailable) block('TARGET_SOURCE_CLOSURE_UNAVAILABLE');
    }
    for (const pin of request.source.files || []) {
      if (!pin.path || path.isAbsolute(pin.path) || pin.path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/i.test(pin.sha256 || '')) throw Error('Invalid frozen source file pin');
      const bytes = source.git(['cat-file', 'blob', `${request.source.pin}:${pin.path}`]).stdout;
      const actual = digest(bytes), verified = actual === pin.sha256.toLowerCase();
      report.source.frozenFiles.push({ path: pin.path, expectedSHA256: pin.sha256, actualSHA256: actual, verified });
      if (!verified) block('SOURCE_FILE_PIN_MISMATCH');
    }
    const physicalBackups = [];
    report.source.dirtyPreservation = sourceReceipt(request.source.dirtyReceipt, source, beforeSource, physicalBackups);
    if (!report.source.dirtyPreservation.approved) block(report.source.dirtyPreservation.reason);
    const occupied = worktrees(target).filter(row => row.branch === `refs/heads/${request.target.branch}`);
    report.target.worktreeOccupancy = occupied;
    if (!samePath(request.target.ownedWorktree, target.root)) block('TARGET_OWNED_WORKTREE_MISMATCH');
    if (occupied.some(row => !samePath(row.worktree, target.root))) block('TARGET_BRANCH_OCCUPIED');
    if (target.text(['branch', '--show-current']) !== request.target.branch) block('TARGET_BRANCH_NOT_CHECKED_OUT');
    const rawWorking = target.git(['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z']).stdout;
    const cached = target.git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--raw', '-z']).stdout;
    const comparisons = trackedBytes(target), byPath = new Map(comparisons.map(row => [row.path, row]));
    const contentDirtyPaths = comparisons.filter(row => !row.exact).map(row => row.path);
    const modeOnlyPaths = beforeTarget.entries.filter(row => row.type === 'ordinary' && row.xy === '.M'
      && row.headMode === row.indexMode && row.indexMode !== row.diskMode && byPath.get(row.path)?.exact
      && ['100644', '100755'].includes(row.indexMode) && ['100644', '100755'].includes(row.diskMode)).map(row => row.path);
    const onlyModes = beforeTarget.entries.length > 0 && beforeTarget.entries.every(row => modeOnlyPaths.includes(row.path))
      && cached.length === 0 && contentDirtyPaths.length === 0;
    const used = request.allowCommandFilemodeFalse === true && onlyModes;
    const effective = used ? target.git(['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z'], { filemodeFalse: true }).stdout : rawWorking;
    const effectiveStatus = used ? target.git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { filemodeFalse: true }).stdout : Buffer.from('');
    report.target = { ...report.target, rawWorking: rawWorking.toString(), cached: cached.toString(), effectiveWorking: effective.toString(),
      rawWorkingSHA256: digest(rawWorking), cachedSHA256: digest(cached), modeOnlyPaths, contentDirtyPaths,
      trackedFileByteComparisons: comparisons.map(row => ({ path: row.path, mode: row.mode, stage: row.stage, exact: row.exact, disk: row.disk, blob: row.blob })),
      commandFilemodeFalseUsed: used };
    if (cached.length || beforeTarget.entries.some(row => row.xy[0] !== '.')) block('TARGET_STAGED_DIRTY');
    if (contentDirtyPaths.length) block('TARGET_CONTENT_OR_EOL_DIRTY');
    if (beforeTarget.entries.length && !(used && effective.length === 0 && effectiveStatus.length === 0)) block('TARGET_WORKTREE_DIRTY');
    report.permissionAssessment = permissions(request, target, osAclObservation([source.root, source.commonDir, target.root, target.commonDir]));
    const afterSource = snapshot(source), afterTarget = snapshot(target);
    let physicalBackupsUnchanged = true;
    try {
      for (const proof of physicalBackups) readIndependentBackup(proof.sourceFile, proof.backupFile, proof.expectedSHA256, proof.evidence);
    } catch (error) {
      physicalBackupsUnchanged = false;
      report.source.dirtyPreservation = { ...report.source.dirtyPreservation, approved: false,
        reason: 'SOURCE_DIRTY_RECEIPT_MISMATCH', verificationFailure: error.message };
      block('SOURCE_DIRTY_RECEIPT_MISMATCH');
    }
    report.source.dirtyPreservation.finalPhysicalBackupRechecked = physicalBackups.length > 0 && physicalBackupsUnchanged;
    report.preservation = { unchanged: JSON.stringify(beforeSource) === JSON.stringify(afterSource) && JSON.stringify(beforeTarget) === JSON.stringify(afterTarget) && physicalBackupsUnchanged,
      physicalBackupsUnchanged: physicalBackups.length ? physicalBackupsUnchanged : null,
      beforeSourceSHA256: digest(Buffer.from(JSON.stringify(beforeSource))), afterSourceSHA256: digest(Buffer.from(JSON.stringify(afterSource))),
      beforeTargetSHA256: digest(Buffer.from(JSON.stringify(beforeTarget))), afterTargetSHA256: digest(Buffer.from(JSON.stringify(afterTarget))) };
    if (!report.preservation.unchanged) block('OBSERVED_STATE_CHANGED_DURING_READS');
    report.gitIntegration = { status: report.reasons.length ? 'blocked' : 'ready', means: 'Frozen committed-source fast-forward prerequisites only; no integration or permission approval performed' };
    report.status = report.gitIntegration.status === 'blocked' || report.permissionAssessment.writeStatus === 'denied' ? 'BLOCKED'
      : report.permissionAssessment.writeStatus === 'reported-success-for-this-action-only' ? 'READY' : 'UNKNOWN';
  } catch (error) { block('READ_OR_INPUT_UNAVAILABLE'); report.error = { action: 'read-only integration preflight', reason: error.message };
    report.gitIntegration = { status: 'blocked' }; report.permissionAssessment ||= { writeStatus: 'unknown' }; }
  return report;
}
module.exports = { checkIntegration };
if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--request') throw Error('Usage: node check_windows_integration_preflight.cjs --request <request.json>');
    const report = checkIntegration(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'READY' ? 0 : report.status === 'UNKNOWN' ? 2 : 1;
  } catch (error) { process.stdout.write(JSON.stringify({ status: 'BLOCKED', readOnly: true, error: { action: 'read request', reason: error.message } }) + '\n'); process.exitCode = 1; }
}
