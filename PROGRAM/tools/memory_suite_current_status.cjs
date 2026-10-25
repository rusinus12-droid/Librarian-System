'use strict';

// Embedded in the owner GUI. Only applied settings and observational storage
// probes are read here; opening a status row must never call a model or migrate.
module.exports = function createMemorySuiteCurrentStatus(options) {
  const bridge = options.bridge;
  let serial = 0, timer = null, unsubscribe = null, cache = null, pending = null;
  const visible = () => options.isVisible() && options.getRoot()?.isConnected;
  const signature = config => JSON.stringify([config.mode, config.url, config.scopeId,
    config.global?.set, config.global?.mode,
    config.transition, config.migrationRequired, config.recoveryRequired]);
  const setStorage = (foot, text, warning = false, detail = '') => {
    const row = foot.querySelector('[data-current-status="storage"]');
    if (!row) return;
    row.textContent = text.startsWith('저장:') || text.startsWith('전역 저장:') ? text : `저장: ${text}`;
    row.dataset.warning = String(warning);
    row.title = [detail, '저장 설정으로 이동'].filter(Boolean).join(' · ');
    row.style.color = warning ? 'var(--warn-ink, #a05415)' : '';
    row.style.background = warning ? 'var(--warn-soft, #fbeccb)' : '';
    row.style.fontWeight = warning ? '700' : '';
  };
  const mount = root => {
    const foot = root.querySelector('.side-foot');
    if (!foot) return null;
    if (!foot.querySelector('[data-current-status]')) {
      const doc = foot.ownerDocument;
      const node = (tag, text) => { const el = doc.createElement(tag); el.textContent = text; return el; };
      // Retain the owner's sidebar footer, like LIBRA. It stays expanded and
      // participates in sidebar layout rather than covering the main content.
      foot.classList.add('current-status-panel');
      const body = node('div', ''); body.className = 'current-status-body';
      foot.replaceChildren(node('b', '현재 상태'), body);
      foot.setAttribute('aria-label', '현재 상태 및 설정 바로가기');
      for (const row of [{ id:'storage', text:'저장: 확인 중', target:'server' }, ...options.getRows()]) {
        const button = node('button', row.text);
        button.type = 'button'; button.className = 'current-status-row';
        button.dataset.currentStatus = row.id;
        button.title = '관련 설정으로 이동';
        button.addEventListener('click', () => options.navigate(row.target));
        body.appendChild(button);
      }
      const refresh = node('button', '상태 다시 확인');
      refresh.type = 'button'; refresh.className = 'current-status-row current-status-refresh';
      refresh.dataset.currentStatusRefresh = 'true';
      refresh.addEventListener('click', () => { cache = null; void refreshStatus(true); });
      body.append(refresh, node('small', '각 항목을 눌러 설정 변경'));
      const style = node('style', `
        .side-foot.current-status-panel{position:sticky;bottom:0;flex-shrink:0;margin-top:auto;padding:10px 12px;background:var(--side-foot-bg,var(--surface,#fff));color:var(--side-text,var(--text,#252321));border:1px solid var(--side-line,var(--border2,#ccc))}
        .current-status-body{margin-top:5px}
        .side-foot .current-status-row{display:block;width:100%;min-width:0;margin:3px 0;padding:4px 2px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;line-height:1.5;white-space:normal;overflow-wrap:anywhere;cursor:pointer}
        .side-foot .current-status-row:hover{background:var(--side-line,var(--border));text-decoration:underline}
        .side-foot .current-status-row:focus-visible{outline:2px solid currentColor;outline-offset:1px}
        .side-foot small{display:block;font-size:11px;line-height:1.5}
        .side-foot .current-status-refresh{font-size:11px;text-decoration:underline}
      `);
      foot.appendChild(style);
    }
    for (const row of options.getRows()) {
      const button = foot.querySelector(`[data-current-status="${row.id}"]`);
      if (button) button.textContent = row.text;
    }
    return foot;
  };
  const refreshStatus = async (force = false) => {
    if (!visible()) return;
    const root = options.getRoot(), foot = mount(root);
    if (!foot) return;
    const attempt = ++serial, identity = options.getIdentity();
    const current = () => attempt === serial && visible() && root === options.getRoot()
      && identity === options.getIdentity() && foot.isConnected;
    setStorage(foot, '확인 중');
    try {
      const config = await bridge.getConnectionSettings();
      if (!current()) return;
      const job = bridge.getSyncJob?.();
      if (config.transition || config.migrationRequired || (job && !['completed','cancelled','failed'].includes(job.status))) {
        setStorage(foot, '이전 완료 확인 필요', true); return;
      }
      if (config.recoveryRequired) { setStorage(foot, '초기화·복원 확인 필요', true); return; }

      const hasScope = Boolean(config.scopeId);
      const isGlobalSet = Boolean(config.global?.set);
      const globalMode = config.global?.mode || 'plugin_only';
      const effectiveMode = hasScope ? config.mode : (isGlobalSet ? globalMode : config.mode);

      if (effectiveMode === 'plugin_only') {
        setStorage(foot, (!hasScope && isGlobalSet) ? '전역 저장: 플러그인 모드' : '플러그인 모드');
        return;
      }
      if (!['server_only','mirror'].includes(effectiveMode)) { setStorage(foot, '설정 확인 필요', true); return; }
      const key = signature(config);
      // Reuse a recent successful connection-page probe. A fresh settings read
      // alone is not evidence that the server answered.
      if (!force && config.status?.state === 'connected' && config.status.url === config.url
          && Date.now() - Number(config.status.at || 0) < 15000) {
        cache = { key, at:Number(config.status.at), result:{ok:true} };
      }
      // Coalesce repeated GUI renders into one in-flight observational request.
      if (!cache || cache.key !== key || Date.now() - cache.at > 15000) {
        if (!pending || pending.key !== key) {
          const probe = { key, promise: bridge.testConnection(config.url) };
          pending = probe;
          void probe.promise.finally(() => { if (pending === probe) pending = null; }).catch(() => {});
        }
        const result = await pending.promise;
        if (!current()) return;
        const checked = await bridge.getConnectionSettings();
        if (!current()) return;
        if (signature(checked) !== key) { cache = null; void refreshStatus(); return; }
        if (/connection_stale/i.test(String(result?.error || ''))) {
          // Another settings/probe operation superseded this read. It is not
          // proof of an offline server, and must not become a red warning.
          cache = null; setStorage(foot, '연결 확인 중'); return;
        }
        cache = { key, at: Date.now(), result };
      }
      const result = cache.result;
      let label = '';
      if (result?.ok) {
        if (effectiveMode === 'mirror') {
          label = '이전 설정 · 전환 필요';
        } else if (!hasScope && isGlobalSet) {
          label = '전역 저장: 서버 모드 · 연결됨';
        } else {
          label = '서버 모드 · 연결됨';
        }
      } else {
        label = (!hasScope && isGlobalSet) ? '전역 저장: 서버 연결 미완료' : '서버 연결 미완료';
      }
      setStorage(foot, label, !result?.ok || effectiveMode === 'mirror',
        result?.ok ? '' : String(result?.error || '서버 응답을 확인하지 못했습니다.'));
    } catch (error) {
      if (current()) setStorage(foot, '확인 필요', true, String(error?.message || error));
    }
  };
  const stop = () => {
    ++serial; clearTimeout(timer); timer = null; cache = null;
    try { unsubscribe?.(); } catch (_) {} unsubscribe = null;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!visible()) { stop(); return; }
      void refreshStatus(); schedule();
    }, 15000);
    try { timer?.unref?.(); } catch (_) {}
  };
  const sync = () => {
    if (!visible()) return;
    if (!unsubscribe && bridge.subscribeSyncJob) unsubscribe = bridge.subscribeSyncJob(() => {
      cache = null;
      // A job may report every transferred item. Debounce those updates.
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (visible()) { void refreshStatus(); schedule(); } else stop(); }, 200);
    });
    void refreshStatus(); schedule();
  };
  return { sync, stop };
};
