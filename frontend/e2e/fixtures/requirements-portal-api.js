// Synthetic stakeholder portal and guided-review API for browser acceptance (U7). One
// "world" holds the round, the reviewers' verdicts, answers and marks, and the portal's
// questions; every page that installs a handler shares it, so two browser contexts see each
// other's work through the held event streams, as the real portal does (AC-18). Shapes
// follow backend/src/modules/requirements/requirements-portal.service.js and
// rounds/review.service.js. All people and text here are synthetic.

import { crc32, deflateSync } from 'node:zlib';
import { FIELDWORK_MANIFEST, REVIEW_ORIGIN, installStandInReviewOrigin } from './requirements-api.js';
import { syntheticProject } from './synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';
const PROJECT_ID = syntheticProject.id;
const NOW = Date.now();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const daysFromNow = (days) => new Date(NOW + days * 86_400_000).toISOString();

export const PORTAL_TOKENS = Object.freeze({
  busy: 'link-busy-0001',
  expired: 'link-expired-0001',
  jamie: 'link-jamie-0001',
  missing: 'link-missing-0001',
  ravi: 'link-ravi-0001',
  revoked: 'link-revoked-0001',
});

const ACTORS = {
  jamie: { key: 'jamie', name: 'Jamie Ortiz', ref: 'person:jamie', roleTitle: 'Client services', stakeholderId: 'stakeholder-jamie', type: 'stakeholder' },
  ravi: { key: 'ravi', name: 'Ravi Shah', ref: 'person:ravi', roleTitle: 'Finance', stakeholderId: 'stakeholder-ravi', type: 'stakeholder' },
  team: { key: 'team', name: 'Synthetic Demo', ref: 'user:user-synthetic', type: 'user' },
};

/** The package for round 2: the fieldwork example plus a multi-choice question. */
export function reviewManifest() {
  const manifest = structuredClone(FIELDWORK_MANIFEST);
  const questions = manifest.sections.find((section) => section.type === 'questions');
  questions.items.splice(3, 0, {
    id: 'reminder-channels',
    kind: 'multi',
    options: [{ id: 'sms', label: 'Text message' }, { id: 'email', label: 'Email' }, { id: 'call', label: 'Phone call' }],
    prompt: 'Which reminder channels do clients use?',
  });
  return manifest;
}

const style = (color = '#0369a1') => ({ color, stroke: 3 });

function portalComment({ authorName, actorType = 'stakeholder', body, children = [], createdAt, id, isMine = false, parentCommentId = null, upvotes = 0 }) {
  return { actorType, authorName, body, children, createdAt, currentReaction: null, deletedAt: null, downvotes: 0, editedAt: null, id, isDeleted: false, isMine, parentCommentId, source: 'comment', updatedAt: createdAt, upvotes };
}

function portalTopics() {
  const base = { commentsOpen: true, createdAt: minutesAgo(5000), decision: null, lastActivityAt: minutesAgo(60), rationale: '', settles: '', state: 'open', status: 'open', summaryStatus: { lastAttemptAt: minutesAgo(30), lastAttemptStatus: 'ok', refreshPending: false }, updatedAt: minutesAgo(60) };
  return [
    {
      ...base,
      assignmentRole: 'collaborator',
      comments: [
        portalComment({ authorName: 'Jamie Ortiz', body: 'Estimates should come from the job type and how long it usually takes.', createdAt: minutesAgo(900), id: 'pc-1', upvotes: 1 }),
        portalComment({
          authorName: 'Ravi Shah',
          body: 'Agreed, but someone has to own the rate table. Finance can, if it lives in the billing service.',
          children: [portalComment({ actorType: 'user', authorName: 'Alex Kim', body: 'The billing service already has rates per job type.', createdAt: minutesAgo(400), id: 'pc-3', parentCommentId: 'pc-2' })],
          createdAt: minutesAgo(800),
          id: 'pc-2',
          isMine: true,
          upvotes: 2,
        }),
      ],
      id: 'topic-price-calc',
      isAssignedToMe: true,
      prompt: 'How do price estimates get calculated, and by which service?',
      summary: {
        createdAt: minutesAgo(30),
        id: 'summary-price-calc',
        lastAttemptAt: minutesAgo(30),
        lastAttemptStatus: 'ok',
        output: {
          aligned: [{ sources: ['comment:pc-1', 'comment:pc-2'], statement: 'Estimates come from job type and duration.', supporterNames: ['Jamie Ortiz', 'Ravi Shah'] }],
          divergent: [{ issue: 'Who maintains the rate table.', positions: [{ actorNames: ['Ravi Shah'], sources: ['comment:pc-2'], summary: 'Finance, inside the billing service.' }, { actorNames: ['Alex Kim'], sources: ['comment:pc-3'], summary: 'The billing service already has it.' }] }],
          insufficientInput: false,
          outstanding: [{ blocking: false, item: 'Confirm the billing service can store estimates.', suggestedOwnerRole: 'Engineering' }],
          proposedAnswer: '',
          proposedPreferences: [],
          underExplored: [{ area: 'Estimates for jobs nobody has priced before.', suggestedQuestion: 'How do we estimate a job type with no history?', why: 'Nobody has raised it.' }],
        },
        scopeId: 'topic-price-calc',
        scopeType: 'topic',
        status: 'ok',
      },
      track: 'architecture',
    },
    {
      ...base,
      assignmentRole: 'primary',
      comments: [portalComment({ actorType: 'user', authorName: 'Alex Kim', body: 'We keep payment records for seven years today.', createdAt: minutesAgo(300), id: 'pc-10' })],
      id: 'topic-refunds',
      isAssignedToMe: true,
      prompt: 'What data must we keep for refunds and disputes, and for how long?',
      summary: { createdAt: minutesAgo(200), id: 'summary-refunds', lastAttemptAt: minutesAgo(200), lastAttemptStatus: 'ok', output: { aligned: [], divergent: [], insufficientInput: true, outstanding: [], proposedAnswer: '', proposedPreferences: [], underExplored: [] }, scopeId: 'topic-refunds', scopeType: 'topic', status: 'ok' },
      track: 'architecture',
    },
    {
      ...base,
      assignmentRole: null,
      comments: [],
      id: 'topic-reminders',
      isAssignedToMe: false,
      prompt: 'Which reminder channel do clients prefer?',
      summary: null,
      track: 'experience',
    },
    {
      ...base,
      assignmentRole: null,
      comments: [portalComment({ actorType: 'user', authorName: 'Morgan Lee', body: 'Round 1 verdicts all kept booking first.', createdAt: minutesAgo(5000), id: 'pc-20' })],
      decision: { decidedAt: daysFromNow(-3), decidedBy: { name: 'Morgan Lee' }, id: 'decision-home', outcome: 'agreed', statement: 'Booking is the first task on the home screen.' },
      id: 'topic-home',
      isAssignedToMe: false,
      prompt: 'Is booking the first task on the home screen?',
      state: 'decided',
      status: 'resolved',
      summary: null,
      track: 'experience',
    },
    {
      ...base,
      assignmentRole: 'collaborator',
      comments: [],
      decision: { decidedAt: daysFromNow(-5), decidedBy: { name: 'Sam Patel' }, id: 'decision-stripe', outcome: 'decided', statement: 'Payments stay on Fieldwork’s existing Stripe account.' },
      id: 'topic-payments',
      isAssignedToMe: true,
      prompt: 'Which payment provider do we use?',
      state: 'decided',
      status: 'resolved',
      summary: null,
      track: 'architecture',
    },
  ];
}

