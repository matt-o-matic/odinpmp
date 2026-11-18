import { readFileSync } from 'node:fs';

import Ajv2020Module from 'ajv/dist/2020.js';

import { readImageSize } from './image-size.js';
import {
  checkPackagePath,
  contentTypeForPath,
  dirname,
  fileExtension,
  PACKAGE_LIMITS,
  PROTOTYPE_ONLY_EXTENSIONS,
} from './package-files.js';
import { computeScreenRecords, screensSection, sha256Hex } from './package-hash.js';
import { packageLayout, screenScopeAllows } from './package-scope.js';
import { resolvePackageReference, scanPackageFile } from './package-url-scan.js';
import { readPackageZip } from './package-zip.js';

// Review package validation (package-spec.md sections 1-7). The order is the contract's:
// zip checks, schema, cross-references, static URL scan, Mermaid, malware scan. Nothing
// here performs I/O except through the injected scanner, Mermaid checker, and topic lookup.

export const MANIFEST_SCHEMA = JSON.parse(readFileSync(new URL('./review-package.schema.json', import.meta.url), 'utf8'));
export const MANIFEST_PATH = 'manifest.json';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
// Every Ajv strict check except strictRequired, which rejects the schema's valid pattern of
// listing `required` fields inside if/then branches whose properties sit on the parent.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validateManifestSchema = ajv.compile(MANIFEST_SCHEMA);
const KNOWN_TOP_LEVEL_FIELDS = new Set(Object.keys(MANIFEST_SCHEMA.properties));
const BUILT_IN_DIMENSIONS = new Set(MANIFEST_SCHEMA.properties.feedbackDimensions.items.oneOf[0].enum);

