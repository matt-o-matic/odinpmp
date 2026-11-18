// Builds the example review packages into output/review-packages/<name>.zip.
// Each zip gets its manifest from docs/requirements-gathering/examples/<name>.manifest.json
// and its files from tools/review-package/examples/<name>/ (excluding screens-src/, which
// holds the HTML used to render the example screenshots).
// Usage: node tools/review-package/build-examples.mjs
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(path.join(repo, 'backend/package.json'));
const JSZip = require('jszip');

const EXAMPLES = ['fieldwork-round-2', 'scheduling-options'];
const EXCLUDED_DIRS = new Set(['screens-src']);

async function addDir(zip, dir, prefix = '') {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!prefix && EXCLUDED_DIRS.has(entry.name)) continue;
      await addDir(zip, path.join(dir, entry.name), `${prefix}${entry.name}/`);
    } else {
      zip.file(`${prefix}${entry.name}`, await readFile(path.join(dir, entry.name)), { date: new Date('2026-10-07T00:00:00Z') });
    }
  }
}

export async function buildExample(name, outDir = path.join(repo, 'output/review-packages')) {
  const zip = new JSZip();
  const manifest = await readFile(path.join(repo, `docs/requirements-gathering/examples/${name}.manifest.json`));
  zip.file('manifest.json', manifest, { date: new Date('2026-10-07T00:00:00Z') });
  await addDir(zip, path.join(here, 'examples', name));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, `${name}.zip`);
  await writeFile(target, bytes);
  return { target, bytes: bytes.length, files: Object.keys(zip.files).filter((f) => !zip.files[f].dir) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const name of EXAMPLES) {
    const result = await buildExample(name);
    console.log(`${name}: ${result.files.length} files, ${result.bytes} bytes -> ${path.relative(repo, result.target)}`);
  }
}
