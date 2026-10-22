'use strict';
// Compatibility entry point: automatic routing was retired in GRADIA 0.26.9.
console.log('스킬 자동 라우터는 퇴역했습니다. 수동 선택 검증을 실행합니다.');
require('./gradia_manual_skills_eval.cjs').run().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
