    const show = async () => {
        wmHealthOrchestrator?.clear();
        const openingVersion = MemoryState.initVersion;
        const R = RisuCompat.host('getCharacter') || RisuCompat.api();
        if (!R) return;

        // 기존 레이어가 있다면 제거
        const existingOverlay = document.getElementById('lmai-overlay');
        if (existingOverlay) {
            existingOverlay.dispatchEvent(new Event('wm-gui-dispose'));
            existingOverlay.remove();
        }

        // 1. V1.1 방식: DOM 엘리먼트 직접 생성 (보안정책 우회)
        const overlay = document.createElement('div');
        let turnReanalysisViewRevision = 0, turnReanalysisAbort = null;
        const turnReanalysisStatuses = new Map();
        overlay.id = 'lmai-overlay';
        overlay.className = 'lmai-overlay';
        
        // CSS 주입
        const style = document.createElement('style');
        style.textContent = GUI_CSS;
        overlay.appendChild(style);

        // 본문 주입
        const bodyWrap = document.createElement('div');
        bodyWrap.style.width = '100%';
        bodyWrap.style.display = 'flex';
        bodyWrap.style.justifyContent = 'center';
        bodyWrap.setAttribute('data-libra-gui-backdrop', 'true');
        bodyWrap.innerHTML = GUI_BODY;
        overlay.appendChild(bodyWrap);

        document.body.appendChild(overlay);

        const makeGuiSectionLabel = (text = '') => {
            const node = document.createElement('div');
            node.className = 'sec';
            node.textContent = text;
            return node;
        };
        const makeGuiAccordion = (index, title, nodes = [], options = {}) => {
            const acc = document.createElement('div');
            acc.className = `acc${options.open ? ' open' : ''}`;
            const header = document.createElement('div');
            header.className = 'acc-h';
            header.dataset.acc = String(options.key || `gui-${index}`);
            const safeTitle = String(title || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
            header.innerHTML = `<span class="ttl"><span class="idx">${String(index).padStart(2, '0')}</span>${safeTitle}</span><span class="chev">›</span>`;
            acc.appendChild(header);
            if (options.hint) {
                const hint = document.createElement('div');
                hint.className = 'acc-hint';
                hint.textContent = String(options.hint || '');
                acc.appendChild(hint);
            }
            const body = document.createElement('div');
            body.className = 'acc-b';
            nodes.filter(Boolean).forEach(node => body.appendChild(node));
            acc.appendChild(body);
            return acc;
        };
        const upgradeWorldPanelLayout = () => {
            const tab = overlay.querySelector('#tab-world');
            if (!tab || tab.dataset.libraLayoutUpgraded === '1') return;
            // panel-heading 은 셸 재설계에서 사라질 수 있다. null 을 그대로
            // replaceChildren 에 넘기면 화면에 "null" 글자가 찍힌다.
            const heading = tab.querySelector('.panel-heading') || (() => {
                const node = document.createElement('div');
                node.className = 'panel-heading';
                node.innerHTML = '<div><h2>설정</h2><p>일반 사용에 필요한 항목을 먼저 보여주고 전문 설정은 구역별로 분리합니다.</p></div>';
                return node;
            })();
            const viewTabs = tab.querySelector('.view-tabs');
            const tree = overlay.querySelector('#wt');
            const globalFeatures = overlay.querySelector('#world-global-features');
            const rules = overlay.querySelector('#wr');
            const fieldBand = overlay.querySelector('#world-node-name')?.closest('.entity-band');
            const saveWorldFields = overlay.querySelector('#btn-save-world-fields')?.closest('.sbar');
            const stateLog = overlay.querySelector('#world-state-log');
            const codexStatus = overlay.querySelector('#world-codex-status');
            const correctionField = overlay.querySelector('#world-user-correction')?.closest('.fld');
            const saveCorrection = overlay.querySelector('#btn-save-world-correction')?.closest('.sbar');
            const lensMeta = overlay.querySelector('#world-lens-meta');
            const lensPromptField = overlay.querySelector('#world-lens-prompt')?.closest('.fld');
            tab.replaceChildren(
                heading,
                viewTabs,
                makeGuiAccordion(1, '세계관 트리 · 전역 특성', [
                    makeGuiSectionLabel('세계관 트리'),
                    tree,
                    makeGuiSectionLabel('전역 세계 특성'),
                    globalFeatures,
                    makeGuiSectionLabel('현재 세계 규칙'),
                    rules
                ], { open: true, key: 'world-tree' }),
                makeGuiAccordion(2, '세계관 정본 필드', [
                    fieldBand,
                    saveWorldFields
                ], {
                    key: 'world-canon',
                    hint: '영구적으로 저장되는 세계 구조 값입니다. 잘못된 값을 발견하면 직접 고쳐서 저장하세요.'
                }),
                makeGuiAccordion(3, '상태 로그 · 코덱스', [
                    makeGuiSectionLabel('현재 세계 상태 로그'),
                    stateLog,
                    makeGuiSectionLabel('세계관 코덱스 상태'),
                    codexStatus
                ], { key: 'world-status' }),
                makeGuiAccordion(4, '수동 보정', [
                    makeGuiSectionLabel('수동 세계관 보정'),
                    correctionField,
                    saveCorrection
                ], { key: 'world-correction' }),
                makeGuiAccordion(5, '현재 장면 렌즈', [
                    makeGuiSectionLabel('현재 장면용 세계관 보정'),
                    lensMeta,
                    lensPromptField
                ], { key: 'world-lens' })
            );
            tab.dataset.libraLayoutUpgraded = '1';
        };
        const composeSettingsPanelLayout = () => {
            const tab = overlay.querySelector('#tab-settings');
            if (!tab || tab.dataset.libraLayoutComposed === '1') return;
            const grid = tab.querySelector('.sgrid');
            const ai = grid?.querySelector('[data-settings-group="ai"]');
            if (!ai) return;
            const summary = document.createElement('div');
            summary.className = 'settings-overview';
            summary.innerHTML = '<div class="settings-overview-copy"><strong>새로 시작하는 분석에 적용</strong><span>진행 중인 분석의 AI는 유지합니다.</span><span id="settings-profile-connection-pill" class="status-pill">확인 중</span><span id="settings-default-profile-summary" class="setting-note"></span><span id="common-ai-save-status" class="setting-note">저장된 프리셋을 선택하세요.</span></div>';
            ai.querySelector('[data-analysis-use-control]')?.after(summary);
            const work = overlay.querySelector('[data-work-maintenance]');
            const storage = overlay.querySelector('[data-work-storage]');
            const storageSection = document.createElement('section');
            storageSection.className = 'ss';
            storageSection.dataset.settingsSection = 'wm-storage';
            storageSection.innerHTML = '<h3>WM 전체 기억 저장</h3><div data-wm-storage-panel data-wm-storage-controls>저장 지원 상태 확인 중…</div>';
            storage?.appendChild(storageSection);
            // Health/cache/import/export/reset remain explicit tools with their original IDs.
            const afterGrid = Array.from(tab.childNodes).slice(Array.from(tab.childNodes).indexOf(grid) + 1);
            const saveBar = tab.querySelector('.settings-actions');
            for (const node of afterGrid) if (node !== saveBar) work?.appendChild(node);
            if (saveBar) {
                const toolBar = document.createElement('div');
                toolBar.className = 'sbar';
                for (const node of Array.from(saveBar.children)) {
                    if (!['settings-auto-save-status', 'btn-save-settings'].includes(node.id)) toolBar.appendChild(node);
                }
                work?.appendChild(toolBar);
            }
            tab.dataset.libraLayoutComposed = '1';
        };
        const composeGuiLayoutShell = () => {
            // The approved UX prototype keeps data pages flat. Do not turn the
            // world database into the former numbered dark accordion layout.
            composeSettingsPanelLayout();
            overlay.addEventListener('click', (event) => {
                const header = event.target?.closest?.('.acc-h');
                if (!header || !overlay.contains(header)) return;
                const acc = header.closest('.acc');
                if (acc) acc.classList.toggle('open');
            });
        };
        composeGuiLayoutShell();

        // 2. 데이터 준비
        let guiContext = await resolveActiveChatContext(null, { includeReadOnly: true });
        const activation = await PersonaRuntimeCoordinator.activate(guiContext, { isViewCurrent: () => overlay.isConnected && MemoryState.initVersion === openingVersion });
        if (!overlay.isConnected) return;
        if (!activation.ok) {
            // Rejected ownership must never render or rebuild the previous persona's caches.
            const reason = String(activation.reason || 'persona_activation_unavailable');
            const message = /legacy|persona.*binding|persona.*unbound|persona.*ambiguous/.test(reason)
                ? '기존 데이터는 보존했습니다. 페르소나 연결 또는 이관 확인이 필요합니다.'
                : /provenance|branch_source|integrity/.test(reason)
                    ? '기존 데이터는 보존했습니다. 기록의 소유 범위 또는 무결성을 확인할 수 없어 읽기 전용입니다.'
                    : '정본 데이터를 확인할 수 없습니다. 이전 표시를 신뢰하지 말고 새로고침해 주세요.';
            bodyWrap.innerHTML = '<div class="lmai-modal"><button id="xbtn">닫기</button><div id="health-summary" data-read-state="unavailable"></div><button id="btn-health-refresh">새로고침</button><button id="btn-health-scan" disabled>검사</button><div id="health-quarantine-list"></div><div id="health-integrity-list"></div><div id="health-conflict-list"></div></div>';
            bodyWrap.querySelector('#health-summary').textContent = message;
            bodyWrap.querySelector('#btn-health-refresh').addEventListener('click', async () => { if (overlay.isConnected) await show(); });
            bodyWrap.querySelector('#xbtn').addEventListener('click', () => { overlay.remove(); R.hideContainer?.(); });
            await R.showContainer('fullscreen');
            return;
        }
        guiContext = activation.context;
        const char = guiContext.char;
        const chat = guiContext.chat;
        const guiChatId = String(chat?.id || '').trim();
        let guiHealthBinding = null, guiHealthBindingError = '';
        try { guiHealthBinding = await ManagementReviewCore.captureBinding({ char, chat }); }
        catch (error) { guiHealthBindingError = error?.code || error?.message || 'management_binding_unavailable'; }
        let healthReadSource = { status: 'pending', verified: false, lore: null, reason: guiHealthBindingError };
        let healthReadSerial = 0, healthActionBusy = false;
        let pendingCaptureRead = { status: 'pending', records: [], complete: false, scanned: 0 };

        let lore = [];
        if (char) {
            // Opening the inspector must not migrate or persist any data.
            lore = MemoryEngine.getLorebook(char, chat) || [];
        }
        let effectiveGuiLore = char ? (MemoryEngine.getEffectiveLorebook(char, chat) || lore) : lore;
        let guiPersistedBaselineLore = (Array.isArray(lore) ? lore : []).map(entry => safeClone(entry));
        HierarchicalWorldManager.loadWorldGraph(effectiveGuiLore, true);
        try { EntityManager.rebuildCache(effectiveGuiLore); }
        catch (error) { recordSuppressedRuntimeError('gui.initial_entity_cache_rebuild_failed', error, { loreCount: effectiveGuiLore.length }); }

        let _MEM = effectiveGuiLore.filter(e => e.comment === 'lmai_memory');
        let _ENT = effectiveGuiLore.filter(e => e.comment === 'lmai_entity');
        let _REL = effectiveGuiLore.filter(e => e.comment === 'lmai_relation');
        let _NARRATIVE_INSPECTOR = buildNarrativeInspectorSnapshot(effectiveGuiLore, {
            narrativeState: NarrativeTracker.getState?.() || { storylines: [], turnLog: [], lastSummaryTurn: 0 },
            storyAuthorState: StoryAuthor.getState?.() || {},
            directorState: Director.getState?.() || {},
            config: MemoryEngine.CONFIG
        });
        let _NAR = safeClone(_NARRATIVE_INSPECTOR.narrative.state || { storylines: [], turnLog: [], lastSummaryTurn: 0 });
        let _AUTHOR = safeClone(_NARRATIVE_INSPECTOR.storyAuthor.state || {});
        let _DIRECTOR = safeClone(_NARRATIVE_INSPECTOR.director.state || {});

        let _WLD = { nodes: [], activePath: [], activeNodes: [], global: {}, rootId: null };
        try {
            const profile = HierarchicalWorldManager.getProfile();
            if (profile) {
                _WLD = { nodes: Array.from(profile.nodes.entries()), activePath: profile.activePath || [], activeNodes: profile.activeNodes || [], global: profile.global || {}, rootId: profile.rootId };
            }
        } catch (error) {
            recordSuppressedRuntimeError('gui.initial_world_graph_parse_failed', error, {
                comment: '',
                key: '',
                chatId: guiChatId
            });
        }

        let _CFG = { ...MemoryEngine.CONFIG };
        // A small non-secret saved-layer view keeps saved intent separate from runtime arguments.
        let savedInjectionBudgetSettings = null;
        const captureSavedInjectionBudgetSettings = config => {
            savedInjectionBudgetSettings = {};
            for (const key of ['injectionBudgetPreset', 'injectionBudgetMaxTokens', 'injectionBudgetTokens']) {
                if (Object.prototype.hasOwnProperty.call(config || {}, key)) savedInjectionBudgetSettings[key] = config[key];
            }
        };
        let settingsViewReplacementRevision = commonSettingsReplacementRevision;
        try {
            const saved = await readCommonPluginSettings();
            if (saved) {
                const p = (() => {
                    try {
                        const v = typeof saved === 'string' ? JSON.parse(saved) : saved;
                        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
                    } catch (error) {
                        recordSuppressedRuntimeError('gui.initial_config_parse_failed', error, {
                            chatId: guiChatId,
                            rawChars: String(saved || '').length
                        });
                        return {};
                    }
                })();
                // ★ 옛 alias 를 정본 키로 접는다 — 구 저장 데이터도 사용자 설정이 보존된다(P1).
                const normalizedSaved = normalizeMemoryRetentionSettings(normalizeSettingsAliases(p));
                captureSavedInjectionBudgetSettings(normalizedSaved);
                _CFG = { ..._CFG, ...normalizedSaved };
            }
        } catch (error) {
            recordSuppressedRuntimeError('gui.initial_config_read_failed', error, {
                chatId: guiChatId
            });
        }
        _CFG.entityBlocklist = normalizeEntityBlocklistCollection(_CFG.entityBlocklist || []);
        _NARRATIVE_INSPECTOR = buildNarrativeInspectorSnapshot(effectiveGuiLore, {
            narrativeState: _NAR,
            storyAuthorState: _AUTHOR,
            directorState: _DIRECTOR,
            config: _CFG
        });
        _NAR = safeClone(_NARRATIVE_INSPECTOR.narrative.state || _NAR);
        _AUTHOR = safeClone(_NARRATIVE_INSPECTOR.storyAuthor.state || _AUTHOR);
        _DIRECTOR = safeClone(_NARRATIVE_INSPECTOR.director.state || _DIRECTOR);

        // 유틸리티 함수
        const esc = (s) => { const d = document.createElement("div"); d.appendChild(document.createTextNode(s||"")); return d.innerHTML; };
        const escAttr = (s) => esc(s).replace(/"/g,"&quot;").replace(/'/g,"&#39;");
        let toastHideTimer = null;
        const toast = (m, d) => {
            const t = overlay.querySelector("#toast");
            if (!t) return;
            if (toastHideTimer) clearTimeout(toastHideTimer);
            t.textContent = m;
            t.classList.add("on");
            toastHideTimer = setTimeout(() => t.classList.remove("on"), d || 2000);
        };
        const getJsonExportStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
        const sanitizeJsonExportFilename = (filename = 'libra-export.json') => {
            const base = String(filename || 'libra-export.json')
                .replace(/[\\/:*?"<>|]+/g, '-')
                .replace(/\s+/g, ' ')
                .replace(/^\.+/, '')
                .trim()
                .slice(0, 180);
            const safe = base || 'libra-export.json';
            return /\.json$/i.test(safe) ? safe : `${safe}.json`;
        };
        const saveJsonExportFile = async (payload, filename, options = {}) => {
            if (options.isCurrent && !options.isCurrent()) return { ok: false, stale: true };
            const safeName = sanitizeJsonExportFilename(filename);
            const json = typeof options.serializedJson === 'string' ? options.serializedJson : JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            if (typeof document !== 'undefined' && document.body && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = safeName;
                link.rel = 'noopener';
                link.type = 'application/json';
                link.style.display = 'none';
                document.body.appendChild(link);
                try {
                    const clickEvent = typeof MouseEvent === 'function'
                        ? new MouseEvent('click', { bubbles: true, cancelable: true, view: typeof window !== 'undefined' ? window : null })
                        : null;
                    if (options.isCurrent && !options.isCurrent()) return { ok: false, stale: true };
                    if (clickEvent) link.dispatchEvent(clickEvent);
                    else link.click();
                } finally {
                    setTimeout(() => {
                        try { link.remove(); } catch {}
                        try { URL.revokeObjectURL(url); } catch {}
                    }, 60000);
                }
                return { ok: true, method: 'download', filename: safeName, bytes: blob.size || json.length };
            }
            if (options.downloadOnly === true) throw new Error('diagnostic_download_unavailable');
            const picker = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
                ? window.showSaveFilePicker.bind(window)
                : null;
            if (!picker) throw new Error('JSON 파일 저장 API를 사용할 수 없습니다.');
            try {
                const handle = await picker({
                    suggestedName: safeName,
                    types: [{
                        description: 'JSON file',
                        accept: { 'application/json': ['.json'] }
                    }],
                    excludeAcceptAllOption: false
                });
                const writable = await handle.createWritable();
                try {
                    await writable.write(blob);
                } finally {
                    await writable.close();
                }
                return { ok: true, method: 'file-picker', filename: safeName, bytes: blob.size || json.length };
            } catch (error) {
                if (String(error?.name || '') === 'AbortError') {
                    return { ok: false, canceled: true, method: 'file-picker', filename: safeName };
                }
                if (_CFG?.debug) recordRuntimeDebug('warn', '[LIBRA] JSON export file picker failed:', error?.message || error);
                throw error;
            }
        };
        const toastJsonExportResult = (label, result) => {
            if (result?.canceled) {
                toast(`${label} 내보내기를 취소했습니다`, 1800);
                return;
            }
            const method = result?.method === 'file-picker' ? 'JSON 파일로 저장' : '브라우저 다운로드로 저장';
            toast(`✅ ${label} 내보내기 완료 (${method})`, 2600);
        };
                const parseMeta = (c) => parseLibraMetaObject(c || '', { imp: 5, t: 0, ttl: 0, cat: '' });
        const stripMeta = (c) => {
            const raw = String(c || '');
            const metaJson = extractLibraMetaJsonString(raw);
            if (!metaJson) return raw.trim();
            const markerStart = raw.indexOf('[META:');
            const jsonStart = raw.indexOf(metaJson, markerStart >= 0 ? markerStart : 0);
            const close = jsonStart >= 0 ? raw.indexOf(']', jsonStart + metaJson.length) : -1;
            return (close >= 0 ? raw.slice(close + 1) : raw).trim();
        };
        const cleanGuiMemoryDisplayText = (value = '', max = 900) => {
            let text = String(value || '')
                .replace(/\r\n/g, '\n')
                .replace(/\s*\/\s*/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!text) return '';
            const labelPatterns = [
                /^Scene result\s*:\s*/i,
                /^User turn\s*:\s*/i,
                /^Assistant response\s*:\s*/i,
                /^Retrospective overall recap\s*:\s*/i,
                /^Retrospective family postscript\s*:\s*/i,
                /^summary\s*[:：]\s*/i,
                /^direct evidence\s*[:：]\s*/i
            ];
            let changed = true;
            while (changed) {
                changed = false;
                for (const re of labelPatterns) {
                    const next = text.replace(re, '').trim();
                    if (next !== text) { text = next; changed = true; }
                }
            }
            text = text
                .replace(/\bScene result\s*:\s*/gi, '')
                .replace(/\bUser turn\s*:\s*/gi, '')
                .replace(/\bAssistant response\s*:\s*/gi, '')
                .replace(/\bRetrospective overall recap\s*:\s*/gi, '')
                .replace(/\bRetrospective family postscript\s*:\s*/gi, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            const limit = Math.max(80, Number(max || 0) || 900);
            return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trim()}…` : text;
        };
        const uniqueGuiMemoryTexts = (items = [], limit = 6, maxChars = 360) => {
            const out = [];
            const seen = new Set();
            for (const item of Array.isArray(items) ? items : []) {
                const text = cleanGuiMemoryDisplayText(
                    typeof item === 'string' ? item : (item?.text || item?.summary || item?.label || item?.delta || item?.trigger || ''),
                    maxChars
                );
                if (!text) continue;
                const key = text.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(text);
                if (out.length >= limit) break;
            }
            return out;
        };
        const joinGuiMemorySentences = (items = [], fallback = '', options = {}) => {
            const limit = Math.max(3, Math.min(12, Number(options.limit || 7) || 7));
            const maxChars = Math.max(160, Math.min(900, Number(options.maxChars || 520) || 520));
            const lines = uniqueGuiMemoryTexts(items, limit, maxChars);
            if (!lines.length && fallback) lines.push(cleanGuiMemoryDisplayText(fallback, 520));
            if (!lines.length) return '표시할 기억 요약이 아직 없습니다. 원본 데이터 보기에서 저장된 compact payload를 확인할 수 있습니다.';
            return lines.join('\n');
        };
        const collectGuiMemoryTags = (payload = null) => {
            const blocked = new Set(['일어나요', '말하지', '말도', '당장', '머리', '마요', '하지', '지금', '없는', '있어요', '있나요', '합니다', '했어요']);
            const tags = [];
            const push = (value) => {
                const text = String(value || '').replace(/[_-]+/g, ' ').trim();
                if (!text || blocked.has(text)) return;
                if (text && !tags.some(v => v.toLowerCase() === text.toLowerCase())) tags.push(text);
            };
            const pushArray = (list) => Array.isArray(list) && list.forEach(push);
            pushArray(payload?.participants?.canonicalEntities);
            pushArray(payload?.mentionedEntityNames);
            pushArray(payload?.tags);
            pushArray(payload?.recallKeywords);
            pushArray(payload?.sceneTags);
            if (payload?.sceneCore?.location) push(`장소: ${payload.sceneCore.location}`);
            if (payload?.scene?.location) push(`장소: ${payload.scene.location}`);
            return tags.slice(0, 10);
        };
        const buildGuiMemoryReadable = (entry, meta = null) => {
            const sourceContent = entry?.content || entry || '';
            const rawContent = stripMeta(sourceContent);
            let payload = null;
            try { payload = CompactMemoryCodec.parsePayloadFromEntry(entry) || null; } catch (_) { payload = null; }
            const fallbackDisplay = (() => {
                try { return CompactMemoryCodec.buildDisplayTextFromEntry(entry, 700); } catch (_) { return rawContent; }
            })();

            if (payload && CompactMemoryCodec.isLedgerPayload?.(payload)) {
                const oneLine = cleanGuiMemoryDisplayText(payload?.summaryV2?.oneLine || payload.summary || fallbackDisplay, 520);
                const sceneLine = [
                    payload?.sceneCore?.time || payload?.scene?.time,
                    payload?.sceneCore?.location || payload?.scene?.location
                ].filter(Boolean).join(' / ');
                const evidence = uniqueGuiMemoryTexts(
                    Array.isArray(payload.directEvidenceSnippets) && payload.directEvidenceSnippets.length
                        ? payload.directEvidenceSnippets
                        : payload.evidence || [],
                    8,
                    520
                );
                const facts = evidence.length ? [] : uniqueGuiMemoryTexts(payload.facts || [], 6, 420);
                const beats = uniqueGuiMemoryTexts(payload.beats || [], 4, 420);
                // RP 장기 연속성 — 정본 기억과 **다른 역할**을 담당하므로 지우지 않고 접힌 곳에 남긴다.
                // 정본은 "무슨 일이 있었나"(턴 요약·근거)이고, 여기는 "무엇이 아직 유효한가"
                // (약속 open/fulfilled/broken · 미해결 과제 · 고정 사실 · 수명 등급)다.
                // 본문에 섞으면 같은 문장이 반복되고 어느 쪽이 최신인지 읽을 수 없다(실측).
                const rpLongTerm = payload?.rpLongTerm && typeof payload.rpLongTerm === 'object' ? payload.rpLongTerm : {};
                const rpCategoryLabels = [
                    ['stableFacts', '고정 사실'],
                    ['preferences', '취향·경계'],
                    ['commitments', '약속'],
                    ['openLoops', '미해결 과제'],
                    ['relationshipMilestones', '관계 이정표'],
                    ['stateChanges', '상태 변화'],
                    ['callbacks', '회수할 상징'],
                    ['episodes', '핵심 장면']
                ];
                const rpGroups = rpCategoryLabels
                    .map(([key, label]) => ({
                        key,
                        label,
                        items: (Array.isArray(rpLongTerm[key]) ? rpLongTerm[key] : [])
                            .map(item => String(item?.text || item?.summary || '').trim())
                            .filter(Boolean)
                    }))
                    .filter(group => group.items.length);
                const rpContinuity = [];
                const continuity = uniqueGuiMemoryTexts([
                    ...(Array.isArray(payload?.continuity?.openThreads) ? payload.continuity.openThreads : []),
                    ...(Array.isArray(payload?.continuity?.relationSignals) ? payload.continuity.relationSignals : []),
                    ...(Array.isArray(payload?.continuity?.worldChanges) ? payload.continuity.worldChanges : []),
                    ...(Array.isArray(payload?.relationDeltas) ? payload.relationDeltas : [])
                ], 4, 420);
                const body = joinGuiMemorySentences([
                    sceneLine ? `장면: ${sceneLine}` : '',
                    oneLine,
                    ...evidence,
                    ...facts,
                    ...beats,
                    ...rpContinuity,
                    ...continuity
                ], fallbackDisplay, { limit: 12, maxChars: 620 });
                return {
                    kind: 'compact-ledger',
                    title: '자연어 기억 보기',
                    body,
                    chips: collectGuiMemoryTags(payload),
                    rawLabel: '원본 compact JSON 보기/수정',
                    rpGroups
                };
            }

            if (payload) {
                const snippets = Array.isArray(payload.directEvidenceSnippets)
                    ? payload.directEvidenceSnippets.map(item => typeof item === 'string' ? item : item?.text).filter(Boolean)
                    : [];
                const body = joinGuiMemorySentences([
                    payload.summary,
                    payload.primaryConflict,
                    payload.relationDelta,
                    ...snippets
                ], fallbackDisplay);
                return {
                    kind: 'compact-memory',
                    title: '자연어 기억 보기',
                    body,
                    chips: collectGuiMemoryTags(payload),
                    rawLabel: '원본 compact JSON 보기/수정'
                };
            }

            return {
                kind: 'plain-memory',
                title: '자연어 기억 보기',
                body: cleanGuiMemoryDisplayText(fallbackDisplay || rawContent, 900) || '표시할 기억 내용이 없습니다.',
                chips: meta?.cat ? [String(meta.cat)] : [],
                rawLabel: '원본 메모리 보기/수정'
            };
        };
        const impBdg = (i) => { const cls = i>=7?"bh":i>=4?"bm":"bl"; return `<span class="bdg ${cls}">중요도 ${i}</span>`; };
        const GUI_PARTIAL_MANAGED_COMMENTS = new Set(['lmai_memory', 'lmai_hme_index', 'lmai_entity', 'lmai_relation', 'lmai_world_graph', 'lmai_world_node']);
        const buildFullManagedLoreSnapshot = (partialLore) => {
            const baseLore = Array.isArray(lore) ? lore : [];
            const additions = (Array.isArray(partialLore) ? partialLore : []).map(entry => safeClone(entry));
            const additionComments = new Set(additions.map(entry => String(entry?.comment || '')));
            const replaceComments = new Set(GUI_PARTIAL_MANAGED_COMMENTS);
            if (!additionComments.has('lmai_world_graph') && !additionComments.has('lmai_world_node')) {
                replaceComments.delete('lmai_world_graph');
                replaceComments.delete('lmai_world_node');
            }
            const preserved = baseLore
                .filter(entry => {
                    const comment = String(entry?.comment || '');
                    if (!comment.startsWith('lmai_')) return true;
                    return !replaceComments.has(comment);
                })
                .map(entry => safeClone(entry));
            return [...preserved, ...additions];
        };
        const resolveGuiTargetContext = async () => {
            // Do not let a long GUI analysis commit into the chat that originally
            // opened this window after the user has navigated elsewhere. Passing
            // `chat` as a preferred target can resolve that off-screen chat and
            // then reload its singleton runtime over the actually active one.
            const targetCtx = await resolveActiveChatContext();
            const targetChar = targetCtx?.char || null;
            const targetChat = targetCtx?.chat || null;
            if (!targetChar || !targetChat) {
                throw new Error('GUI가 열린 채팅방을 찾을 수 없습니다. 작업을 중단합니다.');
            }
            if (guiChatId && String(targetChat?.id || '').trim() !== guiChatId) {
                throw new Error('GUI가 열린 채팅방을 찾을 수 없습니다. 작업을 중단합니다.');
            }
            return { targetChar, targetChat, targetCtx };
        };
        
        const saveLoreToChar = async (newLoreOrUpdater, cb, options = {}) => {
            if (!char) throw new Error('저장 대상 캐릭터를 찾을 수 없습니다.');
            await loreLock.writeLock();
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const ownerScope = LibraDataStorage.scopeKeyFor(targetChar, targetChat);
                const ownerRead = options.verifiedOwner === true ? await LibraDataStorage.readVerified(ownerScope, { readonly: true }) : null;
                if (ownerRead && !ownerRead.ok) throw Error(ownerRead.reason);
                const wmGuiSource = ownerRead ? { ok: true, sourceToken: ownerRead.authoritySource }
                    : (WmWriterRuntime.enabled ? await WmWriterRuntime.read(ownerScope) : null);
                if(WmWriterRuntime.enabled&&!wmGuiSource.ok)throw Error(wmGuiSource.reason);
                const viewLore = MemoryEngine.getLorebook(targetChar, targetChat) || [];
                const latestLore = ownerRead ? [...viewLore.filter(entry => !LibraDataStorage.isLibraEntry(entry)), ...LibraLoreConsolidator.unpackRawFromLore(ownerRead.entries).map(entry => safeClone(entry))] : viewLore;
                const originalLoreBytes = options.skipUnchanged === true ? JSON.stringify(latestLore) : '';
                const usesLatestUpdater = typeof newLoreOrUpdater === 'function';
                const requestedLore = usesLatestUpdater
                    ? await newLoreOrUpdater(latestLore, { targetChar, targetChat, ownerRead, ownerScope })
                    : newLoreOrUpdater;
                const concurrentMerge = usesLatestUpdater
                    ? { lore: requestedLore, addedConcurrent: [], refreshedConcurrent: [] }
                    : mergeConcurrentLibraManagedLore(requestedLore, latestLore, guiPersistedBaselineLore);
                const newLore = concurrentMerge.lore;
                if (!Array.isArray(newLore)) throw new Error('저장할 로어북 데이터가 올바르지 않습니다.');
                if (options.skipUnchanged === true && JSON.stringify(newLore) === originalLoreBytes) {
                    // The opt-in owner read above already verified this result. No repeated publication.
                    if (cb) cb({ targetChar, targetChat, lore: latestLore, scopeKey: getChatRuntimeScopeKey(targetChat, targetChar), chatId: String(targetChat?.id || '') });
                    return;
                }
                // GUI 데이터는 현재 채팅의 독립 DB다. localLore가 아직 없는
                // 새 채팅도 전역 캐릭터 로어로 승격하지 말고 localLore를 만든다.
                if(!WmWriterRuntime.enabled)targetChat.localLore = newLore;
                const persistResult = await persistLoreToActiveChat(targetChat, newLore,{expectedSource:wmGuiSource?.sourceToken,operation:'verified'});
                if (!persistResult?.ok) {
                    throw new Error(`저장 대상 채팅방에 기록하지 못했습니다: ${persistResult?.reason || 'unknown'}`);
                }
                const persistedLore = Array.isArray(persistResult?.chat?.localLore)
                    ? persistResult.chat.localLore.map(entry => safeClone(entry))
                    : (Array.isArray(newLore) ? newLore.map(entry => safeClone(entry)) : []);
                lore = persistedLore;
                guiPersistedBaselineLore = persistedLore.map(entry => safeClone(entry));
                effectiveGuiLore = MemoryEngine.getEffectiveLorebook(targetChar, targetChat) || lore;
                if (targetChat) targetChat.localLore = persistedLore.map(entry => safeClone(entry));
                MemoryEngine.rebuildIndex(lore);
                HierarchicalWorldManager.loadWorldGraph(lore);
                SecretKnowledgeCore.loadState(lore, {
                    scopeKey: getChatRuntimeScopeKey(targetChat, targetChar),
                    chatId: String(targetChat?.id || getActiveManagedChatId() || '').trim()
                });
                EntityKnowledgeVaultCore.loadState(lore, {
                    scopeKey: getChatRuntimeScopeKey(targetChat, targetChar),
                    chatId: String(targetChat?.id || getActiveManagedChatId() || '').trim()
                });
                TimeEngine.loadState(lore, {
                    scopeKey: getChatRuntimeScopeKey(targetChat, targetChar),
                    chatId: String(targetChat?.id || getActiveManagedChatId() || '').trim()
                });
                EntityManager.rebuildCache(lore);
                NarrativeTracker.loadState(lore);
                StoryAuthor.loadState(lore);
                Director.loadState(lore);
                const targetScopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
                const targetChatId = String(targetChat?.id || '').trim();
                WorldAdditionalCore.loadState?.(lore, {
                    scopeKey: targetScopeKey,
                    chatId: targetChatId
                });
                UserDlcCore.loadState?.(lore, { scopeKey: targetScopeKey, chatId: targetChatId });
                CharacterStateTracker.loadState(lore);
                WorldStateTracker.loadState(lore);
                if (cb) cb({ targetChar, targetChat, lore: persistedLore, scopeKey: targetScopeKey, chatId: targetChatId });
            } catch (e) {
                toast("❌ 저장 실패");
                recordRuntimeDebug('error', "[LIBRA] Save Error:", e);
                throw e;
            } finally {
                loreLock.writeUnlock();
            }
        };
        const buildHealthBadge = (label, value, tone = '') => {
            const cls = tone ? ` health-sev-${escAttr(tone)}` : '';
            return `<div class="ci${cls}">${esc(label)}: ${value === null ? '확인 불가' : Number(value || 0)}</div>`;
        };
        const getHealthPreview = (value = '', limit = 260) => {
            const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
            return text.length > limit ? `${text.slice(0, Math.max(20, limit - 4))} ...` : text;
        };
        let healthReviewSnapshots = { scopeKey: null, quarantineRows: null, findings: null };
        const buildConflictRows = (quarantineRows = [], findings = []) => {
            const rows = [];
            const pushRow = (row = {}) => {
                const id = String(row.id || TokenizerEngine.simpleHash(JSON.stringify(row))).trim();
                if (!id) return;
                rows.push({
                    id,
                    source: String(row.source || 'conflict').trim(),
                    type: String(row.type || 'conflict').trim(),
                    severity: String(row.severity || 'warn').trim(),
                    title: getHealthPreview(row.title || row.reason || row.type || '충돌 항목', 120),
                    detail: getHealthPreview(row.detail || row.preview || '', 260),
                    correction: getHealthPreview(row.correction || row.detail || row.preview || row.title || '', 900)
                });
            };
            try {
                quarantineRows.forEach(entry => {
                    const conflictCount = Number(entry?.summary?.counts?.conflicts || 0) || 0;
                    if (conflictCount > 0) {
                        pushRow({
                            id: `quarantine:${entry.id}`,
                            source: 'quarantine',
                            type: 'analysis_conflict',
                            severity: 'warn',
                            title: `${entry.domain || 'analysis'} conflict ${conflictCount}`,
                            detail: entry.reason || entry.summary?.sourcePreview || '',
                            correction: entry.summary?.sourcePreview || entry.reason || ''
                        });
                    }
                });
            } catch (error) {
                recordSuppressedRuntimeError('gui.health.quarantine_conflict_collect_failed', error);
            }
            try {
                findings
                    .filter(item => ['duplicate_entity', 'orphan_relation', 'schema_mismatch', 'scope_mismatch'].includes(String(item?.type || '')))
                    .forEach(item => pushRow({
                        id: `integrity:${item.id}`,
                        source: 'integrity',
                        type: item.type,
                        severity: item.severity || 'warn',
                        title: `${item.type} · ${item.key || item.recordId || item.comment || ''}`,
                        detail: item.reason || item.preview || '',
                        correction: item.preview || item.reason || ''
                    }));
            } catch (error) {
                recordSuppressedRuntimeError('gui.health.integrity_conflict_collect_failed', error);
            }
            return rows.slice(0, 80);
        };
        const buildHealthSummaryFromLore = (healthLore = []) => {
            const scopeKey = JSON.stringify([getChatRuntimeScopeKey(chat, char), LibraDataStorage.scopeKeyFor(char, chat)]);
            if (healthReviewSnapshots.scopeKey !== scopeKey) healthReviewSnapshots = { scopeKey, quarantineRows: null, findings: null };
            const readErrors = [];
            const readRows = (key, source, reader) => {
                try {
                    const rows = reader();
                    if (!Array.isArray(rows)) throw new Error('review_rows_unavailable');
                    healthReviewSnapshots[key] = safeClone(rows);
                    return rows;
                } catch (error) {
                    recordSuppressedRuntimeError(`gui.health.${source}_list_failed`, error);
                    const previous = healthReviewSnapshots[key];
                    readErrors.push({ source, state: Array.isArray(previous) ? 'stale' : 'unavailable' });
                    return Array.isArray(previous) ? safeClone(previous) : [];
                }
            };
            const quarantineRows = readRows('quarantineRows', 'quarantine', () => QuarantineManager.withTemporaryState(() => LibraLoreConsolidator.withRawManagementRead(() => QuarantineManager.list(healthLore, { limit: 80, strictRead: true }))));
            const findings = readRows('findings', 'integrity', () => IntegrityScanner.withTemporaryState(() => LibraLoreConsolidator.withRawManagementRead(() => IntegrityScanner.listFindings(healthLore, { limit: 180, strictRead: true }))));
            const readState = readErrors.some(item => item.state === 'unavailable') ? 'unavailable' : (readErrors.length ? 'stale' : 'current');
            const quarantineKnown = !readErrors.some(item => item.source === 'quarantine');
            const integrityKnown = !readErrors.some(item => item.source === 'integrity');
            const openQuarantine = quarantineRows.filter(item => !['ignored', 'resolved', 'archived'].includes(String(item?.status || ''))).length;
            const openFindings = findings.filter(item => !['ignored', 'resolved', 'accepted'].includes(String(item?.status || 'open'))).length;
            const conflicts = buildConflictRows(quarantineRows, findings);
            const embedding = findings.filter(item => item?.type === 'embedding_fingerprint_mismatch' && !['ignored', 'resolved'].includes(String(item?.status || 'open'))).length;
            const errorCount = findings.filter(item => ['error', 'critical'].includes(String(item?.severity || '')) && !['ignored', 'resolved', 'accepted'].includes(String(item?.status || 'open'))).length;
            const total = openQuarantine + openFindings + conflicts.length;
            return {
                readState,
                readErrors,
                total: readErrors.length ? null : total,
                quarantine: quarantineKnown ? openQuarantine : null,
                conflictCount: readErrors.length ? null : conflicts.length,
                integrity: integrityKnown ? openFindings : null,
                embedding: integrityKnown ? embedding : null,
                severity: readErrors.length ? 'warn' : (errorCount > 0 ? 'error' : (total > 0 ? 'warn' : 'ok')),
                message: readErrors.length
                    ? (readState === 'stale' ? '데이터 헬스 확인 실패 · 이전 결과 표시 중' : '데이터 헬스 확인 불가 · 다시 새로고침해 주세요')
                    : (total > 0
                        ? `데이터 점검 필요 · 검역 ${openQuarantine} · 충돌 ${conflicts.length} · 무결성 ${openFindings}`
                        : '데이터 헬스 정상'),
                quarantineRows,
                findings,
                conflicts
            };
        };
        const renderHealthItem = (item = {}, options = {}) => {
            const type = esc(item.type || item.domain || options.type || 'item');
            const title = esc(item.title || item.reason || item.key || item.id || '항목');
            const status = esc(item.status || item.severity || 'open');
            const detail = esc(getHealthPreview(item.detail || item.preview || item.reason || item.summary?.sourcePreview || '', 260));
            const id = escAttr(item.id || '');
            const action = escAttr(options.action || '');
            const severity = escAttr(item.severity || (item.status === 'blocked' ? 'warn' : ''));
            const repairText = escAttr(item.correction || item.summary?.sourcePreview || item.preview || item.reason || '');
            const cls = severity ? ` health-sev-${severity}` : '';
            const disabled = options.readOnly === true ? ' disabled aria-disabled="true"' : '';
            return `
              <div class="health-item${cls}">
                <div class="health-item-head"><span class="health-item-title">${type} · ${title}</span><span>${status}</span></div>
                <div class="health-item-body">${detail || '세부 정보 없음'}</div>
                <div class="health-actions">
                  <button class="btn bp" type="button" data-health-action="${action}-accept" data-health-id="${id}"${disabled}>승인</button>
                  <button class="btn bs" type="button" data-health-action="${action}-resolve" data-health-id="${id}"${disabled}>해결</button>
                  <button class="btn bd" type="button" data-health-action="${action}-ignore" data-health-id="${id}"${disabled}>무시</button>
                  <button class="btn" type="button" data-health-action="repair-field" data-health-text="${repairText}">보정란</button>
                </div>
              </div>`;
        };
        const buildGuiAcceptedExtractionPayload = prepared => ManagementReviewCore.buildAcceptedPayload(prepared, lore);
        const healthReadMessage = reason => /persona_binding_requires_migration|legacy_persona_ambiguous|canonical_missing_unverified_data/.test(reason || '')
            ? '기존 데이터는 보존했습니다. 페르소나 연결 또는 이관 확인이 필요합니다.'
            : reason === 'canonical_provenance_unverified'
                ? '기존 데이터는 보존했습니다. 기록의 소유 범위 또는 무결성을 확인할 수 없어 읽기 전용입니다.'
            : (/stale_identity|stale_worldline|management_scope_mismatch/.test(reason || '') ? '채팅 또는 페르소나가 변경되었습니다. 화면을 다시 열어 주세요.'
                : '정본 데이터를 확인할 수 없습니다. 이전 표시를 신뢰하지 말고 새로고침해 주세요.');
        // Durable receipt coverage is independent of the canonical integrity scan.
        // Read metadata only; inspecting or opening the existing review route must
        // never finalize, analyze, delete, or otherwise consume a parked receipt.
        const readPendingCaptureForHealth = async (snapshot, serial) => {
            let pending;
            try {
                pending = await PendingTurnManager.inspectDeferred(snapshot.context.char, snapshot.context.chat);
                if (pending?.ok !== true || !Array.isArray(pending.records) || typeof pending.complete !== 'boolean'
                    || !Number.isSafeInteger(pending.scanned) || pending.scanned < 0
                    || !Number.isSafeInteger(pending.currentResetGeneration) || pending.currentResetGeneration < 0) throw new Error('pending_capture_read_unavailable');
                pending = { ...pending, status: 'current' };
            } catch (_) { pending = { status: 'unavailable', records: [], complete: false, scanned: 0 }; }
            // The ledger await can outlive a persona, worldline, reset, or view.
            // Reuse canonical ownership checks before publishing either result.
            const proof = await ManagementReviewCore.read(guiHealthBinding, {
                worldlineRevision: snapshot.worldlineRevision,
                isViewCurrent: () => serial === healthReadSerial && overlay.isConnected
            });
            if (proof.raw !== snapshot.raw) throw new Error('canonical_changed');
            return pending;
        };
        const renderPendingCaptureHealth = (summary) => {
            let node = overlay.querySelector('#health-pending-capture');
            if (!node) {
                node = document.createElement('section');
                node.id = 'health-pending-capture'; node.className = 'health-panel'; node.setAttribute('aria-live', 'polite');
                overlay.querySelector('#health-summary')?.insertAdjacentElement('afterend', node);
            }
            const current = healthReadSource.status === 'current' && summary.readState === 'current' && pendingCaptureRead.status === 'current';
            const complete = current && pendingCaptureRead.complete;
            const rows = current ? pendingCaptureRead.records : [];
            const generation = current ? pendingCaptureRead.currentResetGeneration : null;
            const generationState = row => {
                if (!Number.isSafeInteger(row.resetGeneration) || row.resetGeneration < 0) return 'unknown';
                if (row.generationState === 'current' && row.resetGeneration === generation) return 'current';
                if (row.generationState === 'historical' && row.resetGeneration < generation) return 'historical';
                return 'unknown';
            };
            const currentRows = rows.filter(row => generationState(row) === 'current');
            const historicalRows = rows.filter(row => generationState(row) === 'historical');
            const unknownRows = rows.filter(row => generationState(row) === 'unknown');
            node.dataset.currentResetGeneration = current ? String(generation) : '';
            node.dataset.currentBlockers = current ? String(currentRows.length) : '';
            node.dataset.historicalCount = current ? String(historicalRows.length) : '';
            node.dataset.unknownGenerationCount = current ? String(unknownRows.length) : '';
            node.dataset.readState = current ? 'current' : 'unavailable';
            node.dataset.coverage = current ? (complete ? 'complete' : 'incomplete') : 'unavailable';
            node.dataset.scanned = String(current ? pendingCaptureRead.scanned : 0);
            const warning = !current ? '보류 원문 확인 불가 · 새로고침이 필요합니다. 보류 항목이 없는 것으로 판단하지 않습니다.'
                : !complete ? `보류 원문 일부 확인 · ${pendingCaptureRead.scanned}개 영수증 검사 · 표시 ${rows.length}건. 제한된 범위이며 전체 상태를 정상으로 확정하지 않습니다.`
                : `보류 원문 확인 완료 · ${pendingCaptureRead.scanned}개 영수증 검사 · 현재 세대 ${generation} · 현재 처리 보류 ${currentRows.length}건 · 초기화 이전 ${historicalRows.length}건 · 초기화 세대 미확인 ${unknownRows.length}건`;
            const reasons = {
                blocked_host_source_changed: '호스트 원문이 변경되어 자동 처리를 중단했습니다.',
                pending_queue_capacity: '처리 대기열이 가득 차 원문을 보관하고 있습니다.',
                pending_durable_backlog: '먼저 저장된 원문의 처리를 기다립니다.',
                pending_order_read_unverified: '저장된 원문의 처리 순서를 확인하지 못했습니다.',
                pending_order_scan_incomplete: '처리 순서 검사가 아직 끝나지 않았습니다.',
                pending_retry_exhausted: '자동 확인 재시도 한도에 도달했습니다.'
            };
            const renderRows = entries => entries.map(row => {
                const reason = String(row.deferredReason || row.analysisStatus || 'pending');
                const state = generationState(row);
                return `<div class="health-item${state === 'historical' ? '' : ' health-sev-warn'}" data-pending-reason="${escAttr(reason)}" data-pending-generation="${state}"><div class="health-item-title">요청 ${esc(String(row.requestSequence || 0))} · 원문 위치 ${esc(String(row.originMessageCount || 0))}</div><div>${esc(reasons[reason] || '원문 처리 확인이 필요합니다.')} ${esc(reason)}</div></div>`;
            }).join('');
            const sourceChanged = !unknownRows.length && currentRows.some(row => (row.deferredReason || row.analysisStatus) === 'blocked_host_source_changed');
            node.innerHTML = '<h4>보류된 응답 원문</h4>'
                + `<div class="${!current || !complete || currentRows.length || unknownRows.length ? 'health-sev-warn' : 'empty'}">${esc(warning)}</div>`
                + (rows.length ? '<div>원문은 보존되어 있습니다. 이 화면은 읽기 전용입니다.</div>' : '')
                + (currentRows.length ? '<div id="health-pending-current"><h4>현재 초기화 세대의 처리 보류</h4><div class="health-sev-warn">정본 반영 미완료 · 분석 미완료 상태입니다.</div>' + renderRows(currentRows) + '</div>' : (current && complete && !unknownRows.length ? '<div class="empty">현재 초기화 세대의 보류된 원문 없음</div>' : ''))
                + (historicalRows.length ? '<div id="health-pending-historical"><h4>초기화 이전 보존 원문</h4><div>검증된 초기화 이전에 저장된 기록입니다. 현재 처리 보류 집계에서 제외하며 자동 복원·재분석하지 않습니다.</div>' + renderRows(historicalRows) + '</div>' : '')
                + (unknownRows.length ? '<div id="health-pending-unknown"><h4>초기화 세대 미확인 원문</h4><div class="health-sev-warn">초기화 세대 정보를 확인할 수 없어 현재 기록인지 과거 기록인지 확정하지 않습니다. 미해결 상태이며 정상으로 판단하지 않습니다.</div>' + renderRows(unknownRows) + '</div>' : '')
                + (sourceChanged ? '<div class="health-sev-warn">필요한 호스트 대화 원문을 먼저 확인·복원한 뒤 전체 대화 재분석·보강 병합을 검토하세요. 이 작업은 보류 원문을 자동 복원하거나 완료로 표시하지 않습니다.</div><button class="btn" type="button" id="btn-pending-capture-review">전체 대화 재분석·보강 병합 검토</button>' : '');
            node.querySelector('#btn-pending-capture-review')?.addEventListener('click', () => {
                if (!overlay.isConnected || healthReadSource.status !== 'current' || pendingCaptureRead.status !== 'current') return;
                const target = overlay.querySelector('#btn-cold-reanalyze');
                if (!target || target.disabled) return;
                switchTab('settings');
                target.closest('.acc')?.classList.add('open');
                target.scrollIntoView?.({ block: 'center' });
                target.click();
            });
            if (!current || !complete || currentRows.length || unknownRows.length) {
                if (summary.severity === 'ok') summary.severity = 'warn';
                summary.total = !current || !complete || unknownRows.length || summary.total === null ? null : summary.total + currentRows.length;
                const notice = !current ? '보류 원문 확인 불가' : !complete ? '보류 원문 일부 확인'
                    : unknownRows.length ? `초기화 세대 미확인 원문 ${unknownRows.length}건 · 상태 미확인` : `원문 보존·현재 처리 보류 ${currentRows.length}건`;
                summary.message = summary.message === '데이터 헬스 정상' ? notice : `${summary.message} · ${notice}`;
            } else if (historicalRows.length) {
                const notice = `초기화 이전 원문 ${historicalRows.length}건 보존 · 현재 처리 보류 집계 제외`;
                summary.message = summary.message === '데이터 헬스 정상' ? `현재 초기화 세대 보류 없음 · ${notice}` : `${summary.message} · ${notice}`;
            }
        };
        const acceptQuarantineEntryFromGui = id => runHealthReviewAction('quarantine-accept', id);
        const renderHealthReview = () => {
            const healthLore = Array.isArray(healthReadSource.lore) ? healthReadSource.lore : (Array.isArray(lore) ? lore : effectiveGuiLore);
            const summary = buildHealthSummaryFromLore(healthLore || []);
            if (healthReadSource.status !== 'current') {
                summary.readState = healthReadSource.verified ? 'stale' : 'unavailable';
                summary.readErrors = ['quarantine', 'integrity'].map(source => ({ source, state: summary.readState }));
                summary.total = summary.quarantine = summary.conflictCount = summary.integrity = summary.embedding = null;
                summary.severity = 'warn';
                summary.message = healthReadSource.status === 'pending' ? '정본 데이터 확인 중' : healthReadMessage(healthReadSource.reason);
            }
            const coverage = healthReadSource.coverage || { state: healthLore?.length ? 'unscanned' : 'complete', completed: !healthLore?.length, scannedThrough: 0, total: healthLore?.length || 0 };
            summary.coverageState = healthReadSource.status === 'current' ? coverage.state : 'unavailable';
            summary.scanComplete = healthReadSource.status === 'current' && coverage.completed === true;
            summary.scannedThrough = coverage.scannedThrough || 0; summary.scanTotal = coverage.total || 0;
            if (!summary.scanComplete) {
                if (summary.severity === 'ok') summary.severity = 'warn';
                summary.total = null;
                summary.message = summary.coverageState === 'incomplete' ? '읽기 전용 검사 일부 완료 · 정상으로 확정하지 않습니다'
                    : summary.coverageState === 'unscanned' ? '현재 정본은 아직 검사하지 않았습니다 · 상태 미확인' : summary.message;
            }
            renderPendingCaptureHealth(summary);
            const readOnly = summary.readState !== 'current' || healthReadSource.previewOnly === true;
            const readNotice = source => {
                const error = summary.readErrors.find(item => item.source === source);
                return error ? `<div class="empty health-sev-warn">${error.state === 'stale' ? '읽기 실패 · 이전 결과입니다' : '읽을 수 없음 · 새로고침이 필요합니다'}</div>` : '';
            };
            const summaryNode = overlay.querySelector('#health-summary');
            if (summaryNode) {
                summaryNode.dataset.readState = summary.readState;
                summaryNode.dataset.coverage = summary.coverageState;
                summaryNode.dataset.healthSeverity = summary.severity;
                summaryNode.innerHTML = (readOnly || !summary.scanComplete ? `<div class="health-sev-warn">${esc(summary.message)}</div>` : '') + [
                    buildHealthBadge('검역', summary.quarantine, summary.quarantine ? 'warn' : ''),
                    buildHealthBadge('충돌', summary.conflictCount, summary.conflictCount ? 'warn' : ''),
                    buildHealthBadge('무결성', summary.integrity, summary.integrity ? summary.severity : ''),
                    buildHealthBadge('임베딩 불일치', summary.embedding, summary.embedding ? 'warn' : '')
                ].join('');
            }
            const quarantineNode = overlay.querySelector('#health-quarantine-list');
            if (quarantineNode) {
                const rows = summary.quarantineRows.filter(item => !['ignored', 'resolved', 'archived'].includes(String(item?.status || ''))).slice(0, 40);
                quarantineNode.innerHTML = readNotice('quarantine') + (rows.length
                    ? rows.map(item => renderHealthItem({
                        ...item,
                        title: item.operation || item.domain || item.reason,
                        detail: item.reason || item.summary?.sourcePreview || '',
                        correction: item.summary?.sourcePreview || item.reason || ''
                    }, { action: 'quarantine', readOnly })).join('')
                    : (summary.readErrors.some(item => item.source === 'quarantine') ? '' : '<div class="empty">검역 항목 없음</div>'));
            }
            const conflictNode = overlay.querySelector('#health-conflict-list');
            if (conflictNode) {
                conflictNode.innerHTML = (readOnly ? `<div class="empty health-sev-warn">${esc(summary.message)}</div>` : '') + (summary.conflicts.length
                    ? summary.conflicts.slice(0, 40).map(item => renderHealthItem(item, { action: 'conflict', readOnly })).join('')
                    : (readOnly ? '' : '<div class="empty">충돌 항목 없음</div>'));
            }
            const integrityNode = overlay.querySelector('#health-integrity-list');
            if (integrityNode) {
                const rows = summary.findings.filter(item => !['ignored', 'resolved', 'accepted'].includes(String(item?.status || 'open'))).slice(0, 60);
                integrityNode.innerHTML = readNotice('integrity') + (rows.length
                    ? rows.map(item => renderHealthItem({
                        ...item,
                        title: item.key || item.recordId || item.comment || item.type,
                        detail: item.reason || item.preview || ''
                    }, { action: 'integrity', readOnly })).join('')
                    : (summary.readErrors.some(item => item.source === 'integrity') ? '' : '<div class="empty">무결성 경고 없음</div>'));
            }
            try {
                if (/stale_identity|stale_worldline|management_scope_mismatch|persona_binding_requires_migration/.test(healthReadSource.reason || '')
                    || getActiveManagedRuntimeScopeKey() !== getChatRuntimeScopeKey(chat, char)) return summary;
                ActivityDashboardCore?.updateHealthSummary?.({
                    scopeKey: getActiveManagedRuntimeScopeKey?.() || getChatRuntimeScopeKey(chat, char)
                }, {
                    coverageState: summary.coverageState, scanComplete: summary.scanComplete, scannedThrough: summary.scannedThrough, scanTotal: summary.scanTotal,
                    total: summary.total,
                    quarantine: summary.quarantine,
                    conflicts: summary.conflictCount,
                    readState: summary.readState,
                    integrity: summary.integrity,
                    embedding: summary.embedding,
                    severity: summary.severity,
                    message: summary.message
                });
            } catch (_) {}
            const progress = overlay.querySelector('#health-recovery-status');
            if (progress) {
                progress.dataset.scannedThrough = String(summary.scannedThrough);
                progress.dataset.scanTotal = String(summary.scanTotal);
                progress.textContent = summary.scanComplete ? '읽기 전용 검사 완료 · 현재 정본에 대한 결과입니다.'
                    : summary.coverageState === 'incomplete' ? `읽기 전용 검사 일부 완료 · ${summary.scannedThrough}/${summary.scanTotal} · 같은 정본은 다음 검사에서 이어집니다. 정상으로 확정하지 않습니다.`
                    : '현재 정본은 아직 검사하지 않았습니다 · 상태 미확인';
            }
            return summary;
        };
        const refreshHealthReviewFromStorage = async (announce = false) => {
            const serial = ++healthReadSerial;
            try {
                if (!guiHealthBinding) throw new Error(guiHealthBindingError || 'management_binding_unavailable');
                const result = await ManagementReviewCore.readHealth(guiHealthBinding, { isViewCurrent: () => overlay.isConnected });
                if (serial !== healthReadSerial || !overlay.isConnected) return false;
                const pending = await readPendingCaptureForHealth(result, serial);
                if (serial !== healthReadSerial || !overlay.isConnected) return false;
                pendingCaptureRead = pending;
                healthReadSource = { status: 'current', verified: true, lore: result.lore, reason: '', coverage: result.coverage, previewOnly: result.previewOnly === true };
                renderHealthReview();
                if (announce) toast('정본 헬스 상태를 새로고침했습니다');
                return true;
            } catch (error) {
                if (serial !== healthReadSerial || !overlay.isConnected) return false;
                healthReadSource = { ...healthReadSource, status: 'failed', reason: error?.code || error?.message || 'canonical_read_unavailable' };
                renderHealthReview();
                return false;
            }
        };
        const runHealthReviewAction = async (action, id = '') => {
            if (healthActionBusy || !overlay.isConnected) return false;
            healthActionBusy = true;
            overlay.dataset.healthBusy = 'true';
            const serial = ++healthReadSerial;
            try {
                if (!guiHealthBinding) throw new Error(guiHealthBindingError || 'management_binding_unavailable');
                if (action === 'scan') {
                    const result = await wmHealthOrchestrator.inspect({ binding:guiHealthBinding, isViewCurrent: () => overlay.isConnected });
                    if (serial !== healthReadSerial || !overlay.isConnected) return false;
                    const pending = await readPendingCaptureForHealth(result, serial);
                    if (serial !== healthReadSerial || !overlay.isConnected) return false;
                    pendingCaptureRead = pending;
                    healthReadSource = { status: 'current', verified: true, lore: result.lore, reason: '', previewOnly: true, coverage: result.coverage };
                    renderHealthReview();
                    return true;
                }
                const result = await ManagementReviewCore.commit(guiHealthBinding, { action, id, isViewCurrent: () => overlay.isConnected });
                if (!overlay.isConnected) return false;
                lore = safeClone(result.lore);
                guiPersistedBaselineLore = safeClone(result.lore);
                healthReadSource = { status: 'current', verified: true, lore: safeClone(result.lore), reason: '' };
                syncGuiSnapshotsFromRuntime(result.lore);
                renderAllGuiDataViews();
                renderHealthReview();
                toast(!result.changed ? '이미 처리된 항목입니다' : (action === 'scan' ? (result.completed ? '무결성 스캔 완료' : '무결성 스캔 일부 완료')
                    : (action === 'quarantine-accept' ? '검역 항목 승인 병합 완료' : '헬스 리뷰 상태가 저장되었습니다')));
                return true;
            } catch (error) {
                if (!overlay.isConnected) return false;
                healthReadSource = { ...healthReadSource, status: 'failed', reason: error?.code || error?.message || 'management_action_failed' };
                renderHealthReview();
                toast(error?.canonicalVerified ? '정본은 기록되었지만 화면 또는 호스트 확인이 끝나지 않았습니다. 새로고침해 주세요.' : `헬스 처리 실패 · ${healthReadMessage(healthReadSource.reason)}`);
                return false;
            } finally { healthActionBusy = false; overlay.dataset.healthBusy = 'false'; }
        };
        const NANO_GPT_UI_PROVIDER = 'nanogpt';
        const NANO_GPT_CHAT_COMPLETIONS_URL = 'https://nano-gpt.com/api/v1/chat/completions';
        const PROVIDER_PRESETS = Object.freeze({
            llm: {
                openai: {
                    url: 'https://api.openai.com/v1/chat/completions',
                    urlAliases: ['https://api.openai.com'],
                    models: []
                },
                claude: {
                    url: 'https://api.anthropic.com/v1/messages',
                    urlAliases: ['https://api.anthropic.com'],
                    models: []
                },
                gemini: {
                    url: 'https://generativelanguage.googleapis.com/v1beta',
                    models: []
                },
                openrouter: {
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    urlAliases: ['https://openrouter.ai/api'],
                    models: []
                },
                lmstudio: {
                    url: 'http://localhost:1234/v1/chat/completions',
                    urlAliases: ['http://localhost:1234/v1'],
                    models: []
                },
                ollama: {
                    url: 'http://127.0.0.1:11434',
                    urlAliases: ['http://localhost:11434'],
                    models: []
                },
                ollama_cloud: {
                    url: 'https://ollama.com/v1/chat/completions',
                    urlAliases: ['https://ollama.com'],
                    models: [
                        'glm-5.2:cloud',
                        'glm-5.1:cloud',
                        'glm-5:cloud',
                        'kimi-k2.5:cloud',
                        'kimi-k2.6:cloud',
                        'kimi-k2.7-code:cloud',
                        'deepseek-v4-pro:cloud',
                        'deepseek-v3.2:cloud',
                        'deepseek-v4-flash:cloud',
                        'gemini-3-flash-preview:cloud',
                        'gemma4:26b-a4b-it-q4_K_M',
                        'gemma4:31b-cloud'
                    ]
                },
                nanogpt: {
                    url: NANO_GPT_CHAT_COMPLETIONS_URL,
                    urlAliases: ['https://nano-gpt.com/api', 'https://nano-gpt.com/api/v1'],
                    models: [
                        'zai-org/glm-5.2',
                        'zai-org/glm-5.1',
                        'zai-org/glm-5',
                        'moonshotai/kimi-k2.5',
                        'moonshotai/kimi-k2.6',
                        'moonshotai/kimi-k2.7-code',
                        'deepseek/deepseek-v4-pro',
                        'deepseek/deepseek-v3.2',
                        'deepseek/deepseek-v4-flash',
                        'google/gemma-4-26b-a4b-it',
                        'google/gemma-4-31b-it'
                    ]
                },
                vertex: {
                    url: 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models',
                    models: []
                },
                'vertex-openai': {
                    url: 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi',
                    models: []
                },
                copilot: {
                    url: 'https://api.githubcopilot.com/chat/completions',
                    urlAliases: ['https://api.githubcopilot.com'],
                    models: []
                },
                custom: { url: '', models: [] }
            },
            embedding: {
                openai: {
                    url: 'https://api.openai.com/v1/embeddings',
                    urlAliases: ['https://api.openai.com'],
                    models: []
                },
                gemini: {
                    url: 'https://generativelanguage.googleapis.com/v1beta',
                    models: []
                },
                'gemini-embedding': {
                    url: 'https://generativelanguage.googleapis.com/v1beta',
                    models: []
                },
                lmstudio: {
                    url: 'http://localhost:1234/v1/embeddings',
                    urlAliases: ['http://localhost:1234/v1'],
                    models: []
                },
                ollama: {
                    url: 'http://127.0.0.1:11434',
                    urlAliases: ['http://localhost:11434'],
                    models: []
                },
                vertex: {
                    url: 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models',
                    models: []
                },
                'vertex-embedding': {
                    url: 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models',
                    models: []
                },
                voyageai: {
                    url: 'https://api.voyageai.com/v1/embeddings',
                    urlAliases: ['https://api.voyageai.com'],
                    models: ['voyage-4-large', 'voyage-4', 'voyage-4-lite', 'voyage-context-3']
                },
                custom: { url: '', models: [] }
            }
        });
        const directProviderCatalog = () => {
            try { return globalThis?.LIBRA_DirectProviderCatalog || null; }
            catch (_) { return null; }
        };
        const directProviderOptions = () => {
            try { return directProviderCatalog()?.listProviders?.() || []; }
            catch (_) { return []; }
        };
        const ensureDirectProviderSelectOptions = () => {
            const options = directProviderOptions();
            if (!options.length) return;
            ['#sllmpp'].forEach(selector => {
                const select = overlay.querySelector(selector);
                if (!select || select.querySelector('optgroup[data-direct-providers="1"]')) return;
                const group = document.createElement('optgroup');
                group.label = 'Direct API Providers';
                group.dataset.directProviders = '1';
                options.forEach(item => {
                    if (!item?.key || Array.from(select.options || []).some(option => option.value === item.key)) return;
                    const option = document.createElement('option');
                    option.value = item.key;
                    option.textContent = item.label || item.key;
                    group.appendChild(option);
                });
                if (group.children.length) select.appendChild(group);
            });
        };
        const directProviderGuiPresetFor = (provider = '') => {
            try {
                const meta = directProviderCatalog()?.get?.(provider) || null;
                if (!meta) return null;
                return {
                    url: meta.chatUrl || meta.baseUrl || '',
                    urlAliases: [meta.baseUrl, meta.chatUrl, meta.responsesUrl].filter(Boolean),
                    models: [],
                    supportsResponses: meta.supportsResponses === true,
                    requiresConfiguredUrl: meta.requiresConfiguredUrl === true
                };
            } catch (_) { return null; }
        };
        ensureDirectProviderSelectOptions();

        const vertexSlotSelectors = (slot = 'preset') => {
            const normalized = String(slot || 'preset').trim().toLowerCase();
            if (normalized === 'embedding') return { provider: '#sep', url: '#seu', key: '#sek', model: '#sem', defaultProvider: 'vertex-embedding', defaultModel: 'text-embedding-004' };
            return { provider: '#sllmpp', url: '#sllmpu', key: '#sllmpk', model: '#sllmpm', defaultProvider: 'vertex', defaultModel: 'gemini-2.5-flash' };
        };
        const normalizePresetProviderKey = (provider = '') => {
            const raw = String(provider || '').trim().toLowerCase();
            if (raw === 'anthropic') return 'claude';
            if (raw === 'lm_studio') return 'lmstudio';
            if (raw === 'vertex_openai' || raw === 'vertex-openai-compatible' || raw === 'vertex_openai_compatible') return 'vertex-openai';
            if (raw === 'vertex_embedding') return 'vertex-embedding';
            if (raw === 'nano-gpt' || raw === 'nano_gpt') return NANO_GPT_UI_PROVIDER;
            return raw;
        };
        const providerPresetGroupForSlot = (slot = 'llm') => String(slot || 'llm').trim().toLowerCase() === 'embedding'
            ? PROVIDER_PRESETS.embedding
            : PROVIDER_PRESETS.llm;
        const providerPresetFor = (slot = 'llm', provider = '') => {
            const group = providerPresetGroupForSlot(slot);
            const normalized = normalizePresetProviderKey(provider);
            return group[normalized]
                || (String(slot || 'llm').trim().toLowerCase() !== 'embedding' ? directProviderGuiPresetFor(normalized) : null)
                || group.custom
                || { url: '', models: [] };
        };
        const normalizePresetCompare = (value = '') => String(value || '').trim().replace(/\/+$/, '').toLowerCase();
        const collectPresetValues = (slot = 'llm', field = 'url') => {
            const group = providerPresetGroupForSlot(slot);
            const values = [];
            const presets = [
                ...Object.values(group),
                ...(String(slot || 'llm').trim().toLowerCase() === 'embedding'
                    ? []
                    : directProviderOptions().map(item => directProviderGuiPresetFor(item.key)).filter(Boolean))
            ];
            presets.forEach((preset = {}) => {
                if (field === 'model') {
                    values.push(...(Array.isArray(preset.models) ? preset.models : []));
                } else {
                    if (preset.url) values.push(preset.url);
                    if (Array.isArray(preset.urlAliases)) values.push(...preset.urlAliases);
                }
            });
            return new Set(values.map(normalizePresetCompare).filter(Boolean));
        };
        const isKnownProviderPresetUrl = (value = '', slot = 'llm') => {
            const raw = String(value || '').trim();
            if (!raw) return true;
            if (/PROJECT_ID|my-gcp-project|test-project/i.test(raw)) return true;
            return collectPresetValues(slot, 'url').has(normalizePresetCompare(raw));
        };
        const isKnownProviderPresetModel = (value = '', slot = 'llm') => {
            const raw = String(value || '').trim();
            if (!raw) return true;
            return collectPresetValues(slot, 'model').has(normalizePresetCompare(raw));
        };
        const providerModelDatalistId = (slot = 'preset') => {
            const normalized = String(slot || 'preset').trim().toLowerCase();
            if (normalized === 'embedding') return '#sem-provider-models';
            return '#sllmp-provider-models';
        };
        const syncProviderModelDatalist = (slot = 'llm') => {
            const selectors = vertexSlotSelectors(slot);
            const providerValue = overlay.querySelector(selectors.provider)?.value || '';
            const list = overlay.querySelector(providerModelDatalistId(slot));
            if (!list) return;
            const models = providerPresetFor(slot, providerValue).models || [];
            list.innerHTML = models.map(model => `<option value="${escAttr(model)}"></option>`).join('');
        };
        const applyProviderPresetToSlot = (slot = 'llm', options = {}) => {
            const selectors = vertexSlotSelectors(slot);
            const providerEl = overlay.querySelector(selectors.provider);
            const urlEl = overlay.querySelector(selectors.url);
            const modelEl = overlay.querySelector(selectors.model);
            const providerValue = providerEl?.value || '';
            const preset = providerPresetFor(slot, providerValue);
            syncProviderModelDatalist(slot);
            if (options.fill === false) return;
            const force = options.force === true;
            if (urlEl && preset.url && (force || isKnownProviderPresetUrl(urlEl.value, slot))) urlEl.value = preset.url;
            const primaryModel = Array.isArray(preset.models) ? preset.models[0] : '';
            if (modelEl && primaryModel && (force || isKnownProviderPresetModel(modelEl.value, slot))) modelEl.value = primaryModel;
        };
        const isNanoGPTUrl = (url = '') => /nano-gpt\.com\/api/i.test(String(url || '').trim());
        const providerValueForSettingsUI = (llm = {}, fallback = 'openai') => {
            const provider = normalizePresetProviderKey(llm?.provider || fallback || 'openai');
            if (provider === 'custom' && isNanoGPTUrl(llm?.url)) return NANO_GPT_UI_PROVIDER;
            if (providerPresetFor('llm', provider) !== PROVIDER_PRESETS.llm.custom || provider === 'custom') return provider;
            return fallback || 'openai';
        };
        const normalizeLLMRuntimeProviderFromUI = (llm = {}) => {
            const provider = normalizePresetProviderKey(llm?.provider || 'openai');
            if (provider !== NANO_GPT_UI_PROVIDER) return { ...llm, provider };
            return {
                ...llm,
                provider: 'custom',
                url: String(llm?.url || '').trim() || NANO_GPT_CHAT_COMPLETIONS_URL
            };
        };
        const isVertexProviderValue = (value = '', slot = 'llm') => {
            const raw = String(value || '').trim().toLowerCase();
            return slot === 'embedding'
                ? /^(?:vertex|vertex[-_]?embedding)$/.test(raw)
                : /^(?:vertex|vertex[-_]?openai(?:[-_]?compatible)?)$/.test(raw);
        };
        const vertexProjectIdFromCredential = (credential = {}) => {
            const direct = String(credential?.project_id || credential?.projectId || '').trim();
            if (direct) return direct;
            const email = String(credential?.client_email || '').trim();
            const match = email.match(/@([^.@]+)\.iam\.gserviceaccount\.com$/i);
            return match ? match[1] : '';
        };
        const compactVertexPreview = (value = '', max = 260) => {
            const raw = String(value || '').replace(/\s+/g, ' ').trim();
            return raw.length <= max ? raw : `${raw.slice(0, Math.max(0, max - 14))}...[redacted]`;
        };
        const vertexSuggestedUrlFor = (provider = '', projectId = '') => {
            const project = encodeURIComponent(String(projectId || '').trim());
            if (!project) return '';
            const p = String(provider || '').trim().toLowerCase();
            if (/vertex[-_]?openai/.test(p)) return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/endpoints/openapi`;
            return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models`;
        };
        const shouldReplaceVertexUrl = (value = '') => {
            const raw = String(value || '').trim();
            return !raw || /PROJECT_ID|my-gcp-project|test-project|aiplatform\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/global$/i.test(raw);
        };
        const setVertexPreview = (slot = 'preset', name = '', value = '') => {
            const node = overlay.querySelector(`[data-vertex-json-preview="${slot}:${name}"]`);
            if (node) node.value = String(value || '');
        };
        const syncVertexCredentialPreviewFromKey = (slot = 'preset') => {
            const selectors = vertexSlotSelectors(slot);
            const raw = overlay.querySelector(selectors.key)?.value || '';
            try {
                const credential = JSON.parse(String(raw || '').trim());
                if (!credential || typeof credential !== 'object' || Array.isArray(credential)) throw new Error('not-json-object');
                setVertexPreview(slot, 'project_id', vertexProjectIdFromCredential(credential));
                setVertexPreview(slot, 'client_email', credential.client_email || '');
                setVertexPreview(slot, 'private_key', compactVertexPreview(credential.private_key || credential.access_token || credential.token || ''));
            } catch (_) {
                setVertexPreview(slot, 'project_id', '');
                setVertexPreview(slot, 'client_email', '');
                setVertexPreview(slot, 'private_key', '');
            }
        };
        const syncVertexCredentialPanels = () => {
            ['preset', 'embedding'].forEach((slot) => {
                const selectors = vertexSlotSelectors(slot);
                const providerValue = overlay.querySelector(selectors.provider)?.value || '';
                const active = isVertexProviderValue(providerValue, slot);
                const panel = overlay.querySelector(`[data-vertex-json-slot="${slot}"]`);
                if (panel) panel.hidden = !active;
                syncVertexCredentialPreviewFromKey(slot);
            });
        };
        const loadVertexServiceAccountText = async (slot = 'preset', raw = '') => {
            const selectors = vertexSlotSelectors(slot);
            const statusNode = overlay.querySelector(`[data-vertex-json-status="${slot}"]`);
            try {
                const credential = JSON.parse(String(raw || '').trim());
                if (!credential || typeof credential !== 'object' || Array.isArray(credential)) throw new Error('JSON object required');
                if (!credential.client_email || !credential.private_key) throw new Error('service account client_email/private_key missing');
                const projectId = vertexProjectIdFromCredential(credential);
                const providerEl = overlay.querySelector(selectors.provider);
                const urlEl = overlay.querySelector(selectors.url);
                const keyEl = overlay.querySelector(selectors.key);
                const modelEl = overlay.querySelector(selectors.model);
                const currentProvider = String(providerEl?.value || '').trim().toLowerCase();
                if (providerEl && !isVertexProviderValue(currentProvider, slot)) providerEl.value = selectors.defaultProvider;
                const nextProvider = String(providerEl?.value || selectors.defaultProvider || '').trim().toLowerCase();
                const suggestedUrl = vertexSuggestedUrlFor(nextProvider, projectId);
                if (urlEl && suggestedUrl && shouldReplaceVertexUrl(urlEl.value)) urlEl.value = suggestedUrl;
                if (keyEl) keyEl.value = JSON.stringify(credential);
                if (modelEl && !String(modelEl.value || '').trim()) modelEl.value = selectors.defaultModel;
                setVertexPreview(slot, 'project_id', projectId);
                setVertexPreview(slot, 'client_email', credential.client_email || '');
                setVertexPreview(slot, 'private_key', compactVertexPreview(credential.private_key || ''));
                syncVertexCredentialPanels();
                if (slot === 'preset') syncLLMPresetRequestFormatSupport?.();
                if (statusNode) statusNode.textContent = `JSON 로드 완료: ${credential.client_email}`;
                toast('✅ Vertex 서비스 계정 JSON을 불러왔습니다. 전역 설정에 자동 저장됩니다.');
                return true;
            } catch (error) {
                if (statusNode) statusNode.textContent = `JSON 로드 실패: ${error?.message || error}`;
                toast(`❌ Vertex JSON 로드 실패: ${error?.message || error}`);
                return false;
            }
        };
        const loadVertexServiceAccountFile = async (slot = 'preset', file = null) => {
            if (!file?.text) return false;
            return loadVertexServiceAccountText(slot, await file.text());
        };

        const promptManualLorebookText = () => new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.style.position = 'fixed';
            backdrop.style.inset = '0';
            backdrop.style.background = 'rgba(0,0,0,0.55)';
            backdrop.style.display = 'flex';
            backdrop.style.alignItems = 'center';
            backdrop.style.justifyContent = 'center';
            backdrop.style.zIndex = '100000';

            const modal = document.createElement('div');
            modal.style.width = 'min(92vw, 680px)';
            modal.style.background = 'var(--bg)';
            modal.style.border = '1px solid var(--border)';
            modal.style.borderRadius = '12px';
            modal.style.padding = '14px';
            modal.style.boxShadow = '0 10px 32px rgba(0,0,0,0.45)';

            const title = document.createElement('div');
            title.textContent = '수동 로어북 추가';
            title.style.fontSize = '14px';
            title.style.fontWeight = '600';
            title.style.marginBottom = '8px';

            const hint = document.createElement('div');
            hint.textContent = '손요약, 정리 메모, 설정 문서를 그대로 붙여넣으면 원본은 lmai_user 로 저장되고, 메인 LLM이 분석해 LIBRA 데이터에 병합합니다.';
            hint.style.fontSize = '12px';
            hint.style.color = 'var(--text2)';
            hint.style.lineHeight = '1.5';
            hint.style.marginBottom = '10px';

            const textarea = document.createElement('textarea');
            textarea.className = 'ec';
            textarea.rows = 14;
            textarea.placeholder = '직접 정리한 요약, 설정, 인물 메모, 세계관 노트 등을 입력하세요.';
            textarea.style.width = '100%';
            textarea.style.resize = 'vertical';

            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.justifyContent = 'flex-end';
            actions.style.gap = '8px';
            actions.style.marginTop = '12px';

            const slotWrap = document.createElement('div');
            slotWrap.style.display = 'flex';
            slotWrap.style.alignItems = 'center';
            slotWrap.style.gap = '6px';
            slotWrap.style.marginRight = 'auto';

            const slotLabel = document.createElement('span');
            slotLabel.textContent = '저장 번호';
            slotLabel.style.fontSize = '12px';
            slotLabel.style.color = 'var(--text2)';

            const minusBtn = document.createElement('button');
            minusBtn.className = 'btn bd';
            minusBtn.textContent = '-';
            minusBtn.style.minWidth = '36px';

            const slotInput = document.createElement('input');
            slotInput.type = 'number';
            slotInput.min = '1';
            slotInput.step = '1';
            slotInput.value = '1';
            slotInput.style.width = '72px';

            const plusBtn = document.createElement('button');
            plusBtn.className = 'btn bs';
            plusBtn.textContent = '+';
            plusBtn.style.minWidth = '36px';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn bd';
            cancelBtn.textContent = '취소';
            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn bp';
            saveBtn.textContent = '저장';

            const close = (value) => {
                backdrop.remove();
                resolve(value);
            };
            const getSlotNumber = () => Math.max(1, parseInt(slotInput.value, 10) || 1);
            minusBtn.onclick = () => { slotInput.value = String(Math.max(1, getSlotNumber() - 1)); };
            plusBtn.onclick = () => { slotInput.value = String(getSlotNumber() + 1); };
            cancelBtn.onclick = () => close(null);
            saveBtn.onclick = () => {
                const text = String(textarea.value || '').trim();
                close(text ? { text, slotNumber: getSlotNumber() } : null);
            };
            backdrop.addEventListener('click', (e) => {
                if (e.target === backdrop) close(null);
            });

            slotWrap.appendChild(slotLabel);
            slotWrap.appendChild(minusBtn);
            slotWrap.appendChild(slotInput);
            slotWrap.appendChild(plusBtn);
            actions.appendChild(slotWrap);
            actions.appendChild(cancelBtn);
            actions.appendChild(saveBtn);
            modal.appendChild(title);
            modal.appendChild(hint);
            modal.appendChild(textarea);
            modal.appendChild(actions);
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
            textarea.focus();
        });
        const buildUserLorebookEntry = (text, slotNumber) => ({
            key: `lmai_user_${Math.max(1, parseInt(slotNumber, 10) || 1)}`,
            secondkey: 'user manual summary, libra user lorebook',
            comment: 'lmai_user',
            content: String(text || '').trim(),
            mode: 'normal',
            insertorder: 2,
            alwaysActive: true
        });
        const addManualUserLorebook = async () => {
            const payload = await promptManualLorebookText();
            if (!payload?.text) return;
            if (!char || !chat) throw new Error("채팅방을 찾을 수 없습니다.");

            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const entry = buildUserLorebookEntry(payload.text, payload.slotNumber);
                const hasExistingSlot = lore.some(item => item?.comment === 'lmai_user' && String(item?.key || '') === entry.key);
                if (hasExistingSlot) {
                    const shouldOverwrite = await Utils.confirmEx('데이터가 덮어씌워집니다. 정말 저장하시겠습니까?');
                    if (!shouldOverwrite) {
                        toast('↩️ 수동 로어북 저장이 취소되었습니다');
                        return;
                    }
                }
                const nextLore = [
                    ...lore.filter(item => !(item?.comment === 'lmai_user' && String(item?.key || '') === entry.key)),
                    entry
                ];
                await saveLoreToChar(nextLore);
                syncGuiSnapshotsFromRuntime();

                await ColdStartManager.integrateImportedKnowledge(
                    [payload.text],
                    `User Lorebook #${entry.key.replace('lmai_user_', '')}`,
                    {
                        sourceId: 'user_lorebook',
                        updateNarrative: true,
                        worldNote: `Updated via User Lorebook #${entry.key.replace('lmai_user_', '')}`,
                        targetChar,
                        targetChat
                    }
                );

                lore = MemoryEngine.getLorebook(targetChar, targetChat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderAllGuiDataViews();
                toast('✅ 수동 로어북 저장 및 병합 완료');
            } catch (e) {
                throw e;
            }
        };
        const syncGuiSnapshotsFromRuntime = (verifiedLore = null) => {
            // Rebuild the effective view from the newest local lore.  Cold start,
            // reanalysis and detached post-processing can replace chat.localLore
            // while this window is open; retaining the old effective array made
            // World Additional and planner tabs jump back to a stale snapshot.
            const displayChat = chat && typeof chat === 'object'
                ? { ...chat, localLore: Array.isArray(lore) ? lore : [] }
                : chat;
            guiPersistedBaselineLore = (Array.isArray(lore) ? lore : []).map(entry => safeClone(entry));
            effectiveGuiLore = Array.isArray(verifiedLore) ? safeClone(verifiedLore) : (char ? (MemoryEngine.getEffectiveLorebook(char, displayChat) || lore) : lore);
            try { EntityManager.rebuildCache(effectiveGuiLore); }
            catch (error) { recordSuppressedRuntimeError('gui.entity_cache_rebuild_failed', error, { loreCount: effectiveGuiLore.length }); }
            _MEM = effectiveGuiLore.filter(e => e.comment === 'lmai_memory');
            _ENT = effectiveGuiLore.filter(e => e.comment === 'lmai_entity');
            _REL = effectiveGuiLore.filter(e => e.comment === 'lmai_relation');
            applyGuiEntityBlocklistToLocalSnapshots();
            _NARRATIVE_INSPECTOR = buildNarrativeInspectorSnapshot(effectiveGuiLore, {
                narrativeState: NarrativeTracker.getState?.() || { storylines: [], turnLog: [], lastSummaryTurn: 0 },
                storyAuthorState: StoryAuthor.getState?.() || {},
                directorState: Director.getState?.() || {},
                config: _CFG
            });
            _NAR = safeClone(_NARRATIVE_INSPECTOR.narrative.state || { storylines: [], turnLog: [], lastSummaryTurn: 0 });
            _AUTHOR = safeClone(_NARRATIVE_INSPECTOR.storyAuthor.state || {});
            _DIRECTOR = safeClone(_NARRATIVE_INSPECTOR.director.state || {});
            syncWorldSnapshotFromRuntime();
        };
        const syncWorldSnapshotFromRuntime = () => {
            const profile = HierarchicalWorldManager.getProfile();
            if (!profile) return;
            _WLD = {
                version: profile.version || '6.0',
                nodes: Array.from(profile.nodes.entries()),
                activePath: Array.isArray(profile.activePath) ? [...profile.activePath] : [],
                // 멀티노드(2단계) — 동시에 활성인 위치들. activePath 는 "주 초점"이라
                //   이것이 없으면 활성인 위치가 화면에서 "이력"으로 잘못 표시된다.
                activeNodes: Array.isArray(profile.activeNodes) ? [...profile.activeNodes] : [],
                global: { ...(profile.global || {}) },
                interference: safeClone(profile.interference || { level: 0, recentEvents: [] }),
                meta: safeClone(profile.meta || {}),
                rootId: profile.rootId || null
            };
        };
        const getGuiEntityBlocklist = () => normalizeEntityBlocklistCollection(_CFG.entityBlocklist || MemoryEngine.CONFIG.entityBlocklist || []);
        const getGuiBlockedEntityLoreEntryName = (entry) => {
            try {
                const parsed = JSON.parse(entry?.content || '{}');
                return String(parsed?.name || '').trim();
            } catch {
                return '';
            }
        };
        const getGuiBlockedRelationNames = (entry) => {
            try {
                const parsed = JSON.parse(entry?.content || '{}');
                return [String(parsed?.entityA || '').trim(), String(parsed?.entityB || '').trim()].filter(Boolean);
            } catch {
                return [];
            }
        };
        const applyGuiEntityBlocklistToLocalSnapshots = () => {
            _ENT = _ENT.filter(entry => {
                const name = getGuiBlockedEntityLoreEntryName(entry);
                return !name || !EntityManager.isBlockedEntityName(name, lore);
            });
            _REL = _REL.filter(entry => {
                const names = getGuiBlockedRelationNames(entry);
                return !names.some(name => EntityManager.isBlockedEntityName(name, lore));
            });
        };
        const applyEntityBlocklistConfig = async (names, options = {}) => {
            if (options.persist !== false && typeof flushPendingGlobalSettingsAutoSave === 'function') {
                const flushed = await flushPendingGlobalSettingsAutoSave('entity-blocklist-preflight');
                if (flushed === false) throw new Error('전역 설정 사전 저장 실패');
            }
            return queueCommonPluginSettingsMutation(async () => {
                const current = options.persist !== false
                    ? await readCommonPluginSettingsForMutation(MemoryEngine.CONFIG)
                    : { ...MemoryEngine.CONFIG, ..._CFG };
                const previous = normalizeEntityBlocklistCollection(current.entityBlocklist || []);
                const normalized = normalizeEntityBlocklistCollection(typeof names === 'function' ? names(previous) : names);
                const nextConfig = { ...current, entityBlocklist: normalized };
                if (options.persist !== false) await writeCommonPluginSettings(JSON.stringify(nextConfig));
                // No runtime, snapshot or cache mutation precedes verified storage.
                try {
                    _CFG.entityBlocklist = normalized;
                    MemoryEngine.CONFIG.entityBlocklist = normalized;
                    applyGuiEntityBlocklistToLocalSnapshots();
                    EntityManager.pruneBlockedEntries(lore);
                    EntityCandidateCore?.prunePromotedOrBlocked?.(lore, { source: 'gui.entityBlocklist', blocklist: normalized });
                } catch (error) {
                    if (options.persist === false) throw error;
                    throw entityBlocklistCleanupError(error);
                }
                return normalized;
            });
        };
        const entityBlocklistCleanupError = (cause) => {
            const error = new Error(`설정 저장 완료 · 정리 실패: ${cause?.message || cause}`);
            error.settingsCommitted = true;
            error.cause = cause;
            return error;
        };
        const persistGuiEntitySnapshots = async (successMessage = '') => {
            let newLore = [];
            _ENT.forEach(e => newLore.push(e));
            _REL.forEach(r => newLore.push(r));
            _MEM.forEach(m => newLore.push(m));
            await saveLoreToChar(buildFullManagedLoreSnapshot(newLore), () => {
                if (successMessage) toast(successMessage);
            });
        };
        const blockEntityFromGui = async (rawName, options = {}) => {
            const name = String(rawName || '').trim();
            if (!name) throw new Error('차단할 엔티티 이름이 비어 있습니다.');
            const canonical = EntityManager.normalizeName(name, lore) || name;
            await applyEntityBlocklistConfig(current => [...current, canonical], { persist: true });
            if (options.removeStoredData !== false) {
                try { await persistGuiEntitySnapshots(); }
                catch (error) { throw entityBlocklistCleanupError(error); }
            }
            syncGuiSnapshotsFromRuntime();
            renderEnts();
            return canonical;
        };
        const renameEntityAcrossRuntime = async (oldNameRaw, newNameRaw, options = {}) => {
            const oldName = String(oldNameRaw || '').trim();
            const newName = String(newNameRaw || '').trim();
            if (!oldName || !newName) throw new Error('기존 이름과 새 이름이 모두 필요합니다.');
            const { targetChar, targetChat } = await resolveGuiTargetContext();
            const scopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
            const chatId = String(targetChat?.id || getActiveManagedChatId() || '').trim();
            const workingLore = MemoryEngine.getLorebook(targetChar, targetChat) || lore || [];
            lore = Array.isArray(workingLore) ? workingLore : [];
            effectiveGuiLore = MemoryEngine.getEffectiveLorebook(targetChar, targetChat) || lore;
            SecretKnowledgeCore.loadState(lore, { scopeKey, chatId });
            EntityKnowledgeVaultCore.loadState(lore, { scopeKey, chatId });
            TimeEngine.loadState(lore, { scopeKey, chatId });
            EntityManager.rebuildCache(lore);
            NarrativeTracker.loadState(lore);
            StoryAuthor.loadState(lore);
            Director.loadState(lore);
            WorldAdditionalCore.loadState?.(lore, { scopeKey, chatId });
            UserDlcCore.loadState?.(lore, { scopeKey, chatId });
            CharacterStateTracker.loadState(lore);
            WorldStateTracker.loadState(lore);

            const oldCanonical = EntityManager.normalizeName(oldName, lore) || oldName;
            const newCanonical = String(newName || '').trim();
            if (!oldCanonical || !newCanonical) throw new Error('이름 정규화에 실패했습니다.');
            if (oldCanonical === newCanonical) return { ok: false, reason: 'same_name', oldName: oldCanonical, newName: newCanonical };
            const oldViewerId = SecretKnowledgeCore.entityViewerId(oldCanonical);
            const newViewerId = `entity:${newCanonical}`;
            const oldTimeKey = oldCanonical.toLowerCase();
            const newTimeKey = newCanonical.toLowerCase();
            const renameResult = EntityManager.renameEntity(oldCanonical, newCanonical, lore, {
                source: 'gui_rename',
                keepOldNameAsAlias: options.keepOldNameAsAlias
            });
            if (!renameResult?.ok) {
                throw new Error(`이름 변경 실패: ${renameResult?.reason || 'unknown'}`);
            }
            const renameContext = {
                oldName: renameResult.oldName || oldCanonical,
                newName: renameResult.newName || newCanonical,
                oldViewerId,
                newViewerId,
                previousNames: renameResult.previousNames || [oldCanonical]
            };
            SecretKnowledgeCore.renameEntityReferences?.(renameContext);
            EntityKnowledgeVaultCore.renameEntityViewer?.(renameContext);
            TimeEngine.renameEntityAnchor?.(oldCanonical, newCanonical, { oldKey: oldTimeKey, newKey: newTimeKey });
            NarrativeTracker.renameEntityReferences?.(oldCanonical, newCanonical, renameContext);
            StoryAuthor.renameEntityReferences?.(oldCanonical, newCanonical, renameContext);
            Director.renameEntityReferences?.(oldCanonical, newCanonical, renameContext);
            WorldAdditionalCore.renameEntityReferences?.(oldCanonical, newCanonical, renameContext);
            UserDlcCore.renameEntityReferences?.(oldCanonical, newCanonical, renameContext);
            CharacterStateTracker.renameEntityKey?.(oldCanonical, newCanonical, renameContext);
            MemoryEngine.renameEntityReferencesInLore?.(lore, oldCanonical, newCanonical, { ...renameContext, scopeKey, currentTurn: MemoryEngine.getCurrentTurn?.() || 0 });

            await EntityManager.saveToLorebook(targetChar, targetChat, lore);
            await SecretKnowledgeCore.saveState(lore, { scopeKey, chatId });
            await EntityKnowledgeVaultCore.saveState(lore, { scopeKey, chatId });
            await TimeEngine.saveState(lore, { scopeKey, chatId });
            await NarrativeTracker.saveState(lore);
            await StoryAuthor.saveState?.(lore);
            await Director.saveState?.(lore);
            await WorldAdditionalCore.saveState?.(lore);
            await UserDlcCore.saveState?.(lore);
            await CharacterStateTracker.saveState(lore);
            await WorldStateTracker.saveState(lore);
            await saveLoreToChar(lore);
            syncGuiSnapshotsFromRuntime();
            renderEnts();
            return renameResult;
        };
        const markEntityAbsorptionFromGui = async (sourceNameRaw, targetNameRaw, options = {}) => {
            const sourceName = String(sourceNameRaw || '').trim();
            const targetName = String(targetNameRaw || '').trim();
            if (!sourceName || !targetName) throw new Error('흡수 소스와 대상 이름이 모두 필요합니다.');
            const { targetChar, targetChat } = await resolveGuiTargetContext();
            const scopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
            const chatId = String(targetChat?.id || getActiveManagedChatId() || '').trim();
            const workingLore = MemoryEngine.getLorebook(targetChar, targetChat) || lore || [];
            lore = Array.isArray(workingLore) ? workingLore : [];
            effectiveGuiLore = MemoryEngine.getEffectiveLorebook(targetChar, targetChat) || lore;
            SecretKnowledgeCore.loadState(lore, { scopeKey, chatId });
            EntityKnowledgeVaultCore.loadState(lore, { scopeKey, chatId });
            TimeEngine.loadState(lore, { scopeKey, chatId });
            EntityManager.rebuildCache(lore);
            NarrativeTracker.loadState(lore);
            StoryAuthor.loadState(lore);
            Director.loadState(lore);
            WorldAdditionalCore.loadState?.(lore, { scopeKey, chatId });
            UserDlcCore.loadState?.(lore, { scopeKey, chatId });
            CharacterStateTracker.loadState(lore);
            WorldStateTracker.loadState(lore);

            const result = EntityManager.markEntityAbsorption(sourceName, targetName, lore, {
                source: 'gui_absorption',
                reason: options.reason || 'manual_gui_absorption'
            });
            if (!result?.ok) throw new Error(`흡수 지정 실패: ${result?.reason || 'unknown'}`);
            await EntityManager.saveToLorebook(targetChar, targetChat, lore);
            await saveLoreToChar(lore);
            syncGuiSnapshotsFromRuntime();
            renderEnts();
            return result;
        };
        const cancelEntityAbsorptionFromGui = async (sourceNameRaw) => {
            const sourceName = String(sourceNameRaw || '').trim();
            if (!sourceName) throw new Error('흡수 취소할 엔티티 이름이 비어 있습니다.');
            const { targetChar, targetChat } = await resolveGuiTargetContext();
            const workingLore = MemoryEngine.getLorebook(targetChar, targetChat) || lore || [];
            lore = Array.isArray(workingLore) ? workingLore : [];
            effectiveGuiLore = MemoryEngine.getEffectiveLorebook(targetChar, targetChat) || lore;
            EntityManager.rebuildCache(lore);
            const result = EntityManager.cancelEntityAbsorption(sourceName, lore);
            if (!result?.ok) throw new Error(`흡수 취소 실패: ${result?.reason || 'unknown'}`);
            await EntityManager.saveToLorebook(targetChar, targetChat, lore);
            await saveLoreToChar(lore);
            syncGuiSnapshotsFromRuntime();
            renderEnts();
            return result;
        };
        const unblockEntityFromGui = async (rawName) => {
            const name = String(rawName || '').trim();
            if (!name) return '';
            await applyEntityBlocklistConfig(current => current.filter(item => item !== name), { persist: true });
            syncGuiSnapshotsFromRuntime();
            renderEnts();
            toast(`✅ ${name} 차단 해제됨`);
            return name;
        };
        const persistWorldGraphFromGui = async (successMessage = '', renderAfterSave = true) => {
            let newLore = [];
            _ENT.forEach(e => newLore.push(e));
            _REL.forEach(r => newLore.push(r));
            _MEM.forEach(m => newLore.push(m));
            const nextLore = buildFullManagedLoreSnapshot(newLore);
            HierarchicalWorldManager.saveWorldGraphUnsafe?.(nextLore);
            await saveLoreToChar(nextLore, () => {
                if (renderAfterSave) {
                    renderWorld();
                    renderWorldAdditional();
                }
                if (successMessage) toast(successMessage);
            });
            return true;
        };
        const buildWorldFallbackFromText = (sourceText = '') => {
            const raw = String(sourceText || '').trim();
            // Fallback is intentionally non-inferential: when LLM extraction fails,
            // preserve source context for a retry/audit but never synthesize world
            // rules from local genre or keyword heuristics.
            return normalizeWorldRuleUpdate({
                classification: { primary: '' },
                exists: {},
                systems: {},
                physics: {},
                custom: {},
                __genreSourceText: truncateForLLM(raw, 2000, ' ... ')
            });
        };
        const readStructuredWorldFlagFromPayload = (worldPayload = {}, keys = []) => {
            const roots = [worldPayload?.global, worldPayload?.structure, worldPayload?.flags, worldPayload?.meta];
            for (const root of roots) {
                if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
                for (const key of keys) {
                    if (root[key] === true) return true;
                    if (root[key] === false) return false;
                }
            }
            return undefined;
        };
        const applyGlobalFlagsFromWorldSignals = (signalText = '', worldPayload = {}) => {
            const profile = HierarchicalWorldManager.getProfile?.();
            if (!profile?.global) return;
            const extractedSystems = worldPayload?.systems && typeof worldPayload.systems === 'object' ? worldPayload.systems : {};
            const applyFlag = (targetKey, sourceKeys) => {
                const value = readStructuredWorldFlagFromPayload(worldPayload, sourceKeys);
                if (value === true || value === false) profile.global[targetKey] = value;
            };
            applyFlag('multiverse', ['multiverse', 'multiVerse', 'multipleWorlds', 'multiple_worlds']);
            applyFlag('dimensionTravel', ['dimensionTravel', 'dimension_travel', 'interdimensionalTravel', 'interdimensional_travel']);
            applyFlag('timeTravel', ['timeTravel', 'time_travel', 'timeLoop', 'time_loop']);
            applyFlag('metaNarrative', ['metaNarrative', 'meta_narrative', 'fourthWall', 'fourth_wall']);
            applyFlag('virtualReality', ['virtualReality', 'virtual_reality', 'simulation']);
            applyFlag('dreamWorld', ['dreamWorld', 'dream_world']);
            applyFlag('reincarnationPossession', ['reincarnationPossession', 'reincarnation_possession', 'reincarnation', 'possession', 'transmigration']);
            const explicitSystemInterface = readStructuredWorldFlagFromPayload(worldPayload, ['systemInterface', 'system_interface']);
            const structuredSystemInterface = [
                extractedSystems.systemInterface,
                extractedSystems.system_interface,
                extractedSystems.leveling,
                extractedSystems.stats,
                extractedSystems.skills,
                extractedSystems.classes,
                extractedSystems.quests,
                extractedSystems.inventory
            ].some(value => value === true);
            if (explicitSystemInterface === true || explicitSystemInterface === false) {
                profile.global.systemInterface = explicitSystemInterface;
            } else if (structuredSystemInterface) {
                profile.global.systemInterface = true;
            }
        };
        const mergeWorldCorrectionRules = (base, overlay) => {
            const target = (base && typeof base === 'object' && !Array.isArray(base)) ? safeClone(base) : {};
            const source = (overlay && typeof overlay === 'object' && !Array.isArray(overlay)) ? overlay : {};
            for (const [key, value] of Object.entries(source)) {
                if (Array.isArray(value)) {
                    target[key] = [...new Set([...(Array.isArray(target[key]) ? target[key] : []), ...value])];
                } else if (value && typeof value === 'object') {
                    const nextBase = (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) ? target[key] : {};
                    target[key] = mergeWorldCorrectionRules(nextBase, value);
                } else {
                    target[key] = value;
                }
            }
            return target;
        };
        const applyCorrectionPriorityWorldRules = (existingRules, interpretedWorld, correctionText = '') => {
            const baseRules = existingRules && typeof existingRules === 'object' ? safeClone(existingRules) : {};
            const merged = mergeWorldCorrectionRules(baseRules, normalizeWorldRuleUpdate(interpretedWorld || {}));
            return sanitizeWorldRuleUpdateForPolicy(merged, collectWorldRuleEvidenceText(interpretedWorld || {}, correctionText));
        };
        const interpretUserWorldCorrection = async (rawText) => {
            const correctionText = String(rawText || '').trim();
            if (!correctionText) return null;
            try {
                const analysisConfig = buildFastAnalysisProfile(MemoryEngine.CONFIG, { maxCompletionTokens: 1800, routeKey: 'guiWorldReanalysis', fallbackProfile: 'aux' }).config;
                const currentWorldPrompt = HierarchicalWorldManager.formatForPrompt() || '(none)';
                const storedInfo = EntityAwareProcessor.formatStoredInfoForExtraction(8, {
                    conversationText: correctionText,
                    maxChars: 4200
                });
                let correctionLorebook = lore;
                try {
                    const correctionContext = await resolveGuiTargetContext();
                    correctionLorebook = MemoryEngine.getLorebook(correctionContext?.targetChar || char, correctionContext?.targetChat) || lore;
                } catch (contextError) {
                    recordRuntimeDebug('warn', '[LIBRA] User world correction lorebook fallback:', contextError?.message || contextError);
                }
                const extraction = await EntityAwareProcessor.extractFromConversation(
                    '[세계관 수동 보정 요청]\n사용자가 직접 입력한 세계관 수정 원문을 기반으로, 현재 세계 규칙을 다시 해석해 world JSON만 보정하라.',
                    [
                        '[User World Correction]',
                        correctionText,
                        '',
                        '[Current World Context]',
                        currentWorldPrompt
                ].join('\n'),
                storedInfo,
                analysisConfig,
                {
                    taskInstruction: '[세계관 수동 보정 요청]\n사용자가 직접 입력한 세계관 수정 원문을 기반으로, 현재 세계 규칙을 다시 해석해 world JSON만 보정하라.',
                    canonicalEvidenceText: [
                        '[User World Correction]',
                        correctionText,
                        '',
                        '[Current World Context]',
                        currentWorldPrompt
                    ].join('\n'),
                    evidenceLabel: 'Authoritative User World Correction',
                    evidencePolicy: false,
                    lorebook: Array.isArray(correctionLorebook) ? correctionLorebook : []
                }
            );
                let worldPayload = extraction?.success === false
                    ? buildWorldFallbackFromText(correctionText)
                    : (extraction?.world && typeof extraction.world === 'object'
                        ? extraction.world
                        : buildWorldFallbackFromText(correctionText));
                const verified = await EntityAwareProcessor.verifyTurnCorrections(
                    '[world correction]',
                    correctionText,
                    { entities: [], relations: [], world: worldPayload },
                    analysisConfig
                );
                if (verified?.world && Object.keys(verified.world).length > 0) {
                    worldPayload = {
                        ...worldPayload,
                        ...verified.world,
                        __genreSourceText: String(worldPayload?.__genreSourceText || correctionText).trim()
                    };
                }
                return {
                    ...safeClone(worldPayload),
                    ...normalizeWorldRuleUpdate(worldPayload)
                };
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] User world correction interpretation fallback:', e?.message || e);
                const fallbackWorld = buildWorldFallbackFromText(correctionText);
                return {
                    ...safeClone(fallbackWorld),
                    ...normalizeWorldRuleUpdate(fallbackWorld)
                };
            }
        };
        const saveWorldCorrectionFromGui = async () => {
            if (!_WLD || !Array.isArray(_WLD.nodes) || _WLD.nodes.length === 0) {
                throw new Error("세계관 데이터가 없습니다.");
            }
            const box = overlay.querySelector('#world-user-correction');
            const nextText = String(box?.value || '').trim();
            const activePath = Array.isArray(_WLD.activePath) && _WLD.activePath.length > 0 ? _WLD.activePath : [];
            const targetId = activePath[activePath.length - 1] || _WLD.rootId || (_WLD.nodes[0] && _WLD.nodes[0][0]);
            if (!targetId) throw new Error("현재 세계 노드를 찾을 수 없습니다.");
            const nodeIndex = _WLD.nodes.findIndex(entry => entry && entry[0] === targetId);
            if (nodeIndex < 0) throw new Error("현재 세계 노드를 찾을 수 없습니다.");
            const entry = _WLD.nodes[nodeIndex];
            const node = entry?.[1] && typeof entry[1] === 'object' ? safeClone(entry[1]) : {};
            node.meta = node.meta && typeof node.meta === 'object' ? safeClone(node.meta) : {};
            node.meta.worldMetadata = node.meta.worldMetadata && typeof node.meta.worldMetadata === 'object' ? safeClone(node.meta.worldMetadata) : {};
            node.meta.userWorldCorrection = nextText;
            node.meta.worldMetadata.userWorldCorrection = nextText;
            // ★ 교정의 **출처 턴**을 남긴다 — 이게 없으면 분기 상속에서
            //   부모가 포크 이후에 쓴 보정이 자식에게 그대로 넘어간다(실측 격차).
            //   `0`(턴 미상)이면 도장을 만들지 않는다 — 상속 판정이 보수적으로 남게.
            const correctionTurn = Number(MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            if (correctionTurn > 0) {
                node.meta.worldCorrectionTurn = correctionTurn;
                node.meta.worldMetadata.worldCorrectionTurn = correctionTurn;
            }
            let interpretedWorld = null;
            if (nextText) {
                try {
                    interpretedWorld = await interpretUserWorldCorrection(nextText);
                } catch (e) {
                    recordRuntimeDebug('warn', '[LIBRA] saveWorldCorrectionFromGui interpretation skipped:', e?.message || e);
                    interpretedWorld = null;
                }
            }
            if (interpretedWorld) {
                const worldMetaPayload = buildWorldMetaPayload(interpretedWorld, node.meta || {});
                node.rules = applyCorrectionPriorityWorldRules(node.rules, interpretedWorld, nextText);
                node.meta.classification = worldMetaPayload.classification;
                node.meta.worldSummary = worldMetaPayload.worldSummary;
                node.meta.worldMetadata = {
                    ...(worldMetaPayload.worldMetadata || {}),
                    userWorldCorrection: nextText
                };
                applyGlobalFlagsFromWorldSignals(nextText, interpretedWorld);
            }
            node.meta.updated = Date.now();
            _WLD.nodes[nodeIndex] = [entry[0], node];

            const liveProfile = HierarchicalWorldManager.getProfile?.();
            if (liveProfile?.nodes instanceof Map && liveProfile.nodes.has(targetId)) {
                const liveUpdate = {
                    meta: {
                        userWorldCorrection: nextText,
                        worldMetadata: { userWorldCorrection: nextText }
                    }
                };
                if (interpretedWorld) {
                    const worldMetaPayload = buildWorldMetaPayload(interpretedWorld, liveProfile.nodes.get(targetId)?.meta || {});
                    liveUpdate.rules = applyCorrectionPriorityWorldRules(liveProfile.nodes.get(targetId)?.rules, interpretedWorld, nextText);
                    liveUpdate.meta = {
                        ...liveUpdate.meta,
                        classification: worldMetaPayload.classification,
                        worldSummary: worldMetaPayload.worldSummary,
                        worldMetadata: {
                            ...(worldMetaPayload.worldMetadata || {}),
                            userWorldCorrection: nextText
                        }
                    };
                }
                HierarchicalWorldManager.updateNode(targetId, liveUpdate);
            }
            syncWorldSnapshotFromRuntime();
            await persistWorldGraphFromGui(nextText ? "💾 세계관 보정 저장 완료" : "🧹 세계관 보정 삭제 완료", true);
            return true;
        };
        const stringifyWorldSourceValue = (value) => {
            if (value == null) return '';
            if (typeof value === 'string') return value.trim();
            if (Array.isArray(value)) {
                return value.map(item => stringifyWorldSourceValue(item)).filter(Boolean).join('\n');
            }
            if (typeof value === 'object') {
                try { return JSON.stringify(value, null, 2); }
                catch { return String(value || '').trim(); }
            }
            return String(value || '').trim();
        };
        const collectCharacterWorldSourceTexts = (targetChar = null, targetChat = null) => {
            const texts = [];
            const seen = new Set();
            const pushSource = (label, value, maxChars = 3000) => {
                const raw = stringifyWorldSourceValue(value);
                if (!raw) return;
                const signature = `${label}:${TokenizerEngine.simpleHash(raw)}`;
                if (seen.has(signature)) return;
                seen.add(signature);
                texts.push(`[${label}]\n${truncateForLLM(raw, maxChars, ' ...[TRUNCATED]... ')}`);
            };
            if (targetChar && typeof targetChar === 'object') {
                pushSource('Character Name', targetChar.name || targetChar.displayName, 300);
                pushSource('Character Description', targetChar.description || targetChar.desc || targetChar.detail || targetChar.details, 4000);
                pushSource('Character Personality', targetChar.personality || targetChar.persona || targetChar.traits, 2500);
                pushSource('Scenario', targetChar.scenario || targetChar.situation || targetChar.context, 3000);
                pushSource('First Message', targetChar.firstMessage || targetChar.first_message || targetChar.greeting, 2200);
                pushSource('Creator Notes', targetChar.creatorNotes || targetChar.creator_notes || targetChar.note || targetChar.notes, 2500);
                pushSource('Default Variables', targetChar.defaultVariables, 2200);
            }
            try {
                const effectiveLore = MemoryEngine.getEffectiveLorebook(targetChar, targetChat) || [];
                effectiveLore
                    .filter(entry => !entry?.comment || !String(entry.comment).startsWith('lmai_'))
                    .slice(0, 24)
                    .forEach((entry, index) => {
                        const key = [entry?.key, entry?.secondkey].map(v => String(v || '').trim()).filter(Boolean).join(' / ');
                        const title = key || entry?.comment || entry?.id || `entry-${index + 1}`;
                        pushSource(`Character Lorebook: ${title}`, entry?.content || '', 2600);
                    });
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Character world source lore collection failed:', e?.message || e);
            }
            return texts.slice(0, 32);
        };
        const buildCharacterWorldSourceBundle = (targetChar = null, targetChat = null, maxChars = 10000) => {
            const sourceTexts = collectCharacterWorldSourceTexts(targetChar, targetChat);
            return {
                count: sourceTexts.length,
                context: sourceTexts.length > 0
                    ? truncateForLLM(sourceTexts.join('\n\n'), maxChars, '\n...[TRUNCATED CHARACTER WORLD SOURCES]...\n')
                    : ''
            };
        };
                                                                                                                                                                        const pushUniqueLimited = (items, additions, limit = 12) => {
            const next = dedupeTextArray([...(Array.isArray(items) ? items : []), ...(Array.isArray(additions) ? additions : [additions])]);
            return next.slice(-limit);
        };
