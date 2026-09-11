import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startServer, root } from "./test-support.mjs";
const server = await startServer({ port: 18083 });
await mkdir(join(root, ".work"), { recursive: true });
await writeFile(
  join(root, ".work/e2e-config.json"),
  JSON.stringify({ token: server.adminToken, url: server.url }),
  { mode: 0o600 },
);
const close = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
console.log("Isolated browser test server ready on http://127.0.0.1:18083.");
