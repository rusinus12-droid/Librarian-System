'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'Flashback_Memory.js'), 'utf8');
const computeSdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8').trimEnd();

// Retained source-wide contracts from original root 120.
// Hash-pilot runtime expectations were retired with model-only embeddings.
// The cleanup assertion preserves source presence; it is not a lifecycle proof.
assert.equal((source.match(/\/\* LIBRARIAN SYSTEM COMPUTE SDK v/g) || []).length, 1, 'Flashback embeds one explicit Compute SDK marker');
assert.equal(source.split(computeSdk).length - 1, 1, 'Flashback embeds the canonical Compute SDK source exactly once');
assert.doesNotMatch(source, /^\/\/@arg memory_suite_flashback_compute_mode\b/m);
assert.doesNotMatch(source, /memory_suite_compute_pairing|X-Memory-Suite-Compute-Pairing/);
assert.match(source, /await MemorySuiteComputeBridge\?\.dispose\?\.\(\)/, 'primary unload disposes the Compute bridge');
