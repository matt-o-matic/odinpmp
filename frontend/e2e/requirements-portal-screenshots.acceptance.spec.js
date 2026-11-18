import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { PORTAL_TOKENS, createReviewWorld, drawMark, installCaptureFailingPrototype, installPortalApi, installTeamReviewApi } from './fixtures/requirements-portal-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Review screenshots of every portal and guided-review view, desktop and phone, with
// synthetic data. Files go to output/playwright/u7/ (gitignored). Opt-in:
// ODIN_REVIEW_SCREENSHOTS=1.
test.skip(!process.env.ODIN_REVIEW_SCREENSHOTS, 'Set ODIN_REVIEW_SCREENSHOTS=1 to write review screenshots.');
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output', 'playwright', 'u7');

async function shot(page, name, { fullPage = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ animations: 'disabled', fullPage, path: path.join(outputDir, `${name}.png`) });
}

async function openPortal(page, world = createReviewWorld(), token = PORTAL_TOKENS.ravi) {
  await installSyntheticApi(page);
  await installPortalApi(page, world, { token });
  return world;
}

async function drawPin(page, x, y) {
  await drawMark(page, 'pin', [x, y]);
}

async function drawBox(page, x1, y1, x2, y2) {
  await drawMark(page, 'box', [x1, y1], [x2, y2]);
}

for (const device of ['desktop', 'phone']) {
  test(`portal and guided review, ${device}`, async ({ page }, testInfo) => {
    const wanted = device === 'desktop' ? 'chromium-desktop' : 'chromium-mobile';
    test.skip(testInfo.project.name !== wanted, `${device} screenshots use the ${wanted} project.`);
    test.setTimeout(240_000);
    if (device === 'desktop') await page.setViewportSize({ height: 900, width: 1440 });
    const prefix = device;
    const world = await openPortal(page);

    await page.goto(`requirements/${PORTAL_TOKENS.ravi}`);
    await expect(page.getByTestId('rq-round-ask')).toBeVisible();
    await shot(page, `${prefix}-portal-inbox`, { fullPage: true });

    await page.getByRole('link', { name: 'How do price estimates get calculated, and by which service?' }).click();
    await expect(page.getByRole('region', { name: 'Odin summary' })).toBeVisible();
    await shot(page, `${prefix}-portal-question`, { fullPage: true });

    await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
    await expect(page.getByRole('heading', { name: 'Client booking — price and booking flow' })).toBeVisible();
    await shot(page, `${prefix}-review-overview`, { fullPage: device === 'phone' });

    await page.getByRole('button', { name: /Start review/ }).click();
    await expect(page.getByRole('heading', { name: 'Compare the directions' })).toBeVisible();
    await page.getByRole('group', { name: 'Your view of Action first' }).getByRole('radio', { name: 'Preferred' }).check();
    await page.getByLabel('Anything to keep from this direction?').nth(1).fill('The week calendar');
    await page.getByRole('group', { name: 'Your view of Schedule first' }).getByRole('radio', { name: 'Acceptable' }).check();
    await shot(page, `${prefix}-review-directions`, { fullPage: device === 'phone' });

    await page.getByRole('button', { name: /^Screens/ }).first().click();
    await expect(page.locator('.annotation-canvas__image')).toBeVisible();
    await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
    await drawBox(page, 0.56, 0.47, 0.96, 0.66);
    await page.keyboard.press('Escape');
    await drawPin(page, 0.6, 0.48);
    const thread = page.getByTestId('rq-annotation-thread');
    await thread.getByRole('textbox').fill('“$70–95” needs to say “before tax”.');
    await thread.getByRole('button', { name: 'Post comment' }).click();
    await expect(thread.getByText('“$70–95” needs to say “before tax”.')).toBeVisible();
    if (device === 'desktop') {
      await page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Keep with changes' }).check();
      await page.getByRole('radiogroup', { name: /^Type & size/ }).getByRole('radio', { name: 'Keep' }).check();
      await page.getByRole('radiogroup', { name: /^Hierarchy/ }).getByRole('radio', { name: 'Change' }).check();
      await page.getByLabel('What should change?').fill('Price range needs “before tax”, closer to the booking button.');
      await page.getByLabel('What should change?').blur();
    } else {
      await page.getByRole('region', { name: /Your verdict on/ }).getByRole('radio', { name: 'Keep, with changes' }).check();
    }
    await expect(page.getByTestId('rq-save-status')).toContainText('Saved');
    await shot(page, `${prefix}-review-screen-image`);

    // The prototype: browse, then annotate a snapshot.
    await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
    await page.getByRole('button', { name: /^Screens/ }).first().click();
    if (device === 'desktop') {
      await page.getByRole('button', { name: 'Next screen' }).click();
      await page.getByRole('button', { name: 'Next screen' }).click();
    } else {
      await page.getByRole('button', { name: 'Next screen' }).click();
      await page.getByRole('button', { name: 'Next screen' }).click();
    }
    await expect(page.getByTestId('rq-proto-status')).toHaveText(/Showing/, { timeout: 30_000 });
    await page.getByRole('group', { name: 'States' }).getByRole('button', { name: 'Pick a time' }).click();
    await expect(page.getByTestId('rq-proto-status')).toHaveText('Showing Pick a time');
    await shot(page, `${prefix}-review-prototype-browse`);
    await page.getByRole('button', { name: 'Annotate' }).click();
    await expect(page.locator('.rq-snapbanner')).toContainText('Annotating a snapshot of Pick a time', { timeout: 60_000 });
    await drawPin(page, 0.2, 0.33);
    await expect(page.getByTestId('rq-annotation-thread')).toContainText('Attached to', { timeout: 10_000 });
    await page.getByTestId('rq-annotation-thread').getByRole('textbox').fill('Greyed-out days look clickable. Hide them, or say “fully booked”.');
    await shot(page, `${prefix}-review-prototype-annotate`);

    await page.getByRole('button', { name: /^Questions/ }).first().click().catch(async () => {
      await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
      await page.getByRole('button', { name: /^Questions/ }).first().click();
    });
    await expect(page.getByRole('heading', { name: 'Questions from the team' })).toBeVisible();
    await page.getByRole('group', { name: /Where should the price first appear/ }).getByRole('radio', { name: 'A range on the home screen, exact before payment' }).check();
    await page.getByRole('group', { name: /Which reminder channels/ }).getByRole('checkbox', { name: 'Email' }).check();
    await page.getByRole('group', { name: /How quick did booking feel/ }).getByRole('radio', { name: '4', exact: true }).check();
    await shot(page, `${prefix}-review-questions`, { fullPage: true });

    await page.getByRole('button', { name: 'Review and submit' }).click();
    await expect(page.getByRole('heading', { name: 'Here’s what you’re telling the team' })).toBeVisible();
    await shot(page, `${prefix}-review-submit`, { fullPage: true });
    await page.getByRole('button', { name: 'Submit review' }).click();
    await expect(page.getByTestId('rq-submitted')).toBeVisible();
    await shot(page, `${prefix}-review-submitted`, { fullPage: true });

    // Link problems.
    for (const [token, name] of [[PORTAL_TOKENS.expired, 'expired'], [PORTAL_TOKENS.revoked, 'revoked'], [PORTAL_TOKENS.missing, 'not-found']]) {
      await page.goto(`requirements/${token}`);
      await expect(page.getByTestId('rq-link-problem')).toBeVisible();
      await shot(page, `${prefix}-portal-link-${name}`);
    }
    expect(world.calls.length).toBeGreaterThan(0);
  });
}

