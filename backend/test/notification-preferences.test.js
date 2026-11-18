import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { materializeGoalEvent } from '../src/modules/assistant/agent-monitors.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { LINK_REQUEST_TEMPLATE_ID, MENTION_TEMPLATE_ID } from '../src/modules/mail/mail.templates.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import {
  allowsEmailNotification,
  findEmailOptOuts,
  readUserPreferencesMysql,
} from '../src/modules/users/notification-preferences.js';
import { createRequirementsTestApp } from './helpers/requirements-test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const saved = (values) => ({ notificationPrefsVersion: 1, twoFactorEnabled: false, ...values });

test('preferences only switch email off once the current profile form saved them', () => {
  assert.equal(allowsEmailNotification(undefined, 'mentions'), true, 'unset keeps sending');
  assert.equal(allowsEmailNotification({}, 'mentions'), true);
  // The old form stored every box unchecked without anyone choosing that.
  assert.equal(allowsEmailNotification({ emailNotifMentions: false }, 'mentions'), true);
  assert.equal(allowsEmailNotification(saved({ emailNotifMentions: false }), 'mentions'), false);
  assert.equal(allowsEmailNotification(saved({ emailNotifMentions: true }), 'mentions'), true);
  assert.equal(allowsEmailNotification(saved({}), 'mentions'), true, 'a toggle missing from a saved form still sends');
  assert.equal(allowsEmailNotification(saved({ emailNotifTasks: false }), 'attention'), false);
  assert.equal(allowsEmailNotification(saved({ emailNotifTasks: false }), 'mentions'), true);
  assert.equal(allowsEmailNotification(saved({ emailNotifSummaries: false }), 'summaries'), false);
  assert.throws(() => allowsEmailNotification({}, 'digest'), /Unknown email notification kind/);
});

test('MySQL preference lookup reads every recipient in one query', async () => {
  const calls = [];
  const executor = {
    async execute(sql, params) {
      calls.push({ params, sql: sql.replace(/\s+/g, ' ').trim() });
      return [[
        { email: 'Ada@Example.com', id: 'user-1', preferences: JSON.stringify(saved({ emailNotifMentions: false })) },
        { email: 'bea@example.com', id: 'user-2', preferences: null },
        { email: 'cy@example.com', id: 'user-3', preferences: '{not json' },
      ]];
    },
  };
  const optOuts = await findEmailOptOuts({
    emails: ['outside@partner.example'],
    kind: 'mentions',
    read: (query) => readUserPreferencesMysql(executor, query),
    userIds: ['user-1', 'user-2', 'user-3', 'user-1'],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE u\.id IN \(\?, \?, \?\) OR LOWER\(u\.email\) IN \(\?\)/);
  assert.match(calls[0].sql, /p\.`key` = 'user_preferences'/);
  assert.deepEqual(calls[0].params, ['user-1', 'user-2', 'user-3', 'outside@partner.example']);
  assert.deepEqual([...optOuts].sort(), ['ada@example.com', 'user-1']);
  assert.equal((await findEmailOptOuts({ kind: 'mentions', read: (query) => readUserPreferencesMysql(executor, query) })).size, 0);
  assert.equal(calls.length, 1, 'no query when there is nobody to ask about');
});

async function usersWithPreferences(preferencesById) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: 'tenant-1', name: 'Acme' }],
    users: Object.keys(preferencesById).map((id) => ({
      authMethod: 'basic', email: `${id}@acme.com`, id, memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: id, password: 'Secret123!',
    })),
  });
  // A profile save stores the whole preferences object on the user.
  for (const user of authRepository.state.users) user.preferences = { ...user.preferences, ...preferencesById[user.id] };
  return authRepository;
}

test('mention emails skip people who turned them off and still reach everyone else', async () => {
  const authRepository = await usersWithPreferences({
    author: {},
    legacy: { emailNotifMentions: false },
    muted: saved({ emailNotifMentions: false }),
    unset: {},
  });
  const mailRepository = createInMemoryMailRepository();
  const projects = createInMemoryProjectsRepository({
    authRepository,
    mailRepository,
    seed: { projects: [{ epics: [], id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: 'tenant-1' }] },
  });
  const mention = (id) => `<span class="mention" data-user-id="${id}">@${id}</span>`;
  await projects.addComment({
    comment: `<p>${mention('muted')} ${mention('unset')} ${mention('legacy')}</p>`,
    projectId: 'project-1', targetId: 'clarification-1', targetType: 'clarification', tenantId: 'tenant-1', user: { id: 'author' },
  });
  const sent = mailRepository.state.queue.filter((row) => row.templateId === MENTION_TEMPLATE_ID).map((row) => row.recipientEmail).sort();
  assert.deepEqual(sent, ['legacy@acme.com', 'unset@acme.com']);
});

async function goalAttentionMail(preferences) {
  const repository = createInMemoryAgentExecutionRepository();
  const mailRepository = createInMemoryMailRepository();
  const goal = await repository.createGoal({
    constraints: { escalation: { afterRuns: 1, email: true } }, ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Protect launch',
    success: { verifier: { requiredCheckIds: ['governance.no_open_critical_risks'], type: 'project_health.v1' } },
  });
  await repository.createMonitor({
    goalId: goal.id,
    input: { condition: {}, eventType: 'governance.changed', payload: { sessionId: 'session-1' }, title: 'Check critical risks', triggerType: 'event' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });
  const lookups = [];
  await materializeGoalEvent({
    authRepository: {
      async findUserById() { return { email: 'owner@example.com', id: 'user-1' }; },
      async listUserPreferences(query) { lookups.push(query); return [{ email: 'owner@example.com', id: 'user-1', preferences }]; },
    },
    event: { change: { id: 'risk-1' } }, eventId: 'event-risk-1', eventType: 'governance.changed', executionRepository: repository,
    frontendAppUrl: 'https://odin.example/app',
    governanceRepository: { async listSnapshot() { return { dependencies: [], items: [{ id: 'risk-1', impact: 'critical', kind: 'risk', status: 'open', title: 'Launch blocker' }], milestones: [] }; } },
    mailRepository, projectId: 'project-1', projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1' }; } }, tenantId: 'tenant-1',
  });
  return { lookups, notifications: await repository.listNotifications({ goalId: goal.id, tenantId: 'tenant-1' }), queue: mailRepository.state.queue };
}

test('goal attention emails follow the owner’s attention preference; the in-app record is kept either way', async () => {
  const muted = await goalAttentionMail(saved({ emailNotifTasks: false }));
  assert.equal(muted.queue.length, 0);
  assert.equal(muted.notifications.length, 1);
  assert.deepEqual(muted.lookups, [{ emails: [], userIds: ['user-1'] }]);

  const unset = await goalAttentionMail({});
  assert.equal(unset.queue.length, 1);
  assert.equal(unset.queue[0].recipientEmail, 'owner@example.com');
});

test('stakeholder link-request emails skip managers who turned off attention emails', async () => {
  const mail = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository: mail });
  const admin = harness.authRepository.state.users.find((user) => user.id === 'user-tadmin');
  admin.preferences = saved({ emailNotifTasks: false });
  const stakeholder = await harness.seedStakeholder();
  const created = await harness.createLink(stakeholder.id);
  harness.clock.offsetMs = 15 * DAY_MS;
  const requested = await harness.portal(created.token).post('/link-request');
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  const sent = mail.state.queue.filter((row) => row.templateId === LINK_REQUEST_TEMPLATE_ID).map((row) => row.recipientEmail).sort();
  assert.deepEqual(sent, ['user-padmin@acme.com', 'user-pmanager@acme.com', 'user-tmanager@acme.com']);
});
