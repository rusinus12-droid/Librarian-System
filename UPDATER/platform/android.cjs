'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = {
  name:'android',
  validateRoot(root) {
    const raw = String(root || '');
    // A POSIX path evaluated on a Windows host must be resolved with POSIX
    // semantics, otherwise path.resolve rewrites it to a drive path and the
    // shared-storage guard silently misses.
    const simulatedPosix = process.platform === 'win32' && /^\//.test(raw.replace(/\\/g,'/'));
    const resolved = simulatedPosix ? path.posix.resolve(raw.replace(/\\/g,'/')) : path.resolve(raw);
    const canonical = !simulatedPosix && fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
    const normalized = canonical.replace(/\\/g,'/').toLowerCase();
    if (/^\/(?:sdcard|storage|mnt\/media_rw|mnt\/runtime|mnt\/user|data\/media)(?:\/|$)/.test(normalized)) {
      throw new Error(`android_shared_storage_installation_blocked:${canonical}`);
    }
    return canonical;
  }
};
