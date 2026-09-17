import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { startServer, client, root } from "../test-support.mjs";

const tools = process.env.SDK_TOOLS || join(root, ".work/sdk-tools");
const commands = {
  python: [process.env.SDK_PYTHON || "python3", ["scripts/sdk/python.py"]],
  typescript: ["node", ["scripts/sdk/typescript.mjs"]],
  go: [join(tools, "go-conformance"), []],
  java: [
    "java",
    [
      "-cp",
      `${tools}/java-classes${process.platform === "win32" ? ";" : ":"}${process.env.GSON_JAR || tools + "/gson.jar"}`,
      "Conformance",
    ],
  ],
  cpp: [join(tools, "cpp-conformance"), []],
  dart: [join(tools, "dart-conformance"), []],
  csharp: [
    process.env.DOTNET || "dotnet",
    [join(tools, "csharp-conformance/Conformance.dll")],
  ],
};
const languages = (
  process.env.SDK_LANGUAGES || Object.keys(commands).join(",")
).split(",");
for (const language of languages)
  assert(commands[language], `Unknown SDK ${language}`);
const server = await startServer({ port: 18092 });
const admin = client(server);
const readToken = (
  await admin.json("/v1/tokens", { name: "SDK reader", scope: "read", days: 1 })
).token;
const ingestToken = (
  await admin.json("/v1/tokens", {
    name: "SDK producer",
    scope: "ingest",
    days: 1,
  })
).token;
let redirected = 0;
const faults = createServer((req, res) => {
  req.resume();
  if (req.url === "/v1/redirect") {
    res.writeHead(302, { Location: "http://127.0.0.1:18093/v1/leak" });
    res.end();
  } else if (req.url === "/v1/leak") {
    redirected++;
    res.end("{}");
  } else if (req.url === "/v1/large") res.end("x".repeat(2048));
  else if (req.url === "/v1/slow") {
    const timer = setTimeout(() => res.end("{}"), 600);
    res.on("close", () => clearTimeout(timer));
  } else if (req.url === "/v1/invalid") res.end("not JSON");
  else if (req.url === "/v1/rate") {
    res.writeHead(429, { "Retry-After": "60" });
    res.end(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: "Please retry later" },
      }),
    );
  } else {
    res.writeHead(502);
    res.end("gateway is not JSON");
  }
});
faults.listen(18093, "127.0.0.1");
await once(faults, "listening");
const results = [];
function driver(language) {
  const [cmd, args] = commands[language];
  const child = spawn(cmd, args, {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: join(root, "sdk/python"),
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let waiting,
    errors = "";
  child.stderr.on("data", (data) => (errors += data.toString().slice(0, 2000)));
  lines.on("line", (line) => {
    if (!waiting) return;
    const { resolve, reject, timer } = waiting;
    waiting = null;
    clearTimeout(timer);
    try {
      resolve(JSON.parse(line));
    } catch {
      reject(Error(`${language}: invalid driver response`));
    }
  });
  child.on("error", (error) => {
    if (waiting) waiting.reject(error);
  });
  child.on("exit", () => {
    if (waiting) waiting.reject(Error(`${language}: driver exited: ${errors}`));
  });
  return {
    ask: (q) =>
      new Promise((resolve, reject) => {
        waiting = {
          resolve,
          reject,
          timer: setTimeout(() => {
            child.kill("SIGKILL");
            reject(Error(`${language}: driver deadline exceeded`));
          }, 45000),
        };
        child.stdin.write(
          JSON.stringify({ url: server.url, token: server.adminToken, ...q }) +
            "\n",
        );
      }),
    close: async () => {
      child.stdin.end();
      if (child.exitCode === null) {
        const done = once(child, "exit");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        await done;
        clearTimeout(timer);
      }
      lines.close();
    },
  };
}
try {
  let kind = 4000;
  for (const language of languages) {
    const d = driver(language),
      checks = [];
    const started = performance.now();
    const good = async (op, body = {}, override = {}) => {
      const r = await d.ask({ op, body, ...override });
      assert.equal(r.ok, true, `${language} ${op}: ${JSON.stringify(r)}`);
      return r.value;
    };
    try {
      const info = await d.ask({ path: "/v1/info", method: "GET" });
      assert.equal(info.ok, true);
      assert.equal(
        JSON.parse(Buffer.from(info.value, "hex").toString()).edition,
        "community",
      );
      checks.push("authenticated GET");
      const id = `sdk_${language}`;
      const template = await good("connector_template", {
        id,
        connector: "custom",
        preset: "record-v1",
        contract_version: 1,
        kind: kind++,
        clock_domain: "unix_us",
      });
      const preview = await good("schema_preview", { source: template.source });
      await good("schema_apply", {
        source: template.source,
        checksum: preview.checksum,
        expected_revision: preview.expected_revision,
      });
      checks.push("migration template, preview and apply");
      const metadata = {
        version: 1,
        kind: "tensor",
        encoding: "raw_le",
        dtype: "u8",
        shape: [4],
        provenance: { producer: language },
      };
      const asset = (
        await good(
          "asset_put",
          { metadata, data_hex: "00ff0080" },
          { token: ingestToken },
        )
      ).asset;
      const bytes = await good(
        "asset_get",
        { asset, content: true },
        { token: readToken },
      );
      assert.equal(bytes.data_hex, "00ff0080");
      assert.deepEqual(bytes.metadata, metadata);
      checks.push("binary tensor upload and exact roundtrip");
      const batch = {
        instance: id,
        partition: "stream",
        sequence: "0",
        records: [
          {
            src: "9007199254740993",
            dst: "18446744073709551614",
            timestamp_us: "9007199254740993",
            assets: { signal: asset },
            fields: {
              runtime: language,
              text: "神経 λ 🤖",
              counter: "18446744073709551615",
            },
          },
        ],
      };
      const receipt = (
        await good("connector_ingest", batch, { token: ingestToken })
      ).receipt;
      assert.equal(receipt.durability, "fsync");
      assert.deepEqual(
        (await good("connector_ingest", batch, { token: ingestToken })).receipt,
        receipt,
      );
      const checkpoint = await good("connector_checkpoint", {
        instance: id,
        partition: "stream",
      });
      assert.deepEqual(checkpoint.checkpoint, receipt);
      const stored = await good("connector_record", {
        edge: receipt.first_edge,
      });
      assert.equal(stored.record.src, batch.records[0].src);
      assert.equal(stored.record.dst, batch.records[0].dst);
      assert.equal(stored.record.timestamp_us, batch.records[0].timestamp_us);
      assert.deepEqual(stored.record.fields, batch.records[0].fields);
      checks.push(
        "u64/i64 precision, Unicode, durable ingest, retry and checkpoint",
      );
      const conflict = structuredClone(batch);
      conflict.records[0].fields.runtime = "changed";
      assert.equal(
        (await d.ask({ op: "connector_ingest", body: conflict })).status,
        409,
      );
      assert.equal(
        (await d.ask({ op: "connector_ingest", body: batch, token: readToken }))
          .status,
        403,
      );
      assert.equal(
        (await d.ask({ op: "stats", token: "invalid-fixture-token" })).status,
        401,
      );
      const invalid = await d.ask({
        op: "asset_put",
        body: { metadata: { ...metadata, shape: [10] }, data_hex: "00" },
      });
      assert.equal(invalid.status, 400);
      assert(invalid.code);
      checks.push(
        "conflict, read-only, invalid credentials and validation errors",
      );
      const exported = await d.ask({
        path: "/v1/export_arrow",
        method: "POST",
        body: { t: "9007199254740993" },
      });
      assert.equal(exported.ok, true, JSON.stringify(exported));
      assert(exported.value.length > 64);
      checks.push("binary Arrow export");
      for (const url of [
        "http://example.com",
        "https://example.com/path",
        "https://user:password@example.com",
        "https://example.com/?token=x",
      ])
        assert.equal((await d.ask({ construct: true, url })).local, true);
      for (const q of [
        { op: "../tokens" },
        { path: "/v1/../../escape", method: "GET" },
        { construct: true, token: "bad\r\nheader" },
        { op: "stats", body: { data: "x".repeat(4 * 1024 * 1024) } },
      ])
        assert.equal((await d.ask(q)).local, true);
      checks.push("origin, header, path and request size rejection");
      const fault = {
        url: "http://127.0.0.1:18093",
        token: "synthetic-test-token",
      };
      assert.equal((await d.ask({ ...fault, op: "redirect" })).status, 302);
      assert.equal(redirected, 0);
      assert.equal(
        (await d.ask({ ...fault, op: "large", limit: 1024 })).code,
        "RESPONSE_LIMIT",
      );
      assert.equal(
        (await d.ask({ ...fault, op: "invalid" })).code,
        "INVALID_JSON",
      );
      assert.equal((await d.ask({ ...fault, op: "gateway" })).status, 502);
      const rate = await d.ask({ ...fault, op: "rate" });
      assert.equal(rate.status, 429);
      assert.equal(rate.code, "RATE_LIMITED");
      assert.equal(rate.retry, "60");
      const t = performance.now();
      assert.equal(
        (await d.ask({ ...fault, op: "slow", timeout: 100 })).local,
        true,
      );
      assert(performance.now() - t < 2000);
      checks.push(
        "redirect isolation, response limit, malformed JSON, proxy errors, Retry-After and timeout",
      );
      if (["python", "typescript"].includes(language)) {
        const r = await d.ask({ asset_roundtrip: true });
        assert.deepEqual(r, {
          ok: true,
          value: { bytes: 1048607, encoding: "sdk_fixture" },
        });
        checks.push("multi-chunk asset helper roundtrip");
      }
      results.push({
        language,
        checks,
        duration_ms: Math.round(performance.now() - started),
      });
      console.log(`PASS ${language}: ${checks.length} conformance groups`);
    } finally {
      await d.close();
    }
  }
} finally {
  faults.closeAllConnections();
  await new Promise((resolve) => faults.close(resolve));
  await server.stop();
}
await mkdir(join(root, ".work/sdk-evidence"), { recursive: true });
await writeFile(
  join(root, ".work/sdk-evidence/conformance.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      transport: "real Rust Community server plus controlled HTTP faults",
      results,
    },
    null,
    2,
  ) + "\n",
);
