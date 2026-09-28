import { catalogFixtures, extended } from "./extended.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { createServer as createTLS } from "node:https";
import { tmpdir } from "node:os";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { startServer, client, root } from "../test-support.mjs";

const tools = process.env.SDK_TOOLS || join(root, ".work/sdk-tools");
const exe = process.platform === "win32" ? ".exe" : "";
const reportName = process.env.SDK_REPORT_NAME;
if (reportName && /[^a-z0-9-]/.test(reportName))
  throw new Error("Invalid SDK report name");
const commands = {
  python: [process.env.SDK_PYTHON || "python3", ["scripts/sdk/python.py"]],
  typescript: ["node", ["scripts/sdk/typescript.mjs"]],
  go: [join(tools, "go-conformance" + exe), []],
  java: [
    "java",
    [
      "-cp",
      `${tools}/java-classes${process.platform === "win32" ? ";" : ":"}${process.env.GSON_JAR || tools + "/gson.jar"}`,
      "Conformance",
    ],
  ],
  cpp: [join(tools, "cpp-conformance" + exe), []],
  dart: [join(tools, "dart-conformance" + exe), []],
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
const testPort = Number(process.env.SDK_TEST_PORT || 18092);
assert(Number.isInteger(testPort) && testPort >= 1024 && testPort <= 65533);
const faultURL = `http://127.0.0.1:${testPort + 1}`,
  tlsURL = `https://127.0.0.1:${testPort + 2}`;
let fixture;
if (process.env.SDK_FIXTURE_CONFIG) {
  fixture = JSON.parse(await readFile(process.env.SDK_FIXTURE_CONFIG, "utf8"));
  const url = new URL(fixture.url);
  assert(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Conformance only writes to disposable loopback fixtures",
  );
}
const server = fixture
  ? {
      url: fixture.url,
      adminToken: (await readFile(fixture.tokenFile, "utf8")).trim(),
      stop: async () => {},
    }
  : await startServer({ port: testPort });
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
const faults = createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
  if (req.url === "/v1/null") {
    res.end("null");
    return;
  }
  if (req.url === "/v1/array") {
    res.end("[]");
    return;
  }
  if (req.url === "/v1/trailing") {
    res.end("{} {}");
    return;
  }
  if (req.url === "/v1/nonfinite") {
    res.end('{"v":NaN}');
    return;
  }
  if (req.url === "/v1/utf") {
    res.end(Buffer.from([123, 34, 118, 34, 58, 34, 255, 34, 125]));
    return;
  }
  if (req.url === "/v1/asset_put") {
    res.end('{"asset":123}');
    return;
  }
  if (req.url === "/v1/asset_get") {
    const mode = body.asset,
      offset = body.offset;
    const r = {
      asset: mode,
      bytes: 2,
      offset,
      data_hex: "00",
      metadata: { version: 1, kind: "opaque" },
      next_offset: offset + 1,
    };
    if (mode === "reorder") {
      if (offset === 1) {
        r.metadata = { kind: "opaque", version: 1 };
        r.next_offset = null;
      }
    } else if (mode === "badhex") r.data_hex = "xz";
    else if (mode === "missing") delete r.next_offset;
    else if (mode === "truncated") r.next_offset = null;
    else if (mode === "changed") {
      if (offset === 1) {
        r.metadata.kind = "tensor";
        r.next_offset = null;
      }
    } else if (mode === "jump") r.next_offset = 7;
    else if (mode === "badsize") r.bytes = "2";
    else if (mode === "badmetadata") r.metadata = [];
    res.end(JSON.stringify(r));
    return;
  }
  if (req.url === "/v1/bci_records") {
    let r = {
      records: [],
      has_more: true,
      cursor: body.after === "A" ? "B" : "A",
    };
    if (body.session === "filtered" && body.after)
      r = { records: [{ edge: "B" }], has_more: false, cursor: "B" };
    if (body.session === "missing") delete r.cursor;
    if (body.session === "badflag") r.has_more = 1;
    if (body.session === "badrows") r.records = {};
    res.end(JSON.stringify(r));
    return;
  }
  if (req.url === "/v1/redirect") {
    res.writeHead(302, { Location: faultURL + "/v1/leak" });
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
faults.listen(testPort + 1, "127.0.0.1");
await once(faults, "listening");
const tlsRoot = await mkdtemp(join(tmpdir(), "chronograph-sdk-tls-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(tlsRoot, "key.pem"),
    "-out",
    join(tlsRoot, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
let tlsAuthenticated = 0;
const tls = createTLS(
  {
    key: await readFile(join(tlsRoot, "key.pem")),
    cert: await readFile(join(tlsRoot, "cert.pem")),
  },
  (req, res) => {
    tlsAuthenticated++;
    req.resume();
    res.end("{}");
  },
);
tls.listen(testPort + 2, "127.0.0.1");
await once(tls, "listening");
const results = [];
const fixtures = await catalogFixtures(admin);
function driver(language) {
  const [cmd, args] = commands[language];
  const child = spawn(cmd, args, {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: join(
        process.env.SDK_SOURCE_ROOT || join(root, "sdk"),
        "python",
      ),
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      PYTHONIOENCODING: "utf-8",
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
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(Error(`${language}: driver exited: ${errors}`));
      waiting = null;
    }
  });
  return {
    ask: async (q) => {
      if (fixture && fixture.kind !== "community")
        await new Promise((r) => setTimeout(r, 90));
      return new Promise((resolve, reject) => {
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
      });
    },
    close: async (verifyExit = true) => {
      child.stdin.end();
      if (child.exitCode === null) {
        const done = once(child, "exit");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        await done;
        clearTimeout(timer);
      }
      lines.close();
      if (verifyExit)
        assert.equal(
          child.exitCode,
          0,
          `${language}: driver failed on shutdown: ${errors}`,
        );
    },
  };
}
try {
  let kind = 4000;
  for (const language of languages) {
    const d = driver(language),
      checks = [];
    let completed = false;
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
        fixture && fixture.kind !== "community" ? "managed" : "community",
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
        { op: "stats\n" },
        { path: "/v1/stats\n", method: "GET" },
        { path: "/v1/../../escape", method: "GET" },
        { construct: true, token: "bad\r\nheader" },
        { op: "stats", body: { data: "x".repeat(4 * 1024 * 1024) } },
      ])
        assert.equal((await d.ask(q)).local, true);
      checks.push("origin, header, path and request size rejection");
      const fault = {
        url: faultURL,
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
      for (const op of ["null", "array", "trailing", "nonfinite", "utf"])
        assert.equal(
          (await d.ask({ ...fault, op })).code,
          "INVALID_JSON",
          `${language} ${op}`,
        );
      assert.equal(
        (
          await d.ask({
            ...fault,
            helper: "upload",
            body: {
              metadata: { version: 1, kind: "opaque", encoding: "fixture" },
              data_hex: "00",
            },
          })
        ).local,
        true,
        `${language} invalid upload receipt`,
      );
      for (const mode of [
        "badhex",
        "missing",
        "truncated",
        "changed",
        "jump",
        "badsize",
        "badmetadata",
      ])
        assert.equal(
          (await d.ask({ ...fault, helper: "read", body: { asset: mode } }))
            .local,
          true,
          `${language} asset ${mode}`,
        );
      assert.equal(
        (await d.ask({ ...fault, helper: "read", body: { asset: "reorder" } }))
          .ok,
        true,
        `${language} equivalent reordered metadata`,
      );
      for (const session of ["cycle", "missing", "badflag", "badrows"])
        assert.equal(
          (
            await d.ask({
              ...fault,
              helper: "pages",
              op: "bci_records",
              body: { session },
              max_pages: 5,
            })
          ).local,
          true,
          `${language} pagination ${session}`,
        );
      const filtered = await d.ask({
        ...fault,
        helper: "pages",
        op: "bci_records",
        body: { session: "filtered" },
        max_pages: 5,
      });
      assert.equal(filtered.ok, true);
      assert.equal(filtered.value.length, 2);
      checks.push(
        "malformed UTF-8/JSON, incomplete assets, metadata consistency, cyclic/malformed cursors and filtered pages",
      );
      const t = performance.now();
      assert.equal(
        (await d.ask({ ...fault, op: "slow", timeout: 100 })).local,
        true,
      );
      assert(performance.now() - t < 2000);
      assert.equal(
        (
          await d.ask({
            url: tlsURL,
            token: "fixture-only",
            op: "stats",
          })
        ).local,
        true,
        `${language} must reject untrusted TLS`,
      );
      assert.equal(tlsAuthenticated, 0);
      checks.push(
        "untrusted TLS certificate rejected before authenticated HTTP",
      );
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
      checks.push(
        ...(await extended(
          good,
          d,
          language,
          fixtures,
          readToken,
          ingestToken,
          6000 + languages.indexOf(language) * 2,
        )),
      );
      assert.equal(await good("", {}, { helper: "parallel" }), 12);
      checks.push("12 simultaneous reads on a shared client");
      results.push({
        language,
        checks,
        duration_ms: Math.round(performance.now() - started),
      });
      console.log(`PASS ${language}: ${checks.length} conformance groups`);
      completed = true;
    } finally {
      // Cleanup must not replace the original request/assertion failure.
      await d.close(completed);
    }
  }
} finally {
  faults.closeAllConnections();
  await new Promise((resolve) => faults.close(resolve));
  tls.closeAllConnections();
  await new Promise((resolve) => tls.close(resolve));
  await rm(tlsRoot, { recursive: true, force: true });
  await server.stop();
}
await mkdir(join(root, ".work/sdk-evidence"), { recursive: true });
await writeFile(
  join(
    root,
    reportName
      ? `.work/sdk-evidence/${reportName}.json`
      : fixture
        ? ".work/sdk-evidence/managed-conformance.json"
        : process.env.SDK_SOURCE_ROOT
          ? ".work/sdk-evidence/kit-conformance.json"
          : ".work/sdk-evidence/conformance.json",
  ),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      transport:
        fixture && fixture.kind !== "community"
          ? "real Managed gateway and isolated project engines plus controlled HTTP faults"
          : "real Rust Community server plus controlled HTTP faults",
      results,
    },
    null,
    2,
  ) + "\n",
);
