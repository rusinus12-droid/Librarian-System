'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateProvenance } = require('../tools/plugin_version_provenance.cjs');

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const row = (version, sha256, bytes = 4) => ({ version, sha256, bytes });
const catalog = (overrides = {}) => ({
  schema: 'librarian.plugin-release-provenance.v2',
  profile: 'source',
  releases: [{ packageVersion: '0.3.67', artifact: 'old.zip', plugins: {
    libra: row('2.3.144', hashA),
    retrace: row('2.3.144', hashB)
  } }],
  historicalAnomalies: [],
  currentRelease: { packageVersion: '0.3.68', artifact: 'Librarian-System-0.3.68-Source.zip', plugins: {
    libra: row('2.3.145', hashC),
    retrace: row('2.3.144', hashB)
  } },
  ...overrides
});
const actual = (overrides = {}) => ({
  profile: 'source',
  packageVersion: '0.3.68',
  plugins: {
    libra: { ...row('2.3.145', hashC), file: 'LIBRA.js' },
    retrace: { ...row('2.3.144', hashB), file: 'RETRACE.js' }
  },
  ...overrides
});
const result = (data = catalog(), bytes = actual()) => validateProvenance(data, bytes);

assert.deepEqual(result(), [], 'complete current owner/version/hash rows pass');
assert.ok(result(catalog({ profile: 'release' })).some(x => x.code === 'catalog_profile_invalid'),
  'source-byte provenance cannot be confused with minified release plugin bytes');
assert.ok(result(catalog({ currentRelease: { packageVersion: '0.3.68', plugins: { libra: row('2.3.145', hashC) } } })).some(x => x.code === 'current_plugin_set_mismatch'),
  'a current release missing a distributed owner is rejected');
assert.ok(result(catalog({ currentRelease: { packageVersion: '0.3.68', plugins: {
  libra: row('2.3.144', hashC), retrace: row('2.3.144', hashB)
} } }), actual({ plugins: {
  libra: { ...row('2.3.144', hashC), file: 'LIBRA.js' }, retrace: { ...row('2.3.144', hashB), file: 'RETRACE.js' }
} })).some(x => x.code === 'current_version_collision'),
  'a third byte stream cannot reuse an owner-scoped historical version');
assert.deepEqual(result(catalog({ currentRelease: { packageVersion: '0.3.68', plugins: {
  libra: row('2.3.144', hashA.toUpperCase()), retrace: row('2.3.144', hashB)
} } }), actual({ plugins: {
  libra: { ...row('2.3.144', hashA), file: 'LIBRA.js' }, retrace: { ...row('2.3.144', hashB), file: 'RETRACE.js' }
} })), [], 'digest comparisons normalize case and unchanged bytes may retain their version');
assert.deepEqual(result(catalog(), actual()), [], 'same version labels across different plugin owners do not collide');
assert.ok(result(catalog({ historicalAnomalies: [{ owner: 'libra', version: '2.3.144', sha256: [hashA.toUpperCase(), hashC].sort() }] }), actual()).some(x => x.code === 'historical_anomaly_mismatch'),
  'known historical collisions require an explicit matching anomaly record');
assert.ok(result(catalog(), actual({ plugins: {
  libra: { ...row('2.3.145', hashA), file: 'LIBRA.js' }, retrace: { ...row('2.3.144', hashB), file: 'RETRACE.js' }
} })).some(x => x.code === 'current_row_mismatch'),
  'current catalog rows must match distributed bytes');
const ambiguousCatalog = catalog({
  releases: [
    { packageVersion: '0.3.65', artifact: 'older.zip', plugins: { libra: row('2.3.144', hashA), retrace: row('2.3.144', hashB) } },
    { packageVersion: '0.3.67', artifact: 'newer.zip', plugins: { libra: row('2.3.144', hashC), retrace: row('2.3.144', hashB) } }
  ],
  historicalAnomalies: [{ owner: 'libra', version: '2.3.144', sha256: [hashA, hashC] }],
  currentRelease: { packageVersion: '0.3.68', artifact: 'current.zip', plugins: {
    libra: row('2.3.144', hashA), retrace: row('2.3.144', hashB)
  } }
});
assert.ok(result(ambiguousCatalog, actual({ plugins: {
  libra: { ...row('2.3.144', hashA), file: 'LIBRA.js' }, retrace: { ...row('2.3.144', hashB), file: 'RETRACE.js' }
} })).some(x => x.code === 'current_version_collision'),
  'a current plugin cannot reuse an explicitly ambiguous historical owner/version, even with one known hash');
const builderSource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build_distribution.cjs'), 'utf8');
assert.ok(builderSource.includes("'plugin_version_provenance_contract_test.cjs'"),
  'release smoke includes the synthetic provenance controls');
console.log(JSON.stringify({ test: 'plugin_version_provenance_contract', controls: 10, ok: true }));
