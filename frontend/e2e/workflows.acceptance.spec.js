import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Workflow definition editor, typed templates, and the places templates are applied.
// Runs against the synthetic API; the synthetic templates include a legacy free-form row.

const API = 'http://localhost:3001';

async function signIn(page) {
  const api = await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  return api;
}

function recordPosts(page, path) {
  const bodies = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === path) bodies.push(request.postDataJSON());
  });
  return bodies;
}

async function expectNoSeriousAxeViolations(page, selector, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

test('the definition editor validates live and saves a structured workflow', async ({ page }, testInfo) => {
  const api = await signIn(page);
  const created = recordPosts(page, '/api/workflows/definitions');
  await page.goto('workflows');

  await expect(page.getByRole('heading', { name: 'Workflow governance' })).toBeVisible();
  await page.getByRole('link', { name: 'New workflow' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New workflow' })).toBeVisible();
  await page.getByLabel('Workflow name').fill('Change control');
  await page.getByRole('checkbox', { exact: true, name: 'Ticket' }).check();

  const states = page.getByTestId('workflow-state-row');
  await expect(states).toHaveCount(3);
  await page.getByRole('button', { name: 'Add state' }).click();
  await expect(states).toHaveCount(4);
  const added = states.nth(3);
  await added.getByLabel('State label').fill('');
  const validation = page.getByTestId('workflow-validation');
  await expect(validation).toContainText('State 4 needs a label.');
  await expect(added.getByText('State 4 needs a label.')).toBeVisible();
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByText('Fix the problems listed above before saving.')).toBeVisible();
  expect(created).toHaveLength(0);

  await added.getByLabel('State label').fill('Cancelled');
  await added.getByLabel('State key').fill('cancelled');
  await added.getByLabel('Category').selectOption('cancelled');
  // The row is still settling here, and check() can land on the label, which toggles the box,
  // then retry and toggle it back. This test is about saving the state, so toggle it directly.
  await added.getByLabel('Terminal').dispatchEvent('click');
  await expect(added.getByLabel('Terminal')).toBeChecked();

  await page.getByRole('button', { name: 'Add transition' }).click();
  const transitions = page.getByTestId('workflow-transition-row');
  await expect(transitions).toHaveCount(3);
  const cancel = transitions.nth(2);
  await cancel.getByLabel('From state').selectOption({ label: 'Ready' });
  await cancel.getByLabel('To state').selectOption({ label: 'Cancelled' });
  await cancel.getByLabel('Transition key').fill('cancel');
  await cancel.getByText('Rules').click();
  await cancel.getByRole('group', { name: 'Roles allowed to move items' }).getByLabel('manager').check();
  await cancel.getByLabel('Requires approval before the move').check();
  await cancel.getByRole('group', { name: 'Approver roles' }).getByLabel('admin', { exact: true }).check();

  await expect(validation).toContainText('The workflow is valid.');
  const preview = page.getByTestId('workflow-preview');
  await expect(preview.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(preview).toContainText('(manager · approval)');
  await expectNoSeriousAxeViolations(page, '.wf-page', testInfo, 'definition-editor');

  await page.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByText('Workflow created.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Change control' })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ itemTypes: ['story', 'ticket'], name: 'Change control', status: 'active' });
  expect(created[0].states.map((state) => state.key)).toEqual(['ready', 'in_progress', 'done', 'cancelled']);
  expect(created[0].states[3]).toMatchObject({ category: 'cancelled', terminal: true });
  expect(created[0].transitions[2]).toMatchObject({ allowedRoles: ['manager'], approvalRequired: true, approverRoles: ['admin'], fromState: 'ready', key: 'cancel', toState: 'cancelled' });
  expect(created[0].states[0]).not.toHaveProperty('uid');

  await expect(page.getByRole('button', { name: 'Create workflow' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit workflow' }).click();
  await page.getByLabel('Description').fill('Governed change lifecycle.');
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByText('Workflow saved.')).toBeVisible();
  await expect(page.getByText('Governed change lifecycle.')).toBeVisible();
  await expectNoSeriousAxeViolations(page, '.wf-page', testInfo, 'definition-view');
  api.assertNoUnexpectedRequests();
});

test('templates show legacy rows as needing an update, and a workflow template prefills a definition', async ({ page }, testInfo) => {
  const api = await signIn(page);
  const created = recordPosts(page, '/api/workflows/definitions');
  await page.goto('workflows?tab=templates');

  const legacy = page.getByTestId('template-row').filter({ hasText: 'Delivery starter' });
  await expect(legacy.getByText('Needs update')).toBeVisible();
  await expect(legacy.getByRole('link', { name: 'Use template' })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page, '.wf-page', testInfo, 'templates-list');
  await legacy.getByRole('link', { name: 'Delivery starter' }).click();
  await expect(page.getByTestId('template-legacy-notice')).toContainText('This template needs an update.');
  await page.getByRole('link', { name: 'Templates' }).click();

  await page.getByTestId('template-row').filter({ hasText: 'Story flow' }).getByRole('link', { name: 'Use template' }).click();
  await expect(page.getByText('Prefilled from the "Story flow" template.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Workflow name')).toHaveValue('Story flow');
  await expect(page.getByTestId('workflow-state-row')).toHaveCount(3);
  await expect(page.getByTestId('workflow-validation')).toContainText('The workflow is valid.');
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByText('Workflow created.')).toBeVisible();
  expect(created[0].states.map((state) => state.key)).toEqual(['ready', 'doing', 'done']);
  expect(created[0].transitions[1]).toMatchObject({ approvalRequired: true, key: 'finish' });
  api.assertNoUnexpectedRequests();
});

test('the template editor builds a typed project template', async ({ page }, testInfo) => {
  const api = await signIn(page);
  const created = recordPosts(page, '/api/workflows/templates');
  await page.goto('workflows?tab=templates');

  await page.getByRole('link', { name: 'New template' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New project template' })).toBeVisible();
  await page.getByLabel('Template name').fill('Launch project');
  await page.getByRole('button', { name: 'Add binding' }).click();
  await page.getByLabel('Item type').first().selectOption('story');
  await page.getByLabel('Workflow', { exact: true }).selectOption({ label: 'Story flow' });
  await page.getByRole('button', { name: 'Add epic' }).click();
  await page.getByLabel('Epic name').fill('Launch');
  await page.getByRole('button', { name: 'Add story to Launch' }).click();
  await page.getByLabel('Story name').fill('');
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByText('Every story in the outline needs a name.')).toBeVisible();
  expect(created).toHaveLength(0);
  await page.getByLabel('Story name').fill('Announce');
  await page.getByLabel('Points').nth(1).fill('2');
  await expectNoSeriousAxeViolations(page, '.wf-page', testInfo, 'template-editor');
  await page.getByRole('button', { name: 'Create template' }).click();

  await expect(page.getByText('Template created.')).toBeVisible();
  await expect(page.getByTestId('template-summary')).toContainText('Announce');
  expect(created[0]).toMatchObject({
    kind: 'project',
    name: 'Launch project',
    payload: {
      customFields: [],
      outline: { epics: [{ name: 'Launch', points: null, stories: [{ name: 'Announce', points: 2, tasks: [] }] }] },
      workflowBindings: [{ itemType: 'story', sourceId: 'template-workflow', sourceKind: 'workflow_template' }],
    },
  });
  api.assertNoUnexpectedRequests();
});

test('a project template is offered when creating a project and sent with it', async ({ page }, testInfo) => {
  const api = await signIn(page);
  const posted = [];
  await page.route(`${API}/api/projects`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON());
    return route.fulfill({ body: JSON.stringify({ ok: true, project: syntheticProject }), contentType: 'application/json', status: 201 });
  });
  await page.goto('workflows/templates/template-project');

  await expect(page.getByTestId('template-summary')).toContainText('Interview users');
  await page.getByRole('link', { name: 'Create project from template' }).click();
  const drawer = page.locator('#createProjectDrawer');
  await expect(drawer.getByLabel('Project Template')).toHaveValue('template-project');
  await expect(drawer.getByText('Sets up 1 workflow binding · 3 outline items · 1 custom field.')).toBeVisible();
  await expect(drawer.getByLabel('Project Template').locator('option')).toHaveText(['No template', 'Discovery project']);
  await drawer.getByLabel('Project Name').fill('Research programme');
  // The description editor is named by its visible label.
  await expect(drawer.getByRole('textbox', { name: 'Project Description' })).toBeVisible();
  // This template binds no project workflow, so the usual statuses stay on offer.
  await expect(drawer.getByLabel('Project Status').locator('option')).toHaveText(['Planned', 'In Progress', 'At Risk', 'Completed']);
  await expectNoSeriousAxeViolations(page, '#createProjectDrawer', testInfo, 'project-create-template');
  await drawer.getByRole('button', { name: 'Save Project' }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}`));
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ name: 'Research programme', status: 'Planned', templateId: 'template-project' });
  api.assertNoUnexpectedRequests();
});

test('a template that binds a project workflow offers only that workflow’s states', async ({ page }, testInfo) => {
  const api = await signIn(page);
  const posted = [];
  const state = (key, label, initial = false) => ({ category: initial ? 'backlog' : 'active', initial, key, label, requiredFields: [], slaHours: 0, terminal: false });
  const gateFlow = { description: 'Gated delivery.', itemTypes: ['project'], states: [state('Proposed', 'Proposed', true), state('Approved', 'Approved'), state('Live', 'Live')], transitions: [] };
  const template = (id, name, binding) => ({ description: '', id, kind: 'project', name, payload: { customFields: [], outline: { epics: [] }, workflowBindings: [{ itemType: 'project', ...binding }] }, payloadIssues: [], payloadStatus: 'valid', status: 'active', version: 1 });
  const templates = [
    template('template-gated', 'Gated programme', { sourceId: 'template-gate-flow', sourceKind: 'workflow_template' }),
    template('template-delivery', 'Controlled delivery', { sourceId: 'workflow-synthetic', sourceKind: 'workflow_definition' }),
    { description: '', id: 'template-gate-flow', kind: 'workflow', name: 'Gate flow', payload: gateFlow, payloadIssues: [], payloadStatus: 'valid', status: 'active', version: 1 },
  ];
  await page.route((url) => url.pathname === '/api/workflows/templates', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ body: JSON.stringify({ templates }), contentType: 'application/json', status: 200 });
  });
  await page.route(`${API}/api/projects`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON());
    return route.fulfill({ body: JSON.stringify({ ok: true, project: syntheticProject }), contentType: 'application/json', status: 201 });
  });
  await page.goto('projects?new=project');
  const drawer = page.locator('#createProjectDrawer');
  const status = drawer.getByLabel('Project Status');
  await expect(drawer.getByLabel('Project Template')).toBeVisible();
  await expect(status.locator('option')).toHaveText(['Planned', 'In Progress', 'At Risk', 'Completed']);

  // A workflow template supplies the states; the initial one is chosen.
  await drawer.getByLabel('Project Template').selectOption({ label: 'Gated programme' });
  await expect(status.locator('option')).toHaveText(['Proposed', 'Approved', 'Live']);
  await expect(status).toHaveValue('Proposed');
  await expect(drawer.getByText('States of the template’s “Gate flow” workflow.')).toBeVisible();

  // An existing workflow definition supplies them too.
  await drawer.getByLabel('Project Template').selectOption({ label: 'Controlled delivery' });
  await expect(status.locator('option')).toHaveText(['In progress', 'Completed']);
  await expect(status).toHaveValue('In Progress');
  await drawer.getByLabel('Project Name').fill('Controlled pilot');
  await page.screenshot({ path: testInfo.outputPath('project-create-workflow-status.png') });
  await expectNoSeriousAxeViolations(page, '#createProjectDrawer', testInfo, 'project-create-workflow-status');
  await drawer.getByRole('button', { name: 'Save Project' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}`));
  expect(posted[0]).toMatchObject({ name: 'Controlled pilot', status: 'In Progress', templateId: 'template-delivery' });

  api.assertNoUnexpectedRequests();
});

