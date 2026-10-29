'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test');
const {extract}=require('./helpers/libra_approved_gui_contract.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const parser=vm.runInNewContext(extract(source,'bookReadingVisibleText')+'\n'+extract(source,'parseBookMemoryReading')+'\nparseBookMemoryReading;');
const parse=text=>JSON.parse(JSON.stringify(parser(text)));
test('all canonical areas stay on one page with separate headings and fact lists',()=>{
 const raw='# 종합 기억\n\n## 시간순 사건\n- 문이 열렸다. (근거: t1-a)\n- 민아가 도착했다. (근거:t2-u)\n## 인물과 관계\n- 민아는 암호를 듣지 않았다. (근거: t3-a)\n## 세계와 장면\n- 서재는 도서관 안에 있다.\n## 내러티브와 미해결 문제\n- 열쇠의 행방은 미확인이다.\n## 확정 사실과 불확실 정보\n- 목격자는 한 명이다.\n## 회상 키워드\n- 민아, 열쇠';
 const sections=parse(raw);assert.equal(sections.length,7);assert.deepEqual(sections.map(s=>s.title),['종합 기억','시간순 사건','인물과 관계','세계와 장면','내러티브와 미해결 문제','확정 사실과 불확실 정보','회상 키워드']);
 assert.equal(sections[1].blocks[0].items.length,2);assert.equal(sections[2].blocks[0].items[0],'민아는 암호를 듣지 않았다.');assert.equal(sections[0].blocks.length,0);assert.match(raw,/근거: t3-a/);
});
test('only generated trailing message-ref citations are hidden; prose and quoted markers survive',()=>{
 const sections=parse('# 종합 기억\n## 확정 사실과 불확실 정보\n- 단서는 없다. (근거: T3-a, t4-u)\n- 목격했다. （근거：t5-a）\n- 추정이다. (근거: 목격자의 증언)\n- 표지에 “(근거: t3-a)”라고 적혀 있다.\n- 암호는 t3-a 이다.');
 assert.deepEqual(sections[1].blocks[0].items,['단서는 없다.','목격했다.','추정이다. (근거: 목격자의 증언)','표지에 “(근거: t3-a)”라고 적혀 있다.','암호는 t3-a 이다.']);
});
test('legacy prose, paragraphs and list continuations keep their full text',()=>{
 const sections=parse('첫 문단이다.\n같은 문단의 다음 줄이다.\n\n두 번째 문단이다.\n- 긴 항목\n  이어지는 설명이다. (근거: t2-a)');
 assert.equal(sections.length,1);assert.equal(sections[0].title,'종합 기억');assert.equal(sections[0].blocks[0].text,'첫 문단이다.\n같은 문단의 다음 줄이다.');assert.equal(sections[0].blocks[1].text,'두 번째 문단이다.');assert.equal(sections[0].blocks[2].items[0],'긴 항목\n이어지는 설명이다.');
});
test('unknown headings and long content are retained without summarizing',()=>{
 const long='긴 원문 '.repeat(2500),sections=parse('# 종합 기억\n## 추가 약속\n'+long);assert.equal(sections[1].title,'추가 약속');assert.equal(sections[1].blocks[0].text,long.trim());
});
