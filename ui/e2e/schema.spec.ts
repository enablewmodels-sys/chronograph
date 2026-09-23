import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
async function navigate(page: Page, name: string) {
  await expect(page.locator(".workspace-top")).toBeVisible();
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
  await expect(page.locator(".workspace-top")).toBeVisible();
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
async function connect(page: Page, token?: string) {
  const c = await config();
  await page.goto("/login");
  await page.getByLabel("API token", { exact: true }).fill(token || c.token);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await navigate(page, "Schema & migrations");
  await expect(
    page.getByRole("heading", { name: "Schema & migrations" }),
  ).toBeVisible();
}
async function applyDraft(page: Page) {
  await page
    .getByRole("button", { name: "Preview migration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready for review" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Apply migration", exact: true })
    .click();
  await expect(
    page.getByText("Migration applied and synchronized to disk.", {
      exact: true,
    }),
  ).toBeVisible();
}
test("visual schema, imported migration, typed write, settings and history", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await connect(page);
  const suffix = `${info.project.name.startsWith("mobile") ? "m" : "d"}_${info.repeatEachIndex}`;
  const kind =
    40000 + (suffix.startsWith("m") ? 100 : 0) + info.repeatEachIndex;
  const name = `observes_${suffix}`;
  await page.getByRole("button", { name: "New relation", exact: true }).click();
  await page.getByLabel("Relation name", { exact: true }).fill(name);
  await page.getByLabel("Kind ID", { exact: true }).fill(String(kind));
  await page.getByLabel("Source label", { exact: true }).fill("sensor");
  await page.getByLabel("Target label", { exact: true }).fill("object");
  await page.getByRole("button", { name: "Add property", exact: true }).click();
  await page.getByLabel("Property 1 name", { exact: true }).fill("confidence");
  await page
    .getByRole("combobox", { name: "Property 1 type", exact: true })
    .selectOption("f32");
  await page.getByRole("button", { name: "Add property", exact: true }).click();
  await page.getByLabel("Property 2 name", { exact: true }).fill("sequence");
  await page
    .getByRole("combobox", { name: "Property 2 type", exact: true })
    .selectOption("u64");
  await page.getByLabel("Property 2 offset", { exact: true }).fill("8");
  await page
    .getByRole("button", { name: "Create migration", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Migration JSON", exact: true }),
  ).toHaveText(new RegExp(name));
  await applyDraft(page);
  await page.getByRole("tab", { name: /^Relations/ }).click();
  await page.getByLabel("Find a relation").fill(name);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({
    path: `/tmp/chronograph-schema-relations-${info.project.name}-${info.repeatEachIndex}.png`,
    fullPage: true,
  });
  await navigate(page, "Write data");
  await page
    .getByRole("combobox", { name: "Schema relation", exact: true })
    .selectOption(String(kind));
  await page.getByLabel("Source ID", { exact: true }).fill(String(kind));
  await page.getByLabel("Target ID", { exact: true }).fill(String(kind + 1000));
  await page.getByLabel("Valid from (µs)", { exact: true }).fill("9000000");
  await page.getByLabel("confidence (f32)", { exact: true }).fill("0.75");
  await page
    .getByLabel("sequence (u64)", { exact: true })
    .fill("18446744073709551615");
  await page
    .getByRole("button", { name: "Insert relationship", exact: true })
    .click();
  await expect(
    page.getByText("Operation completed.", { exact: true }),
  ).toBeVisible();
  const c = await config();
  const auth = { Authorization: `Bearer ${c.token}` };
  const queried = await (
    await page.request.post(c.url + "/v1/neighbors", {
      headers: auth,
      data: { node: String(kind), t: "9000000" },
    })
  ).json();
  expect(queried.edges[0].properties).toEqual({
    confidence: 0.75,
    sequence: "18446744073709551615",
  });
  expect(queried.edges[0].relation).toBe(name);
  await navigate(page, "Schema & migrations");
  await page.getByRole("tab", { name: /^Migrations/ }).click();
  const migration = {
    version: 1,
    id: `import_${suffix}`,
    name: `Imported description ${suffix}`,
    operations: [
      {
        op: "set_settings",
        settings: { description: `World model ${suffix}` },
      },
    ],
  };
  await page
    .getByLabel("Import migration file", { exact: true })
    .setInputFiles({
      name: "20260910_world.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(migration, null, 2)),
    });
  await expect(
    page.getByRole("textbox", { name: "Migration JSON", exact: true }),
  ).toHaveText(JSON.stringify(migration, null, 2), { useInnerText: true });
  await applyDraft(page);
  await page.locator(".schema-history > summary").click();
  await expect(
    page.locator(".schema-history-item").filter({ hasText: migration.name }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`import_${suffix}.json`);
  await page.screenshot({
    path: `/tmp/chronograph-schema-migration-${info.project.name}-${info.repeatEachIndex}.png`,
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill(`World lab ${suffix}`);
  await page
    .getByLabel("Default write durability", { exact: false })
    .selectOption("fsync");
  await page.getByLabel("Default query page size", { exact: false }).fill("7");
  await page
    .getByRole("button", { name: "Draft settings migration", exact: true })
    .click();
  await applyDraft(page);
  const stats = await (
    await page.request.get(c.url + "/v1/stats", { headers: auth })
  ).json();
  expect(stats.default_durability).toBe("fsync");
  // Restore service defaults for the existing journeys sharing this ephemeral server.
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Default query page size", { exact: false })
    .fill("100");
  await page
    .getByLabel("Default write durability", { exact: false })
    .selectOption("buffered");
  await page
    .getByRole("button", { name: "Draft settings migration", exact: true })
    .click();
  await applyDraft(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Read the migration guide" }).click();
  await expect(page).toHaveURL(/\/documentation\/SCHEMA$/);
  await expect(page.locator(".prose h1")).toHaveText("Schema and migrations");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("invalid files, stale previews, draft preservation and read-only access", async ({
  page,
}, info) => {
  await connect(page);
  await page.getByRole("tab", { name: /^Migrations/ }).click();
  const editor = page.getByRole("textbox", {
    name: "Migration JSON",
    exact: true,
  });
  await editor.fill('{"not a migration":true}');
  await page
    .getByRole("button", { name: "Preview migration", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("unknown field");
  await expect(
    page.getByRole("button", { name: "Apply migration", exact: true }),
  ).toHaveCount(0);
  await expect(editor).toHaveText('{"not a migration":true}');
  const c = await config(),
    headers = { Authorization: `Bearer ${c.token}` };
  const suffix = `${info.project.name}_${info.repeatEachIndex}`;
  const source = JSON.stringify({
    version: 1,
    id: `draft_${suffix}`,
    name: "My preserved draft",
    operations: [
      { op: "set_settings", settings: { description: "Pending draft" } },
    ],
  });
  await editor.fill(source);
  await page
    .getByRole("button", { name: "Preview migration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready for review" }),
  ).toBeVisible();
  const other = JSON.stringify({
    version: 1,
    id: `concurrent_${suffix}`,
    name: "Concurrent migration",
    operations: [
      { op: "set_settings", settings: { description: "Changed elsewhere" } },
    ],
  });
  const preview = await (
    await page.request.post(c.url + "/v1/schema_preview", {
      headers,
      data: { source: other },
    })
  ).json();
  expect(
    (
      await page.request.post(c.url + "/v1/schema_apply", {
        headers,
        data: {
          source: other,
          checksum: preview.checksum,
          expected_revision: preview.expected_revision,
        },
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Apply migration", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Schema changed since preview",
  );
  await expect(editor).toHaveText(source);
  await page
    .getByRole("button", { name: "Refresh schema", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply migration", exact: true }),
  ).toBeDisabled();
  await page.locator(".schema-history > summary").click();
  await page
    .locator(".schema-history-item")
    .filter({ hasText: "Concurrent migration" })
    .first()
    .click();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await page
    .getByRole("button", { name: "Back to draft", exact: true })
    .click();
  await expect(editor).toHaveText(source);
  await navigate(page, "Overview");
  await navigate(page, "Schema & migrations");
  await page.getByRole("tab", { name: /^Migrations/ }).click();
  await expect(editor).toHaveText(source);
  const reader = await (
    await page.request.post(c.url + "/v1/tokens", {
      headers,
      data: { name: `schema_reader_${suffix}`, scope: "read", days: 1 },
    })
  ).json();
  await disconnect(page);
  await connect(page, reader.token);
  await expect(
    page.getByRole("button", { name: "New relation", exact: true }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: /^Migrations/ }).click();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(
    page.getByLabel("Import migration file", { exact: true }),
  ).toBeDisabled();
  expect(
    (
      await page.request.post(c.url + "/v1/schema_apply", {
        headers: { Authorization: `Bearer ${reader.token}` },
        data: {
          source: other,
          checksum: preview.checksum,
          expected_revision: preview.expected_revision,
        },
      })
    ).status(),
  ).toBe(403);
  await page.request.delete(c.url + `/v1/tokens/${reader.credential.id}`, {
    headers,
  });
});

test("ordered multi-file plan, baseline export and reviewed rollback", async ({
  page,
}, info) => {
  await connect(page);
  await page.getByRole("tab", { name: /^Migrations/ }).click();
  const c = await config();
  const headers = { Authorization: `Bearer ${c.token}` };
  const before = await (
    await page.request.post(c.url + "/v1/schema", { headers, data: {} })
  ).json();
  const suffix = `${info.project.name}_${info.repeatEachIndex}`;
  const kind =
    42000 +
    (info.project.name.startsWith("mobile") ? 100 : 0) +
    info.repeatEachIndex;
  const first = {
    version: 3,
    id: `plan_first_${suffix}`,
    name: "Plan relation",
    operations: [
      {
        op: "upsert_relation",
        relation: {
          kind,
          name: `plan_relation_${suffix.replaceAll("-", "_")}`,
          source_label: "a",
          target_label: "b",
          properties: [{ name: "value", type: "f32", offset: 0 }],
        },
      },
    ],
  };
  const second = {
    version: 3,
    id: `plan_second_${suffix}`,
    name: "Plan property rename",
    requires: [first.id],
    operations: [{ op: "rename_property", kind, from: "value", to: "score" }],
  };
  // Selecting in reverse order still imports in lexical filename order.
  await page
    .getByLabel("Import migration file", { exact: true })
    .setInputFiles([
      {
        name: "002.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(second)),
      },
      {
        name: "001.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(first)),
      },
    ]);
  const editor = page.getByRole("textbox", {
    name: "Migration JSON",
    exact: true,
  });
  await expect(editor).toHaveText(/migrations/);
  await page
    .getByRole("button", { name: "Preview migration", exact: true })
    .click();
  const plan = page.getByRole("list", { name: "Ordered migration plan" });
  await expect(plan.getByRole("listitem")).toHaveCount(2);
  await expect(plan.getByRole("listitem").first()).toContainText(
    "Plan relation",
  );
  await expect(plan).toContainText(`requires ${first.id}`);
  await page
    .getByRole("button", { name: "Apply migration", exact: true })
    .click();
  await expect(
    page.getByText("Migration applied and synchronized to disk.", {
      exact: true,
    }),
  ).toBeVisible();
  const after = await (
    await page.request.post(c.url + "/v1/schema", { headers, data: {} })
  ).json();
  expect(after.revision).toBe(before.revision + 2);
  expect(
    after.relations.find((r: { kind: number }) => r.kind === kind).properties[0]
      .name,
  ).toBe("score");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export schema", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("schema-baseline.json");
  expect(await readFile((await download.path())!, "utf8")).toContain(
    `plan_relation_${suffix.replaceAll("-", "_")}`,
  );
  await page.locator(".schema-history > summary").click();
  await page
    .getByLabel("Restore definitions from revision", { exact: false })
    .selectOption(String(before.revision));
  await page
    .getByRole("button", { name: "Prepare rollback", exact: true })
    .click();
  await expect(
    page.getByText("Rollback drafted. Preview and review before applying.", {
      exact: true,
    }),
  ).toBeVisible();
  // Draft preparation is read-only, even when the target is the empty catalog.
  expect(
    (
      await (
        await page.request.post(c.url + "/v1/schema", { headers, data: {} })
      ).json()
    ).revision,
  ).toBe(after.revision);
  await expect(editor).toHaveText(/drop_relation/);
  await applyDraft(page);
  const final = await (
    await page.request.post(c.url + "/v1/schema", { headers, data: {} })
  ).json();
  expect(final.revision).toBe(after.revision + 1);
  expect(final.relations.some((r: { kind: number }) => r.kind === kind)).toBe(
    false,
  );
  expect(final.history.some((h: { id: string }) => h.id === first.id)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `/tmp/chronograph-schema-plan-${info.project.name}-${info.repeatEachIndex}.png`,
    fullPage: true,
  });
});