function priorAnnotation(overrides) {
  return {
    anchor: {},
    author: 'jamie',
    category: null,
    createdAt: minutesAgo(120),
    deletedAt: null,
    elementHint: null,
    number: 1,
    packageVersion: 3,
    roundId: 'round-2',
    screenId: 'booking-home',
    shapes: [{ number: 1, schemaVersion: 1, style: style('#0369a1'), type: 'pin', x: 300, y: 330 }],
    snapshotFileId: null,
    stateKey: null,
    status: 'open',
    updatedAt: minutesAgo(120),
    ...overrides,
  };
}

/**
 * A fresh world. Options: `roundStatus` ('open' | 'closed'), `withOutdated` (an outdated
 * mark of Ravi's from round 1), `entryUrls` (screen id → URL, for a real review origin),
 * `previousAnswers` (Ravi's round-1 answers by question id).
 */
export function createReviewWorld({ entryUrls = null, previousAnswers = true, roundStatus = 'open', withOutdated = true } = {}) {
  const manifest = reviewManifest();
  const world = {
    annotations: [
      priorAnnotation({ id: '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a01' }),
      ...(withOutdated ? [priorAnnotation({
        author: 'ravi',
        createdAt: minutesAgo(9000),
        id: '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a02',
        number: 2,
        packageVersion: 2,
        roundId: 'round-1',
        shapes: [{ h: 120, schemaVersion: 1, style: style('#c2410c'), type: 'box', w: 300, x: 720, y: 380 }],
        status: 'outdated',
      })] : []),
    ],
    answers: { jamie: {}, ravi: {}, team: {} },
    calls: [],
    channels: new Set(),
    comments: [
      { annotationId: '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a01', author: 'jamie', body: 'The Book a visit button should be bigger.', createdAt: minutesAgo(118), deletedAt: null, editedAt: null, id: 'ac-1', parentCommentId: null },
      ...(withOutdated ? [{ annotationId: '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a02', author: 'ravi', body: 'The price card was missing on version 2.', createdAt: minutesAgo(8990), deletedAt: null, editedAt: null, id: 'ac-2', parentCommentId: null }] : []),
    ],
    entryUrls,
    failures: [],
    linkRequests: 0,
    manifest,
    package: { id: 'package-3', title: manifest.title, version: 3 },
    portal: {
      link: { expiresAt: '2026-10-31T17:00:00.000Z', extendedUntil: '2026-10-31T17:00:00.000Z', id: 'link-1', involvementActive: false },
      project: { id: PROJECT_ID, name: 'Fieldwork' },
      topics: portalTopics(),
    },
    previousAnswers: previousAnswers ? { ravi: { 'before-tax': { answeredAt: minutesAgo(9000), packageVersion: 2, roundId: 'round-1', roundNumber: 1, text: 'Yes', value: 'yes' } } } : {},
    rounds: {
      'round-1': { closedAt: daysFromNow(-6), dueAt: daysFromNow(-8), id: 'round-1', note: '', number: 1, packageVersion: 2, publishedAt: daysFromNow(-14), status: 'closed', title: 'Client booking, booking first', track: 'experience' },
      'round-2': { closedAt: roundStatus === 'closed' ? daysFromNow(-1) : null, dueAt: daysFromNow(3), id: 'round-2', note: 'We tried a price range on the home screen after your feedback in round 1. Please check whether it would prevent the disputes you described.', number: 2, packageVersion: 3, publishedAt: daysFromNow(-1), publishedBy: { name: 'Morgan Lee' }, status: roundStatus, title: manifest.title, track: 'experience' },
    },
    reviewers: {
      jamie: { position: null, submittedAt: null },
      ravi: { position: null, submittedAt: null },
      team: { position: null, submittedAt: null },
    },
    snapshots: new Map(),
    stances: { jamie: {}, ravi: {}, team: {} },
    verdicts: { jamie: {}, ravi: {}, team: {} },
  };
  world.failNext = (method, pattern, status = 503, body = { error: 'Service unavailable.', ok: false }) => {
    world.failures.push({ body, method, pattern, status });
  };
  world.callsTo = (method, pattern) => world.calls.filter((call) => call.method === method && pattern.test(call.path));
  return world;
}

// ---------------------------------------------------------------------------
// Presenting the world
// ---------------------------------------------------------------------------

function screensOf(world) {
  return world.manifest.sections.find((section) => section.type === 'screens').items;
}

function questionsOf(world) {
  return world.manifest.sections.find((section) => section.type === 'questions').items;
}

// A test marks a question `removed` (its topic deleted or dismissed); like the server, it is
// listed but takes no answers, shows none, and counts nowhere.
function askedQuestionsOf(world) {
  return questionsOf(world).filter((question) => !question.removed);
}

const QUESTION_REMOVED_BODY = Object.freeze({
  details: { code: 'question_removed', message: 'This question has been removed and no longer needs an answer.' },
  error: 'This question has been removed and no longer needs an answer.',
  ok: false,
});

function directionsOf(world) {
  return world.manifest.sections.find((section) => section.type === 'directions').items;
}

function entryUrl(world, screen) {
  return world.entryUrls?.[screen.id] ?? `${REVIEW_ORIGIN}/p/${world.package.id}/grant-synthetic/${screen.src}`;
}

