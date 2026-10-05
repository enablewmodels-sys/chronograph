/**
 * Press the buttons. Every other suite reads pages; this one writes through the product's own
 * controls and requires the result to appear, because a page that renders correctly and a
 * control that does nothing look identical to a reader of the rendered output.
 *
 * It runs against a real deployment only — the mocked suites cannot answer a write — and every
 * name it creates is unique per run, so a repeated run neither collides nor needs a clean slate.
 *
 * See ui/e2e/real-deployment.ts for the environment.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  NEEDS_DEPLOYMENT,
  ORIGIN,
  applySession,
  configured,
  signInOnce,
} from "./real-deployment";

// One deployment, and these tests are the only writers in the file: run them in order.
test.describe.configure({ mode: "serial" });
test.skip(!configured, NEEDS_DEPLOYMENT);

test.beforeAll(async ({ playwright }) => {
  await signInOnce(playwright);
});

test.beforeEach(async ({ page }) => {
  await applySession(page);
  // Revoking a key and discarding a branch ask for confirmation; accept the dialog rather
  // than leaving the page waiting on an answer nobody gives in a test.
  page.on("dialog", (dialog) => void dialog.accept());
});

/** The drawer in this console labels its close control "Close <title>". */
async function closeDrawer(page: Page) {
  await page.getByRole("button", { name: /^Close / }).first().click();
}

const unique = (prefix: string) => prefix + "-" + Date.now().toString(36);

test("an API key can be created and revoked", async ({ page }) => {
  const name = unique("qa-key");
  await page.goto(ORIGIN + "/app/access");
  await expect(page.getByRole("heading", { name: "Project endpoints" })).toBeVisible();
  await page.getByRole("button", { name: "New API key" }).click();
  await page.getByLabel("Token name").fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  // The value is shown once and never again, which is the whole contract of this control.
  await expect(page.getByText("Copy your token now")).toBeVisible({ timeout: 15_000 });
  await closeDrawer(page);
  const cell = page.getByRole("cell", { name, exact: true });
  await expect(cell).toBeVisible({ timeout: 15_000 });
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Revoke" }).click();
  await expect(cell).toHaveCount(0, { timeout: 15_000 });
});

test("a secret can be stored and a reader key issued", async ({ page }) => {
  const secret = "QA_" + unique("SECRET").toUpperCase().replace(/-/g, "_");
  const key = unique("qa-reader");
  await page.goto(ORIGIN + "/app/secrets");
  await page.getByRole("button", { name: "Add or rotate secret" }).click();
  await page.getByLabel("Secret name").fill(secret);
  await page.getByLabel("Secret value").fill("value-for-the-test");
  await page.getByRole("button", { name: "Save secret" }).click();
  await closeDrawer(page);
  await expect(page.getByRole("cell", { name: secret, exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "New reader key" }).click();
  await page.getByLabel("Key name").fill(key);
  await page.getByRole("button", { name: "Create reader key" }).click();
  await closeDrawer(page);
  await expect(page.getByRole("cell", { name: key, exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("asking for a collaborator answers, or says exactly what is missing", async ({
  page,
}) => {
  const email = unique("qa-invite") + "@example.com";
  await page.goto(ORIGIN + "/app/team");
  await page.getByRole("button", { name: "Invite collaborator" }).click();
  await page.getByLabel("Name").fill("QA collaborator");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Create invitation" }).click();
  // Two outcomes are correct and they are not the same thing. With mail delivery configured the
  // invitation is created and the private link is shown, because delivery is the operator's job.
  // Without it the console must refuse and say why: an invitation nobody can activate is worse
  // than no button, and this is the state every deployment without a mail provider is in.
  // The refusal is drawn twice — inside the dialog and again as the page's feedback — so the
  // locator has to pick one rather than tripping over strict mode.
  const refusal = page.getByText(/Ask this collaborator to sign up/).first();
  const link = page.getByText(`Private invitation for ${email}`);
  await expect(refusal.or(link).first()).toBeVisible({ timeout: 20_000 });
  if (await refusal.isVisible()) {
    // Nothing was created, which is the point of refusing: no invitation, no audit event for
    // an account that can never be activated.
    await expect(page.getByText(email)).toHaveCount(0);
  } else {
    await expect(link).toBeVisible();
  }
});

test("a durable branch can be created", async ({ page }) => {
  const name = unique("qa-branch");
  await page.goto(ORIGIN + "/app/branches");
  await page.getByRole("button", { name: "Create branch" }).click();
  await page.getByLabel("Branch name").fill(name);
  await page.getByRole("button", { name: "Create durable branch" }).click();
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test("a consistent backup can be created", async ({ page }) => {
  await page.goto(ORIGIN + "/app/operations");
  // Wait for the page to have read the engine before reading the table: an empty read here once
  // skipped the room-making below and left the test asserting a success the cap forbade.
  await expect(page.getByRole("button", { name: "Create backup" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator("table tbody tr").first().or(page.getByText("No local backups yet.")),
  ).toBeVisible({ timeout: 20_000 });
  // Identify the backups by their IDs rather than counting rows: a count that grew would also be
  // satisfied by an unrelated row appearing, and this test's claim is that a *new* backup exists.
  const ids = async () =>
    (await page.locator("table tbody tr td:nth-child(3)").allInnerTexts())
      .map((value) => value.trim())
      .filter(Boolean);
  let before = new Set(await ids());
  // The engine keeps three local backups and refuses the fourth, saying so. A repeated run has
  // to make room rather than assert a success it cannot have, and removing one exercises the
  // delete path on the way.
  if (before.size >= 3) {
    await page
      .locator("table tbody tr")
      .last()
      .getByRole("button", { name: "Delete" })
      .click();
    await expect.poll(async () => (await ids()).length, { timeout: 20_000 }).toBeLessThan(
      before.size,
    );
    before = new Set(await ids());
  }
  await page.getByRole("button", { name: "Create backup" }).click();
  await expect(page.getByText("Consistent backup created.")).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(async () => (await ids()).some((id) => !before.has(id)), { timeout: 20_000 })
    .toBe(true);
});

/* The suites sign in through the provider's endpoint, which is not the path a person takes. This
   one uses the rendered form on a real deployment, because the failure this product actually had
   was a form that accepted a password and then bounced the reader back to itself. */
test("the sign-in form itself works against this deployment", async ({ browser }) => {
  // A context with no session, or the form would never render.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(ORIGIN + "/login");
    await page.getByLabel("Email address").fill(process.env.CHRONOGRAPH_SWEEP_EMAIL || "");
    await page.getByLabel("Password").fill(process.env.CHRONOGRAPH_SWEEP_PASSWORD || "");
    await page.getByRole("button", { name: "Sign in" }).click();
    // The signed-in shell, not the form again: a bounce is the defect this test exists for.
    await expect(page.locator(".workspace-top")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Sign in to ChronoDB." })).toHaveCount(
      0,
    );
  } finally {
    await context.close();
  }
});