function pointerSegment(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function manifestProblem(code, path, message) {
  return { code, file: MANIFEST_PATH, message, path };
}

function fileProblem(code, file, message) {
  return { code, file, message, path: '' };
}

function quote(value) {
  return JSON.stringify(String(value));
}

// ---------------------------------------------------------------------------
// Schema errors
// ---------------------------------------------------------------------------

function describeSchemaError(error) {
  const { keyword, params } = error;
  switch (keyword) {
    case 'additionalProperties':
      return { message: `Unknown field ${quote(params.additionalProperty)}. Check the spelling against package-spec.md.`, path: `${error.instancePath}/${pointerSegment(params.additionalProperty)}` };
    case 'unevaluatedProperties':
      return { message: `Unknown field ${quote(params.unevaluatedProperty)}. Check the spelling against package-spec.md.`, path: `${error.instancePath}/${pointerSegment(params.unevaluatedProperty)}` };
    case 'required':
      return { message: `Missing required field ${quote(params.missingProperty)}.`, path: `${error.instancePath}/${pointerSegment(params.missingProperty)}` };
    case 'const':
      return { message: `Must be ${quote(params.allowedValue)}.` };
    case 'enum':
      return { message: `Must be one of: ${params.allowedValues.map((value) => quote(value)).join(', ')}.` };
    case 'type':
      return { message: `Must be ${params.type === 'integer' ? 'an integer' : params.type === 'object' || params.type === 'array' ? `an ${params.type}` : `a ${params.type}`}.` };
    case 'minLength':
      return { message: params.limit === 1 ? 'Must not be empty.' : `Must be at least ${params.limit} characters.` };
    case 'maxLength':
      return { message: `Must be at most ${params.limit} characters.` };
    case 'minItems':
      return { message: `Needs at least ${params.limit} item${params.limit === 1 ? '' : 's'}.` };
    case 'maxItems':
      return { message: `Allows at most ${params.limit} items.` };
    case 'minimum':
      return { message: `Must be at least ${params.limit}.` };
    case 'maximum':
      return { message: `Must be at most ${params.limit}.` };
    case 'uniqueItems':
      return { message: `Must not repeat items (items ${params.j} and ${params.i} are the same).` };
    case 'pattern': {
      if (error.schemaPath.includes('/$defs/id/')) return { message: 'Must be a lowercase id like "booking-home": letters, digits, and single hyphens, at most 64 characters.' };
      if (error.schemaPath.includes('/$defs/path/')) return { message: 'Must be a relative path inside the package using "/", with no ".." segment, leading "/", or drive letter.' };
      if (error.instancePath.endsWith('/url')) return { message: 'Must be an https: URL.' };
      if (error.instancePath.endsWith('/src')) {
        return { message: error.schema.includes('html') ? 'A prototype src must be an .html file.' : 'An image src must be a .png, .jpg, .jpeg, .webp, .gif, or .svg file.' };
      }
      return { message: `Must match the pattern ${error.schema}.` };
    }
    case 'false schema': {
      const field = error.instancePath.split('/').pop();
      return { message: `Field ${quote(field)} is not allowed here (for example, viewport and states are for prototypes; width and height are for images).` };
    }
    case 'contains':
      return { message: 'Needs at least one section of type "screens", "directions", "flows", or "questions".' };
    case 'oneOf':
      return { message: 'Must be a built-in feedback dimension key or an object with "id" and "label".' };
    default:
      return { message: error.message ? `${error.message[0].toUpperCase()}${error.message.slice(1)}.` : 'Fails the schema.' };
  }
}

function schemaProblems(errors = []) {
  const problems = [];
  const seen = new Set();
  // A failed `oneOf` reports each branch's error too; keep only the summary for that path.
  const oneOfPaths = new Set(errors.filter((error) => error.keyword === 'oneOf').map((error) => error.instancePath));
  for (const error of errors) {
    if (error.keyword === 'if') continue;
    if (error.keyword !== 'oneOf' && oneOfPaths.has(error.instancePath) && error.schemaPath.includes('/oneOf/')) continue;
    const described = describeSchemaError(error);
    const path = described.path ?? error.instancePath;
    const key = `${path}|${described.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(manifestProblem('manifest_invalid', path, described.message));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function checkEntries(entries, limits) {
  const errors = [];
  const files = new Map();
  const directories = [];
  const lowerCase = new Map();

  if (entries.length > limits.entries) {
    return { errors: [fileProblem('zip_limit', '', `The package has ${entries.length} entries; the limit is ${limits.entries}.`)], fatal: true, files };
  }

  for (const entry of entries) {
    const pathProblem = checkPackagePath(entry.path, { isDirectory: entry.isDirectory, limits });
    if (pathProblem) {
      errors.push(fileProblem(pathProblem.code, entry.path, pathProblem.message));
      continue;
    }
    if (entry.isSymlink) {
      errors.push(fileProblem('path_invalid', entry.path, `${entry.path} is a symbolic link. Packages contain only regular files.`));
      continue;
    }
    const normalized = entry.isDirectory ? entry.path.replace(/\/+$/, '') : entry.path;
    const folded = normalized.toLowerCase();
    const clash = lowerCase.get(folded);
    if (clash !== undefined && !(entry.isDirectory && clash.isDirectory)) {
      errors.push(fileProblem('path_invalid', entry.path, `${entry.path} collides with ${clash.path} when case is ignored.`));
      continue;
    }
    if (clash === undefined) lowerCase.set(folded, { isDirectory: entry.isDirectory, path: entry.path });

    if (entry.isDirectory) {
      directories.push(normalized);
      continue;
    }
    if (!contentTypeForPath(entry.path)) {
      const extension = fileExtension(entry.path);
      errors.push(fileProblem('type_not_allowed', entry.path, extension
        ? `${entry.path}: ".${extension}" files are not allowed in a review package.`
        : `${entry.path} has no file extension, so Odin cannot decide its type.`));
      continue;
    }
    files.set(entry.path, entry.bytes);
  }

  // A directory entry and a file at the same path, folded, is already a collision above.
  for (const directory of directories) {
    const prefix = `${directory}/`;
    const hasFiles = entries.some((entry) => !entry.isDirectory && entry.path.startsWith(prefix));
    if (!hasFiles) errors.push(fileProblem('path_invalid', `${directory}/`, `${directory}/ is an empty directory.`));
  }

  let total = 0;
  for (const bytes of files.values()) total += bytes.length;
  if (total > limits.totalUncompressedBytes) {
    errors.push(fileProblem('zip_limit', '', `The files total ${total} bytes; the limit is ${limits.totalUncompressedBytes}.`));
    return { errors, fatal: true, files };
  }
  return { errors, fatal: false, files };
}

function readManifest(entries, files, limits) {
  const rootEntry = entries.find((entry) => entry.path === MANIFEST_PATH && !entry.isDirectory);
  if (!rootEntry) {
    const nested = entries.find((entry) => !entry.isDirectory && entry.path.endsWith(`/${MANIFEST_PATH}`));
    return {
      error: fileProblem('manifest_missing', nested?.path ?? '', nested
        ? `manifest.json must sit at the root of the zip, not in ${dirname(nested.path)}/.`
        : 'The package has no manifest.json at its root.'),
    };
  }
  const bytes = files.get(MANIFEST_PATH) ?? rootEntry.bytes ?? Buffer.alloc(0);
  if (bytes.length > limits.manifestBytes) {
    return { error: manifestProblem('manifest_invalid', '', `manifest.json is ${bytes.length} bytes; the limit is ${limits.manifestBytes}.`) };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_error) {
    return { error: manifestProblem('manifest_invalid', '', 'manifest.json is not valid UTF-8.') };
  }
  let manifest;
  try {
    manifest = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    return { error: manifestProblem('manifest_invalid', '', `manifest.json is not valid JSON (${String(error.message).slice(0, 160)}).`) };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { error: manifestProblem('manifest_invalid', '', 'manifest.json must contain a JSON object.') };
  }
  return { manifest };
}

function sectionItems(manifest, type) {
  const index = manifest.sections.findIndex((section) => section.type === type);
  return index === -1 ? { index: -1, items: [] } : { index, items: manifest.sections[index].items ?? [] };
}

function duplicateIdProblems(list, basePath, kind) {
  const problems = [];
  const seen = new Map();
  list.forEach((item, position) => {
    const id = item?.id;
    if (typeof id !== 'string') return;
    if (seen.has(id)) {
      problems.push(manifestProblem('duplicate_id', `${basePath}/${position}/id`, `The ${kind} id ${quote(id)} is already used at ${basePath}/${seen.get(id)}.`));
    } else {
      seen.set(id, position);
    }
  });
  return problems;
}

async function crossReferenceProblems(manifest, files, options) {
  const errors = [];
  const warnings = [];

  if (options.track && manifest.track !== options.track) {
    errors.push(manifestProblem('track_mismatch', '/track', `Review packages are project-wide and use the ${quote(options.track)} track; this manifest says ${quote(manifest.track)}. Set "track": ${quote(options.track)}.`));
  }

  const typeSeen = new Map();
  manifest.sections.forEach((section, index) => {
    if (typeSeen.has(section.type)) {
      errors.push(manifestProblem('manifest_invalid', `/sections/${index}/type`, `Each section type may appear once; ${quote(section.type)} already appears at /sections/${typeSeen.get(section.type)}.`));
    } else {
      typeSeen.set(section.type, index);
    }
  });
  errors.push(...duplicateIdProblems(manifest.sections, '/sections', 'section'));

  const directions = sectionItems(manifest, 'directions');
  const screens = sectionItems(manifest, 'screens');
  const flows = sectionItems(manifest, 'flows');
  const questions = sectionItems(manifest, 'questions');
  errors.push(...duplicateIdProblems(directions.items, `/sections/${directions.index}/items`, 'direction'));
  errors.push(...duplicateIdProblems(screens.items, `/sections/${screens.index}/items`, 'screen'));
  errors.push(...duplicateIdProblems(flows.items, `/sections/${flows.index}/items`, 'flow'));
  errors.push(...duplicateIdProblems(questions.items, `/sections/${questions.index}/items`, 'question'));

  const dimensionIds = (manifest.feedbackDimensions ?? []).map((entry) => (typeof entry === 'string' ? { id: entry } : entry));
  errors.push(...duplicateIdProblems(dimensionIds, '/feedbackDimensions', 'feedback dimension').map((problem) => ({
    ...problem,
    path: problem.path.replace(/\/id$/, typeof manifest.feedbackDimensions[Number(problem.path.split('/')[2])] === 'string' ? '' : '/id'),
  })));

  const directionIds = new Set(directions.items.map((item) => item.id));
  const screenIds = new Set(screens.items.map((item) => item.id));

  directions.items.forEach((direction, position) => {
    (direction.screenIds ?? []).forEach((screenId, slot) => {
      if (!screenIds.has(screenId)) {
        errors.push(manifestProblem('reference_invalid', `/sections/${directions.index}/items/${position}/screenIds/${slot}`, `Screen ${quote(screenId)} is not in the screens section.`));
      }
    });
  });

  const prototypeDirectories = [];
  screens.items.forEach((screen, position) => {
    const base = `/sections/${screens.index}/items/${position}`;
    if (!files.has(screen.src)) {
      const caseMatch = [...files.keys()].find((path) => path.toLowerCase() === screen.src.toLowerCase());
      errors.push(manifestProblem('missing_file', `${base}/src`, caseMatch
        ? `${screen.src} is not in the package (paths are case-sensitive; found ${caseMatch}).`
        : `${screen.src} is not in the package.`));
    }
    if (screen.directionId && !directionIds.has(screen.directionId)) {
      errors.push(manifestProblem('reference_invalid', `${base}/directionId`, `Direction ${quote(screen.directionId)} is not in the directions section.`));
    }
    errors.push(...duplicateIdProblems((screen.states ?? []).map((state) => ({ id: state.key })), `${base}/states`, 'state key').map((problem) => ({
      ...problem,
      path: problem.path.replace(/\/id$/, '/key'),
    })));
    if (screen.kind === 'prototype') prototypeDirectories.push(dirname(screen.src));
    if (screen.kind === 'image' && files.has(screen.src)) {
      const size = readImageSize(files.get(screen.src), fileExtension(screen.src));
      if (size && (size.width !== screen.width || size.height !== screen.height)) {
        warnings.push(manifestProblem('size_mismatch', base, `${screen.src} is ${size.width}x${size.height} pixels; the manifest says ${screen.width}x${screen.height}.`));
      }
    }
  });

  for (const [path] of files) {
    if (!PROTOTYPE_ONLY_EXTENSIONS.has(fileExtension(path))) continue;
    const inside = prototypeDirectories.some((directory) => directory === '' || path.startsWith(`${directory}/`));
    if (!inside) {
      errors.push(fileProblem('type_not_allowed', path, `${path}: HTML and JavaScript files must sit inside a prototype screen's directory.`));
    }
  }

  const topicChecks = [];
  questions.items.forEach((question, position) => {
    const base = `/sections/${questions.index}/items/${position}`;
    errors.push(...duplicateIdProblems(question.options ?? [], `${base}/options`, 'option'));
    if (question.scale) {
      if (question.scale.min >= question.scale.max) {
        errors.push(manifestProblem('manifest_invalid', `${base}/scale`, 'Scale min must be less than max.'));
      } else if (question.scale.max - question.scale.min > 10) {
        errors.push(manifestProblem('manifest_invalid', `${base}/scale`, 'Scale range must be at most 10.'));
      }
    }
    if (question.topicId && options.lookupTopic) {
      topicChecks.push((async () => {
        const topic = await options.lookupTopic(question.topicId);
        if (!topic) {
          return manifestProblem('reference_invalid', `${base}/topicId`, `Topic ${quote(question.topicId)} does not exist in this project.`);
        }
        // Review is project-wide: a question may settle a topic on either track.
        return null;
      })());
    }
  });
  for (const problem of await Promise.all(topicChecks)) {
    if (problem) errors.push(problem);
  }

  if (manifest.basedOnRoundId && options.latestRoundId !== undefined && manifest.basedOnRoundId !== options.latestRoundId) {
    warnings.push(manifestProblem('stale_base_round', '/basedOnRoundId', options.latestRoundId
      ? `Round ${quote(manifest.basedOnRoundId)} is not the project's latest round (${quote(options.latestRoundId)}).`
      : `Round ${quote(manifest.basedOnRoundId)} is not a round in this project; it has no rounds yet.`));
  }

  return { errors, flows, warnings };
}

