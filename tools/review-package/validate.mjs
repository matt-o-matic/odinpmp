// Validates a review package the way Odin does at upload, minus the topic lookup and the
// malware scan, which need a project. Accepts a zip or an unzipped package directory.
//
// Usage: node validate.mjs <package.zip | package-dir> [--track experience|architecture] [--json]
//
// Exit code 0 when the package would be accepted, 1 when it has errors, 2 for usage errors.
// Without --track, the manifest's own track is used and track_mismatch is not checked.
//
// Runs in two places. In the Odin repo (tools/review-package/) it uses the backend's
// validator, Mermaid check included. In the package kit downloaded from Odin it uses the
// validator copied into ./validator/ (run `npm install` first) and skips Mermaid, which
// Odin still checks at upload.
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kitValidator = path.join(here, 'validator/package-validator.js');
const inKit = existsSync(kitValidator);
const validatorPath = inKit
  ? kitValidator
  : path.join(here, '../../backend/src/modules/requirements/packages/package-validator.js');
const { validateReviewPackage } = await import(pathToFileURL(validatorPath).href);

const TRACKS = ['experience', 'architecture'];

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node validate.mjs <package.zip | package-dir> [--track experience|architecture] [--json]');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { json: false, target: '', track: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--track') {
      options.track = argv[index + 1];
      index += 1;
      if (!TRACKS.includes(options.track)) usage(`--track must be one of: ${TRACKS.join(', ')}.`);
    } else if (arg === '--help' || arg === '-h') usage();
    else if (arg.startsWith('--')) usage(`Unknown option ${arg}.`);
    else if (!options.target) options.target = arg;
    else usage('Give one package at a time.');
  }
  if (!options.target) usage();
  return options;
}

async function directoryEntries(root) {
  const entries = [];
  async function walk(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    if (prefix && children.length === 0) entries.push({ bytes: null, isDirectory: true, isSymlink: false, path: `${prefix}/` });
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) entries.push({ bytes: null, isDirectory: false, isSymlink: true, path: relative });
      else if (info.isDirectory()) await walk(absolute, relative);
      else entries.push({ bytes: await readFile(absolute), isDirectory: false, isSymlink: false, path: relative });
    }
  }
  await walk(root, '');
  return entries;
}

function printProblems(label, problems) {
  for (const problem of problems) {
    const where = [problem.file, problem.path].filter(Boolean).join(' ');
    console.log(`${label} ${problem.code}${where ? ` [${where}]` : ''}: ${problem.message}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const target = path.resolve(options.target);
let info;
try {
  info = await lstat(target);
} catch (_error) {
  usage(`${options.target} does not exist.`);
}

const input = info.isDirectory() ? { entries: await directoryEntries(target) } : { zip: await readFile(target) };
const result = await validateReviewPackage(input, { mermaid: inKit ? null : undefined, track: options.track });
const hasFlows = Boolean(result.manifest?.sections?.some((section) => section.type === 'flows'));

if (options.json) {
  console.log(JSON.stringify({ errors: result.errors, mermaidChecked: !inKit, status: result.status, warnings: result.warnings }, null, 2));
} else {
  printProblems('error', result.errors);
  printProblems('warning', result.warnings);
  if (result.status === 'accepted') {
    console.log(`Valid: ${result.manifest.track} package "${result.manifest.title}", ${result.fileCount} files, ${result.screens.length} screens, ${result.warnings.length} warnings.`);
    if (inKit && hasFlows) console.log('Mermaid flows were not checked here; Odin checks them at upload.');
  } else {
    console.log(`Rejected: ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}, ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}.`);
  }
}
process.exit(result.status === 'accepted' ? 0 : 1);
