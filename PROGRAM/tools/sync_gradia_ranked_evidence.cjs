'use strict';
// Canonical ACTIVE component source -> byte-identical LIBRA/GRADIA private embeds.
// Independent GRADIA upstream may verify its source using --upstream-render PATH.
// This does not generate Full/Min releases or enable a qualified owner route.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), write = process.argv.includes('--write');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const common = ['sdk/gradia/GradiaReadV2Protocol.source.js', 'sdk/gradia/GradiaReadV2Credit.source.js', 'sdk/gradia/GradiaReadV2Frames.source.js', 'sdk/GradiaEvidenceRender.v2.source.js'];
const begin = '/* GRADIA RANKED EVIDENCE V2 COMPONENTS BEGIN */', end = '/* GRADIA RANKED EVIDENCE V2 COMPONENTS END */';
const index = process.argv.indexOf('--upstream-render');
if (index >= 0) {
  if (!process.argv[index + 1]) throw Error('UPSTREAM_RENDER_PATH_REQUIRED');
  if (!fs.readFileSync(process.argv[index + 1]).equals(fs.readFileSync(path.join(root, 'sdk/GradiaEvidenceRender.v2.source.js')))) throw Error('UPSTREAM_RENDER_PIN_MISMATCH');
}
const result = [];
for (const target of [
  { file: 'plugins/LIBRA.js', module: 'sdk/gradia/LibraGradiaRankedProducer.source.js', marker: 'function createLibraReadonlySourceContext(owner) {' },
  { file: 'plugins/GRADIA.js', module: 'sdk/gradia/GradiaEvidenceSelection.source.js', marker: 'function createGradiaEvidenceBudget({ digest }) {' }
]) {
  const sources = [...common, target.module].map(file => ({ file, source: fs.readFileSync(path.join(root, file), 'utf8') }));
  const block = begin + '\n' + sources.map(({ file, source }) => '// Source: ' + file + ' sha256=' + sha(source) + '\n' + source).join('\n') + end;
  const file = path.join(root, target.file); let source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(begin), finish = source.indexOf(end);
  if (start < 0) {
    if (!write) throw Error(target.file + ': MISSING_COMPONENT_EMBED');
    if (source.split(target.marker).length !== 2) throw Error('AMBIGUOUS_INSERTION');
    source = source.replace(target.marker, block + '\n\n' + target.marker);
  } else {
    if (finish < start || source.indexOf(begin, start + begin.length) >= 0) throw Error('AMBIGUOUS_COMPONENT_EMBED');
    if (!write && source.slice(start, finish + end.length) !== block) throw Error(target.file + ': COMPONENT_PIN_MISMATCH');
    source = source.slice(0, start) + block + source.slice(finish + end.length);
  }
  if (write) fs.writeFileSync(file, source);
  result.push({ target: target.file, componentSources: sources.map(({ file, source }) => ({ file, sha256: sha(source) })), byteIdentical: true });
}
process.stdout.write(JSON.stringify({ schema: 'gradia.ranked-component-pins.v2', upstreamCompared: index >= 0, productionAdmission: false, targets: result }, null, 2) + '\n');
