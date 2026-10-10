        // Expose actual scored memory candidates before diversity/exact-backfill.
        // No post-MMR selections or inferred missing ranks enter the typed lane.
        const buildHeuristicPreMmrLane = (scored, depth, trace = {}, typedAdmission = null) => {
            const accepted = scored.filter(item => item?.accepted).sort((a, b) => b.finalScore - a.finalScore || String(getSafeKey(a.entry)).localeCompare(String(getSafeKey(b.entry))));
            const admitted = [], typedRejected = [], returnDepth = Math.max(1, Math.min(32, Number(depth) || 32));
            for (const item of accepted) {
                const hit = { entry: item.entry, rawScore: item.finalScore, text: item.text, evidence: { legacyAccepted: true, similarity: item.similarity,
                    detail: item.detail, exactAnchorHits: item.exactAnchorHits, recallBucket: item.recallBucket } };
                const verdict = typeof typedAdmission === 'function' ? typedAdmission(hit) : { ok: true };
                if (!verdict?.ok) { typedRejected.push({ key: getSafeKey(item.entry), reason: verdict?.reason || 'typed_admission' }); continue; }
                admitted.push(hit);
            }
            // Only candidates admitted by both gates may affect another source's
            // ranking. Typed-rejected inputs never enter the token statistics.
            const tokensByHit = new Map(), documentFrequency = new Map();
            for (const hit of admitted) {
                // The auxiliary source-rarity bonus measures lexical words.
                // Numeric and mixed identifier tokens remain in the original
                // query/evidence score, but their uniqueness is not evidence
                // of a distinctive fact and must not inflate this bonus.
                const tokens = new Set(TokenizerEngine.tokenize(hit.text || '').filter(token => /^\p{L}+$/u.test(token)));
                tokensByHit.set(hit, tokens);
                for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
            }
            for (const hit of admitted) {
                const tokens = tokensByHit.get(hit);
                const sourceDistinctiveness = 1 + [...tokens].reduce((sum, token) => sum + Math.log((admitted.length + 1) / ((documentFrequency.get(token) || 0) + 1)), 0) / Math.max(1, tokens.size);
                hit.evidence.sourceDistinctiveness = sourceDistinctiveness;
                hit.evidence.originalRawScore = hit.rawScore;
                hit.rawScore *= sourceDistinctiveness;
            }
            admitted.sort((a, b) => b.rawScore - a.rawScore || String(getSafeKey(a.entry)).localeCompare(String(getSafeKey(b.entry))));
            return { status: admitted.length ? 'ready' : 'degraded', reason: admitted.length ? '' : 'no_evidence',
                hits: admitted.slice(0, returnDepth).map((hit, i) => ({ ...hit, rank: i + 1 })),
                trace: { ...trace, stage: 'pre_mmr', scoredCount: scored.length, acceptedCount: accepted.length,
                    typedAdmittedCount: admitted.length, typedRejected, returnDepth,
                    rejected: scored.filter(item => !item?.accepted).map(item => ({ key: getSafeKey(item.entry), reason: item.rejectReason })) } };
        };
        // Recall Scoring V2 parity layer.
        // This is deliberately layered *above* the strengthened Jaccard core.  The sparse
        // engine still computes lexical/semantic similarity, while this layer decides
        // whether a candidate has enough direct evidence to receive positive bonuses.
        const RECALL_SCORING_V2_POLICY = Object.freeze({
            version: 'libra_recall_scoring_v2_parity_20260617',
            minSparseGate: 0.18,
            minWeakSparseGate: 0.10,
            maxPositiveBonus: 0.42,
            hardMismatchPenalty: 0.55,
            genericAnchorPenalty: 0.10,
            directAnchorBonus: 0.11,
            entityBonus: 0.07,
            semanticBonus: 0.055,
            bucketBonus: 0.075,
            directEvidenceBonus: 0.06,
            salienceWeight: 0.12,
            stalePenalty: 0.08
        });
        const RECALL_SCORING_DOMAIN_ANCHORS = new Set([]);
        const RECALL_SCORING_GENERIC_ANCHORS = new Set([
            '회수','기억','장면','관련','연결','정리','요약','정보','현재','지금','처음','원점부터','필요','필요해','다시','어떻게','무엇','왜','그때','이후','이전','계속','갈등','관계','상황','상태','단둘','단둘이','먹었던','먹은','먹던','먹고','식사','마음','부담','생긴','흔들린','부분','규칙','회사','계획','계획이야','일정','동선','동선을','숙소','관광','여행','하카타','고쿠라성','카페','라멘','축제','상관없는','상관','무관','제외','말고','아이돌','연습생','회수해줘','뭐였는지','막았는지','공개적','공개적으로','어떤','무슨','이유','때문','때문에','롤백','롤백된','삭제','삭제된','테스트','테스트야'
        ]);
        const RECALL_EXTERNAL_DOMAIN_RE = /고쿠라성|하카타|관광|숙소|호텔|동선|여행|일정|항공|비행|교통|맛집|카페|라멘|축제|온천|박물관|성터|후쿠오카|오사카|도쿄|나가사키|유후인|벳푸/i;
        const RECALL_STRONG_RP_RE = /a^/i;
        const RECALL_LATE_FAMILY_RE = /가족|자녀|아들(?=$|[\s,.;!?'"”’)\]}]|은|는|이|가|을|를|에게|과|와|의)|딸(?=$|[\s,.;!?'"”’)\]}]|은|는|이|가|을|를|에게|과|와|의)|부부|후일담|출산|육아/u;
        const RECALL_ORIGIN_QUERY_CUE_RE = /원점|어렸을\s*때|첫\s*만남|처음(?:에|부터)?|기원|초반|why|origin|beginning/u;
        const RECALL_EARLY_ORIGIN_SCENE_RE = /원점|어렸을\s*때|첫\s*만남|처음\s*(?:만났|사귀|좋아하게|끌렸|연애하게)|처음부터/u;
        const RECALL_GLOBAL_RECAP_RE = /스토리\s*전체\s*평가|전체\s*구조|전체적\s*흐름|장대한|대중들\s*포함해서|첫째를\s*가졌|가족\s*탄생/u;
        const normalizeRecallScoringAnchor = (value = '') => normalizeRecallAnchor(stripRecallAnchorParticles(normalizeRecallAnchor(value)));
        const normalizeRecallNameKey = (value = '') => normalizeRecallScoringAnchor(value).replace(/\s+/g, '');
        const isExternalRecallAnchor = (anchor = '') => RECALL_EXTERNAL_DOMAIN_RE.test(normalizeRecallScoringAnchor(anchor));
        const isGenericRecallAnchor = (anchor = '') => {
            const a = normalizeRecallScoringAnchor(anchor);
            return !a
                || RECALL_EXACT_ANCHOR_STOPWORDS.has(a)
                || RECALL_SCORING_GENERIC_ANCHORS.has(a)
                || /^(?:회수|기억|장면|관련|정보|정리|요약|필요|현재|지금|뭐|무엇|어떤|무슨|왜|이유|때문|공개적|롤백|삭제|테스트)/.test(a)
                || /(?:었던|했던|하던|먹던|먹은|먹고|생긴|흔들린|느낀|막았|막았는지|만나는|했던지|뭐였는지|해줘)$/.test(a);
        };
        const isScoringStrongRecallAnchor = (anchor = '') => {
            const a = normalizeRecallScoringAnchor(anchor);
            if (!a || a.length < 2) return false;
            if (RECALL_SCORING_DOMAIN_ANCHORS.has(a)) return true;
            if (isGenericRecallAnchor(a) || isExternalRecallAnchor(a)) return false;
            // Unknown proper nouns / rare concrete anchors are allowed, but generic short
            // Korean nouns are not promoted to direct evidence.
            return a.length >= 3 && !/^(계획|일정|동선|관광|숙소|여행|상관|제외|말고)/u.test(a);
        };
        const splitRecallAnchorsByEntity = (anchors = [], names = []) => {
            const nameKeys = new Set((Array.isArray(names) ? names : []).map(normalizeRecallNameKey).filter(Boolean));
            const entityAnchors = [];
            const sceneAnchors = [];
            for (const anchor of Array.isArray(anchors) ? anchors : []) {
                const normalized = normalizeRecallNameKey(anchor);
                if (!normalized) continue;
                if (nameKeys.has(normalized)) entityAnchors.push(normalizeRecallScoringAnchor(anchor));
                else sceneAnchors.push(normalizeRecallScoringAnchor(anchor));
            }
            return {
                entityAnchors: uniqLimit(entityAnchors, 16),
                sceneAnchors: uniqLimit(sceneAnchors, 16)
            };
        };
        const recallQueryNeedsStrictOriginScene = (queryPlan = {}, recallIntent = {}) => {
            if (!recallIntent?.origin) return false;
            const raw = String(queryPlan?.raw || '');
            if (RECALL_ORIGIN_QUERY_CUE_RE.test(raw)) return true;
            return (Array.isArray(queryPlan?.strongAnchors) ? queryPlan.strongAnchors : []).some(anchor => RECALL_ORIGIN_QUERY_CUE_RE.test(String(anchor || '')));
        };
        const getOriginSceneCueHits = (text = '', payload = {}) => {
            const raw = [
                String(text || ''),
                getHybridPayloadProjectionText(payload),
                String(payload?.summary || ''),
                String(payload?.arcKey || ''),
                String(payload?.arcRole || ''),
                ...(Array.isArray(payload?.tags) ? payload.tags : [])
            ].join('\n');
            const hits = [];
            if (/원점|출발점|시작점/u.test(raw)) hits.push('원점');
            if (/어렸을\s*때/u.test(raw)) hits.push('어렸을 때');
            if (/첫\s*만남/u.test(raw)) hits.push('첫 만남');
            if (/처음\s*(?:만났|사귀|좋아하게|끌렸|연애하게)|처음부터/u.test(raw)) hits.push('처음 관계');
            return uniqLimit(hits, 8);
        };
        const getOriginSceneCueProfile = (text = '', payload = {}) => {
            const hits = getOriginSceneCueHits(text, payload);
            const strongHits = hits.slice();
            return {
                hits,
                strongHits,
                weakHits: [],
                totalCount: hits.length,
                strongCount: strongHits.length,
                weakCount: 0
            };
        };
        const detectOriginLateFamilyLeak = ({ text = '', payload = {}, recallIntent = {}, queryPlan = {}, entityNames = [], matchedAnchors = [] } = {}) => {
            if (!recallIntent?.origin) return false;
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            const raw = [
                String(text || ''),
                getHybridPayloadProjectionText(payload),
                String(payload?.arcKey || ''),
                String(payload?.arcRole || ''),
                String(payload?.causalRole || ''),
                ...(isLedger ? [] : [
                    String(payload?.relationDelta || ''),
                    ...(Array.isArray(payload?.tags) ? payload.tags : [])
                ])
            ].join('\n');
            if (!RECALL_LATE_FAMILY_RE.test(raw) && !RECALL_GLOBAL_RECAP_RE.test(raw)) return false;
            if (RECALL_EARLY_ORIGIN_SCENE_RE.test(raw)) return false;
            const queryAnchorSplit = splitRecallAnchorsByEntity(queryPlan?.strongAnchors || [], entityNames);
            if (!recallQueryNeedsStrictOriginScene(queryPlan, recallIntent) && !queryAnchorSplit.sceneAnchors.some(anchor => RECALL_EARLY_ORIGIN_SCENE_RE.test(anchor))) return false;
            const matchedAnchorSplit = splitRecallAnchorsByEntity(matchedAnchors || [], entityNames);
            return matchedAnchorSplit.sceneAnchors.length === 0;
        };
        const getHybridWorldSignalProfile = (payload = {}, meta = {}, text = '') => {
            const ledger = getLedgerProjectionParts(payload);
            const payloadWorld = payload?.world && typeof payload.world === 'object' && !Array.isArray(payload.world) ? payload.world : {};
            const payloadHybrid = payload?.hybridRow && typeof payload.hybridRow === 'object' ? payload.hybridRow : {};
            const metaHybrid = meta?.hme && typeof meta.hme === 'object' ? meta.hme : {};
            const payloadCustomRules = normalizeWorldCustomRules(payloadWorld?.custom || payload?.custom);
            const facts = Array.isArray(payload?.facts) ? payload.facts : [];
            const ledgerWorldChange = ledger.world.length > 0 || facts.some(item => {
                const type = String(item?.type || item?.kind || '').trim().toLowerCase();
                return ['world', 'world_rule', 'worldrule', 'world_delta', 'world_change'].includes(type);
            });
            const hasStructuredWorldPayload = !!(
                String(payload?.worldSummary || meta?.worldSummary || meta?.classification || payload?.classification || payloadWorld?.classification?.primary || '').trim()
                || (payloadWorld?.exists && Object.keys(payloadWorld.exists).length > 0)
                || (payloadWorld?.systems && Object.keys(payloadWorld.systems).length > 0)
                || (payloadWorld?.physics && Object.keys(payloadWorld.physics).length > 0)
                || Object.keys(payloadCustomRules).length > 0
                || ledgerWorldChange
            );
            const hybridSource = String(payloadHybrid?.source || metaHybrid?.source || '').trim().toLowerCase();
            const storedPrimaryKind = String(payloadHybrid?.primaryKind || payloadHybrid?.kind || metaHybrid?.kind || '').trim().toLowerCase();
            const explicitWorldSnapshot = String(payload?.arcKey || '').trim().toLowerCase() === 'world_rule_snapshot';
            const narrativeSignals = ledger.narrative.length > 0 || storedPrimaryKind === 'narrative';
            const relationshipSignals = ledger.relation.length > 0 || storedPrimaryKind === 'relationship' || storedPrimaryKind === 'relation';
            const worldOnlyStructure = !narrativeSignals && !relationshipSignals;
            const dedicatedRow = explicitWorldSnapshot
                || ledgerWorldChange
                || hybridSource === 'world_recall_seed'
                || (worldOnlyStructure && hasStructuredWorldPayload)
                || (worldOnlyStructure && storedPrimaryKind === 'world' && hasStructuredWorldPayload);
            const strongDefinition = hasStructuredWorldPayload;
            return {
                strongDefinition,
                dedicatedRow,
                hasStructuredWorldPayload,
                worldLabelHits: 0,
                worldLexiconHits: 0,
                constraintHits: 0,
                narrativeSignals,
                relationshipSignals,
                ledgerWorldChange,
                hybridSource,
                storedPrimaryKind,
                sourcePolicy: 'structured_world_payload_only'
            };
        };
        const RECALL_NEGATIVE_CLAUSE_RE = /(상관\s*없\w*|무관\w*|관련\s*없\w*|관계\s*없\w*|제외\w*|빼고|말고|unrelated|not\s+related|excluding|except(?:\s+for)?|without)/i;
        const RECALL_NEGATIVE_META_TERMS = new Set(['상관', '상관없', '무관', '관련', '관계', '제외', '빼고', '말고', '없는', '없음', 'unrelated', 'related', 'excluding', 'except', 'without', 'not']);
        const RECALL_EXPLICIT_MEMORY_SCOPE_RE = /(?:이|현재|지금|방금|우리)\s*(?:챗|채팅|대화)\s*(?:안|내|에서)?|(?:저장된|기록된)\s*(?:기억|메모리)|(?:리브라|LIBRA)\s*(?:기억|메모리|리콜)|(?:chat|conversation)\s+(?:memory|recall)/i;
        const normalizeRecallSuppressionTerm = (value = '') => normalizeRecallScoringAnchor(value).replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
        const cleanNegativeRecallClause = (chunk = '') => String(chunk || '')
            .replace(RECALL_NEGATIVE_CLAUSE_RE, ' ')
            .replace(/(?:와|과|랑|하고|에)?(?:는|은)?\s*$/u, ' ')
            .replace(/^(?:그리고|또는|혹은|다만|하지만|그러나)\s+/u, ' ')
            .replace(/["'“”‘’`()[\]{}<>]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const splitNegativeRecallTerms = (chunk = '') => {
            const cleaned = cleanNegativeRecallClause(chunk);
            if (!cleaned) return [];
            const terms = [];
            const phrase = normalizeRecallSuppressionTerm(cleaned);
            if (phrase && phrase.length >= 2 && phrase.length <= 80) terms.push(phrase);
            for (const token of TokenizerEngine.tokenize(cleaned)) {
                const term = normalizeRecallSuppressionTerm(stripRecallAnchorParticles(token));
                if (!term || term.length < 2) continue;
                if (RECALL_NEGATIVE_META_TERMS.has(term)) continue;
                if (typeof RECALL_EXACT_ANCHOR_STOPWORDS !== 'undefined' && RECALL_EXACT_ANCHOR_STOPWORDS.has(term)) continue;
                terms.push(term);
            }
            return uniqLimit(terms, 24);
        };
        const extractNegativeRecallTerms = (query = '') => {
            const raw = String(query || '');
            const chunks = [];
            const koRelationPatterns = [
                /([^\n.!?。！？]{2,120}?)(?:와|과|랑|하고|에)?(?:는|은)?\s*(?:상관\s*없\w*|무관\w*|관련\s*없\w*|관계\s*없\w*)/giu,
                /([^\n.!?。！？]{2,120}?)(?:은|는|이|가|을|를)?\s*(?:제외\w*|빼고|말고)/giu
            ];
            const enRelationPatterns = [
                /(?:not\s+related\s+to|unrelated\s+to|excluding|except(?:\s+for)?|without)\s+([^\n.!?。！？]{2,120})/giu
            ];
            for (const pattern of [...koRelationPatterns, ...enRelationPatterns]) {
                let match;
                while ((match = pattern.exec(raw))) {
                    const chunk = String(match[1] || '').trim();
                    if (chunk) chunks.push(chunk);
                }
            }
            return uniqLimit(chunks.flatMap(splitNegativeRecallTerms), 32);
        };
        const recallSuppressionTermKeys = (terms = []) => new Set((Array.isArray(terms) ? terms : [])
            .map(term => normalizeRecallNameKey(term))
            .filter(Boolean));
        const recallSuppressionTermKeyCache = new WeakMap();
        const getRecallSuppressionTermKeySet = (plan = {}) => {
            if (!plan || typeof plan !== 'object') return recallSuppressionTermKeys([]);
            const terms = Array.isArray(plan.excludedTerms) ? plan.excludedTerms : [];
            const signature = terms.join('\u0000');
            const cached = recallSuppressionTermKeyCache.get(plan);
            if (cached && cached.signature === signature) return cached.keys;
            const keys = recallSuppressionTermKeys(terms);
            recallSuppressionTermKeyCache.set(plan, { signature, keys });
            return keys;
        };
        const matchesRecallSuppressionText = (value = '', plan = {}) => {
            const terms = Array.isArray(plan?.excludedTerms) ? plan.excludedTerms : [];
            if (!terms.length) return false;
            const normalized = normalizeSemanticText(value);
            const compact = normalized.replace(/\s+/g, '');
            return terms.some(term => {
                const t = normalizeSemanticText(term);
                if (!t || t.length < 2) return false;
                return normalized.includes(t) || compact.includes(t.replace(/\s+/g, ''));
            });
        };
        const buildRecallSuppressionPlan = (query = '', queryPlan = null, recallIntent = {}) => {
            const raw = String(query || '');
            const plan = queryPlan || buildRecallQueryPlan(raw, extractExactRecallAnchors(raw), recallIntent || classifyRecallIntent(raw));
            const excludedTerms = uniqLimit([...(Array.isArray(plan?.excludedTerms) ? plan.excludedTerms : []), ...extractNegativeRecallTerms(raw)], 32);
            const explicitMemoryScope = RECALL_EXPLICIT_MEMORY_SCOPE_RE.test(raw);
            const unrelatedExternal = !!(plan?.externalMismatch && !explicitMemoryScope);
            const negativeClause = excludedTerms.length > 0;
            return {
                version: 'libra.query_scope_guard.v1',
                raw,
                explicitMemoryScope,
                unrelatedExternal,
                negativeClause,
                suppressMemoryRecall: unrelatedExternal,
                suppressMemoryBackfill: unrelatedExternal,
                suppressActiveContext: unrelatedExternal,
                excludedTerms,
                reason: unrelatedExternal ? 'external_domain_query' : (negativeClause ? 'negative_recall_clause' : '')
            };
        };
        const normalizeRecallSuppressionPlan = (provided = null, query = '', queryPlan = null, recallIntent = {}) => {
            if (provided && typeof provided === 'object' && provided.version === 'libra.query_scope_guard.v1') {
                const localTerms = extractNegativeRecallTerms(query);
                return {
                    ...provided,
                    excludedTerms: uniqLimit([...(Array.isArray(provided.excludedTerms) ? provided.excludedTerms : []), ...localTerms], 32)
                };
            }
            return buildRecallSuppressionPlan(query, queryPlan, recallIntent);
        };
        const buildRecallQueryPlan = (query = '', exactAnchors = [], recallIntent = {}) => {
            const raw = String(query || '');
            const normalized = normalizeSemanticText(raw);
            const excludedTerms = extractNegativeRecallTerms(raw);
            const excludedTermKeys = recallSuppressionTermKeys(excludedTerms);
            const anchors = uniqLimit((Array.isArray(exactAnchors) ? exactAnchors : [])
                .map(normalizeRecallScoringAnchor)
                .filter(Boolean)
                .filter(anchor => !excludedTermKeys.has(normalizeRecallNameKey(anchor))), 16);
            const strongAnchors = anchors.filter(isScoringStrongRecallAnchor).slice(0, 10);
            const genericAnchors = anchors.filter(a => !strongAnchors.includes(a)).slice(0, 10);
            const externalHits = uniqLimit((normalized.match(RECALL_EXTERNAL_DOMAIN_RE) || []).map(v => String(v || '').trim()).filter(Boolean), 8);
            const explicitUnrelated = RECALL_NEGATIVE_CLAUSE_RE.test(normalized);
            const hasRpNamedAnchor = RECALL_STRONG_RP_RE.test(normalized) || strongAnchors.some(a => RECALL_SCORING_DOMAIN_ANCHORS.has(a));
            const hasRecallEvidenceIntent = !!(recallIntent?.origin || recallIntent?.transition || recallIntent?.relationship || recallIntent?.worldRule || recallIntent?.aftermath);
            const externalMismatch = externalHits.length > 0 && !hasRpNamedAnchor && !hasRecallEvidenceIntent;
            const explicitExternalMismatch = externalHits.length > 0 && explicitUnrelated && !hasRpNamedAnchor;
            return {
                version: RECALL_SCORING_V2_POLICY.version,
                raw,
                normalized,
                anchors,
                strongAnchors,
                genericAnchors,
                excludedTerms,
                externalHits,
                explicitUnrelated,
                hasRpNamedAnchor,
                hasRecallEvidenceIntent,
                externalMismatch: !!(externalMismatch || explicitExternalMismatch),
                labels: uniqLimit([
                    ...(strongAnchors.length ? ['strong-anchor'] : []),
                    ...(genericAnchors.length ? ['generic-anchor'] : []),
                    ...(excludedTerms.length ? ['negative-anchor'] : []),
                    ...(externalHits.length ? ['external-domain'] : []),
                    ...(explicitUnrelated ? ['explicit-unrelated'] : []),
                    ...(hasRecallEvidenceIntent ? ['recall-intent'] : [])
                ], 12)
            };
        };
        const collectRecallEntityEvidence = (query = '', payload = {}, meta = {}, focusNames = []) => {
            const ledger = getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            const names = uniqLimit([
                ...(Array.isArray(focusNames) ? focusNames : []),
                ...(isLedger ? [] : [
                    ...(Array.isArray(meta?.ent) ? meta.ent : []),
                    ...(Array.isArray(meta?.entities) ? meta.entities : []),
                    ...(Array.isArray(payload?.mentionedEntityNames) ? payload.mentionedEntityNames : []),
                    ...(Array.isArray(payload?.entityRefs) ? payload.entityRefs.map(x => x?.name || x?.id || x).filter(Boolean) : [])
                ]),
                ...ledger.entities
            ].map(v => String(v || '').trim()).filter(v => v.length >= 2), 32);
            const q = normalizeSemanticText(query).replace(/\s+/g, '');
            const hits = names.filter(name => q.includes(normalizeSemanticText(name).replace(/\s+/g, ''))).slice(0, 8);
            return { names, hits, count: hits.length };
        };
        const bucketMatchesIntent = (bucket = '', intent = {}) => {
            const b = String(bucket || 'general');
            return !!((intent?.origin && b === 'origin')
                || (intent?.transition && b === 'transition')
                || (intent?.relationship && b === 'relationship')
                || (intent?.worldRule && b === 'world')
                || (intent?.aftermath && b === 'aftermath')
                || (intent?.current && b === 'current'));
        };
        const scoreRecallItemV2 = ({ detail = {}, queryPlan = {}, recallIntent = {}, payload = {}, meta = {}, currentTurn = 0, recency = 0, effectiveRecency = 0, importance = 0, intentBonus = 0, recallBucket = 'general', W = {}, text = '', query = '', focusNames = [], hmeGraphBoostInfo = null, hmeGraphBoost = 0 } = {}) => {
            const evidenceMode = String(CONFIG.recallEvidenceGate || 'soft').toLowerCase();
            const sim = Number(detail?.similarity || 0);
            const sparse = Number(detail?.sparseScore || detail?.baseScore || 0);
            const strongAnchorHits = getExactAnchorHits(queryPlan.strongAnchors || [], text).filter(isScoringStrongRecallAnchor).slice(0, 8);
            const genericAnchorHits = getExactAnchorHits(queryPlan.genericAnchors || [], text).filter(a => !strongAnchorHits.includes(a)).slice(0, 8);
            const excludedAnchorHits = getExactAnchorHits(queryPlan.excludedTerms || [], text).slice(0, 8);
            const excludedAnchorKeySet = getRecallSuppressionTermKeySet(queryPlan);
            const positiveStrongAnchorHits = strongAnchorHits.filter(anchor => !excludedAnchorKeySet.has(normalizeRecallNameKey(anchor)));
            const entity = collectRecallEntityEvidence(query, payload, meta, focusNames);
            const semanticEvidence = !!(detail?.semanticAliasBridge || (detail?.semanticGate && Number(detail?.semanticEntityOverlap || 0) >= 1));
            const directEvidence = !!(detail?.evidence?.quoteHits?.length || detail?.evidence?.nameHits?.length || detail?.evidence?.numberHits?.length || strongAnchorHits.length || entity.count);
            const intentAligned = bucketMatchesIntent(recallBucket, recallIntent) || intentBonus >= 0.14;
            const graphRelation = String(hmeGraphBoostInfo?.relation || '').trim();
            const graphLayer = String(hmeGraphBoostInfo?.edgeLayer || '').trim();
            const graphConfidence = Number(hmeGraphBoostInfo?.confidence || 0);
            const graphBoostValue = Math.max(0, Number(hmeGraphBoost || hmeGraphBoostInfo?.boost || 0));
            const graphFocusSeed = graphRelation === 'focus_entity_seed' || graphLayer === 'focus';
            const graphEvidence = !!(hmeGraphBoostInfo && graphBoostValue > 0 && !['turn_proximity'].includes(graphRelation));
            const graphStrongEvidence = !!(graphEvidence && (
                graphFocusSeed
                || graphLayer === 'meaning'
                || !['shared_entity', 'same_source_ref', 'associated_with'].includes(graphRelation)
                || graphConfidence >= 0.35
            ));
            const negativeAnchorHardReject = excludedAnchorHits.length > 0 && positiveStrongAnchorHits.length === 0 && !semanticEvidence && !intentAligned;
            const worldSignalProfile = getHybridWorldSignalProfile(payload, meta, text);
            const worldPrimaryMatch = recallIntent?.worldRule && worldSignalProfile.dedicatedRow;
            const originFamilyMismatch = recallIntent?.origin
                && RECALL_LATE_FAMILY_RE.test(String(text || ''))
                && !RECALL_EARLY_ORIGIN_SCENE_RE.test(String(text || ''));
            const originLateFamilyLeak = detectOriginLateFamilyLeak({
                text,
                payload,
                recallIntent,
                queryPlan,
                entityNames: entity.names,
                matchedAnchors: strongAnchorHits
            });
            const strictOriginQuery = recallQueryNeedsStrictOriginScene(queryPlan, recallIntent);
            const originCueProfile = strictOriginQuery ? getOriginSceneCueProfile(text, payload) : { hits: [], strongHits: [], weakHits: [], totalCount: 0, strongCount: 0, weakCount: 0 };
            const sparseGate = sim >= RECALL_SCORING_V2_POLICY.minSparseGate || sparse >= RECALL_SCORING_V2_POLICY.minSparseGate;
            const weakSparseGate = (sim >= RECALL_SCORING_V2_POLICY.minWeakSparseGate || sparse >= RECALL_SCORING_V2_POLICY.minWeakSparseGate) && (semanticEvidence || directEvidence || intentAligned);
            const relevanceGate = !!(sparseGate || weakSparseGate || directEvidence || semanticEvidence || intentAligned || graphStrongEvidence);
            const domainMismatchHardReject = !!(CONFIG.recallDomainGuardEnabled !== false && queryPlan.externalMismatch && !directEvidence && !semanticEvidence && !intentAligned);
            const positiveAllowed = relevanceGate && !domainMismatchHardReject && !negativeAnchorHardReject;
            let positiveBonus = 0;
            if (positiveAllowed) {
                positiveBonus += Math.min(0.22, strongAnchorHits.length * RECALL_SCORING_V2_POLICY.directAnchorBonus);
                positiveBonus += Math.min(0.14, entity.count * RECALL_SCORING_V2_POLICY.entityBonus);
                if (semanticEvidence) positiveBonus += RECALL_SCORING_V2_POLICY.semanticBonus;
                if (intentAligned) positiveBonus += RECALL_SCORING_V2_POLICY.bucketBonus;
                if (directEvidence) positiveBonus += RECALL_SCORING_V2_POLICY.directEvidenceBonus;
                if (graphStrongEvidence) positiveBonus += Math.min(0.12, (graphBoostValue * 0.7) + (graphFocusSeed ? 0.055 : 0.025));
                if (worldPrimaryMatch) positiveBonus += 0.18;
                if (strictOriginQuery && recallIntent?.origin && originCueProfile.totalCount > 0) {
                    positiveBonus += Math.min(0.26, (originCueProfile.strongCount * 0.12) + (originCueProfile.weakCount * 0.05));
                }
                positiveBonus += Math.min(0.10, Math.max(0, importance) * RECALL_SCORING_V2_POLICY.salienceWeight);
                positiveBonus = Math.min(RECALL_SCORING_V2_POLICY.maxPositiveBonus, positiveBonus);
            }
            let penalty = 0;
            if (domainMismatchHardReject || (queryPlan.externalMismatch && !directEvidence)) penalty += RECALL_SCORING_V2_POLICY.hardMismatchPenalty;
            if (excludedAnchorHits.length > 0) penalty += Math.min(0.48, 0.28 + (excludedAnchorHits.length * 0.08));
            if (!strongAnchorHits.length && genericAnchorHits.length > 0 && !semanticEvidence && !entity.count) penalty += RECALL_SCORING_V2_POLICY.genericAnchorPenalty;
            if (originFamilyMismatch) penalty += 0.34;
            if (originLateFamilyLeak) penalty += 0.28;
            if (strictOriginQuery && recallIntent?.origin && originCueProfile.strongCount === 0 && originCueProfile.weakCount > 0) penalty += 0.09;
            const turn = Number(meta?.t || payload?.turn || 0);
            const age = Number.isFinite(turn) && currentTurn ? Math.max(0, currentTurn - turn) : 0;
            if (!recallIntent?.origin && !recallIntent?.transition && age > 24 && !directEvidence && !semanticEvidence) penalty += RECALL_SCORING_V2_POLICY.stalePenalty;
            const recencyTerm = positiveAllowed ? (Number(effectiveRecency || recency || 0) * Number(W.recency ?? 0.2)) : Math.min(0.025, Number(recency || 0) * 0.025);
            const importanceTerm = positiveAllowed ? (Number(importance || 0) * Number(W.importance ?? 0.3)) : 0;
            const baseScore = (sim * Number(W.similarity ?? 0.5)) + recencyTerm + importanceTerm;
            const finalScore = Math.max(0, baseScore + (positiveAllowed ? intentBonus : 0) + positiveBonus - penalty);
            const thresholdPass = !domainMismatchHardReject && !negativeAnchorHardReject && (
                finalScore >= Math.max(0.18, CONFIG.simThreshold * 0.72)
                || sim >= CONFIG.simThreshold
                || (directEvidence && sim >= CONFIG.simThreshold * 0.45)
                || (semanticEvidence && sim >= CONFIG.simThreshold * 0.45)
                || (intentAligned && sim >= CONFIG.simThreshold * 0.50)
                || (graphStrongEvidence && (sim >= CONFIG.simThreshold * 0.25 || sparse >= RECALL_SCORING_V2_POLICY.minWeakSparseGate * 0.55 || graphBoostValue >= 0.045))
            );
            const gatePass = !domainMismatchHardReject && !negativeAnchorHardReject && (relevanceGate || evidenceMode === 'off');
            return {
                version: RECALL_SCORING_V2_POLICY.version,
                enabled: CONFIG.recallScoringV2Enabled !== false,
                finalScore,
                baseScore,
                positiveBonus,
                penalty,
                thresholdPass,
                gatePass,
                relevanceGate,
                domainMismatchHardReject,
                directEvidence,
                semanticEvidence,
                intentAligned,
                graphEvidence,
                graphStrongEvidence,
                sparseGate,
                weakSparseGate,
                strongAnchorHits,
                genericAnchorHits,
                excludedAnchorHits,
                negativeAnchorHardReject,
                entityHits: entity.hits,
                externalHits: queryPlan.externalHits || [],
                reasons: uniqLimit([
                    ...(relevanceGate ? ['relevance_gate'] : ['no_relevance_gate']),
                    ...(strongAnchorHits.length ? [`anchor:${strongAnchorHits.slice(0, 3).join('/')}`] : []),
                    ...(genericAnchorHits.length ? [`generic:${genericAnchorHits.slice(0, 3).join('/')}`] : []),
                    ...(excludedAnchorHits.length ? [`excluded:${excludedAnchorHits.slice(0, 3).join('/')}`] : []),
                    ...(negativeAnchorHardReject ? ['negative_anchor_hard_reject'] : []),
                    ...(entity.hits.length ? [`entity:${entity.hits.slice(0, 3).join('/')}`] : []),
                    ...(semanticEvidence ? ['semantic'] : []),
                    ...(intentAligned ? [`bucket:${recallBucket}`] : []),
                    ...(graphStrongEvidence ? [`hme-graph:${graphLayer || 'signal'}:${graphRelation || 'associated'}`] : []),
                    ...(worldPrimaryMatch ? ['world-primary-match'] : []),
                    ...(strictOriginQuery && recallIntent?.origin && originCueProfile.strongCount > 0 ? [`origin-cue:${originCueProfile.strongHits.slice(0, 2).join('/')}`] : []),
                    ...(strictOriginQuery && recallIntent?.origin && originCueProfile.strongCount === 0 && originCueProfile.weakCount > 0 ? ['origin-strong-cue-miss'] : []),
                    ...(originLateFamilyLeak ? ['origin-late-family-leak'] : []),
                    ...(originFamilyMismatch ? ['origin-family-mismatch'] : []),
                    ...(domainMismatchHardReject ? ['domain_mismatch_hard_reject'] : [])
                ], 12)
            };
        };
        // Patch A follow-up: exact-anchor recall backfill.
        // Purpose: when a long-chat query names a rare concrete anchor (e.g. an item, place,
        // rule, or guilt beat), at least one memory containing that exact anchor should survive
        // prefiltering and diversity selection even if recent high-pressure scenes dominate scores.
        const RECALL_EXACT_BACKFILL_MAX = 4;
        const RECALL_EXACT_ANCHOR_STOPWORDS = new Set([
            '사용자','응답','대화','장면','현재','지금','기억','관련','회수','회수해줘','필요','필요해','연결','갈등','정보','요약','정리','계속','다음','이번','저번','처음에','왜','무엇','어떻게','그리고','하지만','그러나','때문','부터','까지','같이','중요','원점부터'
        ]);
        const stripRecallAnchorParticles = (token = '') => {
            let out = String(token || '').trim();
            for (let i = 0; i < 3; i += 1) {
                const normalizedOut = normalizeRecallAnchor(out);
                if (RECALL_SCORING_DOMAIN_ANCHORS.has(normalizedOut)) break;
                const next = out.replace(/(에게서|에게|에서|으로부터|부터|까지|이라서|라서|이라는|라는|이라도|라도|으로|로|은|는|이|가|을|를|과|와|의|도|만|에)$/u, '').trim();
                if (next === out) break;
                out = next;
                if (RECALL_SCORING_DOMAIN_ANCHORS.has(normalizeRecallAnchor(out))) break;
            }
            return out;
        };
        // Pure string normalizer.  Callers hit it once per (anchor x candidate) pair, and the
        // same anchors repeat across every candidate, so the redundant work dominates recall.
        // Memoized below; the raw implementation stays as the reference.
        const normalizeRecallAnchorUncached = (value = '') => String(value || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{M}\p{N}_\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        // Bounded memo: recall vocabularies repeat heavily (entity names, places, slots) but a
        // huge chat could grow unbounded, so cap the entries and clear on overflow.
        const RECALL_ANCHOR_MEMO_MAX = 20000;
        const recallAnchorMemo = new Map();
        const recallAnchorMemoStats = { hits: 0, misses: 0, maxEntries: RECALL_ANCHOR_MEMO_MAX };
        const normalizeRecallAnchor = (value = '') => {
            const key = String(value ?? '');
            const cached = recallAnchorMemo.get(key);
            if (cached !== undefined) {
                recallAnchorMemoStats.hits += 1;
                return cached;
            }
            recallAnchorMemoStats.misses += 1;
            const normalized = normalizeRecallAnchorUncached(key);
            if (recallAnchorMemo.size >= RECALL_ANCHOR_MEMO_MAX) {
                recallAnchorMemo.clear();
                recallAnchorMemoStats.clears = (recallAnchorMemoStats.clears || 0) + 1;
            }
            recallAnchorMemo.set(key, normalized);
            return normalized;
        };
        const RECALL_EXACT_ANCHOR_PRIORITY = new Set([]);
        const isPriorityRecallAnchor = (anchor = '') => RECALL_EXACT_ANCHOR_PRIORITY.has(normalizeRecallAnchor(anchor));
        const pushRecallAnchor = (anchors, value = '') => {
            const normalizedRaw = normalizeRecallAnchor(value);
            const normalized = normalizeRecallAnchor(stripRecallAnchorParticles(normalizedRaw));
            if (!normalized || normalized.length < 2) return;
            if (RECALL_EXACT_ANCHOR_STOPWORDS.has(normalized)) return;
            if (typeof isGenericRecallAnchor === 'function' && isGenericRecallAnchor(normalized)) return;
            anchors.push(normalized);
        };
        const extractExactRecallAnchors = (query = '') => {
            const raw = String(query || '');
            const lower = raw.normalize('NFKC').toLowerCase();
            const anchors = [];
            const phraseRules = [
                ['원점', /원점|처음|origin|beginning/i]
            ];
            phraseRules.forEach(([anchor, pattern]) => { if (pattern.test(lower)) pushRecallAnchor(anchors, anchor); });
            const hardQueryTokens = raw.match(/[A-Za-z][A-Za-z0-9_.-]{1,32}|[가-힣]{2,12}|[ぁ-んァ-ヶ一-龯]{2,12}/g) || [];
            for (const token of hardQueryTokens) {
                const variants = [token, stripRecallAnchorParticles(token)];
                for (const variant of variants) pushRecallAnchor(anchors, variant);
            }
            const seen = new Set();
            return anchors
                .map(normalizeRecallAnchor)
                .filter(anchor => {
                    if (!anchor || seen.has(anchor)) return false;
                    seen.add(anchor);
                    return true;
                })
                .sort((a, b) => b.length - a.length)
                .slice(0, 10);
        };
        const getExactAnchorHits = (anchors = [], text = '') => {
            const normalizedText = normalizeRecallAnchor(text);
            if (!normalizedText) return [];
            const list = Array.isArray(anchors) ? anchors : [];
            // The anchors are loop-invariant across candidates: pre-normalizing them here (with
            // the memo) removes the per-candidate re-normalization that dominated recall.
            const normalizedAnchors = list.map(anchor => normalizeRecallAnchor(anchor));
            return list.filter((anchor, index) => {
                const normalizedAnchor = normalizedAnchors[index];
                return normalizedAnchor && normalizedText.includes(normalizedAnchor);
            });
        };
        const getRecallItemKey = (item = null) => {
            const entry = item?.entry || item;
            try { return getSafeKey(entry) || TokenizerEngine.getSafeMapKey(JSON.stringify(entry || {})); }
            catch (_) { return TokenizerEngine.getSafeMapKey(String(entry?.content || item?.text || '')); }
        };
        const buildExactAnchorBackfillItem = (item = null, hits = [], recallIntent = {}, currentTurn = 0, eligibilityContext = {}) => {
            if (!item || !inspectRecallEligibility(item.entry, { ...eligibilityContext, currentTurn }).eligible) return null;
            const entry = { ...(item.entry || {}) };
            const meta = item.meta || getCachedMeta(entry);
            const payload = item.payload || getRecallPayload(entry);
            const text = item.text || CompactMemoryCodec.buildSearchTextFromEntry(entry);
            const detail = item.detail && typeof item.detail === 'object' ? { ...item.detail } : {};
            const reason = `exact_anchor:${hits.slice(0, 3).join('/')}`;
            detail.evidenceGate = true;
            detail.exactAnchorBackfill = true;
            detail.exactAnchorHits = hits.slice(0, 8);
            detail.evidenceReasons = uniqLimit([...(Array.isArray(detail.evidenceReasons) ? detail.evidenceReasons : []), reason], 8);
            if (!detail.bestWindow) {
                try {
                    detail.bestWindow = StrengthenedJaccardCore.selectBestWindow(hits.join(' '), text, {
                        meta,
                        currentTurn,
                        maxChars: CONFIG.recallSentenceWindowChars || 260,
                        radius: 1
                    });
                } catch (_) { detail.bestWindow = ''; }
            }
            const boostedScore = Math.max(Number(item.finalScore || 0), Number(item.similarity || 0)) + 0.28 + Math.min(0.18, hits.length * 0.04);
            const originCueProfile = recallIntent?.origin ? getOriginSceneCueProfile(text, payload || {}) : { strongCount: 0 };
            const hybridBuckets = item?.hybridRow?.hybridLite?.buckets || item?.entry?._hybridBuckets || [];
            const backfillOriginFit = Boolean(recallIntent?.origin && (
                item.recallBucket === 'origin'
                || (Array.isArray(hybridBuckets) && hybridBuckets.includes('origin'))
                || String(payload?.arcRole || '').trim() === 'origin'
                || String(payload?.causalRole || '').trim() === 'cause'
                || Number(originCueProfile.strongCount || 0) > 0
            ));
            const recallBucket = backfillOriginFit
                ? 'origin'
                : (item.recallBucket || classifyRecallBucket(payload, recallIntent, meta, currentTurn) || 'general');
            entry._score = boostedScore;
            entry._recallDetail = detail;
            entry._recallWindow = detail.bestWindow || item.entry?._recallWindow || '';
            entry._recallBucket = recallBucket;
            entry._recallIntentBonus = Math.max(Number(item.intentBonus || 0), 0.18);
            entry._recallIntentLabels = Array.isArray(recallIntent?.labels) ? recallIntent.labels.slice(0, 6) : [];
            entry._recallExactAnchorBackfill = hits.slice(0, 8);
            return {
                ...item,
                entry,
                accepted: true,
                exactAnchorBackfill: true,
                exactAnchorHits: hits.slice(0, 8),
                recallBucket,
                finalScore: boostedScore,
                detail,
                meta,
                payload,
                text
            };
        };
        const applyExactAnchorBackfill = (selectedItems = [], scoredResults = [], exactAnchors = [], topK = 15, recallIntent = {}, currentTurn = 0, eligibilityContext = {}) => {
            const anchors = Array.isArray(exactAnchors) ? exactAnchors.filter(Boolean) : [];
            if (!anchors.length || !Array.isArray(scoredResults) || !scoredResults.length) return selectedItems;
            const limit = Math.max(1, Number(topK || 15));
            const selected = Array.isArray(selectedItems) ? selectedItems.slice() : [];
            const selectedKeys = new Set(selected.map(getRecallItemKey).filter(Boolean));
            const covered = new Set();
            for (let idx = 0; idx < selected.length; idx += 1) {
                const item = selected[idx];
                const text = [item?.text, item?.entry?.content, CompactMemoryCodec.buildSearchTextFromEntry(item?.entry)].filter(Boolean).join('\n');
                const hits = getExactAnchorHits(anchors, text);
                hits.forEach(anchor => covered.add(anchor));
                const priorityHits = hits.filter(isPriorityRecallAnchor);
                if (priorityHits.length > 0 && !(item?.exactAnchorBackfill || item?.entry?._recallExactAnchorBackfill)) {
                    const promoted = buildExactAnchorBackfillItem(item, priorityHits, recallIntent, currentTurn, eligibilityContext);
                    if (promoted) selected[idx] = promoted;
                }
            }
            const candidates = scoredResults
                .map(item => {
                    const text = [item?.text, item?.entry?.content, CompactMemoryCodec.buildSearchTextFromEntry(item?.entry)].filter(Boolean).join('\n');
                    const hits = getExactAnchorHits(anchors, text);
                    return { item, hits };
                })
                .filter(row => row.hits.length > 0 && inspectRecallEligibility(row.item?.entry, { ...eligibilityContext, currentTurn }).eligible)
                .sort((a, b) => {
                    const acceptedA = a.item?.accepted ? 1 : 0;
                    const acceptedB = b.item?.accepted ? 1 : 0;
                    return (b.hits.length - a.hits.length)
                        || (acceptedB - acceptedA)
                        || (Number(b.item?.finalScore || 0) - Number(a.item?.finalScore || 0))
                        || (Number(b.item?.meta?.t || 0) - Number(a.item?.meta?.t || 0));
                });
            let added = 0;
            for (const anchor of anchors) {
                if (covered.has(anchor) || added >= RECALL_EXACT_BACKFILL_MAX) continue;
                const row = candidates.find(candidate => candidate.hits.includes(anchor) && !selectedKeys.has(getRecallItemKey(candidate.item)));
                if (!row) continue;
                const backfill = buildExactAnchorBackfillItem(row.item, row.hits, recallIntent, currentTurn, eligibilityContext);
                if (!backfill) continue;
                const key = getRecallItemKey(backfill);
                if (!key || selectedKeys.has(key)) continue;
                selected.push(backfill);
                selectedKeys.add(key);
                row.hits.forEach(hit => covered.add(hit));
                added += 1;
            }
            if (selected.length <= limit) return selected;
            const backfill = selected.filter(item => item?.exactAnchorBackfill || item?.entry?._recallExactAnchorBackfill);
            const regular = selected.filter(item => !(item?.exactAnchorBackfill || item?.entry?._recallExactAnchorBackfill));
            const out = [];
            const seen = new Set();
            const add = (item) => {
                const key = getRecallItemKey(item);
                if (!key || seen.has(key) || out.length >= limit) return;
                seen.add(key);
                out.push(item);
            };
            backfill.forEach(add);
            regular.forEach(add);
            return out;
        };
        const getRecallItemText = (item = null) => {
            if (!item) return '';
            return String(item.text || item.entry?._recallWindow || CompactMemoryCodec.buildSearchTextFromEntry(item.entry || {}) || '');
        };
        const getRecallItemEntityNames = (item = null) => {
            const payload = item?.payload || {};
            const meta = item?.meta || {};
            const ledger = getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            const toNames = (value) => (Array.isArray(value) ? value : [])
                .map(v => typeof v === 'string' ? v : (v?.name || v?.id || v?.label || v?.ref || ''))
                .map(v => String(v || '').trim())
                .filter(Boolean);
            return uniqLimit([
                ...(isLedger ? [] : [
                    ...toNames(meta?.ent),
                    ...toNames(meta?.entities),
                    ...toNames(payload?.mentionedEntityNames),
                    ...toNames(payload?.entityRefs),
                    ...toNames(item?.hybridRow?.subjects)
                ]),
                ...ledger.entities
            ], 24);
        };
        const annotateOriginSelectionCandidate = (item = null, queryPlan = {}, recallIntent = {}) => {
            if (!item) return null;
            const text = getRecallItemText(item);
            const entityNames = getRecallItemEntityNames(item);
            const matchedAnchors = getExactAnchorHits(queryPlan?.strongAnchors || [], text).filter(isScoringStrongRecallAnchor).slice(0, 12);
            const anchorSplit = splitRecallAnchorsByEntity(matchedAnchors, entityNames);
            const sceneHits = anchorSplit.sceneAnchors.filter(anchor => RECALL_EARLY_ORIGIN_SCENE_RE.test(anchor));
            const originCueProfile = getOriginSceneCueProfile(text, item.payload || {});
            const originCueHits = originCueProfile.hits;
            const retrospective = Boolean(
                item?.payload?.retrospectiveClass
                || String(item?.payload?.arcRole || '').trim() === 'retrospective'
                || String(item?.payload?.recallProfile || '').trim() === 'continuity_only'
            );
            const leak = detectOriginLateFamilyLeak({
                text,
                payload: item.payload || {},
                recallIntent,
                queryPlan,
                entityNames,
                matchedAnchors
            });
            return {
                item,
                text,
                entityNames,
                matchedAnchors,
                sceneHits,
                originCueHits,
                originCueProfile,
                retrospective,
                leak,
                exactBackfill: Boolean(item?.exactAnchorBackfill || item?.entry?._recallExactAnchorBackfill)
            };
        };
        const rebalanceSelectedRecallItemsForIntent = (selectedItems = [], scoredResults = [], queryPlan = {}, recallIntent = {}, topK = 15, currentTurn = 0) => {
            if (!recallIntent?.origin || !Array.isArray(selectedItems) || selectedItems.length === 0) return selectedItems;
            const strictOriginQuery = recallQueryNeedsStrictOriginScene(queryPlan, recallIntent);
            const sceneQueryAnchors = splitRecallAnchorsByEntity(queryPlan?.strongAnchors || [], []).sceneAnchors
                .filter(anchor => RECALL_EARLY_ORIGIN_SCENE_RE.test(anchor));
            if (!strictOriginQuery && sceneQueryAnchors.length === 0) return selectedItems;
            const limit = Math.max(1, Number(topK || selectedItems.length || 1));
            const keyOf = (item) => getRecallItemKey(item);
            const selectedKeys = new Set(selectedItems.map(keyOf).filter(Boolean));
            const annotatedSelected = selectedItems.map(item => annotateOriginSelectionCandidate(item, queryPlan, recallIntent)).filter(Boolean);
            const minSceneCount = strictOriginQuery
                ? 2
                : Math.min(3, Math.max(1, sceneQueryAnchors.length >= 2 ? 2 : 1));
            const minStrongOriginCount = strictOriginQuery ? 1 : 0;
            const acceptedCandidates = (Array.isArray(scoredResults) ? scoredResults : [])
                .filter(item => item?.accepted)
                .map(item => annotateOriginSelectionCandidate(item, queryPlan, recallIntent))
                .filter(Boolean)
                .filter(candidate => {
                    const key = keyOf(candidate.item);
                    return key && !selectedKeys.has(key);
                })
                .filter(candidate => !candidate.leak && (candidate.sceneHits.length > 0 || candidate.originCueHits.length > 0 || candidate.item?.recallBucket === 'origin'))
                .sort((a, b) => {
                    const exactDiff = Number(b.exactBackfill) - Number(a.exactBackfill);
                    if (exactDiff) return exactDiff;
                    const retrospectiveDiff = Number(a.retrospective) - Number(b.retrospective);
                    if (retrospectiveDiff) return retrospectiveDiff;
                    const strongCueDiff = Number(b.originCueProfile?.strongCount || 0) - Number(a.originCueProfile?.strongCount || 0);
                    if (strongCueDiff) return strongCueDiff;
                    const cueDiff = b.originCueHits.length - a.originCueHits.length;
                    if (cueDiff) return cueDiff;
                    const sceneDiff = b.sceneHits.length - a.sceneHits.length;
                    if (sceneDiff) return sceneDiff;
                    const turnDiff = Number(a.item?.meta?.t || a.item?.payload?.turn || 0) - Number(b.item?.meta?.t || b.item?.payload?.turn || 0);
                    if (strictOriginQuery && turnDiff) return turnDiff;
                    return Number(b.item?.finalScore || 0) - Number(a.item?.finalScore || 0);
                });
            if (acceptedCandidates.length === 0) return selectedItems;
            const takeReplacement = (predicate = null) => {
                if (typeof predicate !== 'function') return acceptedCandidates.shift() || null;
                const index = acceptedCandidates.findIndex(predicate);
                if (index < 0) return acceptedCandidates.shift() || null;
                const [picked] = acceptedCandidates.splice(index, 1);
                return picked || null;
            };
            const replaceAt = (index, replacement) => {
                if (!replacement || index < 0 || index >= annotatedSelected.length) return false;
                const oldKey = keyOf(annotatedSelected[index]?.item);
                const newKey = keyOf(replacement.item);
                if (!newKey || selectedKeys.has(newKey)) return false;
                if (oldKey) selectedKeys.delete(oldKey);
                selectedKeys.add(newKey);
                annotatedSelected[index] = replacement;
                return true;
            };
            const countStrongOriginSelected = () => annotatedSelected.reduce((acc, candidate) => acc + (((candidate.originCueProfile?.strongCount || 0) > 0 && !candidate.retrospective) ? 1 : 0), 0);
            annotatedSelected
                .map((candidate, index) => ({ candidate, index }))
                .filter(({ candidate }) => candidate.leak && candidate.sceneHits.length === 0 && candidate.originCueHits.length === 0)
                .sort((a, b) => Number(a.candidate.item?.finalScore || 0) - Number(b.candidate.item?.finalScore || 0))
                .forEach(({ index }) => {
                    const replacement = takeReplacement();
                    if (replacement) replaceAt(index, replacement);
                });
            const hasNonRetrospectiveStrongOrigin = strictOriginQuery && (
                annotatedSelected.some(candidate => !candidate.retrospective && Number(candidate.originCueProfile?.strongCount || 0) > 0)
                || acceptedCandidates.some(candidate => !candidate.retrospective && Number(candidate.originCueProfile?.strongCount || 0) > 0)
            );
            if (hasNonRetrospectiveStrongOrigin) {
                annotatedSelected
                    .map((candidate, index) => ({ candidate, index }))
                    .filter(({ candidate }) => candidate.retrospective)
                    .sort((a, b) => Number(a.candidate.item?.finalScore || 0) - Number(b.candidate.item?.finalScore || 0))
                    .forEach(({ index }) => {
                        const replacement = takeReplacement(candidate => !candidate.retrospective);
                        if (replacement) replaceAt(index, replacement);
                    });
            }
            while (countStrongOriginSelected() < minStrongOriginCount) {
                const replacement = takeReplacement(candidate => Number(candidate.originCueProfile?.strongCount || 0) > 0 && !candidate.retrospective);
                if (!replacement) break;
                const removable = annotatedSelected
                    .map((candidate, index) => ({ candidate, index }))
                    .filter(({ candidate }) => Number(candidate.originCueProfile?.strongCount || 0) === 0 || candidate.retrospective)
                    .sort((a, b) => {
                        const retrospectiveDiff = Number(b.candidate.retrospective) - Number(a.candidate.retrospective);
                        if (retrospectiveDiff) return retrospectiveDiff;
                        const weakCueDiff = Number(a.candidate.originCueHits.length || 0) - Number(b.candidate.originCueHits.length || 0);
                        if (weakCueDiff) return weakCueDiff;
                        const leakDiff = Number(b.candidate.leak) - Number(a.candidate.leak);
                        if (leakDiff) return leakDiff;
                        const exactDiff = Number(a.candidate.exactBackfill) - Number(b.candidate.exactBackfill);
                        if (exactDiff) return exactDiff;
                        return Number(a.candidate.item?.finalScore || 0) - Number(b.candidate.item?.finalScore || 0);
                    })[0];
                if (!removable) break;
                replaceAt(removable.index, replacement);
            }
            const countSceneSelected = () => annotatedSelected.reduce((acc, candidate) => acc + ((candidate.sceneHits.length > 0 || candidate.originCueHits.length > 0) ? 1 : 0), 0);
            while (countSceneSelected() < minSceneCount) {
                const replacement = takeReplacement();
                if (!replacement) break;
                const removable = annotatedSelected
                    .map((candidate, index) => ({ candidate, index }))
                    .filter(({ candidate }) => candidate.sceneHits.length === 0 && candidate.originCueHits.length === 0)
                    .sort((a, b) => {
                        const leakDiff = Number(b.candidate.leak) - Number(a.candidate.leak);
                        if (leakDiff) return leakDiff;
                        const exactDiff = Number(a.candidate.exactBackfill) - Number(b.candidate.exactBackfill);
                        if (exactDiff) return exactDiff;
                        return Number(a.candidate.item?.finalScore || 0) - Number(b.candidate.item?.finalScore || 0);
                    })[0];
                if (!removable) break;
                replaceAt(removable.index, replacement);
            }
            const strictFiltered = annotatedSelected.filter(candidate => !(candidate.leak && candidate.sceneHits.length === 0 && candidate.originCueHits.length === 0));
            let activeSet = strictFiltered.length > 0 && strictFiltered.some(candidate => candidate.sceneHits.length > 0 || candidate.originCueHits.length > 0)
                ? strictFiltered
                : annotatedSelected;
            if (strictOriginQuery) {
                const nonRetrospective = activeSet.filter(candidate => !candidate.retrospective);
                const hasStrongNonRetrospectiveOrigin = nonRetrospective.some(candidate => Number(candidate.originCueProfile?.strongCount || 0) > 0);
                if (hasStrongNonRetrospectiveOrigin && nonRetrospective.length > 0) {
                    activeSet = nonRetrospective;
                }
            }
            const orderedSet = strictOriginQuery
                ? activeSet.slice().sort((a, b) => {
                    const retrospectiveDiff = Number(a.retrospective) - Number(b.retrospective);
                    if (retrospectiveDiff) return retrospectiveDiff;
                    const strongCueDiff = Number(b.originCueProfile?.strongCount || 0) - Number(a.originCueProfile?.strongCount || 0);
                    if (strongCueDiff) return strongCueDiff;
                    const cueDiff = Number(b.originCueHits.length || 0) - Number(a.originCueHits.length || 0);
                    if (cueDiff) return cueDiff;
                    return Number(b.item?.finalScore || 0) - Number(a.item?.finalScore || 0);
                })
                : activeSet;
            return orderedSet
                .slice(0, limit)
                .map(candidate => candidate.item);
        };
        const selectRecallDiverse = (accepted = [], topK = 15, intent = {}) => {
            const limit = Math.max(1, Number(topK || 15));
            const selected = [];
            const seen = new Set();
            const arcCounts = new Map();
            const keyOf = (item) => MemoryEngine.getSafeKey(item?.entry || item) || TokenizerEngine.getSafeMapKey(JSON.stringify(item?.entry || item || {}));
            const arcOf = (item) => String(item?.payload?.arcKey || item?.meta?.arcKey || 'no_arc').trim() || 'no_arc';
            const profileCache = new Map();
            const profileOf = (item) => {
                const key = keyOf(item);
                if (profileCache.has(key)) return profileCache.get(key);
                const entry = item?.entry || item;
                const payload = item?.payload || CompactMemoryCodec.parsePayloadFromEntry(entry) || {};
                const claimKeys = new Set((Array.isArray(payload?.records) ? payload.records : [])
                    .map(record => String(record?.claim?.key || '').normalize('NFKC').toLowerCase().trim())
                    .filter(Boolean));
                const text = CompactMemoryCodec.buildRecallScoringTextFromEntry(entry, 900)
                    .normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
                const tokens = new Set((text.match(/[\p{L}\p{N}_'-]{2,}/gu) || []).slice(0, 120));
                const profile = { text, tokens, claimKeys };
                profileCache.set(key, profile);
                return profile;
            };
            const semanticSimilarity = (left, right) => {
                const a = profileOf(left);
                const b = profileOf(right);
                if (!a.text || !b.text) return 0;
                if ([...a.claimKeys].some(key => b.claimKeys.has(key))) return 1;
                const shorter = a.text.length <= b.text.length ? a.text : b.text;
                const longer = a.text.length > b.text.length ? a.text : b.text;
                const containment = shorter.length >= 48 && longer.includes(shorter) ? Math.min(0.98, shorter.length / Math.max(1, longer.length) + 0.3) : 0;
                let intersection = 0;
                for (const token of a.tokens) if (b.tokens.has(token)) intersection += 1;
                const union = a.tokens.size + b.tokens.size - intersection;
                const jaccard = union > 0 ? intersection / union : 0;
                return Math.max(containment, jaccard);
            };
            const redundancyOf = (item) => selected.reduce((max, existing) => Math.max(max, semanticSimilarity(item, existing)), 0);
            const canAdd = (item, relaxed = false) => {
                const key = keyOf(item);
                if (!key || seen.has(key)) return false;
                if (!relaxed) {
                    const arc = arcOf(item);
                    const count = arcCounts.get(arc) || 0;
                    if (arc !== 'no_arc' && count >= 2 && selected.length < Math.max(3, limit - 1)) return false;
                    const redundancy = redundancyOf(item);
                    const exactEvidence = Array.isArray(item?.exactAnchorHits) && item.exactAnchorHits.length > 0;
                    if (redundancy >= 0.86 && !exactEvidence) return false;
                }
                return true;
            };
            const add = (item, relaxed = false) => {
                if (!item || !canAdd(item, relaxed)) return false;
                const key = keyOf(item);
                seen.add(key);
                arcCounts.set(arcOf(item), (arcCounts.get(arcOf(item)) || 0) + 1);
                const entry = item.entry || item;
                entry._recallBucket = item.recallBucket || 'general';
                entry._recallIntentBonus = Number(item.intentBonus || 0);
                entry._recallIntentLabels = Array.isArray(intent.labels) ? intent.labels.slice(0, 6) : [];
                selected.push(item);
                return selected.length >= limit;
            };
            const desired = [];
            if (intent.origin) desired.push('origin');
            if (intent.transition) desired.push('transition');
            if (intent.relationship) desired.push('relationship');
            if (intent.worldRule) desired.push('world');
            if (intent.aftermath) desired.push('aftermath');
            if (intent.current) desired.push('current');
            for (const bucket of [...new Set(desired)]) {
                const item = accepted.find(candidate => candidate.recallBucket === bucket && canAdd(candidate, true));
                if (item && add(item, true)) return selected;
            }
            const maxScore = Math.max(0.0001, ...accepted.map(item => Number(item?.finalScore || 0)));
            while (selected.length < limit) {
                const ranked = accepted
                    .filter(item => canAdd(item, false))
                    .map(item => {
                        const relevance = Math.max(0, Number(item?.finalScore || 0) / maxScore);
                        const redundancy = redundancyOf(item);
                        const arcPenalty = Math.max(0, (arcCounts.get(arcOf(item)) || 0) - 0.5) * 0.035;
                        const intentReward = Math.min(0.12, Math.max(0, Number(item?.intentBonus || 0)) * 0.35);
                        return { item, mmr: (0.80 * relevance) - (0.20 * redundancy) - arcPenalty + intentReward, redundancy };
                    })
                    .sort((a, b) => b.mmr - a.mmr || Number(b.item?.finalScore || 0) - Number(a.item?.finalScore || 0));
                if (!ranked.length) break;
                const best = ranked[0];
                best.item.mmrScore = best.mmr;
                best.item.semanticRedundancy = best.redundancy;
                if (add(best.item, false)) return selected;
            }
            const minimumUsefulCount = Math.min(limit, Math.max(1, Math.min(3, accepted.length)));
            for (const item of accepted) {
                if (selected.length >= minimumUsefulCount) break;
                if (add(item, true)) return selected;
            }
            return selected.slice(0, limit);
        };
