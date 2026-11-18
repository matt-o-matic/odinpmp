// Synthetic Requirements API for browser acceptance. It is installed after
// installSyntheticApi(), so these handlers take precedence (Playwright runs the most
// recently registered matching route first) and anything else falls back to the shared
// fixture. Responses follow the U1 contract in docs/requirements-gathering/impl.md.
// All people, topics, and text here are synthetic.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syntheticProject, syntheticUser } from './synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT_ID = syntheticProject.id;
const BASE = `/api/projects/${PROJECT_ID}/requirements`;
// Times are relative to when a scenario is built (each test builds its own), not to when
// this module loaded: a long run would otherwise turn "6 min ago" into "9 min ago".
function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export const syntheticStakeholders = [
  { email: 'jamie.ortiz@client.example', id: 'stakeholder-jamie', name: 'Jamie Ortiz', roleTitle: 'Client services' },
  { email: 'ravi.shah@client.example', id: 'stakeholder-ravi', name: 'Ravi Shah', roleTitle: 'Finance' },
  { email: 'noor.haddad@client.example', id: 'stakeholder-noor', name: 'Noor Haddad', roleTitle: 'Operations' },
];

// Names for people a bulk assign names by id only.
const PEOPLE_LABELS = Object.fromEntries([
  ...syntheticStakeholders.map((stakeholder) => [`stakeholder:${stakeholder.id}`, stakeholder.name]),
  [`user:${syntheticUser.id}`, syntheticUser.name],
  ['user:user-alex', 'Alex Kim'],
]);

export const syntheticBriefLines = [
  { label: 'Requirement 1', ref: 'brief:requirements:0', section: 'requirements', text: 'Clients book a home visit in under two minutes.' },
  { label: 'Requirement 2', ref: 'brief:requirements:1', section: 'requirements', text: 'Clients always know the price range before they commit.' },
  { label: 'Requirement 3', ref: 'brief:requirements:2', section: 'requirements', text: 'Clients can reschedule or cancel without calling.' },
  { label: 'Constraint 1', ref: 'brief:constraints:0', section: 'constraints', text: 'The booking flow meets the accessibility standard the client signs off on.' },
  { label: 'Objective', ref: 'brief:objective', section: 'objective', text: 'Make booking a home visit fast and predictable.' },
];

function comment({ actorId, actorType = 'stakeholder', authorName, body, children = [], createdAt, id, source = 'comment', upvotes = 0 }) {
  return {
    actorId,
    actorType,
    authorName,
    body,
    children,
    createdAt,
    currentReaction: null,
    deletedAt: null,
    downvotes: 0,
    editedAt: null,
    id,
    isDeleted: false,
    isMine: actorType === 'user' && actorId === syntheticUser.id,
    parentCommentId: null,
    source,
    updatedAt: createdAt,
    upvotes,
  };
}

function priceTopicComments() {
  const c3 = { ...comment({ actorId: 'stakeholder-jamie', authorName: 'Jamie Ortiz', body: 'Fair. I can live with a range up front if the exact number shows before they pay.', createdAt: minutesAgo(600), id: 'comment-price-3' }), parentCommentId: 'comment-price-2' };
  return [
    comment({ actorId: 'stakeholder-jamie', authorName: 'Jamie Ortiz', body: 'Show price after I pick a visit. When we led with price on the old site, people bounced before they looked at times.', createdAt: minutesAgo(900), id: 'comment-price-1', upvotes: 1 }),
    comment({ actorId: 'stakeholder-ravi', authorName: 'Ravi Shah', body: 'Price must be visible before booking. Most refund disputes last quarter started with "I didn\'t know it would cost that."', children: [c3], createdAt: minutesAgo(800), id: 'comment-price-2', source: 'email-reply', upvotes: 3 }),
    comment({ actorId: 'user-alex', actorType: 'user', authorName: 'Alex Kim', body: 'Range on the home screen, exact price on confirm. Technicians need the job type before they can price it anyway.', createdAt: minutesAgo(300), id: 'comment-price-4' }),
    comment({ actorId: 'odin', actorType: 'assistant', authorName: 'Odin', body: 'Ravi\'s tax point is new since the last summary. Nobody has said how ranges are calculated.', createdAt: minutesAgo(6), id: 'comment-price-odin', source: 'assistant' }),
  ];
}

const PRICE_SUMMARY_OUTPUT = {
  aligned: [
    { sources: ['comment:comment-price-2', 'comment:comment-price-3', 'comment:comment-price-4'], statement: 'Clients should never be surprised by the final price.', supporterNames: ['Jamie Ortiz', 'Ravi Shah', 'Alex Kim'], supporters: ['stakeholder:stakeholder-jamie', 'stakeholder:stakeholder-ravi', 'user:user-alex'] },
    { sources: ['comment:comment-price-3', 'comment:comment-price-4'], statement: 'The exact price appears before payment.', supporterNames: ['Jamie Ortiz', 'Alex Kim'], supporters: ['stakeholder:stakeholder-jamie', 'user:user-alex'] },
  ],
  divergent: [{
    issue: 'When a price first appears.',
    positions: [
      { actorNames: ['Jamie Ortiz'], actors: ['stakeholder:stakeholder-jamie'], sources: ['comment:comment-price-1'], summary: 'After a time is picked, to avoid early drop-off.' },
      { actorNames: ['Ravi Shah'], actors: ['stakeholder:stakeholder-ravi'], sources: ['comment:comment-price-2'], summary: 'Before booking starts, to prevent disputes.' },
    ],
  }],
  insufficientInput: false,
  outstanding: [
    { blocking: true, item: 'Finance confirms refund-policy wording.', suggestedOwnerRole: 'Finance' },
    { blocking: false, item: 'Noor has not responded yet.', suggestedOwnerRole: '' },
  ],
  proposedAnswer: 'Show a price range before tax on the home screen. Confirm the exact price, with tax, before payment.',
  proposedPreferences: [],
  underExplored: [
    { area: 'How a range is calculated before job details are known.', suggestedQuestion: 'How should we calculate a price range before we know the job type?', why: 'Nobody has addressed it yet.' },
  ],
};

function baseTopic(overrides) {
  return {
    assignments: [],
    commentsOpen: true,
    comments: [],
    createdAt: minutesAgo(2000),
    createdBy: { id: syntheticUser.id, name: syntheticUser.name, ref: `user:${syntheticUser.id}`, type: 'user' },
    decision: null,
    decisionId: null,
    decisions: [],
    evidence: { comments: 0, contributors: 0, roundAnswers: 0, votes: 0 },
    fullSummary: null,
    lastActivityAt: minutesAgo(2000),
    origin: 'manual',
    owner: null,
    prompt: '',
    rationale: '',
    settles: '',
    signals: { aligned: 0, divergent: 0, outstanding: 0, underExplored: 0 },
    sourceRef: null,
    state: 'open',
    status: 'open',
    suggestedOwnerRole: '',
    track: 'experience',
    updatedAt: minutesAgo(2000),
    ...overrides,
  };
}

function assignment(actorType, actorId, label, role = 'collaborator') {
  return { actorId, actorType, id: `assignment-${actorType}-${actorId}`, label, mailStatus: actorType === 'stakeholder' ? 'sent' : '', role };
}

// --- Review packages ------------------------------------------------------------
// Package bodies come from the fieldwork example (docs/requirements-gathering/examples and
// tools/review-package/examples). Screens are served by a stand-in review origin below that
// sends the example files with the real bridge script, so prototypes talk to the app.

