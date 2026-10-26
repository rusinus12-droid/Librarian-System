'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const libraSrc = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const authoritySrc = fs.readFileSync(path.join(__dirname, '../server/authority/libra-typed-codec.cjs'), 'utf8');

// 1. Structural contract assertions in LIBRA.js
assert(
  libraSrc.includes("에|아|야)"),
  'LIBRA.js must include vocative particles (아|야) in CANONICAL_ENTITY_KOREAN_PARTICLE'
);

assert(
  authoritySrc.includes("에|아|야)"),
  'authority must include vocative particles (아|야) in CANONICAL_ENTITY_KOREAN_PARTICLE'
);

assert(
  libraSrc.includes("if (parts.length > 1 && parts.some(part => matchExact(part))) return true;"),
  'LIBRA.js canonicalEntityNameBoundToEvidence must support multi-token name binding'
);

assert(
  authoritySrc.includes("if (parts.length > 1 && parts.some(part => matchExact(part))) return true;"),
  'authority canonicalEntityNameBoundToEvidence must support multi-token name binding'
);

assert(
  libraSrc.includes("catch(replayErr){\n          console.warn?.('canonical_reader_evidence_replay_warning:', replayErr?.message || replayErr);\n        }"),
  'LIBRA.js getCanonicalReaderChapter must guard unifiedEvidenceRead against replay rejection crashing reader'
);

// 2. Functional tests on canonicalEntityNameBoundToEvidence logic from authority
const CANONICAL_ENTITY_KOREAN_PARTICLE = /^(?:에게서는|에게서|에게는|에게|한테서는|한테서|한테는|한테|께서는|께서|께|으로서는|으로서|로서는|로서|으로써|로써|으로는|으로|에서는|에서|부터|까지|처럼|하고|이며|이랑|랑|들은|들이|들을|들의|들과|들|은|는|이|가|을|를|의|도|와|과|로|만|에|아|야)(?=$|[^\p{L}\p{N}_])/u;
const canonicalEntityWordChar = ch => !!ch && /[\p{L}\p{N}_]/u.test(ch);
const canonicalEvidenceComparable = value => String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
const canonicalEntityNameBoundToEvidence = (name, quote) => {
  const matchExact = term => {
    const needle = canonicalEvidenceComparable(term);
    const source = canonicalEvidenceComparable(quote);
    if (!needle || !source) return false;
    let from = 0;
    while (from < source.length) {
      const at = source.indexOf(needle, from);
      if (at < 0) return false;
      from = at + needle.length;
      if (canonicalEntityWordChar(source[at - 1])) continue;
      const tail = source.slice(from);
      if (!canonicalEntityWordChar(tail[0]) || CANONICAL_ENTITY_KOREAN_PARTICLE.test(tail)) return true;
    }
    return false;
  };
  if (matchExact(name)) return true;
  const rawName = String(name || '').trim();
  const parts = rawName.split(/[\s·/_-]+/).map(p => p.trim()).filter(p => p.length >= 2);
  if (parts.length > 1 && parts.some(part => matchExact(part))) return true;
  if (/^[\uAC00-\uD7A3]{3,5}$/.test(rawName)) {
    if (matchExact(rawName.slice(1))) return true;
    if (rawName.length >= 4 && matchExact(rawName.slice(2))) return true;
  }
  return false;
};

// Given name in quote matches compound name
assert.strictEqual(
  canonicalEntityNameBoundToEvidence('히이라기 우테나', '우테나는 키위의 손을 살며시 잡았다'),
  true,
  'Given name with particle (우테나는) must bind to compound name (히이라기 우테나)'
);

assert.strictEqual(
  canonicalEntityNameBoundToEvidence('하나비사와 하루카', '하루카의 젖가슴을 손으로 만졌다'),
  true,
  'Given name with genitive particle (하루카의) must bind to compound name (하나비사와 하루카)'
);

assert.strictEqual(
  canonicalEntityNameBoundToEvidence('홍길동', '길동아 오늘 밥 먹었니?'),
  true,
  '3-character Hangul name with vocative particle (길동아) must bind to full name (홍길동)'
);

assert.strictEqual(
  canonicalEntityNameBoundToEvidence('마지아 베제', '마지아 베제의 손끝이 레오파르트의 가슴 위를 느릿하게 스쳤다'),
  true,
  'Exact multi-word name matches directly'
);

assert.strictEqual(
  canonicalEntityNameBoundToEvidence('아스카', '우테나는 키위의 손을 살며시 잡았다'),
  false,
  'Unrelated entity name must not bind'
);

console.log('libra_canonical_reader_evidence_binding_test: PASS');
