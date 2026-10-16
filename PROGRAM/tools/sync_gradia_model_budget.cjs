'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),file=path.join(root,'plugins/GRADIA.js');
const modulePath='sdk/GradiaModelContextBudget.source.js';
const source=fs.readFileSync(path.join(root,modulePath),'utf8');
const digest=crypto.createHash('sha256').update(source).digest('hex');
const begin='/* GRADIA MODEL CONTEXT BUDGET BEGIN */',end='/* GRADIA MODEL CONTEXT BUDGET END */';
const block=begin+'\n// Source: '+modulePath+' sha256='+digest+'\n'+source+'\n'+end;
let plugin=fs.readFileSync(file,'utf8');
const start=plugin.indexOf(begin),finish=plugin.indexOf(end),write=process.argv.includes('--write');
if(start<0){
 if(!write)throw Error('GRADIA_MODEL_BUDGET_EMBED_MISSING');
 const marker='function createGradiaEvidenceBudget({ digest }) {';
 if(plugin.split(marker).length!==2)throw Error('GRADIA_MODEL_BUDGET_MARKER_AMBIGUOUS');
 plugin=plugin.replace(marker,block+'\n\n'+marker);
}else{
 if(finish<start||plugin.indexOf(begin,start+begin.length)>=0)throw Error('GRADIA_MODEL_BUDGET_EMBED_AMBIGUOUS');
 if(!write&&plugin.slice(start,finish+end.length)!==block)throw Error('GRADIA_MODEL_BUDGET_EMBED_DRIFT');
 plugin=plugin.slice(0,start)+block+plugin.slice(finish+end.length);
}
if(write)fs.writeFileSync(file,plugin);
console.log('GRADIA model budget embed: OK '+digest);
