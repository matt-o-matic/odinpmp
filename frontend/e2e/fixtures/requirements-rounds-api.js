// Synthetic review-rounds API for browser acceptance (U6c). Install it after
// installRequirementsApi(): Playwright runs the most recently registered matching route
// first, so these handlers answer /requirements/rounds and /requirements/my-items and every
// other requirements request falls back to the shared fixture. Response shapes follow
// backend/src/modules/requirements/rounds/rounds.service.js. All people, rounds, and
// feedback here are synthetic.

import { FIELDWORK_MANIFEST, defaultRequirementsScenario, packageDetail } from './requirements-api.js';
import { syntheticProject, syntheticUser } from './synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';
const PROJECT_ID = syntheticProject.id;
const BASE = `/api/projects/${PROJECT_ID}/requirements`;

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const ME = `user:${syntheticUser.id}`;
const PEOPLE = {
  'stakeholder:stakeholder-jamie': { email: 'jamie.ortiz@client.example', name: 'Jamie Ortiz' },
  'stakeholder:stakeholder-noor': { email: 'noor.haddad@client.example', name: 'Noor Haddad' },
  'stakeholder:stakeholder-ravi': { email: 'ravi.shah@client.example', name: 'Ravi Shah' },
  'user:user-alex': { email: 'alex.kim@example.com', name: 'Alex Kim' },
  'user:user-morgan': { email: 'morgan.lee@example.com', name: 'Morgan Lee' },
  [ME]: { email: syntheticUser.email, name: syntheticUser.name },
};

const PRICE_DETAILS_SCREEN = {
  alt: 'Price details panel listing what each service includes.', height: 800, id: 'price-details', kind: 'image', src: 'screens/booking-home-schedule.png', title: 'Price details', width: 1280,
};

/** Round 2's package: the fieldwork manifest (two directions, three screens, four questions) plus a price details screen. */
export function roundTwoManifest() {
  const manifest = structuredClone(FIELDWORK_MANIFEST);
  manifest.title = 'Client booking, booking first';
  const screens = manifest.sections.find((section) => section.type === 'screens');
  screens.items.push(structuredClone(PRICE_DETAILS_SCREEN));
  // The price question links to the synthetic register's price topic.
  manifest.sections.find((section) => section.type === 'questions').items[0].topicId = 'topic-price';
  return manifest;
}

function reviewer({ actorRef, id, mail = { queuedAt: minutesAgo(1440), reason: null, status: 'sent' }, progress = null, required = false, submittedAt = null, lastSeenAt = null, removedAt = null }) {
  const [actorType, actorId] = actorRef.split(':');
  return {
    actorId,
    actorRef,
    actorType,
    email: PEOPLE[actorRef]?.email ?? '',
    id,
    invitedAt: minutesAgo(1440),
    lastSeenAt,
    mail,
    name: PEOPLE[actorRef]?.name ?? (actorType === 'stakeholder' ? 'Stakeholder' : 'Team member'),
    progress,
    remindedAt: null,
    removedAt,
    required,
    submittedAt,
  };
}

const SUMMARY_SOURCES = [
  { annotationId: 'ann-1', available: true, kind: 'annotation', label: '#1', ref: 'annotation:ann-1', screenId: 'booking-home' },
  { annotationId: 'ann-3', available: true, kind: 'annotation', label: '#3', ref: 'annotation:ann-3', screenId: 'booking-home' },
  { annotationId: 'ann-5', available: true, kind: 'annotation', label: '#5', ref: 'annotation:ann-5', screenId: 'booking-home' },
  { annotationId: 'ann-6', available: true, kind: 'annotation', label: '#6', ref: 'annotation:ann-6', screenId: 'booking-home' },
  { annotationId: 'ann-2', available: true, kind: 'comment', label: 'C2', ref: 'comment:c-2', screenId: 'booking-home' },
  { actorRef: 'stakeholder:stakeholder-jamie', available: true, kind: 'verdict', label: 'V1', ref: 'verdict:v-jamie-home', screenId: 'booking-home' },
  { actorRef: 'user:user-alex', available: true, kind: 'verdict', label: 'V3', ref: 'verdict:v-alex-home', screenId: 'booking-home' },
  { available: false, kind: 'annotation', label: null, ref: 'annotation:ann-deleted' },
];

const HOME_SUMMARY = {
  aligned: [
    { sources: ['annotation:ann-1', 'verdict:v-jamie-home', 'verdict:v-alex-home'], statement: 'Keep one primary "Book a visit" action.', supporterNames: ['Jamie Ortiz', 'Alex Kim'], supporters: ['stakeholder:stakeholder-jamie', 'user:user-alex'] },
  ],
  divergent: [{
    issue: 'What sits above the fold on small screens.',
    positions: [
      { actorNames: ['Noor Haddad'], actors: ['stakeholder:stakeholder-noor'], sources: ['annotation:ann-5'], summary: 'The price card first.' },
      { actorNames: ['Jamie Ortiz'], actors: ['stakeholder:stakeholder-jamie'], sources: ['annotation:ann-6', 'annotation:ann-deleted'], summary: 'The upcoming visit first.' },
    ],
  }],
  insufficientInput: false,
  outstanding: [{ blocking: true, item: 'Exact "before tax" wording, owned by Finance.', suggestedOwnerRole: 'Finance' }],
  proposedAnswer: '',
  proposedPreferences: [],
  underExplored: [{ area: 'Contrast of the secondary "See services" button.', suggestedQuestion: 'Is the "See services" button easy enough to see?', why: 'Only Noor marked it.' }],
};