test('clearing the template restores the usual project statuses', async ({ page }) => {
  const api = await signIn(page);
  const binding = { itemType: 'project', sourceId: 'workflow-synthetic', sourceKind: 'workflow_definition' };
  await page.route((url) => url.pathname === '/api/workflows/templates', (route) => route.fulfill({
    body: JSON.stringify({ templates: [{ description: '', id: 'template-delivery', kind: 'project', name: 'Controlled delivery', payload: { customFields: [], outline: { epics: [] }, workflowBindings: [binding] }, payloadIssues: [], payloadStatus: 'valid', status: 'active', version: 1 }] }),
    contentType: 'application/json',
    status: 200,
  }));
  await page.goto('projects?new=project');
  const drawer = page.locator('#createProjectDrawer');
  const status = drawer.getByLabel('Project Status');
  await drawer.getByLabel('Project Template').selectOption({ label: 'Controlled delivery' });
  await expect(status).toHaveValue('In Progress');
  await drawer.getByLabel('Project Template').selectOption({ label: 'No template' });
  await expect(status.locator('option')).toHaveText(['Planned', 'In Progress', 'At Risk', 'Completed']);
  await expect(status).toHaveValue('In Progress');
  await expect(drawer.locator('#project-status-hint')).toHaveCount(0);
  api.assertNoUnexpectedRequests();
});

