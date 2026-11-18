// The Consulting module and engagements for browser specs. Install after installSyntheticApi:
// Playwright tries the latest route first, and this one passes on everything it does not own.
const API_ORIGIN = 'http://localhost:3001';

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

const tenantUsers = [
  { email: 'demo@example.com', id: 'user-synthetic', name: 'Synthetic Demo', role: 'member' },
  { email: 'pat@example.com', id: 'user-pat', name: 'Pat Seller', role: 'member' },
];

function engagementRecord({ customer, id, lastActivityAt = '2026-11-12T10:00:00.000Z', name, ownerId = 'user-pat', status = 'open' }) {
  return {
    closedAt: status === 'lost' ? '2026-11-10T10:00:00.000Z' : null,
    createdAt: '2026-11-01T10:00:00.000Z',
    description: '',
    endDate: null,
    engagementCustomer: customer,
    engagementOwnerId: ownerId,
    engagementStatus: status,
    epics: [],
    id,
    kind: status === 'won' ? 'delivery' : 'engagement',
    lastActivityAt,
    name,
    startDate: null,
    status: status === 'lost' ? 'Archived' : 'Planned',
    tenantId: 'tenant-synthetic',
    tickets: [],
    updatedAt: lastActivityAt,
  };
}

export async function installEngagementsApi(page, { enabled = true, openEngagementCount = null } = {}) {
  const calls = [];
  let module = { enabled, key: 'consulting', label: 'Consulting', updatedAt: enabled ? '2026-11-01T09:00:00.000Z' : null, updatedBy: enabled ? 'user-admin' : null, version: enabled ? 1 : 0 };
  const engagements = new Map([
    engagementRecord({ customer: 'Northwind', id: 'eng-northwind', lastActivityAt: '2026-11-13T10:00:00.000Z', name: 'Northwind data platform' }),
    engagementRecord({ customer: 'Fabrikam', id: 'eng-fabrikam', name: 'Fabrikam CRM pilot', status: 'lost' }),
    engagementRecord({ customer: 'Contoso', id: 'eng-contoso', lastActivityAt: '2026-11-11T10:00:00.000Z', name: 'Contoso rollout', status: 'won' }),
  ].map((record) => [record.id, record]));
  let created = 0;
  const summary = (record) => ({
    closedAt: record.closedAt, convertedAt: null, createdAt: record.createdAt, customer: record.engagementCustomer, id: record.id, kind: record.kind,
    lastActivityAt: record.lastActivityAt, name: record.name, ownerId: record.engagementOwnerId,
    ownerName: tenantUsers.find((user) => user.id === record.engagementOwnerId)?.name ?? null, role: 'admin', status: record.engagementStatus, updatedAt: record.updatedAt,
  });
  const openCount = () => openEngagementCount ?? [...engagements.values()].filter((record) => record.engagementStatus === 'open').length;
  const disabled = (route) => json(route, { details: { code: 'module_disabled', module: 'consulting' }, error: 'The Consulting module is switched off for this workspace.', ok: false }, 403);

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body = () => request.postDataJSON() ?? {};

    if (path === '/api/workspace/modules') {
      if (method === 'PUT') {
        const input = body();
        calls.push({ body: input, method, path });
        if (input.expectedVersion !== module.version) return json(route, { details: { code: 'module_version_conflict' }, error: 'Conflict', ok: false }, 409);
        module = { ...module, enabled: input.enabled, updatedAt: '2026-11-14T12:00:00.000Z', updatedBy: 'user-synthetic', version: module.version + 1 };
        return json(route, { module: { ...module, impact: { openEngagements: openCount() } }, ok: true });
      }
      return json(route, { canManage: true, modules: [{ ...module, impact: { openEngagements: openCount() } }] });
    }
    if (path === '/api/engagements') {
      if (!module.enabled) return disabled(route);
      if (method === 'POST') {
        const input = body();
        calls.push({ body: input, method, path });
        created += 1;
        const record = engagementRecord({ customer: input.customer, id: `eng-new-${created}`, lastActivityAt: '2026-11-14T12:00:00.000Z', name: input.name, ownerId: 'user-synthetic' });
        engagements.set(record.id, record);
        return json(route, { ok: true, project: { ...record, role: 'admin' } }, 201);
      }
      const list = [...engagements.values()].map((record) => ({ ...summary(record), unreadCount: record.id === 'eng-northwind' ? 3 : 0 }));
      return json(route, { counts: { lost: 0, open: 0, won: 0 }, engagements: list });
    }
    if (method === 'GET' && path === '/api/workflows/templates') {
      return json(route, { templates: [{ id: 'template-delivery', kind: 'project', name: 'Consulting delivery', payloadStatus: 'valid', status: 'active' }] });
    }

    const match = /^\/api\/projects\/(eng-[^/]+)(?:\/(.*))?$/.exec(path);
    const record = match ? engagements.get(match[1]) : null;
    if (match && !record) return json(route, { error: 'Project not found.', ok: false }, 404);
    if (record) {
      const action = match[2] ?? '';
      if (['convert', 'close', 'reopen'].includes(action) && method === 'POST') {
        calls.push({ body: body(), method, path });
        if (!module.enabled) return disabled(route);
        if (action === 'close') Object.assign(record, { closedAt: '2026-11-14T12:00:00.000Z', engagementStatus: 'lost', status: 'Archived' });
        if (action === 'reopen') Object.assign(record, { closedAt: null, engagementStatus: 'open', status: 'Planned' });
        if (action === 'convert') Object.assign(record, { engagementStatus: 'won', kind: 'delivery' });
        return json(route, { ok: true, project: structuredClone(record) });
      }
      if (!module.enabled && record.kind === 'engagement') return json(route, { error: 'Project not found.', ok: false }, 404);
      if (method === 'GET' && action === '') return json(route, { ok: true, permissions: { canDelete: true, canEditPlan: true, canManage: true, canManageMembers: true, projectRole: 'admin', workspaceRole: 'member' }, project: structuredClone(record) });
      if (method === 'GET' && action === 'valid-users') return json(route, { project_users: [{ ...tenantUsers[0], role: 'admin' }, { ...tenantUsers[1], role: 'user' }], tenant_users: tenantUsers });
      if (method === 'GET' && action === 'files') {
        return json(route, { canWrite: record.engagementStatus !== 'lost', files: [{ audience: 'internal', createdAt: '2026-11-02T10:00:00.000Z', fileName: 'Proposal v3.docx', fileSize: 48_200, fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', id: 'file-proposal', projectId: record.id, targetId: record.id, targetType: 'project', updatedAt: '2026-11-12T10:00:00.000Z', uploaderName: 'Pat Seller', version: 3 }], ok: true });
      }
      if (method === 'GET' && action === 'events') return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
      // Every engagement opens on its General channel (channels-api.js has the full channel fixture).
      if (method === 'GET' && action === 'channels') {
        const open = record.engagementStatus !== 'lost';
        return json(route, { channels: [{ archivedAt: null, canArchive: false, canEdit: open, canPost: open, canRename: false, canRestore: false, canUpload: open, createdAt: record.createdAt, description: '', id: `${record.id}-general`, isGeneral: true, name: 'General', unreadCount: 0 }], ok: true, permissions: { canCreate: open, canDecide: true, canUpload: open, readOnly: !open } });
      }
      if (method === 'GET' && /^channels\/[^/]+\/posts$/.test(action)) return json(route, { canPost: record.engagementStatus !== 'lost', nextCursor: null, ok: true, posts: [] });
      if (method === 'POST' && /^channels\/[^/]+\/read$/.test(action)) return json(route, { ok: true, unreadCount: 0 });
      // The engagement's files as folders: General, and the proposal at the top.
      if (method === 'GET' && action === 'file-tree') {
        return json(route, { canManage: record.engagementStatus !== 'lost', channels: [{ archived: false, fileCount: 0, folders: [], guestCount: 0, id: `${record.id}-general`, isGeneral: true, name: 'General' }], ok: true, project: { id: record.id, name: record.name }, rootFileCount: 1 });
      }
      if (method === 'GET' && action === 'file-storage') return json(route, { canDeleteVersions: true, maxUploadBytes: 15_000_000, ok: true, storage: { bytes: 0 }, uploadsByParts: false });
      if (method === 'PATCH' && action === 'engagement') {
        const input = body();
        calls.push({ body: input, method, path });
        Object.assign(record, input.customer ? { engagementCustomer: input.customer } : {}, input.ownerId ? { engagementOwnerId: input.ownerId } : {});
        return json(route, { ok: true, project: structuredClone(record) });
      }
      if (method === 'GET') return json(route, { error: 'Not found.', ok: false }, 404);
    }
    return route.fallback();
  });

  return { calls, engagement: (id) => engagements.get(id), get module() { return module; } };
}
