// invoice-gen billing for browser specs: the synthetic project linked
// to a SOW, its invoices and story mapping, and an engagement's linked SOW. Install after
// installSyntheticApi (and installEngagementsApi): Playwright tries the latest route first.
// All of it is synthetic data.
import { syntheticProject } from './synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

export const SOW = {
  executedAt: '2026-07-02T15:00:00Z', id: 41, rateCents: 15000, status: 'executed', title: 'Synthetic phase 2 SOW', url: 'https://invoices.example/agreements/41',
  milestones: [{ hours: 40, id: 101, name: 'Discovery', shortLabel: 'Disc' }, { hours: 80, id: 102, name: 'Build', shortLabel: 'Build' }],
};

export async function installBillingApi(page, { canManage = true, consulting = true, linked = true } = {}) {
  const calls = [];
  const stories = [
    { epicId: 'epic-synthetic', epicTitle: 'Delivery', id: 'story-synthetic', milestoneId: null, title: 'Release pilot' },
    { epicId: 'epic-build', epicTitle: 'Build', id: 'story-model', milestoneId: 101, title: 'Data model' },
    { epicId: 'epic-build', epicTitle: 'Build', id: 'story-reports', milestoneId: null, title: 'Reports' },
  ];
  const milestones = () => SOW.milestones.map(({ hours, id, name, shortLabel }) => ({ hours, id, name, shortLabel }));
  const mapping = () => ({ agreement: linked ? { id: SOW.id, status: SOW.status, title: SOW.title, url: SOW.url } : null, canManage: true, milestones: linked ? milestones() : [], ok: true, stories: structuredClone(stories) });
  const summary = () => ({
    canManage: true,
    heardAt: linked ? '2026-07-12T09:30:00.000Z' : null,
    invoiceGenUrl: 'https://invoices.example',
    invoices: linked ? [
      { currency: 'USD', dueDate: '2026-08-11', externalInvoiceId: '70', hours: 12, issueDate: '2026-07-12', number: 'NESLLC-20260712-001', overdue: true, paidDate: null, sourceUpdatedAt: '2026-07-12T09:30:00Z', status: 'submitted', submittedDate: '2026-07-12', totalCents: 180000, url: 'https://invoices.example/invoices/70' },
      { currency: 'USD', dueDate: null, externalInvoiceId: '71', hours: 8, issueDate: null, number: '', overdue: false, paidDate: null, sourceUpdatedAt: '2026-07-12T09:00:00Z', status: 'draft', submittedDate: null, totalCents: 120000, url: 'https://invoices.example/invoices/71' },
    ] : [],
    link: linked ? { agreement: SOW, customer: { id: 12, name: 'Synthetic Client' }, lineOfBusiness: { id: 3, name: 'Consulting' }, projectId: syntheticProject.id, sourceUpdatedAt: '2026-07-02T15:00:01Z' } : null,
    milestones: linked ? SOW.milestones.map((milestone) => ({
      approvedUnclaimedHours: milestone.id === 101 ? 6 : 3, billedHours: milestone.id === 101 ? 12 : 30, budgetHours: milestone.hours, claimedUnbilledHours: milestone.id === 101 ? 8 : 52.5,
      id: milestone.id, name: milestone.name, shortLabel: milestone.shortLabel, storyCount: stories.filter((story) => story.milestoneId === milestone.id).length,
    })) : [],
    noSow: { approvedUnclaimedHours: 2.5, billedHours: 0, claimedUnbilledHours: 0 },
    ok: true,
  });
  const refused = (route) => json(route, { details: { code: 'billing_not_allowed' }, error: 'Billing is shown to project admins and managers, and workspace admins and managers.', ok: false }, 403);

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method === 'GET' && path === '/api/workspace/modules') {
      return json(route, { canManage: false, modules: [{ enabled: consulting, key: 'consulting', label: 'Consulting' }] });
    }
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}`) {
      return json(route, { ok: true, permissions: { canDelete: canManage, canEditPlan: true, canManage, canManageMembers: canManage, projectRole: canManage ? 'manager' : 'contributor', workspaceRole: 'member' }, project: syntheticProject });
    }
    if (path === `/api/projects/${syntheticProject.id}/billing` && method === 'GET') {
      calls.push({ method, path });
      return canManage ? json(route, summary()) : refused(route);
    }
    if (path === `/api/projects/${syntheticProject.id}/billing/milestones`) {
      if (!canManage) return refused(route);
      if (method === 'GET') return json(route, mapping());
      if (method === 'PUT') {
        const body = request.postDataJSON();
        calls.push({ body, method, path });
        const changed = [];
        for (const { milestoneId, storyId } of body.assignments) {
          const story = stories.find((entry) => entry.id === storyId);
          if (story && story.milestoneId !== milestoneId) { changed.push({ from: story.milestoneId, storyId, to: milestoneId }); story.milestoneId = milestoneId; }
        }
        return json(route, { ...mapping(), changed });
      }
    }
    if (method === 'GET' && path === '/api/projects/eng-northwind/billing') {
      return json(route, { ...summary(), invoices: [], link: { agreement: SOW, customer: { id: 14, name: 'Northwind' }, lineOfBusiness: null, projectId: 'eng-northwind', sourceUpdatedAt: '2026-11-12T10:00:00Z' } });
    }
    return route.fallback();
  });

  return { calls, stories };
}
