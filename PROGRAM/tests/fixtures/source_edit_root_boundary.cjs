'use strict';
// Faithful boundary stub for supplied RisuAI SafeElement: x-* attrs only and
// document-wide trimmed listeners. No RisuAI data/processing is simulated here.
function createRootBoundary(){
 const listeners=new Map();let next=0,focus=null;
 class Element {
  constructor(tag,cls=''){this.tag=tag;this.cls=cls;this.attrs={};this.children=[];this.parent=null;this.text='';this.styles='';}
  async setAttribute(k,v){if(!k.startsWith('x-'))throw Error('x-* only');this.attrs[k]=v;}
  async getAttribute(k){if(!k.startsWith('x-'))throw Error('x-* only');return this.attrs[k]??null;}
  async setStyleAttribute(s){this.styles=s;}
  async setTextContent(s){this.text=s;}
  async appendChild(c){this.children.push(c);c.parent=this;}
  async remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;}
  async getParent(){return this.parent;}
  async focus(){focus=this;}
  async matches(s){return s===':focus'&&focus===this;}
  async addEventListener(type,fn){const id=String(++next);listeners.set(id,{type,fn});return id;}
  async removeEventListener(type,id){listeners.delete(id);}
  async getBoundingClientRect(){const yes=this.cls==='ms-source-edit-yes',no=this.cls==='ms-source-edit-no';return yes?{left:220,right:360,top:310,bottom:354,width:140,height:44}:no?{left:70,right:200,top:310,bottom:354,width:130,height:44}:{left:40,right:380,top:70,bottom:380,width:340,height:310};}
  async setInnerHTML(){const panel=new Element('section','ms-source-edit-panel');const actions=new Element('div','ms-source-edit-actions');await panel.appendChild(new Element('h3'));await panel.appendChild(new Element('p'));await panel.appendChild(actions);await actions.appendChild(new Element('button','ms-source-edit-no'));await actions.appendChild(new Element('button','ms-source-edit-yes'));await this.appendChild(panel);}
  async querySelector(sel){const children=this.children.flatMap(c=>[c,...c.descendants()]);return children.find(n=>sel==='body'?n.tag==='body':sel.startsWith('.')?n.cls===sel.slice(1):sel.startsWith('[x-')?Object.hasOwn(n.attrs,sel.slice(1,-1)):n.tag===sel)||null;}
  descendants(){return this.children.flatMap(c=>[c,...c.descendants()]);}
 }
 const root=new Element('html'),body=new Element('body');root.children.push(body);body.parent=root;root.createElement=async tag=>new Element(tag);
 return {root,body,listeners, async emit(type,ev){for(const r of [...listeners.values()])if(r.type===type)await r.fn({...ev,type});},async click(approve){await this.emit('click',{clientX:approve?260:110,clientY:330,button:0});},async outside(){await this.emit('click',{clientX:5,clientY:5,button:0});},async keyboard(key){await this.emit('keydown',{key});},async ready(){return !!await root.querySelector('[x-memory-suite-source-edit-dialog]') && !!focus && body.descendants().includes(focus);}};
}
module.exports={createRootBoundary};
