// The shared rich text editor's full toolset, in project comments: links are added in a
// field under the tools (not a browser prompt) and typing after one is plain text, and @
// opens a listbox of project members. Synthetic data only.
import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

test('project comments editor: link field and @ list', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-mobile', 'The settings drawer layout is checked on desktop.');
  await installSyntheticApi(page);
  await page.route('**/api/projects/*/mentionables*', (route) => route.fulfill({ json: { ok: true, users: [{ id: 'user-alex', name: 'Alex Kim' }] } }));
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Comments/ }).click();
  const editor = page.locator('.rich-editor .ProseMirror').first();
  await editor.click();
  await page.keyboard.type('See ');
  await page.getByRole('button', { name: 'Link' }).first().click();
  const field = page.getByRole('textbox', { name: 'Link' });
  await expect(field).toBeFocused();
  await field.fill('odin.test');
  await page.keyboard.press('Enter');
  await expect(editor.getByRole('link', { name: 'https://odin.test' })).toBeVisible();
  // Focus comes back to the editor just after the link appears, so typing waits for it.
  await expect(editor).toBeFocused();
  await page.keyboard.type(' and @al');
  await expect(editor.getByRole('link')).toHaveText('https://odin.test');
  const list = page.getByRole('listbox', { name: 'People to tag' });
  await expect(list.getByRole('option')).toHaveText([/Alex Kim/]);
  await page.keyboard.press('Enter');
  await expect(editor.locator('.mention[data-user-id="user-alex"]')).toHaveText('@Alex Kim');
});
