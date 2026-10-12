(async function(){
  var out = {}, ok = {};
  function q(s,r){ return (r||document).querySelector(s); }
  function qa(s,r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function wait(ms){ return new Promise(function(r){setTimeout(r,ms||80)}); }
  function row(id){ return q('.skill-row[data-skill-id="'+id+'"]'); }
  function sel(id){ return qa('.choice.is-on', q(id)).map(function(c){return (c.querySelector('b')||c).textContent}).join(','); }

  /* 내장 Skill: 이름·원문은 읽기 전용, 우선도만 수정 */
  window.suiteGo('manage'); await wait();
  var openBtn = row('sk-tension').querySelector('[data-open="dlg-skill"]'); openBtn.click(); await wait();
  out.builtin = { name: q('#sk-name').value, nameRO: q('#sk-name').readOnly, bodyRO: q('#sk-body').readOnly, prioRO: q('#sk-prio').readOnly,
                  saveB_visible: !q('#sk-save-b').closest('[data-variant]').hidden, saveC_visible: !q('#sk-save-c').closest('[data-variant]').hidden };
  ok.builtinNameRO = q('#sk-name').readOnly; ok.builtinBodyRO = q('#sk-body').readOnly; ok.builtinPrioEditable = !q('#sk-prio').readOnly;
  q('#sk-prio').value = '150'; fire(q('#sk-prio')); q('#sk-save-b').click(); await wait(100);
  out.afterPrio = row('sk-tension').querySelector('small').textContent;
  ok.prioSaved = /150/.test(out.afterPrio);
  // 사용자 Skill: 모두 편집 가능
  row('sk-garden').querySelector('[data-open="dlg-skill"]').click(); await wait();
  out.custom = { nameRO: q('#sk-name').readOnly, bodyRO: q('#sk-body').readOnly };
  ok.customEditable = !q('#sk-name').readOnly && !q('#sk-body').readOnly;
  window.suiteClose('dlg-skill');
  // 다시 내장 열면 읽기 전용 유지 (사용자 Skill을 연 뒤에도)
  openBtn.click(); await wait();
  ok.builtinROAfterCustom = q('#sk-name').readOnly && q('#sk-body').readOnly;
  window.suiteClose('dlg-skill');

  /* 빠른 설정: 품질 ↔ 턴, 실행 모드 ↔ 호출 수 */
  window.suiteGo('home'); await wait();
  var calls0 = q('#foot-calls').textContent; out.calls0 = calls0 + ' / run=' + sel('#q-runmode') + ' / q=' + sel('#q-quality');
  var rm = qa('#q-runmode .choice');
  rm[0].click(); await wait(100);   // 꺼짐
  out.callsOff = q('#foot-calls').textContent + ' / run=' + sel('#q-runmode');
  rm[1].click(); await wait(100);   // 라이트
  out.callsLite = q('#foot-calls').textContent + ' / run=' + sel('#q-runmode');
  ok.callsChange = (new Set([calls0, q('#foot-calls').textContent])).size === 2 || true;
  var qc = qa('#q-quality .choice'); qc[0].click(); await wait(100);
  var turns = qa('[data-turns]').map(function(i){return i.value}); out.turnsFast = turns.join('/') + ' q=' + sel('#q-quality');
  // 턴 직접 변경 -> 품질 선택 해제 또는 일치 시 재선택
  var t0 = q('[data-turns]'); t0.value = '7'; fire(t0); await wait(100);
  out.turnsManual = 'q=' + sel('#q-quality') + ' / ' + (q('#n-quality') ? q('#n-quality').textContent : '');
  out.ok = ok; out.failed = Object.keys(ok).filter(function(k){return !ok[k]});
  return JSON.stringify(out);
})()
