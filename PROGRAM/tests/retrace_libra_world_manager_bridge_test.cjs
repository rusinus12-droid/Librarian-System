'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'RETRACE.js'), 'utf8');
assert.match(source, /libraApi\?\.rebuildWorldManagerState/);
assert.match(source, /reason: 'retrace_handoff_completed'/);
console.log('retrace_libra_world_manager_bridge_test: ok');
