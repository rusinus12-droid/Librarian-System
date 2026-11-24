'use strict';
// Explicit current nested suite identity; the coordinator may use --list for bounded per-file scheduling.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const os=require('node:os');
const {spawn}=require('node:child_process');
const root=path.join(__dirname,'gradia'),manifest=require('./gradia/suite-inventory.json');
const files=manifest.requiredRoots.flatMap(relative=>{const dir=path.join(root,relative);assert(fs.statSync(dir).isDirectory(),'required GRADIA root exists');return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.test.cjs')).map(e=>path.relative(root,path.join(dir,e.name))).sort();}).sort();
assert.deepEqual(files,manifest.files,'current GRADIA identities match the declared inventory');
if(process.argv.includes('--list'))console.log(JSON.stringify({suite:'gradia',files}));
else {
  const cpu=typeof os.availableParallelism==='function'?os.availableParallelism():4;
  const concurrency=Math.max(1,Math.min(files.length,Number(process.env.GRADIA_SUITE_CONCURRENCY)||Math.min(4,Math.max(2,cpu))));
  const runFile=file=>new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join(root,file)],{stdio:['ignore','pipe','pipe'],env:process.env});
    const out=[],err=[];
    child.stdout?.on('data',c=>out.push(c));
    child.stderr?.on('data',c=>err.push(c));
    child.on('error',error=>resolve({file,exit:null,signal:null,error:error.message,out:Buffer.concat(out),err:Buffer.concat(err)}));
    child.on('close',(status,signal)=>resolve({file,exit:status,signal:signal||null,error:null,out:Buffer.concat(out),err:Buffer.concat(err)}));
  });
  (async()=>{
    let next=0;
    const results=new Array(files.length);
    const worker=async()=>{while(next<files.length){const idx=next++;results[idx]=await runFile(files[idx]);}};
    await Promise.all(Array.from({length:concurrency},worker));
    for(const r of results){
      if(r.out.length)process.stdout.write(r.out);
      if(r.err.length)process.stderr.write(r.err);
      console.log(JSON.stringify({wrapper:'gradia',file:r.file,exit:r.exit,signal:r.signal,error:r.error}));
      if(r.error||r.exit!==0)process.exitCode=1;
    }
  })().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});
}
