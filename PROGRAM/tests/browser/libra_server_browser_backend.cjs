'use strict';
// Ephemeral, local-only real server for browser tests; no debug route in product.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {createMemorySuiteServer}=require('../../server/server.cjs');
(async()=>{const out=path.resolve(process.argv[2]),dir=fs.mkdtempSync(path.join(os.tmpdir(),'libra-seventh-browser-'));fs.mkdirSync(out,{recursive:true});const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});const a=await app.listen();fs.writeFileSync(path.join(out,'server.json'),JSON.stringify({url:`http://127.0.0.1:${a.port}`}));
 let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;const rows=app.repositories.libra.database.prepare('SELECT key,revision,deleted FROM kv').all();fs.writeFileSync(path.join(out,'SERVER_RECORDS.json'),JSON.stringify(rows,null,2));await app.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
})().catch(e=>{console.error(e);process.exitCode=1;});
