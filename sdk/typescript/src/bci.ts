import { Client, type ObjectValue, type Json, type RecordV1 } from "./index.js";
export interface BCIRecord extends RecordV1 {
  fields: ObjectValue & {
    type: string;
    session_id: string;
    clock_domain: string;
  };
}
/**
 * Options shared by every BCI read. `branch` selects one durable branch exactly like the
 * Python SDK and the HTTP API: an omitted branch shows the parent graph only, and a branch
 * inherits the state it was forked from while isolating everything written afterwards.
 */
export interface BCIReadOptions {
  branch?: string | bigint;
}
function scope(options: BCIReadOptions): { fork?: string } {
  if (options.branch === undefined || options.branch === "") return {};
  const branch = String(options.branch);
  if (!/^[0-9]+$/.test(branch))
    throw new RangeError("A branch is a decimal fork ID");
  return { fork: branch };
}
/** Read-side BCI helpers; acquisition belongs in the local Python worker. */
export class BCIClient {
  constructor(
    readonly client: Client,
    readonly instance = "bci_research",
  ) {}
  sessions(after?: string, options: BCIReadOptions = {}) {
    return this.client.call("bci_sessions", {
      instance: this.instance,
      ...(after ? { after } : {}),
      ...scope(options),
    });
  }
  session(session: string, options: BCIReadOptions = {}) {
    return this.client.call("bci_session", {
      instance: this.instance,
      session,
      ...scope(options),
    });
  }
  window(
    session: string,
    stream: string,
    start: bigint,
    end: bigint,
    channels: number[] = [],
    options: BCIReadOptions = {},
  ) {
    if (end <= start || end - start > 60000000n)
      throw new RangeError("Window must be 1–60000000 microseconds");
    return this.client.call("bci_window", {
      instance: this.instance,
      session,
      stream,
      start: start.toString(),
      end: end.toString(),
      channels,
      ...scope(options),
    });
  }
  async *records(
    session: string,
    recordType = "",
    maxPages = 200,
    options: BCIReadOptions = {},
  ) {
    for await (const page of Client.prototype.pages.call(
      this.client,
      "bci_records",
      {
        instance: this.instance,
        session,
        record_type: recordType,
        limit: 500,
        ...scope(options),
      },
      maxPages,
    ))
      yield* page.records as Json[];
  }
  async *allSessions(maxPages = 1000, options: BCIReadOptions = {}) {
    for await (const page of Client.prototype.pages.call(
      this.client,
      "bci_sessions",
      { instance: this.instance, ...scope(options) },
      maxPages,
    ))
      yield* page.sessions as Json[];
  }
  manifest(sessions: string[], stream = "eeg", options: BCIReadOptions = {}) {
    return this.client.call("bci_manifest", {
      instance: this.instance,
      sessions,
      stream,
      ...scope(options),
    });
  }
  /**
   * Walk recorded lineage backwards from one observation: prediction to run, run to
   * dataset, dataset to sessions, session to streams, stream to signal chunks and events.
   * Bounded by depth and rows, exactly like the HTTP operation it wraps.
   */
  causalPath(
    session: string,
    observation: string | bigint,
    options: BCIReadOptions & { depth?: number; limit?: number } = {},
  ) {
    const id = String(observation);
    if (!/^[0-9]+$/.test(id) || id === "0")
      throw new RangeError("Select a nonzero observation ID");
    if (options.depth !== undefined && !(options.depth >= 1 && options.depth <= 8))
      throw new RangeError("Causal path depth is 1–8");
    return this.client.call("bci_causal_path", {
      instance: this.instance,
      session,
      observation: id,
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...scope(options),
    });
  }
}
