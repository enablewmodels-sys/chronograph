#!/usr/bin/env node
// Compatibility launcher. The native binary owns all MCP protocol handling.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const binary =
  process.env.CHRONOGRAPH_MCP_BINARY ||
  fileURLToPath(new URL("../target/release/chronograph-mcp", import.meta.url));
const child = spawn(binary, [], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...(!process.env.CHRONOGRAPH_MCP_URL && process.env.CHRONOGRAPH_URL
      ? { CHRONOGRAPH_MCP_URL: process.env.CHRONOGRAPH_URL }
      : {}),
  },
});
child.on("error", () => {
  console.error(
    "Native chronograph-mcp could not start; build the service or set CHRONOGRAPH_MCP_BINARY.",
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
