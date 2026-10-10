    const LIBRA_SPEECH_TONE_OPTIONS = [
        { value: '', label: '미지정' },
        { value: 'formal', label: '격식적' },
        { value: 'polite', label: '공손함' },
        { value: 'casual', label: '편안함' },
        { value: 'blunt', label: '직설적' },
        { value: 'playful', label: '장난스러움' },
        { value: 'cold', label: '차가움' },
        { value: 'gentle', label: '부드러움' }
    ];
    const LIBRA_HONORIFIC_STYLE_OPTIONS = [
        { value: '', label: '미지정' },
        { value: 'mostly_honorific', label: '주로 존댓말' },
        { value: 'mostly_casual', label: '주로 반말' },
        { value: 'mixed_by_hierarchy', label: '관계 따라 혼용' },
        { value: 'switches_by_mood', label: '기분 따라 바뀜' }
    ];
    const LIBRA_RELATION_SPEECH_OPTIONS = [
        { value: '', label: '미지정' },
        { value: 'formal_polite', label: '공손한 존댓말' },
        { value: 'measured_polite', label: '차분한 존댓말' },
        { value: 'casual_friendly', label: '편한 반말' },
        { value: 'playful_casual', label: '장난스러운 반말' },
        { value: 'blunt_casual', label: '직설적인 반말' },
        { value: 'gentle_caring', label: '다정하고 부드러움' },
        { value: 'commanding', label: '지시형 말투' }
    ];
    const SPEECH_FIELD_OPTION_MAP = {
        defaultTone: LIBRA_SPEECH_TONE_OPTIONS,
        honorificStyle: LIBRA_HONORIFIC_STYLE_OPTIONS,
        toSuperiors: LIBRA_RELATION_SPEECH_OPTIONS,
        toSubordinates: LIBRA_RELATION_SPEECH_OPTIONS,
        toPeers: LIBRA_RELATION_SPEECH_OPTIONS,
        toYounger: LIBRA_RELATION_SPEECH_OPTIONS
    };
    const normalizeSpeechSelectValue = (options, value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if ((options || []).some(option => option.value === raw)) return raw;
        const lower = raw.toLowerCase().replace(/[\s-]+/g, '_');
        if ((options || []).some(option => option.value === lower)) return lower;
        if (options === LIBRA_SPEECH_TONE_OPTIONS) {
            if (/formal|격식|정중/i.test(raw)) return 'formal';
            if (/polite|공손|존댓|높임/i.test(raw)) return 'polite';
            if (/casual|informal|편안|편한|반말/i.test(raw)) return 'casual';
            if (/blunt|direct|직설|무뚝뚝/i.test(raw)) return 'blunt';
            if (/playful|teas|jok|장난|농담/i.test(raw)) return 'playful';
            if (/cold|cool|차가|냉담/i.test(raw)) return 'cold';
            if (/gentle|soft|warm|부드럽|다정|상냥/i.test(raw)) return 'gentle';
        }
        if (options === LIBRA_HONORIFIC_STYLE_OPTIONS) {
            if (/mood|기분|감정/i.test(raw)) return 'switches_by_mood';
            if (/hierarchy|rank|status|superior|subordinate|관계|서열|상하|위계/i.test(raw)) return 'mixed_by_hierarchy';
            if (/honorific|존댓|높임|polite speech|formal speech/i.test(raw)) return 'mostly_honorific';
            if (/casual|informal|반말/i.test(raw)) return 'mostly_casual';
        }
        if (options === LIBRA_RELATION_SPEECH_OPTIONS) {
            if (/command|order|authoritative|지시|명령/i.test(raw)) return 'commanding';
            if (/gentle|caring|soft|warm|다정|부드럽|상냥/i.test(raw)) return 'gentle_caring';
            if (/playful|teas|jok|장난|농담/i.test(raw)) return 'playful_casual';
            if (/blunt|direct|직설|무뚝뚝/i.test(raw)) return 'blunt_casual';
            if (/measured|calm|reserved|차분|절제/i.test(raw)) return 'measured_polite';
            if (/casual|informal|friendly|friend|편한|친근|반말/i.test(raw)) return 'casual_friendly';
            if (/formal|polite|honorific|격식|공손|존댓|높임/i.test(raw)) return 'formal_polite';
        }
        return raw;
    };
    const normalizeSpeechStyleField = (key, value) => normalizeSpeechSelectValue(SPEECH_FIELD_OPTION_MAP[key] || [], value);
    const normalizeBiologicalSex = (value = '') => {
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        const normalized = raw.toLowerCase().replace(/[\s_\-]+/g, '');
        if (/^(male|m|man|boy|masculine|남성|남자|소년|남학생|남아)$/.test(normalized)) return 'male';
        if (/^(female|f|woman|girl|feminine|여성|여자|소녀|여학생|여아)$/.test(normalized)) return 'female';
        return '';
    };
    const extractBiologicalSexFromEntityPayload = (entity = {}) => {
        const candidates = [
            entity?.sex,
            entity?.biologicalSex,
            entity?.biological_sex,
            entity?.gender,
            entity?.appearance?.sex,
            entity?.appearance?.biologicalSex,
            entity?.profile?.sex
        ];
        for (const candidate of candidates) {
            const normalized = normalizeBiologicalSex(candidate);
            if (normalized) return normalized;
        }
        return '';
    };
    const normalizeSpeechStyleObject = (speechStyle = {}) => {
        const source = speechStyle && typeof speechStyle === 'object' ? speechStyle : {};
        const normalized = {};
        const preservedNotes = Array.isArray(source.notes)
            ? source.notes.map(String).map(v => v.trim()).filter(Boolean)
            : [];
        for (const key of ['defaultTone', 'honorificStyle', 'toSuperiors', 'toSubordinates', 'toPeers', 'toYounger']) {
            const raw = String(source[key] || '').trim();
            const nextValue = normalizeSpeechStyleField(key, raw);
            normalized[key] = nextValue;
            const isKnownValue = !raw || (SPEECH_FIELD_OPTION_MAP[key] || []).some(option => option.value === raw);
            if (raw && nextValue && nextValue !== raw && !isKnownValue) {
                preservedNotes.push(`${key}: ${raw}`);
            }
        }
        normalized.notes = dedupeTextArray(preservedNotes);
        return normalized;
    };
    const unwrapStructuredJsonCarrier = (value) => {
        if (typeof value === 'string') return value;
        if (!value || typeof value !== 'object') return value;
        const keys = Object.keys(value);
        const providerLike = Array.isArray(value.choices)
            || Array.isArray(value.content)
            || Object.prototype.hasOwnProperty.call(value, 'output_text')
            || Object.prototype.hasOwnProperty.call(value, 'generated_text')
            || Object.prototype.hasOwnProperty.call(value, 'completion')
            || (keys.length <= 2 && (typeof value.text === 'string' || typeof value.content === 'string'));
        if (!providerLike) return value;
        const choice = Array.isArray(value.choices) ? value.choices[0] : null;
        const message = choice?.message && typeof choice.message === 'object' ? choice.message : null;
        const candidates = [
            message?.content,
            choice?.text,
            value.output_text,
            value.generated_text,
            value.completion,
            value.text,
            value.content
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) return candidate;
            if (Array.isArray(candidate)) {
                const joined = candidate
                    .map(part => typeof part === 'string' ? part : (part?.text || part?.content || ''))
                    .filter(Boolean)
                    .join('\n');
                if (joined.trim()) return joined;
            }
        }
        return value;
    };

    const UNSAFE_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
    const stripUnsafeJsonKeys = (value, depth = 0) => {
        if (depth > 24) return undefined;
        if (Array.isArray(value)) {
            return value
                .map(item => stripUnsafeJsonKeys(item, depth + 1))
                .filter(item => item !== undefined);
        }
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, nested] of Object.entries(value)) {
                if (UNSAFE_JSON_KEYS.has(key)) continue;
                const cleaned = stripUnsafeJsonKeys(nested, depth + 1);
                if (cleaned !== undefined) out[key] = cleaned;
            }
            return out;
        }
        return value;
    };

        // ── 닫는 괄호가 부족한 응답 복구 ──
        // 실측(2026-09-27, 실제 출하 프롬프트 + 실제 로컬 모델 qwen3.5-9B):
        //   worldAdditional 응답이 최상위 root 의 닫는 '}' 하나를 반복적으로 누락했다.
        //   done=stop 이고 문자열 열림도 없어 내용은 완전했는데, 아래 두 경로가 모두 실패했다.
        //     parseCandidate(cleaned)          → JSON.parse 실패 (누락 괄호를 닫지 않음)
        //     findBalancedJsonValue(cleaned)   → depth > 0 이면 잘린 조각을 그대로 반환하므로
        //                                        여기서는 내부 배열만 추출됐고, 그 결과
        //                                        extractJson 이 계약과 다른 root(배열)를 돌려줬다.
        //   → 호출부(parsed.worldAdditional)가 undefined → 분석 결과가 통째로 버려졌다.
        //   실측 파싱 성공률: worldAdditional 1/8, canonical 3/11 (같은 프롬프트에서 gemma 는 전부 성공).
        //
        // 원칙: **문자열 밖에서 닫는 괄호만 부족한** 경우에만 닫는다.
        //       문자열이 열려 있으면 내용 자체가 잘린 것이므로 없는 내용을 만들어내면 안 된다.
        const closeUnbalancedJson = (source) => {
            const raw = String(source || '').trim();
            if (!raw) return '';
            const stack = [];
            let inString = false;
            let escaped = false;
            for (let i = 0; i < raw.length; i++) {
                const ch = raw[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch === '\\') escaped = true;
                    else if (ch === '"') inString = false;
                    continue;
                }
                if (ch === '"') { inString = true; continue; }
                if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
                else if (ch === '}' || ch === ']') {
                    if (stack.length && stack[stack.length - 1] === ch) stack.pop();
                    else return ''; // 구조가 어긋남 — 여기서 추측하지 않는다
                }
            }
            // 문자열이 열려 있으면 내용이 잘린 것이다. 닫아도 의미 없는 값이 나온다.
            if (inString) return '';
            if (!stack.length) return ''; // 이미 균형 — 복구 불필요
            return raw + stack.reverse().join('');
        };
    const extractJson = (text, options = {}) => {
        if (!text || typeof text !== 'string') return null;
        const cleaned = Utils.stripLLMThinkingTags(text).trim();
        const sanitizeJsonCandidate = (value) => String(value || '')
            .replace(/^\uFEFF/, '')
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/,\s*([}\]])/g, '$1')
            .trim();

        const parseCandidate = (candidate) => {
            const normalized = sanitizeJsonCandidate(candidate);
            if (!normalized) return null;
            try {
                const parsed = JSON.parse(normalized);
                if (typeof parsed === 'string' && /^[\s]*[\[{]/.test(parsed)) {
                    try { return JSON.parse(sanitizeJsonCandidate(parsed)); } catch {}
                }
                return parsed;
            } catch {
                return null;
            }
        };

        const findBalancedJsonValue = (source, openChar = '{', closeChar = '}') => {
            const raw = String(source || '');
            let start = -1;
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let i = 0; i < raw.length; i++) {
                const ch = raw[i];
                if (start < 0) {
                    if (ch === openChar) {
                        start = i;
                        depth = 1;
                    }
                    continue;
                }
                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (ch === '\\') {
                        escaped = true;
                    } else if (ch === '"') {
                        inString = false;
                    }
                    continue;
                }
                if (ch === '"') {
                    inString = true;
                    continue;
                }
                if (ch === openChar) depth += 1;
                else if (ch === closeChar) {
                    depth -= 1;
                    if (depth === 0) return raw.slice(start, i + 1);
                }
            }
            if (start >= 0 && depth > 0) return raw.slice(start);
            return '';
        };
        const findBalancedJsonObject = (source) => findBalancedJsonValue(source, '{', '}');
        const findBalancedJsonArray = (source) => findBalancedJsonValue(source, '[', ']');

        // 닫는 괄호가 부족한 후보를 복구해 파싱한다.
        // 균형 잡힌 앞부분만 남기는 폴백보다 **뒤쪽 내용을 버리지 않는다**는 점이 다르다.
        const parseClosedCandidate = (candidate) => {
            const closed = closeUnbalancedJson(candidate);
            if (!closed) return null;
            return parseCandidate(closed);
        };

        const direct = parseCandidate(cleaned);
        if (direct) return direct;

        const directClosed = parseClosedCandidate(cleaned);
        if (directClosed) return directClosed;

        const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (codeBlock) {
            const parsedCodeBlock = parseCandidate(codeBlock[1]);
            if (parsedCodeBlock) return parsedCodeBlock;
            const closedCodeBlock = parseClosedCandidate(codeBlock[1]);
            if (closedCodeBlock) return closedCodeBlock;
            const balancedCodeBlock = findBalancedJsonObject(codeBlock[1]);
            const repairedCodeBlock = parseCandidate(balancedCodeBlock) || parseClosedCandidate(balancedCodeBlock);
            if (repairedCodeBlock) return repairedCodeBlock;
            const balancedArrayCodeBlock = findBalancedJsonArray(codeBlock[1]);
            const repairedArrayCodeBlock = parseCandidate(balancedArrayCodeBlock) || parseClosedCandidate(balancedArrayCodeBlock);
            if (repairedArrayCodeBlock) return repairedArrayCodeBlock;
        }

        // 산문이 앞에 붙은 경우: 첫 '{' 부터 끝까지를 닫아서 시도한다.
        // findBalancedJsonObject 는 균형이 안 맞으면 내부 조각을 돌려주므로,
        // 그보다 **바깥 전체를 닫는** 쪽을 먼저 시도해야 계약과 같은 root 가 나온다.
        const firstObj = cleaned.indexOf('{');
        if (firstObj > 0) {
            const outerClosed = parseClosedCandidate(cleaned.slice(firstObj));
            if (outerClosed) return outerClosed;
        }

        const balanced = findBalancedJsonObject(cleaned);
        const repairedObject = parseCandidate(balanced) || parseClosedCandidate(balanced);
        if (repairedObject) return repairedObject;
        const balancedArray = findBalancedJsonArray(cleaned);
        return parseCandidate(balancedArray) || parseClosedCandidate(balancedArray) || null;
    };
    const extractStructuredJson = (value, options = {}) => {
        const unwrapped = unwrapStructuredJsonCarrier(value);
        const parsed = extractJson(unwrapped, options) || parseLooseJson(unwrapped);
        return stripUnsafeJsonKeys(parsed);
    };

    const isMeaningfulJsonContractValue = (value, depth = 0) => {
        if (value == null) return false;
        if (typeof value === 'string') {
            const text = value.trim();
            return !!text && !/^(?:none|null|undefined|unknown|n\/a|na|없음|해당 없음|정보 없음|알 수 없음|미상|no change|no changes|unchanged)$/i.test(text);
        }
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value === 'boolean') return true;
        if (Array.isArray(value)) return value.some(item => isMeaningfulJsonContractValue(item, depth + 1));
        if (typeof value === 'object') {
            const keys = Object.keys(value).filter(key => value[key] !== undefined);
            if (keys.length === 0) return false;
            if (depth >= 8) return true;
            return keys.some(key => isMeaningfulJsonContractValue(value[key], depth + 1));
        }
        return false;
    };

    const parseValidatedStructuredJson = (text, expectedKeys = [], options = {}) => {
        const parsed = extractStructuredJson(text);
        if (!parsed || typeof parsed !== 'object') return null;
        if (Array.isArray(parsed)) {
            return options.allowArray === true && parsed.some(item => isMeaningfulJsonContractValue(item)) ? parsed : null;
        }
        const keys = Object.keys(parsed);
        if (keys.length === 0) return null;
        if (!isMeaningfulJsonContractValue(parsed)) return null;
        const expected = (Array.isArray(expectedKeys) ? expectedKeys : [])
            .map(key => String(key || '').trim())
            .filter(Boolean);
        if (expected.length > 0 && !expected.some(key => Object.prototype.hasOwnProperty.call(parsed, key))) return null;
        return parsed;
    };

    const hasObjectShape = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const hasArrayShape = (value) => Array.isArray(value);

