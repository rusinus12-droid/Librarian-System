'use strict';
// Test-only process hosting the unmodified exported production HTTP server.
const {createMemorySuiteServer}=require('../../server/server.cjs');
(async()=>{
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:process.argv[2],autoBackup:false});const address=await app.listen();
 process.on('message',async m=>{
  if(m?.kind==='close'){await app.close();process.exit(0);}
  if(m?.kind==='crash-trigger'){
   app.repositories.libra.database.function('fixture_process_crash',()=>{process.kill(process.pid,'SIGKILL');return 0;});
   app.repositories.libra.database.exec(`CREATE TEMP TRIGGER fixture_crash BEFORE INSERT ON kv WHEN NEW.key='libra:test:crash-second' BEGIN SELECT fixture_process_crash(); END;`);
   process.send?.({triggerReady:true});
  }
 });
 process.send?.({port:address.port});
})().catch(e=>{console.error(e);process.exit(1);});
