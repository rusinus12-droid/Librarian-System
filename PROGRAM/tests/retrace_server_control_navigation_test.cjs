'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const pages=['overview','data','backups','connection','history'];
const node=page=>({hidden:false,attrs:{'data-server-view':page,'data-server-page':page},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]}});
const views=pages.map(node),buttons=pages.map(node),Runtime={serverControl:{plan:{planId:'keep'}},serverControlPage:'backups'};
const root={querySelector:()=>null,querySelectorAll:s=>s==='[data-server-view]'?views:buttons};
const start=source.indexOf('    const setServerPage = value => {'),end=source.indexOf("    root.querySelectorAll('[data-server-page]').forEach(button=>",start);
assert.ok(start>=0&&end>start);
const setPage=new Function('Runtime','root',source.slice(start,end)+'return setServerPage;')(Runtime,root);
for(const page of pages){setPage(page);assert.deepEqual(views.filter(n=>!n.hidden).map(n=>n.attrs['data-server-view']),[page]);assert.deepEqual(buttons.filter(n=>n.attrs['aria-current']==='page').map(n=>n.attrs['data-server-page']),[page]);assert.equal(Runtime.serverControl.plan.planId,'keep','navigation does not invalidate restore selection or plan');}
setPage('invalid');assert.equal(Runtime.serverControlPage,'overview');
const shell=source.slice(source.indexOf('  const renderShell ='),source.indexOf('  const setBusy ='));
for(const page of pages)assert.equal((shell.match(new RegExp('data-server-view="'+page+'"','g'))||[]).length,1);
for(const id of ['serverControlBackups','serverControlHistory','serverControlResult','serverDataBody','serverResetBegin','closeBridge'])assert.equal((shell.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id+' unique and retained');
assert.ok(source.includes("refreshRetraceTab('serverconnection')"),'connection shortcut calls existing loader');
assert.ok(shell.includes('#panel-serverdata [data-server-view][hidden],#panel-serverdata [hidden]{display:none!important}'));
assert.ok(shell.includes('@container(max-width:760px)'));
console.log('retrace_server_control_navigation_test: PASS (five pages, selection preservation, fallback, unique controls, connection loader, responsive CSS contract)');
