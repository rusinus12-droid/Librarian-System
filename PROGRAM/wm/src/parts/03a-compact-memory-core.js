    const CompactMemoryCodec = (() => {
        const SCHEMA = 'libra.memory.compact_turn.v1';
        const VERSION = 1;
        const LEDGER_SCHEMA = 'libra.memory.turn_ledger.v2';
        const LEDGER_VERSION = 2;
        const BUNDLE_SCHEMA = 'libra.memory.turn_bundle.v3';
        const RECORD_SCHEMA = 'libra.memory.record.v3';
        const BUNDLE_VERSION = 3;
        const MAX_SUMMARY_CHARS = 420;
        const MAX_ANCHORS = 3;
        const MAX_SNIPPETS = 8;
        const MAX_SNIPPET_CHARS = 260;
        const MAX_TAGS = 10;
        const MAX_RECALL_KEYWORDS = 24;
        const MAX_ENTITIES = 12;
        const LEDGER_SOURCE_RETENTION = 'hash_summary_and_structured_evidence_only';
        const LEDGER_RAW_RETENTION = 'summary_and_structured_evidence';
        const clip = (value = '', max = 240) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            const limit = Math.max(20, Number(max || 0));
            return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trim()}…` : text;
        };
        const stripMeta = (content = '') => {
            const raw = String(content || '');
            const start = raw.search(/\[META:/);
            if (start >= 0) {
                const crlf = raw.indexOf(']\r\n', start);
                const lf = raw.indexOf(']\n', start);
                const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
                if (end >= 0) return raw.slice(end + (end === crlf ? 3 : 2)).trim();
            }
            return raw.replace(/\[META:\{.*?\}\]\s*/s, '').trim();
        };
        const tryParseJson = (value) => {
            try {
                const parsed = JSON.parse(String(value || '').trim());
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
            } catch (_) { return null; }
        };
        const isLegacyCompactPayload = (value) => value && typeof value === 'object' && String(value.schema || '') === SCHEMA;
        const isLedgerPayload = (value) => value && typeof value === 'object'
            && [LEDGER_SCHEMA, BUNDLE_SCHEMA].includes(String(value.schema || ''));
        const isV3BundlePayload = (value) => value && typeof value === 'object' && String(value.schema || '') === BUNDLE_SCHEMA;
        const isCompactPayload = (value) => isLegacyCompactPayload(value) || isLedgerPayload(value);
        const parsePayloadFromContent = (content = '') => {
            const body = stripMeta(content);
            const parsed = tryParseJson(body);
            return isCompactPayload(parsed) ? parsed : null;
        };
        const parsePayloadFromEntry = (entry = null) => parsePayloadFromContent(entry?.content || entry || '');
        const splitTagged = (content = '') => {
            const raw = Utils.getMemorySourceText(stripMeta(content));
            const tagged = Utils.splitTaggedTurn(raw);
            return {
                user: String(tagged.user || '').trim(),
                ai: String(tagged.ai || (!tagged.user && !tagged.ai ? raw : '')).trim()
            };
        };
        const splitSentences = (text = '') => String(text || '')
            .replace(/\r\n/g, '\n')
            .split(/(?<=[.!?。！？다요죠네음함임됨]|[\]\)])\s+|\n{2,}|\n(?=["“‘'가-힣A-Z0-9])/g)
            .map(item => item.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        const getDynamicKnownEntityNames = (options = {}) => {
            const names = [];
            const push = (value) => {
                const text = String(value || '').trim();
                if (text) names.push(text);
            };
            const sourceLists = [
                options.entityRefs,
                options.knownEntityNames,
                options.mentionedEntityNames
            ];
            for (const list of sourceLists) {
                if (Array.isArray(list)) list.forEach(item => {
                    if (typeof item === 'string') push(item);
                    else if (item && typeof item === 'object') push(item.name || item.ref || item.id || item.label);
                });
            }
            try {
                if (typeof EntityManager !== 'undefined' && EntityManager?.getEntityCache) {
                    Array.from(EntityManager.getEntityCache().values()).forEach(entity => {
                        push(entity?.name);
                        if (Array.isArray(entity?.aliases)) entity.aliases.forEach(push);
                    });
                }
            } catch (_) {}
            return dedupeTextArray(names)
                .filter(name => name.length >= 1 && name.length <= 80)
                .sort((a, b) => b.length - a.length)
                .slice(0, 80);
        };
        // 기억 엔트리를 가리키는 키를 `memory_hash:<hash>` 정규형으로 만든다.
        // entry.key 는 getSafeMapKey 산출물(`<hash>_<앞8>_<뒤4>`)일 수 있는데,
        // 본문이 `[META:{...` 로 시작하면 앞8자가 `[META:{"` 가 되어
        // `-1457614357_[META:{"_"}}` 같은 문자열이 된다. 같은 기억이 정상형과
        // 깨진형으로 이중 등록되어 RP-LTM sourceMemoryKeys 가 부풀었다.
        const normalizeMemorySourceKey = (entry = null, fallbackSeed = '') => {
            const raw = String(entry?.key || '').trim();
            const hashMatch = raw.match(/^(-?\d+)(?:_|$)/);
            if (hashMatch) return `memory_hash:${hashMatch[1]}`;
            if (raw && !raw.includes('[')) return raw;
            const seed = String(entry?.content || fallbackSeed || '');
            return `memory_hash:${TokenizerEngine.simpleHash(seed)}`;
        };
        const MEMORY_ENTITY_ALIAS_MAP = new Map([]);
        const COMPACT_MEMORY_ENTITY_REF_BLOCKED_EXACT = new Set([
            '사용자','응답','대화','장면','관계','메모리','원문','학교','교복','소녀','소년','사람','순간','목소리','스마트폰','연습생',
            '여성','남성','여자','남자','남자들','여자들','일행','무리','남성들','여성들',
            '세계관','내러티브','스토리','사건','감정','공간','시간','후처리','요약','기억','데이터','후보','분석','현재','최근','장기','정보',
            '그녀','그는','그때','그저','이제','아무','정말','하지만','그리고','그러나','자신','서로','누군가','어딘가','무언가','우리',
            '오빠','언니','누나','형','엄마','아빠','아까','데뷔하기','담당하','너더러','되는','연예인',
            '일어나요','말하지','말도','당장','머리','마요','하지','지금','없는','있어요','있나요','합니다','했어요',
            '때문','때문이','같은','자랑','말고','핸드북','핸드북에','몰골','몰골이었','데려가서','옆','옆에','지방',
            '국어','역사','체육','수학','보건','문학','영어','과학','사회','음악','미술','안무','상담','보건실','상담실','유치원','커플',
            '감독','원장','사감','사장','로드','교생','교생인',
            '지나가던','완벽한','다른','도는','먹다','읽는','진행하','생들이나','했다','있었다','없었다','않았다','시작했다','지키기','물었다','어머','될지','되었다',
            '구조','구조와','평가','총평','총괄','심리','핵심','현실감','공감','포인트','테마','서사','흐름','이야기','전체','장대한','드라마틱','순환','결핍','치유','성장','용서','자아','존중'
        ]);
        const normalizeMemoryEntityAliasKey = (value = '') => String(value || '')
            .trim()
            .toLowerCase()
            .replace(/['’]s$/i, '')
            .replace(/[^a-z0-9가-힣]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const stripMemoryEntityParticle = (value = '') => {
            const raw = String(value || '').trim();
            if (!/^[가-힣]{2,8}$/.test(raw)) return raw;
            const suffixes = [
                '에게서는', '에게서', '으로는', '이라도', '에게는', '에게', '한테는', '한테', '에서는', '에는', '에서', '부터', '까지', '처럼',
                '께서는', '께서', '으로', '하고', '이다', '이며', '이랑', '랑', '은', '는', '이',
                '에',
                '가', '을', '를', '의', '도', '로', '만'
            ];
            for (const suffix of suffixes) {
                if (raw.length - suffix.length >= 2 && raw.endsWith(suffix)) {
                    return raw.slice(0, -suffix.length);
                }
            }
            return raw;
        };
        const isBlockedCompactMemoryEntityRef = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return true;
            const normalized = stripMemoryEntityParticle(raw)
                .toLowerCase()
                .replace(/[()[\]{}"'`]/g, '')
                .trim();
            if (!normalized) return true;
            if (COMPACT_MEMORY_ENTITY_REF_BLOCKED_EXACT.has(normalized)) return true;
            if (/^(그녀|그는|그때|그저|이제|아무|정말|하지만|그리고|그러나|자신|서로|누군가|어딘가|무언가)$/i.test(normalized)) return true;
            // 어미·품사 기반 차단. 열거식 목록은 무한히 새는 반면
            // ('휘둘렀지','가볍게','날려','피했다' …), 한국어는 어미로 품사를 가른다.
            // 실측: 열거식만으로는 엔티티 추출 정밀도 6% (정탐 3 : 오탐 44).
            if (/(?:했다|되었다|됐다|였다|이었다|한다|된다|이다|있다|없다|같다|싶다|보다|주다|받다|오다|가다)$/.test(normalized)) return true;   // 서술어 활용형
            if (/(?:했|됐|였|졌|렸|겼|켰|쳤|났|몰|렀|섰|섰|았|었|였|겠|하겠|하리|하던|하러|하려|하고|하며|해서|하지|해야|하듯)$/.test(normalized)) return true; // 동사 어간+어미
            if (/(?:지|게|도|만|서|며|고|나|면|야|라|네|데|요|음|임)$/.test(normalized) && normalized.length <= 4 && !/[A-Z]/.test(raw)) {
                // 3~4자 짧은 한글 토큰이 조사·어미로 끝나면 명사일 확률이 낮다.
                // 단, '도현'(2자) 같은 2자 고유명사는 위 stripMemoryEntityParticle 단계에서
                // 이미 조사가 제거되어 여기 도달하지 않는다.
                if (normalized.length >= 3) return true;
            }
            if (/(?:에서|으로|부터|까지|처럼|보다|마다|라도|이랑|한테|에게|께서|보다는|으로서)$/.test(normalized)) return true; // 부사·조사구
            if (/^(?:매우|아주|정말|너무|가장|조금|약간|잠시|잠깐|다시|또|이미|아직|모두|각각|서로|함께|혼자|먼저|나중|곧|방금|막|꽤|상당히|거의|전혀|결코)$/.test(normalized)) return true; // 부사
            if (/^(?:선생님|교사|담임|교생|매니저|원장|사장|감독)(?:인)?$/i.test(normalized)) return true;
            return false;
        };
        const normalizeMemoryEntityRefCandidate = (value = '', knownNames = []) => {
            let candidate = String(value || '')
                .replace(/['’]s$/i, '')
                .replace(/^[^A-Za-z가-힣]+|[^A-Za-z가-힣]+$/g, '')
                .trim();
            if (!candidate) return '';
            const aliasDirect = MEMORY_ENTITY_ALIAS_MAP.get(normalizeMemoryEntityAliasKey(candidate));
            if (aliasDirect) candidate = aliasDirect;
            candidate = stripMemoryEntityParticle(candidate)
                .replace(/^[^A-Za-z가-힣]+|[^A-Za-z가-힣]+$/g, '')
                .trim();
            if (!candidate) return '';
            if (isBlockedCompactMemoryEntityRef(candidate)) return '';
            let canonicalFallback = null;
            try {
                if (typeof EntityManager !== 'undefined' && EntityManager?.resolveCanonicalName && EntityManager?.getEntityCache) {
                    const canonical = String(EntityManager.resolveCanonicalName(candidate) || '').trim();
                    const cache = EntityManager.getEntityCache();
                    if (canonical && cache?.has?.(canonical)) {
                        const canonicalName = String(cache.get(canonical)?.name || canonical).trim();
                        if (canonicalName && !isBlockedCompactMemoryEntityRef(canonicalName)) return canonicalName;
                    }
                    canonicalFallback = canonical;
                }
            } catch (_) {}
            const exactKnown = knownNames.find(name => String(name || '').trim() === candidate);
            if (exactKnown && !isBlockedCompactMemoryEntityRef(exactKnown)) return exactKnown;
            const containingKnown = knownNames
                .map(name => String(name || '').trim())
                .filter(Boolean)
                .filter(name => candidate.includes(name));
            if (containingKnown.length > 0) {
                const best = containingKnown.sort((a, b) => b.length - a.length)[0];
                return isBlockedCompactMemoryEntityRef(best) ? '' : best;
            }
            // 역방향(superKnown) 매칭은 금지한다. candidate='도현'(조사 제거 완료)에 대해
            // known 에 '도현이'(조사 미제거 오염)가 있으면 더 긴 쪽을 골라 '도현이'를 되돌려
            // 조사 제거를 무효화하고, 그 오염이 다시 known 으로 축적되는 자가 오염 루프를 만든다.
            // 실측: 엔티티 캐시가 빈 상태에서 정밀도 6% (정탐 3 : 오탐 44),
            //       known 이 있어도 '도현이'/'마수가' 가 그대로 저장됐다.
            // 더 긴 문자열이 더 정확한 이름이라는 보장이 없으므로 확장 방향 매칭만 신뢰한다.
            try {
                if (typeof EntityManager !== 'undefined' && EntityManager?.normalizeName) {
                    const normalized = canonicalFallback !== null ? canonicalFallback : EntityManager.normalizeName(candidate);
                    if (String(normalized || '').trim() && !isBlockedCompactMemoryEntityRef(normalized)) return String(normalized || '').trim();
                }
            } catch (_) {}
            if (isBlockedCompactMemoryEntityRef(candidate)) return '';
            return candidate;
        };
                // 구체적 사건을 만드는 서술어. '계획을 확인했다' 같은 진행·정리 동사는
        // 사건이 아니라 장면 유지 문장이므로 GENERIC_SCENE_PATTERN 에 둔다.
        const CONCRETE_EVENT_PATTERN = /(죽|사망|부상|입었|베였|맞았|잃었|얻었|발견|폭로|드러났|들켰|고백|고했|선언|체결|파기|해제|봉인|파괴|소멸|도착|떠났|이별|재회|배신|반란|체포|구출|탈출|실종|납치|계약|약속|서약|합의|결정|선택|거절|수락|합류|포기|죽였|살렸|구했|떨어졌|합격|불합격|입원|퇴원|취직|해고|전학|졸업|결혼|이혼|임신|출산|사고|교통사고|진단|수술|완치|악화)/;
        const NUMERIC_SPECIFICITY_PATTERN = /(\d+\s*(?:개|명|번|시|분|일|년|월|층|회|칸|걸음|미터|km|%)|[0-9]{1,2}시|새벽|정오|자정|반나절|사흘|이틀|모레|어제|내일)/;
        // 진행 없이 장면만 유지하는 문장 (요약에서 밀어낸다).
        const GENERIC_SCENE_PATTERN = /(말이\s*없|잠시|잠깐|고개를\s*(?:끄덕|젓)|둘러보|앉았|일어섰|걸어갔|바라보|한숨|미소|대기했|기다렸|정리했|계속되었|이어졌|넘겼|고쳐\s*쥐|숨을\s*(?:고르|들이)|다시\s*확인|확인했|점검했|살폈|정돈|정리하고|이야기했|얘기했|대화했|물었|물었다|답했다|대답했)/;

        const scoreSentence = (sentence = '', options = {}) => {
            const s = String(sentence || '');
            let score = 0;
            if (/["“”‘’']/.test(s)) score += 2;
            if (/(결정|고백|거절|갈등|약속|합류|떠남|문자|연락|사건|관계|감정|긴장|위기|선택|진심|정체|규칙|금지|이별|재회|동맹|배신|합의|오해|폭로|전환|불안)/.test(s)) score += 4;
            if (/(요청|안내|설명|도착|이동|발견|확인|대답|수락|거절|계획|목표|단서|비밀|문제|변화)/.test(s)) score += 3;
            // 구체적 사건·수치를 우대한다. 키워드 사전만으로는
            // '별핵 파편이 빛나며 북쪽을 가리켰다'(핵심) 가 '계획을 확인했다'(진행) 에 진다
            // (실측: 핵심 사건 포착 6/10, 요약 8개 중 4개가 동일).
            if (CONCRETE_EVENT_PATTERN.test(s)) score += 5;
            if (NUMERIC_SPECIFICITY_PATTERN.test(s)) score += 3;
            if (GENERIC_SCENE_PATTERN.test(s) && !CONCRETE_EVENT_PATTERN.test(s)) score -= 4;
            if (/⏱️|★📍|^🚪|🚪\s*[^:\n]{1,24}:|^§\s*(?:[월화수목금토일]|Mon|Tue|Wed|Thu|Fri|Sat|Sun)|<img\b|<GT-|<\/GigaTrans>|Chatindex|#\s*(?:Response|응답)/i.test(s)) score -= 7;
            if (/^🚪/.test(s)) score -= 3;
            const knownNames = getDynamicKnownEntityNames(options);
            if (knownNames.some(name => name && s.includes(name))) score += 2;
            if (/[가-힣A-Za-z0-9]{2,}\s*(?:은|는|이|가|에게|와|과|의)\s/.test(s)) score += 1;
            if (s.length >= 40 && s.length <= 240) score += 2;
            return score;
        };

        const extractEntityRefs = (text = '', options = {}) => {
            const raw = String(text || '');
            const names = [];
            const known = getDynamicKnownEntityNames(options);
            const strictKnownOnly = Boolean(options?.strictKnownEntityNamesOnly || options?.retrospectiveClass);
            known.forEach(name => {
                if (!name || !raw.includes(name)) return;
                // 알려진 이름도 조사 제거를 거쳐 정규화한다. 저장된 이름이 '도현이' 처럼
                // 조사가 붙은 채로 남아 있으면 그 오염이 다시 known 으로 들어가
                // 자가 오염 루프를 만든다 (실측: 엔티티가 '도현이'/'마수가' 로 저장됨).
                const base = String(name || '').trim();
                const strippedBase = stripMemoryEntityParticle(base);
                for (const variant of (strippedBase && strippedBase !== base ? [strippedBase, base] : [base])) {
                    if (!raw.includes(variant)) continue;
                    const normalized = normalizeMemoryEntityRefCandidate(variant, known);
                    if (normalized && !isBlockedCompactMemoryEntityRef(normalized)) names.push(normalized);
                    break;
                }
            });
            for (const [aliasKey, canonical] of MEMORY_ENTITY_ALIAS_MAP.entries()) {
                const escaped = aliasKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
                if (new RegExp(`\\b${escaped}(?:['’]s)?\\b`, 'i').test(raw) && !isBlockedCompactMemoryEntityRef(canonical)) names.push(canonical);
            }
            if (strictKnownOnly) return dedupeTextArray(names).slice(0, MAX_ENTITIES);
            // 어절 경계를 존중한다. /[가-힣]{2,5}/g 는 띄어쓰기를 무시하고 5자씩 잘라
            // '휘둘렀지만'을 '휘둘렀지'+'만' 으로, '가볍게'를 통째로 인물명처럼 만든다.
            // 실측: 엔티티 추출 정밀도 6% (정탐 3 : 오탐 44).
            // 어절(공백) 단위로 자른 뒤 각 어절에서 한글 덩어리만 취한다.
            // /[가-힣]{2,5}/g 로 통짜 매칭하면 띄어쓰기를 무시해 '휘둘렀지만' 같은
            // 동사 활용형이 인물명 후보가 된다 (실측 정밀도 6%).
            const wordChunks = raw
                .split(/[^가-힣A-Za-z]+/)
                .map(chunk => chunk.trim())
                .filter(Boolean);
            const matches = [];
            for (const chunk of wordChunks) {
                if (/^[A-Za-z]/.test(chunk)) {
                    // 영어는 관사·전치사·접속사를 엔티티로 삼지 않는다.
                    // 어절 단위로 뽑으면 'the','to','after' 까지 등록되어
                    // focus 가중치와 회상 순위가 오염된다 (실측: MMR 순위 역전).
                    const lower = chunk.toLowerCase();
                    if (EN_STOPWORD_RE.test(lower)) continue;
                    if (chunk.length < 2) continue;
                    matches.push(chunk);
                    continue;
                }
                if (!/^[가-힣]+$/.test(chunk)) continue;
                // 조사·어미를 떼어낸 뒤 2~5자만 후보로 삼는다.
                matches.push(stripMemoryEntityParticle(chunk) || chunk);
            }
            matches.forEach(item => {
                const v = String(item || '').trim();
                if (!v || v.length < 2 || v.length > 12) return;
                const normalized = normalizeMemoryEntityRefCandidate(v, known);
                if (!normalized || isBlockedCompactMemoryEntityRef(normalized)) return;
                if (known.length > 0 && !known.includes(normalized) && !known.some(name => normalized.includes(name) || name.includes(normalized))) return;
                names.push(normalized);
            });
            return dedupeTextArray(names).slice(0, MAX_ENTITIES);
        };
        const COMPACT_MEMORY_FAMILY_ROLE_RE = /가족|자녀|아들(?=$|[\s,.;!?'"”’)\]}]|은|는|이|가|을|를|에게|과|와|의)|딸(?=$|[\s,.;!?'"”’)\]}]|은|는|이|가|을|를|에게|과|와|의)|부부|모녀|부녀/u;
        const hasExplicitFamilyRoleMention = (text = '') => COMPACT_MEMORY_FAMILY_ROLE_RE.test(String(text || ''));
        const extractTags = (text = '') => {
            const raw = String(text || '');
            const tagRules = [
                ['사건', /사건|위험|위기|구조|도움|발견/],
                ['대화', /대화|말했|물었|답했|묻고|대답|질문/],
                ['약속', /약속|다짐|합의/],
                ['갈등', /갈등|대립|거절|긴장|오해|폭로/],
                ['진로', /진로|커리어|직업|학교|시험|취업|복귀/],
                ['세계 규칙', /세계관|규칙|마법|초자연|기술|시스템|레벨/],
                ['기억 단절', /기억(?:이)?\s*(?:안\s*나|나지|없|끊|상실)|기억\s*공백/],
                ['장소', /장소|위치|도착|이동|교실|복도|카페|병원|학교|집|방|공원|식당|역|정류장/],
                ['물건', /물건|소지품|도구|폰|휴대폰|서류|편지|가방/],
                ['관계', /관계|친구|연인|가족|동료|상대|파트너/]
            ];
            const tags = tagRules.filter(([, pattern]) => pattern.test(raw)).map(([tag]) => tag);
            if (hasExplicitFamilyRoleMention(raw)) tags.push('가족');
            return dedupeTextArray(tags).slice(0, MAX_TAGS);
        };
        const extractRecallKeywords = (text = '', tags = []) => {
            const raw = String(text || '');
            const keywordRules = [
                ['기억 단서', /기억(?:이)?\s*(?:안\s*나|나지|없|끊|상실)|기억\s*공백/],
                ['연락 단서', /연락|문자|전화|메시지|답장|읽지\s*않은/],
                ['물건 단서', /물건|소지품|도구|폰|휴대폰|서류|편지|가방/],
                ['장소 단서', /장소|위치|도착|이동/],
                ['관계 단서', /관계|친구|연인|가족|동료|상대|파트너/]
            ];
            const keywords = [
                ...(Array.isArray(tags) ? tags : []),
                ...keywordRules.filter(([, pattern]) => pattern.test(raw)).map(([keyword]) => keyword)
            ];
            return dedupeTextArray(keywords)
                .map(value => clip(value, 40))
                .filter(Boolean)
                .slice(0, MAX_RECALL_KEYWORDS);
        };
        const ledgerEntityBaseName = (value = '') => {
            const raw = String(value || '').trim();
            return raw.replace(/\([^)]*\)/g, '').trim() || raw;
        };
        const ledgerEntityMentionedInText = (entity = '', text = '') => {
            const raw = String(text || '');
            const full = String(entity || '').trim();
            const base = ledgerEntityBaseName(full);
            if (!raw || !full) return false;
            return raw.includes(full) || (base && raw.includes(base));
        };
        const ledgerRefObject = (kind = '', item = null, role = '') => {
            if (!item) return null;
            if (typeof item === 'string') {
                const label = item.trim();
                return label ? { kind: kind || 'entity', label, role: role || '' } : null;
            }
            const label = String(item.label || item.name || item.ref || item.id || '').trim();
            if (!label) return null;
            return {
                kind: kind || item.kind || (item.role === 'group' ? 'group' : 'mention'),
                ref: String(item.id || item.ref || '').trim(),
                label,
                role: role || item.subjectRole || item.role || ''
            };
        };
        const dedupeLedgerRefs = (refs = []) => {
            const seen = new Set();
            const out = [];
            for (const ref of Array.isArray(refs) ? refs : []) {
                if (!ref || typeof ref !== 'object') continue;
                const label = String(ref.label || ref.name || '').trim();
                if (!label) continue;
                const item = {
                    kind: String(ref.kind || '').trim() || 'mention',
                    ref: String(ref.ref || ref.id || '').trim(),
                    label,
                    role: String(ref.role || '').trim()
                };
                const key = `${item.kind}:${item.ref || item.label}:${item.role}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(item);
            }
            return out.slice(0, 8);
        };
        const resolveLedgerFactActors = (body = '', source = 'assistant', entityRefs = [], context = {}) => {
            const text = String(body || '');
            const entities = [];
            const subjects = [];
            const observerEntities = [];
            for (const entity of Array.isArray(entityRefs) ? entityRefs : []) {
                if (ledgerEntityMentionedInText(entity, text)) entities.push(entity);
            }
            if (source === 'assistant' && entityRefs.length > 0) {
                observerEntities.push(...entityRefs);
            }
            return {
                entities: dedupeTextArray(entities).slice(0, 8),
                subjects: dedupeLedgerRefs(subjects),
                observerEntities: dedupeTextArray(observerEntities).slice(0, 8)
            };
        };
        const LEDGER_DERIVED_TAG_BLOCKED_EXACT = new Set([
            'current', 'cause', 'trigger', 'escalation', 'result', 'write_path_adapter',
            '연애 금지', '삼각관계', '죄책감', '질투', '고백 압력', '비밀 접촉', '관계 파열',
            '재건', '관계 압력', '정서적 접근', '단둘이 식사', '떡볶이', '소속사 연애 금지',
            'family_concert_postscript', 'dating_ban_triangle_pressure', 'umbrella_confession_pressure',
            'post_rupture_apology', 'career_repair', 'childhood_triangle_setup', 'unresolved-pressure'
        ]);
        const LEDGER_DERIVED_ARC_BLOCKED_EXACT = new Set([
            'family_concert_postscript',
            'dating_ban_triangle_pressure',
            'umbrella_confession_pressure',
            'post_rupture_apology',
            'career_repair',
            'childhood_triangle_setup'
        ]);
        const LEDGER_DERIVED_RELATION_BLOCKED_RE = /정서적\s*접촉|관계\s*(?:압력|해석|파열)|공개적\s*접촉\s*제한/i;
        const LEDGER_DERIVED_CONFLICT_BLOCKED_RE = /외부\s*규칙\/연애\s*금지|소꿉친구\s*관계와\s*연인\s*관계|끌림과\s*죄책감|감춰둔\s*진심|관계\s*파열\s*이후/i;
        const KOREAN_SURNAME_SINGLE_GIVEN_RE = /^[김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민류진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제][가-힣]$/u;
        const buildLedgerEvidenceText = (payload = {}) => {
            const facts = Array.isArray(payload?.facts) ? payload.facts : [];
            const snippets = Array.isArray(payload?.directEvidenceSnippets) ? payload.directEvidenceSnippets : [];
            const anchors = Array.isArray(payload?.recallAnchors) ? payload.recallAnchors : [];
            return [
                payload?.summary,
                payload?.primaryConflict,
                payload?.relationDelta,
                ...(Array.isArray(payload?.tags) ? payload.tags : []),
                ...(Array.isArray(payload?.recallKeywords) ? payload.recallKeywords : []),
                ...facts.flatMap(item => [
                    item?.text,
                    ...(Array.isArray(item?.subjects) ? item.subjects.flatMap(ref => [ref?.label, ref?.role]) : []),
                    ...(Array.isArray(item?.observerEntities) ? item.observerEntities : []),
                    ...(Array.isArray(item?.evidence) ? item.evidence.map(ev => ev?.text || ev) : [])
                ]),
                ...snippets.map(item => typeof item === 'string' ? item : item?.text),
                ...anchors.flatMap(item => [item?.summary, item?.hint]),
                payload?.scene?.summary,
                payload?.scene?.location
            ].map(v => String(v || '').trim()).filter(Boolean).join('\n');
        };
        // 이름 뒤에 붙은 조사·어미를 이름의 일부로 오인하지 않는다.
        // '도현'은 성씨 '도' + 외자 '현' 으로도 읽혀 KOREAN_SURNAME_SINGLE_GIVEN_RE 에 걸리는데,
        // 본문에 '도현이'(주격 조사) 가 있으면 더 완전한 이름으로 착각해 '도현이' 를 만들었다.
        // 실측: 엔티티가 '도현이','마수가' 로 저장되고 그 오염이 known 으로 축적됐다.
        // 영어 기능어 — 엔티티 후보에서 제외한다.
        const EN_STOPWORD_RE = /^(?:a|an|the|and|or|but|if|then|than|so|as|at|by|for|from|in|into|of|on|onto|to|with|without|over|under|after|before|during|while|when|where|which|who|whom|whose|that|this|these|those|is|are|was|were|be|been|being|has|have|had|do|does|did|will|would|shall|should|can|could|may|might|must|not|no|yes|it|its|he|she|they|them|his|her|their|we|our|you|your|i|me|my)$/i;
        const NAME_EXTENSION_JOSA_RE = /(?:이|가|을|를|은|는|의|에|와|과|도|만|로|으로|에게|에게서|한테|께|께서|에서|부터|까지|처럼|보다|마다|라도|이랑|랑|하고|이며|이다)$/u;
        const expandTruncatedKoreanName = (name = '', evidenceText = '', knownNames = []) => {
            const value = String(name || '').trim();
            if (!KOREAN_SURNAME_SINGLE_GIVEN_RE.test(value)) return value;
            const known = (Array.isArray(knownNames) ? knownNames : [])
                .map(item => String(item || '').trim())
                .filter(item => item.length > value.length && item.startsWith(value))
                .filter(item => !NAME_EXTENSION_JOSA_RE.test(item.slice(value.length)))
                .sort((a, b) => b.length - a.length)[0];
            if (known) return known;
            const evidenceHit = (String(evidenceText || '').match(/[가-힣]{3,5}/g) || [])
                .filter(item => item.length > value.length && item.startsWith(value) && !isBlockedCompactMemoryEntityRef(item))
                .filter(item => !NAME_EXTENSION_JOSA_RE.test(item.slice(value.length)))
                .sort((a, b) => b.length - a.length)[0];
            // 확장 후보가 없으면 원래 이름을 유지한다. 빈 문자열을 반환하면 호출자가
            // 그 엔티티를 통째로 버려 정상 인물('도현')이 누락된다 (실측 누락 2건).
            return evidenceHit || value;
        };
        const sanitizeLedgerEntityList = (values = [], evidenceText = '') => {
            let knownNames = [];
            try {
                if (typeof EntityManager !== 'undefined' && EntityManager?.getEntityCache) {
                    knownNames = dedupeTextArray(Array.from(EntityManager.getEntityCache().values())
                        .map(entity => String(entity?.name || '').trim())
                        .filter(Boolean));
                }
            } catch (_) {}
            if (!knownNames.length) knownNames = getDynamicKnownEntityNames({});
            const out = [];
            for (const value of Array.isArray(values) ? values : []) {
                const raw = String(value || '').trim();
                if (!raw) continue;
                const particleStripped = stripMemoryEntityParticle(raw);
                let canonicalKnown = knownNames.find(name => normalizeMemoryEntityAliasKey(name) === normalizeMemoryEntityAliasKey(particleStripped)) || '';
                if (!canonicalKnown && knownNames.length) {
                    try {
                        const resolved = String(EntityManager?.resolveCanonicalName?.(particleStripped) || '').trim();
                        canonicalKnown = knownNames.find(name => normalizeMemoryEntityAliasKey(name) === normalizeMemoryEntityAliasKey(resolved)) || '';
                    } catch (_) {}
                }
                if (knownNames.length && !canonicalKnown) continue;
                let normalized = canonicalKnown || normalizeMemoryEntityRefCandidate(particleStripped, knownNames);
                if (!normalized || isBlockedCompactMemoryEntityRef(normalized)) continue;
                const expanded = expandTruncatedKoreanName(normalized, evidenceText, knownNames);
                if (!expanded) continue;
                normalized = expanded;
                if (isBlockedCompactMemoryEntityRef(normalized)) continue;
                out.push(normalized);
            }
            return dedupeTextArray(out).slice(0, MAX_ENTITIES);
        };
        const sanitizeLedgerTags = (tags = [], evidenceText = '', retrospectiveClass = '') => {
            const retro = normalizeRetrospectiveClass(retrospectiveClass);
            const out = [];
            for (const tag of Array.isArray(tags) ? tags : []) {
                const value = String(tag || '').trim();
                if (!value || LEDGER_DERIVED_TAG_BLOCKED_EXACT.has(value)) continue;
                if (/^(?:current|cause|trigger|escalation|result|write_path_adapter)$/i.test(value)) continue;
                if (value === '가족' && !hasExplicitFamilyRoleMention(evidenceText)) continue;
                if (value === '가족 후일담' && retro !== 'family_postscript') continue;
                if (value === '회고' && !retro) continue;
                out.push(value);
            }
            return dedupeTextArray(out).slice(0, MAX_TAGS);
        };
        const sanitizeLedgerRecallKeywords = (keywords = [], evidenceText = '') => {
            const seed = Array.isArray(keywords) ? keywords : [];
            const out = [];
            for (const keyword of seed) {
                const value = clip(keyword, 48);
                if (!value || LEDGER_DERIVED_TAG_BLOCKED_EXACT.has(value)) continue;
                out.push(value);
            }
            const derived = extractRecallKeywords(evidenceText, []);
            return dedupeTextArray([...out, ...derived]).slice(0, MAX_RECALL_KEYWORDS);
        };
        const sanitizeLedgerRefObjects = (refs = []) => dedupeLedgerRefs((Array.isArray(refs) ? refs : [])
            .map(ref => {
                if (!ref) return null;
                if (typeof ref === 'string') return ledgerRefObject('entity', ref, '');
                const label = clip(ref.label || ref.name || ref.ref || ref.id || '', 80);
                if (!label) return null;
                const kind = String(ref.kind || '').trim() || (/group/i.test(String(ref.role || '')) ? 'group' : 'mention');
                return {
                    kind,
                    ref: clip(ref.ref || ref.id || '', 100),
                    label,
                    role: clip(ref.role || '', 80)
                };
            })
            .filter(Boolean));
        const sanitizeLedgerArcKey = (arcKey = '', retrospectiveClass = '') => {
            const value = String(arcKey || '').trim();
            if (!value) return '';
            const lower = value.toLowerCase();
            if (lower === 'family_concert_postscript') {
                return normalizeRetrospectiveClass(retrospectiveClass) === 'family_postscript' ? 'family_postscript' : '';
            }
            if (LEDGER_DERIVED_ARC_BLOCKED_EXACT.has(lower)) return '';
            // arcKey 는 식별자다. 문장이 들어오면 서사 storyline 의 arcKey 가
            // 문장 전체로 오염되고, 그 값이 storyline 이름으로까지 변환된다.
            // 실측: arcKey = '아리엘은_는_초기_조사와_관련된_직접_증거를_확인하고_루멘_아카데미의_금지_규칙이_아직_유효하다고_설명했다'
            if (value.length > 60) return '';
            if (/[.!?。！？]\s|\s{2,}/.test(value)) return '';
            if ((value.match(/[_-]/g) || []).length > 6) return '';
            if (/(?:은|는|이|가|을|를|했다|한다|있었다|입니다|합니다)(?:_|$)/.test(value) && value.length > 24) return '';
            return value;
        };
        const sanitizeLedgerRelationText = (value = '', entityRefs = []) => {
            const text = clip(value || '', 240);
            if (!text) return '';
            if (LEDGER_DERIVED_RELATION_BLOCKED_RE.test(text)) return '';
            if ((Array.isArray(entityRefs) ? entityRefs : []).length < 2 && /관계|relationship|romance/i.test(text)) return '';
            return text;
        };
        const sanitizeLedgerConflictText = (value = '') => {
            const text = clip(value || '', 260);
            if (!text || LEDGER_DERIVED_CONFLICT_BLOCKED_RE.test(text)) return '';
            return text;
        };
        const normalizeRetrospectiveClass = (value = '') => {
            const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            if (normalized === 'global_recap' || normalized === 'family_postscript') return normalized;
            return '';
        };
        const detectRetrospectiveClass = (text = '', summary = '') => {
            return '';
        };
        const getRetrospectiveTags = (retrospectiveClass = '') => {
            const normalized = normalizeRetrospectiveClass(retrospectiveClass);
            if (normalized === 'family_postscript') return ['회고', '가족 후일담'];
            if (normalized === 'global_recap') return ['회고', '전체 정리'];
            return [];
        };
        const applyRetrospectiveTags = (tags = [], retrospectiveClass = '') => {
            const normalized = normalizeRetrospectiveClass(retrospectiveClass);
            if (!normalized) return dedupeTextArray(Array.isArray(tags) ? tags : []).slice(0, MAX_TAGS);
            return dedupeTextArray([...getRetrospectiveTags(normalized), ...(Array.isArray(tags) ? tags : [])]).slice(0, MAX_TAGS);
        };
        const buildRetrospectiveSummary = (summary = '', retrospectiveClass = '') => {
            const normalized = normalizeRetrospectiveClass(retrospectiveClass);
            if (!normalized) return clip(summary, MAX_SUMMARY_CHARS);
            const label = normalized === 'family_postscript'
                ? 'Retrospective family postscript:'
                : 'Retrospective overall recap:';
            const body = clip(String(summary || '').replace(/\s+/g, ' ').trim(), Math.max(24, MAX_SUMMARY_CHARS - label.length - 1));
            return clip(`${label} ${body}`.trim(), MAX_SUMMARY_CHARS);
        };
        const buildRetrospectiveAnchors = (summary = '', entityRefs = [], tags = [], retrospectiveClass = '') => {
            const normalized = normalizeRetrospectiveClass(retrospectiveClass);
            if (!normalized || !summary) return [];
            const label = normalized === 'family_postscript' ? 'family postscript recap' : 'overall recap';
            return [{
                summary: clip(summary, 180),
                hint: clip([label, ...getRetrospectiveTags(normalized), ...tags, ...entityRefs].filter(Boolean).join(' / '), 160),
                entityRefs: entityRefs.slice(0, 6),
                confidence: 0.48
            }];
        };
        const stripUserTurnSummaryText = (value = '') => {
            const raw = String(value || '').replace(/\s+/g, ' ').trim();
            if (!raw) return '';
            if (!/^User turn\s*:/i.test(raw)) return raw;
            const sceneMatch = raw.match(/\bScene result\s*:/i);
            if (sceneMatch && Number.isFinite(sceneMatch.index)) {
                return raw.slice(sceneMatch.index + sceneMatch[0].length).trim();
            }
            return '';
        };
        const isUserLedgerSource = (source = '', kind = '') => {
            const normalizedSource = String(source || '').trim().toLowerCase();
            const normalizedKind = String(kind || '').trim().toLowerCase();
            return normalizedSource === 'user' || normalizedKind === 'user_input';
        };
        const isContinuityOnlyRecallProfile = (payload = null) => {
            const retrospectiveClass = normalizeRetrospectiveClass(payload?.retrospectiveClass || payload?.hybridRow?.retrospectiveClass || payload?.hme?.retrospectiveClass || '');
            if (retrospectiveClass) return true;
            return String(payload?.recallProfile || payload?.hybridRow?.recallProfile || payload?.hme?.recallProfile || '').trim() === 'continuity_only';
        };
        const inferArcKey = (text = '') => {
            return '';
        };
        const inferArcRole = (text = '') => {
            return '';
        };
        const inferCausalRole = (text = '') => {
            return '';
        };
        const inferPrimaryConflict = (text = '', tags = []) => {
            return '';
        };
        const inferRelationDelta = (text = '', entityRefs = []) => {
            return '';
        };
        const buildSummary = (user = '', ai = '', options = {}) => {
            const sentences = splitSentences(ai);
            const narrativeRanked = sentences
                .filter(sentence => !isLedgerStatusOrControlText(sentence))
                .map(sentence => ({ sentence, score: scoreSentence(sentence, options) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 2)
                .map(item => clip(item.sentence, 180));
            const ranked = narrativeRanked.length ? narrativeRanked : sentences
                .map(sentence => ({ sentence, score: scoreSentence(sentence, options) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 2)
                .map(item => clip(item.sentence, 180));
            const parts = [];
            if (ranked.length) parts.push(`Scene result: ${ranked.join(' / ')}`);
            if (!parts.length) parts.push(clip(ai || '', MAX_SUMMARY_CHARS));
            return clip(parts.join(' '), MAX_SUMMARY_CHARS);
        };
        const buildSnippets = (user = '', ai = '', options = {}) => {
            const assistantItems = splitSentences(ai).map((sentence, index) => ({
                index,
                sentence,
                source: isLedgerStatusOrControlText(sentence) ? 'status_block' : 'assistant',
                score: scoreSentence(sentence, options)
            }));
            const rest = [...assistantItems]
                .filter(item => item.sentence && item.sentence.length >= 12)
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_SNIPPETS)
                .sort((a, b) => a.index - b.index);
            return rest
                .slice(0, MAX_SNIPPETS)
                .map(item => ({ source: item.source, text: clip(item.sentence, MAX_SNIPPET_CHARS) }));
        };
        const buildAnchors = (summary = '', snippets = [], entityRefs = [], tags = [], recallKeywords = []) => {
            const hintParts = dedupeTextArray([...(Array.isArray(tags) ? tags : []), ...(Array.isArray(recallKeywords) ? recallKeywords : []), ...entityRefs]);
            const anchors = [];
            if (summary) anchors.push({ summary: clip(summary, 180), hint: clip(hintParts.join(' / '), 180), entityRefs: entityRefs.slice(0, 6), confidence: 0.72 });
            for (const snip of snippets.slice(0, 1)) {
                anchors.push({ summary: clip(snip.text, 170), hint: clip([...hintParts.slice(0, 8), snip.source].join(' / '), 170), entityRefs: entityRefs.slice(0, 6), confidence: 0.66 });
            }
            return anchors.slice(0, MAX_ANCHORS);
        };
        const makeLedgerId = (prefix = 'item', seed = '', turn = 0, index = 0) => {
            const safeTurn = normalizeLegacyMemoryTurnAnchor(turn) || 'pending';
            const hash = String(TokenizerEngine.simpleHash(String(seed || `${prefix}:${safeTurn}:${index}`))).replace(/^-/, 'n').slice(0, 10);
            return `${prefix}.${safeTurn}.${index + 1}.${hash}`;
        };
        const classifyUserEvidence = (text = '') => {
            const raw = String(text || '').trim();
            if (/(약속|맹세|반드시|promise|swear)/i.test(raw)) return 'promise';
            if (/(선택|고르|결정|하기로|choose|decide)/i.test(raw)) return 'choice';
            if (/^["“'‘]|(?:말했|물었|대답|외쳤|속삭|say|ask|reply)/i.test(raw)) return 'dialogue';
            if (/(한다|했다|간다|갔다|잡|놓|열|닫|공격|도망|다가가|행동|action)/i.test(raw)) return 'action';
            return 'assertion';
        };
        const buildUserEvidenceRecords = (user = '', turn = 0) => {
            const source = Utils.getMemorySourceText(user || '');
            if (!source) return [];
            const seen = new Set();
            return splitSentences(source)
                .map(sentence => clip(sentence, 220))
                .filter(sentence => sentence.length >= 2 && !Utils.isForcedBypassPrompt?.(sentence))
                .filter(sentence => {
                    const key = sentence.toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .slice(0, 3)
                .map((text, index) => ({
                    id: makeLedgerId('user-evidence', text, turn || 0, index),
                    sourceRole: 'user',
                    kind: classifyUserEvidence(text),
                    text,
                    turn: normalizeLegacyMemoryTurnAnchor(turn || 0) || undefined,
                    evidenceHash: String(TokenizerEngine.simpleHash(text)),
                    epistemicStatus: 'user_asserted',
                    authority: 'evidence_only',
                    executable: false
                }));
        };
