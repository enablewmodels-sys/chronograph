import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "Console navigation" })
    .getByRole("link", { name, exact: true })
    .click();
}
async function disconnect(page: Page) {
  const menu = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page.locator(".sidebar:visible .account-menu summary").click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
}
const config = async () =>
  JSON.parse(await readFile(resolve("../.work/e2e-config.json"), "utf8")) as {
    token: string;
    url: string;
  };
async function connect(page: Page) {
  const c = await config();
  await page.goto("/login");
  await page.getByLabel("API token", { exact: true }).fill(c.token);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
}
test("connect, explore, write, manage tokens, backup and disconnect", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await connect(page);
  await expect(page).toHaveTitle(/Chronograph/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const c = await config();
  const auth = { Authorization: `Bearer ${c.token}` };
  const stats = await (
    await page.request.get(c.url + "/v1/stats", { headers: auth })
  ).json();
  if (stats.nodes === "0") {
    await page.getByRole("button", { name: "Load sample workspace" }).click();
    await expect(
      page.getByRole("link", { name: "Open temporal explorer" }),
    ).toBeVisible();
  }
  await navigate(page, "Explorer");
  await expect(
    page.getByRole("heading", { name: "Explore any moment." }),
  ).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await page.getByLabel("Timestamp (µs)", { exact: true }).fill("-1");
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.getByText("No matching relationships.")).toBeVisible();
  await page.getByLabel("Timestamp (µs)", { exact: true }).fill("2500000");
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await page.getByLabel("Page limit").fill("2");
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Continuation page")).toBeVisible();
  await page.getByRole("button", { name: "First page", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const screenshot = `/tmp/chronograph-phase7-${testInfo.project.name}-${testInfo.repeatEachIndex}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  const arrowDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Arrow", exact: true }).click();
  expect((await arrowDownload).suggestedFilename()).toContain(".arrow");
  await navigate(page, "Write data");
  const node = String(
    BigInt(Date.now()) * 1000n + BigInt(testInfo.repeatEachIndex),
  );
  await page.getByLabel("Source ID", { exact: true }).fill(node);
  await page.getByLabel("Target ID", { exact: true }).fill("1001");
  await page.getByLabel("Valid from (µs)", { exact: true }).fill("9000000");
  await page
    .getByRole("button", { name: "Insert relationship", exact: true })
    .click();
  await expect(page.locator(".response pre")).toContainText(
    '"durability": "fsync"',
  );
  await navigate(page, "Connections & keys");
  await page.getByRole("button", { name: "New API key", exact: true }).click();
  await page
    .getByLabel("Token name", { exact: true })
    .fill("browser read token");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.getByText("Copy your token now")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss secret" }).click();
  const tokenRow = page
    .locator(".token-table tbody tr")
    .filter({ hasText: "browser read token" });
  await expect(tokenRow).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  const revokeRequest = page.waitForRequest(
    (r) => r.method() === "DELETE" && r.url().includes("/v1/tokens/"),
  );
  await tokenRow.getByRole("button", { name: "Revoke" }).click();
  // Managed cookie-authenticated mutations require this CSRF boundary header,
  // including DELETE requests without a JSON body.
  expect((await revokeRequest).headers()["content-type"]).toBe(
    "application/json",
  );
  await expect(tokenRow).toHaveCount(0);
  await navigate(page, "Operations");
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toHaveCount(1);
  const backupDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  expect((await backupDownload).suggestedFilename()).toBe(
    "chronograph-backup.tar",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("No local backups yet.")).toBeVisible();
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
    })),
  ).toEqual({ local: 0, session: 0, cookie: "" });
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await connect(page);
  await disconnect(page);
  await expect(page).toHaveURL(/\/login$/);
  expect(errors).toEqual([]);
});
test("synthetic preview works without backend calls and is read only", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let calls = 0;
  await page.route("**/v1/**", (route) => {
    calls++;
    return route.abort();
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore synthetic preview" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("Synthetic preview · no backend")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Write data", exact: true }),
  ).toHaveCount(1); // Overview documentation link; no privileged sidebar item.
  await navigate(page, "Explorer");
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await page.getByLabel("Timestamp (µs)", { exact: true }).fill("-1");
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.getByText("No matching relationships.")).toBeVisible();
  await page.screenshot({
    path: `/tmp/chronograph-demo-${testInfo.project.name}-${testInfo.repeatEachIndex}.png`,
    fullPage: true,
  });
  expect(calls).toBe(0);
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
});

test("durable branches: write in isolation, inspect, preview, merge and reject stale alternatives", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await connect(page);
  const c = await config(),
    headers = { Authorization: `Bearer ${c.token}` };
  const post = async (op: string, args: unknown = {}) => {
    const r = await page.request.post(`${c.url}/v1/${op}`, {
      headers,
      data: args,
    });
    expect(r.ok()).toBeTruthy();
    return r.json();
  };
  if ((await post("stats")).nodes === "0")
    await post("load_demo", { durability: "fsync" });
  await navigate(page, "Branches");
  const name = `UI future ${testInfo.project.name} ${testInfo.repeatEachIndex} ${Date.now()}`;
  const create = async (label: string) => {
    await page
      .getByRole("button", { name: "Create branch", exact: true })
      .click();
    await page.getByLabel("Branch name", { exact: true }).fill(label);
    await page
      .getByLabel("Fork timestamp (µs)", { exact: true })
      .fill("4000000");
    await page
      .getByRole("button", { name: "Create durable branch", exact: true })
      .click();
    await expect(page.locator(".branch-inspector h2")).toHaveText(label);
    await expect(
      page.getByText("Branch created and synchronized to disk.", {
        exact: true,
      }),
    ).toBeVisible();
  };
  await create(name);
  const forks = await post("forks");
  const id = forks.forks.find((f: { name: string }) => f.name === name).id;
  await create(name + " alternative");
  await page
    .locator(".branch-table")
    .getByRole("button", { name, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Write into branch", exact: true })
    .click();
  await expect(page.getByLabel("Working branch")).toHaveValue(id);
  const node = (BigInt(Date.now()) * 1000n + 777n).toString();
  await page.getByLabel("Source ID", { exact: true }).fill(node);
  await page.getByLabel("Target ID", { exact: true }).fill("1001");
  await page.getByLabel("Valid from (µs)", { exact: true }).fill("5000000");
  await page
    .getByLabel("Valid to (µs, optional)", { exact: true })
    .fill("6000000");
  await page
    .getByRole("button", { name: "Insert relationship", exact: true })
    .click();
  await expect(page.locator(".response pre")).toContainText(`"fork": "${id}"`);
  const inserted = JSON.parse(await page.locator(".response pre").innerText())
    .ids[0];
  expect((await post("contains_node", { id: node })).exists).toBe(false);
  expect((await post("contains_node", { id: node, fork: id })).exists).toBe(
    true,
  );
  await navigate(page, "Explorer");
  await page.getByLabel("Timestamp (µs)", { exact: true }).fill("5500000");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page
    .getByRole("button", { name: `Inspect version ${inserted}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Selected relationship", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".selection-details")).toContainText(node);
  await expect(page.locator(".selection-details")).toContainText("6000000");
  const zoomBox = await page
    .getByRole("button", { name: "Zoom in graph", exact: true })
    .locator("svg")
    .boundingBox();
  expect(zoomBox!.height).toBeLessThan(25);
  expect(zoomBox!.width).toBeLessThan(25);
  await page
    .getByRole("button", { name: "Zoom in graph", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset graph view", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Inspect version ${inserted}`, exact: true })
    .click();
  await page.screenshot({
    path: `/tmp/chronograph-branch-explorer-${testInfo.project.name}-${testInfo.repeatEachIndex}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await navigate(page, "Branches");
  await page
    .locator(".branch-table")
    .getByRole("button", { name, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview merge", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Merge review", exact: true }),
  ).toBeVisible();
  await page.getByText("Review exact ID mappings", { exact: true }).click();
  await expect(page.locator(".merge-review pre")).toContainText(node);
  await page.screenshot({
    path: `/tmp/chronograph-branches-${testInfo.project.name}-${testInfo.repeatEachIndex}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page
    .getByRole("button", { name: "Merge into main", exact: true })
    .click();
  await expect(
    page.getByText(
      "Merged into main and synchronized. The branch is now closed.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Working branch")).toHaveValue("");
  const result = (await post("fork_info", { fork: id })).merge;
  const remap = result.nodes.find((n: { branch: string }) => n.branch === node);
  expect(remap).toBeTruthy();
  expect(remap.parent).not.toBe(node);
  const edgeId = result.edges.find(
    (e: { branch: string }) => e.branch === inserted,
  ).parent;
  const committed = await post("get_edge", { id: edgeId });
  expect(committed.src).toBe(remap.parent);
  expect(committed.valid_to).toBe("6000000");
  await page
    .locator(".branch-table")
    .getByRole("button", { name: name + " alternative", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview merge", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "parent revision changed",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Discard branch", exact: true })
    .click();
  await expect(
    page.getByText("Branch discarded and synchronized.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await connect(page);
  await navigate(page, "Branches");
  await expect(
    page
      .locator(".branch-table tbody tr")
      .filter({ has: page.getByRole("button", { name, exact: true }) }),
  ).toContainText("merged");
  // A deliberate merge conflict is an expected HTTP error, not an uncaught application error.
  expect(errors.filter((e) => !e.includes("409"))).toEqual([]);
});

test("landing artwork, documentation and connector navigation render at this viewport", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Build worlds that remember.",
      exact: true,
    }),
  ).toBeVisible();
  const hero = page.locator(".world-plane.is-current img");
  await expect(hero).toBeVisible();
  await expect
    .poll(() => hero.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(1200);
  await page
    .getByRole("button", { name: "Expand timeline", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Focus this moment", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  const range = page.getByRole("slider", { name: "World timeline" });
  await range.focus();
  await page.keyboard.press("Home");
  await expect(range).toHaveValue("0");
  await page.keyboard.press("End");
  await expect(range).toHaveValue("2");
  await page.screenshot({
    path: `/tmp/chronograph-navy-${testInfo.project.name}-${testInfo.repeatEachIndex}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await expect(page.locator(".integration-banner")).toContainText(
    "TypeSafe Jev, with a memory.",
  );
  await page.getByRole("tab", { name: "Decision models", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("TypeSafe Jev");
  await page
    .getByRole("tab", { name: "Decision models", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "World models", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page
    .locator(".connection-example")
    .getByRole("button", { name: "Copy configuration" })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "$CHRONOGRAPH_URL/v1/info",
  );
  await page.goto("/documentation/connectors/worldmodel#durable-fork-rollouts");
  await expect(
    page.getByRole("heading", { name: "Durable fork rollouts", exact: true }),
  ).toBeVisible();
  await page
    .locator(".prose")
    .getByRole("link", { name: "Branch guide", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Durable branching snapshots",
      exact: true,
    }),
  ).toBeVisible();
  const docs = [
    "HOSTED",
    "ISOLATED",
    "PRODUCTION",
    "QUICKSTART",
    "TUTORIAL",
    "BRANCHES",
    "API",
    "SCHEMA",
    "MCP",
    "connectors/bci",
    "connectors/robotics",
    "connectors/worldmodel",
    "connectors/quantum",
    "ARCHITECTURE",
    "SECURITY",
    "OPERATIONS",
    "DEPLOYMENT",
    "INSTALL",
    "TESTING",
    "BENCHMARKS",
    "FORMAT",
    "LIMITATIONS",
    "EDITIONS",
    "REQUIREMENTS",
  ];
  for (const doc of docs) {
    await page.goto(`/documentation/${doc}`);
    await expect(page.locator(".prose h1")).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    if (doc === "ARCHITECTURE") {
      const diagram = page.getByAltText("Chronograph Community architecture");
      await expect
        .poll(() =>
          diagram.evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBe(1120);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `No horizontal page overflow in ${doc}`,
    ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  await connect(page);
  await navigate(page, "Connectors");
  await expect(page.locator(".connector-detail")).toHaveCount(4);
  await page
    .locator(".connector-detail")
    .filter({ hasText: "Robotics & physical AI" })
    .getByRole("link", { name: "Open connector guide" })
    .click();
  await expect(page.locator(".prose h1")).toBeVisible();
  expect(errors).toEqual([]);
});

test("world timeline supports reduced motion, keyboard selection and pause without database calls", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/v1/**", (route) => {
    calls++;
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const scene = page.locator(".world-timeline");
  await expect(scene).toHaveAttribute("data-playing", "false");
  await page.getByRole("button", { name: "Toggle world history" }).click();
  await expect(scene).toHaveClass(/is-expanded/);
  const slider = page.getByRole("slider", { name: "World timeline" });
  await slider.focus();
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", "t0: Object observed");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "t1: Action recorded");
  await page
    .getByRole("button", { name: "Focus this moment", exact: true })
    .click();
  await expect(scene).toHaveClass(/is-focused/);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Replay world animation" }).click();
  await expect(scene).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause world animation" }).click();
  await expect(scene).toHaveAttribute("data-playing", "false");
  expect(calls).toBe(0);
});
