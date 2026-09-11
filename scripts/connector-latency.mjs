import { startServer, client, report } from "./test-support.mjs";
import assert from "node:assert/strict";
const server = await startServer({ port: 18091 });
try {
  const api = client(server);
  const summary = [];
  const binding = {
    id: "latency",
    connector: "jepa",
    preset: "v-jepa-2.1",
    contract_version: 1,
    kind: 61000,
    clock_domain: "simulation_us",
    tensor_shapes: { latent: [128, 512] },
  };
  const template = await api.json("/v1/connector_template", binding);
  const preview = await api.json("/v1/schema_preview", {
    source: template.source,
  });
  await api.json("/v1/schema_apply", {
    source: template.source,
    checksum: preview.checksum,
    expected_revision: preview.expected_revision,
  });
  const bytes = Buffer.alloc(128 * 512 * 4);
  const asset = (
    await api.json("/v1/asset_put", {
      metadata: {
        version: 1,
        kind: "tensor",
        encoding: "raw_le",
        dtype: "f32",
        shape: [128, 512],
        provenance: {},
      },
      data_hex: bytes.toString("hex"),
    })
  ).asset;
  let sequence = 0,
    last;
  const record = (i, t) => ({
    src: String(i),
    dst: String(i + 10000),
    timestamp_us: String(t),
    assets: { latent: asset },
    fields: { checkpoint: "synthetic-latency-fixture" },
  });
  async function measure(name, count, fn) {
    for (let i = 0; i < 10; i++) await fn();
    const values = [];
    for (let i = 0; i < count; i++) {
      const t = performance.now();
      await fn();
      values.push(performance.now() - t);
    }
    values.sort((a, b) => a - b);
    const value = {
      name,
      samples: count,
      p50_ms: values[Math.floor(count * 0.5)],
      p95_ms: values[Math.floor(count * 0.95)],
      p99_ms: values[Math.floor(count * 0.99)],
    };
    summary.push(value);
    console.log(JSON.stringify(value));
  }
  await measure(
    "JEPA single record, 256 KiB tensor validation, Arrow publish + journal fsync",
    100,
    async () => {
      last = {
        instance: "latency",
        partition: "main",
        sequence: String(sequence),
        records: [record(1, sequence)],
      };
      sequence++;
      const r = await api.json("/v1/connector_ingest", last);
      assert.equal(r.receipt.durability, "fsync");
    },
  );
  await measure("Identical latest-batch retry", 200, () =>
    api.json("/v1/connector_ingest", last),
  );
  await measure("Read checkpoint", 200, () =>
    api.json("/v1/connector_checkpoint", {
      instance: "latency",
      partition: "main",
    }),
  );
  await measure("Verified source record export", 200, () =>
    api.json("/v1/connector_record", { edge: "0" }),
  );
  await measure(
    "500 JEPA records sharing a 256 KiB tensor, fsync",
    50,
    async () => {
      const batch = {
        instance: "latency",
        partition: "main",
        sequence: String(sequence),
        records: Array.from({ length: 500 }, (_, i) => record(i, sequence)),
      };
      sequence++;
      const r = await api.json("/v1/connector_ingest", batch);
      assert.equal(r.receipt.edge_count, "500");
    },
  );
  await report("connector-latency.json", {
    version: "0.4.0-alpha.2",
    transport: "loopback HTTP, no TLS",
    durability: "fsync",
    fixture: "synthetic model outputs; 256 KiB little-endian f32 tensor",
    summary,
  });
} finally {
  await server.stop();
}
