'use strict';
// Explicit current nested suite identity; the coordinator may use --list for bounded per-file scheduling.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'gradia'),manifest=require('./gradia/suite-inventory.json');
const files=manifest.requiredRoots.flatMap(relative=>{const dir=path.join(root,relative);assert(fs.statSync(dir).isDirectory(),'required GRADIA root exists');return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.test.cjs')).map(e=>path.relative(root,path.join(dir,e.name))).sort();}).sort();
assert.deepEqual(files,manifest.files,'current GRADIA identities match the declared inventory');
if(process.argv.includes('--list'))console.log(JSON.stringify({suite:'gradia',files}));
else for(const file of files){const run=spawnSync(process.execPath,[path.join(root,file)],{stdio:'inherit',env:process.env});console.log(JSON.stringify({wrapper:'gradia',file,exit:run.status,error:run.error?.message||null}));if(run.error||run.status!==0)process.exitCode=1;}
