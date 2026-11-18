// More demo data for the marketing screenshots: the AI Workspace chat, a workflow, tickets
// and AI memory. Same story and people as demo-data.js.

import { PEOPLE, PROJECT_ID, PROJECT_NAME } from './demo-data.js';

// --- AI Workspace -------------------------------------------------------------------------

/**
 * A chat on the project, in the shape GET /api/assistant/chats/:chatId returns. Priya asks how
 * to save Sprint 14; Odin says what it will change and asks first, because she asked rather
 * than told. She says yes, and the reply lists the two changes with Undo. Her last request
 * mentions Sam in a comment, which emails him, so that call waits for her to confirm.
 */
export function demoAssistantChat() {
  const at = (minute) => `2026-10-12T14:${String(minute).padStart(2, '0')}:00.000Z`;
  const tool = (callId, label, name) => ({ callId, label, name, ok: true });
  const link = (name, id) => `[${name}](odin://item/${id})`;
  const returns = link('Start a return online', 'story-returns');
  return {
    createdAt: at(38),
    id: 'chat-sprint-14',
    messages: [
      {
        content: 'Sprint 14 ends Friday and Sam is behind on the returns work. What can we move so online returns still go live on Oct 30?',
        createdAt: at(38), id: 'message-ask', role: 'user',
      },
      {
        activity: [
          tool('call-overview', 'Read the project overview', 'odin_project_overview'),
          tool('call-query', 'Ran a query (14 rows)', 'odin_query'),
          tool('call-team', 'Get project team', 'odin_run'),
          tool('call-timeline', 'Get timeline', 'odin_run'),
        ],
        content: [
          `Sprint 14 has 16 of 34 points done with 70% of the sprint gone. At this pace about 11 points won’t finish by Friday, and most of them are in ${returns}.`,
          '',
          'I’ll make two changes:',
          '',
          `1. **Move** ${link('Refund status in order history', 'task-refund-status')} and ${link('Return confirmation email', 'task-return-email')} to Sprint 15. Neither has started, and nothing in the Oct 30 launch waits on them.`,
          `2. **Reassign** ${link('Return reasons and prepaid labels', 'task-return-reasons')} from Sam to Lee Park. Lee has 9 free hours this sprint.`,
          '',
          'The “Online returns live” milestone stays on Oct 30. Shall I go ahead?',
        ].join('\n'),
        createdAt: at(39), id: 'message-plan', role: 'assistant',
      },
      { content: 'Yes, go ahead.', createdAt: at(41), id: 'message-go', role: 'user' },
      {
        activity: [
          tool('call-assign', 'Assign items to sprint', 'odin_run'),
          tool('call-update', 'Updated 1 item', 'odin_update_items'),
          tool('call-timeline-2', 'Get timeline', 'odin_run'),
        ],
        changes: {
          records: [
            { id: 'change-sprint', label: 'Moved 2 items between sprints', status: 'applied', undoable: true },
            { id: 'change-assignee', label: 'Updated "Return reasons and prepaid labels": assignee', status: 'applied', undoable: true },
          ],
          status: 'applied',
          undoneAt: null,
        },
        content: `Done. Sprint 14 is down to 30 points, and the timeline has ${returns} finishing on Oct 16, two weeks before the launch.`,
        createdAt: at(41), id: 'message-done', role: 'assistant',
      },
      { content: 'Let Sam know on the story why it changed.', createdAt: at(46), id: 'message-tell', role: 'user' },
      {
        activity: [tool('call-people', 'List mentionable people', 'odin_run')],
        confirmation: {
          callId: 'call-comment',
          description: 'Add a comment or reply to a project, epic, story, task or ticket through Odin collaboration permissions.',
          label: 'Add a comment',
          name: 'odin_add_comment',
          status: 'pending',
          target: '',
        },
        content: [
          `This comment on ${returns} mentions Sam, so Odin will email him:`,
          '',
          '> @Sam Ortiz Lee has picked up Return reasons and prepaid labels so the returns flow can finish by Oct 16. Refund status and the confirmation email moved to Sprint 15.',
        ].join('\n'),
        createdAt: at(47), id: 'message-comment', role: 'assistant',
      },
    ],
    pending: { callId: 'call-comment', label: 'Add a comment', name: 'odin_add_comment' },
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    run: { id: 'run-comment', status: 'awaiting_confirmation' },
    settings: { allowWebResearch: true },
    title: 'Get Sprint 14 back on track',
    updatedAt: at(47),
  };
}

