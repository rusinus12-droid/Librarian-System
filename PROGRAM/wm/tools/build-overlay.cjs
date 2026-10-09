'use strict';
// Retained compatibility entrypoint. Output is owned by the LIB adapter; the
// factory/overlay assembly lives in build-portable.cjs and never writes dist.
const { runCli, assemblePortableSource } = require('./build-portable.cjs');
if (require.main === module) runCli().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runCli, assemblePortableSource };
