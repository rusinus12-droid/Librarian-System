'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base=JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')).base,freeze=JSON.parse(fs.readFileSync(base+'/PRODUCT-SUPPORT-FREEZE.json'));
const intentionallyUnpackaged=['tools/__pycache__/verify_required_support.cpython-312.pyc'];
let exact=0;const absent=[],different=[];
for(const [name,pin]of Object.entries(freeze.files)){const file=path.join(base,name);if(!fs.existsSync(file)){absent.push(name);continue;}const bytes=fs.readFileSync(file);if(bytes.length!==pin.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==pin.sha256)different.push(name);else exact++;}
assert.deepEqual(absent,intentionallyUnpackaged);assert.deepEqual(different,[]);assert.equal(exact,495);assert.equal(Object.keys(freeze.files).length,496);
for(const record of JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')).files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(base,record.file))).digest('hex'),record.sha256,record.file);
const result={status:'RESTORED_SOURCE_INVENTORY_PASS',exactFiles:exact,differingFiles:different,soleIntentionallyUnpackagedGeneratedFile:absent,historical496Assertion:'NOT_PASSED; its failure remains preserved',meaning:'Separate packaging-aware inventory check. No bytecode reconstructed and no original assertion altered.'};
console.log(JSON.stringify(result,null,2));
