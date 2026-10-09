'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = {
  name: 'linux',
  validateRoot(root) {
    const resolved = path.resolve(root);
    return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
  }
};
