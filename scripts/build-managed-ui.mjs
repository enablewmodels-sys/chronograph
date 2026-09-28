// Keep deployable Managed assets separate from Community/SDK test builds.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyUiBuild } from "./verify-ui-build.mjs";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));
const env = {
  ...process.env,
  VITE_MANAGED_SITE: "true",
  VITE_PUBLIC_SITE: "false",
  CHRONOGRAPH_SITE_BASE: "/",
};
for (const [entry, args] of [
  ["./node_modules/typescript/bin/tsc", ["-b"]],
  ["./node_modules/vite/bin/vite.js", ["build", "--outDir", "dist-managed"]],
])
  execFileSync(process.execPath, [entry, ...args], {
    cwd: ui,
    env,
    stdio: "inherit",
  });
await verifyUiBuild(new URL("../ui/dist-managed/", import.meta.url), "managed");
