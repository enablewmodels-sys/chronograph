import { test, expect, type Page, type Route } from "@playwright/test";

/* The operator panel is the highest-value page in the Managed console, so these
   cases cover what it shows, what it refuses to claim, and the two ways it is
   refused. The snapshot here is a fixture: the panel must render exactly what the
   endpoint returned and must never turn a missing reading into a healthy one. */

const STAMP = 1_790_881_860;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    at: STAMP,
    // The aggregator can emit both levels at once, so the fixture carries a
    // critical and a warning and the page must distinguish them.
    alerts: [
      {
        level: "critical",
        code: "project.engine_unreachable",
        message: "A project engine did not answer its readiness probe.",
        detail:
          "prj_f3736c2c28523976 — The engine refused the readiness connection.",
      },
      {
        level: "warning",
        code: "backup.stale",
        message: "A project backup is older than the freshness window.",
        detail: "secondary",
      },
    ],
    host: {
      uptimeSec: 1_016_400,
      loadAvg: [0.01, 0.02, 0.0],
      cpuCount: 2,
      cpuModel: "Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz",
      memoryTotalBytes: 8_000_000_000,
      memoryAvailableBytes: 3_000_000_000,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
      disks: [
        {
          path: "/",
          totalBytes: 100_000_000_000,
          freeBytes: 52_000_000_000,
          usedPercent: 48,
        },
      ],
    },
    services: [
      { unit: "chronograph-managed.service", active: true, enabled: true },
      {
        unit: "chronograph-monitor.service",
        active: null,
        enabled: null,
        reason: "systemctl is not available on this host.",
      },
    ],
    engines: { count: 1, limit: 3, processes: [] },
    projects: [
      {
        id: "prj_f3736c2c28523976",
        name: "secondary",
        ownerId: "user_1",
        state: "ready",
        port: 18100,
        memberCount: 2,
        ageSec: 260_000,
        diskBytes: 8_192,
        backup: {
          latestAt: STAMP - 3600,
          latestBytes: 8_192,
          count: 1,
          stale: true,
        },
        engine: { reachable: true, revision: "4" },
      },
    ],
    accounts: {
      total: 3,
      byStatus: { invited: 1, active: 2, suspended: 0 },
      byRole: { owner: 2, admin: 0, editor: 0, viewer: 1 },
      mfaEnrolled: 2,
      sessionsActive: 2,
      invitesPending: 1,
      invitesExpired: 0,
      lastSignInAt: STAMP - 120,
    },
    // backupsSection derives ok = latestAt !== null && !stale, so a missing
    // archive is the only shape that yields ok false with a stale identity.
    backups: {
      ok: false,
      identity: { latestAt: null, latestBytes: null, count: 0, stale: true },
    },
    audit: {
      total: 128,
      recent: [
        {
          seq: 128,
          at: STAMP,
          actor: "user_1",
          action: "superadmin.viewed",
          target: "overview",
          outcome: "success",
        },
      ],
    },
    traffic: {
      requests: 4_312,
      clientErrors: 21,
      serverErrors: 0,
      rateLimited: 3,
      since: STAMP - 9_000,
    },
    release: {
      release: "20260928-accounts-r2",
      commit: "2d87c427d460ffd91d38d93ef1361fd4bce93896",
      edition: "managed",
      deployedAt: STAMP - 260_000,
    },
    ...overrides,
  };
}

/* The Community artifact is served by the test server, so the document is
   restamped the way the private gateway does it. */