export const REVIEW_ORIGIN = 'http://review.odin.test';
const EXAMPLE_DIR = path.join(REPO_ROOT, 'tools', 'review-package', 'examples', 'fieldwork-round-2');
export const FIELDWORK_MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs', 'requirements-gathering', 'examples', 'fieldwork-round-2.manifest.json'), 'utf8'));
const MB = 1024 * 1024;

function fieldworkScreens() {
  return structuredClone(FIELDWORK_MANIFEST.sections.find((section) => section.type === 'screens').items);
}

const PRICE_DETAILS_SCREEN = {
  alt: 'Price details panel listing what each service includes.', height: 800, id: 'price-details', kind: 'image', src: 'screens/booking-home-schedule.png', title: 'Price details', width: 1280,
};

/** A small manifest for earlier versions: a summary and the named screens. */
function earlierManifest(title, screenIds) {
  const all = [...fieldworkScreens(), PRICE_DETAILS_SCREEN];
  return {
    schema: 'odin.review-package/v1',
    sections: [{ id: 'screens', items: screenIds.map((id) => ({ ...all.find((screen) => screen.id === id), directionId: undefined })), type: 'screens' }],
    summary: `${title}. Screens for the first rounds.`,
    title,
    track: 'experience',
  };
}

export function packageDetail({ changes, createdAt, fileCount = 12, id, manifest, sizeBytes = 2.4 * MB, source = 'mcp', status = 'draft', track = 'experience', uploader = { id: 'user-dana', name: 'Dana Cho' }, version, warnings = [] }) {
  const screens = (manifest.sections.find((section) => section.type === 'screens')?.items ?? []).map((screen) => ({
    contentHash: `sha256-${screen.id}-${screen.id === 'booking-flow' ? 1 : version}`,
    directionId: screen.directionId ?? null,
    kind: screen.kind,
    screenId: screen.id,
    src: screen.src,
    title: screen.title,
  }));
  return {
    changes: changes ?? { baseline: null, counts: { changed: 0, new: screens.length, removed: 0, unchanged: 0 }, screens: screens.map((screen) => ({ change: 'new', screenId: screen.screenId, title: screen.title })) },
    createdAt,
    fileCount,
    id,
    manifest,
    projectId: PROJECT_ID,
    screens,
    sizeBytes,
    source,
    status,
    title: manifest.title,
    track,
    updatedAt: createdAt,
    uploadedBy: `user:${uploader.id}`,
    uploader: { actorRef: `user:${uploader.id}`, id: uploader.id, name: uploader.name, type: 'user' },
    version,
    warningCount: warnings.length,
    warnings,
  };
}

export function packageSummaryView(detail) {
  const { changes: _changes, manifest: _manifest, screens: _screens, warnings: _warnings, ...summary } = detail;
  return summary;
}

const THEME_WARNING = { code: 'unknown_field', file: 'manifest.json', message: 'Unknown field "theme" was ignored.', path: '/theme' };

export function defaultPackages() {
  const v1 = packageDetail({
    createdAt: minutesAgo(9000), id: 'package-1', manifest: earlierManifest('Client booking, first look', ['booking-home', 'price-details']),
    source: 'ui', status: 'published', uploader: { id: 'user-morgan', name: 'Morgan Lee' }, version: 1,
  });
  const v2 = packageDetail({
    changes: {
      baseline: { packageId: 'package-1', roundId: 'round-1', roundNumber: 1, title: v1.title, version: 1 },
      counts: { changed: 1, new: 1, removed: 0, unchanged: 1 },
      screens: [{ change: 'changed', screenId: 'booking-home', title: 'Booking home' }, { change: 'unchanged', screenId: 'price-details', title: 'Price details' }, { change: 'new', screenId: 'booking-flow', title: 'Booking flow' }],
    },
    createdAt: minutesAgo(3000), id: 'package-2', manifest: earlierManifest('Client booking, booking first', ['booking-home', 'price-details', 'booking-flow']), status: 'published', version: 2,
  });
  const v3 = packageDetail({
    changes: {
      baseline: { packageId: 'package-2', roundId: 'round-2', roundNumber: 2, title: v2.title, version: 2 },
      counts: { changed: 1, new: 1, removed: 1, unchanged: 1 },
      screens: [
        { change: 'changed', screenId: 'booking-home', title: 'Booking home' },
        { change: 'new', screenId: 'booking-home-schedule', title: 'Booking home, schedule first' },
        { change: 'unchanged', screenId: 'booking-flow', title: 'Booking flow' },
        { change: 'removed', screenId: 'price-details', title: 'Price details' },
      ],
    },
    createdAt: minutesAgo(12), fileCount: 38, id: 'package-3', manifest: structuredClone(FIELDWORK_MANIFEST), sizeBytes: 4.2 * MB, version: 3, warnings: [THEME_WARNING],
  });
  return [v1, v2, v3];
}

// The API issues one grant per screen; the synthetic one stands in for all of them.
export function grantFor(detail) {
  const baseUrl = `${REVIEW_ORIGIN}/p/${detail.id}/grant-synthetic/`;
  return {
    entryUrls: Object.fromEntries(detail.screens.map((screen) => [screen.screenId, `${baseUrl}${screen.src}`])),
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    ok: true,
  };
}

export const SYNTHETIC_REJECTION = {
  errors: [
    { code: 'missing_file', file: 'manifest.json', message: 'screens/confirm.png is not in the package.', path: '/sections/3/items/1/src' },
    { code: 'external_url', file: 'prototypes/booking/index.html', message: 'https://cdn.example.com/widget.js is an absolute network URL.', path: '' },
    { code: 'zip_limit', file: '', message: 'Entry prototypes/booking/hero.png expands past its declared size.', path: '' },
  ],
  ok: false,
  status: 'rejected',
  warnings: [THEME_WARNING],
};

