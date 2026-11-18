import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { createChatWorld, installChatApi } from './fixtures/chat-api.js';
import { installShellApi } from './fixtures/shell-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Results as you type (docs/semantic-search/plan.md AC-08): the top bar's search (Ctrl+K) and
// Odin Chat's jump box show the best few matches after a pause; choosing one opens it, and Enter
// with none chosen opens the search page. The search API is the shell fixture's corpus.

async function expectNoSeriousAxe(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

test('typing in the top bar\'s search shows results; choosing one opens it, and Enter opens the search page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-mobile', 'The phone opens the search page from its menu.');
  await installSyntheticApi(page);
  const shell = await installShellApi(page);
  await authenticateSyntheticUser(page);

  await page.keyboard.press('Control+k');
  const box = page.getByRole('combobox', { name: 'Search workspace' });
  await expect(box).toBeFocused();
  await box.pressSequentially('pi');
  await page.waitForTimeout(500);
  expect(shell.searchRequests.filter((request) => request.limit === '5')).toEqual([]);

  await box.pressSequentially('lot');
  const results = page.getByRole('listbox', { name: 'Search results' });
  await expect(results.getByRole('option')).toHaveCount(6);
  await expect(results.getByRole('option').last()).toHaveText(/See all results for “pilot”/);
  await expect(results.getByRole('option').first()).toContainText('Project');
  expect(shell.searchRequests.filter((request) => request.limit === '5').map((request) => request.query)).toEqual(['pilot']);
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  await expectNoSeriousAxe(page, testInfo, 'search-results-open');
  if (testInfo.project.name === 'chromium-desktop') await testInfo.attach('search-results.png', { body: await page.screenshot(), contentType: 'image/png' });

  // Arrows choose a result; Enter opens it.
  await box.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', 'app-search-option-0');
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/projects/${syntheticProject.id}$`));
  await expect(results).toBeHidden();

  // With none chosen, Enter opens the search page.
  await page.keyboard.press('Control+k');
  await box.fill('');
  await box.pressSequentially('vendor');
  await expect(results.getByRole('option')).toHaveCount(2);
  await box.press('Enter');
  await expect(page).toHaveURL(/\/app\/search\?q=vendor$/);

  // Escape closes the list and keeps the text.
  await box.fill('');
  await box.pressSequentially('pilot');
  await expect(results).toBeVisible();
  await box.press('Escape');
  await expect(results).toBeHidden();
  await expect(box).toHaveValue('pilot');
});

test('Odin Chat\'s jump box shows workspace results after the places and people it matches', async ({ page }, testInfo) => {
  await installSyntheticApi(page);
  const channelsWorld = createChannelsWorld();
  await installChannelsApi(page, { world: channelsWorld });
  await installChatApi(page, { world: createChatWorld({ channelsWorld }) });
  await installShellApi(page);
  await authenticateSyntheticUser(page);
  // A phone searches on the Chat search page; a wider screen in the header.
  await page.goto(testInfo.project.name === 'chromium-mobile' ? 'chat/search' : 'chat');

  const jump = page.getByTestId('chat-jump').locator('visible=true').first();
  await jump.click();
  await jump.pressSequentially('vendor');
  const list = page.getByRole('listbox', { name: 'Places, people and results' }).first();
  await expect(list.getByRole('option')).toHaveText([/Vendor capacity\s*Risk/, /See all results for “vendor”/]);
  // Nothing was chosen, so a result that arrived first doesn't take Enter: it opens the search page.
  await expect(list.getByRole('option', { name: /See all results/ })).toHaveAttribute('aria-selected', 'true');
  await jump.press('Enter');
  await expect(page).toHaveURL(/\/app\/search\?q=vendor$/);

  // A result opens where it lives.
  await page.goto(testInfo.project.name === 'chromium-mobile' ? 'chat/search' : 'chat');
  await jump.click();
  await jump.pressSequentially('vendor');
  await list.getByRole('option', { name: /Vendor capacity/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/projects/${syntheticProject.id}/governance$`));
});
