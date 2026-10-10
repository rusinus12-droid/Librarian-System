'use strict';
const path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const C=require('../../server/authority/control-store.cjs'),O=require('../../server/authority/owner-store.cjs');
const {dataDir}=JSON.parse(process.argv[2]),marker=C.readActivationState({dataDir}).marker,filePath=path.join(dataDir,'stores/libra/libra.sqlite');
const db=new DatabaseSync(filePath),store=O.bindOwnerStore({database:db,namespace:'libra',filePath,physicalBinding:marker.physicalBinding,resetEpoch:marker.ownerBindings.libra.resetEpoch});
const close=DatabaseSync.prototype.close;DatabaseSync.prototype.close=function(){if(this===db)throw Error('TEST_PUBLIC_CLOSE_BUSY');return close.call(this);};
store.close();process.stdout.write('UNSAFE_NORMAL_CONTINUATION\n');
