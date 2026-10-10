'use strict';
// Why is the real model's normal-turn answer still not counted as a valid packet?
// Reads the plugin's OWN diagnostics for the verbatim answer.
const fs = require('node:fs');
const { createHayakuRuntime } = require('../tests/fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const r = await createHayakuRuntime({ messages: [] });
  const t = r.hayaku._test;
  const ans = JSON.parse(fs.readFileSync('/tmp/gemma_normal_result.json', 'utf8')).attempts[0].rawContent;

  const insp = t.packetCaptureInspectionFromText(ans);
  console.log(JSON.stringify({
    counts: {
      markerStartCount: insp.markerStartCount,
      markerEndCount: insp.markerEndCount,
      completeCount: insp.completeCount,
      parsedCount: insp.parsedCount,
      validCount: insp.validCount,
      repairableCount: insp.repairableCount,
      semanticIncompleteCount: insp.semanticIncompleteCount,
      invalidCount: insp.invalidCount,
      oversizedCount: insp.oversizedCount
    },
    diagnostics: insp.diagnostics
  }, null, 1).slice(0, 4000));

  await r.dispose?.();
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
