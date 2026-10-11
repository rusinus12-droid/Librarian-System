'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createMemorySuiteServer,LEGACY_STORAGE_NAMESPACES}=require('../../server/server.cjs');
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const dbfile=(dataDir,ns)=>path.join(dataDir,'stores',ns,ns+'.sqlite');

// Represent already-existing historical inventory, never a live retired writer.
// The exact schema comes from the real server's backup of its empty read-only
// slots, as in server_retired_restore_inventory_test's historical nonempty case.
async function seedHistoricalInventory(dataDir,rows){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'portable-historical-template-'));
  let app;
  try{
    app=createMemorySuiteServer({dataDir:root,host:'127.0.0.1',port:0,autoBackup:false,computeEnabled:false});await app.listen();
    const backup=await app.createBackup('manual','historical-schema-template');
    const template=app.listBackups().find(row=>row.id===backup.result.id);
    for(const ns of LEGACY_STORAGE_NAMESPACES)assert.equal(fs.existsSync(dbfile(root,ns)),false,'template backup does not provision a retired live store');
    await app.close();app.server.emit('close');app.diagnosticJournal?.close();app=null;
    const inventory={};
    for(const ns of LEGACY_STORAGE_NAMESPACES){
      assert.ok(rows[ns],'explicit historical rows required for '+ns);
      const dest=dbfile(dataDir,ns);assert.equal(fs.existsSync(dest),false,'seed happens before source app opens');
      fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(template.path,template.stores[ns].file),dest);
      const db=new DatabaseSync(dest);try{
        for(const row of rows[ns]){const json=JSON.stringify(row.value);db.prepare('INSERT INTO kv VALUES(?,?,?,0,?,?,?)').run(row.space,row.key,json,row.revision||1,sha256(json),row.updatedAt||123);}
        db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('historical-unrecognized-field','preserved-'+ns);
      }finally{db.close();}
      inventory[ns]={rows:rows[ns],sha256:sha256(fs.readFileSync(dest)),metadata:'preserved-'+ns};
    }
    return inventory;
  }finally{if(app){await app.close();app.server.emit('close');app.diagnosticJournal?.close();}fs.rmSync(root,{recursive:true,force:true});}
}
function assertRetiredReadOnly(app,inventory,{sourceUnchanged=false}={}){
  for(const ns of LEGACY_STORAGE_NAMESPACES){
    const repo=app.repositories[ns];assert.equal(repo.legacyReadOnly,true);assert.equal(repo.ephemeral,false,'historical inventory is physically present');
    for(const row of inventory[ns].rows){const actual=repo.get(row.space,row.key);assert.deepEqual(actual.value,row.value);assert.equal(actual.digest,sha256(JSON.stringify(row.value)));assert.equal(actual.revision,row.revision||1);}
    assert.throws(()=>repo.mutate({kind:'set',space:'plugin',key:ns+':forbidden-new',value:'blocked',operationId:'portable-retired-write-'+ns,expectedRevision:0}),/retired_storage_owner_read_only/);
    assert.throws(()=>repo.applyConditionalBatch([{kind:'set',space:'plugin',key:ns+':forbidden-batch',value:'blocked',expectedRevision:0}],{operationId:'portable-retired-batch-'+ns}),/retired_storage_owner_read_only/);
    if(sourceUnchanged){assert.equal(repo.database.prepare('SELECT value FROM metadata WHERE key=?').get('historical-unrecognized-field').value,inventory[ns].metadata);assert.equal(sha256(fs.readFileSync(dbfile(app.dataDir,ns))),inventory[ns].sha256,'original historical source bytes and metadata unchanged');}
  }
}
const metadataSnapshot=app=>Object.fromEntries(Object.entries(app.repositories).map(([ns,repo])=>[ns,repo.database.prepare('SELECT key,value FROM metadata ORDER BY key').all()]));
module.exports={seedHistoricalInventory,assertRetiredReadOnly,sha256,dbfile,metadataSnapshot};
