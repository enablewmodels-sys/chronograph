import { test, expect } from "@playwright/test";

// Reproduce the hosted regression against the Community artifact. The private
// gateway stamps this metadata; account/provider security has separate tests.
test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(
      /(<meta name="chronodb-edition" content=")[^"]+("\s*\/?>)/,
      "$1managed$2",
    );
    await route.fulfill({ response, body: html });
  });
  await page.route("**/managed/session", (route) =>
    route.fulfill({ json: { user: null, project: null, projects: [] } }),
  );
  await page.route("**/managed/config", (route) =>
    route.fulfill({
      json: {
        google: true,
        github: true,
        emailSignup: false,
        passwordReset: false,
      },
    }),
  );
});

test("hosted navigation restores signup and account login even with Community assets", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(
    nav.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "Sign up", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Give intelligence a memory." }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Neuralink/i);
  await nav.getByRole("link", { name: "Sign up", exact: true }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(
    page.getByRole("heading", { name: "Create your account." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(page.getByLabel("API token", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue with email" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(
    page.getByText("Email recovery is not available yet.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "contact support" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("email signup is offered only when delivery is configured", async ({
  page,
}) => {
  await page.route("**/managed/config", (route) =>
    route.fulfill({
      json: {
        google: true,
        github: true,
        emailSignup: true,
        passwordReset: true,
      },
    }),
  );
  await page.route("**/managed/auth/register", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      name: "Signup fixture",
      email: "signup@example.com",
    });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Signup fixture");
  await page.getByLabel("Email address").fill("signup@example.com");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("status")).toContainText("Check your inbox");
});

test("account service errors offer a retry instead of token login", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/managed/config", (route) =>
    ++attempts === 1
      ? route.fulfill({ status: 503, json: { message: "Please try again." } })
      : route.fulfill({
          json: {
            google: true,
            github: true,
            emailSignup: false,
            passwordReset: false,
          },
        }),
  );
  await page.goto("/signup");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(page.getByLabel("API token", { exact: true })).toHaveCount(0);
});

// Regression: the console gates must agree with the server's readiness contract.
// The server reports needsMfa=false and twoFactorEnabled=false while the
// authenticator is off; a client that still required twoFactorEnabled bounced
// /app -> /projects -> /login -> /app forever and rendered a blank screen.
const signedIn = {
  user: {
    id: "u-1",
    name: "Operator",
    email: "enablewmodels@gmail.com",
    role: "owner",
    twoFactorEnabled: false,
    needsMfa: false,
    needsActivation: false,
    hasPassword: true,
    sessionId: "s-1",
    expiresAt: "2030-01-01T00:00:00.000Z",
    freshUntil: 0,
  },
  project: { id: "primary", name: "Primary", state: "running" },
  projects: [{ id: "primary", name: "Primary", state: "running" }],
  superadmin: true,
};

test("a signed-in account reaches the console without a redirect loop", async ({
  page,
}) => {
  const errors: string[] = [];
  const visited: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  await page.route("**/managed/session", (route) =>
    route.fulfill({ json: signedIn }),
  );
  await page.route("**/v1/info", (route) =>
    route.fulfill({
      json: {
        credential: { id: "c-1", scope: "admin" },
        edition: "managed",
        mcp_url: "",
        uptime_seconds: 12,
        project: signedIn.project,
        account: signedIn.user,
      },
    }),
  );
  // The console shell reads these three at mount. Without them the isolated test
  // server answers 401, the app treats that as an expired session and signs out,
  // which would hide the routing behaviour this test exists to pin down.
  await page.route("**/v1/stats", (route) =>
    route.fulfill({
      json: {
        nodes: "128",
        edge_versions: "256",
        log_bytes: "4096",
        recovered_tail_bytes: "0",
        default_durability: "fsync",
        require_fsync: true,
        writer_healthy: true,
        revision: "3",
        active_forks: "0",
        duration_ms: 1,
      },
    }),
  );
  await page.route("**/v1/forks", (route) =>
    route.fulfill({ json: { forks: [], next_after: null } }),
  );
  await page.route("**/v1/schema", (route) =>
    route.fulfill({
      json: {
        revision: 0,
        history: [],
        relations: [],
        settings: {
          name: "Primary",
          description: "",
          default_durability: "fsync",
          default_query_limit: 100,
          strict_relations: false,
        },
      },
    }),
  );
  await page.goto("/app");
  await expect(
    page.getByRole("navigation", { name: "Console navigation" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("link", { name: "All projects" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Operator panel" }),
  ).toBeVisible();
  // A loop keeps re-navigating; the settled page must stop at /app.
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/app$/);
  expect(visited.filter((p) => p === "/login" || p === "/projects")).toEqual(
    [],
  );
  expect(errors).toEqual([]);
});

test("an unreachable account service says so instead of showing the sign-in form", async ({
  page,
}) => {
  // The account service failing is not the same as being signed out. Showing the
  // sign-in form here reads as a broken session and hides a retryable outage.
  await page.route("**/managed/session", (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: "INTERNAL", message: "Account service unavailable." } },
    }),
  );
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "The account service is not answering." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/app$/);
});

test("a signed-in non-operator is told, not bounced to the sign-in form", async ({
  page,
}) => {
  await page.route("**/managed/session", (route) =>
    route.fulfill({ json: { ...signedIn, superadmin: false } }),
  );
  await page.route("**/v1/info", (route) =>
    route.fulfill({
      json: {
        credential: { id: "c-1", scope: "read" },
        edition: "managed",
        mcp_url: "",
        uptime_seconds: 12,
        project: signedIn.project,
        account: signedIn.user,
      },
    }),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Operator access required." }),
  ).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
});

test("a superadmin account stays on the operator panel", async ({ page }) => {
  await page.route("**/managed/session", (route) =>
    route.fulfill({ json: signedIn }),
  );
  await page.route("**/managed/superadmin/overview", (route) =>
    route.fulfill({ json: { generatedAt: Date.now(), alerts: [] } }),
  );
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").first()).toBeVisible();
});
