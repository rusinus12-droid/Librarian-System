    const RPContinuityCore = (() => {
        const COMMENT = 'lmai_rp_longterm';
        const KEY = 'lmai_rp_longterm::core';
        const SCHEMA = 'libra.rp_longterm.v1';
        const TURN_SCHEMA = 'libra.rp_turn_memory.v1';
        const VERSION = 1;
        const CATEGORY_LIMITS = Object.freeze({
            stableFacts: 180,
            preferences: 120,
            commitments: 120,
            openLoops: 160,
            relationshipMilestones: 160,
            stateChanges: 140,
            callbacks: 120,
            episodes: 80
        });
        const CATEGORY_ORDER = Object.freeze([
            'stableFacts', 'preferences', 'commitments', 'openLoops',
            'relationshipMilestones', 'stateChanges', 'callbacks', 'episodes'
        ]);
        const DURABILITY_RANK = Object.freeze({ short: 0, medium: 1, long: 2, permanent: 3 });
        const ACTIVE_STATUS = new Set(['open', 'active', 'pending', 'ongoing', 'unresolved', 'promised']);
        const CLOSED_STATUS = new Set(['resolved', 'closed', 'fulfilled', 'broken', 'cancelled', 'superseded', 'inactive']);
        const GENERIC_TOKENS = new Set([
            '사용자','응답','대화','장면','현재','기억','메모리','정보','요약','관계','세계','세계관','내러티브','스토리',
            '그리고','하지만','그러나','그녀','그는','그들','이것','저것','정말','아무','자신','서로','이번','다음','방금',
            'user','assistant','response','conversation','scene','current','memory','information','summary','relationship','world','story',
            'and','but','however','this','that','they','them','really','something','someone','next','latest'
        ]);
        const MAJOR_RELATION_RE = /(고백|사귀(?:기|게|자)?|연인|애인|결혼|약혼|키스|첫키스|화해|절교|이별|헤어|재회|동맹|배신|용서|신뢰|가족이 되|친구가 되|lover|dating|date each other|married|marriage|engaged|engagement|kissed|first kiss|reconciled|breakup|broke up|reunited|alliance|betrayed|forgave|trusted)/i;
        const COMMITMENT_RE = /(약속|맹세|서약|(?:반드시|꼭)\s*.{0,24}(?:할게|하겠다|하겠어|해\s*줄게|지킬게|돌아오겠|돌아올게|기다릴게|함께할게)|다시는\s*.{0,24}(?:않|안\s)|잊지\s*않|끝까지\s*.{0,18}(?:지키|함께)|promise|swear|pledge|vow|never again|won't ever|will always|come back|return to you|wait for you|stay with you|(?:i(?:'ll| will)|we(?:'ll| will)).{0,48}(?:make sure|come back|return|wait|stay|protect|remember|never|always|keep my word))/i;
        const COMMITMENT_RESOLVED_RE = /(약속(?:을|은)?\s*(?:지켰|이행|완수)|맹세(?:를|는)?\s*(?:지켰|이행)|fulfilled\s+(?:the\s+)?promise|kept\s+(?:the|my|their|his|her)?\s*promise|promise\s+(?:was\s+)?fulfilled)/i;
        const COMMITMENT_BROKEN_RE = /(약속(?:을|은)?\s*(?:어겼|깨뜨|저버)|맹세(?:를|는)?\s*(?:어겼|저버)|broke\s+(?:the|my|their|his|her)?\s*promise|betrayed\s+(?:the\s+)?promise)/i;
        const PREFERENCE_RE = /(좋아(?:한|하|해)|싫어(?:한|하|해)|선호|취향|최애|알레르기|못\s*먹|먹지\s*못|두려워|무서워|꺼려|불편해|편안해|하지\s*마|원하지\s*않|금기|경계선|likes?|loves?|dislikes?|hates?|prefers?|favorite|favourite|allergic|cannot eat|can't eat|afraid of|fears?|uncomfortable|comfortable|do not|don't\s+want|boundary|taboo)/i;
        const STABLE_FACT_RE = /(정체|본명|진짜\s*이름|생일|나이|직업|소속|가족|부모|아버지|어머니|형제|자매|고향|출신|거주|사는\s*곳|혈액형|종족|능력|약점|비밀(?:은|이|의\s*정체)|기혼|미혼|real\s+name|true\s+identity|identity\s+is|birthday|age\s+is|works?\s+as|occupation|member\s+of|belongs?\s+to|family|father|mother|parent|sibling|brother|sister|hometown|from\s+[A-Z]|lives?\s+in|species|ability|weakness|secret\s+(?:is|identity)|actually\s+(?:is|works|lives|belongs))/i;
        const IDENTITY_RE = /(정체|본명|진짜\s*이름|종족|혈통|출생의\s*비밀|real\s+name|true\s+identity|identity|species|bloodline)/i;
        const STATE_CHANGE_RE = /(다쳤|부상|상처|골절|병원|입원|의식(?:을)?\s*잃|죽었|사망|실종|임신|체포|구금|해고|승진|퇴학|졸업|이사|전학|합류|탈퇴|떠났|도착했|귀환|변신|기억(?:을)?\s*잃|injured|wounded|hospitalized|unconscious|died|dead|killed|missing|pregnant|arrested|detained|fired|promoted|expelled|graduated|transferred\s+to|moved\s+to|joined\s+(?:the\s+)?(?:group|team|guild|party|organization|company|school)|left\s+(?:(?:the\s+)?(?:group|team|guild|party|organization|company|school|city|town|village|home|room|building)|for\s+)|departed\s+(?:from|for)|arrived\s+(?:at|in|home)|returned\s+(?:to|from|home)|transformed|lost\s+(?:his|her|their)?\s*memory)/i;
        const IRREVERSIBLE_RE = /(죽었|사망|살해|결혼|약혼|임신|출산|이별|절교|퇴학|졸업|해고|체포|영구|불구|died|dead|killed|married|engaged|pregnant|gave birth|breakup|expelled|graduated|fired|arrested|permanent)/i;
        const OPEN_LOOP_RE = /(해야\s*(?:해|한다|돼|된다)|찾아야|알아내야|확인해야|해결해야|구해야|막아야|기다리는\s*중|미해결|수수께끼|의문|단서|추적|행방|목표|계획|퀘스트|임무|숙제|비밀을\s*밝|need(?:s)?\s+to|must\s+|have\s+to|has\s+to|still\s+need|unresolved|mystery|clue|trace|whereabouts|goal|plan|quest|mission|find\s+out|figure\s+out|save\s+|stop\s+)/i;
        const LOOP_RESOLVED_RE = /(해결했|밝혀냈|찾아냈|구해냈|완료했|끝냈|진실이\s*드러|resolved|solved|found\s+out|completed|finished|rescued|truth\s+was\s+revealed)/i;
        const CALLBACK_RE = /(반지|목걸이|팔찌|사진|편지|일기|선물|흉터|문신|암호|암호명|별명|애칭|기념품|부적|열쇠|증표|징표|ring|necklace|bracelet|photo|photograph|letter|diary|gift|scar|tattoo|codeword|codename|nickname|pet\s+name|memento|keepsake|amulet|key|token)/i;
        const SECRET_RE = /(비밀|몰래|숨기|감추|아무도\s*모르|모르게|알려지지|정체를\s*숨|secret|hidden|conceal|unbeknownst|no\s+one\s+knows|doesn['’]?t\s+know|do\s+not\s+know)/i;
        const POV_RE = /([가-힣A-Za-z0-9 _-]{1,40})(?:만|만이)\s*(?:알|알고)|only\s+([A-Za-z0-9 _-]{1,40})\s+knows?/i;
        const TRANSIENT_MOOD_ONLY_RE = /^(?:잠시|순간|지금|현재|방금)?\s*(?:기쁘|슬프|화가\s*나|긴장|당황|놀라|웃|울|행복|불안|angry|sad|happy|nervous|surprised|smiled|cried)(?:다|했다|해졌다|였다|\.)?$/i;
        const META_CONTROL_RE = /^(?:\s*\[?(?:ooc|system|assistant|analysis|memory|메모리|설정|시스템|분석|요약|번역|지시|명령)\]?\s*[:：]|\s*#\s*(?:response|analysis|memory)|\s*```)/i;

        const clip = (value = '', max = 280) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            const limit = Math.max(20, Number(max || 0));
            return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trim()}…` : text;
        };
        const normalizeText = (value = '') => String(value || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[“”‘’"'`]/g, '')
            .replace(/[^a-z0-9가-힣]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const normalizeRecallToken = (value = '') => {
            let token = String(value || '').trim().toLowerCase();
            // Korean particles otherwise make the same anchor look unrelated
            // (민트초코를/민트초코가, 서연은/서연이). Keep short lexical
            // words such as 사과 intact and strip only from longer tokens.
            if (token.length >= 3 && /[가-힣]/.test(token)) {
                token = token.replace(/(?:에게서는|에게서|에게는|에게|한테는|한테|께서는|께서|으로는|에서는|에는|에서|부터|까지|처럼|으로|하고|이랑|랑|은|는|이|가|을|를|의|도|로|와|과)$/u, '');
            }
            return token;
        };
        const tokenize = (value = '') => (normalizeText(value).match(/[a-z0-9가-힣]{2,}/g) || [])
            .map(normalizeRecallToken)
            .filter(token => token && token.length >= 2 && !GENERIC_TOKENS.has(token))
            .slice(0, 80);
        const normalizeEntity = (value = '') => String(value || '')
            .replace(/^[\s,.;:!?()[\]{}"'`~\-]+|[\s,.;:!?()[\]{}"'`~\-]+$/g, '')
            .replace(/(?:에게서는|에게서|에게는|에게|한테는|한테|께서는|께서|으로는|에서는|에는|에서|부터|까지|처럼|으로|하고|이랑|랑|은|는|이|가|을|를|의|도|로|만)$/u, '')
            .trim();
        const uniqueStrings = (items = [], max = 24) => dedupeTextArray((Array.isArray(items) ? items : [items])
            .map(item => typeof item === 'string' ? item : (item?.name || item?.label || item?.ref || item?.id || ''))
            .map(normalizeEntity)
            .filter(Boolean))
            .slice(0, max);
        const clampConfidence = (value, fallback = 0.72) => Math.max(0.1, Math.min(0.99, Number(value ?? fallback) || fallback));
        const clampImportance = (value, fallback = 5) => Math.max(1, Math.min(10, Math.round(Number(value ?? fallback) || fallback)));
        const normalizeDurability = (value = '', fallback = 'medium') => {
            const normalized = String(value || '').trim().toLowerCase();
            return Object.prototype.hasOwnProperty.call(DURABILITY_RANK, normalized) ? normalized : fallback;
        };
        const normalizeStatus = (value = '', fallback = 'active') => {
            const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            const aliases = {
                pending: 'open', ongoing: 'open', unresolved: 'open', active: 'active', promised: 'open',
                done: 'resolved', complete: 'resolved', completed: 'resolved', fulfilled: 'fulfilled',
                cancelled: 'cancelled', canceled: 'cancelled', broken: 'broken', superseded: 'superseded'
            };
            return aliases[normalized] || normalized || fallback;
        };
        const normalizeVisibility = (value = '', text = '') => {
            const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            if (['secret', 'hidden', 'private'].includes(normalized)) return 'secret';
            if (['pov', 'limited', 'restricted', 'entity_only'].includes(normalized)) return 'pov';
            if (SECRET_RE.test(String(text || ''))) return 'secret';
            return 'public';
        };
        const durabilityFromText = (text = '', category = '') => {
            const raw = String(text || '');
            if (category === 'stableFacts' || category === 'preferences') return 'permanent';
            if (IRREVERSIBLE_RE.test(raw) || IDENTITY_RE.test(raw) || /(영원|평생|다시는|forever|always|never again)/i.test(raw)) return 'permanent';
            if (['commitments', 'openLoops', 'relationshipMilestones', 'stateChanges'].includes(category)) return 'long';
            if (category === 'callbacks') return 'long';
            return 'medium';
        };
        const categoryDefaultStatus = (category = '') => {
            if (category === 'commitments' || category === 'openLoops') return 'open';
            return 'active';
        };
        const splitSentences = (text = '') => String(text || '')
            .replace(/\r\n/g, '\n')
            .split(/(?<=[.!?。！？다요죠네음함임됨]|[\]\)])\s+|\n{2,}|\n(?=["“‘'가-힣A-Z0-9])/g)
            .map(item => item.replace(/\s+/g, ' ').trim())
            .filter(item => item.length >= 5 && item.length <= 900)
            .slice(0, 42);
        const getKnownEntityNames = (options = {}) => {
            const names = [];
            const push = (value) => {
                const text = normalizeEntity(value);
                if (text && text.length <= 80) names.push(text);
            };
            for (const list of [options.entityRefs, options.knownEntityNames, options.focusNames]) {
                if (Array.isArray(list)) list.forEach(item => push(typeof item === 'string' ? item : (item?.name || item?.label || item?.ref)));
            }
            try {
                if (typeof EntityManager !== 'undefined' && EntityManager?.getEntityCache) {
                    Array.from(EntityManager.getEntityCache().values()).forEach(entity => {
                        push(entity?.name);
                        if (Array.isArray(entity?.aliases)) entity.aliases.forEach(push);
                    });
                }
            } catch (_) {}
            return dedupeTextArray(names).sort((a, b) => b.length - a.length).slice(0, 96);
        };
        const entitiesInText = (text = '', knownNames = []) => {
            const lower = String(text || '').toLowerCase();
            return dedupeTextArray((Array.isArray(knownNames) ? knownNames : [])
                .filter(name => name && lower.includes(String(name).toLowerCase())))
                .slice(0, 8);
        };
        const inferSubject = (text = '', entities = [], source = '') => {
            if (entities.length > 0) return entities[0];
            const raw = String(text || '').trim();
            if (source === 'user' && (/^(?:나|내가|나는|난|내|저|제가|저는)(?:\s|은|는|가|를|의|$)/i.test(raw) || /(?:^|[\s"“‘(])(?:i|i'm|i am|my)(?:\s|$)/i.test(raw))) return 'User';
            return '';
        };
        const inferFactSlot = (text = '') => {
            const raw = String(text || '');
            if (/(본명|진짜\s*이름|real\s+name)/i.test(raw)) return 'real_name';
            if (/(정체|true\s+identity|identity)/i.test(raw)) return 'identity';
            if (/(생일|birthday)/i.test(raw)) return 'birthday';
            if (/(나이|age\s+is)/i.test(raw)) return 'age';
            if (/(직업|works?\s+as|occupation)/i.test(raw)) return 'occupation';
            if (/(소속|member\s+of|belongs?\s+to)/i.test(raw)) return 'affiliation';
            if (/(가족|부모|아버지|어머니|형제|자매|family|father|mother|parent|sibling|brother|sister)/i.test(raw)) return 'family';
            if (/(고향|출신|hometown|from\s+[A-Z])/i.test(raw)) return 'origin';
            if (/(거주|사는\s*곳|lives?\s+in)/i.test(raw)) return 'residence';
            if (/(종족|species)/i.test(raw)) return 'species';
            if (/(능력|ability)/i.test(raw)) return 'ability';
            if (/(약점|weakness)/i.test(raw)) return 'weakness';
            if (/(비밀|secret)/i.test(raw)) return 'secret';
            return 'canon_fact';
        };
        const inferPreferenceKind = (text = '') => {
            const raw = String(text || '');
            if (/(알레르기|allergic|못\s*먹|먹지\s*못|cannot eat|can't eat)/i.test(raw)) return 'medical_or_food_boundary';
            if (/(하지\s*마|지\s*마|원하지\s*않|경계선|boundary|do not|don't\s+want)/i.test(raw)) return 'boundary';
            if (/(두려워|무서워|afraid of|fears?)/i.test(raw)) return 'fear';
            if (/(싫어|좋아하지\s*않|더\s*이상\s*좋아하지|dislikes?|hates?|don['’]?t\s+like|doesn['’]?t\s+like|no\s+longer\s+likes?)/i.test(raw)) return 'dislike';
            return 'preference';
        };
        const inferPreferenceTopic = (text = '') => {
            const raw = String(text || '').replace(/\s+/g, ' ').trim();
            if (!raw) return '';
            const patterns = [
                /(?:나는|난|내가|저는|전|제가|[가-힣A-Za-z0-9 _-]{1,40}(?:은|는|이|가))?\s*["“‘']?(.{1,90}?)["”’']?(?:을|를|이|가|은|는)?\s*(?:정말\s*|아주\s*|이제\s*|더\s*이상\s*)?(?:좋아(?:해|한다|하지\s*않)|싫어(?:해|한다)?|선호(?:해|한다)?|두려워(?:해|한다)?|무서워(?:해|한다)?|꺼려(?:해|한다)?|불편해|편안해|못\s*먹|먹지\s*못)/i,
                /([가-힣A-Za-z0-9 _-]{1,90}?)\s*(?:에|에겐|에는)?\s*알레르기/i,
                /(?:like|love|hate|dislike|prefer|fear|afraid\s+of|allergic\s+to|cannot\s+eat|can['’]?t\s+eat)\s+(.{1,90}?)(?:[.!?]|$)/i
            ];
            for (const pattern of patterns) {
                const match = raw.match(pattern);
                const topic = String(match?.[1] || '')
                    .replace(/^(?:이제|앞으로|요즘|현재|더\s*이상|now|currently|from\s+now\s+on|no\s+longer)\s+/i, '')
                    .replace(/^[\s"“”‘’']+|[\s"“”‘’',.;:!?]+$/g, '')
                    .trim();
                if (topic && topic.length >= 2) return clip(topic, 140);
            }
            const fallback = raw
                .replace(/^(?:나는|난|내가|저는|전|제가|i|we|he|she|they)\s+/i, '')
                .replace(/(?:좋아(?:해|한다|하지\s*않)|싫어(?:해|한다)?|선호(?:해|한다)?|두려워(?:해|한다)?|무서워(?:해|한다)?|꺼려(?:해|한다)?|불편해|편안해|알레르기(?:가\s*있어|가\s*있다)?|못\s*먹(?:어|는다)?|먹지\s*못(?:해|한다)?|likes?|loves?|hates?|dislikes?|prefers?|afraid\s+of|allergic\s+to|cannot\s+eat|can['’]?t\s+eat).*$/i, '')
                .replace(/(?:을|를|이|가|은|는)$/u, '')
                .replace(/^[\s"“”‘’']+|[\s"“”‘’',.;:!?]+$/g, '')
                .trim();
            return fallback.length >= 2 ? clip(fallback, 140) : clip(raw, 140);
        };
        const inferStateDomain = (text = '') => {
            const raw = String(text || '');
            if (/(다쳤|부상|상처|골절|병원|입원|의식|죽었|사망|임신|injured|wounded|hospital|unconscious|died|dead|pregnant)/i.test(raw)) return 'physical';
            if (/(도착|떠났|귀환|이사|전학|arrived|left|departed|returned|moved|transferred)/i.test(raw)) return 'location';
            if (/(해고|승진|퇴학|졸업|합류|탈퇴|fired|promoted|expelled|graduated|joined)/i.test(raw)) return 'role';
            if (/(기억|알게|깨달|발견|learned|realized|discovered|memory)/i.test(raw)) return 'knowledge';
            if (/(얻었|잃었|받았|훔쳤|found|received|lost|stole)/i.test(raw)) return 'possession';
            return 'state';
        };
        const inferStateSlot = (text = '') => {
            const raw = String(text || '');
            if (/(죽었|사망|살해|died|dead|killed)/i.test(raw)) return 'life_status';
            if (/(임신|출산|pregnant|gave\s+birth)/i.test(raw)) return 'pregnancy';
            if (/(다쳤|부상|상처|골절|병원|입원|의식|injured|wounded|hospital|unconscious)/i.test(raw)) return 'health_or_injury';
            if (/(실종|missing)/i.test(raw)) return 'missing_status';
            if (/(체포|구금|arrested|detained)/i.test(raw)) return 'custody_status';
            if (/(해고|승진|fired|promoted)/i.test(raw)) return 'occupation_status';
            if (/(퇴학|졸업|전학|expelled|graduated|transferred)/i.test(raw)) return 'school_status';
            if (/(합류|탈퇴|joined|left\s+(?:the\s+)?(?:group|team|guild|party|organization|company))/i.test(raw)) return 'affiliation_status';
            if (/(이사|떠났|도착|귀환|moved\s+to|departed|arrived|returned)/i.test(raw)) return 'location';
            if (/(변신|transformed)/i.test(raw)) return 'form';
            if (/(기억(?:을)?\s*잃|lost\s+(?:his|her|their)?\s*memory)/i.test(raw)) return 'memory_status';
            return inferStateDomain(raw);
        };
        const inferRelationAxis = (text = '') => {
            const raw = String(text || '');
            if (/(사랑|고백|연인|키스|결혼|애정|love|lover|kiss|married|affection)/i.test(raw)) return 'affection';
            if (/(신뢰|믿|trust)/i.test(raw)) return 'trust';
            if (/(배신|적대|증오|betray|hostile|hate)/i.test(raw)) return 'hostility';
            if (/(두려|공포|fear)/i.test(raw)) return 'fear';
            if (/(충성|동맹|loyal|alliance)/i.test(raw)) return 'loyalty';
            if (/(가족|친구|연인|약혼|결혼|family|friend|dating|engaged|married)/i.test(raw)) return 'status';
            return 'relationship';
        };
        const inferDirection = (text = '') => {
            const raw = String(text || '');
            if (/(배신|이별|절교|거절|불신|멀어|betray|breakup|broke up|rejected|distrust|hostile)/i.test(raw)) return 'decrease';
            if (/(고백|사귀|연인|키스|결혼|약혼|화해|용서|신뢰|동맹|confessed|dating|lover|kiss|married|engaged|reconciled|forgave|trusted|alliance)/i.test(raw)) return 'increase';
            return 'shift';
        };
        const makeId = (category = 'item', text = '', turn = 0) => `rp_${category}_${TokenizerEngine.simpleHash(`${category}|${normalizeText(text)}|${Number(turn || 0)}`)}`;
        const itemText = (value = null) => {
            if (typeof value === 'string') return clip(value, 420);
            if (!value || typeof value !== 'object') return '';
            return clip(value.text || value.summary || value.fact || value.preference || value.promise || value.commitment || value.change || value.delta || value.label || value.value || '', 420);
        };
        const ITEM_VERSION_SCALAR_KEYS = Object.freeze([
            'text', 'summary', 'value', 'before', 'after', 'status', 'resolution', 'due',
            'subject', 'owner', 'target', 'entity', 'slot', 'kind', 'topic', 'axis',
            'direction', 'domain', 'type', 'visibility', 'confidence', 'importance',
            'durability', 'source', 'location', 'time', 'emotionalTone'
        ]);
        const ITEM_VERSION_ARRAY_KEYS = Object.freeze(['entities', 'pair', 'knownBy', 'unknownTo', 'resolutionCriteria', 'consequences']);
        const normalizeItemVersion = (raw = null, fallbackTurn = 0) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
            const turn = Math.max(0, Number(raw.turn || raw.sourceTurn || raw.lastTurn || fallbackTurn || 0) || 0);
            if (!turn) return null;
            const version = { turn };
            for (const key of ITEM_VERSION_SCALAR_KEYS) {
                if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue;
                if (key === 'confidence') version[key] = clampConfidence(raw[key]);
                else if (key === 'importance') version[key] = clampImportance(raw[key]);
                else if (key === 'durability') version[key] = normalizeDurability(raw[key], 'medium');
                else if (key === 'status') version[key] = normalizeStatus(raw[key], 'active');
                else if (key === 'visibility') version[key] = normalizeVisibility(raw[key], raw.text || '');
                else version[key] = clip(raw[key], key === 'text' || key === 'summary' ? 420 : 220);
            }
            for (const key of ITEM_VERSION_ARRAY_KEYS) {
                if (!Array.isArray(raw[key])) continue;
                version[key] = key === 'entities' || key === 'pair' || key === 'knownBy' || key === 'unknownTo'
                    ? uniqueStrings(raw[key], key === 'pair' ? 2 : 10)
                    : dedupeTextArray(raw[key].map(value => clip(value, 160)).filter(Boolean)).slice(0, 8);
            }
            return version;
        };
        const snapshotItemVersion = (item = null, fallbackTurn = 0) => {
            if (!item || typeof item !== 'object') return null;
            return normalizeItemVersion({ ...item, turn: item.lastTurn || item.sourceTurn || fallbackTurn }, fallbackTurn);
        };
        const itemVersionFingerprint = (version = null) => {
            if (!version) return '';
            return `${Number(version.turn || 0)}|${normalizeText([
                version.text, version.summary, version.value, version.after, version.status,
                version.subject, version.owner, version.target, version.entity, version.slot,
                version.kind, version.topic, version.axis, version.domain, version.type
            ].filter(Boolean).join('|'))}`;
        };
        const mergeItemVersions = (...groups) => {
            const out = [];
            const seen = new Set();
            for (const raw of groups.flat()) {
                const version = normalizeItemVersion(raw);
                if (!version) continue;
                const key = itemVersionFingerprint(version);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(version);
            }
            return out.sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0)).slice(-8);
        };
        const itemMaterialSignature = (item = null) => normalizeText([
            item?.text, item?.summary, item?.value, item?.before, item?.after,
            item?.status, item?.resolution, item?.due, item?.subject, item?.owner,
            item?.target, item?.entity, item?.slot, item?.kind, item?.topic,
            item?.axis, item?.direction, item?.domain, item?.type, item?.visibility,
            ...(Array.isArray(item?.pair) ? item.pair : [])
        ].filter(Boolean).join('|'));
        const applyItemVersion = (item = null, version = null) => {
            const next = { ...(item || {}) };
            if (!version) return next;
            for (const key of ITEM_VERSION_SCALAR_KEYS) {
                if (version[key] !== undefined) next[key] = version[key];
            }
            for (const key of ITEM_VERSION_ARRAY_KEYS) {
                if (Array.isArray(version[key])) next[key] = [...version[key]];
            }
            return next;
        };
        const normalizeDurableEvidenceRefs = (value = [], fallbackTurn = 0) => {
            const rows = Array.isArray(value) ? value : (value ? [value] : []);
            const out = [];
            const seen = new Set();
            for (const raw of rows) {
                const item = raw && typeof raw === 'object' && !Array.isArray(raw)
                    ? raw
                    : { snippet: String(raw || '') };
                const ref = {
                    turn: Math.max(0, Number(item.turn || fallbackTurn || 0) || 0),
                    messageId: clip(item.messageId || item.sourceMessageId || '', 120),
                    spanHash: clip(item.spanHash || item.hash || '', 120),
                    snippet: clip(item.snippet || item.text || item.evidence || '', 240),
                    sourceKind: clip(item.sourceKind || item.source || 'assistant', 60) || 'assistant'
                };
                if (!ref.turn && !ref.messageId && !ref.spanHash && !ref.snippet) continue;
                const key = `${ref.turn}|${ref.messageId}|${ref.spanHash}|${normalizeText(ref.snippet)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(ref);
                if (out.length >= 8) break;
            }
            return out;
        };
        const normalizeItem = (category = '', raw = null, context = {}) => {
            const text = itemText(raw);
            if (!text) return null;
            const sourceTurn = Math.max(0, Number(raw?.sourceTurn || raw?.turn || context.turn || 0) || 0);
            const entities = uniqueStrings([
                ...(Array.isArray(raw?.entities) ? raw.entities : []),
                ...(Array.isArray(raw?.pair) ? raw.pair : []),
                raw?.subject, raw?.entity, raw?.owner, raw?.target,
                ...(Array.isArray(context.entityRefs) ? context.entityRefs.filter(name => String(text).toLowerCase().includes(String(name).toLowerCase())) : [])
            ], 8);
            const subject = normalizeEntity(raw?.subject || raw?.entity || raw?.owner || entities[0] || '');
            const knownBy = uniqueStrings(raw?.knownBy || raw?.visibleTo || [], 10);
            const unknownTo = uniqueStrings(raw?.unknownTo || raw?.hiddenFrom || [], 10);
            const visibility = normalizeVisibility(raw?.visibility, text);
            const durability = normalizeDurability(raw?.durability, durabilityFromText(text, category));
            const status = normalizeStatus(raw?.status, categoryDefaultStatus(category));
            const base = {
                id: String(raw?.id || makeId(category, text, sourceTurn)).trim(),
                text,
                entities,
                subject,
                visibility,
                knownBy,
                unknownTo,
                confidence: clampConfidence(raw?.confidence, context.confidence ?? 0.72),
                importance: clampImportance(raw?.importance, context.importance ?? 6),
                durability,
                status,
                firstTurn: Math.max(0, Number(raw?.firstTurn || sourceTurn || 0) || 0),
                lastTurn: Math.max(0, Number(raw?.lastTurn || sourceTurn || 0) || 0),
                sourceTurns: dedupeTextArray([
                    ...(Array.isArray(raw?.sourceTurns) ? raw.sourceTurns : []),
                    sourceTurn > 0 ? String(sourceTurn) : ''
                ].filter(Boolean)).map(Number).filter(Number.isFinite).slice(-12),
                reinforcement: Math.max(1, Number(raw?.reinforcement || 1) || 1),
                source: clip(raw?.source || context.source || 'turn', 60),
                evidenceRefs: normalizeDurableEvidenceRefs(raw?.evidenceRefs || raw?.evidence || [], sourceTurn)
            };
            if (category === 'stableFacts') {
                base.slot = clip(raw?.slot || inferFactSlot(text), 80);
                base.value = clip(raw?.value || text, 260);
            } else if (category === 'preferences') {
                base.kind = clip(raw?.kind || inferPreferenceKind(text), 80);
                base.topic = clip(raw?.topic || raw?.value || inferPreferenceTopic(text), 140);
            } else if (category === 'commitments') {
                base.owner = normalizeEntity(raw?.owner || subject || entities[0] || '');
                base.target = normalizeEntity(raw?.target || entities.find(name => name !== base.owner) || '');
                base.due = clip(raw?.due || raw?.deadline || '', 120);
                base.resolution = clip(raw?.resolution || '', 220);
            } else if (category === 'openLoops') {
                base.type = clip(raw?.type || 'unresolved_goal', 80);
                base.resolutionCriteria = dedupeTextArray((Array.isArray(raw?.resolutionCriteria) ? raw.resolutionCriteria : [raw?.resolutionCriteria])
                    .map(value => clip(value, 140)).filter(Boolean)).slice(0, 6);
                base.resolution = clip(raw?.resolution || '', 220);
            } else if (category === 'relationshipMilestones') {
                base.pair = uniqueStrings(raw?.pair || entities, 2);
                base.axis = clip(raw?.axis || inferRelationAxis(text), 80);
                base.direction = clip(raw?.direction || inferDirection(text), 40);
            } else if (category === 'stateChanges') {
                base.entity = normalizeEntity(raw?.entity || subject || entities[0] || '');
                base.domain = clip(raw?.domain || inferStateDomain(text), 80);
                base.slot = clip(raw?.slot || inferStateSlot(text), 80);
                base.before = clip(raw?.before || '', 140);
                base.after = clip(raw?.after || raw?.value || text, 180);
            } else if (category === 'callbacks') {
                base.label = clip(raw?.label || text, 100);
                base.kind = clip(raw?.kind || 'callback_anchor', 80);
            } else if (category === 'episodes') {
                base.summary = clip(raw?.summary || text, 420);
                base.location = clip(raw?.location || context.location || '', 120);
                base.time = clip(raw?.time || context.time || '', 100);
                base.emotionalTone = clip(raw?.emotionalTone || raw?.tone || '', 100);
                base.consequences = dedupeTextArray((Array.isArray(raw?.consequences) ? raw.consequences : [raw?.consequences])
                    .map(value => clip(value, 160)).filter(Boolean)).slice(0, 6);
            }
            const versions = mergeItemVersions(Array.isArray(raw?.versions) ? raw.versions : (Array.isArray(raw?.history) ? raw.history : []));
            if (versions.length > 0) base.versions = versions;
            return base;
        };
        const itemFingerprint = (category = '', item = null) => {
            if (!item) return '';
            const slot = item.slot || item.kind || item.axis || item.domain || item.type || '';
            const subject = item.subject || item.owner || item.entity || '';
            return normalizeText(`${category}|${subject}|${slot}|${item.text}`);
        };
        const textSimilarity = (left = '', right = '') => {
            const a = normalizeText(left);
            const b = normalizeText(right);
            if (!a || !b) return 0;
            if (a === b) return 1;
            if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 12) return 0.9;
            const ta = new Set(tokenize(a));
            const tb = new Set(tokenize(b));
            if (!ta.size || !tb.size) return 0;
            let intersection = 0;
            for (const token of ta) if (tb.has(token)) intersection += 1;
            return intersection / Math.max(1, ta.size + tb.size - intersection);
        };
        const entityOverlap = (a = [], b = []) => {
            const left = new Set(uniqueStrings(a, 16).map(normalizeText));
            const right = new Set(uniqueStrings(b, 16).map(normalizeText));
            let count = 0;
            for (const value of left) if (right.has(value)) count += 1;
            return count;
        };
        const sameSlotIdentity = (category = '', a = null, b = null) => {
            if (!a || !b) return false;
            if (category === 'stableFacts') return normalizeText(a.subject) === normalizeText(b.subject) && normalizeText(a.slot) === normalizeText(b.slot) && !!normalizeText(a.subject);
            if (category === 'preferences') {
                const subjectA = normalizeText(a.subject);
                const subjectB = normalizeText(b.subject);
                const topicA = normalizeText(a.topic || inferPreferenceTopic(a.text));
                const topicB = normalizeText(b.topic || inferPreferenceTopic(b.text));
                return subjectA === subjectB && topicA === topicB && !!subjectA && !!topicA;
            }
            if (category === 'stateChanges') return normalizeText(a.entity) === normalizeText(b.entity) && normalizeText(a.slot || a.domain) === normalizeText(b.slot || b.domain) && !!normalizeText(a.entity);
            return false;
        };
        const collectItemRefs = (item = null) => uniqueStrings([
            ...(Array.isArray(item?.entities) ? item.entities : []),
            ...(Array.isArray(item?.pair) ? item.pair : []),
            item?.subject, item?.owner, item?.target, item?.entity
        ], 12);
        const durableAnchorTokens = (category = '', item = null) => {
            let raw = [
                item?.topic, item?.value, item?.after, item?.label,
                item?.text, item?.summary,
                ...(Array.isArray(item?.resolutionCriteria) ? item.resolutionCriteria : [])
            ].filter(Boolean).join(' ');
            if (category === 'commitments') {
                raw = raw.replace(/(?:약속|맹세|서약|반드시|꼭|지켰|이행|완수|어겼|저버|promise|promised|swear|pledge|vow|fulfilled|kept|broken|broke)/gi, ' ');
            } else if (category === 'openLoops') {
                raw = raw.replace(/(?:해야|찾아야|알아내야|확인해야|해결해야|구해야|막아야|미해결|목표|계획|퀘스트|임무|해결했|완료했|need|must|have\s+to|unresolved|goal|plan|quest|mission|resolved|solved|completed|finished)/gi, ' ');
            } else if (category === 'preferences') {
                raw = item?.topic || inferPreferenceTopic(item?.text || '') || raw;
            }
            return new Set(tokenize(raw).filter(token => token.length >= 2));
        };
        const durableAnchorSimilarity = (category = '', left = null, right = null) => {
            const a = durableAnchorTokens(category, left);
            const b = durableAnchorTokens(category, right);
            if (!a.size || !b.size) return 0;
            let intersection = 0;
            for (const token of a) if (b.has(token)) intersection += 1;
            return intersection / Math.max(1, a.size + b.size - intersection);
        };
        const isMatchingItem = (category = '', existing = null, incoming = null) => {
            if (!existing || !incoming) return false;
            if (itemFingerprint(category, existing) === itemFingerprint(category, incoming)) return true;
            if (sameSlotIdentity(category, existing, incoming)) return true;
            const similarity = textSimilarity(existing.text, incoming.text);
            const refsA = collectItemRefs(existing);
            const refsB = collectItemRefs(incoming);
            const overlap = entityOverlap(refsA, refsB);
            const anchorSimilarity = durableAnchorSimilarity(category, existing, incoming);
            if (similarity >= 0.74) return true;
            if (similarity >= 0.54 && overlap > 0) return true;
            if (['commitments', 'openLoops'].includes(category) && overlap > 0 && (similarity >= 0.4 || anchorSimilarity >= 0.28)) return true;
            if (category === 'callbacks' && overlap > 0 && anchorSimilarity >= 0.46) return true;
            return false;
        };
        const findStatusResolutionMatchIndex = (category = '', bucket = [], incoming = null) => {
            if (!['commitments', 'openLoops'].includes(category) || !incoming) return -1;
            const incomingStatus = normalizeStatus(incoming.status, categoryDefaultStatus(category));
            if (!CLOSED_STATUS.has(incomingStatus)) return -1;
            const activeCandidates = (Array.isArray(bucket) ? bucket : [])
                .map((item, index) => ({ item, index }))
                .filter(({ item }) => ACTIVE_STATUS.has(normalizeStatus(item?.status, categoryDefaultStatus(category))));
            if (!activeCandidates.length) return -1;
            const incomingRefs = collectItemRefs(incoming);
            const scored = activeCandidates.map(({ item, index }) => {
                const overlap = entityOverlap(collectItemRefs(item), incomingRefs);
                const ownerMatch = !!normalizeText(item?.owner || item?.subject || item?.entity)
                    && normalizeText(item?.owner || item?.subject || item?.entity) === normalizeText(incoming?.owner || incoming?.subject || incoming?.entity);
                const targetMatch = !!normalizeText(item?.target)
                    && normalizeText(item?.target) === normalizeText(incoming?.target);
                const anchor = durableAnchorSimilarity(category, item, incoming);
                const score = (overlap * 3) + (ownerMatch ? 2 : 0) + (targetMatch ? 2 : 0) + (anchor * 6) + (Number(item?.lastTurn || 0) / 100000);
                return { index, overlap, ownerMatch, targetMatch, anchor, score };
            });
            const participantScoped = incomingRefs.length
                ? scored.filter(item => item.overlap > 0 || item.ownerMatch || item.targetMatch)
                : scored;
            const candidates = participantScoped.length ? participantScoped : scored;
            if (candidates.length === 1) {
                const only = candidates[0];
                if (!incomingRefs.length || only.overlap > 0 || only.ownerMatch || only.targetMatch || only.anchor >= 0.2) return only.index;
            }
            candidates.sort((a, b) => b.score - a.score);
            const top = candidates[0];
            const second = candidates[1];
            if (top && top.anchor >= 0.34 && (!second || top.anchor - second.anchor >= 0.12)) return top.index;
            return -1;
        };
        const mergeItems = (category = '', existing = null, incoming = null) => {
            if (!existing) return incoming;
            if (!incoming) return existing;
            const incomingWins = Number(incoming.lastTurn || 0) >= Number(existing.lastTurn || 0)
                && Number(incoming.confidence || 0) >= Math.max(0.45, Number(existing.confidence || 0) - 0.12);
            const merged = {
                ...existing,
                ...(incomingWins ? incoming : {}),
                id: existing.id || incoming.id,
                text: incomingWins ? incoming.text : existing.text,
                entities: uniqueStrings([...(existing.entities || []), ...(incoming.entities || [])], 8),
                knownBy: uniqueStrings([...(existing.knownBy || []), ...(incoming.knownBy || [])], 10),
                unknownTo: uniqueStrings([...(existing.unknownTo || []), ...(incoming.unknownTo || [])], 10),
                confidence: Math.max(Number(existing.confidence || 0), Number(incoming.confidence || 0)),
                importance: Math.max(Number(existing.importance || 0), Number(incoming.importance || 0)),
                durability: DURABILITY_RANK[incoming.durability] >= DURABILITY_RANK[existing.durability] ? incoming.durability : existing.durability,
                firstTurn: [existing.firstTurn, incoming.firstTurn].map(Number).filter(value => value > 0).sort((a, b) => a - b)[0] || Math.max(Number(existing.firstTurn || 0), Number(incoming.firstTurn || 0)),
                lastTurn: Math.max(Number(existing.lastTurn || 0), Number(incoming.lastTurn || 0)),
                sourceTurns: dedupeTextArray([...(existing.sourceTurns || []), ...(incoming.sourceTurns || [])].map(String)).map(Number).filter(Number.isFinite).slice(-12),
                evidenceRefs: normalizeDurableEvidenceRefs([...(existing.evidenceRefs || []), ...(incoming.evidenceRefs || [])], Math.max(Number(existing.lastTurn || 0), Number(incoming.lastTurn || 0))),
                reinforcement: Math.max(1, Number(existing.reinforcement || 1)) + 1
            };
            const incomingStatus = normalizeStatus(incoming.status, existing.status || categoryDefaultStatus(category));
            if (CLOSED_STATUS.has(incomingStatus) || ACTIVE_STATUS.has(incomingStatus)) merged.status = incomingStatus;
            if (incoming.resolution) merged.resolution = clip(incoming.resolution, 220);
            if (sameSlotIdentity(category, existing, incoming) && normalizeText(existing.value || existing.after || existing.text) !== normalizeText(incoming.value || incoming.after || incoming.text)) {
                merged.previousValues = dedupeTextArray([
                    ...(Array.isArray(existing.previousValues) ? existing.previousValues : []),
                    clip(existing.value || existing.after || existing.text, 220)
                ]).slice(-5);
            }
            if (category === 'openLoops') merged.resolutionCriteria = dedupeTextArray([...(existing.resolutionCriteria || []), ...(incoming.resolutionCriteria || [])]).slice(0, 8);
            if (category === 'relationshipMilestones') merged.pair = uniqueStrings([...(existing.pair || []), ...(incoming.pair || [])], 2);
            const materialChanged = itemMaterialSignature(existing) !== itemMaterialSignature(incoming);
            const versions = materialChanged
                ? mergeItemVersions(
                    existing.versions || [],
                    snapshotItemVersion(existing, existing.lastTurn || existing.firstTurn || 0),
                    incoming.versions || [],
                    snapshotItemVersion(incoming, incoming.lastTurn || incoming.firstTurn || 0)
                )
                : mergeItemVersions(existing.versions || [], incoming.versions || []);
            if (versions.length > 0) merged.versions = versions;
            else delete merged.versions;
            return merged;
        };
        const normalizeCategoryList = (category = '', rawItems = [], context = {}) => {
            const out = [];
            for (const raw of (Array.isArray(rawItems) ? rawItems : [rawItems])) {
                const item = normalizeItem(category, raw, context);
                if (!item) continue;
                const matchIndex = out.findIndex(existing => isMatchingItem(category, existing, item));
                if (matchIndex >= 0) out[matchIndex] = mergeItems(category, out[matchIndex], item);
                else out.push(item);
            }
            return out.slice(0, Math.max(1, Number(context.maxItems || 24) || 24));
        };
        const normalizeTurnMemory = (raw = null, context = {}) => {
            const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
            const aliases = {
                stableFacts: value.stableFacts || value.facts || [],
                preferences: value.preferences || value.boundaries || [],
                commitments: value.commitments || value.promises || [],
                openLoops: value.openLoops || value.openThreads || value.unresolved || [],
                relationshipMilestones: value.relationshipMilestones || value.relationshipDeltas || value.relations || [],
                stateChanges: value.stateChanges || value.states || [],
                callbacks: value.callbacks || value.callbackAnchors || value.mementos || [],
                episodes: value.episodes || value.episode || []
            };
            const normalized = {
                schema: TURN_SCHEMA,
                version: VERSION,
                turn: Math.max(0, Number(value.turn || context.turn || 0) || 0),
                importance: clampImportance(value.importance, context.importance ?? 5),
                durability: normalizeDurability(value.durability, 'medium'),
                protected: value.protected === true,
                retentionReasons: dedupeTextArray((Array.isArray(value.retentionReasons) ? value.retentionReasons : [value.retentionReason])
                    .map(item => clip(item, 100)).filter(Boolean)).slice(0, 8),
                tags: dedupeTextArray((Array.isArray(value.tags) ? value.tags : []).map(item => clip(item, 80)).filter(Boolean)).slice(0, 12),
                source: clip(value.source || context.source || 'turn', 60)
            };
            for (const category of CATEGORY_ORDER) normalized[category] = normalizeCategoryList(category, aliases[category], context);
            const hasSignals = CATEGORY_ORDER.some(category => normalized[category].length > 0);
            if (hasSignals) {
                const allItems = CATEGORY_ORDER.flatMap(category => normalized[category]);
                normalized.importance = Math.max(normalized.importance, ...allItems.map(item => Number(item.importance || 0)));
                normalized.durability = allItems
                    .map(item => item.durability)
                    .sort((a, b) => DURABILITY_RANK[b] - DURABILITY_RANK[a])[0] || normalized.durability;
                normalized.protected = normalized.protected
                    || normalized.durability === 'permanent'
                    || normalized.stableFacts.length > 0
                    || normalized.preferences.some(item => item.kind === 'boundary' || item.kind === 'medical_or_food_boundary')
                    || normalized.commitments.some(item => ACTIVE_STATUS.has(normalizeStatus(item.status)))
                    || normalized.openLoops.some(item => ACTIVE_STATUS.has(normalizeStatus(item.status)))
                    || normalized.relationshipMilestones.some(item => item.durability === 'permanent');
                normalized.retentionReasons = dedupeTextArray([
                    ...normalized.retentionReasons,
                    normalized.stableFacts.length ? 'stable_fact' : '',
                    normalized.preferences.length ? 'preference_or_boundary' : '',
                    normalized.commitments.some(item => ACTIVE_STATUS.has(normalizeStatus(item.status))) ? 'open_commitment' : '',
                    normalized.openLoops.some(item => ACTIVE_STATUS.has(normalizeStatus(item.status))) ? 'open_loop' : '',
                    normalized.relationshipMilestones.length ? 'relationship_milestone' : '',
                    normalized.durability === 'permanent' ? 'permanent_canon' : ''
                ].filter(Boolean)).slice(0, 8);
            }
            return normalized;
        };
        const mergeTurnMemory = (base = null, incoming = null, context = {}) => {
            const left = normalizeTurnMemory(base, context);
            const right = normalizeTurnMemory(incoming, context);
            const merged = {
                ...left,
                turn: Math.max(Number(left.turn || 0), Number(right.turn || 0), Number(context.turn || 0)),
                importance: Math.max(Number(left.importance || 0), Number(right.importance || 0)),
                durability: DURABILITY_RANK[right.durability] >= DURABILITY_RANK[left.durability] ? right.durability : left.durability,
                protected: left.protected === true || right.protected === true,
                retentionReasons: dedupeTextArray([...(left.retentionReasons || []), ...(right.retentionReasons || [])]).slice(0, 10),
                tags: dedupeTextArray([...(left.tags || []), ...(right.tags || [])]).slice(0, 16),
                source: clip(right.source || left.source || context.source || 'turn', 60)
            };
            for (const category of CATEGORY_ORDER) {
                const items = [];
                for (const item of [...(left[category] || []), ...(right[category] || [])]) {
                    const idx = items.findIndex(existing => isMatchingItem(category, existing, item));
                    if (idx >= 0) items[idx] = mergeItems(category, items[idx], item);
                    else items.push(item);
                }
                merged[category] = items.slice(0, 28);
            }
            return normalizeTurnMemory(merged, context);
        };