/** The chat list beside the open chat: a few earlier chats on the project, and one not tied to a project. */
export function demoAssistantChatList(open) {
  const summary = (id, title, createdAt, updatedAt, projectId = PROJECT_ID) => ({ createdAt, id, lastMessagePreview: '', pendingProposalCount: 0, projectId, status: 'completed', title, updatedAt });
  return {
    general: [summary('chat-week', 'What needs me this week?', '2026-10-12T12:55:00.000Z', '2026-10-12T13:02:00.000Z', null)],
    ok: true,
    projects: [{
      chats: [
        { ...summary(open.id, open.title, open.createdAt, open.updatedAt), status: open.run.status },
        summary('chat-steering', 'Status summary for Friday’s steering meeting', '2026-10-09T19:10:00.000Z', '2026-10-09T19:25:00.000Z'),
        summary('chat-dropoff', 'Which stores can take drop-off returns?', '2026-10-08T14:00:00.000Z', '2026-10-08T14:20:00.000Z'),
      ],
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      updatedAt: open.updatedAt,
    }],
    projectsAvailable: [{ id: PROJECT_ID, name: PROJECT_NAME }],
  };
}

// --- Workflows ----------------------------------------------------------------------------

export function demoWorkflow() {
  const state = (key, label, category, extra = {}) => ({ category, initial: false, key, label, requiredFields: [], slaHours: 0, terminal: false, ...extra });
  const move = (key, fromState, toState, extra = {}) => ({ allowedRoles: [], approvalRequired: false, approverRoles: [], fromState, key, requiredFields: [], toState, ...extra });
  return {
    description: 'How stories and tasks move from ready to accepted on the portal relaunch. Store acceptance needs a manager to sign off.',
    id: 'workflow-story',
    itemTypes: ['story', 'task'],
    name: 'Story delivery with store acceptance',
    states: [
      state('ready', 'Ready', 'backlog', { initial: true }),
      state('in_progress', 'In progress', 'active'),
      state('in_review', 'Code review', 'active', { slaHours: 24 }),
      state('acceptance', 'Store acceptance', 'active', { slaHours: 48 }),
      state('done', 'Done', 'done', { terminal: true }),
      state('wont_do', 'Won’t do', 'cancelled', { terminal: true }),
    ],
    status: 'active',
    transitions: [
      move('start', 'ready', 'in_progress'),
      move('submit', 'in_progress', 'in_review'),
      move('request_changes', 'in_review', 'in_progress'),
      move('send_to_store', 'in_review', 'acceptance', { allowedRoles: ['manager'] }),
      move('accept', 'acceptance', 'done', { allowedRoles: ['manager'], approvalRequired: true, approverRoles: ['admin'] }),
      move('reject', 'acceptance', 'in_progress'),
      move('drop', 'ready', 'wont_do', { allowedRoles: ['manager'], approvalRequired: true, approverRoles: ['admin'] }),
    ],
    version: 4,
  };
}

// --- Tickets ------------------------------------------------------------------------------

