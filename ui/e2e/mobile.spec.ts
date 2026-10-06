/*
 * The mobile floor, asserted on the public pages.
 *
 * WHY this file exists: the stylesheets shrink type and stack layout at narrow widths in more than
 * a hundred places, and several of them made text *smaller* on a phone than on a desktop. Auditing
 * the live site at 390x844 found 7px timeline ticks, an 8px caption, a section nav that scrolled
 * sideways instead of folding, inline links a thumb cannot hit, and a price table cut mid-word. The
 * floors live in ui/src/mobile.css; this holds them, so the next narrow-screen rule cannot quietly
 * cross them again.
 *
 * It runs against the served console rather than a mock of it: the floors are CSS, and CSS is the
 * thing under test. Every page below is a public route, so no session is needed. The measurement
 * itself is in mobile-floor.ts, shared with the signed-in console's copy of this test.
 */
import { expect, test } from "@playwright/test";
import { floorReport } from "./mobile-floor";

// A phone, whatever project this runs under.
test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
});

const PAGES = [
  "/",
  "/bci",
  "/pricing",
  "/login",
  "/signup",
  "/documentation/HOSTED",
  "/privacy",
  "/terms",
  "/support",
  "/status",
];

for (const path of PAGES) {
  test(`${path} holds the mobile floor`, async ({ page }) => {
    // The route has to exist before its layout can be judged: a page this deployment does not
    // serve would report every floor at once and mean nothing. A single-page app answers 200 for
    // an unknown route, so the not-found page is recognised by its own heading.
    const response = await page.goto(path);
    await page.waitForTimeout(2000);
    const notFound = await page
      .getByRole("heading", { name: "That page is not here." })
      .isVisible()
      .catch(() => false);
    test.skip(
      notFound || (response !== null && response.status() >= 400),
      `this deployment does not serve ${path}`,
    );
    await expect(page.locator("body")).not.toHaveText(/could not be displayed/);
    const report = await floorReport(page);
    expect(
      report.documentOverflow,
      `${path} scrolls sideways: ${JSON.stringify(report)}`,
    ).toBeLessThanOrEqual(1);
    expect(
      report.overflowing,
      `${path} overflows the viewport: ${JSON.stringify(report.overflowing)}`,
    ).toEqual([]);
    expect(
      report.sidewaysNav,
      `${path} has a navigation that scrolls sideways instead of wrapping: ${JSON.stringify(report.sidewaysNav)}`,
    ).toEqual([]);
    expect(
      report.smallText,
      `${path} has text below 12px: ${JSON.stringify(report.smallText)}`,
    ).toEqual([]);
    expect(
      report.smallTargets,
      `${path} has controls below 40px: ${JSON.stringify(report.smallTargets)}`,
    ).toEqual([]);
    expect(
      report.clippedText,
      `${path} truncates text with an ellipsis: ${JSON.stringify(report.clippedText)}`,
    ).toEqual([]);
  });
}
