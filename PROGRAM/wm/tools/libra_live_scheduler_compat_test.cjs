'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const text=fs.readFileSync(path.join(__dirname,'build-libra-runtime-factory.cjs'),'utf8');
const start=text.indexOf('(async function createLibraRuntime(environment = '),end=text.indexOf('}) {',start);
let first=0,second=0;const context={setTimeout:()=>++first,clearTimeout(){},setInterval(){},clearInterval(){}};vm.createContext(context);
const code=text.slice(start,end+2)+' {return environment.scheduler;})()';
(async()=>{const scheduler=await vm.runInContext(code,context);context.setTimeout=()=>++second;scheduler.setTimeout(()=>{},1);assert.equal(second,1,'live scheduler must retain ordinary dynamic host timer lookup');assert.equal(first,0);console.log(JSON.stringify({passed:1,failed:0}));})().catch(e=>{console.error(e);process.exitCode=1});
