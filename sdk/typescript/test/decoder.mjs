// The TypeScript SDK must decode through the same artifact reader as Python.
//
// It loads the module a browser would load, writes the fixture's raw windows
// through the linear-memory ABI and compares every number with the output the
// Python SDK produced from the same artifact.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Decoder } from "../dist/index.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PYTHON = process.env.CHRONOGRAPH_PYTHON || "python3";
const SHIPPED_MODULE = join(ROOT, "ui", "public", "wasm", "chronograph-decoder.wasm");
const SHIPPED_ARTIFACT = join(ROOT, "ui", "public", "wasm", "artifact");
const WASM =
  process.env.CHRONOGRAPH_WASM ||
  join(
    ROOT,
    "target",
    "wasm32-unknown-unknown",
    "release",
    "chronograph_wasm.wasm",
  );

test(
  "the artifact the console ships decodes identically in both runtimes",
  {
    skip: existsSync(SHIPPED_MODULE)
      ? false
      : "run scripts/export-browser-decoder.py to ship the browser decoder",
  },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "chronograph-ts-shipped-"));
    const summary = JSON.parse(
      execFileSync(
        PYTHON,
        [join(ROOT, "scripts", "decoder-fixture.py"), work, SHIPPED_ARTIFACT],
        { encoding: "utf8" },
      ),
    );
    const decoder = await Decoder.load(
      readFileSync(SHIPPED_MODULE),
      readFileSync(join(SHIPPED_ARTIFACT, "model.json")),
      readFileSync(join(SHIPPED_ARTIFACT, "weights.bin")),
    );
    const described = decoder.describe();
    assert.equal(described.format, "decoder-v1");
    assert.equal(described.adapter, summary.adapter);
    assert.deepEqual(described.channel_names, summary.channels);
    const expected = JSON.parse(
      readFileSync(join(work, "expected.json"), "utf8"),
    );
    let worst = 0;
    expected.forEach((reference, index) => {
      const decoded = decoder.decode(
        readFileSync(join(work, `window${index}.f64`)),
      );
      assert.equal(decoded.text, reference.text);
      worst = Math.max(
        worst,
        Math.abs(decoded.probability - reference.probability),
      );
    });
    assert.ok(worst < 1e-9, "shipped artifact probability delta " + worst);
    decoder.dispose();
    console.log(
      JSON.stringify({
        passed: true,
        shipped_windows: expected.length,
        shipped_max_delta: worst,
      }),
    );
  },
);

test(
  "the TypeScript decoder matches Python through one shared artifact",
  {
    skip: existsSync(WASM)
      ? false
      : "build the module first: cargo build --release --target wasm32-unknown-unknown -p chronograph-wasm",
  },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "chronograph-ts-decoder-"));
    const summary = JSON.parse(
      execFileSync(
        PYTHON,
        [join(ROOT, "scripts", "decoder-fixture.py"), work],
        { encoding: "utf8" },
      ),
    );
    const artifact = join(work, "artifact");
    const module = await WebAssembly.compile(readFileSync(WASM));
    const decoder = await Decoder.load(
      module,
      readFileSync(join(artifact, "model.json")),
      readFileSync(join(artifact, "weights.bin")),
    );

    const described = decoder.describe();
    assert.equal(described.format, "decoder-v1");
    assert.equal(described.adapter, "wasm-fixture");
    assert.deepEqual(described.channel_names, summary.channels);
    assert.equal(described.window_samples, summary.samples);

    const expected = JSON.parse(
      readFileSync(join(work, "expected.json"), "utf8"),
    );
    assert.equal(expected.length, summary.windows);
    let worst = 0;
    expected.forEach((reference, index) => {
      const decoded = decoder.decode(
        readFileSync(join(work, `window${index}.f64`)),
      );
      assert.equal(decoded.text, reference.text);
      assert.equal(decoded.abstained, reference.abstained);
      assert.equal(decoded.tokens.length, reference.tokens.length);
      decoded.tokens.forEach((token, slot) => {
        assert.equal(token.token, reference.tokens[slot].token);
        assert.equal(token.slot, reference.tokens[slot].slot);
        worst = Math.max(
          worst,
          Math.abs(token.probability - reference.tokens[slot].probability),
        );
      });
      worst = Math.max(
        worst,
        Math.abs(decoded.probability - reference.probability),
      );
    });
    assert.ok(worst < 1e-9, "probability delta " + worst);

    decoder.dispose();
    assert.throws(() => decoder.describe(), /disposed/);
    console.log(
      JSON.stringify({
        passed: true,
        windows: expected.length,
        max_probability_delta: worst,
        module_bytes: readFileSync(WASM).length,
      }),
    );
  },
);
