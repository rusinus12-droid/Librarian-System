'use strict';
// Dump the REAL LIBRA analysis prompt (system + user) exactly as a model receives it, so the real
// Gemma-4 can be driven with it instead of a re-written approximation.
//
// Method mirrors tests/libra_memory_e2e_test.cjs: drive the real plugin through its fixture and
// capture the request on the first model call. Nothing is synthesised — the captured text is what
// the plugin sent.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_PROMPT_OUT || '/tmp/libra_prompt_dump.json';

(async () => {
  const f = await fixture();
  const captured = [];
  try {
    // Capture and answer with a deliberately unusable value: the prompt is the deliverable, and an
    // unusable answer guarantees the capture is not consumed by a successful commit path.
    f.control.onCall = args => {
      const messages = args[0]?.messages || [];
      const system = String(messages.find(m => m.role === 'system')?.content || '');
      const user = String(messages.find(m => m.role === 'user')?.content || '');
      captured.push({
        system,
        user,
        systemChars: system.length,
        userChars: user.length,
        totalChars: system.length + user.length,
        otherArgs: Object.fromEntries(
          Object.entries(args[0] || {}).filter(([k]) => k !== 'messages'))
      });
      return 'noop';
    };

    let runError = '';
    try {
      await f.run();
    } catch (error) {
      runError = String(error?.message || error).slice(0, 300);
    }

    // The five-pair source the prompt delimits, so the model runner can verify quotes against it.
    const sourceRows = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;

    fs.writeFileSync(OUT, JSON.stringify({
      capturedAt: new Date().toISOString(),
      callCount: captured.length,
      calls: captured,
      runError,
      sourceRows
    }, null, 1));

    process.stdout.write(JSON.stringify({
      ok: captured.length > 0,
      out: OUT,
      calls: captured.length,
      sizes: captured.map(c => ({ system: c.systemChars, user: c.userChars, total: c.totalChars })),
      runError: runError.slice(0, 120)
    }, null, 1) + '\n');
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
