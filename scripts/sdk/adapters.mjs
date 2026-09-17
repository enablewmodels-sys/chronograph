import { startServer, root } from "../test-support.mjs";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const server = await startServer({ port: 18094 });
try {
  const child = spawn(
    process.env.SDK_PYTHON || "python3",
    ["scripts/sdk/test-adapters.py", server.url, server.tokenFile],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: join(root, "sdk/python"),
        LSLAPICFG: join(root, "examples/datasets/bci/lsl-loopback.cfg"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (d) => {
    output += d;
    process.stdout.write(d);
  });
  child.stderr.on("data", (d) => {
    errors += d;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) throw Error(`Adapter runtime fixtures failed:\n${errors}`);
  await mkdir(join(root, ".work/sdk-evidence"), { recursive: true });
  await writeFile(join(root, ".work/sdk-evidence/adapters.txt"), output);
} finally {
  await server.stop();
}
