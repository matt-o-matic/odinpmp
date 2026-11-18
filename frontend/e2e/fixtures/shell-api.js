import { syntheticProject, syntheticUser } from './synthetic-api.js';

// Extra synthetic endpoints for the app shell specs: enterprise search, the profile page and
// two-factor setup. Register after installSyntheticApi; anything not handled here falls back to it.

const API_ORIGIN = 'http://localhost:3001';
const SECOND_PROJECT = { id: 'project-archive', name: 'Archive Migration' };
const QR_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function searchCorpus() {
  const at = '2026-10-09T12:00:00.000Z';
  const base = { indexedAt: at, updatedAt: at };
  const tasks = Array.from({ length: 22 }, (_, index) => ({
    ...base,
    content: `Pilot checklist step ${index + 1} for the rollout.`,
    documentType: 'task',
    facets: { status: index % 2 ? 'Not Started' : 'In Progress' },
    id: `search-task-${index + 1}`,
    projectId: syntheticProject.id,
    sourceId: `task-pilot-${index + 1}`,
    title: `Pilot task ${String(index + 1).padStart(2, '0')}`,
    url: `/projects/${syntheticProject.id}`,
  }));
  return [
    { ...base, content: 'Synthetic browser acceptance fixture pilot delivery plan.', documentType: 'project', facets: { status: 'In Progress' }, id: 'search-project', projectId: syntheticProject.id, sourceId: syntheticProject.id, title: syntheticProject.name, url: `/projects/${syntheticProject.id}` },
    { ...base, content: 'Vendor capacity may constrain the pilot.', documentType: 'risk', facets: { impact: 'high', status: 'monitoring' }, id: 'search-risk', projectId: syntheticProject.id, sourceId: 'risk-synthetic', title: 'Vendor capacity', url: `/projects/${syntheticProject.id}/governance` },
    // Indexed before governance links moved to the governance route.
    { ...base, content: 'planned 2026-08-28 pilot', documentType: 'milestone', facets: { status: 'planned' }, id: 'search-milestone', projectId: syntheticProject.id, sourceId: 'milestone-synthetic', title: 'Pilot ready', url: `/projects/${syntheticProject.id}?tab=governance` },
    { ...base, content: 'Customer delivery program pilot.', documentType: 'program', facets: { status: 'active' }, id: 'search-program', projectId: null, sourceId: 'program-synthetic', title: 'Customer launch', url: '/portfolio' },
    { ...base, content: 'Pilot data copy for the archive.', documentType: 'story', facets: { status: 'In Progress' }, id: 'search-archive', projectId: SECOND_PROJECT.id, sourceId: 'story-archive', title: 'Archive pilot copy', url: `/projects/${SECOND_PROJECT.id}` },
    ...tasks,
  ];
}

export async function installShellApi(page) {
  const state = { searchRequests: [], twoFactor: { enabled: false, events: [] } };
  const corpus = searchCorpus();
  const backupCodes = ['A1B2-C3D4', 'E5F6-G7H8', 'J9K1-L2M3', 'N4P5-Q6R7', 'S8T9-U1V2', 'W3X4-Y5Z6', 'B7C8-D9E1', 'F2G3-H4J5'];

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === 'GET' && path === '/api/projects') return json(route, { projects: [syntheticProject, { ...syntheticProject, epics: [], id: SECOND_PROJECT.id, name: SECOND_PROJECT.name, rank: 2 }] });

    if (method === 'GET' && path === '/api/reporting/search') {
      const params = Object.fromEntries(url.searchParams.entries());
      state.searchRequests.push(params);
      const query = String(params.query ?? '').trim().toLowerCase();
      if (!query) return json(route, { error: 'Validation failed.' }, 400);
      const types = String(params.types ?? '').split(',').filter(Boolean);
      const matches = corpus.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(query)
        && (!types.length || types.includes(item.documentType))
        && (!params.projectId || item.projectId === params.projectId));
      const limit = Number(params.limit ?? 25); const offset = Number(params.offset ?? 0);
      return json(route, { facetCounts: {}, indexedFreshness: '2026-10-09T12:00:00.000Z', limit, offset, records: matches.slice(offset, offset + limit), total: matches.length });
    }

    if (method === 'GET' && path === '/api/users/me') {
      return json(route, { sessions: [], user: { ...syntheticUser, firstName: 'Synthetic', lastName: 'Demo', preferences: { twoFactorEnabled: state.twoFactor.enabled }, profileDisplayName: syntheticUser.name, timezone: 'America/New_York' } });
    }
    if (method === 'POST' && path === '/api/auth/two-factor/init') {
      state.twoFactor.events.push('init');
      return json(route, { ok: true, qrCodeData: QR_PIXEL });
    }
    if (method === 'POST' && path === '/api/auth/two-factor/enable') {
      const { code } = request.postDataJSON();
      if (code !== '123456') return json(route, { error: 'The verification code is invalid.' }, 400);
      state.twoFactor.enabled = true; state.twoFactor.events.push('enable');
      return json(route, { backupCodes, ok: true });
    }
    if (method === 'GET' && path === '/api/auth/two-factor/backup-codes') return json(route, { backupCodes: state.twoFactor.enabled ? backupCodes : [] });
    if (method === 'POST' && path === '/api/auth/two-factor/disable') {
      state.twoFactor.enabled = false; state.twoFactor.events.push('disable');
      return json(route, { ok: true });
    }

    return route.fallback();
  });

  return state;
}
