// Contract fixtures only: no model weights, inference quality claim or external API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { startServer, client, root } from "./test-support.mjs";
const request = JSON.parse(
  await readFile(new URL("../examples/laya/request.json", import.meta.url)),
);
const response = JSON.parse(
  await readFile(
    new URL("../examples/laya/response.fixture.json", import.meta.url),
  ),
);
let calls = 0,
  reject = false;
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/systemone");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Bearer contract-fixture-key");
    let body = "";
    for await (const c of req) body += c;
    assert.deepEqual(JSON.parse(body), request);
    calls++;
    res.writeHead(reject ? 302 : 200, {
      "Content-Type": "application/json",
      Location: "http://127.0.0.1:1/no-redirect",
    });
    res.end(JSON.stringify(response));
  } catch {
    res.writeHead(400);
    res.end("{}");
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
let server = await startServer({ port: 18089 });
async function run(language, args, expected = 0) {
  const cmd =
    language === "python"
      ? process.env.SDK_PYTHON || "python3"
      : process.execPath;
  const file = `examples/laya/${language === "python" ? "python_example.py" : "typescript_example.mjs"}`;
  const child = spawn(cmd, [file, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: root + "/sdk/python",
      CHRONOGRAPH_URL: server.url,
      CHRONOGRAPH_TOKEN_FILE: server.tokenFile,
      LAYA_URL: `http://127.0.0.1:${provider.address().port}`,
      LAYA_API_KEY: "contract-fixture-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 40000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (expected === 0) {
      assert.equal(code, 0, err.slice(0, 1500));
      return JSON.parse(out);
    }
    assert.notEqual(code, 0);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const first = await run("python", ["--write", "--init", "--attach-inputs"]);
  assert.equal(first.stored.binding.connector, "laya");
  assert.equal(first.stored.record.fields.provider, "convai");
  for (const language of ["python", "typescript"]) {
    const r = await run(language, ["--live", "--write", "--attach-inputs"]);
    assert.deepEqual(r.stored.record.fields.answers, response.answers);
    assert.deepEqual(r.stored.record.fields.routing, response.routing);
    assert.equal(r.stored.record.fields.checkpoint, "convaiinnovations/laya");
    assert.equal(r.receipt.receipt.durability, "fsync");
    const attachment = await client(server).json("/v1/asset_get", {
      asset: r.stored.record.assets.response,
      content: true,
    });
    assert.deepEqual(
      JSON.parse(Buffer.from(attachment.data_hex, "hex").toString()),
      response,
    );
  }
  assert.equal(calls, 2);
  reject = true;
  await run("python", ["--live"], 1);
  await run("typescript", ["--live"], 1);
  assert.equal(calls, 4);
  await server.stop("SIGKILL");
  server = await startServer({
    port: 18089,
    data: server.data,
    config: server.config,
    tokenFile: server.tokenFile,
  });
  const stored = await client(server).json("/v1/connector_record", {
    edge: first.receipt.receipt.first_edge,
  });
  assert.deepEqual(stored, first.stored);
  console.log(
    "PASS Laya Python/TypeScript: fixture and HTTP producer, migration, exact IDs, typed metadata, attachments, fsync, redirects rejected, restart persistence (no model inference).",
  );
} finally {
  await server.stop();
  await new Promise((resolve) => provider.close(resolve));
}
