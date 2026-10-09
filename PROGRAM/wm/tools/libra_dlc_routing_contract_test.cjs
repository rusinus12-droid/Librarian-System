'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {verifyDlcRouting}=require('./libra_dlc_routing_contract.cjs');
const replaceOnce=(s,a,b)=>{assert.equal(s.split(a).length,2,'unique mutation anchor');return s.replace(a,b)};
test('current dedicated DLC routing passes without external calls',()=>verifyDlcRouting());
test('comment and whitespace changes leave routing contract green',()=>verifyDlcRouting({transformCode:s=>replaceOnce(s,'const includeUserDlcTrackers = false; // Dedicated route/profile handled by runUserDlcTrackerUpdates.','const includeUserDlcTrackers=false; // benign changed explanation')}));
test('missing dedicated worker call is rejected',async()=>assert.rejects(verifyDlcRouting({transformCode:s=>replaceOnce(s,': runUserDlcTrackerUpdates(currentTurn, turnState, aiResponse, effectiveLore, config, payload);',': Promise.resolve([]);')}),/exactly one maintenance and one dedicated tracker call/));
test('mixing tracker output into general prompt is rejected',async()=>assert.rejects(verifyDlcRouting({transformCode:s=>replaceOnce(s,'const includeUserDlcTrackers = false; // Dedicated route/profile handled by runUserDlcTrackerUpdates.','const includeUserDlcTrackers = true;')}),/general maintenance must not request tracker output/));
test('routing tracker through maintenance profile is rejected',async()=>assert.rejects(verifyDlcRouting({transformCode:s=>replaceOnce(s,"const resolvedProfile = resolveAnalysisProfile(config, 'userDlcTrackerAnalysis', 'primary');","const resolvedProfile = resolveAnalysisProfile(config, 'turnMaintenanceBundle', 'primary');")}),/tracker keeps dedicated profile/));
