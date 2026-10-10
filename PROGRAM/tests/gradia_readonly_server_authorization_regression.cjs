'use strict';
// Run the unchanged existing authorization regression against the real handler,
// using the existing in-memory HTTP fixture. No socket listen or network I/O.
const serverPath = require.resolve('../server/server.cjs');
const actual = require(serverPath);
const fixture = require('./fixtures/flashback_in_memory_server_fixture.cjs');
require.cache[serverPath].exports = { ...actual, createMemorySuiteServer: fixture.createMemorySuiteServer };
try { require('./server_authorization_test.cjs'); }
finally { require.cache[serverPath].exports = actual; }
