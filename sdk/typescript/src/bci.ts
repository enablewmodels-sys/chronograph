import { Client, type ObjectValue, type Json, type RecordV1 } from "./index.js";
export interface BCIRecord extends RecordV1 {
  fields: ObjectValue & {
    type: string;
    session_id: string;
    clock_domain: string;
  };
}
/** Read-side BCI helpers; acquisition belongs in the local Python worker. */
export class BCIClient {
  constructor(
    readonly client: Client,
    readonly instance = "bci_research",
  ) {}
  sessions(after?: string) {
    return this.client.call("bci_sessions", {
      instance: this.instance,
      ...(after ? { after } : {}),
    });
  }
  session(session: string) {
    return this.client.call("bci_session", {
      instance: this.instance,
      session,
    });
  }
  window(
    session: string,
    stream: string,
    start: bigint,
    end: bigint,
    channels: number[] = [],
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
    });
  }
  async *records(session: string, recordType = "", maxPages = 200) {
    for await (const page of Client.prototype.pages.call(
      this.client,
      "bci_records",
      {
        instance: this.instance,
        session,
        record_type: recordType,
        limit: 500,
      },
      maxPages,
    ))
      yield* page.records as Json[];
  }
  async *allSessions(maxPages = 1000) {
    for await (const page of Client.prototype.pages.call(
      this.client,
      "bci_sessions",
      { instance: this.instance },
      maxPages,
    ))
      yield* page.sessions as Json[];
  }
  manifest(sessions: string[], stream = "eeg") {
    return this.client.call("bci_manifest", {
      instance: this.instance,
      sessions,
      stream,
    });
  }
}
