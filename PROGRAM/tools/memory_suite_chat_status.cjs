'use strict';

// Presentation only. Each owner keeps its work, cancellation and result state.
module.exports = function createMemorySuiteChatStatus(options = {}) {
  const id = String(options.id || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('chat_status_id_invalid');
  const rootId = `${id}-compact`, closeId = `${id}-close`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const api = methods => options.api?.(methods) || {};
  let disposed = false, dismissed = false, epoch = 0, tail = Promise.resolve(), binding = null;
  const unbind = async () => {
    const previous = binding;
    binding = null;
    if (previous) try { await previous.button.removeEventListener('click', previous.listener); } catch (_) {}
  };
  const queue = action => {
    const next = tail.catch(() => {}).then(action);
    tail = next.catch(() => {});
    return next;
  };
  const current = version => !disposed && !dismissed && epoch === version;
  const bindClose = async version => {
    const domApi = api(['getRootDocument']);
    if (typeof domApi.getRootDocument !== 'function') return;
    try {
      const permissionApi = api(['requestPluginPermission']);
      if (typeof permissionApi.requestPluginPermission === 'function'
        && await permissionApi.requestPluginPermission('mainDom') === false) return;
      for (let attempt = 0; attempt < 25 && current(version); attempt += 1) {
        const root = await domApi.getRootDocument();
        const button = await root?.getElementById?.(closeId);
        if (!current(version)) return;
        if (button && typeof button.addEventListener === 'function') {
          try {
            const hostSection = await (root?.querySelector ? root.querySelector(`section[data-plugin-chat-panel="${id}"]`) : null);
            if (hostSection?.style) {
              hostSection.style.padding = '0';
              hostSection.style.border = '0';
              hostSection.style.background = 'transparent';
            }
          } catch (_) {}
          const listener = await button.addEventListener('click', async event => {
            if (!current(version)) return;
            // Older SafeElement hosts delegate clicks through the document and
            // strip event.target. Check the actual button bounds, or focus for
            // the zero-coordinate click produced by keyboard activation.
            const x = Number(event?.clientX), y = Number(event?.clientY);
            let inside = false;
            if (Number.isFinite(x) && Number.isFinite(y)) {
              const rect = await button.getBoundingClientRect();
              inside = rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
              if (!inside && x === 0 && y === 0 && typeof root.querySelector === 'function')
                inside = !!(await root.querySelector(`#${closeId}:focus`));
            }
            if (inside && current(version)) await dismiss();
          });
          if (!current(version)) {
            try { await button.removeEventListener('click', listener); } catch (_) {}
            return;
          }
          binding = { button, listener };
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } catch (_) { /* The status text remains readable when mainDom is unavailable. */ }
  };
  const render = view => {
    const brand = escape(options.brand), message = escape(view.message);
    const state = ['done','error','cancelled'].includes(view.state) ? view.state : 'working';
    const label = { working:'진행 중', done:'완료', error:'확인 필요', cancelled:'취소됨' }[state];
    const accent = { working:'#a8b9ff', done:'#79d8b2', error:'#ffacb4', cancelled:'#c7b6ef' }[state];
    const result = view.result && view.result !== view.message
      ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;font:11px/1.6 ui-monospace,monospace;color:#c8d3e8">${escape(view.result)}</pre>`
      : '';
    const cancel = view.cancelId
      ? `<button id="${escape(view.cancelId)}" class="mscs-cancel" type="button" aria-label="${brand} 전송 취소" style="box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:28px;border-radius:6px;font:inherit;cursor:pointer;padding:0 7px;border:1px solid rgba(255,172,180,.3);background:rgba(255,172,180,.06);color:#ffbec5;font-size:11px;flex:none">전송 취소</button>`
      : '';
    // Only the owning host section is restyled. No shared container, chat input
    // or other plugin panel is selected, reordered or positioned by this CSS.
    return `<div id="${rootId}" style="--mscs-accent:${accent};box-sizing:border-box;width:100%;max-width:100%;border:1px solid rgba(136,155,188,.24);border-radius:10px;background:linear-gradient(115deg,rgba(25,34,51,.97),rgba(16,23,36,.96));color:#dce5f5;font:12px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.10);overflow:hidden"><style>
section[data-plugin-chat-panel="${id}"]{padding:0!important;border:0!important;background:transparent!important}
#${rootId}{box-sizing:border-box;width:100%;max-width:100%;border:1px solid rgba(136,155,188,.24);border-radius:10px;background:linear-gradient(115deg,rgba(25,34,51,.97),rgba(16,23,36,.96));color:#dce5f5;font:12px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.10);overflow:hidden}
#${rootId} .mscs-bar{display:flex;align-items:flex-start;gap:9px;min-height:38px;padding:5px 8px;box-sizing:border-box;width:100%}
#${rootId} .mscs-brand{display:flex;align-items:center;gap:7px;flex:none;height:28px;font-size:10px;font-weight:750;letter-spacing:.07em;color:#dce5f5}
#${rootId} .mscs-dot{width:6px;height:6px;border-radius:50%;background:var(--mscs-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mscs-accent) 10%,transparent);flex:none;display:inline-block}
#${rootId} .mscs-state{flex:none;line-height:28px;font-size:10px;color:var(--mscs-accent)}
#${rootId} details{flex:1 1 auto;min-width:0;margin:0;padding:0;border:0}
#${rootId} summary{display:flex;align-items:center;gap:5px;min-height:28px;cursor:pointer;list-style:none;border-radius:5px;color:#c8d3e8;outline:none}
#${rootId} summary::-webkit-details-marker{display:none}
#${rootId} .mscs-preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
#${rootId} .mscs-chevron{width:12px;height:12px;min-width:12px;min-height:12px;max-width:12px;max-height:12px;flex:none;display:inline-block;vertical-align:middle;opacity:.55;transition:transform .15s}
#${rootId} details[open] .mscs-chevron{transform:rotate(180deg)}
#${rootId} .mscs-body{margin:4px 0 3px;padding:8px 0 2px;border-top:1px solid rgba(136,155,188,.16);white-space:pre-wrap;overflow-wrap:anywhere;color:#c8d3e8;max-height:160px;overflow:auto}
#${rootId} pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;font:11px/1.6 ui-monospace,monospace}
#${rootId} .mscs-actions{display:flex;gap:4px;flex:none;align-items:center}
#${rootId} button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:28px;border-radius:6px;font:inherit;cursor:pointer;transition:background .15s,color .15s}
#${rootId} .mscs-close{width:28px;border:0;background:transparent;color:#94a4c1;font-size:19px;line-height:1}
#${rootId} .mscs-close:hover{background:rgba(167,185,220,.12);color:#fff}
#${rootId} .mscs-cancel{padding:0 7px;border:1px solid rgba(255,172,180,.3);background:rgba(255,172,180,.06);color:#ffbec5;font-size:11px}
#${rootId} .mscs-cancel:hover{background:rgba(255,172,180,.14)}
#${rootId} button:focus-visible,#${rootId} summary:focus-visible{outline:2px solid var(--mscs-accent);outline-offset:2px}
@media(max-width:520px){#${rootId} .mscs-bar{gap:6px;padding:4px 6px;min-height:40px}#${rootId} .mscs-brand{height:32px;gap:5px;font-size:9px}#${rootId} .mscs-state{line-height:32px;font-size:9px}#${rootId} summary{min-height:32px}#${rootId} button{min-height:32px}#${rootId} .mscs-close{width:32px}#${rootId} .mscs-cancel{font-size:10px;padding:0 5px}}
@media(prefers-reduced-motion:reduce){#${rootId} button,#${rootId} .mscs-chevron{transition:none}}
</style><div class="mscs-bar" style="display:flex;align-items:flex-start;gap:9px;min-height:38px;padding:5px 8px;box-sizing:border-box;width:100%"><span class="mscs-brand" style="display:flex;align-items:center;gap:7px;flex:none;height:28px;font-size:10px;font-weight:750;letter-spacing:.07em;color:#dce5f5"><span class="mscs-dot" aria-hidden="true" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${accent};box-shadow:0 0 0 3px color-mix(in srgb,${accent} 10%,transparent);flex:none"></span>${brand}</span><span class="mscs-state" role="status" style="flex:none;line-height:28px;font-size:10px;color:${accent};font-weight:600">${label}</span><details style="flex:1 1 auto;min-width:0;margin:0;padding:0;border:0"><summary title="${message}" aria-label="${brand} 작업 상세 펼치기" style="display:flex;align-items:center;gap:5px;min-height:28px;cursor:pointer;list-style:none;border-radius:5px;color:#c8d3e8;outline:none"><span class="mscs-preview" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;font-size:11px;line-height:28px">${message}</span><svg class="mscs-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" style="width:12px;height:12px;min-width:12px;min-height:12px;max-width:12px;max-height:12px;flex:none;display:inline-block;vertical-align:middle;opacity:.55;transition:transform .15s"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></summary><div class="mscs-body" style="margin:4px 0 3px;padding:8px 0 2px;border-top:1px solid rgba(136,155,188,.16);white-space:pre-wrap;overflow-wrap:anywhere;color:#c8d3e8;max-height:160px;overflow:auto">${message}${result}</div></details><div class="mscs-actions" style="display:flex;gap:4px;flex:none;align-items:center">${cancel}<button id="${closeId}" class="mscs-close" type="button" title="상태 표시 닫기 · 작업은 계속됩니다" aria-label="${brand} 상태 표시 닫기" style="box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:28px;width:28px;border-radius:6px;font:inherit;cursor:pointer;border:0;background:transparent;color:#94a4c1;font-size:19px;line-height:1">×</button></div></div></div>`;
  };
  const show = async view => {
    const version = ++epoch;
    await unbind();
    return await queue(async () => {
      if (disposed || version !== epoch) return false;
      const panelApi = api(['setChatPanel']);
      if (typeof panelApi.setChatPanel !== 'function') return false;
      const visible = !!view.message && !dismissed;
      await panelApi.setChatPanel(visible ? render(view) : null, { id, className: options.className || '' });
      if (current(version) && visible) void bindClose(version);
      return visible;
    });
  };
  const dismiss = async () => {
    if (disposed || dismissed) return false;
    dismissed = true;
    options.onDismiss?.();
    await show({ message:'' });
    return true;
  };
  return {
    show,
    begin() { dismissed = false; epoch += 1; void unbind(); },
    dismiss,
    isDismissed() { return dismissed; },
    async dispose() {
      disposed = true; epoch += 1;
      await unbind();
      await queue(async () => { await api(['setChatPanel']).setChatPanel?.(null, { id }); });
    }
  };
};
