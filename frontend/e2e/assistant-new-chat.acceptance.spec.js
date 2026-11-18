import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, openPhoneMenu, syntheticProject } from './fixtures/synthetic-api.js';

async function openAssistant(page) {
  const button = page.getByRole('button', { name: 'AI Workspace' });
  if (!await button.isVisible()) await openPhoneMenu(page);
  await button.click();
  const workspace = page.getByRole('dialog', { name: 'AI Workspace' });
  await expect(workspace).toBeVisible();
  return workspace;
}

// Narrow layouts keep the chat list behind a toggle.
async function showChats(workspace) {
  const toggle = workspace.getByRole('button', { name: 'Show chats' });
  if (await toggle.isVisible()) await toggle.click();
}

test.describe('assistant new chats', () => {
  test('a new chat started outside a project can be put in one before its first message', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('projects');
    const workspace = await openAssistant(page);

    const picker = workspace.getByLabel('Project', { exact: true });
    await expect(picker).toHaveValue('');
    await expect(workspace.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
    await picker.selectOption({ label: syntheticProject.name });
    await expect(workspace.getByRole('heading', { name: `What do you need on ${syntheticProject.name}?` })).toBeVisible();

    const created = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/assistant/chats'));
    await workspace.getByLabel('Message the assistant').fill('How is the project going?');
    await workspace.getByLabel('Message the assistant').press('Enter');
    expect((await created).postDataJSON()).toEqual({ projectId: syntheticProject.id });
    await expect(workspace.getByRole('article', { name: 'Assistant reply' })).toContainText('Synthetic Project is on track.');
    await expect(picker).toBeHidden();
    api.assertNoUnexpectedRequests();
  });

  test('each folder in the chat list starts a chat in itself, and the header holds the one New chat button', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}`);
    const workspace = await openAssistant(page);
    const picker = workspace.getByLabel('Project', { exact: true });
    await expect(picker).toHaveValue(syntheticProject.id);
    // The chat's title reads "New chat" too, but stays disabled until the chat exists.
    const newChat = workspace.getByRole('button', { disabled: false, exact: true, name: 'New chat' });
    await expect(newChat).toHaveCount(1);

    await showChats(workspace);
    await workspace.getByRole('button', { name: 'New chat not tied to a project' }).click();
    await expect(picker).toHaveValue('');
    await expect(workspace.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();

    await showChats(workspace);
    await workspace.getByRole('button', { name: `New chat in ${syntheticProject.name}` }).click();
    await expect(picker).toHaveValue(syntheticProject.id);
    await expect(workspace.getByRole('heading', { name: `What do you need on ${syntheticProject.name}?` })).toBeVisible();

    // The header's New chat starts on the page's project.
    await picker.selectOption('');
    await newChat.click();
    await expect(picker).toHaveValue(syntheticProject.id);
    api.assertNoUnexpectedRequests();
  });

  test('a chat in the list shows when it was opened and last active, and renames in place', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}`);
    const workspace = await openAssistant(page);
    await workspace.getByLabel('Message the assistant').fill('How is the project going?');
    await workspace.getByLabel('Message the assistant').press('Enter');
    await expect(workspace.getByRole('article', { name: 'Assistant reply' })).toBeVisible();

    await showChats(workspace);
    const row = workspace.getByRole('navigation', { name: 'Chats' }).getByRole('listitem').filter({ hasText: 'How is the project going?' });
    await expect(row).toContainText(/Last active .*\d:\d\d [AP]M|Last active [A-Z][a-z]{2} \d+, \d{4}/);
    await expect(row).toContainText('Opened ');

    // Escape keeps the old name; Enter saves the new one.
    const list = workspace.getByRole('navigation', { name: 'Chats' });
    const input = list.getByRole('textbox', { name: 'Chat title' });
    await row.hover();
    await row.getByRole('button', { name: 'Rename How is the project going?' }).click();
    await expect(input).toBeFocused();
    await input.fill('Ignored');
    await input.press('Escape');
    await expect(workspace).toBeVisible();
    await expect(row.getByRole('button', { name: /^How is the project going\?/ })).toBeVisible();

    await row.hover();
    await row.getByRole('button', { name: 'Rename How is the project going?' }).click();
    const renamed = page.waitForRequest((request) => request.method() === 'PATCH');
    await input.fill('Project health check');
    await input.press('Enter');
    expect((await renamed).postDataJSON()).toEqual({ title: 'Project health check' });
    await expect(input).toBeHidden();
    await expect(list.getByRole('button', { name: /^Project health check/ })).toBeVisible();
    await expect(workspace.getByRole('heading', { name: 'Project health check' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});