// A prototype loads only its own directory and shared files (package-scope.js); the review
// origin answers 404 for anything else. A static reference outside that scope would only
// break in review, so it rejects the package here. References from JavaScript are not seen,
// but fail the same way at runtime.
function scopeProblems(manifest, files) {
  const screens = screensSection(manifest)?.items ?? [];
  const prototypes = screens.filter((screen) => screen.kind === 'prototype');
  const layout = packageLayout(screens);
  const errors = [];
  for (const [path, bytes] of files) {
    const loadedBy = prototypes.filter((screen) => screenScopeAllows(screen, path, layout));
    if (loadedBy.length === 0) continue;
    const reported = new Set();
    for (const finding of scanPackageFile(path, bytes, { accept: () => true })) {
      const target = resolvePackageReference(path, finding.url);
      if (!target || !files.has(target) || reported.has(target)) continue;
      const blocked = loadedBy.find((screen) => !screenScopeAllows(screen, target, layout));
      if (!blocked) continue;
      reported.add(target);
      errors.push(fileProblem('reference_out_of_scope', path, `${path} line ${finding.line} references ${target}, which prototype ${quote(blocked.id)} cannot load. A prototype loads only files in its own directory and shared files outside every prototype directory, not image screen files or manifest.json.`));
    }
  }
  return errors;
}

