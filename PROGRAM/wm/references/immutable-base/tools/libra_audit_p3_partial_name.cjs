'use strict';
// 감사용 실측 — P3(영어 multi-part name 의 partial edge) 오탐 여부
//   주장: `John` ⊂ `John Smith` 가 separator 규칙을 통과해 partial(0.45) 엣지가 생긴다.
//   판정: 0.45 > `light.edgeWeightMin`(0.28) 이므로 **실제 엣지**가 된다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/10c-hme-associative-graph.js'), 'utf8');

// ① 경계 판정 로직을 실제 코드에서 추출해 실행한다 (제품과 같은 규칙)
const i = SRC.indexOf('const hmeEntityNameBoundaryMatch');
const j = SRC.indexOf('const buildHmeGraphCrossTypeEdges', i);
const fnSrc = SRC.slice(i, j);
const boundary = new Function(fnSrc + '; return hmeEntityNameBoundaryMatch;')();

const CASES = [
  ['John Smith', 'John', '영어 multi-part (지적 대상)'],
  ['John', 'John Smith', '역방향 (긴 쪽이 짧은 쪽으로 시작 안 함)'],
  ['art-arthur', 'art', '구분자 -'],
  ['art arthur', 'art', '구분자 공백'],
  ['세라핌', '세라', '한국어 접두 (막아야 함)'],
  ['김민아', '민아', '한국어 성씨 (끝 일치)'],
  ['아리엘', '리엘', '한국어 끝 일치'],
  ['미라', '미라', '완전 일치']
];
console.log('=== 경계 판정 (실제 제품 함수 실행) ===');
for (const [long, short, note] of CASES) {
  const ok = boundary(long, short);
  console.log(`  "${long}" vs "${short}" → ${ok ? 'partial 허용' : '거부 (오탐 아님)'}   ${note}`);
}

// ② 가중치
const weightLine = SRC.match(/const weight = exact > 0 \? ([\d.]+) : ([\d.]+);/);
console.log();
console.log('=== 가중치 ===');
console.log('  exact =', weightLine ? weightLine[1] : '?', '| partial =', weightLine ? weightLine[2] : '?');
const minLine = SRC.match(/edgeWeightMin:\s*([\d.]+)/);
console.log('  light.edgeWeightMin =', minLine ? minLine[1] : '(10c 밖)');
const partialW = weightLine ? Number(weightLine[2]) : 0;
const minW = minLine ? Number(minLine[1]) : 0.28;
console.log();
console.log('  ★ partial(' + partialW + ') > edgeWeightMin(' + minW + ') →', partialW > minW ? '실제 엣지가 된다 (오탐 가능)' : '엣지 필터에서 탈락');
