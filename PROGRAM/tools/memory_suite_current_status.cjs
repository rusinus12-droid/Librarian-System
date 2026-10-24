'use strict';

// Embedded in the owner GUI. Only applied settings and observational storage
// probes are read here; opening a status row must never call a model or migrate.
module.exports = function createMemorySuiteCurrentStatus(options) {
  const bridge = options.bridge;
  let serial = 0, timer = null, unsubscribe = null, cache = null, pending = null;
  const visible = () => options.isVisible() && options.getRoot()?.isConnected;
  const signature = config => JSON.stringify([config.mode, config.url, config.scopeId,
    config.transition, config.migrationRequired, config.recoveryRequired]);
  const setStorage = (foot, text, warning = false, detail = '') => {
    const row = foot.querySelector('[data-current-status="storage"]');
    if (!row) return;
    row.textContent = `저장: ${text}`;
    row.dataset.warning = String(warning);
    row.title = [detail, '저장 설정으로 이동'].filter(Boolean).join(' · ');
    row.style.color = warning ? 'var(--warn-ink, #a05415)' : '';
    row.style.fontWeight = warning ? '700' : '';
    const summary = foot.querySelector('[data-current-status-summary]');
    if (summary) { summary.textContent = text; summary.style.color = row.style.color; }
  };
  const mount = root => {
    const foot = root.querySelector('.side-foot');
    if (!foot) return null;
    if (!foot.querySelector('[data-current-status]')) {
      const doc = foot.ownerDocument;
      const node = (tag, text) => { const el = doc.createElement(tag); el.textContent = text; return el; };
      // Keep the status visible when narrow layouts hide the sidebar. The card
      // belongs to the GUI app, not the host chat, and can be folded out of the way.
      (root.querySelector('.app') || root).appendChild(foot);
      foot.classList.add('current-status-panel');
      const fold = node('details', ''), heading = node('summary', '현재 상태 · '), summary = node('span', '확인 중');
      fold.open = doc.defaultView?.innerWidth >= 900;
      summary.dataset.currentStatusSummary = 'true'; heading.appendChild(summary); fold.appendChild(heading);
      const body = node('div', ''); body.className = 'current-status-body'; fold.appendChild(body);
      foot.replaceChildren(fold);
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
        .side-foot.current-status-panel{position:absolute;right:12px;bottom:12px;z-index:10;width:min(270px,calc(100% - 24px));max-height:45%;overflow:auto;margin:0;padding:10px 12px;background:var(--surface,#fff);color:var(--text,#252321);border:1px solid var(--border2,#ccc);box-shadow:0 3px 16px rgba(0,0,0,.14)}
        .current-status-panel summary{cursor:pointer;overflow-wrap:anywhere;line-height:1.5;font-weight:700}
        .current-status-panel summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
        .current-status-body{margin-top:5px}
        .side-foot .current-status-row{display:block;width:100%;min-width:0;margin:3px 0;padding:4px 2px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;line-height:1.5;white-space:normal;overflow-wrap:anywhere;cursor:pointer}
        .side-foot .current-status-row:hover{background:var(--side-line,var(--border));text-decoration:underline}
        .side-foot .current-status-row:focus-visible{outline:2px solid currentColor;outline-offset:1px}
        .side-foot small{display:block;font-size:11px;line-height:1.5}
        .side-foot .current-status-refresh{font-size:11px;text-decoration:underline}
        @container app (max-width:640px){.side-foot.current-status-panel{bottom:calc(72px + env(safe-area-inset-bottom,0px));max-height:40%}}
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
      if (config.mode === 'plugin_only') { setStorage(foot, '플러그인 모드'); return; }
      if (!['server_only','mirror'].includes(config.mode)) { setStorage(foot, '설정 확인 필요', true); return; }
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
      setStorage(foot, result?.ok ? (config.mode === 'server_only' ? '서버 모드 · 연결됨' : '이전 설정 · 전환 필요')
        : '서버 연결 미완료', !result?.ok || config.mode === 'mirror', result?.ok ? '' : String(result?.error || '서버 응답을 확인하지 못했습니다.'));
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
