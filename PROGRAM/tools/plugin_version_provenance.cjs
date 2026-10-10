'use strict';

const HASH = /^[0-9a-f]{64}$/i;
const VERSION = /^\d+\.\d+\.\d+$/;

function digest(value) {
  return typeof value === 'string' && HASH.test(value) ? value.toLowerCase() : null;
}

function validateProvenance(catalog, actual) {
  const errors = [];
  const fail = (code, detail = '') => errors.push({ code, detail });
  if (!catalog || catalog.schema !== 'librarian.plugin-release-provenance.v2') {
    fail('catalog_schema_invalid');
    return errors;
  }
  if (catalog.profile !== 'source' || actual?.profile !== 'source') {
    fail('catalog_profile_invalid', `${catalog.profile || '<missing>'}:${actual?.profile || '<missing>'}`);
    return errors;
  }
  if (!Array.isArray(catalog.releases)) fail('historical_releases_invalid');
  if (!Array.isArray(catalog.historicalAnomalies)) fail('historical_anomalies_invalid');
  if (!actual || !actual.plugins || typeof actual.plugins !== 'object' || Array.isArray(actual.plugins)) {
    fail('actual_plugins_invalid');
    return errors;
  }

  const historical = new Map();
  const addHistorical = (owner, info, releaseIndex) => {
    if (!owner || !info || typeof info !== 'object' || !VERSION.test(String(info.version || ''))
      || !digest(info.sha256) || !Number.isSafeInteger(info.bytes) || info.bytes <= 0) {
      fail('historical_row_invalid', `release[${releaseIndex}]:${owner || '<missing>'}`);
      return;
    }
    const key = `${owner}\0${info.version}`;
    if (!historical.has(key)) historical.set(key, { owner, version: info.version, hashes: new Set() });
    historical.get(key).hashes.add(digest(info.sha256));
  };

  if (Array.isArray(catalog.releases)) {
    catalog.releases.forEach((release, index) => {
      if (!release || !release.plugins || typeof release.plugins !== 'object' || Array.isArray(release.plugins)) {
        fail('historical_release_invalid', `release[${index}]`);
        return;
      }
      for (const [owner, info] of Object.entries(release.plugins)) addHistorical(owner, info, index);
    });
  }

  const expectedAnomalies = new Map([...historical]
    .filter(([, value]) => value.hashes.size > 1)
    .map(([key, value]) => [key, [...value.hashes].sort()]));
  const declaredAnomalies = new Map();
  if (Array.isArray(catalog.historicalAnomalies)) {
    for (const row of catalog.historicalAnomalies) {
      const hashes = Array.isArray(row?.sha256) ? row.sha256.map(digest) : null;
      if (!row || typeof row.owner !== 'string' || !VERSION.test(String(row.version || ''))
        || !hashes || hashes.some(value => value === null)) {
        fail('historical_anomaly_invalid');
        continue;
      }
      const key = `${row.owner}\0${row.version}`;
      if (declaredAnomalies.has(key)) {
        fail('historical_anomaly_duplicate', `${row.owner}:${row.version}`);
        continue;
      }
      declaredAnomalies.set(key, [...new Set(hashes)].sort());
    }
  }
  const anomalyKeys = new Set([...expectedAnomalies.keys(), ...declaredAnomalies.keys()]);
  for (const key of anomalyKeys) {
    const expected = expectedAnomalies.get(key);
    const declared = declaredAnomalies.get(key);
    if (!expected || !declared || expected.length !== declared.length
      || expected.some((hash, index) => hash !== declared[index])) {
      const [owner, version] = key.split('\0');
      fail('historical_anomaly_mismatch', `${owner}:${version}`);
    }
  }

  const current = catalog.currentRelease;
  if (!current || !current.plugins || typeof current.plugins !== 'object' || Array.isArray(current.plugins)) {
    fail('current_release_invalid');
    return errors;
  }
  if (!VERSION.test(String(current.packageVersion || ''))
    || current.packageVersion !== actual.packageVersion) {
    fail('current_package_version_mismatch', `${current.packageVersion || '<missing>'}:${actual.packageVersion || '<missing>'}`);
  }
  const actualOwners = Object.keys(actual.plugins).sort();
  const catalogOwners = Object.keys(current.plugins).sort();
  if (actualOwners.length !== catalogOwners.length
    || actualOwners.some((owner, index) => owner !== catalogOwners[index])) {
    fail('current_plugin_set_mismatch', `catalog=${catalogOwners.join(',')} actual=${actualOwners.join(',')}`);
  }

  for (const owner of actualOwners) {
    const observed = actual.plugins[owner];
    const recorded = current.plugins[owner];
    const observedHash = digest(observed?.sha256);
    const recordedHash = digest(recorded?.sha256);
    if (!observed || !recorded || !VERSION.test(String(observed.version || ''))
      || !observedHash || !Number.isSafeInteger(observed.bytes) || observed.bytes <= 0
      || !VERSION.test(String(recorded?.version || '')) || !recordedHash
      || !Number.isSafeInteger(recorded?.bytes) || recorded.bytes <= 0
      || observed.version !== recorded.version || observedHash !== recordedHash || observed.bytes !== recorded.bytes) {
      fail('current_row_mismatch', owner);
      continue;
    }
    const prior = historical.get(`${owner}\0${observed.version}`);
    if (prior && (prior.hashes.size > 1 || !prior.hashes.has(observedHash))) {
      fail('current_version_collision', `${owner}:${observed.version}`);
    }
  }
  return errors;
}

