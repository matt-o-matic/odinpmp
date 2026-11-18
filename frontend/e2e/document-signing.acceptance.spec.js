import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { PORTAL_TOKENS, createReviewWorld, installPortalApi } from './fixtures/requirements-portal-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Document signing: the team shares a file and asks a stakeholder to
// accept it in the vault; the stakeholder signs it in the client portal with an emailed code.
// Synthetic data and a stand-in for the signing routes, registered after the shared fixtures
// so they take precedence; anything else falls through to them.

const API = 'http://localhost:3001';
const PROJECT = syntheticProject.id;
const TOKEN = PORTAL_TOKENS.jamie;
const AT = '2026-11-10T10:00:00.000Z';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const STATEMENT = 'I have reviewed the documents listed here and accept them on behalf of my organization.';
const CONSENT = 'I agree to sign electronically. My typed name and this action have the same effect as my handwritten signature on what is listed here.';

function createWorld({ withRequest = false } = {}) {
  const world = {
    calls: [],
    files: [{
      audience: 'internal', contentType: 'application/pdf', createdAt: AT, description: 'Statement of work', fileName: 'SOW.pdf', fileSize: 2048, id: 'file-sow', links: [],
      projectId: PROJECT, targetId: PROJECT, targetName: null, targetType: 'project', updatedAt: AT, uploadedBy: { id: 'user-synthetic', name: 'Synthetic Demo' }, version: 1, versionNote: '', versionUploadedAt: AT,
    }],
    requests: [],
    stakeholders: [
      { email: 'jamie@client.example', id: 'stakeholder-jamie', name: 'Jamie Ortiz', roleTitle: 'Operations lead' },
      { email: '', id: 'stakeholder-noemail', name: 'Pat No-Email', roleTitle: '' },
    ],
  };
  if (withRequest) {
    world.files[0].audience = 'external';
    world.requests.push(memberRequest(world, { documents: [{ fileId: 'file-sow' }], kind: 'acceptance', signerStakeholderIds: ['stakeholder-jamie'], title: 'Statement of work' }));
  }
  return world;
}

function memberRequest(world, body) {
  const documents = body.documents.map(({ fileId }, position) => {
    const file = world.files.find((entry) => entry.id === fileId);
    return { contentType: file.contentType, fileId, fileName: file.fileName, fileSize: file.fileSize, position, sha256: 'a'.repeat(64), version: file.version };
  });
  return {
    createdAt: AT, createdBy: { id: 'user-synthetic', name: 'Synthetic Demo' }, documents, endReason: null, endedAt: null, endedBy: null,
    events: [{ action: 'requested', actor: { id: 'user:user-synthetic', name: 'Synthetic Demo' }, at: AT, detail: null, signerId: null }],
    id: `request-${world.requests.length + 1}`, kind: body.kind, message: body.message ?? '', packageHash: 'b'.repeat(64), packageValid: true, progress: { signed: 0, total: body.signerStakeholderIds.length }, projectId: PROJECT,
    signers: body.signerStakeholderIds.map((id, index) => {
      const stakeholder = world.stakeholders.find((entry) => entry.id === id);
      return { declinedAt: null, email: stakeholder.email, id: `signer-${index + 1}`, mail: { reason: null, status: 'queued' }, name: stakeholder.name, remindedAt: null, removedAt: null, signedAt: null, stakeholderId: id, status: 'pending' };
    }),
    statement: body.statement || STATEMENT, status: 'pending', subject: { id: documents[0]?.fileId ?? PROJECT, name: documents[0]?.fileName ?? 'Synthetic Project', type: documents.length ? 'file' : 'project' }, title: body.title,
  };
}

