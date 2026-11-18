import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OdinApiError } from '../src/mcp/api-client.js';
import { createOdinMcpServer } from '../src/mcp/server.js';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';
import { KEYWORD_GROUPS, toolNeedsConfirmation } from '../src/lib/agent/agent-tools.js';

// The file sharing and signature request tools against a fake Odin REST API: what they send,
// what they return, when the assistant asks first, and which routes an MCP
// credential may reach. The routes themselves are covered in document-signing.test.js.

const P = '/api/projects/project-1';
const REQUEST = {
  createdAt: '2026-11-13T10:00:00.000Z', createdBy: { id: 'user-1', name: 'Pia Manager' }, documents: [{ contentType: 'application/pdf', fileId: 'file-1', fileName: 'sow.pdf', fileSize: 10, position: 0, sha256: 'a'.repeat(64), version: 2 }],
  endReason: null, endedAt: null, events: [{ action: 'requested', actor: { id: 'user:user-1', name: 'Pia Manager' }, at: '2026-11-13T10:00:00.000Z', detail: null }],
  id: 'req-1', kind: 'acceptance', message: '', packageHash: 'b'.repeat(64), progress: { signed: 1, total: 2 }, statement: 'I accept.', status: 'pending', subject: { id: 'file-1', name: 'sow.pdf', type: 'file' }, title: 'SOW',
  signers: [
    { email: 'jamie@client.example', evidence: { clientIp: '203.0.113.9', verification: { method: 'email_code', sentTo: 'jamie@client.example' } }, id: 'signer-1', mail: { status: 'queued' }, name: 'Jamie', sealValid: true, signedAt: '2026-11-13T11:00:00.000Z', signedName: 'Jamie Ortiz', signedOrganization: 'Client Co', signedTitle: 'COO', stakeholderId: 'sh-1', status: 'signed' },
    { email: 'riley@client.example', id: 'signer-2', mail: { reason: 'link-revoked', status: 'not-sent' }, name: 'Riley', stakeholderId: 'sh-2', status: 'pending' },
  ],
};

async function session(t, respond) {
  const calls = [];
  const server = createOdinMcpServer({ api: { request: async (...args) => { calls.push(args); return respond(...args); } } });
  const client = new Client({ name: 'odin-mcp-signing-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
    return { data: result.structuredContent, isError: result.isError === true };
  };
  return { call, calls, client };
}

test('the assistant asks before sharing a file, requesting signatures, cancelling, removing or reminding', () => {
  assert.equal(toolNeedsConfirmation('odin_set_file_audience', { audience: 'external', fileId: 'f', projectId: 'p' }), true);
  assert.equal(toolNeedsConfirmation('odin_set_file_audience', { audience: 'internal', fileId: 'f', projectId: 'p' }), false);
  for (const name of ['odin_request_signatures', 'odin_cancel_signing_request', 'odin_remove_signer', 'odin_remind_signers']) {
    assert.equal(toolNeedsConfirmation(name, { projectId: 'p' }), true, name);
    assert.equal(toolNeedsConfirmation(name, { dryRun: true, projectId: 'p' }), false, `${name} dry run`);
  }
  assert.equal(toolNeedsConfirmation('odin_list_signing_requests', { projectId: 'p' }), false);
  const group = KEYWORD_GROUPS.find((entry) => entry.operations.includes('odin_request_signatures'));
  for (const text of ['send the SOW to the client for signature', 'get sign-off on phase 1', 'who has signed?', 'mark the contract external']) assert.ok(group.pattern.test(text), text);
  assert.equal(group.pattern.test('assign this to Dana and redesign the page'), false);
});

test('marking a file external sends the audience and returns the file', async (t) => {
  const { call, calls } = await session(t, () => ({ changed: true, file: { audience: 'external', fileName: 'sow.pdf', id: 'file-1' }, ok: true }));
  const result = await call('odin_set_file_audience', { audience: 'external', fileId: 'file-1', projectId: 'project-1' });
  assert.deepEqual(result.data, { changed: true, file: { audience: 'external', fileName: 'sow.pdf', id: 'file-1' }, ok: true });
  assert.deepEqual(calls[0], ['PATCH', `${P}/files/file-1/audience`, { body: { audience: 'external' } }]);
});

test('a file under signature cannot be made internal, and the refusal says why', async (t) => {
  const { call } = await session(t, () => { throw new OdinApiError(409, 'http_409', 'Conflict'); });
  const result = await call('odin_set_file_audience', { audience: 'internal', fileId: 'file-1', projectId: 'project-1' });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.data ?? {}), /file_under_signature/);
});

