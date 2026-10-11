'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Element{
  constructor(tag,doc){this.tagName=tag.toLowerCase();this.ownerDocument=doc;this.children=[];this.attributes=new Map();this.dataset={};this.style={};this.value='';this.textContent='';this.disabled=false;this.isConnected=true;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  prepend(...nodes){for(const node of nodes){node.parent=this;this.children.unshift(node);}}
  insertBefore(node,reference){const index=this.children.indexOf(reference);node.parent=this;this.children.splice(index<0?this.children.length:index,0,node);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.isConnected=false;}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getAttribute(key){return this.attributes.get(key)||null;}
  querySelector(selector){if(selector==='[data-source-input-controls]')return this.walk().find(node=>node.dataset.sourceInputControls)||null;return null;}
  querySelectorAll(selector){const names=selector.split(',').map(name=>name.trim());return this.walk().filter(node=>names.includes(node.tagName));}
  walk(){return this.children.flatMap(child=>[child,...child.walk()]);}
  focus(){}
}

test('owner input preview remains local, literal and model-free without host dialogs',async()=>{
 const c=vm.createContext({setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceInput.libra.source.js'),'utf8'),c);
 const doc={createElement:tag=>new Element(tag,doc)},root=new Element('div',doc),raw='Alice <img src=x onerror="globalThis.xss=1"><script>globalThis.xss=2</script>';let reads=0,writes=0,stored=JSON.stringify({sourceRules:{version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]}});
 const api=c.createMemorySuiteSourceInputPolicy({owner:'libra',read:async()=>stored,write:async body=>{writes++;stored=body;return true},readSample:async()=>{reads++;return{text:raw,label:'T1'}}});
 try{api.mountControls(root);await api.ready();await Promise.resolve();assert.equal(reads,0,'mounting never reads raw source implicitly');assert.equal(writes,0);const button=root.walk().find(n=>n.dataset.sourceInputPreview!==undefined);assert.ok(button);await button.onclick();const output=root.walk().find(n=>n.dataset.sourceInputOutput!==undefined);assert.equal(output.textContent,raw);assert.equal(output.querySelectorAll('img,script').length,0);assert.equal(reads,1);assert.equal(writes,0);assert.equal(stored.includes('Alice'),false);assert.equal(root.walk().some(n=>n.dataset.sourceEditDialog!==undefined),false)}finally{api.dispose()}
});
