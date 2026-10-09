'use strict';
// Preserve the original 27 hook scenarios; use the exact restored change-base for
// the differential scenario instead of its unavailable historical /tmp ancestor.
// This is explicitly a cap-base differential, not a claim to restore Stage A.
const fs=require('fs'),path=require('path'),Module=require('module'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),base=JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')).base,file=base+'/tools/libra_owned_hydration_hook_test.cjs';
const original=fs.readFileSync(file,'utf8'),old='/tmp/wm-validation-receipts-candidate-20261006T0308Z/dist';if(original.split(old).length!==2)throw Error('native_reference_seam_changed');
const source=original.replace(old,base+'/dist').replace('Stage A and Stage B actual hook payload, complete trace and physical reads match','restored cap and new native hook payload, complete trace and physical reads match');
if(process.env.WM_EVIDENCE_DIR)fs.writeFileSync(process.env.WM_EVIDENCE_DIR+'/native-reference-binding.json',JSON.stringify({originalFile:file,originalSha256:crypto.createHash('sha256').update(original).digest('hex'),unavailableHistoricalReference:old,selectedReference:base+'/dist',meaning:'27 original scenario assertions preserved. One differential reference intentionally compares against the exact recovered cap change-base, not the missing Stage A historical path.'},null,2)+'\n');
const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(source,file);
