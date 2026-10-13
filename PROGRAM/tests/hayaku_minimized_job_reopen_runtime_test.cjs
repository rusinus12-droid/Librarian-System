'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const s=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const nodes={};const make=id=>nodes[id]={hidden:true,attrs:{},setAttribute(k,v){this.attrs[k]=v},addEventListener(_,fn){this.click=fn}};
for(const id of ['#hayakuNativeJobChip','#hayakuNativeJobOverlay','#minimizeHayakuNativeJob'])make(id);

const root={querySelector:id=>nodes[id]||null};const Memory={ledgerViewer:{root,jobMinimized:false},nativeRecovery:{job:{kind:'manual_missing_batch',state:'running',total:8,completed:3}}};
const c=vm.createContext({Memory,root,hayakuMockupIcon:()=>'<svg></svg>',viewerRenderHeaderHealth:()=>{},NATIVE_JOB_TERMINAL_STATES:new Set(['completed','failed','cancelled']),viewerNativeJobKindLabel:()=> '누락 복구',viewerNativeJobStateLabel:x=>x,viewerNativeJobElapsed:()=> '10초',clearInterval:()=>{}});
const a=s.indexOf('  const viewerRenderNativeJob ='),b=s.indexOf('    const setText =',a);
vm.runInContext(s.slice(a,b)+'};globalThis.render=viewerRenderNativeJob;',c);
const h=s.indexOf("    root.querySelector?.('#hayakuNativeJobChip')?.addEventListener"),e=s.indexOf("    root.querySelector?.('#closeHayakuNativeJob')",h);
vm.runInContext(s.slice(h,e),c);
c.render();assert.equal(nodes['#hayakuNativeJobOverlay'].hidden,false);assert.equal(nodes['#hayakuNativeJobChip'].hidden,true);
nodes['#minimizeHayakuNativeJob'].click();assert.equal(nodes['#hayakuNativeJobOverlay'].hidden,true);assert.equal(nodes['#hayakuNativeJobChip'].hidden,false,'minimized job exposes its task tray');assert(nodes['#hayakuNativeJobChip'].attrs['aria-label'].includes('3 / 8'));
nodes['#hayakuNativeJobChip'].click();assert.equal(Memory.ledgerViewer.jobMinimized,false);assert.equal(nodes['#hayakuNativeJobOverlay'].hidden,false);
Memory.nativeRecovery.job.state='completed';nodes['#minimizeHayakuNativeJob'].click();assert.equal(nodes['#hayakuNativeJobChip'].hidden,false,'finished minimized job remains reviewable');
Memory.nativeRecovery.job=null;c.render();assert.equal(nodes['#hayakuNativeJobChip'].hidden,false,'idle task tray remains visible');assert.equal(nodes['#hayakuNativeJobOverlay'].hidden,true);
console.log('PASS minimize/reopen with mockup task tray, progress, terminal review and no-job cleanup');
