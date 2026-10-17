'use strict';
// Batch client for an OpenAI-compatible embeddings endpoint (OpenAI, Voyage, ...), used by
// the offline evaluators when RAG_EVAL_EMBED_URL is set. Results are cached per model in
// RAG_EVAL_EMBED_CACHE (a JSON file) so repeated runs do not call the provider again.
//   RAG_EVAL_EMBED_URL   base URL ending in /v1
//   RAG_EVAL_EMBED_KEY   bearer key
//   RAG_EVAL_EMBED_MODEL model name
// Node's built-in fetch ignores HTTPS_PROXY; run with NODE_USE_ENV_PROXY=1 behind a proxy.
const fs = require('node:fs');
const crypto = require('node:crypto');

const url = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
const model = String(process.env.RAG_EVAL_EMBED_MODEL || 'text-embedding-3-small');
const cachePath = process.env.RAG_EVAL_EMBED_CACHE || '';
const cache = cachePath && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
const keyOf = text => crypto.createHash('sha256').update(model + '\0' + text).digest('hex');

async function embedMany(texts) {
  const missing = [...new Set(texts.filter(text => !cache[keyOf(text)]))];
  for (let offset = 0; offset < missing.length; offset += 64) {
    const batch = missing.slice(offset, offset + 64);
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url + '/embeddings', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_EMBED_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }) });
      if (response.status === 429 && attempt < 5) { await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1))); continue; }
      if (!response.ok) throw new Error(`embedding request failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
      const body = await response.json();
      for (const row of body.data) cache[keyOf(batch[row.index])] = row.embedding;
      break;
    }
  }
  if (cachePath && missing.length) fs.writeFileSync(cachePath, JSON.stringify(cache));
  return texts.map(text => cache[keyOf(text)]);
}

module.exports = { enabled: Boolean(url), model, embedMany };