async function managedDocument(page: Page) {
  await page.route("**/*", async (route: Route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(
      /(<meta name="chronodb-edition" content=")[^"]+("\s*\/?>)/,
      "$1managed$2",
    );
    await route.fulfill({ response, body: html });
  });
  await page.route("**/managed/config", (route) =>
    route.fulfill({
      json: {
        google: false,
        github: false,
        emailSignup: false,
        passwordReset: false,
      },
    }),
  );
}

test("an operator reads every section and unknown readings are never healthy", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await managedDocument(page);
  await page.route("**/managed/session", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "user_1",
          email: "enablewmodels@gmail.com",
          name: "Operator",
        },
        project: { id: "primary" },
        projects: [{ id: "primary" }],
        superadmin: true,
      },
    }),
  );
  let overviewCalls = 0;
  await page.route("**/managed/superadmin/overview", (route) => {
    overviewCalls += 1;
    return route.fulfill({ json: snapshot() });
  });

  await page.goto("/admin");

  await expect(
    page.getByRole("heading", { name: "Platform status" }),
  ).toBeVisible();
  await expect(page.locator(".superadmin-denied")).toHaveCount(0);
  for (const panel of [
    "Alerts",
    "Host",
    "Services",
    "Engines",
    "Projects",
    "Accounts",
    "Backups",
    "Audit",
    "Release",
  ]) {
    await expect(
      page.getByRole("heading", { name: panel, exact: true }),
    ).toBeVisible();
  }

  // Every alert is surfaced with its code and detail, not folded into a count,
  // and the level is visible rather than implied by colour alone.
  const alerts = page.locator(".superadmin-alert");
  await expect(alerts).toHaveCount(2);
  const critical = page.locator(".superadmin-alert-critical");
  await expect(critical).toHaveCount(1);
  await expect(critical).toContainText("project.engine_unreachable");
  await expect(critical).toContainText("critical");
  await expect(critical).toContainText(
    "The engine refused the readiness connection.",
  );
  const warning = page.locator(".superadmin-alert-warning");
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText(
    "A project backup is older than the freshness window.",
  );
  await expect(warning).toContainText("secondary");

  // Real values render.
  // The id appears in both the Projects and Project backups tables, so the
  // assertion is scoped to the table it belongs to.
  const projects = page.getByRole("table", { name: "Projects" });
  await expect(
    projects.getByRole("rowheader", { name: "prj_f3736c2c28523976" }),
  ).toBeVisible();
  const projectBackups = page.getByRole("table", { name: "Project backups" });
  await expect(
    projectBackups.getByRole("rowheader", { name: "prj_f3736c2c28523976" }),
  ).toBeVisible();
  await expect(page.locator("body")).toContainText(
    "2d87c427d460ffd91d38d93ef1361fd4bce93896",
  );
  // A measured byte value still renders as a size, so the unknown assertions in
  // the degraded case cannot pass merely because bytes never render at all.
  await expect(page.getByText("8.0 KB").first()).toBeVisible();
  await expect(page.locator("body")).toContainText("superadmin.viewed");

  // An unmeasurable unit state is unknown, not "not running".
  const monitorRow = page.getByRole("row", {
    name: /chronograph-monitor\.service/,
  });
  await expect(monitorRow).toContainText(
    "systemctl is not available on this host.",
  );
  // Both flags are unmeasurable, so both read as unknown rather than inactive.
  await expect(monitorRow.locator(".superadmin-unknown")).toHaveCount(2);
  await expect(monitorRow.locator(".superadmin-unknown").first()).toHaveText(
    "unknown",
  );

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect
    .poll(() => overviewCalls, {
      message: "refresh must re-request the snapshot",
    })
    .toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test("an absent probe section is reported, not invented", async ({ page }) => {
  await managedDocument(page);
  await page.route("**/managed/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "user_1", email: "enablewmodels@gmail.com" },
        project: null,
        projects: [],
        superadmin: true,
      },
    }),
  );
  await page.route("**/managed/superadmin/overview", (route) =>
    route.fulfill({
      json: snapshot({
        host: null,
        services: null,
        engines: null,
        projects: null,
        accounts: null,
        backups: null,
        audit: null,
        traffic: null,
        release: null,
        alerts: [],
      }),
    }),
  );

  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Platform status" }),
  ).toBeVisible();
  await expect(
    page.getByText("The probe did not report.").first(),
  ).toBeVisible();
  await expect(
    page.getByText("The platform is clear. No alerts were reported."),
  ).toBeVisible();
});

test("a signed-out visitor is asked to sign in rather than shown the fleet", async ({
  page,
}) => {
  await managedDocument(page);
  await page.route("**/managed/session", (route) =>
    route.fulfill({
      json: { user: null, project: null, projects: [], superadmin: false },
    }),
  );
  await page.route("**/managed/superadmin/overview", (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      },
    }),
  );

  await page.goto("/admin");
  await expect(page.locator(".superadmin-denied")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sign in required" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.locator(".superadmin-panel")).toHaveCount(0);
});

test("a signed-in account that is not an operator is refused", async ({
  page,
}) => {
  await managedDocument(page);
  await page.route("**/managed/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "user_2", email: "member@example.com" },
        project: { id: "primary" },
        projects: [{ id: "primary" }],
        superadmin: false,
      },
    }),
  );
  await page.route("**/managed/superadmin/overview", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "FORBIDDEN",
          message: "Platform operator access required.",
        },
      },
    }),
  );

  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Not authorised" }),
  ).toBeVisible();
  await expect(page.locator(".superadmin-panel")).toHaveCount(0);
});