function buildSourceCandidate(catalog, actual) {
  const candidate = structuredClone(catalog);
  if (!candidate.currentRelease || !actual?.plugins) throw new Error('source_candidate_input_invalid');
  if (candidate.currentRelease.packageVersion !== actual.packageVersion) throw new Error('source_package_version_mismatch');
  if (candidate.currentRelease.archiveSha256 || candidate.currentRelease.sourceState === 'published') {
    throw new Error('source_published_current_release_refused');
  }
  const plugins = {};
  for (const [owner, observed] of Object.entries(actual.plugins)) {
    if (!VERSION.test(String(observed?.version || ''))) throw new Error(`source_version_invalid:${owner}`);
    const prior = (catalog.releases || []).flatMap(release => release?.plugins?.[owner] ? [release.plugins[owner]] : []);
    const atVersion = prior.filter(row => row.version === observed.version);
    const hashes = new Set(atVersion.map(row => digest(row.sha256)));
    const collision = hashes.size > 1 || (hashes.size === 1 && !hashes.has(digest(observed.sha256)));
    let nextVersion = observed.version;
    if (collision) {
      const parts = observed.version.split('.').map(Number);
      const occupied = new Set(prior.map(row => row.version));
      if (catalog.currentRelease.plugins?.[owner]?.version) occupied.add(catalog.currentRelease.plugins[owner].version);
      do {
        parts[2] += 1;
        if (!parts.every(Number.isSafeInteger)) throw new Error(`source_patch_overflow:${owner}`);
        nextVersion = parts.join('.');
      } while (occupied.has(nextVersion));
    }
    plugins[owner] = { version: nextVersion, sha256: observed.sha256, bytes: observed.bytes };
  }
  candidate.currentRelease = {
    ...candidate.currentRelease,
    packageVersion: actual.packageVersion,
    plugins,
    sourceState: 'unpublished-source-candidate',
    producer: 'tools/plugin_version_provenance.cjs',
    note: 'Generated from current readable Source plugin bytes. This unpublished source candidate is not a published archive, deployment, or live-host/model execution receipt. Historical records and anomalies are preserved; prior candidate bytes are backed up separately.'
  };
  const plannedActual = { ...actual, plugins };
  const errors = validateProvenance(candidate, plannedActual);
  if (errors.length) throw new Error(`source_candidate_invalid:${JSON.stringify(errors)}`);
  return candidate;
}

