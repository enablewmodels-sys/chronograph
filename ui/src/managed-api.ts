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
}
let project = "";
export function setManagedProject(id: string) {
  project = id;
}
export function projectHeaders(): Record<string, string> {
  return project ? { "X-Chronograph-Project": project } : {};
}
export async function managedApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      ...projectHeaders(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) {
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
export async function githubSignIn() {
  const result = await managedApi<{ url: string }>("/api/auth/sign-in/social", {
    provider: "github",
    callbackURL: window.location.origin + "/login",
    errorCallbackURL: window.location.origin + "/login?error=github",
  });
  const target = new URL(result.url);
  if (target.origin !== "https://github.com")
    throw new Error("Unexpected sign-in destination.");
  window.location.assign(target.href);
}
