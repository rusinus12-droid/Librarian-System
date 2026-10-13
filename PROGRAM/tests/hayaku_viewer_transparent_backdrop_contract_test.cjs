const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, '../plugins/HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(sourcePath, 'utf8');

assert.match(source, releasePattern("\\/\\/@version {hayaku}\\b", ""), 'transparent viewer patch must remain present in the current release');
assert.match(
  source,
  /const viewerEnsureRoot = \(\) => \{[\s\S]*?root\.style\.width = '100%';[\s\S]*?root\.style\.height = '100dvh';[\s\S]*?root\.style\.position = 'fixed';[\s\S]*?root\.style\.inset = '0';[\s\S]*?root\.style\.background = 'var\(--page-bg,#cdd5d8\)';[\s\S]*?root\.dataset\.hayakuViewerBackdrop = 'translucent';[\s\S]*?Memory\.ledgerViewer\.root = root;/,
  'viewer root must reapply the full-screen mockup canvas on each open'
);
assert.doesNotMatch(
  source,
  /root\.style\.background = '#0b1020'/,
  'legacy opaque fullscreen backdrop must be removed'
);
assert.match(
  source,
  /\.app\{position:relative;width:100%;height:100%;display:grid;grid-template-columns:var\(--side-w\) minmax\(0,1fr\);/,
  'the adopted mockup app shell must own the visible panel surface and layout'
);
assert.match(
  source,
  /#\$\{LEDGER_VIEWER_ROOT_ID\} \.stage\{width:100%;height:100%;padding:14px;overflow:auto\}/,
  'the canonical stage must remain scoped to the HAYAKU full-screen root'
);
assert.doesNotMatch(
  source,
  /root\.style\.pointerEvents\s*=\s*['"]none['"]/,
  'transparent fullscreen root must continue blocking outside clicks'
);
assert.match(
  source,
  /const forceTransparentGuiCanvas = \(\) => \{[\s\S]*?node\.style\.setProperty\('background', 'transparent', 'important'\);[\s\S]*?node\.style\.setProperty\('background-image', 'none', 'important'\);/,
  'iframe document canvas must stay transparent behind the product shell'
);
assert.match(
  source,
  /showContainer\('fullscreen'\)/,
  'viewer must retain fullscreen modal container behavior'
);

console.log('HAYAKU transparent viewer backdrop contract passed');
