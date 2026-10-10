'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const builder=require('../tools/build_distribution.cjs');
const root=path.resolve(__dirname,'..'),fixtureBase='tests/fixtures/authority-preserved/logical-reader-fixtures/';
const fixtures=['wal-only-authority/source.sqlite','wal-only-authority/source.sqlite-shm','wal-only-authority/source.sqlite-wal','hot-journal-readonly/source.sqlite','hot-journal-readonly/source.sqlite-journal'].map(p=>fixtureBase+p);
for(const file of fixtures){assert.equal(builder.shouldCopySourceProgram(file),true,'required source closure: '+file);assert.equal(builder.shouldCopyRuntimeProgram(file),false,'source-only fixture/document: '+file);}
for(const file of ['tests/private.sqlite',fixtureBase+'wal-only-authority/private.sqlite',fixtureBase+'wal-only-authority/source.sqlite.bak','docs/private.sqlite','docs/credentials.json','unpackaged/docs/UNKNOWN.md','docs/.env','unpackaged/evidence/report.json','tests/secrets.json'])assert.equal(builder.shouldCopySourceProgram(file),false,'no broad private-file exception: '+file);
assert.equal(builder.verifySourceFixtureBytes(root).files,5);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'source-fixture-closure-'));
try{
 for(const file of fixtures){const dest=path.join(temp,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest);}
 assert.equal(builder.verifySourceFixtureBytes(temp).files,5);
 for(const file of fixtures){const p=path.join(temp,file),bytes=fs.readFileSync(p);fs.writeFileSync(p,Buffer.concat([bytes,Buffer.from('synthetic-tamper')]));assert.throws(()=>builder.verifySourceFixtureBytes(temp),/distribution_source_fixture_mismatch/);fs.writeFileSync(p,bytes);}
 const missing=path.join(temp,fixtures[0]),bytes=fs.readFileSync(missing);fs.unlinkSync(missing);assert.throws(()=>builder.verifySourceFixtureBytes(temp),/distribution_source_fixture_missing/);fs.writeFileSync(missing,bytes);
 const guard=require('../server/authority/maintenance-admission.cjs'),wal=path.join(temp,fixtures[0]),hot=path.join(temp,fixtures[3]);
 assert.throws(()=>guard.assertNoAuthorityDatabaseFile(wal),e=>e.code==='AUTHORITY_LIFECYCLE_UNAVAILABLE','copied golden WAL still contains actual committed authority evidence');
 const hotBytes=fs.readFileSync(hot),journalBytes=fs.readFileSync(hot+'-journal');assert.throws(()=>guard.assertNoAuthorityDatabaseFile(hot),e=>e.code==='AUTHORITY_QUARANTINED'&&e.reason==='authority_evidence_unreadable');assert.ok(fs.readFileSync(hot).equals(hotBytes));assert.ok(fs.readFileSync(hot+'-journal').equals(journalBytes));
 console.log(JSON.stringify({test:'release_builder_source_fixture_closure',fixtureFiles:5,missingFixtureRefusals:1,tamperRefusals:5,unknownPrivatePathsRefused:9,realGoldenReadOnlyControls:2}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
