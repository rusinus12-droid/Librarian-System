'use strict';
// 실모델 실측: 세계 그래프가 왜 노드를 못 만드는지 — 출하 프롬프트를 실제 RP 턴에 넣어 확인한다.
//
// 배경(정적 분석으로 확정된 후보 원인):
//   A. 노드 생성 경로는 05k:200 하나이고 조건은 ① LLM 이 world.dimensionalShifts 를 내고
//      ② channel==='scene' 일 때. 그런데 추출 프롬프트의 "World patch fields may include:" 에
//      dimensionalShifts 가 없다(프롬프트 감사 실측: mentions_dimensionalShifts=false).
//   B. 프롬프트는 global/structure/state 를 요구하지만 정규화기는 5키만 처리(실측 dropped).
//   C. 규칙은 항상 현재 노드(=루트)에 누적된다 → 97턴 하네스에서 nodeCount=1.
//
// 이 스크립트는 실제 출하 프롬프트(12 의 EntityExtractionPrompt)를 그대로 쓰고,
// 실제 RP 턴 본문을 넣어 모델의 world 출력을 그대로 보고한다. 추측하지 않는다.
//
// 실행: OLLAMA_MODEL=<name> node tools/libra_world_graph_live_model_probe.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + '\n    globalThis.__probePrompt = EntityExtractionPrompt;\n' + code.slice(idx);

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this._id = ''; this.className = ''; this.style = {}; this.attributes = {};
    this.listeners = {}; this._innerHTML = ''; this.textContent = ''; this.dataset = {};
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._innerHTML = String(v || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id && this.ownerDocument) this.ownerDocument._register(el); return el; }
  remove() {} addEventListener(n, f) { this.listeners[n] = f; }
  removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)]; }
  querySelector() { return null; } querySelectorAll() { return []; }
}
class FakeDocument {
  constructor() { this._ids = Object.create(null); this.head = new FakeElement('head', this); this.body = new FakeElement('body', this); this.readyState = 'complete'; }
  _register(el) { if (el && el.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(t) { const e = new FakeElement('#text', this); e.textContent = t; return e; }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(sel) { if (sel === 'head') return this.head; if (sel === 'body') return this.body; return null; }
}

const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';

// 실제 RP 턴 — 차원 이동이 명시적으로 일어나는 장면(노드가 만들어져야 하는 상황)
const RP_TURNS = [
  {
    label: '차원 이동(명시적)',
    user: '나는 고대 유적의 제단에 손을 얹었다. 빛이 터지더니 눈앞이 바뀌었다.',
    ai: '정신을 차렸을 때 나는 다른 세계에 서 있었다. 하늘에는 두 개의 달이 떠 있고, 공중에 떠 있는 섬들 사이로 빛나는 다리가 이어져 있었다. "여기는 아르카디아," 옆에서 낯선 여성이 말했다. "네가 있던 세계와는 법칙이 달라."'
  },
  {
    label: '마법 규칙이 드러나는 장면',
    user: '주변을 살펴본다.',
    ai: '거리의 행인들이 손끝에서 불꽃을 피워 담배에 불을 붙였다. 이 세계에서는 마력이 일상적인 도구로 쓰이는 듯했다. 경비병이 나를 향해 창을 겨누며 외쳤다. "마력 등록증을 제시하라!"'
  },
  {
    label: '평범한 일상 장면',
    user: '카페에 앉아 커피를 주문했다.',
    ai: '점원이 미소를 지으며 아메리카노를 내려주었다. 창밖으로는 비가 내리고 있었다. 나는 노트북을 열고 오늘 있었던 일을 정리하기 시작했다.'
  }
];

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [], globalLore: [] };
  const chat = { id: 'chat-1', localLore: [], message: [], bindedPersona: 'p1' };
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); },
      async keys() { return Array.from(store.keys()); }
    },
    async getLocalPluginStorage() { return { async getItem() { return null; }, async setItem() {}, async removeItem() {} }; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getCharacter() { return character; },
    async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai, risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() }
  };
  context.globalThis = context; context.window = context;
  vm.createContext(context);
  let runError = '';
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 400); }
  await new Promise(r => setTimeout(r, 100));

  const systemPrompt = String(context.__probePrompt || '');
  const out = { model: MODEL, run_error: runError || null, prompt_chars: systemPrompt.length, turns: [] };
  if (!systemPrompt) { console.log(JSON.stringify({ ok: false, reason: 'no prompt' }, null, 2)); process.exit(1); }

  // 실제 출하 user payload 형식 (buildEntityExtractionUserPayload 와 동형)
  const buildUserPayload = (t) => [
    '[Output Contract]',
    'Return one sparse JSON object: {"spans":[],"entities":[],"relations":[],"world":{},"conflicts":[],"uncertain":[],"rejected":[]}',
    'Omit empty nested fields. Missing field = no update.',
    '',
    '[Assistant Evidence]',
    t.ai,
    '',
    '[User Input]',
    t.user
  ].join('\n');

  for (const t of RP_TURNS) {
    const body = {
      model: MODEL,
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 6000 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPayload(t) }
      ]
    };
    let result = { label: t.label };
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240000)
      });
      const data = await res.json();
      const content = String(data?.message?.content || '');
      result.raw_chars = content.length;
      result.done_reason = data?.done_reason || null;
      let parsed = null;
      try { parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim()); } catch { /* 아래에서 구조만 본다 */ }
      if (parsed) {
        result.world_keys = parsed.world && typeof parsed.world === 'object' ? Object.keys(parsed.world).sort() : null;
        result.world = parsed.world || null;
        result.has_dimensional_shifts = !!(parsed.world && (parsed.world.dimensionalShifts || parsed.world.dimensional_shifts));
        result.entity_count = Array.isArray(parsed.entities) ? parsed.entities.length : 0;
        result.entities = (parsed.entities || []).slice(0, 5).map(e => e?.name || e?.canonicalName || '?');
      } else {
        result.parse_failed = true;
        result.head = content.slice(0, 400);
        // 파싱이 실패해도 **원문에서** dimensionalShifts 를 찾는다.
        // (JSON 이 잘려도 필드는 나왔을 수 있다 — 실측: 첫 턴이 physics 에서 끊겼다.)
        const m = content.match(/"dimensionalShifts"\s*:\s*(\[[\s\S]{0,400}?\]|null)/);
        result.has_dimensional_shifts_raw = !!m;
        result.shift_raw = m ? m[1].slice(0, 300) : null;
        // world 안의 키 이름만이라도 뽑는다
        const wk = content.match(/"world"\s*:\s*\{([\s\S]{0,600})/);
        result.world_keys_raw = wk ? [...wk[1].matchAll(/"([a-zA-Z_]+)"\s*:/g)].map(x => x[1]).slice(0, 12) : null;
      }
      result.content_tail = content.slice(-160);
    } catch (e) {
      result.error = String(e?.message || e).slice(0, 200);
    }
    out.turns.push(result);
    console.error(`[${t.label}] 완료`);
  }

  // 집계: 프롬프트가 요구하지 않는 필드를 모델이 낼 확률
  out.summary = {
    turns_with_world: out.turns.filter(t => t.world_keys && t.world_keys.length).length,
    turns_with_dimensionalShifts: out.turns.filter(t => t.has_dimensional_shifts).length,
    world_keys_seen: Array.from(new Set(out.turns.flatMap(t => t.world_keys || []))).sort()
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
