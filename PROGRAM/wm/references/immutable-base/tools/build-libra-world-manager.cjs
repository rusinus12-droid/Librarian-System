const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const main = async () => {
  const root = path.resolve(__dirname, '..');
  const manifestPath = path.join(root, 'src', 'build-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const outputPath = path.join(root, manifest.output);
  const minifiedOutputPath = path.join(root, manifest.minifiedOutput || manifest.output.replace(/\.js$/i, '.min.js'));
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const cleanOutput of manifest.cleanOutputs || []) {
    const cleanPath = path.join(root, cleanOutput);
    if (cleanPath !== outputPath && cleanPath !== minifiedOutputPath && fs.existsSync(cleanPath)) {
      fs.unlinkSync(cleanPath);
    }
  }

  const chunks = [];
  const partStats = [];
  const seenParts = new Set();
  for (const part of manifest.parts || []) {
    if (!part?.file || seenParts.has(part.file)) {
      throw new Error(`Invalid or duplicate source part: ${part?.file || '(empty)'}`);
    }
    seenParts.add(part.file);
    const partPath = path.join(root, 'src', part.file);
    if (!fs.existsSync(partPath)) {
      throw new Error(`Missing source part: ${path.relative(root, partPath)}`);
    }
    const source = fs.readFileSync(partPath, 'utf8');
    chunks.push(source);
    partStats.push({
      file: part.file,
      bytes: Buffer.byteLength(source, 'utf8'),
      lines: source.length ? source.split(/\r?\n/).length : 0
    });
  }

  if (!chunks.length) throw new Error('Build manifest contains no source parts');

  const bundle = await require('./build-libra-runtime-factory.cjs')();
  if (!/^\/\/@name\s+/m.test(chunks[0]) || !/\}\)\(\);\s*$/.test(bundle)) {
    throw new Error('Bundle shell integrity check failed: plugin metadata or closing IIFE is missing');
  }
  fs.writeFileSync(outputPath, bundle, 'utf8');

  let minifiedCode = '';
  let usedTerser = false;
  try {
    const { minify } = require('terser');
    const minified = await minify(bundle, {
      compress: {
        passes: 2,
        negate_iife: false
      },
      mangle: false,
      format: {
        comments: /@(?:name|display-name|description|version|author|api|update-url|arg)\b|^!/
      }
    });
    if (!minified.code) throw new Error('Terser produced an empty minified bundle');
    minifiedCode = minified.code;
    usedTerser = true;
  } catch (error) {
    // A silent unminified fallback shipped a 4.9MB "minified" deployment bundle for an
    // unknown period: the output was byte-identical to the readable build, so nothing
    // looked wrong.  Fail loudly instead, and let an explicit opt-out keep the old path
    // for environments that genuinely cannot install devDependencies.
    const allowFallback = String(process.env.LIBRA_ALLOW_UNMINIFIED_FALLBACK || '').trim() === '1';
    if (!allowFallback) {
      console.error(`[build] Terser unavailable or failed (${error?.message || error}).`);
      console.error('[build] Refusing to write an unminified bundle to the deployment output.');
      console.error('[build] Run `npm install` to install devDependencies, or set');
      console.error('[build] LIBRA_ALLOW_UNMINIFIED_FALLBACK=1 to accept the larger artifact.');
      throw new Error('minification_required_but_unavailable');
    }
    console.warn(`[build] Terser unavailable or failed (${error?.message || error}); writing unminified fallback to minified output (explicitly allowed).`);
    minifiedCode = bundle;
  }
  fs.writeFileSync(minifiedOutputPath, minifiedCode + '\n', 'utf8');

  for (const target of [outputPath, minifiedOutputPath]) {
    const check = spawnSync(process.execPath, ['--check', target], {
      cwd: root,
      encoding: 'utf8'
    });
    if (check.status !== 0) {
      process.stderr.write(check.stdout || '');
      process.stderr.write(check.stderr || '');
      process.exit(check.status || 1);
    }
  }

  const hash = crypto.createHash('sha256').update(bundle).digest('hex');
  const size = Buffer.byteLength(bundle, 'utf8');
  const minifiedBundle = fs.readFileSync(minifiedOutputPath);
  const minifiedHash = crypto.createHash('sha256').update(minifiedBundle).digest('hex');
  const minifiedSize = minifiedBundle.length;
  const savedBytes = usedTerser ? Math.max(0, size - minifiedSize) : 0;
  const savedPercent = size > 0 ? ((savedBytes / size) * 100).toFixed(2) : '0.00';

  console.log(`Built ${path.relative(root, outputPath)}`);
  console.log(`Built ${path.relative(root, minifiedOutputPath)}`);
  console.log(`Parts: ${chunks.length}`);
  console.log(`Source lines: ${partStats.reduce((sum, item) => sum + item.lines, 0)}`);
  console.log(`Size: ${size} bytes`);
  console.log(`${usedTerser ? 'Minified' : 'Fallback'} size: ${minifiedSize} bytes`);
  console.log(`Saved: ${savedBytes} bytes (${savedPercent}%)${usedTerser ? '' : ' [minifier unavailable]'}`);
  console.log(`SHA256: ${hash}`);
  console.log(`Minified SHA256: ${minifiedHash}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
