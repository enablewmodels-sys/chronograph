import type { Client, Json, ObjectValue, RecordV1 } from "./index.js";

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string | ObjectValue | Json[]>; probabilities: Record<string, number>; confidence: number };
export interface JevResponse { model: string; answers: Record<string, JevAnswer>; usage?: ObjectValue }
export interface JevRequest { model: string; state: Json; questions: Record<string, { type: "noul" | "choice" | "score"; instructions?: Json; criteria?: Json }> }
const encoder = new TextEncoder();
const prob = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function validateAnswers(answers: unknown): asserts answers is Record<string, JevAnswer> {
  if (!object(answers) || !Object.keys(answers).length || Object.keys(answers).length > 64) throw new TypeError("Expected 1–64 Jev answers");
  for (const [name, a] of Object.entries(answers)) {
    if (!name || encoder.encode(name).length > 128 || !object(a)) throw new TypeError("Invalid Jev answer");
    if (a.type === "noul") { if (!prob(a.noul)) throw new TypeError("Invalid Noul probability"); continue; }
    if (a.type !== "choice" && a.type !== "score") throw new TypeError("Unknown Jev answer type");
    const p = a.probabilities;
    if (!object(p) || !Object.keys(p).length || Object.keys(p).length > 255 || !prob(a.confidence)
      || Object.entries(p).some(([k, n]) => !k || encoder.encode(k).length > 256 || !prob(n))
      || Math.abs(Object.values(p).reduce<number>((n, v) => n + Number(v), 0) - 1) > 0.001) throw new TypeError("Invalid Jev probability distribution");
    if (a.type === "choice") {
      if (typeof a.choice !== "string" || !Object.hasOwn(p, a.choice)) throw new TypeError("Invalid Jev choice");
    } else {
      const legend = a.legend;
      if (!object(legend) || Object.keys(legend).length < 2 || Object.keys(legend).length > 10
        || Object.keys(legend).length !== Object.keys(p).length
        || Object.entries(legend).some(([k, v]) => !/^\d+$/.test(k) || Number(k) > 4294967295 || (typeof v !== "string" && !object(v) && !Array.isArray(v)) || !Object.hasOwn(p, k))
        || typeof a.score !== "number" || !Number.isFinite(a.score)
        || a.score < Math.min(...Object.keys(legend).map(Number)) || a.score > Math.max(...Object.keys(legend).map(Number))) throw new TypeError("Invalid Jev score/legend");
    }
  }
}

/** Normalize TypeSafe's JSON response. No inference, retries or provider keys here. */
export async function jevDecision(response: JevResponse, options: {
  request: JevRequest; src: string; dst: string; timestampUs: string; mode: "live" | "fixture";
  client?: Client; attachInputs?: boolean; episode?: string;
}): Promise<RecordV1> {
  const { request, src, dst, timestampUs, mode, client, attachInputs = false, episode } = options;
  validateAnswers(response.answers);
  if ([request.model, response.model].some(m => typeof m !== "string" || !m || encoder.encode(m).length > 128)
    || !["live", "fixture"].includes(mode) || !object(request.questions) || request.state === undefined
    || Object.keys(request.questions).length !== Object.keys(response.answers).length
    || Object.entries(response.answers).some(([k, a]) => !Object.hasOwn(request.questions, k) || request.questions[k].type !== a.type)) throw new TypeError("Request/response provenance mismatch");
  for (const id of [src, dst]) if (typeof id !== "string" || !/^\d+$/.test(id) || BigInt(id) > 18446744073709551615n) throw new TypeError("IDs must be u64 decimal strings");
  if (typeof timestampUs !== "string" || !/^-?\d+$/.test(timestampUs) || BigInt(timestampUs) < -9223372036854775808n || BigInt(timestampUs) >= 9223372036854775807n) throw new TypeError("Invalid microsecond timestamp");
  const strictStringify = (v: unknown) => JSON.stringify(v, (_k, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Non-finite JSON value");
    return value;
  });
  const data = encoder.encode(strictStringify(request));
  if (data.length > 1024 * 1024) throw new RangeError("Request exceeds 1 MiB");
  const digest = await crypto.subtle.digest("SHA-256", data);
  const assets: Record<string, string> = {};
  if (attachInputs) {
    if (!client) throw new TypeError("Attachment uploads require a Chronograph client");
    for (const [name, bytes] of [["request", data], ["response", encoder.encode(strictStringify(response))]] as const) {
      assets[name] = await client.uploadAsset(bytes, { version: 1, kind: "opaque", encoding: "json", provenance: { provider: "typesafe", mode } });
    }
  }
  return { src, dst, timestamp_us: timestampUs, ...(episode ? { episode } : {}), assets,
    fields: { provider: "typesafe", model: response.model, requested_model: request.model, mode,
      input_sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""),
      answers: response.answers as unknown as ObjectValue, usage: response.usage ?? {} } };
}