test('closed round, capture failure, and the team review, desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop only.');
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const world = createReviewWorld();
  await openPortal(page, world);
  world.entryUrls = { 'booking-flow': await installCaptureFailingPrototype(page) };
  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
  await page.getByRole('button', { name: /^Screens/ }).first().click();
  await page.getByRole('button', { name: 'Next screen' }).click();
  await page.getByRole('button', { name: 'Next screen' }).click();
  await expect(page.getByTestId('rq-proto-status')).toHaveText(/Showing|Ready/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Annotate' }).click();
  await expect(page.locator('.rq-snapbanner')).toContainText('Snapshot unavailable');
  await shot(page, 'desktop-review-prototype-capture-failed');

  const closed = createReviewWorld({ roundStatus: 'closed' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await openPortal(page, closed);
  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
  await page.getByRole('button', { name: /^Screens/ }).first().click();
  await expect(page.getByRole('note')).toContainText('This round closed');
  await shot(page, 'desktop-review-closed');

  // A team member reviewing inside the app.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const team = createReviewWorld();
  await installSyntheticApi(page);
  await installRequirementsApi(page, defaultRequirementsScenario());
  await installTeamReviewApi(page, team);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/requirements/experience/review/rounds/round-2/review`);
  await expect(page.getByRole('heading', { name: 'Client booking — price and booking flow' })).toBeVisible();
  await shot(page, 'desktop-team-review-overview');
  await page.getByRole('button', { name: /^Screens/ }).first().click();
  await expect(page.locator('.annotation-canvas__image')).toBeVisible();
  await shot(page, 'desktop-team-review-screen');
});
