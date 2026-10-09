    // [MANAGER] V4.2-style Secret Knowledge / POV Guard
    // Keeps undisclosed facts out of main prompt injection and character POV.
    // ══════════════════════════════════════════════════════════════
    const SecretKnowledgeCore = (() => {
        const COMMENT = 'lmai_secret_knowledge';
        const VERSION = 1;
        const SECRET_BLOCK_RE = /\[\[비밀([^\]]*)\]\]([\s\S]*?)\[\[\/비밀\]\]/gi;
        const REVEAL_TAG_RE = /\[\[공개\s+([^\]]*?)\]\]/gi;
        const REDACTED_SECRET_TEXT = '[비밀 기록됨: 본문 비공개]';
        const REVEAL_RECORDED_TEXT = '[비밀 공개 근거 기록됨]';
        const IMPLICIT_SECRET_CUE_RE = /(?:비밀|숨기|숨겨|감추|몰래|아무도\s*모르|모르면|알면\s*안|정체|본명|약점|진실|사실은|secret|hidden|concealed|no\s+one\s+knows|keep\s+(?:it\s+)?secret)/i;
        const IMPLICIT_SECRET_BOUNDARY_RE = /(?:유저만|사용자만|플레이어만|나만|나\s*혼자|본인만|캐릭터(?:들)?(?:은|가)?\s*모르|아무도\s*모르|누구(?:도|에게도)\s*(?:말|알리|공개).{0,30}(?:마|말|않|안)|비밀로\s*(?:남|유지|둬|해)|숨겨야|알면\s*안|모르게|only\s+(?:the\s+)?user|known\s+only\s+to|no\s+one\s+knows|do\s+not\s+(?:reveal|tell|show)|must\s+not\s+know)/i;
        const DIRECT_REVEAL_RE = /(말했|알렸|알려|고백|밝혔|공개|털어놓|보여줬|보여주|들려줬|전했|told|revealed|confessed|showed|disclosed|informed|said)/i;
        const STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'was', 'were', 'are', '그리고', '하지만', '그러나', '그는', '그녀는', '했다', '한다', '있는', '없는', '에게', '으로', '에서']);
        const makeEmptyState = (scopeKey = '', chatId = '') => ({
            version: VERSION,
            scopeKey: String(scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global',
            chatId: String(chatId || getActiveManagedChatId() || '').trim(),
            secrets: []
        });
        let state = makeEmptyState();
        const compact = (value = '', max = 600) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            return text.length > max ? text.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : text;
        };
        const normalizeLoose = (value = '') => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
        const normalizeKey = (value = '') => normalizeLoose(value).toLowerCase().replace(/\s+/g, '');
        const escapeRegex = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const splitValues = (value = '') => String(value || '')
            .split(/[,\s|;、，]+/u)
            .map(item => item.trim())
            .filter(Boolean);
        const parseJsonObject = (text = '') => {
            try {
                const parsed = JSON.parse(String(text || '{}'));
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch {
                return {};
            }
        };
        const normalizeEntityForSecret = (name = '') => {
            const raw = String(name || '').trim();
            if (!raw) return '';
            try {
                return EntityManager?.normalizeName?.(raw) || normalizeKey(raw);
            } catch {
                return normalizeKey(raw);
            }
        };
        const isUserPersonaViewerName = (name = '') => /^(?:user|유저|사용자|player|pc|persona|나|본인)$/i.test(String(name || '').trim());
        const entityViewerId = (name = '') => {
            if (isUserPersonaViewerName(name)) return 'user';
            const normalized = normalizeEntityForSecret(name);
            return normalized ? `entity:${normalized}` : '';
        };
        const normalizeViewerId = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            const lowered = raw.toLowerCase();
            if (/^(?:user|유저|사용자|player|pc|persona|나|본인)$/.test(lowered)) return 'user';
            if (/^(?:planner|storyauthor|story_author|director)$/.test(lowered)) return 'planner';
            if (/^(?:main|main_request|model)$/.test(lowered)) return 'main_request';
            if (lowered.startsWith('entity:')) return entityViewerId(raw.slice(raw.indexOf(':') + 1));
            return entityViewerId(raw);
        };
        const normalizeViewerList = (values = []) => dedupeTextArray(
            (Array.isArray(values) ? values : splitValues(values))
                .map(normalizeViewerId)
                .filter(Boolean)
        );
        const parseAttributes = (source = '', options = {}) => {
            const out = {};
            const raw = String(source || '').trim();
            raw.replace(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g, (match, key, dq, sq, bare) => {
                out[String(key || '').trim().toLowerCase()] = String(dq ?? sq ?? bare ?? '').trim();
                return match;
            });
            const withoutPairs = raw.replace(/([^\s=]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/g, ' ').trim();
            const bareTokens = splitValues(withoutPairs);
            if (options.bareKey && bareTokens.length > 0 && !out[options.bareKey]) out[options.bareKey] = bareTokens[0];
            return out;
        };
        const pickAttr = (attrs = {}, keys = [], fallback = '') => {
            for (const key of keys) {
                const normalized = String(key || '').trim().toLowerCase();
                if (attrs[normalized] != null && String(attrs[normalized]).trim()) return String(attrs[normalized]).trim();
            }
            return fallback;
        };
        const buildSecretId = (secret = {}) => `sk_${TokenizerEngine.simpleHash([
            secret.title || '',
            secret.content || '',
            Array.isArray(secret.about) ? secret.about.join('|') : '',
            state.scopeKey || ''
        ].join('::'))}`;
        const normalizeSecret = (secret = {}) => {
            const source = secret && typeof secret === 'object' ? secret : {};
            const about = dedupeTextArray(
                (Array.isArray(source.about) ? source.about : splitValues(source.about || source.target || ''))
                    .map(item => compact(item, 80))
                    .filter(Boolean)
            ).slice(0, 12);
            const content = compact(source.content || source.text || source.summary || '', 1800);
            const title = compact(source.title || source.name || '', 120) || (about.length ? `${about[0]} secret` : 'protected secret');
            const knownBy = normalizeViewerList(source.knownBy && source.knownBy.length ? source.knownBy : ['user']);
            const next = {
                id: compact(source.id || '', 80),
                title,
                content,
                about,
                owner: normalizeViewerId(source.owner || 'user') || 'user',
                knownBy: knownBy.length ? knownBy : ['user'],
                sensitivity: compact(source.sensitivity || 'normal', 40) || 'normal',
                status: compact(source.status || 'active', 40) || 'active',
                source: compact(source.source || 'explicit-tag', 120) || 'explicit-tag',
                evidenceLog: Array.isArray(source.evidenceLog)
                    ? source.evidenceLog.filter(item => item && typeof item === 'object').map(item => ({
                        turn: Number(item.turn || 0),
                        viewerId: normalizeViewerId(item.viewerId || item.viewer || '') || '',
                        source: compact(item.source || '', 80),
                        note: compact(item.note || '', 180),
                        at: Number(item.at || Date.now())
                    })).slice(-24)
                    : []
            };
            if (!next.id) next.id = buildSecretId(next);
            return next;
        };
        const getActiveSecrets = () => (Array.isArray(state.secrets) ? state.secrets : [])
            .map(normalizeSecret)
            .filter(secret => String(secret.status || 'active').toLowerCase() !== 'archived' && (secret.content || secret.title));
        const loadState = (lorebook = [], options = {}) => {
            const scopeKey = String(options?.scopeKey || options?.scopeId || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            const chatId = String(options?.chatId || getActiveManagedChatId() || '').trim();
            const idx = findManagedScopedEntryIndex(lorebook, COMMENT, scopeKey);
            const entry = idx >= 0 ? lorebook[idx] : null;
            if (!entry) {
                state = makeEmptyState(scopeKey, chatId);
                return state;
            }
            const parsed = parseJsonObject(entry.content || '{}');
            state = {
                ...makeEmptyState(scopeKey, chatId),
                ...parsed,
                scopeKey,
                chatId,
                secrets: (Array.isArray(parsed.secrets) ? parsed.secrets : []).map(normalizeSecret).filter(secret => secret.content || secret.title)
            };
            return state;
        };
        const saveState = (lorebook = [], options = {}) => {
            if (!Array.isArray(lorebook)) return false;
            const scopeKey = String(options?.scopeKey || state.scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            const chatId = String(options?.chatId || state.chatId || getActiveManagedChatId() || '').trim();
            state.scopeKey = scopeKey;
            state.chatId = chatId;
            state.version = VERSION;
            state.secrets = getActiveSecrets();
            const entry = {
                key: buildScopedManagedLoreKey(COMMENT, scopeKey),
                comment: COMMENT,
                content: JSON.stringify(state),
                mode: 'normal',
                insertorder: 6,
                alwaysActive: false
            };
            return upsertManagedScopedEntry(lorebook, COMMENT, entry, scopeKey) >= 0;
        };
        const upsertSecret = (incoming = {}, meta = {}) => {
            const next = normalizeSecret({ ...incoming, source: incoming.source || meta.source || 'explicit-tag' });
            if (!next.content) return { changed: false, secret: null };
            const fingerprint = normalizeKey(`${next.title}|${next.content}|${next.about.join('|')}`);
            const secrets = Array.isArray(state.secrets) ? state.secrets : [];
            const idx = secrets.findIndex(secret =>
                String(secret.id || '') === String(next.id || '')
                || normalizeKey(`${secret.title}|${secret.content}|${(secret.about || []).join('|')}`) === fingerprint
            );
            const evidence = {
                turn: Number(meta.turn || 0),
                viewerId: 'user',
                source: compact(meta.source || next.source || 'secret', 80),
                note: compact(meta.note || 'secret registered', 180),
                at: Date.now()
            };
            if (idx >= 0) {
                const merged = normalizeSecret({
                    ...secrets[idx],
                    ...next,
                    knownBy: dedupeTextArray([...(secrets[idx].knownBy || []), ...(next.knownBy || [])]),
                    evidenceLog: [...(secrets[idx].evidenceLog || []), evidence]
                });
                const changed = JSON.stringify(secrets[idx]) !== JSON.stringify(merged);
                secrets[idx] = merged;
                state.secrets = secrets;
                return { changed, secret: merged };
            }
            next.evidenceLog = [...(next.evidenceLog || []), evidence].slice(-24);
            state.secrets = [...secrets, next];
            return { changed: true, secret: next };
        };
        const parseSecretBlocks = (text = '') => {
            const blocks = [];
            String(text || '').replace(SECRET_BLOCK_RE, (full, attrText, body, offset) => {
                const attrs = parseAttributes(attrText || '');
                const knownRaw = pickAttr(attrs, ['알고있음', '알고있는', 'knownby', 'known']);
                blocks.push({
                    full,
                    offset,
                    title: pickAttr(attrs, ['제목', 'title', 'name'], ''),
                    about: splitValues(pickAttr(attrs, ['대상', 'target', 'about'], '')),
                    owner: pickAttr(attrs, ['owner', '소유자'], 'user'),
                    knownBy: knownRaw ? splitValues(knownRaw) : ['user'],
                    sensitivity: pickAttr(attrs, ['sensitivity', '민감도'], 'normal'),
                    content: String(body || '').trim()
                });
                return full;
            });
            return blocks;
        };
        const parseRevealTags = (text = '') => {
            const tags = [];
            String(text || '').replace(REVEAL_TAG_RE, (full, attrText, offset) => {
                const attrs = parseAttributes(attrText || '', { bareKey: 'id' });
                const id = pickAttr(attrs, ['id', 'secretid', 'secret', '비밀'], attrs.id || '');
                const targetRaw = pickAttr(attrs, ['대상', 'target', 'to', 'viewer', '알림대상'], '');
                tags.push({ full, offset, id, targets: splitValues(targetRaw) });
                return full;
            });
            return tags;
        };
        const redactSecretTagsInText = (text = '') => String(text || '')
            .replace(SECRET_BLOCK_RE, REDACTED_SECRET_TEXT)
            .replace(REVEAL_TAG_RE, REVEAL_RECORDED_TEXT);
        const detectImplicitSecretCandidates = (text = '', options = {}) => {
            if (MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return [];
            const role = String(options?.role || '').trim().toLowerCase();
            if (role && !['user', 'human'].includes(role)) return [];
            const lines = redactSecretTagsInText(text)
                .replace(/\r\n/g, '\n')
                .split(/\n+/)
                .map(line => compact(line, 900))
                .filter(Boolean)
                .slice(0, 8);
            const out = [];
            for (const line of lines) {
                if (!IMPLICIT_SECRET_CUE_RE.test(line) || !IMPLICIT_SECRET_BOUNDARY_RE.test(line)) continue;
                out.push({
                    title: '자동 감지 비밀',
                    content: line,
                    about: [],
                    owner: 'user',
                    knownBy: ['user'],
                    sensitivity: 'normal',
                    source: 'implicit-auto'
                });
                if (out.length >= 3) break;
            }
            return out;
        };
        const addKnownBy = (secretId = '', viewers = [], meta = {}) => {
            const normalizedViewers = normalizeViewerList(viewers);
            if (!secretId || normalizedViewers.length === 0) return false;
            const secret = (state.secrets || []).find(item => String(item.id || '') === String(secretId || ''));
            if (!secret) return false;
            const before = new Set(secret.knownBy || []);
            normalizedViewers.forEach(viewer => before.add(viewer));
            const nextKnown = Array.from(before).filter(Boolean);
            const changed = nextKnown.length !== (secret.knownBy || []).length;
            if (!changed) return false;
            secret.knownBy = nextKnown;
            secret.evidenceLog = [
                ...(Array.isArray(secret.evidenceLog) ? secret.evidenceLog : []),
                ...normalizedViewers.map(viewerId => ({
                    turn: Number(meta.turn || 0),
                    viewerId,
                    source: compact(meta.source || 'scene-evidence', 80),
                    note: compact(meta.note || 'secret revealed by scene evidence', 180),
                    at: Date.now()
                }))
            ].slice(-24);
            state.secrets = state.secrets.map(item => item.id === secret.id ? normalizeSecret(secret) : item);
            return true;
        };
        const ingestFromMessages = (messages = [], options = {}) => {
            if (MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return { changed: false, state: safeClone(state) };
            state.scopeKey = String(options?.scopeKey || state.scopeKey || getActiveManagedRuntimeScopeKey() || 'global').trim() || 'global';
            state.chatId = String(options?.chatId || state.chatId || getActiveManagedChatId() || '').trim();
            let changed = false;
            for (const msg of (Array.isArray(messages) ? messages : [])) {
                const role = String(msg?.role || '').trim().toLowerCase();
                const sourceText = String(Utils.getMessageText?.(msg) || msg?.content || '').trim();
                if (!sourceText) continue;
                for (const block of parseSecretBlocks(sourceText)) {
                    const result = upsertSecret({
                        title: block.title,
                        content: block.content,
                        about: block.about,
                        owner: block.owner,
                        knownBy: block.knownBy,
                        sensitivity: block.sensitivity,
                        source: role ? `explicit-tag:${role}` : 'explicit-tag'
                    }, { turn: options.turn, source: role ? `explicit-tag:${role}` : 'explicit-tag', note: 'secret tag captured' });
                    changed = result.changed || changed;
                }
                for (const tag of parseRevealTags(sourceText)) {
                    if (!tag.id) continue;
                    changed = addKnownBy(tag.id, tag.targets, { turn: options.turn, source: role ? `explicit-reveal:${role}` : 'explicit-reveal', note: 'explicit reveal tag captured' }) || changed;
                }
                for (const implicit of detectImplicitSecretCandidates(sourceText, { role })) {
                    const result = upsertSecret(implicit, { turn: options.turn, source: role ? `implicit-auto:${role}` : 'implicit-auto', note: 'conservative implicit secret cue captured' });
                    changed = result.changed || changed;
                }
            }
            return { changed, state: safeClone(state) };
        };
        const ingestFromEntities = (entities = [], options = {}) => {
            if (MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return { changed: false, count: 0 };
            let changed = false;
            let count = 0;
            for (const entity of (Array.isArray(entities) ? entities : [])) {
                const name = String(entity?.name || '').trim();
                const secrets = [
                    ...(Array.isArray(entity?.background?.secrets) ? entity.background.secrets : []),
                    ...(Array.isArray(entity?.secrets) ? entity.secrets : []),
                    ...(Array.isArray(entity?.privateKnowledge) ? entity.privateKnowledge : [])
                ].map(value => String(value || '').trim()).filter(Boolean);
                for (const secretText of secrets.slice(0, 12)) {
                    const result = upsertSecret({
                        title: name ? `${name} 비공개 사실` : '비공개 사실',
                        content: secretText,
                        about: name ? [name] : [],
                        owner: 'user',
                        knownBy: ['user'],
                        source: options.source || 'entity-secret-field'
                    }, { turn: options.turn, source: options.source || 'entity-secret-field', note: 'entity secret field protected' });
                    if (result.changed) {
                        changed = true;
                        count += 1;
                    }
                }
            }
            return { changed, count };
        };
        const viewerSetFor = (viewerId = '') => {
            const normalized = normalizeViewerId(viewerId);
            const set = new Set([normalized].filter(Boolean));
            if (normalized === 'user') set.add('player');
            return set;
        };
        const isAllowedForViewer = (secret = {}, viewerId = '') => {
            const normalized = normalizeViewerId(viewerId);
            if (!normalized) return false;
            const known = new Set(normalizeViewerList(secret.knownBy || []));
            for (const alias of viewerSetFor(normalized)) {
                if (known.has(alias)) return true;
            }
            return false;
        };
        const replaceLiteral = (text = '', value = '', replacement = REDACTED_SECRET_TEXT) => {
            const source = String(text || '');
            const raw = String(value || '').trim();
            if (!raw || raw.length < 3 || !source) return source;
            return source.replace(new RegExp(escapeRegex(raw), 'gi'), replacement);
        };
        const redactForViewer = (text = '', viewerId = 'planner', options = {}) => {
            if (MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return String(text || '');
            let out = redactSecretTagsInText(text);
            const viewer = normalizeViewerId(viewerId || 'planner') || 'planner';
            for (const secret of getActiveSecrets()) {
                if (isAllowedForViewer(secret, viewer)) continue;
                out = replaceLiteral(out, secret.content, options.replacement || REDACTED_SECRET_TEXT);
                out = replaceLiteral(out, secret.title, options.replacement || '[비밀 제목 비공개]');
            }
            return out;
        };
        const redactPayloadForViewer = (value, viewerId = 'planner') => {
            if (typeof value === 'string') return redactForViewer(value, viewerId);
            if (Array.isArray(value)) return value.map(item => redactPayloadForViewer(item, viewerId));
            if (value && typeof value === 'object') {
                const next = {};
                for (const [key, nested] of Object.entries(value)) {
                    const loweredKey = String(key || '').trim().toLowerCase();
                    if (/(?:^|[_.-])(secrets?|privateSecrets?|hiddenSecrets?)(?:$|[_.-])/i.test(loweredKey) || loweredKey === 'secrets') {
                        next[key] = Array.isArray(nested) ? [] : '[비밀 필드 비공개]';
                        continue;
                    }
                    next[key] = redactPayloadForViewer(nested, viewerId);
                }
                return next;
            }
            return value;
        };
        const redactMessages = (messages = [], viewerId = 'main_request') => (Array.isArray(messages) ? messages : []).map(msg => ({
            ...msg,
            content: redactForViewer(String(msg?.content ?? Utils.getMessageText?.(msg) ?? ''), viewerId)
        }));
        const getKnownSecretsForViewer = (viewerId = '') => getActiveSecrets().filter(secret => isAllowedForViewer(secret, viewerId));
        const getHiddenSecretsForViewer = (viewerId = '') => getActiveSecrets().filter(secret => !isAllowedForViewer(secret, viewerId));
        const buildSecrecyGuardPrompt = (options = {}) => {
            if (MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return '';
            const viewerId = normalizeViewerId(options.viewerId || 'main_request') || 'main_request';
            const hidden = getHiddenSecretsForViewer(viewerId);
            if (!hidden.length) return '';
            const focusNames = dedupeTextArray((Array.isArray(options.focusNames) ? options.focusNames : [])
                .map(item => typeof item === 'string' ? item : item?.name)
                .map(item => compact(item, 80))
                .filter(Boolean)).slice(0, 8);
            const aboutCounts = new Map();
            hidden.forEach(secret => {
                const about = Array.isArray(secret.about) && secret.about.length ? secret.about : ['unscoped'];
                about.slice(0, 3).forEach(item => aboutCounts.set(item, (aboutCounts.get(item) || 0) + 1));
            });
            const aboutLine = Array.from(aboutCounts.entries()).slice(0, 8).map(([name, count]) => `${name}:${count}`).join(', ');
            return [
                '[비밀 유지 / Secrecy Guard]',
                `${hidden.length} protected undisclosed fact(s) exist outside the active viewer knowledge.`,
                focusNames.length ? `Active focus: ${focusNames.join(', ')}` : '',
                aboutLine ? `Protected scopes: ${aboutLine}` : '',
                'Do not reveal, paraphrase, hint, infer, or let any character act on protected information unless the scene explicitly made that character a knower.',
                'Characters may react only to visible behavior, shared/public facts, or facts explicitly told to them in-scene.',
                'Hidden facts may affect long-term continuity bookkeeping, but must not surface as dialogue, narration, body reaction, or decision.'
            ].filter(Boolean).join('\n');
        };
        const buildCharacterKnowledgeBoundaryPrompt = (focusNames = []) => {
            if (MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return '';
            const names = dedupeTextArray((Array.isArray(focusNames) ? focusNames : [])
                .map(item => typeof item === 'string' ? item : item?.name)
                .map(item => compact(item, 80))
                .filter(Boolean)).slice(0, 8);
            if (!names.length || !getActiveSecrets().length) return '';
            const lines = names.map(name => {
                const viewerId = entityViewerId(name);
                const known = getKnownSecretsForViewer(viewerId).length;
                const hidden = getHiddenSecretsForViewer(viewerId).length;
                return `- ${name}: known protected facts=${known}; hidden facts=${hidden}. Speak and act only from known facts plus visible scene evidence.`;
            });
            lines.push('- If a fact is in LIBRA memory but not visible to a character, that character must not reveal it through dialogue, narration, body reaction, or decision.');
            return ['[Character Knowledge Boundaries]', ...lines].join('\n');
        };
        const tokenizeAuditText = (value = '', limit = 48) => dedupeTextArray(String(value || '')
            .normalize('NFKC')
            .toLowerCase()
            .split(/[^0-9a-z가-힣]+/iu)
            .map(token => token.trim())
            .filter(token => token.length >= 2 && token.length <= 32 && !STOPWORDS.has(token))
        ).slice(0, Math.max(4, Number(limit || 48)));
        const splitAuditSentences = (value = '') => String(value || '')
            .split(/\n+/)
            .flatMap(line => {
                const trimmed = line.trim();
                if (!trimmed) return [];
                return trimmed.match(/[^.!?。！？]+[.!?。！？]?/gu) || [trimmed];
            })
            .map(part => part.trim())
            .filter(Boolean)
            .slice(0, 140);
        const auditResponseForLeaks = (text = '', options = {}) => {
            const source = String(text || '');
            if (!source || MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return { changed: false, text: source, leaks: [], checked: false };
            const viewer = normalizeViewerId(options.viewerId || 'main_request') || 'main_request';
            const replacement = String(options.replacement || '말해지지 않은 사실').trim() || '말해지지 않은 사실';
            const sentenceReplacement = String(options.sentenceReplacement || '그 사실은 겉으로 드러나지 않았다.').trim() || '그 사실은 겉으로 드러나지 않았다.';
            let out = source;
            const leaks = [];
            for (const secret of getHiddenSecretsForViewer(viewer)) {
                const before = out;
                const content = String(secret.content || '').trim();
                const title = compact(secret.title || '', 120);
                if (content.length >= 8 && normalizeKey(out).includes(normalizeKey(content))) out = replaceLiteral(out, content, replacement);
                if (!/^(?:자동 감지 비밀|protected secret|known secret|secret|비밀)$/i.test(title) && title.length >= 6 && normalizeKey(out).includes(normalizeKey(title))) out = replaceLiteral(out, title, '숨겨진 사실');
                if (out !== before) {
                    leaks.push({ id: secret.id || '', kind: 'literal', title, about: Array.isArray(secret.about) ? secret.about.slice(0, 4) : [] });
                    continue;
                }
                const recordTokens = tokenizeAuditText(content, 48);
                if (recordTokens.length < 4) continue;
                for (const sentence of splitAuditSentences(out)) {
                    const sentenceTokens = new Set(tokenizeAuditText(sentence, 64));
                    const matched = recordTokens.filter(token => sentenceTokens.has(token));
                    const hitRatio = matched.length / Math.max(1, Math.min(recordTokens.length, 12));
                    const cueHit = /(?:비밀|진실|정체|사실은|숨기|감추|몰랐|알고 있었|secret|truth|identity|hidden|knew)/i.test(sentence);
                    if (!(matched.length >= 4 && hitRatio >= 0.42) && !(matched.length >= 3 && hitRatio >= 0.34 && cueHit)) continue;
                    const next = out.replace(sentence, sentenceReplacement);
                    if (next === out) continue;
                    out = next;
                    leaks.push({ id: secret.id || '', kind: 'semantic_sentence', title, matchedTokens: matched.slice(0, 8), hitRatio: Number(hitRatio.toFixed(3)) });
                    break;
                }
            }
            return { changed: out !== source, text: out, leaks, checked: true, viewerId: viewer };
        };
        const applySceneEvidenceReveal = (options = {}) => {
            if (MemoryEngine?.CONFIG?.secretKnowledgeEnabled === false) return { changed: false };
            const texts = (Array.isArray(options.texts) ? options.texts : [options.text])
                .map(text => redactSecretTagsInText(text))
                .map(normalizeLoose)
                .filter(Boolean);
            const focusViewers = normalizeViewerList((Array.isArray(options.focusNames) ? options.focusNames : []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean));
            if (!texts.length || !focusViewers.length) return { changed: false };
            let changed = false;
            for (const text of texts) {
                if (!DIRECT_REVEAL_RE.test(text)) continue;
                const haystack = normalizeKey(text);
                for (const secret of getActiveSecrets()) {
                    const contentKey = normalizeKey(secret.content);
                    const titleKey = normalizeKey(secret.title);
                    const contentHit = contentKey.length >= 6 && haystack.includes(contentKey);
                    const titleHit = titleKey.length >= 3 && haystack.includes(titleKey) && /비밀|secret|진실|fact|사실/i.test(text);
                    if (!contentHit && !titleHit) continue;
                    changed = addKnownBy(secret.id, focusViewers, { turn: options.turn, source: 'scene-evidence', note: 'direct visible reveal wording matched' }) || changed;
                }
            }
            return { changed, state: safeClone(state) };
        };
        const listSecrets = () => getActiveSecrets().map(secret => ({
            id: secret.id,
            title: secret.title,
            content: secret.content,
            about: secret.about || [],
            owner: secret.owner || 'user',
            knownBy: secret.knownBy || [],
            sensitivity: secret.sensitivity || 'normal',
            status: secret.status || 'active',
            evidenceLog: Array.isArray(secret.evidenceLog) ? secret.evidenceLog.slice(-8) : []
        }));
        const deleteSecret = (secretId = '') => {
            const id = String(secretId || '').trim();
            if (!id) return false;
            const before = Array.isArray(state.secrets) ? state.secrets.length : 0;
            state.secrets = (Array.isArray(state.secrets) ? state.secrets : []).filter(secret => String(secret?.id || '') !== id);
            return state.secrets.length !== before;
        };
        const manualReveal = (secretId = '', viewer = '', meta = {}) => addKnownBy(secretId, [viewer], { ...meta, source: meta?.source || 'manual-reveal', note: meta?.note || 'manual reveal' });
        const renameEntityReferences = (options = {}) => {
            const oldName = compact(options.oldName || '', 80);
            const newName = compact(options.newName || '', 80);
            const oldViewerId = String(options.oldViewerId || '').trim();
            const newViewerId = String(options.newViewerId || '').trim();
            if (!oldName || !newName || !oldViewerId || !newViewerId || oldViewerId === newViewerId) return { changed: false };
            const oldNameKeys = new Set([oldName, ...(Array.isArray(options.previousNames) ? options.previousNames : [])]
                .map(normalizeKey)
                .filter(Boolean));
            const replaceViewer = (value = '') => String(value || '').trim() === oldViewerId ? newViewerId : String(value || '').trim();
            let changed = false;
            state.secrets = (Array.isArray(state.secrets) ? state.secrets : []).map(secret => {
                const next = { ...secret };
                const about = Array.isArray(next.about) ? next.about : [];
                const nextAbout = dedupeTextArray(about.map(item => oldNameKeys.has(normalizeKey(item)) ? newName : item).filter(Boolean)).slice(0, 12);
                if (JSON.stringify(nextAbout) !== JSON.stringify(about)) changed = true;
                next.about = nextAbout;
                const nextOwner = replaceViewer(next.owner || '');
                if (nextOwner !== next.owner) changed = true;
                next.owner = nextOwner || next.owner;
                const knownBy = Array.isArray(next.knownBy) ? next.knownBy : [];
                const nextKnownBy = dedupeTextArray(knownBy.map(replaceViewer).filter(Boolean));
                if (JSON.stringify(nextKnownBy) !== JSON.stringify(knownBy)) changed = true;
                next.knownBy = nextKnownBy;
                if (Array.isArray(next.evidenceLog)) {
                    next.evidenceLog = next.evidenceLog.map(item => {
                        if (!item || typeof item !== 'object') return item;
                        const viewerId = replaceViewer(item.viewerId || '');
                        if (viewerId !== item.viewerId) changed = true;
                        return { ...item, viewerId };
                    });
                }
                return next;
            });
            if (changed) state.secrets = state.secrets.map(normalizeSecret);
            return { changed };
        };
        const getState = () => state;
        const resetState = (next = null) => {
            state = next && typeof next === 'object'
                ? { ...makeEmptyState(next.scopeKey, next.chatId), ...safeClone(next), secrets: (Array.isArray(next.secrets) ? next.secrets : []).map(normalizeSecret) }
                : makeEmptyState();
            return state;
        };
        const selfCheck = () => ({
            ok: true,
            core: 'SecretKnowledgeCore',
            comment: COMMENT,
            enabled: MemoryEngine?.CONFIG?.secretKnowledgeEnabled !== false,
            secrets: getActiveSecrets().length,
            scopeKey: state.scopeKey || ''
        });
        return Object.freeze({
            COMMENT,
            REDACTED_SECRET_TEXT,
            loadState,
            saveState,
            ingestFromMessages,
            ingestFromEntities,
            redactForViewer,
            redactPayloadForViewer,
            redactMessages,
            buildSecrecyGuardPrompt,
            buildCharacterKnowledgeBoundaryPrompt,
            auditResponseForLeaks,
            applySceneEvidenceReveal,
            getKnownSecretsForViewer,
            getHiddenSecretsForViewer,
            entityViewerId,
            listSecrets,
            deleteSecret,
            manualReveal,
            renameEntityReferences,
            getState,
            resetState,
            selfCheck
        });
    })();