function snapshotPath(audience, { roundId, snapshotId, token }) {
  return audience === 'portal'
    ? `/api/public/requirements/${token}/rounds/${roundId}/snapshots/${snapshotId}`
    : `/api/projects/${PROJECT_ID}/requirements/rounds/${roundId}/snapshots/${snapshotId}`;
}

function presentComment(world, comment, viewer) {
  return {
    authorName: ACTORS[comment.author].name,
    authorRef: ACTORS[comment.author].ref,
    body: comment.deletedAt ? '' : comment.body,
    createdAt: comment.createdAt,
    deletedAt: comment.deletedAt,
    editedAt: comment.editedAt,
    id: comment.id,
    isDeleted: Boolean(comment.deletedAt),
    isMine: comment.author === viewer.key,
    parentCommentId: comment.parentCommentId,
  };
}

function presentAnnotation(world, annotation, { audience, round, token, viewer }) {
  const isMine = annotation.author === viewer.key;
  const open = round.status === 'open';
  const inRound = annotation.roundId === round.id;
  return {
    actions: {
      carry: open && !inRound && annotation.status === 'outdated' && isMine,
      changeStatus: open && inRound && isMine,
      close: open && !inRound && annotation.status === 'outdated' && isMine,
      comment: open,
      delete: open && inRound && isMine,
      edit: open && inRound && isMine,
    },
    anchor: annotation.anchor ?? {},
    authorName: ACTORS[annotation.author].name,
    authorRef: ACTORS[annotation.author].ref,
    carriedFromRoundId: annotation.carriedFromRoundId ?? null,
    category: annotation.category,
    color: annotation.shapes?.[0]?.style?.color ?? null,
    createdAt: annotation.createdAt,
    elementHint: annotation.elementHint,
    id: annotation.id,
    isMine,
    number: annotation.number,
    packageVersion: annotation.packageVersion,
    roundId: annotation.roundId,
    roundNumber: world.rounds[annotation.roundId]?.number ?? null,
    screenId: annotation.screenId,
    shapes: structuredClone(annotation.shapes),
    snapshotFileId: annotation.snapshotFileId,
    snapshotUrl: annotation.snapshotFileId ? snapshotPath(audience, { roundId: round.id, snapshotId: annotation.snapshotFileId, token }) : null,
    stateKey: annotation.stateKey,
    status: annotation.status,
    statusChangedAt: null,
    thread: world.comments.filter((comment) => comment.annotationId === annotation.id).map((comment) => presentComment(world, comment, viewer)),
    updatedAt: annotation.updatedAt,
  };
}

function answerText(question, value) {
  const label = (id) => question.options?.find((option) => option.id === id)?.label ?? id;
  if (question.kind === 'single') return label(value);
  if (question.kind === 'multi') return value.map(label).join(', ');
  if (question.kind === 'scale') return `${value} on a ${question.scale.min}-${question.scale.max} scale`;
  return String(value);
}

function validateAnswer(question, value) {
  const ids = (question.options ?? []).map((option) => option.id);
  if (question.kind === 'single') return typeof value === 'string' && ids.includes(value);
  if (question.kind === 'multi') return Array.isArray(value) && value.length > 0 && value.every((entry) => ids.includes(entry)) && new Set(value).size === value.length;
  if (question.kind === 'text') return typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;
  if (question.kind === 'scale') return Number.isInteger(value) && value >= question.scale.min && value <= question.scale.max;
  return false;
}

function progressOf(world, actorKey) {
  const part = (items, done) => ({ done: items.filter(done).length, total: items.length });
  const progress = {
    directions: part(directionsOf(world), (direction) => Boolean(world.stances[actorKey][direction.id])),
    questions: part(askedQuestionsOf(world), (question) => Boolean(world.answers[actorKey][question.id])),
    screens: part(screensOf(world), (screen) => Boolean(world.verdicts[actorKey][screen.id])),
  };
  progress.done = progress.directions.done + progress.screens.done + progress.questions.done;
  progress.total = progress.directions.total + progress.screens.total + progress.questions.total;
  return progress;
}

function visibleAnnotations(world, round) {
  const screenIds = new Set(screensOf(world).map((screen) => screen.id));
  return world.annotations.filter((annotation) => !annotation.deletedAt && (annotation.roundId === round.id || (annotation.status === 'outdated' && screenIds.has(annotation.screenId) && world.rounds[annotation.roundId]?.number < round.number)));
}

export function reviewState(world, { actorKey, audience, roundId, token = '' }) {
  const round = world.rounds[roundId];
  const viewer = ACTORS[actorKey];
  const reviewer = world.reviewers[actorKey];
  return {
    annotations: visibleAnnotations(world, round).map((annotation) => presentAnnotation(world, annotation, { audience, round, token, viewer })),
    answers: Object.fromEntries(askedQuestionsOf(world).filter((question) => world.answers[actorKey][question.id]).map((question) => [question.id, structuredClone(world.answers[actorKey][question.id])])),
    directions: structuredClone(world.stances[actorKey]),
    grant: { expiresAt: daysFromNow(1) },
    me: { actorRef: viewer.ref, canModerate: false, canSubmit: round.status === 'open', isReviewer: true, name: viewer.name, position: reviewer.position, required: true, submittedAt: reviewer.submittedAt },
    ok: true,
    package: { feedbackDimensions: (world.manifest.feedbackDimensions ?? []).map((key) => ({ help: '', key, label: { behavior: 'Behavior', branding: 'Branding', color: 'Color', density: 'Density & spacing', hierarchy: 'Hierarchy & navigation', type: 'Type & size' }[key] ?? key })), id: world.package.id, manifest: structuredClone(world.manifest), title: world.package.title, version: world.package.version },
    previousAnswers: structuredClone(world.previousAnswers[actorKey] ?? {}),
    progress: progressOf(world, actorKey),
    questions: questionsOf(world).map((question) => ({ help: question.help ?? '', id: question.id, kind: question.kind, options: question.options ?? [], prompt: question.prompt, removed: Boolean(question.removed), scale: question.scale ?? null, topicId: question.topicId ?? null })),
    round: { ...round, readOnly: round.status !== 'open' },
    screens: screensOf(world).map((screen) => ({
      alt: screen.alt, change: screen.id === 'booking-home' ? 'changed' : screen.id === 'booking-flow' ? 'unchanged' : 'new', changeNote: screen.changeNote ?? '', directionId: screen.directionId ?? null,
      entryUrl: entryUrl(world, screen), height: screen.height ?? null, kind: screen.kind, rationale: screen.rationale ?? '', screenId: screen.id, states: screen.states ?? [], title: screen.title, viewport: screen.viewport ?? null, width: screen.width ?? null,
    })),
    verdicts: structuredClone(world.verdicts[actorKey]),
  };
}

