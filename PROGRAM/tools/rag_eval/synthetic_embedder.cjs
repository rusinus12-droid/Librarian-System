'use strict';
// Offline, deterministic stand-in for a dense embedding model. It is NOT a quality
// claim about any real provider. It reproduces two properties that matter when
// comparing ranking strategies:
//   1. paraphrases share meaning (a small concept lexicon maps synonyms together);
//   2. proper names and exact numbers carry only a weak surface signal (character
//      trigrams), as with many general-purpose embedding models.
// Real-provider numbers come from running the evaluator with RAG_EVAL_EMBED_URL.

const CONCEPTS = [
  ['anger', ['화를', '화가', '화났', '분노', '악물', '노려']],
  ['sad', ['울었', '울어', '눈물', '슬퍼', '슬픈', '울며']],
  ['family', ['동생', '가족', '형제', '자매', '어릴']],
  ['money', ['돈', '금화', '은화', '뱃삯', '가격', '값', '숙박비', '얼마', '닢', '벌었', '마련']],
  ['gift', ['선물', '건넸', '맡겼', '줬', '준 ', '주었']],
  ['fire', ['불이', '화재', '불길', '사고', '탔']],
  ['tower', ['탑', '건물', '높은']],
  ['night', ['자정', '밤늦게', '한밤', '밤']],
  ['meet', ['만나', '만남', '약속', '아래에서', '장소']],
  ['trace', ['흔적', '단추', '발자국', '증거', '남긴']],
  ['intrude', ['침입', '몰래', '들어왔']],
  ['crime', ['밀수', '나쁜', '범죄', '훔치', '도둑', '조직']],
  ['boat', ['배를', '배 ', '선장', '출항', '선착장', '뱃삯', '섬까지']],
  ['door', ['문', '입구', '열려', '열린', '철문', '홈']],
  ['lodging', ['여관', '숙소', '묵을', '하룻밤', '숙박']],
  ['silk', ['비단', '천']],
  ['market', ['시장', '상인', '장수']],
  ['map', ['지도', '별자리', '뒷면', '문장']],
  ['moon', ['달', '초승달']],
  ['missing', ['행방', '목격', '잃어버린', '마지막으로']],
  ['place', ['어디', '곳', '수도원', '섬']],
  ['signature', ['서명', '장부', '페이지']],
  ['food', ['식당', '요리', '고등어', '배가 고파']],
  ['weather', ['비가', '폭우', '안개', '바람']],
  ['necklace', ['목걸이', '조개', '진주']],
  ['brooch', ['브로치', '은 ']],
  ['work', ['일을', '설거지', '장작', '사흘']],
  ['reason', ['왜', '이유', '때문']],
  ['comfort', ['위로', '진정']],
  ['story', ['이야기', '옛이야기', '털어놓']]
];
const HASH_DIM = 64;
const DIM = CONCEPTS.length + HASH_DIM;
const SURFACE_WEIGHT = 0.35;

const fnv = value => { let h = 2166136261; for (const ch of value) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

function embed(text) {
  const source = ` ${String(text || '').normalize('NFKC')} `;
  const vector = new Array(DIM).fill(0);
  CONCEPTS.forEach(([, stems], index) => {
    for (const stem of stems) {
      let from = 0, at;
      while ((at = source.indexOf(stem, from)) >= 0) { vector[index] += 1; from = at + stem.length; }
    }
  });
  const compact = source.replace(/\s+/g, ' ');
  for (let i = 0; i + 3 <= compact.length; i += 1) {
    const gram = compact.slice(i, i + 3);
    if (!gram.trim()) continue;
    vector[CONCEPTS.length + (fnv(gram) % HASH_DIM)] += SURFACE_WEIGHT / 3;
  }
  // Floor keeps unrelated texts at a small positive cosine like real models do.
  for (let i = 0; i < DIM; i += 1) vector[i] += 0.02;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

module.exports = { embed, DIM, name: 'synthetic-concept-trigram-v1' };
