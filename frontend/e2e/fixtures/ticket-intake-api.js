// Synthetic external ticket intake API for browser acceptance: the reporter's public page
// (/api/public/ticket-intake/:token) and the project's intake links. Shapes follow
// backend/src/modules/projects/ticket-intake.service.js and ticket-intake-mail.js. All
// people and text here are synthetic.

import { syntheticProject } from './synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';
const APP_URL = 'http://127.0.0.1/app';
const PROJECT_ID = syntheticProject.id;

export const INTAKE_TOKENS = Object.freeze({ missing: 'intake-missing-0001', valid: 'intake-valid-0001' });

const STATUS_LABELS = { closed: 'Closed', in_progress: 'In Progress', new: 'New', resolved: 'Resolved', triage: 'Triage' };

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function reference(id) {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function ticket(id, name, status, updatedAt) {
  return { category: 'defect', id, name, reference: reference(id), severity: 'S2', status, statusLabel: STATUS_LABELS[status], updatedAt };
}

export function createIntakeWorld() {
  const now = Date.now();
  return {
    invitations: [
      {
        createdAt: new Date(now - 3 * 86_400_000).toISOString(), expiresAt: null, id: 'invitation-ann', intakeToken: INTAKE_TOKENS.valid,
        lastSubmittedAt: null, projectId: PROJECT_ID, replyToken: 'reply-ann', reporterEmail: 'ann.client@example.com',
        reporterName: 'Ann Client', revokedAt: null, submissionCount: 2, url: `${APP_URL}/report/${INTAKE_TOKENS.valid}`,
      },
      {
        createdAt: new Date(now - 9 * 86_400_000).toISOString(), expiresAt: null, id: 'invitation-old', intakeToken: 'intake-old-0001',
        lastSubmittedAt: null, projectId: PROJECT_ID, replyToken: 'reply-old', reporterEmail: 'former@example.com',
        reporterName: '', revokedAt: new Date(now - 86_400_000).toISOString(), submissionCount: 0, url: null,
      },
    ],
    submissions: [],
    tickets: [
      ticket('aaaa1111-0000-4000-8000-000000000001', 'Invoice total ignores the discount', 'in_progress', new Date(now - 2 * 3_600_000).toISOString()),
      ticket('bbbb2222-0000-4000-8000-000000000002', 'Logo is blurry on the login page', 'closed', new Date(now - 5 * 86_400_000).toISOString()),
    ],
  };
}

export async function installTicketIntakeApi(page, world = createIntakeWorld(), { invalidSubmission = false } = {}) {
  await page.route(`${API_ORIGIN}/api/public/ticket-intake/**`, async (route) => {
    const request = route.request();
    const token = decodeURIComponent(new URL(request.url()).pathname.split('/').pop());
    if (token !== INTAKE_TOKENS.valid) return json(route, { error: 'This submission link is not available.', ok: false }, 404);

    if (request.method() === 'GET') {
      return json(route, {
        intake: {
          attachmentLimits: {
            allowedTypes: ['application/pdf', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'text/csv', 'text/plain'],
            maxBytes: 10 * 1024 * 1024,
            maxCount: 5,
            maxTotalBytes: 20 * 1024 * 1024,
          },
          environments: [{ id: 'env-staging', name: 'Staging' }, { id: 'env-production', name: 'Production' }],
          expiresAt: null,
          projectName: syntheticProject.name,
          releases: [{ id: 'release-2-4', name: '2.4.0' }],
          reporterName: 'Ann Client',
          tickets: world.tickets,
        },
        ok: true,
      });
    }

    const body = request.postDataJSON();
    if (invalidSubmission) {
      return json(route, { details: [{ message: 'String must contain at most 200 character(s)', path: 'name' }], error: 'Invalid request payload.', ok: false }, 400);
    }
    world.submissions.push(body);
    const created = ticket('cccc3333-0000-4000-8000-000000000003', body.name, 'new', new Date().toISOString());
    world.tickets = [created, ...world.tickets];
    return json(route, { ok: true, ticket: created }, 201);
  });

  await page.route(`${API_ORIGIN}/api/projects/${PROJECT_ID}/tickets**`, (route) => json(route, { nextCursor: null, ok: true, tickets: [] }));
  // The Tickets tab loads the environment and release choices for its pickers.
  await page.route(`${API_ORIGIN}/api/projects/${PROJECT_ID}/ticket-config`, (route) => json(route, { environments: [], ok: true, releases: [] }));
  await page.route(`${API_ORIGIN}/api/projects/${PROJECT_ID}/ticket-intake-invitations**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return json(route, { invitations: world.invitations, ok: true });
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      const invitation = {
        createdAt: new Date().toISOString(), expiresAt: body.expiresAt ?? null, id: 'invitation-new', intakeToken: 'intake-new-0001',
        lastSubmittedAt: null, projectId: PROJECT_ID, replyToken: 'reply-new', reporterEmail: body.reporterEmail,
        reporterName: body.reporterName ?? '', revokedAt: null, submissionCount: 0, url: `${APP_URL}/report/intake-new-0001`,
      };
      world.invitations = [invitation, ...world.invitations];
      world.created = body;
      return json(route, { email: { recipient: body.reporterEmail, sent: true }, invitation, ok: true, url: invitation.url }, 201);
    }
    if (request.method() === 'DELETE') {
      const id = path.split('/').pop();
      world.invitations = world.invitations.map((entry) => (entry.id === id ? { ...entry, revokedAt: new Date().toISOString(), url: null } : entry));
      return json(route, { ok: true });
    }
    return route.fallback();
  });

  return world;
}
