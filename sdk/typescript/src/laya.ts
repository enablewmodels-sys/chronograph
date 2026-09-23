import type { Json, ObjectValue, RecordV1 } from "./index.js";
import { decisionRecord, type DecisionOptions, type JevAnswer, type JevResponse } from "./jev.js";

export type LayaAnswer = JevAnswer & { action?: { act_probability: number }; confidence?: number };
export interface LayaResponse extends JevResponse {
  answers: Record<string, LayaAnswer>;
  routing?: ObjectValue;
}
export interface LayaOptions extends DecisionOptions {
  checkpoint?: string;
  checkpointRevision?: string;
  runtimeVersion?: string;
}
/** Store Laya output without loading weights, making inference calls or inventing provenance. */
export async function layaDecision(response: LayaResponse, options: LayaOptions): Promise<RecordV1> {
  const routing = response.routing ?? {};
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) throw new TypeError("Invalid Laya routing");
  const checkpoint = options.checkpoint ?? routing.repo;
  const length = (v: string) => new TextEncoder().encode(v).length;
  if (typeof checkpoint !== "string" || !checkpoint || length(checkpoint) > 256) throw new TypeError("Provide the actual Laya checkpoint or routing.repo");
  const metadata: Record<string, Json> = { checkpoint, routing };
  for (const [name, value] of [["checkpoint_revision", options.checkpointRevision], ["runtime_version", options.runtimeVersion]]) {
    if (value !== undefined) {
      if (typeof value !== "string" || !value || length(value) > 128) throw new TypeError("Invalid Laya revision");
      metadata[name!] = value;
    }
  }
  const result = await decisionRecord(response, "convai", options);
  Object.assign(result.fields, metadata);
  return result;
}