export function demoTickets() {
  const ticket = (id, name, status, severity, category, assignee, updatedAt, extra = {}) => ({
    assigneeName: assignee?.name ?? '', category, externalReviewState: 'not_external', id, lastReopenedAt: null, name,
    priority: { S1: 1, S2: 2, S3: 3, S4: 4 }[severity], projectId: PROJECT_ID, projectName: PROJECT_NAME, reopenCount: 0,
    reporterExternalId: null, severity, status, updatedAt, version: 2, ...extra,
  });
  const { sam, lee, dana, marcus } = PEOPLE;
  return [
    ticket('t-label-ios', 'Return label PDF is blank on iOS Safari', 'new', 'S1', 'defect', null, '2026-10-12T13:40:00.000Z', { externalReviewState: 'pending', lastReopenedAt: '2026-10-12T13:40:00.000Z', reopenCount: 1, reporterExternalId: 'bug-reporter:store-harbor-st' }),
    ticket('t-promo-case', 'Promo codes are rejected when typed in lower case', 'new', 'S2', 'defect', null, '2026-10-12T11:05:00.000Z'),
    ticket('t-store-hours', 'Order email shows last season’s store hours', 'triage', 'S3', 'defect', null, '2026-10-11T16:20:00.000Z', { externalReviewState: 'pending', reporterExternalId: 'bug-reporter:customer-care' }),
    ticket('t-gift-wrap', 'Can customers add gift wrap after ordering?', 'triage', 'S4', 'question', null, '2026-10-11T09:30:00.000Z'),
    ticket('t-tracking-link', 'Tracking link opens the carrier’s home page', 'open', 'S2', 'defect', lee, '2026-10-10T15:00:00.000Z'),
    ticket('t-size-chart', 'Show the size chart on the exchange screen', 'open', 'S3', 'change_request', dana, '2026-10-09T14:10:00.000Z'),
    ticket('t-sso-loop', 'SSO sign-in loops for staff accounts', 'in_progress', 'S1', 'defect', sam, '2026-10-12T10:15:00.000Z'),
    ticket('t-address-format', 'Canadian postal codes fail address validation', 'in_progress', 'S2', 'defect', marcus, '2026-10-11T17:45:00.000Z'),
    ticket('t-reset-email', 'Password reset email lands in spam for some providers', 'in_progress', 'S3', 'support', lee, '2026-10-10T12:00:00.000Z'),
    ticket('t-order-sort', 'Order history sorts by order number, not date', 'resolved', 'S3', 'defect', dana, '2026-10-09T10:30:00.000Z'),
    ticket('t-loyalty-points', 'Loyalty points missing on orders over $500', 'resolved', 'S2', 'defect', marcus, '2026-10-08T16:00:00.000Z'),
    ticket('t-favicon', 'Old logo still shows as the browser tab icon', 'closed', 'S4', 'defect', dana, '2026-10-07T09:00:00.000Z'),
    ticket('t-apple-pay', 'Apple Pay button missing on the cart page', 'new', 'S2', 'defect', null, '2026-10-12T09:20:00.000Z', { projectId: 'p-checkout', projectName: 'Checkout Redesign' }),
    ticket('t-stock-lag', 'Stock counts lag an hour at the Harbor Street store', 'triage', 'S2', 'defect', null, '2026-10-11T08:10:00.000Z', { projectId: 'p-inventory', projectName: 'Store Inventory Sync' }),
    ticket('t-review-photos', 'Review photos load slowly on product pages', 'open', 'S3', 'defect', dana, '2026-10-09T08:00:00.000Z', { projectId: 'p-reviews', projectName: 'Product Reviews and Q&A' }),
    ticket('t-rounding', 'Checkout total rounds down on mixed carts', 'resolved', 'S2', 'defect', marcus, '2026-10-06T16:00:00.000Z', { projectId: 'p-checkout', projectName: 'Checkout Redesign' }),
    ticket('t-welcome-email', 'Duplicate welcome email after sign-up', 'closed', 'S3', 'defect', sam, '2026-10-05T11:00:00.000Z'),
  ];
}

// --- Compliance ---------------------------------------------------------------------------

export function demoWorkspaceUsers() {
  const { priya, sam, lee, dana, marcus, ava } = PEOPLE;
  return [
    ...[priya, marcus].map(({ email, id, name }) => ({ email, id, name, role: 'admin' })),
    ...[sam, lee, dana, ava].map(({ email, id, name }) => ({ email, id, name, role: 'user' })),
    { email: 'casey.nguyen@example.com', id: 'user-casey', name: 'Casey Nguyen', role: 'user' },
    { email: 'drew.callahan@example.com', id: 'user-drew', name: 'Drew Callahan', role: 'user' },
  ];
}