function portalRounds(world, actorKey) {
  return Object.values(world.rounds).map((round) => ({
    closedAt: round.closedAt, dueAt: round.dueAt, id: round.id, note: round.note, number: round.number, packageVersion: round.packageVersion,
    progress: round.id === 'round-2' ? progressOf(world, actorKey) : { directions: { done: 0, total: 0 }, done: 3, questions: { done: 1, total: 1 }, screens: { done: 2, total: 2 }, total: 3 },
    publishedAt: round.publishedAt, publishedBy: round.publishedBy, required: true, status: round.status, submittedAt: round.id === 'round-2' ? world.reviewers[actorKey].submittedAt : daysFromNow(-7), title: round.title, track: round.track,
  })).sort((left, right) => (left.status === right.status ? right.number - left.number : left.status === 'open' ? -1 : 1));
}

function portalHome(world, actorKey) {
  const topics = world.portal.topics.map(({ comments, ...topic }) => ({ ...topic, commentCount: countComments(comments) }));
  return {
    decisions: world.portal.topics.filter((topic) => topic.decision).map((topic) => ({ ...topic.decision, topicId: topic.id, topicPrompt: topic.prompt, track: topic.track })).sort((left, right) => right.decidedAt.localeCompare(left.decidedAt)),
    link: { ...world.portal.link },
    ok: true,
    project: { ...world.portal.project },
    stakeholder: { id: ACTORS[actorKey].stakeholderId, name: ACTORS[actorKey].name, roleTitle: ACTORS[actorKey].roleTitle },
    topics: {
      assigned: topics.filter((topic) => topic.isAssignedToMe),
      decided: topics.filter((topic) => !topic.isAssignedToMe && topic.state === 'decided'),
      open: topics.filter((topic) => !topic.isAssignedToMe && topic.state !== 'decided'),
    },
  };
}

function countComments(comments = []) {
  return comments.reduce((total, comment) => total + (comment.isDeleted ? 0 : 1) + countComments(comment.children ?? []), 0);
}

