'use strict';
// Dump the NORMAL-TURN packet contract exactly as it is injected into the response model's prompt.
//
// The normal turn does not call a separate model: the contract is appended to the generation prompt
// and the RESPONSE MODEL is asked to append one packet after its visible answer. This dump captures
// that contract text (all three cache profiles, because the profile is chosen at runtime) plus the
// completion seal, so a real model can be driven with exactly what the plugin ships.
const fs = require('node:fs');
const path = require('node:path');
const { createHayakuRuntime } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));

const OUT = process.env.HAYAKU_NORMAL_PROMPT_OUT || '/tmp/hayaku_normal_prompt_dump.json';

(async () => {
  const runtime = await createHayakuRuntime({ messages: [] });
  try {
    const t = runtime.hayaku._test;
    const settings = { memoryLanguage: 'source' };

    const profile = typeof t.packetCacheStaticContract === 'function'
      ? t.packetCacheStaticContract(settings, 'full')
      : null;

    const full = t.buildPacketCoreStaticWriteInstruction(settings);
    const compact = t.buildPacketCoreCompactWriteInstruction(settings);
    const critical = t.buildPacketCoreCompactWriteInstruction(settings, { critical: true });
    const seal = t.buildPacketTerminalCompletionSeal(settings);
    const example = t.packetCompletedFormatExample();

    fs.writeFileSync(OUT, JSON.stringify({
      capturedAt: new Date().toISOString(),
      // The contract the response model receives when the full profile is active.
      fullContract: full,
      compactContract: compact,
      criticalContract: critical,
      // The tail reminder appended after the visible-response instruction.
      completionSeal: seal,
      // The worked example embedded in the full contract.
      formatExample: JSON.stringify(example),
      profileChars: profile ? { chars: profile.chars, estimatedTokens: profile.estimatedTokens, profile: profile.profile } : null,
      sizes: {
        full: full.length,
        compact: compact.length,
        critical: critical.length,
        seal: seal.length
      }
    }, null, 1));

    process.stdout.write(JSON.stringify({
      ok: true,
      out: OUT,
      sizes: { full: full.length, compact: compact.length, critical: critical.length, seal: seal.length },
      fullHasExample: /FORMAT EXAMPLE/.test(full),
      compactHasExample: /FORMAT EXAMPLE/.test(compact)
    }, null, 1) + '\n');
  } finally {
    await runtime.dispose?.();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
