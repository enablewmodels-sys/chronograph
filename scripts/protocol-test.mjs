#!/usr/bin/env node
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { readFile, writeFile, stat, mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { StdioClientTransport } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import {
  startServer,
  client,
  report,
  root,
  serverBinary,
} from "./test-support.mjs";
const began = performance.now(),
  checks = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let server = await startServer(),
  mcp,
  stdio,
  readMcp;
try {
  const admin = client(server);
  assert.equal((await fetch(server.url + "/v1/info")).status, 401);
  const info = await admin.json("/v1/info");
  assert.equal(info.edition, "community");
  assert.equal(info.credential.scope, "admin");
  assert.equal(info.limits.queue, 32);
  assert.equal((await stat(server.tokenFile)).mode & 0o077, 0);
  assert.equal((await stat(server.config)).mode & 0o077, 0);
  const stored = await readFile(server.config, "utf8");
  assert.ok(stored.includes("$argon2id$"));
  assert.ok(!stored.includes(server.adminToken));
  pass(
    "token bootstrap, private permissions and hash-only external credential store",
  );
  const read = await admin.json("/v1/tokens", {
    name: "reader",
    scope: "read",
    days: 1,
  });
  const ingest = await admin.json("/v1/tokens", {
    name: "ingest",
    scope: "ingest",
    days: 1,
  });
  const reader = client(server, read.token),
    writer = client(server, ingest.token);
  const edges = [
    { src: "18446744073709551615", dst: "2", kind: 1, valid_from: "0" },
    { src: "18446744073709551615", dst: "2", kind: 1, valid_from: "3000000" },
    { src: "3", dst: "4", kind: 2, valid_from: "0" },
  ];
  assert.equal((await reader.request("/v1/edges", { edges })).status, 403);
  assert.equal((await writer.request("/v1/backup", {})).status, 403);
  assert.equal((await writer.request("/v1/tokens")).status, 403);
  const inserted = await writer.json("/v1/edges", {
    edges,
    durability: "fsync",
  });
  assert.equal(inserted.durability, "fsync");
  assert.deepEqual(inserted.ids, ["0", "1", "2"]);
  const late = await writer.json("/v1/edges", {
    edges: [{ ...edges[0], valid_from: "2000000", payload: "07".repeat(16) }],
  });
  assert.equal(late.durability, "buffered");
  assert.equal((await writer.json("/v1/sync", {})).durability, "fsync");
  const before = await reader.json("/v1/stats");
  assert.equal(before.edge_versions, "4");
  assert.equal(
    (
      await writer.request("/v1/edges", {
        edges: [edges[0], { ...edges[0], valid_from: "9223372036854775807" }],
      })
    ).status,
    400,
  );
  assert.equal((await reader.json("/v1/stats")).revision, before.revision);
  pass(
    "scope enforcement, exact u64 IDs, explicit durability and atomic validation",
  );
  const q = { t: "2500000", limit: 1 };
  const page = await reader.json("/v1/as_of", q);
  assert.equal(typeof page.next_cursor, "string");
  const second = await reader.json("/v1/as_of", {
    ...q,
    cursor: page.next_cursor,
  });
  assert.equal(second.edges[0].src, "18446744073709551615");
  assert.equal(second.edges[0].valid_to, "3000000");
  assert.equal(second.next_cursor, null);
  await writer.json("/v1/nodes", { id: "99", durability: "fsync" });
  assert.equal(
    (await reader.request("/v1/as_of", { ...q, cursor: page.next_cursor }))
      .status,
    409,
  );
  const sample = await reader.json("/v1/sample", {
    nodes: ["18446744073709551615", "3"],
    t: "2500000",
    k: 1,
    strategy: "uniform",
    seed: "18446744073709551615",
  });
  assert.equal(sample.samples.length, 2);
  assert.equal(sample.samples[0].edges[0].id, "3");
  assert.equal(
    (await reader.json("/v1/between", { start: "0", end: "3000000" })).count,
    3,
  );
  const arrow = await reader.request("/v1/export_arrow", { t: "2500000" });
  assert.equal(
    arrow.headers.get("content-type"),
    "application/vnd.apache.arrow.stream",
  );
  assert.ok((await arrow.arrayBuffer()).byteLength > 128);
  pass(
    "temporal semantics, revision-bound pagination, batch sampling and Arrow stream",
  );
  const boundary = await reader.request("/v1/stats", {}, "POST", {
    Origin: "https://attacker.invalid",
  });
  assert.equal(boundary.status, 403);
  assert.ok(boundary.headers.get("content-security-policy"));
  assert.equal(
    (await admin.request("/api/login", { password: "retired" })).status,
    404,
  );
  assert.equal((await admin.request("/v1/unknown/deep", {})).status, 404);
  // Expect/Continue observes the server's early 413 before sending the oversized
  // body; a regular fetch can see TCP reset while still uploading rejected data.
  const tooBig = await new Promise((resolve, reject) => {
    const size = 4 * 1024 * 1024 + 1;
    const req = httpRequest(
      server.url + "/v1/edges",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server.adminToken}`,
          "Content-Type": "application/json",
          "Content-Length": size,
          Expect: "100-continue",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    req.on("continue", () => req.end("x".repeat(size)));
    req.on("error", reject);
    req.setTimeout(5000, () =>
      req.destroy(new Error("Oversize response timeout")),
    );
    req.flushHeaders();
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error.code, "PAYLOAD_TOO_LARGE");
  pass("origin boundary, retired cookies, JSON errors and body limit");
  const connect = async (token, name) => {
    const c = new Client({ name, version: "0.3.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url + "/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return c;
  };
  mcp = await connect(ingest.token, "chronograph-protocol");
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  for (const name of [
    "ingest_edges",
    "as_of",
    "between",
    "sample_neighbors",
    "backup",
  ])
    assert.ok(tools.includes(name));
  const result = await mcp.callTool({
    name: "as_of",
    arguments: { t: "2500000", limit: 100 },
  });
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.count, 2);
  readMcp = await connect(read.token, "chronograph-read-only");
  assert.equal(
    (
      await readMcp.callTool({
        name: "ingest_edges",
        arguments: { edges: [edges[0]] },
      })
    ).isError,
    true,
  );
  assert.equal(
    (await mcp.callTool({ name: "backup", arguments: {} })).isError,
    true,
  );
  const machineToken = join(
    await mkdtemp(join(tmpdir(), "chronograph-stdio-")),
    "ingest.token",
  );
  await writeFile(machineToken, ingest.token, { mode: 0o600 });
  stdio = new Client({
    name: "chronograph-native-stdio-test",
    version: "0.3.0",
  });
  await stdio.connect(
    new StdioClientTransport({
      command: join(
        root,
        process.env.CHRONOGRAPH_TEST_PROFILE || "target/release",
        "chronograph-mcp",
      ),
      env: {
        PATH: process.env.PATH,
        CHRONOGRAPH_MCP_URL: server.url + "/mcp",
        CHRONOGRAPH_TOKEN_FILE: machineToken,
      },
      stderr: "pipe",
    }),
  );
  assert.ok(
    (await stdio.listTools()).tools.some((t) => t.name === "sample_neighbors"),
  );
  const bridged = await stdio.callTool({
    name: "ingest_edges",
    arguments: {
      edges: [{ src: "11", dst: "12", kind: 1, valid_from: "42" }],
      durability: "fsync",
    },
  });
  assert.ok(!bridged.isError);
  assert.equal(bridged.structuredContent.durability, "fsync");
  pass(
    "official JS client: HTTP MCP and native Rust stdio bridge tool discovery/read/write",
  );
  for (const name of [
    "fork",
    "forks",
    "fork_info",
    "preview_merge",
    "merge",
    "discard",
  ])
    assert.ok(tools.includes(name));
  assert.equal(
    (await reader.request("/v1/fork", { t: "4000000", name: "denied" })).status,
    403,
  );
  assert.equal(
    (
      await readMcp.callTool({
        name: "fork",
        arguments: { t: "4000000", name: "denied" },
      })
    ).isError,
    true,
  );
  const created = await mcp.callTool({
    name: "fork",
    arguments: { t: "4000000", name: "MCP candidate", durability: "fsync" },
  });
  assert.ok(!created.isError);
  const branchId = created.structuredContent.fork.id;
  const pendingId = (
    await writer.json("/v1/fork", {
      t: "4000000",
      name: "Retained alternative",
      durability: "fsync",
    })
  ).fork.id;
  const beforeBranch = (await admin.json("/v1/history", {})).edges;
  const branchWrite = await stdio.callTool({
    name: "ingest_edges",
    arguments: {
      fork: branchId,
      edges: [
        {
          src: "3",
          dst: "4",
          kind: 2,
          valid_from: "5000000",
          valid_to: "6000000",
          payload: "77".repeat(16),
        },
        { src: "3", dst: "90", kind: 2, valid_from: "5000000" },
      ],
      durability: "fsync",
    },
  });
  assert.ok(!branchWrite.isError);
  assert.equal(branchWrite.structuredContent.fork, branchId);
  assert.deepEqual((await admin.json("/v1/history", {})).edges, beforeBranch);
  const branchRead = await stdio.callTool({
    name: "as_of",
    arguments: { fork: branchId, t: "5500000", limit: 100 },
  });
  assert.ok(
    branchRead.structuredContent.edges.some(
      (e) => e.payload === "77".repeat(16),
    ),
  );
  const branchPage = await reader.json("/v1/history", {
    fork: branchId,
    limit: 1,
  });
  assert.equal(
    (
      await reader.request("/v1/history", {
        fork: pendingId,
        limit: 1,
        cursor: branchPage.next_cursor,
      })
    ).status,
    409,
  );
  assert.equal(
    (await reader.request("/v1/as_of", { fork: branchId, t: "3999999" }))
      .status,
    400,
  );
  const forkSample = await reader.json("/v1/sample", {
    fork: branchId,
    nodes: ["3"],
    t: "5500000",
    k: 2,
    strategy: "uniform",
    seed: "42",
  });
  assert.equal(forkSample.samples[0].edges.length, 2);
  assert.equal(new Set(forkSample.samples[0].edges.map((e) => e.id)).size, 2);
  const forkArrow = await reader.request("/v1/export_arrow", {
    fork: branchId,
    t: "5500000",
  });
  assert.equal(forkArrow.status, 200);
  assert.ok((await forkArrow.arrayBuffer()).byteLength > 128);
  await writer.json("/v1/edges", {
    fork: pendingId,
    edges: [
      {
        src: "11",
        dst: "12",
        kind: 1,
        valid_from: "5500000",
        payload: "88".repeat(16),
      },
    ],
    durability: "fsync",
  });
  const preview = await readMcp.callTool({
    name: "preview_merge",
    arguments: { fork: branchId },
  });
  assert.ok(!preview.isError);
  assert.deepEqual(preview.structuredContent.merge.nodes, [
    { branch: "90", parent: "0" },
  ]);
  assert.equal(
    (await reader.request("/v1/merge", { fork: branchId })).status,
    403,
  );
  const merged = await mcp.callTool({
    name: "merge",
    arguments: { fork: branchId, durability: "fsync" },
  });
  assert.ok(!merged.isError);
  assert.deepEqual(
    merged.structuredContent.merge,
    preview.structuredContent.merge,
  );
  const retry = await writer.json("/v1/merge", {
    fork: branchId,
    durability: "fsync",
  });
  assert.deepEqual(retry.merge, merged.structuredContent.merge);
  assert.equal(retry.revision, merged.structuredContent.revision);
  assert.equal(
    (await writer.request("/v1/merge", { fork: pendingId })).status,
    409,
  );
  assert.equal(
    (await reader.request("/v1/history", { fork: branchId })).status,
    409,
  );
  assert.equal(
    (await reader.request("/v1/fork_info", { fork: "999999" })).status,
    404,
  );
  const discardedId = (
    await writer.json("/v1/fork", {
      t: "7000000",
      name: "Discarded candidate",
      durability: "fsync",
    })
  ).fork.id;
  await writer.json("/v1/discard", { fork: discardedId, durability: "fsync" });
  const expectedForks = (await admin.json("/v1/forks", {})).forks;
  const expectedBranch = (await admin.json("/v1/history", { fork: pendingId }))
    .edges;
  const expectedMerge = (await admin.json("/v1/fork_info", { fork: branchId }))
    .merge;
  pass(
    "HTTP and native MCP branches: scoped IDs, bounded intervals, cursor isolation, preview, merge remapping, retries and conflicts",
  );
  await admin.json(`/v1/tokens/${read.credential.id}`, undefined, "DELETE");
  assert.equal((await reader.request("/v1/info")).status, 401);
  await assert.rejects(() =>
    readMcp.callTool({ name: "stats", arguments: {} }),
  );
  pass(
    "revocation invalidates cached HTTP and existing MCP credentials immediately",
  );
  await mkdir(join(server.data, "sidecars"));
  await writeFile(
    join(server.data, "sidecars/epoch.arrow"),
    Buffer.from("owned connector fixture"),
  );
  const backup = await admin.json("/v1/backup", {});
  assert.equal(backup.durability, "fsync");
  const bytes = Buffer.from(
    await (await admin.request(`/v1/backups/${backup.id}`)).arrayBuffer(),
  );
  assert.ok(!bytes.includes(Buffer.from(server.adminToken)));
  assert.ok(!bytes.includes(Buffer.from("argon2id")));
  const local = await mkdtemp(join(tmpdir(), "chronograph-restore-test-"));
  const source = join(local, "backup.tar");
  await writeFile(source, bytes);
  const dest = join(local, "restored");
  let restore = spawnSync(serverBinary, ["restore", source], {
    cwd: root,
    env: { ...process.env, CHRONOGRAPH_DATA: dest },
    encoding: "utf8",
  });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(
    await readFile(join(dest, "sidecars/epoch.arrow"), "utf8"),
    "owned connector fixture",
  );
  const restored = await startServer({ port: 18082, data: dest });
  try {
    assert.deepEqual(
      (await client(restored).json("/v1/history", {})).edges,
      (await admin.json("/v1/history", {})).edges,
    );
    assert.deepEqual(
      (await client(restored).json("/v1/forks", {})).forks,
      expectedForks,
    );
    assert.deepEqual(
      (await client(restored).json("/v1/history", { fork: pendingId })).edges,
      expectedBranch,
    );
    assert.deepEqual(
      (await client(restored).json("/v1/fork_info", { fork: branchId })).merge,
      expectedMerge,
    );
  } finally {
    await restored.stop();
  }
  restore = spawnSync(serverBinary, ["restore", source], {
    cwd: root,
    env: { ...process.env, CHRONOGRAPH_DATA: dest },
    encoding: "utf8",
  });
  assert.notEqual(restore.status, 0);
  assert.deepEqual(await readFile(source), bytes);
  await admin.json(`/v1/backups/${backup.id}`, undefined, "DELETE");
  assert.equal((await admin.json("/v1/backups")).backups.length, 0);
  pass(
    "downloaded bundle restores to an independent service; sidecars retained, secrets excluded, overwrite rejected",
  );
  await stdio.close();
  stdio = null;
  await mcp.close();
  mcp = null;
  await readMcp.close();
  readMcp = null;
  const expected = (await admin.json("/v1/history", {})).edges;
  await server.stop("SIGKILL");
  server = await startServer({
    data: server.data,
    config: server.config,
    tokenFile: server.tokenFile,
  });
  assert.deepEqual(
    (await client(server).json("/v1/history", {})).edges,
    expected,
  );
  assert.deepEqual(
    (await client(server).json("/v1/forks", {})).forks,
    expectedForks,
  );
  assert.deepEqual(
    (await client(server).json("/v1/history", { fork: pendingId })).edges,
    expectedBranch,
  );
  assert.deepEqual(
    (await client(server).json("/v1/fork_info", { fork: branchId })).merge,
    expectedMerge,
  );
  pass(
    "fsync-acknowledged parent and branch history, discard and merge results survive backup restoration and process kill/restart",
  );
  assert.ok(!server.logs().includes(server.adminToken));
  await report("protocol.json", {
    status: "passed",
    checks,
    seconds: (performance.now() - began) / 1000,
    date: new Date().toISOString(),
    runtime: process.version,
    mcp_client: "@modelcontextprotocol/sdk",
    server: "0.3.0",
  });
} finally {
  await stdio?.close();
  await mcp?.close();
  await readMcp?.close();
  await server.stop();
}
