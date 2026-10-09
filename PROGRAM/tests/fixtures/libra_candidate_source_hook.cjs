'use strict';

const fs = require('node:fs');
const path = require('node:path');

const candidate = process.env.LIBRA_TEST_PLUGIN_PATH
  ? path.resolve(process.env.LIBRA_TEST_PLUGIN_PATH)
  : '';

if (!candidate) throw new Error('LIBRA_TEST_PLUGIN_PATH is required');

const canonical = path.resolve(__dirname, '..', '..', 'plugins', 'LIBRA.js');
const originalReadFileSync = fs.readFileSync.bind(fs);

fs.readFileSync = (filePath, ...args) => {
  const resolved = typeof filePath === 'string' || Buffer.isBuffer(filePath)
    ? path.resolve(String(filePath))
    : '';
  return resolved === canonical
    ? originalReadFileSync(candidate, ...args)
    : originalReadFileSync(filePath, ...args);
};
