/**
 * TypeScript binding for the shared decoder-v1 WebAssembly module.
 *
 * The browser, Node, the native CLI and the Python SDK all execute the same
 * artifact reader, so a decoded result cannot differ by runtime. This file adds
 * no arithmetic of its own: it moves bytes through the module's linear-memory
 * ABI, which keeps a browser run from becoming a third implementation.
 *
 * The module holds all state in linear memory and returns JSON through a pointer
 * pair, so the host must re-read the memory buffer after every call: growing the
 * memory detaches any view taken earlier.
 */

/** Adapter, geometry and limits reported by a loaded artifact. */
export interface DecoderDescription {
  readonly format: string;
  readonly adapter?: string;
  readonly channel_names?: string[];
  readonly window_samples?: number;
  readonly [key: string]: unknown;
}

/** A compiled module, its bytes, or a promise of either. */
export type DecoderSource =
  | WebAssembly.Module
  | BufferSource
  | Promise<WebAssembly.Module | BufferSource>;

/** The subset of the module's exports this binding calls. */
interface DecoderExports {
  readonly memory: WebAssembly.Memory;
  chronograph_format_ptr(): number;
  chronograph_format_len(): number;
  chronograph_alloc(length: number): number;
  chronograph_free(pointer: number, length: number): void;
  chronograph_result_ptr(): number;
  chronograph_result_len(): number;
  chronograph_describe(
    model: number,
    modelLength: number,
    weights: number,
    weightsLength: number,
  ): number;
  chronograph_decode(
    model: number,
    modelLength: number,
    weights: number,
    weightsLength: number,
    window: number,
    windowLength: number,
  ): number;
}

interface Buffer {
  pointer: number;
  length: number;
}

/**
 * A forgotten dispose would leak module memory for the lifetime of the page, so the
 * artifact buffers are also released when a decoder becomes unreachable. Explicit
 * dispose() stays the supported path; this is the backstop.
 */
const releaseOnFinalize = new FinalizationRegistry<{
  module: DecoderExports;
  pointers: Buffer[];
}>(({ module, pointers }) => {
  for (const buffer of pointers)
    if (buffer.pointer) module.chronograph_free(buffer.pointer, buffer.length);
});

/** One artifact, ready to describe and decode windows. */
export class Decoder {
  /** Artifact format this module executes. */
  static readonly format = "decoder-v1";

  private readonly module: DecoderExports;
  private readonly format: string;
  private model: Buffer;
  private weights: Buffer;
  private closed = false;

  private constructor(
    instance: WebAssembly.Instance,
    model: Buffer,
    weights: Buffer,
  ) {
    this.module = instance.exports as unknown as DecoderExports;
    if (!this.module.memory)
      throw new Error("The decoder module exports no memory.");
    const pointer = this.module.chronograph_format_ptr();
    const length = this.module.chronograph_format_len();
    this.format = new TextDecoder().decode(
      this.memory().slice(pointer, pointer + length),
    );
    this.model = model;
    this.weights = weights;
  }

  /**
   * Load one decoder-v1 artifact: a model.json document plus weights.bin.
   *
   * `source` is the module itself when a host compiles it once and reuses it
   * across artifacts, which is what a browser page should do.
   */
  static async load(
    source: DecoderSource,
    model: BufferSource,
    weights: BufferSource,
  ): Promise<Decoder> {
    const resolved = await source;
    const instance =
      resolved instanceof WebAssembly.Module
        ? await WebAssembly.instantiate(resolved, {})
        : (await WebAssembly.instantiate(resolved as BufferSource, {}))
            .instance;
    const decoder = new Decoder(
      instance,
      { pointer: 0, length: 0 },
      {
        pointer: 0,
        length: 0,
      },
    );
    decoder.model = decoder.write(bytesOf(model));
    decoder.weights = decoder.write(bytesOf(weights));
    releaseOnFinalize.register(
      decoder,
      { module: decoder.module, pointers: [decoder.model, decoder.weights] },
      decoder,
    );
    return decoder;
  }

  /** Adapter, geometry and limits for this artifact. */
  describe(): DecoderDescription {
    this.assertOpen();
    const result = this.call(
      this.module.chronograph_describe(
        this.model.pointer,
        this.model.length,
        this.weights.pointer,
        this.weights.length,
      ),
    );
    if (!result || typeof result !== "object")
      throw new Error("The decoder module returned no description.");
    return { format: this.format, ...(result as Record<string, unknown>) };
  }

  /**
   * Decode one window. Raw sample bytes in the artifact's declared dtype, which
   * is little-endian f64 for decoder-v1 fixtures.
   */
  decode(window: BufferSource): unknown {
    // Checked before the module is called: a disposed decoder must not pass null
    // pointers into wasm and report whatever the module happens to say.
    this.assertOpen();
    const input = bytesOf(window);
    const buffer = this.write(input);
    try {
      return this.call(
        this.module.chronograph_decode(
          this.model.pointer,
          this.model.length,
          this.weights.pointer,
          this.weights.length,
          buffer.pointer,
          buffer.length,
        ),
      );
    } finally {
      this.module.chronograph_free(buffer.pointer, buffer.length);
    }
  }

  /** Release the artifact buffers. Decoding after this throws. */
  dispose(): void {
    if (this.closed) return;
    for (const buffer of [this.model, this.weights])
      if (buffer.pointer)
        this.module.chronograph_free(buffer.pointer, buffer.length);
    this.model = { pointer: 0, length: 0 };
    this.weights = { pointer: 0, length: 0 };
    this.closed = true;
    releaseOnFinalize.unregister(this);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("This decoder has been disposed.");
  }

  private memory(): Uint8Array {
    return new Uint8Array(this.module.memory.buffer);
  }

  private write(bytes: Uint8Array): Buffer {
    if (!bytes.length) throw new Error("The decoder needs a nonempty buffer.");
    const pointer = this.module.chronograph_alloc(bytes.length);
    // The module allocates through Vec::with_capacity and does not return null today, so
    // this guards a future allocator rather than a live path: an oversized window is
    // refused by the module's own bounds checks, which trap instead of returning.
    if (!pointer)
      throw new Error(
        "The decoder module could not allocate " + bytes.length + " bytes.",
      );
    this.memory().set(bytes, pointer);
    return { pointer, length: bytes.length };
  }

  private call(code: number): unknown {
    if (this.closed) throw new Error("This decoder has been disposed.");
    const pointer = this.module.chronograph_result_ptr();
    const length = this.module.chronograph_result_len();
    const text = new TextDecoder().decode(
      this.memory().slice(pointer, pointer + length),
    );
    if (code !== 0) throw new Error(text || "The decoder call failed.");
    return text ? JSON.parse(text) : null;
  }
}

function bytesOf(value: BufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const view = value as ArrayBufferView;
  return new Uint8Array(
    view.buffer as ArrayBuffer,
    view.byteOffset,
    view.byteLength,
  );
}
