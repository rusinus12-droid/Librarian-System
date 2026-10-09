    const LibraTimeParser = (() => {
        const options = { timezone: 'Asia/Seoul', defaultHour: 9, preserveCurrentTimeForDateOnly: false, weekStartsOn: 1, endOfMonthBias: true };
        const unitMap = { '초': 'seconds', '초간': 'seconds', '분': 'minutes', '시간': 'hours', '시': 'hours', '일': 'days', '주': 'weeks', '주일': 'weeks', '개월': 'months', '달': 'months', '월': 'months', '년': 'years', '해': 'years' };
        const directionMap = { '후': 1, '뒤': 1, '이후': 1, '전': -1, '이전': -1, '앞': -1 };
        const weekdayMap = { '일요일': 0, '월요일': 1, '화요일': 2, '수요일': 3, '목요일': 4, '금요일': 5, '토요일': 6, '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };
        const normalizeInput = (input) => String(input || '').trim().replace(/\s+/g, ' ').replace(/오전\s*/g, '오전 ').replace(/오후\s*/g, '오후 ').replace(/내일모레/g, '모레');
        const formatDateLocal = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const formatTimeLocal = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
        const toTarget = (date) => ({ date: formatDateLocal(date), time: formatTimeLocal(date), iso: date.toISOString(), timestamp: date.getTime() });
        const parseDateText = (value) => {
            const text = compactTimeFieldText(value, 80);
            if (!text) return null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
                const [y, m, d] = text.split('-').map(Number);
                const parsed = new Date(y, m - 1, d, options.defaultHour, 0, 0, 0);
                return Number.isNaN(parsed.getTime()) ? null : parsed;
            }
            if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
                const parsed = new Date(text);
                return Number.isNaN(parsed.getTime()) ? null : parsed;
            }
            let match = text.match(/(\d{1,6})년\s*(\d{1,2})월\s*(\d{1,2})일/);
            if (match) {
                const y = Number(match[1]);
                const m = Number(match[2]);
                const d = Number(match[3]);
                const parsed = new Date(y, m - 1, d, options.defaultHour, 0, 0, 0);
                if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d) return parsed;
            }
            match = text.match(/\b(\d{1,6})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
            if (match) {
                const y = Number(match[1]);
                const m = Number(match[2]);
                const d = Number(match[3]);
                const parsed = new Date(y, m - 1, d, options.defaultHour, 0, 0, 0);
                if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d) return parsed;
            }
            return null;
        };
        const parseTimeText = (value) => {
            const text = compactTimeFieldText(value, 40);
            if (!text) return null;
            let match = text.match(/^(오전|오후)\s*(\d{1,2})(?::|시\s*)?(\d{2})?(?:분)?$/);
            if (match) {
                let hour = Number(match[2]);
                const minute = Number(match[3] || 0);
                if (match[1] === '오후' && hour < 12) hour += 12;
                if (match[1] === '오전' && hour === 12) hour = 0;
                return { hour, minute, second: 0 };
            }
            match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
            if (match) {
                let hour = Number(match[1]);
                const minute = Number(match[2]);
                if (/PM/i.test(match[4]) && hour < 12) hour += 12;
                if (/AM/i.test(match[4]) && hour === 12) hour = 0;
                return { hour, minute, second: Number(match[3] || 0) };
            }
            match = text.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
            if (!match) return null;
            return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] || 0) };
        };
        const buildDateFromState = (dateText = '', timeText = '') => {
            const parsedDate = parseDateText(dateText);
            if (!parsedDate) return null;
            const parsedTime = parseTimeText(timeText);
            if (parsedTime) parsedDate.setHours(parsedTime.hour, parsedTime.minute, parsedTime.second, 0);
            return parsedDate;
        };
        const applyDefaultTime = (date) => {
            const next = new Date(date);
            if (options.preserveCurrentTimeForDateOnly) return next;
            next.setHours(options.defaultHour, 0, 0, 0);
            return next;
        };
        const startOfWeek = (date) => {
            const next = new Date(date);
            const diff = (next.getDay() - options.weekStartsOn + 7) % 7;
            next.setDate(next.getDate() - diff);
            next.setHours(0, 0, 0, 0);
            return next;
        };
        const addDuration = (date, duration) => {
            const next = new Date(date);
            if (duration.years) next.setFullYear(next.getFullYear() + duration.years);
            if (duration.months) {
                const originalDate = next.getDate();
                next.setDate(1);
                next.setMonth(next.getMonth() + duration.months);
                const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
                next.setDate(Math.min(originalDate, maxDay));
            }
            if (duration.weeks) next.setDate(next.getDate() + duration.weeks * 7);
            if (duration.days) next.setDate(next.getDate() + duration.days);
            if (duration.hours) next.setHours(next.getHours() + duration.hours);
            if (duration.minutes) next.setMinutes(next.getMinutes() + duration.minutes);
            if (duration.seconds) next.setSeconds(next.getSeconds() + duration.seconds);
            return next;
        };
        const extractClockTime = (text, date) => {
            const next = new Date(date);
            const tokens = [];
            if (text.includes('자정')) { next.setHours(0, 0, 0, 0); tokens.push({ kind: 'special_time', value: 'midnight' }); return { date: next, tokens }; }
            if (text.includes('정오')) { next.setHours(12, 0, 0, 0); tokens.push({ kind: 'special_time', value: 'noon' }); return { date: next, tokens }; }
            const explicit = text.match(/(오전|오후)?\s*(\d{1,2})시(?:\s*(\d{1,2})분)?/);
            if (explicit) {
                const meridiem = explicit[1] || null;
                let hour = Number(explicit[2]);
                const minute = explicit[3] ? Number(explicit[3]) : 0;
                if (meridiem === '오후' && hour < 12) hour += 12;
                if (meridiem === '오전' && hour === 12) hour = 0;
                next.setHours(hour, minute, 0, 0);
                tokens.push({ kind: 'hour', value: hour }, { kind: 'minute', value: minute });
                return { date: next, tokens };
            }
            const ampm = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\b/i);
            if (ampm) {
                let hour = Number(ampm[1]);
                const minute = Number(ampm[2]);
                const second = Number(ampm[3] || 0);
                if (/PM/i.test(ampm[4]) && hour < 12) hour += 12;
                if (/AM/i.test(ampm[4]) && hour === 12) hour = 0;
                next.setHours(hour, minute, second, 0);
                tokens.push({ kind: 'hour', value: hour }, { kind: 'minute', value: minute });
                return { date: next, tokens };
            }
            for (const [label, hour] of [['아침', 8], ['점심', 12], ['오후', 15], ['저녁', 19], ['밤', 21]]) {
                if (text.includes(label)) {
                    next.setHours(hour, 0, 0, 0);
                    tokens.push({ kind: 'time_bucket', value: label }, { kind: 'hour', value: hour });
                    return { date: next, tokens };
                }
            }
            return null;
        };
        const parseAbsolute = (text, baseDate) => {
            const tokens = [];
            let match = text.match(/(\d{1,6})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2}))?)?/);
            if (match) {
                const year = Number(match[1]);
                const month = Number(match[2]);
                const day = Number(match[3]);
                const hour = match[4] ? Number(match[4]) : options.defaultHour;
                const minute = match[5] ? Number(match[5]) : 0;
                const date = new Date(baseDate);
                date.setFullYear(year, month - 1, day);
                date.setHours(hour, minute, 0, 0);
                tokens.push({ kind: 'year', value: year }, { kind: 'month', value: month }, { kind: 'day', value: day }, { kind: 'hour', value: hour }, { kind: 'minute', value: minute });
                return { date, tokens, meta: { assumedTime: !match[4], ambiguous: false, confidence: 0.99 } };
            }
            match = text.match(/(?:(\d{1,6})년\s*)?(\d{1,2})월\s*(\d{1,2})일(?:\s*\([^)]{1,12}\))?(?:\s*(오전|오후))?\s*(\d{1,2})?시?(?:\s*(\d{1,2})분)?/);
            if (!match) return null;
            const year = match[1] ? Number(match[1]) : null;
            const month = Number(match[2]);
            const day = Number(match[3]);
            let hour = match[5] ? Number(match[5]) : options.defaultHour;
            const minute = match[6] ? Number(match[6]) : 0;
            const meridiem = match[4] || null;
            if (meridiem === '오후' && hour < 12) hour += 12;
            if (meridiem === '오전' && hour === 12) hour = 0;
            const date = new Date(baseDate);
            if (year) date.setFullYear(year);
            date.setMonth(month - 1, day);
            const ampm = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\b/i);
            let explicitMinute = minute;
            if (ampm) {
                hour = Number(ampm[1]);
                if (/PM/i.test(ampm[4]) && hour < 12) hour += 12;
                if (/AM/i.test(ampm[4]) && hour === 12) hour = 0;
                explicitMinute = Number(ampm[2]);
            }
            date.setHours(hour, explicitMinute, 0, 0);
            if (ampm) date.setMinutes(Number(ampm[2]), Number(ampm[3] || 0), 0);
            tokens.push({ kind: 'month', value: month }, { kind: 'day', value: day }, { kind: 'hour', value: hour }, { kind: 'minute', value: explicitMinute });
            return { date, tokens, meta: { assumedTime: !match[5] && !ampm, ambiguous: false, confidence: year ? 0.97 : 0.93 } };
        };
        const parseRelative = (text, baseDate) => {
            const matches = [...text.matchAll(/(\d+)\s*(초|분|시간|시|일|주|개월|달|월|년)\s*(후|뒤|이후|전|이전|앞)/g)];
            if (!matches.length) return null;
            const duration = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
            const tokens = [];
            for (const match of matches) {
                const amount = Number(match[1]);
                const unit = unitMap[match[2]];
                const direction = directionMap[match[3]] || 1;
                if (!unit) continue;
                duration[unit] += amount * direction;
                tokens.push({ kind: 'amount', value: amount }, { kind: 'unit', value: unit }, { kind: 'direction', value: direction > 0 ? 'future' : 'past' });
            }
            let date = addDuration(baseDate, duration);
            const timeAdjust = extractClockTime(text, date);
            if (timeAdjust) {
                date = timeAdjust.date;
                tokens.push(...timeAdjust.tokens);
            }
            return { date, tokens, duration, meta: { assumedTime: !timeAdjust, ambiguous: false, confidence: 0.96 } };
        };
        const parseKeyword = (text, baseDate) => {
            const date = new Date(baseDate);
            const makeRange = (start, end, anchor) => ({ type: 'range', anchor, tokens: [{ kind: 'keyword', value: anchor }], range: { start: toTarget(start), end: toTarget(end) }, meta: { assumedTime: false, ambiguous: false, confidence: 0.92 } });
            if (text === '지금') return { type: 'keyword', anchor: 'now', tokens: [{ kind: 'keyword', value: 'now' }], target: date, meta: { assumedTime: false, ambiguous: false, confidence: 1 } };
            if (text.startsWith('오늘')) { const adjusted = extractClockTime(text, new Date(date)); return { type: 'keyword', anchor: 'today', tokens: [{ kind: 'keyword', value: 'today' }, ...(adjusted?.tokens || [])], target: adjusted ? adjusted.date : applyDefaultTime(date), meta: { assumedTime: !adjusted, ambiguous: false, confidence: adjusted ? 0.97 : 0.9 } }; }
            if (text.startsWith('내일')) { date.setDate(date.getDate() + 1); const adjusted = extractClockTime(text, date); return { type: 'keyword', anchor: 'tomorrow', tokens: [{ kind: 'keyword', value: 'tomorrow' }, ...(adjusted?.tokens || [])], target: adjusted ? adjusted.date : applyDefaultTime(date), meta: { assumedTime: !adjusted, ambiguous: false, confidence: 0.95 } }; }
            if (text.startsWith('모레')) { date.setDate(date.getDate() + 2); const adjusted = extractClockTime(text, date); return { type: 'keyword', anchor: 'day_after_tomorrow', tokens: [{ kind: 'keyword', value: 'day_after_tomorrow' }, ...(adjusted?.tokens || [])], target: adjusted ? adjusted.date : applyDefaultTime(date), meta: { assumedTime: !adjusted, ambiguous: false, confidence: 0.94 } }; }
            if (text.startsWith('어제')) { date.setDate(date.getDate() - 1); const adjusted = extractClockTime(text, date); return { type: 'keyword', anchor: 'yesterday', tokens: [{ kind: 'keyword', value: 'yesterday' }, ...(adjusted?.tokens || [])], target: adjusted ? adjusted.date : applyDefaultTime(date), meta: { assumedTime: !adjusted, ambiguous: false, confidence: 0.94 } }; }
            if (text.startsWith('그제')) { date.setDate(date.getDate() - 2); const adjusted = extractClockTime(text, date); return { type: 'keyword', anchor: 'day_before_yesterday', tokens: [{ kind: 'keyword', value: 'day_before_yesterday' }, ...(adjusted?.tokens || [])], target: adjusted ? adjusted.date : applyDefaultTime(date), meta: { assumedTime: !adjusted, ambiguous: false, confidence: 0.93 } }; }
            if (text === '이번 주' || text === '다음 주' || text === '지난 주') {
                const start = startOfWeek(baseDate);
                if (text === '다음 주') start.setDate(start.getDate() + 7);
                if (text === '지난 주') start.setDate(start.getDate() - 7);
                const end = new Date(start);
                end.setDate(end.getDate() + 6);
                end.setHours(23, 59, 59, 999);
                return makeRange(start, end, text === '이번 주' ? 'this_week' : text === '다음 주' ? 'next_week' : 'last_week');
            }
            if (text === '이번 달' || text === '다음 달' || text === '지난 달') {
                const start = new Date(baseDate);
                start.setDate(1);
                start.setHours(0, 0, 0, 0);
                if (text === '다음 달') start.setMonth(start.getMonth() + 1);
                if (text === '지난 달') start.setMonth(start.getMonth() - 1);
                const end = new Date(start);
                end.setMonth(end.getMonth() + 1);
                end.setDate(0);
                end.setHours(23, 59, 59, 999);
                return makeRange(start, end, text === '이번 달' ? 'this_month' : text === '다음 달' ? 'next_month' : 'last_month');
            }
            if (text === '월말') { const end = new Date(baseDate); end.setMonth(end.getMonth() + 1, 0); end.setHours(23, 59, 59, 999); return { type: 'keyword', anchor: 'end_of_month', tokens: [{ kind: 'keyword', value: 'end_of_month' }], target: end, meta: { assumedTime: false, ambiguous: false, confidence: 0.9 } }; }
            if (text === '연말') { const end = new Date(baseDate); end.setMonth(11, 31); end.setHours(23, 59, 59, 999); return { type: 'keyword', anchor: 'end_of_year', tokens: [{ kind: 'keyword', value: 'end_of_year' }], target: end, meta: { assumedTime: false, ambiguous: false, confidence: 0.9 } }; }
            return null;
        };
        const parseWeekday = (text, baseDate) => {
            const match = text.match(/(이번 주|다음 주|지난 주)?\s*(일요일|월요일|화요일|수요일|목요일|금요일|토요일|일|월|화|수|목|금|토)(?:\s*(오전|오후))?\s*(\d{1,2})?시?(?:\s*(\d{1,2})분)?/);
            if (!match) return null;
            const scope = match[1] || null;
            const weekday = weekdayMap[match[2]];
            const meridiem = match[3] || null;
            let hour = match[4] ? Number(match[4]) : options.defaultHour;
            const minute = match[5] ? Number(match[5]) : 0;
            if (meridiem === '오후' && hour < 12) hour += 12;
            if (meridiem === '오전' && hour === 12) hour = 0;
            const start = startOfWeek(baseDate);
            if (scope === '다음 주') start.setDate(start.getDate() + 7);
            if (scope === '지난 주') start.setDate(start.getDate() - 7);
            const target = new Date(start);
            target.setDate(start.getDate() + weekday);
            target.setHours(hour, minute, 0, 0);
            if (!scope && target < baseDate) target.setDate(target.getDate() + 7);
            return { date: target, tokens: [{ kind: 'scope', value: scope || 'nearest' }, { kind: 'weekday', value: weekday }, { kind: 'hour', value: hour }, { kind: 'minute', value: minute }], meta: { assumedTime: !match[4], ambiguous: !scope, confidence: scope ? 0.93 : 0.82 } };
        };
        const parse = (input, baseDate = null) => {
            const normalized = normalizeInput(input);
            const base = baseDate instanceof Date
                ? (Number.isNaN(baseDate.getTime()) ? null : new Date(baseDate.getTime()))
                : (() => {
                    if (baseDate == null || baseDate === '') return null;
                    const parsed = new Date(baseDate);
                    return Number.isNaN(parsed.getTime()) ? null : parsed;
                })();
            const result = { ok: false, type: null, input, normalized, base: base ? base.toISOString() : null, timezone: options.timezone, tokens: [], duration: { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 }, anchor: null, target: null, range: null, meta: { assumedTime: false, ambiguous: false, confidence: 0 } };
            if (!base) {
                return { ...result, ok: false, meta: { assumedTime: false, ambiguous: true, confidence: 0.15 } };
            }
            const absolute = parseAbsolute(normalized, base);
            if (absolute) return { ...result, ok: true, type: 'absolute', tokens: absolute.tokens, target: toTarget(absolute.date), meta: absolute.meta };
            const relative = parseRelative(normalized, base);
            if (relative) return { ...result, ok: true, type: 'relative', tokens: relative.tokens, duration: relative.duration, target: toTarget(relative.date), meta: relative.meta };
            const keyword = parseKeyword(normalized, base);
            if (keyword) return { ...result, ok: true, type: keyword.type, tokens: keyword.tokens, anchor: keyword.anchor, target: keyword.target ? toTarget(keyword.target) : null, range: keyword.range || null, meta: keyword.meta };
            const weekday = parseWeekday(normalized, base);
            if (weekday) return { ...result, ok: true, type: 'absolute', tokens: weekday.tokens, target: toTarget(weekday.date), meta: weekday.meta };
            return { ...result, ok: false, meta: { assumedTime: false, ambiguous: true, confidence: 0.15 } };
        };
        const resolveTextTarget = (input, baseDate = null) => {
            const text = compactTimeFieldText(input, 120);
            if (!text) return null;
            const dateOnly = /^\d{1,6}-\d{1,2}-\d{1,2}$/.test(text)
                || /^\d{1,6}[\/.]\d{1,2}[\/.]\d{1,2}$/.test(text)
                || /^\d{1,6}년\s*\d{1,2}월\s*\d{1,2}일(?:\s*\([^)]{1,12}\))?$/.test(text);
            const normalizedBase = baseDate instanceof Date
                ? (Number.isNaN(baseDate.getTime()) ? null : new Date(baseDate.getTime()))
                : (() => {
                    if (baseDate == null || baseDate === '') return null;
                    const parsed = new Date(baseDate);
                    return Number.isNaN(parsed.getTime()) ? null : parsed;
                })();
            if (normalizedBase) {
                const parsed = parse(text, normalizedBase);
                if (parsed?.ok) return parsed;
            }
            const hasExplicitDateToken = /(\d{1,6})[\/.-](\d{1,2})[\/.-](\d{1,2})/.test(text) || /(\d{1,6})년\s*(\d{1,2})월\s*(\d{1,2})일/.test(text) || /^\d{4}-\d{2}-\d{2}T/.test(text);
            if (!normalizedBase && hasExplicitDateToken) {
                const parsed = parse(text, new Date(2000, 0, 1, options.defaultHour, 0, 0, 0));
                if (parsed?.ok) return parsed;
            }
            const parsedDate = parseDateText(text);
            if (parsedDate) return { ok: true, type: 'absolute', input: text, target: toTarget(parsedDate), meta: { assumedTime: dateOnly, ambiguous: false, confidence: 0.99 } };
            if (hasExplicitDateToken) {
                const nativeDate = new Date(text);
                if (!Number.isNaN(nativeDate.getTime())) return { ok: true, type: 'absolute', input: text, target: toTarget(nativeDate), meta: { assumedTime: false, ambiguous: false, confidence: 0.7 } };
            }
            return null;
        };
        return { options, formatDateLocal, formatTimeLocal, toTarget, parseDateText, parseTimeText, buildDateFromState, parse, resolveTextTarget };
    })();

    // [MANAGER] Narrative Time Engine
    // Entity-local timeTracking is treated as legacy input only.
    // Canonical time state now lives here and is projected top-down.
    // ══════════════════════════════════════════════════════════════
