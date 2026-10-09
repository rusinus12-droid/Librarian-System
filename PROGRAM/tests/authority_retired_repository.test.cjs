'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,put}=require('./fixtures/authority_server_fixture.cjs');
test('retired_repository_refuses_mutation_before_publishing_intent',t=>{
 const f=fixture(t);f.activate();const repo=f.repositories.libra;repo.close();
 const before=f.readControl('SELECT COUNT(*) n FROM write_intents')[0].n;
 assert.throws(()=>put(repo,'retired-repository','denied','retired-repo-op'),{code:'AUTHORITY_CLOSED'});
 assert.equal(f.readControl('SELECT COUNT(*) n FROM write_intents')[0].n,before);assert.equal(f.originals.libra.get('plugin','retired-repository').exists,false);
});
