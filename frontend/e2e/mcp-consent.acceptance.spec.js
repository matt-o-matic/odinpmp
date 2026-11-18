import { expect, test } from '@playwright/test';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const parameters = new URLSearchParams({ client_id: 'mcp-synthetic-client', response_type: 'code',
  redirect_uri: 'http://127.0.0.1:54321/callback', scope: 'projects.read projects.write', state: 'synthetic-state',
  resource: 'https://odin.example/mcp', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });

async function consentFixture(page, { denied = false, long = false } = {}) {
  const api = await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  await page.route('**/api/mcp/oauth/consent?**', route => route.fulfill({ status: denied ? 403 : 200, contentType: 'application/json', body: JSON.stringify(denied ? { error: 'access_denied' } : {
    name: long ? 'Synthetic MCP client '.repeat(15) : 'Synthetic MCP client', scopes: ['projects.read', 'projects.write'],
    tenantId: 'tenant-synthetic', projectIds: [syntheticProject.id], projects: [{ id: syntheticProject.id, name: long ? 'Long synthetic project '.repeat(15) : syntheticProject.name }],
    redirectUri: parameters.get('redirect_uri'),
  }) }));
  return api;
}

test('MCP consent shows delegated access and preserves keyboard focus and callback state', async ({ page }) => {
  const api = await consentFixture(page);
  let approval;
  await page.route('**/api/mcp/oauth/authorize', route => {
    approval = route.request().postDataJSON();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ redirectTo: `${parameters.get('redirect_uri')}?code=synthetic-code&state=synthetic-state` }) });
  });
  await page.route('http://127.0.0.1:54321/callback?**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic client callback</h1>' }));
  await page.goto(`/app/mcp/authorize?${parameters}`);
  await expect(page.getByRole('heading', { name: 'Connect Synthetic MCP client to Odin' })).toBeVisible();
  await expect(page.getByText('Create and change projects, plan items, comments, and boards within your permissions.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: syntheticProject.name })).toBeVisible();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toBeFocused();
  expect(await connect.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/callback\?code=synthetic-code&state=synthetic-state/);
  expect(approval.approved).toBe(true);
  expect(approval.resource).toBe('https://odin.example/mcp');
  api.assertNoUnexpectedRequests();
});

test('MCP consent handles denied requests and long names without horizontal overflow', async ({ page }) => {
  await consentFixture(page, { long: true });
  await page.goto(`/app/mcp/authorize?${parameters}`);
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.route('**/api/mcp/oauth/consent?**', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"access_denied"}' }));
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'This connection request is unavailable.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
});

test('MCP cancellation returns access_denied and OAuth state to the registered client', async ({ page }) => {
  await consentFixture(page);
  await page.route('http://127.0.0.1:54321/callback?**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic cancelled callback</h1>' }));
  await page.goto(`/app/mcp/authorize?${parameters}`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/callback\?error=access_denied&state=synthetic-state/);
});

test('MCP consent stays usable while loading, in dark mode and with 200 percent text scaling', async ({ page }, testInfo) => {
  await consentFixture(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/mcp/oauth/consent?**', async route => {
    await pending;
    await route.fallback();
  });
  await page.goto(`/app/mcp/authorize?${parameters}`);
  await expect(page.getByRole('status').filter({ hasText: 'Loading connection request' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
  release();
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toBeVisible();
  await page.evaluate(() => { document.documentElement.classList.add('dark'); });
  await page.screenshot({ path: testInfo.outputPath('mcp-consent-dark.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect(connect).toBeVisible();
  await connect.focus();
  await expect(connect).toBeFocused();
  const consent = page.getByRole('region', { name: 'Connect Synthetic MCP client to Odin' });
  // The shared navbar has separate text-scaling overflow; check this form's bounds.
  expect(await consent.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await consent.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
});

test('integration administrators see MCP project scope and can revoke sessions without a client secret', async ({ page }) => {
  await installSyntheticApi(page, { admin: true });
  await authenticateSyntheticUser(page);
  await page.route('**/api/integrations?**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    applications: [{ id: 'synthetic-mcp-application', name: 'Synthetic MCP client', clientId: 'odin_mcp_client_synthetic', scopes: ['projects.read', 'projects.write'], projectIds: [], enabled: true, version: 1, createdAt: '2026-01-01T00:00:00Z' }],
    deliveries: [], subscriptions: [], health: [], tokens: [],
  }) }));
  let revoked = false;
  await page.route('**/api/mcp/clients/odin_mcp_client_synthetic/revoke', route => { revoked = true; return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
  await page.goto('/app/admin/integrations');
  await expect(page.getByText('All accessible projects', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke sessions', exact: true }).click();
  await expect.poll(() => revoked).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
