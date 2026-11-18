import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';

import {
  authenticateSyntheticUser,
  installSyntheticApi,
  syntheticProject,
  openPhoneMenu,
} from './fixtures/synthetic-api.js';

// A finished assistant chat whose reply has a chart, a Mermaid diagram, a Graphviz graph and a code block.
function visualsChat() {
  const chart = JSON.stringify({ labels: ['Matt', 'Kelly', 'Reese'], series: [{ data: [12, 4, 2], name: 'Open' }, { data: [20, 6, 3], name: 'Done' }], title: 'Work by owner', type: 'bar', unit: 'items', yLabel: 'Items' });
  const assistantChat = {
    createdAt: '2026-10-25T15:00:00.000Z',
    id: 'chat-visuals',
    messages: [
      { content: 'Show me the work by owner, the release flow and the epic dependencies.', createdAt: '2026-10-25T15:00:00.000Z', id: 'user-visuals', role: 'user' },
      {
        content: `Matt carries most of the open work.\n\n\`\`\`chart\n${chart}\n\`\`\`\n\nThe release flow:\n\n\`\`\`mermaid\nflowchart LR\n  A[Build] --> B[Review]\n  B --> C[Release]\n\`\`\`\n\nHow the epics depend on each other:\n\n\`\`\`dot\ndigraph { rankdir=LR; Foundation -> Content; Content -> Launch; Foundation -> Launch }\n\`\`\`\n\nThe counts as text:\n\n\`\`\`text\nCompleted    30\nIn progress   3\n\`\`\``,
        createdAt: '2026-10-25T15:00:10.000Z',
        id: 'assistant-visuals',
        role: 'assistant',
      },
    ],
    pending: null,
    projectId: syntheticProject.id,
    projectName: syntheticProject.name,
    run: { id: 'run-visuals', status: 'completed' },
    settings: { allowWebResearch: true },
    title: 'Work, flow and dependencies',
    updatedAt: '2026-10-25T15:00:10.000Z',
  };
  return assistantChat;
}

// A finished chat with two replies that changed things in Odin.
function changesChat() {
  const reply = (id, createdAt, content, records) => ({ activity: [{ callId: `${id}-call`, label: 'Changed items', name: 'odin_update_items', ok: true }], changes: { records, status: 'applied', undoneAt: null }, content, createdAt, id, role: 'assistant' });
  return {
    createdAt: '2026-10-25T15:00:00.000Z',
    id: 'chat-undo',
    messages: [
      { content: 'Add an FAQ task and block Rules.', createdAt: '2026-10-25T15:00:00.000Z', id: 'user-undo', role: 'user' },
      reply('reply-undo', '2026-10-25T15:00:10.000Z', 'Added the FAQ task and blocked Rules.', [
        { id: 'change-1', label: 'Created task "Write the launch FAQ"', status: 'applied', undoable: true },
        { id: 'change-2', label: 'Updated "Rules": status, points', status: 'applied', undoable: true },
        { id: 'change-3', label: 'Reorder board card', status: 'applied', undoable: false },
      ]),
      { content: 'And a task to book the venue.', createdAt: '2026-10-25T15:01:00.000Z', id: 'user-undo-2', role: 'user' },
      reply('reply-venue', '2026-10-25T15:01:10.000Z', 'Added the venue task.', [
        { id: 'change-4', label: 'Created task "Book the venue"', status: 'applied', undoable: true },
      ]),
    ],
    pending: null,
    projectId: syntheticProject.id,
    projectName: syntheticProject.name,
    run: { id: 'run-undo', status: 'completed' },
    settings: { allowWebResearch: true },
    title: 'FAQ and Rules',
    updatedAt: '2026-10-25T15:01:10.000Z',
  };
}

