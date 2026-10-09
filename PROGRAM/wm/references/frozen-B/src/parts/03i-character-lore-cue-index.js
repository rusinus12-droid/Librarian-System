    const CharacterLoreCueIndex = (() => {
        const COMMENT = 'lmai_character_lore_cues';
        const SCHEMA = 'libra.character_lore_cues.v1';
        const VERSION = 1;
        const MAX_CUES = 160;
        const MAX_CHUNK_CHARS = 720;
        const MAX_TEXT_CHARS = 1100;
        const MAX_SEARCH_RESULTS = 16;
        const VECTOR_CACHE_PREFIX = 'charLoreCue';
        const stringify = (value) => {
            if (value == null) return '';
            if (typeof value === 'string') return value.trim();
            if (Array.isArray(value)) return value.map(item => stringify(item)).filter(Boolean).join('\n');
            if (typeof value === 'object') {
                try { return JSON.stringify(value, null, 2); } catch (_) { return String(value || '').trim(); }
            }
            return String(value || '').trim();
        };
        const sanitize = (value = '') => String(value || '')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<GigaTrans>[\s\S]*?<\/GigaTrans>/gi, ' ')
            .replace(/<GT-CTRL\s*\/?>/gi, ' ')
            .replace(/<GT-SEP\s*\/?>/gi, ' ')
            .replace(/<[^>]{1,80}>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const clip = (value = '', max = MAX_TEXT_CHARS) => {
            const text = sanitize(value);
            const limit = Math.max(80, Number(max || MAX_TEXT_CHARS) || MAX_TEXT_CHARS);
            return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
        };
        const hash = (value = '') => {
            try { return String(TokenizerEngine.simpleHash(String(value || ''))); } catch (_) {
                let h = 0; const text = String(value || '');
                for (let i = 0; i < text.length; i++) { h = ((h << 5) - h) + text.charCodeAt(i); h |= 0; }
                return String(h);
            }
        };
        const normalizeId = (value = '') => String(value || '')
            .normalize('NFKC')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[^a-z0-9가-힣_.:-]+/g, '_')
            .slice(0, 96);
        const tokenize = (value = '') => {
            const raw = String(value || '').normalize('NFKC').toLowerCase();
            const tokens = raw.match(/[가-힣A-Za-z0-9]{2,}/g) || [];
            const blocked = new Set([
                'character','description','personality','scenario','lorebook','entry','section','사용자','응답','대화','장면','현재','기억','정보','세계관','관계','성격','외모','설정','그리고','하지만','그러나','the','and','for','with','this','that','from','into','your','name','roleplay','setting'
            ]);
            return tokens.filter(token => token.length >= 2 && !blocked.has(token)).slice(0, 220);
        };
        const tokenSet = (value = '') => new Set(tokenize(value));
        const overlapScore = (a, b) => {
            if (!a || !b || a.size === 0 || b.size === 0) return 0;
            let count = 0;
            for (const token of a) if (b.has(token)) count += 1;
            return count;
        };
        const classifyBuckets = (label = '', text = '') => {
            const raw = `${label}\n${text}`;
            const out = new Set();
            if (/(외모|성격|말투|나이|성별|남성|여성|남자|여자|학년|직업|배경|appearance|personality|speech|age|sex|gender|occupation|background|profile|identity|alias|persona|캐릭터|인물)/i.test(raw)) out.add('entity');
            if (/(관계|relationship|relation|친구|연인|가족|라이벌|동료|friend|lover|family|sibling|rival|partner|crush)/i.test(raw)) out.add('relation');
            if (/(세계관|시대|장소|학교|도시|국가|마법|레벨|상태창|초자연|기술|장르|조직|법칙|규칙|world|era|location|genre|magic|level|system|technology|organization|rule|academy|school|modern)/i.test(raw)) out.add('world');
            if (/(서사|사건|목표|갈등|떡밥|비밀|전개|arc|plot|story|narrative|goal|conflict|foreshadow|event|tension|motive)/i.test(raw)) out.add('narrative');
            if (/(문체|출력|형식|style|format|output|markdown|response|write|writing|대사체|톤|tone)/i.test(raw)) out.add('style');
            if (!out.size) out.add('entity');
            return Array.from(out);
        };
        // 한국어 조사 제거 — `10c` 의 `stripHmeKoParticle` 과 같은 규칙·같은 목록.
        //   두 사본이 갈라지면 같은 이름이 경로마다 다른 키가 된다(그게 이 결함의 원인이었다).
        //   `10c` 는 엔티티 목록 정규화에, 여기는 cue entityRefs 추출에 쓴다.
        //
        // ★ `이`/`가` 는 목록에서 제외한다 (오탐 실측 — `10c` 와 동일 규칙).
        //   '호랑이'·'지팡이'·'가위'·'소이' 처럼 `이` 로 끝나는 명사가 많아, 떼면 없는 이름을 만든다.
        //   주격 조사는 `push(value)` 경로가 정본 이름을 `raw.includes(v)` 로 찾으므로 이미 해결된다
        //   (본문에 '미르가' 가 있어도 이름 '미르' 가 그대로 잡힌다).
        const LORE_CUE_KO_PARTICLE_SUFFIXES = [
            '에게서는', '에게서', '으로는', '이라도', '에게는', '에게', '한테는', '한테', '에서는', '에는', '에서',
            '부터', '까지', '처럼', '께서는', '께서', '으로', '하고', '이다', '이며', '이랑', '랑',
            '과', '와',
            '은', '는', '에', '을', '를', '의', '도', '로', '만'
        ];
        const stripLoreCueKoParticle = (value = '') => {
            let current = String(value || '').trim();
            if (!/^[가-힣]{2,8}$/.test(current)) return current;
            for (let pass = 0; pass < 2; pass += 1) {
                let stripped = false;
                for (const suffix of LORE_CUE_KO_PARTICLE_SUFFIXES) {
                    if (current.length - suffix.length >= 2 && current.endsWith(suffix)) {
                        current = current.slice(0, -suffix.length);
                        stripped = true;
                        break;
                    }
                }
                if (!stripped) break;
            }
            return current;
        };
        const extractEntityRefs = (text = '', known = []) => {
            const raw = String(text || '');
            const refs = [];
            const push = (value) => {
                const v = stripLoreCueKoParticle(String(value || '').trim());
                if (v && raw.includes(v)) refs.push(v);
            };
            (Array.isArray(known) ? known : []).forEach(item => {
                if (typeof item === 'string') push(item);
                else if (item && typeof item === 'object') push(item.name || item.ref || item.id || item.label);
            });
            try {
                if (typeof EntityManager !== 'undefined' && EntityManager?.getEntityCache) {
                    Array.from(EntityManager.getEntityCache().values()).forEach(entity => {
                        push(entity?.name);
                        if (Array.isArray(entity?.aliases)) entity.aliases.forEach(push);
                    });
                }
            } catch (_) {}
            // 폴백 — 어절 단위로 자른 뒤 조사를 떼고 한글 덩어리만 후보로 삼는다.
            //   옛 정규식 `/[가-힣]{2,5}(?:...)?/g` 는 띄어쓰기를 무시해 '아리엘은' 을
            //   그대로 ref 로 만들었고, 그게 format() 을 거쳐 프롬프트에 나갔다
            //   (`entities=아리엘은/세라와는`). 같은 계열 결함이 CompactMemoryCodec 에서는
            //   이미 고쳐져 있었다(stripMemoryEntityParticle, 어절 분리 — 실측 정밀도 6%).
            const blocked = new Set(['사용자','응답','대화','장면','관계','세계관','내러티브','스토리','학교','교복','소녀','소년','사람','현재','최근','장기','정보','설정','그녀','그는','그리고','그러나','하지만','자신','서로']);
            const explicit = [];
            for (const chunk of raw.split(/[^가-힣A-Za-z]+/)) {
                if (!chunk) continue;
                if (/^[A-Za-z]/.test(chunk)) {
                    if (chunk.length < 2) continue;
                    explicit.push(chunk);
                    continue;
                }
                if (!/^[가-힣]+$/.test(chunk)) continue;
                const stripped = stripLoreCueKoParticle(chunk) || chunk;
                if (stripped.length < 2) continue;
                explicit.push(stripped);
            }
            explicit.forEach(item => {
                const v = String(item || '').trim();
                if (!v || blocked.has(v)) return;
                if (refs.length > 0 && !refs.some(name => v.includes(name) || name.includes(v))) return;
                refs.push(v);
            });
            return dedupeTextArray(refs).slice(0, 12);
        };
        const extractTags = (text = '') => {
            const raw = String(text || '');
            const rules = [
                ['세계관', /세계관|world|setting/i], ['관계', /관계|relationship|relation|friend|lover|가족|친구|연인/],
                ['외모', /외모|appearance|hair|eyes|키|눈|머리/], ['성격', /성격|personality|trait|temper|성향/],
                ['성별', /성별|남성|여성|male|female|sex|gender/], ['직업', /직업|occupation|student|학생|직원|staff/],
                ['말투', /말투|speech|voice|tone|말버릇/], ['장르', /장르|genre/],
                ['규칙', /규칙|rule|forbidden|금지|법칙|system|level|magic/], ['서사', /서사|narrative|arc|plot|conflict|갈등|목표|떡밥/]
            ];
            return rules.filter(([, pattern]) => pattern.test(raw)).map(([tag]) => tag).slice(0, 10);
        };
        const splitChunks = (text = '', maxChars = MAX_CHUNK_CHARS) => {
            const clean = sanitize(text);
            if (!clean) return [];
            const paras = clean.split(/\n{2,}|(?<=다\.|요\.|죠\.|함\.|음\.)\s+/).map(p => p.trim()).filter(Boolean);
            const chunks = [];
            let buf = '';
            for (const para of paras.length ? paras : [clean]) {
                if ((buf + ' ' + para).trim().length > maxChars && buf) {
                    chunks.push(buf.trim());
                    buf = para;
                } else {
                    buf = `${buf} ${para}`.trim();
                }
                while (buf.length > maxChars * 1.4) {
                    chunks.push(buf.slice(0, maxChars).trim());
                    buf = buf.slice(maxChars).trim();
                }
            }
            if (buf) chunks.push(buf.trim());
            return chunks.slice(0, 8);
        };
        const collectNonLibraLoreEntries = (targetChar = null, targetChat = null, resolvedCharacterLore = null) => {
            const unpack = (value) => {
                try {
                    if (Array.isArray(value)) return (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) ? LibraLoreConsolidator.unpack(value) : value;
                    if (value && typeof value === 'object') {
                        if (Array.isArray(value.entries)) return unpack(value.entries);
                        if (Array.isArray(value.lorebook)) return unpack(value.lorebook);
                        if (Array.isArray(value.lore)) return unpack(value.lore);
                        if (Array.isArray(value.globalLore)) return unpack(value.globalLore);
                    }
                } catch (error) {
                    recordSuppressedRuntimeError('lore.collect_non_libra_lore_entries', error, {
                        stage: 'lore-collect'
                    });
                }
                return [];
            };
            const characterLore = Array.isArray(resolvedCharacterLore)
                ? resolvedCharacterLore
                : [
                    ...unpack(targetChar?.lorebook), ...unpack(targetChar?.lore), ...unpack(targetChar?.characterLore), ...unpack(targetChar?.rawCharacterLore), ...unpack(targetChar?.globalLore),
                    ...unpack(targetChar?.data), ...unpack(targetChar?.data?.lorebook), ...unpack(targetChar?.data?.lore), ...unpack(targetChar?.data?.globalLore)
                ];
            const all = [
                ...characterLore,
                ...unpack(targetChat?.localLore), ...unpack(targetChat?.lorebook), ...unpack(targetChat?.lore)
            ];
            const seen = new Set();
            return all.filter(entry => {
                if (!entry || typeof entry !== 'object') return false;
                if (String(entry.comment || '').startsWith('lmai_')) return false;
                const sig = `${entry.comment || ''}::${entry.key || ''}::${hash(entry.content || '')}`;
                if (seen.has(sig)) return false;
                seen.add(sig);
                return true;
            }).slice(0, 120);
        };
        const collectSources = (targetChar = null, targetChat = null, resolvedCharacterLore = null) => {
            const sources = [];
            const push = (sourceType, sourceId, label, value, priority = 5) => {
                const text = sanitize(stringify(value));
                if (!text) return;
                sources.push({ sourceType, sourceId: String(sourceId || label || sourceType), label: String(label || sourceType), text, priority });
            };
            if (targetChar && typeof targetChar === 'object') {
                push('character_card', 'name', 'Character Name', targetChar.name || targetChar.displayName, 10);
                push('character_card', 'description', 'Character Description', targetChar.description || targetChar.desc || targetChar.detail || targetChar.details, 9);
                push('character_card', 'personality', 'Character Personality', targetChar.personality || targetChar.persona || targetChar.traits, 8);
                push('character_card', 'scenario', 'Scenario', targetChar.scenario || targetChar.situation || targetChar.context, 5);
                push('character_card', 'first_message', 'First Message', targetChar.firstMessage || targetChar.first_message || targetChar.greeting, 4);
                push('character_card', 'creator_notes', 'Creator Notes', targetChar.creatorNotes || targetChar.creator_notes || targetChar.note || targetChar.notes, 4);
                push('character_card', 'default_variables', 'Default Variables', targetChar.defaultVariables, 4);
            }
            collectNonLibraLoreEntries(targetChar, targetChat, resolvedCharacterLore).forEach((entry, index) => {
                const label = [entry?.key, entry?.secondkey, entry?.comment].map(v => String(v || '').trim()).filter(Boolean).join(' / ') || `Lorebook Entry ${index + 1}`;
                const text = [label, stringify(entry?.content || '')].filter(Boolean).join('\n');
                push('character_lorebook', entry?.id || entry?.key || entry?.comment || `entry_${index + 1}`, `Character Lorebook: ${label}`, text, 6);
            });
            return sources;
        };
        const buildPayload = (targetChar = null, targetChat = null, options = {}) => {
            const known = options.entityRefs || options.knownEntityNames || [];
            const cues = [];
            const seen = new Set();
            let cbsSnapshot = null;
            try {
                if (typeof getCbsResolvedCharacterLoreSnapshot === 'function') {
                    cbsSnapshot = getCbsResolvedCharacterLoreSnapshot({ char: targetChar, chat: targetChat });
                }
            } catch (_) {
                cbsSnapshot = null;
            }
            // This build is synchronous: metadata and source rows share the same
            // freshly validated snapshot, without a second full source scan/clone.
            collectSources(targetChar, targetChat, cbsSnapshot?.entries).forEach((source) => {
                splitChunks(source.text, options.chunkChars || MAX_CHUNK_CHARS).forEach((chunk, index) => {
                    const text = clip(chunk, MAX_TEXT_CHARS);
                    if (!text) return;
                    const sourceHash = hash(`${source.sourceType}\n${source.sourceId}\n${text}`);
                    if (seen.has(sourceHash)) return;
                    seen.add(sourceHash);
                    const buckets = classifyBuckets(source.label, text);
                    const cue = {
                        id: `cue_${hash(`${source.sourceType}:${source.sourceId}:${index}:${sourceHash}`)}`,
                        sourceType: source.sourceType,
                        sourceId: String(source.sourceId || '').trim(),
                        sourceLabel: source.label,
                        chunkIndex: index,
                        buckets,
                        entityRefs: extractEntityRefs(text, known),
                        tags: extractTags(`${source.label}\n${text}`),
                        text,
                        sourceHash,
                        priority: Number(source.priority || 5),
                        updatedAt: Date.now()
                    };
                    cues.push(cue);
                });
            });
            const sorted = cues
                .sort((a, b) => (b.priority - a.priority) || String(a.sourceLabel || '').localeCompare(String(b.sourceLabel || '')))
                .slice(0, Math.max(20, Math.min(MAX_CUES, Number(options.maxCues || MAX_CUES) || MAX_CUES)));
            const sourceHash = hash(sorted.map(cue => `${cue.sourceHash}:${cue.buckets.join(',')}`).join('|'));
            return {
                schema: SCHEMA,
                version: VERSION,
                sourceHash,
                cueCount: sorted.length,
                vectorPolicy: {
                    storage: 'runtime_cache_only',
                    persistedVectors: false,
                    fallback: 'sparse_entity_tag_bucket_search'
                },
                cbsCharacterLorePreResolved: Array.isArray(cbsSnapshot?.entries),
                cbsCharacterLoreMacroCount: Number(cbsSnapshot?.macroCount || 0),
                cbsCharacterLoreSignature: String(cbsSnapshot?.signature || ''),
                updatedAt: Date.now(),
                cues: sorted
            };
        };
        const buildLoreEntry = (targetChar = null, targetChat = null, options = {}) => {
            const payload = buildPayload(targetChar, targetChat, options);
            if (!payload.cues.length) return { entry: null, payload, changed: false };
            const entry = {
                key: `lmai_character_lore_cues::${payload.sourceHash}`,
                comment: COMMENT,
                content: JSON.stringify(payload),
                mode: 'normal',
                insertorder: 2,
                alwaysActive: false
            };
            return { entry, payload, changed: true };
        };
        const parsePayload = (entryOrContent = null) => {
            try {
                const content = typeof entryOrContent === 'string' ? entryOrContent : entryOrContent?.content;
                const parsed = JSON.parse(String(content || '').trim());
                if (parsed && parsed.schema === SCHEMA && Array.isArray(parsed.cues)) return parsed;
            } catch (_) {}
            return null;
        };
        const findPayloadInLore = (lore = []) => {
            const list = Array.isArray(lore) ? lore : [];
            for (const entry of list) {
                if (String(entry?.comment || '') !== COMMENT) continue;
                const payload = parsePayload(entry);
                if (payload) return payload;
            }
            return null;
        };
        const getPayload = (targetChar = null, targetChat = null, options = {}) => {
            // Persisted cues are derived hints, not authority for native sources.
            // Reconcile the complete current projection (not its short hash) so
            // edits, deletions, copied scopes and forged cue text cannot survive.
            const current = buildPayload(targetChar, targetChat, options);
            const sourceProjection = payload => JSON.stringify({
                ...payload,
                updatedAt: 0,
                cues: payload.cues.map(cue => ({ ...cue, updatedAt: 0 }))
            });
            try {
                const localLore = Array.isArray(targetChat?.localLore)
                    ? ((typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) ? LibraLoreConsolidator.unpack(targetChat.localLore) : targetChat.localLore)
                    : [];
                const existing = findPayloadInLore(localLore);
                if (existing && !options.forceRebuild && sourceProjection(existing) === sourceProjection(current)) return existing;
            } catch (_) {}
            return current;
        };
        const ensureLocalLoreEntry = (targetChar = null, targetChat = null, options = {}) => {
            if (!targetChat || typeof targetChat !== 'object') return { changed: false, reason: 'missing_chat', cueCount: 0 };
            const currentLore = Array.isArray(targetChat.localLore) ? targetChat.localLore : [];
            const unpacked = (typeof LibraLoreConsolidator !== 'undefined' && LibraLoreConsolidator?.unpack) ? LibraLoreConsolidator.unpack(currentLore) : currentLore.slice();
            const built = buildLoreEntry(targetChar, { ...targetChat, localLore: unpacked.filter(e => String(e?.comment || '') !== COMMENT) }, options);
            const without = unpacked.filter(entry => String(entry?.comment || '') !== COMMENT);
            const existing = unpacked.find(entry => String(entry?.comment || '') === COMMENT);
            const existingHash = parsePayload(existing)?.sourceHash || '';
            const nextHash = built.payload?.sourceHash || '';
            if (!built.entry) {
                if (existing) {
                    targetChat.localLore = without;
                    return { changed: true, reason: 'removed_empty_index', cueCount: 0 };
                }
                return { changed: false, reason: 'empty_index', cueCount: 0 };
            }
            const changed = !existing || existingHash !== nextHash || String(existing?.content || '') !== String(built.entry.content || '');
            if (changed) targetChat.localLore = [...without, built.entry];
            return { changed, reason: changed ? 'updated' : 'unchanged', cueCount: built.payload.cueCount, sourceHash: built.payload.sourceHash };
        };
        const getVectorCache = () => {
            if (!MemoryState.characterLoreEmbeddingCache) MemoryState.characterLoreEmbeddingCache = new Map();
            return MemoryState.characterLoreEmbeddingCache;
        };
        const vectorKey = (cue) => `${VECTOR_CACHE_PREFIX}:${cue?.sourceHash || cue?.id || ''}`;
        const queryVectorKey = (query = '') => `${VECTOR_CACHE_PREFIX}:query:${hash(String(query || '').slice(0, 4000))}`;
        const refreshEmbeddingCache = async (targetChar = null, targetChat = null, options = {}) => {
            let cbsPreResolveMeta = null;
            try {
                if (MemoryEngine.CONFIG?.cbsEnabled !== false && typeof CharacterLoreCbsPreResolver !== 'undefined' && CharacterLoreCbsPreResolver?.resolve) {
                    cbsPreResolveMeta = await CharacterLoreCbsPreResolver.resolve({ char: targetChar, chat: targetChat, mode: 'embedding' });
                }
            } catch (error) {
                recordSuppressedRuntimeError('character_lore_cue_index.cbs_preresolve', error, { stage: 'refresh-embedding-cache' });
            }
            const payload = getPayload(targetChar, targetChat, { ...options, forceRebuild: true });
            const cache = getVectorCache();
            const engine = (() => { try { return MemoryEngine?.EmbeddingEngine || null; } catch (_) { return null; } })();
            if (!engine?.getEmbedding) return { ok: false, reason: 'embedding_engine_unavailable', cueCount: payload.cueCount || 0, embedded: 0, cached: 0, cbsPreResolved: Array.isArray(cbsPreResolveMeta?.entries) };
            let embedded = 0;
            let cached = 0;
            const limit = Math.max(1, Math.min(80, Number(options.limit || payload.cues.length || 0) || payload.cues.length || 0));
            for (const cue of payload.cues.slice(0, limit)) {
                const key = vectorKey(cue);
                const existing = cache.get(key);
                if (existing?.sourceHash === cue.sourceHash && Array.isArray(existing.vector)) { cached += 1; continue; }
                const vector = await engine.getEmbedding(cue.text);
                if (Array.isArray(vector) && vector.length) {
                    cache.set(key, { sourceHash: cue.sourceHash, vector, cueId: cue.id, updatedAt: Date.now() });
                    ResourceGovernor.enforceMapBudget(cache, 'character-lore-vector', 192, 24 * 1024 * 1024);
                    embedded += 1;
                }
            }
            const scope = String(MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global');
            MemoryState.characterLoreIndexStatusByScope?.set?.(scope, { ok: true, cueCount: payload.cueCount || 0, embedded, cached, updatedAt: Date.now(), sourceHash: payload.sourceHash || '', cbsPreResolved: Array.isArray(cbsPreResolveMeta?.entries), cbsMacroCount: Number(cbsPreResolveMeta?.macroCount || 0) });
            return { ok: true, cueCount: payload.cueCount || 0, embedded, cached, sourceHash: payload.sourceHash || '', cbsPreResolved: Array.isArray(cbsPreResolveMeta?.entries), cbsMacroCount: Number(cbsPreResolveMeta?.macroCount || 0) };
        };
        const cueSparseScore = (cue, queryTokens, queryLower = '', buckets = []) => {
            const text = `${cue.sourceLabel || ''}\n${cue.text || ''}\n${(cue.tags || []).join(' ')}\n${(cue.entityRefs || []).join(' ')}`;
            let score = Number(cue.priority || 5) * 0.25 + overlapScore(queryTokens, tokenSet(text)) * 1.35;
            const requestedBuckets = new Set((Array.isArray(buckets) ? buckets : []).map(v => String(v || '').toLowerCase()).filter(Boolean));
            const cueBuckets = new Set((Array.isArray(cue.buckets) ? cue.buckets : []).map(v => String(v || '').toLowerCase()));
            if (requestedBuckets.size) {
                let hit = false;
                for (const b of requestedBuckets) if (cueBuckets.has(b)) hit = true;
                score += hit ? 4.0 : -2.0;
            }
            (cue.entityRefs || []).forEach(ref => { if (queryLower.includes(String(ref || '').toLowerCase())) score += 3.5; });
            (cue.tags || []).forEach(tag => { if (queryLower.includes(String(tag || '').toLowerCase())) score += 1.8; });
            return score;
        };
        const search = async (targetChar = null, targetChat = null, query = '', options = {}) => {
            let cbsPreResolveMeta = null;
            try {
                if (options.cbsPreResolve !== false && MemoryEngine.CONFIG?.cbsEnabled !== false && typeof CharacterLoreCbsPreResolver !== 'undefined' && CharacterLoreCbsPreResolver?.resolve) {
                    cbsPreResolveMeta = await CharacterLoreCbsPreResolver.resolve({ char: targetChar, chat: targetChat, mode: 'search' });
                }
            } catch (error) {
                recordSuppressedRuntimeError('character_lore_cue_index.search_cbs_preresolve', error, { stage: 'search' });
            }
            const payload = getPayload(targetChar, targetChat, {
                ...options,
                forceRebuild: options.forceRebuild === true || Array.isArray(cbsPreResolveMeta?.entries)
            });
            const requestedLimit = Number(options.limit ?? 8);
            const limit = Math.max(0, Math.min(MAX_SEARCH_RESULTS, Number.isFinite(requestedLimit) ? requestedLimit : 8));
            if (!limit || !payload?.cues?.length) return { count: 0, items: [], sourceHash: payload?.sourceHash || '', vectorUsed: false, cbsPreResolved: Array.isArray(cbsPreResolveMeta?.entries) };
            const queryText = String(query || '').trim();
            const queryTokens = tokenSet(queryText);
            const queryLower = queryText.toLowerCase();
            const buckets = Array.isArray(options.buckets) ? options.buckets : [];
            const cache = getVectorCache();
            const engine = (() => { try { return MemoryEngine?.EmbeddingEngine || null; } catch (_) { return null; } })();
            let queryVector = null;
            let vectorUsed = false;
            if (options.allowQueryEmbedding === true && engine?.getEmbedding && queryText) {
                const qKey = queryVectorKey(queryText);
                const cached = cache.get(qKey);
                if (Array.isArray(cached?.vector)) queryVector = cached.vector;
                else {
                    queryVector = await engine.getEmbedding(queryText);
                    if (Array.isArray(queryVector) && queryVector.length) cache.set(qKey, { vector: queryVector, updatedAt: Date.now() });
                }
            }
            const preScored = payload.cues.map((cue) => ({
                cue,
                sparseScore: cueSparseScore(cue, queryTokens, queryLower, buckets)
            }));
            if (queryVector && engine?.getEmbedding && engine?.cosineSimilarity) {
                const candidateLimit = Math.max(limit, Math.min(48, Number(options.embeddingCandidateLimit || 32) || 32));
                const candidates = [];
                const seen = new Set();
                const addCandidate = (item) => {
                    if (!item?.cue?.id || seen.has(item.cue.id)) return;
                    seen.add(item.cue.id);
                    candidates.push(item);
                };
                preScored
                    .filter(item => item.sparseScore > 0)
                    .sort((a, b) => (b.sparseScore - a.sparseScore) || (Number(b.cue.priority || 0) - Number(a.cue.priority || 0)))
                    .slice(0, candidateLimit)
                    .forEach(addCandidate);
                if (candidates.length < candidateLimit) {
                    preScored
                        .sort((a, b) => (Number(b.cue.priority || 0) - Number(a.cue.priority || 0)) || String(a.cue.sourceLabel || '').localeCompare(String(b.cue.sourceLabel || '')))
                        .slice(0, candidateLimit)
                        .forEach(addCandidate);
                }
                for (const item of candidates.slice(0, candidateLimit)) {
                    const key = vectorKey(item.cue);
                    const existing = cache.get(key);
                    if (existing?.sourceHash === item.cue.sourceHash && Array.isArray(existing.vector)) continue;
                    try {
                        const vector = await engine.getEmbedding(item.cue.text);
                        if (Array.isArray(vector) && vector.length) {
                            cache.set(key, { sourceHash: item.cue.sourceHash, vector, cueId: item.cue.id, updatedAt: Date.now() });
                        }
                    } catch (error) {
                        recordSuppressedRuntimeError('character_lore_cue_index.embed_candidate', error, { cueId: item.cue.id || '' });
                    }
                }
            }
            const scored = preScored.map(({ cue, sparseScore }) => {
                let score = sparseScore;
                let vectorScore = 0;
                if (queryVector && engine?.cosineSimilarity) {
                    const cached = cache.get(vectorKey(cue));
                    if (Array.isArray(cached?.vector) && cached.vector.length === queryVector.length) {
                        vectorScore = Math.max(0, engine.cosineSimilarity(queryVector, cached.vector));
                        score += vectorScore * 7.0;
                        vectorUsed = true;
                    }
                }
                return { ...cue, score: Number(score.toFixed(3)), vectorScore: Number(vectorScore.toFixed(3)) };
            })
                .filter(cue => cue.score > 0)
                .sort((a, b) => (b.score - a.score) || (b.vectorScore - a.vectorScore) || String(a.sourceLabel || '').localeCompare(String(b.sourceLabel || '')))
                .slice(0, limit);
            return { count: scored.length, items: scored, sourceHash: payload.sourceHash || '', vectorUsed, cbsPreResolved: Array.isArray(cbsPreResolveMeta?.entries), cbsMacroCount: Number(cbsPreResolveMeta?.macroCount || payload?.cbsCharacterLoreMacroCount || 0) };
        };
        const format = (items = [], options = {}) => {
            const list = (Array.isArray(items) ? items : []).filter(item => item && String(item.text || '').trim());
            if (!list.length) return '';
            const title = String(options.title || 'Retrieved Character/Lorebook Cues').trim();
            const policy = String(options.policy || 'Lower-priority retrieved cues from character description/lorebook cue index. Use only when they clarify stable facts. Current user/assistant turn, manual corrections, and stored LIBRA data outrank these cues.').trim();
            const lines = [`[${title}]`, policy];
            list.forEach(item => {
                const bits = [];
                if (Array.isArray(item.buckets) && item.buckets.length) bits.push(`bucket=${item.buckets.join('/')}`);
                if (Array.isArray(item.entityRefs) && item.entityRefs.length) bits.push(`entities=${item.entityRefs.slice(0, 5).join('/')}`);
                if (Number.isFinite(Number(item.vectorScore)) && Number(item.vectorScore) > 0) bits.push(`v=${Number(item.vectorScore).toFixed(2)}`);
                lines.push(`- [${item.sourceLabel || item.sourceType || 'cue'}${bits.length ? '; ' + bits.join(', ') : ''}] ${clip(item.text, Number(options.itemChars || 520) || 520)}`);
            });
            return truncateForLLM(lines.join('\n'), Math.max(800, Number(options.maxChars || 3200) || 3200), '\n...[TRUNCATED CHARACTER LORE CUES]...\n');
        };
        const getStatus = (targetChar = null, targetChat = null) => {
            const payload = getPayload(targetChar, targetChat, {});
            const cache = getVectorCache();
            const embedded = (payload.cues || []).filter(cue => Array.isArray(cache.get(vectorKey(cue))?.vector)).length;
            return { ok: true, cueCount: payload.cueCount || 0, embedded, sourceHash: payload.sourceHash || '', persistedVectors: false, comment: COMMENT };
        };
        return Object.freeze({ COMMENT, SCHEMA, buildPayload, buildLoreEntry, ensureLocalLoreEntry, parsePayload, findPayloadInLore, search, format, refreshEmbeddingCache, getStatus });
    })();
