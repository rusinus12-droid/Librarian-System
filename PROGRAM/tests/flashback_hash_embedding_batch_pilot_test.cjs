'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'Flashback_Memory.js'), 'utf8');

// Retained source-wide contracts from original root 120.
// Hash-pilot runtime expectations were retired with model-only embeddings, and the
// Compute SDK was retired from Flashback: recall cosine runs locally.
assert.doesNotMatch(source, /\/\* LIBRARIAN SYSTEM COMPUTE SDK v/, 'Flashback no longer embeds the Compute SDK');
assert.doesNotMatch(source, /createMemorySuiteComputeBridge|MemorySuiteComputeBridge|createMemorySuiteSearchClient/, 'no Compute bridge or search client remains');
assert.doesNotMatch(source, /^\/\/@arg memory_suite_flashback_compute_mode\b/m);
assert.doesNotMatch(source, /memory_suite_compute_pairing|X-Memory-Suite-Compute-Pairing/);