test.describe('synthetic local acceptance', () => {
  test('protected app load redirects to login and signs in', async ({ page }) => {
    const api = await installSyntheticApi(page);
    api.resetAuthentication();
    await page.goto('/app/projects');
    await expect(page).toHaveURL(/\/app\/login\?redirect=/);
    await expect(page.getByRole('heading', { name: 'Enter your credentials' })).toBeVisible();

    await page.getByLabel('Work email').fill('demo@example.com');
    await page.getByLabel('Password').fill('SyntheticPass123!');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/app\/projects$/);
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('enterprise SSO discovery routes a verified domain to its configured SAML provider', async ({ page }) => {
    const api = await installSyntheticApi(page, { ssoMode: 'saml' });
    api.resetAuthentication();
    await page.route('http://localhost:3001/api/auth/sso/saml/start?**', (route) => route.fulfill({ body: '<main><h1>Synthetic SAML identity provider</h1></main>', contentType: 'text/html', status: 200 }));
    await page.goto('/app/login?redirect=/projects');
    await page.getByLabel('Work email').fill('demo@example.com');
    await page.getByRole('button', { name: 'Continue with enterprise SSO' }).click();
    await expect(page).toHaveURL(/http:\/\/localhost:3001\/api\/auth\/sso\/saml\/start\?tenantId=11111111-1111-4111-8111-111111111111&redirect=%2Fprojects/);
    await expect(page.getByRole('heading', { name: 'Synthetic SAML identity provider' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('authenticated project, assistant, and refresh smoke', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('projects');
    await expect(page.getByRole('table').getByText(syntheticProject.name, { exact: true })).toBeVisible();
    await page.getByRole('table').getByRole('link', { name: syntheticProject.name }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${syntheticProject.id}$`));
    await expect(page.getByRole('navigation', { name: 'Project workspace tabs' })).toBeVisible();

    const assistantButton = page.getByRole('button', { name: 'AI Workspace' });
    if (!await assistantButton.isVisible()) await openPhoneMenu(page);
    await assistantButton.click();
    const workspace = page.getByRole('dialog', { name: 'AI Workspace' });
    await expect(workspace).toBeVisible();
    await expect(workspace.getByRole('heading', { name: `What do you need on ${syntheticProject.name}?` })).toBeVisible();
    await workspace.getByLabel('Message the assistant').fill('How is the project going?');
    await workspace.getByLabel('Message the assistant').press('Enter');
    await expect(workspace.getByRole('article', { name: 'Assistant reply' })).toContainText('Synthetic Project is on track.');
    await expect(workspace.getByRole('button', { name: 'Used 1 tool' })).toBeVisible();
    await expect(page).toHaveURL(/assistantSessionId=chat-1/);
    await workspace.getByRole('button', { name: 'Close assistant' }).click();
    await expect(workspace).toBeHidden();

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${syntheticProject.id}$`));
    await expect(page.getByRole('navigation', { name: 'Project workspace tabs' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('assistant replies render as rich content with links into the project, in light and dark', async ({ page }, testInfo) => {
    const assistantChat = {
      createdAt: '2026-07-11T22:24:00.000Z',
      id: 'chat-markdown',
      messages: [{
        content: 'Assess project completeness.',
        createdAt: '2026-07-11T22:24:00.000Z',
        id: 'message-user-markdown',
        role: 'user',
      }, {
        activity: [{ callId: 'call-1', label: 'Read the project overview', name: 'odin_project_overview', ok: true }, { callId: 'call-2', label: 'Found 4 items', name: 'odin_find_items', ok: true }],
        content: 'Overall, the project is **not ready**.\n\n### Short assessment\n\n- The draft has **broad coverage**.\n- [Release pilot](odin://item/story-synthetic) still has no acceptance criteria.\n\n### What is missing\n\n| Area | Gap |\n| --- | --- |\n| Scope | Define launch boundaries. |\n| Ownership | Assign approvers. |',
        createdAt: '2026-07-11T22:25:00.000Z',
        id: 'message-assistant-markdown',
        plan: [{ status: 'done', title: 'Read the plan' }, { status: 'done', title: 'Check acceptance criteria' }],
        role: 'assistant',
      }],
      pending: null,
      projectId: syntheticProject.id,
      projectName: syntheticProject.name,
      run: { id: 'run-1', status: 'completed' },
      settings: { allowWebResearch: true },
      title: 'Assess project completeness',
      updatedAt: '2026-07-11T22:25:00.000Z',
    };
    const api = await installSyntheticApi(page, { assistantChat });
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}?assistant=1&assistantSessionId=${assistantChat.id}`);
    const workspace = page.getByRole('dialog', { name: 'AI Workspace' });
    await expect(workspace.getByRole('heading', { name: 'Assess project completeness' })).toBeVisible();
    const reply = workspace.getByRole('article', { name: 'Assistant reply' });
    await expect(reply.getByRole('heading', { name: 'Short assessment' })).toBeVisible();
    await expect(reply.getByRole('heading', { name: 'What is missing' })).toBeVisible();
    await expect(reply.getByRole('cell', { name: 'Define launch boundaries.' })).toBeVisible();
    await expect(reply.getByRole('button', { name: 'Plan · 2 of 2 done' })).toBeVisible();
    await reply.getByRole('button', { name: 'Used 2 tools' }).click();
    await expect(reply.getByText('Found 4 items')).toBeVisible();
    expect(await reply.evaluate((element) => element.innerHTML)).not.toContain('###');
    const headingSize = await reply.getByRole('heading', { name: 'Short assessment' }).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(headingSize).toBeLessThan(20);
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
      await settleForAxe(page);
      const results = await new AxeBuilder({ page }).include('.assistant-shell').analyze();
      await testInfo.attach(`axe-assistant-${theme}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
      expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    }
    await reply.getByRole('link', { name: 'Release pilot' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}$`));
    await expect(workspace).toBeHidden();
    api.assertNoUnexpectedRequests();
  });

  test('assistant replies draw charts, Mermaid diagrams and Graphviz graphs, with the data a click away', async ({ page }, testInfo) => {
    const assistantChat = visualsChat();
    const api = await installSyntheticApi(page, { assistantChat });
    await authenticateSyntheticUser(page);
    await page.setViewportSize({ height: 1100, width: 1400 });
    await page.goto(`projects/${syntheticProject.id}?assistant=1&assistantSessionId=${assistantChat.id}`);
    const reply = page.getByRole('dialog', { name: 'AI Workspace' }).getByRole('article', { name: 'Assistant reply' });
    await expect(reply.locator('.assistant-visual--chart canvas')).toBeVisible();
    await expect(reply.locator('.assistant-visual--mermaid svg')).toBeVisible();
    await expect(reply.locator('.assistant-visual--graphviz svg')).toBeVisible();
    await expect(reply.locator('.assistant-visual--graphviz svg')).toContainText('Foundation');
    expect(await reply.locator('.assistant-visual--graphviz svg a, .assistant-visual--graphviz svg script').count()).toBe(0);
    await reply.getByRole('button', { name: 'Show data' }).click();
    await expect(reply.getByRole('row', { name: /Matt 12 items 20 items/ })).toBeVisible();
    expect(await reply.innerText()).not.toContain('"series"');
    // Plain code blocks are dark ink on the soft surface in light mode, not .rich-copy's light-on-dark text.
    expect(await reply.locator('.message__markdown pre').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(7, 17, 31)');
    await page.screenshot({ fullPage: false, path: testInfo.outputPath('assistant-visuals.png') });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.evaluate(() => document.documentElement.classList.add('dark'));
        await expect(reply.locator('.assistant-visual--mermaid svg')).toBeVisible();
      }
      await settleForAxe(page);
      const results = await new AxeBuilder({ page }).include('.assistant-shell').analyze();
      await testInfo.attach(`axe-assistant-visuals-${theme}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
      expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    }
    await page.screenshot({ fullPage: false, path: testInfo.outputPath('assistant-visuals-dark.png') });
    await reply.locator('.assistant-visual--graphviz').screenshot({ path: testInfo.outputPath('assistant-visuals-graph-dark.png') });
    api.assertNoUnexpectedRequests();
  });

  test('an assistant visual enlarges into a zoomable view and closes back to where you were', async ({ page }, testInfo) => {
    const assistantChat = visualsChat();
    const api = await installSyntheticApi(page, { assistantChat });
    await authenticateSyntheticUser(page);
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(`projects/${syntheticProject.id}?assistant=1&assistantSessionId=${assistantChat.id}`);
    const workspace = page.getByRole('dialog', { name: 'AI Workspace' });
    const reply = workspace.getByRole('article', { name: 'Assistant reply' });
    await expect(reply.locator('.assistant-visual--graphviz svg')).toBeVisible();

    // The graph opens fitted to the window, zooms in steps, and Escape closes only the zoom.
    const enlargeGraph = reply.locator('.assistant-visual--graphviz').getByRole('button', { name: 'Enlarge' });
    await enlargeGraph.click();
    const zoomedGraph = page.getByRole('dialog', { name: 'Graph' });
    const graph = zoomedGraph.locator('.assistant-zoom__diagram svg');
    await expect(graph).toContainText('Foundation');
    await expect(zoomedGraph.getByRole('button', { name: 'Close' })).toBeFocused();
    const fitWidth = (await graph.boundingBox()).width;
    expect(fitWidth).toBeGreaterThan((await reply.locator('.assistant-visual--graphviz .assistant-visual__diagram svg').boundingBox()).width);
    await zoomedGraph.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoomedGraph.getByRole('button', { name: 'Fit to the window' })).toHaveText('150%');
    await expect.poll(async () => Math.round(((await graph.boundingBox()).width / fitWidth) * 100)).toBe(150);
    await page.keyboard.press('0');
    await expect(zoomedGraph.getByRole('button', { name: 'Fit to the window' })).toHaveText('Fit');
    await page.screenshot({ fullPage: false, path: testInfo.outputPath('assistant-zoom-graph.png') });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
      await expect(graph).toBeVisible();
      const results = await new AxeBuilder({ page }).include('.assistant-zoom').analyze();
      await testInfo.attach(`axe-assistant-zoom-${theme}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
      expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    }
    await page.keyboard.press('Escape');
    await expect(zoomedGraph).toBeHidden();
    await expect(workspace).toBeVisible();
    await expect(enlargeGraph).toBeFocused();

    // The chart redraws at the window's size; a click on the backdrop closes it.
    await reply.locator('.assistant-visual--chart').getByRole('button', { name: 'Enlarge' }).click();
    const zoomedChart = page.getByRole('dialog', { name: 'Work by owner' });
    await expect(zoomedChart.locator('canvas')).toBeVisible();
    await expect.poll(async () => (await zoomedChart.locator('canvas').boundingBox()).height).toBeGreaterThan(500);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath('assistant-zoom-chart-dark.png') });
    await page.mouse.click(4, 4);
    await expect(zoomedChart).toBeHidden();

    // A click on a diagram opens it as well.
    await reply.locator('.assistant-visual--mermaid .assistant-visual__diagram svg').click();
    await expect(page.getByRole('dialog', { name: 'Diagram' }).locator('.assistant-zoom__diagram svg')).toContainText('Release');
    await page.screenshot({ fullPage: false, path: testInfo.outputPath('assistant-zoom-diagram-dark.png') });
    api.assertNoUnexpectedRequests();
  });

  test('a reply lists what it changed in Odin, and undo reverses it after one inline confirmation', async ({ page }, testInfo) => {
    const assistantChat = changesChat();
    const api = await installSyntheticApi(page, { assistantChat });
    // The first undo is held until the other reply has been checked.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/assistant/chats/chat-undo/messages/reply-undo/undo', async (route) => { await held; await route.fallback(); });
    await authenticateSyntheticUser(page);
    // Button colours fade on a theme change; without motion axe reads the settled colours.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ height: 1000, width: 1400 });
    await page.goto(`projects/${syntheticProject.id}?assistant=1&assistantSessionId=${assistantChat.id}`);
    const dialog = page.getByRole('dialog', { name: 'AI Workspace' });
    const replies = dialog.getByRole('article', { name: 'Assistant reply' });
    const changes = replies.nth(0).getByRole('region', { name: 'Changes in Odin' });
    const venue = replies.nth(1).getByRole('region', { name: 'Changes in Odin' });
    await expect(changes.getByRole('button', { name: 'Made 3 changes in Odin' })).toBeVisible();
    await changes.getByRole('button', { name: 'Made 3 changes in Odin' }).click();
    await expect(changes.getByText('Created task "Write the launch FAQ"')).toBeVisible();

    await changes.getByRole('button', { name: 'Undo' }).click();
    await expect(changes.getByText('Undo these 2 changes? Anything edited since stays as it is.')).toBeVisible();
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.evaluate(() => document.documentElement.classList.add('dark'));
        // Surfaces fade to the new theme; check contrast once they have settled.
        await expect.poll(() => changes.locator('.changes__confirm').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(22, 41, 74)');
      }
      await settleForAxe(page);
      const results = await new AxeBuilder({ page }).include('.assistant-shell').analyze();
      await testInfo.attach(`axe-assistant-undo-${theme}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
      expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.screenshot({ fullPage: false, path: testInfo.outputPath('assistant-undo-confirm.png') });
    await changes.getByRole('button', { name: 'Undo changes' }).click();

    // Only this reply shows its undo running; the other reply and the chat carry on as they were.
    await expect(changes.getByRole('status')).toHaveText('Undoing…');
    await expect(venue.getByRole('status')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    // The other reply's undo runs on its own and finishes first; the held one is still running.
    await venue.getByRole('button', { name: 'Undo', exact: true }).click();
    await venue.getByRole('button', { name: 'Undo changes' }).click();
    await expect(venue.getByRole('button', { name: 'Undid this change' })).toBeVisible();
    await expect(venue.getByRole('status')).toHaveCount(0);
    await expect(changes.getByRole('status')).toHaveText('Undoing…');
    release();

    await expect(changes.getByRole('button', { name: 'Undid 2 of 3 changes' })).toBeVisible();
    await expect(changes.getByRole('status')).toHaveCount(0);
    await expect(changes.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await expect(changes.getByText('This kind of change can\'t be undone here.')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'AI Workspace' }).getByText(/^Undid 2 changes\./)).toBeVisible();
    await page.screenshot({ fullPage: false, path: testInfo.outputPath('assistant-undo-done.png') });
    await expect(venue.getByRole('button', { name: 'Undid this change' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('while the assistant works, earlier replies show no undo running and wait to be undone', async ({ page }) => {
    const assistantChat = changesChat();
    assistantChat.messages.push({ content: 'Now plan the venue week.', createdAt: '2026-10-25T15:02:00.000Z', id: 'user-undo-3', role: 'user' });
    assistantChat.run = { id: 'run-working', startedAt: '2026-10-25T15:02:00.000Z', status: 'running' };
    const api = await installSyntheticApi(page, { assistantChat });
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}?assistant=1&assistantSessionId=${assistantChat.id}`);
    const dialog = page.getByRole('dialog', { name: 'AI Workspace' });
    await expect(dialog.getByRole('button', { name: 'Stop' })).toBeVisible();
    const changes = dialog.getByRole('region', { name: 'Changes in Odin' });
    await expect(changes).toHaveCount(2);
    await expect(changes.getByRole('status')).toHaveCount(0);
    for (const index of [0, 1]) await expect(changes.nth(index).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    api.assertNoUnexpectedRequests();
  });

  test('the assistant docks beside the page and stays open while you work, or fills the screen', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(`projects/${syntheticProject.id}?assistant=1`);
    const window = page.getByRole('dialog', { name: 'AI Workspace' });
    await expect(window).toBeVisible();

    await window.getByRole('button', { name: 'Dock beside the page' }).click();
    const panel = page.getByRole('complementary', { name: 'AI Workspace' });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'AI Workspace' })).toHaveCount(0);
    expect(await page.locator('.app-frame').evaluate((element) => getComputedStyle(element).paddingRight)).toBe('460px');
    const tabs = page.getByRole('navigation', { name: 'Project workspace tabs' });
    await expect(tabs).toBeVisible();
    expect(await tabs.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1440 - 460);

    // The page stays usable and the panel stays open as you move around.
    await tabs.getByRole('link', { name: 'Governance' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}/governance`));
    await expect(panel).toBeVisible();
    await page.locator('#main-content').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI Workspace' })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('assistant-docked.png') });
    await settleForAxe(page);
    const results = await new AxeBuilder({ page }).include('.assistant-shell').analyze();
    await testInfo.attach('axe-assistant-docked.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);

    await panel.getByRole('button', { name: 'Maximize' }).click();
    const maximized = page.getByRole('dialog', { name: 'AI Workspace' });
    await expect(maximized).toBeVisible();
    const box = await maximized.boundingBox();
    expect(box.width).toBe(1440);
    expect(await page.evaluate(() => localStorage.getItem('odin.assistant.layout'))).toBe('maximized');
    await maximized.getByRole('button', { name: 'Restore the window size' }).click();
    expect((await page.getByRole('dialog', { name: 'AI Workspace' }).boundingBox()).width).toBeLessThan(1440);
    await page.getByRole('dialog', { name: 'AI Workspace' }).getByRole('button', { name: 'Close assistant' }).click();
    await expect(page.getByRole('dialog', { name: 'AI Workspace' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('project item history restores a prior optimistic revision accessibly', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}`);
    const structureNavigator = page.getByRole('button', { name: 'Open structure navigator' });
    if (await structureNavigator.isVisible()) await structureNavigator.click();
    await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();
    await expect(page.getByRole('heading', { name: 'Release pilot', exact: true })).toBeVisible();
    const historyButton = page.getByRole('button', { name: 'History' });
    await historyButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Restore Release pilot' })).toBeVisible();
    await expect(page.getByText('v2', { exact: true }).first()).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.item-history-card').analyze();
    await testInfo.attach('axe-project-item-history.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    const restorePrevious = page.getByRole('button', { name: 'Restore previous' });
    await restorePrevious.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Pilot release', exact: true })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('governance workspace supports accessible RAID and schedule workflows', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}/governance`);

    await expect(page.getByRole('heading', { name: 'Governance & schedule' })).toBeVisible();
    await expect(page.getByText('Vendor capacity', { exact: true })).toBeVisible();
    await expect(page.getByText('Healthy', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add record' }).click();
    await page.getByLabel('Type', { exact: true }).selectOption('change_request');
    await page.getByLabel('Title', { exact: true }).fill('Approve expanded pilot scope');
    await page.getByLabel('Description', { exact: true }).fill('Approval is required before expanding the pilot cohort.');
    await page.getByLabel('Impact', { exact: true }).selectOption('high');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Approve expanded pilot scope', { exact: true })).toBeVisible();

    const createdRow = page.getByRole('row').filter({ hasText: 'Approve expanded pilot scope' });
    await createdRow.getByRole('button', { name: 'Edit record' }).click();
    await page.getByLabel('Status', { exact: true }).selectOption('approved');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(createdRow.getByText('approved', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Milestones' }).click();
    await expect(page.getByText('Pilot ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Dependencies' }).click();
    await expect(page.locator('.governance-list').getByText('Delivery / Release pilot → Delivery / Release pilot / Validate rollout', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit dependency' }).click();
    await page.getByLabel('Type', { exact: true }).selectOption('SS');
    await page.getByLabel('Lag days').fill('2');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('2 day lag', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Schedule controls' }).click();
    await expect(page.getByRole('heading', { name: 'Working calendar' })).toBeVisible();
    await page.getByLabel('Hours per working day').fill('7.5');
    await page.getByLabel('Holidays').fill('2026-07-03\n2026-11-26');
    await page.getByRole('button', { name: 'Save calendar' }).click();
    await expect(page.getByLabel('Hours per working day')).toHaveValue('7.5');
    await page.getByLabel('Baseline name').fill('Approved browser plan');
    await page.getByLabel('Approval note').fill('Synthetic steering approval.');
    await page.getByRole('button', { name: 'Capture baseline' }).click();
    await expect(page.getByText('Approved browser plan', { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel('Latest baseline variance')).toContainText('0 added / 0 removed');
    const scheduleResults = await new AxeBuilder({ page }).include('.schedule-controls').analyze();
    await testInfo.attach('axe-schedule-controls.json', { body: JSON.stringify(scheduleResults, null, 2), contentType: 'application/json' });
    expect(scheduleResults.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);

    await page.getByRole('button', { name: 'Automation' }).click();
    await expect(page.getByText('Protect launch readiness', { exact: true })).toBeVisible();
    await expect(page.getByText('Goal needs attention: Protect launch readiness', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mark Goal needs attention: Protect launch readiness as read' }).click();
    await expect(page.getByText('Goal needs attention: Protect launch readiness', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add autonomous goal' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Watch portfolio readiness');
    await page.getByLabel('Success measure').fill('No unresolved critical launch risk');
    await page.getByRole('button', { name: 'Add predicate' }).click();
    await expect(page.getByLabel('Verifier', { exact: true }).locator('option[value="communication.v1"]')).toHaveCount(1);
    await page.getByLabel('Verifier', { exact: true }).selectOption('integration.v1');
    await page.getByLabel('Predicate id').fill('delivery-complete');
    await page.getByLabel('Check id').fill('integration.deliveries_succeeded');
    await page.getByLabel('Send signed goal-attention webhooks').check();
    await page.getByRole('button', { name: 'Save' }).click();
    const goalCard = page.locator('.governance-list--goals article').filter({ hasText: 'Watch portfolio readiness' });
    await expect(goalCard).toBeVisible();
    await expect(goalCard).toContainText('composable verifier plan');
    await expect(goalCard).toContainText('escalation: in_app, webhook');
    await goalCard.getByRole('button', { name: 'Add goal monitor' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Critical RAID watch');
    await page.getByLabel('Trigger').selectOption('event');
    await page.getByLabel('Condition field').selectOption('change.impact');
    await page.getByLabel('Condition value').fill('critical');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(goalCard.getByText('Critical RAID watch', { exact: true })).toBeVisible();
    await goalCard.getByRole('button', { name: 'Add goal monitor' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Workflow SLA escalation');
    await page.getByLabel('Trigger').selectOption('event');
    await page.getByLabel('Event').selectOption('workflow.sla.overdue');
    await page.getByLabel('Condition field').selectOption('itemType');
    await page.getByLabel('Condition value').fill('task');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(goalCard.getByText('Workflow SLA escalation', { exact: true })).toBeVisible();
    await goalCard.getByRole('button', { name: 'Run goal now' }).click();
    await expect(goalCard).toContainText('1 run · composable verifier plan');

    await page.getByRole('button', { name: 'Register' }).click();
    await createdRow.getByRole('button', { name: 'Delete record' }).click();
    await expect(page.getByRole('heading', { name: 'Delete item' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Approve expanded pilot scope' })).toHaveCount(0);

    const results = await new AxeBuilder({ page }).include('.governance-workspace').analyze();
    await testInfo.attach('axe-governance.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test("only a goal's owner can let it make changes on its own", async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page, {
      agentGoals: [
        { constraints: { autoApply: true, maxAttempts: 5 }, id: 'goal-riley', ownerUserId: 'user-riley', projectId: syntheticProject.id, scope: { projectIds: [syntheticProject.id] }, status: 'active', success: { measure: 'Finished stories are closed' }, title: 'Tidy the plan', version: 1 },
        { constraints: { autoApply: false, readOnly: true }, id: 'goal-watch', ownerUserId: 'user-synthetic', projectId: syntheticProject.id, scope: { kind: 'assistant-watch' }, status: 'active', success: { measure: 'Tell me if the launch slips' }, title: 'Watch: Launch date slipping', version: 1 },
      ],
      tenantUsers: [{ email: 'riley@example.com', id: 'user-riley', name: 'Riley Planner' }],
    });
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}/governance`);
    await page.getByRole('button', { name: 'Automation' }).click();
    const editor = page.locator('.governance-editor');
    const card = (title) => page.locator('.governance-list--goals article').filter({ hasText: title });
    const savedConstraints = async (goalId) => {
      const saved = page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith(`/api/agent-goals/${goalId}`));
      await editor.getByRole('button', { name: 'Save' }).click();
      return (await saved).postDataJSON().constraints;
    };

    // New goals start off.
    await page.getByRole('button', { name: 'Add autonomous goal' }).click();
    await expect(editor.getByLabel('Let this goal make changes on its own')).not.toBeChecked();
    await editor.getByRole('button', { name: 'Cancel' }).click();

    // The owner turns it on.
    await expect(card('Protect launch readiness')).toContainText('Watches only · No missed launch milestone');
    await card('Protect launch readiness').getByRole('button', { name: 'Edit autonomous goal' }).click();
    await expect(editor.getByText('Its runs happen with nobody watching and act as you. They can change anything you can.')).toBeVisible();
    await editor.getByLabel('Let this goal make changes on its own').check();
    expect((await savedConstraints('goal-synthetic')).autoApply).toBe(true);
    await expect(card('Protect launch readiness')).toContainText('Makes changes on its own · No missed launch milestone');

    // Someone else's goal: its state is text, and saving turns it off.
    await expect(card('Tidy the plan')).toContainText('Makes changes on its own');
    await card('Tidy the plan').getByRole('button', { name: 'Edit autonomous goal' }).click();
    await expect(editor.getByLabel('Let this goal make changes on its own')).toHaveCount(0);
    await expect(editor.getByText('Makes changes on its own (set by Riley Planner).')).toBeVisible();
    await expect(editor.getByText('Saving stops this goal making changes on its own. Only Riley Planner can turn that back on.')).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.governance-editor').analyze();
    await testInfo.attach('axe-goal-changes.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    expect((await savedConstraints('goal-riley')).autoApply).toBe(false);
    await expect(card('Tidy the plan')).toContainText('Watches only');

    // A monitor the assistant set up always watches only.
    await expect(card('Watch: Launch date slipping')).toContainText('Watches only');
    await card('Watch: Launch date slipping').getByRole('button', { name: 'Edit autonomous goal' }).click();
    await expect(editor.getByLabel('Let this goal make changes on its own')).toHaveCount(0);
    await expect(editor.getByText('Watches only. Monitors the assistant sets up never make changes.')).toBeVisible();
    await editor.getByRole('button', { name: 'Cancel' }).click();
    api.assertNoUnexpectedRequests();
  });

  test('portfolio workspace supports accessible hierarchy, strategy, and demand workflows', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('portfolio');

    await expect(page.getByRole('heading', { name: 'Portfolio & strategy' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Portfolio hierarchy' }).getByText('Enterprise growth', { exact: true })).toBeVisible();
    await expect(page.getByText('750,000 USD', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Add node' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Operations portfolio');
    await page.getByLabel('Description', { exact: true }).fill('Operational resilience investments.');
    await page.getByRole('button', { name: 'Save' }).click();
    const createdNode = page.getByRole('row').filter({ hasText: 'Operations portfolio' });
    await expect(createdNode).toBeVisible();
    await createdNode.getByRole('button', { name: 'Edit portfolio node' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Operations resilience');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Operations resilience' })).toBeVisible();

    await page.getByRole('button', { name: 'Add objective' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Reduce service interruptions');
    await page.getByLabel('Current', { exact: true }).fill('20');
    await page.getByLabel('Target', { exact: true }).fill('80');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Strategy' }).click();
    await expect(page.getByRole('heading', { name: 'Reduce service interruptions' })).toBeVisible();

    await page.getByRole('button', { name: 'Align project' }).click();
    await page.getByLabel('Portfolio / program').selectOption('portfolio-node-3');
    await page.locator('dialog[open] label').filter({ hasText: /^Objective/ }).locator('select').selectOption('objective-2');
    await page.getByLabel('Demand stage').selectOption('approved');
    await page.getByLabel('Benefit', { exact: true }).fill('125000');
    await page.getByLabel('Requested funding').fill('100000');
    await page.getByLabel('Requested hours').fill('1200');
    await page.getByLabel('Strategic score').fill('85');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Demand & scenarios' }).click();
    const createdAlignment = page.getByRole('row').filter({ hasText: 'Operations resilience' });
    await expect(createdAlignment.getByText('125,000 USD', { exact: true })).toBeVisible();
    await createdAlignment.getByRole('button', { name: 'Edit project alignment' }).click();
    await page.locator('dialog[open] label').filter({ hasText: /^Scenario/ }).locator('select').selectOption('optimistic');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Operations resilience' }).getByText('optimistic', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add scenario plan' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Operations funded plan');
    await page.locator('dialog[open] select').first().selectOption('portfolio-node-3');
    await page.getByLabel('Funding limit').fill('150000');
    await page.getByLabel('Resource hour limit').fill('2000');
    await page.locator('dialog[open] label').filter({ hasText: /^Status/ }).locator('select').selectOption('submitted');
    await page.getByRole('button', { name: 'Save' }).click();
    const planCard = page.locator('.scenario-grid article').filter({ hasText: 'Operations funded plan' });
    await expect(planCard).toBeVisible();
    await planCard.getByRole('button', { name: 'Edit scenario plan' }).click();
    await page.locator('dialog[open] label').filter({ hasText: /^Status/ }).locator('select').selectOption('approved');
    await page.getByLabel('Decision note').fill('Approved by steering committee.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(planCard.getByText('approved', { exact: true })).toBeVisible();
    await expect(planCard.getByText('Approved by steering committee.', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Capture baseline' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Operations approval baseline');
    await page.locator('dialog[open] select').first().selectOption('portfolio-node-3');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Operations approval baseline' })).toBeVisible();

    const portfolioSearch = page.locator('.portfolio-filters input[type="search"]');
    await portfolioSearch.fill('not present');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Hierarchy' }).click();
    await expect(page.getByText('No matching portfolio nodes.', { exact: true })).toBeVisible();
    await portfolioSearch.fill('');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('region', { name: 'Portfolio hierarchy' }).getByText('Enterprise growth', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).include('.portfolio-page').analyze();
    await testInfo.attach('axe-portfolio.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('resources directory edits profiles with role and skill pills, allocations, leveling and time off', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('resources');

    await expect(page.getByRole('heading', { name: 'Resources', exact: true })).toBeVisible();
    const people = page.getByRole('region', { name: 'People' });
    const alex = people.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Alex Engineer' }) });
    await expect(alex.getByText(/44 of 40 h · over/)).toBeVisible();

    await page.getByRole('button', { name: 'Add resource' }).click();
    const profile = page.getByRole('dialog', { name: 'Add resource' });
    await profile.getByLabel('Name', { exact: true }).fill('Jordan Delivery');
    await profile.getByLabel('Odin login').selectOption('user-riley');
    await profile.getByLabel('Roles').fill('Program Manager');
    await profile.getByLabel('Roles').press('Enter');
    await profile.getByLabel('Skills', { exact: true }).fill('Portfolio delivery');
    await profile.getByLabel('Level for the new skill').selectOption('5');
    await profile.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(profile.getByRole('button', { name: 'Remove Program Manager' })).toBeVisible();
    await expect(profile.getByLabel('Portfolio delivery level')).toHaveValue('5');
    await profile.getByLabel('Cost').fill('150');
    await profile.getByLabel('Suggested bill').fill('$240');
    await profile.getByLabel('Minimum bill').fill('200');
    await profile.getByRole('button', { name: 'Save' }).click();
    const jordan = people.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Jordan Delivery' }) });
    await expect(jordan.getByText('Program Manager', { exact: true })).toBeVisible();
    await expect(jordan.getByText(/Portfolio delivery\s+Expert/)).toBeVisible();
    await expect(jordan.getByText('riley@example.com')).toBeVisible();

    await jordan.getByRole('button', { name: 'Edit Jordan Delivery' }).click();
    await page.getByRole('dialog', { name: 'Edit Jordan Delivery' }).getByLabel('Name', { exact: true }).fill('Jordan Portfolio');
    await page.getByRole('dialog', { name: 'Edit Jordan Delivery' }).getByRole('button', { name: 'Save' }).click();
    await expect(people.getByRole('heading', { name: 'Jordan Portfolio' })).toBeVisible();

    await page.getByRole('button', { name: 'Allocations' }).click();
    await page.getByRole('button', { name: 'Add allocation' }).click();
    const allocation = page.getByRole('dialog', { name: 'Add allocation' });
    await allocation.getByLabel('Person').selectOption('resource-2');
    await allocation.getByLabel('Project', { exact: true }).selectOption(syntheticProject.id);
    await allocation.getByLabel('Hours per week').fill('32');
    await allocation.getByLabel('Status').selectOption('active');
    await allocation.getByLabel('Project bill rate per hour').fill('250');
    await allocation.getByRole('button', { name: 'Save' }).click();
    const allocations = page.getByRole('region', { name: 'Allocations' });
    const jordanRow = allocations.getByRole('row').filter({ hasText: 'Jordan Portfolio' });
    await expect(jordanRow.getByText('32 h/wk (80%)', { exact: true })).toBeVisible();
    await expect(jordanRow.getByText('$250.00/h', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Planning' }).click();
    const planning = page.getByRole('region', { name: 'Planning' });
    await expect(planning.getByRole('heading', { name: 'Demand by week' })).toBeVisible();
    await expect(planning.getByRole('row').filter({ hasText: 'baseline' }).getByText('$3,740', { exact: true })).toBeVisible();
    await planning.getByRole('button', { name: 'Review' }).click();
    const move = page.getByRole('dialog', { name: 'Move workload' });
    await expect(move.getByLabel('Move to')).toHaveValue('resource-2');
    await move.getByRole('button', { name: 'Move hours' }).click();
    await page.getByRole('button', { name: 'Allocations' }).click();
    await expect(allocations.getByRole('row').filter({ hasText: 'Alex Engineer' }).getByText('40 h/wk (100%)', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Time off' }).click();
    await page.getByRole('button', { name: 'Add time off' }).click();
    const timeOff = page.getByRole('dialog', { name: 'Add time off' });
    await timeOff.getByLabel('Person').selectOption('resource-2');
    await timeOff.getByLabel('Hours off a day').fill('4');
    await timeOff.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('region', { name: 'Time off' }).getByRole('row').filter({ hasText: 'Jordan Portfolio' })).toBeVisible();

    const results = await new AxeBuilder({ page }).include('.resources-page').analyze();
    await testInfo.attach('axe-resources.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('finance page keeps ledgers, rates, controls, time and receipts', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('finance');

    await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add ledger entry' }).first().click();
    await page.locator('dialog[open] label').filter({ hasText: /^Kind/ }).locator('select').selectOption('funding');
    await page.getByLabel('Category').fill('Growth funding');
    await page.getByLabel('Amount').fill('250000');
    await page.getByRole('button', { name: 'Save' }).click();
    const financeRegion = page.getByRole('region', { name: 'Project financials' });
    await expect(financeRegion.getByRole('row').filter({ hasText: 'Growth funding' }).getByText('$250,000', { exact: true })).toBeVisible();
    await financeRegion.getByRole('button', { name: 'Add rate' }).click();
    await page.locator('dialog[open] label').filter({ hasText: /^Resource/ }).locator('select').selectOption('resource-synthetic');
    await page.getByLabel('Cost rate').fill('160');
    await page.getByLabel('Bill rate').fill('240');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(financeRegion.getByRole('row').filter({ hasText: 'Alex Engineer' }).getByText('$160 / $240', { exact: true })).toBeVisible();
    await financeRegion.getByRole('button', { name: 'Add FX rate' }).click();
    await page.getByLabel('Rate', { exact: true }).fill('0.92');
    await page.locator('dialog[open]').getByLabel('Source', { exact: true }).fill('Controller');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(financeRegion.getByRole('row').filter({ hasText: 'Controller' }).getByText('0.92', { exact: true })).toBeVisible();
    await financeRegion.getByRole('button', { name: 'Add accounting period' }).click();
    await page.getByLabel('Name', { exact: true }).fill('July close');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(financeRegion.getByRole('row').filter({ hasText: 'July close' })).toBeVisible();
    await financeRegion.getByRole('button', { name: 'Add control policy' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Steering thresholds');
    await page.getByLabel('Project scope').selectOption(syntheticProject.id);
    await page.getByLabel('Forecast tolerance (%)').fill('10');
    await page.getByLabel('Minimum margin (%)').fill('20');
    await page.getByLabel('Admin expense approval at').fill('1000');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(financeRegion.getByRole('row').filter({ hasText: 'Steering thresholds' }).getByText('Margin 20% · admin approval $1,000', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add time' }).first().click();
    await page.locator('dialog[open] label').filter({ hasText: /^Resource/ }).locator('select').selectOption('resource-synthetic');
    await page.getByLabel('Hours', { exact: true }).fill('6.5');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Time & expenses' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Alex Engineer' }).getByText('6.5', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add period' }).click();
    await page.getByLabel('Name', { exact: true }).fill('July week three');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'July week three' })).toBeVisible();
    await page.getByRole('button', { name: 'Upload receipt' }).click();
    await page.getByLabel('Receipt file').setInputFiles({ buffer: Buffer.from('synthetic receipt bytes'), mimeType: 'application/pdf', name: 'travel-updated.pdf' });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'travel-updated.pdf' })).toBeVisible();

    const results = await new AxeBuilder({ page }).include('.resource-page').analyze();
    await testInfo.attach('axe-finance.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('project resources tab shows who is on the project and takes a typed project rate', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}?projectSettings=permissions`);
    await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}/resources`));

    const tab = page.getByRole('region', { name: 'Resources' });
    const row = tab.getByRole('row').filter({ hasText: 'Synthetic Demo' });
    await expect(row.getByText('44 h/wk · 110%', { exact: true })).toBeVisible();
    await expect(row.getByText(/\$220\.00\/h/)).toBeVisible();

    await row.getByRole('button', { name: 'Edit Synthetic Demo' }).click();
    const dialog = page.getByRole('dialog', { name: `Synthetic Demo on ${syntheticProject.name}` });
    await dialog.getByLabel('Project bill rate per hour').fill('$255.50');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByText('$255.50/h', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).include('.project-resources').analyze();
    await testInfo.attach('axe-project-resources.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('workflow workspace supports accessible lifecycle, approval, baseline, template, and custom-field workflows', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('workflows');

    await expect(page.getByRole('heading', { name: 'Workflow governance' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Delivery lifecycle' })).toBeVisible();

    await page.getByRole('button', { name: 'Bindings' }).click();
    await expect(page.getByRole('region', { name: 'Project bindings' }).getByText('Delivery lifecycle', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Bind workflow' }).click();
    const bindDialog = page.getByRole('dialog', { name: 'Bind workflow' });
    await expect(bindDialog.getByLabel('Item type').locator('option')).toHaveText(['Project', 'Epic', 'Story', 'Task', 'Ticket']);
    await bindDialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Approvals' }).click();
    await page.getByRole('button', { name: 'Decide' }).click();
    await page.getByLabel('Decision note').fill('Closure evidence accepted.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('region', { name: 'Transition approvals' }).getByText('approved', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Baselines' }).click();
    await page.getByRole('button', { name: 'Capture baseline' }).click();
    await page.getByLabel('Baseline name').fill('Executive checkpoint');
    await page.getByLabel('Note').fill('Approved scope and schedule.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Executive checkpoint', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Custom fields' }).click();
    await expect(page.getByRole('region', { name: 'Custom fields table' }).getByRole('cell', { exact: true, name: 'Acceptance evidence' })).toBeVisible();
    await page.getByRole('button', { name: 'Add field' }).click();
    await page.getByLabel('Field name').fill('Control owner');
    await page.getByLabel('Item type').selectOption('ticket');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Control owner' }).getByRole('cell', { name: 'Ticket' })).toBeVisible();

    await page.getByRole('button', { name: 'History' }).click();
    const historyRow = page.getByRole('region', { name: 'Immutable transition history' }).getByRole('row').filter({ hasText: 'Planned' }).filter({ hasText: 'In Progress' });
    await expect(historyRow).toBeVisible();
    await expect(historyRow.getByText('Transition event dispatched', { exact: true })).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.workflow-page').analyze();
    await testInfo.attach('axe-workflows.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('reporting workspace supports accessible dashboards, search, custom reports, views, schedules, and run history', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page); await authenticateSyntheticUser(page); await page.goto('reports');
    await expect(page.getByRole('heading', { name: 'Search & reporting' })).toBeVisible(); await expect(page.getByRole('region', { name: 'Standard enterprise dashboards' }).getByText('1', { exact: true }).first()).toBeVisible(); await expect(page.getByText('110%', { exact: true })).toBeVisible();
    const reportingTabs = page.getByRole('navigation', { name: 'Search and reporting sections' });
    await reportingTabs.getByRole('button', { name: 'search', exact: true }).click(); const searchRegion = page.getByRole('region', { name: 'Indexed enterprise search' }); await expect(searchRegion.getByText(/Enter a word or phrase to search/)).toBeVisible(); await searchRegion.getByLabel('Search', { exact: true }).fill('launch'); await searchRegion.getByRole('button', { name: 'Search', exact: true }).click(); await expect(searchRegion.getByRole('link', { name: 'Synthetic Delivery Plan', exact: true })).toBeVisible(); await searchRegion.getByLabel('Search', { exact: true }).fill('vendor'); await searchRegion.getByRole('button', { name: 'Search', exact: true }).click(); await expect(searchRegion.getByText('Vendor capacity', { exact: true })).toBeVisible();
    await reportingTabs.getByRole('button', { name: 'reports', exact: true }).click(); await page.getByRole('button', { name: 'Add report' }).click(); await page.getByLabel('Name', { exact: true }).fill('Launch checkpoint'); await page.getByLabel('Description').fill('Executive launch checkpoint.'); await page.getByLabel('Dataset').selectOption('risk'); await expect(page.getByLabel('projectId', { exact: true })).toBeChecked(); await page.getByLabel('Dataset').selectOption('project'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    const reportCard = page.getByRole('article').filter({ hasText: 'Launch checkpoint' }); await expect(reportCard).toBeVisible(); await reportCard.getByRole('button', { name: 'Run' }).click(); await expect(page.getByRole('dialog').getByRole('heading', { name: 'Launch checkpoint' })).toBeVisible(); await expect(page.getByRole('dialog').getByText('Synthetic Delivery Plan', { exact: true })).toBeVisible(); await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await reportingTabs.getByRole('button', { name: 'views', exact: true }).click(); await page.getByRole('button', { name: 'Add view' }).click(); await page.getByLabel('Name', { exact: true }).fill('Launch risks'); await page.getByLabel('Filters JSON').fill('{"impact":"high"}'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Launch risks' })).toBeVisible();
    await reportingTabs.getByRole('button', { name: 'subscriptions', exact: true }).click(); await page.getByRole('button', { name: 'Add subscription' }).click(); const subscriptionDialog = page.locator('dialog[open]'); await subscriptionDialog.getByLabel('Report').selectOption({ label: 'Launch checkpoint' }); await subscriptionDialog.getByLabel('Format').selectOption('xlsx'); await subscriptionDialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('row').filter({ hasText: 'Launch checkpoint' }).getByText('in_app · XLSX', { exact: true })).toBeVisible();
    await reportingTabs.getByRole('button', { name: 'runs', exact: true }).click(); await expect(page.getByRole('row').filter({ hasText: 'Launch checkpoint' }).getByText('completed', { exact: true })).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.reporting-page').analyze(); await testInfo.attach('axe-reporting.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' }); expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]); api.assertNoUnexpectedRequests();
  });

  test('identity administration supports verified domains, custom access, credentials, reviews, and responsive accessibility', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page, { admin: true, approvedImpersonation: true }); await authenticateSyntheticUser(page); await page.goto('admin/identity');
    await expect(page.getByRole('heading', { name: 'Enterprise identity' })).toBeVisible(); await expect(page.getByText('none', { exact: true }).first()).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Identity control sections' });
    const editor = page.locator('dialog[open]');
    await tabs.getByRole('button', { name: 'domains', exact: true }).click(); await page.getByRole('button', { name: 'Add domain' }).click(); await editor.getByLabel('Domain').fill('identity.example.com'); await editor.getByRole('button', { name: 'Save', exact: true }).click(); const proof = await editor.locator('code').textContent(); await editor.getByRole('button', { name: 'Close', exact: true }).click();
    const domainRow = page.getByRole('row').filter({ hasText: 'identity.example.com' }); await domainRow.getByRole('button', { name: 'Verify' }).click(); await editor.getByLabel('Verification value').fill(proof); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(domainRow.getByText('verified', { exact: true })).toBeVisible();
    await tabs.getByRole('button', { name: 'roles', exact: true }).click(); await page.getByRole('button', { name: 'Add role' }).click(); await editor.getByLabel('Name', { exact: true }).fill('Analyst'); await editor.getByLabel('Key').fill('analyst'); await editor.getByLabel('Capabilities').fill('projects.read,reports.run'); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Analyst', exact: true })).toBeVisible();
    await tabs.getByRole('button', { name: 'groups', exact: true }).click(); await page.getByRole('button', { name: 'Add group' }).click(); await editor.getByLabel('Name', { exact: true }).fill('Delivery analysts'); await editor.getByLabel('Role keys').fill('analyst'); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Delivery analysts' })).toBeVisible();
    await tabs.getByRole('button', { name: 'service accounts', exact: true }).click(); await page.getByRole('button', { name: 'Add service account' }).click(); await editor.getByLabel('Name', { exact: true }).fill('BI reader'); await editor.getByLabel('Scopes').fill('reporting.read'); await editor.getByLabel('Project IDs').fill(syntheticProject.id); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor.getByText('Shown once')).toBeVisible(); await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('cell', { name: 'BI reader' })).toBeVisible();
    await tabs.getByRole('button', { name: 'reviews', exact: true }).click(); await page.getByRole('button', { name: 'Schedule campaign' }).click(); await editor.getByLabel('Name', { exact: true }).fill('Quarterly privileged access'); await editor.getByLabel('Reviewer administrator ID').fill('admin-reviewer'); await editor.getByRole('button', { name: 'Save', exact: true }).click(); const campaignRow = page.getByRole('row').filter({ hasText: 'Quarterly privileged access' }); await expect(campaignRow.getByText('Enabled', { exact: true })).toBeVisible(); await campaignRow.getByRole('button', { name: 'Pause' }).click(); await expect(campaignRow.getByText('Paused', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start review' }).click(); await editor.getByLabel('Name', { exact: true }).fill('Quarterly access review'); await editor.getByLabel('Reviewer user ID').fill('admin-reviewer'); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('button', { name: 'Certify' }).first()).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.identity-page').analyze(); await testInfo.attach('axe-identity.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' }); expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]); api.assertNoUnexpectedRequests();
    await tabs.getByRole('button', { name: 'impersonation', exact: true }).click(); const approvedRow = page.getByRole('row').filter({ hasText: 'Investigate an authorized support incident.' }); await approvedRow.getByRole('button', { name: 'Start session' }).click(); await expect(page).toHaveURL(/\/app\/$/); await expect(page.getByRole('status')).toContainText('acting as Target User'); await page.getByRole('button', { name: 'End impersonation' }).click(); await expect(page.getByRole('status')).toHaveCount(0); await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Synthetic$/ })).toBeVisible(); api.assertNoUnexpectedRequests();
  });

  test('delegated custom-role capabilities allow identity and integration administration without tenant admin', async ({ page }) => {
    const api = await installSyntheticApi(page, { capabilities: ['identity.manage', 'integrations.manage'] }); await authenticateSyntheticUser(page);
    await page.goto('admin/identity'); await expect(page.getByRole('heading', { name: 'Enterprise identity' })).toBeVisible();
    await page.goto('admin/integrations'); await expect(page.getByRole('heading', { name: 'API & integrations' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('integration administration supports OAuth credentials, signed webhooks, health, and DLQ replay', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page, { admin: true }); await authenticateSyntheticUser(page); await page.goto('admin/integrations');
    await expect(page.getByRole('heading', { name: 'API & integrations' })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Portfolio reader', exact: true })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Integration control sections' }); const editor = page.locator('dialog[open]');
    await page.getByRole('button', { name: 'Add application' }).click(); await editor.getByLabel('Name').fill('Delivery API'); await editor.getByLabel(syntheticProject.name).check(); await editor.getByRole('button', { name: 'Save' }).click(); await expect(editor.getByText('Shown once')).toBeVisible(); await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Delivery API', exact: true })).toBeVisible();
    const readerRow = page.getByRole('row').filter({ hasText: 'Portfolio reader' }); await expect(readerRow.getByRole('cell', { name: syntheticProject.name })).toBeVisible();
    await readerRow.getByRole('button', { name: 'Edit Portfolio reader' }).click(); await expect(editor.getByRole('heading', { name: 'Edit Portfolio reader' })).toBeVisible(); await expect(editor.getByLabel(syntheticProject.name)).toBeChecked(); await editor.getByLabel(syntheticProject.name).uncheck(); await editor.getByRole('button', { name: 'Save' }).click(); await expect(editor).toHaveCount(0); await expect(readerRow.getByRole('cell', { name: 'None', exact: true })).toBeVisible();
    await readerRow.getByRole('button', { name: 'Edit Portfolio reader' }).click(); await editor.getByLabel(syntheticProject.name).check(); await editor.getByRole('button', { name: 'Save' }).click(); await expect(readerRow.getByRole('cell', { name: syntheticProject.name })).toBeVisible();
    await tabs.getByRole('button', { name: 'webhooks', exact: true }).click(); await expect(page.getByText('degraded', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Add webhook' }).click(); await editor.getByLabel('Name').fill('Launch receiver'); await editor.getByLabel('HTTPS endpoint').fill('https://hooks.example.com/launch'); await editor.getByRole('button', { name: 'Save' }).click(); await expect(editor.locator('code')).toContainText('odin_whsec'); await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Launch receiver' })).toBeVisible();
    await tabs.getByRole('button', { name: 'deliveries', exact: true }).click(); await page.getByLabel('Status').selectOption('dead'); const deadRow = page.getByRole('row').filter({ hasText: 'event-synthetic' }); await expect(deadRow.getByText('dead', { exact: true })).toBeVisible(); await deadRow.getByRole('button', { name: 'Replay' }).click(); await page.getByLabel('Status').selectOption('pending'); await expect(page.getByRole('row').filter({ hasText: 'event-synthetic' }).getByText('pending', { exact: true })).toBeVisible();
    await tabs.getByRole('button', { name: 'connectors', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Enterprise connectors' })).toBeVisible(); await expect(page.getByRole('cell', { name: /Engineering Jira/ })).toBeVisible();
    await page.getByRole('button', { name: 'Add connector' }).click(); await editor.getByLabel('Name').fill('Delivery GitHub'); await editor.getByLabel('Provider').selectOption('github'); await editor.getByLabel('Project IDs').fill(syntheticProject.id); await editor.getByRole('button', { name: 'Save' }).click(); await expect(editor.getByText('Shown once')).toBeVisible(); await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('cell', { name: /Delivery GitHub/ })).toBeVisible();
    const connectorRow = page.getByRole('row').filter({ hasText: 'Engineering Jira' }); await connectorRow.getByRole('button', { name: 'Queue sync' }).click(); await expect(page.getByRole('heading', { name: 'Recent activity' }).locator('span')).toHaveText('2'); await connectorRow.getByRole('button', { name: 'Add mapping' }).click(); await editor.getByLabel('External ID').fill('JIRA-101'); await editor.getByLabel('Odin ID').fill('task-synthetic'); await editor.getByRole('button', { name: 'Save' }).click(); await expect(page.getByText('issue:JIRA-101', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Keep Odin' }).click(); await expect(page.getByText('No unresolved conflicts.')).toBeVisible();
    await page.getByPlaceholder('Provider, project, scope, or name').focus(); await expect(page.getByPlaceholder('Provider, project, scope, or name')).toBeFocused();
    const results = await new AxeBuilder({ page }).include('.integration-page').analyze(); await testInfo.attach('axe-integrations.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' }); expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]); api.assertNoUnexpectedRequests();
  });

  test('OAuth allowlists cannot be saved when projects fail to load', async ({ page }) => {
    const api = await installSyntheticApi(page, { admin: true }); await authenticateSyntheticUser(page);
    await page.route('**/api/projects', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' }));
    await page.goto('admin/integrations'); const editor = page.locator('dialog[open]');
    await page.getByRole('row').filter({ hasText: 'Portfolio reader' }).getByRole('button', { name: 'Edit Portfolio reader' }).click();
    await expect(editor.getByRole('alert')).toContainText('Projects could not be loaded'); await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    api.assertNoUnexpectedRequests();
  });

  test('non-admin user is denied the admin route', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('admin');
    await expect(page).toHaveURL(/\/app\/\?notice=admin$/);
    await expect(page.getByRole('status').filter({ hasText: 'Tenant administration is available to workspace admins.' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Synthetic$/ })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('designated emergency access requires an incident reason and MFA and shows a persistent warning', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page); api.resetAuthentication(); await page.goto('/app/login');
    await page.getByRole('button', { name: 'Emergency access' }).click();
    await page.getByLabel('Work email').fill('demo@example.com'); await page.getByLabel('Password').fill('SyntheticPass123!'); await page.getByLabel('Incident reason').fill('Synthetic identity provider outage incident.');
    await page.getByRole('button', { name: 'Request emergency access' }).click(); await page.getByLabel('Authenticator or backup code').fill('123456'); await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page).toHaveURL(/\/app\/$/); await expect(page.getByRole('alert')).toContainText('Emergency access active');
    const results = await new AxeBuilder({ page }).include('aside[role="alert"]').analyze(); await testInfo.attach('axe-break-glass.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' }); expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    await page.getByRole('button', { name: 'End emergency session' }).click(); await expect(page).toHaveURL(/\/app\/login$/); api.assertNoUnexpectedRequests();
  });

  test('login and authenticated project list axe smoke', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    api.resetAuthentication();
    await page.goto('/app/login');
    const loginResults = await new AxeBuilder({ page }).analyze();
    await testInfo.attach('axe-login.json', { body: JSON.stringify(loginResults, null, 2), contentType: 'application/json' });
    expect(loginResults.violations.filter(({ impact }) => impact === 'critical')).toEqual([]);

    await authenticateSyntheticUser(page);
    await page.goto('projects');
    await expect(page.getByRole('table').getByText(syntheticProject.name, { exact: true })).toBeVisible();
    const projectResults = await new AxeBuilder({ page }).analyze();
    await testInfo.attach('axe-projects.json', { body: JSON.stringify(projectResults, null, 2), contentType: 'application/json' });
    expect(projectResults.violations.filter(({ impact }) => impact === 'critical')).toEqual([]);
    api.assertNoUnexpectedRequests();
  });
});
