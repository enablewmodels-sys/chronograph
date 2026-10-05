// Visit every console page and report what a person would see.
//
// The other suites check the behaviour they were written for; this one answers the blunter
// question "is anything in the console broken or empty", because a page that renders an error
// or a dead end is what makes a product feel unfinished. It runs in the managed edition with a
// privileged session so the operator-only pages are included.
//
// The engine's answers are not invented here. ui/e2e/fixtures/engine.json is captured from a
// real chronograph-server by scripts/capture-engine-shapes.mjs, so a page that breaks in this
// suite breaks on a payload the server really sends. Set CHRONOGRAPH_SWEEP_ORIGIN to a running
// deployment to sweep it for real instead, with no interception at all.
import { readFileSync, writeFileSync } from "node:fs";
import { test, expect, type Cookie, type Page } from "@playwright/test";

const ORIGIN = process.env.CHRONOGRAPH_SWEEP_ORIGIN || "";
// A real deployment needs a session, so the same suite can be pointed at one by supplying an
// account. Nothing is defaulted: without a credential the suite only runs against mocks.
const EMAIL = process.env.CHRONOGRAPH_SWEEP_EMAIL || "";
const PASSWORD = process.env.CHRONOGRAPH_SWEEP_PASSWORD || "";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/engine.json", import.meta.url), "utf8"),
) as { routes: Record<string, { status: number; body: unknown }> };

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
  project: { id: "primary", name: "Primary", state: "running", role: "owner" },
  projects: [{ id: "primary", name: "Primary", state: "running", role: "owner" }],
  superadmin: true,
};

// The control plane's own answers for a project that has nothing in it yet. Each shape is the
// one gateway.mjs returns for that route; the key names are load-bearing, because a page that
// reads `keys` from a body that has none is exactly the failure this suite exists to catch.
const MANAGED: Record<string, unknown> = {
  "/managed/session": signedIn,
  "/managed/config": {
    github: true,
    google: true,
    emailSignup: false,
    passwordReset: false,
    mfaRequired: false,
    workspace: "ChronoDB",
    passwordMinLength: 15,
  },
  "/managed/members": { members: [] },
  "/managed/audit": { events: [], nextCursor: null },
  "/managed/sessions": { sessions: [] },
  "/managed/secrets": { secrets: [], keys: [] },
  "/managed/secrets/keys": { keys: [] },
  "/managed/projects": { projects: signedIn.projects },
  "/managed/apps": { apps: [], runtime: "docker" },
  "/managed/bci/jobs": {
    available: false,
    reason: "The BCI worker is not configured on this deployment.",
    jobs: [],
  },
};

// Each page is named together with copy that only that page draws. Without it the suite can
// pass a page that redirected somewhere else (a read-scope credential sends /app/secrets back
// to /app) or one whose reads all failed and left a single notice: both mount the shell, draw
// something, and raise nothing.
const PAGES: [string, string, string[]][] = [
  ["Overview", "/app/", ["Every relationship has a timeline"]],
  ["BCI workspace", "/app/bci", ["NEURAL DATA WORKSPACE", "Follow a signal"]],
  ["Explorer", "/app/explorer", ["Explore any moment"]],
  ["Branches", "/app/branches", ["Explore another future"]],
  [
    "Schema & migrations",
    "/app/schema",
    ["A recording writes numeric relation kinds"],
  ],
  ["Write data", "/app/write", ["Insert a relationship", "Writing to main"]],
  ["Connectors", "/app/connectors", ["Bring your world into the graph"]],
  ["Connections & keys", "/app/access", ["Project endpoints"]],
  ["Operations", "/app/operations", ["Storage health"]],
  ["Team & audit", "/app/team", ["Clear accountability"]],
  ["Secrets", "/app/secrets", ["Values are encrypted"]],
  [
    "Apps",
    "/app/apps",
    [
      "A manifest in this project's manifests directory",
      "Hosting is not enabled",
    ],
  ],
  ["Account security", "/app/security", ["Your account, protected"]],
];

async function mockConsole(page: Page) {
  if (ORIGIN) return;
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(
      /(<meta name="chronodb-edition" content=")[^"]+("\s*\/?>)/,
      "$1managed$2",
    );
    await route.fulfill({ response, body: html });
  });
  // The engine's operations, replayed from the capture. Anything the capture did not cover is
  // answered the way the engine answers an unknown operation: 404 with an error body.
  await page.route("**/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const recorded = fixture.routes[`${request.method()} ${path}`];
    if (!recorded)
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "No such operation." } },
      });
    const body =
      path === "/v1/info"
        ? { ...(recorded.body as object), edition: "managed" }
        : recorded.body;
    return route.fulfill({ status: recorded.status, json: body as object });
  });
  await page.route("**/managed/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = MANAGED[path];
    if (body === undefined)
      return route.fulfill({
        status: 404,
        json: {
          error: {
            code: "NOT_AVAILABLE",
            message: "This workspace operation is not available.",
          },
        },
      });
    return route.fulfill({ json: body as object });
  });
}

/**
 * One sign-in for the whole file, reused by every test. Each test gets a fresh browser
 * context, and signing in per test hit the provider's rate limit (ten attempts a minute)
 * before the last pages ran. The sign-in goes through the provider's own endpoint rather
 * than the form: the form is covered by managed-auth.spec.ts, and what this suite needs is
 * a session, not a click path.
 */
