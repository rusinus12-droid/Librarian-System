 'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const program=path.resolve(__dirname,'..');
function fixtureCatalog(programDir=program){const file=path.join(programDir,'wm/build-support/source-fixture-catalog.json');if(!fs.existsSync(file)){if(fs.existsSync(path.join(programDir,'wm')))throw Error('WM_SOURCE_FIXTURE_CATALOG_MISSING');return {};}const data=JSON.parse(fs.readFileSync(file));if(data.schema!=='wm.pinned-source-fixtures.v1')throw Error('WM_SOURCE_FIXTURE_CATALOG_INVALID');return data.files;}
const references=fixtureCatalog();
function isPinnedWmFixture(relative){const normalized=relative.split(path.sep).join('/');return Object.hasOwn(references,normalized.replace(/^wm\//,''));}
function isWmSourceInput(relative){
 const normalized=relative.split(path.sep).join('/');if(!normalized.startsWith('wm/'))return false;
 const file=normalized.slice(3);if(file==='BASE-PINS.json')return true;
 if(file.split('/').includes('dist'))return isPinnedWmFixture(normalized);
 if(file.startsWith('references/'))return isPinnedWmFixture(normalized);
 if(!/^(src|tools|build-support)\//.test(file))return false;
 return !/(?:^|\/)(?:DATA|data|evidence|provenance|verification|test-output|backups?|credentials?|secrets?|node_modules|\.git)(?:\/|$)/i.test(file);
}
function verifyWmFixtures(programDir=program){const files=fixtureCatalog(programDir);for(const [relative,expected]of Object.entries(files)){const full=path.join(programDir,'wm',relative);if(!fs.existsSync(full)||crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')!==expected)throw Error('WM_SOURCE_FIXTURE_MISMATCH:'+relative);}return {files:Object.keys(files).length};}
module.exports={fixtureCatalog,isPinnedWmFixture,isWmSourceInput,verifyWmFixtures};