test("the operator entry appears in the console only for an operator", async ({
  page,
  isMobile,
}) => {
  // At the mobile viewport the console sidebar is reached through a menu, which
  // console.spec.ts already covers. This case is about who sees the entry.
  test.skip(
    isMobile === true,
    "The console sidebar is a desktop layout concern.",
  );
  await managedDocument(page);
  let superadmin = false;
  await page.route("**/managed/session", (route) =>
    route.fulfill({
      json: {
        // The console only renders for a session that has cleared the
        // authenticator gate and reached a project, so the entry point is
        // asserted with exactly that session in place.
        user: {
          id: "user_1",
          email: "enablewmodels@gmail.com",
          needsMfa: false,
          twoFactorEnabled: true,
          needsActivation: false,
        },
        project: { id: "primary" },
        projects: [{ id: "primary" }],
        superadmin,
      },
    }),
  );
  // Every other engine call is refused, which the console panes render as an
  // error. A 401 would instead fire session-expired and tear the console down,
  // which is a different path and not what this case is about.
  await page.route("**/v1/**", (route) =>
    route.fulfill({
      status: 403,
      json: { error: { message: "Not offered in this test." } },
    }),
  );
  // Registered last, so it takes precedence over the catch-all above.
  await page.route("**/v1/info", (route) =>
    route.fulfill({
      json: {
        credential: { id: "key_1", scope: "admin" },
        edition: "managed",
        mcp_url: "/mcp",
        uptime_seconds: 1,
      },
    }),
  );
  await page.route("**/managed/superadmin/overview", (route) =>
    route.fulfill({ json: snapshot() }),
  );

  await page.goto("/app");
  // The operator entry sits in the console sidebar beside the navigation, not
  // inside it, so the sidebar is the scope for both assertions.
  const sidebar = page.getByRole("complementary");
  await expect(
    sidebar.getByRole("navigation", { name: "Console navigation" }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "All projects" }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "Operator panel" }),
  ).toHaveCount(0);

  superadmin = true;
  await page.reload();
  await expect(
    sidebar.getByRole("link", { name: "Operator panel" }),
  ).toBeVisible();
  await sidebar.getByRole("link", { name: "Operator panel" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "Platform status" }),
  ).toBeVisible();
});

test("a degraded deployment renders unknown rather than zero", async ({
  page,
}) => {
  // The real probe never returns a null section: a failing section keeps its
  // shape and reports null fields. That is the shape that could silently read as
  // zero, so it is asserted directly.
  await managedDocument(page);
  await page.route("**/managed/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "user_1", email: "enablewmodels@gmail.com" },
        project: null,
        projects: [],
        superadmin: true,
      },
    }),
  );
  await page.route("**/managed/superadmin/overview", (route) =>
    route.fulfill({
      json: snapshot({
        host: {
          uptimeSec: null,
          loadAvg: [],
          cpuCount: null,
          cpuModel: "",
          memoryTotalBytes: null,
          memoryAvailableBytes: null,
          swapTotalBytes: null,
          swapFreeBytes: null,
          disks: [],
        },
        services: [],
        engines: { count: null, limit: 3, processes: [] },
        projects: [],
        accounts: {
          total: null,
          byStatus: { invited: null, active: null, suspended: null },
          byRole: { owner: null, admin: null, editor: null, viewer: null },
          mfaEnrolled: null,
          sessionsActive: null,
          invitesPending: null,
          invitesExpired: null,
          lastSignInAt: null,
        },
        backups: {
          ok: false,
          identity: {
            latestAt: null,
            latestBytes: null,
            count: 0,
            stale: true,
          },
        },
        audit: { recent: [], total: null },
        traffic: {
          requests: null,
          clientErrors: null,
          serverErrors: null,
          rateLimited: null,
          since: null,
        },
        release: {
          release: null,
          commit: null,
          edition: null,
          deployedAt: null,
        },
        alerts: [
          {
            level: "warning",
            code: "section.unavailable",
            message: "The host section could not be read.",
            detail: "statfs failed",
          },
        ],
      }),
    }),
  );

  await page.goto("/admin");

  // A count that was never measured reads as unknown, and the literal 0 never
  // appears where a measurement is missing.
  const stat = (label: string) =>
    page.locator(".superadmin-stat").filter({
      has: page.locator("dt", { hasText: new RegExp("^" + label + "$") }),
    });
  for (const label of [
    "Accounts",
    "Invited",
    "Active",
    "Suspended",
    "MFA enrolled",
  ]) {
    await expect(stat(label).locator("dd")).toHaveText("unknown");
  }
  await expect(
    page.getByText("unknown of 3 engine processes running."),
  ).toBeVisible();
  // The zero claim needs a real zero: an unmeasured process list must not be
  // reported as "nothing is running".
  await expect(page.getByText("No engine processes are running.")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("The engine process list was not reported."),
  ).toBeVisible();

  // Bytes and timestamps must fail the same way counts do, or a "0" fallback in
  // any one formatter would slip through.
  // These two read "<used> of <total>", so both halves must be unknown. The
  // usage bar inside the same cell carries its own label, hence contains.
  await expect(stat("Memory used").locator("dd")).toContainText(
    "unknown of unknown",
  );
  await expect(stat("Swap used").locator("dd")).toContainText(
    "unknown of unknown",
  );
  await expect(stat("Identity size").locator("dd")).toHaveText("unknown");
  await expect(stat("Last sign-in").locator("dd")).toHaveText("unknown");
  await expect(stat("Identity archive").locator("dd")).toHaveText("unknown");

  // The degradation is visible as an alert rather than as an empty panel.
  await expect(page.locator(".superadmin-alert")).toHaveCount(1);
  await expect(page.locator(".superadmin-alert")).toContainText(
    "The host section could not be read.",
  );
});
