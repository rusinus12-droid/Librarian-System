'use strict';

const crypto = require('node:crypto');
// Reference kernels of the retired server Compute plane, kept only as test oracles for
// the plugins' local implementations (exact parity and fingerprints). Nothing ships them.
function computeError(code, statusCode = 500, details = {}) {
  const error = new Error(String(code || 'compute_error'));
  error.code = String(code || 'COMPUTE_ERROR').toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  error.statusCode = statusCode;
  error.compute = true;
  for (const [key, value] of Object.entries(details || {})) error[key] = value;
  return error;
}

const OWNER_NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra', 'lia']);
const ALL_NAMESPACES = Object.freeze([...OWNER_NAMESPACES, 'retrace']);

const descriptorFingerprint = descriptor => crypto.createHash('sha256')
  .update(String(descriptor), 'utf8')
  .digest('hex');

const finiteNumber = (value, code) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw computeError(code, 400);
  return number;
};

const flashbackText = value => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flashbackText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return value.content.map(flashbackText).filter(Boolean).join('\n');
    if (Array.isArray(value.parts)) return value.parts.map(flashbackText).filter(Boolean).join('\n');
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value);
};

const flashbackFNV1a = value => {
  let hash = 0x811c9dc5;
  const source = flashbackText(value);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const flashbackHashEmbedding = (value, dimensions = 384) => {
  const parsed = Number.parseInt(dimensions, 10);
  const dims = Number.isFinite(parsed) ? Math.max(64, Math.min(4096, parsed)) : 384;
  const vector = new Array(dims).fill(0);
  const source = flashbackText(value).toLowerCase();
  const tokens = source.match(/[a-z0-9가-힣一-龥ぁ-んァ-ン]{1,}/g) || [];
  const maxGrams = 4000;
  let gramCount = 0;
  const addGram = gram => {
    if (gramCount >= maxGrams) return false;
    const hash = flashbackFNV1a(gram);
    const vectorIndex = hash % dims;
    const sign = (hash & 1) ? 1 : -1;
    vector[vectorIndex] += sign * (1 + Math.min(gram.length, 8) / 8);
    gramCount += 1;
    return gramCount < maxGrams;
  };
  for (const token of tokens) {
    if (!addGram(token)) break;
    if (token.length >= 2) {
      const characters = Array.from(token);
      let keepGoing = true;
      for (let size = 2; size <= Math.min(4, characters.length); size += 1) {
        for (let offset = 0; offset <= characters.length - size; offset += 1) {
          keepGoing = addGram(characters.slice(offset, offset + size).join(''));
          if (!keepGoing) break;
        }
        if (!keepGoing) break;
      }
      if (!keepGoing) break;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return vector.map(value => value / norm);
};

function flashbackHashEmbeddingBatch(input) {
  const texts = Array.isArray(input?.texts) ? input.texts : null;
  if (!texts || texts.length > 512) throw computeError('compute_flashback_hash_texts_invalid', 400);
  const parsed = Number.parseInt(input?.dimensions, 10);
  const dimensions = Number.isFinite(parsed) ? Math.max(64, Math.min(4096, parsed)) : 384;
  let totalChars = 0;
  for (const value of texts) {
    totalChars += flashbackText(value).length;
    if (totalChars > 2_000_000) throw computeError('compute_flashback_hash_chars_limit_exceeded', 413);
  }
  if (texts.length * dimensions > 262144) throw computeError('compute_flashback_hash_vector_limit_exceeded', 413);
  return {
    vectors: texts.map(value => flashbackHashEmbedding(value, dimensions)),
    count: texts.length,
    dimensions,
    totalChars
  };
}

function sha256Batch(input) {
  const values = Array.isArray(input?.values) ? input.values : null;
  if (!values || values.length > 10000) throw computeError('compute_sha256_values_invalid', 400);
  let totalBytes = 0;
  const digests = values.map(value => {
    if (typeof value !== 'string') throw computeError('compute_sha256_string_required', 400);
    totalBytes += Buffer.byteLength(value, 'utf8');
    if (totalBytes > 4 * 1024 * 1024) throw computeError('compute_sha256_input_too_large', 413);
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  });
  return { digests, count: digests.length, totalBytes };
}

function vectorRank(input) {
  const query = Array.isArray(input?.query) ? input.query : null;
  const candidates = Array.isArray(input?.candidates) ? input.candidates : null;
  if (!query || query.length < 1 || query.length > 4096) throw computeError('compute_vector_query_invalid', 400);
  if (!candidates || candidates.length > 20000) throw computeError('compute_vector_candidates_invalid', 400);
  if (query.length * candidates.length > 2_000_000) throw computeError('compute_vector_cost_limit_exceeded', 413);
  const normalizedQuery = query.map(value => finiteNumber(value, 'compute_vector_non_finite_query'));
  const queryNorm = Math.sqrt(normalizedQuery.reduce((sum, value) => sum + (value * value), 0));
  const cosineWeight = finiteNumber(input?.cosineWeight ?? 1, 'compute_vector_cosine_weight_invalid');
  const baseWeight = finiteNumber(input?.baseWeight ?? 0, 'compute_vector_base_weight_invalid');
  const topK = Math.max(0, Math.min(candidates.length, 1000, Math.floor(finiteNumber(input?.topK ?? candidates.length, 'compute_vector_top_k_invalid'))));
  const seenIds = new Set();
  const ranked = candidates.map((candidate, index) => {
    const id = String(candidate?.id || '').trim();
    if (!id || id.length > 320 || seenIds.has(id)) throw computeError('compute_vector_candidate_id_invalid', 400);
    seenIds.add(id);
    const vector = Array.isArray(candidate?.vector) ? candidate.vector : null;
    if (!vector || vector.length !== normalizedQuery.length) throw computeError('compute_vector_dimension_mismatch', 400);
    let dot = 0;
    let normSquared = 0;
    for (let offset = 0; offset < vector.length; offset += 1) {
      const value = finiteNumber(vector[offset], 'compute_vector_non_finite_candidate');
      dot += value * normalizedQuery[offset];
      normSquared += value * value;
    }
    const denominator = queryNorm * Math.sqrt(normSquared);
    const cosine = denominator > 0 ? dot / denominator : 0;
    const baseScore = finiteNumber(candidate?.baseScore ?? 0, 'compute_vector_base_score_invalid');
    const score = (cosine * cosineWeight) + (baseScore * baseWeight);
    return { id, score, cosine, baseScore, index };
  });
  ranked.sort((left, right) => (
    (right.score - left.score)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    || (left.index - right.index)
  ));
  return { candidates: ranked.slice(0, topK), totalCandidates: ranked.length, dimensions: normalizedQuery.length };
}

const liaCompact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const liaUnique = (values, max = 16) => {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = liaCompact(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
};
const liaLoreTokenize = (value, max = 160) => {
  const matches = String(value || '').toLowerCase().match(/[a-z0-9가-힣ぁ-んァ-ヶ一-龠]{2,}/g) || [];
  return liaUnique(matches.filter(token => !/^(the|and|for|with|from|this|that|into|있는|없는|대한|위한|그리고|또는|에서|으로|에게|하는|한다)$/.test(token)), max);
};
const liaLoreEntryText = entry => `${entry?.key || ''}\n${entry?.secondkey || ''}\n${entry?.comment || ''}\n${entry?.content || ''}`.trim();
const liaLoreProtection = entry => {
  const meta = `${entry?.key || ''} ${entry?.secondkey || ''} ${entry?.comment || ''}`.toLowerCase();
  const all = liaLoreEntryText(entry).toLowerCase();
  const reasons = [];
  let priority = 0;
  if (entry?.alwaysActive) { reasons.push('alwaysActive'); priority += 120; }
  if (entry?.mode === 'constant') { reasons.push('constant'); priority += 110; }
  const worldRuleHeader = /(?:world|setting|canon|rules?|law|species|race|naming|name rule|power system|magic system|technology|social structure|hierarchy|class system|religion|geography|timeline|세계관|세계 규칙|설정|캐논|규칙|법률|법칙|종족|작명|이름 규칙|능력 체계|마법 체계|기술 수준|사회 구조|계급|신분|종교|지리|연표)/i.test(meta);
  if (worldRuleHeader) { reasons.push('world_rule_header'); priority += 90; }
  const hasHardNegation = /(?:only humans?|human[- ]only|does not exist|do not exist|cannot exist|forbidden|prohibited|impossible|must not|never exists?|인간만|오직 인간|존재하지 않|없음|없다|금지|불가능|허용되지 않|해서는 안|할 수 없)/i.test(all);
  const hasWorldDomain = /(?:species|race|magic|power|ability|technology|law|rule|world|setting|social|class|naming|language|종족|마법|능력|기술|법|규칙|세계|설정|사회|계급|신분|작명|언어)/i.test(all);
  const hard = hasHardNegation && hasWorldDomain;
  if (hard) { reasons.push('hard_constraint'); priority += 140; }
  const soft = !hard && (entry?.alwaysActive === true || entry?.mode === 'constant' || worldRuleHeader);
  return { protected: hard || soft, hard, soft, tier: hard ? 'hard' : soft ? 'soft' : 'none', reasons: liaUnique(reasons, 8), priority };
};
const liaLoreFieldTokenCounts = value => {
  const counts = new Map();
  for (const token of liaLoreTokenize(value, 400)) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
};
const liaLoreCorpusStats = (entries, queryTokens) => {
  const documentFrequency = new Map(queryTokens.map(token => [token, 0]));
  const docs = entries.map(entry => {
    const fields = {
      key: liaLoreFieldTokenCounts(entry?.key || ''),
      secondkey: liaLoreFieldTokenCounts(entry?.secondkey || ''),
      comment: liaLoreFieldTokenCounts(entry?.comment || ''),
      content: liaLoreFieldTokenCounts(entry?.content || '')
    };
    const seen = new Set();
    for (const field of Object.values(fields)) for (const token of field.keys()) if (documentFrequency.has(token)) seen.add(token);
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    return { entry, fields };
  });
  const total = Math.max(1, docs.length);
  const idf = new Map(queryTokens.map(token => {
    const df = Number(documentFrequency.get(token) || 0);
    return [token, Math.log(1 + (total - df + 0.5) / (df + 0.5))];
  }));
  return { docs, idf };
};
const liaLoreBm25fScore = (doc, queryTokens, idf) => {
  const weights = { key: 3.4, secondkey: 2.8, comment: 1.8, content: 1.0 };
  const k1 = 1.2;
  let raw = 0;
  let idfTotal = 0;
  const matches = [];
  const rareMatches = [];
  for (const token of queryTokens) {
    const tokenIdf = Number(idf.get(token) || 0);
    idfTotal += tokenIdf;
    let weightedTf = 0;
    for (const [fieldName, fieldCounts] of Object.entries(doc.fields)) weightedTf += Number(fieldCounts.get(token) || 0) * weights[fieldName];
    if (weightedTf <= 0) continue;
    raw += tokenIdf * ((weightedTf * (k1 + 1)) / (weightedTf + k1));
    if (matches.length < 8) matches.push(token);
    if (tokenIdf >= 1.15 && rareMatches.length < 6) rareMatches.push(token);
  }
  return { score: idfTotal > 0 ? Math.min(1, raw / Math.max(1.4, idfTotal * 1.45)) : 0, matches, rareMatches };
};
const liaLoreExactAnchorScore = (entry, queryText) => {
  const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const query = norm(queryText);
  if (!query) return { score: 0, matches: [] };
  const key = norm(entry?.key || '');
  const secondkey = norm(entry?.secondkey || '');
  const anchors = liaUnique([key, secondkey, norm(entry?.comment || '')].filter(value => value.length >= 2 && value.length <= 120), 12);
  const hits = anchors.filter(anchor => query.includes(anchor));
  let score = 0;
  if (key && hits.includes(key)) score += 0.7;
  if (secondkey && hits.includes(secondkey)) score += 0.2;
  if (hits.length >= 2) score += 0.1;
  return { score: Math.min(1, score), matches: hits.slice(0, 4) };
};
const liaLoreWorldDomainScore = entry => {
  const text = liaLoreEntryText(entry).toLowerCase();
  let score = 0;
  if (/world|setting|canon|rule|law|species|race|naming|language|culture|technology|magic|power system|social|hierarchy|class|institution|government|religion|geography|timeline|세계|설정|캐논|규칙|법|종족|작명|언어|문화|기술|마법|능력 체계|사회|계급|기관|정부|종교|지리|연표/i.test(text)) score += 0.55;
  if (/school|academy|guild|company|military|police|church|family system|학교|학원|길드|회사|군대|경찰|교회|가문/i.test(text)) score += 0.25;
  if (entry?.source === 'character_lore') score += 0.08;
  if (entry?.source === 'module_lore') score += 0.04;
  if (entry?.insertorder > 0) score += Math.min(0.08, entry.insertorder / 12000);
  return Math.min(1, score);
};
const liaLoreScoreReasons = (entry, bm25f, exactAnchor, domainScore, protection) => {
  const reasons = [];
  if (protection?.hard) reasons.push(`강한 보호 규칙: ${protection.reasons.join(', ')}`);
  else if (protection?.soft) reasons.push(`보호 후보: ${protection.reasons.join(', ')}`);
  if (exactAnchor?.matches?.length) reasons.push(`정확 구문: ${exactAnchor.matches.slice(0, 3).join(', ')}`);
  if (bm25f?.rareMatches?.length) reasons.push(`희귀어: ${bm25f.rareMatches.slice(0, 4).join(', ')}`);
  else if (bm25f?.matches?.length) reasons.push(`BM25F: ${bm25f.matches.slice(0, 5).join(', ')}`);
  if (domainScore >= 0.5) reasons.push('세계관 도메인 적합');
  if (entry?.source === 'character_lore') reasons.push('캐릭터 로어');
  return liaUnique(reasons, 6);
};

function liaWorldLoreRerank(input) {
  const entries = Array.isArray(input?.entries) ? input.entries : null;
  if (!entries || entries.length > 600) throw computeError('compute_lia_lore_entries_invalid', 400);
  const query = String(input?.query || '').trim();
  if (query.length > 2_000_000) throw computeError('compute_lia_lore_query_too_large', 413);
  const topK = Math.max(1, Math.min(100, Math.floor(finiteNumber(input?.topK ?? 16, 'compute_lia_lore_top_k_invalid'))));
  const queryTokens = liaLoreTokenize(query, 180);
  let totalChars = query.length;
  const normalized = entries.map((rawEntry, position) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) throw computeError('compute_lia_lore_entry_invalid', 400);
    const loreId = String(rawEntry.loreId || '').trim();
    if (!loreId || loreId.length > 320) throw computeError('compute_lia_lore_id_invalid', 400);
    const entry = {
      position,
      loreId,
      key: String(rawEntry.key || ''), secondkey: String(rawEntry.secondkey || ''), comment: String(rawEntry.comment || ''), content: String(rawEntry.content || ''),
      mode: String(rawEntry.mode || ''), alwaysActive: rawEntry.alwaysActive === true,
      insertorder: finiteNumber(rawEntry.insertorder ?? 0, 'compute_lia_lore_insertorder_invalid'),
      source: String(rawEntry.source || ''), score: finiteNumber(rawEntry.score ?? 0, 'compute_lia_lore_legacy_score_invalid')
    };
    totalChars += entry.key.length + entry.secondkey.length + entry.comment.length + entry.content.length;
    if (totalChars > 2_000_000) throw computeError('compute_lia_lore_chars_limit_exceeded', 413);
    return entry;
  });
  const corpus = liaLoreCorpusStats(normalized, queryTokens);
  const annotated = corpus.docs.map(({ entry, fields }) => {
    const protection = liaLoreProtection(entry);
    const bm25f = liaLoreBm25fScore({ entry, fields }, queryTokens, corpus.idf);
    const exactAnchor = liaLoreExactAnchorScore(entry, query);
    const domain = liaLoreWorldDomainScore(entry);
    const legacyBase = Math.min(1, entry.score / 180);
    const protectionBoost = protection.hard ? 1 : protection.soft ? Math.min(1, protection.priority / 240) : 0;
    return {
      position: entry.position, loreId: entry.loreId, protection,
      rerankScore: Math.min(1, bm25f.score * 0.52 + exactAnchor.score * 0.22 + domain * 0.14 + legacyBase * 0.06 + protectionBoost * 0.06),
      rerankPurpose: 'world', rerankReasons: liaLoreScoreReasons(entry, bm25f, exactAnchor, domain, protection)
    };
  });
  const hardProtected = annotated.filter(item => item.protection.hard)
    .sort((a,b) => b.protection.priority-a.protection.priority || b.rerankScore-a.rerankScore || a.position-b.position);
  const softProtected = annotated.filter(item => item.protection.soft)
    .sort((a,b) => b.rerankScore-a.rerankScore || b.protection.priority-a.protection.priority || a.position-b.position);
  const normal = annotated.filter(item => !item.protection.protected)
    .sort((a,b) => b.rerankScore-a.rerankScore || a.position-b.position);
  const minimumScore = 0.08;
  const softProtectedBudget = Math.max(1, Math.min(8, Math.ceil(topK * 0.35)));
  const selectedSoft = softProtected.slice(0, softProtectedBudget);
  const normalBudget = Math.max(0, topK - selectedSoft.length);
  const selectedNormal = normal.filter(item => item.rerankScore >= minimumScore).slice(0, normalBudget);
  const selectedIds = new Set([...hardProtected, ...selectedSoft, ...selectedNormal].map(item => item.loreId));
  const selected = [
    ...hardProtected.map(item => ({ ...item, rerankDecision: 'protected', protectionTier: 'hard' })),
    ...selectedSoft.map(item => ({ ...item, rerankDecision: 'protected', protectionTier: 'soft' })),
    ...selectedNormal.map(item => ({ ...item, rerankDecision: 'selected', protectionTier: 'none' }))
  ].map((item,index)=>({ ...item, index:index+1 }));
  const rejected = annotated.filter(item => !selectedIds.has(item.loreId))
    .sort((a,b) => b.rerankScore-a.rerankScore || a.position-b.position)
    .map(item => ({ ...item, rerankDecision:'rejected', protectionTier:item.protection?.tier || 'none' }));
  return {
    version: 'lia_lore_reranker_v2', purpose:'world', topK, minimumScore, total:annotated.length,
    protectedCount:hardProtected.length+selectedSoft.length, hardProtectedCount:hardProtected.length,
    softProtectedCount:selectedSoft.length, softProtectedBudget, selectedCount:selected.length,
    selected, rejected, all:[...selected,...rejected]
  };
}

const LIBRA_RECALL_BM25F_FIELDS = Object.freeze([
  'summary',
  'recall_keys',
  'characters_relations',
  'narrative_open_threads',
  'chronology',
  'world_scene',
  'facts_uncertainty',
  'full_text'
]);
const LIBRA_RECALL_BM25F_WEIGHTS = Object.freeze({
  summary: 2.2,
  recall_keys: 1.05,
  characters_relations: 2.0,
  narrative_open_threads: 1.9,
  chronology: 1.5,
  world_scene: 1.5,
  facts_uncertainty: 1.4,
  full_text: 0.7
});
const LIBRA_RECALL_BM25F_LENGTH_NORM = Object.freeze({
  summary: 0.28,
  recall_keys: 0.24,
  characters_relations: 0.36,
  narrative_open_threads: 0.52,
  chronology: 0.58,
  world_scene: 0.50,
  facts_uncertainty: 0.56,
  full_text: 0.82
});
const LIBRA_RECALL_BM25F_K1 = 1.2;
// BEGIN LIBRA RECALL TOKENIZER
const libraTokenStream = (function createLibraRecallTokenizer() {
  const normalizeLexicalText = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const partsFor = value => {
      const body = normalizeLexicalText(value);
      const words = body.match(/[\p{L}\p{N}_-]{2,}/gu) || [];
      const pureCjkRun = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;
      const lexicalWords = words.filter(word => !pureCjkRun.test(word)).slice(0, 960);
      const hangulGrams = [];
      const hangulRuns = body.match(/[가-힣]+/gu) || [];
      for (const run of hangulRuns) {
        const chars = Array.from(run);
        if (chars.length === 1) hangulGrams.push(chars[0]);
        else for (let index = 0; index + 1 < chars.length && hangulGrams.length < 640; index += 1) hangulGrams.push(chars[index] + chars[index + 1]);
        if (hangulGrams.length >= 640) break;
      }
      const cjkGrams = [];
      const cjkRuns = body.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || [];
      for (const run of cjkRuns) {
        const chars = Array.from(run);
        if (chars.length === 1) cjkGrams.push(chars[0]);
        else for (let index = 0; index + 1 < chars.length && cjkGrams.length < 640; index += 1) cjkGrams.push(chars[index] + chars[index + 1]);
        if (cjkGrams.length >= 640) break;
      }
      return { lexicalWords, hangulRuns, hangulGrams, cjkGrams };
    };
  const legacy = value => {
      const { lexicalWords, hangulGrams, cjkGrams } = partsFor(value);
      const gramBudget = Math.max(0, 1600 - lexicalWords.length);
      const grams = [];
      let hangulIndex = 0;
      let cjkIndex = 0;
      while (grams.length < gramBudget && (hangulIndex < hangulGrams.length || cjkIndex < cjkGrams.length)) {
        if (hangulIndex < hangulGrams.length && grams.length < gramBudget) grams.push(hangulGrams[hangulIndex++]);
        if (cjkIndex < cjkGrams.length && grams.length < gramBudget) grams.push(cjkGrams[cjkIndex++]);
      }
      return [...lexicalWords, ...grams].slice(0, 1600);
    };
  const koreanParticle = /(?:으로|에서|에게|한테|께서|까지|부터|처럼|보다|하고|이랑|랑|들과|들은|들이|들을|들의|들|은|는|이|가|을|를|에|께|로|와|과|도|만|의)$/u;
  legacy.bm25Tokens = value => {
    const { lexicalWords, hangulRuns, hangulGrams, cjkGrams } = partsFor(value);
    const surface = [...lexicalWords, ...hangulRuns.filter(run => run.length === 1)];
    const particles = lexicalWords.filter(word => /[가-힣]/u.test(word))
      .map(word => word.replace(koreanParticle, ''))
      .filter(word => word.length >= 1);
    const words = Array.from(new Set([...surface, ...particles])).slice(0, 960);
    const tokens = words.map(word => `w:${word}`);
    let hangulIndex = 0;
    let cjkIndex = 0;
    while (tokens.length < 1600 && (hangulIndex < hangulGrams.length || cjkIndex < cjkGrams.length)) {
      if (hangulIndex < hangulGrams.length && tokens.length < 1600) tokens.push(`g:${hangulGrams[hangulIndex++]}`);
      if (cjkIndex < cjkGrams.length && tokens.length < 1600) tokens.push(`c:${cjkGrams[cjkIndex++]}`);
    }
    return tokens;
  };
  return legacy;
})();
// END LIBRA RECALL TOKENIZER

function libraRecallBm25f(input) {
  if (input?.schema !== 'libra.recall-bm25f.input.v1') throw computeError('compute_libra_bm25f_input_schema_invalid', 400);
  const queryText = String(input?.queryText || '').trim();
  if (queryText.length > 500_000) throw computeError('compute_libra_bm25f_query_too_large', 413);
  const sourceDocuments = Array.isArray(input?.documents) ? input.documents : null;
  if (!sourceDocuments || sourceDocuments.length > 64) throw computeError('compute_libra_bm25f_documents_invalid', 400);
  let totalChars = queryText.length;
  const seenIds = new Set();
  const normalizedSources = sourceDocuments.map((source, position) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || Number(source.position) !== position) {
      throw computeError('compute_libra_bm25f_document_position_invalid', 400);
    }
    const id = String(source.id || '').trim();
    if (!id || id.length > 320 || seenIds.has(id)) throw computeError('compute_libra_bm25f_document_id_invalid', 400);
    seenIds.add(id);
    const rawFields = source.fields;
    if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) throw computeError('compute_libra_bm25f_fields_invalid', 400);
    const fields = Object.fromEntries(LIBRA_RECALL_BM25F_FIELDS.map(field => {
      const value = String(rawFields[field] || '').trim();
      totalChars += value.length;
      if (totalChars > 6_000_000) throw computeError('compute_libra_bm25f_chars_limit_exceeded', 413);
      return [field, value];
    }));
    return { position, id, fields };
  });
  const queryTokens = Array.from(new Set(libraTokenStream.bm25Tokens(queryText))).slice(0, 160);
  if (!queryTokens.length || !normalizedSources.length) {
    return {
      schema: 'libra.recall-bm25f.result.v1',
      documentCount: normalizedSources.length,
      queryTokenCount: queryTokens.length,
      scores: []
    };
  }
  const documents = normalizedSources.map(source => {
    const streams = Object.fromEntries(LIBRA_RECALL_BM25F_FIELDS.map(field => [field, libraTokenStream.bm25Tokens(source.fields[field] || '')]));
    const counts = Object.fromEntries(LIBRA_RECALL_BM25F_FIELDS.map(field => {
      const map = new Map();
      for (const token of streams[field]) map.set(token, (map.get(token) || 0) + 1);
      return [field, map];
    }));
    return { position: source.position, id: source.id, streams, counts };
  });
  const avgLengths = Object.fromEntries(LIBRA_RECALL_BM25F_FIELDS.map(field => [
    field,
    documents.reduce((sum, document) => sum + document.streams[field].length, 0) / Math.max(1, documents.length)
  ]));
  const df = new Map();
  for (const token of queryTokens) {
    let count = 0;
    for (const document of documents) if (LIBRA_RECALL_BM25F_FIELDS.some(field => document.counts[field].has(token))) count += 1;
    df.set(token, count);
  }
  const rawScores = documents.map(document => {
    let score = 0;
    let strongScore = 0;
    for (const token of queryTokens) {
      let weightedTf = 0;
      for (const field of LIBRA_RECALL_BM25F_FIELDS) {
        const tf = Number(document.counts[field].get(token) || 0);
        if (!tf) continue;
        const length = document.streams[field].length;
        const average = Math.max(1, avgLengths[field] || 1);
        const b = LIBRA_RECALL_BM25F_LENGTH_NORM[field] ?? 0.5;
        const normalizedTf = tf / Math.max(0.1, (1 - b) + b * (length / average));
        weightedTf += Number(LIBRA_RECALL_BM25F_WEIGHTS[field] || 1) * normalizedTf;
      }
      if (!weightedTf) continue;
      const documentFrequency = Number(df.get(token) || 0);
      const idf = Math.log(1 + ((documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
      const termScore = idf * ((weightedTf * (LIBRA_RECALL_BM25F_K1 + 1)) / (weightedTf + LIBRA_RECALL_BM25F_K1));
      score += termScore;
      if (token.startsWith('w:') || token.startsWith('c:')) strongScore += termScore;
    }
    return { position: document.position, id: document.id, raw: score, strongScore };
  });
  const maxScore = Math.max(0, ...rawScores.map(row => row.raw));
  return {
    schema: 'libra.recall-bm25f.result.v1',
    documentCount: documents.length,
    queryTokenCount: queryTokens.length,
    scores: rawScores.map(({ strongScore, ...row }) => ({
      ...row,
      normalized: maxScore > 0 ? row.raw / maxScore : 0,
      evidence: 1 - Math.exp(-Math.max(0, strongScore))
    }))
  };
}

const HAYAKU_RRF_SPARSE_SIGNALS = Object.freeze([
  'bm25fSignal', 'identitySignal', 'canonicalExactSignal', 'associationSignal',
  'charNgramSignal', 'lexicalCoverageSignal', 'sparsePhraseSignal'
]);
const HAYAKU_RRF_FALLBACK_SIGNALS = Object.freeze([
  'bm25Signal', 'entitySignal', 'canonicalSignal', 'frameSignal', 'locatorSignal', 'phraseSignal'
]);
const HAYAKU_RRF_ALL_SIGNALS = Object.freeze([...HAYAKU_RRF_SPARSE_SIGNALS, ...HAYAKU_RRF_FALLBACK_SIGNALS]);

function hayakuSparseRrfFusion(input) {
  if (input?.schema !== 'hayaku.sparse-rrf-fusion.input.v1') throw computeError('compute_hayaku_rrf_input_schema_invalid', 400);
  const sourceRows = Array.isArray(input?.rows) ? input.rows : null;
  if (!sourceRows || sourceRows.length > 256) throw computeError('compute_hayaku_rrf_rows_invalid', 400);
  const k = finiteNumber(input?.k, 'compute_hayaku_rrf_k_invalid');
  const blend = finiteNumber(input?.blend, 'compute_hayaku_rrf_blend_invalid');
  const epsilon = finiteNumber(input?.epsilon, 'compute_hayaku_rrf_epsilon_invalid');
  if (k <= 0 || k > 10000) throw computeError('compute_hayaku_rrf_k_out_of_range', 400);
  if (blend < 0 || blend > 1) throw computeError('compute_hayaku_rrf_blend_out_of_range', 400);
  if (epsilon < 0 || epsilon > 1) throw computeError('compute_hayaku_rrf_epsilon_out_of_range', 400);
  const seenIds = new Set();
  const rows = sourceRows.map((source, position) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || Number(source.position) !== position) {
      throw computeError('compute_hayaku_rrf_row_position_invalid', 400);
    }
    const id = String(source.id || '').trim();
    if (!id || id.length > 320 || seenIds.has(id)) throw computeError('compute_hayaku_rrf_row_id_invalid', 400);
    seenIds.add(id);
    const score = finiteNumber(source.score, 'compute_hayaku_rrf_score_invalid');
    if (score < 0 || score > 1.35) throw computeError('compute_hayaku_rrf_score_out_of_range', 400);
    if (!source.signals || typeof source.signals !== 'object' || Array.isArray(source.signals)) {
      throw computeError('compute_hayaku_rrf_signals_invalid', 400);
    }
    const signals = Object.fromEntries(HAYAKU_RRF_ALL_SIGNALS.map(signal => {
      const value = finiteNumber(source.signals[signal] ?? 0, 'compute_hayaku_rrf_signal_non_finite');
      if (value < 0 || value > 1.35) throw computeError('compute_hayaku_rrf_signal_out_of_range', 400);
      return [signal, value];
    }));
    return { position, id, score, signals };
  });
  const signals = HAYAKU_RRF_SPARSE_SIGNALS.some(signal => rows.some(row => row.signals[signal] > epsilon))
    ? [...HAYAKU_RRF_SPARSE_SIGNALS]
    : [...HAYAKU_RRF_FALLBACK_SIGNALS];
  const ranked = {};
  for (const signal of signals) {
    const sorted = rows
      .filter(row => row.signals[signal] > epsilon)
      .slice()
      .sort((left, right) => right.signals[signal] - left.signals[signal] || left.position - right.position);
    ranked[signal] = new Map(sorted.map((row, index) => [row.position, index + 1]));
  }
  let maxRrf = 0;
  const computed = rows.map(row => {
    let rrf = 0;
    for (const signal of signals) {
      const rank = ranked[signal].get(row.position);
      if (rank !== undefined) rrf += 1 / (k + rank);
    }
    if (rrf > maxRrf) maxRrf = rrf;
    return { row, rrf };
  });
  return {
    schema: 'hayaku.sparse-rrf-fusion.result.v1',
    rowCount: rows.length,
    signals,
    scores: computed.map(({ row, rrf }) => {
      const normalized = maxRrf > 0 ? rrf / maxRrf : 0;
      return {
        position: row.position,
        id: row.id,
        score: Math.max(0, Math.min(1.35, row.score * (1 - blend) + normalized * blend * 1.35)),
        rrfScore: Number(normalized.toFixed(4)),
        rrfSignals: signals,
        scoreBeforeRrf: Number(row.score.toFixed(4))
      };
    })
  };
}