function urlScanProblems(files) {
  const errors = [];
  for (const [path, bytes] of files) {
    for (const finding of scanPackageFile(path, bytes)) {
      errors.push(fileProblem('external_url', path, `${path} line ${finding.line} references ${finding.url.slice(0, 200)} (${finding.context}). Prototypes may use only files in the package or data: URLs.`));
    }
  }
  return errors;
}

async function mermaidProblems(flows, mermaid) {
  if (flows.items.length === 0) return [];
  let results;
  try {
    results = await mermaid.validate(flows.items.map((flow) => flow.mermaid));
  } catch (error) {
    return [manifestProblem('mermaid_invalid', `/sections/${flows.index}/items`, `Odin could not check the flows (${String(error?.message ?? error).slice(0, 200)}). Try the upload again.`)];
  }
  const problems = [];
  results.forEach((result, position) => {
    if (!result?.ok) {
      problems.push(manifestProblem('mermaid_invalid', `/sections/${flows.index}/items/${position}/mermaid`, `Flow ${quote(flows.items[position].id)} does not render: ${result?.error ?? 'Mermaid rejected it.'}`));
    }
  });
  return problems;
}

async function malwareProblems(files, scanner) {
  const problems = [];
  const queue = [...files.entries()];
  async function next() {
    while (queue.length > 0) {
      const [path, bytes] = queue.shift();
      try {
        const result = await scanner.scanBytes(bytes);
        if (!result?.clean) problems.push(fileProblem('scan_failed', path, `${path} was flagged by the malware scan.`));
      } catch (_error) {
        problems.push(fileProblem('scan_failed', path, `The malware scan could not run for ${path}. Try the upload again.`));
      }
    }
  }
  await Promise.all([next(), next(), next(), next()]);
  return problems.sort((left, right) => left.file.localeCompare(right.file));
}

