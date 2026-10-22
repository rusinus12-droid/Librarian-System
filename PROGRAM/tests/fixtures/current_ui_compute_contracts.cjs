'use strict';
// Source AST and isolated pure UI/navigation execution only. No product bootstrap,
// bridge execution, network, models, authentication or protocol probes.
const assert=require('node:assert/strict'),vm=require('node:vm');
const {resolveAcorn}=require('../../tools/build_plugins.cjs');
const acorn=resolveAcorn();assert(acorn,'Acorn is required for structural regression contracts');
function walk(node,visit){if(!node||typeof node!=='object')return; if(typeof node.type==='string')visit(node);for(const value of Object.values(node)){if(Array.isArray(value))for(const item of value)walk(item,visit);else if(value&&typeof value==='object')walk(value,visit);}}
function parse(source){return acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'});}
function findAll(ast,predicate){const out=[];walk(ast,node=>{if(predicate(node))out.push(node);});return out;}
function variable(ast,name){const rows=findAll(ast,n=>n.type==='VariableDeclarator'&&n.id?.name===name);assert.equal(rows.length,1,'required unique binding: '+name);return rows[0];}
const key=node=>node?.type==='Identifier'?node.name:node?.type==='Literal'?node.value:undefined;
const member=(node,object,property)=>node?.type==='MemberExpression'&&node.object?.type==='Identifier'&&node.object.name===object&&key(node.property)===property;
const prop=(node,name)=>node?.type==='ObjectExpression'?node.properties.find(p=>p.type==='Property'&&key(p.key)===name)?.value:undefined;
const plain=value=>JSON.parse(JSON.stringify(value));
function checkNavigation(source){
 const ast=parse(source),names=['SHARED_SIDEBAR_PAGE_REGISTRY','SHARED_SIDEBAR_SECTIONS','resolveSharedNavigationTarget'];
 const declarations=names.map(name=>{const n=variable(ast,name);return 'const '+name+'='+source.slice(n.init.start,n.init.end)+';';}).join('\n');
 const resolve=vm.runInNewContext(declarations+'\nresolveSharedNavigationTarget;',{}, {timeout:1000});
 for(const requested of ['server','transfer','source_edits'])assert.deepEqual(plain(resolve(requested)),{pageId:'settings',settingsHubSection:requested},'legacy settings route: '+requested);
 return true;
}
function checkBookHeader(source){
 // The Book header is the topbar of the approved mockup app (LIBRA_APPROVED_MOCKUP_APP_HTML);
 // its controls are wired by data attributes through the app-level click handlers.
 const ast=parse(source),node=variable(ast,'LIBRA_APPROVED_MOCKUP_APP_HTML');
 assert.equal(node.init.type,'Literal','approved mockup markup is a string literal');
 const html=String(node.init.value),header=/<header class="topbar">([\s\S]*?)<\/header>/.exec(html);
 assert.ok(header,'Book header remains a semantic header.topbar');
 const buttons=[...header[1].matchAll(/<button\b([^>]*)>/g)].map(m=>m[1]);
 const has=attr=>buttons.some(b=>b.includes(attr));
 assert.ok(has('data-go="settings"'),'required Book header control: settings');
 assert.ok(!has('data-open="drawer-quick"'),'retired quick settings entry is absent');
 assert.ok(has('data-close-gui'),'required Book header control: close');
 // Handler wiring: data-go -> bookNavigate, drawer-quick -> bookOpenQuickSettings, close -> hideSettingsGui.
 assert.match(source,/const nav = event\.target\.closest\('\[data-go\]'\);[\s\S]{0,400}?bookNavigate\(nav\.dataset\.go\)/,'settings control dispatches bookNavigate');
 assert.match(source,/button\.matches\('\[data-close-gui\]'\)\) \{ event\.preventDefault\(\); void hideSettingsGui\(\)/,'close control hides the GUI');
 return true;
}
// The Compute SDK is retired from the plugins: no owner creates a Compute bridge or search
// client, and no embedded SDK remains. Search and reranking run locally.
function checkComputeRetired(source){
 assert.doesNotMatch(source,/LIBRARIAN SYSTEM COMPUTE SDK v/,'no embedded Compute SDK');
 const ast=parse(source);
 const factories=findAll(ast,n=>n.type==='CallExpression'&&['createMemorySuiteComputeBridge','createMemorySuiteSearchClient'].includes(n.callee?.name));
 assert.equal(factories.length,0,'no retired Compute bridge or search client is created');
 const executes=findAll(ast,n=>n.type==='CallExpression'&&n.callee?.type==='MemberExpression'&&/ComputeBridge$|SearchClient$/.test(String(n.callee.object?.name||'')));
 assert.equal(executes.length,0,'no retired Compute bridge or search client is called');
 return true;
}
module.exports={checkNavigation,checkBookHeader,checkComputeRetired};