function portalRequest(request) {
  const me = request.signers.find((signer) => signer.stakeholderId === 'stakeholder-jamie');
  return {
    createdAt: request.createdAt, documents: request.documents, endReason: request.endReason, endedAt: request.endedAt, id: request.id, kind: request.kind,
    me: me ? { codeSentAt: me.codeSentAt ?? null, status: me.status } : null, message: request.message, packageHash: request.packageHash, progress: request.progress,
    signers: request.signers.map((signer) => ({ declinedAt: signer.declinedAt, isMe: signer === me, name: signer.signedName ?? signer.name, organization: signer.signedOrganization ?? null, signedAt: signer.signedAt, status: signer.status, title: signer.signedTitle ?? null })),
    statement: request.statement, status: request.status, subject: { name: request.subject.name, type: request.subject.type }, title: request.title,
  };
}

async function installSigningApi(page, world) {
  const json = (route, body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
  await page.route(`${API}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    let match;

    if (path === `/api/projects/${PROJECT}/files` && method === 'GET') return json(route, { canWrite: true, files: world.files, ok: true });
    if ((match = /^\/api\/projects\/[^/]+\/files\/([^/]+)\/audience$/.exec(path))) {
      world.calls.push(['audience', match[1], body.audience]);
      const file = world.files.find((entry) => entry.id === match[1]);
      file.audience = body.audience;
      return json(route, { changed: true, file, ok: true });
    }
    if (path === `/api/assistant/projects/${PROJECT}/clarifications`) return json(route, { clarifications: [], stakeholders: world.stakeholders });
    if (path === `/api/projects/${PROJECT}/signing-requests`) {
      if (method === 'GET') return json(route, { canManage: true, ok: true, requests: world.requests });
      world.calls.push(['create', body]);
      const created = memberRequest(world, body);
      world.requests.unshift(created);
      for (const document of created.documents) world.files.find((file) => file.id === document.fileId).audience = 'external';
      return json(route, { ok: true, request: created }, 201);
    }
    if ((match = /^\/api\/projects\/[^/]+\/signing-requests\/([^/]+)(\/.*)?$/.exec(path))) {
      const found = world.requests.find((entry) => entry.id === match[1]);
      const rest = match[2] ?? '';
      if (rest === '/remind') {
        world.calls.push(['remind', body]);
        return json(route, { ok: true, reminded: 1, request: found });
      }
      if (rest === '/cancel') {
        world.calls.push(['cancel', body]);
        Object.assign(found, { endReason: body.reason ?? null, status: 'cancelled' });
        return json(route, { ok: true, request: found });
      }
      return json(route, { canManage: true, ok: true, request: found });
    }

    if ((match = new RegExp(`^/api/public/requirements/${TOKEN}(/.*)$`).exec(path))) {
      const rest = match[1];
      if (rest === '/documents') {
        const requests = world.requests.map(portalRequest);
        return json(route, {
          awaitingMe: requests.filter((entry) => entry.status === 'pending' && entry.me?.status === 'pending').map((entry) => entry.id),
          documents: world.files.filter((file) => file.audience === 'external').map((file) => ({ ...file, requestIds: requests.filter((entry) => entry.documents.some((document) => document.fileId === file.id)).map((entry) => entry.id) })),
          ok: true,
          requests,
        });
      }
      if ((match = /^\/signing\/([^/]+)(\/.*)?$/.exec(rest))) {
        const found = world.requests.find((entry) => entry.id === match[1]);
        const action = match[2] ?? '';
        const me = found.signers.find((signer) => signer.stakeholderId === 'stakeholder-jamie');
        const view = () => ({ consent: { text: CONSENT, version: 'odin-esign-consent-v1' }, disclosure: 'Odin keeps your typed name as evidence of this signature.', ok: true, request: portalRequest(found), signer: { email: 'j****@client.example', name: 'Jamie Ortiz' } });
        if (action === '/code') {
          world.calls.push(['code']);
          me.codeSentAt = new Date().toISOString();
          return json(route, { expiresAt: new Date(Date.now() + 900_000).toISOString(), ok: true, resendAfter: new Date(Date.now() + 60_000).toISOString(), sentTo: 'j****@client.example' });
        }
        if (action === '/sign') {
          world.calls.push(['sign', body]);
          if (body.code !== '123456') return json(route, { details: { code: 'code_invalid', remaining: 4 }, error: 'That code is not right. Check the email and try again.', ok: false }, 400);
          Object.assign(me, { signedAt: new Date().toISOString(), signedName: body.fullName, signedOrganization: body.organization, signedTitle: body.title, status: 'signed' });
          Object.assign(found, { endedAt: new Date().toISOString(), progress: { signed: 1, total: 1 }, status: 'completed' });
          return json(route, view());
        }
        if (action === '/decline') {
          world.calls.push(['decline', body]);
          Object.assign(me, { declinedAt: new Date().toISOString(), status: 'declined' });
          Object.assign(found, { endReason: body.reason ?? null, status: 'declined' });
          return json(route, view());
        }
        if (action === '/certificate') {
          world.calls.push(['certificate']);
          return route.fulfill({ body: '%PDF-1.4 certificate', contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="certificate.pdf"' }, status: 200 });
        }
        if (/^\/documents\/\d+\/content$/.test(action)) {
          world.calls.push(['document', action]);
          return route.fulfill({ body: 'frozen contents', contentType: 'application/pdf', status: 200 });
        }
        return json(route, view());
      }
    }
    return route.fallback();
  });
}

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scrolling').toBeLessThanOrEqual(1);
}

async function expectNoSeriousIssues(page, selector) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include(selector).withTags(WCAG).analyze();
  const serious = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(serious).toEqual([]);
}

test.describe('document signing', () => {
  test('the team shares a file and asks a stakeholder to accept it', async ({ page }) => {
    // A long journey: share, request, remind and withdraw, with an accessibility scan.
    test.setTimeout(60_000);
    const world = createWorld();
    await installSyntheticApi(page);
    await installSigningApi(page, world);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${PROJECT}?projectSettings=files`);

    const panel = page.locator('.project-files');
    const row = panel.locator('.project-files__row').filter({ hasText: 'SOW.pdf' });
    await row.getByRole('button', { name: 'Show versions and links for SOW.pdf' }).click();
    await expect(row.getByText('Internal: only the project team can see it.')).toBeVisible();

    await row.getByRole('button', { name: 'Share with stakeholders' }).click();
    const share = page.getByRole('dialog', { name: 'Share with stakeholders?' });
    await share.getByRole('button', { name: 'Share' }).click();
    await expect(share).toBeHidden();
    await expect(row.getByText('Shared', { exact: true })).toBeVisible();
    expect(world.calls).toContainEqual(['audience', 'file-sow', 'external']);

    await row.getByRole('button', { name: 'Request signatures' }).click();
    const dialog = page.getByRole('dialog', { name: 'Request signatures' });
    await expect(dialog.getByRole('checkbox', { name: /SOW\.pdf/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /Pat No-Email/ })).toBeDisabled();
    await expect(dialog.getByLabel('Title')).toHaveValue('SOW');
    await expect(dialog.getByLabel('What signers agree to')).toHaveValue(STATEMENT);
    await dialog.getByRole('checkbox', { name: /Jamie Ortiz/ }).check();
    await dialog.getByLabel('Title').fill('Statement of work');
    await dialog.getByLabel('Message to signers (optional)').fill('Please sign by Friday.');
    await noHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Send for signature' }).click();

    const created = world.calls.find((call) => call[0] === 'create')[1];
    expect(created).toEqual({ documents: [{ fileId: 'file-sow' }], kind: 'acceptance', message: 'Please sign by Friday.', signerStakeholderIds: ['stakeholder-jamie'], statement: STATEMENT, title: 'Statement of work' });

    const detail = page.getByRole('dialog', { name: 'Statement of work' });
    await expect(detail.getByText('Waiting for signatures')).toBeVisible();
    await expect(detail.locator('strong', { hasText: 'Jamie Ortiz' })).toBeVisible();
    await expect(detail.getByText('Not signed yet')).toBeVisible();
    await expectNoSeriousIssues(page, 'dialog[open]');
    await detail.getByRole('button', { name: 'Remind Jamie Ortiz' }).click();
    await expect(detail.getByText('Reminder sent to Jamie Ortiz.')).toBeVisible();
    expect(world.calls).toContainEqual(['remind', { signerId: 'signer-1' }]);

    await detail.getByRole('button', { name: 'Withdraw request' }).click();
    const confirm = page.getByRole('dialog', { name: 'Withdraw this request?' });
    await confirm.getByLabel('Reason (optional)').fill('Scope changed');
    await confirm.getByRole('button', { name: 'Withdraw request' }).click();
    await expect(detail.getByText('Withdrawn', { exact: true })).toBeVisible();
    expect(world.calls).toContainEqual(['cancel', { reason: 'Scope changed' }]);
  });

  test('a stakeholder signs from the portal with an emailed code', async ({ page }) => {
    const world = createWorld({ withRequest: true });
    await installSyntheticApi(page);
    await installPortalApi(page, createReviewWorld(), { actor: 'jamie', token: TOKEN });
    await installSigningApi(page, world);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`requirements/${TOKEN}`);

    const ask = page.getByTestId('rq-signing-ask');
    await expect(ask.getByRole('heading')).toHaveText('Your signature is needed: Statement of work');
    await expect(page.getByRole('link', { name: 'Documents and signatures' })).toBeVisible();
    await ask.getByRole('link', { name: /Review and sign/ }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Statement of work' })).toBeVisible();
    await expect(page.getByText(STATEMENT)).toBeVisible();
    const documentDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SOW.pdf' }).click();
    expect((await documentDownload).suggestedFilename()).toBe('SOW.pdf');

    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page.getByText(/We sent a 6-digit code to j\*\*\*\*@client\.example/)).toBeVisible();
    await expectNoSeriousIssues(page, '.rq-portal');
    await noHorizontalOverflow(page);

    await page.getByLabel('Code').fill('000000');
    await page.getByLabel('Title (optional)').fill('Operations lead');
    await page.getByLabel(CONSENT).check();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(page.getByText('That code is not right. Check the email and try again.')).toBeVisible();

    await page.getByLabel('Code').fill('123456');
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(page.getByText('Signed. Everyone has now signed, so the certificate is ready.')).toBeVisible();
    await expect(page.getByText('Signed by everyone')).toBeVisible();
    const signed = world.calls.filter((call) => call[0] === 'sign').at(-1)[1];
    expect(signed).toMatchObject({ code: '123456', consent: true, fullName: 'Jamie Ortiz', organization: '', title: 'Operations lead' });
    expect(signed.browser.language).toBeTruthy();
    expect(typeof signed.browser.timeZone).toBe('string');

    const certificate = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download the completion certificate' }).click();
    expect((await certificate).suggestedFilename()).toBe('Statement of work certificate.pdf');

    await page.getByRole('link', { name: 'Shared documents' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Shared documents' })).toBeVisible();
    await expect(page.locator('strong', { hasText: 'SOW.pdf' })).toBeVisible();
    await expect(page.getByText(/Jamie Ortiz signed/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a stakeholder can decline without giving a reason', async ({ page }) => {
    const world = createWorld({ withRequest: true });
    await installSyntheticApi(page);
    await installPortalApi(page, createReviewWorld(), { actor: 'jamie', token: TOKEN });
    await installSigningApi(page, world);
    await page.goto(`requirements/${TOKEN}/signing/request-1`);

    await page.getByRole('button', { name: 'Decline', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Decline this request?' });
    await confirm.getByRole('button', { name: 'Decline' }).click();
    await expect(page.getByText('You declined this. The team has been told.')).toBeVisible();
    await expect(page.getByText('Declined', { exact: true }).first()).toBeVisible();
    expect(world.calls).toContainEqual(['decline', {}]);
    await expect(page.getByRole('button', { name: 'Email me a code' })).toHaveCount(0);
  });
});