// Inspect only the two authored version forms. Never execute plugin source.
// WM's derived debug version is admitted solely for its exact owner/file/name;
// changing that version requires rebuilding the canonical WM source inputs.
function inspectInternalVersion(source, identity = {}) {
  const fail = () => { throw new Error('source_version_mismatch:internal'); };
  if ([...source.matchAll(/^\s*const PLUGIN_VERSION\s*=/gm)].length !== 1) fail();
  const literal = [...source.matchAll(/^\s*const PLUGIN_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]\s*;/gm)];
  const wmSource = identity.owner === 'wm' || identity.file === 'LIBRA_World_Manager.js'
    || /^\/\/@name[ \t]+libra_world_manager[ \t]*\r?$/m.test(source);
  if (literal.length === 1 && !wmSource) return {version:literal[0][1],kind:'literal'};
  if (identity.owner !== 'wm' || identity.file !== 'LIBRA_World_Manager.js'
    || [...source.matchAll(/^\/\/@name[ \t]+libra_world_manager[ \t]*\r?$/gm)].length !== 1) fail();
  const forms = [...source.matchAll(/^\s*const PLUGIN_VERSION = \(\(\) => \{\r?\n([\s\S]*?)^\s*\}\)\(\);/gm)];
  if (forms.length !== 1) fail();
  const body = forms[0][1].split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
  const fallback = [...body.matchAll(/^return '(\d+\.\d+\.\d+)';$/gm)];
  if (fallback.length !== 1) fail();
  const expected = String.raw`try {
const src = String((typeof LIBRA_PLUGIN_SHELL_HEADER !== 'undefined' && LIBRA_PLUGIN_SHELL_HEADER) || '');
const matched = src.match(/@version\s+([0-9][^\s]*)/);
if (matched && matched[1]) return matched[1];
} catch (_) {}
// 폴백 — 헤더를 못 읽어도 실제 버전을 유지한다(0.1 로 회귀 금지).
return '<version>';`;
  if (body.replace(`return '${fallback[0][1]}';`, "return '<version>';") !== expected) fail();
  return {version:fallback[0][1],kind:'wm-derived'};
}