/** Top-level fields the schema does not know are ignored (and reported as warnings). */
function stripUnknownTopLevel(manifest) {
  const warnings = [];
  const kept = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      kept[key] = value;
    } else {
      warnings.push(manifestProblem('unknown_field', `/${pointerSegment(key)}`, `Unknown field ${quote(key)} was ignored.`));
    }
  }
  return { manifest: kept, warnings };
}

function rejected(errors, warnings) {
  return { errors, status: 'rejected', warnings };
}

/**
 * Validates a package.
 *
 * input: `{ zip: Buffer }` or `{ entries: [{ path, isDirectory, isSymlink, bytes }] }`.
 * options:
 * - track: the upload target; omit to skip the track check (developer CLI).
 * - lookupTopic(topicId) -> `{ track }` or null; omit to skip topic resolution.
 * - latestRoundId: the track's latest round id, or null; omit to skip the stale check.
 * - mermaid: `{ validate(sources) }`; null skips Mermaid (tests only).
 * - scanner: `{ enabled, scanBytes }`; omitted or `enabled: false` skips the malware scan.
 *
 * Returns the spec's `{ status, errors, warnings }`. An accepted result also carries
 * `manifest` (unknown top-level fields removed), `files`, `screens`, `sizeBytes`, and
 * `fileCount`.
 */
