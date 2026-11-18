// Review packages in the team workspace: the upload checks done before sending, the
// validation problems the API returns (package-spec.md section 7) in plain words, and the
// list, header, checklist, and "what changed" presentation for the Review stage.

import { plural } from './requirements-tracks.js';

/** Default zip limit (package-spec.md section 1). A deployment can raise it on the server. */
export const PACKAGE_MAX_BYTES = 50 * 1024 * 1024;

const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'multipart/x-zip']);

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

/**
 * Checks a chosen file before it is sent. Returns `{ ok: true }` or `{ ok: false, message }`.
 * The server checks everything again; this only saves a slow upload that would fail.
 */
export function checkPackageFile(file, { maxBytes = PACKAGE_MAX_BYTES } = {}) {
  if (!file) return { message: 'Choose a package zip to upload.', ok: false };
  const name = String(file.name ?? '');
  const type = String(file.type ?? '').toLowerCase();
  const looksLikeZip = /\.zip$/i.test(name) || (type && ZIP_TYPES.has(type) && type !== 'application/octet-stream');
  if (!looksLikeZip) {
    return { message: `${name || 'That file'} is not a zip. A review package is one .zip file with manifest.json at the top level.`, ok: false };
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return { message: `${name || 'The zip'} is empty.`, ok: false };
  if (size > maxBytes) {
    return { message: `${name || 'The zip'} is ${formatBytes(size)}. Packages can be up to ${formatBytes(maxBytes)}.`, ok: false };
  }
  return { ok: true };
}

/** Upload progress as a whole percentage, or null when the total is unknown. */
export function uploadPercent(loaded, total) {
  const done = Number(loaded);
  const all = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(all) || all <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / all) * 100)));
}

// ---------------------------------------------------------------------------
// Validation problems
// ---------------------------------------------------------------------------

const PROBLEM_CODES = Object.freeze({
  // Errors
  duplicate_id: 'The same id is used twice where ids must be unique.',
  external_url: 'A prototype file links to an outside web address. Prototypes can only use files inside the package.',
  manifest_invalid: 'manifest.json is not valid JSON, is larger than 512 KB, or breaks a manifest rule.',
  manifest_missing: 'There is no manifest.json at the top level of the zip.',
  mermaid_invalid: 'A flow diagram does not render, or Odin could not check it.',
  missing_file: 'The manifest names a file that is not in the zip. Paths are case-sensitive.',
  path_invalid: 'A file path is not allowed: it leaves the package, is absolute or reserved, is a link or an empty folder, or repeats another path.',
  reference_invalid: 'A direction, screen, or topic it points to does not exist, or the topic belongs to the other track.',
  reference_out_of_scope: 'A prototype file points to a file that prototype cannot load: another prototype’s folder, an image screen’s file, or manifest.json.',
  scan_failed: 'The malware scan flagged a file or could not run.',
  track_mismatch: 'The manifest names a different track from the one you are uploading to.',
  type_not_allowed: 'This kind of file is not allowed, or an HTML or JavaScript file sits outside a prototype’s folder.',
  zip_invalid: 'The file is not a readable zip, is empty, or has a damaged entry.',
  zip_limit: 'The zip is over a size, file-count, path-length, or compression limit.',
  // Warnings
  size_mismatch: 'The image’s width or height in the manifest differs from the file.',
  stale_base_round: 'The package says it answers a round that is not the track’s latest one.',
  unknown_field: 'Odin does not use this top-level field, so it was ignored.',
});

export function problemCodeMeaning(code) {
  return PROBLEM_CODES[String(code ?? '')] ?? 'Odin could not accept this part of the package.';
}

/** Where a problem is: the file, plus the JSON Pointer into the manifest when there is one. */
export function problemLocation({ file = '', path = '' } = {}) {
  const fileName = String(file ?? '').trim();
  const pointer = String(path ?? '').trim();
  if (!fileName && !pointer) return { file: '', path: '', text: 'The zip as a whole' };
  return { file: fileName, path: pointer, text: [fileName || 'The zip', pointer].filter(Boolean).join(' at ') };
}

export function describePackageProblem(problem = {}) {
  const code = String(problem?.code ?? '').trim();
  return {
    code,
    location: problemLocation(problem ?? {}),
    meaning: problemCodeMeaning(code),
    message: String(problem?.message ?? '').trim(),
  };
}

function problems(value) {
  return Array.isArray(value) ? value.map(describePackageProblem) : [];
}

/**
 * A rejected upload (422) in display form. Also used for the size check's own rejection.
 * `summary` leads with the count so people know how much there is to fix.
 */
