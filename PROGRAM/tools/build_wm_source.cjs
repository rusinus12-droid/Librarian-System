'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function assembleWmSource({ wmRoot, verifyPins = true }) {
  const root = path.resolve(wmRoot);
  // Use this project's assembler, with the selected data root passed explicitly.
  // It cannot silently fall back to the original WM candidate's source inputs.
  const { assemblePortableSource } = require(path.join(__dirname, '../wm/tools/build-portable.cjs'));
  return assemblePortableSource({ wmRoot: root, verifyPins });
}

async function writeWmDevelopmentSource({ programDir, fullOutputDir }) {
  const program = path.resolve(programDir);
  const assembled = await assembleWmSource({ wmRoot: path.join(program, 'wm'), verifyPins: true });
  const output = path.resolve(fullOutputDir || path.join(program, 'plugins'));
  const filename = 'LIBRA_World_Manager.js';
  // No folder or artifact is created until every pin and assembly seam passed.
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, filename), assembled.code);
  return {
    owner: 'wm', profile: 'source', filename,
    inputDigest: hash(JSON.stringify(assembled.inputs)),
    outputSha256: assembled.sourceSha256,
    outputBytes: Buffer.byteLength(assembled.code),
    transforms: []
  };
}

module.exports = { assembleWmSource, writeWmDevelopmentSource };
if (require.main === module) {
  writeWmDevelopmentSource({ programDir: path.resolve(__dirname, '..'), fullOutputDir: process.argv[2] })
    .then(receipt => console.log(JSON.stringify(receipt)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
