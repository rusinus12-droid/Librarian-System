'use strict';
// Explicit offline candidate packaging. Original release/source publication CLI remains gated.
const {parseArgs,buildOfflineCandidate}=require('./build_distribution.cjs');
try {const args=parseArgs();const result=buildOfflineCandidate(args);console.log(JSON.stringify(result,null,2));}catch(error){console.error(error.stack||error);process.exitCode=1;}