export async function validateReviewPackage(input, options = {}) {
  const limits = { ...PACKAGE_LIMITS, ...(options.limits ?? {}) };
  const errors = [];
  const warnings = [];

  let entries = input.entries ?? null;
  let zipBytes = 0;
  if (input.zip !== undefined) {
    zipBytes = input.zip?.length ?? 0;
    const read = await readPackageZip(input.zip, { limits });
    errors.push(...read.errors);
    if (read.fatal) return rejected(errors, warnings);
    entries = read.entries;
  }

  const checked = checkEntries(entries ?? [], limits);
  errors.push(...checked.errors);
  if (checked.fatal) return rejected(errors, warnings);
  const { files } = checked;

  const read = readManifest(entries ?? [], files, limits);
  let manifest = null;
  let flows = { index: -1, items: [] };
  if (read.error) {
    errors.push(read.error);
  } else if (!validateManifestSchema(read.manifest)) {
    errors.push(...schemaProblems(validateManifestSchema.errors));
    warnings.push(...stripUnknownTopLevel(read.manifest).warnings);
  } else {
    const stripped = stripUnknownTopLevel(read.manifest);
    manifest = stripped.manifest;
    warnings.push(...stripped.warnings);
    const crossReferences = await crossReferenceProblems(manifest, files, options);
    errors.push(...crossReferences.errors);
    warnings.push(...crossReferences.warnings);
    flows = crossReferences.flows;
  }

  errors.push(...urlScanProblems(files));
  if (manifest) errors.push(...scopeProblems(manifest, files));

  if (manifest && options.mermaid !== null) {
    const mermaid = options.mermaid ?? (await import('./mermaid-validator.js')).getSharedMermaidValidator();
    errors.push(...await mermaidProblems(flows, mermaid));
  }

  if (errors.length === 0 && options.scanner && options.scanner.enabled !== false) {
    errors.push(...await malwareProblems(files, options.scanner));
  }

  if (errors.length > 0 || !manifest) return rejected(errors, warnings);

  const fileList = [...files.entries()].map(([path, bytes]) => ({
    bytes,
    contentType: contentTypeForPath(path),
    path,
    sha256: sha256Hex(bytes),
    size: bytes.length,
  }));
  return {
    errors: [],
    fileCount: fileList.length,
    files: fileList,
    manifest,
    screens: computeScreenRecords(manifest, files),
    sizeBytes: zipBytes || fileList.reduce((total, file) => total + file.size, 0),
    status: 'accepted',
    warnings,
  };
}
