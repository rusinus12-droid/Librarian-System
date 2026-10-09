'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const start=source.indexOf('    const UNIFIED_CLAIMS = Object.freeze('),end=source.indexOf('    const unifiedAssert =',start);
const claims=vm.runInNewContext(source.slice(start,end)+';UNIFIED_CLAIMS');
const supported=domain=>new Set(Object.values(claims).filter(c=>c.domain===domain&&c.field).map(c=>c.field));
const people=source.slice(source.indexOf('  const buildBookCharacterProfileProjection ='),source.indexOf('  const BOOK_WORLD_KIND_LABELS ='));
const groups=people.slice(people.indexOf('const groupDefs='),people.indexOf('const groupedKeys='));
for(const match of groups.matchAll(/keys:\[([^\]]+)\]/g))for(const field of vm.runInNewContext('['+match[1]+']'))assert(supported('character').has(field),'No character producer: '+field);
const world=/const BOOK_WORLD_AUTO_FIELDS = new Set\((\[[^\]]+\])\)/.exec(source);
for(const field of vm.runInNewContext(world[1]))assert(supported('world').has(field),'No world producer: '+field);
const tabs=vm.runInNewContext(/const BOOK_NARRATIVE_GROUPS = (\[[^;]+);/.exec(source)[1]);
// T09 added two reading categories to the almanac, and both must stay backed by
// records this plugin actually produces:
//   * `arcs`    -- story flow / turning points / motifs, which `bookNarrativeModel`
//                  already built (`n.arcs`, `n.turningPoints`, `n.motifs`) but which
//                  had no tab, so they were never drawn.
//   * `relations` -- the directional relationship rows (`view.relationships`) whose
//                  milestones are read from the existing rows rather than a second
//                  parallel fact (`02` T09: "이중 사실을 생성하지 않는다").
// The assertion stays exact on purpose: a category may not be added to the reading
// page without a producer behind it.
assert.deepEqual(Array.from(tabs,tab=>tab[0]),['threads','events','arcs','relations','closed']);
console.log('PASS reading-page fields match unified producers; narrative categories limited to supported records');