test('the new card dialog prefills from a work-item template', async ({ page }, testInfo) => {
  const api = await signIn(page);
  const creates = [];
  const columns = [{ defaultStatus: 'Not Started', key: 'to-do', name: 'To do', statuses: ['Not Started'] }];
  const json = (route, body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
  await page.route(`${API}/api/projects/${syntheticProject.id}/kanban/config`, (route) => json(route, { config: { columns, presets: [], swimlane: 'none' }, ok: true }));
  await page.route((url) => url.pathname === `/api/projects/${syntheticProject.id}/kanban`, (route) => json(route, {
    board: { cards: [{ boardColumn: null, epicId: 'epic-synthetic', id: 'story-synthetic', issueType: 'story', name: 'Release pilot', parentName: 'Delivery', sprintId: null, status: 'Not Started', storyId: 'story-synthetic' }], columns, members: [], sprints: [], swimlane: 'none' },
    ok: true,
  }));
  await page.route(`${API}/api/projects/${syntheticProject.id}/items`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    creates.push(body);
    return json(route, { item: { ...body.item, version: 1 }, ok: true, project: syntheticProject }, 201);
  });
  await page.goto(`projects/${syntheticProject.id}/kanban`);
  await expect(page.locator('[data-card-id="story-synthetic"]')).toBeVisible();

  await page.getByRole('button', { name: 'New card' }).click();
  const modal = page.getByRole('dialog', { name: 'New card' });
  await expect(modal.getByLabel('Template').locator('option')).toHaveText(['No template', 'Research spike']);
  await modal.getByLabel('Template').selectOption({ label: 'Research spike' });
  await expect(modal.getByLabel('Points')).toHaveValue('3');
  await expect(modal.getByLabel('Description')).toHaveValue(/Investigate the options\.[\s\S]*Acceptance criteria[\s\S]*Findings are written up\./);
  await modal.getByLabel('Name').fill('Caching spike');
  await expectNoSeriousAxeViolations(page, '[aria-labelledby="kanban-card-create-title"]', testInfo, 'kanban-template');
  await modal.getByRole('button', { name: 'Create card' }).click();

  await expect(modal).toBeHidden();
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({ item: { name: 'Caching spike', points: 3, priority: 2 }, itemType: 'story', templateId: 'template-spike' });
  api.assertNoUnexpectedRequests();
});
