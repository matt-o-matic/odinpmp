import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

// The review package kit: everything a developer's coding agent needs to build a package
// outside the Odin repo. The agent guide, spec, schema, examples, and validate.mjs, plus
// the upload validator's own source files so validate.mjs runs after `npm install`. Built
// from the repo's files on first request, so it never drifts from what Odin enforces.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const docs = path.join(repo, 'docs/requirements-gathering');
const tools = path.join(repo, 'tools/review-package');

// package-validator.js and the modules it imports. mermaid-validator.js stays out: it needs
// a browser engine, and the kit's validate.mjs skips Mermaid (Odin checks it at upload).
export const KIT_VALIDATOR_FILES = Object.freeze([
  'image-size.js',
  'package-files.js',
  'package-hash.js',
  'package-scope.js',
  'package-url-scan.js',
  'package-validator.js',
  'package-zip.js',
  'review-package.schema.json',
]);
const KIT_DEPENDENCIES = Object.freeze(['ajv', 'htmlparser2', 'jszip']);
// Review rounds are for screens and prototypes, so the kit carries the screen example only.
const EXAMPLES = Object.freeze(['fieldwork-round-2']);
// Screenshot sources for the example images; not part of a package.
const EXCLUDED_EXAMPLE_DIRS = new Set(['screens-src']);
const FIXED_DATE = new Date('2026-10-08T00:00:00Z');

export const PACKAGE_KIT_FILENAME = 'odin-review-package-kit.zip';

async function addDirectory(zip, directory, prefix) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (prefix.split('/').length === 3 && EXCLUDED_EXAMPLE_DIRS.has(entry.name)) continue;
      await addDirectory(zip, absolute, `${prefix}${entry.name}/`);
    } else {
      zip.file(`${prefix}${entry.name}`, await readFile(absolute), { date: FIXED_DATE });
    }
  }
}

async function kitPackageJson() {
  const backend = JSON.parse(await readFile(path.join(repo, 'backend/package.json'), 'utf8'));
  const dependencies = Object.fromEntries(KIT_DEPENDENCIES.map((name) => [name, backend.dependencies[name]]));
  return `${JSON.stringify({
    dependencies,
    description: 'Builds and checks Odin review packages. See README.md.',
    name: 'odin-review-package-kit',
    private: true,
    scripts: { validate: 'node validate.mjs' },
    type: 'module',
  }, null, 2)}\n`;
}

export async function buildPackageKit() {
  const zip = new JSZip();
  const add = async (name, source) => zip.file(name, await readFile(source), { date: FIXED_DATE });

  await add('README.md', path.join(docs, 'agent-guide.md'));
  await add('package-spec.md', path.join(docs, 'package-spec.md'));
  await add('review-package.schema.json', path.join(docs, 'review-package.schema.json'));
  await add('validate.mjs', path.join(tools, 'validate.mjs'));
  zip.file('package.json', await kitPackageJson(), { date: FIXED_DATE });
  for (const name of KIT_VALIDATOR_FILES) await add(`validator/${name}`, path.join(here, name));
  for (const name of EXAMPLES) {
    await add(`examples/${name}/manifest.json`, path.join(docs, `examples/${name}.manifest.json`));
    await addDirectory(zip, path.join(tools, 'examples', name), `examples/${name}/`);
  }
  return zip.generateAsync({ compression: 'DEFLATE', type: 'nodebuffer' });
}

let cached = null;

/** The kit zip, built once per process. */
export function getPackageKit() {
  if (!cached) {
    cached = buildPackageKit().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}
