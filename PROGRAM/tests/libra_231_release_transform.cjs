'use strict';

const crypto = require('node:crypto');

const EXPECTED_SOURCE_SHA256 = '047049C45F205C617EDE0FBED5035513360B1FA4EF4A68E1327DD06F009DC798';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();

module.exports = (input, { replaceExactlyOnce }) => {
  const actualHash = sha256(Buffer.from(input, 'utf8'));
  if (actualHash !== EXPECTED_SOURCE_SHA256) throw new Error(`libra_231_source_hash_changed:${actualHash}`);

  let source = input;
  const labels = [];
  const replace = (label, before, after) => {
    source = replaceExactlyOnce(source, before, after, label);
    labels.push(label);
  };

  replace(
    'libra_231_header',
    `//@display-name LIBRA v2.3.0
//@version 2.3.0
//@api 3.0
/* v2.3.0 rebuilds`,
    `//@display-name LIBRA v2.3.1
//@version 2.3.1
//@api 3.0
/* v2.3.1 completes the durable State reload gate and the read-only Input Writer delivery boundary: cold recall no longer persists its catalog, Narrative Direction is sealed once per preflight, regenerated candidates retain the matching run snapshot, and sendChat is physically invoked only after host preflight plus a second authority validation. */
/* v2.3.0 rebuilds`
  );
  replace(
    'libra_231_runtime_version',
    `  const PLUGIN_VERSION = '2.3.0';`,
    `  const PLUGIN_VERSION = '2.3.1';`
  );
  replace(
    'libra_231_portable_transition',
    `"old":"2.2.13","new":"2.3.0","pluginVersion":"2.3.0"`,
    `"old":"2.3.0","new":"2.3.1","pluginVersion":"2.3.1"`
  );

  return { source, labels };
};
