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
import { readFile } from "node:fs/promises";
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
  // The vault keeps at most twenty reader keys per project, and this suite creates one per run,
  // so it revokes its own key at the end rather than leaving the deployment to fill up. A run that
  // meets a full vault makes room first, the way the backup test does.
  const keyCell = page.getByRole("cell", { name: key, exact: true });
  await page.getByRole("button", { name: "New reader key" }).click();
  await page.getByLabel("Key name").fill(key);
  await page.getByRole("button", { name: "Create reader key" }).click();
  if (
    await page
      .getByText(/Revoke unused secret-reader keys/)
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await page
      .locator("table tbody tr")
      .last()
      .getByRole("button", { name: "Revoke" })
      .click();
    await page.getByRole("button", { name: "Create reader key" }).click();
  }
  await closeDrawer(page);
  await expect(keyCell).toBeVisible({ timeout: 15_000 });
  await page.getByRole("row", { name: new RegExp(key) }).getByRole("button", { name: "Revoke" }).click();
  await expect(keyCell).toHaveCount(0, { timeout: 15_000 });
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
  const delivered = page.getByText(`Invitation emailed to ${email}`);
  const link = page.getByText(`Private invitation for ${email}`);
  await expect(refusal.or(delivered).or(link).first()).toBeVisible({ timeout: 20_000 });
  if (await refusal.isVisible()) {
    // Nothing was created, which is the point of refusing: no invitation, no audit event for
    // an account that can never be activated.
    await expect(page.getByText(email)).toHaveCount(0);
    return;
  }
  // The invitation exists either way, and the private link is always shown so an operator can
  // deliver it by hand when sending failed.
  await expect(delivered.or(link).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /set a password|join/i }).or(page.getByText(/\/activate#token=|\/join#token=/)).first()).toBeVisible({
    timeout: 15_000,
  });
  // When the deployment spools its mail, the message must actually be there: a notice that says
  // "emailed" proves nothing on its own.
  const spool = process.env.CHRONOGRAPH_SWEEP_MAIL_SPOOL;
  if (spool && (await delivered.isVisible())) {
    const written = await expect
      .poll(
        async () => {
          try {
            return (await readFile(spool, "utf8")).includes(email);
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    void written;
    const message = (await readFile(spool, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.to === email)
      .at(-1);
    expect(message, "the spool holds the invitation").toBeTruthy();
    expect(message.text).toMatch(/activate#token=|join#token=/);
  }
});

test("a durable branch can be created and discarded", async ({ page }) => {
  const name = unique("qa-branch");
  await page.goto(ORIGIN + "/app/branches");
  await page.getByRole("button", { name: "Create branch" }).click();
  await page.getByLabel("Branch name").fill(name);
  await page.getByRole("button", { name: "Create durable branch" }).click();
  const branch = page.getByRole("button", { name, exact: true });
  await expect(branch).toBeVisible({ timeout: 20_000 });
  // Discard it again: a suite that leaves a branch behind on every run fills the deployment's
  // fork budget, and discarding exercises the one branch control the create path does not.
  await branch.click();
  await page.getByRole("button", { name: "Discard branch" }).click();
  await expect(page.getByText("Branch discarded and synchronized.")).toBeVisible({
    timeout: 20_000,
  });
  // The branch stays in the table as history with its state, which is the point of a lineage
  // view; what the discard frees is the active fork, not the record of it.
  await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText(
    "discarded",
    { timeout: 20_000 },
  );
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

/* Layer 4 is the one surface whose console was never driven: without a hosting block every
   deployment answers "Hosting is not enabled for this deployment", so plan, deploy, roll back and
   destroy had only ever been exercised at the API level. This walks the rendered controls against a
   deployment running the dry-run driver, which records the argv a container runtime would receive
   and touches nothing. */
test("an app is planned, deployed, rolled back and destroyed from the console", async ({
  page,
}) => {
  await page.goto(ORIGIN + "/app/apps");
  await expect(page.getByText("Hosting is not enabled")).toHaveCount(0);
  await expect(page.getByText("sample-service").first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByText("Plan ready. Nothing on the host was touched.")).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  await expect(page.getByText("Deploy finished. The ledger records it.")).toBeVisible({
    timeout: 30_000,
  });
  // The ledger shows the first twelve hex characters of the digest the deploy recorded (the full
  // value is the cell's title), so a placeholder would not produce this.
  await expect(page.getByText(/^[0-9a-f]{12}…$/).first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Roll back", exact: true }).click();
  // Either outcome is correct and they are not the same thing: with a previous digest recorded the
  // rollback happens, and on a first deploy appctl refuses rather than inventing a target. Both
  // must be reported, and this asserts one of the two appeared rather than silence.
  await expect(
    page
      .getByText("Rollback recorded.")
      .or(page.getByText(/no earlier image digest|will not invent/i))
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Destroy", exact: true }).click();
  await expect(page.getByText("Destroy recorded.")).toBeVisible({ timeout: 30_000 });
});

/* The whole account lifecycle through the rendered pages and the deployment's own mail: sign up,
   read the message the control plane actually wrote, activate from its link, and sign in as the new
   account. The activation link only exists in the spool, so this cannot pass without delivery. */
test("a new account is created, activated from the email, and signed in", async ({
  page,
}) => {
  const spool = process.env.CHRONOGRAPH_SWEEP_MAIL_SPOOL;
  if (!spool) test.skip(true, "Set CHRONOGRAPH_SWEEP_MAIL_SPOOL to a deployment that spools mail.");
  const email = unique("qa-signup") + "@example.com";
  const password = "qa-signup-passphrase-2468";

  // Signing up is for somebody who is not signed in: the deployment redirects a signed-in visitor
  // away from /signup, which is correct and is why this test drops the suite's session first.
  await page.context().clearCookies();
  await page.goto(ORIGIN + "/signup");
  // The form only renders once /managed/config has answered, and a deployment that has just been
  // swept answers it slower than a human would notice.
  await expect(page.getByLabel("Full name")).toBeVisible({ timeout: 45_000 });
  await page.getByLabel("Full name").fill("QA Signup");
  await page.getByLabel("Email address").fill(email);
  // A single IP that has been driving a whole suite can be rate-limited for a minute; that is the
  // limiter working, so wait it out rather than reporting a broken signup.
  const notice = page.getByText(/Check your inbox/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Continue with email" }).click();
    const outcome = await Promise.race([
      notice
        .waitFor({ state: "visible", timeout: 25_000 })
        .then(() => "sent")
        .catch(() => ""),
      page
        .getByText(/too many attempts|rate/i)
        .first()
        .waitFor({ state: "visible", timeout: 25_000 })
        .then(() => "limited")
        .catch(() => ""),
    ]);
    if (outcome === "sent") break;
    await page.waitForTimeout(30_000);
  }
  await expect(notice).toBeVisible({ timeout: 25_000 });

  let link = "";
  await expect
    .poll(
      async () => {
        try {
          const lines = (await readFile(spool as string, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean);
          const message = lines
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.to === email)
            .at(-1);
          link = message?.text?.match(/https?:\/\/\S+/)?.[0] ?? "";
        } catch {
          link = "";
        }
        return link;
      },
      { timeout: 20_000 },
    )
    .not.toBe("");

  await page.goto(link);
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create password" }).click();

  await page.goto(ORIGIN + "/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The sign-in form is gone: the account it was just created for is usable.
  await expect(page.getByRole("heading", { name: "Sign in to ChronoDB." })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
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
