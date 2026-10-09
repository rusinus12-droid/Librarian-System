'use strict';
/**
 * Gate: 프롬프트가 모델에게 주는 enum 이 제품 검증기와 일치하는가.
 *
 * 실측 결함 (2026-09-27, 실제 출하 프롬프트 캡처):
 *   worldAdditional 응답 shape 의 status enum 이 배열마다 달랐다.
 *     sceneInterventions  prepared|armed|injected|manifested|integrated|retired|blocked  (7)
 *     worldDeltas         prepared|armed|          manifested|integrated                 (4)
 *     characterAdditions  prepared|armed|          manifested|integrated                 (4)
 *   제품 VALID_STATUSES 는 7개 전부이고, ingestMaintenance 는
 *   worldDeltas/characterAdditions 도 normalizeStatus(...) === 'injected' 로 판정한다.
 *   즉 프롬프트가 모델에게서 뺏은 값을 제품이 판정에 쓴다.
 *   blocked(모델이 안전상 스스로 억제해야 할 때)는 그 두 배열에서 표현 자체가 불가했다.
 *
 * 이 게이트는 shape 을 **실제 함수 실행 결과**에서 얻는다. 소스 문자열 리터럴 패턴에 의존하지
 * 않으므로 shape 을 구조 객체로 리팩터링해도 계속 유효하다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

const assertions = [];
const add = (name, ok, details) => assertions.push({ name, ok: !!ok, details: details || {} });
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const opt = readSrc('src/parts/09c-turn-maintenance-optimizer.js');
const dlc = readSrc('src/parts/09a-world-additional-user-dlc.js');
const dist = readSrc('dist/LIBRA World Manager Full.js');

// ── shape 을 실제로 실행해 얻는다 ──
// 함수 끝을 '        };' 패턴으로 찾으면 함수 내부의 중괄호에서 먼저 잘린다.
// 문자열 리터럴을 존중하는 중괄호 균형으로 정확한 끝을 찾는다.
const extractFunction = (src, name) => {
    const i = src.indexOf('const ' + name);
    if (i < 0) return null;
    const open = src.indexOf('{', src.indexOf('=>', i));
    if (open < 0) return null;
    let depth = 0, inStr = false, esc = false, inTpl = false;
    for (let x = open; x < src.length; x++) {
        const ch = src[x];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (inStr) { if (ch === inStr) inStr = false; continue; }
        if (inTpl) { if (ch === '`') inTpl = false; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '`') { inTpl = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') { depth -= 1; if (depth === 0) return src.slice(i, x + 1); }
    }
    return null;
};
const runShape = (name) => {
    const fnSrc = extractFunction(opt, name);
    if (!fnSrc) return null;
    const ctx = vm.createContext({ console, JSON, Object, Array, String, Number });
    try {
        vm.runInContext(fnSrc + `\nglobalThis.__r = ${name}();`, ctx);
        return vm.runInContext('globalThis.__r', ctx);
    } catch (_) { return null; }
};
const parseShape = (name, root) => {
    const raw = runShape(name);
    if (!raw) return { raw: null, obj: null };
    try { return { raw, obj: JSON.parse('{' + raw + '}')[root] }; } catch (_) { return { raw, obj: null }; }
};
const wa = parseShape('getWorldAdditionalResponseShape', 'worldAdditional');
const dlcShape = parseShape('getUserDlcTrackerResponseShape', 'userDlcTrackerUpdates');

add('world_additional_shape_executable', !!wa.obj,
    { rawLen: wa.raw ? wa.raw.length : 0, keys: wa.obj ? Object.keys(wa.obj) : null });
add('user_dlc_shape_executable', !!dlcShape.obj,
    { rawLen: dlcShape.raw ? dlcShape.raw.length : 0, count: dlcShape.obj ? dlcShape.obj.length : null });

// ── 제품 상수 ──
const vals = (re) => { const m = dlc.match(re); return m ? m[1].match(/'(\w+)'/g).map(s => s.replace(/'/g, '')) : null; };
const product = vals(/VALID_STATUSES\s*=\s*\[([^\]]+)\]/);
const pForce = vals(/VALID_FORCE\s*=\s*\[([^\]]+)\]/);
const pImpact = vals(/VALID_IMPACT\s*=\s*\[([^\]]+)\]/);
const pTier = vals(/VALID_PROGRESSION_TIERS\s*=\s*\[([^\]]+)\]/);
add('product_valid_statuses_present', !!product, { count: product ? product.length : 0 });

// ── 버킷별 status enum (실행 결과에서) ──
const bucketItem = (b) => (wa.obj && Array.isArray(wa.obj[b]) && wa.obj[b][0]) ? wa.obj[b][0] : null;
const statusOf = (b) => { const it = bucketItem(b); return it && it.status ? String(it.status).split('|') : null; };
const si = statusOf('sceneInterventions'), wd = statusOf('worldDeltas'), ca = statusOf('characterAdditions');

const same = (a, b) => !!a && !!b && a.length === b.length && a.every(x => b.includes(x));

add('scene_interventions_status_matches_product', same(si, product), { prompt: si });
add('world_deltas_status_matches_product', same(wd, product),
    { prompt: wd, missing: product && wd ? product.filter(x => !wd.includes(x)) : null });
add('character_additions_status_matches_product', same(ca, product),
    { prompt: ca, missing: product && ca ? product.filter(x => !ca.includes(x)) : null });

// 세 배열이 서로 같은 enum 을 쓴다 (비대칭 재발 방지 — 이번 결함의 핵심)
add('status_enum_symmetric_across_buckets', same(si, wd) && same(wd, ca), { si, wd, ca });

// injected 가 세 배열 모두에 있다 (중복 주입 방지의 핵심 값)
add('injected_available_in_all_buckets', [si, wd, ca].every(x => !!x && x.includes('injected')), {});

// ── 나머지 enum ──
const siItem = bucketItem('sceneInterventions');
add('force_enum_matches', same(siItem && siItem.forceLevel ? String(siItem.forceLevel).split('|') : null, pForce), {});
add('impact_enum_matches', same(siItem && siItem.userImpact ? String(siItem.userImpact).split('|') : null, pImpact), {});
add('progression_tier_matches', same(siItem && siItem.progressionTier ? String(siItem.progressionTier).split('|') : null, pTier), {});

// ── 버킷 필드가 제품 정규화기 범위 안인지 (프롬프트 ⊆ 제품) ──
const PROD_DIRECTIVE_FIELDS = new Set(['type', 'title', 'description', 'directive', 'purpose', 'sourceBasis',
    'reusedCanonEntity', 'noveltyReason', 'noveltyScope', 'customSource', 'progressionTier',
    'activationCondition', 'forceLevel', 'userImpact', 'constraints', 'status', 'name', 'role']);
for (const b of ['sceneInterventions', 'worldDeltas', 'characterAdditions']) {
    const it = bucketItem(b);
    const extra = it ? Object.keys(it).filter(k => !PROD_DIRECTIVE_FIELDS.has(k)) : [];
    add(`no_unconsumed_fields:${b}`, !!it && extra.length === 0, { extra });
}

// ── 죽은 별칭이 되살아나지 않았는지 (A 정리) ──
add('dead_manifest_aliases_removed',
    !/source\.adoptionLog\b/.test(dlc) && !/source\.adoption_log\b/.test(dlc),
    {});

// ── dist 반영 ──
add('dist_carries_fix',
    /prepared\|armed\|injected\|manifested\|integrated\|retired\|blocked/.test(dist),
    {});

const failed = assertions.filter(a => !a.ok);
process.stdout.write(JSON.stringify({
    ok: failed.length === 0,
    suite: 'prompt-enum-product-parity',
    summary: `${assertions.length - failed.length}/${assertions.length}`,
    assertions,
}, null, 1) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
