'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const {declaration}=require('./helpers/libra_navigation_contract.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const dom=new JSDOM('<div id="root"><span id="globalStatus"><span id="globalStatusCount"></span><span id="globalStatusText"></span></span></div>');
const root=dom.window.document.querySelector('#root');
const Runtime={root,warnings:[],overviewError:'현재 캐릭터를 불러올 수 없습니다.',overviewErrorAt:123,serverScopeCatalog:{at:1,scopes:Array.from({length:132},()=>({classification:'unverified'})),scanErrors:{}}};
const state={gate:null,loading:false,checked:false};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx={Runtime,Date,text:v=>String(v??''),scopeManagerArray:v=>Array.isArray(v)?v:[],formatNumber:String,scopeManagerDeleteBlockedReason:()=>'',MEMORY_SUITE_NAMESPACE_LABELS:{libra:'LIBRA',retrace:'RE:TRACE'},escapeHtml,scopeManagerFormatTime:String,retraceOverviewState:()=>state};
vm.createContext(ctx);
vm.runInContext(['retraceDiagnosticSnapshot','syncRetraceDiagnosticIndicator','renderRetraceErrorLogContents','openRetraceErrorLog'].map(n=>declaration(source,n)).join('\n')+'\nthis.api={snapshot:retraceDiagnosticSnapshot,sync:()=>syncRetraceDiagnosticIndicator(retraceOverviewState()),open:openRetraceErrorLog};',ctx);
try{
 const api=ctx.api;
 let snap=api.snapshot();assert.equal(snap.errors,0);assert.equal(snap.warnings,0);assert.equal(snap.information,1);assert.equal(snap.unverifiedScopes,132);assert.equal(snap.entries[0].at,123);
 api.sync();api.open();
 const overlay=root.querySelector('#retraceErrorLogOverlay');
 const header=()=>root.querySelector('#globalStatusCount').textContent;
 const summary=()=>overlay.querySelector('[data-error-log-summary]').textContent;
 assert.equal(header(),'오류 0 · 경고 0');assert.equal(summary(),'오류 0건 · 경고 0건 · 안내 1건');
 assert.match(overlay.querySelector('[data-error-log-catalog]').textContent,/확인 불가 132개/);
 assert.doesNotMatch(header(),/132/);assert.match(overlay.querySelector('[data-error-log-list] .badge').textContent,/안내/);
 Runtime.overviewError='서버 상태 조회 실패';Runtime.warnings=[{message:'fallback',detail:'<script>bad</script>'},{message:'second warning'}];Runtime.serverScopeCatalog.scanErrors={libra:'scan failed'};
 api.sync(); // The already open dialog must update together with the header.
 snap=api.snapshot();assert.equal(snap.errors,2);assert.equal(snap.warnings,2);assert.equal(snap.entries.length,4);
 assert.equal(header(),'오류 2 · 경고 2');assert.equal(summary(),'오류 2건 · 경고 2건 · 안내 0건');
 assert.equal(overlay.querySelectorAll('[data-error-log-list] .card').length,4);
 assert.match(overlay.dataset.fullLogText,/오류 2건 · 경고 2건 · 안내 0건/);assert.equal(overlay.querySelector('script'),null);
 assert.equal(root.querySelector('#globalStatus').classList.contains('health--danger'),true);
 Runtime.overviewError='character storage integrity failed';assert.equal(api.snapshot().isContextMissing,false,'character-related failures are not automatically standby');
 Runtime.overviewError='';Runtime.warnings=[];Runtime.serverScopeCatalog.scanErrors={};api.sync();
 assert.equal(header(),'오류 0 · 경고 0');assert.equal(summary(),'오류 0건 · 경고 0건 · 안내 0건');
 assert.doesNotMatch(overlay.textContent,/모든 플러그인과 서버 스토리지가 정상/,'no logs does not certify unqueried services');
 Runtime.warnings.push({message:'new warning since last overview'});
 root.querySelector('#globalStatus').click();assert.equal(header(),'오류 0 · 경고 1');assert.equal(summary(),'오류 0건 · 경고 1건 · 안내 0건');
 Runtime.diagnosticsError='probe failed';Runtime.diagnosticsErrorAt=456;api.sync();assert.match(summary(),/오류 1건/);assert.match(overlay.textContent,/호환 계약 검사 실패/);
 console.log('PASS RE:TRACE header/dialog/copy share severity counts; standby and 132 protected scopes are separate; live update and escaping');
}finally{dom.window.close();}
