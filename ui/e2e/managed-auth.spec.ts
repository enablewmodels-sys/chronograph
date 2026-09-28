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
  await expect(page.locator(".integration-banner")).toContainText("Jev & Laya");
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
