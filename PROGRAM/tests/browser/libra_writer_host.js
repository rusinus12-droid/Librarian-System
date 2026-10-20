// Ephemeral API boundary for the full production LIBRA browser regression.
// No RisuAI application, user data, external model, or OS clipboard is involved.
(() => {
 // The first-setup quick-connect popup is covered by its own tests; these hosts start past it.
 const values=new Map([['libra.firstSetupSeen.v1','1']]), unload=[];
 const stores={action:[],hamburger:[],chat:[]};
 const chat={id:'writer-browser-chat',chatId:'writer-browser-chat',message:[{role:'user',data:'문 앞에 서서 기다린다.',chatId:'u1'},{role:'char',data:'문 너머에서 발소리가 멎는다.',chatId:'a1'}]};
 const character={id:'writer-browser-character',chaId:'writer-browser-character',name:'검증용 인물',chatPage:0,chats:[chat],globalLore:[]};
 const calls={show:[],hide:0,model:0,send:[],errors:[],inputHooks:[],removed:[],network:0};
 const storage={async getItem(k){return values.get(String(k))??null;},async setItem(k,v){values.set(String(k),v);return true;},async removeItem(k){values.delete(String(k));return true;},async keys(){return [...values.keys()];}};
 const state={stores,calls,chat,character,values,unload,showMode:'normal',pendingShows:[],providerMode:'rp'};
 const api={
  pluginStorage:storage,safeLocalStorage:storage,async getLocalPluginStorage(){return storage;},
  async getArgument(k){k=String(k);if(k.includes('memory_suite_server_mode'))return 'plugin_only';if(k.includes('enable_gui'))return 'true';if(k.includes('input_writer_enabled'))return 'true';if(k.includes('input_writer_mode'))return 'rp';return '';},
  async setArgument(){return true;}, async getCurrentCharacterIndex(){return 0;},async getCurrentChatIndex(){return 0;},
  async getCharacter(){return structuredClone(character);},async getCharacterFromIndex(){return structuredClone(character);},
  async getChat(){return structuredClone(chat);},async getCurrentChat(){return structuredClone(chat);},async getChatFromIndex(){return structuredClone(chat);},
  async getDatabase(fields){const all={personas:[],selectedPersona:'',characters:[character],plugins:[],modules:[]};return structuredClone(Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,all[k]??null])):all);},
  async registerButton(arg,callback){const row={...arg,callback};for(const store of Object.values(stores)){const at=store.findIndex(n=>n.id===row.id);if(at>=0){store[at]=row;return {id:row.id};}}stores[arg.location||'action'].push(row);return {id:row.id};},
  async unregisterUIPart(id){calls.removed.push(id);for(const store of Object.values(stores)){const at=store.findIndex(n=>n.id===id);if(at>=0)store.splice(at,1);}},
  async registerSetting(){return {id:'libra-test-setting'};},
  showContainer(mode){calls.show.push({mode,hasComposer:!!document.querySelector('.libra-input-writer-modal'),at:performance.now()});if(state.showMode==='pending')return new Promise((resolve,reject)=>state.pendingShows.push({resolve,reject}));if(state.showMode==='reject')return Promise.reject(new Error('fixture show denied'));return Promise.resolve(true);},
  hideContainer(){calls.hide++;return Promise.resolve(true);},
  async alertError(m){calls.errors.push(String(m));},
  async requestPluginPermission(){return true;},
  async onUnload(fn){unload.push(fn);return true;},async addRisuReplacer(){return true;},async removeRisuReplacer(){return true;},
  async addRisuChatListener(){return true;},async removeRisuChatListener(){return true;},
  async addRisuScriptHandler(k){calls.inputHooks.push(k);return true;},async removeRisuScriptHandler(){return true;},
  async addPluginChannelListener(){return true;},async removePluginChannelListener(){return true;},async postPluginChannelMessage(){return true;},
  async nativeFetch(){calls.network++;throw new Error('network not used in this fixture');},
  async runLLMModel(arg){calls.model++;if(arg.mode!=='otherAx')throw new Error('wrong API route');return JSON.stringify({schema:'libra.input_writer_choices.v1',ok:true,mode:state.providerMode,choices:[{id:'A',title:'조심스레 질문하기',summary:'직접 질문',perspective:'user_focus',input:'문 너머를 향해 누구인지 조심스럽게 묻는다.'},{id:'B',title:'조용히 기다리기',summary:'기다림',perspective:'npc_focus',input:'손을 내리고 문 너머에서 다시 소리가 들리는지 잠시 기다린다.'},{id:'C',title:'문 주변 살피기',summary:'주변 관찰',perspective:'offscreen_focus',input:'문을 열지 않고 손잡이와 문틈을 천천히 살핀다.'}]});},
  async sendChat(body){calls.send.push(body);chat.message.push({role:'user',data:body,chatId:'sent-'+calls.send.length});return true;}
 };
 state.click=()=>{const row=stores.chat.find(r=>r.id==='libra-input-writer-button');if(!row)throw new Error('writer not in chat menu');state.lastAction=Promise.resolve(row.callback());return true;};
 state.resolveShows=()=>{for(const p of state.pendingShows.splice(0))p.resolve(true);};
 window.__writerHost=state;window.risuai=api;
})();