// The stand-in review origin: package files from the example folder, HTML with the real
// bridge injected, and the production headers. Only http://review.odin.test is served.
const CONTENT_TYPES = { css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png', svg: 'image/svg+xml' };

function reviewOriginHeaders(appOrigin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `sandbox allow-scripts allow-forms allow-popups; default-src 'self' http://review.odin.test data: blob:; script-src 'self' http://review.odin.test 'unsafe-inline' data: blob:; style-src 'self' http://review.odin.test 'unsafe-inline' data: blob:; connect-src 'self' http://review.odin.test; frame-ancestors ${appOrigin}; form-action 'none'`,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

export function playwrightAppOrigin() {
  return `http://127.0.0.1:${Number(process.env.ODIN_PLAYWRIGHT_PORT || 4173)}`;
}

export async function installStandInReviewOrigin(page, { appOrigin = playwrightAppOrigin() } = {}) {
  const bridge = readFileSync(path.join(REPO_ROOT, 'backend', 'src', 'review-origin', 'bridge.js'), 'utf8')
    .replace('/*__ODIN_BRIDGE_CONFIG__*/{ "allowedParentOrigins": [] }', JSON.stringify({ allowedParentOrigins: [appOrigin] }));
  const requests = [];
  await page.route(`${REVIEW_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const headers = reviewOriginHeaders(appOrigin);
    if (url.pathname === '/__odin/bridge.js') return route.fulfill({ body: bridge, headers: { ...headers, 'Content-Type': CONTENT_TYPES.js }, status: 200 });
    const match = url.pathname.match(/^\/p\/[^/]+\/[^/]+\/(.+)$/);
    const relative = match ? decodeURIComponent(match[1]) : '';
    const file = path.resolve(EXAMPLE_DIR, relative);
    const extension = path.extname(file).slice(1).toLowerCase();
    if (!relative || !file.startsWith(EXAMPLE_DIR + path.sep) || !CONTENT_TYPES[extension]) {
      return route.fulfill({ body: 'Not found', headers: { ...headers, 'Content-Type': 'text/plain' }, status: 404 });
    }
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      return route.fulfill({ body: 'Not found', headers: { ...headers, 'Content-Type': 'text/plain' }, status: 404 });
    }
    const body = extension === 'html' ? Buffer.from(bytes.toString('utf8').replace(/<\/head\s*>/i, '<script src="/__odin/bridge.js"></script></head>')) : bytes;
    return route.fulfill({ body, headers: { ...headers, 'Content-Type': CONTENT_TYPES[extension] }, status: 200 });
  });
  return { requests };
}

/** The default data set: a populated Experience track and one Functional (architecture) topic. */
export function defaultRequirementsScenario() {
  const topics = [
    baseTopic({
      assignments: [
        assignment('stakeholder', 'stakeholder-jamie', 'Jamie Ortiz', 'primary'),
        assignment('stakeholder', 'stakeholder-ravi', 'Ravi Shah'),
        assignment('user', 'user-alex', 'Alex Kim'),
      ],
      comments: priceTopicComments(),
      evidence: { comments: 4, contributors: 3, roundAnswers: 0, votes: 4 },
      // A copy, because specs edit the scenario and the next test in the worker would see it.
      fullSummary: { createdAt: minutesAgo(6), id: 'summary-price', output: structuredClone(PRICE_SUMMARY_OUTPUT), scopeId: 'topic-price', scopeType: 'topic' },
      id: 'topic-price',
      owner: { actorId: 'stakeholder-jamie', actorType: 'stakeholder', label: 'Jamie Ortiz' },
      prompt: 'Should clients see an estimated price before they pick a time?',
      rationale: 'Pricing surprises drive refund disputes.',
      settles: 'booking flow',
      signals: { aligned: 2, divergent: 1, outstanding: 2, underExplored: 1 },
      sourceRef: 'brief:requirements:1',
      state: 'ready',
    }),
    baseTopic({
      comments: [comment({ actorId: 'stakeholder-noor', authorName: 'Noor Haddad', body: 'Reminders by email first. Text costs money we have not budgeted.', createdAt: minutesAgo(1500), id: 'comment-reminder-1' })],
      createdAt: minutesAgo(1900),
      evidence: { comments: 1, contributors: 1, roundAnswers: 0, votes: 0 },
      fullSummary: { createdAt: minutesAgo(1400), id: 'summary-reminder', output: { aligned: [], divergent: [], insufficientInput: true, outstanding: [], proposedAnswer: '', underExplored: [] }, scopeId: 'topic-reminder', scopeType: 'topic' },
      id: 'topic-reminder',
      prompt: 'Do clients want reminders by email, text, or both?',
      sourceRef: 'brief:requirements:0',
      state: 'ready',
      // Ready because the clarification flow marked it answered.
      status: 'answered',
    }),
    baseTopic({
      assignments: [assignment('user', syntheticUser.id, syntheticUser.name, 'primary')],
      createdAt: minutesAgo(1800),
      id: 'topic-notes',
      owner: { actorId: syntheticUser.id, actorType: 'user', label: syntheticUser.name },
      prompt: 'Do technicians see client notes before the visit?',
    }),
    baseTopic({
      createdAt: minutesAgo(120),
      id: 'topic-accessibility',
      origin: 'brief-draft',
      prompt: 'Which accessibility standard applies, and who signs off on it?',
      settles: 'accessibility sign-off',
      sourceRef: 'brief:constraints:0',
      suggestedOwnerRole: 'Client services',
    }),
    baseTopic({
      createdAt: minutesAgo(5000),
      decision: { decidedAt: minutesAgo(3000), decidedBy: { name: 'Morgan Lee' }, id: 'decision-home-2', outcome: 'agreed', statement: 'Booking is the first task on the home screen.' },
      decisionId: 'decision-home-2',
      id: 'topic-home',
      prompt: 'Is booking the first task on the home screen?',
      signals: { aligned: 3, divergent: 0, outstanding: 0, underExplored: 0 },
      state: 'decided',
      status: 'resolved',
    }),
    baseTopic({
      assignments: [assignment('user', syntheticUser.id, syntheticUser.name, 'primary')],
      createdAt: minutesAgo(1700),
      id: 'topic-estimate-service',
      owner: { actorId: syntheticUser.id, actorType: 'user', label: syntheticUser.name },
      prompt: 'How do price estimates get calculated, and by which service?',
      track: 'architecture',
    }),
  ];

  const decisions = [
    { chain: [], decidedAt: minutesAgo(6000), decidedBy: { id: 'user-morgan', name: 'Morgan Lee', ref: 'user:user-morgan', type: 'user' }, id: 'decision-home-1', kind: 'topic', outcome: 'decided', preference: null, sources: [], statement: 'Booking sits second, after the visit history.', status: 'superseded', supersededById: 'decision-home-2', supersedesId: null, topic: { id: 'topic-home', prompt: 'Is booking the first task on the home screen?' }, topicId: 'topic-home', track: 'experience', version: 2 },
    { chain: ['decision-home-1'], decidedAt: minutesAgo(3000), decidedBy: { id: 'user-morgan', name: 'Morgan Lee', ref: 'user:user-morgan', type: 'user' }, id: 'decision-home-2', kind: 'topic', outcome: 'agreed', preference: null, sources: ['comment:a', 'comment:b'], statement: 'Booking is the first task on the home screen.', status: 'active', supersededById: null, supersedesId: 'decision-home-1', topic: { id: 'topic-home', prompt: 'Is booking the first task on the home screen?' }, topicId: 'topic-home', track: 'experience', version: 1 },
    { chain: [], decidedAt: minutesAgo(2000), decidedBy: { id: 'user-morgan', name: 'Morgan Lee', ref: 'user:user-morgan', type: 'user' }, id: 'decision-pref-1', kind: 'preference', outcome: 'agreed', preference: { dimension: 'hierarchy', stance: 'keep' }, sources: ['comment:x'], statement: 'One primary "Book a visit" action on the home screen.', status: 'active', supersededById: null, supersedesId: null, topic: null, topicId: null, track: 'experience', version: 1 },
  ];

  return {
    briefLines: syntheticBriefLines,
    canDecide: true,
    decisions,
    draftMode: 'success',
    links: [{
      expiresAt: null, extendedUntil: null, id: 'link-ravi', involvementActive: true, issuedAt: minutesAgo(3000), lastInvolvementEndedAt: null,
      lastUsedAt: minutesAgo(800), revokedAt: null, stakeholder: { ...syntheticStakeholders[1] }, status: 'active',
    }],
    projectRole: 'manager',
    // The round one shows on its round page only; Decide lists the topic one.
    proposedPreferences: [{
      dimension: 'type', key: 'summary-review-2:0', proposedAt: minutesAgo(30), scopeId: 'round-2', scopeType: 'round',
      sources: ['annotation:a1', 'comment:comment-price-2'], stance: 'keep', statement: 'Keep the 14px body text on booking screens.', summaryId: 'summary-review-2', track: 'experience',
    }, {
      dimension: 'density', key: 'summary-price:0', proposedAt: minutesAgo(25), scopeId: 'topic-price', scopeType: 'topic',
      sources: ['comment:comment-price-2'], stance: 'keep', statement: 'Keep the price card to one line.', summaryId: 'summary-price', track: 'experience',
    }],
    grantMode: 'ok',
    packages: defaultPackages(),
    rounds: [{ dueAt: daysFromNow(3), id: 'round-2', number: 2, packageId: 'package-2', publishedAt: minutesAgo(1440), required: true, reviewersSubmitted: 3, reviewersTotal: 5, status: 'open', track: 'experience' }],
    stakeholders: syntheticStakeholders,
    summaryRefreshMode: 'ok',
    topics,
    uploadDelayMs: 0,
    uploadMode: 'accept',
    withdrawConflict: false,
    // POST /packages/:id/replace answers 409 as if the draft was published meanwhile.
    replaceConflict: false,
    // Track plans as GET /requirements/plans presents them (newest version first per track).
    // Specs that draft, edit, or approve install fixtures/requirements-plans-api.js.
    plans: [],
  };
}

/** Exactly the AC-19 setup: owns one topic, invited to one open round, two topics ready. */
export function myItemsScenario() {
  const scenario = defaultRequirementsScenario();
  scenario.proposedPreferences = [];
  scenario.topics = scenario.topics.filter((topic) => topic.id !== 'topic-estimate-service');
  return scenario;
}

export function emptyRequirementsScenario() {
  return {
    ...defaultRequirementsScenario(),
    decisions: [],
    links: [],
    packages: [],
    proposedPreferences: [],
    rounds: [],
    topics: [],
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function notFound(route) {
  return json(route, { error: 'Project not found.', ok: false }, 404);
}

function summaryStatusOf(topic) {
  return topic.summaryStatus ?? {
    lastAttemptAt: topic.fullSummary?.createdAt ?? null,
    lastAttemptStatus: topic.fullSummary ? 'ok' : null,
    refreshPending: false,
  };
}

function fullSummaryView(topic) {
  if (!topic.fullSummary) return null;
  const status = summaryStatusOf(topic);
  return { ...structuredClone(topic.fullSummary), lastAttemptAt: status.lastAttemptAt ?? topic.fullSummary.createdAt, lastAttemptStatus: status.lastAttemptStatus ?? 'ok', status: 'ok' };
}

// `withOutput` mirrors `include=summaries`: each row's summary also carries its output.
function presentRow(topic, { withOutput = false } = {}) {
  const { comments: _comments, decisions: _decisions, fullSummary, summaryStatus: _summaryStatus, ...row } = topic;
  const status = summaryStatusOf(topic);
  return {
    ...row,
    summary: fullSummary
      ? {
        createdAt: fullSummary.createdAt,
        id: fullSummary.id,
        insufficientInput: Boolean(fullSummary.output?.insufficientInput),
        proposedAnswer: fullSummary.output?.proposedAnswer ?? '',
        ...(withOutput ? { output: fullSummary.output } : {}),
      }
      : null,
    summaryStatus: { lastAttemptAt: status.lastAttemptAt, lastAttemptStatus: status.lastAttemptStatus },
  };
}

function flatten(comments = []) {
  return comments.flatMap((entry) => [entry, ...flatten(entry.children ?? [])]);
}

export async function installRequirementsApi(page, scenario = defaultRequirementsScenario()) {
  const state = structuredClone(scenario);
  const calls = [];
  // Package screens point at the stand-in review origin unless a spec brings its own.
  const reviewOrigin = state.standInReviewOrigin === false ? { requests: [] } : await installStandInReviewOrigin(page);
  let commentCounter = 0;
  let pendingEvents = [];
  const eventWaiters = [];

  const presentTopic = (topic) => ({
    ...presentRow(topic),
    comments: structuredClone(topic.comments ?? []),
    decisions: state.decisions.filter((decision) => decision.topicId === topic.id),
    summary: fullSummaryView(topic),
    summaryStatus: summaryStatusOf(topic),
  });

  const commentWriteResponse = (topic, extra = {}) => ({ ok: true, topic: { ...presentRow(topic), comments: structuredClone(topic.comments) }, ...extra });

  function overview() {
    const tracks = {};
    const latestRound = [...state.rounds].sort((left, right) => right.number - left.number)[0] ?? null;
    const reviewStage = latestRound
      ? { latestRound: { closedAt: null, dueAt: latestRound.dueAt, id: latestRound.id, number: latestRound.number, publishedAt: latestRound.publishedAt, reviewersSubmitted: latestRound.reviewersSubmitted, reviewersTotal: latestRound.reviewersTotal, status: latestRound.status }, state: latestRound.status }
      : { latestRound: null, state: 'none' };
    for (const track of ['experience', 'architecture']) {
      const rows = state.topics.filter((topic) => topic.track === track);
      const live = rows.filter((topic) => topic.state !== 'dismissed');
      const count = (value) => rows.filter((topic) => topic.state === value).length;
      const lines = state.briefLines.map((line) => ({ ...line, topicCount: live.filter((topic) => topic.sourceRef === line.ref).length }));
      const coveredLines = lines.filter((line) => line.topicCount > 0).length;
      // Review is project-wide: every track reports the project's latest round.
      const round = latestRound;
      const proposed = state.proposedPreferences.filter((entry) => entry.track === track && entry.scopeType === 'topic').length;
      tracks[track] = {
        stages: {
          brief: { coveredLines, lines, state: lines.length === 0 ? 'empty' : coveredLines === lines.length ? 'covered' : coveredLines === 0 ? 'uncovered' : 'partial', totalLines: lines.length },
          decide: { decided: count('decided'), proposedPreferences: proposed, state: 'active', waiting: count('ready') },
          discuss: { decided: count('decided'), dismissed: count('dismissed'), open: count('open'), ready: count('ready'), state: live.length ? 'active' : 'empty', total: live.length },
          plan: (() => {
            const latest = (state.plans ?? []).filter((entry) => entry.track === track).sort((left, right) => right.version - left.version)[0] ?? null;
            return latest
              ? { latestPlan: { approvedAt: latest.approvedAt ?? null, id: latest.id, status: latest.status, version: latest.version }, state: latest.status }
              : { latestPlan: null, state: 'not-started' };
          })(),
          review: round ? reviewStage : { latestRound: null, state: 'none' },
        },
        track,
      };
    }
    return { canDecide: state.canDecide, ok: true, review: reviewStage, tracks };
  }

  function myItems() {
    const decide = !state.canDecide ? [] : [
      ...state.topics.filter((topic) => topic.state === 'ready').map((topic) => ({
        action: 'decide', createdAt: topic.createdAt, id: topic.id, kind: 'topic',
        meta: { evidence: topic.evidence, readySince: topic.fullSummary?.createdAt ?? topic.updatedAt, signals: topic.signals, status: topic.status },
        title: topic.prompt, track: topic.track, updatedAt: topic.updatedAt,
      })),
      ...state.proposedPreferences.filter((proposal) => proposal.scopeType === 'topic').map((proposal) => ({
        action: 'decide', createdAt: proposal.proposedAt, id: proposal.key, kind: 'preference',
        meta: { dimension: proposal.dimension, scopeId: proposal.scopeId, scopeType: proposal.scopeType, sources: proposal.sources, stance: proposal.stance, summaryId: proposal.summaryId },
        title: proposal.statement, track: proposal.track, updatedAt: proposal.proposedAt,
      })),
    ];
    const answer = state.topics
      .filter((topic) => ['open', 'ready'].includes(topic.state))
      .flatMap((topic) => {
        const mine = topic.assignments.find((entry) => entry.actorType === 'user' && entry.actorId === syntheticUser.id);
        return mine ? [{ action: 'reply', createdAt: topic.createdAt, id: topic.id, kind: 'topic', meta: { commentCount: topic.evidence.comments, lastActivityAt: topic.lastActivityAt, role: mine.role, state: topic.state }, title: topic.prompt, track: topic.track, updatedAt: topic.updatedAt }] : [];
      });
    const review = state.rounds.filter((round) => round.status === 'open').map((round) => ({
      action: 'review', createdAt: round.publishedAt, id: round.id, kind: 'round',
      meta: { dueAt: round.dueAt, number: round.number, packageId: round.packageId, required: round.required }, title: `Round ${round.number}`, track: round.track, updatedAt: round.publishedAt,
    }));
    const drafts = [];
    return {
      canDecide: state.canDecide,
      counts: { answer: answer.length, decide: decide.length, drafts: 0, review: review.length, total: decide.length + answer.length + review.length },
      groups: { answer, decide, drafts, review },
      ok: true,
    };
  }

  const canCollaborate = () => state.projectRole !== 'viewer';

  await page.route(`${API_ORIGIN}/api/projects/${PROJECT_ID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { project: { ...syntheticProject, role: state.projectRole } });
  });

  await page.route(`${API_ORIGIN}/api/assistant/projects/${PROJECT_ID}/clarifications`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { clarifications: [], stakeholders: structuredClone(state.stakeholders) });
  });

  await page.route(`${API_ORIGIN}/api/projects/${PROJECT_ID}/valid-users`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const users = [{ ...syntheticUser, role: state.projectRole }, { email: 'alex.kim@example.com', id: 'user-alex', name: 'Alex Kim', role: 'member' }];
    return json(route, { project_users: users, tenant_users: users, validStatusTypes: {}, validTaskTypes: {} });
  });

  await page.route(`${API_ORIGIN}/api/projects/${PROJECT_ID}/events`, async (route) => {
    if (!state.liveEvents) return route.fallback();
    // Hold the stream open until the test pushes an event, then deliver it once.
    const body = pendingEvents.length > 0 ? pendingEvents.splice(0) : await new Promise((resolve) => {
      const waiter = (events) => {
        clearTimeout(timer);
        resolve(events);
      };
      const timer = setTimeout(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) eventWaiters.splice(index, 1);
        resolve([]);
      }, 20_000);
      eventWaiters.push(waiter);
    });
    const frames = body.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`).join('');
    try {
      await route.fulfill({ body: frames, contentType: 'text/event-stream', status: 200 });
    } catch {
      // The page closed while the stream was held.
    }
  });

  await page.route(`${API_ORIGIN}${BASE}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(BASE.length) || '/';
    const method = request.method();
    let body = null;
    if (['POST', 'PATCH'].includes(method)) {
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        // A raw zip upload has no JSON body.
        body = null;
      }
    }
    calls.push({ body, contentType: request.headers()['content-type'] ?? '', method, path, search: url.search, size: request.postDataBuffer()?.length ?? 0 });

    if (method === 'GET' && path === '/') return json(route, overview());
    if (method === 'GET' && path === '/my-items') return json(route, myItems());

    const trackTopics = path.match(/^\/tracks\/(experience|architecture)\/topics$/);
    if (trackTopics && method === 'GET') {
      const rows = state.topics.filter((topic) => topic.track === trackTopics[1]);
      const view = url.searchParams.get('view') ?? 'all';
      const counts = { decided: 0, dismissed: 0, open: 0, ready: 0, total: 0 };
      for (const row of rows) { counts[row.state] += 1; if (row.state !== 'dismissed') counts.total += 1; }
      const withOutput = url.searchParams.get('include') === 'summaries';
      return json(route, { counts, ok: true, q: '', topics: rows.filter((row) => (view === 'dismissed' ? row.state === 'dismissed' : view === 'every' || row.state !== 'dismissed')).map((row) => presentRow(row, { withOutput })), track: trackTopics[1], view });
    }
    if (trackTopics && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      const topic = baseTopic({
        createdAt: new Date().toISOString(), id: `topic-new-${state.topics.length + 1}`, prompt: body.prompt, rationale: body.rationale ?? '',
        settles: body.settles ?? '', sourceRef: body.sourceRef ?? null, suggestedOwnerRole: body.suggestedOwnerRole ?? '', track: trackTopics[1], updatedAt: new Date().toISOString(),
      });
      state.topics.push(topic);
      return json(route, { ok: true, topic: presentRow(topic) }, 201);
    }

    const draft = path.match(/^\/tracks\/(experience|architecture)\/draft-questions$/);
    if (draft && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      if (state.draftMode === 'ai_not_configured') return json(route, { details: { code: 'ai_not_configured', message: 'Requirements AI is not configured. Save a tenant OpenAI key or set OPENAI_API_KEY.' }, error: 'ai_not_configured', ok: false }, 503);
      if (state.draftMode === 'ai_output_invalid') return json(route, { details: { code: 'ai_output_invalid', message: 'Odin returned questions in an unexpected shape. Try again.', retryable: true }, error: 'ai_output_invalid', ok: false }, 502);
      if (state.draftMode === 'ai_request_failed') return json(route, { details: { code: 'ai_request_failed', message: 'Odin could not draft questions. Try again.', retryable: true }, error: 'ai_request_failed', ok: false }, 502);
      if (state.draftMode === 'brief_empty') return json(route, { details: { code: 'brief_empty', message: 'Add a project brief before drafting questions from it.' }, error: 'brief_empty', ok: false }, 409);
      const drafted = [
        { prompt: 'How do clients reschedule or cancel, and what do they see when a fee applies?', settles: 'reschedule and cancel', sourceRef: 'brief:requirements:2', suggestedOwnerRole: 'Client services' },
        { prompt: 'What does "fast" mean for booking: how many steps or seconds?', settles: 'booking speed target', sourceRef: 'brief:objective', suggestedOwnerRole: 'Product' },
      ].map((question, index) => baseTopic({
        createdAt: new Date(Date.now() + index).toISOString(), id: `topic-drafted-${state.topics.length + index + 1}`, origin: 'brief-draft',
        prompt: question.prompt, settles: question.settles, sourceRef: question.sourceRef, suggestedOwnerRole: question.suggestedOwnerRole, track: draft[1],
      }));
      state.topics.push(...drafted);
      return json(route, {
        created: drafted.map(presentRow), ok: true, provider: 'synthetic',
        skipped: [{ duplicateOf: 'topic-reminder', prompt: 'Should reminders go out by email or by text?', reason: 'duplicate', sourceRef: 'brief:requirements:0' }],
        track: draft[1],
      }, 201);
    }

    const trackDecisions = path.match(/^\/tracks\/(experience|architecture)\/decisions$/);
    if (trackDecisions && method === 'GET') return json(route, { decisions: state.decisions.filter((decision) => decision.track === trackDecisions[1]), ok: true, track: trackDecisions[1] });
    const trackPreferences = path.match(/^\/tracks\/(experience|architecture)\/preferences$/);
    if (trackPreferences && method === 'GET') {
      return json(route, {
        accepted: state.decisions.filter((decision) => decision.kind === 'preference' && decision.track === trackPreferences[1]),
        ok: true, proposed: state.proposedPreferences.filter((entry) => entry.track === trackPreferences[1]), track: trackPreferences[1],
      });
    }

    // A simplified POST /topics/bulk: the same per-topic outcomes as the API, one result each.
    if (path === '/topics/bulk' && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      if (['agree', 'defer', 'dismiss', 'reopen'].includes(body.action) && !state.canDecide) return notFound(route);
      const skip = (topicId, code, message) => ({ code, message, status: 'skipped', topicId });
      const results = body.topicIds.map((topicId) => {
        const topic = state.topics.find((entry) => entry.id === topicId);
        if (!topic) return { code: 'http_404', message: 'Topic not found.', status: 'failed', topicId };
        const hasDecision = state.decisions.some((decision) => decision.topicId === topicId && decision.status === 'active');
        if (body.action === 'dismiss') {
          if (topic.state === 'dismissed') return skip(topicId, 'already_dismissed', 'Already dismissed.');
          if (topic.state === 'decided') return skip(topicId, 'has_decision', 'Already has a decision. Replace it on the topic page.');
          Object.assign(topic, { state: 'dismissed', status: 'dismissed' });
        } else if (body.action === 'reopen') {
          if (topic.state !== 'dismissed') return skip(topicId, 'not_dismissed', 'Not dismissed, so there is nothing to reopen.');
          Object.assign(topic, { state: 'open', status: 'open' });
        } else if (body.action === 'delete') {
          if ((topic.comments?.length ?? 0) > 0 || hasDecision || topic.assignments.some((entry) => entry.actorType === 'stakeholder')) {
            return skip(topicId, 'topic_has_activity', 'Has comments, decisions, stakeholders or files, so it can only be dismissed.');
          }
          state.topics = state.topics.filter((entry) => entry.id !== topicId);
        } else if (body.action === 'agree' || body.action === 'defer') {
          if (topic.state === 'dismissed') return skip(topicId, 'is_dismissed', 'Dismissed. Reopen it first.');
          if (hasDecision || topic.state === 'decided') return skip(topicId, 'has_decision', 'Already has a decision. Replace it on the topic page.');
          const answer = presentRow(topic).summary?.proposedAnswer ?? '';
          if (body.action === 'agree' && !answer) return skip(topicId, 'no_proposed_answer', 'No Odin proposed answer to agree to yet.');
          const statement = body.action === 'agree' ? answer : body.statement;
          const decision = { decidedAt: new Date().toISOString(), id: `decision-bulk-${topicId}`, kind: 'topic', outcome: body.action === 'agree' ? 'agreed' : 'deferred', sources: [], statement, status: 'active', topicId, track: topic.track, version: 1 };
          state.decisions.push(decision);
          if (body.action === 'agree') Object.assign(topic, { state: 'decided', status: 'resolved' });
          topic.decision = { decidedAt: decision.decidedAt, decidedBy: { name: syntheticUser.name }, id: decision.id, outcome: decision.outcome, statement };
        } else if (body.action === 'assign') {
          const key = (person) => `${person.actorType}:${person.actorId}`;
          const removed = new Set((body.assign.remove ?? []).map(key));
          const current = topic.assignments;
          const currentOwner = current.find((entry) => entry.role === 'primary') ?? null;
          const owner = body.assign.owner === undefined ? (currentOwner && !removed.has(key(currentOwner)) ? currentOwner : null) : body.assign.owner;
          const seen = new Set(owner ? [key(owner)] : []);
          const next = owner ? [assignment(owner.actorType, owner.actorId, current.find((entry) => key(entry) === key(owner))?.label ?? PEOPLE_LABELS[key(owner)] ?? '', 'primary')] : [];
          for (const person of [...current.filter((entry) => entry.role !== 'primary'), ...(body.assign.add ?? [])]) {
            if (seen.has(key(person)) || removed.has(key(person))) continue;
            seen.add(key(person));
            next.push(assignment(person.actorType, person.actorId, person.label ?? PEOPLE_LABELS[key(person)] ?? '', 'collaborator'));
          }
          topic.assignments = next;
          topic.owner = owner ? { actorId: owner.actorId, actorType: owner.actorType, label: next[0].label } : null;
        }
        return { status: 'done', topicId };
      });
      const count = (status) => results.filter((entry) => entry.status === status).length;
      return json(route, { action: body.action, counts: { done: count('done'), failed: count('failed'), skipped: count('skipped') }, ok: true, results });
    }

    const topicMatch = path.match(/^\/topics\/([^/]+)$/);
    if (topicMatch) {
      const topic = state.topics.find((entry) => entry.id === topicMatch[1]);
      if (!topic) return json(route, { error: 'Topic not found.', ok: false }, 404);
      if (method === 'GET') return json(route, { ok: true, topic: presentTopic(topic) });
      if (!canCollaborate()) return notFound(route);
      if (method === 'PATCH') {
        if (body.status !== undefined) {
          if (!state.canDecide) return notFound(route);
          topic.status = body.status;
          topic.state = body.status === 'dismissed' ? 'dismissed' : body.status === 'resolved' ? 'decided' : 'open';
        }
        for (const field of ['prompt', 'rationale', 'settles', 'suggestedOwnerRole']) if (body[field] !== undefined) topic[field] = body[field];
        if (body.assignments) {
          topic.assignments = body.assignments.map((entry) => assignment(entry.actorType, entry.actorId, entry.label, entry.role));
          const primary = topic.assignments.find((entry) => entry.role === 'primary');
          topic.owner = primary ? { actorId: primary.actorId, actorType: primary.actorType, label: primary.label } : null;
        }
        topic.updatedAt = new Date().toISOString();
        return json(route, { ok: true, topic: presentRow(topic) });
      }
      if (method === 'DELETE') {
        const hasActivity = (topic.comments?.length ?? 0) > 0 || state.decisions.some((decision) => decision.topicId === topic.id)
          || topic.assignments.some((entry) => entry.actorType === 'stakeholder');
        if (hasActivity) {
          return json(route, {
            details: { activity: { comments: topic.comments.length }, code: 'topic_has_activity', message: 'This topic already has comments, decisions, stakeholders, or files. Ask a project admin or manager to dismiss it.' },
            error: 'topic_has_activity', ok: false,
          }, 409);
        }
        state.topics = state.topics.filter((entry) => entry.id !== topic.id);
        return json(route, { deleted: { id: topic.id, track: topic.track }, ok: true });
      }
    }

    const mentionablesMatch = path.match(/^\/topics\/([^/]+)\/mentionables$/);
    if (mentionablesMatch && method === 'GET') {
      if (!canCollaborate()) return notFound(route);
      const people = [
        { detail: 'Team', kind: 'team', name: 'Alex Kim', ref: 'user:user-alex' },
        ...state.stakeholders.map((stakeholder) => ({ detail: `Stakeholder · ${stakeholder.roleTitle}`, kind: 'stakeholder', name: stakeholder.name, ref: `stakeholder:${stakeholder.id}` })),
      ];
      return json(route, { ok: true, people });
    }

    const commentsMatch = path.match(/^\/topics\/([^/]+)\/comments$/);
    if (commentsMatch && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      const topic = state.topics.find((entry) => entry.id === commentsMatch[1]);
      const created = { ...comment({ actorId: syntheticUser.id, actorType: 'user', authorName: syntheticUser.name, body: body.body, createdAt: new Date().toISOString(), id: `comment-new-${(commentCounter += 1)}` }), parentCommentId: body.parentCommentId || null };
      const parent = body.parentCommentId ? flatten(topic.comments).find((entry) => entry.id === body.parentCommentId) : null;
      if (parent) parent.children = [...(parent.children ?? []), created];
      else topic.comments.push(created);
      topic.evidence = { ...topic.evidence, comments: topic.evidence.comments + 1 };
      return json(route, commentWriteResponse(topic, { comment: created }), 201);
    }
    const commentMatch = path.match(/^\/topics\/([^/]+)\/comments\/([^/]+)(\/vote)?$/);
    if (commentMatch) {
      if (!canCollaborate()) return notFound(route);
      const topic = state.topics.find((entry) => entry.id === commentMatch[1]);
      const target = flatten(topic.comments).find((entry) => entry.id === commentMatch[2]);
      if (commentMatch[3] && method === 'POST') {
        const previous = target.currentReaction;
        if (previous === 'up') target.upvotes -= 1;
        if (previous === 'down') target.downvotes -= 1;
        target.currentReaction = previous === body.vote ? null : body.vote;
        if (target.currentReaction === 'up') target.upvotes += 1;
        if (target.currentReaction === 'down') target.downvotes += 1;
        return json(route, commentWriteResponse(topic, { vote: target.currentReaction }));
      }
      if (method === 'PATCH') {
        Object.assign(target, { body: body.body, editedAt: new Date().toISOString() });
        return json(route, commentWriteResponse(topic, { comment: target }));
      }
      if (method === 'DELETE') {
        Object.assign(target, { deletedAt: new Date().toISOString(), isDeleted: true });
        return json(route, commentWriteResponse(topic, { comment: target, deleteMode: 'soft' }));
      }
    }

    if (path === '/decisions' && method === 'POST') {
      if (!state.canDecide) return notFound(route);
      const topic = state.topics.find((entry) => entry.id === body.topicId);
      const active = state.decisions.find((decision) => decision.topicId === body.topicId && decision.status === 'active');
      if (active && active.id !== body.supersedesId) {
        return json(route, { details: { activeDecisionId: active.id, code: 'decision_exists' }, error: 'This topic already has a decision. Supersede it to record a new one.', ok: false }, 409);
      }
      const decision = {
        chain: active ? [active.id] : [], decidedAt: new Date().toISOString(), decidedBy: { id: syntheticUser.id, name: syntheticUser.name, ref: `user:${syntheticUser.id}`, type: 'user' },
        id: `decision-new-${state.decisions.length + 1}`, kind: 'topic', outcome: body.outcome, preference: null, sources: body.sources ?? [], statement: body.statement,
        status: 'active', supersededById: null, supersedesId: body.supersedesId || null, topic: { id: topic.id, prompt: topic.prompt }, topicId: topic.id, track: topic.track, version: 1,
      };
      if (active) Object.assign(active, { status: 'superseded', supersededById: decision.id });
      state.decisions.push(decision);
      if (body.outcome !== 'deferred') Object.assign(topic, { status: 'resolved', state: 'decided' });
      topic.decision = { decidedAt: decision.decidedAt, decidedBy: { name: syntheticUser.name }, id: decision.id, outcome: decision.outcome, statement: decision.statement };
      topic.decisionId = decision.id;
      return json(route, { decision, ok: true, topic: presentRow(topic) }, 201);
    }

    if (path === '/preferences/accept' && method === 'POST') {
      if (!state.canDecide) return notFound(route);
      const decision = {
        chain: [], decidedAt: new Date().toISOString(), decidedBy: { id: syntheticUser.id, name: syntheticUser.name, ref: `user:${syntheticUser.id}`, type: 'user' },
        id: `decision-pref-${state.decisions.length + 1}`, kind: 'preference', outcome: 'agreed', preference: { dimension: body.dimension, stance: body.stance },
        sources: body.sources ?? [], statement: body.statement, status: 'active', supersededById: null, supersedesId: null, topic: null, topicId: null, track: body.track, version: 1,
      };
      state.decisions.push(decision);
      state.proposedPreferences = state.proposedPreferences.filter((entry) => entry.key !== body.key);
      return json(route, { decision, ok: true }, 201);
    }

    const refreshMatch = path.match(/^\/topics\/([^/]+)\/summary\/refresh$/);
    if (refreshMatch && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      const topic = state.topics.find((entry) => entry.id === refreshMatch[1]);
      if (!topic) return json(route, { error: 'Topic not found.', ok: false }, 404);
      const mode = state.summaryRefreshMode ?? 'ok';
      if (mode === 'ai_not_configured') {
        return json(route, { details: { code: 'ai_not_configured', message: 'Requirements AI is not configured. Save a tenant OpenAI key or set OPENAI_API_KEY.' }, error: 'ai_not_configured', ok: false }, 503);
      }
      const at = new Date().toISOString();
      if (mode === 'no-input') {
        return json(route, { ok: true, outcome: 'no-input', run: null, summary: fullSummaryView(topic), summaryStatus: summaryStatusOf(topic), topicId: topic.id });
      }
      if (mode === 'failed') {
        topic.summaryStatus = { lastAttemptAt: at, lastAttemptStatus: 'failed', refreshPending: false };
        return json(route, { ok: true, outcome: 'failed', run: { createdAt: at, failureReason: 'ai_request_failed', id: `run-${topic.id}-failed`, status: 'failed' }, summary: fullSummaryView(topic), summaryStatus: summaryStatusOf(topic), topicId: topic.id });
      }
      topic.fullSummary = {
        ...(topic.fullSummary ?? { output: { aligned: [], divergent: [], insufficientInput: true, outstanding: [], proposedAnswer: '', underExplored: [] }, scopeId: topic.id, scopeType: 'topic' }),
        createdAt: at,
        id: `summary-${topic.id}-refreshed`,
      };
      topic.summaryStatus = { lastAttemptAt: at, lastAttemptStatus: 'ok', refreshPending: false };
      return json(route, { ok: true, outcome: 'ok', run: { createdAt: at, failureReason: null, id: topic.fullSummary.id, status: 'ok' }, summary: fullSummaryView(topic), summaryStatus: summaryStatusOf(topic), topicId: topic.id });
    }

    if (path === '/packages' && method === 'GET') {
      const track = url.searchParams.get('track');
      return json(route, { ok: true, packages: state.packages.filter((entry) => !track || entry.track === track).map(packageSummaryView) });
    }
    if (path === '/packages/upload-urls' && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      return json(route, {
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), ok: true, track: body?.track,
        uploadId: `upload-${calls.length}`, url: `${API_ORIGIN}/api/public/requirements-uploads/odin_pkgup_synthetic-once-${calls.length}`,
      }, 201);
    }
    if (path === '/packages/upload' && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      if (state.uploadDelayMs) await new Promise((resolve) => setTimeout(resolve, state.uploadDelayMs));
      const track = url.searchParams.get('track');
      if (!['experience', 'architecture'].includes(track)) return json(route, { details: null, error: 'Choose a track: experience or architecture.', ok: false }, 400);
      if (!String(request.headers()['content-type'] ?? '').includes('zip')) return json(route, { details: null, error: 'Send the package as a raw application/zip body.', ok: false }, 415);
      if (state.uploadMode === 'reject') return json(route, structuredClone(SYNTHETIC_REJECTION), 422);
      const version = Math.max(0, ...state.packages.filter((entry) => entry.track === track).map((entry) => entry.version)) + 1;
      const detail = packageDetail({
        createdAt: new Date().toISOString(), id: `package-uploaded-${version}`,
        manifest: { ...structuredClone(FIELDWORK_MANIFEST), title: 'Client booking, reschedule flow', track },
        source: 'ui', track, uploader: { id: syntheticUser.id, name: syntheticUser.name }, version,
      });
      state.packages.push(detail);
      return json(route, { ok: true, package: detail }, 201);
    }
    const replaceMatch = path.match(/^\/packages\/([^/]+)\/replace$/);
    if (replaceMatch && method === 'POST') {
      if (!canCollaborate()) return notFound(route);
      const draft = state.packages.find((entry) => entry.id === replaceMatch[1]);
      if (!draft) return json(route, { details: null, error: 'Package not found.', ok: false }, 404);
      if (draft.status !== 'draft' || state.replaceConflict) {
        const packageStatus = state.replaceConflict ? 'published' : draft.status;
        if (state.replaceConflict) draft.status = 'published';
        return json(route, {
          details: { code: 'package_not_draft', packageId: draft.id, packageStatus },
          error: `Version ${draft.version} is no longer a draft: it was published, withdrawn, or replaced. Nothing was stored.`,
          ok: false,
        }, 409);
      }
      if (!String(request.headers()['content-type'] ?? '').includes('zip')) return json(route, { details: null, error: 'Send the package as a raw application/zip body.', ok: false }, 415);
      if (state.uploadMode === 'reject') return json(route, structuredClone(SYNTHETIC_REJECTION), 422);
      const version = Math.max(0, ...state.packages.filter((entry) => entry.track === draft.track).map((entry) => entry.version)) + 1;
      const detail = packageDetail({
        createdAt: new Date().toISOString(), id: `package-replacement-${version}`,
        manifest: { ...structuredClone(FIELDWORK_MANIFEST), title: 'Client booking, corrected price copy', track: draft.track },
        source: 'ui', track: draft.track, uploader: { id: syntheticUser.id, name: syntheticUser.name }, version,
      });
      state.packages.push(detail);
      Object.assign(draft, { status: 'withdrawn', updatedAt: new Date().toISOString() });
      // The replacement is stored before a slow response, as when the server already has the
      // zip; a client that cancels meanwhile never reads the answer.
      if (state.uploadDelayMs) await new Promise((resolve) => setTimeout(resolve, state.uploadDelayMs));
      return json(route, { ok: true, package: detail, replaced: packageSummaryView(draft) }, 201).catch(() => {});
    }
    const packageMatch = path.match(/^\/packages\/([^/]+)(\/grant)?$/);
    if (packageMatch) {
      const detail = state.packages.find((entry) => entry.id === packageMatch[1]);
      if (!detail) return json(route, { details: null, error: 'Package not found.', ok: false }, 404);
      if (packageMatch[2] && method === 'GET') {
        if (state.grantMode === 'not-configured') return json(route, { details: { code: 'review_origin_not_configured' }, error: 'The review origin is not configured.', ok: false }, 503);
        if (detail.status === 'withdrawn') return json(route, { details: null, error: 'Package not found.', ok: false }, 404);
        return json(route, state.grants?.[detail.id] ?? grantFor(detail));
      }
      if (method === 'GET') return json(route, { ok: true, package: structuredClone(detail) });
      if (method === 'DELETE') {
        if (!canCollaborate()) return notFound(route);
        if (detail.status === 'published') return json(route, { details: null, error: 'A published package cannot be withdrawn.', ok: false }, 409);
        if (state.withdrawConflict) return json(route, { details: null, error: 'A round uses this package, so it cannot be withdrawn.', ok: false }, 409);
        if (detail.status !== 'draft') return json(route, { details: null, error: 'This package was already withdrawn.', ok: false }, 409);
        Object.assign(detail, { status: 'withdrawn', updatedAt: new Date().toISOString() });
        return json(route, { ok: true, package: structuredClone(detail) });
      }
    }

    if (path.startsWith('/links') && !state.canDecide) return notFound(route);
    if (path === '/links' && method === 'GET') return json(route, { links: structuredClone(state.links), ok: true });
    if (path === '/links' && method === 'POST') {
      const stakeholder = state.stakeholders.find((entry) => entry.id === body.stakeholderId);
      let link = state.links.find((entry) => entry.stakeholder.id === stakeholder.id);
      if (!link) {
        link = { expiresAt: null, extendedUntil: null, id: `link-${stakeholder.id}`, involvementActive: false, issuedAt: new Date().toISOString(), lastInvolvementEndedAt: null, lastUsedAt: null, revokedAt: null, stakeholder: { ...stakeholder }, status: 'active' };
        link.expiresAt = daysFromNow(14);
        state.links.push(link);
      }
      return json(route, { link, ok: true, reactivated: false, regenerated: false, token: 'synthetic-once-token', url: 'http://127.0.0.1/app/requirements/synthetic-once-token' }, 201);
    }
    const linkAction = path.match(/^\/links\/([^/]+)\/(revoke|extend)$/);
    if (linkAction && method === 'POST') {
      const link = state.links.find((entry) => entry.id === linkAction[1]);
      if (linkAction[2] === 'revoke') Object.assign(link, { revokedAt: new Date().toISOString(), status: 'revoked' });
      else Object.assign(link, { extendedUntil: body.until, expiresAt: link.involvementActive ? null : body.until });
      return json(route, { link, ok: true });
    }

    // Rounds and plans, read-only. The rounds and plans fixtures answer these routes in full
    // for the specs that need it; here they reflect the simple rows in the scenario.
    if (path === '/rounds' && method === 'GET') {
      const track = url.searchParams.get('track');
      const rounds = (state.rounds ?? [])
        .filter((round) => !track || round.track === track)
        .sort((left, right) => right.number - left.number)
        .map((round) => {
          const pkg = state.packages.find((entry) => entry.id === round.packageId) ?? null;
          return {
            closedAt: round.closedAt ?? null, closedBy: null,
            counts: { required: 0, requiredSubmitted: 0, reviewers: round.reviewersTotal ?? 0, submitted: round.reviewersSubmitted ?? 0 },
            dueAt: round.dueAt ?? null, id: round.id,
            // My open items lists the signed-in person as a reviewer of every open round.
            me: round.status === 'open' ? { reviewerId: `reviewer-me-${round.id}`, submittedAt: null } : null,
            note: '', number: round.number, outcome: round.outcome ?? null, outcomeDirectionId: null, packageId: round.packageId,
            packageVersion: pkg?.version ?? null, publishedAt: round.publishedAt ?? null, publishedBy: null,
            reminder: null, status: round.status, title: pkg?.title ?? '', track: round.track,
          };
        });
      return json(route, { ok: true, rounds, track: track || null });
    }
    if (path === '/plans' && method === 'GET') {
      const track = url.searchParams.get('track');
      const plans = (state.plans ?? []).filter((plan) => !track || plan.track === track).sort((left, right) => right.version - left.version);
      return json(route, { ok: true, plans: structuredClone(plans), track: track || null });
    }
    const planRead = path.match(/^\/plans\/([^/]+)$/);
    if (planRead && method === 'GET') {
      const plan = (state.plans ?? []).find((entry) => entry.id === planRead[1]);
      if (!plan) return json(route, { details: null, error: 'Plan not found.', ok: false }, 404);
      return json(route, { ok: true, plan: { proposedWork: [], ...structuredClone(plan) } });
    }

    return json(route, { error: `Unhandled synthetic requirements request: ${method} ${path}`, ok: false }, 501);
  });

  return {
    calls,
    reviewOrigin,
    // Delivers one event to every held stream, or to the next stream that opens.
    pushEvent(event) {
      if (eventWaiters.length === 0) {
        pendingEvents.push(event);
        return;
      }
      while (eventWaiters.length > 0) eventWaiters.shift()([event]);
    },
    state,
  };
}
