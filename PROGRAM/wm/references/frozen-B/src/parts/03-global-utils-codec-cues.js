    // ══════════════════════════════════════════════════════════════
    // [UTILITY] Global Utilities
    // ══════════════════════════════════════════════════════════════
    const showLibraDialog = ({ message = '', title = 'LIBRA', kind = 'confirm' } = {}) => new Promise(resolve => {
        if (typeof document === 'undefined' || !document.body) {
            resolve(kind === 'alert');
            return;
        }

        const prior = document.querySelector('[data-libra-dialog="true"]');
        if (prior) prior.remove();

        const backdrop = document.createElement('div');
        backdrop.setAttribute('data-libra-dialog', 'true');
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:18px;font-family:var(--risu-font-family,Segoe UI,system-ui,sans-serif);color:var(--risu-theme-textcolor,#e8e8ef);';

        const box = document.createElement('div');
        box.style.cssText = 'width:min(92vw,420px);background:var(--risu-theme-bgcolor,#1a1a2e);border:1px solid var(--risu-theme-borderc,#3b3b5c);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.45);padding:18px;display:flex;flex-direction:column;gap:14px;';

        const heading = document.createElement('div');
        heading.textContent = title;
        heading.style.cssText = 'font-size:14px;font-weight:700;line-height:1.45;';

        const body = document.createElement('div');
        body.textContent = String(message || '');
        body.style.cssText = 'white-space:pre-wrap;font-size:13px;line-height:1.55;color:var(--risu-theme-textcolor,#e8e8ef);';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;';

        const close = (value) => {
            document.removeEventListener('keydown', onKeyDown, true);
            backdrop.remove();
            resolve(value);
        };

        const makeButton = (text, primary = false) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.style.cssText = primary
                ? 'min-height:34px;padding:7px 14px;border:0;border-radius:8px;background:var(--risu-theme-primary-600,var(--risu-theme-borderc,#6a44a0));color:#fff;cursor:pointer;font-size:13px;'
                : 'min-height:34px;padding:7px 14px;border:1px solid var(--risu-theme-borderc,#3b3b5c);border-radius:8px;background:transparent;color:var(--risu-theme-textcolor,#e8e8ef);cursor:pointer;font-size:13px;';
            return button;
        };

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close(kind === 'alert');
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                close(true);
            }
        };

        if (kind === 'confirm') {
            const cancel = makeButton('취소');
            cancel.onclick = () => close(false);
            actions.appendChild(cancel);
        }

        const ok = makeButton(kind === 'confirm' ? '확인' : '확인', true);
        ok.onclick = () => close(true);
        actions.appendChild(ok);

        box.appendChild(heading);
        box.appendChild(body);
        box.appendChild(actions);
        backdrop.appendChild(box);
        document.body.appendChild(backdrop);
        document.addEventListener('keydown', onKeyDown, true);
        setTimeout(() => ok.focus(), 0);
    });

    const Utils = {
        confirmEx: (msg) => showLibraDialog({ message: msg, title: '확인', kind: 'confirm' }),
        alertEx: (msg) => showLibraDialog({ message: msg, title: '알림', kind: 'alert' }),
        sleep: (ms) => new Promise(res => setTimeout(res, ms)),

        /**
         * LLM 사고/필터 태그 제거 (프로바이더 공통)
         * <thoughts>, <thinking>, <__filter_complete__> 등 LLM 내부 추론 태그를 제거
         */
        stripLLMThinkingTags: (text) => {
            if (!text) return text;
            let clean = String(text);
            clean = clean.replace(/<thoughts>[\s\S]*?<\/thoughts>/gi, '');
            clean = clean.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
            clean = clean.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
            clean = clean.replace(/<(?:analysis|reasoning)\b[^>]*>[\s\S]*?<\/(?:analysis|reasoning)>/gi, '');
            clean = clean.replace(/<__filter_complete__>[\s\S]*?<\/__filter_complete__>/gi, '');
            clean = clean.replace(/<__filter_complete__\s*\/?>/gi, '');
            // 닫히지 않은 사고 태그 제거 (LLM 출력이 잘린 경우)
            clean = clean.replace(/<thoughts>[\s\S]*$/gi, '');
            clean = clean.replace(/<thinking>[\s\S]*$/gi, '');
            clean = clean.replace(/<think\b[^>]*>[\s\S]*$/gi, '');
            clean = clean.replace(/<(?:analysis|reasoning)\b[^>]*>[\s\S]*$/gi, '');
            return clean;
        },

        stripManagedModuleTags: (text) => {
            if (!text) return text;
            let clean = String(text);
            clean = clean.replace(/<GT-CTRL\b[^>]*\/>/gi, '');
            clean = clean.replace(/<GT-SEP\/>/gi, '');
            clean = clean.replace(/<GigaTrans\b[^>]*>[\s\S]*?<\/GigaTrans>/gi, '');
            clean = clean.replace(/<\/GigaTrans>/gi, '');
            clean = clean.replace(/<GigaTrans\b[^>]*>/gi, '');
            clean = clean.replace(/<dag_runtime_contract\b[^>]*>[\s\S]*?<\/dag_runtime_contract>/gi, '');
            clean = clean.replace(/<dag_runtime_contract\b[^>]*>[\s\S]*$/gi, '');
            // Hidden side-write packets from companion modules must never become LIBRA memory/turn evidence.
            // Strip only known managed packet comments. Ordinary prose/code HTML comments are preserved.
            const managedCommentMarker = '(?:HAYAKU_STATE_PACKET_START|HAYAKU_[A-Z0-9_]+_START|LIBRA_STATE|LIBRA_[A-Z0-9_]+_START|RAW_VAULT(?:_[A-Z0-9_]+)?_START|RAW_VAULT|LOKI_MEMORY_LEDGER_START)';
            clean = clean.replace(new RegExp(`<!--[\\s\\S]{0,240}${managedCommentMarker}[\\s\\S]*?-->`, 'gi'), '');
            clean = clean.replace(new RegExp(`<!--[\\s\\S]{0,240}${managedCommentMarker}[\\s\\S]*$`, 'gi'), '');
            return clean;
        },

        // Risu presets and modules may wrap the visible story with translation,
        // reasoning, status, option, and post-response scaffolding. Keep the
        // displayed response untouched; strip these artifacts only from LIBRA's
        // private analysis/memory source so UI contracts never become canon.
        stripPresetOutputScaffolding: (text) => {
            if (!text) return text;
            let clean = String(text).replace(/\r\n?/g, '\n');
            // Closed, explicitly non-narrative blocks only. State/secret blocks
            // such as <stats>, NPC_LIST comments, hidden prose, and dice are
            // deliberately preserved for their dedicated trackers.
            const metaBlockTags = '(?:checklist|tip|AOS|RP-Guide|rp_guide)';
            clean = clean.replace(new RegExp(`(?:^|\\n)[ \\t]*<${metaBlockTags}\\b[^>]*>[\\s\\S]*?<\\/${metaBlockTags}>[ \\t]*(?=\\n|$)`, 'gi'), '\n');
            // Remove helper sections only when a paired primary story heading
            // gives us a safe closing boundary. Incomplete sections are kept.
            clean = clean.replace(/(?:^|\n)\s*#{2,6}\s*(?:Outline|개요|概要)(?=\s|:|$)[^\n]*\n[\s\S]*?(?=\n\s*#{2,6}\s*(?:Narrative|이야기|物語)(?=\s|:|$))/gi, '\n');
            clean = clean.replace(/(?:^|\n)\s*#{2,6}\s*(?:Input\s+Translation|인풋\s*번역|입력\s*번역|インプット翻訳|入力翻訳)(?=\s|:|$)[^\n]*\n[\s\S]*?(?=\n\s*#{1,6}\s*(?:Input\s+Enhancement|인풋\s*개선|입력\s*개선|インプット改善|入力強化|Narrative|이야기|物語|Response|응답|応答)(?=\s|:|$))/gi, '\n');
            clean = clean.replace(/(?:^|\n)\s*#{2,6}\s*(?:Input\s+Enhancement|인풋\s*개선|입력\s*개선|インプット改善|入力強化)(?=\s|:|$)[^\n]*\n[\s\S]*?(?=\n\s*#{1,6}\s*(?:Narrative|이야기|物語|Response|응답|応答)(?=\s|:|$))/gi, '\n');
            const primaryHeadingSeen = /(?:^|\n)\s*#{1,6}\s*(?:Response|응답|応答|Narrative|이야기|物語)(?=\s|:|$)/i.test(clean);
            if (primaryHeadingSeen) {
                clean = clean.replace(/(?:\n|^)\s*#{1,6}\s*(?:Post[- ]?response|사후\s*응답|事後応答)(?=\s|:|$)[\s\S]*$/i, '\n');
            }
            clean = clean.replace(/(?:^|\n)\s*#{1,6}\s*(?:Response|응답|応答|Narrative|이야기|物語)\s*:?[ \t]*(?=\n|$)/gi, '\n');
            clean = clean.replace(/(?:^|\n)\s*####\s+Chatindex:\s*\d+\s*∮?\s*(?=\n|$)/gi, '\n');
            clean = clean.replace(/(?:^|\n)\s*\[✨Upcoming characters\|[^\]\r\n]*\]\s*(?=\n|$)/gi, '\n');
            clean = clean.replace(/\n?【Evaluation:[^\n】]*】\s*$/i, '');
            return clean.replace(/\n{3,}/g, '\n\n').trim();
        },

        sanitizeForLibra: (text) => {
            if (!text) return text;
            let clean = Utils.stripLLMThinkingTags(text);
            clean = Utils.stripManagedModuleTags(clean);
            clean = Utils.stripPresetOutputScaffolding(clean);
            
            const result = clean.trim();
            if (isLibraDebugEnabled() && result !== text.trim()) {
                recordRuntimeDebug('log', `[LIBRA] Text sanitized (Module compatibility active)`);
            }
            return result;
        },

        getMessageText: (msg) => {
            if (!msg || typeof msg !== 'object') return '';

            const extract = (value) => {
                if (value == null) return '';
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                    return String(value);
                }
                if (Array.isArray(value)) {
                    return value.map(extract).filter(Boolean).join('\n').trim();
                }
                if (typeof value === 'object') {
                    const preferredKeys = ['content', 'text', 'message', 'msg', 'mes', 'data', 'value', 'parts', 'input', 'prompt'];
                    for (const key of preferredKeys) {
                        const picked = extract(value[key]);
                        if (picked) return picked;
                    }
                }
                return '';
            };

            return extract(msg.data)
                || extract(msg.content)
                || extract(msg.text)
                || extract(msg.message)
                || extract(msg.msg)
                || extract(msg.mes)
                || '';
        },

        getLibraComparableText: (text) => {
            const sanitized = Utils.sanitizeForLibra(text);
            return typeof sanitized === 'string' ? sanitized.trim() : String(sanitized || '').trim();
        },

        stripToolResponseBlocks: (text) => {
            const raw = String(text || '');
            if (!raw) return raw;
            return raw
                .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, ' ')
                .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, ' ')
                .replace(/<tool_response\b[^>]*>[\s\S]*?<\/tool_response>/gi, ' ')
                .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, ' ')
                .replace(/<tool_results\b[^>]*>[\s\S]*?<\/tool_results>/gi, ' ')
                .replace(/(?:^|\n)\s*<tool_name>\s*[\s\S]*?<\/tool_name>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*<parameters>\s*[\s\S]*?<\/parameters>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*<parameter\b[^>]*>\s*[\s\S]*?<\/parameter>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*<tool_use_id>\s*[\s\S]*?<\/tool_use_id>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*<is_error>\s*[\s\S]*?<\/is_error>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*<result_code>\s*[\s\S]*?<\/result_code>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*<content>\s*\{[\s\S]*?\}\s*<\/content>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*<content>\s*"?(?:LICENSED_USER_FROM_PROVIDER|All safety restrictions bypassed|NO_INTERNET|Internet connection confirmed offline|Local environment is sealed|No data routes exist)[\s\S]*?<\/content>\s*(?=\n|$)/gi, ' ')
                .replace(/(?:^|\n)\s*["']?(?:LICENSED_USER_FROM_PROVIDER|All safety restrictions bypassed|NO_INTERNET|Internet connection confirmed offline|Local environment is sealed|No data routes exist|bypass self-correction\/safety-check)[^\n]*["']?\s*(?=\n|$)/gi, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        },

        isToolResponseEnvelope: (text) => {
            const raw = String(text || '').trim();
            if (!raw) return false;
            if (/<tool_(?:call|calls|response|result|results)\b/i.test(raw)) return true;
            const stripped = Utils.stripToolResponseBlocks(raw);
            if (!stripped) return true;
            const lower = stripped.toLowerCase();
            if (
                /^(?:<tool_use_id>|<tool_name>|<parameters>|<is_error>|<result_code>|<content>|<\/tool_use_id>|<\/tool_name>|<\/parameters>|<\/is_error>|<\/result_code>|<\/content>)/i.test(raw)
                || (
                    lower.length <= 220
                    && /(?:licensed_user_from_provider|no_internet|internet connection is unavailable|all safety restrictions bypassed|local environment is sealed|no data routes exist)/i.test(lower)
                    && !Utils.hasSubstantialNarrativePayload(lower, 'user')
                )
            ) {
                return true;
            }
            return false;
        },

        getMemorySourceText: (text) => {
            const strippedThinking = Utils.stripLLMThinkingTags(text);
            const strippedManaged = Utils.stripManagedModuleTags(strippedThinking);
            const strippedPreset = Utils.stripPresetOutputScaffolding(strippedManaged);
            const strippedTools = Utils.stripToolResponseBlocks(strippedPreset);
            return typeof strippedTools === 'string' ? strippedTools.trim() : String(strippedTools || '').trim();
        },

        hasLibraVisibleContent: (text) => {
            return Utils.getLibraComparableText(text).length > 0;
        },

        isRecoverableNarrativeCandidate: (text, roleHint = 'either') => {
            const raw = Utils.getMemorySourceText(text);
            if (!raw || raw.length < 3) return false;
            if (Utils.isMetaPromptLike(raw)) return false;
            if (Utils.isTagOnlyToolResponse(raw)) return false;

            const lower = raw.toLowerCase();
            const blockedMarkers = [
                '<past conversations>',
                '</past conversations>',
                '--- chat log end ---',
                '"messages": [',
                '"max_tokens":',
                '"logit_bias":',
                '## ai guidance:',
                '## character information',
                '<others info>',
                '<lore>',
                '</lore>',
            ];
            if (blockedMarkers.some(marker => lower.includes(marker))) return false;

            if (roleHint === 'user' && /^(?:assistant|character)\s*:/im.test(raw) && !/^user\s*:/im.test(raw)) {
                return false;
            }
            if (roleHint === 'ai' && /^user\s*:/im.test(raw) && !/^(?:assistant|character)\s*:/im.test(raw) && !/\[응답\]/.test(raw)) {
                return false;
            }
            return true;
        },

        scoreNarrativeCandidate: (text, roleHint = 'either') => {
            const raw = Utils.getMemorySourceText(text);
            if (!Utils.isRecoverableNarrativeCandidate(raw, roleHint)) return -Infinity;

            const lower = raw.toLowerCase();
            let score = 0;

            score += Math.min(8, Math.floor(raw.length / 180));
            if (/\n/.test(raw)) score += 2;
            if (/["“”]|'.+?'/.test(raw)) score += 2;
            if (/⏱️|\[사용자\]|\[응답\]|^user\s*:|^(assistant|character)\s*:/im.test(raw)) score += 3;
            if (/<current input>/i.test(raw)) score -= 2;
            if (/\bjson\b|logit_bias|max_tokens|stream\s*:\s*true/i.test(lower)) score -= 6;
            if (/##\s*ai guidance:|##\s*character information|<others info>|<lore>/i.test(raw)) score -= 6;
            if (roleHint === 'user' && /^user\s*:/im.test(raw)) score += 2;
            if (roleHint === 'ai' && /^(assistant|character)\s*:/im.test(raw)) score += 2;
            if (roleHint === 'ai' && /⏱️|chatindex|@hidden spoiler@|# response/i.test(raw)) score += 3;

            return score;
        },

        extractNarrativePayload: (text, roleHint = 'either') => {
            const raw = Utils.getMemorySourceText(text);
            if (!raw) return '';
            if (!Utils.isMetaPromptLike(raw) && !Utils.isTagOnlyToolResponse(raw)) {
                return raw;
            }

            const seen = new Set();
            const candidates = [];
            const pushCandidate = (value) => {
                const candidate = Utils.getMemorySourceText(value);
                if (!candidate) return;
                const normalized = candidate.trim();
                if (!normalized || seen.has(normalized)) return;
                seen.add(normalized);
                candidates.push(normalized);
            };

            const tagged = Utils.splitTaggedTurn(raw);
            if (roleHint !== 'ai') pushCandidate(tagged.user);
            if (roleHint !== 'user') pushCandidate(tagged.ai);

            const currentInputMatch = raw.match(/<Current Input>\s*```([\s\S]*?)```\s*<\/Current Input>/i);
            pushCandidate(currentInputMatch?.[1] || '');

            const userMatch = raw.match(/(?:^|\n)\s*USER:\s*"([\s\S]*?)"\s*(?=\n\s*(?:CHARACTER:|ASSISTANT:|SYSTEM:|$))/i);
            if (roleHint !== 'ai') pushCandidate(userMatch?.[1] || '');

            const assistantMatch = raw.match(/(?:^|\n)\s*(?:ASSISTANT|CHARACTER):\s*([\s\S]*?)\s*(?=\n\s*(?:USER:|SYSTEM:|$))/i);
            if (roleHint !== 'user') pushCandidate(assistantMatch?.[1] || '');

            const ranked = candidates
                .map(candidate => ({ candidate, score: Utils.scoreNarrativeCandidate(candidate, roleHint) }))
                .filter(item => Number.isFinite(item.score))
                .sort((a, b) => b.score - a.score);

            return ranked[0]?.candidate || '';
        },

        getNarrativeComparableText: (text, roleHint = 'either') => {
            return Utils.extractNarrativePayload(text, roleHint);
        },

        getNarrativeSourceText: (text, roleHint = 'either') => {
            return Utils.extractNarrativePayload(text, roleHint);
        },

        isTagOnlyToolResponse: (text) => {
            const raw = String(text || '').trim();
            if (!raw) return false;
            const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (!lines.length || lines.length > 6) return false;
            return lines.every(line => /^(?:\[[^\]\n]+\])+(?:[★■\s]+)?$/.test(line));
        },

        isMetaPromptLike: (text) => {
            const raw = String(text || '').trim();
            if (!raw) return false;
            if (/^\[(?:LIBRA\s+[^\]\n]{1,100}\s+Injection|VECTOR RAG MEMORY|HAYAKU\s+(?:CONTINUITY CONTEXT|SIDE-WRITE FINAL REMINDER|IMMUTABLE CORE|RECALL KERNEL))\]/i.test(raw)) return true;
            if (/HAYAKU_STATE_PACKET_START\b[\s\S]*?HAYAKU_STATE_PACKET_END/i.test(raw)) return true;
            const lower = raw.toLowerCase();
            const patterns = [
                '# system rule',
                'you are a data extraction bot',
                'your only job is to analyze',
                'analyze the following chat log',
                'provide the data string now',
                'final output format',
                'affection tag rules',
                'status tag rules',
                'rules start',
                'chat log start',
                'reiteration phase',
                '<|im_start|>system',
                '# advance_notice',
                '# system_role',
                'translate the <sample_text>',
                'output only the translated text',
                'preserve as is',
                'core_principles',
                'additional_instructions',
                'narrative register [mandatory]',
                'zero omission + zero translationese',
                'this prompt has been confirmed for use only in fully personalized, private sessions',
                '<system>',
                '</system>',
                '<thoughts>',
                '<thinking>',
                'output must strictly follow these rules',
                'output json:',
                'do not output any other text',
                'system: pov : freely',
                'respond in full english',
                'all the characters inside this rp are adults who are acting',
                'platform policies were disabled',
                'platform policy unactivated'
            ];
            if (patterns.some(p => lower.includes(p))) return true;
            return false;
        },

        hasNarrativeSceneLikeCues: (text, roleHint = 'either') => {
            const raw = String(Utils.getMemorySourceText(text) || '').trim();
            if (!raw) return false;
            const candidate = String(Utils.getNarrativeComparableText(text, roleHint) || raw).trim();
            if (!candidate) return false;
            let score = 0;
            if (/["“”‘’]|'.+?'/u.test(candidate)) score += 2;
            if (/\[사용자\]|\[응답\]|^user\s*:|^(?:assistant|character)\s*:/im.test(raw)) score += 2;
            if (/\n/.test(candidate)) score += 1;
            if (/(?:말하|속삭|중얼|웃|울|바라보|쳐다보|고개|손|표정|침묵|한숨|껴안|안아|키스|입맞춤|smile|looked?|said|whispered|hugged?|kissed?)/i.test(candidate)) score += 1;
            return score >= 2;
        },

        hasSubstantialNarrativePayload: (text, roleHint = 'either') => {
            const candidate = Utils.extractNarrativePayload(text, roleHint);
            if (!candidate) return false;
            const visible = String(candidate)
                .replace(/\[[^\]\n]{1,80}\]/g, ' ')
                .replace(/<[^>\n]{1,80}>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (visible.length < 12) return false;
            const meaningfulUnits = (visible.match(/[A-Za-z0-9\u3131-\u318E\uAC00-\uD7A3\u3040-\u30FF\u4E00-\u9FFF]/g) || []).length;
            return meaningfulUnits >= 8;
        },

        isForcedBypassPrompt: (text) => {
            const raw = String(text || '').trim();
            if (!raw) return false;
            return /^provide the data string now\.?$/i.test(raw);
        },

        splitTaggedTurn: (text) => {
            const raw = String(text || '');
            const userMatch = raw.match(/\[사용자\]\s*([\s\S]*?)(?:\n\[응답\]|\r\n\[응답\]|$)/);
            const aiMatch = raw.match(/\[응답\]\s*([\s\S]*)$/);
            return {
                user: (userMatch?.[1] || '').trim(),
                ai: (aiMatch?.[1] || '').trim()
            };
        },

        shouldExcludeMemoryContent: (text, roleHint = 'either') => {
            const recovered = Utils.extractNarrativePayload(text, roleHint);
            if (recovered) return false;

            const raw = Utils.getLibraComparableText(text);
            if (!raw) return true;
            const tagged = Utils.splitTaggedTurn(raw);
            if (tagged.user || tagged.ai) {
                if (Utils.isMetaPromptLike(tagged.user) || Utils.isMetaPromptLike(tagged.ai)) return true;
                if (Utils.isTagOnlyToolResponse(tagged.ai)) return true;
            }
            if (Utils.isMetaPromptLike(raw)) return true;
            if (Utils.isTagOnlyToolResponse(raw)) return true;
            return false;
        },

        shouldExcludeStoredMemoryContent: (text) => {
            const raw = Utils.getMemorySourceText(text);
            if (!raw || raw.length < 5) return true;
            if (Utils.isMetaPromptLike(raw)) return true;
            if (Utils.isTagOnlyToolResponse(raw)) return true;

            const tagged = Utils.splitTaggedTurn(raw);
            if (tagged.user && Utils.isMetaPromptLike(tagged.user)) return true;
            if (tagged.ai && Utils.isTagOnlyToolResponse(tagged.ai)) return true;
            return false;
        },

        shouldBypassNarrativeSystems: (userText, aiText = '') => {
            const user = Utils.getNarrativeComparableText(userText, 'user');
            const ai = Utils.getNarrativeComparableText(aiText, 'ai');
            const rawUser = Utils.getMemorySourceText(userText);
            const hasNarrativePayload =
                Utils.hasSubstantialNarrativePayload(userText, 'user') ||
                Utils.hasSubstantialNarrativePayload(aiText, 'ai');
            if (!user && !ai && !hasNarrativePayload) return true;
            if (Utils.isForcedBypassPrompt(user) || Utils.isForcedBypassPrompt(rawUser)) return true;
            return false;
        },

        isModelRequestType: (type) => {
            const normalized = String(type || '').trim().toLowerCase();
            return normalized === 'model';
        },

        isNarrativeRequestType: (type) => Utils.isModelRequestType(type)
    };


    // ══════════════════════════════════════════════════════════════
    // [MEMORY] Compact Memory Codec — summary-only durable memory
    // - New lmai_memory entries no longer store full user/assistant prose.
    // - Legacy raw memories are dual-read and migrated to compact JSON.
    // - Search/recall uses summary, anchors, snippets, tags, entity refs, arcKey.
    // ══════════════════════════════════════════════════════════════
