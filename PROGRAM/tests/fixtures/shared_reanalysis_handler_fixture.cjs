'use strict';
// Existing real-server in-process transport. Offline guards remain unchanged.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer}=require('../../server/server.cjs');
const transport=require('../helpers/inprocess-review-transport.cjs');
function createHandlerFixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shared-reanalysis-handler-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:64509,dataDir:path.join(root,'DATA'),autoBackup:false});
 const trace=[],url='http://127.0.0.1:64509',send=transport(app,trace);
 const nativeFetch=(input,options={})=>{if(new URL(input).origin!==url)throw Error('OFFLINE_UNREGISTERED_HANDLER_URL');return send(input,options)};
 return {app,url,nativeFetch,trace,close:()=>app.close()};
}
module.exports={createHandlerFixture};
