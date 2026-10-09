'use strict';
// Public SDK + existing in-process handlers. Explicit legacy routes are included and retired only after verification.
require('./storage_global_allchat_job_test.cjs').run().catch(error=>{console.error(error);process.exitCode=1;});
