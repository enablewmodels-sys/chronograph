#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
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
    "schema_plan",
    "schema_apply_plan",
    "schema_export",
    "schema_rollback",
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
  // Exercise new operations on the same historical graph after crash recovery.
  mcp = await connect(server.adminToken);
  readerMcp = await connect(reader.token);
  const migrations = [
    {
      version: 3,
      id: "batch_labels",
      name: "Label patch",
      operations: [
        {
          op: "patch_relation",
          kind: 10,
          patch: { description: "Ordered plan" },
        },
      ],
    },
    {
      version: 3,
      id: "batch_rename",
      name: "Rename confidence",
      requires: ["batch_labels"],
      operations: [
        { op: "rename_property", kind: 10, from: "confidence", to: "score" },
      ],
    },
  ];
  const sources = migrations.map((m) => JSON.stringify(m));
  const planned = await call("schema_plan", { sources });
  const planApply = {
    sources,
    checksum: planned.checksum,
    expected_revision: planned.expected_revision,
  };
  assert.equal(planned.pending, 2);
  assert.equal(
    (
      await readerMcp.callTool({
        name: "schema_apply_plan",
        arguments: planApply,
      })
    ).isError,
    true,
  );
  const bad = JSON.stringify({
    version: 3,
    id: "bad_final",
    name: "Must fail",
    operations: [{ op: "drop_relation", kind: 65534 }],
  });
  assert.equal(
    (
      await mcp.callTool({
        name: "schema_apply_plan",
        arguments: { ...planApply, sources: [...sources, bad] },
      })
    ).isError,
    true,
  );
  assert.equal((await call("schema")).revision, 1);
  const dir = join(invalid, "ordered");
  await mkdir(dir);
  // Write in reverse filesystem insertion order; filename order is authoritative.
  await writeFile(join(dir, "002_rename.json"), sources[1]);
  await writeFile(join(dir, "001_labels.json"), sources[0]);
  const folderCli = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(root, "scripts/migrate.mjs"),
          "--token-file",
          server.tokenFile,
          "--url",
          server.url,
          ...args,
        ],
        { encoding: "utf8" },
      ),
    );
  assert.equal(folderCli("--dir", dir).pending, 2);
  assert.equal(folderCli("--dir", dir, "--apply").applied_count, 2);
  assert.equal(
    (await call("schema_apply_plan", planApply)).already_applied,
    true,
  );
  assert.deepEqual(
    (await call("get_edge", { id: inserted.ids[0] })).properties,
    { score: 0.75, sequence: values.sequence },
  );
  const rollback = await call("schema_rollback", {
    target_revision: 1,
    id: "undo_batch",
    name: "Restore prior labels",
  });
  const undo = await call("schema_apply_plan", {
    sources: rollback.sources,
    checksum: rollback.preview.checksum,
    expected_revision: rollback.preview.expected_revision,
  });
  assert.equal(undo.schema_revision, 4);
  assert.deepEqual(
    (await call("get_edge", { id: inserted.ids[0] })).properties,
    values,
  );
  assert.equal(
    (
      await mcp.callTool({
        name: "schema_rollback",
        arguments: { target_revision: 0, id: "unsafe_undo", name: "Unsafe" },
      })
    ).isError,
    true,
  );
  const baselineFile = join(invalid, "baseline.json");
  folderCli("--export", "--out", baselineFile);
  const fresh = await startServer({ port: 18086 });
  try {
    const imported = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(root, "scripts/migrate.mjs"),
          "--file",
          baselineFile,
          "--token-file",
          fresh.tokenFile,
          "--url",
          fresh.url,
          "--apply",
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(imported.applied, true);
    assert.deepEqual(
      (await client(fresh).json("/v1/schema", {})).relations,
      (await call("schema")).relations,
    );
    assert.equal(
      (await client(fresh).json("/v1/stats", {})).edge_versions,
      "0",
    );
  } finally {
    await fresh.stop();
  }
  assert.equal(folderCli("--status").revision, 4);
  pass(
    "Atomic ordered folder apply, MCP/REST parity, scope checks, safe historical rename, compensating rollback and portable baseline import",
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