test('requesting signatures: a dry run names the recipients and sends nothing, then the request goes to Odin', async (t) => {
  const { call, calls } = await session(t, (method, path) => {
    if (path.endsWith('/clarifications')) return { stakeholders: [{ email: 'jamie@client.example', id: 'sh-1', name: 'Jamie' }] };
    if (method === 'POST') return { ok: true, request: REQUEST };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const args = { documents: [{ fileId: 'file-1' }], kind: 'acceptance', message: 'By Friday', projectId: 'project-1', stakeholderIds: ['sh-1', 'sh-missing'], title: 'SOW' };
  const preview = await call('odin_request_signatures', { ...args, dryRun: true });
  assert.equal(preview.data.dryRun, true);
  assert.deepEqual(preview.data.emails, [{ email: 'jamie@client.example', id: 'sh-1', name: 'Jamie' }, { id: 'sh-missing', missing: true }]);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 0);

  const sent = await call('odin_request_signatures', args);
  assert.equal(sent.isError, false);
  const post = calls.find(([method]) => method === 'POST');
  assert.deepEqual(post, ['POST', `${P}/signing-requests`, { body: { documents: [{ fileId: 'file-1' }], kind: 'acceptance', message: 'By Friday', signerStakeholderIds: ['sh-1', 'sh-missing'], title: 'SOW' } }]);
  assert.equal(sent.data.request.signers[1].emailProblem, 'link-revoked');
  assert.equal(sent.data.request.signers[0].signedAs, 'Jamie Ortiz, COO, Client Co');
  assert.equal('evidence' in sent.data.request.signers[0], false, 'lists leave the evidence out');

  const signoff = await call('odin_request_signatures', { kind: 'signoff', milestoneId: 'ms-1', projectId: 'project-1', stakeholderIds: ['sh-1'], title: 'Phase 1' });
  assert.equal(signoff.isError, false);
  assert.deepEqual(calls.at(-1)[2].body, { documents: [], kind: 'signoff', signerStakeholderIds: ['sh-1'], subjectId: 'ms-1', subjectType: 'milestone', title: 'Phase 1' });
  const empty = await call('odin_request_signatures', { kind: 'acceptance', projectId: 'project-1', stakeholderIds: ['sh-1'], title: 'x' });
  assert.equal(empty.isError, true);
});

test('reading a request shows how each signer verified and whether their seal checks out', async (t) => {
  const { call } = await session(t, () => ({ ok: true, request: { ...REQUEST, manifestHash: null } }));
  const result = await call('odin_get_signing_request', { projectId: 'project-1', requestId: 'req-1' });
  assert.deepEqual(result.data.request.signers[0].evidence, { clientIp: '203.0.113.9', sealValid: true, sentTo: 'jamie@client.example', verifiedBy: 'email_code' });
  assert.equal(result.data.request.statement, 'I accept.');
  assert.deepEqual(result.data.request.events, [{ action: 'requested', at: '2026-11-13T10:00:00.000Z', by: 'Pia Manager' }]);
});

test('cancel, remove and remind call their routes, and stale actions say what to do', async (t) => {
  let fail = false;
  const { call, calls } = await session(t, (method, path) => {
    if (fail) throw new OdinApiError(409, 'http_409', 'Conflict');
    return path.endsWith('/remind') ? { ok: true, reminded: 1, request: REQUEST } : { ok: true, request: REQUEST };
  });
  await call('odin_cancel_signing_request', { projectId: 'project-1', reason: 'Scope changed', requestId: 'req-1' });
  await call('odin_remove_signer', { projectId: 'project-1', requestId: 'req-1', signerId: 'signer-2' });
  const reminded = await call('odin_remind_signers', { projectId: 'project-1', requestId: 'req-1', signerId: 'signer-2' });
  assert.equal(reminded.data.reminded, 1);
  assert.deepEqual(calls.map(([method, path, options]) => [method, path, options?.body]), [
    ['POST', `${P}/signing-requests/req-1/cancel`, { reason: 'Scope changed' }],
    ['POST', `${P}/signing-requests/req-1/signers/signer-2/remove`, {}],
    ['POST', `${P}/signing-requests/req-1/remind`, { signerId: 'signer-2' }],
  ]);
  fail = true;
  const stale = await call('odin_cancel_signing_request', { projectId: 'project-1', requestId: 'req-1' });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.data ?? {}), /not_pending/);
});

test('an MCP credential reaches the signing routes the tools use and nothing that signs', () => {
  const grant = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
  const allowed = (method, url, body = {}) => {
    try {
      requireMcpRouteAccess({ body, method, originalUrl: url }, grant);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(allowed('PATCH', `${P}/files/file-1/audience`, { audience: 'external' }), true);
  assert.equal(allowed('PATCH', `${P}/files/file-1/audience`, { audience: 'public' }), false);
  assert.equal(allowed('GET', `${P}/signing-requests`), true);
  assert.equal(allowed('POST', `${P}/signing-requests`, { kind: 'acceptance', signerStakeholderIds: ['sh-1'], title: 'x' }), true);
  assert.equal(allowed('POST', `${P}/signing-requests`, { evil: true }), false);
  assert.equal(allowed('POST', `${P}/signing-requests/req-1/remind`, {}), true);
  assert.equal(allowed('GET', `${P}/signing-requests/req-1/certificate`), false);
  assert.equal(allowed('POST', '/api/public/requirements/token/signing/req-1/sign', {}), false);
});
