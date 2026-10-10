module.exports = function createLibraRecallTokenizer() {
  const normalizeLexicalText = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const partsFor = value => {
      const body = normalizeLexicalText(value);
      const words = body.match(/[\p{L}\p{N}_-]{2,}/gu) || [];
      const pureCjkRun = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;
      const lexicalWords = words.filter(word => !pureCjkRun.test(word)).slice(0, 960);
      const hangulGrams = [];
      const hangulRuns = body.match(/[가-힣]+/gu) || [];
      for (const run of hangulRuns) {
        const chars = Array.from(run);
        if (chars.length === 1) hangulGrams.push(chars[0]);
        else for (let index = 0; index + 1 < chars.length && hangulGrams.length < 640; index += 1) hangulGrams.push(chars[index] + chars[index + 1]);
        if (hangulGrams.length >= 640) break;
      }
      const cjkGrams = [];
      const cjkRuns = body.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || [];
      for (const run of cjkRuns) {
        const chars = Array.from(run);
        if (chars.length === 1) cjkGrams.push(chars[0]);
        else for (let index = 0; index + 1 < chars.length && cjkGrams.length < 640; index += 1) cjkGrams.push(chars[index] + chars[index + 1]);
        if (cjkGrams.length >= 640) break;
      }
      return { lexicalWords, hangulRuns, hangulGrams, cjkGrams };
    };
  const legacy = value => {
      const { lexicalWords, hangulGrams, cjkGrams } = partsFor(value);
      const gramBudget = Math.max(0, 1600 - lexicalWords.length);
      const grams = [];
      let hangulIndex = 0;
      let cjkIndex = 0;
      while (grams.length < gramBudget && (hangulIndex < hangulGrams.length || cjkIndex < cjkGrams.length)) {
        if (hangulIndex < hangulGrams.length && grams.length < gramBudget) grams.push(hangulGrams[hangulIndex++]);
        if (cjkIndex < cjkGrams.length && grams.length < gramBudget) grams.push(cjkGrams[cjkIndex++]);
      }
      return [...lexicalWords, ...grams].slice(0, 1600);
    };
  const koreanParticle = /(?:으로|에서|에게|한테|께서|까지|부터|처럼|보다|하고|이랑|랑|들과|들은|들이|들을|들의|들|은|는|이|가|을|를|에|께|로|와|과|도|만|의)$/u;
  legacy.bm25Tokens = value => {
    const { lexicalWords, hangulRuns, hangulGrams, cjkGrams } = partsFor(value);
    const surface = [...lexicalWords, ...hangulRuns.filter(run => run.length === 1)];
    const particles = lexicalWords.filter(word => /[가-힣]/u.test(word))
      .map(word => word.replace(koreanParticle, ''))
      .filter(word => word.length >= 1);
    const words = Array.from(new Set([...surface, ...particles])).slice(0, 960);
    const tokens = words.map(word => `w:${word}`);
    let hangulIndex = 0;
    let cjkIndex = 0;
    while (tokens.length < 1600 && (hangulIndex < hangulGrams.length || cjkIndex < cjkGrams.length)) {
      if (hangulIndex < hangulGrams.length && tokens.length < 1600) tokens.push(`g:${hangulGrams[hangulIndex++]}`);
      if (cjkIndex < cjkGrams.length && tokens.length < 1600) tokens.push(`c:${cjkGrams[cjkIndex++]}`);
    }
    return tokens;
  };
  return legacy;
};
