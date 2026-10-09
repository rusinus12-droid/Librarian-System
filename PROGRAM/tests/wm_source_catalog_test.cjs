'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const distribution=require('../tools/build_distribution.cjs'),catalog=require('../tools/wm_source_catalog.cjs');
test('wm_unpinned_dist_is_never_a_source_catalog_exception_even_under_active_tools',()=>{for(const file of ['wm/dist/extra.js','wm/tools/dist/extra.js','wm/build-support/dist/extra.js','wm/src/dist/extra.js','wm/references/frozen-B/dist/extra.js'])assert.equal(distribution.shouldCopySourceProgram(file),false,file)});
test('wm_exact_636_pinned_reference_inputs_remain_shippable',()=>{const files=catalog.fixtureCatalog();assert.equal(Object.keys(files).length,636);for(const file of Object.keys(files))assert.equal(distribution.shouldCopySourceProgram('wm/'+file),true,file)});
