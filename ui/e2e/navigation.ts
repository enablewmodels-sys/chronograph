/**
 * Navigate the console the way the viewport allows.
 *
 * Below the desktop breakpoint the sidebar collapses behind an "Open navigation" button, so a
 * locator for the navigation itself is not visible and a click on a link inside it never lands.
 * Three tests assumed the desktop sidebar and failed only in the mobile project; the product was
 * right and the tests were desktop-shaped. This opens the sidebar when it is collapsed and
 * otherwise does nothing, so a test can be written once for both viewports.
 */
import { expect, type Page } from "@playwright/test";

/** The console sidebar, opening it first when the viewport has collapsed it. */
export async function consoleNavigation(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Console navigation" });
  if (await navigation.isVisible().catch(() => false)) return navigation;
  const toggle = page.getByRole("button", { name: "Open navigation" });
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await expect(navigation).toBeVisible();
  }
  return navigation;
}

/** Open the console page a link in the sidebar points at, at any viewport. */
export async function openConsolePage(page: Page, name: string) {
  const navigation = await consoleNavigation(page);
  await navigation.getByRole("link", { name, exact: true }).click();
}
