'use strict';
// Run the new regression boundary against both actual deployment artifacts.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = false;
for (const variant of ['full', 'min']) {
  for (const file of ['libra_pending_ownership_test.cjs', 'libra_pending_capture_health_test.cjs']) {
    const result = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, file)], {
      cwd: root, stdio: 'inherit', env: { ...process.env, WM_PENDING_VARIANT: variant, WM_PENDING_PHASE: `package-${variant}` }
    });
    if (result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
