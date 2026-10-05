// Edition selection for the console.
//
// Three editions share one codebase:
//
//   managed    chronodb.co and other hosted deployments. Accounts, MFA and
//              memberships come from the private control plane.
//   community  a self-hosted install. The operator mints scoped API tokens; there
//              is no account service and no email flow.
//   public     the documentation and demo site. No credentials at all.
//
// The private gateway stamps the HTML shell so a misplaced artifact cannot replace
// account login with engine credentials. That stamp is the only authority; the build
// flags are a fallback for local work.
const declared = document.querySelector<HTMLMetaElement>(
  'meta[name="chronodb-edition"]',
)?.content;
const declaredEdition = ["managed", "community", "public"].includes(declared || "")
  ? (declared as "managed" | "community" | "public")
  : null;
const compiledEdition: "managed" | "community" | "public" =
  import.meta.env.VITE_PUBLIC_SITE === "true"
    ? "public"
    : import.meta.env.VITE_MANAGED_SITE === "true"
      ? "managed"
      : "community";
// A hosted origin must never serve the token console. If a Community artifact is
// deployed here, or the gateway stamp is missing, the hosted edition still wins: the
// worst case is a sign-in page that finds no account service, which is recoverable,
// against an engine-token prompt on the public internet, which is not.
export const hostedOrigin = /(^|\.)chronodb\.co$/.test(
  globalThis.location?.hostname ?? "",
);
export const editionMismatch =
  hostedOrigin && (declaredEdition ?? compiledEdition) !== "managed";
export const edition = hostedOrigin
  ? "managed"
  : (declaredEdition ?? compiledEdition);
export const publicSite = edition === "public";
export const managedSite = edition === "managed";
export const communitySite = edition === "community";
export const publicPath = (path: string) =>
  `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
