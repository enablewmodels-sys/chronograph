export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "editor" | "viewer" | "member";
  twoFactorEnabled: boolean;
  needsMfa: boolean;
  needsActivation: boolean;
  hasPassword: boolean;
  sessionId: string;
  expiresAt: string;
  freshUntil: number;
}
export interface ManagedProject {
  id: string;
  name: string;
  state: string;
  role?: string;
}
export interface ManagedSession {
  user: ManagedUser | null;
  project: ManagedProject | null;
  projects: ManagedProject[];
  /** True only for a platform operator named in the server's superadminEmails. */
  superadmin?: boolean;
}
export interface ManagedAuthConfig {
  github: boolean;
  google: boolean;
  emailSignup: boolean;
  passwordReset: boolean;
}
let project = "";
export function setManagedProject(id: string) {
  project = id;
}
export function projectHeaders(): Record<string, string> {
  return project ? { "X-Chronograph-Project": project } : {};
}
/**
 * Every call is bounded. Without this a slow or restarting control plane left the
 * console on "Checking your account…" forever, because the session probe never
 * settled and the sign-in form was never allowed to render.
 */
const REQUEST_TIMEOUT_MS = 8000;
export async function managedApi<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        ...projectHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw Object.assign(
      new Error(
        (error as Error)?.name === "AbortError"
          ? "The service did not answer in time. Try again."
          : "The service is unreachable.",
      ),
      { code: "NETWORK" },
    );
  } finally {
    clearTimeout(timer);
  }
  const value = await response.json().catch(() => null);
  if (value === null) {
    throw Object.assign(new Error("The service returned an unreadable answer."), {
      code: "BAD_RESPONSE",
    });
  }
  if (!response.ok) {
    // A 401 here is the control plane saying this browser is no longer signed in. The
    // console listens for this so it can explain the sign-out instead of rendering a page
    // full of failed requests.
    if (response.status === 401 && !path.startsWith("/api/auth"))
      window.dispatchEvent(new Event("session-expired"));
    throw Object.assign(
      new Error(
        value.error?.message ||
          value.message ||
          "The request could not be completed.",
      ),
      { code: value.error?.code || value.code },
    );
  }
  return value;
}
export type SocialProvider = "github" | "google";
export async function socialSignIn(provider: SocialProvider) {
  const result = await managedApi<{ url: string }>("/api/auth/sign-in/social", {
    provider,
    callbackURL: window.location.origin + "/login",
    errorCallbackURL: window.location.origin + "/login",
  });
  const target = new URL(result.url);
  const expected =
    provider === "google"
      ? "https://accounts.google.com"
      : "https://github.com";
  if (target.origin !== expected || target.username || target.password)
    throw new Error("Unexpected sign-in destination.");
  window.location.assign(target.href);
}
export const githubSignIn = () => socialSignIn("github");
