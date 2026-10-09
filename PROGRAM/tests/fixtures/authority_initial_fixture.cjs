'use strict';
const {fixture,insertSource,OWNERS}=require('./authority_sqlite_fixture.cjs');
const O=require('../../server/authority/owner-store.cjs');
function initialFixture(t){const f=fixture(t);insertSource(f.databases.libra);f.control=f.initialize();f.owners={};for(const namespace of OWNERS)f.owners[namespace]=f.track(O.bindOwnerStore({database:f.databases[namespace],namespace,...f.ownerBindings[namespace],physicalBinding:f.physicalBinding}));f.qualifier=()=>{const api=require('../../server/authority/initial-qualification.cjs');return api.createInitialOwnerQualifier({dataDir:f.dataDir,control:f.control,resolveOwnerStore:n=>f.owners[n]});};return f;}
module.exports={initialFixture,OWNERS};
