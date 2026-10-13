'use strict';
// Replays the existing mockup plan in a new Chromium context for every scenario.
// This verifies mockup behavior only, not product APIs or a live Risu host.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const here = __dirname;
const site = path.dirname(here);
const filter = process.argv[2] || '';
const out = path.resolve(process.argv[3] || path.join(here, 'playwright-results'));
const historicalPlan = fs.readFileSync(path.join(here, 'run_all.sh'), 'utf8').match(/PLAN='([\s\S]*?)'/)[1].trim().split('\n').map(line => line.trim().split(/\s+/)).filter(([script, page]) => `${script} ${page}`.includes(filter));
const plan = process.env.MOCKUP_G2_ONLY ? ['lia','libra','hayaku','flashback','gradia','retrace'].map(product => [`g2_${product}`, `${product}.html`]).filter(([script,page]) => `${script} ${page}`.includes(filter)) : historicalPlan;
const summary = [];
const classify = data => Array.isArray(data)
  ? { checks: data.length, failures: data.filter(value => /NOT-DONE/.test(value)) }
  : data.ok ? { checks: Object.keys(data.ok).length, failures: Object.keys(data.ok).filter(key => !data.ok[key]) }
  : 'rawPlaceholders' in data ? { checks: data.clicks, failures: [...data.rawPlaceholders, ...data.errors] }
  : { checks: 'static', failures: Object.keys(data).filter(key => Array.isArray(data[key]) && data[key].length) };
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const inputs = [...new Set(plan.map(([, page]) => page.split(/[?#]/)[0]).concat(['assets/suite.css', 'assets/themes.css', 'assets/suite.js']))];
  fs.writeFileSync(path.join(out, 'inputs.json'), JSON.stringify({ baseGitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site, encoding: 'utf8' }).trim(), scripts: Object.fromEntries([...new Set(plan.map(([script])=>script))].map(script=>[script,crypto.createHash('sha256').update(fs.readFileSync(path.join(here,'scripts',script+'.js'))).digest('hex')])), inputs: Object.fromEntries(inputs.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(site, file))).digest('hex')])) }, null, 2));
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const [script, page] of plan) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 920 } });
      const tab = await context.newPage();
      const errors = [];
      tab.on('pageerror', error => errors.push(String(error)));
      let timer, data;
      try {
        await tab.goto(process.env.MOCKUP_BASE_URL ? `${process.env.MOCKUP_BASE_URL.replace(/\/$/, '')}/${page}` : `file://${site}/${page}`, { waitUntil: 'load' });
        await tab.waitForTimeout(700);
        const result = await Promise.race([
          tab.evaluate(fs.readFileSync(path.join(here, 'scripts', `${script}.js`), 'utf8')),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('scenario exceeded 90 seconds')), 90000); })
        ]);
        data = typeof result === 'string' ? JSON.parse(result) : result;
      } catch (error) { data = { evalError: String(error) }; }
      finally { clearTimeout(timer); await context.close(); }
      const verdict = data.evalError ? { checks: 'EVAL_ERROR', failures: [data.evalError] } : classify(data);
      const name = `${script}__${page}`.replace(/[\/?#=&]/g, '_');
      fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ method: 'isolated Chromium mockup context', script, page, pageErrors: errors, result: data }, null, 2));
      summary.push({ script, page, ...verdict, pageErrors: errors.length });
      console.log(JSON.stringify(summary.at(-1)));
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(out, 'summary.tsv'), 'script\tpage\tchecks\tfailed\tpage_errors\n' + summary.map(row => [row.script, row.page, row.checks, JSON.stringify(row.failures), row.pageErrors].join('\t')).join('\n') + '\n');
  process.exitCode = summary.some(row => row.checks === 'EVAL_ERROR' || row.pageErrors || (!['sweep_noctx', 'final_jobs'].includes(row.script) && row.failures.length)) ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
