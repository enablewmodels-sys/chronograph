import assert from "node:assert/strict";

export async function catalogFixtures(admin) {
  const registry = await admin.json("/v1/connector_catalog", {}),
    fixtures = [],
    sources = [];
  const tensor = (
    await admin.json("/v1/asset_put", {
      metadata: {
        version: 1,
        kind: "tensor",
        encoding: "raw_le",
        dtype: "f32",
        shape: [2, 2],
      },
      data_hex: "000000000000803f0000807f0100c07f",
    })
  ).asset;
  const source = (
    await admin.json("/v1/asset_put", {
      metadata: { version: 1, kind: "opaque", encoding: "openqasm3" },
      data_hex: Buffer.from("OPENQASM 3; // fixture only").toString("hex"),
    })
  ).asset;
  let kind = 5000;
  for (const descriptor of registry.connectors)
    for (const preset of descriptor.presets) {
      const id = `portable_${kind}`,
        clock = descriptor.id === "lsl" ? "lsl_local_us" : "simulation_us";
      sources.push(
        (
          await admin.json("/v1/connector_template", {
            id,
            connector: descriptor.id,
            preset,
            kind: kind++,
            contract_version: 1,
            clock_domain: clock,
            channels: ["C3", "C4"],
            units: ["uV", "uV"],
          })
        ).source,
      );
      fixtures.push({
        id,
        connector: descriptor.id,
        preset,
        clock,
        tensor,
        source,
      });
    }
  const plan = await admin.json("/v1/schema_plan", { sources });
  await admin.json("/v1/schema_apply_plan", {
    sources,
    checksum: plan.checksum,
    expected_revision: plan.expected_revision,
  });
  return fixtures;
}

