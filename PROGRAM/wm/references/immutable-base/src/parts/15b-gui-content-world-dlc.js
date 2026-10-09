        // UI 업데이트 로직
        const syncDebugRecordStatus = () => {
            const toggle = overlay.querySelector('#sdebug');
            const status = overlay.querySelector('#sdebug-status');
            if (!status) return;
            status.textContent = toggle?.checked === true
                ? '켜짐 · 최근 2턴의 상세 실행 기록을 보관합니다.'
                : '꺼짐 · 상세 실행 기록을 저장하지 않습니다.';
            status.classList.toggle('is-ok', toggle?.checked === true);
        };
        const HOME_RECENT_KIND_LABELS = Object.freeze({
            lmai_memory: '메모리',
            lmai_entity: '인물',
            lmai_relation: '관계'
        });
        const HOME_RECENT_RELATION_LABELS = Object.freeze({
            classmate: '학급 친구',
            friend: '친구',
            close_friend: '친한 친구',
            acquaintance: '지인',
            family: '가족',
            sibling: '형제자매',
            parent_child: '부모와 자녀',
            colleague: '동료',
            coworker: '직장 동료',
            rival: '경쟁자',
            enemy: '적대',
            romantic: '연인',
            lover: '연인',
            spouse: '부부',
            first_meeting: '첫 만남'
        });
        const homeRecentJsonValue = (value) => {
            if (value && typeof value === 'object') return value;
            const text = String(value ?? '').trim();
            if (!text || !/^[\[{]/.test(text)) return null;
            try { return JSON.parse(text); } catch (_) { return null; }
        };
        const homeRecentObject = (value) => {
            const parsed = homeRecentJsonValue(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        };
        const homeRecentCleanText = (value, max = 180, depth = 0) => {
            if (value == null || depth > 4) return '';
            const parsed = homeRecentJsonValue(value);
            if (parsed && parsed !== value) return homeRecentCleanText(parsed, max, depth + 1);
            if (Array.isArray(value)) {
                const joined = dedupeTextArray(value.map(item => homeRecentCleanText(item, max, depth + 1)).filter(Boolean)).join(', ');
                return joined.length > max ? `${joined.slice(0, Math.max(24, max - 1)).trim()}…` : joined;
            }
            if (value && typeof value === 'object') {
                const preferredKeys = ['summary', 'description', 'event', 'text', 'note', 'label', 'activity', 'current_state', 'state', 'result'];
                for (const key of preferredKeys) {
                    const text = homeRecentCleanText(value[key], max, depth + 1);
                    if (text) return text;
                }
                return '';
            }
            let text = String(value || '')
                .replace(/^(?:Scene result|Scene summary|Summary|Result)\s*:\s*/i, '')
                .replace(/^\s*[-•]\s*/, '')
                .replace(/\s*\/\s*/g, ' 이어서 ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!text || text === '[]' || text === '{}') return '';
            if (/^[\[{].*[\]}]$/.test(text) || /"(?:schema|version|sourceMessageIds|integrity)"\s*:/.test(text)) return '';
            if (text.length > max) text = `${text.slice(0, Math.max(24, max - 1)).trim()}…`;
            return text;
        };
        const homeRecentRecord = (entry) => {
            const raw = String(stripMeta(entry?.content || '') || '').trim();
            const parsed = homeRecentJsonValue(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        };
        const homeRecentMemoryCopy = (record = {}, meta = {}) => {
            const scene = homeRecentObject(record.scene);
            const claim = homeRecentObject(record.claim);
            const latestClaim = Array.isArray(record.claims) ? record.claims[record.claims.length - 1] : null;
            const latestEvent = Array.isArray(record.events) ? record.events[record.events.length - 1] : null;
            const latestBeat = Array.isArray(record.beats) ? record.beats[record.beats.length - 1] : null;
            const summary = homeRecentCleanText(
                meta.summary || record.summary || scene.summary || scene.description || claim.text || latestClaim || latestEvent || latestBeat,
                104
            );
            return {
                title: summary || '새로운 장면 기억이 저장되었습니다.',
                detail: summary ? '이 장면의 핵심 사건과 연속성 근거를 기억했습니다.' : '현재 턴의 핵심 변화가 메모리에 추가되었습니다.'
            };
        };
        const homeRecentEntityCopy = (record = {}, meta = {}, entry = {}) => {
            const identity = homeRecentObject(record.identity);
            const identityDetails = homeRecentObject(identity.summary);
            const status = homeRecentObject(record.status);
            const currentState = homeRecentObject(record.currentState || record.current_state || status);
            const stateDetails = homeRecentObject(currentState.summary || status.notes);
            const name = homeRecentCleanText(record.name || record.canonicalName || meta.name || entry?.name, 80)
                || '인물';
            const role = homeRecentCleanText(identity.roleInStory || identity.role || identityDetails.role || record.roleInStory || record.role, 80);
            const affiliations = dedupeTextArray([
                homeRecentCleanText(identity.affiliation || identity.school || identityDetails.school || record.affiliation, 100),
                homeRecentCleanText(identity.band || identityDetails.band || record.band, 100)
            ].filter(Boolean));
            const location = homeRecentCleanText(currentState.location || status.currentLocation || stateDetails.location, 120);
            const mood = homeRecentCleanText(currentState.emotionalState || status.currentMood || stateDetails.mood, 120);
            const activity = homeRecentCleanText(currentState.activity || currentState.immediateGoal || stateDetails.activity, 120);
            const stateSentences = [
                location && activity ? `현재 ${location}에서 ${activity} 중입니다.` : (location ? `현재 위치는 ${location}입니다.` : (activity ? `현재 ${activity} 중입니다.` : '')),
                mood ? `현재 감정은 ${mood}입니다.` : ''
            ].filter(Boolean);
            const identitySentences = [
                role && affiliations.length ? `서사 역할은 ${role}이며 소속은 ${affiliations.join(', ')}입니다.` : (role ? `서사 역할은 ${role}입니다.` : (affiliations.length ? `소속은 ${affiliations.join(', ')}입니다.` : ''))
            ].filter(Boolean);
            return {
                title: stateSentences.length ? `${name}의 현재 상태가 갱신되었습니다.` : `${name}의 인물 정보가 갱신되었습니다.`,
                detail: [...stateSentences, ...identitySentences].join(' ') || '이 인물에 관한 새로운 정보가 기록되었습니다.'
            };
        };
        const homeRecentRelationCopy = (record = {}) => {
            const entityA = homeRecentCleanText(record.entityA || record.from || record.sourceEntity, 80) || '첫 번째 인물';
            const entityB = homeRecentCleanText(record.entityB || record.to || record.targetEntity, 80) || '두 번째 인물';
            const relationTypeRaw = homeRecentCleanText(record.relationType || record.type || record.relationship, 80);
            const relationType = HOME_RECENT_RELATION_LABELS[String(relationTypeRaw || '').trim().toLowerCase()] || relationTypeRaw;
            const currentStatus = homeRecentObject(record.currentStatus || record.current_status);
            const timeline = homeRecentObject(record.relationTimeline || record.timeline);
            const latestTimelineEvent = Array.isArray(timeline.events) ? timeline.events[timeline.events.length - 1] : null;
            const latestChange = Array.isArray(record?.dynamics?.recentChanges) ? record.dynamics.recentChanges[record.dynamics.recentChanges.length - 1] : null;
            const statusSummary = homeRecentCleanText(currentStatus.summary || currentStatus.publicLayer || latestTimelineEvent || latestChange, 150);
            const relationPhrase = relationType
                ? `${relationType}${relationType.endsWith('관계') ? '' : ' 관계'}`
                : '서로 연결된 관계';
            return {
                title: `${entityA}와 ${entityB}의 관계가 갱신되었습니다.`,
                detail: statusSummary || `현재 ${relationPhrase}로 기록되어 있습니다.`
            };
        };
        const buildHomeRecentCandidate = (entry) => {
            let meta = {};
            try { meta = parseMeta(entry?.content || '') || {}; } catch (_) {}
            const record = homeRecentRecord(entry);
            const kind = String(entry?.comment || 'lmai_memory');
            const turn = Number(
                meta.t || meta.turn || meta.finalizedTurn || record.turn || record?.quality?.lastUpdatedTurn
                || record?.currentState?.lastObservedTurn || record?.currentStatus?.lastChangedTurn || record?.meta?.updated || 0
            ) || 0;
            const copy = kind === 'lmai_entity'
                ? homeRecentEntityCopy(record, meta, entry)
                : (kind === 'lmai_relation' ? homeRecentRelationCopy(record) : homeRecentMemoryCopy(record, meta));
            return {
                turn,
                kind,
                title: homeRecentCleanText(copy.title, 112) || `${HOME_RECENT_KIND_LABELS[kind] || 'LIBRA'} 데이터가 갱신되었습니다.`,
                detail: homeRecentCleanText(copy.detail, 180),
                target: kind === 'lmai_entity' || kind === 'lmai_relation' ? 'entity' : 'memory'
            };
        };
        const renderHome = () => {
            const setText = (selector, value) => { const node = overlay.querySelector(selector); if (node) node.textContent = String(value ?? ''); };
            const setPill = (selector, text, tone = '') => {
                const node = overlay.querySelector(selector);
                if (!node) return;
                node.textContent = text;
                node.classList.remove('ok', 'warn');
                if (tone) node.classList.add(tone);
            };
            const defaultPreset = String(_CFG.llmDefaultPreset || 'primary').trim() || 'primary';
            const presets = _CFG.llmPresets && typeof _CFG.llmPresets === 'object' && !Array.isArray(_CFG.llmPresets) ? _CFG.llmPresets : {};
            const profile = presets[defaultPreset] || (defaultPreset === 'aux' ? _CFG.auxLlm : _CFG.llm) || {};
            const provider = String(profile.provider || _CFG.llm?.provider || '').trim();
            const model = String(profile.model || _CFG.llm?.model || '').trim();
            const configured = Boolean(provider && model);
            setPill('#home-llm-pill', configured ? '정상' : '설정 필요', configured ? 'ok' : 'warn');
            setText('#home-llm-value', model || '모델 미지정');
            setText('#home-llm-note', configured ? `${defaultPreset} · ${provider}` : '설정에서 LLM 프로필을 연결해 주세요.');
            setText('#settings-default-profile-summary', configured ? `${defaultPreset} · ${provider} · ${model}` : '기본 LLM 프로필 설정이 필요합니다.');
            setPill('#settings-profile-connection-pill', configured ? '정상' : '설정 필요', configured ? 'ok' : 'warn');

            const narrativeCount = Array.isArray(_NAR?.storylines) ? _NAR.storylines.length : 0;
            const worldCount = Array.isArray(_WLD?.nodes) ? _WLD.nodes.length : 0;
            const totalCount = _MEM.length + _ENT.length + _REL.length + narrativeCount + worldCount;
            setPill('#home-data-pill', totalCount > 0 ? '저장됨' : '초기 상태', totalCount > 0 ? 'ok' : 'warn');
            setText('#home-data-value', `${totalCount}개 항목`);
            setText('#home-data-note', `메모리 ${_MEM.length} · 인물 ${_ENT.length} · 관계 ${_REL.length} · 서사 ${narrativeCount} · 세계 ${worldCount}`);

            let additional = {};
            let userDlc = {};
            try { additional = WorldAdditionalCore?.getState?.() || {}; } catch (_) {}
            try { userDlc = UserDlcCore?.getState?.() || {}; } catch (_) {}
            const additionalItems = ['sceneInterventions', 'worldDeltas', 'characterAdditions']
                .reduce((sum, key) => sum + (Array.isArray(additional?.[key]) ? additional[key].length : 0), 0);
            const dlcItems = ['worldItems', 'targetAnalyses', 'entityTrackers']
                .reduce((sum, key) => sum + (Array.isArray(userDlc?.[key]) ? userDlc[key].length : 0), 0);
            const activeAdditional = [...(additional?.sceneInterventions || []), ...(additional?.worldDeltas || []), ...(additional?.characterAdditions || [])]
                .filter(item => item?.manualInjection === true || ['armed', 'injected'].includes(String(item?.status || '').toLowerCase())).length;
            const tracking = (userDlc?.entityTrackers || []).filter(item => item?.enabled === true).length;
            setPill('#home-additional-pill', activeAdditional + tracking > 0 ? '사용 중' : '대기', activeAdditional + tracking > 0 ? 'ok' : '');
            setText('#home-additional-value', `${additionalItems + dlcItems}개`);
            setText('#home-additional-note', `월드 에디셔널 ${additionalItems} · 유저 DLC ${dlcItems} · 투입 ${activeAdditional} · 추적 ${tracking}`);

            const currentTurn = Number(MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0;
            let lastStoredTurn = 0;
            for (const entry of _MEM) {
                try {
                    const meta = parseMeta(entry?.content || '');
                    lastStoredTurn = Math.max(lastStoredTurn, Number(meta?.t || meta?.turn || meta?.finalizedTurn || 0) || 0);
                } catch (_) {}
            }
            if (totalCount <= 0) {
                setText('#home-sync-title', '아직 LIBRA 구조 데이터가 없습니다');
                setText('#home-sync-note', '초기 구조 분석을 실행하면 현재 대화 전체를 기준으로 DB를 만듭니다.');
            } else if (currentTurn > lastStoredTurn) {
                setText('#home-sync-title', `${Math.max(1, currentTurn - lastStoredTurn)}턴의 변화가 반영 대기 중입니다`);
                setText('#home-sync-note', `현재 T${currentTurn} · 마지막 메모리 T${lastStoredTurn}. 증분 분석은 응답 후 자동 실행됩니다.`);
            } else {
                setText('#home-sync-title', `T${Math.max(currentTurn, lastStoredTurn)}까지 동기화되었습니다`);
                setText('#home-sync-note', '다음 응답 후 필요한 증분 분석을 자동으로 실행합니다.');
            }
            const syncButton = overlay.querySelector('#btn-home-sync');
            if (syncButton) {
                syncButton.dataset.syncAction = totalCount <= 0 ? 'cold-start' : 'reanalyze';
                syncButton.textContent = totalCount <= 0 ? '대화 데이터 동기화' : '대화 데이터 다시 동기화';
            }
            setText('#libra-global-status', totalCount <= 0
                ? '준비 완료 · 초기 분석 필요'
                : `준비 완료 · T${Math.max(currentTurn, lastStoredTurn)}까지 동기화됨`);

            const recentContainer = overlay.querySelector('#home-recent-list');
            if (recentContainer) {
                const recentCandidates = [..._MEM, ..._ENT, ..._REL]
                    .map(buildHomeRecentCandidate)
                    .sort((a, b) => b.turn - a.turn)
                    .slice(0, 3);
                recentContainer.innerHTML = recentCandidates.length ? recentCandidates.map(item => `
                    <div class="home-recent-row"><div class="home-recent-copy"><strong>${esc(item.title)}</strong><span class="home-card-note">${esc(HOME_RECENT_KIND_LABELS[item.kind] || 'LIBRA 데이터')} · T${item.turn || '-'}${item.detail ? ` · ${esc(item.detail)}` : ''}</span></div><button class="btn bs" type="button" data-view-tab="${item.target}">보기</button></div>`).join('')
                    : '<div class="empty">아직 표시할 변화가 없습니다. 대화 데이터 동기화를 실행해 주세요.</div>';
                recentContainer.querySelectorAll('[data-view-tab]').forEach(button => {
                    button.addEventListener('click', () => switchTab(button.dataset.viewTab));
                });
            }
        };
        // 세계선 패널 렌더 — 턴 노드와 분기 계보를 보여준다.
        const renderWorldlinePane = () => {
            try {
                if (typeof LibraTurnWorldline?.renderWorldlineView !== 'function') return;
                const scopeKey = LibraDataStorage?.scopeKeyFor?.(char, chat, null) || '';
                const worldlineState = scopeKey ? LibraTurnWorldline.get(scopeKey) : null;
                let lineage = null;
                try { lineage = LibraHostLineage?.inspect?.(char, chat) || null; } catch (_) {}
                const viewNode = overlay.querySelector('#wl-view');
                if (viewNode) viewNode.innerHTML = LibraTurnWorldline.renderWorldlineView(worldlineState, { lineage });
                const lineageNode = overlay.querySelector('#wl-lineage');
                if (lineageNode && lineage) {
                    const rows = [];
                    const statusText = ({
                        verified: '검증됨', diverged: '갈라짐', unverified: '확인 불가', independent: '독립'
                    }[String(lineage.status)] || '알 수 없음');
                    rows.push(`<div class="wl-lineage-body">상태 · ${statusText}</div>`);
                    if (lineage.path?.length > 1) rows.push(`<div class="wl-lineage-note">경로 깊이 · ${lineage.path.length - 1}단계</div>`);
                    if (lineage.commonPrefixPairs) rows.push(`<div class="wl-lineage-note">부모와 공통 · ${lineage.commonPrefixPairs}턴</div>`);
                    lineageNode.innerHTML = rows.join('');
                } else if (lineageNode) {
                    lineageNode.innerHTML = '<div class="empty">이 대화는 분기된 대화가 아닙니다.</div>';
                }
            } catch (error) {
                if (_CFG?.debug) recordRuntimeDebug('warn', '[LIBRA][Worldline] pane render failed:', error?.message || error);
            }
            syncWorldlineKpi();
            syncSidebarCounts();
        };

        // 사이드바 항목 → 화면 경로. 목업의 항목 구성을 원본 언어로 구현한다.
        // 관계는 인물 패널의 관계 서브탭, 월드 에디셔널/유저 DLC 는 추가 요소의 하위 패널,
        // 세계선은 세계관 패널의 세계선 서브탭으로 들어간다 — 셸 자체는 그대로 둔다.
        // 항목 → 사이드바에서 함께 강조할 루트.
        // 상세 화면(entity-profile / narrative-detail / world-detail)은 부모 그룹을 켠다.
        const GUI_TAB_GROUPS = {
            home: 'home',
            memory: 'memory',
            entity: 'memory',
            'entity-profile': 'memory',
            relations: 'relations',
            narrative: 'memory',
            'narrative-detail': 'memory',
            world: 'memory',
            'world-detail': 'memory',
            worldline: 'memory',
            'world-additional': 'world-additional',
            'wa-auto': 'wa-auto',
            udlc: 'udlc',
            settings: 'settings'
        };
        // 사이드바 항목 이름과 패널 id 가 다른 경우를 해석한다.
        // 이게 없으면 #tab-wa-auto 가 없어 switchTab 이 조용히 넘어가고
        // 직전 패널이 그대로 남아 "눌러도 화면이 안 바뀐다"가 된다.
        const GUI_PANEL_ALIAS = {};
        const applySidebarPath = (n) => {
            const name = String(n || 'home');
            const root = GUI_TAB_GROUPS[name] || name;
            // 사이드바가 곧 내비게이션이다 — 루트 그룹과 하위 항목을 함께 표시한다.
            // in-root 는 '같은 그룹에 속한 형제 항목'을 옅게 강조한다.
            // root 이름의 항목이 없을 수 있으므로(wa-auto→world-additional) 그룹 소속으로 판정한다.
            overlay.querySelectorAll('.side-link').forEach(button => {
                const selected = button.dataset.tab === name;
                const sibling = !selected && (GUI_TAB_GROUPS[button.dataset.tab] || button.dataset.tab) === root;
                button.classList.toggle('on', selected);
                button.classList.toggle('in-root', selected || sibling);
                button.setAttribute('aria-selected', selected ? 'true' : 'false');
            });
            if (name === 'relations') {
                renderRels();
            }
        };
        const switchTab = (n) => {
            turnReanalysisViewRevision++;
            turnReanalysisAbort?.abort();
            const panelId = GUI_PANEL_ALIAS[n] || n;
            overlay.querySelectorAll(".panel").forEach(p => p.classList.remove("on"));
            const panel = overlay.querySelector("#tab-" + panelId);
            if (panel) {
                panel.classList.add("on");
            } else {
                // 조용히 넘어가면 직전 패널이 남아 '눌러도 안 바뀐다'가 된다.
                recordSuppressedRuntimeError('gui.switch_tab_panel_missing', new Error(`no panel for tab=${n} (resolved=${panelId})`), { tab: n, panelId });
                const fallback = overlay.querySelector('#tab-' + (GUI_TAB_GROUPS[n] || 'home'));
                if (fallback) fallback.classList.add('on');
            }
            applySidebarPath(n);
            if (n === 'home') {
                lore = MemoryEngine.getLorebook(char, chat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderHome();
            } else if (n === 'worldline') {
                renderWorldlinePane();
            } else if (n === 'narrative') {
                lore = MemoryEngine.getLorebook(char, chat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderNarrative();
            } else if (n === 'world') {
                renderWorld();
                Promise.resolve().then(() => refreshSectionWorldLensFromGui(false)).catch(() => {});
            } else if (n === 'relations') {
                lore = MemoryEngine.getLorebook(char, chat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderRels();
            } else if (n === 'wa-auto') {
                lore = MemoryEngine.getLorebook(char, chat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderWorldAdditional();
                activateWorldAdditionalPane('entities');
            } else if (n === 'udlc') {
                lore = MemoryEngine.getLorebook(char, chat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderWorldAdditional();
                activateUserDlcPane('world');
            } else if (n === 'world-additional') {
                lore = MemoryEngine.getLorebook(char, chat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderWorldAdditional();
            } else if (n === 'settings' || n === 'provider') {
                }
        };

        // 인물 프로필 상세 — 목록에서 이름을 누르면 열린다(읽기 전용 요약 + 관계).
        // 인물 이름과 상태 키를 맞춘다 — 정확 일치를 먼저, 없으면 괄호 제거·부분 일치로.
        const getCharacterStateLookupKeysCompat = (key, name) => {
            const k = String(key || '').trim();
            const n = String(name || '').trim();
            if (!k || !n) return false;
            if (k === n) return true;
            const bare = k.replace(/\([^)]*\)/g, '').trim();
            if (bare === n) return true;
            return k.includes(n);
        };
        const renderEntityProfile = (index) => {
            const e = _ENT[index];
            if (!e) return;
            let d = parseGuiStoredJson(e, 'entity.profile', index);
            if (typeof EntityManager?.normalizeEntityRecord === 'function') d = EntityManager.normalizeEntityRecord(d);
            const identity = d.identity && typeof d.identity === 'object' ? d.identity : {};
            const profile = d.profile && typeof d.profile === 'object' ? d.profile : {};
            const currentState = d.currentState && typeof d.currentState === 'object' ? d.currentState : {};
            const continuity = d.continuity && typeof d.continuity === 'object' ? d.continuity : {};
            const name = String(d.name || e.key || '?');
            const setText = (id, v) => { const n = overlay.querySelector('#' + id); if (n) n.textContent = String(v ?? '—'); };
            setText('prof-crumb', name);
            setText('prof-name', name);
            setText('prof-role', identity.roleInStory || '역할 미기록');
            const av = overlay.querySelector('#prof-avatar');
            if (av) av.textContent = name.charAt(0) || '·';
            setText('prof-canon', d?.meta?.manualLocked ? '정본' : '자동');
            const timeline = formatGuiStateTimelineHtml(e, currentState) || {};
            setText('prof-last', timeline.count ? `T${Number(d?.meta?.lastTurn) || 0} · ${timeline.count}턴` : '기록 없음');
            const relatedList = _REL.map((r, i) => ({ d: parseGuiStoredJson(r, 'relation.profile', i), i }))
                .filter(x => String(x.d?.entityA || '') === name || String(x.d?.entityB || '') === name);
            setText('prof-relcount', `${relatedList.length}건`);
            const relHost = overlay.querySelector('#prof-relations');
            if (relHost) {
                relHost.innerHTML = relatedList.length
                    ? relatedList.map(x => {
                        const dd = x.d || {};
                        const hasCls = Number.isFinite(Number(dd?.details?.closeness));
                        const cls = hasCls ? Math.round(Number(dd.details.closeness) * 100) : null;
                        const other = String(dd.entityA || '') === name ? dd.entityB : dd.entityA;
                        const dir = String(dd.entityA || '') === name ? '→' : '←';
                        return `<div class="card rel"><div class="card-hdr"><strong><span class="rel-dir">${esc(name)}<span class="rel-dir-arrow">${dir}</span>${esc(other || '?')}</span></strong><div class="card-meta"><span class="bdg bt">${esc(dd.relationType || '미정')}</span></div></div><div class="dim">${cls == null ? '친밀도 판단 보류' : `친밀도 ${cls}%`} · ${esc((dd.sentiments && dd.sentiments.fromAtoB) || '감정 미기록')}</div></div>`;
                    }).join('')
                    : '<div class="empty">이 인물과 연결된 관계가 없습니다.</div>';
            }
            const tags = [
                ...(Array.isArray(identity.affiliation) ? identity.affiliation : (identity.affiliation ? [identity.affiliation] : [])),
                ...(Array.isArray(currentState.emotionalState) ? currentState.emotionalState : (currentState.emotionalState ? [currentState.emotionalState] : []))
            ].filter(Boolean).slice(0, 5);
            const tagHost = overlay.querySelector('#prof-tags');
            if (tagHost) tagHost.innerHTML = tags.map(t => `<span class="chip">${esc(t)}</span>`).join('');
            // 소속 세계(4단계) — '소속'(identity.affiliation=조직)과는 **다른 축**이다.
            //   세계 정본은 CharacterStateTracker 턴 로그의 world 다(인물 레코드가 아니다).
            const worldAffiliation = (() => {
                try {
                    const state = CharacterStateTracker?.getState?.() || {};
                    const key = Object.keys(state).find(k => getCharacterStateLookupKeysCompat(k, name));
                    const log = Array.isArray(state[key]?.turnLog) ? state[key].turnLog : [];
                    for (let i = log.length - 1; i >= 0; i--) {
                        const w = String(log[i]?.world || '').trim();
                        if (w) return w;
                    }
                    return '';
                } catch (_) { return ''; }
            })();
            const rows = [
                ['외모 특징', guiCsv(profile?.appearance?.features)],
                ['성격 특성', guiCsv(profile?.personality?.traits)],
                ['말투 단서', guiCsv(profile?.speechStyle?.notes)],
                ['배경', formatGuiEntityBackground(profile, identity)],
                ['심리', guiLines([profile?.psychology?.baseline, profile?.psychology?.currentConflict])],
                ['소속', guiCsv(Array.isArray(identity.affiliation) ? identity.affiliation : [identity.affiliation])],
                ['세계', worldAffiliation],
                ['위치', guiLines([currentState.location])],
                ['현재 상태', guiLines([currentState.summary, guiCsv(currentState.emotionalState), guiCsv(currentState.activity)])],
                ['열린 떡밥', formatGuiOpenThreadLabels(continuity.openThreads)]
            ].filter(([, v]) => v && String(v).trim() && String(v).trim() !== '—');
            const readHost = overlay.querySelector('#prof-read');
            if (readHost) {
                readHost.innerHTML = rows.length
                    ? rows.map(([k, v]) => `<span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(String(v))}</span>`).join('')
                    : '<span class="kv-k">기록</span><span class="kv-v">아직 읽을 기록이 없습니다.</span>';
            }
            switchTab('entity-profile');
        };
        // 내러티브 상세 — 목록에서 항목을 누르면 열린다.
        const renderNarrativeDetail = (index) => {
            const storylines = Array.isArray(_NAR?.storylines) ? _NAR.storylines : [];
            const st = storylines[index];
            if (!st) return;
            const setText = (id, v) => { const n = overlay.querySelector('#' + id); if (n) n.textContent = String(v ?? '—'); };
            const title = String(st.title || st.arc || `스토리라인 ${index + 1}`);
            setText('nar-detail-crumb', title);
            setText('nar-detail-title', title);
            setText('nar-detail-context', st.context || st.summary || '맥락이 아직 기록되지 않았습니다.');
            setText('nar-detail-lock', st.manualLocked === true || st.locked === true ? '수동 보호됨' : '자동 수정 가능');
            const summaries = Array.isArray(st.summaries) ? st.summaries : [];
            setText('nar-detail-turn', summaries.length ? `T${Number(st.lastTurn) || 0}` : '기록 없음');
            setText('nar-detail-hist', `${summaries.length}회`);
            const tags = [];
            if (Array.isArray(st.entities) && st.entities.length) tags.push(`인물 ${st.entities.length}`);
            if (Array.isArray(st.keyPoints) && st.keyPoints.length) tags.push(`핵심 ${st.keyPoints.length}`);
            if (Array.isArray(st.ongoingTensions) && st.ongoingTensions.length) tags.push(`흐름 ${st.ongoingTensions.length}`);
            const tagHost = overlay.querySelector('#nar-detail-tags');
            if (tagHost) tagHost.innerHTML = tags.map(t => `<span class="chip">${esc(t)}</span>`).join('');
            const rows = [
                ['등장 인물', Array.isArray(st.entities) ? st.entities.join(', ') : ''],
                ['핵심 포인트', Array.isArray(st.keyPoints) ? st.keyPoints.join(', ') : ''],
                ['진행 중 흐름', Array.isArray(st.ongoingTensions) ? st.ongoingTensions.join(', ') : ''],
                ['최근 이벤트', formatNarrativeRecentEvents(st)],
                ['요약 이력', formatNarrativeSummaryHistory(st)],
                ['턴별 흐름', formatNarrativeTurnFlow(st)]
            ].filter(([, v]) => v && String(v).trim());
            const host = overlay.querySelector('#nar-detail-read');
            if (host) host.innerHTML = rows.length
                ? rows.map(([k, v]) => `<span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(String(v))}</span>`).join('')
                : '<span class="kv-k">기록</span><span class="kv-v">아직 읽을 기록이 없습니다.</span>';
            switchTab('narrative-detail');
        };
        // 세계관 상세 — 노드를 누르면 열린다.
        const renderWorldDetail = (nodeId) => {
            const nodes = Array.isArray(_WLD?.nodes) ? _WLD.nodes : [];
            const entry = nodes.find(([id]) => String(id) === String(nodeId)) || nodes[0];
            if (!entry) return;
            const [id, node] = entry;
            const setText = (t, v) => { const n = overlay.querySelector('#' + t); if (n) n.textContent = String(v ?? '—'); };
            const name = String(node?.name || id || '?');
            setText('wld-detail-crumb', name);
            setText('wld-detail-name', name);
            // 정본은 meta.worldSummary 다 (node.summary 는 정본에 없는 평면 필드였다).
            const wldMeta = node?.meta && typeof node.meta === 'object' ? node.meta : {};
            setText('wld-detail-summary', wldMeta.worldSummary || '요약이 아직 기록되지 않았습니다.');
            // 멀티노드: activeNodes 가 있으면 그게 활성 기준이다(activePath 는 주 초점).
            //   activePath 만 보면 동시에 활성인 위치가 "이력"으로 잘못 표시된다.
            const activePath = Array.isArray(_WLD?.activePath) ? _WLD.activePath.map(String) : [];
            const activeNodeIds = Array.isArray(_WLD?.activeNodes) && _WLD.activeNodes.length > 0
                ? _WLD.activeNodes.map(String)
                : activePath;
            const isActive = activeNodeIds.includes(String(id));
            setText('wld-detail-badge', isActive ? '활성' : '이력');
            // 깊이·개정은 제품에 없는 축이다 — 표시하지 않는다(값을 만들어내지 않는다).
            // 대신 정본에 실제로 있는 축을 보여준다.
            const wldRules = node?.rules && typeof node.rules === 'object' ? node.rules : {};
            const wldHighlights = extractWorldRuleHighlights(wldRules, 24)
                .map(v => String(v || '').trim()).filter(Boolean);
            const ruleCount = wldHighlights.length;
            setText('wld-detail-class', String(wldMeta.classification || '').trim() || '—');
            setText('wld-detail-rules', `${ruleCount}`);
            const tagHost = overlay.querySelector('#wld-detail-tags');
            if (tagHost) {
                const bits = [String(wldMeta.classification || '').trim(), `규칙 ${ruleCount}`].filter(Boolean);
                tagHost.innerHTML = bits.map(t => `<span class="chip">${esc(t)}</span>`).join('');
            }
            // 상위 노드는 parent(정본) 다. parentId 는 정본에 없다.
            const parentId = String(node?.parent || '').trim();
            const parentName = (() => {
                if (!parentId) return '';
                const found = nodes.find(([pid]) => String(pid) === parentId);
                return String(found?.[1]?.name || parentId).trim();
            })();
            const rows = [['세계 분류', wldMeta.classification], ['상위 노드', parentName]]
                .concat(wldHighlights.map(h => ['규칙', h]))
                .filter(([, v]) => v != null && String(v).trim() && String(v).trim() !== 'undefined');
            const host = overlay.querySelector('#wld-detail-read');
            if (host) host.innerHTML = rows.length
                ? rows.map(([k, v]) => `<span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(String(v))}</span>`).join('')
                : '<span class="kv-k">기록</span><span class="kv-v">아직 읽을 기록이 없습니다.</span>';
            switchTab('world-detail');
        };
        // 내러티브·세계관·세계선 KPI — 스냅샷만 읽는다(추가 호출 없음).
        const syncNarrativeKpi = () => {
            try {
                const lines = Array.isArray(_NAR?.storylines) ? _NAR.storylines : [];
                const locked = lines.filter(l => l?.manualLocked === true || l?.locked === true).length;
                const set = (id, html) => { const n = overlay.querySelector('#' + id); if (n) n.innerHTML = html; };
                set('sum-nar-count', `${lines.length}<small>개</small>`);
                const badge = overlay.querySelector('#sum-nar-badge');
                if (badge) badge.textContent = `활성 ${Math.max(0, lines.length - locked)} · 보호 ${locked}`;
                const active = lines[0] || null;
                set('sum-nar-arc', esc(active?.title || active?.arc || '—'));
                const arcNote = overlay.querySelector('#sum-nar-arc-note');
                if (arcNote) {
                    const beats = Array.isArray(active?.keyPoints) ? active.keyPoints.length : 0;
                    const flow = Array.isArray(active?.progress) ? active.progress.length : 0;
                    arcNote.textContent = active ? `핵심 포인트 ${beats} · 진행 흐름 ${flow}` : '아직 기록된 아크가 없습니다.';
                }
                const openThreads = [];
                lines.forEach(l => (Array.isArray(l?.openThreads) ? l.openThreads : []).forEach(t => { if (t) openThreads.push(String(t)); }));
                set('sum-nar-open', `${openThreads.length}<small>건</small>`);
                const openNote = overlay.querySelector('#sum-nar-open-note');
                if (openNote) openNote.textContent = openThreads.length ? openThreads.slice(0, 3).join(' · ') : '미해결 흐름이 없습니다.';
            } catch (error) { recordSuppressedRuntimeError('gui.narrative_kpi_failed', error, {}); }
        };
        const syncWorldKpi = () => {
            try {
                const nodes = Array.isArray(_WLD?.nodes) ? _WLD.nodes : [];
                const activePath = Array.isArray(_WLD?.activePath) ? _WLD.activePath : [];
                // 멀티노드: 활성 위치가 여럿이면 그 수로 센다(activePath 는 주 초점 하나뿐).
                const activeCount = Array.isArray(_WLD?.activeNodes) && _WLD.activeNodes.length > 0
                    ? _WLD.activeNodes.length
                    : activePath.length;
                const set = (id, html) => { const n = overlay.querySelector('#' + id); if (n) n.innerHTML = html; };
                set('sum-wld-nodes', `${nodes.length}<small>개</small>`);
                const badge = overlay.querySelector('#sum-wld-badge');
                if (badge) badge.textContent = `활성 ${activeCount} · 이력 ${Math.max(0, nodes.length - activeCount)}`;
                let ruleCount = 0;
                const classes = new Map();
                nodes.forEach(([, node]) => {
                    // 정본은 node.rules 다 (node.fields 는 읽는 곳이 없어 항상 0 이었다).
                    const nodeRules = node?.rules && typeof node.rules === 'object' ? node.rules : {};
                    ruleCount += extractWorldRuleHighlights(nodeRules, 24).length;
                    const cls = String(node?.meta?.classification || node?.name || '').trim();
                    if (cls) classes.set(cls, (classes.get(cls) || 0) + 1);
                });
                set('sum-wld-rules', `${ruleCount}<small>건</small>`);
                const ruleBadge = overlay.querySelector('#sum-wld-rules-badge');
                if (ruleBadge) ruleBadge.textContent = classes.size ? `${classes.size}개 분류` : '분류 집계';
                const ruleNote = overlay.querySelector('#sum-wld-rules-note');
                if (ruleNote) ruleNote.textContent = classes.size
                    ? Array.from(classes.entries()).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ')
                    : '현재 노드의 규칙을 집계하고 있습니다.';
                const corrCount = nodes.filter(([, node]) => node?.userCorrection === true || node?.corrected === true).length;
                set('sum-wld-corr', `${corrCount}<small>건</small>`);
                const wldCount = overlay.querySelector('#wld-count');
                if (wldCount) wldCount.textContent = `노드 ${nodes.length}개`;
            } catch (error) { recordSuppressedRuntimeError('gui.world_kpi_failed', error, {}); }
        };
        const syncWorldlineKpi = () => {
            try {
                const scopeKey = LibraDataStorage?.scopeKeyFor?.(char, chat, null) || '';
                const state = scopeKey ? LibraTurnWorldline?.get?.(scopeKey) : null;
                const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
                const active = nodes.filter(n => !n?.supersededBy);
                const history = nodes.filter(n => n?.supersededBy);
                const set = (id, html) => { const n = overlay.querySelector('#' + id); if (n) n.innerHTML = html; };
                set('sum-wl-active', `${active.length}<small>턴</small>`);
                set('sum-wl-history', `${history.length}<small>개</small>`);
                set('sum-wl-rev', `${Number(state?.revision) || 0}<small>회차</small>`);
            } catch (error) { recordSuppressedRuntimeError('gui.worldline_kpi_failed', error, {}); }
        };
        // 인물 KPI 계기판과 인덱스 탐색기 — 스냅샷만 읽는다(추가 호출 없음).
        const syncEntityDashboard = () => {
            try {
                const blockCount = overlay.querySelector('#entity-block-count');
                if (blockCount) {
                    const listed = typeof getGuiEntityBlocklist === 'function' ? getGuiEntityBlocklist() : [];
                    blockCount.textContent = String(Array.isArray(listed) ? listed.length : 0);
                }
                const canonCount = _ENT.filter(e => {
                    const d = parseGuiStoredJson(e, 'entity.dashboard');
                    return d?.meta?.manualLocked === true;
                }).length;
                const entCount = overlay.querySelector('#sum-ent-count');
                if (entCount) entCount.innerHTML = `${_ENT.length}<small>명</small>`;
                const entBadge = overlay.querySelector('#sum-ent-badge');
                // 정본/조연 구분은 두지 않는다 — 전체 수와 보호 상태만 본다.
                if (entBadge) entBadge.textContent = canonCount ? `보호 ${canonCount} · 전체 ${_ENT.length}` : `전체 ${_ENT.length}`;
                const entNote = overlay.querySelector('#sum-ent-note');
                if (entNote) entNote.textContent = _ENT.length ? `최근 10턴 기준으로 기록된 인물입니다.` : '아직 등록된 인물이 없습니다.';
                const relCount = overlay.querySelector('#sum-rel-count');
                if (relCount) relCount.innerHTML = `${_REL.length}<small>건</small>`;
                const relNote = overlay.querySelector('#sum-rel-note');
                if (relNote) {
                    let strongest = null;
                    _REL.forEach((r, i) => {
                        const d = parseGuiStoredJson(r, 'relation.dashboard', i);
                        const c = Number(d?.details?.closeness);
                        if (!Number.isFinite(c)) return;
                        if (!strongest || c > strongest.value) strongest = { value: c, a: d.entityA, b: d.entityB };
                    });
                    relNote.textContent = strongest
                        ? `가장 강한 관계: ${strongest.a} → ${strongest.b} (친밀도 ${Math.round(strongest.value * 100)})`
                        : '아직 수치가 기록된 관계가 없습니다.';
                }
                // 주의 필요 — 열린 떡밥이 있는 인물
                const needCount = _ENT.filter(e => {
                    const d = parseGuiStoredJson(e, 'entity.dashboard');
                    const threads = d?.continuity?.openThreads;
                    return Array.isArray(threads) && threads.filter(Boolean).length > 0;
                }).length;
                const needNode = overlay.querySelector('#sum-need-count');
                if (needNode) needNode.innerHTML = `${needCount}<small>명</small>`;
                // 탐색기 계수
                const entCountNode = overlay.querySelector('#ent-count');
                if (entCountNode) entCountNode.textContent = `인물 ${_ENT.length}명`;
                const relCountNode = overlay.querySelector('#rel-count');
                if (relCountNode) relCountNode.textContent = `관계 ${_REL.length}건`;
            } catch (error) {
                recordSuppressedRuntimeError('gui.entity_dashboard_failed', error, {});
            }
        };
        // 초성 인덱스 — 한글 이름은 알파벳보다 초성이 잘 맞는다.
        const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
        const choOf = (name) => {
            const ch = String(name || '').trim().charAt(0);
            const code = ch.charCodeAt(0);
            if (code >= 0xAC00 && code <= 0xD7A3) return CHO[Math.floor((code - 0xAC00) / 588)];
            if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
            if (/[0-9]/.test(ch)) return '#';
            return ch ? '·' : '';
        };
        const ENT_INDEX_ORDER = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','#'];
        const syncEntityIndex = () => {
            const host = overlay.querySelector('#ent-index');
            if (!host) return;
            const counts = new Map();
            _ENT.forEach(e => {
                const d = parseGuiStoredJson(e, 'entity.index');
                const key = choOf(d?.name || e?.key || '');
                if (!key) return;
                counts.set(key, (counts.get(key) || 0) + 1);
            });
            const keys = ENT_INDEX_ORDER.filter(k => counts.has(k));
            host.innerHTML = `<button type="button" class="on" data-ent-index="all">전체<span class="n">${_ENT.length}</span></button>`
                + keys.map(k => `<button type="button" data-ent-index="${k}">${k}<span class="n">${counts.get(k)}</span></button>`).join('');
        };
        // 사이드바 카운트 배지 — 이미 만들어진 스냅샷만 읽는다(추가 호출 없음).
        const syncSidebarCounts = () => {
            const set = (id, value) => { const node = overlay.querySelector('#nav-' + id); if (node) node.textContent = String(value); };
            try {
                const hiddenSrc = _MEM.filter(m => String(parseMeta(m.content).source || '') === 'narrative_source_record').length;
                const memVisible = (memViewState.showNarrativeSource ? _MEM.length : _MEM.length - hiddenSrc);
                set('mc', memVisible);
                set('ec', _ENT.length);
                set('rc', _REL.length);
                set('nc', Array.isArray(_NAR?.storylines) ? _NAR.storylines.length : 0);
                set('wc', Array.isArray(_WLD?.nodes) ? _WLD.nodes.length : 0);
                const scopeKey = LibraDataStorage?.scopeKeyFor?.(char, chat, null) || '';
                const worldlineState = scopeKey ? LibraTurnWorldline?.get?.(scopeKey) : null;
                const worldlineCount = Array.isArray(worldlineState?.nodes) ? worldlineState.nodes.length : 0;
                set('wlc', worldlineCount);
                // 헤더 카운터 — 사이드바와 같은 스냅샷을 쓴다.
                const headMem = overlay.querySelector('#hdr-mem');
                if (headMem) headMem.textContent = String(memVisible);
                const headEnt = overlay.querySelector('#hdr-ent');
                if (headEnt) headEnt.textContent = String(_ENT.length);
                const headModel = overlay.querySelector('#hdr-model');
                if (headModel) {
                    const activePreset = (() => {
                        try { return String(_CFG?.llm?.model || MemoryEngine.CONFIG?.llm?.model || '').trim(); } catch (_) { return ''; }
                    })();
                    headModel.textContent = activePreset || '프로필 없음';
                    headModel.setAttribute('title', activePreset ? `현재 모델 · ${activePreset}` : '활성 LLM 프로필이 없습니다');
                }
                // 사이드바 데이터 카드 — 대화 턴 수, 저장소 크기, 무결성.
                const turnsNode = overlay.querySelector('#side-card-turns');
                const barNode = overlay.querySelector('#side-card-bar');
                const storageNode = overlay.querySelector('#side-card-storage');
                const integrityNode = overlay.querySelector('#side-card-integrity');
                const totalItems = _MEM.length + _ENT.length + _REL.length;
                if (turnsNode) turnsNode.textContent = worldlineCount ? `${worldlineCount}턴` : '기록 없음';
                if (barNode) barNode.style.width = `${Math.min(100, Math.max(0, (worldlineCount / Math.max(1, worldlineCount + 20)) * 100 * 3))}%`;
                if (storageNode) storageNode.textContent = (() => {
                    try {
                        const bytes = JSON.stringify(lore || []).length + JSON.stringify(_NAR || {}).length + JSON.stringify(_WLD || {}).length;
                        return bytes > 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
                    } catch (_) { return '—'; }
                })();
                if (integrityNode) {
                    const hasContent = totalItems > 0;
                    integrityNode.textContent = hasContent ? '정상' : '초기 상태';
                    integrityNode.style.color = hasContent ? 'var(--success)' : 'var(--text3)';
                }
            } catch (error) {
                recordSuppressedRuntimeError('gui.sidebar_counts_failed', error, {});
            }
        };
        const memCardsHtml = (list) => list.map((m) => {
                const meta = parseMeta(m.content);
                const content = stripMeta(m.content);
                const readable = buildGuiMemoryReadable(m, meta);
                const idx = _MEM.indexOf(m);
                const reanalysisId = String(meta.canonicalMemoryId || '');
                const reanalysis = turnReanalysisAvailability(reanalysisId);
                const reanalysisStatus = turnReanalysisStatuses.get(reanalysisId) || {state:'idle',message:reanalysis.reason};
                const ttl = meta.ttl === -1 ? "영구" : (meta.ttl || 0) + "turn";
                const originBadge = meta.source === 'narrative_source_record' ? `<span class="bdg bt">서사 요약 원본</span>` : '';
                const promotedBadge = meta.promotedTo
                    ? `<span class="bdg bh" title="이 기억은 세계 규칙으로 올라갔습니다 — 매 턴 무조건 주입되고 회상에서는 빠집니다.">세계 규칙 ↑${esc(meta.promotedTo.nodeName || '')}</span>`
                    : '';
                const readableChips = (readable.chips || []).length
                    ? `<div class="memory-readable-sub">${readable.chips.map(chip => `<span class="bdg bt">${esc(chip)}</span>`).join('')}</div>`
                    : '';
                return `<div class="card mem" id="mc-${idx}">
                    <div class="card-hdr">
                        <div class="card-meta">${impBdg(meta.imp||5)}<span class="bdg bt">턴 ${meta.t||0}</span><span class="bdg bt">TTL:${ttl}</span>${originBadge}${promotedBadge}${meta.cat ? `<span class="bdg bt">${esc(meta.cat)}</span>` : ''}</div>
                        <div class="acts">
                            ${/* 승격(개편 마무리) — 기억을 세계 규칙으로 올린다. 이미 올렸으면 강등을 낸다.
                                 자동이 아니라 **사용자가 고르는** 경로다(5.2.8 오작동 방지). */''}
                            ${meta.promotedTo
                                ? `<button class="btn bs act-demote-mem" data-idx="${idx}" title="이 기억을 세계 규칙에서 내리고 회상 대상으로 되돌립니다.">승격 취소</button>`
                                : `<button class="btn bs act-promote-mem" data-idx="${idx}" title="이 기억을 지금 세계 노드의 규칙으로 올립니다. 매 턴 무조건 주입되고, 이 기억은 회상에서 빠집니다.">세계 규칙으로</button>`}
                            <button class="btn bs act-reanalyze-turn" type="button" data-memory-id="${escAttr(reanalysisId)}" title="${escAttr(reanalysis.reason)}" ${reanalysis.eligible ? '' : 'disabled'}>턴 전체 재분석</button>
                            <button class="btn bp act-save-mem" data-idx="${idx}">저장</button>
                            <button class="btn bd act-del-mem" data-idx="${idx}">삭제</button>
                        </div>
                    </div>
                    <div class="turn-reanalysis-status hint" role="status" data-memory-id="${escAttr(reanalysisId)}" data-state="${escAttr(reanalysisStatus.state)}">${esc(reanalysisStatus.message)}</div>
                    <div class="memory-readable" data-memory-view-kind="${escAttr(readable.kind || '')}">
                        <div class="memory-readable-title">${esc(readable.title || '자연어 기억 보기')}</div>
                        <div class="memory-readable-text">${esc(readable.body || '')}</div>
                        ${readableChips}
                    </div>
                    ${meta.sourceHint ? `<div class="hint">${esc(meta.sourceHint)}</div>` : ''}
                    ${/* RP 장기 연속성 — 정본 기억과 다른 역할(무엇이 아직 유효한가).
                         본문에 섞으면 같은 문장이 반복되고 어느 쪽이 최신인지 읽을 수 없다.
                         그래서 접어 둔다. 기본은 닫힘이라 평소엔 보이지 않는다. */ ''}
                    ${Array.isArray(readable.rpGroups) && readable.rpGroups.length ? `<details class="memory-rp-box"><summary>RP 장기 연속성 <span class="bdg bt">${readable.rpGroups.reduce((n, g) => n + g.items.length, 0)}건</span></summary><div class="memory-rp-help">이 기억에서 뽑은 <b>지속 사실</b>입니다. 정본 기억이 "무슨 일이 있었나"(턴 요약·근거)라면 여기는 <b>"무엇이 아직 유효한가"</b>(약속의 이행·파기, 미해결 과제, 고정 사실, 수명 등급)입니다. 응답 모델에는 [RP Long-Term Continuity] 블록으로 따로 들어갑니다.</div>${readable.rpGroups.map(g => `<div class="memory-rp-group"><div class="memory-rp-label">${esc(g.label)}</div><ul class="memory-rp-list">${g.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('')}</details>` : ''}
                    <details class="memory-raw-box">
                        <summary>${esc(readable.rawLabel || '원본 데이터 보기/수정')}</summary>
                        <div class="memory-raw-help">GUI 기본 보기는 읽기 쉽도록 변환된 표시용 문장입니다. 아래 원본 compact JSON/메모리 본문은 저장 로어북 데이터이며, 자동으로 자연어 표시문으로 덮어쓰지 않습니다.</div>
                        <textarea class="ec mt-val" data-idx="${idx}" rows="7">${esc(content)}</textarea>
                    </details>
                    <div class="memory-importance-row">
                        <label style="font-size:var(--fs-label);line-height:var(--lh-ui);color:var(--text2)">중요도:</label>
                        <input type="number" class="mi-val" data-idx="${idx}" min="1" max="10" value="${meta.imp||5}">
                    </div>
                </div>`;
        }).join("");
        // 목업의 표 행 — 중요도 게이지 · 내용 · 분류 칩 · 턴 · 삭제.
        const memRowsHtml = (list) => list.map((m) => {
                const meta = parseMeta(m.content);
                const readable = buildGuiMemoryReadable(m, meta);
                const idx = _MEM.indexOf(m);
                const imp = Math.max(1, Math.min(10, Number(meta.imp) || 5));
                const filled = Math.round(imp / 2);
                const bars = Array.from({ length: 5 }, (_, i) => {
                    const cls = i < filled ? (imp >= 7 ? 'f3' : imp >= 4 ? 'f2' : 'f1') : '';
                    return `<i class="${cls}"></i>`;
                }).join('');
                const ttl = meta.ttl === -1 ? '영구' : (Number(meta.ttl) || 0) + 'turn';
                const originBadge = meta.source === 'narrative_source_record' ? '<span class="chip">서사 근거</span> ' : '';
                const note = readable.title || '';
                return `<tr id="mc-${idx}" data-idx="${idx}">
                    <td><div class="gauge"><span class="bars">${bars}</span><span>${imp}</span></div></td>
                    <td><div class="strong" data-memory-view-kind="${escAttr(readable.kind || '')}">${esc(stripMeta(m.content) || '')}</div>${note ? `<div class="dim">${esc(String(note).slice(0, 120))}</div>` : ''}</td>
                    <td><span class="chip">${esc(meta.cat || '일반')}</span></td>
                    <td class="dim" style="margin:0">T${Number(meta.t) || 0}<div class="dim" style="margin-top:2px">${esc(ttl)}</div></td>
                    <td style="white-space:nowrap">${originBadge}<button class="btn bd act-del-mem" data-idx="${idx}" title="삭제">✕</button> <button class="btn bs act-save-mem" data-idx="${idx}" title="저장">저장</button></td>
                </tr>`;
        }).join("");
        // 목업은 카드가 아니라 표다 — 훑어보기(밀도·비교)에 유리하다.
        const renderMemTable = (list) => {
            const tableNode = overlay.querySelector("#ml-table");
            const cardNode = overlay.querySelector("#ml");
            if (!tableNode || !cardNode) return;
            tableNode.innerHTML = list.length
                ? `<thead><tr><th>중요도</th><th>내용</th><th>분류</th><th>턴</th><th></th></tr></thead><tbody>${memRowsHtml(list)}</tbody>`
                : '';
            const wrap = tableNode.closest('.tbl');
            if (wrap) wrap.classList.toggle('hide', !list.length);
            cardNode.classList.toggle('hide', Boolean(list.length));
            if (!list.length) cardNode.innerHTML = '<div class="empty">저장된 메모리가 없습니다</div>';
        };
        // ── 연상 그래프 보기 ────────────────────────────────────────────────
        // 제품 그래프를 그린다. 데이터는 `MemoryEngine.getHmeGraphView()` 에서 온다 —
        //   화면이 노드를 만들지 않는다(발명 금지). 그래프가 없으면 **만들지 않고** 안내만 한다.
        //
        // 렉 방지 (사용자 제약: 노드가 많아도 렉 없음):
        //   ① 뷰 API 가 이미 상한(종류별 보장 + 엣지 끝점 보장)으로 자른 것을 받는다
        //   ② alpha 소진 시 rAF 정지 → 유휴 CPU 0
        //   ③ 뷰포트 컬링 + 라벨 LOD
        // 그래프 대상 id — 메모리 화면과 관계 화면이 **같은 렌더러**를 쓴다.
        //   id 를 하드코딩하면 화면이 하나뿐일 때만 맞는다(리팩터 전 상태).
        const GRAPH_TARGET_MEM = { host: '#ml-graph', cv: '#ml-graph-cv', kpi: '#ml-graph-kpi', paths: '#ml-graph-paths', card: '#ml', table: '#ml-table' };
        const GRAPH_TARGET_REL = { host: '#rl-graph', cv: '#rl-graph-cv', kpi: '#rl-graph-kpi', paths: '#rl-graph-paths', card: '#rl', table: null };
        const GRAPH_TARGET_ENT = { host: '#el-graph', cv: '#el-graph-cv', kpi: '#el-graph-kpi', paths: '#el-graph-paths', card: '#el', table: null };
        const graphState = { nodes: [], edges: [], alpha: 1, raf: null, scale: 1, tx: 0, ty: 0,
                             frames: 0, labels: false, drag: null, hover: null, pinned: null, userAdjusted: false };
        const GRAPH_ALPHA_MIN = 0.001, GRAPH_ALPHA_DECAY = 0.0228, GRAPH_VEL_DECAY = 0.6;
        const GRAPH_TYPE_R = { entity: 9, lore: 7, memory: 4.2 };
        const GRAPH_TYPE_C = { entity: '#c9a15a', lore: '#339cff', memory: '#6d8090' };
        const GRAPH_REL_C = {
            mentions_entity: 'rgba(201,161,90,.55)', described_by_lore: 'rgba(51,156,255,.5)',
            shared_entity: 'rgba(109,128,144,.2)', turn_proximity: 'rgba(109,128,144,.16)',
            shared_topic: 'rgba(109,128,144,.24)', relation_record: 'rgba(201,161,90,.35)'
        };
        const graphCleanLabel = (v) => String(v || '').split('/')[0].trim();

        const stopGraphLoop = () => { if (graphState.raf) { cancelAnimationFrame(graphState.raf); graphState.raf = null; } };

        const graphTick = (stageW, stageH) => {
            const { nodes, edges } = graphState;
            const n = nodes.length;
            for (let i = 0; i < n; i += 1) {
                const a = nodes[i];
                const aHub = a.type === 'entity';
                for (let j = i + 1; j < n; j += 1) {
                    const b = nodes[j];
                    let dx = b.x - a.x, dy = b.y - a.y;
                    let d2 = dx * dx + dy * dy;
                    if (d2 > 90000) continue;
                    if (d2 < 1e-4) { dx = (i - j) || 1; dy = 1.7; d2 = 3; }
                    let f = 900 / d2;
                    // 허브끼리 밀어낸다 — 안 하면 인물이 중심에 겹쳐 "허브 1개"처럼 보인다(실측).
                    if (aHub && b.type === 'entity') f *= 55;
                    const d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
                    a.vx -= ux * f; a.vy -= uy * f;
                    b.vx += ux * f; b.vy += uy * f;
                }
            }
            for (const e of edges) {
                const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
                const d = Math.sqrt(dx * dx + dy * dy) || 1;
                const rest = 46 + 130 * (1 - Math.min(1, e.weight));
                const f = (d - rest) * 0.0016 * (e.weight + 0.25);
                const ux = dx / d, uy = dy / d;
                e.a.vx += ux * f; e.a.vy += uy * f;
                e.b.vx -= ux * f; e.b.vy -= uy * f;
            }
            for (const p of nodes) {
                p.vx += (stageW / 2 - p.x) * 0.0012;
                p.vy += (stageH / 2 - p.y) * 0.0016;
                p.vx *= GRAPH_VEL_DECAY; p.vy *= GRAPH_VEL_DECAY;
                p.x += p.vx * graphState.alpha; p.y += p.vy * graphState.alpha;
            }
            // 허브 최소 간격 강제 — 반발력만으로는 fit 배율에서 부족해진다(실측).
            const hubs = nodes.filter(p => p.type === 'entity');
            for (let i = 0; i < hubs.length; i += 1) for (let j = i + 1; j < hubs.length; j += 1) {
                const a = hubs[i], b = hubs[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1;
                if (d >= 170) continue;
                const push = (170 - d) * 0.5, ux = dx / d, uy = dy / d;
                a.x -= ux * push; a.y -= uy * push;
                b.x += ux * push; b.y += uy * push;
            }
            graphState.alpha += (0 - graphState.alpha) * GRAPH_ALPHA_DECAY;
            if (graphState.alpha < GRAPH_ALPHA_MIN) graphState.alpha = 0;
        };

        const graphDraw = (TID = GRAPH_TARGET_MEM) => {
            const cv = overlay.querySelector(TID.cv);
            if (!cv) return;
            const stage = cv.parentElement;
            const W = stage.clientWidth, H = stage.clientHeight;
            if (!W || !H) return;
            const DPR = Math.min(2, window.devicePixelRatio || 1);
            if (cv.width !== Math.round(W * DPR) || cv.height !== Math.round(H * DPR)) {
                cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
            }
            const ctx = cv.getContext('2d');
            ctx.setTransform(DPR * graphState.scale, 0, 0, DPR * graphState.scale,
                             DPR * graphState.tx, DPR * graphState.ty);
            ctx.clearRect(-1e5, -1e5, 2e5, 2e5);
            const PAD = 48;
            const vx0 = -graphState.tx / graphState.scale - PAD, vy0 = -graphState.ty / graphState.scale - PAD;
            const vx1 = (-graphState.tx + W) / graphState.scale + PAD, vy1 = (-graphState.ty + H) / graphState.scale + PAD;
            const vis = (p) => p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1;
            for (const e of graphState.edges) {
                if (!vis(e.a) && !vis(e.b)) continue;
                ctx.strokeStyle = GRAPH_REL_C[e.relation] || 'rgba(109,128,144,.18)';
                ctx.lineWidth = 0.9;
                ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
            }
            const showLabel = graphState.scale >= 0.42;
            graphState.labels = showLabel;
            const placed = [];
            const labels = graphState.nodes.filter(vis).map(p => [p, (GRAPH_TYPE_R[p.type] || 4) * (1 + Math.min(0.5, p.deg / 40))]);
            // 허브(인물·로어) 라벨에 우선권 — 기억 라벨은 밀려난다.
            labels.sort((a, b) => (b[0].type === 'entity' ? 2 : b[0].type === 'lore' ? 1 : 0)
                - (a[0].type === 'entity' ? 2 : a[0].type === 'lore' ? 1 : 0));
            for (const [p, r] of labels) {
                const isHub = p.type === 'entity';
                ctx.beginPath();
                if (isHub) {
                    ctx.arc(p.x, p.y, r * 2.6, 0, 6.2832);
                    ctx.fillStyle = 'rgba(201,161,90,.10)'; ctx.fill();
                    ctx.beginPath();
                }
                ctx.arc(p.x, p.y, r, 0, 6.2832);
                ctx.fillStyle = GRAPH_TYPE_C[p.type] || '#6d8090'; ctx.fill();
                const isHot = graphState.hover === p.id || graphState.pinned === p.id;
                if (isHot) {
                    // 클릭 대상 강조 — 테두리를 밝게 + 살짝 크게
                    ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, 6.2832);
                    ctx.lineWidth = 2.2; ctx.strokeStyle = '#e0bd7c'; ctx.stroke();
                }
                if (isHub || p.type === 'lore' || isHot) {
                    ctx.lineWidth = isHot ? 1.8 : 1.2;
                    ctx.strokeStyle = isHot ? '#e0bd7c' : 'rgba(12,16,19,.85)'; ctx.stroke();
                }
            }
            if (!showLabel) return;
            ctx.font = '600 11px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            for (const [p, r] of labels) {
                const t = p.type === 'memory' ? ('T' + (p.turn == null ? '?' : p.turn)) : graphCleanLabel(p.label);
                const w = ctx.measureText(t).width, h = 11;
                const x0 = p.x - w / 2, y0 = p.y + r + 3;
                // 충돌하는 라벨은 그리지 않는다 — 겹치면 아무것도 안 읽힌다(실측).
                const clash = placed.some(q => x0 < q.x1 + 15 && x0 + w + 15 > q.x0 && y0 < q.y1 + 4 && y0 + h + 4 > q.y0);
                if (clash) continue;
                placed.push({ x0, x1: x0 + w, y0, y1: y0 + h });
                ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(12,16,19,.9)';
                ctx.strokeText(t, p.x, y0);
                ctx.fillStyle = p.type === 'memory' ? '#9fb0bd' : '#e7edf1';
                ctx.fillText(t, p.x, y0);
            }
        };

        // ── 그래프 상호작용 (C) ──────────────────────────────────────────────
        // 노드를 클릭하면 그 대상으로 이동한다 — 그래프가 '보기'가 아니라 '탐색 도구'가 된다.
        //   인물 노드 → 인물 프로필 상세 (`renderEntityProfile`)
        //   기억 노드 → 메모리 목록에서 그 항목으로 (보기 전환 + 검색어 채우기)
        // 클릭 지점을 **캔버스 좌표 → 월드 좌표**로 되돌려 가장 가까운 노드를 고른다.
        const GRAPH_HIT_RADIUS = 16;
        const graphNodeAt = (TID, clientX, clientY) => {
            const cv = overlay.querySelector(TID.cv);
            if (!cv) return null;
            const rect = cv.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            // 화면 → 월드 (fit/줌 변환의 역)
            const wx = (clientX - rect.left - graphState.tx) / graphState.scale;
            const wy = (clientY - rect.top - graphState.ty) / graphState.scale;
            let best = null, bestD = Infinity;
            for (const p of graphState.nodes) {
                const r = (GRAPH_TYPE_R[p.type] || 4) * (1 + Math.min(0.5, p.deg / 40)) + GRAPH_HIT_RADIUS;
                const d = Math.hypot(p.x - wx, p.y - wy);
                if (d <= r && d < bestD) { best = p; bestD = d; }
            }
            return best;
        };
        // 인물 노드 → 프로필. rowId(`lmai_entity::<이름>`) 또는 label 로 _ENT 에서 찾는다.
        const openEntityFromGraph = (node) => {
            if (!node || !Array.isArray(_ENT)) return false;
            const want = String(node.rowId || '').trim();
            const label = graphCleanLabel(node.label || '');
            const idx = _ENT.findIndex((e, i) => {
                let d = {};
                try { d = parseGuiStoredJson(e, 'entity.graphHit', i) || {}; } catch (_) { d = {}; }
                const key = String(e?.key || '').trim();
                const name = String(d?.name || '').trim();
                return key === want || (name && name === label) || key === ('lmai_entity::' + label);
            });
            if (idx < 0) return false;
            renderEntityProfile(idx);
            return true;
        };
        // 기억 노드 → 메모리 화면 그 항목. 보기를 목록으로 돌리고 검색어에 키를 넣는다.
        const openMemoryFromGraph = (node) => {
            if (!node) return false;
            const key = String(node.rowId || '').trim();
            if (!key) return false;
            memViewState.view = 'list';
            overlay.querySelectorAll('[data-mem-view]').forEach(x => x.classList.toggle('on', x.dataset.memView === 'list'));
            const search = overlay.querySelector('#ms');
            if (search) search.value = key;
            switchTab('memory');
            try { filterMems(); } catch (_) {}
            return true;
        };
        const graphActivateNode = (TID, node) => {
            if (!node) return;
            if (node.type === 'entity') { openEntityFromGraph(node); return; }
            if (node.type === 'memory') { openMemoryFromGraph(node); return; }
            // 로어 노드는 대응하는 화면이 없다 — 강조만 하고 이동하지 않는다(없는 화면을 만들지 않는다).
            graphState.pinned = node.id;
            graphDraw(TID);
        };
        // 호버 강조 — 클릭 가능하다는 것을 알린다.
        const graphHoverAt = (TID, clientX, clientY) => {
            const node = graphNodeAt(TID, clientX, clientY);
            const id = node ? node.id : null;
            if (graphState.hover === id) return;
            graphState.hover = id;
            const cv = overlay.querySelector(TID.cv);
            if (cv) cv.style.cursor = id ? 'pointer' : 'default';
            graphDraw(TID);
        };
        const bindGraphInteraction = (TID) => {
            const cv = overlay.querySelector(TID.cv);
            if (!cv || cv.dataset.bound === '1') return;
            cv.dataset.bound = '1';
            cv.addEventListener('mousemove', (ev) => graphHoverAt(TID, ev.clientX, ev.clientY));
            cv.addEventListener('mouseleave', () => { graphState.hover = null; cv.style.cursor = 'default'; graphDraw(TID); });
            cv.addEventListener('click', (ev) => {
                const node = graphNodeAt(TID, ev.clientX, ev.clientY);
                if (node) graphActivateNode(TID, node);
            });
        };

        const graphFit = (TID = GRAPH_TARGET_MEM) => {
            const cv = overlay.querySelector(TID.cv);
            if (!cv || !graphState.nodes.length) return;
            const stage = cv.parentElement;
            const W = stage.clientWidth, H = stage.clientHeight;
            if (!W || !H) return;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of graphState.nodes) {
                if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
                if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
            }
            const sx = W / Math.max(1, (x1 - x0) + 128);
            const sy = H / Math.max(1, (y1 - y0) + 128);
            graphState.scale = Math.min(1.8, Math.max(0.18, Math.min(sx, sy)));
            graphState.tx = W / 2 - ((x0 + x1) / 2) * graphState.scale;
            graphState.ty = H / 2 - ((y0 + y1) / 2) * graphState.scale;
            graphDraw(TID);
        };

        const startGraphLoop = (TID = GRAPH_TARGET_MEM) => {
            stopGraphLoop();
            const cv = overlay.querySelector(TID.cv);
            if (!cv) return;
            const stage = cv.parentElement;
            graphState.alpha = 1; graphState.frames = 0;
            const loop = () => {
                graphTick(stage.clientWidth, stage.clientHeight);
                graphDraw(TID);
                graphState.frames += 1;
                if (graphState.alpha >= GRAPH_ALPHA_MIN && graphState.frames < 3000) {
                    graphState.raf = requestAnimationFrame(loop);
                } else {
                    graphState.raf = null;
                    // 정지 시 한 번 맞춘다 — 사용자가 직접 줌/팬 하기 전에만.
                    if (!graphState.userAdjusted) graphFit(TID);
                }
            };
            graphState.raf = requestAnimationFrame(loop);
        };

        // 공용 그래프 렌더러 — 메모리 화면과 관계 화면이 같은 코드를 쓴다.
        //   화면별로 다른 것은 ① 뷰 getter ② 대상 id ③ KPI 라벨 ④ 빈 안내 문구뿐이다.
        //   id 를 하드코딩하면 화면이 하나뿐일 때만 맞는다(리팩터 전 상태).
        const renderGraphView = (opts = {}) => {
            const TID = opts.target || GRAPH_TARGET_MEM;
            const host = overlay.querySelector(TID.host);
            const cv = overlay.querySelector(TID.cv);
            const kpi = overlay.querySelector(TID.kpi);
            const paths = overlay.querySelector(TID.paths);
            if (!host || !cv || !kpi || !paths) return;
            let view = null;
            try {
                view = (opts.getView ? opts.getView() : null) || null;
            } catch (_) { view = null; }
            if (!view || view.ok !== true) {
                // 그래프가 없으면 **만들지 않는다** — 안내만 한다(렌더 중 구축은 화면을 멈춘다).
                stopGraphLoop();
                kpi.innerHTML = '';
                paths.innerHTML = '<div class="mg-empty">' + (opts.emptyHtml || '연상 그래프가 아직 없습니다.')
                    + '<br><span style="color:var(--text3)">' + esc(String(view?.reason || 'unavailable')) + '</span></div>';
                return;
            }
            const stage = cv.parentElement;
            const W = Math.max(240, stage.clientWidth), H = Math.max(240, stage.clientHeight);
            const idMap = new Map();
            graphState.nodes = (view.nodes || []).map((n, i) => {
                const a = (i * 2.399963) % (Math.PI * 2);
                const r = Math.min(W, H) * 0.38 * Math.sqrt(i / Math.max(1, (view.nodes || []).length));
                const node = {
                    id: n.id, rowId: n.rowId, type: n.nodeType || 'memory',
                    label: n.label || n.rowId, turn: n.turn, deg: 0,
                    x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0
                };
                idMap.set(n.id, node);
                return node;
            });
            graphState.edges = [];
            for (const e of (view.edges || [])) {
                const a = idMap.get(e.from), b = idMap.get(e.to);
                if (!a || !b) continue;
                const w = Number(e.weight) || 0.2;
                graphState.edges.push({ a, b, relation: e.relation, weight: w });
                a.deg += w; b.deg += w;
            }
            graphState.scale = 1; graphState.tx = 0; graphState.ty = 0; graphState.userAdjusted = false; graphState.hover = null; graphState.pinned = null;
            const types = graphState.nodes.reduce((m, n) => { m[n.type] = (m[n.type] || 0) + 1; return m; }, {});
            const rel = (view.stats && view.stats.relationCounts) || {};
            // KPI 는 화면 목적에 따라 다르다 — 관계 화면은 "이어진 인물 수" 가 핵심이다.
            const kpis = opts.kpis
                ? opts.kpis(view, graphState, types)
                : [
                    ['노드', graphState.nodes.length + ' / ' + (view.stats?.nodeCount || graphState.nodes.length)],
                    ['엣지', graphState.edges.length + ' / ' + (view.stats?.edgeCount || graphState.edges.length)],
                    ['인물', types.entity || 0],
                    ['로어', types.lore || 0]
                ];
            kpi.innerHTML = kpis.map(([k, v]) => `<div><div class="v">${esc(String(v))}</div><div class="k">${esc(k)}</div></div>`).join('');
            // 엣지 관계 요약 — 관계 화면은 relation_type 도 보여준다.
            const relations = Array.from(new Set(graphState.edges.map(e => e.relation))).filter(Boolean);
            const relList = Object.keys(rel).filter(k => Number(rel[k]) > 0).slice(0, 6);
            paths.innerHTML = relList.length
                ? '<div class="mg-empty" style="padding:2px 0 6px">엣지 관계<br>' + relList.map(k =>
                    `<b style="color:var(--accent2)">${esc(k)}</b> ${Number(rel[k])}`).join('<br>') + '</div>'
                : (relations.length
                    ? '<div class="mg-empty" style="padding:2px 0 6px">엣지 관계<br>' + relations.slice(0, 6).map(k =>
                        `<b style="color:var(--accent2)">${esc(k)}</b>`).join('<br>') + '</div>'
                    : '<div class="mg-empty">엣지 관계 없음</div>');
            bindGraphInteraction(TID);
            startGraphLoop(TID);
        };

        const renderMemGraph = () => renderGraphView({
            target: GRAPH_TARGET_MEM,
            getView: () => MemoryEngine.getHmeGraphView?.(getActiveManagedRuntimeScopeKey?.() || getChatRuntimeScopeKey(chat, char)),
            emptyHtml: '연상 그래프가 아직 없습니다.<br>기억이 쌓이고 회상이 한 번 돌면 그래프가 만들어집니다.'
        });

        // 인물 화면 그래프 — 인물 + 그들 사이 관계 + 인물당 소수의 등장 기억.
        //   질문이 "이 인물이 어떤 기억에 나오는가" 이므로 기억을 조금 담는다(관계 화면과 다르다).
        const renderEntGraph = () => renderGraphView({
            target: GRAPH_TARGET_ENT,
            getView: () => MemoryEngine.getHmeCharacterGraphView?.(
                getActiveManagedRuntimeScopeKey?.() || getChatRuntimeScopeKey(chat, char),
                { memoriesPerEntity: 5 }
            ),
            emptyHtml: '인물 연상 그래프가 아직 없습니다.<br>인물이 추적되고 회상이 한 번 돌면 만들어집니다.',
            kpis: (view, st, types) => [
                ['인물', types.entity || 0],
                ['기억', types.memory || 0],
                ['관계', st.edges.filter(e => e.relation === 'relation_record').length],
                ['등장', st.edges.filter(e => e.relation === 'mentions_entity').length]
            ]
        });

        // 관계 화면 그래프 — 인물과 그들 사이의 관계만 그린다(기억 노드는 소음).
        const renderRelGraph = () => renderGraphView({
            target: GRAPH_TARGET_REL,
            getView: () => MemoryEngine.getHmeEntityGraphView?.(getActiveManagedRuntimeScopeKey?.() || getChatRuntimeScopeKey(chat, char)),
            emptyHtml: '인물 연상 그래프가 아직 없습니다.<br>인물이 추적되고 회상이 한 번 돌면 만들어집니다.',
            kpis: (view, st, types) => [
                ['인물', view.stats?.linkedCount != null
                    ? (view.stats.linkedCount + ' / ' + (view.stats.nodeCount || types.entity || 0))
                    : (types.entity || 0)],
                ['관계', st.edges.filter(e => e.relation === 'relation_record').length],
                ['엣지', st.edges.length],
                ['수치', st.edges.length ? Math.round(st.edges.reduce((a, e) => a + e.weight, 0) / st.edges.length * 100) + '%' : '—']
            ]
        });

        const renderMems = (list) => {
            const c = overlay.querySelector("#ml");
            overlay.querySelector("#mc").textContent = list.length;
            const graphHost = overlay.querySelector('#ml-graph');
            // 그래프 보기 — 표·카드를 모두 숨기고 그래프 패널만 보인다.
            //   `renderMemTable` 을 거치지 않으면 표가 남아 그래프 위에 겹친다(실측 패턴).
            if (memViewState.view === 'graph') {
                const tw = overlay.querySelector("#ml-table")?.closest('.tbl');
                if (tw) tw.classList.add('hide');
                c.classList.add('hide');
                if (graphHost) graphHost.classList.remove('hide');
                renderMemGraph();
                syncSidebarCounts();
                return;
            }
            if (graphHost) graphHost.classList.add('hide');
            if (memViewState.view === 'list') { renderMemTable(list); syncSidebarCounts(); return; }
            const tableWrap = overlay.querySelector("#ml-table")?.closest('.tbl');
            if (tableWrap) tableWrap.classList.add('hide');
            c.classList.remove('hide');
            if (!list.length) { c.innerHTML = '<div class="empty">저장된 메모리가 없습니다</div>'; syncSidebarCounts(); return; }
            c.innerHTML = memCardsHtml(list);
            syncSidebarCounts();
        };

        // 메모리 구분 — 턴별 / 종류별 보기와 분류·수명 필터.
        // 축은 meta 에 실제로 있는 것만 쓴다: imp(중요도) · t(턴) · ttl(수명) · cat(분류) · source(서사 근거).
        // 서사 근거 원문(narrative_source_record)은 사용자 기억이 아니라 서사 요약의 내부 근거이므로
        // 기본은 '없는 것'으로 취급하고, 한 켠의 토글로만 드러낸다.
        const memViewState = { view: 'list', showNarrativeSource: false };
        const memFilterPass = (meta, m, q) => {
            if (!memViewState.showNarrativeSource && String(meta.source || '') === 'narrative_source_record') return false;
            const f = overlay.querySelector("#mf")?.value || 'all';
            // 칩 필터를 우선 읽고, 칩이 없던 시절의 select(#mkind/#mttl)도 계속 지원한다.
            const chip = (group, fallback) => {
                const node = overlay.querySelector(`[data-mem-${group}].on`);
                return (node && node.dataset[`mem${group[0].toUpperCase()}${group.slice(1)}`]) || fallback;
            };
            const kind = chip('kind', overlay.querySelector("#mkind")?.value || 'all');
            const ttl = chip('ttl', overlay.querySelector("#mttl")?.value || 'all');
            const turnRange = chip('turn', 'all');
            const imp = meta.imp || 5;
            const mf = f === "h" ? imp >= 7 : f === "m" ? (imp >= 4 && imp < 7) : f === "l" ? imp < 4 : true;
            const mk = kind === 'all' ? true : String(meta.cat || '일반') === kind;
            const mt = ttl === 'all' ? true : (ttl === 'perm' ? meta.ttl === -1 : meta.ttl !== -1);
            const turn = Number(meta.t) || 0;
            const mr = turnRange === 'all' ? true
                : turnRange === 'recent' ? turn >= 90
                    : turnRange === 'mid' ? (turn >= 60 && turn < 90)
                        : turn < 60;
            const readable = buildGuiMemoryReadable(m, meta);
            const c = [stripMeta(m.content), readable.body, ...(readable.chips || [])].join(' ').toLowerCase();
            const mq = !q || c.indexOf(q) >= 0;
            return mf && mk && mt && mr && mq;
        };
        const memPassList = (q) => _MEM.filter(m => memFilterPass(parseMeta(m.content), m, q));
        const memGroupedHtml = (rows, keyFn, groupLabel) => {
            const groups = new Map();
            rows.forEach(m => {
                const meta = parseMeta(m.content);
                const k = keyFn(meta);
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(m);
            });
            const keys = Array.from(groups.keys()).sort((a, b) => {
                if (memViewState.view === 'turn') return Number(String(b).replace(/\D/g, '')) - Number(String(a).replace(/\D/g, ''));
                return groups.get(b).length - groups.get(a).length;
            });
            return keys.map(k => {
                const items = groups.get(k);
                const imps = items.map(m => parseMeta(m.content).imp || 5);
                const avg = Math.round(imps.reduce((s, x) => s + x, 0) / imps.length);
                const turns = items.map(m => parseMeta(m.content).t || 0);
                const meta2 = items.length > 1
                    ? `중요도 평균 ${avg} · T${Math.min(...turns)}–T${Math.max(...turns)}`
                    : `중요도 ${avg} · T${turns[0]}`;
                return `<div class="mem-group"><div class="mem-group-h"><span class="mem-group-t">${esc(groupLabel(k))}</span><span class="bdg bt">${items.length}건</span><span class="mem-group-m">${esc(meta2)}</span></div>${memCardsHtml(items)}</div>`;
            }).join('');
        };
        const filterMems = () => {
            const q = (overlay.querySelector("#ms")?.value || '').toLowerCase();
            const rows = memPassList(q);
            const note = overlay.querySelector('#mem-shown-note');
            const total = _MEM.filter(m => memViewState.showNarrativeSource || String(parseMeta(m.content).source || '') !== 'narrative_source_record').length;
            if (note) note.textContent = rows.length === total ? '' : `· 표시 ${rows.length}건`;
            const hiddenSrc = _MEM.filter(m => String(parseMeta(m.content).source || '') === 'narrative_source_record').length;
            const toggle = overlay.querySelector('#mem-nsrc-toggle');
            if (toggle) {
                toggle.textContent = memViewState.showNarrativeSource ? `서사 근거 ${hiddenSrc}건 숨기기` : `서사 근거 ${hiddenSrc}건`;
                toggle.classList.toggle('is-on', memViewState.showNarrativeSource);
            }
            // 카드 보기(턴별/종류별)는 renderMems 를 거쳐야 한다.
            // 직접 innerHTML 을 채우면 renderMems 의 표 숨김·카드 노출(classList)이
            // 건너뛰어져 **표가 사라지지 않고 카드도 hide 인 채로 남는다**(실측:
            // 턴별 클릭 후 표 404px 유지 · #ml 이 "list hide" · 카드 1개가 높이 0).
            const c = overlay.querySelector("#ml");
            if (!c) return;
            // 그래프 보기는 목록 필터와 무관하다 — 그래프는 별도 데이터다.
            if (memViewState.view === 'graph') { renderMems(rows); return; }
            if (!rows.length) {
                renderMems([]);
                c.innerHTML = '<div class="empty">조건에 맞는 메모리가 없습니다</div>';
                return;
            }
            renderMems(rows);
            c.innerHTML = memViewState.view === 'turn'
                ? memGroupedHtml(rows, meta => `T${meta.t || 0}`, k => k)
                : memGroupedHtml(rows, meta => String(meta.cat || '일반'), k => k);
        };

        const renderEntityBlocklist = () => {
            const blockListEl = overlay.querySelector("#entity-block-list");
            if (!blockListEl) return;
            const blocked = getGuiEntityBlocklist();
            if (!blocked.length) {
                blockListEl.innerHTML = '<div class="empty">차단된 엔티티가 없습니다</div>';
                return;
            }
            blockListEl.innerHTML = blocked.map(name => `<div class="card ent"><div class="card-hdr"><strong>${esc(name)}</strong><div class="acts"><button class="btn bs act-unblock-ent" data-name="${escAttr(name)}">차단 해제</button></div></div></div>`).join("");
        };
        const guiArray = (value) => Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
        const guiCsv = (value) => dedupeTextArray(guiArray(value).map(item => String(item || '').trim()).filter(Boolean)).join(", ");
        const guiLines = (value) => guiArray(value).map(item => String(item || '').trim()).filter(Boolean).join("\n");
        const formatGuiRelationRecentChanges = (value, depth = 0) => {
            if (depth > 4 || value == null || value === '') return '';
            if (Array.isArray(value)) {
                return dedupeTextArray(value.flatMap(item => formatGuiRelationRecentChanges(item, depth + 1).split(/\r?\n/)).map(line => line.trim()).filter(Boolean)).join('\n');
            }
            if (value && typeof value === 'object') {
                const lines = [];
                const push = (label, item) => {
                    const text = formatGuiRelationRecentChanges(item, depth + 1);
                    if (!text) return;
                    text.split(/\r?\n/).filter(Boolean).forEach(line => lines.push(label ? `${label}: ${line}` : line));
                };
                push('', value.summary || value.change || value.brief || value.description || value.event);
                push('겉으로 드러난 변화', value.publicLayer || value.public_layer);
                push('내면의 변화', value.privateLayer || value.private_layer);
                push('현재 경계', value.boundaryState || value.boundary_state);
                push('관계 변화', value.relationDelta || value.relationshipDelta || value.delta);
                push('변화 이유', value.reason || value.cause);
                return dedupeTextArray(lines.map(line => line.trim()).filter(Boolean)).join('\n');
            }
            const text = String(value || '').trim();
            if (!text || text === '[object Object]' || /^(?:null|undefined)$/i.test(text)) return '';
            if (/^[\[{]/.test(text)) {
                try { return formatGuiRelationRecentChanges(JSON.parse(text), depth + 1); } catch (_) { /* keep natural text below */ }
            }
            return text;
        };
        const guiFirstText = (...values) => {
            for (const value of values) {
                const text = String(value || '').trim();
                if (text) return text;
            }
            return '';
        };
        const guiFirstList = (...values) => {
            for (const value of values) {
                const list = guiArray(value).map(item => String(item || '').trim()).filter(Boolean);
                if (list.length) return list;
            }
            return [];
        };
        const parseGuiCsv = (value) => dedupeTextArray(String(value || '').split(",").map(s => s.trim()).filter(Boolean));
        const parseGuiLines = (value) => String(value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const hasGuiValue = (value) => {
            if (Array.isArray(value)) return value.some(hasGuiValue);
            if (value && typeof value === 'object') return Object.values(value).some(hasGuiValue);
            return String(value || '').trim().length > 0;
        };
        const formatGuiOpenThreadLabels = (items) => guiArray(items).map(item => {
            if (typeof item === 'string') return item.trim();
            if (!item || typeof item !== 'object') return '';
            return String(item.label || item.summary || item.text || item.name || '').trim();
        }).filter(Boolean).join("\n");
        const parseGuiOpenThreadLabels = (value) => parseGuiLines(value).map(line => ({
            id: `thread_${TokenizerEngine.simpleHash(line)}`,
            status: 'active',
            pressure: 0,
            label: line
        })).filter(item => item.label);
        const formatGuiEntityBackground = (entity = {}) => {
            const background = entity?.background && typeof entity.background === 'object' ? entity.background : entity?.background;
            if (typeof background === 'string') return background.trim();
            return guiFirstText(
                background?.summary,
                background?.origin,
                guiLines(background?.history || [])
            );
        };
        const normalizeGuiStateTimelineRows = (items) => guiArray(items).map(item => {
            if (typeof item === 'string') {
                const summary = item.trim();
                return summary ? { turn: 0, summary, meta: [], sourceKind: '' } : null;
            }
            if (!item || typeof item !== 'object') return null;
            const turn = Number(item.turn ?? item.sourceTurn ?? item.lastObservedTurn ?? 0) || 0;
            const summary = String(item.summary || item.state || item.text || item.description || item.note || '').trim();
            const physicalState = guiArray(item.physicalState || item.physical_state || []).map(v => String(v || '').trim()).filter(Boolean);
            const emotionalState = guiArray(item.emotionalState || item.emotional_state || []).map(v => String(v || '').trim()).filter(Boolean);
            const cognitiveFocus = guiArray(item.cognitiveFocus || item.cognitive_focus || []).map(v => String(v || '').trim()).filter(Boolean);
            const meta = [
                physicalState.length ? `신체: ${physicalState.join(', ')}` : '',
                emotionalState.length ? `감정: ${emotionalState.join(', ')}` : '',
                cognitiveFocus.length ? `초점: ${cognitiveFocus.join(', ')}` : ''
            ].filter(Boolean);
            return summary || meta.length ? {
                turn,
                summary,
                meta,
                sourceKind: String(item.sourceKind || item.source || item.stability || '').trim()
            } : null;
        }).filter(Boolean).slice(-24);
        const formatGuiStateTimelineHtml = (items) => {
            const rows = normalizeGuiStateTimelineRows(items);
            if (!rows.length) return { count: 0, html: '<div class="entity-state-empty">턴별 상태 로그가 없습니다</div>' };
            return {
                count: rows.length,
                html: rows.slice().reverse().map(row => `
                    <div class="entity-state-row">
                        <div class="entity-state-row-head">
                            <span class="entity-state-turn">${row.turn ? `T${row.turn}` : 'T?'}</span>
                            ${row.sourceKind ? `<span class="entity-state-source">${esc(row.sourceKind)}</span>` : ''}
                        </div>
                        ${row.summary ? `<div class="entity-state-summary">${esc(row.summary)}</div>` : ''}
                        ${row.meta.length ? `<div class="entity-state-meta">${esc(row.meta.join(' | '))}</div>` : ''}
                    </div>
                `).join("")
            };
        };
        const parseGuiStoredJson = (entry = null, kind = 'gui-entry', index = -1) => {
            try {
                const parsed = JSON.parse(String(entry?.content || '{}'));
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch (error) {
                recordSuppressedRuntimeError(`gui.${kind}.parse_failed`, error, {
                    comment: String(entry?.comment || '').trim(),
                    key: String(entry?.key || '').trim(),
                    index: Number(index || 0) || 0
                });
                return {};
            }
        };
        // 관계 탐색기 — 검색·필터는 클라이언트 필터다(추가 분석 호출 없음).
        // 축은 제품 데이터에 실재하는 것만 쓴다: details.closeness / details.trust /
        // meta.manualLocked / 감정 누락. '긴장' 칩은 제품에 없는 축이라 제거했다.
        const relFilterState = { query: '', filter: 'all' };
        const relRowMeta = (row, tr) => {
            const idx = Number(row?.dataset.idx);
            const entry = Number.isFinite(idx) ? _REL[idx] : null;
            let d = {};
            try { d = JSON.parse(String(entry?.content || '{}')) || {}; } catch (_) { d = {}; }
            const details = d.details && typeof d.details === 'object' ? d.details : {};
            return {
                closeness: Number.isFinite(Number(details.closeness)) ? Math.round(Number(details.closeness) * 100) : null,
                trust: Number.isFinite(Number(details.trust)) ? Math.round(Number(details.trust) * 100) : null,
                locked: !!(d.meta && d.meta.manualLocked),
                sentiment: String((d.sentiments && d.sentiments.fromAtoB) || '').trim(),
                type: String(d.relationType || '').trim()
            };
        };
        const applyRelFilter = () => {
            const table = overlay.querySelector('#rl');
            if (!table) return;
            table.querySelectorAll('tr.rel-row').forEach(row => {
                const tr = relRowMeta(row, row);
                const hay = [tr.type, tr.sentiment, row.textContent || ''].join(' ').toLowerCase();
                const qOk = !relFilterState.query || hay.includes(relFilterState.query);
                let fOk = true;
                if (relFilterState.filter === 'strong') fOk = tr.closeness != null && tr.closeness >= 70;
                else if (relFilterState.filter === 'weak') fOk = tr.closeness != null && tr.closeness < 40;
                else if (relFilterState.filter === 'onenone') fOk = tr.closeness == null || tr.trust == null;
                else if (relFilterState.filter === 'locked') fOk = tr.locked;
                const visible = qOk && fOk;
                row.hidden = !visible;
                // 접힌 상세 행도 함께 따라가야 '한 행만 사라지는' 어긋남이 없다.
                const detail = table.querySelector(`tr.rel-detail-row[data-idx="${row.dataset.idx}"]`);
                if (detail) detail.hidden = !visible;
            });
            const count = overlay.querySelector('#rel-count');
            const total = table.querySelectorAll('tr.rel-row').length;
            const shown = [...table.querySelectorAll('tr.rel-row')].filter(r => !r.hidden).length;
            if (count) count.textContent = shown === total ? `관계 ${total}건` : `관계 ${shown}건 표시 / 전체 ${total}건`;
        };
        // 관계 표만 다시 그린다. 종전에는 switchTab 이 renderRels() 를 호출했는데
        // 그런 함수가 없어서 관계 화면 갱신이 조용히 실패했다(런타임 오류).
        // 관계 렌더는 renderEnts 안에 묶여 있었고, 그대로 두면 인물 입력까지
        // 다시 그려 편집 중인 값이 날아간다. 그래서 관계 부분만 분리했다.
        // 관계 보기 상태 — 메모리 보기와 같은 패턴(목록 / 그래프).
        const relViewState = { view: 'list' };
        const renderRels = () => {
            const rc = overlay.querySelector("#rl");
            const relGraphHost = overlay.querySelector('#rl-graph');
            // 그래프 보기 — 표를 숨기고 그래프 패널만 보인다.
            if (relViewState.view === 'graph') {
                const tw = overlay.querySelector("#rl")?.closest('.tbl-wrap');
                if (tw) tw.classList.add('hide');
                if (rc) rc.classList.add('hide');
                if (relGraphHost) relGraphHost.classList.remove('hide');
                renderRelGraph();
                return;
            }
            if (relGraphHost) relGraphHost.classList.add('hide');
            if (rc) rc.classList.remove('hide');
            const relTw = overlay.querySelector("#rl")?.closest('.tbl-wrap');
            if (relTw) relTw.classList.remove('hide');
            if (!_REL.length) { rc.innerHTML = '<div class="empty">추적된 관계가 없습니다</div>'; }
            else {
                rc.innerHTML = _REL.map((r, i) => {
                    let d = parseGuiStoredJson(r, 'relation.render', i);
                    const isManualLocked = !!d?.meta?.manualLocked;
                    const hasCls = Number.isFinite(Number(d?.details?.closeness));
                    const hasTrs = Number.isFinite(Number(d?.details?.trust));
                    const cls = hasCls ? Math.round(Number(d.details.closeness) * 100) : null;
                    const trs = hasTrs ? Math.round(Number(d.details.trust) * 100) : null;
                    const assessment = d.relationshipAssessment && typeof d.relationshipAssessment === 'object' ? d.relationshipAssessment : {};
                    const definitionConfidence = Number.isFinite(Number(assessment.definitionConfidence))
                        ? Math.round(Number(assessment.definitionConfidence) * 100)
                        : null;
                    const currentStatus = d.currentStatus && typeof d.currentStatus === 'object' ? d.currentStatus : {};
                    const dynamics = d.dynamics && typeof d.dynamics === 'object' ? d.dynamics : {};
                    // 수치는 인물 속성이 아니라 A→B 방향의 값이다. 헤더에 방향을 명시한다.
                    const dirLabel = `<span class="rel-dir">${esc(d.entityA || "?")}<span class="rel-dir-arrow">→</span>${esc(d.entityB || "?")}</span>`;
                    const clsBar = cls == null ? '<span class="dim">판단 보류</span>' : `<div class="gauge"><span class="bars">${Array.from({length:5},(_,k)=>{const f=Math.round(cls/20);return `<i class="${k<f?(cls>=70?'f3':cls>=40?'f2':'f1'):''}"></i>`;}).join('')}</span><span>${cls}</span></div>`;
                    const trsBar = trs == null ? '<span class="dim">판단 보류</span>' : `<div class="gauge"><span class="bars">${Array.from({length:5},(_,k)=>{const f=Math.round(trs/20);return `<i class="${k<f?(trs>=70?'f3':trs>=40?'f2':'f1'):''}"></i>`;}).join('')}</span><span>${trs}</span></div>`;
                    return `<tr class="rel-row" data-idx="${i}">
                        <td><div class="strong rel-dir-cell">${dirLabel}</div><div class="dim">${isManualLocked ? '수동 보호됨' : '자동 수정 가능'}</div></td>
                        <td><input type="text" class="rT-val inp-inline" data-idx="${i}" value="${escAttr(d.relationType || "")}" placeholder="관계 유형"></td>
                        <td><div class="rel-score-cell"><span class="fl">친밀</span>${clsBar}</div><div class="rel-score-cell"><span class="fl">신뢰</span>${trsBar}</div><div class="rw" style="display:none"><input type="range" class="rC-val" data-idx="${i}" min="0" max="100" value="${cls ?? 0}" data-unset="${cls == null ? '1' : '0'}"><input type="range" class="rR-val" data-idx="${i}" min="0" max="100" value="${trs ?? 0}" data-unset="${trs == null ? '1' : '0'}"></div></td>
                        <td><input type="text" class="rS-val inp-inline" data-idx="${i}" value="${escAttr((d.sentiments && d.sentiments.fromAtoB) || "")}" placeholder="감정 (A→B)"><textarea class="ec rChanges-val" data-idx="${i}" rows="2" placeholder="최근 변화">${esc(formatGuiRelationRecentChanges(dynamics.recentChanges || []))}</textarea></td>
                        <td style="white-space:nowrap"><button class="btn bp act-save-rel" data-idx="${i}">저장</button> <button class="btn bd act-del-rel" data-idx="${i}">삭제</button></td>
                    </tr>
                    <tr class="rel-detail-row" data-idx="${i}"><td colspan="5">
                        <div class="card-hdr" style="display:none"><strong>${dirLabel}</strong>
                            <div class="card-meta">${isManualLocked ? '<span class="bdg bh">수동 보호됨</span>' : '<span class="bdg bt">자동 수정 가능</span>'}</div>
                            <div class="acts"><button class="btn bp act-save-rel" data-idx="${i}">저장</button><button class="btn bs act-toggle-lock-rel" data-idx="${i}">${isManualLocked ? '보호 해제' : '보호 설정'}</button><button class="btn bd act-del-rel" data-idx="${i}">삭제</button></div>
                        </div>
                        <div class="rel-define">
                            <div>
                                <div class="rel-define-main">${esc(assessment.label || (hasCls || hasTrs ? '관계 정의됨' : '첫 대면 · 정의 보류'))}${definitionConfidence != null ? ` · ${definitionConfidence}%` : ''}</div>
                                <div class="rel-define-note">${esc(assessment.note || (hasCls || hasTrs ? '관계 수치가 기록되어 있습니다.' : '관계를 정의하기에는 근거가 부족합니다.'))}</div>
                            </div>
                            <span class="bdg ${assessment.inferred === false ? 'bh' : 'bt'}">${assessment.inferred === false ? '정의됨' : '추정'}</span>
                        </div>
                        <div class="ef">
                            <div class="fld"><label>관계 유형</label><input type="text" class="rT-val" data-idx="${i}" value="${escAttr(d.relationType || "")}"></div>
                            <div class="fld"><label>감정 (A→B)</label><input type="text" class="rS-val" data-idx="${i}" value="${escAttr((d.sentiments && d.sentiments.fromAtoB) || "")}"></div>
                        </div>
                        <div class="fld"><label>관계 요약</label><input type="text" class="rState-val" data-idx="${i}" value="${escAttr(currentStatus.summary || '')}"></div>
                        <div class="fld"><label>최근 변화</label><textarea class="ec rChanges-val" data-idx="${i}" rows="3" placeholder="">${esc(formatGuiRelationRecentChanges(dynamics.recentChanges || []))}</textarea></div>
                        <div class="fld"><label>미해결 이슈</label><textarea class="ec rIssues-val" data-idx="${i}" rows="3">${esc(guiLines(dynamics.unresolvedIssues || []))}</textarea></div>
                        <div class="ef">
                            <div class="fld">
                                <div class="rel-score-head"><label>A의 B에 대한 친밀도 ${cls == null ? '판단 보류' : `${cls}%`}</label><div class="rel-score-tools">${cls == null ? '<span class="bdg bt">근거 부족</span>' : ''}<button class="btn bd act-unset-rel-score" data-idx="${i}" data-field="closeness" type="button">미정</button></div></div>
                                <div class="rw"><input type="range" class="rC-val" data-idx="${i}" min="0" max="100" value="${cls ?? 0}" data-unset="${cls == null ? '1' : '0'}"></div>
                            </div>
                            <div class="fld">
                                <div class="rel-score-head"><label>A의 B에 대한 신뢰도 ${trs == null ? '판단 보류' : `${trs}%`}</label><div class="rel-score-tools">${trs == null ? '<span class="bdg bt">근거 부족</span>' : ''}<button class="btn bd act-unset-rel-score" data-idx="${i}" data-field="trust" type="button">미정</button></div></div>
                                <div class="rw"><input type="range" class="rR-val" data-idx="${i}" min="0" max="100" value="${trs ?? 0}" data-unset="${trs == null ? '1' : '0'}"></div>
                            </div>
                        </div>
                    </div>`;
                }).join("");
            }
        };
            applyRelFilter();

        const entViewState = { view: 'list' };
        const renderEnts = () => {
            applyGuiEntityBlocklistToLocalSnapshots();
            const ec = overlay.querySelector("#el");
            const entGraphHost = overlay.querySelector('#el-graph');
            // 그래프 보기 — 목록을 숨기고 그래프만 보인다(메모리·관계 화면과 같은 패턴).
            if (entViewState.view === 'graph') {
                if (ec) ec.classList.add('hide');
                if (entGraphHost) entGraphHost.classList.remove('hide');
                renderEntGraph();
                return;
            }
            if (entGraphHost) entGraphHost.classList.add('hide');
            if (ec) ec.classList.remove('hide');
            if (!_ENT.length) { ec.innerHTML = '<div class="empty">추적된 인물이 없습니다</div>'; }
            else {
                ec.innerHTML = _ENT.map((e, i) => {
                    let d = parseGuiStoredJson(e, 'entity.render', i);
                    if (typeof EntityManager?.normalizeEntityRecord === 'function') d = EntityManager.normalizeEntityRecord(d);
                    const isManualLocked = !!d?.meta?.manualLocked;
                    const identity = d.identity && typeof d.identity === 'object' ? d.identity : {};
                    const profile = d.profile && typeof d.profile === 'object' ? d.profile : {};
                    const profileAppearance = profile.appearance && typeof profile.appearance === 'object' ? profile.appearance : {};
                    const profilePersonality = profile.personality && typeof profile.personality === 'object' ? profile.personality : {};
                    const profileSpeech = profile.speechStyle && typeof profile.speechStyle === 'object' ? profile.speechStyle : {};
                    const profilePsychology = profile.psychology && typeof profile.psychology === 'object' ? profile.psychology : {};
                    const currentState = d.currentState && typeof d.currentState === 'object' ? d.currentState : {};
                    const stateTimeline = formatGuiStateTimelineHtml(d.stateTimeline || d.state_timeline || []);
                    const isNameLocked = !!d?.meta?.nameManualLocked;
                    const feats = guiCsv(guiFirstList(profileAppearance.features, d?.appearance?.features));
                    const traits = guiCsv(guiFirstList(profilePersonality.traits, d?.personality?.traits));
                    const speechNotes = guiCsv(guiFirstList(profileSpeech.notes, d?.speechStyle?.notes));
                    const continuity = d.continuity && typeof d.continuity === 'object' ? d.continuity : {};
                    const backgroundText = formatGuiEntityBackground(d);
                    const affiliationText = guiFirstText(identity.affiliation, identity.school, identity.organization, identity.workplace);
                    const locationText = guiFirstText(currentState.location, d?.status?.currentLocation);
                    const moodText = guiFirstText(guiLines(currentState.emotionalState || []), d?.status?.currentMood);
                    const activityText = guiFirstText(currentState.activity, currentState.currentActivity, currentState.immediateGoal);
                    const psychologyText = guiFirstText(profilePsychology.baseline, profilePsychology.currentConflict, guiLines(profilePsychology.notes || []));
                    const openThreadsText = formatGuiOpenThreadLabels(continuity.openThreads || []);
                    const absorptionMeta = d?.meta?.absorption && typeof d.meta.absorption === 'object' ? d.meta.absorption : null;
                    const absorptionStatus = String(absorptionMeta?.status || '').trim().toLowerCase();
                    const isAbsorptionPending = absorptionStatus === 'pending';
                    const absorptionTarget = String(absorptionMeta?.targetName || '').trim();
                    const absorptionBadge = isAbsorptionPending
                        ? `<span class="bdg bm">흡수 대기 → ${esc(absorptionTarget || '?')}</span>`
                        : (absorptionStatus === 'applied' ? '<span class="bdg bt">흡수 완료</span>' : '');
                    const absorptionButton = isAbsorptionPending
                        ? `<button class="btn bd act-absorb-ent" data-idx="${i}" data-mode="cancel">흡수 취소</button>`
                        : `<button class="btn bs act-absorb-ent" data-idx="${i}" data-mode="mark">흡수 지정</button>`;
                    // 읽기 요약 — 12개 필드를 훑지 않고도 이 인물이 누구인지 보이게 한다.
                    // 편집 필드는 그대로 아래에 전부 유지된다(접지 않는다).
                    const summaryBits = [
                        guiFirstText(identity.roleInStory, '') ? `역할 · ${guiFirstText(identity.roleInStory, '')}` : '',
                        affiliationText ? `소속 · ${affiliationText}` : '',
                        locationText ? `위치 · ${locationText}` : '',
                        moodText ? `감정 · ${moodText}` : '',
                        activityText ? `활동 · ${activityText}` : ''
                    ].filter(Boolean);
                    const threadsCount = Array.isArray(continuity.openThreads) ? continuity.openThreads.length : 0;
                    const summaryTail = [
                        traits ? `특성 ${traits.split(',').filter(Boolean).length}개` : '',
                        threadsCount ? `떡밥 ${threadsCount}개` : '',
                        stateTimeline.count ? `상태 로그 ${stateTimeline.count}턴` : ''
                    ].filter(Boolean);
                    return `<div class="card ent">
                        <div class="card-hdr"><strong><button type="button" class="ent-name-link" data-ent-profile="${i}">${esc(d.name || e.key || "?")}</button></strong>
                            <div class="card-meta">${isManualLocked ? '<span class="bdg bh">수동 보호됨</span>' : '<span class="bdg bt">자동 수정 가능</span>'}${isNameLocked ? '<span class="bdg bm">이름 고정</span>' : ''}${absorptionBadge}</div>
                            <div class="acts"><button class="btn bp act-save-ent" data-idx="${i}">저장</button><button class="btn bs act-rename-ent" data-idx="${i}">이름 변경</button>${absorptionButton}<button class="btn bs act-toggle-lock-ent" data-idx="${i}">${isManualLocked ? '보호 해제' : '보호 설정'}</button><button class="btn bs act-block-ent" data-idx="${i}">차단</button><button class="btn bd act-del-ent" data-idx="${i}">삭제</button></div>
                        </div>
                        ${summaryBits.length || summaryTail.length ? `<div class="entity-summary">${summaryBits.map(x => `<span class="entity-summary-bit">${esc(x)}</span>`).join('')}${summaryTail.map(x => `<span class="bdg bt">${esc(x)}</span>`).join('')}</div>` : ''}
                        <details class="entity-band entity-edit">
                            <summary><span class="entity-band-title">기본 정본 카드</span><span class="bdg bt">편집</span></summary>
                            <div class="entity-grid">
                                <div class="fld entity-wide"><label>서사 역할</label><input type="text" class="eRole-val" data-idx="${i}" value="${escAttr(identity.roleInStory || '')}"></div>
                                <div class="fld"><label>소속</label><input type="text" class="eAffiliation-val" data-idx="${i}" value="${escAttr(affiliationText)}"></div>
                                <div class="fld"><label>현재 위치</label><input type="text" class="eLocation-val" data-idx="${i}" value="${escAttr(locationText)}"></div>
                                <div class="fld"><label>현재 감정</label><input type="text" class="eMood-val" data-idx="${i}" value="${escAttr(moodText)}"></div>
                                <div class="fld"><label>현재 활동</label><input type="text" class="eActivity-val" data-idx="${i}" value="${escAttr(activityText)}"></div>
                                <div class="fld entity-wide"><label>외모 특징</label><input type="text" class="eF-val" data-idx="${i}" value="${escAttr(feats)}"></div>
                                <div class="fld entity-wide"><label>성격 특성</label><input type="text" class="eP-val" data-idx="${i}" value="${escAttr(traits)}"></div>
                                <div class="fld entity-wide"><label>배경</label><textarea class="ec eBg-val" data-idx="${i}" rows="3">${esc(backgroundText)}</textarea></div>
                                <div class="fld entity-wide"><label>상태 요약</label><textarea class="ec eCSummary-val" data-idx="${i}" rows="3">${esc(currentState.summary || '')}</textarea></div>
                                <details class="entity-state-log">
                                    <summary><span class="entity-state-log-title">턴별 상태 로그</span><span class="bdg bt">${stateTimeline.count}개</span></summary>
                                    <div class="entity-state-log-body">${stateTimeline.html}</div>
                                </details>
                                <div class="fld entity-wide"><label>말투 단서</label><input type="text" class="eSpeechNotes-val" data-idx="${i}" value="${escAttr(speechNotes)}"></div>
                                <div class="fld entity-wide"><label>심리</label><input type="text" class="ePsychBase-val" data-idx="${i}" value="${escAttr(psychologyText)}"></div>
                                <div class="fld entity-wide"><label>열린 떡밥</label><textarea class="ec eThreads-val" data-idx="${i}" rows="3">${esc(openThreadsText)}</textarea></div>
                            </div>
                        </details>
                        </div></td></tr>`;
                }).join("");
            }
            renderEntityBlocklist();
            renderRels();


            syncEntityDashboard();
            syncEntityIndex();
            syncEntityDashboard();
            syncSidebarCounts();
        };

        const formatNarrativeRecentEvents = (storyline) => {
            const events = Array.isArray(storyline?.recentEvents) ? storyline.recentEvents : [];
            return events.map(evt => {
                if (evt && typeof evt === 'object') {
                    const turn = evt.turn ?? '?';
                    const brief = String(evt.brief || '').trim();
                    return brief ? `T${turn}: ${brief}` : '';
                }
                return String(evt || '').trim();
            }).filter(Boolean).join("\n");
        };

        const formatNarrativeSummaryHistory = (storyline) => {
            const summaries = Array.isArray(storyline?.summaries) ? storyline.summaries : [];
            return summaries.map((entry, idx) => {
                const turn = entry?.upToTurn ?? '?';
                const summary = String(entry?.summary || '').trim();
                const keyPoints = Array.isArray(entry?.keyPoints) && entry.keyPoints.length > 0
                    ? ` | Key: ${entry.keyPoints.join('; ')}`
                    : '';
                const tensions = Array.isArray(entry?.ongoingTensions) && entry.ongoingTensions.length > 0
                    ? ` | Flow: ${entry.ongoingTensions.join('; ')}`
                    : '';
                return `${idx + 1}. T${turn} | ${summary}${keyPoints}${tensions}`.trim();
            }).filter(Boolean).join("\n");
        };

        const formatNarrativeTurnFlow = (storyline) => {
            const turns = new Set(Array.isArray(storyline?.turns) ? storyline.turns : []);
            const logs = Array.isArray(_NAR?.turnLog) ? _NAR.turnLog : [];
            return logs
                .filter(entry => turns.has(entry.turn))
                .map(entry => `T${entry.turn} | ${String(entry.summary || entry.response || entry.responseBrief || '').trim()}`)
                .filter(line => !/^\s*T\d+\s*\|\s*$/.test(line))
                .join("\n\n");
        };

        const activateNarrativePane = (view = 'storylines') => {
            const allowed = new Set(['storylines', 'author', 'director']);
            const selected = allowed.has(String(view || '')) ? String(view) : 'storylines';
            overlay.querySelectorAll('#tab-narrative [data-narrative-tab]').forEach(button => {
                const active = button.dataset.narrativeTab === selected;
                button.classList.toggle('on', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            overlay.querySelectorAll('#tab-narrative [data-narrative-pane]').forEach(pane => {
                pane.classList.toggle('on', pane.dataset.narrativePane === selected);
            });
        };

        const renderNarrativeOrchestration = () => {
            const snapshot = {
                ...(_NARRATIVE_INSPECTOR || {}),
                storyAuthor: {
                    ...(_NARRATIVE_INSPECTOR?.storyAuthor || {}),
                    state: safeClone(_AUTHOR || {})
                },
                director: {
                    ...(_NARRATIVE_INSPECTOR?.director || {}),
                    state: safeClone(_DIRECTOR || {})
                }
            };
            const authorView = overlay.querySelector('#story-author-view');
            const directorView = overlay.querySelector('#director-view');
            if (authorView) authorView.innerHTML = renderNarrativeInspectorHtml(snapshot, 'author');
            if (directorView) directorView.innerHTML = renderNarrativeInspectorHtml(snapshot, 'director');
        };

        const renderNarrative = () => {
            const list = overlay.querySelector("#narrative-list");
            const counter = overlay.querySelector("#nc");
            const storylines = Array.isArray(_NAR?.storylines) ? _NAR.storylines : [];
            // Planner DBs remain independently visible even when no storyline has
            // been created yet.
            renderNarrativeOrchestration();
            counter.textContent = storylines.length;
            if (!storylines.length) {
                list.innerHTML = '<div class="empty">저장된 내러티브가 없습니다</div>';
                return;
            }

            list.innerHTML = storylines.map((storyline, i) => {
                const entities = Array.isArray(storyline.entities) ? storyline.entities.join(", ") : "";
                const keyPoints = Array.isArray(storyline.keyPoints) ? storyline.keyPoints.join(", ") : "";
                const recentEvents = formatNarrativeRecentEvents(storyline);
                const ongoingFlow = Array.isArray(storyline.ongoingTensions) ? storyline.ongoingTensions.join(", ") : "";
                const summaryHistory = formatNarrativeSummaryHistory(storyline);
                const turnFlow = formatNarrativeTurnFlow(storyline);
                const summary = Array.isArray(storyline.summaries) && storyline.summaries.length > 0
                    ? (storyline.summaries[storyline.summaries.length - 1]?.summary || "")
                    : "";
                const isManualLocked = storyline?.meta?.manualLocked === true;
                return `<div class="card nar">
                    <div class="card-hdr">
                        <strong><button type="button" class="ent-name-link" data-nar-detail="${i}">${esc(storyline.name || `Storyline ${i + 1}`)}</button></strong>
                        <div class="card-meta">${isManualLocked ? '<span class="bdg bh">수동 보호됨</span>' : '<span class="bdg bt">자동 요약 가능</span>'}</div>
                        <div class="acts">
                            <button class="btn bp act-save-nar" data-idx="${i}">저장</button>
                            <button class="btn bs act-toggle-lock-nar" data-idx="${i}">${isManualLocked ? '보호 해제' : '보호 설정'}</button>
                            <button class="btn bd act-del-nar" data-idx="${i}">삭제</button>
                        </div>
                    </div>
                    ${(() => {
                        const bits = [
                            entities ? `인물 · ${String(entities).split(',').filter(Boolean).slice(0, 3).join(', ')}` : '',
                            keyPoints ? `핵심 ${String(keyPoints).split(',').filter(Boolean).length}` : '',
                            ongoingFlow ? `흐름 ${String(ongoingFlow).split(',').filter(Boolean).length}` : ''
                        ].filter(Boolean);
                        return bits.length ? `<div class="entity-summary">${bits.map(x => `<span class="entity-summary-bit">${esc(x)}</span>`).join('')}</div>` : '';
                    })()}
                    <details class="card-detail"><summary>기록 편집</summary>
                    <div class="fld"><label>이름</label><input type="text" class="nN-val" data-idx="${i}" value="${escAttr(storyline.name || '')}"></div>
                    <div class="fld"><label>등장 인물 (쉼표 구분)</label><input type="text" class="nE-val" data-idx="${i}" value="${escAttr(entities)}"></div>
                    <div class="fld"><label>현재 맥락</label><textarea class="ec nC-val" data-idx="${i}" rows="3">${esc(storyline.currentContext || '')}</textarea></div>
                    <div class="fld"><label>핵심 포인트 (쉼표 구분)</label><textarea class="ec nK-val" data-idx="${i}" rows="3">${esc(keyPoints)}</textarea></div>
                    <div class="fld"><label>진행 중 흐름 (쉼표 구분)</label><textarea class="ec nO-val" data-idx="${i}" rows="3">${esc(ongoingFlow)}</textarea></div>
                    <div class="fld"><label>최근 이벤트 (줄바꿈 구분)</label><textarea class="ec nR-val" data-idx="${i}" rows="4">${esc(recentEvents)}</textarea></div>
                    <div class="fld"><label>최근 요약</label><textarea class="ec nS-val" data-idx="${i}" rows="3">${esc(summary)}</textarea></div>
                    <div class="fld"><label>요약 이력 (읽기 전용)</label><textarea class="ec" rows="6" readonly>${esc(summaryHistory)}</textarea></div>
                    <div class="fld"><label>턴별 서사 흐름 (읽기 전용)</label><textarea class="ec" rows="8" readonly>${esc(turnFlow)}</textarea></div>
                    </details>
                </div>`;
            }).join("");
            syncNarrativeKpi();
            syncSidebarCounts();
        };

        const getActiveWorldNodeSnapshot = () => {
            if (!_WLD || !Array.isArray(_WLD.nodes) || _WLD.nodes.length === 0) return null;
            const activePath = Array.isArray(_WLD.activePath) ? _WLD.activePath : [];
            const targetId = activePath[activePath.length - 1] || _WLD.rootId || (_WLD.nodes[0] && _WLD.nodes[0][0]);
            const index = _WLD.nodes.findIndex(entry => entry && entry[0] === targetId);
            if (index < 0) return null;
            const entry = _WLD.nodes[index];
            return { targetId, index, entry, node: entry?.[1] && typeof entry[1] === 'object' ? entry[1] : {} };
        };
        const worldListToTextarea = (value, limit = 48) => normalizeWorldCanonTextList(value, limit).join('\n');
        const worldTextareaToList = (selector, limit = 48) => normalizeWorldCanonTextList(String(overlay.querySelector(selector)?.value || '').split('\n'), limit);
        const worldBooleanToSelectValue = (value) => value === true ? 'true' : (value === false ? 'false' : '');
        const setWorldSelectValue = (selector, value) => {
            const el = overlay.querySelector(selector);
            if (el) el.value = worldBooleanToSelectValue(value);
        };
        const applyWorldSelectValue = (target, key, selector) => {
            const value = String(overlay.querySelector(selector)?.value || '').trim();
            if (value === 'true') target[key] = true;
            else if (value === 'false') target[key] = false;
            else delete target[key];
        };
        const getWorldCustomRuleLines = (custom = {}) => Object.values(normalizeWorldCustomRules(custom))
            .flatMap(value => normalizeWorldCanonTextList(value, 24));
        const buildGuiWorldCustomRules = (lines = []) => {
            const rules = {};
            normalizeWorldCanonTextList(lines, 48).forEach((line, index) => { rules[`rule_${index + 1}`] = line; });
            return rules;
        };
        const renderWorldFields = (currentNode = null, effectiveRules = null) => {
            const node = currentNode || {};
            const rules = effectiveRules || node.rules || {};
            const meta = node.meta || {};
            const metadata = meta.worldMetadata && typeof meta.worldMetadata === 'object' ? meta.worldMetadata : {};
            const exists = rules.exists || {};
            const systems = rules.systems || {};
            const setting = normalizeWorldSettingRules(rules.setting);
            const physics = rules.physics || {};
            const customLines = getWorldCustomRuleLines(rules.custom || {});
            const classifiedCustom = classifyWorldCanonStatements(customLines);
            const displaySetting = normalizeWorldSettingRules({
                places: [setting.places, classifiedCustom.places],
                organizations: [setting.organizations, classifiedCustom.organizations],
                socialRules: [setting.socialRules, classifiedCustom.socialRules]
            });
            const displayPhenomena = normalizeWorldCanonTextList([physics.special_phenomena || [], classifiedCustom.phenomena], 24);
            const setValue = (selector, value) => {
                const el = overlay.querySelector(selector);
                if (el) el.value = String(value || '');
            };
            setValue('#world-node-name', node.name || '');
            setValue('#world-classification', meta.classification || metadata.classification || '');
            setValue('#world-summary', meta.worldSummary || metadata.summary || metadata.description || '');
            setValue('#world-tech', exists.technology || metadata.tech || '');
            setWorldSelectValue('#world-magic', exists.magic);
            setWorldSelectValue('#world-ki', exists.ki);
            setWorldSelectValue('#world-supernatural', exists.supernatural);
            for (const key of ['leveling', 'skills', 'stats', 'classes', 'guilds', 'factions']) {
                setWorldSelectValue(`#world-system-${key}`, systems[key]);
            }
            setValue('#world-gravity', physics.gravity || '');
            setValue('#world-time-flow', physics.time_flow || physics.timeFlow || '');
            setValue('#world-space', physics.space || '');
            setValue('#world-places', displaySetting.places.join('\n'));
            setValue('#world-organizations', displaySetting.organizations.join('\n'));
            setValue('#world-social-rules', displaySetting.socialRules.join('\n'));
            setValue('#world-mythical', worldListToTextarea(exists.mythical_creatures || [], 24));
            setValue('#world-races', worldListToTextarea(exists.non_human_races || [], 24));
            setValue('#world-phenomena', worldListToTextarea(displayPhenomena, 24));
            setValue('#world-custom-rules', classifiedCustom.custom.join('\n'));
        };
        const renderWorldStateLog = () => {
            const box = overlay.querySelector('#world-state-log');
            if (!box) return;
            const state = WorldStateTracker.getState?.() || { turnLog: [], consolidated: [] };
            const logs = Array.isArray(state.turnLog) ? state.turnLog.slice(-8) : [];
            if (logs.length === 0) {
                box.innerHTML = '<div class="empty">현재 세계 상태 로그가 없습니다</div>';
                return;
            }
            box.innerHTML = logs.map(entry => {
                const parts = [];
                if (entry.turn) parts.push(`T${entry.turn}`);
                if (entry.currentTime) parts.push(`시간: ${entry.currentTime}`);
                if (entry.currentLocation) parts.push(`위치: ${entry.currentLocation}`);
                if (entry.currentScene) parts.push(`장면: ${entry.currentScene}`);
                if (Array.isArray(entry.activeEvents) && entry.activeEvents.length > 0) parts.push(`진행: ${entry.activeEvents.slice(0, 3).join(', ')}`);
                if (Array.isArray(entry.offscreenThreads) && entry.offscreenThreads.length > 0) parts.push(`오프스크린: ${entry.offscreenThreads.slice(0, 3).join(', ')}`);
                if (Array.isArray(entry.ruleHighlights) && entry.ruleHighlights.length > 0) parts.push(`규칙: ${entry.ruleHighlights.slice(0, 3).join(', ')}`);
                return `<div style="margin-bottom:8px;white-space:pre-wrap;word-break:break-word">${esc(parts.join('\n'))}</div>`;
            }).join('');
        };
        const saveWorldFieldsFromGui = async () => {
            const snapshot = getActiveWorldNodeSnapshot();
            if (!snapshot) throw new Error('현재 세계 노드를 찾을 수 없습니다.');
            const node = safeClone(snapshot.node || {});
            node.name = String(overlay.querySelector('#world-node-name')?.value || node.name || '주요 세계').trim() || '주요 세계';
            node.rules = node.rules && typeof node.rules === 'object' ? safeClone(node.rules) : {};
            node.meta = node.meta && typeof node.meta === 'object' ? safeClone(node.meta) : {};
            node.meta.worldMetadata = node.meta.worldMetadata && typeof node.meta.worldMetadata === 'object' ? safeClone(node.meta.worldMetadata) : {};

            const rules = node.rules;
            rules.exists = rules.exists && typeof rules.exists === 'object' ? rules.exists : {};
            rules.systems = rules.systems && typeof rules.systems === 'object' ? rules.systems : {};
            rules.physics = rules.physics && typeof rules.physics === 'object' ? rules.physics : {};

            const classification = String(overlay.querySelector('#world-classification')?.value || '').trim();
            const summary = String(overlay.querySelector('#world-summary')?.value || '').trim();
            const tech = String(overlay.querySelector('#world-tech')?.value || '').trim();
            node.meta.classification = classification;
            node.meta.worldSummary = summary;
            node.meta.worldMetadata = {
                ...node.meta.worldMetadata,
                classification,
                summary,
                description: summary,
                tech
            };
            if (tech) rules.exists.technology = tech;
            else delete rules.exists.technology;

            applyWorldSelectValue(rules.exists, 'magic', '#world-magic');
            applyWorldSelectValue(rules.exists, 'ki', '#world-ki');
            applyWorldSelectValue(rules.exists, 'supernatural', '#world-supernatural');
            rules.exists.mythical_creatures = worldTextareaToList('#world-mythical', 24);
            rules.exists.non_human_races = worldTextareaToList('#world-races', 24);

            for (const key of ['leveling', 'skills', 'stats', 'classes', 'guilds', 'factions']) {
                applyWorldSelectValue(rules.systems, key, `#world-system-${key}`);
            }
            rules.setting = normalizeWorldSettingRules({
                places: worldTextareaToList('#world-places', 32),
                organizations: worldTextareaToList('#world-organizations', 32),
                socialRules: worldTextareaToList('#world-social-rules', 48)
            });
            rules.physics.gravity = String(overlay.querySelector('#world-gravity')?.value || '').trim() || 'normal';
            rules.physics.time_flow = String(overlay.querySelector('#world-time-flow')?.value || '').trim() || 'linear';
            rules.physics.space = String(overlay.querySelector('#world-space')?.value || '').trim() || 'three_dimensional';
            rules.physics.special_phenomena = worldTextareaToList('#world-phenomena', 24);
            rules.custom = buildGuiWorldCustomRules(worldTextareaToList('#world-custom-rules', 48));
            const guiRuleEvidence = [
                rules.exists.magic === true ? 'magic present' : '',
                rules.exists.magic === false ? 'no magic' : '',
                rules.exists.ki === true ? 'ki present' : '',
                rules.exists.ki === false ? 'no ki' : '',
                rules.exists.supernatural === true ? 'supernatural present' : '',
                rules.exists.supernatural === false ? 'no supernatural' : '',
                ...['leveling', 'skills', 'stats', 'classes'].flatMap(key => [
                    rules.systems[key] === true ? `${key} system present` : '',
                    rules.systems[key] === false ? `no ${key} system` : ''
                ])
            ].filter(Boolean);
            node.rules = sanitizeWorldRuleUpdateForPolicy(rules, [classification, summary, collectWorldRuleEvidenceText(rules), ...guiRuleEvidence].filter(Boolean).join('\n'));
            node.meta.updated = Date.now();

            _WLD.nodes[snapshot.index] = [snapshot.entry[0], node];
            const liveProfile = HierarchicalWorldManager.getProfile?.();
            if (liveProfile?.nodes instanceof Map && liveProfile.nodes.has(snapshot.targetId)) {
                liveProfile.nodes.set(snapshot.targetId, safeClone(node));
                if (liveProfile.global && _WLD.global) liveProfile.global = { ..._WLD.global };
            }
            syncWorldSnapshotFromRuntime();
            await persistWorldGraphFromGui('💾 세계관 필드 저장 완료', true);
            return true;
        };

        const renderWorld = () => {
            const tc = overlay.querySelector("#wt");
            const rc = overlay.querySelector("#wr");
            const userCorrectionBox = overlay.querySelector("#world-user-correction");
            const lensMeta = overlay.querySelector("#world-lens-meta");
            const lensPrompt = overlay.querySelector("#world-lens-prompt");
            const codexStatus = overlay.querySelector("#world-codex-status");
            if (!_WLD || !_WLD.nodes || !_WLD.nodes.length) {
                tc.innerHTML = '<div class="empty">세계관 데이터가 없습니다</div>';
                if (rc) rc.innerHTML = '<span style="color:var(--text2)">규칙 없음</span>';
                const emptyGlobalFeatures = overlay.querySelector('#world-global-features');
                if (emptyGlobalFeatures) emptyGlobalFeatures.innerHTML = '<span style="color:var(--text2)">전역 세계 특성 없음</span>';
                if (userCorrectionBox) userCorrectionBox.value = '';
                if (lensMeta) lensMeta.innerHTML = '<span style="color:var(--text2)">아직 생성된 장면용 세계관 보정이 없습니다</span>';
                if (lensPrompt) {
                    lensPrompt.value = '';
                    lensPrompt.placeholder = '아직 생성된 장면용 세계관 보정이 없습니다.';
                }
                if (codexStatus) codexStatus.innerHTML = '<span style="color:var(--text2)">세계관 코덱스 데이터가 없습니다</span>';
                renderWorldFields(null, null);
                renderWorldStateLog();
                return;
            }
            const ap = _WLD.activePath || [];
            // 멀티노드: 활성 기준은 activeNodes 다(activePath 는 주 초점) — 상세·KPI·카드와 같은 규칙.
            const apActive = Array.isArray(_WLD.activeNodes) && _WLD.activeNodes.length > 0
                ? _WLD.activeNodes.map(String) : ap;
            
            const rn = (id, depth, visited) => {
                if (depth > 50 || visited.has(id)) return "";
                visited.add(id);
                let entry = null;
                for (let j = 0; j < _WLD.nodes.length; j++) { if (_WLD.nodes[j][0] === id) { entry = _WLD.nodes[j][1]; break; } }
                if (!entry) return "";
                const active = apActive.indexOf(id) >= 0;
                const ind = depth * 14;
                let h = `<div class="wn${active ? " cur" : ""}" style="padding-left:${10 + ind}px">
                    ${depth > 0 ? "└ " : ""}<span class="wn-name">${esc(entry.name)}</span>
                    <span class="wn-layer">[${esc(entry.layer || "dim")}]</span>
                    ${active ? '<span class="bdg bh" style="margin-left:4px">현재</span>' : ''}</div>`;
                const ch = entry.children || [];
                for (let k = 0; k < ch.length; k++) h += rn(ch[k], depth + 1, visited);
                return h;
            };
            tc.innerHTML = _WLD.rootId ? rn(_WLD.rootId, 0, new Set()) : _WLD.nodes.map(n => `<div class="wn"><span class="wn-name">${esc((n[1] || {}).name || "?")}</span></div>`).join("");
            // 목업의 노드 목록 — 트리와 같은 데이터를 카드 목록으로도 보여준다.
            const wldHost = overlay.querySelector("#wld-list");
            if (wldHost) {
                const ap = Array.isArray(_WLD.activePath) ? _WLD.activePath.map(String) : [];
                // 멀티노드: activeNodes 가 활성 기준이다(activePath 는 주 초점) — 상세·KPI 와 같은 규칙.
                const apActive = Array.isArray(_WLD.activeNodes) && _WLD.activeNodes.length > 0
                    ? _WLD.activeNodes.map(String) : ap;
                const cards = _WLD.nodes.map(([id, node]) => {
                    const n = node && typeof node === 'object' ? node : {};
                    const isActive = apActive.includes(String(id));
                    // 정본은 node.rules / node.meta 다 (node.fields·classification·summary 는 정본에 없는 평면 필드였다 \u2014
                    // 상세 화면과 같은 부류의 결함).
                    const nMeta = n.meta && typeof n.meta === 'object' ? n.meta : {};
                    const ruleList = extractWorldRuleHighlights(n.rules && typeof n.rules === 'object' ? n.rules : {}, 24);
                    const ruleCount = ruleList.length;
                    const preview = ruleList.slice(0, 3).map(v => esc(String(v))).join(" · ");
                    return `<div class="card wld-node-card" data-wld-node="${escAttr(String(id))}" data-wld-active="${isActive ? '1' : '0'}">
                        <div class="card-hdr"><strong><button type="button" class="ent-name-link" data-wld-detail="${escAttr(String(id))}">${esc(n.name || id || "?")}</button></strong>
                            <div class="card-meta">${isActive ? '<span class="bdg bt">활성</span>' : '<span class="bdg bh">이력</span>'}${nMeta.classification ? `<span class="chip">${esc(nMeta.classification)}</span>` : ''}<span class="chip">규칙 ${ruleCount}</span></div>
                        </div>
                        ${(nMeta.worldSummary || preview) ? `<div class="entity-summary">${nMeta.worldSummary ? `<span class="entity-summary-bit">${esc(String(nMeta.worldSummary).slice(0, 140))}</span>` : ''}${preview ? `<span class="entity-summary-bit">${preview}</span>` : ''}</div>` : ''}
                    </div>`;
                }).join("");
                wldHost.innerHTML = cards || '<div class="empty">세계 노드가 없습니다</div>';
            }
            
            const g = _WLD.global || {};
            const featureBox = overlay.querySelector("#world-global-features");
            const activeFeatures = [
                g.multiverse ? '멀티버스' : '',
                g.dimensionTravel ? '차원 이동' : '',
                g.timeTravel ? '시간 여행' : '',
                g.metaNarrative ? '메타 서술' : '',
                g.virtualReality ? '가상현실' : '',
                g.dreamWorld ? '꿈 세계' : '',
                g.reincarnationPossession ? '회귀·환생·빙의' : '',
                g.systemInterface ? '시스템 인터페이스' : ''
            ].filter(Boolean);
            featureBox.innerHTML = activeFeatures.length > 0
                ? `<div>${esc(activeFeatures.join(', '))}</div>`
                : '<div class="empty">감지된 전역 세계 특성이 없습니다</div>';
            
            const lid = ap[ap.length - 1];
            let currentNode = null;
            if (lid) {
                for (let i = 0; i < _WLD.nodes.length; i++) {
                    if (_WLD.nodes[i][0] === lid) {
                        currentNode = _WLD.nodes[i][1];
                        break;
                    }
                }
            }
            const effectiveRules = lid ? sanitizeWorldRuleUpdateForPolicy(HierarchicalWorldManager.getEffectiveRules(lid), collectWorldRuleEvidenceText(HierarchicalWorldManager.getEffectiveRules(lid))) : null;
            renderWorldFields(currentNode, effectiveRules || currentNode?.rules || null);
            renderWorldStateLog();
            if (effectiveRules) {
                const nodeMeta = currentNode?.meta || {};
                const worldSummaryLines = [];
                if (nodeMeta.classification) worldSummaryLines.push(`분류: ${String(nodeMeta.classification)}`);
                if (nodeMeta.worldSummary) worldSummaryLines.push(String(nodeMeta.worldSummary));
                if (nodeMeta.worldMetadata?.description) worldSummaryLines.push(`설명: ${String(nodeMeta.worldMetadata.description)}`);
                if (nodeMeta.worldMetadata?.tech) worldSummaryLines.push(`기술 메모: ${String(nodeMeta.worldMetadata.tech)}`);
                const manualCorrection = String(nodeMeta.userWorldCorrection || nodeMeta.worldMetadata?.userWorldCorrection || '').trim();
                if (userCorrectionBox) userCorrectionBox.value = manualCorrection;
                const ex = effectiveRules.exists || {};
                const sys = effectiveRules.systems || {};
                const physics = effectiveRules.physics || {};
                const custom = Array.isArray(effectiveRules.custom)
                    ? effectiveRules.custom.map(v => String(v || '').trim()).filter(Boolean)
                    : (effectiveRules.custom && typeof effectiveRules.custom === 'object')
                        ? Object.entries(effectiveRules.custom)
                            .flatMap(([key, value]) => splitImportedWorldRuleFragments(String(value || '')).map(fragment => {
                                if (!fragment || isDiscardableWorldCanonFragment(fragment)) return '';
                                return /^rule_\d+$/i.test(String(key || '').trim()) ? fragment : `${key}: ${fragment}`;
                            }))
                            .filter(Boolean)
                        : [];
                const lines = [];
                if (worldSummaryLines.length > 0) {
                    lines.push(...worldSummaryLines);
                    lines.push('---');
                }
                const existingElements = [];
                if (shouldEmitWorldPresentRule(effectiveRules, 'magic')) existingElements.push("마법");
                if (shouldEmitWorldPresentRule(effectiveRules, 'ki')) existingElements.push("기(氣)");
                if (shouldEmitWorldPresentRule(effectiveRules, 'supernatural')) existingElements.push("초자연");
                if (Array.isArray(ex.mythical_creatures) && ex.mythical_creatures.length > 0) existingElements.push(...ex.mythical_creatures);
                if (Array.isArray(ex.non_human_races) && ex.non_human_races.length > 0) existingElements.push(...ex.non_human_races);
                if (existingElements.length > 0) lines.push(existingElements.join(', '));
                const absentElements = [];
                if (shouldEmitWorldAbsentRule(effectiveRules, 'magic')) absentElements.push("마법 없음");
                if (shouldEmitWorldAbsentRule(effectiveRules, 'ki')) absentElements.push("기 없음");
                if (shouldEmitWorldAbsentRule(effectiveRules, 'supernatural')) absentElements.push("초자연 없음");
                if (absentElements.length > 0) lines.push(`부재: ${absentElements.join(', ')}`);

                const activeSystems = [];
                if (sys.leveling) activeSystems.push("레벨링");
                if (sys.skills) activeSystems.push("스킬");
                if (sys.stats) activeSystems.push("스탯");
                if (sys.classes) activeSystems.push("직업");
                if (sys.guilds) activeSystems.push("길드");
                if (sys.factions) activeSystems.push("세력");
                if (activeSystems.length > 0) lines.push(activeSystems.join(', '));
                const inactiveSystems = [];
                if (shouldEmitWorldInactiveSystem(effectiveRules, 'leveling')) inactiveSystems.push("레벨");
                if (shouldEmitWorldInactiveSystem(effectiveRules, 'skills')) inactiveSystems.push("스킬");
                if (shouldEmitWorldInactiveSystem(effectiveRules, 'stats')) inactiveSystems.push("스탯");
                if (shouldEmitWorldInactiveSystem(effectiveRules, 'classes')) inactiveSystems.push("직업");
                if (inactiveSystems.length > 0) lines.push(`비활성 시스템: ${inactiveSystems.join(', ')}`);

                if (ex.technology) lines.push(`기술: ${String(ex.technology)}`);
                const setting = normalizeWorldSettingRules(effectiveRules.setting);
                if (setting.places.length > 0) lines.push(`장소·시설: ${setting.places.join(', ')}`);
                if (setting.organizations.length > 0) lines.push(`조직: ${setting.organizations.join(', ')}`);
                if (setting.socialRules.length > 0) lines.push(`사회·문화 규칙:\n${setting.socialRules.map(rule => `- ${rule}`).join('\n')}`);
                if (physics.gravity && !isDefaultWorldGravity(physics.gravity)) lines.push(`중력: ${String(physics.gravity)}`);
                if ((physics.time_flow || physics.timeFlow) && !isDefaultWorldTimeFlow(physics.time_flow || physics.timeFlow)) lines.push(`시간 흐름: ${String(physics.time_flow || physics.timeFlow)}`);
                if (physics.space && !isDefaultWorldSpace(physics.space)) lines.push(`공간: ${String(physics.space)}`);
                if (physics.dimensionStability) lines.push(String(physics.dimensionStability));
                if (Array.isArray(physics.special_phenomena) && physics.special_phenomena.length > 0) {
                    const phenomena = physics.special_phenomena
                        .flatMap(v => splitImportedWorldRuleFragments(v))
                        .filter(fragment => fragment && !isDiscardableWorldCanonFragment(fragment));
                    if (phenomena.length > 0) lines.push(dedupeTextArray(phenomena).join(', '));
                }
                if (custom.length > 0) lines.push(custom.join('\n'));

                rc.innerHTML = lines.length
                    ? `<div style="white-space:pre-wrap;word-break:break-word;line-height:1.55">${esc(lines.join('\n'))}</div>`
                    : '<span style="color:var(--text2)">규칙 없음</span>';
            } else {
                rc.innerHTML = '<span style="color:var(--text2)">규칙 없음</span>';
                if (userCorrectionBox) userCorrectionBox.value = '';
            }
            const sectionWorldMeta = SectionWorldInferenceManager.getLastMeta();
            const sectionWorldPrompt = SectionWorldInferenceManager.getLastPrompt();
            if (lensMeta) {
                const chips = [];
                if (sectionWorldMeta.title) chips.push(`<span class="bdg bt" style="display:inline-block;margin:2px">${esc(sectionWorldMeta.title)}</span>`);
                if (Array.isArray(sectionWorldMeta.activeRules)) {
                    sectionWorldMeta.activeRules.slice(0, 4).forEach(rule => chips.push(`<span class="bdg bt" style="display:inline-block;margin:2px">${esc(rule)}</span>`));
                }
                if (Array.isArray(sectionWorldMeta.scenePressures)) {
                    sectionWorldMeta.scenePressures.slice(0, 3).forEach(item => chips.push(`<span class="bdg bt" style="display:inline-block;margin:2px">${esc(item)}</span>`));
                }
                if (Array.isArray(sectionWorldMeta.sourceRefs) && sectionWorldMeta.sourceRefs.length > 0) {
                    chips.push(`<span class="bdg bh" style="display:inline-block;margin:2px">근거: ${esc(sectionWorldMeta.sourceRefs.slice(0, 5).join(', '))}</span>`);
                }
                lensMeta.innerHTML = chips.length > 0
                    ? chips.join("")
                    : '<span style="color:var(--text2)">아직 생성된 장면용 세계관 보정이 없습니다</span>';
            }
            if (lensPrompt) {
                lensPrompt.value = sectionWorldPrompt || '';
                lensPrompt.placeholder = sectionWorldPrompt
                    ? ''
                    : '아직 생성된 장면용 세계관 보정이 없습니다.';
            }
            if (codexStatus) {
                const nodeCount = Array.isArray(_WLD.nodes) ? _WLD.nodes.length : 0;
                const activeNames = (Array.isArray(ap) ? ap : []).map(id => {
                    const found = (_WLD.nodes || []).find(item => item && item[0] === id);
                    return found?.[1]?.name || id;
                }).filter(Boolean);
                const currentClassification = currentNode?.meta?.classification || currentNode?.meta?.worldMetadata?.classification || '';
                const promptTokens = TokenizerEngine.estimateTokens(HierarchicalWorldManager.formatForPrompt() || '', 'simple');
                const sourceBundle = buildCharacterWorldSourceBundle(char, chat, 3000);
                codexStatus.innerHTML = [
                    `<div>노드 수: <b>${nodeCount}</b> / 활성 경로: ${esc(activeNames.join(' › ') || '없음')}</div>`,
                    currentClassification ? `<div>분류: ${esc(String(currentClassification))}</div>` : '',
                    `<div>캐릭터 세계관 소스: <b>${sourceBundle.count}</b>개 참고 가능</div>`,
                    `<div>주입 토큰 추정: 약 ${promptTokens} tokens / 장면 보정: ${_CFG?.sectionWorldInferenceEnabled !== false ? '사용' : '꺼짐'}</div>`,
                    '<div style="color:var(--text2);margin-top:4px">세계관 코덱스는 저장된 LIBRA world graph를 요약해 주입합니다. 재분석과 장면 보정은 캐릭터 설명과 캐릭터 로어북도 세계관 정의 근거로 함께 참고합니다.</div>'
                ].filter(Boolean).join('');
            }
            syncWorldKpi();
            syncSidebarCounts();
        };
        const worldAdditionalTypeLabel = (type = '') => ({
            scene_intervention: '장면 개입',
            world_delta: '세계 추가',
            character_addition: '인물 추가'
        }[String(type || '').trim()] || '추가 지시');
        // 상태 라벨. '주입됨'은 "프롬프트에는 들어갔지만 아직 작품에 쓰이지 않음"을
        // 뜻하는데, 종전 라벨('주입됨')만으로는 사용자가 그 구분을 알 수 없어
        // 요소가 왜 안 나오는지 판단할 수 없었다.
        const worldAdditionalStatusLabel = (status = '') => ({
            prepared: '준비',
            armed: '대기',
            injected: '주입됨·미활용',
            manifested: '발현',
            integrated: '통합',
            retired: '종료',
            blocked: '차단'
        }[String(status || '').trim()] || String(status || 'unknown'));
        const getWorldAdditionalDisplayState = () => {
            const scopeKey = getChatRuntimeScopeKey(chat, char);
            const chatId = String(chat?.id || getActiveManagedChatId?.() || '').trim();
            const managedLore = LibraLoreConsolidator.unpack(effectiveGuiLore || lore || []);
            const entry = managedLore.find(item => item?.comment === 'lmai_world_additional');
            const userDlcEntry = managedLore.find(item => item?.comment === 'lmai_user_dlc');
            try {
                if (entry) WorldAdditionalCore.loadState?.(managedLore, { scopeKey, chatId });
                UserDlcCore.loadState?.(managedLore, { scopeKey, chatId });
            } catch (error) {
                recordSuppressedRuntimeError('gui.world_additional.load_state', error, { scopeKey, chatId });
            }
            const state = safeClone(WorldAdditionalCore.getState?.() || {});
            const allDirectives = [
                ...(Array.isArray(state.sceneInterventions) ? state.sceneInterventions : []),
                ...(Array.isArray(state.worldDeltas) ? state.worldDeltas : []),
                ...(Array.isArray(state.characterAdditions) ? state.characterAdditions : [])
            ];
            const userDlcState = safeClone(UserDlcCore.getState?.() || {});
            return { state, allDirectives, entry, userDlcEntry, userDlcState, scopeKey, chatId };
        };
        const getWorldAdditionalCandidateCount = (state = {}, allDirectives = []) => {
            const activeStatuses = new Set(['prepared', 'armed', 'injected']);
            const activeDirectives = [
                ...(Array.isArray(state.activeDirectives) ? state.activeDirectives : []),
                ...allDirectives.filter(item => activeStatuses.has(String(item?.status || '').trim()))
            ].filter(item => item && item.injectionDisabled !== true);
            const seen = new Set();
            return activeDirectives.filter(item => {
                const key = String(item?.id || item?.title || item?.name || JSON.stringify(item || {}));
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).length;
        };
        const updateWorldAdditionalCandidateLabel = (count = 0) => {
            const label = overlay.querySelector('#swamax-current-candidates');
            if (label) label.textContent = `(현재 후보 수 : ${Math.max(0, Number(count) || 0)})`;
        };
        const isWorldAdditionalInjectionOn = (kind = 'directive', item = {}, config = _CFG || MemoryEngine.CONFIG || {}) => {
            if (item?.injectionDisabled === true) return false;
            if (item?.manualInjection === true) return true;
            if (kind === 'directive') return false;
            return true;
        };
        const renderWorldAdditionalInjectionButton = (kind = 'directive', item = {}, config = _CFG || MemoryEngine.CONFIG || {}) => {
            const conflictBlocked = String(kind || '').startsWith('dlc-') && String(item?.canonCompatibility?.status || '').toLowerCase() === 'conflicted';
            const on = !conflictBlocked && isWorldAdditionalInjectionOn(kind, item, config);
            const automaticCandidate = kind === 'directive' && !conflictBlocked && item?.injectionDisabled !== true && item?.manualInjection !== true && !['retired', 'blocked'].includes(String(item?.status || '').toLowerCase());
            const title = conflictBlocked
                ? 'LIBRA DB와 해결되지 않은 충돌이 있어 투입할 수 없습니다. 다시 분석해 적응형 결과를 만드세요.'
                : (on ? '이 요소는 다음 요청 프롬프트에 반드시 투입됩니다.' : (automaticCandidate ? '자동 투입 후보입니다. 누르면 최대 자동 투입 수와 무관하게 다음 요청에 반드시 투입됩니다.' : '눌러서 이 요소를 다음 요청 프롬프트에 반드시 투입합니다.'));
            const label = String(kind || '').startsWith('dlc-') ? '사용' : '투입';
            const buttonLabel = conflictBlocked ? '충돌 차단' : (on && kind === 'directive' ? '투입 ON' : (automaticCandidate ? '자동 후보' : label));
            return `<button class="btn wa-inject-toggle${on ? ' is-on' : ''}${automaticCandidate ? ' is-auto' : ''}${conflictBlocked ? ' is-blocked' : ''}" type="button" aria-pressed="${on ? 'true' : 'false'}" title="${escAttr(title)}" data-wa-inject-kind="${escAttr(kind)}" data-wa-inject-id="${escAttr(item?.id || '')}" data-wa-inject-enabled="${on ? 'true' : 'false'}"${conflictBlocked ? ' disabled' : ''}>${buttonLabel}</button>`;
        };
        const renderWorldAdditionalDirectiveCard = (directive = {}, options = {}) => {
            const status = String(directive.status || 'prepared').trim();
            const type = String(directive.type || '').trim();
            const title = directive.title || directive.name || 'Untitled';
            const badges = [
                `<span class="bdg bm">${esc(worldAdditionalTypeLabel(type))}</span>`,
                `<span class="bdg bt">${esc(worldAdditionalStatusLabel(status))}</span>`,
                directive.forceLevel ? `<span class="bdg bt">force:${esc(directive.forceLevel)}</span>` : '',
                directive.userImpact ? `<span class="bdg bt">impact:${esc(directive.userImpact)}</span>` : '',
                directive.progressionTier ? `<span class="bdg bt">tier:${esc(directive.progressionTier)}</span>` : ''
            ].filter(Boolean).join('');
            const lines = [
                directive.name && directive.name !== title ? `이름: ${directive.name}` : '',
                directive.role ? `역할: ${directive.role}` : '',
                directive.description ? `추가 내용: ${directive.description}` : '',
                directive.directive ? `적용 지시: ${directive.directive}` : '',
                directive.activationCondition ? `발동 조건: ${directive.activationCondition}` : '',
                Array.isArray(directive.sourceBasis) && directive.sourceBasis.length ? `근거: ${directive.sourceBasis.slice(0, 4).join(' / ')}` : '',
                Array.isArray(directive.relatedEntities) && directive.relatedEntities.length ? `연결 인물: ${directive.relatedEntities.slice(0, 5).join(', ')}` : ''
            ].filter(Boolean);
            const turns = [
                directive.createdTurn ? `생성 T${directive.createdTurn}` : '',
                directive.injectedTurn ? `주입 T${directive.injectedTurn}` : '',
                directive.manifestedTurn ? `발현 T${directive.manifestedTurn}` : '',
                directive.integratedTurn ? `통합 T${directive.integratedTurn}` : ''
            ].filter(Boolean).join(' · ');
            return `<div class="card ${options.active ? 'nar' : 'mem'}">
                <div class="card-hdr">
                  <div>
                    <div class="card-meta">${badges}</div>
                    <div class="card-title">${esc(title)}</div>
                  </div>
                  <div class="acts"><span class="bdg bl">${esc(directive.id || '')}</span>${renderWorldAdditionalInjectionButton('directive', directive)}<button class="btn bs" type="button" data-wa-edit-kind="directive" data-wa-edit-id="${escAttr(directive.id || '')}">편집</button><button class="btn bd" type="button" data-wa-delete-kind="directive" data-wa-delete-id="${escAttr(directive.id || '')}" data-wa-delete-label="${escAttr(title)}">삭제</button></div>
                </div>
                ${lines.length ? `<div style="white-space:pre-wrap;word-break:break-word;color:var(--text2);font-size:var(--fs-label);line-height:1.55">${esc(lines.join('\n'))}</div>` : '<div class="hint">세부 지시가 비어 있습니다.</div>'}
                ${turns ? `<div class="hint" style="margin-top:7px">${esc(turns)}</div>` : ''}
              </div>`;
        };
        const renderWorldAdditionalLogCard = (item = {}) => {
            const at = Number(item.at || 0) ? new Date(Number(item.at)).toLocaleString() : '';
            return `<div class="card nar">
                <div class="card-hdr">
                  <div><div class="card-meta"><span class="bdg bm">${esc(worldAdditionalStatusLabel(item.status))}</span>${item.turn ? `<span class="bdg bt">T${esc(item.turn)}</span>` : ''}</div><div class="card-title">${esc(item.title || item.id || '월드 에디셔널 기록')}</div></div>
                  <div class="acts"><span class="bdg bl">${esc(item.id || '')}</span></div>
                </div>
                ${item.note ? `<div style="white-space:pre-wrap;word-break:break-word;color:var(--text2);font-size:var(--fs-label);line-height:1.55">${esc(item.note)}</div>` : '<div class="hint">추가 기록 내용이 없습니다.</div>'}
                ${at ? `<div class="hint" style="margin-top:7px">${esc(at)}</div>` : ''}
              </div>`;
        };
        const activateWorldAdditionalPane = (view = 'entities') => {
            const allowed = new Set(['entities', 'world', 'active', 'log']);
            const selected = allowed.has(String(view || '')) ? String(view) : 'entities';
            overlay.querySelectorAll('[data-wa-tab]').forEach(button => {
                const active = button.dataset.waTab === selected;
                button.classList.toggle('on', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            overlay.querySelectorAll('[data-wa-pane]').forEach(pane => {
                pane.classList.toggle('on', pane.dataset.waPane === selected);
            });
        };
        const activateAdditionalPrimaryPane = (view = 'create') => {
            const allowed = new Set(['create', 'world-additional', 'active']);
            const selected = allowed.has(String(view || '')) ? String(view) : 'create';
            overlay.querySelectorAll('[data-additional-tab]').forEach(button => {
                const active = button.dataset.additionalTab === selected;
                button.classList.toggle('on', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            overlay.querySelectorAll('[data-additional-pane]').forEach(pane => {
                pane.classList.toggle('on', pane.dataset.additionalPane === selected);
            });
            if (selected === 'world-additional') renderWorldAdditional();
        };
        const activateUserDlcPane = (view = 'world') => {
            const selected = String(view || '') === 'entity' ? 'entity' : 'world';
            overlay.querySelectorAll('[data-udlc-tab]').forEach(button => {
                const active = button.dataset.udlcTab === selected;
                button.classList.toggle('on', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            overlay.querySelectorAll('[data-udlc-pane]').forEach(pane => pane.classList.toggle('on', pane.dataset.udlcPane === selected));
            if (selected === 'entity') refreshUserDlcTargetLists({ preserveSelection: true });
        };
        const userDlcKindLabel = (kind = '') => ({ tool: '도구', contraceptive: '피임 도구', dungeon: '던전', monster: '몬스터', drop_item: '드랍 아이템', experience_system: '경험치 체계', monster_gate: '몬스터 게이트', magic: '마법', sorcery: '요술', magic_array: '마법진', magic_wand: '마법 지팡이', magic_circle: '마법 서클', skill: '스킬', superpower: '초능력', trap: '트랩/함정', crisis: '위기 전개', hazard: '위험 요소', mechanism: '장치', lore: '세계 설정', location: '장소', faction: '조직/세력', rule: '세계 법칙', history: '역사/사건', artifact: '유물/물품', custom: '기타' }[String(kind || '')] || '기타');
        const renderUserDlcWorldCard = (item = {}) => {
            const compatibility = item.canonCompatibility || {};
            const contraceptive = item.contraceptiveProfile || null;
            const fantasy = item.fantasySystemProfile || null;
            const conflictBlocked = String(compatibility.status || '').toLowerCase() === 'conflicted';
            const kv = [
                ['원안', item.userConcept],
                ['세계관 적응 결과', item.adaptedConcept],
                ['세계관 적합성', item.worldFitSummary],
                ['작동 원리', item.mechanism],
                ['발동/트리거', item.trigger || item.activationCondition],
                ['효과', Array.isArray(item.effects) ? item.effects.join('\n• ') : ''],
                ['대응/회피', Array.isArray(item.counterplay) ? item.counterplay.join('\n• ') : ''],
                ['위험/실패', Array.isArray(item.risks) ? item.risks.join('\n• ') : ''],
                ['피임 방식', contraceptive ? `${contraceptive.methodClass || 'other'}${contraceptive.form ? ` · ${contraceptive.form}` : ''}` : ''],
                ['사용법', contraceptive?.useProtocol],
                ['효과 시작', contraceptive?.onset],
                ['유효 기간', contraceptive?.effectiveWindow],
                ['신뢰도 단계', contraceptive?.reliabilityTier],
                ['실패 조건', Array.isArray(contraceptive?.failureConditions) ? contraceptive.failureConditions.join('\n• ') : ''],
                ['부작용·제약', Array.isArray(contraceptive?.sideEffects) ? contraceptive.sideEffects.join('\n• ') : ''],
                ['입수 경로', contraceptive?.availability],
                ['가역성', contraceptive?.reversibility],
                ['보호 범위', contraceptive?.protectionScope],
                ['설정 근거', contraceptive?.settingBasis],
                ['체계 분류', fantasy?.category],
                ['등급·티어', fantasy?.rank],
                ['희귀도', fantasy?.rarity],
                ['권장 레벨·범위', fantasy?.levelRange],
                ['기원', fantasy?.origin],
                ['획득 방법', fantasy?.acquisition],
                ['발동·사용법', fantasy?.activation],
                ['지속 시간', fantasy?.duration],
                ['선행 조건', Array.isArray(fantasy?.prerequisites) ? fantasy.prerequisites.join('\n• ') : ''],
                ['비용·소모 자원', Array.isArray(fantasy?.costs) ? fantasy.costs.join('\n• ') : ''],
                ['제약·대응법', Array.isArray(fantasy?.limits) ? fantasy.limits.join('\n• ') : ''],
                ['성장 규칙', Array.isArray(fantasy?.progressionRules) ? fantasy.progressionRules.join('\n• ') : ''],
                ['보상·경험치 규칙', Array.isArray(fantasy?.rewardRules) ? fantasy.rewardRules.join('\n• ') : ''],
                ['드랍 목록', Array.isArray(fantasy?.drops) ? fantasy.drops.join('\n• ') : ''],
                ['약점', Array.isArray(fantasy?.weaknesses) ? fantasy.weaknesses.join('\n• ') : ''],
                ['진입 조건', Array.isArray(fantasy?.entryConditions) ? fantasy.entryConditions.join('\n• ') : ''],
                ['퇴장·종료 조건', Array.isArray(fantasy?.exitConditions) ? fantasy.exitConditions.join('\n• ') : ''],
                ['출현 조건', Array.isArray(fantasy?.spawnConditions) ? fantasy.spawnConditions.join('\n• ') : ''],
                ['실패 결과', Array.isArray(fantasy?.failureConsequences) ? fantasy.failureConsequences.join('\n• ') : ''],
                ['중복 보상 방지', Array.isArray(fantasy?.antiExploitRules) ? fantasy.antiExploitRules.join('\n• ') : ''],
                ['연결 요소', Array.isArray(fantasy?.relatedElements) ? fantasy.relatedElements.join(' · ') : ''],
                ['판타지 체계 근거', fantasy?.settingBasis],
                ['연결 인물', Array.isArray(item.relatedEntities) ? item.relatedEntities.join(', ') : ''],
                ['적응 근거', Array.isArray(item.sourceBasis) ? item.sourceBasis.join('\n• ') : ''],
                ['변환 사항', Array.isArray(compatibility.adaptations) ? compatibility.adaptations.join('\n• ') : ''],
                ['충돌 점검', Array.isArray(compatibility.conflicts) ? compatibility.conflicts.join('\n• ') : '']
            ].filter(([, value]) => String(value || '').trim());
            return `<div class="card mem">
              <div class="card-hdr"><div><div class="card-meta"><span class="bdg bm">${esc(userDlcKindLabel(item.kind))}</span><span class="bdg ${item.registrationSource === 'user_manual' ? 'bh' : 'bt'}">${item.registrationSource === 'user_manual' ? '직접 등록' : 'LLM 분석'}</span><span class="bdg bt">${esc(item.status || 'analyzed')}</span><span class="bdg bt">rev.${esc(item.revision || 1)}</span>${compatibility.status ? `<span class="bdg ${conflictBlocked ? 'bd' : 'bt'}">canon:${esc(compatibility.status)}</span>` : ''}${conflictBlocked ? '<span class="bdg bd">LIBRA DB 충돌 · 투입 차단</span>' : '<span class="bdg bh">호환 시 강제 적용</span>'}</div><div class="card-title">${esc(item.title || '사용자 DLC 요소')}</div></div><div class="acts"><span class="bdg bl">${esc(item.id || '')}</span>${renderWorldAdditionalInjectionButton('dlc-world', item)}<button class="btn bs" type="button" data-wa-edit-kind="dlc-world" data-wa-edit-id="${escAttr(item.id || '')}">편집</button><button class="btn bd" type="button" data-wa-delete-kind="dlc-world" data-wa-delete-id="${escAttr(item.id || '')}" data-wa-delete-label="${escAttr(item.title || '사용자 DLC 요소')}">삭제</button></div></div>
              <div class="udlc-kv">${kv.map(([key, value]) => `<b>${esc(key)}</b><span>${esc(value)}</span>`).join('')}</div>
              <div class="hint" style="margin-top:9px">${esc([item.updatedTurn ? `갱신 T${item.updatedTurn}` : '', item.progressionTier ? `tier ${item.progressionTier}` : '', item.userImpact ? `impact ${item.userImpact}` : '', Array.isArray(item.history) && item.history.length ? `이전 분석 ${item.history.length}개 보존` : ''].filter(Boolean).join(' · '))}</div>
            </div>`;
        };
        const renderUserDlcTargetCard = (item = {}) => {
            const findings = Array.isArray(item.findings) ? item.findings : [];
            const compatibility = item.canonCompatibility || {};
            const conflictBlocked = String(compatibility.status || '').toLowerCase() === 'conflicted';
            const extra = [
                ['세계관 적합성', item.worldFitSummary],
                ['연속성 영향', Array.isArray(item.continuityEffects) ? item.continuityEffects.join('\n• ') : ''],
                ['서사 활용', Array.isArray(item.narrativeUses) ? item.narrativeUses.join('\n• ') : ''],
                ['관계 해석', Array.isArray(item.relationshipImplications) ? item.relationshipImplications.join('\n• ') : ''],
                ['근거', Array.isArray(item.sourceBasis) ? item.sourceBasis.join('\n• ') : ''],
                ['DB 충돌', Array.isArray(compatibility.conflicts) ? compatibility.conflicts.join('\n• ') : ''],
                ['DB 적응', Array.isArray(compatibility.adaptations) ? compatibility.adaptations.join('\n• ') : '']
            ].filter(([, value]) => String(value || '').trim());
            return `<div class="card ${item.targetType === 'relation' ? 'rel' : 'ent'}">
              <div class="card-hdr"><div><div class="card-meta"><span class="bdg bm">${item.targetType === 'relation' ? '관계' : '인물'}</span><span class="bdg ${item.registrationSource === 'user_manual' ? 'bh' : 'bt'}">${item.registrationSource === 'user_manual' ? '직접 등록' : 'LLM 분석'}</span><span class="bdg bt">누적 rev.${esc(item.revision || 1)}</span>${item.updatedTurn ? `<span class="bdg bt">T${esc(item.updatedTurn)}</span>` : ''}<span class="bdg ${conflictBlocked ? 'bd' : 'bt'}">canon:${esc(compatibility.status || 'unverified')}</span>${conflictBlocked ? '<span class="bdg bd">LIBRA DB 충돌 · 투입 차단</span>' : '<span class="bdg bh">호환 항목 강제 적용</span>'}</div><div class="card-title">${esc(item.displayName || item.targetIds?.join(' ↔ ') || '선택 대상')}</div></div><div class="acts"><span class="bdg bl">${esc(item.id || '')}</span>${renderWorldAdditionalInjectionButton('dlc-target', item)}<button class="btn bd" type="button" data-wa-delete-kind="dlc-target" data-wa-delete-id="${escAttr(item.id || '')}" data-wa-delete-label="${escAttr(item.displayName || '선택 대상')}">삭제</button></div></div>
              ${item.summary ? `<div class="memory-readable"><div class="memory-readable-title">분석 요약</div><div class="memory-readable-text">${esc(item.summary)}</div></div>` : ''}
              ${findings.length ? `<div class="udlc-kv">${findings.map(finding => `<b>${esc(finding.label || '분석')}</b><span>${esc(finding.value || '')}${finding.evidence?.length ? `\n근거: ${esc(finding.evidence.join(' / '))}` : ''}${finding.confidence ? `\n신뢰: ${esc(finding.confidence)}` : ''}${finding.dbCompatibility ? `\nDB 호환: ${esc(finding.dbCompatibility)}` : ''}${finding.conflicts?.length ? `\n충돌: ${esc(finding.conflicts.join(' / '))}` : ''}</span>`).join('')}</div>` : ''}
              ${extra.length ? `<div class="udlc-kv">${extra.map(([key, value]) => `<b>${esc(key)}</b><span>${esc(value)}</span>`).join('')}</div>` : ''}
              <details class="memory-raw-box"><summary>사용자 분석 프롬프트와 갱신 이력</summary><div class="memory-raw-help">${esc(item.prompt || '프롬프트 없음')}\n\n${esc(Array.isArray(item.promptHistory) ? `누적 프롬프트 ${item.promptHistory.length}개 · 이전 분석 ${item.history?.length || 0}개` : '')}</div></details>
            </div>`;
        };
        const userDlcTrackerKindLabel = (kind = '') => ({
            state: '상태', scenario_response: '상황 반응', relationship_model: '관계 모델', capability: '방어·능력', reproductive_health: '생식 건강', health_risk: '건강 위험', sexual_history: '성경험 이력'
        }[String(kind || '')] || '추가 요소');
        let activeUserDlcRetargetEdit = null;
        const renderUserDlcTrackerCard = (item = {}) => {
            const history = Array.isArray(item.history) ? [...item.history].slice(-8).reverse() : [];
            const membershipActive = item.membershipActive !== false;
            const trackingOn = membershipActive && item.enabled !== false;
            const value = String(item.currentValue || '').trim() || 'unknown';
            const snapshot = item.currentSnapshot || {};
            const probability = snapshot.probabilityMin !== null && snapshot.probabilityMin !== undefined || snapshot.probabilityMax !== null && snapshot.probabilityMax !== undefined
                ? `${snapshot.probabilityMin ?? '?'}~${snapshot.probabilityMax ?? '?'}%${snapshot.probabilityLabel ? ` · ${snapshot.probabilityLabel}` : ''}` : '';
            const isSexualHistory = String(item.kind || '') === 'sexual_history';
            const countText = (number, unit = '회') => number === null || number === undefined || number === ''
                ? '미확인'
                : `${number}${unit}${snapshot.sexualHistoryCountingBasis === 'observed_minimum' ? ' 이상 · 확인 최소치' : ''}`;
            const virginityText = ({
                no_confirmed_sex_experience: '성경험 없음 · 극중 명시 확인',
                sexually_experienced: '성경험 있음',
                unknown: '미확인'
            }[String(snapshot.virginityStatus || 'unknown')] || '미확인');
            const sexualHistoryRows = isSexualHistory ? [
                ['섹스 횟수', countText(snapshot.sexCount)],
                ['처녀 여부(첫 성경험 기준)', virginityText],
                ['자위 횟수', countText(snapshot.masturbationCount)],
                ['임신 횟수', countText(snapshot.pregnancyCount)],
                ['출산 횟수', countText(snapshot.birthCount)],
                ['경험 인수', countText(snapshot.distinctPartnerCount, '명')],
                ['질내사정 횟수', countText(snapshot.vaginalEjaculationCount)],
                ['펠라치오 횟수', countText(snapshot.fellatioCount)],
                ['애널 섹스 횟수', countText(snapshot.analSexCount)],
                ['첫 섹스 상대', snapshot.firstSexPartner || '미확인'],
                ['확인된 상대', Array.isArray(snapshot.knownSexPartners) && snapshot.knownSexPartners.length ? snapshot.knownSexPartners.join(' · ') : '미확인'],
                ['집계 기준', snapshot.sexualHistoryCountingBasis === 'canonical_total' ? '정본상 생애 총계' : (snapshot.sexualHistoryCountingBasis === 'observed_minimum' ? '직접 확인된 최소 누적치' : '미확인')]
            ] : [];
            const currentRows = [...sexualHistoryRows, ...[
                ['현재 관계', snapshot.relationshipState],
                ['현재 가능성', probability],
                ['예상 반응', snapshot.expectedResponse],
                ['대사 방향·예시', Array.isArray(snapshot.dialogueExamples) ? snapshot.dialogueExamples.join('\n• ') : ''],
                ['방어·탈출 판정', snapshot.defenseAssessment],
                ['극중 날짜', snapshot.sceneDate],
                ['현재 주기', snapshot.cycleStatus],
                ['가임 가능성', snapshot.fertilityWindow],
                ['피임·노출', snapshot.contraception],
                ['건강 상태', snapshot.healthStatus],
                ['다음 확인', snapshot.nextEvaluation]
            ]].filter(([, rowValue]) => String(rowValue || '').trim());
            const bands = Array.isArray(item.scenarioBands) ? item.scenarioBands : [];
            const latestEvent = Array.isArray(item.eventLedger) && item.eventLedger.length ? item.eventLedger[item.eventLedger.length - 1] : null;
            const historyHtml = history.length ? history.map(entry => `<div class="hint" style="margin-top:5px">${entry.turn ? `T${esc(entry.turn)} · ` : ''}<b>${esc(entry.from || '(empty)')} → ${esc(entry.to || '')}</b> · ${esc(entry.confidence || 'unknown')}${entry.evidence?.length ? `<br>근거: ${esc(entry.evidence.join(' / '))}` : ''}</div>`).join('') : '<div class="hint">아직 상태 변경 이력이 없습니다.</div>';
            return `<div class="card ${item.targetType === 'relation' ? 'rel' : 'ent'}">
              <div class="card-hdr"><div><div class="card-meta"><span class="bdg bm">${esc(userDlcTrackerKindLabel(item.kind))}</span><span class="bdg bt">${item.targetType === 'relation' ? '관계' : '인물'}</span><span class="bdg ${item.confidence === 'confirmed' ? 'bh' : 'bt'}">${esc(item.confidence || 'unknown')}</span><span class="bdg ${membershipActive ? (trackingOn ? 'bh' : 'bt') : 'bd'}">${membershipActive ? (trackingOn ? '자동 갱신' : '일회성') : '대상 제외 · 보관'}</span><span class="bdg bt">rev.${esc(item.revision || 1)}</span></div><div class="card-title">${esc(item.displayName || item.targetIds?.join(' ↔ ') || '선택 대상')} · ${esc(item.label || '추가 요소')}</div></div><div class="acts"><button class="btn bs" type="button" title="이 추적 요소에 포함할 인물을 다시 선택하고 재분석합니다." data-udlc-retarget-id="${escAttr(item.id || '')}">대상 편집</button>${membershipActive ? `<button class="btn wa-inject-toggle${trackingOn ? ' is-on' : ''}" type="button" aria-pressed="${trackingOn ? 'true' : 'false'}" title="켜면 매 턴 현재 상태를 다시 평가합니다." data-udlc-tracker-enabled-id="${escAttr(item.id || '')}" data-udlc-tracker-enabled="${trackingOn ? 'true' : 'false'}">추적</button>${renderWorldAdditionalInjectionButton('dlc-tracker', item)}` : ''}<button class="btn bd" type="button" data-wa-delete-kind="dlc-tracker" data-wa-delete-id="${escAttr(item.id || '')}" data-wa-delete-label="${escAttr(`${item.displayName || ''} · ${item.label || '추가 요소'}`)}">삭제</button></div></div>
              <div class="memory-readable"><div class="memory-readable-title">${membershipActive ? '현재 결과' : '보관된 이전 결과'}</div><div class="memory-readable-text"><b>${esc(snapshot.summary || value)}</b>${item.lastEvaluatedTurn ? ` · 마지막 갱신 T${esc(item.lastEvaluatedTurn)}` : ' · 생성 시점 결과'}${trackingOn ? '' : (membershipActive ? ' · 추적 OFF' : ' · 데이터 유지')}</div></div>
              ${currentRows.length ? `<div class="udlc-kv">${currentRows.map(([key, rowValue]) => `<b>${esc(key)}</b><span>${esc(rowValue)}</span>`).join('')}</div>` : ''}
              ${latestEvent && isSexualHistory ? `<div class="setting-note">최근 성경험 이력 사건은 ${esc(latestEvent.sceneDate || `T${latestEvent.turn || '?'}`)} 기준 한 번만 집계되었습니다. 같은 사건을 다시 언급하거나 재분석해도 횟수를 중복 가산하지 않습니다.</div>` : (latestEvent ? `<div class="setting-note">최근 사건은 ${esc(latestEvent.sceneDate || `T${latestEvent.turn || '?'}`)} 기준 ${esc(latestEvent.probabilityMin)}~${esc(latestEvent.probabilityMax)}%로 한 번만 판정되어 고정되었습니다. 이후 턴에는 재추첨하지 않습니다.</div>` : '')}
              ${bands.length ? `<details class="memory-raw-box"><summary>관계 단계별 전체 예상 ${bands.length}개</summary><div class="udlc-kv">${bands.map(band => `<b>${esc(band.band || '상황')}</b><span>${esc([band.expectedResponse, band.probabilityMin !== null || band.probabilityMax !== null ? `${band.probabilityMin ?? '?'}~${band.probabilityMax ?? '?'}%` : '', ...(band.dialogueExamples || [])].filter(Boolean).join('\n'))}</span>`).join('')}</div></details>` : ''}
              <details class="memory-raw-box"><summary>근거와 변경 이력</summary><div class="memory-raw-help">${item.reason ? `최근 판정: ${esc(item.reason)}\n` : ''}${item.evidence?.length ? `근거: ${esc(item.evidence.join(' / '))}\n\n` : ''}${historyHtml}</div></details>
            </div>`;
        };
        const refreshUserDlcTargetLists = (options = {}) => {
            const preserveSelection = options.preserveSelection !== false;
            const selectedEntityIds = preserveSelection
                ? new Set([...overlay.querySelectorAll('[data-udlc-entity-target]:checked')].map(node => String(node.value || '')))
                : new Set();
            const targetLore = Array.isArray(effectiveGuiLore) && effectiveGuiLore.length ? effectiveGuiLore : (Array.isArray(lore) ? lore : []);
            try { EntityManager.rebuildCache(targetLore); }
            catch (error) { recordSuppressedRuntimeError('gui.user_dlc.target_cache_rebuild_failed', error, { loreCount: targetLore.length }); }
            const entities = UserDlcCore.listEntityTargets?.(targetLore) || [];
            const relations = UserDlcCore.listRelationTargets?.(targetLore) || [];
            const entityList = overlay.querySelector('#user-dlc-entity-target-list');
            if (entityList) entityList.innerHTML = entities.length
                ? entities.map(item => `<label class="udlc-target-item"><input type="checkbox" data-udlc-entity-target value="${escAttr(item.id)}"${selectedEntityIds.has(String(item.id)) ? ' checked' : ''}><span>${esc(item.displayName)}${item.type ? `<small class="hint"> · ${esc(item.type)}</small>` : ''}</span></label>`).join('')
                : '<div class="empty">현재 채팅 범위에 저장된 LIBRA 엔티티가 없습니다. 콜드스타트 또는 과거대화 재분석 후 다시 새로고침해 주세요.</div>';
            const countNode = overlay.querySelector('#user-dlc-target-count');
            if (countNode) countNode.textContent = `인물 ${entities.length}개 · 자동 참조 관계 ${relations.length}개`;
            const unifiedTarget = overlay.querySelector('#udlc-unified-target');
            if (unifiedTarget) {
                const previousValue = String(unifiedTarget.value || 'world');
                unifiedTarget.innerHTML = [
                    '<option value="world">세계 전체</option>',
                    ...entities.map(item => `<option value="entity:${escAttr(item.id)}">${esc(item.displayName)} · 인물</option>`)
                ].join('');
                unifiedTarget.value = [...unifiedTarget.options].some(option => option.value === previousValue) ? previousValue : 'world';
            }
            if (options.announce === true) {
                const status = overlay.querySelector('#user-dlc-entity-status');
                if (status) status.textContent = entities.length
                    ? `인물 목록 새로고침 완료 · ${entities.length}개 · 관계 ${relations.length}개 자동 참조`
                    : '현재 채팅의 LIBRA 엔티티 DB가 비어 있습니다.';
            }
            return { entities, relations };
        };
        const renderUserDlc = (userDlcState = UserDlcCore.getState?.() || {}) => {
            const worldItems = Array.isArray(userDlcState.worldItems) ? userDlcState.worldItems : [];
            const targetLore = Array.isArray(effectiveGuiLore) && effectiveGuiLore.length ? effectiveGuiLore : (Array.isArray(lore) ? lore : []);
            const targetAnalyses = (Array.isArray(userDlcState.targetAnalyses) ? userDlcState.targetAnalyses : []).filter(item => UserDlcCore.isTargetBlocked?.(item, targetLore) !== true);
            const entityTrackers = (Array.isArray(userDlcState.entityTrackers) ? userDlcState.entityTrackers : []).filter(item => UserDlcCore.isTargetBlocked?.(item, targetLore) !== true);
            const setCount = (id, value) => { const node = overlay.querySelector(id); if (node) node.textContent = String(value); };
            setCount('#wa-user-dlc-count', worldItems.length + targetAnalyses.length + entityTrackers.length);
            setCount('#udlc-world-count', worldItems.length);
            setCount('#udlc-entity-count', targetAnalyses.length + entityTrackers.length);
            // 목업 계기판 — 같은 값을 KPI 로도 보여준다.
            const udlcSet = (id, html) => { const node = overlay.querySelector('#' + id); if (node) node.innerHTML = html; };
            udlcSet('udlc-kpi-total', `${worldItems.length + targetAnalyses.length + entityTrackers.length}<small>건</small>`);
            const udlcMix = overlay.querySelector('#udlc-kpi-mix');
            if (udlcMix) udlcMix.textContent = `세계 ${worldItems.length} · 인물 ${targetAnalyses.length + entityTrackers.length}`;
            udlcSet('udlc-kpi-track', `${entityTrackers.filter(t => t?.enabled === true).length}<small>건</small>`);
            udlcSet('udlc-kpi-targets', `${targetAnalyses.length}<small>명</small>`);
            setCount('#udlc-tracker-count', entityTrackers.length);
            const worldBox = overlay.querySelector('#user-dlc-world-results');
            if (worldBox) worldBox.innerHTML = worldItems.length ? [...worldItems].sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).map(renderUserDlcWorldCard).join('') : '<div class="empty">아직 창안·적응된 World DLC가 없습니다</div>';
            const targetBox = overlay.querySelector('#user-dlc-entity-results');
            if (targetBox) targetBox.innerHTML = targetAnalyses.length ? [...targetAnalyses].sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).map(renderUserDlcTargetCard).join('') : '<div class="empty">아직 선택 인물/관계에 연결된 추가 분석이 없습니다</div>';
            const trackerBox = overlay.querySelector('#user-dlc-tracker-results');
            if (trackerBox) trackerBox.innerHTML = entityTrackers.length ? [...entityTrackers].sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).map(renderUserDlcTrackerCard).join('') : '<div class="empty">아직 등록된 커스텀 상태 추적기가 없습니다</div>';
            refreshUserDlcTargetLists({ preserveSelection: true });
        };
        const renderWorldAdditional = () => {
            const { state, allDirectives, entry, userDlcState } = getWorldAdditionalDisplayState();
            const candidateCount = getWorldAdditionalCandidateCount(state, allDirectives);
            updateWorldAdditionalCandidateLabel(candidateCount);
            const summary = overlay.querySelector('#world-additional-summary');
            if (!summary) return;
            const config = _CFG || MemoryEngine.CONFIG || {};
            const activeStatuses = new Set(['prepared', 'armed', 'injected']);
            const activeDirectives = [
                ...(Array.isArray(state.activeDirectives) ? state.activeDirectives : []),
                ...allDirectives.filter(item => activeStatuses.has(String(item?.status || '').trim()))
            ].filter(item => item && item.injectionDisabled !== true);
            const seen = new Set();
            const activeUnique = activeDirectives.filter(item => {
                const key = String(item?.id || item?.title || JSON.stringify(item || {}));
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).slice(0, 12);
            const entityDirectives = Array.isArray(state.characterAdditions) ? state.characterAdditions : [];
            const worldDeltas = Array.isArray(state.worldDeltas) ? state.worldDeltas : [];
            const sceneInterventions = Array.isArray(state.sceneInterventions) ? state.sceneInterventions : [];
            const manifestationLog = Array.isArray(state.manifestationLog) ? state.manifestationLog : [];
            overlay.querySelector('#wa-db-count').textContent = String(allDirectives.length);
            overlay.querySelector('#wa-entity-count').textContent = String(entityDirectives.length);
            overlay.querySelector('#wa-world-count').textContent = String(worldDeltas.length + sceneInterventions.length);
            overlay.querySelector('#wa-active-count').textContent = String(activeUnique.length);
            overlay.querySelector('#wa-log-count').textContent = String(manifestationLog.length);
            // 목업 계기판 — 같은 값을 KPI 로도 보여준다(추가 계산 없음).
            const waSet = (id, html) => { const node = overlay.querySelector('#' + id); if (node) node.innerHTML = html; };
            waSet('wa-kpi-total', `${allDirectives.length}<small>건</small>`);
            const waMix = overlay.querySelector('#wa-kpi-mix');
            if (waMix) waMix.textContent = `엔티티 ${entityDirectives.length} · 월드 ${worldDeltas.length}`;
            waSet('wa-kpi-active', `${activeUnique.length}<small>건</small>`);
            waSet('wa-kpi-log', `${manifestationLog.length}<small>건</small>`);
            summary.innerHTML = [
                ['투입 방식', '모델 적응형'],
                ['최대 자동 투입', `${Math.max(1, Math.min(6, Number(config.worldAdditionalMaxPerRequest || 3) || 3))}개`],
                ['엔티티 DB', `${entityDirectives.length}개`],
                ['월드 지시', `${worldDeltas.length + sceneInterventions.length}개`],
                ['현재 활성', `${activeUnique.length}개`],
                ['발현/통합', `${manifestationLog.length}건`],
                ['최근 턴', `T${Number(state.lastTurn || 0) || 0}`],
                ['저장', entry ? 'lmai_world_additional 있음' : '저장 엔트리 없음']
            ].map(([label, value]) => `<div class="ci"><b>${esc(label)}</b><br>${esc(value)}</div>`).join('');

            const entityBox = overlay.querySelector('#world-additional-entities');
            if (entityBox) {
                entityBox.innerHTML = entityDirectives.length
                    ? [...entityDirectives].sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).map(item => renderWorldAdditionalDirectiveCard(item)).join('')
                    : '<div class="empty">월드 에디셔널이 생성한 엔티티가 없습니다</div>';
            }

            const worldBox = overlay.querySelector('#world-additional-world');
            if (worldBox) {
                const groups = [
                    ['세계 추가 요소', worldDeltas, item => renderWorldAdditionalDirectiveCard(item)],
                    ['장면 개입 지시', sceneInterventions, item => renderWorldAdditionalDirectiveCard(item)]
                ];
                worldBox.innerHTML = groups.map(([label, items, renderer]) => `<div class="wa-group">
                    <div class="wa-group-title"><span>${esc(label)}</span><span class="wa-tab-count">${items.length}</span></div>
                    <div class="list">${items.length ? [...items].sort((a, b) => Number(b.lastUpdated || 0) - Number(a.lastUpdated || 0)).map(renderer).join('') : `<div class="empty">${esc(label)}가 없습니다</div>`}</div>
                  </div>`).join('');
            }

            const activeBox = overlay.querySelector('#world-additional-active');
            if (activeBox) {
                activeBox.innerHTML = activeUnique.length
                    ? activeUnique.map(item => renderWorldAdditionalDirectiveCard(item, { active: true })).join('')
                    : '<div class="empty">현재 주입 대기/활성 지시가 없습니다</div>';
            }

            // ── 투입 판정 패널 ────────────────────────────────────────────
            // selectForPrompt 가 계산한 거부 사유·버킷 통계를 그대로 보여준다.
            // 이게 없으면 사용자는 "왜 이 요소가 안 나오지"를 알 수 없다.
            const diagBox = overlay.querySelector('#world-additional-diagnostics');
            if (diagBox) {
                let diag = null;
                try { diag = WorldAdditionalCore.getSelectionDiagnostics?.() || null; } catch (_) { diag = null; }
                if (!diag) {
                    diagBox.innerHTML = '<div class="hint">아직 판정 기록이 없습니다. 다음 요청 후 표시됩니다.</div>';
                } else {
                    const rejected = Array.isArray(diag.rejected) ? diag.rejected : [];
                    const stats = Array.isArray(diag.bucketStats) ? diag.bucketStats : [];
                    const selectedCount = Array.isArray(diag.selectedIds) ? diag.selectedIds.length : 0;
                    const statRows = stats.map(s => `<div class="hint">${esc(String(s.bucket || ''))}: 후보 ${esc(String(s.candidates ?? 0))} · 조건 충족 ${esc(String(s.eligible ?? 0))} · 투입 ${esc(String(s.picked ?? 0))} (유형 한도 ${esc(String(s.limit ?? 0))})</div>`).join('');
                    // '주입됨'에 머문 항목 = 모델이 아직 작품에 쓰지 않은 요소.
                    const stalled = allDirectives.filter(item => String(item?.status || '').trim() === 'injected');
                    const stalledRows = stalled.length
                        ? stalled.slice(0, 6).map(item => `<div class="hint">· ${esc(item.title || item.name || item.id || '')} — 주입 중이지만 아직 등장하지 않음${item.injectedTurn ? ` (T${esc(String(item.injectedTurn))}부터)` : ''}</div>`).join('')
                        : '<div class="hint">· 없음</div>';
                    const rejectedRows = rejected.length
                        ? rejected.slice(0, 10).map(r => {
                            const t = r?.directive?.title || r?.directive?.name || r?.directive?.id || '(제목 없음)';
                            const reasonLabel = r?.label
                                || (() => { try { return WorldAdditionalCore.getRejectReasonLabel?.(r?.reason) || ''; } catch (_) { return ''; } })()
                                || String(r?.reason || '사유 미상');
                            return `<div class="hint">· ${esc(t)} — ${esc(reasonLabel)}</div>`;
                        }).join('')
                        : '<div class="hint">· 없음 (모든 후보가 투입됨)</div>';
                    diagBox.innerHTML = `
                        <div class="wa-group">
                          <div class="wa-group-title"><span>이번 턴 투입</span><span class="wa-tab-count">${esc(String(selectedCount))}</span></div>
                          <div class="list">${statRows || '<div class="hint">판정 통계가 없습니다.</div>'}</div>
                        </div>
                        <div class="wa-group">
                          <div class="wa-group-title"><span>⏸ 대기 — 투입되지 않음</span><span class="wa-tab-count">${esc(String(rejected.length))}</span></div>
                          <div class="list">${rejectedRows}</div>
                        </div>
                        <div class="wa-group">
                          <div class="wa-group-title"><span>⏳ 주입 중이지만 아직 등장 안 함</span><span class="wa-tab-count">${esc(String(stalled.length))}</span></div>
                          <div class="list">${stalledRows}</div>
                        </div>`;
                }
            }

            const logBox = overlay.querySelector('#world-additional-log');
            if (logBox) {
                const log = manifestationLog.slice(-40).reverse();
                logBox.innerHTML = log.length
                    ? log.map(item => renderWorldAdditionalLogCard(item)).join('')
                    : '<div class="empty">아직 발현/통합 로그가 없습니다</div>';
            }
            renderUserDlc(userDlcState);
            syncSidebarCounts();
        };
        const renderAllGuiDataViews = () => {
            renderEnts();
            renderNarrative();
            renderWorld();
            renderWorldAdditional();
            filterMems();
        };
        const mergeWorldAdditionalDuplicatesFromGui = async () => {
            const button = overlay.querySelector('#btn-merge-world-additional');
            if (button) button.disabled = true;
            try {
                let worldMerged = 0; let dlcMerged = 0;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    const scopeKey = getChatRuntimeScopeKey(latestChat, latestChar);
                    const chatId = String(latestChat?.id || '').trim();
                    WorldAdditionalCore.loadState?.(latestLore, { scopeKey, chatId });
                    UserDlcCore.loadState?.(latestLore, { scopeKey, chatId });
                    const worldResult = WorldAdditionalCore.mergeDuplicateDirectives?.() || {};
                    const dlcResult = UserDlcCore.mergeDuplicateItems?.() || {};
                    worldMerged = Number(worldResult.merged || 0); dlcMerged = Number(dlcResult.merged || 0);
                    await WorldAdditionalCore.saveState?.(latestLore);
                    await UserDlcCore.saveState?.(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const total = worldMerged + dlcMerged;
                const message = total ? `중복 ${total}개 병합 완료 · 기본 DB ${worldMerged} · 유저 DLC ${dlcMerged}` : '병합할 중복 요소가 없습니다';
                const status = overlay.querySelector('#world-additional-analysis-status');
                if (status) status.textContent = message;
                toast(total ? `🧩 ${message}` : `ℹ️ ${message}`);
            } catch (error) {
                const message = `중복 병합 실패: ${error?.message || error}`;
                const status = overlay.querySelector('#world-additional-analysis-status');
                if (status) status.textContent = message;
                recordRuntimeDebug('error', '[LIBRA] World Additional duplicate merge failed:', error);
                toast(`❌ ${message}`);
            } finally { if (button) button.disabled = false; }
        };
        const toggleWorldAdditionalInjectionFromGui = async (kind = '', id = '', enabled = false) => {
            const targetId = String(id || '').trim(); if (!targetId) return false;
            try {
                let result = null;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    const scopeKey = getChatRuntimeScopeKey(latestChat, latestChar);
                    const chatId = String(latestChat?.id || '').trim();
                    WorldAdditionalCore.loadState?.(latestLore, { scopeKey, chatId });
                    UserDlcCore.loadState?.(latestLore, { scopeKey, chatId });
                    if (kind === 'dlc-world') result = UserDlcCore.setInjectionState?.('world', targetId, enabled);
                    else if (kind === 'dlc-target') result = UserDlcCore.setInjectionState?.('target', targetId, enabled);
                    else if (kind === 'dlc-tracker') result = UserDlcCore.setInjectionState?.('tracker', targetId, enabled);
                    else result = WorldAdditionalCore.setInjectionState?.(kind === 'codex' ? 'codex' : 'directive', targetId, enabled);
                    if (result?.changed !== true) throw new Error(`투입 상태를 바꿀 항목을 찾지 못했습니다: ${result?.reason || 'unknown'}`);
                    await WorldAdditionalCore.saveState?.(latestLore);
                    await UserDlcCore.saveState?.(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const userDlc = String(kind || '').startsWith('dlc-');
                const message = enabled
                    ? `${userDlc ? '사용' : '투입'} ON · 다음 요청부터 실제 프롬프트에 반영됩니다`
                    : `${userDlc ? '사용' : '투입'} OFF · 다음 요청부터 제외됩니다`;
                const status = overlay.querySelector('#world-additional-analysis-status');
                if (status) status.textContent = message;
                toast(enabled ? `💡 ${message}` : `⚫ ${message}`);
                return true;
            } catch (error) {
                recordRuntimeDebug('error', '[LIBRA] World Additional injection toggle failed:', error);
                toast(`❌ 사용 상태 변경 실패: ${error?.message || error}`);
                return false;
            }
        };
        const toggleUserDlcTrackerEnabledFromGui = async (id = '', enabled = false) => {
            const targetId = String(id || '').trim(); if (!targetId) return false;
            try {
                let result = null;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    UserDlcCore.loadState?.(latestLore, { scopeKey: getChatRuntimeScopeKey(latestChat, latestChar), chatId: String(latestChat?.id || '').trim() });
                    result = UserDlcCore.setTrackerEnabled?.(targetId, enabled);
                    if (result?.changed !== true) throw new Error(`추적기를 찾지 못했습니다: ${result?.reason || 'unknown'}`);
                    await UserDlcCore.saveState?.(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const message = enabled ? '자동 추적 ON · 관련 응답 후 상태를 검사합니다' : '자동 추적 OFF · 현재 상태만 보존합니다';
                const status = overlay.querySelector('#user-dlc-tracker-status'); if (status) status.textContent = message;
                toast(enabled ? `💡 ${message}` : `⚫ ${message}`);
                return true;
            } catch (error) {
                recordRuntimeDebug('error', '[LIBRA] User DLC tracker toggle failed:', error);
                toast(`❌ 추적 상태 변경 실패: ${error?.message || error}`);
                return false;
            }
        };
        const deleteWorldAdditionalItemFromGui = async (kind = '', id = '', label = '') => {
            const targetId = String(id || '').trim(); if (!targetId) return false;
            const displayLabel = String(label || targetId).trim();
            if (!await Utils.confirmEx(`“${displayLabel}” 항목을 월드 에디셔널 DB에서 삭제하시겠습니까?\n삭제 후에는 다음 요청부터 주입되지 않습니다.`)) return false;
            try {
                let changed = false;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    const scopeKey = getChatRuntimeScopeKey(latestChat, latestChar);
                    const chatId = String(latestChat?.id || '').trim();
                    WorldAdditionalCore.loadState?.(latestLore, { scopeKey, chatId });
                    UserDlcCore.loadState?.(latestLore, { scopeKey, chatId });
                    if (kind === 'dlc-world') changed = UserDlcCore.deleteItem?.('world', targetId)?.changed === true;
                    else if (kind === 'dlc-target') changed = UserDlcCore.deleteItem?.('target', targetId)?.changed === true;
                    else if (kind === 'dlc-tracker') changed = UserDlcCore.deleteItem?.('tracker', targetId)?.changed === true;
                    else changed = WorldAdditionalCore.deleteItem?.(kind === 'codex' ? 'codex' : 'directive', targetId)?.changed === true;
                    if (!changed) throw new Error('삭제 대상을 현재 DB에서 찾지 못했습니다.');
                    await WorldAdditionalCore.saveState?.(latestLore);
                    await UserDlcCore.saveState?.(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                toast(`🗑 ${displayLabel} 삭제 완료`);
                return changed;
            } catch (error) {
                recordRuntimeDebug('error', '[LIBRA] World Additional item delete failed:', error);
                toast(`❌ 삭제 실패: ${error?.message || error}`);
                return false;
            }
        };
        // ── 카드 인라인 편집 ─────────────────────────────────────────────
        // 카드에 투입 토글과 삭제만 있어서, 내용을 고치려면 재분석하거나 삭제 후
        // 재생성해야 했다. 그러면 revision 이력과 켜 둔 투입 상태가 끊긴다.
        // 여기서 편집 폼을 카드 자리에 띄우고, 승인 시 같은 id 를 갱신한다.
        const EDIT_FIELD_LABELS = {
            title: '제목', userConcept: '원안', adaptedConcept: '세계관 적응 결과',
            worldFitSummary: '세계관 적합성', mechanism: '작동 원리', trigger: '발동/트리거',
            directive: '적용 지시', description: '추가 내용', purpose: '목적', role: '역할',
            activationCondition: '발동 조건', progressionTier: '진행 단계',
            forceLevel: '강제 강도', userImpact: '영향도', status: '상태'
        };
        const editWorldAdditionalItemFromGui = async (kind = '', id = '') => {
            const targetId = String(id || '').trim();
            if (!targetId) return false;
            const isDlc = String(kind || '').startsWith('dlc-');
            const item = isDlc
                ? (UserDlcCore.getState?.()?.worldItems || []).find(entry => String(entry?.id || '') === targetId)
                : [
                    ...(WorldAdditionalCore.getState?.()?.sceneInterventions || []),
                    ...(WorldAdditionalCore.getState?.()?.worldDeltas || []),
                    ...(WorldAdditionalCore.getState?.()?.characterAdditions || [])
                  ].find(entry => String(entry?.id || '') === targetId);
            if (!item) { toast('❌ 편집할 항목을 찾지 못했습니다'); return false; }
            const fieldNames = isDlc
                ? (UserDlcCore.getWorldItemEditableFields?.() || ['title', 'adaptedConcept', 'mechanism', 'trigger'])
                : (WorldAdditionalCore.getDirectiveEditableFields?.() || ['title', 'description', 'directive']);
            const values = fieldNames.map(field => {
                const raw = item[field];
                const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
                return { field, text };
            });
            const body = values.map(v => `
                <div class="fld">
                  <label>${esc(EDIT_FIELD_LABELS[v.field] || v.field)} <span class="setting-note">${esc(v.field)}</span></label>
                  <textarea class="ec" rows="${v.text.length > 120 ? 4 : 2}" data-wa-edit-field="${escAttr(v.field)}">${esc(v.text)}</textarea>
                </div>`).join('');
            const box = overlay.querySelector(isDlc ? '#user-dlc-world-preview' : '#world-additional-diagnostics');
            if (!box) { toast('❌ 편집 폼을 표시할 자리가 없습니다'); return false; }
            const existingForm = overlay.querySelector('#wa-inline-edit-form');
            if (existingForm) existingForm.remove();
            const host = document.createElement('div');
            host.id = 'wa-inline-edit-form';
            host.className = 'wa-group';
            host.innerHTML = `
                <div class="wa-group-title"><span>편집</span><span class="wa-tab-count">${esc(item.title || item.name || targetId)}</span></div>
                <div class="hint" style="margin:4px 0 8px">같은 항목을 갱신합니다 — revision 이 오르고 투입 상태는 유지됩니다. 저장은 [편집 저장]을 눌러야 반영됩니다.</div>
                ${body}
                <div class="toolbar" style="margin-top:8px">
                  <button class="btn bp" id="btn-wa-edit-save" type="button">💾 편집 저장</button>
                  <button class="btn" id="btn-wa-edit-cancel" type="button">취소</button>
                </div>`;
            box.prepend(host);
            host.querySelector('#btn-wa-edit-cancel')?.addEventListener('click', () => host.remove());
            host.querySelector('#btn-wa-edit-save')?.addEventListener('click', async () => {
                const patch = {};
                host.querySelectorAll('[data-wa-edit-field]').forEach(node => {
                    const field = node.dataset.waEditField;
                    const next = String(node.value || '');
                    const original = Array.isArray(item[field]) ? item[field].join('\n') : String(item[field] ?? '');
                    if (next !== original) patch[field] = next;
                });
                if (!Object.keys(patch).length) { toast('변경된 내용이 없습니다'); return; }
                const saveBtn = host.querySelector('#btn-wa-edit-save');
                if (saveBtn) saveBtn.disabled = true;
                try {
                    let changed = false; let reason = '';
                    await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                        const scopeKey = getChatRuntimeScopeKey(latestChat, latestChar);
                        const chatId = String(latestChat?.id || '').trim();
                        WorldAdditionalCore.loadState?.(latestLore, { scopeKey, chatId });
                        UserDlcCore.loadState?.(latestLore, { scopeKey, chatId });
                        const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                        const result = isDlc
                            ? UserDlcCore.updateWorldItemFields?.(targetId, patch, { turn })
                            : WorldAdditionalCore.updateDirectiveFields?.(targetId, patch, { turn });
                        changed = result?.changed === true;
                        reason = String(result?.reason || '');
                        if (!changed) throw new Error(reason || '편집을 적용하지 못했습니다.');
                        if (isDlc) await UserDlcCore.saveState?.(latestLore);
                        else await WorldAdditionalCore.saveState?.(latestLore);
                        return latestLore;
                    }, renderWorldAdditional);
                    host.remove();
                    toast(`💾 편집 저장 완료 (${Object.keys(patch).join(', ')})`);
                    return true;
                } catch (error) {
                    recordRuntimeDebug('error', '[LIBRA] Inline edit failed:', error);
                    toast(`❌ 편집 실패: ${error?.message || error}`);
                    if (saveBtn) saveBtn.disabled = false;
                    return false;
                }
            });
            return true;
        };
        const runWorldAdditionalManualAnalysisFromGui = async () => {
            const button = overlay.querySelector('#btn-analyze-world-additional');
            const status = overlay.querySelector('#world-additional-analysis-status');
            const setStatus = (text) => { if (status) status.textContent = text; };
            let activityContext = null;
            let manualRuntimeToken = null;
            if (button) button.disabled = true;
            setStatus('현재 채팅 기록을 월드 에디셔널 전용 경로로 분석하는 중입니다…');
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const targetLore = MemoryEngine.getLorebook(targetChar, targetChat) || [];
                const scopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
                const chatId = String(targetChat?.id || '').trim();
                WorldAdditionalCore.loadState?.(targetLore, { scopeKey, chatId });

                const messages = getChatMessages(targetChat);
                const blocks = [];
                let totalChars = 0;
                for (let index = messages.length - 1; index >= 0 && blocks.length < 32; index--) {
                    const message = messages[index];
                    const raw = String(Utils.getMessageText(message) || '').trim();
                    if (!raw) continue;
                    const role = isUserLikeMessage(message) ? 'USER' : 'ASSISTANT';
                    const body = truncateForLLM(raw, 5000, ' ... ');
                    const block = `${role} [message ${index + 1}]: ${body}`;
                    if (totalChars + block.length > 30000 && blocks.length) break;
                    blocks.unshift(block);
                    totalChars += block.length;
                }
                const historyText = blocks.join('\n\n');
                if (!historyText) throw new Error('분석할 현재 채팅 기록이 없습니다.');

                const uiConfig = buildSettingsConfigFromUI();
                const analysisConfig = {
                    ...MemoryEngine.CONFIG,
                    ..._CFG,
                    ...uiConfig,
                    worldAdditionalEnabled: true,
                    worldAdditionalMode: String(uiConfig.worldAdditionalMode || 'off').toLowerCase() === 'off'
                        ? 'firm'
                        : uiConfig.worldAdditionalMode
                };
                const entityContext = Array.from(EntityManager.getEntityCache().values())
                    .slice(0, 12)
                    .map(entity => EntityManager.formatEntityForPrompt(entity?.name || entity))
                    .filter(Boolean)
                    .join('\n\n');
                activityContext = {
                    scopeKey,
                    activityDashboard: analysisConfig.activityDashboard || 'compact'
                };
                ActivityDashboardCore.beginRequest({
                    flow: 'worldAdditionalManual',
                    title: 'World Additional manual analysis',
                    stageLabel: '현재 채팅을 전용 경로로 분석합니다.',
                    status: 'running',
                    progress: 10
                }, activityContext);
                const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                const result = await TurnMaintenanceOptimizer.runWorldAdditionalManual({
                    turn,
                    historyText,
                    worldPrompt: HierarchicalWorldManager.formatForPrompt(),
                    worldStatePrompt: WorldStateTracker.formatForPrompt(),
                    narrativePrompt: NarrativeTracker.formatForPrompt(),
                    entityContext,
                    existingDirectives: WorldAdditionalCore.formatStateForAnalysis?.(4000) || '',
                    customDirective: String(analysisConfig.worldAdditionalCustomText || '').trim()
                }, analysisConfig);
                ActivityDashboardCore.update(activityContext, {
                    phase: 'worldAdditionalManual',
                    status: 'running',
                    progress: 72,
                    step: '분석 결과 저장',
                    message: '전용 분석 결과를 월드 에디셔널 DB에 반영합니다.'
                });
                if (isLibraRuntimeEpochActive()) {
                    const busyDeadline = Date.now() + 2000;
                    while (!manualRuntimeToken && Date.now() < busyDeadline) {
                        manualRuntimeToken = ScopedRuntimeTransaction.begin(scopeKey, 'world-additional:manual');
                        if (!manualRuntimeToken) await sleep(100);
                    }
                    if (!manualRuntimeToken) {
                        throw new LIBRAError('다른 LIBRA 후처리가 아직 실행 중입니다. 작업 완료 후 다시 분석해 주세요.', 'RUNTIME_BUSY');
                    }
                }
                // Rebase the analysis result onto the newest target lore while the
                // shared lore write lock is held.  A live turn may finish during the
                // LLM call; saving the pre-call array would otherwise erase that turn
                // or reset a newer World Additional state.
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    const latestScopeKey = getChatRuntimeScopeKey(latestChat, latestChar);
                    const latestChatId = String(latestChat?.id || '').trim();
                    WorldAdditionalCore.loadState?.(latestLore, {
                        scopeKey: latestScopeKey,
                        chatId: latestChatId
                    });
                    WorldAdditionalCore.ingestMaintenance(result.payload, '', {
                        turn,
                        source: result.source,
                        injectedIds: []
                    }, analysisConfig);
                    await WorldAdditionalCore.saveState(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const payload = result.payload || {};
                const added = ['sceneInterventions', 'worldDeltas', 'characterAdditions']
                    .reduce((sum, key) => sum + (Array.isArray(payload[key]) ? payload[key].length : 0), 0);
                const message = `전용 분석 완료 · 후보 ${added}개 반영`;
                setStatus(message);
                ActivityDashboardCore.finish(activityContext, 'done', message);
                toast(`✨ ${message}`);
            } catch (error) {
                const message = `전용 분석 실패: ${error?.message || error}`;
                setStatus(message);
                if (activityContext) ActivityDashboardCore.finish(activityContext, 'failed', message);
                recordRuntimeDebug('error', '[LIBRA] World Additional manual analysis failed:', error);
                toast(`❌ ${message}`);
            } finally {
                if (manualRuntimeToken) ScopedRuntimeTransaction.end(manualRuntimeToken);
                if (button) button.disabled = false;
            }
        };
        const buildUserDlcRecentHistory = (targetChat, maxChars = 10000) => {
            const blocks = [];
            let total = 0;
            const messages = getChatMessages(targetChat);
            for (let index = messages.length - 1; index >= 0 && blocks.length < 16; index--) {
                const text = String(Utils.getMessageText(messages[index]) || '').trim();
                if (!text) continue;
                const block = `${isUserLikeMessage(messages[index]) ? 'USER' : 'ASSISTANT'}: ${truncateForLLM(text, 2800, ' ... ')}`;
                if (blocks.length && total + block.length > maxChars) break;
                blocks.unshift(block); total += block.length;
            }
            return blocks.join('\n\n');
        };
        const registerUserDlcWorldElementFromGui = async () => {
            const button = overlay.querySelector('#btn-register-user-dlc-world');
            const status = overlay.querySelector('#user-dlc-world-status');
            const setStatus = text => { if (status) status.textContent = text; };
            const kind = String(overlay.querySelector('#udlc-world-kind')?.value || 'custom').trim();
            const title = String(overlay.querySelector('#udlc-world-title')?.value || '').trim();
            const userConcept = String(overlay.querySelector('#udlc-world-concept')?.value || '').trim();
            const analysisPrompt = String(overlay.querySelector('#udlc-world-prompt')?.value || '').trim();
            if (!userConcept) { setStatus('직접 등록할 세계관 요소를 입력해 주세요.'); toast('❌ 세계관 요소가 비어 있습니다'); return; }
            if (button) button.disabled = true;
            setStatus('User DLC 세계관 DB에 직접 등록 중…');
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                let savedItem = null;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    UserDlcCore.loadState?.(latestLore, { scopeKey: getChatRuntimeScopeKey(latestChat, latestChar), chatId: String(latestChat?.id || '').trim() });
                    const result = UserDlcCore.registerWorldElement?.({ kind, title, userConcept, analysisPrompt, worldFitSummary: analysisPrompt }, { turn, kind, title, userConcept, analysisPrompt });
                    if (!result?.changed || !result?.item) throw new Error('등록 가능한 세계관 요소를 만들지 못했습니다.');
                    savedItem = result.item;
                    await UserDlcCore.saveState(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const injectionLabel = savedItem?.injectionDisabled === true ? '투입 OFF' : '기존 항목의 투입 상태 유지';
                const message = `세계관 요소 “${savedItem?.title || title || '새 항목'}” 직접 등록 완료 · ${injectionLabel}`;
                setStatus(message);
                const conceptInput = overlay.querySelector('#udlc-world-concept'); if (conceptInput) conceptInput.value = '';
                const titleInput = overlay.querySelector('#udlc-world-title'); if (titleInput) titleInput.value = '';
                const promptInput = overlay.querySelector('#udlc-world-prompt'); if (promptInput) promptInput.value = '';
                toast(`➕ ${message}`);
            } catch (error) {
                const message = `세계관 요소 직접 등록 실패: ${error?.message || error}`;
                setStatus(message); recordRuntimeDebug('error', '[LIBRA] User DLC direct world registration failed:', error); toast(`❌ ${message}`);
            } finally { if (button) button.disabled = false; }
        };
        const registerUserDlcAnalysisElementFromGui = async () => {
            const button = overlay.querySelector('#btn-register-user-dlc-analysis');
            const status = overlay.querySelector('#user-dlc-entity-status');
            const setStatus = text => { if (status) status.textContent = text; };
            const label = String(overlay.querySelector('#udlc-analysis-label')?.value || '').trim() || '사용자 분석 요소';
            const content = String(overlay.querySelector('#udlc-analysis-content')?.value || '').trim();
            const selectedEntityIds = [...overlay.querySelectorAll('[data-udlc-entity-target]:checked')].map(node => String(node.value || ''));
            const selectedRelationIds = [...overlay.querySelectorAll('[data-udlc-relation-target]:checked')].map(node => String(node.value || ''));
            if (!content) { setStatus('직접 등록할 분석 요소를 입력해 주세요.'); toast('❌ 분석 요소가 비어 있습니다'); return; }
            if (!selectedEntityIds.length && !selectedRelationIds.length) { setStatus('분석 요소를 연결할 인물 또는 관계를 선택해 주세요.'); return; }
            if (button) button.disabled = true;
            setStatus('선택 대상의 누적 분석 DB에 직접 등록 중…');
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const targetLore = MemoryEngine.getLorebook(targetChar, targetChat) || [];
                const scopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
                const chatId = String(targetChat?.id || '').trim();
                EntityManager.rebuildCache(targetLore);
                UserDlcCore.loadState?.(targetLore, { scopeKey, chatId });
                const allEntities = UserDlcCore.listEntityTargets?.(targetLore) || [];
                const allRelations = UserDlcCore.listRelationTargets?.(targetLore) || [];
                const selected = [
                    ...allEntities.filter(item => selectedEntityIds.includes(String(item.id))).map(item => ({ ...item, targetType: 'entity', targetIds: [item.id] })),
                    ...allRelations.filter(item => selectedRelationIds.includes(String(item.id))).map(item => ({ ...item, targetType: 'relation', targetIds: [item.id, ...(item.entityIds || [])] }))
                ];
                if (!selected.length) throw new Error('선택 대상이 현재 LIBRA DB에서 사라졌습니다. 새로고침 후 다시 선택해 주세요.');
                const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                let savedCount = 0;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    UserDlcCore.loadState?.(latestLore, { scopeKey: getChatRuntimeScopeKey(latestChat, latestChar), chatId: String(latestChat?.id || '').trim() });
                    for (const target of selected) {
                        const result = UserDlcCore.registerTargetAnalysisElement?.({
                            targetType: target.targetType,
                            targetIds: target.targetIds,
                            displayName: target.displayName,
                            label,
                            value: content,
                            prompt: `[사용자 직접 등록] ${label}`
                        }, { turn, prompt: `[사용자 직접 등록] ${label}` });
                        if (result?.changed) savedCount += 1;
                    }
                    if (!savedCount) throw new Error('등록 가능한 분석 요소가 없습니다.');
                    await UserDlcCore.saveState(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const message = `분석 요소 “${label}” ${savedCount}개 대상에 직접 등록 완료 · 신규 항목은 투입 OFF`;
                setStatus(message);
                const labelInput = overlay.querySelector('#udlc-analysis-label'); if (labelInput) labelInput.value = '';
                const contentInput = overlay.querySelector('#udlc-analysis-content'); if (contentInput) contentInput.value = '';
                toast(`➕ ${message}`);
            } catch (error) {
                const message = `분석 요소 직접 등록 실패: ${error?.message || error}`;
                setStatus(message); recordRuntimeDebug('error', '[LIBRA] User DLC direct analysis registration failed:', error); toast(`❌ ${message}`);
            } finally { if (button) button.disabled = false; }
        };
        const registerUserDlcTrackerFromGui = async () => {
            const button = overlay.querySelector('#btn-register-user-dlc-tracker');
            const status = overlay.querySelector('#user-dlc-tracker-status');
            const setStatus = text => { if (status) status.textContent = text; };
            const label = String(overlay.querySelector('#udlc-tracker-label')?.value || '').trim();
            const instruction = String(overlay.querySelector('#udlc-tracker-instruction')?.value || '').trim();
            const allowedValues = String(overlay.querySelector('#udlc-tracker-values')?.value || '')
                .split(/[,\n]/).map(value => value.trim()).filter(Boolean).slice(0, 20);
            const updateMode = String(overlay.querySelector('#udlc-tracker-update-mode')?.value || 'relevant').trim();
            const selectedEntityIds = [...overlay.querySelectorAll('[data-udlc-entity-target]:checked')].map(node => String(node.value || ''));
            const selectedRelationIds = [...overlay.querySelectorAll('[data-udlc-relation-target]:checked')].map(node => String(node.value || ''));
            if (!label || !instruction) { setStatus('추적 항목명과 상태 판정 지시를 모두 입력해 주세요.'); return; }
            if (allowedValues.length < 2) { setStatus('unknown을 포함해 허용 상태값을 2개 이상 입력해 주세요.'); return; }
            if (!selectedEntityIds.length && !selectedRelationIds.length) { setStatus('추적기를 연결할 인물 또는 관계를 선택해 주세요.'); return; }
            if (button) button.disabled = true;
            setStatus('선택 대상에 커스텀 상태 추적기를 등록 중…');
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const targetLore = MemoryEngine.getLorebook(targetChar, targetChat) || [];
                EntityManager.rebuildCache(targetLore);
                const allEntities = UserDlcCore.listEntityTargets?.(targetLore) || [];
                const allRelations = UserDlcCore.listRelationTargets?.(targetLore) || [];
                const selected = [
                    ...allEntities.filter(item => selectedEntityIds.includes(String(item.id))).map(item => ({ ...item, targetType: 'entity', targetIds: [item.id] })),
                    ...allRelations.filter(item => selectedRelationIds.includes(String(item.id))).map(item => ({ ...item, targetType: 'relation', targetIds: [item.id, ...(item.entityIds || [])] }))
                ];
                if (!selected.length) throw new Error('선택 대상이 현재 LIBRA DB에서 사라졌습니다. 새로고침 후 다시 선택해 주세요.');
                const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                let savedCount = 0;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    UserDlcCore.loadState?.(latestLore, { scopeKey: getChatRuntimeScopeKey(latestChat, latestChar), chatId: String(latestChat?.id || '').trim() });
                    for (const target of selected) {
                        const result = UserDlcCore.registerEntityTracker?.({
                            targetType: target.targetType,
                            targetIds: target.targetIds,
                            displayName: target.displayName,
                            label,
                            instruction,
                            valueType: 'status',
                            allowedValues,
                            updateMode,
                            currentValue: 'unknown',
                            confidence: 'unknown',
                            enabled: true,
                            manualInjection: false,
                            injectionDisabled: false
                        }, { turn });
                        if (result?.changed) savedCount += 1;
                    }
                    if (!savedCount) throw new Error('등록 가능한 추적기가 없습니다.');
                    await UserDlcCore.saveState?.(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const message = `상태 추적기 “${label}” ${savedCount}개 대상에 등록 완료 · 추적 ON · 투입 ON`;
                setStatus(message);
                const labelInput = overlay.querySelector('#udlc-tracker-label'); if (labelInput) labelInput.value = '';
                const instructionInput = overlay.querySelector('#udlc-tracker-instruction'); if (instructionInput) instructionInput.value = '';
                toast(`◉ ${message}`);
            } catch (error) {
                const message = `상태 추적기 등록 실패: ${error?.message || error}`;
                setStatus(message); recordRuntimeDebug('error', '[LIBRA] User DLC tracker registration failed:', error); toast(`❌ ${message}`);
            } finally { if (button) button.disabled = false; }
        };
        let pendingUserDlcWorldPreview = null;
        const runUserDlcWorldAnalysisFromGui = async () => {
            const button = overlay.querySelector('#btn-analyze-user-dlc-world');
            const status = overlay.querySelector('#user-dlc-world-status');
            const setStatus = text => { if (status) status.textContent = text; };
            const kind = 'auto';
            const title = '';
            const userConcept = String(overlay.querySelector('#udlc-world-request')?.value || '').trim();
            const analysisPrompt = '';
            if (!userConcept) { setStatus('세계에 추가할 내용을 자연어로 입력해 주세요.'); toast('❌ 추가할 내용이 비어 있습니다'); return; }
            if (button) button.disabled = true;
            setStatus('캐릭터 로어북과 LIBRA 세계 DB에 맞춰 적응 분석 중…');
            let activityContext = null;
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const targetLore = MemoryEngine.getLorebook(targetChar, targetChat) || [];
                const scopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
                const chatId = String(targetChat?.id || '').trim();
                WorldAdditionalCore.loadState?.(targetLore, { scopeKey, chatId });
                UserDlcCore.loadState?.(targetLore, { scopeKey, chatId });
                const sourceBundle = buildCharacterWorldSourceBundle(targetChar, targetChat, 10000);
                const uiConfig = buildSettingsConfigFromUI();
                const analysisConfig = { ...MemoryEngine.CONFIG, ..._CFG, ...uiConfig };
                activityContext = { scopeKey, activityDashboard: analysisConfig.activityDashboard || 'compact' };
                ActivityDashboardCore.beginRequest({ flow: 'userDlcWorld', title: 'User DLC World adaptation', stageLabel: '세계관 적응 분석', status: 'running', progress: 12 }, activityContext);
                const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                const result = await TurnMaintenanceOptimizer.runUserDlcWorld({
                    turn, kind, title, userConcept, analysisPrompt,
                    characterWorldSources: sourceBundle.context,
                    worldPrompt: HierarchicalWorldManager.formatForPrompt(),
                    worldStatePrompt: WorldStateTracker.formatForPrompt(),
                    worldCodexPrompt: WorldAdditionalCore.formatWorldCodexForPrompt?.(5000, { maxItems: 24 }) || '',
                    entityContext: (UserDlcCore.listEntityTargets?.(targetLore) || []).slice(0, 40).map(item => `${item.id}: ${item.displayName}`).join('\n'),
                    existingDlc: UserDlcCore.formatStateForAnalysis?.(6000) || '',
                    historyText: buildUserDlcRecentHistory(targetChat, 10000)
                }, analysisConfig);
                // ── 승인 단계 ────────────────────────────────────────────────
                // 종전에는 여기서 곧바로 saveLoreToChar 로 커밋했다. 사용자가 결과를
                // 보기 전에 저장되므로 잘못 적응된 요소를 삭제로만 되돌릴 수 있었다.
                // 이제 미리보기를 보여주고, 승인해야 그때 저장한다.
                const preview = UserDlcCore.previewWorldAnalysis?.(result.payload || {}, { turn, userConcept, kind, title });
                pendingUserDlcWorldPreview = preview || null;
                ActivityDashboardCore.finish(activityContext, 'done', `미리보기 준비: ${preview?.wouldAdd ?? 0}개 추가 예정`);
                renderUserDlcWorldPreview(preview);
                setStatus(preview && preview.conflicts?.length
                    ? `⚠️ 충돌 ${preview.conflicts.length}건 — 내용을 확인하고 승인해 주세요.`
                    : `미리보기 ${preview?.items?.length ?? 0}건 — 확인 후 [추가 승인]을 눌러 주세요.`);
            } catch (error) {
                const message = `World DLC 분석 실패: ${error?.message || error}`;
                setStatus(message); if (activityContext) ActivityDashboardCore.finish(activityContext, 'failed', message);
                recordRuntimeDebug('error', '[LIBRA] User DLC World analysis failed:', error); toast(`❌ ${message}`);
            } finally { if (button) button.disabled = false; }
        };
        // 미리보기 승인/취소 — 분석과 저장을 분리한 뒤의 저장 지점.
        const approveUserDlcWorldPreview = async () => {
            const preview = pendingUserDlcWorldPreview;
            if (!preview) { toast('❌ 승인할 미리보기가 없습니다'); return; }
            const status = overlay.querySelector('#user-dlc-world-status');
            const setStatus = text => { if (status) status.textContent = text; };
            const button = overlay.querySelector('#btn-approve-user-dlc-world');
            if (button) button.disabled = true;
            setStatus('승인된 요소를 DLC DB에 저장 중…');
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                let savedCount = 0;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    UserDlcCore.loadState?.(latestLore, { scopeKey: getChatRuntimeScopeKey(latestChat, latestChar), chatId: String(latestChat?.id || '').trim() });
                    const saved = UserDlcCore.commitWorldPreview?.(preview.id, { turn });
                    savedCount = Number(saved?.added || 0);
                    if (!saved?.committed) throw new Error(saved?.reason || '미리보기 승인 저장에 실패했습니다.');
                    if (!savedCount) throw new Error('저장 가능한 World 요소가 없습니다.');
                    await UserDlcCore.saveState(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                pendingUserDlcWorldPreview = null;
                renderUserDlcWorldPreview(null);
                const message = `세계 요소 ${savedCount}개를 현재 세계관에 맞춰 추가하고 사용을 켰습니다.`;
                setStatus(message); toast(`✨ ${message}`);
                const requestInput = overlay.querySelector('#udlc-world-request'); if (requestInput) requestInput.value = '';
            } catch (error) {
                const message = `저장 실패: ${error?.message || error}`;
                setStatus(message);
                recordRuntimeDebug('error', '[LIBRA] User DLC preview commit failed:', error); toast(`❌ ${message}`);
            } finally { if (button) button.disabled = false; }
        };
        const cancelUserDlcWorldPreview = () => {
            const preview = pendingUserDlcWorldPreview;
            try { UserDlcCore.discardWorldPreview?.(preview?.id || null); } catch (_) {}
            pendingUserDlcWorldPreview = null;
            renderUserDlcWorldPreview(null);
            const status = overlay.querySelector('#user-dlc-world-status');
            if (status) status.textContent = '취소했습니다. 아무것도 저장되지 않았습니다.';
            toast('↩️ 추가를 취소했습니다 (DB 변경 없음)');
        };
        // 미리보기 카드 렌더 — 승인 판단에 필요한 것만 보여준다.
        const renderUserDlcWorldPreview = (preview = null) => {
            const box = overlay.querySelector('#user-dlc-world-preview');
            if (!box) return;
            if (!preview) { box.innerHTML = ''; return; }
            const items = Array.isArray(preview.items) ? preview.items : [];
            const rows = items.map(item => {
                const tone = item.blocked ? 'wa-preview-blocked' : 'wa-preview-ok';
                const badge = item.blocked
                    ? `<span class="bdg bt">${esc(item.duplicate ? '중복' : '충돌')}</span>`
                    : '<span class="bdg bm">추가 예정</span>';
                const detail = [
                    item.adaptedConcept ? `적응: ${item.adaptedConcept}` : '',
                    item.mechanism ? `작동: ${item.mechanism}` : '',
                    item.trigger ? `발동: ${item.trigger}` : '',
                    item.counterplay ? `대응책: ${item.counterplay}` : ''
                ].filter(Boolean).join('\n');
                const conflictLine = item.conflicts?.length
                    ? `<div class="hint" style="color:var(--danger,#d66)">⚠️ ${esc(item.conflicts.join(' / '))}</div>`
                    : '';
                return `<div class="card ${tone}" style="margin-bottom:8px">
                    <div class="card-hdr">
                      <div><div class="card-meta">${badge}<span class="bdg bl">${esc(item.kind || '')}</span></div><div class="card-title">${esc(item.title)}</div></div>
                    </div>
                    ${detail ? `<div style="white-space:pre-wrap;word-break:break-word;color:var(--text2);font-size:var(--fs-label);line-height:1.5">${esc(detail)}</div>` : ''}
                    ${conflictLine}
                    <div class="hint" style="margin-top:6px">${esc(item.reason || '')}</div>
                  </div>`;
            }).join('');
            const summary = [
                `추가 예정 ${preview.wouldAdd ?? 0}개`,
                preview.blocked ? `차단 ${preview.blocked}개` : '',
                preview.conflicts?.length ? `충돌 ${preview.conflicts.length}건` : ''
            ].filter(Boolean).join(' · ');
            box.innerHTML = `<div class="wa-group">
                <div class="wa-group-title"><span>추가 미리보기</span><span class="wa-tab-count">${esc(String(items.length))}</span></div>
                <div class="hint" style="margin:4px 0 8px">${esc(summary)} — 승인하면 저장하고, 취소하면 아무것도 저장되지 않습니다.</div>
                <div class="list">${rows || '<div class="empty">추가할 요소가 없습니다</div>'}</div>
                <div class="toolbar" style="margin-top:8px">
                  <button class="btn bp" id="btn-approve-user-dlc-world" type="button">✅ 추가 승인</button>
                  <button class="btn bd" id="btn-cancel-user-dlc-world" type="button">취소</button>
                </div>
              </div>`;
            box.querySelector('#btn-approve-user-dlc-world')?.addEventListener('click', () => { void approveUserDlcWorldPreview(); });
            box.querySelector('#btn-cancel-user-dlc-world')?.addEventListener('click', () => { cancelUserDlcWorldPreview(); });
        };
        const normalizeUserDlcIdentityKey = (value = '') => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
        const collectUserDlcEntityIdentityKeys = (item = {}) => {
            const raw = item?.raw && typeof item.raw === 'object' ? item.raw : {};
            const aliases = [
                ...(Array.isArray(raw.aliases) ? raw.aliases : []),
                ...(Array.isArray(raw.alias) ? raw.alias : []),
                raw.alias, raw.nickname
            ];
            return new Set([
                item.id, item.displayName, raw.id, raw.entityId, raw.name, raw.displayName, raw.canonicalName,
                ...aliases
            ].map(normalizeUserDlcIdentityKey).filter(Boolean));
        };
        const buildUserDlcRelatedRelationRecords = (selectedEntities = [], allRelations = []) => {
            const selectedKeys = new Set(selectedEntities.flatMap(item => [...collectUserDlcEntityIdentityKeys(item)]));
            return allRelations.map(relation => {
                const raw = relation?.raw && typeof relation.raw === 'object' ? relation.raw : {};
                const endpoints = Array.isArray(relation?.entityIds) && relation.entityIds.length
                    ? relation.entityIds
                    : [raw.entityA, raw.entityB, raw.from, raw.to, raw.source, raw.target];
                const endpointKeys = endpoints.map(normalizeUserDlcIdentityKey).filter(Boolean);
                const matchedEndpoints = endpointKeys.filter(key => selectedKeys.has(key)).length;
                if (!matchedEndpoints) return null;
                let promptContext = '';
                try { promptContext = EntityManager.formatRelationForPrompt?.(raw) || JSON.stringify(raw); }
                catch (_) { promptContext = JSON.stringify(raw || relation); }
                return {
                    id: String(relation.id || ''),
                    displayName: String(relation.displayName || ''),
                    entityIds: Array.isArray(relation.entityIds) ? relation.entityIds.map(String) : endpoints.map(String).filter(Boolean),
                    promptContext,
                    priority: matchedEndpoints >= 2 ? 2 : 1
                };
            }).filter(Boolean)
                .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || a.displayName.localeCompare(b.displayName))
                .slice(0, 24);
        };
        const syncUserDlcRetargetEditor = () => {
            const banner = overlay.querySelector('#user-dlc-retarget-banner');
            const bannerText = overlay.querySelector('#user-dlc-retarget-banner-text');
            const analyzeButton = overlay.querySelector('#btn-analyze-user-dlc-entity');
            if (banner) banner.style.display = activeUserDlcRetargetEdit ? '' : 'none';
            if (bannerText) bannerText.textContent = activeUserDlcRetargetEdit
                ? `“${activeUserDlcRetargetEdit.label}” 추적 요소의 대상 인물을 편집 중입니다. 체크를 해제한 인물의 기존 데이터는 삭제하지 않고 보관합니다.`
                : '';
            if (analyzeButton) analyzeButton.textContent = activeUserDlcRetargetEdit ? '↻ 대상 구성으로 재분석·재추적' : '✨ 추가하고 사용';
        };
        const cancelUserDlcTrackerRetargetFromGui = () => {
            activeUserDlcRetargetEdit = null;
            syncUserDlcRetargetEditor();
            const status = overlay.querySelector('#user-dlc-entity-status');
            if (status) status.textContent = '대상 편집을 취소했습니다. 기존 추적 데이터는 변경되지 않았습니다.';
        };
        const beginUserDlcTrackerRetargetFromGui = (trackerId = '') => {
            const sourceId = String(trackerId || '').trim();
            const trackers = UserDlcCore.getState?.()?.entityTrackers || [];
            const source = trackers.find(item => String(item.id || '') === sourceId);
            if (!source) { toast('❌ 편집할 추적 요소를 찾지 못했습니다.'); return false; }
            const groupId = String(source.analysisGroupId || '').trim();
            const members = groupId
                ? trackers.filter(item => String(item.analysisGroupId || '') === groupId)
                : [source];
            const activeMembers = members.filter(item => item.membershipActive !== false);
            refreshUserDlcTargetLists({ preserveSelection: false, announce: false });
            const entityTargets = UserDlcCore.listEntityTargets?.(Array.isArray(effectiveGuiLore) ? effectiveGuiLore : lore) || [];
            const selectedEntityIds = new Set();
            activeMembers.forEach(member => {
                const memberKeys = new Set([...(member.targetIds || []), member.displayName].map(normalizeUserDlcIdentityKey).filter(Boolean));
                const matched = entityTargets.find(entity => [...collectUserDlcEntityIdentityKeys(entity)].some(key => memberKeys.has(key)));
                if (matched) selectedEntityIds.add(String(matched.id));
            });
            overlay.querySelectorAll('[data-udlc-entity-target]').forEach(input => {
                input.checked = selectedEntityIds.has(String(input.value || ''));
            });
            const requestInput = overlay.querySelector('#udlc-entity-request');
            if (requestInput) requestInput.value = String(source.userRequest || source.instruction || '').trim();
            activeUserDlcRetargetEdit = {
                sourceTrackerId: source.id,
                analysisGroupId: groupId,
                label: source.label || '추가 요소',
                existingTrackers: members.map(item => ({ ...item }))
            };
            syncUserDlcRetargetEditor();
            const status = overlay.querySelector('#user-dlc-entity-status');
            if (status) status.textContent = `현재 활성 대상 ${activeMembers.length}명 · 인물을 추가하거나 체크 해제한 뒤 재분석해 주세요.`;
            requestInput?.focus?.();
            requestInput?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
            return true;
        };
        const runUserDlcEntityAnalysisFromGui = async () => {
            const button = overlay.querySelector('#btn-analyze-user-dlc-entity');
            const status = overlay.querySelector('#user-dlc-entity-status');
            const setStatus = text => { if (status) status.textContent = text; };
            const analysisPrompt = String(overlay.querySelector('#udlc-entity-request')?.value || '').trim();
            const selectedEntityIds = [...overlay.querySelectorAll('[data-udlc-entity-target]:checked')].map(node => String(node.value || ''));
            const retargetEdit = activeUserDlcRetargetEdit ? { ...activeUserDlcRetargetEdit } : null;
            if (!analysisPrompt) { setStatus('추가할 상황·반응·추적 요소를 자연어로 입력해 주세요.'); return; }
            if (!selectedEntityIds.length) { setStatus('반응을 분석할 인물을 한 명 이상 선택해 주세요.'); return; }
            if (button) button.disabled = true;
            setStatus(retargetEdit
                ? `기존 데이터를 유지하며 선택한 인물 ${selectedEntityIds.length}명으로 재분석 중…`
                : `선택한 인물 ${selectedEntityIds.length}명을 관계 DB에 연결해 분할 분석 중…`);
            let activityContext = null;
            try {
                const { targetChar, targetChat } = await resolveGuiTargetContext();
                const targetLore = MemoryEngine.getLorebook(targetChar, targetChat) || [];
                const scopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
                const chatId = String(targetChat?.id || '').trim();
                EntityManager.rebuildCache(targetLore);
                WorldAdditionalCore.loadState?.(targetLore, { scopeKey, chatId });
                UserDlcCore.loadState?.(targetLore, { scopeKey, chatId });
                const allEntities = UserDlcCore.listEntityTargets?.(targetLore) || [];
                const allRelations = UserDlcCore.listRelationTargets?.(targetLore) || [];
                const selected = allEntities
                    .filter(item => selectedEntityIds.includes(String(item.id)))
                    .map(item => ({ ...item, targetType: 'entity', targetIds: [String(item.id)] }));
                if (selected.length !== selectedEntityIds.length) throw new Error('선택한 인물 일부가 현재 LIBRA DB에서 사라졌습니다. 새로고침 후 다시 선택해 주세요.');
                const selectedTargetRecords = selected.map(item => {
                    let promptContext = '';
                    try {
                        promptContext = EntityManager.formatEntityForPrompt?.(item.raw?.name || item.raw) || JSON.stringify(item.raw);
                    } catch (_) { promptContext = JSON.stringify(item.raw || item); }
                    return { targetType: 'entity', targetIds: item.targetIds, displayName: item.displayName, promptContext };
                });
                const selectedTargets = selectedTargetRecords
                    .map(item => JSON.stringify({ targetType: 'entity', targetIds: item.targetIds, displayName: item.displayName }))
                    .join('\n');
                const entityContext = selectedTargetRecords.map(item => item.promptContext).filter(Boolean).join('\n\n');
                const relationContextRecords = buildUserDlcRelatedRelationRecords(selected, allRelations);
                const relationContext = relationContextRecords.map(item => item.promptContext).filter(Boolean).join('\n\n');
                const sourceBundle = buildCharacterWorldSourceBundle(targetChar, targetChat, 10000);
                const uiConfig = buildSettingsConfigFromUI();
                const analysisConfig = { ...MemoryEngine.CONFIG, ..._CFG, ...uiConfig };
                activityContext = { scopeKey, activityDashboard: analysisConfig.activityDashboard || 'compact' };
                ActivityDashboardCore.beginRequest({ flow: 'userDlcEntity', title: 'User DLC Character analysis', stageLabel: '다중 인물 분할·관계 기반 분석', status: 'running', progress: 12 }, activityContext);
                const turn = MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0;
                const timeState = typeof TimeEngine !== 'undefined' ? (TimeEngine.getState?.() || {}) : {};
                const result = await TurnMaintenanceOptimizer.runUserDlcEntity({
                    turn, selectedTargets, selectedTargetRecords, analysisPrompt, entityContext,
                    relationContext, relationContextRecords,
                    storyClock: JSON.stringify({ currentDate: timeState.currentDate || '', currentTime: timeState.currentTime || '', currentLabel: timeState.currentLabel || '', sceneTurn: Number(timeState.sceneTurn || turn) || turn }),
                    characterWorldSources: sourceBundle.context,
                    worldPrompt: HierarchicalWorldManager.formatForPrompt(),
                    worldStatePrompt: WorldStateTracker.formatForPrompt(),
                    worldCodexPrompt: WorldAdditionalCore.formatWorldCodexForPrompt?.(5000, { maxItems: 24 }) || '',
                    existingDlc: [
                        retargetEdit ? JSON.stringify({ retargeting: true, sourceTrackerId: retargetEdit.sourceTrackerId, existingTrackers: retargetEdit.existingTrackers || [] }) : '',
                        UserDlcCore.formatStateForAnalysis?.(6000) || ''
                    ].filter(Boolean).join('\n'),
                    retargeting: !!retargetEdit,
                    historyText: buildUserDlcRecentHistory(targetChat, 10000)
                }, analysisConfig);
                ActivityDashboardCore.update(activityContext, { phase: 'userDlcEntity', status: 'running', progress: 76, step: '완전성 검증 후 저장', message: '모든 선택 인물의 결과를 정확한 인물 ID에 연결합니다.' });
                let savedCount = 0;
                let retargetResult = null;
                await saveLoreToChar(async (latestLore, { targetChar: latestChar, targetChat: latestChat }) => {
                    UserDlcCore.loadState?.(latestLore, { scopeKey: getChatRuntimeScopeKey(latestChat, latestChar), chatId: String(latestChat?.id || '').trim() });
                    const payload = { ...(result.payload || {}) };
                    const rawAdaptive = payload.adaptiveItems || payload.adaptive_items || payload.entityTrackers || payload.entity_trackers || payload.trackers || [];
                    const trackingRequested = /(?:계속|지속|매\s*턴|자동\s*갱신|추적)/i.test(analysisPrompt);
                    const analysisGroupId = retargetEdit?.analysisGroupId || `udlc_group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
                    payload.adaptiveItems = (Array.isArray(rawAdaptive) ? rawAdaptive : []).map((adaptive, index) => {
                        const ids = Array.isArray(adaptive?.targetIds) ? adaptive.targetIds.map(String) : [];
                        const match = selected.find(item => ids.includes(String(item.id)) || String(item.displayName) === String(adaptive?.displayName));
                        const kind = String(adaptive?.kind || adaptive?.trackerKind || 'state').toLowerCase();
                        const continuousByKind = ['relationship_model', 'reproductive_health', 'health_risk', 'sexual_history'].includes(kind);
                        const trackingEnabled = !!retargetEdit || adaptive?.trackingEnabled === true || adaptive?.trackingRecommended === true || continuousByKind || trackingRequested;
                        return match ? {
                            ...adaptive,
                            targetType: match.targetType,
                            targetIds: match.targetIds,
                            displayName: match.displayName,
                            kind,
                            userRequest: analysisPrompt,
                            instruction: adaptive?.instruction || `현재 LIBRA 인물·관계 DB와 극중 시간에 근거해 다음 요청을 평가한다: ${analysisPrompt}`,
                            analysisGroupId,
                            membershipActive: true,
                            trackingEnabled,
                            updateMode: trackingEnabled ? 'every_turn' : 'manual',
                            useEnabled: adaptive?.useEnabled !== false
                        } : null;
                    }).filter(Boolean);
                    let saved = [];
                    if (retargetEdit) {
                        const reconciled = UserDlcCore.reconcileTrackerTargets?.(
                            retargetEdit.sourceTrackerId,
                            payload,
                            selected.map(item => String(item.id)),
                            { turn, userRequest: analysisPrompt }
                        ) || {};
                        if (reconciled.changed !== true) throw new Error(`기존 추적 요소의 대상 구성을 갱신하지 못했습니다: ${reconciled.reason || 'unknown'}`);
                        saved = Array.isArray(reconciled.active) ? reconciled.active : [];
                        retargetResult = reconciled;
                    } else {
                        saved = UserDlcCore.ingestAdaptiveItems?.(payload, { turn, userRequest: analysisPrompt, analysisGroupId }) || [];
                    }
                    if (!retargetEdit && !saved.length) {
                        const rawAnalyses = payload.targetAnalyses || payload.target_analyses || payload.analyses || [];
                        payload.targetAnalyses = (Array.isArray(rawAnalyses) ? rawAnalyses : []).map((analysis, index) => {
                            const ids = Array.isArray(analysis?.targetIds) ? analysis.targetIds.map(String) : [];
                            const match = selected.find(item => ids.includes(String(item.id)) || String(item.displayName) === String(analysis?.displayName));
                            return match ? { ...analysis, targetType: 'entity', targetIds: match.targetIds, displayName: match.displayName, prompt: analysisPrompt } : null;
                        }).filter(Boolean);
                        const legacySaved = UserDlcCore.ingestTargetAnalysis(payload, { turn, prompt: analysisPrompt });
                        saved = legacySaved.map(entry => entry?.item).filter(Boolean).map(item => UserDlcCore.registerEntityTracker?.({
                            targetType: item.targetType, targetIds: item.targetIds, displayName: item.displayName,
                            kind: 'scenario_response', label: item.findings?.[0]?.label || '상황별 예상 반응',
                            userRequest: analysisPrompt, instruction: analysisPrompt, valueType: 'text', currentValue: item.summary || item.findings?.[0]?.value || '분석 완료',
                            currentSnapshot: { summary: item.summary || item.findings?.[0]?.value || '분석 완료' }, trackingEnabled: trackingRequested, updateMode: trackingRequested ? 'every_turn' : 'manual', useEnabled: true
                        }, { turn })).filter(entry => entry?.changed);
                    }
                    savedCount = saved.length;
                    if (!savedCount) throw new Error('분석 결과에 저장 가능한 대상 분석이 없습니다.');
                    await UserDlcCore.saveState(latestLore);
                    return latestLore;
                }, renderWorldAdditional);
                const batchNote = Number(result?.batchCount || 1) > 1 ? ` · ${result.batchCount}개 배치` : '';
                const retryNote = Number(result?.coverageRetryCount || 0) > 0 ? ` · 누락 재분석 ${result.coverageRetryCount}회` : '';
                const message = retargetEdit
                    ? `추적 대상 재구성 완료 · 활성 ${savedCount}명 · 새로 추가 ${Number(retargetResult?.added || 0)}명 · 제외 데이터 보관 ${Number(retargetResult?.archived?.length || 0)}명${batchNote}${retryNote}.`
                    : `선택 인물 ${selected.length}명에 추가 요소 ${savedCount}개를 만들고 사용을 켰습니다${batchNote}${retryNote}.`;
                setStatus(message); ActivityDashboardCore.finish(activityContext, 'done', message); toast(`🔗 ${message}`);
                if (retargetEdit) { activeUserDlcRetargetEdit = null; syncUserDlcRetargetEditor(); }
                const requestInput = overlay.querySelector('#udlc-entity-request'); if (requestInput) requestInput.value = '';
            } catch (error) {
                const message = `인물 DLC 분석 실패: ${error?.message || error}`;
                setStatus(message); if (activityContext) ActivityDashboardCore.finish(activityContext, 'failed', message);
                recordRuntimeDebug('error', '[LIBRA] User DLC Entity analysis failed:', error); toast(`❌ ${message}`);
            } finally { if (button) button.disabled = false; }
        };
        const refreshSectionWorldLensFromGui = async (force = false) => {
            if (!_CFG?.sectionWorldInferenceEnabled) return false;
            if (!force && SectionWorldInferenceManager.getLastPrompt()) return true;
            const worldPrompt = HierarchicalWorldManager.formatForPrompt();
            const worldStatePrompt = WorldStateTracker.formatForPrompt();
            const narrativePrompt = NarrativeTracker.formatForPrompt();
            const sourceBundle = buildCharacterWorldSourceBundle(char, chat, 5000);
            if (!worldPrompt && !worldStatePrompt && !narrativePrompt && !sourceBundle.context) return false;
            const activeUser = String(_lastUserMessage || _lastUserMessageRaw || '').trim();
            const focusCharacters = Array.from(EntityManager.getEntityCache().values()).slice(0, 6).map(entity => String(entity?.name || '').trim()).filter(Boolean);
            await SectionWorldInferenceManager.inferPrompt(_CFG, {
                turn: MemoryEngine.getCurrentTurn(),
                userMsg: activeUser,
                worldPrompt,
                worldStatePrompt,
                narrativePrompt,
                focusCharacters,
                memoryHints: [],
                loreHints: sourceBundle.context
                    ? [`[Character Description and Character Lorebook]\n${sourceBundle.context}`]
                    : []
            });
            renderWorld();
            renderWorldAdditional();
            return true;
        };