function testSpin(input) {
  const durationMs = Math.max(1, Math.min(1000, Math.floor(finiteNumber(input?.durationMs ?? 10, 'compute_test_duration_invalid'))));
  const startedAt = Date.now();
  let checksum = 0;
  while (Date.now() - startedAt < durationMs) checksum = (checksum + 2654435761) >>> 0;
  return { startedAt, completedAt: Date.now(), durationMs, checksum };
}

const DEFINITIONS = Object.freeze({
  ...Object.fromEntries(['flashback','hayaku','libra'].map(namespace => {
    const factory = require('../../sdk/MemorySuiteSearchKernel.source.cjs');
    const run = factory();
    const operation = namespace + '.memory-search.v1';
    return [operation, Object.freeze({operation, fingerprint: descriptorFingerprint(factory.toString()),
      namespaces: Object.freeze([namespace]), maxDeadlineMs:30000,
      execute: input => {
        if ((namespace === 'hayaku') !== (input?.kind === 'lexical') || input?.owner !== namespace) throw computeError('compute_search_kind_invalid',400);
        return {...run(input), ...(input._corpusId ? {corpusId:input._corpusId} : {})};
      }})];
  })),
  'flashback.hash-embedding-batch.v1': Object.freeze({
    operation: 'flashback.hash-embedding-batch.v1',
    fingerprint: descriptorFingerprint('flashback/hash-embedding-batch/v1:fnv1a-utf16:lower:token[a-z0-9-ko-cjk-kana]:token+2-4gram:max4000:weight-length8:l2'),
    namespaces: Object.freeze(['flashback']),
    maxDeadlineMs: 30000,
    execute: flashbackHashEmbeddingBatch
  }),
  'common.sha256-batch.v1': Object.freeze({
    operation: 'common.sha256-batch.v1',
    fingerprint: descriptorFingerprint('memory-suite/common.sha256-batch/v1:utf8:sha256:ordered'),
    namespaces: ALL_NAMESPACES,
    maxDeadlineMs: 30000,
    execute: sha256Batch
  }),
  'common.vector-rank.v1': Object.freeze({
    operation: 'common.vector-rank.v1',
    fingerprint: descriptorFingerprint('memory-suite/common.vector-rank/v1:cosine+base:score-desc:id-code-unit:index'),
    namespaces: OWNER_NAMESPACES,
    maxDeadlineMs: 30000,
    execute: vectorRank
  }),
  'lia.world-lore-rerank.v2': Object.freeze({
    operation: 'lia.world-lore-rerank.v2',
    fingerprint: descriptorFingerprint('lia/world-lore-rerank/v2:nfkc-token2+:idf-bm25f:key3.4:second2.8:comment1.8:content1.0:exact-anchor:domain0.14:legacy0.06:hard-soft-protection:soft-budget35pct:stable-position'),
    namespaces: Object.freeze(['lia']),
    maxDeadlineMs: 30000,
    execute: liaWorldLoreRerank
  }),
  'libra.recall-bm25f.v1': Object.freeze({
    operation: 'libra.recall-bm25f.v1',
    fingerprint: descriptorFingerprint('libra/recall-bm25f/v3:tokenizer-sha256:890b2e3cafd3dc822aab0d704f6eef39dc0d4f1b6c9c3bba05e6d0202a520895:fields-v1:weights-v1:length-norm-v1:k1-1.2:evidence-strong-word-cjk-exp1:stable-input-position'),
    namespaces: Object.freeze(['libra']),
    maxDeadlineMs: 30000,
    execute: libraRecallBm25f
  }),
  'hayaku.sparse-rrf-fusion.v1': Object.freeze({
    operation: 'hayaku.sparse-rrf-fusion.v1',
    fingerprint: descriptorFingerprint('hayaku/sparse-rrf-fusion/v1:signals-sparse7-fallback6:epsilon-strict-positive:stable-position:k60:blend0.12:norm-max:boost1.35:clamp1.35:round4'),
    namespaces: Object.freeze(['hayaku']),
    maxDeadlineMs: 30000,
    execute: hayakuSparseRrfFusion
  }),
  'memory-suite.test.spin.v1': Object.freeze({
    operation: 'memory-suite.test.spin.v1',
    fingerprint: descriptorFingerprint('memory-suite/test.spin/v1:bounded-wall-clock'),
    namespaces: ALL_NAMESPACES,
    maxDeadlineMs: 2000,
    testOnly: true,
    execute: testSpin
  })
});

