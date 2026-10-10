        // 3. 자바스크립트로 직접 이벤트 연결 (Event Delegation)
        let settingsAutoSaveTimer = null;
        let settingsAutoSaveDirty = false;
        let settingsAutoSaveChangeRevision = 0;
        let settingsAutoSaveRevision = 0;
        let settingsAutoSaveQueue = Promise.resolve();
        const setSettingsAutoSaveStatus = (message = '', state = 'idle') => {
            const node = overlay.querySelector('#settings-auto-save-status');
            if (!node) return;
            node.textContent = message || '전역 설정 자동 저장 켜짐';
            node.dataset.state = state;
        };
        const applyPersistedSettingsConfig = (cfg = {}, reason = 'settings-auto-save', changedPaths = null) => {
            // Ordinary saves pass an already patched latest live layer; replacement/import remain explicit.
            Object.assign(MemoryEngine.CONFIG, cfg);
            const changed = path => changedPaths === null || changedPaths.has(path);
            if (changedPaths === null || Array.from(changedPaths).some(path => path.startsWith('embed.') || path.startsWith('dualRecall'))) {
                MemoryEngine.EmbeddingEngine.noteConfigurationPublished();
                if (reason !== 'settings-portable-import') {
                    TypedRecallRollout.configureProduction(MemoryEngine.CONFIG);
                    syncDualRecallReadiness();
                }
            }
            _CFG = { ...MemoryEngine.CONFIG };
            syncSimpleSettingsIntentStatus();
            if (changed('debug')) syncDebugRecordStatus();
            if (changed('useLLM')) syncAnalysisUseStatus();
            if (changed('responseStreamingCompatEnabled') && MemoryEngine.CONFIG.responseStreamingCompatEnabled !== false) {
                try { ensureResponseStreamingCompatibilityHandlers?.(); } catch (_) {}
            }
            if (changed('entityBlocklist')) { applyGuiEntityBlocklistToLocalSnapshots(); renderEnts(); }
            if (changed('worldAdditionalMaxPerRequest') || changed('storyAuthorMode') || changed('directorMode')) renderWorldAdditional();
            renderHome();
        };
        const persistGlobalSettingsFromUI = ({ reason = 'settings-auto-save', notify = false } = {}) => {
            if (settingsAutoSaveTimer) { clearTimeout(settingsAutoSaveTimer); settingsAutoSaveTimer = null; }
            const revision = ++settingsAutoSaveRevision;
            const changeRevision = settingsAutoSaveChangeRevision;
            const viewReplacementRevision = settingsViewReplacementRevision;
            let view, patch;
            try {
                view = readGeneralSettingsControlView();
                patch = generalSettingsPatchFromView(view);
            } catch (error) {
                settingsAutoSaveDirty = true;
                setSettingsAutoSaveStatus(`자동 저장 대기 · ${error?.message || error}`, 'failed');
                if (notify) toast(`❌ 저장 실패: ${error?.message || error}`);
                return Promise.resolve(false);
            }
            if (!patch.size) {
                settingsAutoSaveDirty = false;
                setSettingsAutoSaveStatus('저장할 변경 없음', 'saved');
                if (notify) toast('저장할 변경 없음');
                return settingsAutoSaveQueue.then(() => true);
            }
            setSettingsAutoSaveStatus('전역 설정 저장 중…', 'saving');
            const task = queueCommonPluginSettingsMutation(async () => {
                if (viewReplacementRevision !== commonSettingsReplacementRevision) {
                    throw new Error('이전 화면의 저장을 중단했습니다. 가져오기·초기화 결과를 확인한 후 설정 화면을 다시 열거나 변경해 주세요.');
                }
                // The saved layer has no runtime/default fallback. Only explicit edited paths are added.
                const current = await readCommonPluginSettingsForMutation({});
                const nextConfig = canonicalSettingsForStorage(applyOwnedGeneralSettingsPatch(current, patch));
                try { await writeCommonPluginSettings(JSON.stringify(nextConfig)); }
                catch (error) {
                    if (error?.settingsStorageUnverified === true) commonSettingsReplacementRevision += 1;
                    throw error;
                }
                captureSavedInjectionBudgetSettings(nextConfig);
                const changedPaths = new Set(patch.keys());
                applyPersistedSettingsConfig(applyOwnedGeneralSettingsPatch(MemoryEngine.CONFIG, patch), reason, changedPaths);
                if (revision === settingsAutoSaveRevision && changeRevision === settingsAutoSaveChangeRevision) {
                    acceptGeneralSettingsView(view, changeRevision);
                    settingsAutoSaveDirty = false;
                    const savedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    setSettingsAutoSaveStatus(`자동 저장됨 · ${savedAt}`, 'saved');
                }
                // Do not log the full configuration/profile/provider payload during an unrelated save.
                recordRuntimeDebug('warn', `[LIBRA Debug] ${notify ? 'Saved' : 'Auto-saved'} settings fields:`, Array.from(changedPaths));
                if (notify) toast('💾 설정 저장됨');
                return true;
            });
            settingsAutoSaveQueue = task.catch(() => {});
            return task.catch(error => {
                settingsAutoSaveDirty = true;
                if (revision === settingsAutoSaveRevision && changeRevision === settingsAutoSaveChangeRevision) {
                    setSettingsAutoSaveStatus(`자동 저장 실패 · ${error?.message || error}`, 'failed');
                    syncAnalysisUseStatus();
                }
                if (notify) toast(`❌ 저장 실패: ${error?.message || error}`);
                else toast(`❌ 전역 설정 자동 저장 실패: ${error?.message || error}`);
                return false;
            });
        };
        const scheduleGlobalSettingsAutoSave = (reason = 'settings-change', delay = 600) => {
            settingsAutoSaveDirty = true;
            settingsAutoSaveChangeRevision += 1;
            if (settingsAutoSaveTimer) clearTimeout(settingsAutoSaveTimer);
            setSettingsAutoSaveStatus('변경 감지 · 자동 저장 대기 중', 'pending');
            settingsAutoSaveTimer = setTimeout(() => {
                settingsAutoSaveTimer = null;
                void persistGlobalSettingsFromUI({ reason });
            }, Math.max(0, Number(delay) || 0));
        };
        const flushPendingGlobalSettingsAutoSave = (reason = 'settings-flush') => {
            if (!settingsAutoSaveDirty && !settingsAutoSaveTimer) return settingsAutoSaveQueue;
            return persistGlobalSettingsFromUI({ reason });
        };
        const settleGlobalSettingsAutoSaveBeforeReplace = async () => {
            if (settingsAutoSaveTimer) {
                clearTimeout(settingsAutoSaveTimer);
                settingsAutoSaveTimer = null;
            }
            settingsAutoSaveDirty = false;
            settingsAutoSaveChangeRevision += 1;
            settingsAutoSaveRevision += 1;
            await settingsAutoSaveQueue.catch(() => {});
        };
        const isGlobalSettingsAutoSaveControl = target => {
            if (!(target instanceof Element) || !target.matches('input, select, textarea')) return false;
            if (!target.closest('#tab-settings, [data-global-settings]')) return false;
            if (target.closest('[data-wm-storage-controls]')) return false;
            if (target.matches('#settings-file-input, #sdebug, [type="file"], [type="button"], [type="submit"], [readonly], [disabled]')) return false;
            if (target.matches('[data-vertex-json-paste], [data-vertex-json-preview]')) return false;
            return Object.prototype.hasOwnProperty.call(generalSettingsControls, target.id);
        };
        overlay.querySelector('#xbtn').onclick = () => {
            closeGuiOverlay();
        };
        overlay.addEventListener('input', (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            if (target.matches('.rC-val, .rR-val')) {
                target.dataset.unset = '0';
                return;
            }
        });
        overlay.addEventListener('change', (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            if (target.matches('#ar-score-enabled')) {
                syncAddRelationScoreControls();
                return;
            }
        });
        overlay.addEventListener('input', event => {
            const target = event.target;
            if (!isGlobalSettingsAutoSaveControl(target)) return;
            markGeneralSettingsControlDirty(target);
            if (target.id === 's-use-llm') syncAnalysisUseStatus();
            scheduleGlobalSettingsAutoSave('settings-input', 600);
        });
        overlay.addEventListener('change', event => {
            const target = event.target;
            if (!isGlobalSettingsAutoSaveControl(target)) return;
            markGeneralSettingsControlDirty(target);
            if (target.id === 's-use-llm') syncAnalysisUseStatus();
            scheduleGlobalSettingsAutoSave('settings-change', 0);
        });
        overlay.addEventListener('wm-gui-dispose', disposeOperationalLogView);
        overlay.addEventListener('wm-gui-dispose', () => { dismissCommonAiLeaveRequest(); document.removeEventListener('keydown', onGuiKeydown); });
        overlay.querySelector('#oplog-search')?.addEventListener('input', renderOperationalLogView);
        overlay.querySelector('#oplog-filter')?.addEventListener('change', renderOperationalLogView);
        overlay.querySelector('#oplog-events')?.addEventListener('click', event => {
            const row = event.target?.closest?.('[data-oplog-event]');
            if (!row || operationalLogState.scope !== operationalLogScope()) { renderOperationalLogView(); return; }
            operationalLogState.selectedEventId = String(row.dataset.oplogEvent || '');
            renderOperationalLogView();
        });
        overlay.querySelector('#btn-oplog-clear')?.addEventListener('click', () => {
            const scope = operationalLogScope();
            if (!scope || scope !== operationalLogState.scope) { renderOperationalLogView(); return; }
            const result = DebugExportManager.clearOperationalDisplay(scope);
            const status = overlay.querySelector('#oplog-status');
            if (status) status.textContent = `표시 기록 ${result.removed}개를 비웠습니다. 진행 중인 분석과 저장 데이터는 유지됩니다.`;
            renderOperationalLogView();
        });
        overlay.querySelectorAll('.side-link').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
        overlay.querySelectorAll('[data-view-tab]').forEach(button => {
            button.addEventListener('click', () => switchTab(button.dataset.viewTab));
        });
        // 인물 프로필 상세 — 목록의 이름을 누르면 열린다.
        overlay.addEventListener('click', (event) => {
            const link = event.target?.closest?.('[data-ent-profile]');
            if (link && overlay.contains(link)) {
                renderEntityProfile(Number(link.dataset.entProfile) || 0);
                return;
            }
            const nar = event.target?.closest?.('[data-nar-detail]');
            if (nar && overlay.contains(nar)) {
                renderNarrativeDetail(Number(nar.dataset.narDetail) || 0);
                return;
            }
            const wld = event.target?.closest?.('[data-wld-detail]');
            if (wld && overlay.contains(wld)) {
                renderWorldDetail(String(wld.dataset.wldDetail || ''));
                return;
            }
            const back = event.target?.closest?.('[data-back]');
            if (back && overlay.contains(back)) {
                event.preventDefault();
                switchTab(String(back.dataset.back || 'entity'));
            }
        });
        // 세계선 새로고침 — 렌더만 다시 돈다(추가 분석 호출 없음).
        overlay.querySelector('#wl-refresh')?.addEventListener('click', () => {
            const pane = renderWorldlinePane;
            if (typeof pane === 'function') pane();
        });
        // 세계관 탐색기 — 검색·칩은 노드 카드 목록을 클라이언트에서 거른다(추가 분석 호출 없음).
        const wldState = { query: '', filter: 'all' };
        const applyWorldFilter = () => {
            const cards = overlay.querySelectorAll('#wld-list .wld-node-card');
            let shown = 0;
            cards.forEach(card => {
                const hay = String(card.textContent || '').toLowerCase();
                const qOk = !wldState.query || hay.includes(wldState.query);
                const isActive = card.dataset.wldActive === '1';
                const fOk = wldState.filter === 'all' ? true
                    : wldState.filter === 'active' ? isActive
                        : !isActive;
                const visible = qOk && fOk;
                card.hidden = !visible;
                if (visible) shown += 1;
            });
            const count = overlay.querySelector('#wld-count');
            if (count && cards.length) count.textContent = shown === cards.length ? `노드 ${shown}개` : `노드 ${shown}개 표시`;
            const empty = overlay.querySelector('#wld-empty');
            if (empty) empty.hidden = shown !== 0;
        };
        overlay.querySelector('#wld-search')?.addEventListener('input', (event) => {
            wldState.query = String(event.target.value || '').trim().toLowerCase();
            applyWorldFilter();
        });
        overlay.querySelectorAll('#wld-filter [data-wld-filter]').forEach(button => {
            button.addEventListener('click', () => {
                wldState.filter = String(button.dataset.wldFilter || 'all');
                overlay.querySelectorAll('#wld-filter [data-wld-filter]').forEach(x => x.classList.toggle('on', x === button));
                applyWorldFilter();
            });
        });
        // 인물 탐색기 — 검색·초성 인덱스·밀도 전환은 클라이언트 필터다(추가 분석 호출 없음).
        const entFilterState = { query: '', index: 'all', density: 'cards' };
        const applyEntityFilter = () => {
            const list = overlay.querySelector('#el');
            if (!list) return;
            list.classList.toggle('density-cards', entFilterState.density === 'cards');
            list.classList.toggle('density-list', entFilterState.density === 'list');
            const CHOLIST = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
            const cho = (name) => {
                const ch = String(name || '').trim().charAt(0);
                const code = ch.charCodeAt(0);
                if (code >= 0xAC00 && code <= 0xD7A3) return CHOLIST[Math.floor((code - 0xAC00) / 588)];
                if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
                if (/[0-9]/.test(ch)) return '#';
                return ch ? '·' : '';
            };
            let shown = 0;
            list.querySelectorAll('.card.ent').forEach(card => {
                const nameNode = card.querySelector('.card-hdr strong');
                const name = String(nameNode?.textContent || '').trim();
                const hay = card.textContent.toLowerCase();
                const qOk = !entFilterState.query || hay.includes(entFilterState.query);
                const iOk = entFilterState.index === 'all' || cho(name) === entFilterState.index;
                const visible = qOk && iOk;
                card.hidden = !visible;
                if (visible) shown += 1;
            });
            const count = overlay.querySelector('#ent-count');
            if (count) count.textContent = shown === list.querySelectorAll('.card.ent').length
                ? `인물 ${shown}명`
                : `인물 ${shown}명 표시`;
        };
        overlay.querySelector('#ent-search')?.addEventListener('input', (event) => {
            entFilterState.query = String(event.target.value || '').trim().toLowerCase();
            applyEntityFilter();
        });
        overlay.querySelectorAll('#ent-index [data-ent-index]').forEach(button => {
            button.addEventListener('click', () => {
                entFilterState.index = String(button.dataset.entIndex || 'all');
                overlay.querySelectorAll('#ent-index [data-ent-index]').forEach(x => x.classList.toggle('on', x === button));
                applyEntityFilter();
            });
        });
        overlay.querySelectorAll('[data-density]').forEach(button => {
            button.addEventListener('click', () => {
                entFilterState.density = String(button.dataset.density || 'cards');
                overlay.querySelectorAll('[data-density]').forEach(x => x.classList.toggle('on', x === button));
                applyEntityFilter();
            });
        });
        // 관계 탐색기 — 인물 탐색기와 같은 패턴(상태 객체 하나 + 재적용).
        overlay.querySelector('#rel-search')?.addEventListener('input', (event) => {
            relFilterState.query = String(event.target.value || '').trim().toLowerCase();
            applyRelFilter();
        });
        overlay.querySelectorAll('#rel-filter [data-rel-filter]').forEach(button => {
            button.addEventListener('click', () => {
                relFilterState.filter = String(button.dataset.relFilter || 'all');
                overlay.querySelectorAll('#rel-filter [data-rel-filter]').forEach(x => x.classList.toggle('on', x === button));
                applyRelFilter();
            });
        });
        overlay.querySelector('#btn-home-settings')?.addEventListener('click', () => switchTab('settings'));

        overlay.querySelector('#btn-home-sync')?.addEventListener('click', (event) => {
            const action = String(event.currentTarget?.dataset?.syncAction || 'reanalyze');
            const target = action === 'cold-start' ? '#btn-cold-start' : '#btn-cold-reanalyze';
            overlay.querySelector(target)?.click();
        });
        overlay.querySelector('#sdebug')?.addEventListener('change', syncDebugRecordStatus);
        
        // 상단 툴바 및 폼 액션
        // 메모리 구분 — 분류/수명 필터와 리스트·턴별·종류별 보기
        ['#mkind', '#mttl'].forEach(sel => {
            overlay.querySelector(sel)?.addEventListener('change', () => filterMems());
        });
        overlay.querySelectorAll('[data-mem-view]').forEach(button => {
            button.addEventListener('click', () => {
                const key = String(button.dataset.memView || 'list');
                memViewState.view = key;
                overlay.querySelectorAll('[data-mem-view]').forEach(x => x.classList.toggle('on', x === button));
                filterMems();
            });
        });

        // 관계 보기 — 목록 / 그래프. 메모리 보기와 **같은 구조**로 둔다(배선을 일반화한 이유).
        //   그래프는 별도 데이터(인물 중심 뷰)라 목록 필터와 무관하다.
        overlay.querySelectorAll('[data-rel-view]').forEach(button => {
            button.addEventListener('click', () => {
                const key = String(button.dataset.relView || 'list');
                relViewState.view = key;
                overlay.querySelectorAll('[data-rel-view]').forEach(x => x.classList.toggle('on', x === button));
                renderRels();
            });
        });

        // 인물 보기 — 목록 / 그래프(메모리·관계와 같은 구조).
        overlay.querySelectorAll('[data-ent-view]').forEach(button => {
            button.addEventListener('click', () => {
                const key = String(button.dataset.entView || 'list');
                entViewState.view = key;
                overlay.querySelectorAll('[data-ent-view]').forEach(x => x.classList.toggle('on', x === button));
                renderEnts();
            });
        });
        overlay.querySelector('#mem-nsrc-toggle')?.addEventListener('click', () => {
            memViewState.showNarrativeSource = !memViewState.showNarrativeSource;
            filterMems();
        });
        // 메모리 칩 필터 — 같은 그룹 안에서 하나만 켜진다.
        ['kind', 'ttl', 'turn'].forEach(group => {
            overlay.querySelectorAll(`[data-mem-${group}]`).forEach(button => {
                button.addEventListener('click', () => {
                    overlay.querySelectorAll(`[data-mem-${group}]`).forEach(x => x.classList.toggle('on', x === button));
                    filterMems();
                });
            });
        });
        overlay.querySelector('#btn-toggle-add-mem').onclick = () => overlay.querySelector('#amf').classList.toggle('on');
        overlay.querySelector('#btn-cancel-mem').onclick = () => overlay.querySelector('#amf').classList.remove('on');
        overlay.querySelector('#btn-toggle-add-ent').onclick = () => {
            overlay.querySelector('#aef').classList.toggle('on');
        };
        overlay.querySelector('#btn-cancel-ent').onclick = () => {
            overlay.querySelector('#aef').classList.remove('on');
        };
        const syncAddRelationScoreControls = () => {
            const enabled = overlay.querySelector('#ar-score-enabled')?.checked === true;
            const cls = overlay.querySelector('#ar-cls');
            const trs = overlay.querySelector('#ar-trs');
            const clsv = overlay.querySelector('#ar-clsv');
            const trsv = overlay.querySelector('#ar-trsv');
            if (cls) cls.disabled = !enabled;
            if (trs) trs.disabled = !enabled;
            if (clsv) clsv.textContent = enabled ? String(cls?.value || '0') : '미정';
            if (trsv) trsv.textContent = enabled ? String(trs?.value || '0') : '미정';
        };
        overlay.querySelector('#btn-toggle-add-rel').onclick = () => {
            overlay.querySelector('#arf').classList.toggle('on');
            syncAddRelationScoreControls();
        };
        overlay.querySelector('#btn-cancel-rel').onclick = () => {
            overlay.querySelector('#arf').classList.remove('on');
            syncAddRelationScoreControls();
        };

        overlay.querySelector('#ms').oninput = filterMems;
        overlay.querySelector('#mf').onchange = filterMems;
        ['#sep', '#seu', '#sem', '#sek'].forEach(id => {
            const node = overlay.querySelector(id);
            if (!node) return;
            node.addEventListener('change', () => {
                if (id === '#sep') applyProviderPresetToSlot('embedding', { force: true });
                syncVertexCredentialPanels();
            });
            node.addEventListener('input', () => {
                if (id === '#sep' || id === '#seu' || id === '#sem') syncProviderModelDatalist('embedding');
                syncVertexCredentialPanels();
            });
        });
        overlay.querySelectorAll('[data-vertex-json-file]').forEach(input => {
            input.addEventListener('change', async (event) => {
                const file = event?.target?.files?.[0];
                const slot = event?.target?.dataset?.vertexJsonFile || 'preset';
                if (file && await loadVertexServiceAccountFile(slot, file)) {
                    scheduleGlobalSettingsAutoSave('vertex-json-file', 0);
                }
                event.target.value = '';
            });
        });
        // 임베딩 연결 테스트 — LLM 프로필의 '현재 프리셋 테스트' 와 같은 흐름.
        // 종전에는 임베딩 설정을 저장한 뒤 실제 기억 검색이 돌기 전까지
        // provider/url/key 조합이 맞는지 알 방법이 없었다.
        const setEmbedTestStatus = (message = '', state = 'idle') => {
            const status = overlay.querySelector('#embed-test-status');
            if (!status) return;
            status.textContent = message || '임베딩 테스트 대기 중';
            status.classList.remove('is-running', 'is-ok', 'is-failed');
            if (state === 'running') status.classList.add('is-running');
            else if (state === 'ok') status.classList.add('is-ok');
            else if (state === 'failed') status.classList.add('is-failed');
        };
        overlay.querySelector('#btn-test-embed')?.addEventListener('click', async () => {
            const button = overlay.querySelector('#btn-test-embed');
            const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            try {
                if (button) button.disabled = true;
                const cfg = buildSettingsConfigFromUI();
                const embed = cfg?.embed || {};
                const provider = String(embed.provider || 'openai').trim().toLowerCase();
                if (!String(embed.model || '').trim()) {
                    setEmbedTestStatus('실패 · model 이 비어 있습니다.', 'failed');
                    return;
                }
                if (providerRequiresUrl(provider) && !String(embed.url || '').trim()) {
                    setEmbedTestStatus('실패 · url 이 비어 있습니다.', 'failed');
                    return;
                }
                if (!providerAllowsEmptyKey(provider) && !String(embed.key || '').trim()) {
                    setEmbedTestStatus('실패 · api key 가 비어 있습니다.', 'failed');
                    return;
                }
                setEmbedTestStatus(`${provider}/${embed.model} 임베딩 호출 테스트 중...`, 'running');
                const resolved = AutoProvider.get(provider);
                if (!resolved?.getEmbedding) {
                    setEmbedTestStatus(`실패 · ${provider} 는 임베딩을 지원하지 않습니다.`, 'failed');
                    return;
                }
                const vector = await resolved.getEmbedding(cfg, 'LIBRA embedding connectivity test');
                const durationMs = Math.max(0, Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt));
                const dims = Array.isArray(vector) ? vector.length : 0;
                if (!dims) {
                    setEmbedTestStatus(`실패 · 벡터를 받지 못했습니다 (${durationMs}ms)`, 'failed');
                    toast('❌ 임베딩 테스트 실패: 빈 벡터', 3000);
                    return;
                }
                setEmbedTestStatus(`성공 · ${provider}/${embed.model} · ${dims}d · ${durationMs}ms`, 'ok');
                toast(`임베딩 연결 테스트 성공 · ${dims}차원`, 2600);
            } catch (error) {
                const message = error?.message || String(error || 'unknown error');
                setEmbedTestStatus(`실패 · ${message}`, 'failed');
                toast(`❌ 임베딩 테스트 실패: ${message}`, 3000);
            } finally {
                if (button) button.disabled = false;
            }
        });
        overlay.querySelectorAll('[data-vertex-json-apply]').forEach(button => {
            button.addEventListener('click', async () => {
                const slot = button.dataset.vertexJsonApply || 'preset';
                const raw = overlay.querySelector(`[data-vertex-json-paste="${slot}"]`)?.value || '';
                if (await loadVertexServiceAccountText(slot, raw)) {
                    scheduleGlobalSettingsAutoSave('vertex-json-paste', 0);
                }
            });
        });
        overlay.querySelector('#btn-refresh-world-additional')?.addEventListener('click', () => {
            lore = MemoryEngine.getLorebook(char, chat) || lore;
            syncGuiSnapshotsFromRuntime();
            renderWorldAdditional();
            toast('🔄 월드 에디셔널 상태를 새로고침했습니다');
        });
        overlay.querySelectorAll('[data-additional-tab]').forEach(button => {
            button.addEventListener('click', () => activateAdditionalPrimaryPane(button.dataset.additionalTab || 'create'));
        });
        overlay.querySelectorAll('[data-udlc-unified-example]').forEach(button => {
            button.addEventListener('click', () => {
                const input = overlay.querySelector('#udlc-unified-request');
                const target = overlay.querySelector('#udlc-unified-target');
                const status = overlay.querySelector('#user-dlc-unified-status');
                invalidateDirectBundlePreview();
                if (input) { input.value = button.dataset.udlcUnifiedExample || ''; input.focus(); }
                if (button.dataset.udlcUnifiedKind === 'world' && target) target.value = 'world';
                if (button.dataset.udlcUnifiedKind === 'entity' && target?.value === 'world') {
                    if (status) status.textContent = '인물 또는 관계를 선택하면 해당 LIBRA DB에 연결해 분석합니다.';
                    target.focus();
                }
            });
        });
        overlay.querySelector('#btn-analyze-user-dlc-unified')?.addEventListener('click', () => { void runDirectBundleFromGui(); });
        overlay.querySelector('#udlc-unified-request')?.addEventListener('input', () => invalidateDirectBundlePreview());
        overlay.querySelector('#udlc-unified-target')?.addEventListener('change', () => invalidateDirectBundlePreview());
        overlay.addEventListener('click', async event => {
            const migrate = event.target?.closest?.('[data-extension-history-migrate]');
            if (migrate) {event.preventDefault();await migrateExtensionHistoryFromGui();return;}
            const retry = event.target?.closest?.('[data-extension-retry]');
            if (retry) {
                if (retry.disabled) return;
                retry.disabled = true;
                try { await retryExtensionFromGui(retry.dataset.extensionRetry); }
                finally { retry.disabled = false; }
                return;
            }
            const page = event.target?.closest?.('[data-extension-page]');
            if (page) { extensionRecoveryCursor = page.dataset.extensionPage || ''; renderExtensionRecovery(); }
        });
        overlay.querySelector('#btn-analyze-world-additional')?.addEventListener('click', () => {
            void runWorldAdditionalManualAnalysisFromGui();
        });
        overlay.querySelector('#btn-merge-world-additional')?.addEventListener('click', () => {
            void mergeWorldAdditionalDuplicatesFromGui();
        });
        overlay.querySelector('#btn-analyze-user-dlc-world')?.addEventListener('click', () => {
            void runUserDlcWorldAnalysisFromGui();
        });
        overlay.querySelectorAll('[data-udlc-world-example]').forEach(button => button.addEventListener('click', () => {
            const input = overlay.querySelector('#udlc-world-request');
            if (input) { input.value = button.dataset.udlcWorldExample || ''; input.focus(); }
        }));
        overlay.querySelector('#btn-register-user-dlc-world')?.addEventListener('click', () => {
            void registerUserDlcWorldElementFromGui();
        });
        overlay.querySelector('#btn-analyze-user-dlc-entity')?.addEventListener('click', () => {
            void runUserDlcEntityAnalysisFromGui();
        });
        overlay.querySelectorAll('[data-udlc-entity-example]').forEach(button => button.addEventListener('click', () => {
            const input = overlay.querySelector('#udlc-entity-request');
            if (input) { input.value = button.dataset.udlcEntityExample || ''; input.focus(); }
        }));
        overlay.querySelector('#btn-register-user-dlc-analysis')?.addEventListener('click', () => {
            void registerUserDlcAnalysisElementFromGui();
        });
        overlay.querySelector('#btn-register-user-dlc-tracker')?.addEventListener('click', () => {
            void registerUserDlcTrackerFromGui();
        });
        overlay.querySelector('#btn-refresh-user-dlc-targets')?.addEventListener('click', () => {
            syncGuiSnapshotsFromRuntime();
            refreshUserDlcTargetLists({ preserveSelection: true, announce: true });
        });
        overlay.querySelector('#btn-cancel-user-dlc-retarget')?.addEventListener('click', () => {
            cancelUserDlcTrackerRetargetFromGui();
        });
        overlay.querySelectorAll('[data-wa-tab]').forEach(button => {
            button.addEventListener('click', () => activateWorldAdditionalPane(button.dataset.waTab || 'entities'));
        });
        overlay.querySelectorAll('[data-udlc-tab]').forEach(button => {
            button.addEventListener('click', () => activateUserDlcPane(button.dataset.udlcTab || 'world'));
        });
        overlay.querySelector('#tab-world-additional')?.addEventListener('click', event => {
            const retargetButton = event.target?.closest?.('[data-udlc-retarget-id]');
            if (retargetButton) {
                event.preventDefault();
                event.stopPropagation();
                void beginUserDlcTrackerRetargetFromGui(retargetButton.dataset.udlcRetargetId || '');
                return;
            }
            const trackerButton = event.target?.closest?.('[data-udlc-tracker-enabled-id]');
            if (trackerButton) {
                event.preventDefault();
                event.stopPropagation();
                const nextEnabled = trackerButton.dataset.udlcTrackerEnabled !== 'true';
                void toggleUserDlcTrackerEnabledFromGui(trackerButton.dataset.udlcTrackerEnabledId || '', nextEnabled);
                return;
            }
            const injectionButton = event.target?.closest?.('[data-wa-inject-kind]');
            if (injectionButton) {
                event.preventDefault();
                event.stopPropagation();
                const nextEnabled = injectionButton.dataset.waInjectEnabled !== 'true';
                void toggleWorldAdditionalInjectionFromGui(injectionButton.dataset.waInjectKind || '', injectionButton.dataset.waInjectId || '', nextEnabled);
                return;
            }
            const editButton = event.target?.closest?.('[data-wa-edit-kind]');
            if (editButton) {
                event.preventDefault();
                event.stopPropagation();
                void editWorldAdditionalItemFromGui(editButton.dataset.waEditKind || '', editButton.dataset.waEditId || '');
                return;
            }
            const button = event.target?.closest?.('[data-wa-delete-kind]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            void deleteWorldAdditionalItemFromGui(button.dataset.waDeleteKind || '', button.dataset.waDeleteId || '', button.dataset.waDeleteLabel || '');
        });
        overlay.querySelectorAll('#tab-narrative [data-narrative-tab]').forEach(button => {
            button.addEventListener('click', () => activateNarrativePane(button.dataset.narrativeTab || 'storylines'));
        });
        overlay.querySelector('#btn-add-user-lorebook').onclick = async () => {
            try {
                await addManualUserLorebook();
            } catch (e) {
                toast(`❌ 수동 로어북 반영 실패: ${e?.message || e}`);
            }
        };
        const setSettingsTransferStatus = (message, state = 'idle') => {
            const node = overlay.querySelector('#settings-transfer-status');
            if (node) { node.textContent = message; node.dataset.state = state; }
        };
        overlay.querySelector('#btn-export-settings-file').onclick = async () => {
            try {
                // Export the saved layer, never an editor draft, raw runtime, endpoint or credential-bearing config.
                const current = await queueCommonPluginSettingsMutation(() => readCommonPluginSettingsForMutation({}));
                const payload = buildPublicSettingsExport(current);
                const result = await saveJsonExportFile(payload, `wm-portable-settings-v1-${getJsonExportStamp()}.json`, { downloadOnly: true, isCurrent: () => overlay.isConnected });
                if (result?.ok) setSettingsTransferStatus('저장된 허용 설정·프리셋의 로컬 다운로드를 요청했습니다. 브라우저에서 파일을 확인하세요. 지원하지 않는 값과 비밀·연결 URL은 제외했습니다.', 'exported');
            } catch (_) {
                setSettingsTransferStatus('설정 파일을 내보내지 못했습니다. 현재 저장 상태와 브라우저 다운로드 지원을 확인하세요.', 'failed');
            }
        };
        const exportOperationalDiagnostics = async () => {
            if (!overlay.querySelector('#tab-logs')?.classList.contains('on')) switchTab('logs');
            const scope = operationalLogScope();
            const status = overlay.querySelector('#oplog-export-status');
            const snapshotStatus = overlay.querySelector('#oplog-snapshot-status');
            if (!scope || scope !== operationalLogState.scope) {
                renderOperationalLogView();
                if (status) status.textContent = '현재 채팅을 확인한 뒤 다시 내보내세요.';
                return false;
            }
            if (operationalLogState.exportTicket) return false;
            const ticket = { scope, generation: operationalLogState.generation };
            operationalLogState.exportTicket = ticket;
            const isCurrent = () => overlay.isConnected && operationalLogState.exportTicket === ticket
                && operationalLogState.generation === ticket.generation && operationalLogScope() === ticket.scope
                && overlay.querySelector('#tab-logs')?.classList.contains('on');
            const button = overlay.querySelector('#btn-export-debug-file');
            if (button) button.disabled = true;
            operationalLogState.exportText = '';
            const text = overlay.querySelector('#oplog-export-text');
            const fallback = overlay.querySelector('#oplog-export-fallback');
            if (text) text.value = '';
            if (fallback) fallback.hidden = true;
            if (status) status.textContent = '안전한 진단 파일을 준비하고 있습니다…';
            if (snapshotStatus) snapshotStatus.textContent = '진단 스냅샷 저장 응답을 확인하고 있습니다…';
            try {
                const { targetChar: exportChar, targetChat: exportChat, targetCtx: ctx } = await resolveGuiTargetContext();
                if (!isCurrent()) return false;
                const resolvedScope = ctx?.scopeKey || getChatRuntimeScopeKey(exportChat, exportChar);
                if (resolvedScope !== scope) throw new Error('diagnostic_scope_changed');
                const exportLore = MemoryEngine.getLorebook(exportChar, exportChat) || [];
                const payload = await DebugExportManager.buildExportPayloadAsync(exportLore, { chatId: String(exportChat?.id || '').trim(), scopeKey: scope });
                if (!isCurrent()) return false;
                const json = JSON.stringify(payload);
                if (new TextEncoder().encode(json).length > 262144) throw new Error('diagnostic_payload_too_large');
                operationalLogState.exportText = json;
                if (text) text.value = json;
                if (fallback) fallback.hidden = false;
                const snapshot = payload.runtime?.storage?.debugPluginStorage?.lastStatus;
                if (snapshotStatus) snapshotStatus.textContent = snapshot?.operation === 'write' && snapshot?.ok === true
                    ? '진단 스냅샷: 저장 응답을 받았습니다. 파일 저장 여부와는 별개입니다.'
                    : snapshot?.operation === 'write' && snapshot?.ok === false
                        ? '진단 스냅샷: 저장 실패. 파일과 텍스트는 별도로 준비했습니다.'
                        : '진단 스냅샷: 저장 결과 미확인. 파일과 텍스트는 별도로 준비했습니다.';
                try {
                    const result = await saveJsonExportFile(payload, `libra-world-manager-diagnostics-${getJsonExportStamp()}.json`, { serializedJson: json, downloadOnly: true, isCurrent });
                    if (!isCurrent()) return false;
                    if (status) status.textContent = result.ok
                        ? '다운로드를 요청했습니다. 저장되지 않았다면 아래 내용을 복사하세요.'
                        : '다운로드가 시작되지 않았습니다. 아래 내용을 복사하세요.';
                } catch (_) {
                    if (!isCurrent()) return false;
                    if (status) status.textContent = '다운로드를 시작하지 못했습니다. 아래 내용을 복사하세요.';
                }
                return true;
            } catch (_) {
                if (isCurrent()) {
                    if (status) status.textContent = '안전한 진단 파일을 준비하지 못했습니다. 현재 채팅을 확인한 뒤 다시 시도하세요.';
                    if (snapshotStatus) snapshotStatus.textContent = '진단 스냅샷: 저장 결과 미확인.';
                }
                return false;
            } finally {
                if (operationalLogState.exportTicket === ticket) {
                    operationalLogState.exportTicket = null;
                    if (button) button.disabled = false;
                }
            }
        };
        overlay.querySelector('#btn-export-debug-file').onclick = exportOperationalDiagnostics;
        overlay.querySelector('#btn-copy-oplog-json').onclick = async () => {
            const json = operationalLogState.exportText;
            const scope = operationalLogState.scope;
            const generation = operationalLogState.generation;
            const isCurrent = () => overlay.isConnected && generation === operationalLogState.generation
                && scope === operationalLogScope() && overlay.querySelector('#tab-logs')?.classList.contains('on');
            if (!json || !isCurrent()) return false;
            const status = overlay.querySelector('#oplog-export-status');
            try {
                if (typeof navigator?.clipboard?.writeText !== 'function') throw new Error('clipboard_unavailable');
                await navigator.clipboard.writeText(json);
                if (isCurrent() && status) status.textContent = '복사했습니다.';
                return true;
            } catch (_) {
                if (isCurrent() && status) status.textContent = '복사하지 못했습니다. 아래 텍스트를 직접 선택해 복사하세요.';
                return false;
            }
        };
        overlay.querySelector('#btn-health-refresh')?.addEventListener('click', async () => {
            await refreshHealthReviewFromStorage(true);
        });
        let healthRepairTicket = null;
        const showHealthRepairStatus = message => { const node = overlay.querySelector('#health-recovery-status'); if (node) node.textContent = message; };
        overlay.querySelector('#btn-health-repair-preview')?.addEventListener('click', async () => {
            const apply = overlay.querySelector('#btn-health-repair-apply');
            if (apply) apply.disabled = true;
            healthRepairTicket = null;
            try {
                healthRepairTicket = await wmHealthOrchestrator.preview('refresh_derived_cache', { binding:guiHealthBinding, isViewCurrent: () => overlay.isConnected });
                if (apply) apply.disabled = healthRepairTicket.allowed !== true;
                showHealthRepairStatus(healthRepairTicket.allowed ? '현재 범위의 인물·관계 캐시만 정본에서 다시 읽습니다. 원문·저장 기록·벡터 변경 0회, 모델 호출 0회. 실행 뒤 정본과 캐시를 검증합니다.' : '복구 미리보기 제한 · 화면을 다시 열어 검사해 주세요.');
            } catch (_) { showHealthRepairStatus('범위 또는 정본 확인 실패 · 변경 여부를 확인하고 다시 검사해 주세요.'); }
        });
        overlay.querySelector('#btn-health-repair-apply')?.addEventListener('click', async () => {
            if (!healthRepairTicket || healthActionBusy) return;
            healthActionBusy = true;
            try {
                const result = await wmHealthOrchestrator.apply(healthRepairTicket);
                showHealthRepairStatus(result.status === 'verified' ? '캐시 복구 검증 완료 · 정본 변경 없음 · 반복 실행은 같은 결과를 반환합니다.'
                    : result.status === 'uncertain' ? '복구 결과 미확인 · 자동 재시도하지 않습니다. 현재 범위를 다시 검사해 주세요.'
                    : '범위 또는 정본이 변경되었거나 복구가 제한되었습니다. 다시 검사해 주세요.');
            } catch (_) { showHealthRepairStatus('범위 또는 정본이 변경되었습니다. 다시 검사해 주세요.'); }
            finally { healthActionBusy = false; }
        });
        overlay.querySelector('#btn-health-scan')?.addEventListener('click', async () => {
            await runHealthReviewAction('scan');
        });
        overlay.addEventListener('click', async (event) => {
            const button = event.target?.closest?.('[data-health-action]');
            if (!button || !overlay.contains(button)) return;
            let action = String(button.dataset.healthAction || '').trim();
            let id = String(button.dataset.healthId || '').trim();
            if (action === 'repair-field') {
                const box = overlay.querySelector('#world-user-correction');
                const text = String(button.dataset.healthText || '').trim();
                if (box && text) {
                    box.value = [String(box.value || '').trim(), text].filter(Boolean).join('\n\n');
                    switchTab('world');
                    toast('수동 세계관 보정란에 보냈습니다');
                }
                return;
            }
            if (!id) return;
            if (action.startsWith('conflict-')) {
                const split = id.indexOf(':');
                if (split < 0 || !['quarantine', 'integrity'].includes(id.slice(0, split))) return;
                action = `${id.slice(0, split)}-${action.slice('conflict-'.length)}`;
                id = id.slice(split + 1);
            }
            if (action === 'quarantine-accept') await acceptQuarantineEntryFromGui(id);
            else await runHealthReviewAction(action, id);
        });
        let portableImportPreview = null;
        let portableImportGeneration = 0;
        let portableImportBusy = false;
        const clearPortableImportPreview = () => {
            portableImportPreview = null;
            const preview = overlay.querySelector('#settings-import-preview');
            if (preview) { preview.replaceChildren(); preview.hidden = true; }
            overlay.querySelector('#btn-apply-settings-import').disabled = true;
            overlay.querySelector('#btn-cancel-settings-import').disabled = true;
        };
        overlay.querySelector('#btn-import-settings-file').onclick = () => {
            if (portableImportBusy) return;
            const input = overlay.querySelector('#settings-file-input');
            if (input) { input.value = ''; input.click(); }
        };
        overlay.querySelector('#btn-cancel-settings-import').onclick = () => {
            if (portableImportBusy) return;
            portableImportGeneration += 1;
            clearPortableImportPreview();
            setSettingsTransferStatus('가져오기를 취소했습니다. 저장된 설정은 그대로입니다.');
        };
        overlay.querySelector('#settings-file-input').onchange = async (e) => {
            const file = e?.target?.files?.[0];
            if (!file || portableImportBusy) return;
            const generation = ++portableImportGeneration;
            clearPortableImportPreview();
            try {
                if (file.size > WM_PORTABLE_SETTINGS_MAX_BYTES) throw new Error('portable_settings_file_too_large');
                const raw = await file.text();
                if (new TextEncoder().encode(raw).byteLength > WM_PORTABLE_SETTINGS_MAX_BYTES) throw new Error('portable_settings_file_too_large');
                const checked = validatePortableSettingsImport(JSON.parse(raw)); // Complete closed validation before state/save.
                const current = await queueCommonPluginSettingsMutation(() => readCommonPluginSettingsForMutation({}));
                const prepared = mergePortableSettingsImport(current, checked.payload);
                const errors = TypedRecallRollout.validateProductionRecallSettings(prepared.config);
                if (errors.length) throw new Error('portable_settings_invalid_recall');
                if (!overlay.isConnected || generation !== portableImportGeneration) return;
                portableImportPreview = { payload: checked.payload, current: JSON.stringify(current), generation, scope: String(MemoryState._activeScopeKey || ''), initVersion: MemoryState.initVersion, replacementRevision: commonSettingsReplacementRevision };
                const preview = overlay.querySelector('#settings-import-preview');
                const line = message => { const p = document.createElement('p'); p.textContent = message; preview.appendChild(p); };
                line('미리보기 · 아래 허용 항목만 병합합니다. 파일에 없는 설정·기존 프리셋·로컬 비밀정보·서버 저장 권한은 보존합니다.');
                for (const [key, value] of Object.entries(checked.payload.settings)) line(key + ': ' + JSON.stringify(value) + (key === 'useLLM' && value === true ? ' · 켜기는 적용하지 않고 현재 사용 여부 유지' : ''));
                line('분석 AI 선택: ' + (checked.payload.analysis.selectedPreset || '(선택 없음)') + ' · 없는/새 연결은 사용 불가로 유지');
                for (const profile of checked.payload.analysis.presets) {
                    const exists = Object.prototype.hasOwnProperty.call(current.llmPresets || {}, profile.name);
                    line('프리셋 ' + profile.name + ' · ' + (exists ? '메타데이터 병합 · 로컬 연결 유지' : '새 메타데이터 · 연결 정보 입력 필요') + ' · ' + JSON.stringify(profile));
                }
                if (checked.payload.embedding) line('뜻 검색 메타데이터: ' + JSON.stringify(checked.payload.embedding) + ' · 기존 인증/URL/사용 여부 유지');
                if (checked.notices.includes('legacy_routing_retired')) line('구형 분석자별 AI 배정은 폐기하며 복원하지 않습니다.');
                preview.hidden = false;
                overlay.querySelector('#btn-apply-settings-import').disabled = false;
                overlay.querySelector('#btn-cancel-settings-import').disabled = false;
                setSettingsTransferStatus('파일 검증 완료 · 미리보기를 확인하고 병합하세요. 아직 저장하지 않았습니다.', 'preview');
            } catch (_) {
                if (generation !== portableImportGeneration) return;
                clearPortableImportPreview();
                setSettingsTransferStatus('가져오기 거절 · v1 형식·허용 항목·값·256 KiB 제한을 확인하세요. 구형 전체 설정, 비밀/URL/임의 JSON과 제공자가 다른 같은 이름의 프리셋은 지원하지 않습니다. 분석자별 AI 배정은 복원하지 않습니다. 저장하지 않았습니다.', 'rejected');
            }
        };
        const applyPortableImportPreview = async () => {
            const ticket = portableImportPreview;
            if (!ticket || portableImportBusy) return;
            portableImportBusy = true;
            overlay.querySelector('#btn-apply-settings-import').disabled = true;
            overlay.querySelector('#btn-cancel-settings-import').disabled = true;
            const isCurrent = () => overlay.isConnected && portableImportPreview === ticket && ticket.generation === portableImportGeneration
                && ticket.scope === String(MemoryState._activeScopeKey || '') && ticket.initVersion === MemoryState.initVersion;
            try {
                if (!isCurrent()) throw new Error('portable_settings_preview_stale');
                validatePortableSettingsImport(ticket.payload);
                await settleGlobalSettingsAutoSaveBeforeReplace();
                await queueCommonPluginSettingsMutation(async () => {
                    const current = await readCommonPluginSettingsForMutation({});
                    if (!isCurrent() || ticket.replacementRevision !== commonSettingsReplacementRevision || JSON.stringify(current) !== ticket.current) throw new Error('portable_settings_preview_changed');
                    const stored = mergePortableSettingsImport(current, ticket.payload);
                    const live = mergePortableSettingsImport(MemoryEngine.CONFIG, ticket.payload);
                    if (TypedRecallRollout.validateProductionRecallSettings(stored.config).length || TypedRecallRollout.validateProductionRecallSettings(live.config).length) throw new Error('portable_settings_invalid_recall');
                    await replaceCommonPluginSettings(JSON.stringify(stored.config)); // Existing exact native write/readback gate.
                    captureSavedInjectionBudgetSettings(stored.config);
                    applyPersistedSettingsConfig(live.config, 'settings-portable-import', live.changedPaths);
                    if (!isCurrent()) return;
                    settingsViewReplacementRevision = commonSettingsReplacementRevision;
                    _CFG = { ...MemoryEngine.CONFIG };
                    loadSettings(); // Do not use the legacy full-config/default-expanding importer.
                    renderCommonAnalysisSelection(stored.config.llmDefaultPreset || '');
                    clearPortableImportPreview();
                    setSettingsAutoSaveStatus('가져온 허용 설정 저장 확인됨', 'saved');
                    if (ticket.payload.embedding) {
                        const readiness = overlay.querySelector('#sdual-readiness');
                        if (readiness) readiness.textContent = '현재 활성 연결/색인 상태 · 저장된 메타데이터의 자동 적용은 하지 않았습니다. 연결 화면에서 별도로 확인하세요. ' + readiness.textContent;
                    }
                    setSettingsTransferStatus('설정·프리셋 병합 저장을 확인했습니다. 새 연결은 정보를 확인하고 별도로 저장하세요. 뜻 검색 연결 적용·색인 작업은 시작하지 않았습니다.', 'saved');
                });
            } catch (error) {
                clearPortableImportPreview();
                setSettingsTransferStatus(error?.settingsStorageUnverified === true ? '가져오기 저장 결과 미확인 · 새 상태를 발행하지 않았습니다. 저장 상태를 확인하고 화면을 다시 열어 주세요.' : '가져오기를 적용하지 못했습니다. 설정·프리셋이 바뀌었다면 파일을 다시 선택해 미리보기를 확인하세요.', 'failed');
            } finally { portableImportBusy = false; }
        };
        overlay.querySelector('#btn-apply-settings-import').onclick = () => {
            if (!portableImportPreview || portableImportBusy) return;
            if (hasCommonAiDraftChanges()) { requestCommonAiDraftLeave(() => { void applyPortableImportPreview(); }); return; }
            return applyPortableImportPreview();
        };

        overlay.querySelector('#sdebug')?.addEventListener('change', () => {
            markGeneralSettingsControlDirty(overlay.querySelector('#sdebug'));
            scheduleGlobalSettingsAutoSave('debug-toggle', 0);
        });
        // 슬라이더 값 실시간 반영
        overlay.querySelector('#scsp')?.addEventListener('change', () => {
            const preset = overlay.querySelector('#scsp')?.value || 'all';
            const limitInput = overlay.querySelector('#schl');
            if (preset === 'recent100' && limitInput) limitInput.value = 100;
            else if (preset === 'recent200' && limitInput) limitInput.value = 200;
            else if (preset === 'recent500' && limitInput) limitInput.value = 500;
            else if (preset === 'all' && limitInput) limitInput.value = '';
            applyColdStartScopePresetToUI(preset, Number(limitInput?.value || 0));
        });

        const bindSlider = (id, targetId) => overlay.querySelector(id).oninput = (e) => overlay.querySelector(targetId).textContent = e.target.value;
        bindSlider('#ar-cls', '#ar-clsv');
        bindSlider('#ar-trs', '#ar-trsv');
        syncAddRelationScoreControls();

        // 메모리 액션
        overlay.querySelector('#btn-add-mem').onclick = () => {
            const c = Utils.getMemorySourceText(overlay.querySelector("#am-c").value);
            if (!c) { toast("❌ 내용을 입력하세요"); return; }
            const imp = parseInt(overlay.querySelector("#am-i").value) || 5;
            const cat = overlay.querySelector("#am-cat").value.trim() || "";
            const anchorTurn = Math.max(
                1,
                normalizeLegacyMemoryTurnAnchor(MemoryEngine.getCurrentTurn?.() || 0),
                deriveRuntimeTurnFromLorebook(lore),
                TurnRecordLedger.deriveMaxTurn(lore, chat, char)
            );
            const sourceHash = TokenizerEngine.simpleHash(c);
            const userTurnKey = `manual:${sourceHash}`;
            const turnKey = buildCanonicalTurnKey(chat?.id || '', userTurnKey, sourceHash, '', []);
            const meta = {
                imp: Math.max(1, Math.min(10, imp)),
                t: anchorTurn,
                ttl: -1,
                cat: cat,
                ent: [],
                summary: '',
                source: 'manual_memory',
                sourceHint: 'User-created LIBRA memory entry.',
                s_id: MemoryState.currentSessionId,
                sourceMessageIds: [],
                liveMessageIds: [],
                sourceHash,
                aiHash: sourceHash,
                userTurnKey,
                turnKey,
                messageSignature: '',
                messageCount: getChatMessages(chat).length,
                firstTurn: anchorTurn,
                originalTurn: anchorTurn,
                lockedTurn: anchorTurn,
                finalizedTurn: anchorTurn,
                turnAnchorTurn: anchorTurn,
                turnAnchor: anchorTurn,
                turnLocked: true,
                turnAnchorReason: 'manual-memory-entry',
                chatId: String(chat?.id || '').trim(),
                recallHints: StrengthenedJaccardCore.buildRecallHints(c, { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 })
            };
            _MEM.push({ key: "", comment: "lmai_memory", content: `[META:${JSON.stringify(meta)}]\n${c}`, mode: "normal", insertorder: 100, alwaysActive: false });
            overlay.querySelector("#am-c").value = "";
            overlay.querySelector('#amf').classList.remove('on');
            filterMems(); toast("✅ 메모리 추가됨");
        };

        overlay.querySelector('#btn-save-all-mem').onclick = async () => {
            try {
                let newLore = [];
                _ENT.forEach(e => newLore.push(e));
                _REL.forEach(r => newLore.push(r));
                _MEM.forEach(m => newLore.push({ key: m.key || "", comment: "lmai_memory", content: m.content, mode: "normal", insertorder: 100, alwaysActive: false }));
                await saveLoreToChar(buildFullManagedLoreSnapshot(newLore), () => toast("💾 메모리 저장됨"));
            } catch (e) {
                toast(`❌ 메모리 저장 실패: ${e?.message || e}`);
            }
        };

        // 엔티티 및 관계 액션
        overlay.querySelector('#btn-add-ent').onclick = () => {
            const name = overlay.querySelector("#ae-name").value.trim();
            if (!name) { toast("❌ 이름을 입력하세요"); return; }
            const normalizedName = EntityManager.normalizeName(name);
            const roleInStory = (overlay.querySelector("#ae-role")?.value || '').trim();
            const features = parseGuiCsv(overlay.querySelector("#ae-feat")?.value || '');
            const traits = parseGuiCsv(overlay.querySelector("#ae-trait")?.value || '');
            const backgroundSummary = (overlay.querySelector("#ae-bg")?.value || '').trim();
            const currentSummary = (overlay.querySelector("#ae-current-state")?.value || '').trim();
            const speechNotes = parseGuiCsv(overlay.querySelector("#ae-speech-notes")?.value || '');
            const psychology = (overlay.querySelector("#ae-psychology")?.value || '').trim();
            const openThreads = parseGuiOpenThreadLabels(overlay.querySelector("#ae-open-threads")?.value || '');
            let d = {
                id: TokenizerEngine.simpleHash(normalizedName),
                name: normalizedName,
                type: 'character',
                sex: '',
                appearance: {
                    features,
                    distinctiveMarks: [],
                    clothing: []
                },
                personality: {
                    traits,
                    values: [],
                    fears: [],
                    likes: [],
                    dislikes: [],
                    sexualOrientation: '',
                    sexualPreferences: []
                },
                background: {
                    origin: backgroundSummary,
                    occupation: '',
                    history: backgroundSummary ? [backgroundSummary] : [],
                    secrets: []
                },
                speechStyle: {
                    defaultTone: '',
                    honorificStyle: '',
                    toSuperiors: '',
                    toSubordinates: '',
                    toPeers: '',
                    toYounger: '',
                    notes: speechNotes
                },
                status: {
                    currentLocation: '',
                    currentMood: '',
                    healthStatus: '',
                    lastUpdated: MemoryState.currentTurn
                },
                identity: { age: '', sex: '', occupation: '', affiliation: '', roleInStory, summary: backgroundSummary, aliases: [], honorifics: [], source: null },
                profile: {
                    appearance: { features, distinctiveMarks: [], clothing: [], confidence: features.length ? 0.7 : 0 },
                    personality: { traits, values: [], fears: [], likes: [], dislikes: [], vulnerabilities: [], boundaries: [], workStyle: '', socialStyle: '', confidence: traits.length ? 0.7 : 0 },
                    speechStyle: { defaultTone: '', honorificStyle: '', pressureMarkers: [], intimacyShift: '', catchphrases: [], notes: speechNotes },
                    psychology: { baseline: psychology, currentConflict: '', copingStyle: '', notes: [], confidence: psychology ? 0.7 : 0 }
                },
                currentState: { summary: currentSummary, sceneTime: '', location: '', physicalState: [], emotionalState: [], cognitiveFocus: [], immediateGoal: '', activeProblems: [], lastObservedTurn: MemoryState.currentTurn },
                continuity: { openThreads, unresolvedNeeds: [], commitments: [], nextActionHints: [] },
                povKnowledge: { knownToSelf: [], unknownToSelf: [], knownToOthers: [], visibleTo: [], privateExperiences: [], privacy: '' },
                episodeLedger: [],
                stateTimeline: [],
                evidence: [],
                quality: { confidence: 0.7, salience: 0, importance: 0, pressure: 0, lastUpdatedTurn: MemoryState.currentTurn, sourceMix: ['gui'], staleness: '', needsReview: false },
                meta: { created: MemoryState.currentTurn, updated: MemoryState.currentTurn, confidence: 0.7, source: 'gui', manualLocked: true, manualLockedAt: Date.now() }
            };
            if (typeof EntityManager?.normalizeEntityRecord === 'function') d = EntityManager.normalizeEntityRecord(d);
            _ENT.push({ key: LibraLoreKeys.entityFromName(normalizedName), comment: "lmai_entity", content: JSON.stringify(d), mode: "normal", insertorder: 50, alwaysActive: false });
            overlay.querySelector("#ae-name").value = ""; overlay.querySelector("#ae-role").value = ""; overlay.querySelector("#ae-feat").value = ""; overlay.querySelector("#ae-trait").value = ""; overlay.querySelector("#ae-bg").value = ""; overlay.querySelector("#ae-current-state").value = ""; overlay.querySelector("#ae-speech-notes").value = ""; overlay.querySelector("#ae-psychology").value = ""; overlay.querySelector("#ae-open-threads").value = "";
            overlay.querySelector('#aef').classList.remove('on');
            renderEnts(); toast("✅ 인물 추가됨");
        };

        overlay.querySelector('#btn-add-rel').onclick = () => {
            const a = overlay.querySelector("#ar-a").value.trim();
            const b = overlay.querySelector("#ar-b").value.trim();
            if (!a || !b) { toast("❌ 인물을 입력하세요"); return; }
            const entityA = EntityManager.normalizeName(a);
            const entityB = EntityManager.normalizeName(b);
            const sortedPair = [entityA, entityB].sort();
            const scoreEnabled = overlay.querySelector('#ar-score-enabled')?.checked === true;
            const closeness = scoreEnabled ? (parseInt(overlay.querySelector("#ar-cls").value) || 0) / 100 : null;
            const trust = scoreEnabled ? (parseInt(overlay.querySelector("#ar-trs").value) || 0) / 100 : null;
            const d = {
                id: `${sortedPair[0]}_${sortedPair[1]}`,
                entityA,
                entityB,
                relationType: overlay.querySelector("#ar-type").value.trim() || "첫 대면",
                details: {
                    howMet: '',
                    duration: '',
                    closeness,
                    trust,
                    events: []
                },
                sentiments: {
                    fromAtoB: overlay.querySelector("#ar-sent").value.trim(),
                    fromBtoA: '',
                    currentTension: 0,
                    lastInteraction: MemoryState.currentTurn
                },
                currentStatus: { summary: '', publicLayer: '', privateLayer: '', boundaryState: '', lastChangedTurn: 0 },
                metrics: { closeness, trust, tension: 0, risk: 0, ambiguity: scoreEnabled ? 0 : 0.65, pressure: 0 },
                dynamics: { fromAtoB: [], fromBtoA: [], unresolvedIssues: [], recentChanges: [] },
                sharedContext: { location: '', workplace: '', privateThreads: [], notes: [] },
                eventLedger: [],
                evidence: [],
                quality: { confidence: scoreEnabled ? 0.7 : 0.3, salience: 0, importance: 0, pressure: 0, lastUpdatedTurn: MemoryState.currentTurn, sourceMix: ['gui'], staleness: '', needsReview: !scoreEnabled },
                relationshipAssessment: {
                    stage: scoreEnabled ? 'defined_manual' : 'first_contact',
                    definitionConfidence: scoreEnabled ? 0.7 : 0.08,
                    evidenceCount: 0,
                    label: scoreEnabled ? '수동 정의됨' : '첫 대면 · 정의 보류',
                    note: scoreEnabled ? '사용자가 직접 관계 수치를 지정함' : '관계를 정의하기에는 근거가 부족함',
                    inferred: !scoreEnabled
                },
                meta: { created: MemoryState.currentTurn, updated: MemoryState.currentTurn, confidence: 0.6, source: 'gui', manualLocked: true, manualLockedAt: Date.now() }
            };
            _REL.push({ key: LibraLoreKeys.relationFromNames(entityA, entityB), comment: "lmai_relation", content: JSON.stringify(d), mode: "normal", insertorder: 51, alwaysActive: false });
            overlay.querySelector("#ar-a").value = ""; overlay.querySelector("#ar-b").value = ""; overlay.querySelector("#ar-type").value = ""; overlay.querySelector("#ar-sent").value = "";
            overlay.querySelector("#ar-score-enabled").checked = false;
            syncAddRelationScoreControls();
            overlay.querySelector('#arf').classList.remove('on');
            renderEnts(); toast("✅ 관계 추가됨");
        };
        overlay.querySelector('#btn-add-entity-block').onclick = async () => {
            try {
                const input = overlay.querySelector("#entity-block-input");
                const blockedName = await blockEntityFromGui(input?.value || '', { removeStoredData: true });
                if (input) input.value = '';
                toast(`⛔ ${blockedName} 차단됨`);
            } catch (e) {
                toast(e?.settingsCommitted ? `⚠️ ${e.message}` : `❌ 엔티티 차단 실패: ${e?.message || e}`);
            }
        };

        overlay.querySelector('#btn-save-ents').onclick = async () => {
            try {
                applyGuiEntityBlocklistToLocalSnapshots();
                let newLore = [];
                _ENT.forEach(e => newLore.push(e));
                _REL.forEach(r => newLore.push(r));
                _MEM.forEach(m => newLore.push(m));
                await saveLoreToChar(buildFullManagedLoreSnapshot(newLore), () => toast("💾 저장됨"));
            } catch (e) {
                toast(`❌ 저장 실패: ${e?.message || e}`);
            }
        };
        let historicalReanalysisBusy = false;
        const runUnifiedHistoricalReanalysisFromGui = async () => {
            if (historicalReanalysisBusy || !overlay.isConnected) return false;
            historicalReanalysisBusy = true;
            const button = overlay.querySelector('#btn-cold-reanalyze');
            if (button) button.disabled = true;
            const statusNode = overlay.querySelector('#historical-reanalysis-status');
            const status = (state,text) => { if (statusNode && overlay.isConnected) {statusNode.dataset.state=state;statusNode.textContent=text;} };
            const revision = turnReanalysisViewRevision, lease = RuntimeStateLease.capture();
            const abort = new AbortController(); turnReanalysisAbort = abort;
            const current = () => !abort.signal.aborted && overlay.isConnected
                && document.getElementById('lmai-overlay') === overlay && revision === turnReanalysisViewRevision
                && RuntimeStateLease.isCurrent(lease);
            const observer = new MutationObserver(()=>{if (!overlay.isConnected) abort.abort();});
            observer.observe(overlay.parentNode,{childList:true});
            let result = null, dispatched = false;
            try {
                status('preview','전체 대화 보강 병합의 원문·범위를 확인하고 있습니다. 아직 모델을 호출하지 않았습니다.');
                const ticket = await wmHealthOrchestrator.preview('explicit_reanalysis',{
                    mode:'whole_conversation_merge',binding:guiHealthBinding,isViewCurrent:current,signal:abort.signal
                });
                if (!current() || ticket.allowed !== true) {
                    status('rejected','범위·원문 또는 실행 상태를 확인하지 못해 전체 대화 보강 병합을 실행하지 않았습니다.');
                    return false;
                }
                dispatched = true;
                result = await wmHealthOrchestrator.apply(ticket);
                if (result?.committed === true && result?.canonicalVerified === true) {
                    status('committed','전체 대화 보강 병합의 정본 저장을 확인했습니다. 특정 턴 교체·복원은 아닙니다.');
                    if (current() && result.viewCurrent === true) {
                        const read = await ManagementReviewCore.read(guiHealthBinding,{isViewCurrent:current});
                        if (current()) {lore=read.entries;syncGuiSnapshotsFromRuntime(read.entries);renderAllGuiDataViews();}
                    }
                    return true;
                }
                if (result?.status === 'uncertain') {
                    status('uncertain','보강 병합 결과가 불확실합니다. 실행 중 상태가 바뀌었을 수 있으므로 정본을 확인해 주세요.');
                } else status('rejected',result?.reason === 'user_cancelled'
                    ? '전체 대화 보강 병합을 취소했습니다. 변경하지 않았습니다.'
                    : '원문·설정·대화가 변경되었거나 분석이 불가능하여 저장 전에 중단했습니다.');
                return false;
            } catch (_) {
                status(result?.committed === true ? 'committed' : dispatched ? 'uncertain' : 'rejected',
                    result?.committed === true ? '정본 저장은 확인했지만 화면 갱신을 확인하지 못했습니다. 다시 열어 확인해 주세요.'
                    : dispatched ? '전체 대화 보강 병합의 결과를 확인하지 못했습니다. 정본을 확인해 주세요.'
                    : '전체 대화 보강 병합의 원문·범위를 확인하지 못해 실행하지 않았습니다.');
                return false;
            } finally {
                observer.disconnect();
                if (turnReanalysisAbort === abort) turnReanalysisAbort=null;
                historicalReanalysisBusy=false;
                if (button && overlay.isConnected) button.disabled=false;
            }
        };
        const saveWorldCorrectionAction = async () => {
            try {
                await saveWorldCorrectionFromGui();
            } catch (e) {
                toast(`❌ 세계관 보정 저장 실패: ${e?.message || e}`);
            }
        };
        const saveWorldFieldsAction = async () => {
            try {
                await saveWorldFieldsFromGui();
            } catch (e) {
                toast(`❌ 세계관 필드 저장 실패: ${e?.message || e}`);
            }
        };
        for (const button of overlay.querySelectorAll('#btn-save-world-correction, #btn-save-world-correction-inline')) button.onclick = saveWorldCorrectionAction;
        for (const button of overlay.querySelectorAll('#btn-save-world-fields, #btn-save-world-fields-inline')) button.onclick = saveWorldFieldsAction;
        overlay.querySelector('#btn-save-settings').onclick = () => {
            void persistGlobalSettingsFromUI({ reason: 'settings-save', notify: true });
        };

        overlay.querySelector('#btn-reset-settings').onclick = async () => {
            if (!await Utils.confirmEx("모든 설정을 초기값으로 되돌리시겠습니까?")) return;
            const resetConfig = canonicalSettingsForStorage({
                ...MemoryEngine.createDefaultSettingsConfig(),
                ...buildOptimizedHiddenSettingsDefaults({ coldStartScopePreset: 'all', coldStartHistoryLimit: 0 }),
                dualRecallAdmission: {},
                activityDashboard: 'compact',
                debug: false,
                entityBlocklist: [],
                nsfwGuidancePromptEnabled: true,
                assistantPrefillEnabled: true,
                nsfwMode: 'direct',
                nsfwEnabled: true,
                storyAuthorEnabled: false,
                storyAuthorMode: 'disabled',
                directorEnabled: false,
                directorMode: 'disabled',
                worldAdditionalEnabled: true,
                worldAdditionalMode: 'firm',
                worldAdditionalMaxPerRequest: 3,
                worldAdditionalAutoIntegrate: true,
                worldCanonCustomText: '',
                worldCanonCustomForce: false,
                worldAdditionalCustomText: '',
                worldAdditionalCustomForce: false,
                flexRoutingMode: 'off',
                flexTimeoutMs: 600000,
                flexFallbackToStandard: false,
                vertexFlexMode: 'provisioned_then_flex',
                customServiceTierPassthrough: false,
                moduleLorebookReflectionEnabled: false,
                moduleLorebookSelectedIds: '',
                llm: { provider: "openai", url: "", key: "", model: "gpt-4o-mini", temp: 0.3, timeout: 120000, serviceTier: "off", reasoningPreset: "auto", reasoningEffort: "none", reasoningBudgetTokens: DEFAULT_REASONING_BUDGET_TOKENS, maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS, glmThinkingType: "enabled", stream: false },
                auxLlm: { enabled: false, provider: "openai", url: "", key: "", model: "gpt-4o-mini", temp: 0.2, timeout: 90000, serviceTier: "off", reasoningPreset: "auto", reasoningEffort: "none", reasoningBudgetTokens: DEFAULT_REASONING_BUDGET_TOKENS, maxCompletionTokens: DEFAULT_AUX_MAX_COMPLETION_TOKENS, glmThinkingType: "enabled", stream: false },
                llmPresets: {},
                llmRouting: {},
                llmDefaultPreset: 'primary',
                embed: { enabled: true, provider: "voyageai", url: "https://api.voyageai.com/v1/embeddings", key: "", model: "voyage-4-large", timeout: 120000 }
            });
            try {
                await settleGlobalSettingsAutoSaveBeforeReplace();
                await queueCommonPluginSettingsMutation(async () => {
                await replaceCommonPluginSettings(JSON.stringify(resetConfig));
            captureSavedInjectionBudgetSettings(resetConfig);
            applyPersistedSettingsConfig(resetConfig, 'settings-reset');
            loadSettings();
            settingsViewReplacementRevision = commonSettingsReplacementRevision;
            setSettingsAutoSaveStatus('초기 전역 설정 저장됨', 'saved');
            toast("🔄 설정 초기화됨");
                });
            } catch (err) {
                toast(`❌ 설정 초기화 저장 실패: ${err?.message || err}`);
                return;
            }
        };

        overlay.querySelector('#lmai-cache-reset').onclick = async () => {
            const status = overlay.querySelector('#cache-reset-status');
            try {
                if (status) status.textContent = '검색 캐시를 정리하고 있습니다…';
                const result = MemoryEngine.clearDerivedCaches?.() || { ok: true, clearedEntries: 0 };
                MemoryEngine.rebuildIndex(effectiveGuiLore || lore || []);
                try { EntityManager.rebuildCache(effectiveGuiLore || lore || []); } catch (_) {}
                renderCacheStats();
                if (status) status.textContent = `완료 · 파생 항목 ${Number(result.clearedEntries || 0)}개 정리 · 원본 데이터 보존됨`;
                toast('✅ 검색 캐시를 초기화했습니다. 원본 LIBRA 데이터는 보존됩니다.');
            } catch (error) {
                if (status) status.textContent = `초기화 실패 · ${error?.message || error}`;
                toast(`❌ 검색 캐시 초기화 실패: ${error?.message || error}`);
            }
        };

        let memoryResetBusy = false;
        overlay.querySelector('#lmai-data-reset').onclick = async () => {
            if (memoryResetBusy || !overlay.isConnected) return;
            const resetBinding = guiHealthBinding ? Object.freeze({ ...guiHealthBinding }) : null;
            if (!resetBinding) { toast('현재 채팅·페르소나 연결을 확인할 수 없습니다. 화면을 다시 열어 주세요.'); return; }
            memoryResetBusy = true;
            const status = overlay.querySelector('#data-reset-status');
            try {
                const confirmed = await Utils.confirmEx('현재 채팅·페르소나의 저장된 LIBRA 기억을 비우고 런타임 캐시를 초기화할까요? 대화 메시지, 다른 페르소나의 기억, 진단·처리 기록은 보존됩니다. 전체 기록의 영구 삭제 기능은 아닙니다.');
                if (!confirmed || !overlay.isConnected) return;
                if (status) status.textContent = '기억 초기화 저장을 확인하고 있습니다…';
                const result = await ManagementReviewCore.reset(resetBinding, { isViewCurrent: () => overlay.isConnected });
                if (!overlay.isConnected) return;
                await show();
                toast(`LIBRA 기억 초기화 완료 · 기억 ${result.clearedEntries}개 정리 · 진단·처리 기록 보존`);
            } catch (error) {
                if (!overlay.isConnected) return;
                const message = error.uncertain
                    ? '초기화 저장 결과를 확인할 수 없습니다. 결과가 불확실하므로 화면을 다시 열어 확인해 주세요.'
                    : error.canonicalVerified
                        ? '초기화 저장은 확인했지만 화면을 갱신할 수 없습니다. 화면을 다시 열어 주세요.'
                        : error.code === 'management_busy'
                            ? '다른 LIBRA 작업이 진행 중이어서 초기화하지 못했습니다. 완료 후 다시 시도해 주세요.'
                            : '초기화 실패: 채팅·페르소나 또는 정본 상태가 변경되었습니다. 화면을 다시 열어 확인해 주세요.';
                if (status) status.textContent = message;
                if (error.uncertain || error.canonicalVerified) {
                    healthReadSource = { status: 'unavailable', verified: false, lore: null, reason: 'canonical_read_unavailable' };
                    renderHealthReview();
                }
                toast(message);
            } finally { memoryResetBusy = false; }
        };

        // Explicit, whole-turn-only action. The runtime latch also covers reopening the GUI.
        const runTurnCardReanalysis = async button => {
            const id = String(button.dataset.memoryId || '');
            const availability = turnReanalysisAvailability(id);
            if (!availability.eligible || turnReanalysisActionRunning) return;
            turnReanalysisActionRunning = true;
            const revision = turnReanalysisViewRevision;
            const lease = RuntimeStateLease.capture();
            const abort = new AbortController(); turnReanalysisAbort = abort;
            const isViewCurrent = () => !abort.signal.aborted && overlay.isConnected
                && document.getElementById('lmai-overlay') === overlay
                && turnReanalysisViewRevision === revision && RuntimeStateLease.isCurrent(lease);
            const observer = new MutationObserver(() => { if (!overlay.isConnected) abort.abort(); });
            observer.observe(overlay.parentNode, {childList:true});
            const status = (state,message) => {
                turnReanalysisStatuses.set(id,{state,message});
                if (!overlay.isConnected) return;
                for (const node of overlay.querySelectorAll('.turn-reanalysis-status')) {
                    if (node.dataset.memoryId === id) { node.dataset.state=state; node.textContent=message; }
                }
            };
            for (const node of overlay.querySelectorAll('.act-reanalyze-turn')) node.disabled = true;
            status('preparing','현재 원문으로 기억·인물·세계·내러티브 전체를 재분석 중입니다. 아직 저장하지 않았습니다.');
            let publicationStarted = false, publicationResult = null;
            try {
                const ticket = await wmHealthOrchestrator.preview('explicit_reanalysis',{
                    mode:'latest_owned_turn',binding:guiHealthBinding,canonicalMemoryId:id,isViewCurrent,signal:abort.signal
                });
                if (!isViewCurrent() || ticket.allowed !== true) {
                    status('rejected',ticket.reason === 'operation_in_progress'
                        ? '다른 점검·복구 작업이 진행 중입니다. 완료 후 다시 실행해 주세요.'
                        : '원문·대화 또는 안전한 기준본을 확인하지 못해 실행하지 않았습니다.');
                    return;
                }
                publicationStarted = true;
                const result = publicationResult = await wmHealthOrchestrator.apply(ticket);
                if (result.state === 'committed') {
                    status('committed',result.runtimeRefreshed
                        ? '턴 전체 재분석 결과의 정본 저장을 확인했습니다.'
                        : '정본 저장을 확인했지만 현재 화면은 갱신하지 않았습니다. 해당 대화를 다시 열어 확인해 주세요.');
                    if (result.runtimeRefreshed && isViewCurrent()) {
                        const scope = LibraDataStorage.scopeKeyFor(char,chat);
                        const accepted = await LibraDataStorage.readVerified(scope,{strict:true});
                        if (accepted.ok && isViewCurrent() && JSON.parse(accepted.raw).reanalysisRevision?.analysisId === result.analysisId) {
                            lore = accepted.entries; syncGuiSnapshotsFromRuntime(accepted.entries); filterMems();
                        }
                    }
                } else if (result.state === 'uncertain' || result.status === 'uncertain') {
                    status('uncertain','저장 결과가 불확실합니다. 데이터가 바뀌었을 수 있습니다. 다시 실행하지 말고 정본 상태를 확인해 주세요.');
                } else status('rejected','원문·설정·대화 또는 기준본이 변경되어 저장 전에 중단했습니다.');
            } catch (error) {
                const reason = String(error?.message || '');
                if (publicationResult?.state === 'committed') {
                    status('committed','정본 저장을 확인했지만 화면 갱신을 확인하지 못했습니다. 해당 대화를 다시 열어 확인해 주세요.');
                    return;
                }
                if (publicationStarted) {
                    publicationBlocked = true;
                    status('uncertain','저장 결과를 확인하지 못했습니다. 데이터가 바뀌었을 수 있으므로 다시 실행하지 말고 정본 상태를 확인해 주세요.');
                    return;
                }
                status('rejected',reason.includes('user_dlc_unsupported')
                    ? '사용자 추가 요소가 있는 대화의 턴 재분석은 아직 지원하지 않습니다. 저장하지 않았습니다.'
                    : reason.includes('incomplete_domains') || reason.includes('detached_domain')
                        ? '전체 영역의 분석 완료를 확인하지 못해 저장하지 않았습니다.'
                        : '원문·분석 또는 실행 상태를 확인할 수 없어 저장 전에 중단했습니다.');
            } finally {
                observer.disconnect();
                if (turnReanalysisAbort === abort) turnReanalysisAbort = null;
                turnReanalysisActionRunning = false;
                if (overlay.isConnected) for (const node of overlay.querySelectorAll('.act-reanalyze-turn')) {
                    const next = turnReanalysisAvailability(String(node.dataset.memoryId || ''));
                    node.disabled = !next.eligible; node.title = next.reason;
                }
            }
        };

        // 리스트 동적 버튼 이벤트 위임 (Event Delegation)
        overlay.addEventListener('click', async (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            if (target.classList.contains('act-reanalyze-turn')) {
                await runTurnCardReanalysis(target);
                return;
            }
            if (target.classList.contains('act-save-mem')) {
                const idx = parseInt(target.dataset.idx, 10);
                if (isNaN(idx) || idx < 0 || idx >= _MEM.length) return;
                const nc = Utils.getMemorySourceText(overlay.querySelector(".mt-val[data-idx='"+idx+"']")?.value || '');
                const ni = parseInt(overlay.querySelector(".mi-val[data-idx='"+idx+"']")?.value) || 5;
                const previousMeta = parseMeta(_MEM[idx].content);
                const previousTurn = normalizeLegacyMemoryTurnAnchor(previousMeta.t || previousMeta.turn || previousMeta.finalizedTurn || previousMeta.turnAnchorTurn || 0);
                const meta = { ...previousMeta };
                meta.imp = Math.max(1, Math.min(10, ni));
                meta.summary = '';
                meta.source = meta.source || 'narrative_source_record';
                meta.sourceHint = meta.sourceHint || 'Used as source evidence for narrative summaries.';
                // 사용자가 중요도를 바꾸면 meta 가 변하므로 체크섬을 다시 찍는다.
                // 재스탬프가 없으면 편집한 기억이 회상 후보에서 조용히 탈락한다.
                try {
                    IntegrityMetaManager.annotateMemoryMeta(meta, String(nc || '').trim(), {
                        domain: 'memory',
                        recordSchema: 'libra.memory.entry.v1',
                        recordId: String(meta?.integrity?.recordId || meta?.canonicalMemoryId || meta?.turnKey || meta?.sourceHash || meta?.m_id || ''),
                        scopeKey: String(meta?.integrity?.scopeKey || _CFG?.activeScopeKey || MemoryState?._activeScopeKey || meta?.chatId || '').trim(),
                        turn: previousTurn || 0,
                        source: String(meta.source || '')
                    });
                } catch (_) {}
                _MEM[idx].content = `[META:${JSON.stringify(meta)}]` + '\n' + nc;
                if (_CFG.rpLongTermMemoryEnabled !== false && previousTurn > 0) {
                    try {
                        const editedPayload = CompactMemoryCodec.parsePayloadFromEntry(_MEM[idx]);
                        if (editedPayload?.rpLongTerm) {
                            RPContinuityCore.upsertFromTurn(lore, editedPayload.rpLongTerm, {
                                turn: previousTurn,
                                entityRefs: editedPayload?.participants?.canonicalEntities || editedPayload?.mentionedEntityNames || [],
                                source: 'gui-memory-edit',
                                sourceMemoryKey: (() => {
                        const raw = String(_MEM[idx]?.key || '').trim();
                        const hm = raw.match(/^(-?\d+)(?:_|$)/);
                        if (hm) return `memory_hash:${hm[1]}`;
                        if (raw && !raw.includes('[')) return raw;
                        return `memory_hash:${TokenizerEngine.simpleHash(String(_MEM[idx]?.content || ''))}`;
                    })()
                            });
                        }
                    } catch (error) {
                        if (_CFG.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] GUI memory edit reconciliation skipped:', error?.message || error);
                    }
                }
                toast("✅ 메모리 수정됨");
            } else if (target.classList.contains('act-promote-mem') || target.classList.contains('act-demote-mem')) {
                const idx = parseInt(target.dataset.idx, 10);
                if (isNaN(idx) || idx < 0 || idx >= _MEM.length) return;
                const entry = _MEM[idx];
                if (!entry) return;
                const previousMeta = parseMeta(entry.content || '');
                const previousTurn = normalizeLegacyMemoryTurnAnchor(previousMeta.t || previousMeta.turn || previousMeta.finalizedTurn || previousMeta.turnAnchorTurn || 0);
                const body = Utils.getMemorySourceText(stripMeta(entry.content || ''));
                const bridge = (typeof WorldPromotionBridge !== 'undefined') ? WorldPromotionBridge : null;
                if (!bridge) { toast('⚠ 승격을 쓸 수 없습니다'); return; }
                // 지금 세계 노드로 올린다 — 사용자가 화면에서 보고 있는 노드가 대상이다.
                const nodeId = (() => {
                    try {
                        const ap = Array.isArray(_WLD?.activePath) ? _WLD.activePath : [];
                        return String(ap[ap.length - 1] || _WLD?.rootId || '').trim();
                    } catch (_) { return ''; }
                })();
                const isDemote = target.classList.contains('act-demote-mem');
                const outcome = isDemote
                    ? bridge.demote({ nodeId, locator: previousMeta.promotedTo, memoryMeta: previousMeta })
                    : bridge.promote({ nodeId, text: body, memoryMeta: previousMeta });
                if (!outcome?.ok) { toast(`⚠ ${isDemote ? '승격 취소' : '승격'} 실패: ${outcome?.reason || '알 수 없음'}`); return; }
                // META 를 바꿨으므로 **재스탬프**한다 — 없으면 그 기억이 회상 후보에서 조용히 탈락한다.
                const meta = { ...outcome.memoryMeta };
                try {
                    IntegrityMetaManager.annotateMemoryMeta(meta, String(body || '').trim(), {
                        domain: 'memory',
                        recordSchema: 'libra.memory.entry.v1',
                        recordId: String(meta?.integrity?.recordId || meta?.canonicalMemoryId || meta?.turnKey || meta?.sourceHash || meta?.m_id || ''),
                        scopeKey: String(meta?.integrity?.scopeKey || _CFG?.activeScopeKey || MemoryState?._activeScopeKey || meta?.chatId || '').trim(),
                        turn: previousTurn || 0,
                        source: String(meta.source || '')
                    });
                } catch (_) {}
                entry.content = `[META:${JSON.stringify(meta)}]` + '\n' + body;
                if (!isDemote) {
                    // 세계 그래프를 저장해야 규칙이 남는다(안 하면 런타임에만 있고 사라진다).
                    try { await persistWorldGraphFromGui?.('↑ 세계 규칙으로 승격됨', true); } catch (_) {}
                }
                filterMems();
                toast(isDemote ? '↩ 승격 취소 — 회상 대상으로 되돌렸습니다' : '↑ 세계 규칙으로 승격됨 — 매 턴 주입됩니다');
            } else if (target.classList.contains('act-del-mem')) {
                const idx = parseInt(target.dataset.idx, 10);
                if (isNaN(idx) || idx < 0 || idx >= _MEM.length) return;
                if (!await Utils.confirmEx("이 메모리를 삭제하시겠습니까?")) return;
                const removedEntry = _MEM[idx];
                const removedMeta = parseMeta(removedEntry?.content || '');
                _MEM.splice(idx, 1);
                filterMems(); toast("🗑 메모리가 삭제됨");
            } else if (target.classList.contains('act-rename-ent')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _ENT.length) return;
                const d = parseGuiStoredJson(_ENT[i], 'entity.rename', i);
                const currentName = String(d.name || '').trim();
                if (!currentName) return;
                const nextName = typeof window !== 'undefined'
                    ? window.prompt('새 인물 이름을 입력하세요', currentName)
                    : '';
                if (nextName == null) return;
                const cleanName = String(nextName || '').trim();
                if (!cleanName || cleanName === currentName) return;
                try {
                    toast('이름 변경 중...', 1800);
                    const result = await renameEntityAcrossRuntime(currentName, cleanName);
                    if (result?.ok) {
                        toast(`✅ ${result.oldName} → ${result.newName} 이름 변경됨${result.aliasKept ? ' · 기존 이름 별칭 유지' : ' · 기존 이름 별칭 제외'}`, 3200);
                    }
                } catch (e) {
                    toast(`❌ 이름 변경 실패: ${e?.message || e}`, 3600);
                }
            } else if (target.classList.contains('act-absorb-ent')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _ENT.length) return;
                const d = parseGuiStoredJson(_ENT[i], 'entity.absorb', i);
                if (typeof EntityManager?.normalizeEntityRecord === 'function') EntityManager.normalizeEntityRecord(d);
                const sourceName = String(d.name || '').trim();
                if (!sourceName) return;
                const mode = String(target.dataset.mode || '').trim();
                const absorptionMeta = d?.meta?.absorption && typeof d.meta.absorption === 'object' ? d.meta.absorption : null;
                if (mode === 'cancel' || String(absorptionMeta?.status || '').toLowerCase() === 'pending') {
                    if (!await Utils.confirmEx(`"${sourceName}"의 흡수 대기 상태를 취소하시겠습니까?`)) return;
                    try {
                        const result = await cancelEntityAbsorptionFromGui(sourceName);
                        toast(`↩ ${result.sourceName} 흡수 대기 취소됨`, 2800);
                    } catch (err) {
                        toast(`❌ 흡수 취소 실패: ${err?.message || err}`, 3600);
                    }
                    return;
                }

                const sourceCanonical = EntityManager.normalizeName(sourceName, lore) || sourceName;
                const candidates = _ENT
                    .map((entry, idx) => {
                        if (idx === i) return null;
                        const candidate = parseGuiStoredJson(entry, 'entity.absorb_candidate', idx);
                        if (typeof EntityManager?.normalizeEntityRecord === 'function') EntityManager.normalizeEntityRecord(candidate);
                        const name = String(candidate.name || '').trim();
                        if (!name) return null;
                        if (EntityManager.isPromptVisibleEntityRecord?.(candidate) === false) return null;
                        const canonical = EntityManager.normalizeName(name, lore) || name;
                        if (!canonical || canonical === sourceCanonical) return null;
                        return { idx, name, canonical };
                    })
                    .filter(Boolean);
                if (candidates.length === 0) {
                    toast('흡수 대상으로 삼을 정규 엔티티가 없습니다.', 3000);
                    return;
                }
                const promptText = [
                    `"${sourceCanonical}"를 어느 정규 엔티티에 흡수할까요?`,
                    '',
                    ...candidates.slice(0, 40).map((item, idx) => `${idx + 1}. ${item.canonical}`)
                ].join('\n');
                const answer = typeof window !== 'undefined' ? window.prompt(promptText, candidates[0]?.canonical || '') : '';
                if (answer == null) return;
                const cleaned = String(answer || '').trim();
                if (!cleaned) return;
                const numericChoice = Number(cleaned);
                const chosen = Number.isInteger(numericChoice) && numericChoice >= 1 && numericChoice <= candidates.length
                    ? candidates[numericChoice - 1]
                    : candidates.find(item => item.canonical === cleaned || item.name === cleaned);
                if (!chosen) {
                    toast('목록에 있는 정규 엔티티 이름이나 번호를 입력해야 합니다.', 3600);
                    return;
                }
                if (!await Utils.confirmEx(`"${sourceCanonical}"를 "${chosen.canonical}"에 흡수 대기 표시할까요? 다음 유지보수 턴에서 LLM 병합이 진행됩니다.`)) return;
                try {
                    toast('흡수 대기 표시 저장 중...', 1800);
                    const result = await markEntityAbsorptionFromGui(sourceCanonical, chosen.canonical);
                    toast(`✅ ${result.sourceName} → ${result.targetName} 흡수 대기 등록됨`, 3200);
                } catch (err) {
                    toast(`❌ 흡수 지정 실패: ${err?.message || err}`, 3600);
                }
            } else if (target.classList.contains('act-save-ent')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _ENT.length) return;
                let d = parseGuiStoredJson(_ENT[i], 'entity.save', i);
                if (typeof EntityManager?.normalizeEntityRecord === 'function') d = EntityManager.normalizeEntityRecord(d);
                d.meta = d.meta || {};
                d.meta.source = 'gui';
                d.meta.manualLocked = true;
                d.meta.manualLockedAt = Date.now();
                const guiFeatures = parseGuiCsv(overlay.querySelector(".eF-val[data-idx='"+i+"']")?.value || '');
                const guiTraits = parseGuiCsv(overlay.querySelector(".eP-val[data-idx='"+i+"']")?.value || '');
                const guiRole = (overlay.querySelector(".eRole-val[data-idx='"+i+"']")?.value || '').trim();
                const guiAffiliation = (overlay.querySelector(".eAffiliation-val[data-idx='"+i+"']")?.value || '').trim();
                const guiLocation = (overlay.querySelector(".eLocation-val[data-idx='"+i+"']")?.value || '').trim();
                const guiMood = (overlay.querySelector(".eMood-val[data-idx='"+i+"']")?.value || '').trim();
                const guiActivity = (overlay.querySelector(".eActivity-val[data-idx='"+i+"']")?.value || '').trim();
                const guiBackground = (overlay.querySelector(".eBg-val[data-idx='"+i+"']")?.value || '').trim();
                const guiCurrentSummary = (overlay.querySelector(".eCSummary-val[data-idx='"+i+"']")?.value || '').trim();
                const guiSpeechNotes = parseGuiCsv(
                    overlay.querySelector(".eSpeechNotes-val[data-idx='"+i+"']")?.value
                    || overlay.querySelector(".eSN-val[data-idx='"+i+"']")?.value
                    || ''
                );
                const guiPsychology = (overlay.querySelector(".ePsychBase-val[data-idx='"+i+"']")?.value || '').trim();
                const guiOpenThreads = parseGuiOpenThreadLabels(overlay.querySelector(".eThreads-val[data-idx='"+i+"']")?.value || '');
                d.appearance = d.appearance && typeof d.appearance === 'object' ? d.appearance : {};
                d.personality = d.personality && typeof d.personality === 'object' ? d.personality : {};
                d.speechStyle = d.speechStyle && typeof d.speechStyle === 'object' ? d.speechStyle : {};
                d.background = d.background && typeof d.background === 'object' ? d.background : {};
                d.status = d.status && typeof d.status === 'object' ? d.status : {};
                d.identity = d.identity && typeof d.identity === 'object' ? d.identity : {};
                d.identity.roleInStory = guiRole;
                d.identity.affiliation = guiAffiliation;
                d.profile = d.profile && typeof d.profile === 'object' ? d.profile : {};
                d.profile.appearance = d.profile.appearance && typeof d.profile.appearance === 'object' ? d.profile.appearance : {};
                d.profile.appearance.features = [...guiFeatures];
                d.profile.appearance.distinctiveMarks = Array.isArray(d.appearance.distinctiveMarks) ? d.appearance.distinctiveMarks : [];
                d.profile.appearance.clothing = Array.isArray(d.appearance.clothing) ? d.appearance.clothing : [];
                d.profile.personality = d.profile.personality && typeof d.profile.personality === 'object' ? d.profile.personality : {};
                d.profile.personality.traits = [...guiTraits];
                d.profile.personality.likes = Array.isArray(d.profile.personality.likes) ? d.profile.personality.likes : (Array.isArray(d.personality?.likes) ? d.personality.likes : []);
                d.profile.personality.dislikes = Array.isArray(d.profile.personality.dislikes) ? d.profile.personality.dislikes : (Array.isArray(d.personality?.dislikes) ? d.personality.dislikes : []);
                d.profile.speechStyle = d.profile.speechStyle && typeof d.profile.speechStyle === 'object' ? d.profile.speechStyle : {};
                d.profile.speechStyle.notes = [...guiSpeechNotes];
                d.background = d.background || {};
                d.background.origin = guiBackground;
                d.background.history = guiBackground ? [guiBackground] : [];
                d.appearance = d.appearance || {}; d.appearance.features = [...guiFeatures];
                d.personality = d.personality || {};
                d.personality.traits = [...guiTraits];
                d.speechStyle = d.speechStyle || {};
                d.speechStyle.notes = [...guiSpeechNotes];
                d.profile.psychology = d.profile.psychology && typeof d.profile.psychology === 'object' ? d.profile.psychology : {};
                d.profile.psychology.baseline = guiPsychology;
                d.currentState = d.currentState && typeof d.currentState === 'object' ? d.currentState : {};
                d.currentState.summary = guiCurrentSummary;
                d.currentState.location = guiLocation;
                d.currentState.emotionalState = guiMood ? parseGuiCsv(guiMood) : [];
                d.currentState.activity = guiActivity;
                d.status.currentLocation = guiLocation;
                d.status.currentMood = guiMood;
                d.currentState.lastObservedTurn = Number(d.currentState.lastObservedTurn || MemoryEngine.getCurrentTurn?.() || 0);
                d.continuity = d.continuity && typeof d.continuity === 'object' ? d.continuity : {};
                d.continuity.openThreads = guiOpenThreads;
                d.quality = d.quality && typeof d.quality === 'object' ? d.quality : {};
                d.quality.lastUpdatedTurn = Number(MemoryEngine.getCurrentTurn?.() || d.quality.lastUpdatedTurn || 0);
                d.quality.sourceMix = Array.isArray(d.quality.sourceMix) ? d.quality.sourceMix : [];
                if (!d.quality.sourceMix.includes('gui')) d.quality.sourceMix.push('gui');
                if (typeof EntityManager?.normalizeEntityRecord === 'function') d = EntityManager.normalizeEntityRecord(d);
                _ENT[i].content = JSON.stringify(d); toast("✅ 인물 데이터 수정됨");
            } else if (target.classList.contains('act-del-ent')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _ENT.length) return;
                if (!await Utils.confirmEx("이 인물 데이터를 삭제하시겠습니까?")) return;
                _ENT.splice(i, 1); renderEnts(); toast("🗑 삭제됨");
            } else if (target.classList.contains('act-block-ent')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _ENT.length) return;
                let d = parseGuiStoredJson(_ENT[i], 'entity.block', i);
                const entityName = String(d.name || '').trim();
                if (!entityName) return;
                if (!await Utils.confirmEx(`"${entityName}" 엔티티를 차단 리스트에 넣고 기존 구조 데이터도 정리하시겠습니까?`)) return;
                try {
                    const blockedName = await blockEntityFromGui(entityName, { removeStoredData: true });
                    toast(`⛔ ${blockedName} 차단됨`);
                } catch (err) {
                    toast(err?.settingsCommitted ? `⚠️ ${err.message}` : `❌ 엔티티 차단 실패: ${err?.message || err}`);
                }
            } else if (target.classList.contains('act-toggle-lock-ent')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _ENT.length) return;
                let d = parseGuiStoredJson(_ENT[i], 'entity.toggle_lock', i);
                d.meta = d.meta || {};
                const nextLocked = !d.meta.manualLocked;
                d.meta.manualLocked = nextLocked;
                d.meta.manualLockedAt = nextLocked ? Date.now() : 0;
                if (nextLocked) d.meta.source = 'gui';
                _ENT[i].content = JSON.stringify(d);
                renderEnts();
                toast(nextLocked ? "🔒 인물 수동 보호 설정됨" : "🔓 인물 수동 보호 해제됨");
            } else if (target.classList.contains('act-save-rel')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _REL.length) return;
                let d = parseGuiStoredJson(_REL[i], 'relation.save', i);
                const relationType = overlay.querySelector(".rT-val[data-idx='"+i+"']")?.value || '';
                const sentimentFromAtoB = overlay.querySelector(".rS-val[data-idx='"+i+"']")?.value || '';
                const closenessInput = overlay.querySelector(".rC-val[data-idx='"+i+"']");
                const trustInput = overlay.querySelector(".rR-val[data-idx='"+i+"']");
                const manualCloseness = closenessInput?.dataset?.unset === '1'
                    ? null
                    : (parseInt(closenessInput?.value) || 0) / 100;
                const manualTrust = trustInput?.dataset?.unset === '1'
                    ? null
                    : (parseInt(trustInput?.value) || 0) / 100;
                const currentTurn = Number(MemoryEngine.getCurrentTurn?.() || d.currentStatus?.lastChangedTurn || 0);
                const statusSummary = (overlay.querySelector(".rState-val[data-idx='"+i+"']")?.value || '').trim();
                const unresolvedIssues = parseGuiLines(overlay.querySelector(".rIssues-val[data-idx='"+i+"']")?.value || '');
                const recentChanges = parseGuiLines(overlay.querySelector(".rChanges-val[data-idx='"+i+"']")?.value || '');
                d = EntityManager.applyManualRelationProjection?.(d, {
                    relationType,
                    closeness: manualCloseness,
                    trust: manualTrust,
                    currentStatus: { summary: statusSummary, lastChangedTurn: currentTurn },
                    dynamics: { unresolvedIssues, recentChanges },
                    currentTurn,
                    sourceRevision: Date.now()
                }) || d;
                d.sentiments = d.sentiments && typeof d.sentiments === 'object' ? d.sentiments : {};
                d.sentiments.fromAtoB = sentimentFromAtoB;
                d.quality = d.quality && typeof d.quality === 'object' ? d.quality : {};
                d.quality.lastUpdatedTurn = currentTurn;
                d.quality.sourceMix = Array.isArray(d.quality.sourceMix) ? d.quality.sourceMix : [];
                if (!d.quality.sourceMix.includes('gui')) d.quality.sourceMix.push('gui');
                _REL[i].content = JSON.stringify(d);
                renderEnts();
                toast("✅ 관계 데이터 수정됨");
            } else if (target.classList.contains('act-unset-rel-score')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _REL.length) return;
                const field = String(target.dataset.field || '').trim();
                const selector = field === 'trust' ? '.rR-val' : '.rC-val';
                const input = overlay.querySelector(`${selector}[data-idx='${i}']`);
                if (input) {
                    input.dataset.unset = '1';
                    input.value = '0';
                }
                toast(field === 'trust' ? '신뢰도를 미정으로 표시합니다. 저장을 눌러 반영하세요.' : '친밀도를 미정으로 표시합니다. 저장을 눌러 반영하세요.');
            } else if (target.classList.contains('act-toggle-lock-rel')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _REL.length) return;
                let d = parseGuiStoredJson(_REL[i], 'relation.toggle_lock', i);
                d.meta = d.meta || {};
                const nextLocked = !d.meta.manualLocked;
                d.meta.manualLocked = nextLocked;
                d.meta.manualLockedAt = nextLocked ? Date.now() : 0;
                if (nextLocked) d.meta.source = 'gui';
                _REL[i].content = JSON.stringify(d);
                renderEnts();
                toast(nextLocked ? "🔒 관계 수동 보호 설정됨" : "🔓 관계 수동 보호 해제됨");
            } else if (target.classList.contains('act-del-rel')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= _REL.length) return;
                if (!await Utils.confirmEx("이 관계 데이터를 삭제하시겠습니까?")) return;
                _REL.splice(i, 1); renderEnts(); toast("🗑 삭제됨");
            } else if (target.classList.contains('act-unblock-ent')) {
                const name = String(target.dataset.name || '').trim();
                if (!name) return;
                try { await unblockEntityFromGui(name); }
                catch (error) { toast(error?.settingsCommitted ? `⚠️ ${error.message}` : `❌ 차단 해제 실패: ${error?.message || error}`); }
            } else if (target.classList.contains('act-save-nar')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= (_NAR.storylines || []).length) return;
                const storyline = _NAR.storylines[i] || {};
                storyline.meta = storyline.meta || {};
                storyline.meta.manualLocked = true;
                storyline.meta.manualLockedAt = Date.now();
                storyline.name = (overlay.querySelector(".nN-val[data-idx='"+i+"']")?.value || '').trim() || `Storyline ${i + 1}`;
                storyline.entities = (overlay.querySelector(".nE-val[data-idx='"+i+"']")?.value || '').split(",").map(s => s.trim()).filter(Boolean);
                storyline.currentContext = (overlay.querySelector(".nC-val[data-idx='"+i+"']")?.value || '').trim();
                storyline.keyPoints = (overlay.querySelector(".nK-val[data-idx='"+i+"']")?.value || '').split(",").map(s => s.trim()).filter(Boolean);
                storyline.ongoingTensions = (overlay.querySelector(".nO-val[data-idx='"+i+"']")?.value || '').split(",").map(s => s.trim()).filter(Boolean);
                storyline.recentEvents = (overlay.querySelector(".nR-val[data-idx='"+i+"']")?.value || '')
                    .split(/\r?\n/)
                    .map(s => s.trim())
                    .filter(Boolean)
                    .map((line, idx) => {
                        const match = line.match(/^T(\d+)\s*:\s*(.+)$/i);
                        if (match) return { turn: Number(match[1]), brief: match[2].trim() };
                        return { turn: idx + 1, brief: line };
                    });
                const latestSummary = (overlay.querySelector(".nS-val[data-idx='"+i+"']")?.value || '').trim();
                storyline.summaries = Array.isArray(storyline.summaries) ? storyline.summaries : [];
                if (latestSummary) {
                    const upToTurn = MemoryEngine.getCurrentTurn();
                    const last = storyline.summaries[storyline.summaries.length - 1];
                    if (last) {
                        last.summary = latestSummary;
                        last.upToTurn = upToTurn;
                        last.keyPoints = [...storyline.keyPoints];
                        last.ongoingTensions = [...storyline.ongoingTensions];
                    } else {
                        storyline.summaries.push({ upToTurn, summary: latestSummary, keyPoints: [...storyline.keyPoints], ongoingTensions: [...storyline.ongoingTensions], timestamp: Date.now() });
                    }
                }
                _NAR.storylines[i] = storyline;
                renderNarrative();
                toast("✅ 내러티브 수정됨");
            } else if (target.classList.contains('act-toggle-lock-nar')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= (_NAR.storylines || []).length) return;
                const storyline = _NAR.storylines[i] || {};
                storyline.meta = storyline.meta || {};
                const nextLocked = !storyline.meta.manualLocked;
                storyline.meta.manualLocked = nextLocked;
                storyline.meta.manualLockedAt = nextLocked ? Date.now() : 0;
                _NAR.storylines[i] = storyline;
                renderNarrative();
                toast(nextLocked ? "🔒 내러티브 수동 보호 설정됨" : "🔓 내러티브 수동 보호 해제됨");
            } else if (target.classList.contains('act-del-nar')) {
                const i = parseInt(target.dataset.idx, 10);
                if (isNaN(i) || i < 0 || i >= (_NAR.storylines || []).length) return;
                if (!await Utils.confirmEx("이 스토리라인을 삭제하시겠습니까?")) return;
                _NAR.storylines.splice(i, 1);
                renderNarrative();
                toast("🗑 스토리라인 삭제됨");
            }
        });

        overlay.querySelector('#btn-transition').onclick = async () => {
            const confirmed = await Utils.confirmEx(
                "현재 기억을 보존한 채 새 채팅방을 자동 생성하시겠습니까?\n모든 LIBRA 데이터(기억, 엔티티, 세계관 등)가 새 방으로 계승됩니다.\n(LLM 토큰이 일부 소모될 수 있습니다)"
            );
            if (!confirmed) return;

            LMAI_GUI.toast("🚀 세션 전환 중...");
            const success = await TransitionManager.executeTransition();
            
            if (success) {
                await Utils.alertEx(
                    "✅ 새 세션 생성 완료!\n\n모든 기억과 세계관 데이터가 새 채팅방으로 계승되었습니다.\n채팅 목록에서 새로 생성된 방을 확인하세요."
                );
                closeGuiOverlay();
            } else {
                await Utils.alertEx("❌ 세션 전환 중 오류가 발생했습니다. 다시 시도해 주세요.");
            }
        };

        overlay.querySelector('#btn-cold-start').onclick = async () => {
            try {
                const result = await ColdStartManager.startAutoSummarization({
                    trigger: 'manual_gui',
                    reason: '현재 채팅방의 과거 내역을 분석해 초기 구조를 만들거나 기존 정본을 보강합니다.'
                });
                if (result?.skipped) {
                    toast('ℹ️ 초기 구조 분석 취소됨');
                    return;
                }
                lore = MemoryEngine.getLorebook(char, chat) || lore;
                syncGuiSnapshotsFromRuntime();
                renderAllGuiDataViews();
            } catch (e) {
                toast(`❌ 초기 구조 분석 실패: ${e?.message || e}`);
            }
        };

        overlay.querySelector('#btn-cold-reanalyze').onclick = async () => {
            try {
                await runUnifiedHistoricalReanalysisFromGui('과거 대화 통합 재분석');
            } catch (e) {
                toast(`❌ 과거 대화 재분석 실패: ${e?.message || e}`);
            }
        };

        overlay.querySelector('#btn-add-narrative').onclick = () => {
            _NAR.storylines = Array.isArray(_NAR.storylines) ? _NAR.storylines : [];
            _NAR.storylines.push({
                id: (_NAR.storylines.reduce((max, s) => Math.max(max, Number(s?.id || 0)), 0) || 0) + 1,
                name: `New Storyline ${_NAR.storylines.length + 1}`,
                entities: [],
                turns: [],
                recentEvents: [],
                summaries: [],
                keyPoints: [],
                ongoingTensions: [],
                currentContext: ''
            });
            renderNarrative();
            toast("➕ 스토리라인 추가됨");
        };

        overlay.querySelector('#btn-save-narrative').onclick = async () => {
            const narrativeEntry = buildNarrativeLoreEntry();
            const nextLore = lore.filter(e => e.comment !== 'lmai_narrative').map(entry => safeClone(entry));
            nextLore.push(narrativeEntry);
            await saveLoreToChar(nextLore, (saved = {}) => {
                const savedLore = Array.isArray(saved.lore) ? saved.lore : nextLore;
                NarrativeTracker.loadState(savedLore);
                StoryAuthor.loadState(savedLore);
                Director.loadState(savedLore);
                WorldAdditionalCore.loadState?.(savedLore, {
                    scopeKey: saved.scopeKey || getChatRuntimeScopeKey(saved.targetChat, saved.targetChar),
                    chatId: String(saved.chatId || saved.targetChat?.id || '').trim()
                });
                UserDlcCore.loadState?.(savedLore, {
                    scopeKey: saved.scopeKey || getChatRuntimeScopeKey(saved.targetChat, saved.targetChar),
                    chatId: String(saved.chatId || saved.targetChat?.id || '').trim()
                });
                toast("💾 내러티브 저장 완료");
            });
        };

        // 초기 화면 렌더링
        filterMems();
        renderEnts();
        renderNarrative();
        renderWorld();
        loadSettings();
        await mountWmStorageSettings();
        renderWorldAdditional();
        renderHome();

        await refreshHealthReviewFromStorage();
        await R.showContainer('fullscreen');
    };

    const toast = (m, d) => {
        try { void LibraToast.notify(m, { duration: d || 2000, key: `gui:${String(m || '')}` }); } catch {}
    };

    return {
        show,
        disposeStoragePanels,
        toast,
        buildNarrativeInspectorSnapshot,
        renderNarrativeInspectorHtml
    };
})();
