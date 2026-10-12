(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  function setv(el,v){ el.value=v; fire(el); }
  function stitle(){ return q('#savebar [data-save-title]').textContent; }
  function shelfRow(name){ return qa('#shelf-list .row').filter(function(r){return r.textContent.indexOf(name)>-1})[0]; }
  function btnText(root, t){ return qa('button', root).filter(function(b){return b.textContent.indexOf(t)>-1})[0]; }
  function openEdit(name){ window.suiteGo('shelf'); return wait().then(function(){ shelfRow(name).click(); return wait(); }); }
  function adopt(){ var b=q('#btn-adopt'); return b.textContent+'|'+(b.disabled?'off':'on'); }
  function lastToast(){ var t=qa('.toast'); return t.length?t[t.length-1].textContent:''; }
  function openOv(){ var o=qa('.overlay.is-open'); return o.length?o[o.length-1].id:'none'; }

  /* ===== 1. 채택본(v3) vs 보관함 최신본(v4) ===== */
  await openEdit('세라 하운');
  var pers = q('#edit-root [data-key="personality"]'); var v3pers = pers.value;
  setv(pers, '수정본 v4 성격 (채택 전)'); await wait();
  q('#savebar [data-save]').click(); await wait();
  out.i1_afterSave = q('#edit-root [data-fill="ver"]').textContent + ' / ' + adopt();
  window.suiteGo('make'); await wait();
  var sel = q('#src-sel'); sel.value = 'sera'; fire(sel); await wait();
  out.i1_option = sel.options[sel.selectedIndex].textContent;
  out.i1_hint = q('#src-hint').textContent;
  ok.i1_hintExplains = /v4 수정본/.test(out.i1_hint) && /채택본 v3/.test(out.i1_hint);
  q('#mk-classic').click(); await wait(6000);
  var done = qa('#job-gen [data-job-done]').filter(function(b){return !b.hidden})[0]; done.click(); await wait(200);
  out.i1_genPers = q('#edit-root [data-key="personality"]').value;
  out.i1_genVerNote = q('#ver-list small').textContent;
  ok.i1_usesAdopted = out.i1_genPers === v3pers;
  ok.i1_noteSaysAdopted = /채택본 v3/.test(out.i1_genVerNote);

  /* ===== 2. 채택 옵션만 바꿔도 다시 채택 ===== */
  await openEdit('이름 없는 길손');
  out.i2_start = adopt() + ' / ' + stitle();
  ok.i2_startLatest = /최신/.test(adopt()) && /off/.test(adopt());
  qa('#ed-density .choice')[2].click(); await wait();   // Compact
  out.i2_compact = adopt() + ' / ' + stitle() + ' / ' + q('#adopt-diff').textContent;
  ok.i2_compactEnables = /바뀐 옵션/.test(adopt()) && /on/.test(adopt()) && /저장되어/.test(stitle());
  q('#btn-adopt').click(); await wait();
  out.i2_adopted = adopt() + ' / ' + q('#edit-root [data-fill="statusText"]').textContent + ' / toast=' + lastToast();
  ok.i2_afterAdoptLatest = /최신/.test(adopt()) && /Compact/.test(out.i2_adopted);
  qa('#ad-lang button')[1].click(); await wait();       // 번역본
  out.i2_lang = adopt() + ' / ' + q('#adopt-diff').textContent;
  ok.i2_langEnables = /on/.test(adopt());
  qa('#ad-mode .choice')[1].click(); await wait();      // 새 Persona로 저장
  out.i2_mode = q('#adopt-diff').textContent;
  ok.i2_modeListed = /저장 방식/.test(out.i2_mode) && /채택 내용/.test(out.i2_mode);
  // 다른 Persona로 갔다 와도 고른 옵션 유지
  await openEdit('카엘 로웬'); await openEdit('이름 없는 길손');
  out.i2_keep = qa('#ad-lang button').map(function(b){return b.getAttribute('aria-pressed')}).join() + ' / ' + adopt();
  ok.i2_optionsKept = qa('#ad-lang button')[1].getAttribute('aria-pressed')==='true' && /on/.test(adopt());
  // 원래대로 되돌리면 다시 비활성
  qa('#ad-lang button')[0].click(); qa('#ad-mode .choice')[0].click(); await wait();
  out.i2_back = adopt();
  ok.i2_backDisabled = /off/.test(adopt());
  // 내용 변경 + 옵션 변경 동시
  window.suiteGo('shelf'); await wait();
  out.i2_shelfBadge = shelfRow('이름 없는 길손').textContent.replace(/\s+/g,' ').slice(0,60);

  /* ===== 3. 보관함 삭제 후 관리 경로 ===== */
  await openEdit('이름 없는 길손');
  q('#btn-del-vault').click(); await wait();
  out.i3_vaultSheet = q('#sheet-del-vault [data-fill="afterVault"]').textContent;
  btnText(q('#sheet-del-vault'), '보관함에서 삭제').click(); await wait();
  out.i3_toast = lastToast(); out.i3_page = q('.page.is-active').dataset.page;
  out.i3_inShelf = !!shelfRow('이름 없는 길손');
  window.suiteGo('mine'); await wait();
  var card = qa('#mine-list .pcard').filter(function(c){return c.textContent.indexOf('이름 없는 길손')>-1})[0];
  out.i3_card = card ? card.textContent.replace(/\s+/g,' ').trim() : 'NONE';
  card.click(); await wait();
  out.i3_manage = openOv() + ' :: ' + q('#spm-kv').textContent + ' :: ' + qa('#spm-act button').map(function(b){return b.textContent.trim()}).join(' | ');
  ok.i3_manageOpens = openOv()==='sheet-persona' && /삭제됨/.test(q('#spm-kv').textContent);
  btnText(q('#spm-act'), '이 채팅에 연결').click(); await wait();
  out.i3_bindSheet = openOv() + ' sel=' + ((q('#bind-list .is-on[data-pid]')||{}).dataset||{}).pid;
  q('#btn-bind-go').click(); await wait();
  out.i3_pocket = q('#pocket h2').textContent + ' :: ' + qa('#pocket .pocket__act button').map(function(b){return b.textContent.trim()}).join(' | ');
  ok.i3_boundAndManageBtn = /길손/.test(out.i3_pocket) && /관리/.test(out.i3_pocket) && !/편집/.test(out.i3_pocket);
  btnText(q('#pocket'), '관리').click(); await wait();
  btnText(q('#spm-act'), '연결 해제').click(); await wait();
  out.i3_unbindSheet = openOv() + ' :: ' + q('#sheet-unbind h2').textContent;
  btnText(q('#sheet-unbind .dialog__actions'), '연결 해제').click(); await wait();
  out.i3_afterUnbind = q('#pocket h2').textContent;
  ok.i3_unbound = /연결된 Persona 없음/.test(out.i3_afterUnbind);
  card = qa('#mine-list .pcard').filter(function(c){return c.textContent.indexOf('이름 없는 길손')>-1})[0]; card.click(); await wait();
  btnText(q('#spm-act'), '정리').click(); await wait();
  out.i3_delSheet = openOv() + ' :: ' + q('#sheet-del-persona .note').textContent;
  ok.i3_delSheetHonest = /이미 없어/.test(out.i3_delSheet);
  btnText(q('#sheet-del-persona .dialog__actions'), 'Persona 정리').click(); await wait();
  out.i3_delToast = lastToast();
  out.i3_mineAfter = qa('#mine-list .pcard').map(function(c){return c.textContent.replace(/\s+/g,' ').trim().slice(0,16)}).join(' | ');
  ok.i3_gone = !/이름 없는 길손/.test(out.i3_mineAfter);

  /* 보관함에 다시 보관 */
  await openEdit('카엘 로웬');
  q('#btn-adopt').click(); await wait();
  q('#btn-del-vault').click(); await wait(); btnText(q('#sheet-del-vault'), '보관함에서 삭제').click(); await wait();
  window.suiteGo('mine'); await wait();
  card = qa('#mine-list .pcard').filter(function(c){return c.textContent.indexOf('카엘')>-1})[0]; card.click(); await wait();
  btnText(q('#spm-act'), '다시 보관').click(); await wait();
  out.i3_revaultToast = lastToast();
  window.suiteGo('shelf'); await wait();
  out.i3_revaultShelf = shelfRow('카엘 로웬') ? shelfRow('카엘 로웬').textContent.replace(/\s+/g,' ').slice(0,60) : 'NONE';
  ok.i3_revaulted = /채택됨/.test(out.i3_revaultShelf);

  out.ok = ok; out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