const STATE = process.env.CHRONOGRAPH_SWEEP_STATE || "";
let cookies: Cookie[] = [];
test.beforeAll(async ({ playwright }) => {
  if (!ORIGIN || !EMAIL || !PASSWORD) return;
  const context = await playwright.request.newContext({ baseURL: ORIGIN });
  try {
    // The provider rate-limits sign-in attempts, so a saved session is reused until it stops
    // answering. That also means a sweep of a real deployment costs one sign-in, not thirteen.
    if (STATE) {
      try {
        const saved = JSON.parse(readFileSync(STATE, "utf8")) as { cookies: Cookie[] };
        await context.setExtraHTTPHeaders({});
        const check = await context.get("/managed/session", {
          headers: { cookie: saved.cookies.map((c) => c.name + "=" + c.value).join("; ") },
        });
        const body = check.ok() ? await check.json() : null;
        if (body?.user) {
          cookies = saved.cookies;
          return;
        }
      } catch {
        /* no usable saved session; sign in below */
      }
    }
    const response = await context.post("/api/auth/sign-in/email", {
      data: { email: EMAIL, password: PASSWORD },
      headers: { origin: ORIGIN },
    });
    if (!response.ok())
      throw new Error(
        "sign-in failed: " + response.status() + " " + (await response.text()),
      );
    cookies = (await context.storageState()).cookies;
    if (!cookies.length) throw new Error("sign-in produced no session cookie");
    if (STATE)
      writeFileSync(STATE, JSON.stringify({ cookies }, null, 2) + "\n", { mode: 0o600 });
  } finally {
    await context.dispose();
  }
});

/* The operator panel is the page that was reported broken while everything underneath it
   was fine: the account was signed out twenty minutes earlier, so /admin answered with the
   sign-in form and read as a broken panel. Against a real deployment this asserts the panel
   itself renders, which the mocked superadmin suite cannot say. */
test("the operator panel renders for the operator account", async ({ page }) => {
  test.skip(!ORIGIN, "Only meaningful against a real deployment.");
  await page.context().addCookies(cookies);
  await page.goto(ORIGIN + "/admin");
  await expect(page.getByRole("heading", { name: "Platform status" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".superadmin-denied")).toHaveCount(0);
});

// One test per page: a failure names the page, and each page gets its own budget instead
// of one long walk that can only report the first timeout.
for (const [name, path, markers] of PAGES) {
  test(`${name} renders without an error or a dead end`, async ({ page }) => {
    const errors: string[] = [];
    const console_: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // React unmounts the whole tree when a render throws outside the boundary, and the
    // console is then the only witness. Keep it for the failure message.
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        console_.push(`[${message.type()}] ${message.text()}`);
    });
    await mockConsole(page);
    if (cookies.length) await page.context().addCookies(cookies);
    await page.goto(ORIGIN ? ORIGIN + path : path);
    // The console shell is the proof that the route mounted at all. When it is missing,
    // say what the page is showing instead: a redirect and a render failure look nothing
    // alike and only one of them is a bug in this file.
    // Every outcome is recorded in one place so that a run reports all broken pages, and
    // the assertion at the end fails the test with the message the page itself produced.
    const failures: string[] = [];
    const shell = page.locator(".workspace-top");
    const boundaryCard = page
      .locator('[role="alert"]')
      .filter({
        has: page.getByRole("heading", {
          name: "This page could not be displayed.",
        }),
      });
    // Wait for whichever happens: the console shell paints (the route mounted) or the
    // boundary paints (the route mounted and threw). Anything else after this window is
    // genuinely blank, and only then is the page at fault.
    await page
      .locator(".workspace-top, .standalone-security > h2")
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch(() => {});
    let rendered = await shell.isVisible().catch(() => false);
    if (!rendered) {
      rendered = await boundaryCard.isVisible().catch(() => false);
      if (rendered) {
        // Say what the page refused to render: a boundary with a message is a defect to
        // fix, not a state to accept silently.
        const detail = await boundaryCard
          .locator("p.small")
          .first()
          .innerText()
          .catch(() => "");
        failures.push(`render failure — ${detail.replace(/\s+/g, " ").trim()}`);
      }
    }
    if (!rendered) {
      const body = (await page.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .slice(0, 200);
      const state = await page
        .evaluate(() => ({
          nodes: document.documentElement.outerHTML.length,
          main: !!document.querySelector("main"),
          edition: document
            .querySelector('meta[name="chronodb-edition"]')
            ?.getAttribute("content"),
        }))
        .catch(() => null);
      failures.push(
        `the screen is blank at ${page.url()} | body: ${body} | dom: ${JSON.stringify(state)}` +
          ` | pageerrors: ${errors.join("; ").slice(0, 200)}` +
          ` | console: ${console_.join("; ").slice(0, 400)}`,
      );
    }
    const text = (await page.locator("main").innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    // Reaching the shell means the route mounted. From there the requirements are that this
    // page — not a redirect to another one — drew its own content, and that nothing raised.
    if (rendered && (await shell.isVisible().catch(() => false))) {
      if (!text) failures.push("the page mounted but drew nothing inside <main>.");
      if (!markers.some((marker) => text.includes(marker)))
        failures.push(
          `${path} did not draw its own page: expected one of ${markers.join(" / ")}` +
            ` | drew: ${text.slice(0, 240)}`,
        );
      for (const error of errors) failures.push(`raised ${error}`);
    }
    console.log(
      `  ${name.padEnd(20)} ${path.padEnd(18)} ${(failures.length ? failures.join(" | ") : text).slice(0, 140)}`,
    );
    expect(failures, `${name}:`).toEqual([]);
  });
}
