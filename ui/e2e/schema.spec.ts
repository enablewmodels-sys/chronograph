import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  await page
    .getByRole("link", { name: "Schema & migrations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Give your graph a language." }),
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
  ).toHaveValue(new RegExp(name));
  await applyDraft(page);
  await page.getByRole("tab", { name: /^Relations/ }).click();
  await page.getByLabel("Find a relation").fill(name);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({
    path: `/tmp/chronograph-schema-relations-${info.project.name}-${info.repeatEachIndex}.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Write data", exact: true }).click();
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
  await page
    .getByRole("link", { name: "Schema & migrations", exact: true })
    .click();
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
  ).toHaveValue(JSON.stringify(migration, null, 2));
  await applyDraft(page);
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
  await expect(editor).toHaveValue('{"not a migration":true}');
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
  await expect(editor).toHaveValue(source);
  await page
    .getByRole("button", { name: "Refresh schema", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply migration", exact: true }),
  ).toBeDisabled();
  await page
    .locator(".schema-history-item")
    .filter({ hasText: "Concurrent migration" })
    .first()
    .click();
  await expect(editor).toHaveAttribute("readonly", "");
  await page
    .getByRole("button", { name: "Back to draft", exact: true })
    .click();
  await expect(editor).toHaveValue(source);
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page
    .getByRole("link", { name: "Schema & migrations", exact: true })
    .click();
  await page.getByRole("tab", { name: /^Migrations/ }).click();
  await expect(editor).toHaveValue(source);
  const reader = await (
    await page.request.post(c.url + "/v1/tokens", {
      headers,
      data: { name: `schema_reader_${suffix}`, scope: "read", days: 1 },
    })
  ).json();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await connect(page, reader.token);
  await expect(
    page.getByRole("button", { name: "New relation", exact: true }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: /^Migrations/ }).click();
  await expect(editor).toHaveAttribute("readonly", "");
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