export function demoCompliance() {
  const hash = (seed) => Array.from({ length: 64 }, (_, index) => '0123456789abcdef'[(seed * 7 + index * 13 + (index % 5) * seed) % 16]).join('');
  const months = [['2026-06-01', '2026-07-01', 1642], ['2026-07-01', '2026-08-01', 1918], ['2026-08-01', '2026-09-01', 2207], ['2026-09-01', '2026-10-01', 2486]];
  const exports = months.map(([start, end, recordCount], index) => ({
    contentHash: hash(index + 11), createdAt: `${end}T09:00:00.000Z`, createdBy: PEOPLE.marcus.id, dataRegion: 'us', endAt: `${end}T00:00:00.000Z`,
    id: `export-${index + 1}`, previousExportHash: index ? hash(index + 2) : null, recordCount, retentionUntil: `${Number(end.slice(0, 4)) + 7}${end.slice(4)}T09:00:00.000Z`,
    rootHash: hash(index + 3), startAt: `${start}T00:00:00.000Z`,
  }));
  return {
    controlAttestations: [
      { attestedAt: '2026-10-02T15:00:00.000Z', contentHash: hash(21), controlKey: 'access_review.quarterly', evidenceRefs: ['https://example.com/evidence/access-review-q3'], id: 'attestation-access', ownerUserId: PEOPLE.marcus.id, periodEnd: '2026-09-30', periodStart: '2026-07-01', statement: 'Every workspace member’s access was reviewed; four stale accounts were removed.' },
      { attestedAt: '2026-10-01T12:00:00.000Z', contentHash: hash(22), controlKey: 'legal_hold.weekly_review', evidenceRefs: ['hold-giftcards'], id: 'attestation-holds', ownerUserId: PEOPLE.marcus.id, periodEnd: '2026-09-30', periodStart: '2026-07-01', statement: 'Legal holds were reviewed weekly and every release was approved by counsel.' },
      { attestedAt: '2026-09-28T18:00:00.000Z', contentHash: hash(23), controlKey: 'backup.restore_test', evidenceRefs: ['https://example.com/evidence/restore-test-sep'], id: 'attestation-restore', ownerUserId: PEOPLE.priya.id, periodEnd: '2026-09-30', periodStart: '2026-07-01', statement: 'Restored the September backup to a clean environment and checked 50 sampled records.' },
    ],
    exports,
    legalHolds: [
      { createdAt: '2026-10-06T14:00:00.000Z', createdBy: PEOPLE.marcus.id, id: 'hold-portal', reason: 'Preserve payment processor correspondence for the chargeback review.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: PROJECT_ID, resourceType: 'project', status: 'active', version: 1 },
      { createdAt: '2026-09-15T10:00:00.000Z', createdBy: PEOPLE.marcus.id, id: 'hold-giftcards', reason: 'Keep gift card balances and refunds for the unclaimed-property audit.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: 'p-giftcards', resourceType: 'project', status: 'active', version: 1 },
      { createdAt: '2026-10-01T10:00:00.000Z', createdBy: PEOPLE.priya.id, id: 'hold-export', reason: 'Keep the September audit export for the PCI assessment.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: 'export-4', resourceType: 'audit_export', status: 'active', version: 1 },
      { createdAt: '2026-09-22T10:00:00.000Z', createdBy: PEOPLE.marcus.id, id: 'hold-casey', reason: 'Hold a former associate’s records until the employment claim closes.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: 'user-casey', resourceType: 'privacy_subject', status: 'active', version: 1 },
      { createdAt: '2026-09-03T10:00:00.000Z', createdBy: PEOPLE.priya.id, id: 'hold-export-aug', reason: 'Keep the August export for the external SOC 2 auditor.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: 'export-3', resourceType: 'audit_export', status: 'active', version: 1 },
      { createdAt: '2026-08-11T10:00:00.000Z', createdBy: PEOPLE.marcus.id, id: 'hold-inventory', reason: 'Preserve vendor change orders ahead of the contract renewal.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: 'p-inventory', resourceType: 'project', status: 'active', version: 1 },
      { createdAt: '2026-07-20T10:00:00.000Z', createdBy: PEOPLE.marcus.id, id: 'hold-catalog', reason: 'Supplier dispute over catalog photography rights.', releaseReason: 'Dispute settled; counsel approved the release.', releasedAt: '2026-09-02T10:00:00.000Z', releasedBy: PEOPLE.marcus.id, resourceId: 'p-catalog', resourceType: 'project', status: 'released', version: 2 },
    ],
    ok: true,
    policy: { auditRetentionDays: 730, createdAt: '2026-07-01T00:00:00.000Z', dataRegion: 'us', legalHold: false, privacyDeletionDays: 30, tenantId: 'tenant-synthetic', updatedAt: '2026-09-01T12:00:00.000Z', updatedBy: PEOPLE.marcus.id, version: 3, wormRetentionDays: 2555 },
    privacyRequests: [
      { completedAt: null, completedBy: null, createdAt: '2026-10-08T09:00:00.000Z', id: 'privacy-casey', reason: 'Verified request from a former store associate.', requestedBy: PEOPLE.marcus.id, result: null, status: 'pending', subjectUserId: 'user-casey', version: 1 },
      { completedAt: '2026-09-12T09:00:00.000Z', completedBy: PEOPLE.marcus.id, createdAt: '2026-09-04T09:00:00.000Z', id: 'privacy-drew', reason: 'Contractor asked to be forgotten at the end of the engagement.', requestedBy: PEOPLE.priya.id, result: { anonymizedRecords: 214 }, status: 'completed', subjectUserId: 'user-drew', version: 2 },
    ],
  };
}

// --- AI memory ----------------------------------------------------------------------------

export function demoMemories() {
  const base = {
    confidence: 1, createdBy: PEOPLE.priya.id, deletedAt: null, expiresAt: null, freshnessAt: null, legalHold: false,
    projectId: PROJECT_ID, retentionPolicyId: null, sensitivity: 'internal', version: 1,
  };
  const memory = (id, day, memoryType, title, content, extra = {}) => ({
    ...base, content, createdAt: `2026-10-${day}T14:00:00.000Z`, id, memoryType, provenance: { sourceType: 'person' },
    sourceAt: `2026-10-${day}T14:00:00.000Z`, title, ...extra,
  });
  return [
    memory('memory-returns-labels', '10', 'decision', 'Returns launch with prepaid labels first', 'Store drop-off waits for the point-of-sale upgrade in each store. Agreed at the Oct 10 steering meeting; prepaid labels go live on Oct 30.', { confidence: 0.95, provenance: { sourceId: 'D-14', sourceType: 'decision_register', sourceUrl: 'https://example.com/decisions/D-14' } }),
    memory('memory-carrier-limit', '09', 'fact', 'Carrier tracking API limit', 'The carrier allows 600 tracking calls a minute per account. Last year’s holiday peak reached 520.', { confidence: 0.9, provenance: { sourceId: 'risk-carrier', sourceType: 'governance_item' } }),
    memory('memory-applied', '08', 'outcome', 'Approved assistant changes', 'Approved and applied assistant changes:\n- sprint_items_move: CSV export of past orders to Sprint 15', { freshnessAt: '2026-10-08T14:00:00.000Z', provenance: { sourceId: 'session-31', sourceType: 'approved_assistant_run' } }),
    memory('memory-price-range', '07', 'decision', 'Customers see a price range before booking', 'Show a price range before tax on the booking home screen; confirm the exact price, with tax, before payment.', { provenance: { sourceId: 'topic-price', sourceType: 'requirements_topic' } }),
    memory('memory-stores', '06', 'fact', 'Stores on the new point-of-sale system', '9 of 14 stores run the new point-of-sale system as of Oct 1. The rest upgrade by Nov 20.', { confidence: 0.85 }),
    memory('memory-contract', '05', 'fact', 'Payment processor contract terms', 'The signed processor agreement is evidence in the chargeback review. Do not summarize or share outside the finance team.', { createdBy: PEOPLE.marcus.id, legalHold: true, provenance: { sourceId: 'case-12', sourceType: 'legal_case' }, retentionPolicyId: 'case-12', sensitivity: 'confidential', version: 3 }),
    memory('memory-summaries', '04', 'preference', 'Prefers short status summaries', 'Keep weekly status summaries to five bullet points, with risks first.', { projectId: null }),
    memory('memory-retro-13', '03', 'episode', 'Sprint 13 retro: review wait time', 'Code reviews waited two days on average. The team agreed to a daily review slot at 2 pm.', { provenance: { sourceType: 'retrospective' } }),
    memory('memory-peak', '02', 'fact', 'Holiday traffic peak', 'Black Friday traffic last year was 7.5 times a normal Saturday, peaking at 11 am Eastern.', { confidence: 0.8, provenance: { sourceType: 'analytics_export' } }),
    memory('memory-retro-12', '01', 'episode', 'Sprint 12 retro: design handoff', 'Stories with a design link and agreed copy before planning finished 30% faster.', { provenance: { sourceType: 'retrospective' } }),
  ];
}
