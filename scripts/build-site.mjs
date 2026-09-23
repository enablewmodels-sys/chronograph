// Public Community website: no Rust build, private state or live API endpoint.
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist/site");
const base = process.env.CHRONOGRAPH_SITE_BASE || "/";
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))
  throw new Error("CHRONOGRAPH_SITE_BASE must be / or a slash-delimited path.");
execFileSync(
  "npm",
  [
    "--prefix",
    "ui",
    "run",
    "build",
    "--",
    "--outDir",
    "../dist/site",
    "--emptyOutDir",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      CHRONOGRAPH_SITE_BASE: base,
      VITE_PUBLIC_SITE: "true",
    },
    stdio: "inherit",
  },
);
const summary = await readFile(path.join(root, "docs/SUMMARY.md"), "utf8");
const chapters = [...summary.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
for (const chapter of chapters) {
  if (!/^(?:connectors\/)?[a-zA-Z0-9_-]+\.md$/.test(chapter))
    throw new Error("Unexpected documentation path");
  const destination = path.join(output, "docs", chapter);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, "docs", chapter), destination);
}
for (const filename of await readdir(path.join(root, "docs"))) {
  if (/^[a-zA-Z0-9_-]+\.svg$/.test(filename))
    await cp(
      path.join(root, "docs", filename),
      path.join(output, "docs", filename),
    );
}
for (const filename of ["LICENSE", "NOTICE"])
  await cp(path.join(root, filename), path.join(output, filename));
const entry = await readFile(path.join(output, "index.html"));
const routes = [
  "login",
  "privacy",
  "terms",
  "data-protection",
  "security",
  "subprocessors",
  "cookies",
  "acceptable-use",
  "legal",
  "support",
  "status",
  "documentation",
  "app",
  ...[
    "explorer",
    "branches",
    "schema",
    "connectors",
    "write",
    "access",
    "operations",
  ].map((route) => `app/${route}`),
  ...chapters.map((chapter) => `documentation/${chapter.slice(0, -3)}`),
];
for (const route of routes) {
  await mkdir(path.join(output, route), { recursive: true });
  await writeFile(path.join(output, route, "index.html"), entry);
}
await writeFile(path.join(output, ".nojekyll"), "");
console.log(
  `Public Community site: ${chapters.length} chapters, ${routes.length} direct routes, base ${base}`,
);
