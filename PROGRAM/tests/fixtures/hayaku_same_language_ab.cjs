'use strict';
// Hand-authored same-language controls. No translations, external corpus,
// embeddings, or inferred truth: each fixture explicitly labels its evidence.
module.exports = Object.freeze([
  { id: 'en-role', language: 'en', relation: 'role', query: 'Mira trusts Rowan.', supported: 'Mira trusts Rowan.', distractor: 'Rowan trusts Mira.' },
  { id: 'ko-role', language: 'ko', relation: 'role', query: '민아가 지호에게 열쇠를 준다.', supported: '민아가 지호에게 열쇠를 준다.', distractor: '지호가 민아에게 열쇠를 준다.' },
  { id: 'ja-role', language: 'ja', relation: 'role', query: 'ミラがローワンに鍵を渡す。', supported: 'ミラがローワンに鍵を渡す。', distractor: 'ローワンがミラに鍵を渡す。' },
  { id: 'en-negation', language: 'en', relation: 'negation', query: 'Mira does not trust Rowan.', supported: 'Mira does not trust Rowan.', distractor: 'Mira does trust Rowan.' },
  { id: 'ko-negation', language: 'ko', relation: 'negation', query: '민아는 지호를 믿지 않는다.', supported: '민아는 지호를 믿지 않는다.', distractor: '민아는 지호를 믿는다.' },
  { id: 'ja-negation', language: 'ja', relation: 'negation', query: 'ミラはローワンを信じない。', supported: 'ミラはローワンを信じない。', distractor: 'ミラはローワンを信じる。' }
]);
