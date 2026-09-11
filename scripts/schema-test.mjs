#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import {
  startServer,
  client,
  root,
  report,
  serverBinary,
} from "./test-support.mjs";

const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let server = await startServer({ port: 18085 }),
  mcp,
  readerMcp;
try {
  let api = client(server);
  const source = await readFile(
    join(root, "examples/migrations/20260910_observations.json"),
    "utf8",
  );
  const connect = async (token) => {
    const c = new Client({ name: "chronograph-schema-test", version: "1.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url + "/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return c;
  };
  mcp = await connect(server.adminToken);
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  for (const name of [
    "schema",
    "schema_preview",
    "schema_apply",
    "schema_migration",
    "schema_encode",
  ])
    assert.ok(names.includes(name));
  const call = async (name, args = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  const preview = await call("schema_preview", { source });
  assert.equal(preview.expected_revision, 0);
  assert.equal((await call("schema")).revision, 0);
  const apply = {
    source,
    expected_revision: preview.expected_revision,
    checksum: preview.checksum,
  };
  const reader = await api.json("/v1/tokens", {
    name: "schema reader",
    scope: "read",
    days: 1,
  });
  readerMcp = await connect(reader.token);
  assert.equal(
    (await readerMcp.callTool({ name: "schema_apply", arguments: apply }))
      .isError,
    true,
  );
  assert.ok(
    !(await readerMcp.callTool({ name: "schema", arguments: {} })).isError,
  );
  assert.equal((await call("schema_apply", apply)).applied, true);
  assert.equal((await call("schema_apply", apply)).already_applied, true);
  const values = { confidence: 0.75, sequence: "18446744073709551615" };
  const encoded = await call("schema_encode", { kind: 10, properties: values });
  assert.equal(encoded.payload, "0000403f00000000ffffffffffffffff");
  const inserted = await call("ingest_edges", {
    edges: [
      {
        src: "9001",
        dst: "9002",
        kind: 10,
        valid_from: "0",
        properties: values,
      },
    ],
    durability: "fsync",
  });
  assert.deepEqual(
    (await call("get_edge", { id: inserted.ids[0] })).properties,
    values,
  );
  assert.equal(
    (await call("schema_migration", { id: "20260910_observations" })).source,
    source,
  );
  pass(
    "Official MCP client: discovery, scopes, preview, apply, idempotency, encode, structured ingestion and history",
  );
  const cli = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(root, "scripts/migrate.mjs"),
          "--file",
          join(root, "examples/migrations/20260910_observations.json"),
          "--token-file",
          server.tokenFile,
          "--url",
          server.url,
          ...args,
        ],
        { encoding: "utf8" },
      ),
    );
  assert.equal(cli().already_applied, true);
  assert.equal(cli("--apply").already_applied, true);
  const invalid = await mkdtemp(join(tmpdir(), "chronograph-migration-cli-"));
  const badFile = join(invalid, "invalid.json");
  await writeFile(badFile, "DROP TABLE edges;");
  let invalidFailed = false;
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "scripts/migrate.mjs"),
        "--file",
        badFile,
        "--token-file",
        server.tokenFile,
        "--url",
        server.url,
        "--apply",
      ],
      { stdio: "pipe" },
    );
  } catch {
    invalidFailed = true;
  }
  assert.ok(invalidFailed);
  assert.equal((await api.json("/v1/schema", {})).revision, 1);
  pass(
    "File CLI preview/apply retries and invalid files leave schema unchanged",
  );
  const backup = await api.json("/v1/backup", {});
  const destination = join(invalid, "restored");
  execFileSync(
    serverBinary,
    ["restore", join(server.data, "backups", `${backup.id}.tar`)],
    {
      cwd: root,
      env: { ...process.env, CHRONOGRAPH_DATA: destination },
      stdio: "pipe",
    },
  );
  const restored = await startServer({ port: 18086, data: destination });
  try {
    const restoredApi = client(restored);
    assert.equal((await restoredApi.json("/v1/schema", {})).revision, 1);
    assert.deepEqual(
      (await restoredApi.json("/v1/get_edge", { id: inserted.ids[0] }))
        .properties,
      values,
    );
  } finally {
    await restored.stop();
  }
  pass("Backup archive restores the catalog and decoded temporal records");
  await mcp.close();
  mcp = null;
  await readerMcp.close();
  readerMcp = null;
  await server.stop("SIGKILL");
  server = await startServer({
    port: 18085,
    data: server.data,
    config: server.config,
    tokenFile: server.tokenFile,
  });
  api = client(server);
  assert.equal((await api.json("/v1/schema", {})).revision, 1);
  assert.deepEqual(
    (await api.json("/v1/get_edge", { id: inserted.ids[0] })).properties,
    values,
  );
  assert.equal(
    (await api.json("/v1/schema_apply", apply)).already_applied,
    true,
  );
  pass(
    "Abrupt process termination/restart preserves applied migration and exact property values",
  );
  await report("schema-protocol.json", {
    passed: true,
    checks,
    timestamp: new Date().toISOString(),
  });
} finally {
  await mcp?.close();
  await readerMcp?.close();
  await server.stop();
}