function definitionFor(operation, options = {}) {
  const name = String(operation || '').trim();
  const definition = DEFINITIONS[name];
  if (!definition || (definition.testOnly && options.allowTestOperations !== true)) {
    throw computeError('compute_operation_not_supported', 404);
  }
  return definition;
}

function assertOperationAccess(operation, namespace, fingerprint, options = {}) {
  const definition = definitionFor(operation, options);
  if (!definition.namespaces.includes(namespace)) throw computeError('compute_operation_namespace_forbidden', 403);
  if (String(fingerprint || '') !== definition.fingerprint) {
    throw computeError('compute_algorithm_fingerprint_mismatch', 409, {
      expectedFingerprint: definition.fingerprint
    });
  }
  return definition;
}

function executeOperation(operation, input, options = {}) {
  const definition = definitionFor(operation, options);
  return definition.execute(input);
}

function capabilitiesForNamespace(namespace, options = {}) {
  return Object.values(DEFINITIONS)
    .filter(definition => definition.namespaces.includes(namespace))
    .filter(definition => !definition.testOnly || options.allowTestOperations === true)
    .map(definition => ({
      operation: definition.operation,
      algorithmFingerprint: definition.fingerprint,
      maxDeadlineMs: definition.maxDeadlineMs
    }))
    .sort((left, right) => left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : 0);
}

module.exports = {
  DEFINITIONS,
  definitionFor,
  assertOperationAccess,
  executeOperation,
  capabilitiesForNamespace
};
