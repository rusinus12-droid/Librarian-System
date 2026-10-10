'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const text=fs.readFileSync(path.join(__dirname,'runtime-factory-controller.source.js'),'utf8');
const context={runtimeDisposers:[],LatestTurnBaselineOwner:{inspect:()=>({state:'ready',canonicalMemoryId:'card'}),take:()=>({postRaw:JSON.stringify({entries:[{comment:'lmai_user_dlc'}]})})}};
vm.createContext(context);vm.runInContext(text+'\nthis.availability=turnReanalysisAvailability;',context);
const result=context.availability('card');assert.equal(result.eligible,false,'known unsupported DLC is disabled before any action');assert.match(result.reason,/추가 요소/);
console.log(JSON.stringify({passed:1,failed:0}));
