export { Decoder } from "./decoder.js";
export type { DecoderDescription, DecoderSource } from "./decoder.js";
export { BCIClient } from "./bci.js";
export type { BCIRecord } from "./bci.js";
export { layaDecision } from "./laya.js";
export type { LayaAnswer, LayaResponse, LayaOptions } from "./laya.js";
export { jevDecision } from "./jev.js";
export type { JevAnswer, JevResponse, JevRequest } from "./jev.js";
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export interface RecordV1 {
  src: string;
  dst: string;
  timestamp_us: string;
  valid_to?: string | null;
  episode?: string | null;
  assets: Record<string, string>;
  fields: ObjectValue;
}
export interface AssetMetadata {
  version: 1;
  kind: "tensor" | "image" | "video" | "audio" | "opaque";
  encoding: string;
  dtype?: string | null;
  shape?: number[];
  provenance?: Record<string, string>;
}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter: string | null = null,
  ) {
    super(`HTTP ${status} ${code}: ${message}`);
    this.name = "ApiError";
  }
}
const MAX = 4 * 1024 * 1024,
  CHUNK = 1024 * 1024;
function finiteJson(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("Non-finite JSON number");
  if (typeof value === "bigint")
    throw new TypeError("Encode 64-bit integers as decimal strings");
  if (value && typeof value === "object")
    for (const item of Object.values(value)) finiteJson(item);
}
function canonical(value: Json): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return JSON.stringify(value);
}
const hex = (data: Uint8Array) =>
  Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
