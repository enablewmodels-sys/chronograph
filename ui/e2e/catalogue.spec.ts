// The catalogue is only useful if every board in it can actually be picked.
//
// BrainFlow ships 64 boards and documents 18 vendors; 28 boards carry the placeholder
// vendor "undocumented". Grouping by the documentation map hid exactly those boards in
// the source picker — the defect this file pins — so the test walks the real widget in a
// real console and compares what a person can choose with the catalogue file.
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const catalogue = async () =>
  JSON.parse(await readFile(resolve("src/brainflow-boards.json"), "utf8")) as {
    boards: { id: number; name: string; vendor: string }[];
  };

async function connect(page: Page) {
  const config = JSON.parse(
    await readFile(resolve("../.work/e2e-config.json"), "utf8"),
  ) as { token: string };
  await page.goto("/login");
  await page.getByLabel("API token", { exact: true }).fill(config.token);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test("the console decodes the shipped artifact in this browser", async ({
  page,
}) => {
  // The console serves a decoder and the module that reads it, so "the browser runs the
  // same reader as Python" is something this suite can check rather than assert.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await connect(page);
  await page
    .getByRole("navigation", { name: "Console navigation" })
    .getByRole("link", { name: "BCI workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser decoder check" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run a decode here" }).click();
  const outcome = page.locator("p.bci-muted", { hasText: "decoded" }).first();
  await expect(outcome).toBeVisible({ timeout: 30_000 });
  const text = await outcome.innerText();
  // It named one of the artifact's own vocabulary tokens and a real probability.
  expect(text).toMatch(/\bdecoded (up|down|left|right)\b/);
  expect(text).toMatch(/at \d+(\.\d+)?%/);
  expect(text).toContain("for an expected");
  expect(errors).toEqual([]);
});

test("every catalogued board is selectable in the source picker", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await connect(page);
  await page
    .getByRole("navigation", { name: "Console navigation" })
    .getByRole("link", { name: "BCI workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/bci$/);

  // The setup panel is behind the empty-state action on a fresh workspace, and the
  // page renders asynchronously, so wait for whichever of the two arrives.
  const heading = page.getByRole("heading", { name: "Connect a recording" });
  const setup = page.getByRole("button", { name: /Set up a source/ });
  await expect(setup.or(heading).first()).toBeVisible();
  if (!(await heading.isVisible())) await setup.click();
  await expect(heading).toBeVisible();

  // Role-based: the three selects are wrapped in their labels, and the accessible
  // name is what a screen reader announces, so that is what the test asks for.
  await page
    .getByRole("combobox", { name: "Source", exact: true })
    .selectOption("brainflow");

  const vendorSelect = page.getByRole("combobox", {
    name: "Vendor",
    exact: true,
  });
  const deviceSelect = page.getByRole("combobox", {
    name: "Device",
    exact: true,
  });
  const vendors = await vendorSelect
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  expect(vendors.length).toBeGreaterThan(0);

  const selectable = new Map<string, string>();
  for (const vendor of vendors) {
    await vendorSelect.selectOption(vendor);
    const devices = await deviceSelect
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => ({
          value: (option as HTMLOptionElement).value,
          label: (option as HTMLOptionElement).textContent ?? "",
        })),
      );
    // The floor for a broken grouping: an empty group would silently drop boards.
    expect(devices.length).toBeGreaterThan(0);
    for (const device of devices) selectable.set(device.value, device.label);
  }

  const catalogueBoards = (await catalogue()).boards;
  const expected = catalogueBoards.map((board) => String(board.id)).sort();
  const actual = [...selectable.keys()].sort();
  expect(actual).toEqual(expected);
  expect(selectable.size).toBe(catalogueBoards.length);

  // The placeholder group exists and is named for a person, not as "undocumented".
  const labels = [...selectable.values()].join(" | ");
  expect(labels).toContain("AAVAA_V3_BOARD");
  const vendorLabels = await vendorSelect
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).textContent ?? ""),
    );
  expect(
    vendorLabels.some((label) => label.startsWith("Undocumented (BrainFlow)")),
  ).toBe(true);
  // Counts describe boards, not the documentation map: this group holds one board.
  const dummy = vendorLabels.find((label) => label.startsWith("Dummy boards"));
  expect(dummy).toContain("1 board");
  expect(errors).toEqual([]);
});
