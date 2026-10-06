/*
 * The mobile floor, held inside the console.
 *
 * WHY this is a second file: ui/src/mobile.css is the single place the narrow-screen floors live,
 * and ui/e2e/mobile.spec.ts holds them on the public pages. But the console is where an operator
 * actually uses a phone — checking a branch, revoking a key, reading a backup list — and it is a
 * denser screen than any public page: 10px scope badges, 11px table headers, a config block whose
 * intrinsic width stretched a "one column" grid to 432px on a 390px screen. Measuring the public
 * pages would never have seen any of that, so this file signs in and measures the console itself.
 *
 * Both editions are measured, because they are two shells over one stylesheet and the floors have
 * to hold in each:
 *
 *   - Community, on the isolated server the Playwright config starts, with the token it writes to
 *     .work/e2e-config.json. It runs on any machine.
 *   - Managed, against a real control plane (scripts/managed-local.mjs). It skips when no
 *     deployment was supplied.
 *
 * The two editions are walked differently on purpose: the Managed console keeps a session cookie,
 * so one test can sign in once and `goto` every route, while the Community console holds its token
 * in memory and a full page load loses it — so its routes are opened from the sidebar, the way an
 * operator opens them.
 *
 * Two widths: 390 is an iPhone 13/14, 320 is the narrowest phone still in use. 320 is the one that
 * found /app/access overflowing by 149px.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { floorReport } from "./mobile-floor";
import { openConsolePage } from "./navigation";
import {
  NEEDS_DEPLOYMENT,
  ORIGIN,
  applySession,
  configured,
  signInOnce,
} from "./real-deployment";

test.beforeAll(async ({ playwright }) => {
  await signInOnce(playwright);
});

/** Every console route an owner sees in the Managed console. */
const MANAGED_PAGES = [
  "/app",
  "/app/bci",
  "/app/explorer",
  "/app/branches",
  "/app/schema",
  "/app/write",
  "/app/connectors",
  "/app/access",
  "/app/secrets",
  "/app/team",
  "/app/operations",
  "/app/apps",
];

/** The Community console has no accounts, so no members, secrets or hosted apps. */
const COMMUNITY_ROUTES: Array<[string, string]> = [
  ["/app", "Overview"],
  ["/app/bci", "BCI workspace"],
  ["/app/explorer", "Explorer"],
  ["/app/branches", "Branches"],
  ["/app/schema", "Schema & migrations"],
  ["/app/write", "Write data"],
  ["/app/connectors", "Connectors"],
  ["/app/access", "Connections & keys"],
  ["/app/operations", "Operations"],
];

/** Sign in to the isolated Community console the Playwright config serves. */
async function connectCommunity(page: Page): Promise<void> {
  const config = JSON.parse(
    await readFile(resolve("../.work/e2e-config.json"), "utf8"),
  ) as {
    token: string;
    url: string;
  };
  await page.goto("/login");
  await page.getByLabel("API token", { exact: true }).fill(config.token);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await page.waitForURL(/\/app$/);
  // An empty workspace shows the welcome panel on every route; the sample data is what makes the
  // tables and the graph the pages are measured with. `count` rather than `isVisible`: the panel
  // arrives with the first stats response, so asking too early used to skip this and measure the
  // empty state on some runs only.
  await page.waitForTimeout(1200);
  const sample = page.getByRole("button", { name: "Load sample workspace" });
  if ((await sample.count()) > 0) {
    await sample.first().click();
    await expect(
      page.getByRole("link", { name: "Open temporal explorer" }),
    ).toBeVisible();
  }
}

/** Cross a floor on one page? Reported with the page path, so a failure names it. */
async function inspect(
  page: Page,
  path: string,
  failures: string[],
): Promise<void> {
  // The console fetches on mount; the numbers arrive a beat after the shell does.
  await page.waitForTimeout(1800);
  const report = await floorReport(page);
  if (
    report.documentOverflow > 1 ||
    report.overflowing.length ||
    report.smallText.length ||
    report.smallTargets.length ||
    report.clippedText.length
  )
    failures.push(path + " " + JSON.stringify(report));
}

for (const width of [390, 320]) {
  test(`the community console holds the mobile floor at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(300000);
    await page.setViewportSize({ width, height: 844 });
    await connectCommunity(page);
    const failures: string[] = [];
    for (const [path, title] of COMMUNITY_ROUTES) {
      if (path !== "/app") await openConsolePage(page, title);
      await inspect(page, path, failures);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test(`the managed console holds the mobile floor at ${width}px`, async ({
    page,
  }) => {
    test.skip(!configured, NEEDS_DEPLOYMENT);
    test.setTimeout(300000);
    await page.setViewportSize({ width, height: 844 });
    await applySession(page);
    const failures: string[] = [];
    for (const path of MANAGED_PAGES) {
      await page.goto(ORIGIN + path);
      await inspect(page, path, failures);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
}

test("the page help popover opens inside the viewport", async ({ page }) => {
  // The tooltip is anchored 100px to the left of a button that sits at the right edge of the
  // heading, which is off the left of a 390px screen. It is invisible while the details is closed,
  // so this is the only way the defect shows up at all: open it and measure it.
  await page.setViewportSize({ width: 390, height: 844 });
  await connectCommunity(page);
  await openConsolePage(page, "Explorer");
  const summary = page.locator("details.page-help summary").first();
  await expect(summary).toBeVisible();
  await summary.click();
  await page.waitForTimeout(400);
  const box = await page.evaluate(() => {
    const popover = document.querySelector("details.page-help p");
    if (!popover) return null;
    const rect = popover.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewport: window.innerWidth,
      height: window.innerHeight,
    };
  });
  expect(box, "the help popover did not open").not.toBeNull();
  expect(
    box!.left,
    "the help popover hangs off the left of the screen",
  ).toBeGreaterThanOrEqual(0);
  expect(
    box!.right,
    "the help popover hangs off the right of the screen",
  ).toBeLessThanOrEqual(box!.viewport + 1);
  expect(
    box!.top,
    "the help popover is above the screen",
  ).toBeGreaterThanOrEqual(0);
  expect(
    box!.bottom,
    "the help popover is below the screen",
  ).toBeLessThanOrEqual(box!.height + 1);
  const text = await page.locator("details.page-help p").first().innerText();
  expect(
    text.trim().length,
    "the opened help popover has no text",
  ).toBeGreaterThan(0);
});
