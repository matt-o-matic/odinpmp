// Axe measures colors as rendered. Odin's buttons and panels animate color changes (for
// example after switching to dark mode), so a scan that lands mid-transition can report a
// contrast failure for a color the user never sees at rest. Freeze motion before scanning.
const NO_MOTION = '*, *::before, *::after { transition: none !important; animation: none !important; }';

export async function settleForAxe(page) {
  await page.addStyleTag({ content: NO_MOTION });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
