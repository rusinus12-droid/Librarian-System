const fs=require('fs');const path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','plugins','LIBRA.js'),'utf8');
function need(x,msg){if(!x)throw new Error(msg)}
need(src.includes('out.narrative_state = narrative'),'Planner/SGA packet does not expose Narrative');
need(src.includes('narrativeIdentity'),'cache does not include Narrative identity');
need(src.includes('narrativeDirectionIdentity'),'cache does not include Direction identity');
need(src.includes("delete out.story_arc")&&src.includes("narrative_state_legacy_projection")&&src.includes("legacy_advisory_compatibility"),'SGA does not isolate legacy Story Arc from current Narrative authority');
need(src.includes("kind:'narrative_state'")||src.includes('kind: \'narrative_state\''),'SGA Narrative material missing');
console.log('libra_narrative_consumer_consistency_0316_test: PASS');
