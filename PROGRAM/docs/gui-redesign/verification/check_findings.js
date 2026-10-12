#!/usr/bin/env node
/* findings.tsv의 evidence가 가리키는 검사가 results/ 최신 결과에 실제로 있고 통과했는지 확인한다.
   evidence 형식: 스크립트:검사키  (검사키 '*'는 그 스크립트의 모든 실행이 통과해야 함)
   'fixed'/'partial' 행의 evidence가 하나라도 없거나 실패면 종료 코드 1 */
'use strict';
const fs = require('fs'), path = require('path');
const here = __dirname, res = path.join(here, 'results');
const runs = fs.readdirSync(res).filter(f => f.endsWith('.json')).map(f => {
  const script = f.split('__')[0];
  return { file: f, script, data: JSON.parse(fs.readFileSync(path.join(res, f), 'utf8')) };
});
const rows = fs.readFileSync(path.join(here, 'findings.tsv'), 'utf8').trim().split('\n').slice(1).map(l => {
  const [id, report, section, status, evidence, note] = l.split('\t'); return { id, report, section, status, evidence: evidence || '', note: note || '' };
});
function lookup(script, key) {
  const mine = runs.filter(r => r.script === script);
  if (!mine.length) return { found: false };
  if (key === '*') {
    const bad = mine.filter(r => r.data.evalError || (r.data.rawPlaceholders && (r.data.rawPlaceholders.length || r.data.errors.length)) || (r.data.failed && r.data.failed.length));
    return { found: true, pass: bad.length === 0, where: mine.length + ' runs' };
  }
  for (const r of mine) if (r.data.ok && Object.prototype.hasOwnProperty.call(r.data.ok, key)) return { found: true, pass: r.data.ok[key] === true, where: r.file };
  return { found: false };
}
let problems = 0; const counts = {};
for (const row of rows) {
  const k = row.section + '/' + row.status; counts[k] = (counts[k] || 0) + 1;
  if (!row.evidence) { if (row.status === 'fixed') { console.log('NO-EVIDENCE', row.id); problems++; } continue; }
  for (const ev of row.evidence.split(';')) {
    const i = ev.indexOf(':'), script = ev.slice(0, i), key = ev.slice(i + 1);
    const r = lookup(script, key);
    if (!r.found) { console.log('MISSING', row.id, ev); problems++; }
    else if (!r.pass) { console.log('FAILED', row.id, ev, r.where); problems++; }
  }
}
console.log(JSON.stringify({ findings: rows.length, byStatus: counts, evidenceProblems: problems }));
process.exit(problems ? 1 : 0);
