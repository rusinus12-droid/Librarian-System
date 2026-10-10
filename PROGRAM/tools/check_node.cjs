'use strict';

const version = String(process.versions?.node || '');
const [major, minor] = version.split('.').map(Number);

if (!Number.isInteger(major) || !Number.isInteger(minor)) {
  process.stderr.write(`[Librarian System] Node.js version could not be determined: ${version || 'unknown'}\n`);
  process.exit(3);
}
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`[Librarian System] Node.js 22.13.0 or newer is required for unflagged node:sqlite. Current: v${version}\n`);
  process.exit(22);
}
try {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.exec('SELECT 1;');
  database.close();
} catch (error) {
  process.stderr.write(`[Librarian System] node:sqlite runtime check failed: ${String(error?.message || error)}\n`);
  process.exit(23);
}
process.stdout.write(`v${version}\n`);
