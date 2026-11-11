'use strict';
// State-led direct recall. Existing records stay the sources; nothing is built or published.
// `tokenizer` is LIBRA's recall tokenizer (particle stripping, Hangul/CJK grams). Without it
// a plain word split is used, which is enough for unit checks of the selection rules.
module.exports = function createLibraStateMemoryEngine({ fingerprint, tokenizer = null }) {
  const axes = Object.freeze(['characters', 'relationships', 'world', 'narrative']);
  const labels = Object.freeze({ characters: '인물', relationships: '관계', world: '세계', narrative: '서사' });
  const array = value => Array.isArray(value) ? value : [];
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase();

  const tokens = value => [...new Set(normalize(value)
    .split(/[^\p{L}\p{N}_]+/u).filter(word => word.length > 0))];

  const charNgrams = (value, limit = 160) => {
    const cleaned = normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!cleaned) return [];
    const grams = new Set();
    for (let i = 0; i < cleaned.length - 1 && grams.size < limit; i++) {
      const bi = cleaned.slice(i, i + 2);
      if (bi.trim()) grams.add(bi);
      if (i < cleaned.length - 2 && grams.size < limit) {
        const tri = cleaned.slice(i, i + 3);
        if (tri.trim()) grams.add(tri);
      }
    }
    return [...grams];
  };

  const exactSignal = (text, query) => {
    const doc = normalize(text), q = normalize(query).trim();
    if (!q || !doc) return 0;
    if (doc.includes(q)) return 1.0;
    const qWords = tokens(q);
    if (!qWords.length) return 0;
    const matched = qWords.filter(word => doc.includes(word)).length;
    return matched / qWords.length;
  };

  const charNgramSignal = (queryGrams, docGramsSet) => {
    if (!queryGrams.length || !docGramsSet.size) return 0;
    let overlap = 0;
    for (const g of queryGrams) if (docGramsSet.has(g)) overlap++;
    const coverage = overlap / queryGrams.length;
    const jaccard = overlap / (queryGrams.length + docGramsSet.size - overlap || 1);
    return Math.min(1, Math.max(0, coverage * 0.75 + jaccard * 0.25));
  };

  const bm25Score = (queryWords = [], docWords = [], docFreq = new Map(), docCount = 1, avgDocLen = 1, k1 = 1.2, b = 0.75) => {
    if (!queryWords.length || !docWords.length) return 0;
    const tfMap = new Map();
    for (const w of docWords) tfMap.set(w, (tfMap.get(w) || 0) + 1);
    const docLen = docWords.length;
    const norm = 1 - b + b * (docLen / Math.max(1, avgDocLen));
    let raw = 0, maxRaw = 0;
    for (const word of queryWords) {
      const df = Math.max(1, docFreq.get(word) || 1);
      const idf = Math.log(1 + ((docCount - df + 0.5) / (df + 0.5)));
      const tf = tfMap.get(word) || 0;
      if (tf > 0) raw += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
      maxRaw += idf * (k1 + 1);
    }
    return maxRaw > 0 ? Math.min(1, Math.max(0, raw / maxRaw)) : 0;
  };

  // ── Term statistics (BM25 / BM25F) ───────────────────────────────────────────────
  const termFrequency = value => {
    if (tokenizer && typeof tokenizer.bm25TermFrequency === 'function') return tokenizer.bm25TermFrequency(value);
    const tf = new Map(); let length = 0;
    for (const word of normalize(value).split(/[^\p{L}\p{N}_]+/u)) if (word) { tf.set(word, (tf.get(word) || 0) + 1); length++; }
    return { tf, length };
  };
  const queryTerms = value => [...termFrequency(value).tf.keys()].slice(0, 240);
  // Field weights follow the HAYAKU reference: short identifying fields count more and
  // are normalized less by their length than a long body.
  const CATALOG_FIELDS = Object.freeze({ title: { weight: 2.0, b: 0.30 }, summary: { weight: 2.2, b: 0.50 }, terms: { weight: 1.05, b: 0.25 } });
  const TEXT_FIELDS = Object.freeze({ text: { weight: 1, b: 0.75 } });
  const buildCorpus = (documents, fields = TEXT_FIELDS) => {
    const docs = array(documents), docFreq = new Map(), totals = Object.fromEntries(Object.keys(fields).map(name => [name, 0]));
    for (const doc of docs) {
      const seen = new Set();
      for (const name of Object.keys(fields)) {
        const field = doc?.[name]; if (!field) continue;
        totals[name] += field.length;
        for (const term of field.tf.keys()) seen.add(term);
      }
      for (const term of seen) docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
    return { size: docs.length, docFreq, fields,
      averageLength: Object.fromEntries(Object.keys(fields).map(name => [name, docs.length ? Math.max(1, totals[name] / docs.length) : 1])) };
  };
  // Normalized to 0..1 against the best score the query could reach in this corpus.
  const bm25fScore = (terms = [], doc = {}, corpus = null, k1 = 1.2) => {
    if (!terms.length || !corpus?.size) return 0;
    let raw = 0, best = 0;
    for (const term of terms) {
      const df = corpus.docFreq.get(term) || 0;
      const idf = Math.log(1 + ((corpus.size - df + 0.5) / (df + 0.5)));
      best += idf;
      let weighted = 0;
      for (const [name, rule] of Object.entries(corpus.fields)) {
        const field = doc[name], frequency = field?.tf.get(term) || 0;
        if (!frequency) continue;
        weighted += rule.weight * frequency / Math.max(0.15, 1 - rule.b + rule.b * (field.length / corpus.averageLength[name]));
      }
      if (weighted > 0) raw += idf * weighted / (weighted + k1);
    }
    return best > 0 ? Math.min(1, raw / best) : 0;
  };

  // ── Identity: one entity, several written names ──────────────────────────────────
  // Names and aliases come from the State head, so no registry read is added.
  const entityTable = head => {
    const table = [];
    for (const axis of ['characters', 'world']) for (const entity of array(head?.[axis])) {
      const names = [...new Set([entity?.name, entity?.label, ...array(entity?.aliases), ...array(entity?.state?.aliases)]
        .map(name => normalize(name).trim()).filter(name => name.length >= 2))];
      if (entity?.id && names.length) table.push({ id: String(entity.id), axis, names });
    }
    return table;
  };
  const mentionedEntities = (text, table) => {
    const body = normalize(text), found = new Set();
    if (body) for (const entity of array(table)) if (entity.names.some(name => body.includes(name))) found.add(entity.id);
    return found;
  };
  const identitySignal = (queryEntities, text, table) => {
    if (!queryEntities?.size) return 0;
    const found = mentionedEntities(text, table); let shared = 0;
    for (const id of queryEntities) if (found.has(id)) shared++;
    return shared / queryEntities.size;
  };
  // A lens note has no stored domain. Its people and the entities it names decide the axis.
  const classifyAxis = (text, { people = [], entities = [] } = {}) => {
    const found = mentionedEntities(text, entities), byId = new Map(array(entities).map(entity => [entity.id, entity.axis]));
    const characters = Math.max(array(people).filter(Boolean).length, [...found].filter(id => byId.get(id) === 'characters').length);
    if (characters >= 2) return 'relationships';
    if (characters === 1) return 'characters';
    return [...found].some(id => byId.get(id) === 'world') ? 'world' : 'narrative';
  };

  // ── Micro candidate discovery ────────────────────────────────────────────────────
  // `index` maps a turn to the search text already stored on its Micro head. Ranking it
  // lets an old turn be read because it matches, not only because it is recent.
  const rankMicroTurns = ({ turns = [], index = null, query = '', evidenceTurns = [], limit = 12, entities = [] } = {}) => {
    const allowed = new Set(array(turns).map(Number)), cap = Math.max(0, Math.floor(Number(limit) || 0));
    const chosen = [], taken = new Set();
    const take = (turn, reason) => { if (chosen.length < cap && allowed.has(turn) && !taken.has(turn)) { taken.add(turn); chosen.push({ turn, reason }); } };
    const evidence = [...new Set(array(evidenceTurns).map(Number))].filter(turn => allowed.has(turn));
    for (const turn of evidence.slice(0, Math.ceil(cap / 2))) take(turn, 'state_evidence');
    const q = normalize(query).trim(), entries = index instanceof Map ? [...index].filter(([turn]) => allowed.has(Number(turn))) : [];
    let matches = 0;
    if (q && entries.length) {
      const docs = entries.map(([turn, text]) => ({ turn: Number(turn), body: String(text || ''), text: termFrequency(text) }));
      const corpus = buildCorpus(docs), terms = queryTerms(q), queryEntities = mentionedEntities(q, entities);
      const scored = docs.map(doc => ({ turn: doc.turn,
        score: bm25fScore(terms, doc, corpus) + 0.5 * identitySignal(queryEntities, doc.body, entities) + 0.25 * exactSignal(doc.body, q) }))
        .filter(row => row.score > 0.02).sort((a, b) => b.score - a.score || b.turn - a.turn);
      matches = scored.length;
      // The newest turns keep a small floor so a fresh event is never crowded out.
      const recentFloor = Math.min(2, cap);
      for (const row of scored) { if (chosen.length >= cap - recentFloor) break; take(row.turn, 'index_match'); }
    }
    for (const turn of [...allowed].sort((a, b) => b - a)) take(turn, 'recent');
    return { turns: chosen.map(row => row.turn), reasons: Object.fromEntries(chosen.map(row => [row.turn, row.reason])),
      indexed: entries.length, matches, matchesRead: chosen.filter(row => row.reason === 'index_match').length };
  };

  // Standalone composite relevance score for string pairs.
  const score = (text, query) => {
    const q = normalize(query).trim();
    if (!q) return 0;
    const doc = normalize(text);
    if (!doc) return 0;
    const qWords = tokens(q);
    const wordMatches = qWords.filter(w => doc.includes(w));
    if (!wordMatches.length && !doc.includes(q)) {
      const qGrams = charNgrams(q, 40);
      const dGrams = new Set(charNgrams(doc, 80));
      const ngramMatch = charNgramSignal(qGrams, dGrams);
      return ngramMatch >= 0.4 ? Number((ngramMatch * 1.5).toFixed(4)) : 0;
    }
    const tokenScore = wordMatches.reduce((sum, token) => sum + (1 + Math.min(token.length, 12) / 12), 0);
    const exact = doc.includes(q) ? 2.0 : 0;
    const qGrams = charNgrams(q, 40);
    const dGrams = new Set(charNgrams(doc, 80));
    const ngramBonus = charNgramSignal(qGrams, dGrams) * 1.2;
    return Number((tokenScore + exact + ngramBonus).toFixed(4));
  };

  const sparseRrfFusion = (rows = [], signalNames = ['bm25', 'charNgram', 'exact', 'anchor'], k = 60, blend = 0.20) => {
    const rowList = array(rows);
    if (!rowList.length) return [];
    const ranked = {};
    for (const signal of signalNames) {
      const sorted = rowList
        .map((row, index) => ({ index, val: Number(row.signals?.[signal] || 0) }))
        .filter(item => item.val > 0.0001)
        .sort((a, b) => b.val - a.val || a.index - b.index);
      ranked[signal] = new Map(sorted.map((item, rank) => [item.index, rank + 1]));
    }
    let maxRrf = 0;
    const rrfValues = rowList.map((_, index) => {
      let rrf = 0;
      for (const signal of signalNames) {
        const rank = ranked[signal]?.get(index);
        if (rank !== undefined) rrf += 1 / (k + rank);
      }
      if (rrf > maxRrf) maxRrf = rrf;
      return rrf;
    });
    return rowList.map((row, index) => {
      const normRrf = maxRrf > 0 ? rrfValues[index] / maxRrf : 0;
      const base = Number(row.score || 0);
      const blended = Number((base * (1 - blend) + normRrf * blend * 1.5).toFixed(4));
      return {
        ...row,
        score: blended,
        scoreBreakdown: {
          ...(row.signals || {}),
          rrfScore: Number(normRrf.toFixed(4)),
          scoreBeforeRrf: Number(base.toFixed(4))
        }
      };
    });
  };

  const extractCanonicalSearchMetadata = (memory = {}) => {
    const artifact = memory?.canonicalArtifact || {};
    const summary = String(memory?.summary || artifact?.summary || memory?.text || '').trim();
    const title = String(memory?.title || artifact?.title || '').trim();
    const facts = Array.isArray(artifact?.chronology) ? artifact.chronology : [];
    const factTexts = facts.slice(0, 10).map(f => String(f?.text || f?.summary || f?.value || '')).filter(Boolean);
    const combined = [title, summary, ...factTexts].join(' ');
    const words = tokens(combined).slice(0, 40);
    const searchText = [title, summary].filter(Boolean).join(' · ').slice(0, 600);
    return {
      title,
      summary,
      searchText: searchText || summary,
      searchTerms: words,
      recallTerms: words.slice(0, 16)
    };
  };

  const upgradeCanonicalManifestSearchMetadata = async (manifest, getMemory = null) => {
    if (!manifest || typeof manifest !== 'object') return { upgraded: 0, total: 0 };
    const allRefs = [
      ...array(manifest.inheritedMemories),
      ...Object.values(manifest.memories || {})
    ].filter(ref => ref?.key);
    let upgraded = 0;
    for (const ref of allRefs) {
      if (!ref.searchTerms || !ref.searchText) {
        let meta = null;
        if (typeof getMemory === 'function') {
          try {
            const memory = await getMemory(ref);
            if (memory) meta = extractCanonicalSearchMetadata(memory);
          } catch (_) {}
        }
        if (!meta) meta = extractCanonicalSearchMetadata(ref);
        if (meta.searchTerms?.length || meta.searchText) {
          if (!ref.searchTerms) ref.searchTerms = meta.searchTerms;
          if (!ref.searchText) ref.searchText = meta.searchText;
          if (!ref.recallTerms) ref.recallTerms = meta.recallTerms;
          if (!ref.title && meta.title) ref.title = meta.title;
          upgraded++;
        }
      }
    }
    return { upgraded, total: allRefs.length };
  };

  const axisFor = domain => ({ character: 'characters', characters: 'characters', relationship: 'relationships', relationships: 'relationships',
    world: 'world', narrative: 'narrative', event: 'narrative', chronology: 'narrative' })[domain] || 'narrative';

  const stateRows = head => {
    const rows = [];
    if (!head) return rows;
    const names = new Map(axes.slice(0, 3).flatMap(axis => array(head[axis])).filter(row => row.id && row.name).map(row => [row.id, row.name]));
    const display = value => Array.isArray(value) ? value.map(display) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, display(item)])) : names.get(value) || value;
    const fieldLabels = { holderRef:'소지자',ownerRef:'소유자',locationRef:'위치',parentRef:'상위 장소',managerRef:'관리 주체',containerRef:'보관 위치',
      appearance:'외형',background:'배경',personality:'성격',speech:'말투',habits:'습관',abilities:'능력',goals:'목표',emotions:'감정',mood:'기분',
      knowledge:'알고 있는 내용',preferences:'선호',boundaries:'경계',affiliations:'소속',condition:'상태',doorStatus:'문 상태',value:'내용',
      summary:'요약',title:'제목',status:'진행 상태',participants:'관련 인물',resolvedTurn:'종결 기록 턴',description:'설명',rule:'규칙',interpretation:'해석',momentum:'서사 흐름',
      scopeRef:'적용 대상',exceptions:'예외',effect:'효과',personTempRef:'인물',organizationTempRef:'조직',text:'내용',
      organizationRef:'조직',access:'접근 조건',affiliation:'소속',locks:'제약',notes:'비고',detail:'세부 내용',time:'시점',count:'수량',locked:'잠금 여부' };
    const statuses = { open:'미해결',active:'진행 중',resolved:'해결됨',closed:'종결됨',pending:'보류 중',unknown:'알 수 없음' };
    const metadata = new Set(['evidenceSpans','evidenceRefs','firstTurn','lastTurn','identityEvidence','aliasEvidence',
      'fieldEvidence','fieldCandidates','clearedFieldEvidence','fieldCorrectionProvenance','clearedFieldCorrectionProvenance',
      'microProjection','responseAuthority','correctionProvenance','basis','sourceDigest','schema','worldlineId']);
    const format = value => Array.isArray(value) ? value.map(format).filter(Boolean).join('; ')
      : value && typeof value === 'object' ? Object.entries(value).filter(([key])=>!metadata.has(key) && !['id','lifecycleId','tempId'].includes(key))
        .map(([key,item])=>{const text=format(item);return text ? `${fieldLabels[key] || key}: ${text}` : '';}).filter(Boolean).join(' · ')
      : value == null ? '' : typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value);
    const unresolved = value => typeof value === 'string' ? /^ce_/.test(value)
      : Array.isArray(value) ? value.some(unresolved) : value && typeof value === 'object' ? Object.values(value).some(unresolved) : false;
    const add = (axis, entity, index) => {
      if (!entity || typeof entity !== 'object') return;
      const name = String(entity.name || entity.label || entity.title || names.get(entity.subjectId) || labels[axis])
        + (axis === 'relationships' && entity.targetId ? ' → ' + (names.get(entity.targetId) || '대상') : '');
      const values = entity.state && typeof entity.state === 'object' ? entity.state : entity;
      for (const [field, value] of Object.entries(values)) {
        if (/^(?:id|name|label|aliases|kind|type|lifecycleId|subjectId|targetId|tempId|fieldEvidence|evidence|evidenceSpans|evidenceRefs|firstTurn|lastTurn|identityEvidence|aliasEvidence|fieldCandidates|clearedFieldEvidence|fieldCorrectionProvenance|clearedFieldCorrectionProvenance|correctionProvenance|updatedAt|createdAt|responseAuthority|domainStatus|basis|sourceDigest|worldlineId|schema|throughTurn|throughSessionEpoch)$/.test(field)
          || metadata.has(field) || value == null || value === '' || field.startsWith('_') || (field==='title' && entity.title)
          || Array.isArray(value) && !value.length) continue;
        const shown = display(value);
        if (unresolved(shown)) continue;
        const readable = field === 'status' ? statuses[String(shown)] || format(shown) : field === 'resolvedTurn' ? `T${shown}` : format(shown);
        if (!readable) continue;
        const text = `${labels[axis]} · ${name} · ${field}: ${typeof shown === 'string' ? shown : readable}`;
        const promptText = `${name} — ${fieldLabels[field] || field}: ${readable}`;
        const evidence = entity.fieldEvidence?.[field] || entity.evidence || head.domainStatus?.[axis]?.evidence || null;
        const evidenceKeys = evidence?.schema === 'libra.micro_state_field_evidence.v1'
          ? ['micro:' + evidence.analysisRevisionId + ':' + evidence.claimDigest]
          : evidence?.memoryId && evidence?.revision != null ? array(evidence.assertionIds).map(id => 'canonical:' + evidence.memoryId + ':' + evidence.revision + ':' + id) : [];
        rows.push({ id: 'state:' + fingerprint(JSON.stringify([axis, entity.id || index, field, value])), family: 'state', axis, text, promptText,
          turn: Number(evidence?.turn || evidence?.sourceTurnRange?.end || head.throughTurn || 0), evidence, evidenceKeys, factText: readable,
          stateStatus: head.responseAuthority?.pending || head.responseAuthority?.current === false ? 'last_known' : 'current' });
      }
    };
    for (const axis of axes.slice(0, 3)) array(head[axis]).forEach((entity, index) => add(axis, entity, index));
    if (head.narrative) {
      for (const [field, value] of Object.entries(head.narrative)) {
        if (metadata.has(field)) continue;
        if (Array.isArray(value)) value.forEach((entity, index) => add('narrative', typeof entity === 'object' ? entity : { [field]: entity }, field + index));
        else if (typeof value === 'string' && !/^(schema|status|updatedAt|worldlineId)$/.test(field)) add('narrative', { [field]: value }, field);
      }
    }
    return rows;
  };

  const rankCatalog = (refs, query, state = [], limit = 16, { entities = [], semanticScores = new Map() } = {}) => {
    const evidenceIds = new Set(state.map(row => row.evidence?.memoryId).filter(Boolean));
    const refList = array(refs);
    if (!refList.length) return [];
    const q = normalize(query).trim();
    const qGrams = charNgrams(q, 40);
    // Every ref is already in the manifest, so corpus statistics cost no read.
    const docs = q ? refList.map(ref => ({ title: termFrequency(ref.title || ''), summary: termFrequency(ref.searchText || ref.summary || ''),
      terms: termFrequency([...array(ref.searchTerms), ...array(ref.recallTerms)].join(' ')) })) : [];
    const corpus = q ? buildCorpus(docs, CATALOG_FIELDS) : null, terms = q ? queryTerms(q) : [];
    const queryEntities = q ? mentionedEntities(q, entities) : new Set();

    const scored = refList.map((ref, ordinal) => {
      const textFields = [ref.searchText, ref.summary, ref.title, array(ref.searchTerms).join(' '), array(ref.recallTerms).join(' ')].filter(Boolean).join(' ');
      const isAnchor = evidenceIds.has(ref.memoryId);
      const anchorVal = isAnchor ? 1.0 : 0;
      const exactVal = q ? exactSignal(textFields, q) : 0;
      const refGrams = new Set(charNgrams(textFields, 80));
      const ngramVal = q ? charNgramSignal(qGrams, refGrams) : 0;
      const bm25Val = q ? bm25fScore(terms, docs[ordinal], corpus) : 0;
      const identityVal = identitySignal(queryEntities, textFields, entities);
      const semanticVal = Math.max(0, Math.min(1, Number(semanticScores.get(ref.key)) || 0));
      const base = (isAnchor ? 100 : 0) + (q ? score(textFields, q) : 0) + identityVal + 4 * semanticVal;
      return {
        ref,
        ordinal,
        score: base,
        signals: { anchor: anchorVal, exact: exactVal, charNgram: ngramVal, bm25: bm25Val, identity: identityVal, semantic: semanticVal }
      };
    });

    const fused = q ? sparseRrfFusion(scored, ['anchor', 'exact', 'charNgram', 'bm25', 'identity', 'semantic'], 60, 0.25) : scored;
    const ranked = fused.sort((a, b) => b.score - a.score || Number(b.ref.turnRange?.end || 0) - Number(a.ref.turnRange?.end || 0) || a.ordinal - b.ordinal);
    // State anchors can otherwise occupy the entire shortlist, even when an older
    // foreign-language match has the highest dense relevance. Reserve within the same cap.
    const dense = ranked.filter(row => row.signals.semantic > 0).sort((a,b) => b.signals.semantic - a.signals.semantic || b.score - a.score)
      .slice(0, Math.max(0, Math.floor(limit / 2)));
    const denseKeys = new Set(dense.map(row => row.ref.key));
    return [...dense, ...ranked.filter(row => !denseKeys.has(row.ref.key)).slice(0, Math.max(0, limit - dense.length))].map(row => row.ref);
  };

  // Candidate reads follow the delivery budget: at the standard budget (24 items) they equal
  // the configured caps, and a wider budget reads proportionally more so it can be filled.
  const allocationPlan = (query, lensSharePercent = 40, { maxItems = 24, canonicalCap = 16, microCap = 12 } = {}) => {
    if (!Number.isInteger(lensSharePercent) || lensSharePercent < 0 || lensSharePercent > 100) throw Error('LIBRA_MEMORY_WEIGHTS_INVALID');
    const q = normalize(query);
    const detail = /정확|그대로|원문|인용|뭐라고|무슨\s*말|대사|말투|수량|몇\s*개|\b(?:exact|verbatim|quote)\b/u.test(q);
    const history = /왜|어쩌다|경위|이유|원인|예전|과거|지난|그때|처음|이전|역사|어떻게.*(?:됐|되었|넘|전달)|\b(?:before|previous|history|why)\b/u.test(q);
    const current = /지금|현재|어디|상태|보유자|소유자|누가.*(?:보관|가지|갖고|들고)|\b(?:current|now|where|holder|owner)\b/u.test(q);
    const intent = detail ? 'detail' : history ? 'history' : current ? 'current' : 'mixed';
    const order = intent === 'detail' ? ['micro','canonical','state'] : intent === 'history' ? ['canonical','micro','state'] : ['state','canonical','micro'];
    const scale = Math.min(4, Math.max(1, (Number(maxItems) || 24) / 24));
    return { mode: 'query_adaptive', lensSharePercent, evidenceSharePercent: 100 - lensSharePercent, intent, order,
      budgetScale: Number(scale.toFixed(2)),
      canonicalCandidates: Math.min(64, Math.ceil((intent === 'history' ? 1 : intent === 'mixed' ? 0.5 : 0.25) * canonicalCap * scale)),
      microCandidates: Math.min(32, Math.ceil((intent === 'detail' ? 1 : intent === 'mixed' ? 2 / 3 : 0.5) * microCap * scale)) };
  };
  const select = ({ rows = [], query = '', maxCharacters = 8000, maxItems = 24, minimumPerAxis = 2, plan = null, entities = [] } = {}) => {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32 || maxCharacters > 100000
      || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 256
      || !Number.isSafeInteger(minimumPerAxis) || minimumPerAxis < 0 || minimumPerAxis > 16) throw Error('LIBRA_STATE_POLICY_INVALID');

    const validRows = array(rows).filter(row => row?.id && row.text && axes.includes(row.axis)
      && ['lens','canonical','micro','state'].includes(row.family));
    if (!validRows.length) {
      const coverage = Object.fromEntries(axes.map(axis => [axis, { available: 0, selected: 0, minimum: 0, reason: 'no_verified_data' }]));
      return { schema: 'libra.state_recall_selection.v1', engine: 'state_first', items: [], coverage,
        budget: { maxCharacters, usedCharacters: 0, maxItems }, graphBuilds: 0 };
    }

    const q = normalize(query).trim();
    const qGrams = charNgrams(q, 60);
    // Term counts are kept: a row that repeats the queried word ranks above one that mentions it once.
    const docs = q ? validRows.map(row => ({ text: termFrequency(row.text) })) : [];
    const corpus = q ? buildCorpus(docs) : null, terms = q ? queryTerms(q) : [];
    const queryEntities = q ? mentionedEntities(q, entities) : new Set();
    // Source statements behind a State field that answers the question travel with it
    // when the question asks how or what exactly, not what is true now.
    const linkedKeys = new Set();
    if (q && plan && plan.intent !== 'current') {
      const words = terms.filter(term => !/^[gc]:/.test(term));
      // Only the few State fields that best match the question pull their sources along.
      validRows.map((row, index) => ({ row, doc: docs[index].text })).filter(({ row, doc }) => row.family === 'state' && array(row.evidenceKeys).length
        && (words.some(term => doc.tf.has(term)) || identitySignal(queryEntities, row.text, entities) > 0))
        .map(item => ({ ...item, match: bm25fScore(terms, { text: item.doc }, corpus) })).sort((left, right) => right.match - left.match).slice(0, 4)
        .forEach(({ row }) => { for (const key of row.evidenceKeys) linkedKeys.add(key); });
    }

    const scoredCandidates = validRows.map((row, index) => {
      const dGrams = new Set(charNgrams(row.text, 80));
      const exactVal = q ? exactSignal(row.text, q) : 0;
      const ngramVal = q ? charNgramSignal(qGrams, dGrams) : 0;
      const bm25Val = q ? bm25fScore(terms, docs[index], corpus) : 0;
      const identityVal = identitySignal(queryEntities, row.text, entities);
      const linkedVal = row.family !== 'state' && array(row.evidenceKeys).some(key => linkedKeys.has(key)) ? 1 : 0;
      const semanticVal = q ? Math.max(0, Math.min(1, Number(row.semanticScore) || 0)) : 0;
      const relevant = !q || bm25Val > 0 || ngramVal > 0 || exactVal > 0 || identityVal > 0 || linkedVal > 0 || semanticVal > 0;
      const anchorVal = relevant ? (row.family === 'state' ? 1.0 : (row.evidence ? 0.7 : 0)) : 0;
      const rawScore = (q ? score(row.text, q) : 0) + (row.family === 'state' && relevant ? 0.5 : 0) + 0.5 * identityVal + 0.5 * linkedVal + 4 * semanticVal;
      return {
        ...row,
        score: rawScore,
        signals: { bm25: bm25Val, charNgram: ngramVal, exact: exactVal, anchor: anchorVal, identity: identityVal, linked: linkedVal, semantic: semanticVal }
      };
    });

    const candidates = q ? sparseRrfFusion(scoredCandidates, ['bm25', 'charNgram', 'exact', 'anchor', 'identity', 'linked', 'semantic'], 60, 0.20) : scoredCandidates;
    candidates.sort((a, b) => b.score - a.score || Number(b.turn || 0) - Number(a.turn || 0) || a.id.localeCompare(b.id));

    const selected = [], seen = new Set(), textSeen = new Set(), evidenceSeen = new Map(), contextLensGroups = new Set();
    const suppressedEvidenceDuplicates = new Set();
    let usedCharacters = 0;
    const costOf = row => (row.promptText || row.text).length + Math.max(32,
      `[${labels[row.axis]} · ${row.family}${row.turn ? ' · T' + row.turn : ''}${row.stateStatus === 'last_known' ? ' · last_known' : ''}] `.length + 1);
    const add = row => {
      const cost = costOf(row), identity = row.text.normalize('NFKC').trim();
      if (seen.has(row.id) || textSeen.has(identity) || selected.length >= maxItems || usedCharacters + cost > maxCharacters) return false;
      // Keep scene continuity, but one weak note per lens/person is enough.
      // Question matches retain the full lens reservation and are ranked first.
      const contextOnly = row.family === 'lens' && row.lensItem?.floorPassed === false;
      const contextGroup = contextOnly ? JSON.stringify([row.lensItem.lensId, row.lensItem.groupKey || row.lensItem.people]) : null;
      if (contextOnly && contextLensGroups.has(contextGroup)) return false;
      if (!['history','detail'].includes(plan?.intent) && array(row.evidenceKeys).length) {
        const fact = normalize(row.factText || row.promptText || row.text).trim();
        if (selected.some(previous => array(previous.evidenceKeys).some(key => row.evidenceKeys.includes(key))
          && normalize(previous.factText || previous.promptText || previous.text).trim() === fact)) {
          suppressedEvidenceDuplicates.add(row.id); return false;
        }
      }
      // Current-state answers can avoid repeating the same source assertion.
      // History and detail answers retain source statements, even if State used them.
      if (plan?.intent === 'current' && array(row.evidenceKeys).length && row.evidenceKeys.every(key => evidenceSeen.has(key) && evidenceSeen.get(key) !== row.family)) {
        suppressedEvidenceDuplicates.add(row.id); return false;
      }
      seen.add(row.id); textSeen.add(identity); selected.push(row); usedCharacters += cost;
      if (contextOnly) contextLensGroups.add(contextGroup);
      for (const key of array(row.evidenceKeys)) evidenceSeen.set(key, row.family);
      return true;
    };

    const familyAllocation = {};
    const ordered = plan ? candidates.slice().sort((a, b) => {
      const rank = row => row.family === 'lens' ? -1 : plan.order.indexOf(row.family);
      if (a.family === 'lens' || b.family === 'lens') return rank(a) - rank(b)
        || Number(a.lensItem?.floorPassed === false) - Number(b.lensItem?.floorPassed === false) || b.score - a.score;
      return plan.intent === 'mixed' ? b.score - a.score || rank(a) - rank(b) : rank(a) - rank(b) || b.score - a.score;
    }) : candidates;
    const groups = plan ? [{ key: 'lens', weight: plan.lensSharePercent, items: Math.round(maxItems * plan.lensSharePercent / 100) },
      { key: 'evidence', weight: 100 - plan.lensSharePercent, items: maxItems - Math.round(maxItems * plan.lensSharePercent / 100) }] : [];
    for (const group of groups) {
        const targetCharacters = Math.floor(maxCharacters * group.weight / 100);
        let used = 0, count = 0;
        for (const row of ordered.filter(row => (row.family === 'lens') === (group.key === 'lens'))) {
          if (count >= group.items) break;
          const cost = costOf(row);
          if (used + cost <= targetCharacters && add(row)) { used += cost; count++; }
        }
        familyAllocation[group.key] = { weight: group.weight, targetCharacters, targetItems: group.items, reservedItems: count };
    }
    // Axis floors consume shared capacity after the requested family reservations.
    // Without a family policy, retain HAYAKU's explicit axis floor pass.
    // Per-axis budget prevents a verbose first axis consuming every other floor.
    const floorBudget = Math.floor(maxCharacters / axes.length), floorUsed = Object.fromEntries(axes.map(axis => [axis, 0]));
    for (let n = 0; n < minimumPerAxis; n++) for (const axis of axes) {
      if (selected.filter(row => row.axis === axis).length > n) continue;
      const ranked = candidates.filter(row => row.axis === axis && !seen.has(row.id))
        .sort((a, b) => Number(b.family === 'state') - Number(a.family === 'state') || b.score - a.score);
      for (const row of ranked) if (floorUsed[axis] + costOf(row) <= floorBudget && add(row)) { floorUsed[axis] += costOf(row); break; }
    }
    for (const row of ordered) if (row.family === 'state' || row.family === 'lens' || row.score > 0) add(row);
    for (const [family, allocation] of Object.entries(familyAllocation)) {
      const chosen = selected.filter(row => family === 'evidence' ? row.family !== 'lens' : row.family === family);
      allocation.selected = chosen.length;
      allocation.usedCharacters = chosen.reduce((sum, row) => sum + costOf(row), 0);
    }

    const coverage = Object.fromEntries(axes.map(axis => {
      const available = candidates.filter(row => row.axis === axis).length, chosen = selected.filter(row => row.axis === axis).length;
      return [axis, { available, selected: chosen, minimum: Math.min(minimumPerAxis, available),
        reason: !available ? 'no_verified_data' : chosen < Math.min(minimumPerAxis, available) ? 'budget_limited' : 'covered' }];
    }));

    return { schema: 'libra.state_recall_selection.v1', engine: 'state_first', items: selected, coverage,
      budget: { maxCharacters, usedCharacters, maxItems, familyAllocation, suppressedEvidenceDuplicates: suppressedEvidenceDuplicates.size }, graphBuilds: 0 };
  };

  return Object.freeze({
    axes, labels, allocationPlan, tokens, charNgrams, exactSignal, charNgramSignal, bm25Score, score,
    termFrequency, queryTerms, buildCorpus, bm25fScore, entityTable, mentionedEntities, identitySignal, classifyAxis, rankMicroTurns,
    sparseRrfFusion, extractCanonicalSearchMetadata, upgradeCanonicalManifestSearchMetadata,
    axisFor, stateRows, rankCatalog, select
  });
};
