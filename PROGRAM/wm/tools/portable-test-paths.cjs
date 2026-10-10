'use strict';
// Verification-only resolution of captured absolute module paths. No filesystem
// payload redirection, source transform, transport override or package install.
const Module = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const historical = '/workspace/scratch/d09f18a13aaa/';
const oldBase = historical + 'recovery_20261006T2103Z/restored/WM-supplement/references/checksum-use-candidate-1700/';
const oldPackages = historical + 'min-verification-20261004T2120Z/toolchain/node_modules/';
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  if (typeof request === 'string') {
    if (request.startsWith(oldBase)) request = path.join(root, 'references/immutable-base', request.slice(oldBase.length));
    else if (request.startsWith('references/immutable-base/')) request = path.join(root, request);
    else if (request.startsWith(oldPackages)) request = request.slice(oldPackages.length);
  }
  return resolve.call(this, request, parent, ...rest);
};
