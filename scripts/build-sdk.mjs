// Compile the TypeScript SDK from source.
//
// The console imports the SDK's compiled entry point, and that output is gitignored, so
// a clean checkout has nothing to import: a fresh clone or a CI job failed at tsc with
// "cannot find module" until this ran. Every UI build calls it first, which makes the
// dependency explicit instead of relying on whatever dist happened to be lying around.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("../sdk/typescript/", import.meta.url));
execFileSync(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], {
  cwd: sdk,
  stdio: "inherit",
  env: process.env,
});
