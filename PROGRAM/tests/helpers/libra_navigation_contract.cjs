'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),acorn=require('acorn');
function declaration(source,name){const marker='const '+name+' =',start=source.indexOf(marker);assert(start>=0,'actual declaration '+name);const expression=acorn.parseExpressionAt(source,start+marker.length,{ecmaVersion:'latest'});return source.slice(start,expression.end)+';';}
function navigation(source){const context={Object};vm.createContext(context);vm.runInContext(declaration(source,'SHARED_SIDEBAR_PAGE_REGISTRY')+'\nconst SHARED_SIDEBAR_SECTIONS=SHARED_SIDEBAR_PAGE_REGISTRY.map(page=>page.id);\n'+declaration(source,'resolveSharedNavigationTarget')+'\nthis.route=resolveSharedNavigationTarget;',context);return value=>JSON.parse(JSON.stringify(context.route(value)));}
module.exports={declaration,navigation};
