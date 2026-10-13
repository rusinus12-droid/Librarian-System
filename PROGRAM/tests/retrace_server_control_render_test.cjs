'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const start=src.indexOf('  const renderShell =');
const shell=src.slice(start,src.indexOf('  const setBusy =',start));
const literal=shell.match(/root\.innerHTML = ("(?:\\.|[^"\\])*");/s);
assert.ok(literal,'mockup is the single literal product shell');
const template=JSON.parse(literal[1]);
assert.ok(template.startsWith('<style>'));
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={libra:'LIBRA',hayaku:'HAYAKU',flashback:'Flashback',lia:'LIA',retrace:'RE:TRACE'};
const nodes={};const root={querySelector:q=>nodes[q]||(nodes[q]={innerHTML:'',textContent:'',value:q==='#serverControlBackups'?'b1':'',hidden:false,disabled:false}),querySelectorAll:()=>[]};
const Runtime={root,busy:false,serverControl:{},serverScopeCatalog:{at:Date.now(),scopes:[{namespace:'libra',bytes:1024}],scanErrors:{}}};
const a=src.indexOf('  const renderServerControl ='),b=src.indexOf('  const refreshServerControl =',a);
const render=new Function('Runtime','escapeHtml','scopeManagerArray','scopeManagerFormatTime','scopeManagerFormatBytes','MEMORY_SUITE_NAMESPACE_LABELS',src.slice(a,b)+'return renderServerControl;')(Runtime,e,v=>Array.isArray(v)?v:[],v=>v==null?'미확인':String(v),v=>v+' B',names);
const html=template;
assert.ok(html.includes('.scope-card.k-active{'),'actual scope cards use the mockup visual contract');
assert.ok(html.includes('@container app (max-width:900px)'),'responsive tablet layout comes from the mockup');
assert.ok(html.includes('@container app (max-width:640px)'),'responsive mobile layout comes from the mockup');
assert.ok(!html.includes('.bridge{')&&!html.includes('#panel-serverdata .control-grid{'),'old dedicated RE:TRACE shell skin is absent');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,'unique IDs in actual generated HTML');
const fixtures={
 normal:{status:{version:'0.3.48',checkedAt:123,dataInstanceId:'demo',dataPath:'<unsafe>',lastBackup:'2026-09-13',stores:{stores:{libra:{ok:true},hayaku:{ok:false}}},clients:[]},backups:[{id:'b1',createdAt:'2026-09-13',kind:'manual',stores:{libra:{bytes:1}},lastCheckAt:1,verifiedAtLastCheck:true}],history:[{action:'restore',status:'complete',namespaces:['libra'],finishedAt:1},{action:'backup-check',status:'failed',error:'<unsafe>'}]},
 loading:{loading:true},offline:{errors:['offline']},partial:{status:{version:'0.3.48',stores:{stores:{libra:{ok:true}}}},errors:['backups: failed']}
};
for(const [name,state] of Object.entries(fixtures)){Runtime.serverControl=state;render();assert.ok(nodes['#serverControlSummary'].innerHTML);if(name==='normal'){assert.ok(nodes['#serverControlDetails'].innerHTML.includes('&lt;unsafe&gt;'));assert.ok(nodes['#serverControlBackupCards'].innerHTML.includes('data-control-backup="b1"'));assert.ok(nodes['#serverControlPlugins'].innerHTML.includes('점검 필요'));assert.ok(nodes['#serverControlPlugins'].innerHTML.includes('class="owner"')); assert.ok(!nodes['#serverControlPlugins'].innerHTML.includes('control-icon'));assert.ok(nodes['#serverControlHistory'].innerHTML.includes('&lt;unsafe&gt;'));}if(name==='offline')assert.ok(!nodes['#serverControlSummary'].innerHTML.includes('0.3.48'));
 if(process.env.RETRACE_RENDER_OUTPUT){
  fs.mkdirSync(process.env.RETRACE_RENDER_OUTPUT,{recursive:true});let rendered=html.replace('class="page" data-page="serverdata"','class="page is-active" data-page="serverdata"');
  for(const [q,node] of Object.entries(nodes)){if(!q.startsWith('#'))continue;const id=q.slice(1);rendered=rendered.replace(new RegExp('<(div|ul|select)([^>]*id="'+id+'"[^>]*)>[\\s\\S]*?<\\/\\1>'),(m,tag,attrs)=>'<'+tag+attrs+'>'+(node.innerHTML||e(node.textContent))+'</'+tag+'>');}
  fs.writeFileSync(path.join(process.env.RETRACE_RENDER_OUTPUT,name+'.html'),'<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>생산 렌더 HTML · 예시 '+name+'</title><body><p style="color:white;background:#252035;margin:0;padding:8px">생산 렌더 HTML · 예시 데이터 · 정적 구조 점검용 (실서버 미연결)</p>'+rendered+'</body></html>');
 }
}
Runtime.serverControl={...fixtures.normal,plan:{backupId:'b1',namespaces:['libra'],expiresAt:1,estimated:{workingBytes:10}},reconnect:['libra']};render();assert.equal(nodes['#serverControlReconnect'].hidden,false);assert.ok(nodes['#serverControlPreview'].innerHTML.includes('libra'));
console.log('retrace_server_control_render_test: PASS (actual shell HTML/CSS placement, unique IDs, 4 render states, escaping, backup cards, restore guidance; no browser visual assertions)');
