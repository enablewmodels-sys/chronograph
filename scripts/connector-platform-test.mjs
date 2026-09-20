import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  startServer,
  client,
  report,
  serverBinary,
  root,
} from "./test-support.mjs";
import { Client } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../ui/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

let server = await startServer({ port: 18087 }),
  restored,
  mcp,
  tensorBatch,
  decisionBatch;
const checks = [],
  receipts = [],
  batches = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  let api = client(server);
  const readerToken = await api.json("/v1/tokens", {
    name: "reader",
    scope: "read",
    days: 1,
  });
  const reader = client(server, readerToken.token);
  const upload = {
    metadata: {
      version: 1,
      kind: "tensor",
      encoding: "raw_le",
      dtype: "f32",
      shape: [2, 2],
      provenance: { checkpoint: "fixture-v1" },
    },
    data_hex: "000000000000803f0000807f0100c07f",
  };
  assert.equal((await reader.request("/v1/asset_put", upload)).status, 403);
  assert.equal(
    (
      await api.request("/v1/asset_put", {
        ...upload,
        metadata: { ...upload.metadata, shape: [20] },
      })
    ).status,
    400,
  );
  const tensor = await api.json("/v1/asset_put", upload);
  assert.equal((await api.json("/v1/asset_put", upload)).asset, tensor.asset);
  assert.equal(
    (await api.json("/v1/asset_get", { asset: tensor.asset, content: true }))
      .data_hex,
    upload.data_hex,
  );
  const source = await api.json("/v1/asset_put", {
    metadata: {
      version: 1,
      kind: "opaque",
      encoding: "openqasm3",
      dtype: null,
      shape: [],
      provenance: {},
    },
    data_hex: Buffer.from("OPENQASM 3; // retained, never executed").toString(
      "hex",
    ),
  });
  pass("asset exact bits, shape checks, deduplication and read scope");
  const registry = await api.json("/v1/connector_catalog", {});
  let kind = 1000;
  for (const d of registry.connectors)
    for (const preset of d.presets) {
      const id = `fixture_${kind}`;
      const binding = {
        id,
        connector: d.id,
        preset,
        contract_version: 1,
        kind: kind++,
        clock_domain: d.id === "lsl" ? "lsl_local_us" : "simulation_us",
        modalities: [],
        channels: ["C3", "C4"],
        units: ["uV", "uV"],
        topics: [],
        tensor_shapes: {},
        secret_refs: [],
      };
      const generated = await api.json("/v1/connector_template", binding);
      const preview = await api.json("/v1/schema_preview", {
        source: generated.source,
      });
      assert.equal(
        (
          await reader.request("/v1/schema_apply", {
            source: generated.source,
            checksum: preview.checksum,
            expected_revision: preview.expected_revision,
          })
        ).status,
        403,
      );
      await api.json("/v1/schema_apply", {
        source: generated.source,
        checksum: preview.checksum,
        expected_revision: preview.expected_revision,
      });
      const record = {
        src: String(kind),
        dst: String(kind + 10000),
        timestamp_us: "9007199254740993",
        episode: "episode-1",
        assets: {
          latent: tensor.asset,
          signal: tensor.asset,
          source: source.asset,
        },
        fields: {
          checkpoint: "fixture-v1",
          model: "fixture",
          basis: "Z",
          counts: { "00": "8" },
          observables: { z: 0.5 },
          level: 1,
          horizon_us: "500000",
          parent_node: "9007199254740993",
          action: { motor: [0.25, -0.5] },
          reward: 0.75,
          terminated: false,
          truncated: true,
          marker: "start",
          reason: "reconnect",
          lost_samples: "7",
          provider: "typesafe",
          requested_model: "jev-latest",
          mode: "fixture",
          input_sha256: "a".repeat(64),
          answers: { review: { type: "noul", noul: 0.75 } },
        },
      };
      if (d.id === "model-output") delete record.assets.source;
      const batch = {
        instance: id,
        partition: "fixture",
        sequence: "0",
        records: [record],
      };
      if (d.id === "jepa" && preset === "i-jepa") tensorBatch = batch;
      if (d.id === "jev" && preset === "decisions-v1") decisionBatch = batch;
      assert.equal(
        (await reader.request("/v1/connector_ingest", batch)).status,
        403,
      );
      const result = await api.json("/v1/connector_ingest", batch);
      assert.equal(result.already_applied, false);
      assert.equal(result.receipt.durability, "fsync");
      const again = await api.json("/v1/connector_ingest", batch);
      assert.equal(again.already_applied, true);
      assert.deepEqual(again.receipt, result.receipt);
      assert.equal(
        (
          await api.request("/v1/connector_ingest", {
            ...batch,
            records: [{ ...record, timestamp_us: "1" }],
          })
        ).status,
        409,
      );
      assert.equal(
        (await api.request("/v1/connector_ingest", { ...batch, sequence: "2" }))
          .status,
        409,
      );
      assert.deepEqual(
        (
          await api.json("/v1/connector_record", {
            edge: result.receipt.first_edge,
          })
        ).record,
        { ...record, valid_to: null },
      );
      const edge = await api.json("/v1/get_edge", {
        id: result.receipt.first_edge,
      });
      assert.equal(edge.properties.encoding, "arrow_record_v1");
      assert.equal(
        (
          await api.request("/v1/add_edges", {
            edges: [
              { src: "1", dst: "2", kind: binding.kind, valid_from: "0" },
            ],
          })
        ).status,
        400,
      );
      assert.equal(
        (await api.request("/v1/connector_template", binding)).status,
        409,
      );
      receipts.push(result.receipt);
      batches.push(batch);
    }
  pass(
    `${receipts.length} registry presets: migration → ingest → exact source export → retry/conflict`,
  );
  assert.ok(
    tensorBatch,
    "The JEPA fixture must exercise required tensor assets",
  );
  assert.ok(decisionBatch, "The Jev fixture must exercise decision validation");
  const invalid = {
    ...tensorBatch,
    sequence: "1",
    records: [{ ...tensorBatch.records[0], assets: {} }],
  };
  assert.equal(
    (await api.request("/v1/connector_ingest", invalid)).status,
    400,
  );
  assert.equal(
    (
      await api.json("/v1/connector_checkpoint", {
        instance: tensorBatch.instance,
        partition: "fixture",
      })
    ).checkpoint.sequence,
    "0",
  );
  const unknownAsset = {
    ...tensorBatch,
    sequence: "1",
    records: [
      { ...tensorBatch.records[0], assets: { latent: "00".repeat(16) } },
    ],
  };
  assert.equal(
    (await api.request("/v1/connector_ingest", unknownAsset)).status,
    400,
  );
  const invalidDecision = structuredClone(decisionBatch);
  invalidDecision.sequence = "1";
  invalidDecision.records[0].fields.answers.review.noul = 1.5;
  assert.equal(
    (await api.request("/v1/connector_ingest", invalidDecision)).status,
    400,
  );
  for (const batch of [tensorBatch, decisionBatch]) {
    assert.equal(
      (
        await api.json("/v1/connector_checkpoint", {
          instance: batch.instance,
          partition: batch.partition,
        })
      ).checkpoint.sequence,
      "0",
    );
  }
  pass("invalid records and missing assets cannot advance checkpoints");
  mcp = new Client({ name: "connector-test", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(server.url + "/mcp"), {
      requestInit: {
        headers: { Authorization: `Bearer ${server.adminToken}` },
      },
    }),
  );
  const tools = await mcp.listTools();
  assert.ok(tools.tools.some((t) => t.name === "connector_ingest"));
  const tool = tools.tools.find((t) => t.name.endsWith("connector_catalog"));
  const reply = await mcp.callTool({ name: tool.name, arguments: {} });
  assert.ok(!reply.isError);
  await mcp.close();
  mcp = null;
  pass("official MCP client discovers connector contracts");
  const backup = await api.json("/v1/backup", {});
  const backupId = backup.id ?? backup.backup?.id;
  assert.ok(backupId, JSON.stringify(backup));
  const download = await api.request(`/v1/backups/${backupId}`);
  assert.equal(download.status, 200);
  const base = await mkdtemp(join(tmpdir(), "cg-connector-restore-"));
  const archive = join(base, "snapshot.tar");
  await writeFile(archive, Buffer.from(await download.arrayBuffer()));
  execFileSync(serverBinary, ["restore", archive], {
    cwd: root,
    env: { ...process.env, CHRONOGRAPH_DATA: join(base, "restored") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await server.stop("SIGKILL");
  server = await startServer({
    port: 18087,
    data: server.data,
    config: server.config,
    tokenFile: server.tokenFile,
  });
  api = client(server);
  restored = await startServer({ port: 18088, data: join(base, "restored") });
  const restoreApi = client(restored);
  for (let i = 0; i < batches.length; i++) {
    assert.deepEqual(
      (await api.json("/v1/connector_ingest", batches[i])).receipt,
      receipts[i],
    );
    assert.deepEqual(
      (
        await restoreApi.json("/v1/connector_checkpoint", {
          instance: batches[i].instance,
          partition: "fixture",
        })
      ).checkpoint,
      receipts[i],
    );
    assert.deepEqual(
      (
        await restoreApi.json("/v1/connector_record", {
          edge: receipts[i].first_edge,
        })
      ).record,
      (await api.json("/v1/connector_record", { edge: receipts[i].first_edge }))
        .record,
    );
  }
  assert.equal(
    (
      await restoreApi.json("/v1/asset_get", {
        asset: tensor.asset,
        content: true,
      })
    ).data_hex,
    upload.data_hex,
  );
  pass(
    "SIGKILL restart and independent backup restore preserve every preset, asset and receipt",
  );
  await report("connector-platform.json", {
    status: "passed",
    presets: receipts.length,
    checks,
  });
} finally {
  if (mcp) await mcp.close();
  await server.stop();
  if (restored) await restored.stop();
}
