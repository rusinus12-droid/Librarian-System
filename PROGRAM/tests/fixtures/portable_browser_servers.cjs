'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {createMemorySuiteServer,NAMESPACES}=require('../../server/server.cjs');
(async()=>{const dirs=[],apps=[],urls=[];for(let i=0;i<2;i++){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portable-browser-'));dirs.push(dir);const app=createMemorySuiteServer({dataDir:dir,port:0,autoBackup:false,computeEnabled:false});apps.push(app);const addr=await app.listen();urls.push('http://127.0.0.1:'+addr.port);}
for(const ns of NAMESPACES)apps[0].repositories[ns].mutate({kind:'set',space:'plugin',key:'browser-snapshot-'+ns,value:{test:'browser-export-import',owner:ns},operationId:'browser_seed_'+ns+'_12345'});
process.stdout.write(JSON.stringify({urls})+'\n');let closing=false;const close=async()=>{if(closing)return;closing=true;for(let i=0;i<apps.length;i++){await apps[i].close();fs.rmSync(dirs[i],{recursive:true,force:true});}process.exit(0);};process.on('SIGTERM',close);process.on('SIGINT',close);
})().catch(e=>{console.error(e);process.exit(1);});