const ROUND_SUMMARY_SOURCES = [
  { actorRef: 'stakeholder:stakeholder-jamie', available: true, directionId: 'action-first', kind: 'direction', label: 'D1', ref: 'verdict:d-jamie-action' },
  { actorRef: 'stakeholder:stakeholder-ravi', available: true, directionId: 'action-first', kind: 'direction', label: 'D2', ref: 'verdict:d-ravi-action' },
  { actorRef: 'user:user-alex', available: true, directionId: 'schedule-first', kind: 'direction', label: 'D3', ref: 'verdict:d-alex-schedule' },
  { actorRef: 'stakeholder:stakeholder-ravi', available: true, kind: 'answer', label: 'Q2', questionId: 'before-tax', ref: 'answer:a-ravi-tax' },
  { annotationId: 'ann-3', available: true, kind: 'annotation', label: '#3', ref: 'annotation:ann-3', screenId: 'booking-home' },
  { annotationId: 'ann-2', available: true, kind: 'comment', label: 'C2', ref: 'comment:c-2', screenId: 'booking-home' },
];

const ROUND_SUMMARY = {
  aligned: [{ sources: ['verdict:d-jamie-action', 'verdict:d-ravi-action'], statement: 'Lead with the "Book a visit" action.', supporterNames: ['Jamie Ortiz', 'Ravi Shah'], supporters: ['stakeholder:stakeholder-jamie', 'stakeholder:stakeholder-ravi'] }],
  divergent: [{
    issue: 'Whether the week calendar belongs on the home screen.',
    positions: [
      { actorNames: ['Alex Kim'], actors: ['user:user-alex'], sources: ['verdict:d-alex-schedule'], summary: 'Yes, schedule first.' },
      { actorNames: ['Ravi Shah'], actors: ['stakeholder:stakeholder-ravi'], sources: ['annotation:ann-3', 'answer:a-ravi-tax'], summary: 'Only behind the action.' },
    ],
  }],
  feedbackThemes: [{ detail: 'Reviewers want the price easier to find on the home screen, under the main action.', sources: ['annotation:ann-3', 'comment:c-2'], theme: 'Price visibility' }],
  insufficientInput: false,
  outstanding: [],
  proposedAnswer: '',
  proposedPreferences: [],
  underExplored: [],
};

// Round 2 in the "Marks and comments" view.
const ROUND_ANNOTATIONS = {
  annotations: [
    { authorName: 'Jamie Ortiz', authorRef: 'stakeholder:stakeholder-jamie', category: null, categoryLabel: '', color: '#c2410c', createdAt: minutesAgo(700), elementText: 'Book a visit', id: 'ann-1', labels: ['Keep this'], note: '', number: 1, participants: [{ name: 'Jamie Ortiz', ref: 'stakeholder:stakeholder-jamie', roles: ['posted'] }], screenId: 'booking-home', stateKey: null, stateLabel: '', status: 'open', thread: [] },
    {
      authorName: 'Alex Kim', authorRef: 'user:user-alex', category: 'hierarchy', categoryLabel: 'Hierarchy & navigation', color: '#2563eb', createdAt: minutesAgo(650), elementText: '', id: 'ann-2', labels: [], note: '', number: 2, participants: [{ name: 'Alex Kim', ref: 'user:user-alex', roles: ['posted', 'commented'] }, { name: 'Ravi Shah', ref: 'stakeholder:stakeholder-ravi', roles: ['commented'] }], screenId: 'booking-home', stateKey: null, stateLabel: '', status: 'open',
      thread: [
        { authorName: 'Alex Kim', authorRef: 'user:user-alex', body: 'The price range gets lost under the calendar.', createdAt: minutesAgo(640), id: 'c-1', label: 'C1', parentCommentId: null },
        { authorName: 'Ravi Shah', authorRef: 'stakeholder:stakeholder-ravi', body: 'Agree, move it under the main action.', createdAt: minutesAgo(600), id: 'c-2', label: 'C2', parentCommentId: 'c-1' },
      ],
    },
    { authorName: 'Ravi Shah', authorRef: 'stakeholder:stakeholder-ravi', category: null, categoryLabel: '', color: '#15803d', createdAt: minutesAgo(620), elementText: '', id: 'ann-3', labels: [], note: 'Week calendar only behind the action', number: 3, participants: [{ name: 'Ravi Shah', ref: 'stakeholder:stakeholder-ravi', roles: ['posted'] }], screenId: 'booking-home', stateKey: 'calendar-open', stateLabel: 'Calendar open', status: 'open', thread: [] },
    { authorName: 'Noor Haddad', authorRef: 'stakeholder:stakeholder-noor', category: null, categoryLabel: '', color: '#7c3aed', createdAt: minutesAgo(610), elementText: '', id: 'ann-5', labels: ['Typo'], note: '', number: 5, participants: [{ name: 'Noor Haddad', ref: 'stakeholder:stakeholder-noor', roles: ['posted'] }], screenId: 'price-details', stateKey: null, stateLabel: '', status: 'resolved', thread: [] },
  ],
  notes: [{ actorRef: 'stakeholder:stakeholder-jamie', change: 'Show the price before the time picker.', name: 'Jamie Ortiz', overall: 'keep-with-changes', screenId: 'booking-home', stay: 'One clear booking button.' }],
};

