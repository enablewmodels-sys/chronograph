// The Managed gateway stamps the HTML shell so a misplaced Community artifact
// cannot replace account login with engine credentials. This selects UI only;
// every request is still authenticated and authorized by the server.
const declaredEdition = document.querySelector<HTMLMetaElement>(
  'meta[name="chronodb-edition"]',
)?.content;
const edition = ["managed", "community", "public"].includes(
  declaredEdition || "",
)
  ? declaredEdition
  : import.meta.env.VITE_PUBLIC_SITE === "true"
    ? "public"
    : import.meta.env.VITE_MANAGED_SITE === "true"
      ? "managed"
      : "community";
export const publicSite = edition === "public";
export const managedSite = edition === "managed";
export const publicPath = (path: string) =>
  `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