export class Client {
  readonly origin: string;
  #token: string;
  constructor(
    origin: string,
    token: string,
    readonly timeoutMs = 30000,
    readonly maxResponseBytes = MAX,
  ) {
    const u = new URL(origin);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new TypeError("Use an HTTP(S) origin without credentials or path");
    if (
      u.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
      throw new TypeError("Remote endpoints require HTTPS");
    if (!token || /[\x00-\x20\x7f]/.test(token))
      throw new TypeError("Invalid bearer token");
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 64 * MAX
    )
      throw new RangeError("Invalid client bounds");
    this.origin = u.origin;
    this.#token = token;
  }
  async request(
    path: string,
    method = "POST",
    body?: ObjectValue,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !/^\/v1\/[a-z_]+(?:\/[A-Za-z0-9_-]+)?$/.test(path) ||
      !["GET", "POST", "DELETE"].includes(method)
    )
      throw new TypeError("Invalid API path/method");
    finiteJson(body);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && new TextEncoder().encode(payload).byteLength > MAX)
      throw new RangeError("Request exceeds 4 MiB");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const response = await fetch(this.origin + path, {
        method,
        body: payload,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(payload !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader)
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > this.maxResponseBytes)
              throw new ApiError(
                response.status,
                "RESPONSE_LIMIT",
                "Response exceeds configured limit",
              );
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      if (!response.ok) {
        let code = "HTTP_ERROR",
          message = "Request rejected";
        try {
          const error = JSON.parse(new TextDecoder().decode(bytes)).error;
          code = String(error?.code || code);
          message = String(error?.message || message).slice(0, 1000);
        } catch {
          /* Non-JSON gateway errors remain structured. */
        }
        throw new ApiError(
          response.status,
          code,
          message,
          response.headers.get("retry-after"),
        );
      }
      return bytes;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  async call<T = ObjectValue>(
    operation: string,
    arguments_: ObjectValue = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (!/^[a-z_]+$/.test(operation)) throw new TypeError("Invalid operation");
    const raw = await this.request(
      `/v1/${operation}`,
      "POST",
      arguments_,
      signal,
    );
    try {
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      return parsed as T;
    } catch {
      throw new ApiError(200, "INVALID_JSON", "Expected JSON response");
    }
  }
  async info(): Promise<ObjectValue> {
    return JSON.parse(
      new TextDecoder().decode(await this.request("/v1/info", "GET")),
    );
  }
  async uploadAsset(
    data: Uint8Array,
    metadata: AssetMetadata,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!data.length || data.length > 16 * CHUNK)
      throw new RangeError("Asset requires 1 byte to 16 MiB");
    const meta = metadata as unknown as ObjectValue;
    if (data.length <= CHUNK) {
      const result = await this.call(
        "asset_put",
        { metadata: meta, data_hex: hex(data) },
        signal,
      );
      if (typeof result.asset !== "string" || !result.asset)
        throw new Error("Invalid asset response");
      return result.asset;
    }
    const chunks: string[] = [];
    for (let offset = 0; offset < data.length; offset += CHUNK)
      chunks.push(
        await this.uploadAsset(
          data.subarray(offset, offset + CHUNK),
          {
            version: 1,
            kind: "opaque",
            encoding: "chunk_v1",
          },
          signal,
        ),
      );
    const result = await this.call(
      "asset_compose",
      { metadata: meta, chunks },
      signal,
    );
    if (typeof result.asset !== "string" || !result.asset)
      throw new Error("Invalid asset response");
    return result.asset;
  }
  async readAsset(
    asset: string,
    signal?: AbortSignal,
  ): Promise<{ metadata: AssetMetadata; data: Uint8Array }> {
    const chunks: Uint8Array[] = [];
    let offset = 0,
      expected = -1;
    let metadata!: AssetMetadata;
    for (let page = 0; page < 16; page++) {
      const result = await this.call<{
        asset: string;
        bytes: number;
        offset: number;
        next_offset: number | null;
        data_hex: string;
        metadata: AssetMetadata;
      }>("asset_get", { asset, content: true, offset }, signal);
      if (
        result.asset !== asset ||
        result.offset !== offset ||
        !Number.isInteger(result.bytes) ||
        result.bytes < 1 ||
        result.bytes > 16 * CHUNK ||
        (expected !== -1 && expected !== result.bytes) ||
        typeof result.data_hex !== "string" ||
        !/^[0-9a-fA-F]+$/.test(result.data_hex) ||
        result.data_hex.length % 2 !== 0 ||
        result.data_hex.length > 2 * CHUNK ||
        !result.metadata ||
        typeof result.metadata !== "object" ||
        Array.isArray(result.metadata) ||
        !("next_offset" in result)
      )
        throw new Error("Invalid asset page");
      if (
        metadata &&
        canonical(metadata as unknown as Json) !==
          canonical(result.metadata as unknown as Json)
      )
        throw new Error("Asset metadata changed between pages");
      expected = result.bytes;
      metadata = result.metadata;
      const chunk = Uint8Array.from(result.data_hex.match(/../g)!, (n) =>
        parseInt(n, 16),
      );
      chunks.push(chunk);
      offset += chunk.length;
      if (offset > expected) throw new Error("Invalid asset length");
      if (result.next_offset === null) {
        if (offset !== expected) throw new Error("Truncated asset");
        const data = new Uint8Array(offset);
        let p = 0;
        for (const chunk of chunks) {
          data.set(chunk, p);
          p += chunk.length;
        }
        return { metadata, data };
      }
      if (result.next_offset !== offset || offset >= expected)
        throw new Error("Non-progressing asset cursor");
    }
    throw new Error("Asset page limit exceeded");
  }
  ingest(
    instance: string,
    partition: string,
    sequence: string,
    records: RecordV1[],
  ): Promise<ObjectValue> {
    return this.call("connector_ingest", {
      instance,
      partition,
      sequence,
      records: records as unknown as Json[],
    });
  }
  checkpoint(instance: string, partition: string): Promise<ObjectValue> {
    return this.call("connector_checkpoint", { instance, partition });
  }
  async *pages(
    operation:
      | "as_of"
      | "between"
      | "history"
      | "neighbors"
      | "bci_sessions"
      | "bci_records",
    arguments_: ObjectValue = {},
    maxPages = 1000,
    signal?: AbortSignal,
  ): AsyncGenerator<ObjectValue> {
    if (
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 10000 ||
      ![
        "as_of",
        "between",
        "history",
        "neighbors",
        "bci_sessions",
        "bci_records",
      ].includes(operation)
    )
      throw new RangeError("Invalid pagination options");
    const bci = operation.startsWith("bci_"),
      key = bci ? "after" : "cursor";
    const args = { ...arguments_ },
      seen = new Set<string>();
    if (typeof args[key] === "string") seen.add(args[key]);
    for (let i = 0; i < maxPages; i++) {
      const result = await this.call(operation, args, signal);
      const cursorKey = operation === "bci_records" ? "cursor" : "next_cursor";
      if (!(cursorKey in result)) throw new Error("Missing pagination cursor");
      const cursor = result[cursorKey];
      let done = cursor === null;
      if (operation === "bci_records") {
        if (typeof result.has_more !== "boolean")
          throw new Error("Invalid BCI page");
        done = !result.has_more;
      }
      if (
        bci &&
        !Array.isArray(
          result[operation === "bci_records" ? "records" : "sessions"],
        )
      )
        throw new Error("Invalid BCI rows");
      if (!done) {
        if (typeof cursor !== "string" || !cursor || seen.has(cursor))
          throw new Error("Non-progressing pagination cursor");
        seen.add(cursor);
        args[key] = cursor;
      }
      yield result;
      if (done) return;
    }
    throw new Error("Pagination limit reached");
  }
}
