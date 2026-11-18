import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createFileTreeWorld, installFileTreeApi } from './fixtures/file-tree-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// The project's files as folders: the project is the top folder, each channel a folder in it, and
// people's own folders inside a channel. Files rename and move between them; a move into a channel
// with guests asks first.

const PROJECT_NAME = syntheticProject.name;

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.file-tree').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id }) => id)).toEqual([]);
}

async function openFiles(page, world) {
  await installSyntheticApi(page);
  await installFileTreeApi(page, { world });
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}?projectSettings=files`);
  const tree = page.locator('.file-tree');
  await expect(tree.getByRole('list', { name: 'Channel folders' })).toBeVisible();
  return tree;
}

const trailOf = (tree) => tree.getByRole('navigation', { name: 'Folder' });
const rowFor = (tree, name) => tree.locator('.project-files__row').filter({ hasText: name });

async function openRow(tree, name) {
  await tree.getByRole('button', { name: `Show versions and links for ${name}` }).click();
  return rowFor(tree, name);
}

test('the project is the top folder, each channel a folder in it, and Back walks up the folders', async ({ page }, testInfo) => {
  const tree = await openFiles(page, createFileTreeWorld());

  await expect(trailOf(tree).locator('[aria-current="location"]')).toHaveText(PROJECT_NAME);
  const folders = tree.getByRole('list', { name: 'Channel folders' }).getByRole('button');
  await expect(folders).toHaveText([/#General.*2 files.*2 folders/, /#Client review.*0 files.*1 folder.*2 guests/, /#Kickoff.*Archived/]);
  // The top level lists the project's own files; channel files are in their channel's folder.
  await expect(rowFor(tree, 'Budget.xlsx')).toBeVisible();
  await expect(rowFor(tree, 'MSA.pdf')).toHaveCount(0);
  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('file-tree-root.png') });
  await expectNoSeriousAxe(page);

  await folders.filter({ hasText: '#General' }).click();
  await expect(page).toHaveURL(/filesChannel=ch-general/);
  await expect(trailOf(tree).getByRole('button', { name: PROJECT_NAME })).toBeVisible();
  await expect(trailOf(tree).locator('[aria-current="location"]')).toHaveText('General');
  await expect(rowFor(tree, 'Agenda.pdf')).toBeVisible();
  await expect(rowFor(tree, 'MSA.pdf')).toHaveCount(0);

  await tree.getByRole('list', { name: 'Folders' }).getByRole('button', { name: /Contracts/ }).click();
  await expect(page).toHaveURL(/filesFolder=f-contracts/);
  await expect(trailOf(tree).getByRole('button')).toHaveText([PROJECT_NAME, 'General']);
  await expect(trailOf(tree).locator('[aria-current="location"]')).toHaveText('Contracts');
  await expect(rowFor(tree, 'MSA.pdf')).toBeVisible();
  await expect(tree.getByRole('list', { name: 'Folders' }).getByRole('button', { name: /Signed/ })).toBeVisible();
  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('file-tree-folder.png') });
  await expectNoSeriousAxe(page);

  // Back goes up a folder, and the project crumb goes to the top.
  await page.goBack();
  await expect(trailOf(tree).locator('[aria-current="location"]')).toHaveText('General');
  await trailOf(tree).getByRole('button', { name: PROJECT_NAME }).click();
  await expect(trailOf(tree).locator('[aria-current="location"]')).toHaveText(PROJECT_NAME);
  await expect(page).not.toHaveURL(/filesChannel=/);
});

test('a file moves into another channel\'s folder, asking first when that channel has guests, and renames', async ({ page }) => {
  const world = createFileTreeWorld();
  const tree = await openFiles(page, world);

  const budget = await openRow(tree, 'Budget.xlsx');
  await budget.getByRole('button', { name: 'Move to…' }).click();
  const move = page.getByRole('dialog', { name: 'Move Budget.xlsx' });
  // The tree to pick from: the project, open channels and their folders; the file's place is marked.
  await expect(move.getByRole('radio')).toHaveCount(6);
  await expect(move.getByRole('radio', { name: /Synthetic Delivery Plan/ })).toBeDisabled();
  await expect(move.getByRole('radio', { name: /Kickoff/ })).toHaveCount(0);
  await move.getByRole('radio', { name: /Deliverables/ }).check();
  await move.getByRole('button', { name: 'Move', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Guests will see this file' });
  await expect(confirm).toContainText('2 guests in #Client review will see Budget.xlsx.');
  await confirm.getByRole('button', { name: 'Move anyway' }).click();
  await expect(tree.getByRole('status').filter({ hasText: 'Moved Budget.xlsx to #Client review / Deliverables.' })).toBeVisible();
  expect(world.calls.map(({ body }) => body)).toEqual([
    { destination: { channelId: 'ch-client', folderId: 'f-deliverables', kind: 'channel' } },
    { confirmGuests: true, destination: { channelId: 'ch-client', folderId: 'f-deliverables', kind: 'channel' } },
  ]);
  await expect(rowFor(tree, 'Budget.xlsx')).toHaveCount(0);
  await expect(tree.getByRole('list', { name: 'Channel folders' }).getByRole('button', { name: /#Client review/ })).toContainText('1 file');

  // Inside a channel: rename a file where it is.
  await tree.getByRole('list', { name: 'Channel folders' }).getByRole('button', { name: /#General/ }).click();
  const agenda = await openRow(tree, 'Agenda.pdf');
  await agenda.getByRole('button', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename Agenda.pdf' });
  await rename.getByLabel('File name').fill('Agenda v2.pdf');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(rowFor(tree, 'Agenda v2.pdf')).toBeVisible();
  expect(world.calls.at(-1)).toMatchObject({ body: { fileName: 'Agenda v2.pdf' }, fileId: 'file-agenda' });

  // A move to a channel without guests needs no question.
  // The row stays open after a rename.
  await rowFor(tree, 'Agenda v2.pdf').getByRole('button', { name: 'Move to…' }).click();
  const second = page.getByRole('dialog', { name: 'Move Agenda v2.pdf' });
  await expect(second.getByRole('radio', { name: /^General/ })).toBeDisabled();
  await second.getByRole('radio', { name: /Signed/ }).check();
  await second.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Guests will see this file' })).toHaveCount(0);
  await expect(rowFor(tree, 'Agenda v2.pdf')).toHaveCount(0);
  expect(world.calls.at(-1).body).toEqual({ destination: { channelId: 'ch-general', folderId: 'f-signed', kind: 'channel' } });
});

test('someone who can only read sees the folders, but no Rename, Move to or New folder', async ({ page }) => {
  const world = createFileTreeWorld();
  Object.assign(world, { canManage: false, canWrite: false });
  const tree = await openFiles(page, world);

  const budget = await openRow(tree, 'Budget.xlsx');
  await expect(budget.getByRole('button', { name: 'Rename' })).toHaveCount(0);
  await expect(budget.getByRole('button', { name: 'Move to…' })).toHaveCount(0);
  await tree.getByRole('list', { name: 'Channel folders' }).getByRole('button', { name: /#General/ }).click();
  await expect(rowFor(tree, 'Agenda.pdf')).toBeVisible();
  await expect(tree.getByRole('button', { name: /New folder/ })).toHaveCount(0);
  const agenda = await openRow(tree, 'Agenda.pdf');
  await expect(agenda.getByRole('button', { name: 'Move to…' })).toHaveCount(0);
});