export function describeUploadRejection(data = {}, { fileName = '' } = {}) {
  const errors = problems(data?.errors);
  const warnings = problems(data?.warnings);
  const subject = fileName ? `${fileName} was not uploaded` : 'The package was not uploaded';
  const count = errors.length === 0 ? 'Odin rejected it' : `Odin found ${plural(errors.length, 'problem')}`;
  return {
    errors,
    summary: `${subject}. ${count}, and nothing was stored. Fix ${errors.length === 1 ? 'it' : 'them'} and upload the zip again.`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Package list and header
// ---------------------------------------------------------------------------

const STATUS_CHIPS = Object.freeze({
  draft: { label: 'Draft', tone: 'exp' },
  published: { label: 'Published', tone: 'ok' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
});

export function packageStatusChip(status) {
  return STATUS_CHIPS[status] ?? { label: String(status || 'Unknown'), tone: 'neutral' };
}

export function packageSourceText(source) {
  return source === 'mcp' ? 'uploaded through MCP' : 'uploaded in Odin';
}

export function packageUploaderName(pkg) {
  const name = String(pkg?.uploader?.name ?? '').trim();
  return name || 'a team member';
}

export function packageWarningText(count) {
  const value = Number(count) || 0;
  return value > 0 ? plural(value, 'warning') : '';
}

/** "Dana Cho · uploaded through MCP · 4.2 MB · 38 files" (date shown separately). */
export function packageMetaLine(pkg) {
  const parts = [`${packageUploaderName(pkg)} · ${packageSourceText(pkg?.source)}`];
  const size = formatBytes(pkg?.sizeBytes);
  if (size) parts.push(size);
  if (Number(pkg?.fileCount) > 0) parts.push(plural(pkg.fileCount, 'file'));
  return parts.join(' · ');
}

const STATUS_ORDER = { draft: 0, published: 1, withdrawn: 2 };

/** Drafts first (they need someone to look at them), then published, then withdrawn; newest version first within each. */
export function sortPackages(packages = []) {
  return [...(Array.isArray(packages) ? packages : [])].sort((left, right) => {
    const status = (STATUS_ORDER[left?.status] ?? 3) - (STATUS_ORDER[right?.status] ?? 3);
    if (status !== 0) return status;
    return (Number(right?.version) || 0) - (Number(left?.version) || 0);
  });
}

// ---------------------------------------------------------------------------
// Manifest presentation
// ---------------------------------------------------------------------------

export const SECTION_LABELS = Object.freeze({
  boundaries: 'What this round does not cover',
  context: 'Context',
  directions: 'Directions',
  flows: 'Flows',
  questions: 'Questions',
  references: 'References',
  screens: 'Screens',
});

/** The manifest's sections in their own order, each with a heading. Unknown types are dropped. */
export function manifestSections(manifest) {
  const sections = Array.isArray(manifest?.sections) ? manifest.sections : [];
  return sections
    .filter((section) => section && SECTION_LABELS[section.type])
    .map((section, index) => ({
      ...section,
      anchor: `rq-pkg-${section.type}`,
      heading: String(section.title ?? '').trim() || SECTION_LABELS[section.type],
      index,
      items: Array.isArray(section.items) ? section.items : [],
    }));
}

export function sectionOfType(manifest, type) {
  return manifestSections(manifest).find((section) => section.type === type) ?? null;
}

const QUESTION_KINDS = Object.freeze({
  multi: 'Choose any',
  scale: 'Scale',
  single: 'Choose one',
  text: 'Written answer',
});

export function questionKindLabel(question) {
  const label = QUESTION_KINDS[question?.kind] ?? 'Question';
  if (question?.kind === 'scale' && question.scale) {
    const { max, min } = question.scale;
    if (Number.isFinite(Number(min)) && Number.isFinite(Number(max))) return `${label} ${min} to ${max}`;
  }
  return label;
}

const BUILT_IN_DIMENSIONS = Object.freeze({
  behavior: 'Behavior',
  branding: 'Branding',
  color: 'Color',
  cost: 'Cost',
  density: 'Density & spacing',
  feasibility: 'Feasibility',
  hierarchy: 'Hierarchy & navigation',
  operability: 'Operability',
  risk: 'Risk',
  security: 'Security',
  type: 'Type & size',
});

const DEFAULT_DIMENSIONS = Object.freeze({
  architecture: ['feasibility', 'risk', 'cost', 'operability', 'security'],
  experience: ['type', 'density', 'hierarchy', 'color', 'branding', 'behavior'],
});

/** Labels of the aspects reviewers rate, from the manifest or the track's defaults. */
export function feedbackDimensionLabels(manifest, track) {
  const entries = Array.isArray(manifest?.feedbackDimensions) && manifest.feedbackDimensions.length > 0
    ? manifest.feedbackDimensions
    : DEFAULT_DIMENSIONS[track] ?? [];
  return entries
    .map((entry) => (typeof entry === 'string' ? BUILT_IN_DIMENSIONS[entry] ?? entry : String(entry?.label ?? '').trim()))
    .filter(Boolean);
}

/**
 * The validation checklist for an accepted package (design-v1 team-upload): what passed,
 * then each stored warning. An accepted package passed every error check.
 */
export function packageChecklist(detail) {
  const manifest = detail?.manifest ?? {};
  const items = [];
  items.push({ code: 'manifest', text: `Manifest ${manifest.schema || 'odin.review-package/v1'}, track ${detail?.track === 'architecture' ? 'Functional' : 'Experience'}`, tone: 'ok' });

  const screens = sectionOfType(manifest, 'screens')?.items ?? [];
  const directions = sectionOfType(manifest, 'directions')?.items ?? [];
  const flows = sectionOfType(manifest, 'flows')?.items ?? [];
  const questions = sectionOfType(manifest, 'questions')?.items ?? [];
  const content = [];
  if (screens.length) {
    const images = screens.filter((screen) => screen.kind === 'image').length;
    const prototypes = screens.length - images;
    const kinds = [images ? plural(images, 'image') : '', prototypes ? plural(prototypes, 'prototype') : ''].filter(Boolean).join(', ');
    content.push(`${plural(screens.length, 'screen')}${kinds ? ` (${kinds})` : ''}`);
  }
  if (directions.length) content.push(plural(directions.length, 'direction'));
  if (flows.length) content.push(plural(flows.length, 'flow'));
  if (content.length) items.push({ code: 'content', text: content.join(' · '), tone: 'ok' });

  if (questions.length) {
    const linked = questions.filter((question) => question.topicId).length;
    const created = questions.length - linked;
    const parts = [];
    if (linked) parts.push(`${linked} linked to ${linked === 1 ? 'a topic' : 'topics'}`);
    if (created) parts.push(`${created} will create ${created === 1 ? 'a new topic' : 'new topics'}`);
    items.push({ code: 'questions', text: `${plural(questions.length, 'question')}: ${parts.join(', ')}`, tone: 'ok' });
  }

  items.push({ code: 'files', text: 'Every file passed the checks · no outside web addresses', tone: 'ok' });

  for (const warning of problems(detail?.warnings)) {
    items.push({ code: warning.code, location: warning.location, meaning: warning.meaning, text: warning.message || warning.meaning, tone: 'warn' });
  }
  return items;
}

// ---------------------------------------------------------------------------
// What changed since the previous version
// ---------------------------------------------------------------------------

const CHANGE_META = Object.freeze({
  changed: {
    chip: { label: 'changed', tone: 'warn' },
    detail: 'Changed. When this version is published, open annotations on it become Outdated; their authors can carry them forward.',
    order: 0,
  },
  new: { chip: { label: 'new', tone: 'exp' }, detail: 'New screen.', order: 1 },
  removed: {
    chip: { label: 'removed', tone: 'neutral' },
    detail: 'Removed. When this version is published, its open annotations become Superseded.',
    order: 2,
  },
  unchanged: {
    chip: { label: 'carried', tone: 'ok' },
    detail: 'Identical. Open annotations carry forward when this version is published.',
    order: 3,
  },
});

export function screenChangeChip(change) {
  return CHANGE_META[change]?.chip ?? null;
}

/**
 * The "What changed since round N" list. Leads with what needs attention: changed, new,
 * removed, then carried screens, each group in the package's own order.
 */
export function describePackageChanges(changes) {
  const baseline = changes?.baseline ?? null;
  const rows = (Array.isArray(changes?.screens) ? changes.screens : [])
    .filter((screen) => screen && CHANGE_META[screen.change])
    .map((screen, position) => ({
      change: screen.change,
      chip: CHANGE_META[screen.change].chip,
      detail: CHANGE_META[screen.change].detail,
      position,
      screenId: String(screen.screenId ?? ''),
      title: String(screen.title ?? '').trim() || String(screen.screenId ?? 'Screen'),
    }))
    .sort((left, right) => (CHANGE_META[left.change].order - CHANGE_META[right.change].order) || (left.position - right.position));

  if (!baseline) {
    return { baseline: null, heading: 'What changed', rows: [], summary: 'This is the first package in this track, so there is nothing to compare yet.' };
  }

  const since = baseline.roundNumber != null ? `round ${baseline.roundNumber}` : `version ${baseline.version}`;
  const counts = changes?.counts ?? {};
  const parts = [
    counts.changed ? `${counts.changed} changed` : '',
    counts.new ? `${counts.new} new` : '',
    counts.removed ? `${counts.removed} removed` : '',
    counts.unchanged ? `${counts.unchanged} carried` : '',
  ].filter(Boolean);
  return {
    baseline,
    heading: `What changed since ${since}`,
    rows,
    summary: parts.length ? `${parts.join(' · ')}, compared with version ${baseline.version}.` : `No screens to compare with version ${baseline.version}.`,
  };
}

/** One-line instructions for a coding agent's upload URL. */
export function uploadUrlCommand(url) {
  return `curl -X PUT -H "Content-Type: application/zip" --data-binary @package.zip "${url}"`;
}

/** The agent brief with this upload URL added, for pasting into a coding agent. */
export function agentBriefWithUploadUrl(markdown, { expiresAt = '', url }) {
  const expiry = expiresAt ? ` It expires at ${new Date(expiresAt).toISOString()}.` : '';
  return [
    String(markdown ?? '').trimEnd(),
    '',
    '## Your upload URL',
    '',
    `Upload with this URL. It works once, for one package.${expiry} Treat it as a password.`,
    '',
    '```sh',
    uploadUrlCommand(url),
    '```',
    '',
  ].join('\n');
}
