const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, '../plugins/HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(sourcePath, 'utf8');

assert.match(source, releasePattern("\\/\\/@version {hayaku}\\b", ""), 'transparent viewer patch must remain present in the current release');
assert.match(
  source,
  /const viewerEnsureRoot = \(\) => \{[\s\S]*?root\.style\.background = 'rgba\(6,8,14,\.38\)';[\s\S]*?root\.dataset\.hayakuViewerBackdrop = 'translucent';[\s\S]*?Memory\.ledgerViewer\.root = root;/,
  'viewer root must reapply the translucent modal backdrop on every open'
);
assert.doesNotMatch(
  source,
  /root\.style\.background = '#0b1020'/,
  'legacy opaque fullscreen backdrop must be removed'
);
assert.match(
  source,
  /\.hayaku-viewer\{[^}]*position:relative;[^}]*background:var\(--hv-bg\);/,
  'centered HAYAKU window must retain its own opaque surface'
);
assert.match(
  source,
  /\.hv-job-overlay\{position:absolute;/,
  'job overlay must remain scoped to the HAYAKU window'
);
assert.doesNotMatch(
  source,
  /root\.style\.pointerEvents\s*=\s*['"]none['"]/,
  'transparent fullscreen root must continue blocking outside clicks'
);
assert.match(
  source,
  /showContainer\('fullscreen'\)/,
  'viewer must retain fullscreen modal container behavior'
);

console.log('HAYAKU transparent viewer backdrop contract passed');
