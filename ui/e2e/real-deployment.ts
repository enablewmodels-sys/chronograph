/**
 * One real deployment, shared by the console suites.
 *
 * WHY this exists: a mock whose payload the server never sends tests the mock. The console's
 * worst failures have all been in the seam between the two — a session that quietly died, a
 * page that rendered one error notice, a button that called a route the control plane does not
 * serve — and none of those can be seen against an intercepted request. So the suites that
 * matter here run the real thing: scripts/managed-local.mjs runs the real gateway over a real
 * engine, and these helpers sign in to it once per run.
 *
 * Pointed at nothing (no CHRONOGRAPH_SWEEP_ORIGIN), the suites that use this skip; the mocked
 * suites still run everywhere.
 *
 *   CHRONOGRAPH_SWEEP_ORIGIN=http://127.0.0.1:19090
 *   CHRONOGRAPH_SWEEP_EMAIL=operator@chronodb.local
 *   CHRONOGRAPH_SWEEP_PASSWORD="$(cat /tmp/chronodb-local/owner-password)"
 *   CHRONOGRAPH_SWEEP_STATE=/tmp/chronodb-local/sweep-session.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Cookie, Page, Playwright } from "@playwright/test";

export const ORIGIN = process.env.CHRONOGRAPH_SWEEP_ORIGIN || "";
export const EMAIL = process.env.CHRONOGRAPH_SWEEP_EMAIL || "";
export const PASSWORD = process.env.CHRONOGRAPH_SWEEP_PASSWORD || "";
const STATE = process.env.CHRONOGRAPH_SWEEP_STATE || "";

/** True when a deployment and an account were supplied. */
export const configured = Boolean(ORIGIN && EMAIL && PASSWORD);

export const NEEDS_DEPLOYMENT =
  "Needs a real deployment: CHRONOGRAPH_SWEEP_ORIGIN with CHRONOGRAPH_SWEEP_EMAIL and " +
  "CHRONOGRAPH_SWEEP_PASSWORD (see scripts/managed-local.mjs).";

let cookies: Cookie[] = [];

/**
 * Sign in once for the whole run. The provider rate-limits sign-in attempts (ten a minute), and
 * every test gets a fresh browser context, so a per-test sign-in fails the last pages of a run.
 * A saved session is reused while it still answers, which makes a sweep cost one sign-in.
 */
export async function signInOnce(playwright: Playwright): Promise<void> {
  if (!configured) return;
  const context = await playwright.request.newContext({ baseURL: ORIGIN });
  try {
    if (STATE) {
      try {
        const saved = JSON.parse(readFileSync(STATE, "utf8")) as { cookies: Cookie[] };
        const check = await context.get("/managed/session", {
          headers: {
            cookie: saved.cookies.map((c) => c.name + "=" + c.value).join("; "),
          },
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
}

/** Put the run's session on a page. Every test gets its own context, so every test needs it. */
export async function applySession(page: Page): Promise<void> {
  if (cookies.length) await page.context().addCookies(cookies);
}
