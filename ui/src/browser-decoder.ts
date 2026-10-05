// Run the shipped decoder-v1 artifact in the browser.
//
// The module and the artifact are the ones the console serves, and the reader is the
// SDK's, so this is evidence about the artifact rather than a second implementation of
// the arithmetic. Every fetch is same-origin and nothing here downloads model weights
// from anywhere else.
import { Decoder } from "../../sdk/typescript/dist/decoder.js";
import { publicPath } from "./site";

const MODULE_PATH = "/wasm/chronograph-decoder.wasm";
const ARTIFACT_PATH = "/wasm/artifact";

/** The artifact document the console ships. */
export interface DecoderArtifact {
  adapter: { name: string; version: string };
  channels: string[];
  window_samples: number;
  sample_rate_hz: number;
  bands_hz: number[];
  vocabulary: string[];
}

/** One decoded window, with the token the window was synthesised from. */
export interface BrowserDecode {
  adapter: string;
  channels: string[];
  windowSamples: number;
  sampleRateHz: number;
  expected: string;
  token: string | null;
  probability: number;
  abstained: boolean;
  moduleBytes: number;
  windowGenerated: boolean;
}

interface TokenResult {
  token?: string;
  probability?: number;
}

/**
 * Deterministic synthesis: token k is carried by bands_hz[k], exactly as the reference
 * artifact was fitted, so two runs of this check produce the same window and the same
 * answer instead of a fresh random draw each time.
 */
function syntheticWindow(document: DecoderArtifact, token: string) {
  const index = Math.max(0, document.vocabulary.indexOf(token));
  const band = document.bands_hz[Math.min(index, document.bands_hz.length - 1)];
  const channels = document.channels.length;
  const samples = document.window_samples;
  let state = 0x9e3779b9 ^ (index + 1);
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () =>
    Math.sqrt(-2 * Math.log(uniform() || Number.EPSILON)) *
    Math.cos(2 * Math.PI * uniform());
  // An explicit ArrayBuffer keeps the view assignable to the SDK's BufferSource on
  // TypeScript 5.9, where a buffer-backed view is typed as ArrayBufferLike.
  const window = new Float64Array(
    new ArrayBuffer(channels * samples * Float64Array.BYTES_PER_ELEMENT),
  );
  for (let channel = 0; channel < channels; channel += 1)
    for (let sample = 0; sample < samples; sample += 1) {
      const time = sample / document.sample_rate_hz;
      window[channel * samples + sample] =
        24 * (1 - 0.05 * channel) * Math.sin(2 * Math.PI * band * time) +
        3 * normal();
    }
  return window;
}

/** Load the module and the artifact the console serves. */
export async function loadBrowserDecoder(): Promise<{
  decoder: Decoder;
  document: DecoderArtifact;
  moduleBytes: number;
}> {
  const [moduleBytes, documentText, weights] = await Promise.all([
    fetch(publicPath(MODULE_PATH)).then((response) =>
      response.ok
        ? response.arrayBuffer()
        : Promise.reject(new Error("The decoder module is unavailable.")),
    ),
    fetch(publicPath(`${ARTIFACT_PATH}/model.json`)).then((response) => {
      if (!response.ok) throw new Error("The decoder artifact is unavailable.");
      return response.text();
    }),
    fetch(publicPath(`${ARTIFACT_PATH}/weights.bin`)).then((response) =>
      response.ok
        ? response.arrayBuffer()
        : Promise.reject(new Error("The decoder weights are unavailable.")),
    ),
  ]);
  const encoder = new TextEncoder();
  const decoder = await Decoder.load(
    await WebAssembly.compile(moduleBytes),
    encoder.encode(documentText),
    new Uint8Array(weights),
  );
  return {
    decoder,
    document: JSON.parse(documentText) as DecoderArtifact,
    moduleBytes: moduleBytes.byteLength,
  };
}

/** Decode one synthesised window for a vocabulary token. */
export function decodeToken(
  loaded: { decoder: Decoder; document: DecoderArtifact; moduleBytes: number },
  token: string,
): BrowserDecode {
  const { decoder, document, moduleBytes } = loaded;
  const described = decoder.describe();
  const decoded = decoder.decode(syntheticWindow(document, token)) as {
    text?: string | null;
    probability?: number;
    abstained?: boolean;
    tokens?: TokenResult[];
  };
  const first = decoded.tokens?.[0];
  return {
    adapter: String(described.adapter ?? document.adapter.name),
    channels: (described.channel_names as string[]) ?? document.channels,
    windowSamples: Number(described.window_samples ?? document.window_samples),
    sampleRateHz: document.sample_rate_hz,
    expected: token,
    token: decoded.text ?? first?.token ?? null,
    probability: Number(decoded.probability ?? first?.probability ?? 0),
    abstained: decoded.abstained === true,
    moduleBytes,
    windowGenerated: true,
  };
}
