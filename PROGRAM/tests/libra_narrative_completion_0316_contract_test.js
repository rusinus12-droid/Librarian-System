const fs=require('fs');const path=require('path');
const src=fs.readFileSync(process.argv[2]?path.resolve(process.argv[2]):path.join(__dirname,'..','plugins','LIBRA.js'),'utf8');
function need(x,msg){if(!x)throw new Error(msg)}
need(src.includes('NARRATIVE_COMPLETION_V2'),'completion layer missing');
need(src.includes('planner-narrative-direction:v1'),'direction storage missing');
need(src.includes('migrateStoryArcToNarrativeIfNeeded'),'migration missing');
need(src.includes('validateAndBindNarrativePatchEvidence'),'evidence validator missing');
need(src.includes('callNarrativeDeltaProvider'),'manual narrative provider missing');
need(src.includes('narrative_state'),'direct narrative material missing');
need(src.includes('domainStatus')&&src.includes('narrative'),'narrative domain status missing');
need(!/callTask\s*\(\s*STORY_ARC_STAGE_ID/.test(src),'active Story Arc provider call remains');
const server=fs.readFileSync(path.join(__dirname,'..','server','server.cjs'),'utf8');
const packageVersion=fs.readFileSync(path.join(__dirname,'..','VERSION.txt'),'utf8').trim();
const escapedVersion=packageVersion.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
need(new RegExp(`SERVER_VERSION\\s*=\\s*['\"]${escapedVersion}['\"]`).test(server),'server version mismatch');
console.log('libra_narrative_completion_0316_contract_test: PASS');
