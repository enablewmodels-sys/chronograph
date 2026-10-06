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
 *
 * One width is not enough. Each component stylesheet has its own breakpoint, and the floors are not
 * the only rules that move: the information pages' section nav becomes a horizontal scroller at
 * 760px and a column at 761px, so a floor that stopped at 700px left 701-760 worse than either side
 * of it — three of that nav's ten destinations were off the strip. The boundary widths below are
 * measured for that reason.
 */
import { expect, test, type Page } from "@playwright/test";
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

/** The widths where a component stylesheet changes behaviour, plus the phone. */
const BOUNDARIES = [701, 760, 900];

async function failuresAt(page: Page, width: number): Promise<string[]> {
  await page.setViewportSize({ width, height: 900 });
  const failures: string[] = [];
  for (const path of PAGES) {
    // A route has to exist before its layout can be judged: a page this build does not serve would
    // report every floor at once and mean nothing. A single-page app answers 200 for an unknown
    // route, so the not-found page is recognised by its own heading.
    await page.goto(path);
    await page.waitForTimeout(800);
    const notFound = await page
      .getByRole("heading", { name: "That page is not here." })
      .isVisible()
      .catch(() => false);
    if (notFound) continue;
    const report = await floorReport(page);
    if (
      report.documentOverflow > 1 ||
      report.overflowing.length ||
      report.sidewaysNav.length ||
      report.smallText.length ||
      report.smallTargets.length ||
      report.clippedText.length
    )
      failures.push(path + " " + JSON.stringify(report));
  }
  return failures;
}

test("every public page holds the mobile floor at 390px", async ({ page }) => {
  test.setTimeout(300000);
  const failures = await failuresAt(page, 390);
  expect(failures, failures.join("\n")).toEqual([]);
});

for (const width of BOUNDARIES) {
  test(`every public page holds the mobile floor at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(300000);
    const failures = await failuresAt(page, width);
    expect(failures, failures.join("\n")).toEqual([]);
  });
}