function findPortalComment(comments, id) {
  for (const comment of comments) {
    if (comment.id === id) return comment;
    const child = findPortalComment(comment.children ?? [], id);
    if (child) return child;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Events: a held stream per page that delivers what the world publishes
// ---------------------------------------------------------------------------

function publish(world, type, data) {
  for (const channel of world.channels) channel.push({ data, type });
}

function createChannel(world) {
  const channel = { queue: [], waiters: [] };
  channel.push = (event) => {
    channel.queue.push(event);
    const waiter = channel.waiters.shift();
    if (waiter) waiter();
  };
  channel.next = () => new Promise((resolve) => {
    if (channel.queue.length) {
      resolve(channel.queue.splice(0));
      return;
    }
    const timer = setTimeout(() => {
      const index = channel.waiters.indexOf(done);
      if (index >= 0) channel.waiters.splice(index, 1);
      resolve([]);
    }, 15_000);
    function done() {
      clearTimeout(timer);
      // Let a burst of writes land in one delivery.
      setTimeout(() => resolve(channel.queue.splice(0)), 50);
    }
    channel.waiters.push(done);
  });
  world.channels.add(channel);
  return channel;
}

async function holdStream(route, channel) {
  const events = await channel.next();
  const frames = [{ data: { linkId: 'link-1' }, type: 'connected' }, ...events]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`).join('');
  try {
    await route.fulfill({ body: frames, contentType: 'text/event-stream', status: 200 });
  } catch {
    // The page closed while the stream was held.
  }
}

// ---------------------------------------------------------------------------
// Review routes (shared by the portal and the team)
// ---------------------------------------------------------------------------

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, status });
}

function blankPng(width, height) {
  const chunk = (type, data) => {
    const tagged = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tagged));
    return Buffer.concat([length, tagged, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 0xff);
  for (let row = 0; row < height; row += 1) rows[row * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function readPng(buffer) {
  if (!buffer || buffer.length < 33) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) };
}

function nextNumber(world, roundId, screenId) {
  return world.annotations.filter((annotation) => annotation.roundId === roundId && annotation.screenId === screenId).reduce((max, annotation) => Math.max(max, annotation.number), 0) + 1;
}

function numberPins(shapes, number) {
  return shapes.map((shape) => (shape.type === 'pin' ? { ...shape, number } : shape));
}

async function handleReview(world, route, { actorKey, audience, rest, roundId, token }) {
  const request = route.request();
  const method = request.method();
  const round = world.rounds[roundId];
  const viewer = ACTORS[actorKey];
  if (!round) return json(route, { error: 'Round not found.', ok: false }, 404);
  const contentType = request.headers()['content-type'] ?? '';
  let body = null;
  if (method !== 'GET' && method !== 'DELETE' && !contentType.startsWith('image/')) {
    try {
      body = request.postDataJSON() ?? {};
    } catch {
      body = {};
    }
  }
  world.calls.push({ actor: actorKey, audience, body, method, path: rest });
  const failure = world.failures.find((entry) => entry.method === method && entry.pattern.test(rest));
  if (failure) {
    world.failures.splice(world.failures.indexOf(failure), 1);
    return json(route, failure.body, failure.status);
  }
  const notify = (data, type = 'requirements.review.updated') => publish(world, type, { roundId, ...data });
  const presented = (annotation) => presentAnnotation(world, annotation, { audience, round, token, viewer });

  if (method === 'GET' && rest === '') return json(route, reviewState(world, { actorKey, audience, roundId, token }));
  if (method === 'GET' && rest.startsWith('/snapshots/')) {
    const snapshot = world.snapshots.get(decodeURIComponent(rest.slice('/snapshots/'.length)));
    if (!snapshot) return json(route, { error: 'Snapshot not found.', ok: false }, 404);
    return route.fulfill({ body: snapshot.bytes, contentType: 'image/png', status: 200 });
  }
  const mentionablesMatch = /^\/annotations\/([^/]+)\/mentionables$/.exec(rest);
  if (method === 'GET' && mentionablesMatch) {
    // The portal gets opaque person refs; the team gets actor refs.
    const people = Object.values(ACTORS).filter((actor) => actor.key !== actorKey).map((actor) => ({
      detail: actor.type === 'stakeholder' ? 'Stakeholder' : 'Team',
      kind: actor.type === 'stakeholder' ? 'stakeholder' : 'team',
      name: actor.name,
      ref: audience === 'portal' || actor.type !== 'stakeholder' ? actor.ref : `stakeholder:${actor.stakeholderId}`,
    }));
    return json(route, { ok: true, people });
  }
  if (round.status !== 'open') return json(route, { details: { code: 'round_closed' }, error: 'This round is closed. Its feedback is read-only.', ok: false }, 409);

  let match;
  if (method === 'PUT' && rest === '/position') {
    world.reviewers[actorKey].position = body;
    return json(route, { ok: true, position: body });
  }
  if ((match = /^\/directions\/([^/]+)$/.exec(rest))) {
    const id = decodeURIComponent(match[1]);
    if (method === 'PUT') world.stances[actorKey][id] = { remix: body.remix || undefined, stance: body.stance, updatedAt: new Date().toISOString() };
    else delete world.stances[actorKey][id];
    notify({});
    return json(route, { direction: world.stances[actorKey][id] ?? null, directionId: id, ok: true, progress: progressOf(world, actorKey) });
  }
  if ((match = /^\/screens\/([^/]+)\/verdict$/.exec(rest))) {
    const id = decodeURIComponent(match[1]);
    if (method === 'PUT') {
      const allowed = new Set(world.manifest.feedbackDimensions);
      if (Object.keys(body.dimensions ?? {}).some((key) => !allowed.has(key))) return json(route, { details: { code: 'dimension_invalid' }, error: 'Rate only this package’s feedback dimensions.', ok: false }, 400);
      world.verdicts[actorKey][id] = { ...(body.change ? { change: body.change } : {}), dimensions: { ...(body.dimensions ?? {}) }, ...(body.mixed ? { mixed: body.mixed } : {}), overall: body.overall, ...(body.stay ? { stay: body.stay } : {}), updatedAt: new Date().toISOString() };
    } else {
      delete world.verdicts[actorKey][id];
    }
    notify({ screenId: id });
    return json(route, { ok: true, progress: progressOf(world, actorKey), screenId: id, verdict: world.verdicts[actorKey][id] ?? null });
  }
  if ((match = /^\/questions\/([^/]+)\/answer$/.exec(rest))) {
    const id = decodeURIComponent(match[1]);
    const question = questionsOf(world).find((entry) => entry.id === id);
    if (!question) return json(route, { error: 'Question not found.', ok: false }, 404);
    if (question.removed) return json(route, QUESTION_REMOVED_BODY, 409);
    if (method === 'PUT') {
      if (!validateAnswer(question, body.value)) return json(route, { details: { code: 'answer_invalid' }, error: 'That answer doesn’t fit this question.', ok: false }, 400);
      world.answers[actorKey][id] = { postedCommentId: `posted-${id}`, text: answerText(question, body.value), topicId: question.topicId ?? null, updatedAt: new Date().toISOString(), value: body.value };
    } else {
      delete world.answers[actorKey][id];
    }
    notify({});
    return json(route, { answer: world.answers[actorKey][id] ?? null, ok: true, progress: progressOf(world, actorKey), questionId: id });
  }
  if (method === 'POST' && rest.startsWith('/snapshots')) {
    if (!contentType.startsWith('image/png')) return json(route, { details: { code: 'snapshot_type' }, error: 'Send the snapshot as a raw image/png body.', ok: false }, 415);
    // Playwright's WebKit gives a route no body for a Blob, so there the snapshot can't be read:
    // a blank PNG of the frame's size stands in, for the mark to reopen on. The other browsers
    // check the real bytes, and the server's own tests cover the same rule.
    const unseen = !request.postDataBuffer()?.length && request.frame().page().context().browser()?.browserType().name() === 'webkit';
    const bytes = unseen ? blankPng(1280, 800) : request.postDataBuffer();
    const size = readPng(bytes);
    if (!size) return json(route, { details: { code: 'snapshot_invalid' }, error: 'The snapshot is not a PNG image.', ok: false }, 400);
    const query = new URL(request.url()).searchParams;
    const id = `5a5a5a5a-0000-4000-8000-${String(world.snapshots.size + 1).padStart(12, '0')}`;
    world.snapshots.set(id, { bytes, height: size.height, roundId, screenId: query.get('screenId'), stateKey: query.get('stateKey'), width: size.width });
    return json(route, { height: size.height, ok: true, snapshotFileId: id, url: snapshotPath(audience, { roundId, snapshotId: id, token }), width: size.width }, 201);
  }
  if ((match = /^\/annotations\/([^/]+)(\/.*)?$/.exec(rest))) {
    const id = decodeURIComponent(match[1]).toLowerCase();
    const tail = match[2] ?? '';
    if (!UUID.test(id)) return json(route, { details: { code: 'annotation_id_invalid' }, error: 'Annotation ids are client-generated UUIDs.', ok: false }, 400);
    const existing = world.annotations.find((annotation) => annotation.id === id) ?? null;
    if (tail === '' && method === 'PUT') {
      if (existing && existing.author !== actorKey) return json(route, { error: 'Annotation not found.', ok: false }, 404);
      if (existing?.deletedAt && !body.restored) return json(route, { details: { code: 'annotation_deleted' }, error: 'This annotation was deleted.', ok: false }, 409);
      if (!Array.isArray(body.shapes) || !body.shapes.length || body.shapes.some((shape) => shape?.schemaVersion !== 1)) return json(route, { details: { code: 'shapes_invalid' }, error: 'Some marks are not valid.', ok: false }, 400);
      if (body.category && !world.manifest.feedbackDimensions.includes(body.category)) return json(route, { details: { code: 'category_invalid' }, error: 'Use one of this package’s feedback dimensions.', ok: false }, 400);
      const now = new Date().toISOString();
      const fields = { anchor: body.anchor ?? {}, category: body.category || null, elementHint: body.elementHint ?? null, snapshotFileId: body.snapshotFileId ?? null, stateKey: body.stateKey ?? null, updatedAt: now };
      let annotation;
      if (existing) {
        Object.assign(existing, fields, { deletedAt: null, shapes: numberPins(body.shapes, existing.number) });
        annotation = existing;
      } else {
        const number = nextNumber(world, roundId, body.screenId);
        annotation = { ...fields, author: actorKey, createdAt: now, deletedAt: null, id, number, packageVersion: world.package.version, roundId, screenId: body.screenId, shapes: numberPins(body.shapes, number), status: 'open' };
        world.annotations.push(annotation);
      }
      notify({ annotationId: id, screenId: annotation.screenId });
      return json(route, { annotation: presented(annotation), created: !existing, ok: true }, existing ? 200 : 201);
    }
    if (!existing || existing.deletedAt) return json(route, { error: 'Annotation not found.', ok: false }, 404);
    if (tail === '' && method === 'DELETE') {
      existing.deletedAt = new Date().toISOString();
      notify({ annotationId: id, screenId: existing.screenId });
      return json(route, { deleted: { id, number: existing.number, screenId: existing.screenId }, ok: true });
    }
    if (tail === '/status' && method === 'POST') {
      existing.status = body.status;
      notify({ annotationId: id, screenId: existing.screenId });
      return json(route, { annotation: presented(existing), ok: true });
    }
    if (tail === '/carry' && method === 'POST') {
      if (existing.status !== 'outdated') return json(route, { details: { code: 'annotation_not_outdated' }, error: 'Only outdated annotations can be carried forward.', ok: false }, 409);
      existing.carriedFromRoundId = existing.roundId;
      existing.roundId = roundId;
      existing.status = 'carried';
      existing.packageVersion = world.package.version;
      existing.number = nextNumber(world, roundId, existing.screenId);
      existing.shapes = numberPins(existing.shapes, existing.number);
      notify({ annotationId: id, screenId: existing.screenId });
      return json(route, { annotation: presented(existing), ok: true });
    }
    if (tail === '/close' && method === 'POST') {
      if (existing.status !== 'outdated') return json(route, { details: { code: 'annotation_not_outdated' }, error: 'Only outdated annotations can be closed here.', ok: false }, 409);
      existing.status = 'resolved';
      notify({ annotationId: id, screenId: existing.screenId });
      return json(route, { annotation: presented(existing), ok: true });
    }
    if (tail === '/comments' && method === 'POST') {
      const comment = { annotationId: id, author: actorKey, body: body.body, createdAt: new Date().toISOString(), deletedAt: null, editedAt: null, id: `ac-${world.comments.length + 1}-${Date.now().toString(36)}`, parentCommentId: body.parentCommentId || null };
      world.comments.push(comment);
      notify({ annotationId: id, screenId: existing.screenId });
      const annotation = presented(existing);
      return json(route, { annotation, comment: annotation.thread.find((entry) => entry.id === comment.id), ok: true }, 201);
    }
    if ((match = /^\/comments\/([^/]+)$/.exec(tail))) {
      const comment = world.comments.find((entry) => entry.id === decodeURIComponent(match[1]) && entry.annotationId === id);
      if (!comment || comment.author !== actorKey) return json(route, { error: 'Comment not found.', ok: false }, 404);
      if (method === 'PATCH') {
        comment.body = body.body;
        comment.editedAt = new Date().toISOString();
      } else if (method === 'DELETE') {
        comment.deletedAt = new Date().toISOString();
      }
      notify({ annotationId: id, screenId: existing.screenId });
      return json(route, { annotation: presented(existing), ok: true });
    }
  }
  if (method === 'POST' && rest === '/submit') {
    const reviewer = world.reviewers[actorKey];
    reviewer.submittedAt = reviewer.submittedAt ?? new Date().toISOString();
    notify({}, 'requirements.rounds.invalidated');
    return json(route, { ok: true, progress: progressOf(world, actorKey), submittedAt: reviewer.submittedAt });
  }
  return json(route, { error: `Unhandled review call ${method} ${rest}`, ok: false }, 501);
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

const LINK_PROBLEMS = {
  [PORTAL_TOKENS.expired]: { body: { details: { code: 'link_expired', expiredAt: '2026-09-30T17:00:00.000Z', message: 'This link has expired. Ask the project team for a new one.' }, error: 'link_expired', ok: false }, status: 410 },
  [PORTAL_TOKENS.missing]: { body: { details: { code: 'link_not_found' }, error: 'This requirements link is not valid.', ok: false }, status: 404 },
  [PORTAL_TOKENS.revoked]: { body: { details: { code: 'link_revoked', message: 'This link was turned off. Ask the project team for a new one.' }, error: 'link_revoked', ok: false }, status: 410 },
};

/**
 * The stakeholder portal for one page. `actor` is whose link `token` is. Options:
 * `standInOrigin` (default true) serves the example package from the stand-in review origin.
 */
export async function installPortalApi(page, world, { actor = 'ravi', standInOrigin = true, token = PORTAL_TOKENS.ravi } = {}) {
  if (standInOrigin) await installStandInReviewOrigin(page);
  let busyOnce = true;
  // One buffer per page: events published while the stream reconnects arrive on the next one.
  let channel = null;
  page.on('close', () => {
    if (channel) world.channels.delete(channel);
  });
  await page.route(`${API_ORIGIN}/api/public/requirements/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = /^\/api\/public\/requirements\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return route.fallback();
    const linkToken = decodeURIComponent(match[1]);
    const rest = match[2] ?? '';
    const method = request.method();

    if (rest === '/link-request' && method === 'POST') {
      world.calls.push({ actor, method, path: rest });
      if (linkToken === PORTAL_TOKENS.revoked) return json(route, LINK_PROBLEMS[linkToken].body, 410);
      world.linkRequests += 1;
      return json(route, world.linkRequests > 1 ? { alreadyRequested: true, ok: true } : { ok: true });
    }
    if (LINK_PROBLEMS[linkToken]) return json(route, LINK_PROBLEMS[linkToken].body, LINK_PROBLEMS[linkToken].status);
    if (linkToken === PORTAL_TOKENS.busy && busyOnce) {
      busyOnce = false;
      return json(route, { details: { code: 'rate_limited', retryAfterSeconds: 2, scope: 'link' }, error: 'rate_limited', ok: false }, 429);
    }
    const actorKey = linkToken === PORTAL_TOKENS.jamie ? 'jamie' : linkToken === token ? actor : 'ravi';

    if (rest === '/events' && method === 'GET') {
      channel = channel ?? createChannel(world);
      return holdStream(route, channel);
    }
    if (rest === '' && method === 'GET') return json(route, portalHome(world, actorKey));
    if (rest === '/rounds' && method === 'GET') return json(route, { ok: true, rounds: portalRounds(world, actorKey) });

    let found;
    if ((found = /^\/rounds\/([^/]+)(\/.*)?$/.exec(rest))) {
      return handleReview(world, route, { actorKey, audience: 'portal', rest: found[2] ?? '', roundId: decodeURIComponent(found[1]), token: linkToken });
    }

    if ((found = /^\/topics\/([^/]+)(\/.*)?$/.exec(rest))) {
      const topic = world.portal.topics.find((entry) => entry.id === decodeURIComponent(found[1]));
      if (world.portal.removedTopicIds?.has(decodeURIComponent(found[1]))) return json(route, QUESTION_REMOVED_BODY, 404);
      if (!topic) return json(route, { error: 'Question not found.', ok: false }, 404);
      const tail = found[2] ?? '';
      const view = () => ({ ...structuredClone(topic), commentCount: countComments(topic.comments) });
      let body = {};
      if (['POST', 'PATCH'].includes(method)) {
        try { body = request.postDataJSON() ?? {}; } catch { body = {}; }
      }
      world.calls.push({ actor: actorKey, body, method, path: rest });
      if (tail === '' && method === 'GET') return json(route, { ok: true, topic: view() });
      if (tail === '/mentionables' && method === 'GET') {
        const people = Object.values(ACTORS).filter((actor) => actor.key !== actorKey).map((actor) => ({
          detail: actor.type === 'stakeholder' ? 'Stakeholder' : 'Team',
          kind: actor.type === 'stakeholder' ? 'stakeholder' : 'team',
          name: actor.name,
          ref: actor.ref,
        }));
        return json(route, { ok: true, people });
      }
      if (tail === '/comments' && method === 'POST') {
        if (!topic.commentsOpen) return json(route, { details: { code: 'comments_closed' }, error: 'Comments are closed for this question.', ok: false }, 409);
        const comment = portalComment({ authorName: ACTORS[actorKey].name, body: body.body, createdAt: new Date().toISOString(), id: `pc-new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, isMine: true, parentCommentId: body.parentCommentId || null });
        if (body.parentCommentId) findPortalComment(topic.comments, body.parentCommentId)?.children.push(comment);
        else topic.comments.push(comment);
        publish(world, 'requirements.topics.invalidated', { reason: 'topic-commented', topicIds: [topic.id] });
        return json(route, { comment, ok: true, topic: view() }, 201);
      }
      let commentMatch;
      if ((commentMatch = /^\/comments\/([^/]+)(\/vote)?$/.exec(tail))) {
        const comment = findPortalComment(topic.comments, decodeURIComponent(commentMatch[1]));
        if (!comment) return json(route, { error: 'Comment not found.', ok: false }, 404);
        if (commentMatch[2]) {
          comment.currentReaction = comment.currentReaction === body.vote ? null : body.vote;
          comment.upvotes += body.vote === 'up' ? 1 : 0;
        } else if (method === 'PATCH') {
          if (!comment.isMine) return json(route, { error: 'Comment not found.', ok: false }, 404);
          comment.body = body.body;
          comment.editedAt = new Date().toISOString();
        } else if (method === 'DELETE') {
          if (!comment.isMine) return json(route, { error: 'Comment not found.', ok: false }, 404);
          comment.isDeleted = true;
          comment.deletedAt = new Date().toISOString();
          comment.body = '';
        }
        publish(world, 'requirements.topics.invalidated', { reason: 'topic-comment', topicIds: [topic.id] });
        return json(route, { ok: true, topic: view() });
      }
      // There is no route that changes a question's status: stakeholders can't (Q-04).
      return json(route, { error: 'Not found.', ok: false }, 404);
    }
    return json(route, { error: `Unhandled portal call ${method} ${rest}`, ok: false }, 501);
  });
}

const MENTION = /@\[([^\]\n]{1,120})\]\((user|stakeholder|person):([A-Za-z0-9_-]{1,64})\)/g;

/** The team's Marks and comments view of a round (GET /rounds/:id/annotations), from the same world. */
function marksView(world, roundId) {
  const round = world.rounds[roundId];
  const screens = screensOf(world);
  const order = new Map(screens.map((screen, index) => [screen.id, index]));
  const annotations = world.annotations
    .filter((annotation) => !annotation.deletedAt && annotation.roundId === round.id)
    .sort((left, right) => (order.get(left.screenId) - order.get(right.screenId)) || (left.number - right.number))
    .map((annotation) => {
      const thread = world.comments
        .filter((comment) => comment.annotationId === annotation.id && !comment.deletedAt)
        .map((comment, index) => ({ authorName: ACTORS[comment.author].name, authorRef: ACTORS[comment.author].ref, body: comment.body, createdAt: comment.createdAt, id: comment.id, label: `C${index + 1}`, parentCommentId: comment.parentCommentId }));
      const participants = new Map();
      const add = (ref, name, role) => {
        const entry = participants.get(ref) ?? { name, ref, roles: [] };
        if (!entry.roles.includes(role)) entry.roles.push(role);
        participants.set(ref, entry);
      };
      add(ACTORS[annotation.author].ref, ACTORS[annotation.author].name, 'posted');
      for (const comment of thread) add(comment.authorRef, comment.authorName, 'commented');
      for (const comment of thread) for (const [, label, kind, id] of comment.body.matchAll(MENTION)) add(`${kind}:${id}`, label, 'tagged');
      return {
        authorName: ACTORS[annotation.author].name,
        authorRef: ACTORS[annotation.author].ref,
        category: annotation.category ?? null,
        categoryLabel: '',
        color: annotation.shapes?.[0]?.style?.color ?? null,
        createdAt: annotation.createdAt,
        elementText: annotation.elementHint?.text ?? '',
        id: annotation.id,
        labels: [],
        lastActivityAt: [annotation.createdAt, ...thread.map((comment) => comment.createdAt)].sort().at(-1),
        note: '',
        number: annotation.number,
        participants: [...participants.values()],
        screenId: annotation.screenId,
        shapes: structuredClone(annotation.shapes),
        snapshotUnavailable: Boolean(annotation.anchor?.snapshotUnavailable),
        snapshotUrl: annotation.snapshotFileId ? snapshotPath('team', { roundId, snapshotId: annotation.snapshotFileId }) : null,
        stateKey: annotation.stateKey ?? null,
        stateLabel: '',
        status: annotation.status,
        thread,
      };
    });
  return {
    annotations,
    notes: [],
    ok: true,
    round: { id: round.id, number: round.number, status: round.status, title: round.title },
    screens: screens.map((screen) => ({ height: screen.height ?? null, imageUrl: screen.kind === 'image' ? entryUrl(world, screen) : null, kind: screen.kind, screenId: screen.id, title: screen.title, viewport: screen.viewport ?? null, width: screen.width ?? null })),
  };
}

/** The team review API for a signed-in member, on top of installRequirementsApi(), with the round's Marks and comments view. */
export async function installTeamReviewApi(page, world, { actor = 'team', liveEvents = false } = {}) {
  const base = `/api/projects/${PROJECT_ID}/requirements/rounds/`;
  await page.route(`${API_ORIGIN}${base}**`, async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/projects\/[^/]+\/requirements\/rounds\/([^/]+)(\/review(\/.*)?|\/snapshots\/[^/]+|\/annotations)$/.exec(url.pathname);
    if (!match) return route.fallback();
    const roundId = decodeURIComponent(match[1]);
    if (match[2] === '/annotations') return json(route, marksView(world, roundId));
    const rest = match[2].startsWith('/review') ? match[3] ?? '' : match[2];
    return handleReview(world, route, { actorKey: actor, audience: 'team', rest, roundId });
  });
  if (liveEvents) {
    let channel = null;
    page.on('close', () => {
      if (channel) world.channels.delete(channel);
    });
    await page.route(`${API_ORIGIN}/api/projects/${PROJECT_ID}/events`, (route) => {
      channel = channel ?? createChannel(world);
      return holdStream(route, channel);
    });
  }
}

/** A prototype whose bridge cannot take snapshots (for the capture-failed path). */
export async function installCaptureFailingPrototype(page, { path = '/stub/booking.html' } = {}) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Canvas prototype</title></head>
<body style="margin:0;font-family:sans-serif"><main data-odin-id="canvas-board" style="display:grid;place-items:center;height:800px;background:#e6edf7">A canvas-drawn booking board</main>
<script>
(function () {
  var state = { key: 'choose-service', declared: true, path: 'stub/booking.html', hash: '' };
  function post(message) { message.source = 'odin-review-bridge'; message.version = 1; parent.postMessage(message, '*'); }
  function ready() { post({ type: 'ready', state: state, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: 1 }, scroll: { x: 0, y: 0, width: innerWidth, height: 800 } }); }
  addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};
    if (data.type === 'ping') ready();
    if (data.type === 'capture') post({ type: 'capture-failed', requestId: data.requestId, reason: 'This prototype draws on a canvas the snapshot cannot read.' });
    if (data.type === 'hint') post({ type: 'hint', requestId: data.requestId, x: data.x, y: data.y, hint: null });
    if (data.type === 'goto-state') { state = { key: data.key, declared: true, path: state.path, hash: '#' + data.key }; post({ type: 'state', key: state.key, declared: true, path: state.path, hash: state.hash }); }
  });
  ready();
})();
</script></body></html>`;
  await page.route(`${REVIEW_ORIGIN}${path}*`, (route) => route.fulfill({ body: html, contentType: 'text/html; charset=utf-8', status: 200 }));
  return `${REVIEW_ORIGIN}${path}`;
}

export { ACTORS as REVIEW_ACTORS, PROJECT_ID as REVIEW_PROJECT_ID };

// ---------------------------------------------------------------------------
// Browser helpers for the guided review specs
// ---------------------------------------------------------------------------

const TOOL_LABELS = { arrow: 'Arrow', box: 'Box', highlight: 'Highlight', pen: 'Pen', pin: 'Pin a comment', text: 'Text label' };

// The page can still be moving when a test starts drawing: Bootstrap sets `scroll-behavior:
// smooth` on :root, so Playwright's own scroll-into-view for the toolbar click animates. A
// point measured during that animation is stale by the time a raw page.mouse event goes out
// (on a phone it then lands on the sections below the screen). So taps and drag starts go
// through locator actions, which re-check the scene's position and wait for it to be stable
// right before they dispatch.

function sceneLocator(page) {
  return page.locator('.annotation-canvas__scene').first();
}

async function sceneOffset(page, x, y) {
  const box = await sceneLocator(page).boundingBox();
  return { x: box.width * x, y: box.height * y };
}

/** Taps (clicks) the scene at fractions of its size, as a reviewer would. */
export async function tapScene(page, x, y) {
  await sceneLocator(page).click({ position: await sceneOffset(page, x, y) });
}

/** Drags across the scene from one fraction point to another. */
export async function dragScene(page, from, to, { steps = 4 } = {}) {
  const scene = sceneLocator(page);
  // hover() scrolls the point into view and waits until the scene stops moving.
  await scene.hover({ position: await sceneOffset(page, from[0], from[1]) });
  const box = await scene.boundingBox();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps });
  await page.mouse.up();
}

/** A point on the scene in page coordinates, for checks that need one; draw with tapScene or dragScene. */
export async function scenePoint(page, x, y) {
  const box = await sceneLocator(page).boundingBox();
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}

/**
 * Draws one mark with the toolbar. `from` and `to` are fractions of the scene. Text labels
 * type `text` and commit with Escape. Returns after the new mark's thread opened.
 */
export async function drawMark(page, tool, from, to = from, { text = 'before tax?' } = {}) {
  await page.getByRole('toolbar', { name: 'Annotation tools' }).getByRole('button', { name: TOOL_LABELS[tool], exact: true }).click();
  if (tool === 'pin' || tool === 'text') await tapScene(page, from[0], from[1]);
  else await dragScene(page, from, to, { steps: tool === 'pen' ? 12 : 4 });
  if (tool === 'text') {
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
  }
}

/** Closes the open thread popover, if any, with Escape from inside it. */
export async function closeThread(page) {
  const thread = page.getByTestId('rq-annotation-thread');
  if (await thread.count()) {
    await thread.first().focus();
    await page.keyboard.press('Escape');
  }
}
