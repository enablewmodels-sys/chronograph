import { startServer, root, report } from "./test-support.mjs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const server = await startServer({ port: 18090 });
try {
  for (const [runtime, mode] of [
    ["connector-v04-python", "quantum-eeg"],
    ["connector-python", "world-robot"],
  ]) {
    const child = spawn(
      join(root, ".work", runtime, "bin/python"),
      [
        "scripts/connectors/test-platform-sdk.py",
        server.url,
        server.tokenFile,
        mode,
      ],
      {
        cwd: root,
        env: { ...process.env, PYTHONPATH: join(root, "sdk/python") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (s) => {
      output += s;
    });
    child.stderr.on("data", (s) => {
      errors += s;
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code !== 0) throw Error(`${mode}: ${output}\n${errors}`);
    console.log(output);
    await report(`sdk-${mode}.txt`, output);
  }
} finally {
  await server.stop();
}
