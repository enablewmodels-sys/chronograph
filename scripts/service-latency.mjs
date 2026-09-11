#!/usr/bin/env node
import assert from "node:assert/strict";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { startServer, client as httpClient, report } from "./test-support.mjs";
const server = await startServer({ port: 18084 });
let client;
try {
  const admin = httpClient(server);
  const token = (
    await admin.json("/v1/tokens", {
      name: "latency harness",
      scope: "ingest",
      days: 1,
    })
  ).token;
  const http = async (op, args = {}) => {
    const r = await fetch(`${server.url}/v1/${op}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const started = performance.now();
  for (let base = 0; base < 100000; base += 10000) {
    const edges = Array.from({ length: 10000 }, (_, j) => {
      const i = base + j;
      return {
        src: String(i % 1000),
        dst: String(1000 + (Math.floor(i / 1000) % 32)),
        kind: 1,
        valid_from: String(Math.floor(i / 32000) * 1000000),
      };
    });
    await http("add_edges", { edges });
  }
  await http("sync");
  const ingestMs = performance.now() - started;
  const baseline = await http("stats");
  assert.equal(baseline.edge_versions, "100000");
  client = new Client({ name: "chronograph-latency", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const samples = [];
  const summary = [];
  const measure = async (name, count, concurrency, fn) => {
    for (let i = 0; i < 20; i++) await fn(-i - 1);
    const times = [];
    const wall = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < count) {
          const i = next++;
          const start = performance.now();
          await fn(i);
          const ms = performance.now() - start;
          times.push(ms);
          samples.push({ name, sample: i, ms });
        }
      }),
    );
    const elapsed = performance.now() - wall;
    times.sort((a, b) => a - b);
    const pct = (p) => times[Math.ceil(times.length * p) - 1];
    const result = {
      name,
      samples: count,
      concurrency,
      p50_ms: pct(0.5),
      p95_ms: pct(0.95),
      p99_ms: pct(0.99),
      max_ms: times.at(-1),
      requests_per_second: count / (elapsed / 1000),
    };
    summary.push(result);
    console.log(JSON.stringify(result));
  };
  await measure("HTTP stats", 500, 1, async () => {
    assert.equal((await http("stats")).edge_versions, "100000");
  });
  const query = { mode: "as_of", t: "2500000", limit: 1000 };
  await measure("HTTP as-of first page (1000 rows)", 300, 1, async () => {
    const r = await http("query", query);
    assert.equal(r.count, 1000);
    assert.notEqual(r.next_cursor, null);
  });
  await measure("HTTP uniform sample (16 edges)", 300, 1, async () => {
    assert.equal(
      (
        await http("query", {
          mode: "sample",
          node: "32",
          t: "2500000",
          k: 16,
          limit: 16,
          strategy: "uniform",
          seed: "42",
        })
      ).count,
      16,
    );
  });
  await measure("MCP as-of first page (1000 rows)", 300, 1, async () => {
    const r = await client.callTool({ name: "query", arguments: query });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent.count, 1000);
  });
  await measure("HTTP as-of first page, 8 clients", 400, 8, async () => {
    assert.equal((await http("query", query)).count, 1000);
  });
  await measure(
    "MCP as-of first page, 8 concurrent requests",
    400,
    8,
    async () => {
      const r = await client.callTool({
        name: "as_of",
        arguments: { t: "2500000", limit: 1000 },
      });
      assert.ok(!r.isError);
      assert.equal(r.structuredContent.count, 1000);
    },
  );
  let unique = 0;
  await measure("HTTP durable single insert", 200, 1, async () => {
    const id = unique++;
    const r = await http("add_edges", {
      durability: "fsync",
      edges: [
        { src: String(1000000 + id), dst: "2", kind: 1, valid_from: "9000000" },
      ],
    });
    assert.equal(r.ids.length, 1);
  });
  const source = JSON.stringify({
    version: 1,
    id: "latency_schema",
    name: "Measure typed observations",
    operations: [
      {
        op: "upsert_relation",
        relation: {
          kind: 1,
          name: "observes",
          source_label: "sensor",
          target_label: "object",
          properties: [
            { name: "confidence", type: "f32", offset: 0 },
            { name: "sequence", type: "u64", offset: 8 },
          ],
        },
      },
    ],
  });
  const preview = await admin.json("/v1/schema_preview", { source });
  await admin.json("/v1/schema_apply", {
    source,
    checksum: preview.checksum,
    expected_revision: preview.expected_revision,
  });
  await measure(
    "HTTP schema catalog (1 relation, 1 migration)",
    200,
    1,
    async () => {
      assert.equal((await http("schema")).relations[0].name, "observes");
    },
  );
  const settingsDraft = JSON.stringify({
    version: 1,
    id: "preview_only",
    name: "Preview settings",
    operations: [
      { op: "set_settings", settings: { description: "World model" } },
    ],
  });
  await measure("HTTP schema preview (metadata-only)", 200, 1, async () => {
    assert.equal(
      (await http("schema_preview", { source: settingsDraft })).after.settings
        .description,
      "World model",
    );
  });
  await measure("HTTP typed as-of first page (1000 rows)", 300, 1, async () => {
    const r = await http("query", query);
    assert.equal(r.count, 1000);
    assert.equal(r.edges[0].properties.sequence, "0");
  });
  await measure("MCP typed as-of first page (1000 rows)", 200, 1, async () => {
    const r = await client.callTool({ name: "query", arguments: query });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent.edges[0].relation, "observes");
  });
  await measure("HTTP typed durable single insert", 200, 1, async () => {
    const id = unique++;
    const r = await http("add_edges", {
      durability: "fsync",
      edges: [
        {
          src: String(1000000 + id),
          dst: "2",
          kind: 1,
          valid_from: "9000000",
          properties: { confidence: 0.75, sequence: "18446744073709551615" },
        },
      ],
    });
    assert.equal(r.ids.length, 1);
  });
  const output = {
    date: new Date().toISOString(),
    environment: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0].model,
      logical_cpus: os.cpus().length,
      memory_gib: os.totalmem() / 2 ** 30,
      node: process.version,
      rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    },
    workload: {
      versions: 100000,
      nodes: baseline.nodes,
      active_at_query: 32000,
      page_limit: 1000,
      warmups: 20,
      durability:
        "Initial 100k ingest buffered + final sync; durable single-insert workload requests fsync",
      transport:
        "loopback HTTP, no TLS, release build; full client response parsed",
      initial_ingest_ms: ingestMs,
      initial_ingest_edges_per_second: 100000 / (ingestMs / 1000),
    },
    summary,
  };
  await report("latency.json", output);
  await report(
    "latency-samples.csv",
    "workload,sample,latency_ms\n" +
      samples
        .map((r) => `"${r.name}",${r.sample},${r.ms.toFixed(6)}`)
        .join("\n") +
      "\n",
  );
} finally {
  await client?.close();
  await server.stop();
}
