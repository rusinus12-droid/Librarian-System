'use strict';
// Preserve existing five-owner packaging/orphan safety assertions with the
// existing no-socket request-handler fixture. New reader is not a sixth owner.
const serverPath=require.resolve('../server/server.cjs'),actual=require(serverPath);
const fixture=require('./fixtures/flashback_in_memory_server_fixture.cjs');
require.cache[serverPath].exports={...actual,createMemorySuiteServer:fixture.createMemorySuiteServer};
try{require('./gradia_free_contract_test.cjs');}finally{require.cache[serverPath].exports=actual;}
