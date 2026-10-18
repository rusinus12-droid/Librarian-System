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
 const ast=parse(source),node=variable(ast,'topBar'),version=variable(ast,'PLUGIN_VERSION');
 const calls=[];
 const top=vm.runInNewContext('('+source.slice(node.init.start,node.init.end)+')',{
  guiEl:(tag,props={},children=[])=>({tag,props,children}),PLUGIN_VERSION:version.init.value,
  Gui:{bookQuickSection:'response'},bookNavigate:x=>calls.push(['navigate',x]),bookOpenQuickSettings:x=>calls.push(['quick',x]),hideSettingsGui:()=>calls.push(['close'])
 },{timeout:1000});
 assert.equal(top.tag,'header','Book header remains semantic header');
 const all=[];const collect=n=>{if(!n||typeof n!=='object')return;all.push(n);for(const c of n.children||[])collect(c);};collect(top);
 const byClass=c=>all.find(n=>String(n.props?.class||'').split(/\s+/).includes(c));
 for(const cls of ['libra-book-current-page','libra-book-boot-status'])assert.ok(String(byClass(cls)?.props?.text||'').trim(),'nonempty Book header status: '+cls);
 for(const [cls,expected] of [['libra-book-settings-button',['navigate','settings']],['libra-book-quick-button',['quick','response']],['libra-book-close-button',['close']]]){
  const button=byClass(cls);assert.equal(button?.tag,'button','required Book header control: '+cls);assert.equal(typeof button.props.onClick,'function','actionable Book control: '+cls);button.props.onClick();assert.deepEqual(calls.at(-1),expected,'Book header control dispatch: '+cls);
 }
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
