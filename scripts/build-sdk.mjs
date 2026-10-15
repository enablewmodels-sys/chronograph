// Compile the TypeScript SDK from source.
//
// The console imports the SDK's compiled entry point (ui/src/browser-decoder.ts imports
// sdk/typescript/dist/decoder.js) and that output is gitignored, so a clean checkout has nothing
// to import: a fresh clone or a CI job failed at tsc with "cannot find module" until this ran.
// Every UI build calls it first, which makes the dependency explicit instead of relying on
// whatever dist happened to be lying around.
//
// The compiler is looked for in the SDK's own node_modules first and in the console's second.
// A checkout that has run only `npm --prefix ui ci` has no sdk/typescript/node_modules, and that
// is exactly what the CI jobs that build the console do, so without the second candidate every
// one of them stopped here before it built anything.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("../sdk/typescript/", import.meta.url));
const ui = fileURLToPath(new URL("../ui/", import.meta.url));
const compiler = [
  sdk + "node_modules/typescript/bin/tsc",
  ui + "node_modules/typescript/bin/tsc",
].find((candidate) => existsSync(candidate));

if (!compiler) {
  console.error(
    "Cannot compile the TypeScript SDK: no TypeScript compiler found.\n" +
      "Install one first:\n" +
      "  npm --prefix sdk/typescript ci\n" +
      "  npm --prefix ui ci",
  );
  process.exit(1);
}

execFileSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
  cwd: sdk,
  stdio: "inherit",
  env: process.env,
});
