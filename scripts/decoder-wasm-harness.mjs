// WebAssembly decoder harness.
//
// Instantiates the wasm module, replays an artifact and a window through its linear-memory
// ABI, and prints the decoded JSON. Kept deliberately thin: the arithmetic lives in Rust.
import { readFileSync } from "node:fs";

const [, , wasmPath, artifactDir, windowPath] = process.argv;
if (!wasmPath || !artifactDir || !windowPath) {
  console.error("usage: node decoder-wasm-harness.mjs MODULE.wasm ARTIFACT_DIR WINDOW.f64");
  process.exit(2);
}

const module = await WebAssembly.compile(readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(module, {});
const api = instance.exports;
const memory = () => new Uint8Array(api.memory.buffer);

function write(bytes) {
  const pointer = api.chronograph_alloc(bytes.length);
  memory().set(bytes, pointer);
  return [pointer, bytes.length];
}

function readResult() {
  const pointer = api.chronograph_result_ptr();
  const length = api.chronograph_result_len();
  return JSON.parse(new TextDecoder().decode(memory().slice(pointer, pointer + length)));
}

const model = write(readFileSync(`${artifactDir}/model.json`));
const weights = write(readFileSync(`${artifactDir}/weights.bin`));
const window = write(readFileSync(windowPath));

let code = api.chronograph_describe(model[0], model[1], weights[0], weights[1]);
const description = readResult();
if (code !== 0) {
  console.error("describe failed:", JSON.stringify(description));
  process.exit(1);
}

code = api.chronograph_decode(model[0], model[1], weights[0], weights[1], window[0], window[1]);
const decoded = readResult();
if (code !== 0) {
  console.error("decode failed:", JSON.stringify(decoded));
  process.exit(1);
}

process.stdout.write(JSON.stringify({ describe: description, decoded }));