function rewritePluginVersion(bytes, beforeVersion, afterVersion, identity = {}) {
  if (!VERSION.test(beforeVersion) || !VERSION.test(afterVersion)) throw new Error('source_version_invalid');
  const source = bytes.toString('utf8');
  if (!Buffer.from(source).equals(bytes)) throw new Error('source_encoding_invalid');
  const header = /^\/\/@version([ \t]+)(\d+\.\d+\.\d+)([ \t]*)(?=\r?$)/gm;
  const internal = /^(\s*const PLUGIN_VERSION\s*=\s*['"])(\d+\.\d+\.\d+)(['"]\s*;)/gm;
  const display = /^(\/\/@display-name[^\r\n]*?\bv)(\d+\.\d+\.\d+)\b/gm;
  if ([...source.matchAll(/^\/\/@display-name[ \t]+[^\r\n]+(?=\r?$)/gm)].length !== 1) {
    throw new Error('source_version_mismatch:display_directive_count');
  }
  const inspected = inspectInternalVersion(source, identity);
  if (inspected.version !== beforeVersion) throw new Error('source_version_mismatch:internal');
  for (const [label, pattern, required] of [['header', header, true], ['display', display, false]]) {
    const matches = [...source.matchAll(pattern)];
    if ((required && matches.length !== 1) || matches.length > 1 || matches.some(match => match[2] !== beforeVersion)) {
      throw new Error(`source_version_mismatch:${label}`);
    }
  }
  if (beforeVersion === afterVersion) return Buffer.from(bytes);
  if (inspected.kind === 'wm-derived') throw new Error('wm_source_rebuild_required');
  return Buffer.from(source.replace(header, (_, gap, old, tail) => `//@version${gap}${afterVersion}${tail}`)
    .replace(internal, (_, prefix, old, tail) => prefix + afterVersion + tail)
    .replace(display, (_, prefix) => prefix + afterVersion));
}

function readSourceActual(programDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PLUGINS, readReleaseMetadata } = require('./release_metadata.cjs');
  const metadata = readReleaseMetadata(programDir);
  const actual = { profile: 'source', packageVersion: metadata.packageVersion, plugins: {} };
  const sources = {};
  for (const [owner, [file]] of Object.entries(PLUGINS)) {
    const bytes = fs.readFileSync(path.join(programDir, 'plugins', file));
    const version = metadata.plugins[owner].version;
    rewritePluginVersion(bytes, version, version, {owner,file});
    actual.plugins[owner] = { version, sha256: metadata.plugins[owner].sha256, bytes: bytes.length, file };
    sources[owner] = bytes;
  }
  return { actual, sources };
}

function renderCurrentRelease(catalogBytes, currentRelease) {
  const source = catalogBytes.toString('utf8');
  if (!Buffer.from(source).equals(catalogBytes)) throw new Error('catalog_encoding_invalid');
  const matches = [...source.matchAll(/^  "currentRelease": (\{)/gm)];
  if (matches.length !== 1) throw new Error('catalog_current_release_layout_invalid');
  const start = matches[0].index + matches[0][0].length - 1;
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let index = start; index < source.length; index++) {
    const ch = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  if (end < 0) throw new Error('catalog_current_release_layout_invalid');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const replacement = JSON.stringify(currentRelease, null, 2).split('\n').map((line, index) => index ? '  ' + line : line).join(newline);
  const result = Buffer.from(source.slice(0, start) + replacement + source.slice(end));
  JSON.parse(result.toString('utf8'));
  return result;
}

function prepareSourceRefresh(programDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const catalogPath = path.join(programDir, 'docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json');
  const catalogBytes = fs.readFileSync(catalogPath);
  const original = JSON.parse(catalogBytes.toString('utf8'));
  const { actual, sources } = readSourceActual(programDir);
  const catalog = buildSourceCandidate(original, actual);
  const updates = [];
  for (const [owner, observed] of Object.entries(actual.plugins)) {
    const version = catalog.currentRelease.plugins[owner].version;
    const after = rewritePluginVersion(sources[owner], observed.version, version, {owner,file:observed.file});
    updates.push({ owner, file: path.join(programDir, 'plugins', observed.file),
      before: sources[owner], after, beforeVersion: observed.version, afterVersion: version });
    actual.plugins[owner] = { ...observed, version, sha256: hash(after), bytes: after.length };
    catalog.currentRelease.plugins[owner] = { version, sha256: hash(after), bytes: after.length };
  }
  const errors = validateProvenance(catalog, actual);
  if (errors.length) throw new Error(`source_candidate_invalid:${JSON.stringify(errors)}`);
  if (JSON.stringify(original.releases) !== JSON.stringify(catalog.releases)
    || JSON.stringify(original.historicalAnomalies) !== JSON.stringify(catalog.historicalAnomalies)
    || JSON.stringify(original.historicalReleaseCoverage) !== JSON.stringify(catalog.historicalReleaseCoverage)) {
    throw new Error('source_history_mutation_refused');
  }
  const afterCatalog = renderCurrentRelease(catalogBytes, catalog.currentRelease);
  const rendered = JSON.parse(afterCatalog.toString('utf8'));
  if (JSON.stringify(rendered) !== JSON.stringify(catalog)) throw new Error('source_catalog_render_mismatch');
  return { catalog, actual, updates, catalogPath, catalogBytes, afterCatalog,
    changed: !catalogBytes.equals(afterCatalog) || updates.some(update => !update.before.equals(update.after)) };
}

function refreshSourceProvenance(programDir, { write = false, backupFile } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const prepared = prepareSourceRefresh(programDir);
  if (!write || !prepared.changed) return prepared;
  if (!backupFile) throw new Error('source_backup_required');
  const backupPath = path.resolve(backupFile);
  if ([prepared.catalogPath, ...prepared.updates.map(update => update.file)].some(file => path.resolve(file) === backupPath)) {
    throw new Error('source_backup_target_invalid');
  }
  if (fs.existsSync(backupPath)) {
    if (!fs.readFileSync(backupPath).equals(prepared.catalogBytes)) throw new Error('source_backup_conflict');
  } else {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, prepared.catalogBytes, { flag: 'wx' });
  }
  if (!fs.readFileSync(backupPath).equals(prepared.catalogBytes)) throw new Error('source_backup_readback_failed');
  const written = [];
  try {
    for (const update of prepared.updates) {
      if (update.before.equals(update.after)) continue;
      if (!fs.readFileSync(update.file).equals(update.before)) throw new Error(`source_changed_since_plan:${update.owner}`);
      written.push({ file: update.file, before: update.before });
      fs.writeFileSync(update.file, update.after);
      if (!fs.readFileSync(update.file).equals(update.after)) throw new Error(`source_readback_failed:${update.owner}`);
    }
    const readback = readSourceActual(programDir).actual;
    const errors = validateProvenance(prepared.catalog, readback);
    if (errors.length) throw new Error(`source_readback_invalid:${JSON.stringify(errors)}`);
    if (!fs.readFileSync(prepared.catalogPath).equals(prepared.catalogBytes)) throw new Error('catalog_changed_since_plan');
    written.push({ file: prepared.catalogPath, before: prepared.catalogBytes });
    fs.writeFileSync(prepared.catalogPath, prepared.afterCatalog);
    if (!fs.readFileSync(prepared.catalogPath).equals(prepared.afterCatalog)) throw new Error('catalog_readback_failed');
    return { ...prepared, actual: readback };
  } catch (error) {
    const rollbackErrors = [];
    for (const update of written.reverse()) {
      try {
        fs.writeFileSync(update.file, update.before);
        if (!fs.readFileSync(update.file).equals(update.before)) throw new Error('rollback_readback_failed');
      } catch (rollbackError) { rollbackErrors.push(`${update.file}:${rollbackError.message}`); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors.map(detail => new Error(detail))],
      `source_refresh_rollback_failed:${error.message}:${rollbackErrors.join('|')}`);
    throw error;
  }
}

module.exports = { inspectInternalVersion, validateProvenance, buildSourceCandidate, rewritePluginVersion,
  readSourceActual, prepareSourceRefresh, refreshSourceProvenance };

if (require.main === module) {
  const path = require('node:path');
  const args = process.argv.slice(2);
  try {
    if (args.some((arg, index) => !['--write', '--check', '--backup'].includes(arg) && args[index - 1] !== '--backup')
      || args.some((arg, index) => arg === '--backup' && (!args[index + 1] || args[index + 1].startsWith('--')))
      || ['--write', '--check', '--backup'].some(flag => args.filter(arg => arg === flag).length > 1)
      || (args.includes('--write') && args.includes('--check'))) throw new Error('usage: plugin_version_provenance.cjs [--check | --write --backup <file>]');
    const programDir = path.resolve(__dirname, '..');
    const backupIndex = args.indexOf('--backup');
    const result = refreshSourceProvenance(programDir, { write: args.includes('--write'), backupFile: backupIndex < 0 ? undefined : args[backupIndex + 1] });
    console.log(JSON.stringify({ sourceState: result.catalog.currentRelease.sourceState,
      packageVersion: result.actual.packageVersion, changed: result.changed, write: args.includes('--write'),
      versionChanges: result.updates.filter(row => row.beforeVersion !== row.afterVersion).map(row => ({ owner: row.owner, file: row.file, before: row.beforeVersion, after: row.afterVersion })),
      currentPlugins: result.actual.plugins }, null, 2));
    if (args.includes('--check') && result.changed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