export async function extended(
  good,
  d,
  language,
  fixtures,
  readToken,
  ingestToken,
  kind,
) {
  // The same physical bytes are sent through every compiled client, including
  // negative zero and a noncanonical NaN payload. No float/JSON conversion.
  const raw = Buffer.from(
    "0000000000000080010000000000f87f000000000000f03f00000000000000c00000000000000840000000000000104000000000000014400000000000001840",
    "hex",
  );
  const metadata = {
    version: 1,
    kind: "tensor",
    encoding: "raw_le",
    dtype: "f64",
    shape: [2, 4],
    provenance: { producer: language },
  };
  const signal = await good(
    "",
    { metadata, data_hex: raw.toString("hex") },
    { helper: "upload", token: ingestToken },
  );
  const got = await good(
    "",
    { asset: signal },
    { helper: "read", token: readToken },
  );
  assert.equal(got.data_hex, raw.toString("hex"));
  const big = Buffer.alloc(1048607);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const bigID = await good(
    "",
    {
      metadata: { version: 1, kind: "opaque", encoding: "sdk_fixture" },
      data_hex: big.toString("hex"),
    },
    { helper: "upload", token: ingestToken },
  );
  assert.equal(
    (await good("", { asset: bigID }, { helper: "read", token: readToken }))
      .data_hex,
    big.toString("hex"),
  );
  assert.equal(
    (await d.ask({ helper: "upload", body: { metadata, data_hex: "" } })).local,
    true,
  );
  const sources = [];
  for (const [suffix, connector, preset] of [
    ["bci", "bci", "research-v1"],
    ["extra", "custom", "record-v1"],
  ])
    sources.push(
      (
        await good("connector_template", {
          id: `parity_${language}_${suffix}`,
          connector,
          preset,
          contract_version: 1,
          kind: kind++,
          clock_domain: "simulation_us",
        })
      ).source,
    );
  const plan = await good("schema_plan", { sources });
  await good("schema_apply_plan", {
    sources,
    checksum: plan.checksum,
    expected_revision: plan.expected_revision,
  });
  // Applying identical sources again is idempotent; an altered checksum is not.
  const again = await good("schema_plan", { sources });
  await good("schema_apply_plan", {
    sources,
    checksum: again.checksum,
    expected_revision: again.expected_revision,
  });
  assert.equal(
    (
      await d.ask({
        op: "schema_apply_plan",
        body: {
          sources,
          checksum: "0".repeat(64),
          expected_revision: again.expected_revision,
        },
      })
    ).ok,
    false,
  );
  const instance = `parity_${language}_bci`,
    session = "9007199254740993";
  const base = { src: session, timestamp_us: "0", assets: {} };
  const record = (type, n, fields = {}, assets = {}) => ({
    ...base,
    dst: (9007199254740993n + BigInt(n)).toString(),
    assets,
    fields: {
      type,
      session_id: session,
      clock_domain: "simulation_us",
      ...fields,
    },
  });
  const times = Buffer.alloc(32);
  [0, 0.01, 0.02, 0.03].forEach((v, i) => times.writeDoubleLE(v, i * 8));
  const ts = await good(
    "",
    {
      metadata: {
        version: 1,
        kind: "tensor",
        encoding: "raw_le",
        dtype: "f64",
        shape: [4],
      },
      data_hex: times.toString("hex"),
    },
    { helper: "upload" },
  );
  const records = [
    record("session", 0, {
      name: `${language} EEG`,
      study: "fixture",
      participant: "synthetic",
      source: "synthetic",
      device: "fixture",
      driver: "cross-language",
    }),
    record("stream", 1, {
      stream_id: "eeg",
      channels: ["C3", "C4"],
      units: ["V", "V"],
      channel_types: ["EEG", "EEG"],
      sample_rate_hz: 100,
      reference: "synthetic",
      source_clock: "simulation_us",
      electrodes: {},
    }),
    record(
      "signal",
      2,
      {
        stream_id: "eeg",
        segment_id: "a",
        sample_start: "0",
        sample_count: "4",
        end_us: "40000",
        correction_seconds: 0,
      },
      { signal, timestamps: ts },
    ),
  ];
  const body = { instance, partition: language, sequence: "0", records };
  const receipt = (await good("connector_ingest", body, { token: ingestToken }))
    .receipt;
  assert.deepEqual(
    (await good("connector_ingest", body, { token: ingestToken })).receipt,
    receipt,
  );
  const sessions = await good("bci_sessions", { instance }, { helper: "bci" });
  assert.equal(sessions.sessions[0].session, session);
  const detail = await good(
    "bci_session",
    { instance, session },
    { helper: "bci" },
  );
  assert(detail);
  const window = await good(
    "bci_window",
    {
      instance,
      session,
      stream: "eeg",
      start: "0",
      end: "40000",
      channels: [0, 1],
    },
    { helper: "bci", token: readToken },
  );
  assert.equal(window.nonfinite_values, 1);
  assert.equal(window.channels.length, 2);
  assert.equal(window.channels[1].name, "C4");
  const pages = await good(
    "bci_records",
    { instance, session, limit: 1 },
    { helper: "pages", max_pages: 10 },
  );
  assert.equal(pages.length, 3);
  assert.deepEqual(
    pages.flatMap((p) => p.records).map((r) => r.record),
    records.map((r) => ({ ...r, valid_to: null, episode: null })),
  );
  assert.equal(
    (
      await good(
        "bci_records",
        { instance, session, limit: 1 },
        { helper: "pages", stop_after: 1 },
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await d.ask({
        op: "bci_records",
        helper: "pages",
        body: { instance, session, limit: 1 },
        max_pages: 1,
      })
    ).local,
    true,
  );
  const manifest = (
    await good(
      "bci_manifest",
      { instance, sessions: [session], stream: "eeg" },
      { helper: "bci" },
    )
  ).manifest;
  assert.deepEqual(manifest.sessions, [session]);
  const graphPages = await good(
    "as_of",
    { t: "0", limit: 1 },
    { helper: "pages", max_pages: 1000 },
  );
  assert(graphPages.length >= 3);
  // All connector presets pass through each actual language transport, rather
  // than assuming generic JSON implies tested domain compatibility.
  let n = 0;
  for (const f of fixtures) {
    const id = (9100000000000000n + BigInt(kind * 100 + ++n)).toString();
    const r = {
      src: id,
      dst: (BigInt(id) + 1n).toString(),
      timestamp_us: "9007199254740993",
      episode: "fixture",
      assets: { latent: f.tensor, signal: f.tensor, source: f.source },
      fields: {
        checkpoint: "fixture-v1",
        model: "fixture",
        basis: "Z",
        counts: { "00": "9007199254740993" },
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
        provider: f.connector === "laya" ? "convai" : "typesafe",
        requested_model: f.connector === "laya" ? "auto" : "jev-latest",
        mode: "fixture",
        input_sha256: "a".repeat(64),
        answers: { review: { type: "noul", noul: 0.75 } },
      },
    };
    if (f.connector === "bci") {
      r.dst = id;
      Object.assign(r.fields, {
        type: "session",
        session_id: id,
        clock_domain: f.clock,
        name: "SDK research",
        study: "fixture",
        participant: "synthetic",
        source: "synthetic",
        device: "fixture",
        driver: "fixture",
      });
    }
    if (f.connector === "model-output") delete r.assets.source;
    const batch = {
      instance: f.id,
      partition: language,
      sequence: "0",
      records: [r],
    };
    const written = await good("connector_ingest", batch, {
      token: ingestToken,
    });
    const back = await good(
      "connector_record",
      { edge: written.receipt.first_edge },
      { token: readToken },
    );
    for (const key of ["src", "dst", "timestamp_us", "assets", "fields"])
      assert.deepEqual(
        back.record[key],
        r[key],
        `${language} ${f.connector}/${f.preset}: ${key}`,
      );
    assert.deepEqual(
      (await good("connector_ingest", batch, { token: ingestToken })).receipt,
      written.receipt,
    );
  }
  return [
    `multi-chunk binary helpers and exact nonfinite f64 bits`,
    `atomic migration plans and checksum protection`,
    `BCI session/window/manifest helpers and bounded graph/record pagination`,
    `${fixtures.length} connector presets: exact fields, assets, IDs and idempotent ingestion`,
  ];
}
