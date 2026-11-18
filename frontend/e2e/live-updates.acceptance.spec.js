import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Changes made elsewhere (by another person, the assistant or an MCP client) reach a screen
// that is already open, without a reload.

const API_ORIGIN = 'http://localhost:3001';

// Holds streams on `path` until `release()`, then delivers `frames` to each one still open;
// reconnects after that carry nothing new.
async function holdStream(page, path, frames) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let delivered = false;
  await page.route(`${API_ORIGIN}${path}`, async (route) => {
    if (delivered) return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
    await released;
    try {
      await route.fulfill({ body: frames, contentType: 'text/event-stream', status: 200 });
      delivered = true;
    } catch {
      // That screen closed while its stream was held.
    }
  });
  return () => release();
}

test('someone an MCP client adds to the project appears on the open Resources tab', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const casey = { capacityHoursPerWeek: 40, email: '', id: 'resource-casey', name: 'Casey Contractor', roles: ['QA engineer'], status: 'active', userId: null, version: 1 };
  let added = false;
  await page.route(`${API_ORIGIN}/api/resource-planning/projects/${syntheticProject.id}/team`, (route) => {
    if (!added || route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      allocations: [{ endDate: null, hoursPerWeek: 20, id: 'allocation-casey', projectId: syntheticProject.id, resourceId: casey.id, role: 'QA', scenario: 'baseline', startDate: null, status: 'active', version: 1 }],
      canManage: true, canSeeRates: true, directory: [casey], people: [{ assigneeId: `resource:${casey.id}`, resource: casey }], projectId: syntheticProject.id, users: [],
    }) });
  });
  const event = { actor: { id: 'user-riley', name: 'Riley Planner' }, originClientId: 'tab-elsewhere', projectId: syntheticProject.id, type: 'project.assets.invalidated' };
  const release = await holdStream(page, `/api/projects/${syntheticProject.id}/events`,
    `event: connected\ndata: {}\n\nevent: project.assets.invalidated\ndata: ${JSON.stringify(event)}\n\n`);

  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/resources`);
  const tab = page.getByRole('region', { name: 'Resources' });
  await expect(tab.getByRole('row').filter({ hasText: 'Synthetic Demo' })).toBeVisible();
  await expect(tab.getByRole('row').filter({ hasText: 'Casey Contractor' })).toHaveCount(0);

  added = true;
  release();
  await expect(tab.getByRole('row').filter({ hasText: 'Casey Contractor' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});