function verdict(overall, extra = {}) {
  return { dimensions: {}, overall, updatedAt: minutesAgo(600), verdictId: `v-${Math.random().toString(36).slice(2, 8)}`, ...extra };
}

function answer(actorRef, value, text) {
  return { actorRef, name: PEOPLE[actorRef].name, postedCommentId: null, text, updatedAt: minutesAgo(500), value };
}

/** Feedback for round 2: four reviewers have given something; the signed-in manager has not. */
function roundTwoFeedback() {
  return {
    annotationCounts: {
      'booking-flow': { carried: 0, open: 2, outdated: 0, resolved: 0, superseded: 0, total: 2 },
      'booking-home': { carried: 2, open: 4, outdated: 0, resolved: 0, superseded: 0, total: 6 },
      'booking-home-schedule': { carried: 0, open: 5, outdated: 0, resolved: 0, superseded: 0, total: 5 },
      'price-details': { carried: 1, open: 0, outdated: 0, resolved: 0, superseded: 0, total: 1 },
    },
    answers: {
      'before-tax': [answer('stakeholder:stakeholder-ravi', 'yes', 'Yes'), answer('user:user-alex', 'yes', 'Yes')],
      'booking-speed': [answer('stakeholder:stakeholder-jamie', 4, '4 on a 1-5 scale (1 = Slow, 5 = Very quick)')],
      'free-reschedule-notice': [],
      'price-placement': [
        answer('stakeholder:stakeholder-jamie', 'after-time', 'Only after a time is picked'),
        answer('stakeholder:stakeholder-ravi', 'range-on-home', 'A range on the home screen, exact before payment'),
        answer('user:user-alex', 'range-on-home', 'A range on the home screen, exact before payment'),
      ],
    },
    annotationsView: ROUND_ANNOTATIONS,
    commentsPerAnnotation: [3, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    stances: {
      'action-first': [
        { actorRef: 'stakeholder:stakeholder-jamie', stance: 'preferred' },
        { actorRef: 'stakeholder:stakeholder-ravi', stance: 'preferred' },
        { actorRef: 'stakeholder:stakeholder-noor', stance: 'acceptable' },
      ],
      'schedule-first': [
        { actorRef: 'stakeholder:stakeholder-jamie', stance: 'acceptable' },
        { actorRef: 'stakeholder:stakeholder-ravi', remix: "Keep the schedule-first week calendar on the confirm step.", stance: 'rejected' },
        { actorRef: 'user:user-alex', stance: 'preferred' },
        { actorRef: 'stakeholder:stakeholder-noor', remix: 'Keep the week calendar.', stance: 'acceptable' },
      ],
    },
    summaries: {
      round: { current: { createdAt: minutesAgo(20), id: 'summary-round-2', output: ROUND_SUMMARY, sources: ROUND_SUMMARY_SOURCES }, status: { lastAttemptAt: minutesAgo(20), lastAttemptStatus: 'ok', refreshPending: false } },
      screens: {
        'booking-flow': { current: { createdAt: minutesAgo(90), id: 'summary-flow', output: { ...HOME_SUMMARY, aligned: [], divergent: [], insufficientInput: true, outstanding: [], underExplored: [] }, sources: [] }, status: { lastAttemptAt: minutesAgo(90), lastAttemptStatus: 'ok', refreshPending: false } },
        'booking-home': { current: { createdAt: minutesAgo(3), id: 'summary-home', output: HOME_SUMMARY, sources: SUMMARY_SOURCES }, status: { lastAttemptAt: minutesAgo(3), lastAttemptStatus: 'ok', refreshPending: false } },
        'booking-home-schedule': { current: null, status: { lastAttemptAt: null, lastAttemptStatus: null, refreshPending: true } },
        'price-details': { current: null, status: { lastAttemptAt: minutesAgo(30), lastAttemptStatus: 'failed', refreshPending: false } },
      },
    },
    verdicts: {
      'stakeholder:stakeholder-jamie': {
        'booking-flow': verdict('keep'),
        'booking-home': verdict('keep', { dimensions: { hierarchy: 'keep', type: 'keep' }, stay: 'One primary "Book a visit" action.', verdictId: 'v-jamie-home' }),
        'booking-home-schedule': verdict('keep-with-changes', { change: 'Move the week calendar below the action.' }),
        'price-details': verdict('keep'),
      },
      'stakeholder:stakeholder-noor': {
        'booking-home': verdict('change', { change: 'Put the price card above the fold on phones.' }),
        'booking-home-schedule': verdict('keep-with-changes'),
      },
      'stakeholder:stakeholder-ravi': {
        'booking-home': verdict('keep-with-changes', { change: 'Say "before tax" under the price.' }),
        'booking-home-schedule': verdict('change'),
        'price-details': verdict('keep'),
      },
      'user:user-alex': {
        'booking-flow': verdict('undecided', { mixed: 'Fine on desktop; unsure on phones.' }),
        'booking-home': verdict('keep', { verdictId: 'v-alex-home' }),
        'booking-home-schedule': verdict('keep-with-changes'),
        'price-details': verdict('keep-with-changes'),
      },
    },
  };
}

function screensOf(manifest) {
  return manifest.sections.find((section) => section.type === 'screens')?.items ?? [];
}

function directionsOf(manifest) {
  return manifest.sections.find((section) => section.type === 'directions')?.items ?? [];
}

function questionsOf(manifest) {
  return manifest.sections.find((section) => section.type === 'questions')?.items ?? [];
}

const DEFAULT_DIMENSIONS = [
  { help: '', key: 'type', label: 'Type & size' },
  { help: '', key: 'density', label: 'Density & spacing' },
  { help: '', key: 'hierarchy', label: 'Hierarchy & navigation' },
  { help: '', key: 'color', label: 'Color' },
  { help: '', key: 'branding', label: 'Branding' },
  { help: '', key: 'behavior', label: 'Behavior' },
];

export function roundsScenario() {
  const scenario = defaultRequirementsScenario();
  const packageTwo = packageDetail({
    changes: scenario.packages[1].changes,
    createdAt: minutesAgo(3000),
    id: 'package-2',
    manifest: roundTwoManifest(),
    status: 'published',
    version: 2,
  });
  scenario.packages[1] = packageTwo;
  scenario.proposedPreferences = [
    ...scenario.proposedPreferences,
    {
      dimension: 'hierarchy', key: 'summary-home:0', proposedAt: minutesAgo(3), scopeId: 'round-2:booking-home', scopeType: 'screen',
      sources: ['annotation:ann-5', 'verdict:v-jamie-home', 'comment:c-2', 'annotation:ann-1'], stance: 'change', statement: 'Price range says "before tax" and sits under the number.', summaryId: 'summary-home', track: 'experience',
    },
    {
      dimension: 'behavior', key: 'summary-round-2:1', proposedAt: minutesAgo(20), scopeId: 'round-2', scopeType: 'round',
      sources: ['verdict:d-alex-schedule', 'annotation:ann-3'], stance: 'undecided', statement: 'Unavailable time slots: hidden or labeled "fully booked"', summaryId: 'summary-round-2', track: 'experience',
    },
    {
      dimension: 'type', key: 'summary-other:0', proposedAt: minutesAgo(40), scopeId: 'topic-price', scopeType: 'topic',
      sources: ['comment:comment-price-2'], stance: 'keep', statement: 'A preference from a topic, not this round.', summaryId: 'summary-other', track: 'experience',
    },
  ];
  scenario.roundsState = {
    feedback: { 'round-2': roundTwoFeedback() },
    manifests: { 'package-1': null, 'package-2': roundTwoManifest() },
    publishMode: 'ok',
    rounds: [
      {
        closedAt: minutesAgo(4000), closedBy: 'user:user-morgan', dueAt: minutesAgo(4300), id: 'round-1', note: '', number: 1, outcome: 'changes-requested', outcomeDirectionId: null,
        packageId: 'package-1', publishedAt: minutesAgo(8900), publishedBy: 'user:user-morgan', questionTopics: {}, reminder: null, status: 'closed', track: 'experience',
        decision: { decidedAt: minutesAgo(4000), decidedBy: { name: 'Morgan Lee', ref: 'user:user-morgan' }, id: 'decision-round-1', statement: 'Round 1: Changes requested.' },
        reviewers: [
          reviewer({ actorRef: 'stakeholder:stakeholder-jamie', id: 'r1-jamie', submittedAt: minutesAgo(4500) }),
          reviewer({ actorRef: 'stakeholder:stakeholder-ravi', id: 'r1-ravi', submittedAt: minutesAgo(4400) }),
          reviewer({ actorRef: 'user:user-alex', id: 'r1-alex', submittedAt: minutesAgo(4600) }),
        ],
      },
      {
        closedAt: null, closedBy: null, dueAt: daysFromNow(3), id: 'round-2', note: 'Round 2 adds a schedule-first direction. Tell us which one you would use.', number: 2, outcome: null, outcomeDirectionId: null,
        packageId: 'package-2', publishedAt: minutesAgo(1440), publishedBy: 'user:user-morgan', questionTopics: { 'before-tax': 'topic-tax', 'booking-speed': 'topic-speed', 'free-reschedule-notice': 'topic-notice', 'price-placement': 'topic-price' }, reminder: { daysBefore: 2 }, status: 'open', track: 'experience',
        decision: null,
        reviewers: [
          reviewer({ actorRef: 'stakeholder:stakeholder-jamie', id: 'r2-jamie', progress: { done: 9, total: 9 }, required: true, submittedAt: minutesAgo(700) }),
          reviewer({ actorRef: 'stakeholder:stakeholder-ravi', id: 'r2-ravi', progress: { done: 7, total: 9 }, required: true, submittedAt: minutesAgo(650) }),
          reviewer({ actorRef: 'user:user-alex', id: 'r2-alex', progress: { done: 9, total: 9 }, submittedAt: minutesAgo(600) }),
          reviewer({ actorRef: 'stakeholder:stakeholder-noor', id: 'r2-noor', lastSeenAt: minutesAgo(300), mail: { queuedAt: minutesAgo(1440), reason: 'delivery-failed', status: 'failed' }, progress: { done: 3, total: 9 }, required: true }),
          reviewer({ actorRef: ME, id: 'r2-me', progress: { done: 0, total: 9 } }),
        ],
      },
    ],
  };
  return scenario;
}

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function notFound(route, message = 'Not found.') {
  return json(route, { error: message, ok: false }, 404);
}

function conflict(route, code, message, details = {}) {
  return json(route, { details: { code, ...details }, error: message, ok: false }, 409);
}

/**
 * Installs the rounds API over an installed shared fixture. `requirements` is what
 * installRequirementsApi returned; this keeps its overview, packages, topics, decisions,
 * and preferences in step with publishing and closing.
 */
export async function installRequirementsRoundsApi(page, requirements) {
  const base = requirements.state;
  const state = base.roundsState ?? { feedback: {}, manifests: {}, publishMode: 'ok', rounds: [] };
  base.roundsState = state;
  const calls = [];
  let counter = 0;

  const canCollaborate = () => base.projectRole !== 'viewer';
  const packageOf = (round) => base.packages.find((pkg) => pkg.id === round.packageId) ?? null;
  const manifestOf = (round) => state.manifests[round.packageId] ?? packageOf(round)?.manifest ?? { sections: [] };
  const activeReviewers = (round) => round.reviewers.filter((entry) => !entry.removedAt);

  function counts(round) {
    const active = activeReviewers(round);
    return {
      required: active.filter((entry) => entry.required).length,
      requiredSubmitted: active.filter((entry) => entry.required && entry.submittedAt).length,
      reviewers: active.length,
      submitted: active.filter((entry) => entry.submittedAt).length,
    };
  }

  function describe(ref) {
    if (!ref) return null;
    const [type, id] = ref.split(':');
    return { id, name: PEOPLE[ref]?.name ?? 'Team member', ref, type };
  }

  function presentSummary(round) {
    const pkg = packageOf(round);
    const mine = round.reviewers.find((entry) => entry.actorRef === ME && !entry.removedAt) ?? null;
    return {
      closedAt: round.closedAt,
      closedBy: describe(round.closedBy),
      counts: counts(round),
      dueAt: round.dueAt,
      id: round.id,
      me: mine ? { reviewerId: mine.id, submittedAt: mine.submittedAt } : null,
      note: round.note,
      number: round.number,
      outcome: round.outcome,
      outcomeDirectionId: round.outcomeDirectionId,
      packageId: round.packageId,
      packageVersion: pkg?.version ?? null,
      publishedAt: round.publishedAt,
      publishedBy: describe(round.publishedBy),
      reminder: round.reminder,
      status: round.status,
      title: pkg?.title ?? '',
      track: round.track,
    };
  }

  function presentDetail(round) {
    const pkg = packageOf(round);
    const { me, ...summary } = presentSummary(round);
    return {
      ...summary,
      decision: round.decision,
      me,
      package: pkg ? { id: pkg.id, status: pkg.status, title: pkg.title, version: pkg.version } : null,
      questionTopics: round.questionTopics,
      reviewers: structuredClone(round.reviewers),
    };
  }

  function presentResults(round) {
    const manifest = manifestOf(round);
    const feedback = state.feedback[round.id] ?? { annotationCounts: {}, answers: {}, stances: {}, summaries: { round: { current: null, status: null }, screens: {} }, verdicts: {} };
    const reviewers = structuredClone(round.reviewers);
    const gridRefs = [...new Set([...activeReviewers(round).map((entry) => entry.actorRef), ...Object.keys(feedback.verdicts)])];
    const screens = screensOf(manifest);
    return {
      annotationCounts: Object.fromEntries(screens.map((screen) => [screen.id, feedback.annotationCounts[screen.id] ?? { carried: 0, open: 0, outdated: 0, resolved: 0, superseded: 0, total: 0 }])),
      dimensions: DEFAULT_DIMENSIONS,
      directions: directionsOf(manifest).map((direction) => {
        const stances = (feedback.stances[direction.id] ?? []).map((entry) => ({ ...entry, name: PEOPLE[entry.actorRef]?.name ?? 'Reviewer', updatedAt: minutesAgo(500) }));
        return {
          directionId: direction.id,
          remixNotes: stances.filter((entry) => entry.remix).map((entry) => ({ actorRef: entry.actorRef, name: entry.name, remix: entry.remix })),
          stances,
          tallies: {
            acceptable: stances.filter((entry) => entry.stance === 'acceptable').length,
            preferred: stances.filter((entry) => entry.stance === 'preferred').length,
            rejected: stances.filter((entry) => entry.stance === 'rejected').length,
          },
          title: direction.title,
        };
      }),
      grid: gridRefs.map((actorRef) => ({
        actorRef,
        name: PEOPLE[actorRef]?.name ?? 'Reviewer',
        verdicts: Object.fromEntries(Object.entries(feedback.verdicts[actorRef] ?? {}).filter(([screenId]) => screens.some((screen) => screen.id === screenId))),
      })),
      ok: true,
      questions: questionsOf(manifest).map((question) => ({
        answers: structuredClone(feedback.answers[question.id] ?? []),
        kind: question.kind,
        prompt: question.prompt,
        questionId: question.id,
        topicId: round.questionTopics?.[question.id] ?? question.topicId ?? null,
      })),
      reviewers,
      round: (({ me: _me, ...summary }) => summary)(presentSummary(round)),
      screens: screens.map((screen) => ({ directionId: screen.directionId ?? null, kind: screen.kind, screenId: screen.id, title: screen.title })),
      summaries: structuredClone(feedback.summaries),
    };
  }

  function presentAnnotations(round) {
    const view = state.feedback[round.id]?.annotationsView ?? { annotations: [], notes: [] };
    return {
      annotations: structuredClone(view.annotations),
      notes: structuredClone(view.notes),
      ok: true,
      round: (({ me: _me, ...summary }) => summary)(presentSummary(round)),
      screens: screensOf(manifestOf(round)).map((screen) => ({ screenId: screen.id, title: screen.title })),
    };
  }

  function presentFeedback(round) {
    const feedback = state.feedback[round.id];
    const perAnnotation = feedback?.commentsPerAnnotation ?? [];
    return {
      annotations: perAnnotation.map((comments, index) => ({
        actorRef: 'stakeholder:stakeholder-jamie',
        elementHint: null,
        id: `ann-${index + 1}`,
        screenId: 'booking-home',
        shapes: [],
        snapshotUrl: null,
        stateKey: null,
        status: 'open',
        thread: Array.from({ length: comments }, (_, item) => ({ actorRef: 'user:user-alex', body: `Comment ${item + 1}`, createdAt: minutesAgo(400) })),
      })),
      page: { annotationsTotal: perAnnotation.length, limit: 500, nextCursor: null },
      round: { id: round.id, number: round.number, status: round.status, track: round.track },
      schema: 'odin.round-feedback/v1',
    };
  }

  // The shared fixture's overview and topic views read these simpler rows.
  function syncShared() {
    base.rounds = state.rounds.map((round) => {
      const tally = counts(round);
      const mine = round.reviewers.find((entry) => entry.actorRef === ME && !entry.removedAt);
      return {
        dueAt: round.dueAt, id: round.id, number: round.number, packageId: round.packageId, publishedAt: round.publishedAt,
        required: Boolean(mine?.required), reviewersSubmitted: tally.submitted, reviewersTotal: tally.reviewers, status: round.status, track: round.track,
      };
    });
  }
  syncShared();

  function closeRound(round, input) {
    const manifest = manifestOf(round);
    const direction = directionsOf(manifest).find((entry) => entry.id === input.directionId) ?? null;
    if (input.outcome === 'direction-chosen' && !direction) return { error: 'direction_invalid' };
    const text = {
      abandoned: 'Round abandoned.',
      'changes-requested': 'Changes requested.',
      'direction-chosen': `Direction chosen: ${direction?.title}.`,
      'screens-accepted': 'Screens accepted.',
    }[input.outcome];
    const statement = input.statement || `Round ${round.number}: ${text}`;
    const now = new Date().toISOString();
    Object.assign(round, {
      closedAt: now,
      closedBy: ME,
      decision: { decidedAt: now, decidedBy: { name: syntheticUser.name, ref: ME }, id: `decision-round-${round.number}`, statement },
      outcome: input.outcome,
      outcomeDirectionId: direction?.id ?? null,
      status: 'closed',
    });
    base.decisions.push({
      chain: [], decidedAt: now, decidedBy: { id: syntheticUser.id, name: syntheticUser.name, ref: ME, type: 'user' }, id: `decision-round-${round.number}`, kind: 'round',
      outcome: 'decided', preference: null, sources: [`round:${round.id}`], statement, status: 'active', supersededById: null, supersedesId: null, topic: null, topicId: null, track: round.track, version: 1,
    });
    return { error: null };
  }

  function myItems() {
    const decide = !base.canDecide ? [] : [
      ...base.topics.filter((topic) => topic.state === 'ready').map((topic) => ({
        action: 'decide', createdAt: topic.createdAt, id: topic.id, kind: 'topic',
        meta: { evidence: topic.evidence, readySince: topic.fullSummary?.createdAt ?? topic.updatedAt, signals: topic.signals, status: topic.status },
        title: topic.prompt, track: topic.track, updatedAt: topic.updatedAt,
      })),
      ...base.proposedPreferences.filter((proposal) => proposal.scopeType === 'topic').map((proposal) => ({
        action: 'decide', createdAt: proposal.proposedAt, id: proposal.key, kind: 'preference',
        meta: { dimension: proposal.dimension, scopeId: proposal.scopeId, scopeType: proposal.scopeType, sources: proposal.sources, stance: proposal.stance, summaryId: proposal.summaryId },
        title: proposal.statement, track: proposal.track, updatedAt: proposal.proposedAt,
      })),
    ];
    const answer = base.topics
      .filter((topic) => ['open', 'ready'].includes(topic.state))
      .flatMap((topic) => {
        const mine = topic.assignments.find((entry) => entry.actorType === 'user' && entry.actorId === syntheticUser.id);
        return mine ? [{ action: 'reply', createdAt: topic.createdAt, id: topic.id, kind: 'topic', meta: { commentCount: topic.evidence.comments, lastActivityAt: topic.lastActivityAt, role: mine.role, state: topic.state }, title: topic.prompt, track: topic.track, updatedAt: topic.updatedAt }] : [];
      });
    const review = state.rounds.filter((round) => round.status === 'open').flatMap((round) => {
      const mine = round.reviewers.find((entry) => entry.actorRef === ME && !entry.removedAt && !entry.submittedAt);
      return mine ? [{
        action: 'review', createdAt: round.publishedAt, id: round.id, kind: 'round',
        meta: { dueAt: round.dueAt, number: round.number, packageId: round.packageId, required: mine.required }, title: `Round ${round.number}`, track: round.track, updatedAt: round.publishedAt,
      }] : [];
    });
    const drafts = base.packages.filter((pkg) => pkg.status === 'draft').map((pkg) => ({
      action: 'preview', createdAt: pkg.createdAt, id: pkg.id, kind: 'package', meta: { source: pkg.source, version: pkg.version }, title: pkg.title, track: pkg.track, updatedAt: pkg.updatedAt,
    }));
    return {
      canDecide: base.canDecide,
      counts: { answer: answer.length, decide: decide.length, drafts: drafts.length, review: review.length, total: decide.length + answer.length + review.length + drafts.length },
      groups: { answer, decide, drafts, review },
      ok: true,
    };
  }

  await page.route(`${API_ORIGIN}${BASE}/my-items`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    calls.push({ method: 'GET', path: '/my-items' });
    return json(route, myItems());
  });

  await page.route(`${API_ORIGIN}${BASE}/rounds**`, async (route) => {
    try {
      return await handleRounds(route);
    } catch (error) {
      // A fixture bug should fail loudly in the page, not leave the request hanging.
      return json(route, { error: `Synthetic rounds fixture error: ${error.message}`, ok: false }, 500);
    }
  });

  async function handleRounds(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(`${BASE}/rounds`.length) || '/';
    const method = request.method();
    let body = null;
    if (['POST', 'PATCH'].includes(method)) {
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
    }
    calls.push({ body, method, path, search: url.search });
    // Real rounds API calls also show up in the shared call log.
    requirements.calls.push({ body, method, path: `/rounds${path === '/' ? '' : path}`, search: url.search });

    if (path === '/' && method === 'GET') {
      const track = url.searchParams.get('track');
      const listed = state.rounds
        .filter((round) => !track || round.track === track)
        .filter((round) => !(state.listHidesOpenRound && round.status === 'open'))
        .sort((left, right) => right.number - left.number)
        .map(presentSummary);
      return json(route, { ok: true, rounds: listed, track: track || null });
    }

    if (path === '/' && method === 'POST') {
      if (!canCollaborate()) return notFound(route, 'Project not found.');
      if (state.publishDelayMs) await new Promise((resolve) => setTimeout(resolve, state.publishDelayMs));
      const pkg = base.packages.find((entry) => entry.id === body.packageId);
      if (!pkg || pkg.status === 'withdrawn') return notFound(route, 'Package not found.');
      if (pkg.status !== 'draft' || state.publishMode === 'package_not_draft') {
        if (state.publishMode === 'package_not_draft') pkg.status = 'published';
        return conflict(route, 'package_not_draft', 'Only a draft package can be published as a round.', { packageStatus: pkg.status });
      }
      const open = state.rounds.find((round) => round.track === pkg.track && round.status === 'open');
      if (open && !body.closePrevious) return conflict(route, 'round_open', 'A round is already open for this track. Close it before publishing another.', { openRoundId: open.id, openRoundNumber: open.number });
      if (open && !base.canDecide) return notFound(route, 'Project not found.');
      if (state.publishMode === 'reviewer_invalid') {
        return json(route, { details: { actorId: body.reviewers[0]?.actorId, code: 'reviewer_invalid' }, error: 'A reviewer needs member access or above on this project.', ok: false }, 400);
      }
      if (state.publishMode === 'question_topic_missing') return conflict(route, 'question_topic_missing', 'Some questions link to topics that are gone or belong to the other track.', { questionIds: ['price-placement'] });
      if (open) {
        const closed = closeRound(open, body.closePrevious);
        if (closed.error) return json(route, { details: { code: closed.error }, error: "Choose one of the round's directions.", ok: false }, 400);
      }
      pkg.status = 'published';
      const number = Math.max(0, ...state.rounds.filter((round) => round.track === pkg.track).map((round) => round.number)) + 1;
      const questionTopics = {};
      const createdTopicIds = [];
      for (const question of questionsOf(pkg.manifest)) {
        if (question.topicId) {
          questionTopics[question.id] = question.topicId;
          continue;
        }
        const topicId = `topic-from-${pkg.id}-${question.id}`;
        questionTopics[question.id] = topicId;
        createdTopicIds.push(topicId);
        const template = structuredClone(base.topics.find((topic) => topic.id === 'topic-accessibility') ?? base.topics[0]);
        base.topics.push({ ...template, createdAt: new Date().toISOString(), id: topicId, origin: 'package-question', prompt: question.prompt, sourceRef: null, track: pkg.track, updatedAt: new Date().toISOString() });
      }
      const round = {
        closedAt: null, closedBy: null, decision: null, dueAt: body.dueAt ?? null, id: `round-new-${(counter += 1)}`, note: body.note ?? '', number, outcome: null, outcomeDirectionId: null,
        packageId: pkg.id, publishedAt: new Date().toISOString(), publishedBy: ME, questionTopics, reminder: body.reminder ?? null, status: 'open', track: pkg.track,
        reviewers: (body.reviewers ?? []).map((entry, index) => {
          const actorRef = `${entry.actorType}:${entry.actorId}`;
          const noEmail = actorRef === state.reviewerWithoutEmail;
          return reviewer({ actorRef, id: `rv-${counter}-${index}`, mail: noEmail ? { queuedAt: null, reason: 'no-email', status: 'not-sent' } : { queuedAt: new Date().toISOString(), reason: null, status: 'queued' }, progress: { done: 0, total: 9 }, required: entry.required });
        }),
      };
      state.rounds.push(round);
      state.manifests[pkg.id] = pkg.manifest;
      syncShared();
      return json(route, { carryForward: { carried: 2, outdated: 5, superseded: 1 }, createdTopicIds, ok: true, round: presentDetail(round) }, 201);
    }

    const match = path.match(/^\/([^/]+)(\/.*)?$/);
    const round = match ? state.rounds.find((entry) => entry.id === match[1]) : null;
    if (!round) return notFound(route, 'Round not found.');
    const rest = match[2] ?? '';

    if (rest === '' && method === 'GET') return json(route, { canClose: Boolean(base.canDecide) && round.status === 'open', ok: true, round: presentDetail(round) });
    if (rest === '/results' && method === 'GET') return json(route, presentResults(round));
    if (rest === '/feedback' && method === 'GET') return json(route, presentFeedback(round));
    if (rest === '/annotations' && method === 'GET') return json(route, presentAnnotations(round));

    if (rest === '' && method === 'PATCH') {
      if (!canCollaborate()) return notFound(route, 'Project not found.');
      if (round.status !== 'open') return conflict(route, 'round_closed', 'This round is closed. Its feedback is read-only.');
      if (body.dueAt !== undefined) round.dueAt = body.dueAt;
      if (body.note !== undefined) round.note = body.note;
      if (body.reminder !== undefined) round.reminder = body.reminder;
      for (const id of body.removeReviewerIds ?? []) {
        const entry = round.reviewers.find((item) => item.id === id);
        if (entry) entry.removedAt = new Date().toISOString();
      }
      for (const change of body.updateReviewers ?? []) {
        const entry = round.reviewers.find((item) => item.id === change.id);
        if (entry) entry.required = change.required;
      }
      for (const [index, entry] of (body.addReviewers ?? []).entries()) {
        round.reviewers.push(reviewer({ actorRef: `${entry.actorType}:${entry.actorId}`, id: `rv-added-${(counter += 1)}-${index}`, mail: { queuedAt: new Date().toISOString(), reason: null, status: 'queued' }, progress: { done: 0, total: 9 }, required: entry.required }));
      }
      syncShared();
      return json(route, { ok: true, round: presentDetail(round) });
    }

    if (rest === '/close' && method === 'POST') {
      if (!base.canDecide) return notFound(route, 'Project not found.');
      if (round.status !== 'open') return conflict(route, 'round_not_open', 'This round is already closed.');
      const closed = closeRound(round, body);
      if (closed.error) return json(route, { details: { code: closed.error }, error: "Choose one of the round's directions.", ok: false }, 400);
      syncShared();
      return json(route, { decision: { ...round.decision, kind: 'round' }, ok: true, round: presentDetail(round) });
    }

    const resend = rest.match(/^\/reviewers\/([^/]+)\/resend$/);
    if (resend && method === 'POST') {
      if (!canCollaborate()) return notFound(route, 'Project not found.');
      if (round.status !== 'open') return conflict(route, 'round_closed', 'This round is closed. Its feedback is read-only.');
      const entry = round.reviewers.find((item) => item.id === resend[1] && !item.removedAt);
      if (!entry) return notFound(route, 'Reviewer not found.');
      entry.mail = { queuedAt: new Date().toISOString(), reason: null, status: 'queued' };
      const detail = presentDetail(round);
      return json(route, { ok: true, reviewer: detail.reviewers.find((item) => item.id === entry.id), round: detail });
    }

    if (rest === '/summary/refresh' && method === 'POST') {
      if (!canCollaborate()) return notFound(route, 'Project not found.');
      if (state.summaryRefreshMode === 'ai_not_configured') {
        return json(route, { details: { code: 'ai_not_configured', message: 'Odin summaries are not configured on this server.' }, error: 'ai_not_configured', ok: false }, 503);
      }
      const feedback = state.feedback[round.id];
      const scope = body.screenId ? feedback?.summaries?.screens?.[body.screenId] : feedback?.summaries?.round;
      if (scope?.current) scope.current.createdAt = new Date().toISOString();
      if (scope) scope.status = { lastAttemptAt: new Date().toISOString(), lastAttemptStatus: 'ok', refreshPending: false };
      return json(route, { ok: true, outcome: scope?.current ? 'ok' : 'no-input', scopeId: body.screenId ? `${round.id}:${body.screenId}` : round.id, scopeType: body.screenId ? 'screen' : 'round', summaryId: scope?.current?.id ?? null });
    }

    return json(route, { error: `Unhandled synthetic rounds request: ${method} ${path}`, ok: false }, 501);
  }

  return { calls, state, syncShared };
}

