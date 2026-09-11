// The public website serves a synthetic preview; real workspaces use the native UI.
export const publicSite = import.meta.env.VITE_PUBLIC_SITE === "true";
export const publicPath = (path: string) =>
  `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
